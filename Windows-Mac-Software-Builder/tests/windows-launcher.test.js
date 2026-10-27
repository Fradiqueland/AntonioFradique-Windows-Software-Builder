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
