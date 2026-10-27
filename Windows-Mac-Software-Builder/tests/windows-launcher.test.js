'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const bundle=require('../src/shared/windows-launcher');
function fixture(t){const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'native-bundle-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('single EXE footer locates its exact payload and transport bytes survive packaging',async t=>{
 const root=fixture(t),stubPath=path.join(root,'stub.exe'),extractorPath=path.join(root,'7za.exe'),archivePath=path.join(root,'payload.7z'),outputPath=path.join(root,'app.exe');
 const stub=crypto.randomBytes(2048),extractor=crypto.randomBytes(3072),archive=crypto.randomBytes(1024*1024);for(const [file,data]of[[stubPath,stub],[extractorPath,extractor],[archivePath,archive]])fs.writeFileSync(file,data);
 const info=await bundle.packBundle({stubPath,extractorPath,archivePath,outputPath});assert.equal(info.stubBytes,stub.length);assert.equal(info.archiveBytes,archive.length);
 const outputs={extractorPath:path.join(root,'unpacked.exe'),archivePath:path.join(root,'unpacked.7z')};await bundle.extractTransport(outputPath,outputs);
 assert.deepEqual(fs.readFileSync(outputs.extractorPath),extractor);assert.deepEqual(fs.readFileSync(outputs.archivePath),archive);
 const bytes=fs.readFileSync(outputPath);bytes[info.stubBytes+info.extractorBytes+100]^=1;fs.writeFileSync(outputPath,bytes);
 await assert.rejects(bundle.extractTransport(outputPath,{extractorPath:path.join(root,'changed.exe'),archivePath:path.join(root,'changed.7z')}),/corrompido/);
});
test('footer rejects truncation, overflow, unsupported versions and changed identity',()=>{
 const info={stubBytes:2048,extractorBytes:2048,archiveBytes:4096,extractorSha256:'a'.repeat(64),archiveSha256:'b'.repeat(64)};
 const footer=bundle.footerFor(info),size=2048+2048+4096+256;assert.equal(bundle.parseFooter(footer,size).archiveSha256,info.archiveSha256);
 for(const offset of [0,16,20,24,48,80,224]){const changed=Buffer.from(footer);changed[offset]^=1;assert.throws(()=>bundle.parseFooter(changed,size));}
 assert.throws(()=>bundle.parseFooter(footer,size-1));assert.throws(()=>bundle.footerFor({...info,archiveBytes:Number.MAX_SAFE_INTEGER}));
});

test('engine receipts describe the shipped engine and exact sizes without assuming optional upstream files',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'resources'));
 for(const name of ['LaunchBox Viewer.exe','icudtl.dat','ffmpeg.dll','resources/app.asar','resources/app-mode.json'])fs.writeFileSync(path.join(root,name),'ENGINE '+name);
 fs.writeFileSync(path.join(root,'optional-empty.bin'),'');
 const files=bundle.writeEngineManifest(root),bytes=fs.readFileSync(path.join(root,bundle.ENGINE_MANIFEST));
 assert.equal(bytes.subarray(0,16).toString('ascii'),'WSMB-RUNTIME-V1\0');assert.equal(bytes.readUInt32LE(16),5);assert.equal(bytes.length,24+5*264);
 assert.ok(!files.some(f=>f.name==='optional-empty.bin'||f.name==='v8_context_snapshot.bin'));
 for(let i=0;i<files.length;i++){
  assert.equal(bytes.subarray(24+i*264,24+i*264+256).toString('utf16le').replace(/\0.*$/s,''),files[i].name.replace(/\//g,'\\'));
  assert.equal(Number(bytes.readBigUInt64LE(24+i*264+256)),fs.statSync(path.join(root,files[i].name)).size);
 }
 const old=fs.readFileSync(path.join(root,bundle.ENGINE_MANIFEST));assert.throws(()=>bundle.writeEngineManifest(root));assert.deepEqual(fs.readFileSync(path.join(root,bundle.ENGINE_MANIFEST)),old);
 fs.unlinkSync(path.join(root,bundle.ENGINE_MANIFEST));fs.unlinkSync(path.join(root,'resources/app-mode.json'));assert.throws(()=>bundle.writeEngineManifest(root));assert.equal(fs.existsSync(path.join(root,bundle.ENGINE_MANIFEST)),false);
});
