'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const asar=require('@electron/asar');

function fixture(t) {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'builder-ui-root-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const resources=path.join(root,'resources');fs.mkdirSync(resources);
  return {root,resources};
}
function productionRoot(resources,appPath,{platform='win32',packaged=true}={}) {
  const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  const source=main.slice(main.indexOf('const PROJECT_ROOT ='),main.indexOf('function macProjectDirectory'));
  return vm.runInNewContext(source+'\nPROJECT_ROOT;',{
    app:{isPackaged:packaged,resourcesPath:resources,getAppPath:()=>appPath},
    process:{platform,resourcesPath:resources},fs,path,__dirname:appPath
  });
}

test('packaged Windows Builder loads its real resources/app directory',t=>{
  const f=fixture(t),appPath=path.join(f.resources,'app');
  fs.mkdirSync(path.join(appPath,'src/builder'),{recursive:true});
  fs.writeFileSync(path.join(appPath,'src/builder/index.html'),'<h1>Builder interface</h1>');
  const root=productionRoot(f.resources,appPath);
  assert.equal(root,appPath);
  assert.equal(fs.readFileSync(path.join(root,'src/builder/index.html'),'utf8'),'<h1>Builder interface</h1>');
});

test('packaged Windows Viewer retains its real resources/app.asar archive',async t=>{
  const f=fixture(t),source=path.join(f.root,'viewer-source'),appPath=path.join(f.resources,'app.asar');
  fs.mkdirSync(path.join(source,'src/viewer'),{recursive:true});
  fs.writeFileSync(path.join(source,'src/viewer/index.html'),'<h1>Viewer interface</h1>');
  await asar.createPackage(source,appPath);
  const root=productionRoot(f.resources,appPath);
  assert.equal(root,appPath);
  assert.equal(asar.extractFile(root,'src/viewer/index.html').toString(),'<h1>Viewer interface</h1>');
});

test('Windows directory aliases canonicalise without changing app versus app.asar',t=>{
  const f=fixture(t),alias=path.join(f.root,'alias');
  try{fs.symlinkSync(f.resources,alias,process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code))return t.skip('Directory links unavailable');throw error;}
  for(const name of ['app','app.asar']){
    const appPath=path.join(alias,name);
    assert.equal(productionRoot(alias,appPath),path.join(f.resources,name));
  }
});

test('Mac and development keep their existing application source root',t=>{
  const f=fixture(t),macPath=path.join(f.resources,'app.asar');
  assert.equal(productionRoot(f.resources,macPath,{platform:'darwin'}),macPath);
  assert.equal(productionRoot(f.resources,f.root,{packaged:false}),f.root);
});

test('failed Builder page load reports a visible error and exits instead of leaving a blank window',async()=>{
  const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  const source=main.slice(main.indexOf('async function loadBuilderPage('),main.indexOf('function createBuilderWindow('));
  const errors=[];let quit=0;
  const load=vm.runInNewContext(source+'\nloadBuilderPage;',{
    path,PROJECT_ROOT:'/installed/resources/app',console:{error(){}},
    dialog:{showErrorBox:(...args)=>errors.push(args)},app:{quit:()=>quit++}
  });
  await load({loadFile:async()=>{throw new Error('ERR_FILE_NOT_FOUND');},isDestroyed:()=>false});
  assert.equal(errors.length,1);assert.match(errors[0][1],/projetos guardados não foram alterados/);
  assert.match(errors[0][1],/ERR_FILE_NOT_FOUND/);assert.equal(quit,1);
  await load({loadFile:async()=>{},isDestroyed:()=>false});
  assert.equal(errors.length,1);assert.equal(quit,1);
});
