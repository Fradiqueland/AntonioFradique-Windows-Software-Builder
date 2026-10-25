'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const yazl=require('yazl');
const sfx=require('../src/shared/sfx-assets');
const engine=require('../src/shared/project-export');

function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sfx-assets-')));
  t.after(()=>fs.rmSync(path.toNamespacedPath(root),{recursive:true,force:true}));
  const assetsDir=path.join(root,'source'),resourcesDir=path.join(root,'resources');
  fs.mkdirSync(assetsDir);fs.mkdirSync(resourcesDir);
  return {root,assetsDir,resourcesDir,config:{brand:{title:'Test'},content:[]}};
}
async function crafted(f,entries) {
  const zip=new yazl.ZipFile();
  const filename=path.join(f.resourcesDir,sfx.PACKAGE_FILE);
  const writing=pipeline(zip.outputStream,fs.createWriteStream(filename));
  for(const e of entries)zip.addBuffer(Buffer.from(e.data),e.name,{compress:false,mode:e.mode||0o100644});
  zip.end();await writing;
  const bytes=fs.readFileSync(filename);
  const d={format:'wsmb-sfx-assets',version:1,entries:entries.length,bytes:entries.reduce((n,e)=>n+Buffer.byteLength(e.data),0),archiveBytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  fs.writeFileSync(path.join(f.resourcesDir,sfx.DESCRIPTOR_FILE),JSON.stringify(d));
  return d;
}
function rehash(f) {
  const bytes=fs.readFileSync(path.join(f.resourcesDir,sfx.PACKAGE_FILE));
  const filename=path.join(f.resourcesDir,sfx.DESCRIPTOR_FILE);
  const d=JSON.parse(fs.readFileSync(filename));
  d.sha256=crypto.createHash('sha256').update(bytes).digest('hex');d.archiveBytes=bytes.length;
  fs.writeFileSync(filename,JSON.stringify(d));
}

test('SFX opaque transport restores long cache paths and 72 directory levels without changing source bytes',async t=>{
  const f=fixture(t);
  const relative=['portable-profile',...Array(72).fill('d'),'Code Cache','electron-preload','a'.repeat(64)+'-'+'b'.repeat(64)+'.cache'].join('/');
  const original=path.join(f.assetsDir,...relative.split('/'));
  fs.mkdirSync(path.toNamespacedPath(path.dirname(original)),{recursive:true});
  const bytes=crypto.randomBytes(4096);fs.writeFileSync(path.toNamespacedPath(original),bytes);
  fs.mkdirSync(path.join(f.assetsDir,'empty'));
  await sfx.packAssets(f);
  assert.deepEqual(fs.readdirSync(f.resourcesDir).sort(),[sfx.DESCRIPTOR_FILE,sfx.PACKAGE_FILE].sort());
  fs.mkdirSync(path.join(f.resourcesDir,'dist-assets'));
  const result=await sfx.restoreAssets(f.resourcesDir);
  assert.equal(result.restored,true);assert.equal(result.bytes,bytes.length);
  const restored=path.join(f.resourcesDir,'dist-assets',...relative.split('/'));
  assert.ok(restored.length>260);
  assert.deepEqual(fs.readFileSync(path.toNamespacedPath(restored)),bytes);
  assert.deepEqual(fs.readFileSync(path.toNamespacedPath(original)),bytes);
  assert.ok(fs.statSync(path.join(f.resourcesDir,'dist-assets','empty')).isDirectory());
  assert.equal(fs.existsSync(path.join(f.resourcesDir,sfx.PACKAGE_FILE)),false);
  assert.deepEqual(await sfx.restoreAssets(f.resourcesDir),{restored:false,reused:true});
  assert.throws(()=>sfx.cleanupTemporaryAssets(f.resourcesDir,path.join(f.root,'source')),/temporária/);
  assert.ok(fs.existsSync(path.toNamespacedPath(restored)));
  assert.equal(sfx.cleanupTemporaryAssets(f.resourcesDir,f.root),true);
  assert.equal(fs.existsSync(path.join(f.resourcesDir,'dist-assets')),false);
  assert.deepEqual(fs.readFileSync(path.toNamespacedPath(original)),bytes);
});

test('archive paths have no artificial 2048 character or 64 level cap while traversal remains invalid',()=>{
  const name=Array(180).fill('directory-name').join('/')+'/file.cache';
  assert.ok(name.length>2048);assert.equal(engine.archiveIO.validPath(name).length,181);
  for(const bad of ['../escape','a/../../escape','/root','C:/escape','a\\b','a/CON','a/./b'])assert.throws(()=>engine.archiveIO.validPath(bad));
});

test('legacy resources remain readable and missing transport metadata is rejected',async t=>{
  const f=fixture(t);assert.deepEqual(await sfx.restoreAssets(f.resourcesDir),{restored:false,legacy:true});
  fs.writeFileSync(path.join(f.resourcesDir,sfx.PACKAGE_FILE),'incomplete');
  await assert.rejects(sfx.restoreAssets(f.resourcesDir),/metadados/);
});

test('SFX refuses changed transport bytes before writing resources',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.assetsDir,'data.txt'),'ORIGINAL');await sfx.packAssets(f);
  const filename=path.join(f.resourcesDir,sfx.PACKAGE_FILE),bytes=fs.readFileSync(filename);bytes[40]^=1;fs.writeFileSync(filename,bytes);
  await assert.rejects(sfx.restoreAssets(f.resourcesDir),/corrompidos/);
  assert.equal(fs.existsSync(path.join(f.resourcesDir,'dist-assets')),false);
  assert.equal(fs.readFileSync(path.join(f.assetsDir,'data.txt'),'utf8'),'ORIGINAL');
});

test('SFX validates CRC even if transport hash matches and removes partial extraction',async t=>{
  const f=fixture(t);await crafted(f,[{name:'data.txt',data:'ORIGINAL'}]);
  const filename=path.join(f.resourcesDir,sfx.PACKAGE_FILE),bytes=fs.readFileSync(filename);
  bytes[bytes.indexOf(Buffer.from('ORIGINAL'))]^=1;fs.writeFileSync(filename,bytes);rehash(f);
  await assert.rejects(sfx.restoreAssets(f.resourcesDir),/CRC/);
  assert.equal(fs.existsSync(path.join(f.resourcesDir,'dist-assets')),false);
  assert.equal(fs.readdirSync(f.resourcesDir).some(n=>n.startsWith('.assets-unpack-')),false);
});

test('SFX refuses traversal, case collisions, symlinks and reserved receipts before extraction',async t=>{
  for(const kind of ['traversal','collision','symlink','receipt']) {
    const f=fixture(t);
    if(kind==='collision')await crafted(f,[{name:'Data.txt',data:'one'},{name:'data.txt',data:'two'}]);
    else if(kind==='symlink')await crafted(f,[{name:'link',data:'../outside',mode:0o120777}]);
    else if(kind==='receipt')await crafted(f,[{name:sfx.RECEIPT_FILE,data:'{}'}]);
    else {
      await crafted(f,[{name:'safe.txt',data:'one'}]);
      const filename=path.join(f.resourcesDir,sfx.PACKAGE_FILE);
      fs.writeFileSync(filename,Buffer.from(fs.readFileSync(filename).toString('latin1').replaceAll('safe.txt','../evil!'),'latin1'));rehash(f);
    }
    await assert.rejects(sfx.restoreAssets(f.resourcesDir));
    assert.equal(fs.existsSync(path.join(f.resourcesDir,'dist-assets')),false);
    assert.equal(fs.existsSync(path.join(f.root,'evil!')),false);
  }
});

test('SFX never overwrites existing resources or packages inside the original source',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.assetsDir,'original'),'SOURCE');await sfx.packAssets(f);
  const destination=path.join(f.resourcesDir,'dist-assets');fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'keep'),'EXISTING');
  await assert.rejects(sfx.restoreAssets(f.resourcesDir),/recursos diferentes/);
  assert.equal(fs.readFileSync(path.join(destination,'keep'),'utf8'),'EXISTING');
  await assert.rejects(sfx.packAssets({...f,resourcesDir:path.join(f.assetsDir,'nested')}),/fora dos recursos/);
  assert.equal(fs.readFileSync(path.join(f.assetsDir,'original'),'utf8'),'SOURCE');
});

test('SFX checks declared counts and byte totals before extraction',async t=>{
  for(const field of ['entries','bytes','archiveBytes']) {
    const f=fixture(t);await crafted(f,[{name:'data.txt',data:'bytes'}]);
    const filename=path.join(f.resourcesDir,sfx.DESCRIPTOR_FILE),d=JSON.parse(fs.readFileSync(filename));d[field]++;fs.writeFileSync(filename,JSON.stringify(d));
    await assert.rejects(sfx.restoreAssets(f.resourcesDir));
    assert.equal(fs.existsSync(path.join(f.resourcesDir,'dist-assets')),false);
  }
});
