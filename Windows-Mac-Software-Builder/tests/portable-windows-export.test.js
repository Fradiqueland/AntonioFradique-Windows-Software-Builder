'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const yauzl = require('yauzl');

// Run the production Windows branches on every host. The filesystem and ZIP
// streams are real; only process.platform and sibling-module resolution differ.
function windowsModules() {
  const loaded = new Map();
  function load(name) {
    if (loaded.has(name)) return loaded.get(name);
    const file = path.resolve(__dirname, '../src/shared', name + '.js');
    const module = { exports: {} };loaded.set(name,module.exports);
    const nativeRequire = createRequire(file);
    const localRequire = request => /^\.\/(portable-app|project-export|project-archive)$/.test(request)
      ? load(request.slice(2)) : nativeRequire(request);
    const fn = vm.runInThisContext('(function(require,module,exports,process,Buffer){' + fs.readFileSync(file,'utf8') + '\n})', { filename:file });
    fn(localRequire,module,module.exports,{platform:'win32',versions:{}},Buffer);
    loaded.set(name,module.exports);return module.exports;
  }
  return {portable:load('portable-app'),engine:load('project-export'),archive:load('project-archive')};
}
function macho(filetype = 2) {
  const bytes=Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf,0);bytes.writeUInt32LE(0x1000007,4);bytes.writeUInt32LE(filetype,12);return bytes;
}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'windows-mac-portable-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const projectRoot=path.join(root,'project'),assetsDir=path.join(projectRoot,'dist-assets'),sourcePath=path.join(root,'Source.app');
  fs.mkdirSync(assetsDir,{recursive:true});fs.mkdirSync(path.join(projectRoot,'data'));
  const write=(name,bytes)=>{const file=path.join(sourcePath,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode:0o644});return file;};
  write('Contents/Info.plist','<plist><dict><key>CFBundleExecutable</key><string>Program</string></dict></plist>');
  write('Contents/MacOS/Program',macho());write('Contents/MacOS/Helper',macho());
  write('Contents/Frameworks/Library',macho(6));write('Contents/Resources/app.asar',Buffer.from([0,255,3,7]));
  write('Contents/Resources/not-a-program','plain text');write('Contents/Resources/fake-executable',Buffer.from('not Mach-O'));
  return {root,projectRoot,assetsDir,sourcePath,write,...windowsModules()};
}
async function template(filename) {
  const z=new yazl.ZipFile(),done=pipeline(z.outputStream,fs.createWriteStream(filename));
  z.addBuffer(Buffer.from('<plist><dict></dict></plist>'),'LaunchBox Viewer.app/Contents/Info.plist',{mode:0o100644});
  z.addBuffer(Buffer.from('SEALED VIEWER'),'LaunchBox Viewer.app/Contents/Resources/app.asar',{mode:0o100644});
  z.addBuffer(Buffer.from('MACH-O VIEWER'),'LaunchBox Viewer.app/Contents/MacOS/LaunchBox Viewer',{mode:0o100755});
  z.end();await done;
}
async function entries(filename) {
  const result=new Map();const z=await new Promise((resolve,reject)=>yauzl.open(filename,{lazyEntries:true},(e,z)=>e?reject(e):resolve(z)));
  await new Promise((resolve,reject)=>{z.on('error',reject);z.on('end',resolve);z.on('entry',entry=>z.openReadStream(entry,async(e,s)=>{
    if(e)return reject(e);try{const bytes=[];for await(const b of s)bytes.push(b);result.set(entry.fileName,{mode:entry.externalFileAttributes>>>16,bytes:Buffer.concat(bytes)});z.readEntry();}catch(e){reject(e);}
  }));z.readEntry();});return result;
}

test('Windows exports an existing Mac portable project with executable ZIP modes and unchanged bytes',async t=>{
  const f=fixture(t);
  // Import first and retain the saved shape used by existing projects.
  const importer=require('../src/shared/portable-app');
  const data=importer.importPortableProject({...f,entries:{mac:'.'}});
  // candidates are advisory; stale saved false values must not block export.
  data.candidates.forEach(c=>{c.executable=false;});
  const config={brand:{title:'Mac from Windows'},content:[{id:'native',type:'portable',data}]};
  const validated=f.portable.assertPortableTarget({data,assetsDir:f.assetsDir,target:'mac'});
  assert.equal(validated.launchKind,'app');assert.equal(validated.requiresWine,false);
  const original=path.join(f.projectRoot,data.root,'Source.app','Contents/MacOS/Program');
  const modeBefore=fs.statSync(original).mode;
  const templatePath=path.join(f.root,'template.zip'),outputPath=path.join(f.root,'mac.zip');await template(templatePath);
  await f.engine.exportProject({target:'mac',templatePath,outputPath,projectName:'Mac product',config,assetsDir:f.assetsDir});
  const zip=await entries(outputPath),base='Mac product.data/'+data.root+'/Source.app/';
  for(const file of ['Contents/MacOS/Program','Contents/MacOS/Helper']){
    assert.equal(zip.get(base+file).mode,0o100755);assert.deepEqual(zip.get(base+file).bytes,fs.readFileSync(path.join(f.sourcePath,file)));
  }
  for(const file of ['Contents/Resources/app.asar','Contents/Resources/not-a-program','Contents/Resources/fake-executable','Contents/Frameworks/Library']){
    assert.equal(zip.get(base+file).mode&0o111,0);assert.deepEqual(zip.get(base+file).bytes,fs.readFileSync(path.join(f.sourcePath,file)));
  }
  assert.equal(fs.statSync(original).mode,modeBefore,'Export must not chmod or change the saved project');
  assert.equal(zip.get('Mac product.app/Contents/MacOS/LaunchBox Viewer').mode,0o100755);
  assert.equal(zip.get('Mac product.app/Contents/Resources/app.asar').bytes.toString(),'SEALED VIEWER');
  assert.deepEqual(JSON.parse(zip.get('Mac product.data/data/project-config.json').bytes),config);
  // Editable backups must retain the recovered permissions as well.
  fs.writeFileSync(path.join(f.projectRoot,'data/project-config.json'),JSON.stringify(config));
  const backup=path.join(f.root,'project.wsmb');
  await f.archive.exportArchive({projectRoot:f.projectRoot,outputPath:backup,name:'Project',appVersion:'2.6.3',readConfig:file=>JSON.parse(fs.readFileSync(file))});
  assert.equal((await entries(backup)).get('dist-assets/'+data.root.slice('dist-assets/'.length)+'/Source.app/Contents/MacOS/Program').mode,0o100755);
});

test('Windows permission recovery still rejects fake native programs and never grants execution by extension',t=>{
  const f=fixture(t);
  f.write('Contents/MacOS/Program','not a native executable');
  assert.throws(()=>f.portable.importPortableProject({...f,entries:{mac:'.'}}),/Mach-O/);
  const fake=path.join(f.root,'fake.app');fs.writeFileSync(fake,'ordinary');
  assert.equal(f.portable.portableFileMode(fake,fs.statSync(fake))&0o111,0);
  assert.deepEqual(fs.readdirSync(f.assetsDir),[]);
});
