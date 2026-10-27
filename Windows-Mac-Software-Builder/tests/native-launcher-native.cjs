'use strict';
// A small native Windows-only gate runs before the expensive installer jobs.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync,spawn}=require('node:child_process');
const {packBundle}=require('../src/shared/windows-launcher');
test('native bootstrap prepares once, skips all payload I/O on warm starts and repairs missing runtime', {skip:process.platform!=='win32'},async t=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'wsmb-native-check-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stage=path.join(root,'stage'),resources=path.join(stage,'resources');fs.mkdirSync(path.join(resources,'data'),{recursive:true});
 fs.copyFileSync(process.execPath,path.join(stage,'LaunchBox Viewer.exe'));
 fs.writeFileSync(path.join(resources,'app.asar'),'native fixture');fs.writeFileSync(path.join(resources,'data/project-config.json'),'{}');fs.writeFileSync(path.join(resources,'project-assets.json'),'{}');fs.writeFileSync(path.join(resources,'project-assets.zip'),'fixture');
 const sevenZip=path.resolve(__dirname,'../src/builder/bin/7za.exe'),archive=path.join(root,'payload.7z'),output=path.join(root,'Prepared app.exe');
 execFileSync(sevenZip,['a','-t7z','-mx=1',archive,stage+path.sep+'*'],{stdio:'ignore',windowsHide:true});
 const info=await packBundle({stubPath:path.resolve(__dirname,'../dist/native-launcher/windows-launcher.exe'),extractorPath:sevenZip,archivePath:archive,outputPath:output});
 const cache=path.join(process.env.LOCALAPPDATA,'WSMB/runtimes',info.archiveSha256);t.after(()=>fs.rmSync(cache,{recursive:true,force:true}));
 async function run(label){const report=path.join(root,label+'.json');await new Promise((resolve,reject)=>{const child=spawn(output,[],{env:{...process.env,WSMB_BOOT_REPORT:report,WSMB_BOOT_QUIET:'1'},stdio:'ignore'});const timer=setTimeout(()=>{child.kill();reject(new Error('Native bootstrap timed out'));},30000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);assert.equal(code,9,'Node fixture receives the controlled Viewer flags and exits with its bad-option status');resolve();});});return JSON.parse(fs.readFileSync(report));}
 const first=await run('first');assert.equal(first.cacheHit,false);assert.equal(first.archiveExtractions,1);assert.equal(first.payloadBytesRead,info.archiveBytes+info.extractorBytes);
 const marker=path.join(cache,'.wsmb-runtime-ready'),before=fs.statSync(marker).mtimeMs;
 const warm=await run('warm');assert.equal(warm.cacheHit,true);assert.equal(warm.payloadBytesRead,0);assert.equal(warm.archiveExtractions,0);assert.equal(fs.statSync(marker).mtimeMs,before);
 fs.unlinkSync(path.join(cache,'LaunchBox Viewer.exe'));const repaired=await run('repair');assert.equal(repaired.cacheHit,false);assert.equal(repaired.archiveExtractions,1);
 console.log('NATIVE_BOOTSTRAP_PASS',JSON.stringify({first,warm,repaired}));
});
