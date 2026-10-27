'use strict';

// Launch the application delivered by the installer, rather than wrapping
// selected functions from its source. CDP is enabled only by this test's CLI.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {sha256}=require('./release-payload');
const execFileP=promisify(execFile);
const root=path.resolve(__dirname,'..');
const pkg=require('../package.json');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

class DevTools {
  constructor(socket) {
    this.socket=socket;this.sequence=0;this.pending=new Map();
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      const request=this.pending.get(message.id);
      if(!request)return;
      this.pending.delete(message.id);clearTimeout(request.timer);
      if(message.error)request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    socket.addEventListener('close',()=>{
      for(const request of this.pending.values()){
        clearTimeout(request.timer);request.reject(new Error('Builder debugging connection closed'));
      }
      this.pending.clear();
    });
  }
  static async connect(url,port) {
    const parsed=new URL(url);
    assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,String(port));
    const socket=new WebSocket(url);
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{socket.close();reject(new Error('Builder debugging connection timed out'));},10000);
      socket.addEventListener('open',()=>{clearTimeout(timeout);resolve();},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('Cannot connect to Builder debugging port'));},{once:true});
    });
    return new DevTools(socket);
  }
  send(method,params={}) {
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Builder command timed out: '+method));},12000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.socket.send(JSON.stringify({id,method,params}));}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  async evaluate(expression) {
    const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close(){this.socket.close();}
}

async function freePort() {
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}

async function main() {
  if(!['win32','darwin'].includes(process.platform))throw new Error('Run Builder installation/startup checks on native Windows or Mac.');
  const mac=process.platform==='darwin';
  const report={status:'running',platform:process.platform,appVersion:pkg.version,checks:[]};
  const reportFile=path.join(root,'build-builder-startup.json');
  const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'builder-installed-startup-')));
  // Use the package basename for NSIS: its assisted installer may append its
  // application folder, and its legacy /D token parser truncates spaces.
  const installDir=path.join(temporary,mac?'Installed Builder António':pkg.name);
  fs.mkdirSync(installDir);
  const name='Windows-Mac-Software-Builder-'+pkg.version+(mac?'-mac-universal.dmg':'-windows-x64-setup.exe');
  const installer=path.join(root,'dist/builder',name);
  report.installer={name,sha256:await sha256(installer)};
  let child,exited,exit,spawnError,client,mounted=false,logs='',installedRoot=installDir;
  let stage='installer';
  const progress=value=>{stage=value;console.log('[Builder startup] '+value);};
  const deadline=setTimeout(()=>{
    report.status='failed';report.error='Installed Builder check exceeded six minutes during '+stage;
    console.error(report.error);if(logs)console.error(logs);
    fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
    if(mac&&child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch(_){}try{child.kill('SIGKILL');}catch(_){}}
    process.exit(1);
  },6*60*1000);
  const mount=path.join(temporary,'mount');
  try {
    let executable;
    if(mac) {
      progress('mount actual DMG');
      fs.mkdirSync(mount);
      await execFileP('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,'-quiet',installer],{timeout:90000});mounted=true;
      const application=pkg.build.productName+'.app';
      const installed=path.join(installDir,application);
      progress('copy application from DMG');
      await execFileP('/usr/bin/ditto',[path.join(mount,application),installed],{timeout:120000});
      progress('detach DMG');
      await execFileP('/usr/bin/hdiutil',['detach',mount,'-quiet'],{timeout:30000});mounted=false;
      progress('verify installed Mac signature');
      await execFileP('/usr/bin/codesign',['--verify','--deep','--strict',installed],{timeout:30000});
      executable=path.join(installed,'Contents/MacOS',pkg.build.productName);
      report.checks.push('actual DMG mounted, application copied to an installation folder, copied signature verified');
    } else {
      progress('install actual Windows Setup');
      // NSIS requires /D to be last and unquoted, including spaces in its value.
      await execFileP(installer,['/S','/D='+installDir],{windowsVerbatimArguments:true,windowsHide:true,timeout:180000});
      const candidates=[installDir,...fs.readdirSync(installDir,{withFileTypes:true}).filter(item=>item.isDirectory()).map(item=>path.join(installDir,item.name))];
      installedRoot=candidates.find(directory=>fs.existsSync(path.join(directory,pkg.build.productName+'.exe'))&&fs.existsSync(path.join(directory,'resources/app/package.json')));
      assert.ok(installedRoot,'Setup must install the Builder inside its isolated destination: '+JSON.stringify(fs.readdirSync(installDir)));
      executable=path.join(installedRoot,pkg.build.productName+'.exe');
      const installedPackage=JSON.parse(fs.readFileSync(path.join(installedRoot,'resources/app/package.json'),'utf8'));
      assert.equal(installedPackage.version,pkg.version);
      report.checks.push('actual NSIS setup installs the current Builder in an isolated installation folder');
    }
    report.installationDirectory=installedRoot;
    fs.accessSync(executable);
    const port=await freePort();
    const profile=path.join(temporary,'profile');
    progress('launch installed Builder');
    child=spawn(executable,['--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1','--user-data-dir='+profile],{
      detached:mac,stdio:['ignore','pipe','pipe'],
      env:{...process.env,ELECTRON_ENABLE_LOGGING:'1',ELECTRON_LOG_FILE:path.join(temporary,'builder.log')}
    });
    exited=new Promise(resolve=>child.once('exit',(code,signal)=>{exit={code,signal};resolve();}));
    child.once('error',error=>{spawnError=error;});
    for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{logs=(logs+bytes.toString()).slice(-24000);});
    let target;const connectionDeadline=Date.now()+60000;
    for(let attempt=0;attempt<120&&!target&&Date.now()<connectionDeadline;attempt++) {
      if(spawnError)throw spawnError;
      if(exit)throw new Error('Installed Builder exited during startup: '+JSON.stringify(exit));
      try {
        const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(1500)});
        const pages=await response.json();target=pages.find(page=>page.type==='page'&&page.webSocketDebuggerUrl);
      } catch(_){}
      if(!target)await wait(250);
    }
    assert.ok(target,'Installed Builder must create its real editor page');
    client=await DevTools.connect(target.webSocketDebuggerUrl,port);
    progress('verify real editor and project IPC');
    const snapshot=`(async()=>{
      if(!window.icurator||!document.querySelector('.sidebar'))return {ready:false,url:location.href};
      const state=await window.icurator.projectsList();
      const config=await window.icurator.loadConfig();
      const targets=await window.icurator.getExportTargets();
      const active=document.getElementById('active-project-name').textContent;
      const rendered=document.querySelectorAll('#projects-list .project-item').length;
      const photoLoaded=!!document.querySelector('.author-photo')?.naturalWidth;
      return {ready:rendered>0&&active!=='—'&&!document.getElementById('project-new-btn').disabled&&photoLoaded,
        url:location.href,version:window.icurator.version,active,projectCount:state.projects.length,rendered,
        sidebarWidth:document.querySelector('.sidebar').getBoundingClientRect().width,
        authorPhotoLoaded:photoLoaded,
        authorLink:document.querySelector('.author-card a')?.getAttribute('data-ext'),
        configTitle:config.brand.title,targets};
    })()`;
    let state,lastError;const editorDeadline=Date.now()+60000;
    for(let attempt=0;attempt<120&&Date.now()<editorDeadline;attempt++) {
      if(exit)throw new Error('Installed Builder exited before loading projects: '+JSON.stringify(exit));
      try {state=await client.evaluate(snapshot);if(state?.ready)break;}
      catch(error){lastError=error.message;}
      await wait(250);
    }
    assert.ok(state?.ready,'Installed Builder must render the editor and project list: '+JSON.stringify({state,lastError}));
    assert.match(state.url,/\/src\/builder\/index\.html$/);
    assert.equal(state.version,pkg.version);assert.ok(state.sidebarWidth>100);
    assert.equal(state.authorPhotoLoaded,true,'Installed Builder must include and display the author photograph');
    assert.equal(state.authorLink,'https://AntonioFradique.net');
    assert.equal(state.projectCount,state.rendered);assert.ok(state.configTitle);
    report.editor=state;
    report.checks.push('installed Builder renders its real editor, preload and strict privileged IPC load the current version and projects');
    report.checks.push('installed Builder displays the bundled author photograph and products link');
    progress('verify installed editor navigation');
    for(const [tab,panel] of [['projetos','projetos'],['aparencia','brand'],['publicar','export'],['content','content']]) {
      await client.evaluate(`document.querySelector('.tab[data-tab="${tab}"]').click()`);
      const visible=await client.evaluate(`(()=>{const panel=document.querySelector('.panel[data-panel="${panel}"]');return panel&&!panel.classList.contains('hidden')&&panel.getBoundingClientRect().height>0;})()`);
      assert.ok(visible,'Installed Builder navigation failed: '+tab);
    }
    report.checks.push('actual Projects, Appearance, Publish and Content buttons switch to visible panels without a blank window');
    assert.equal(await sha256(installer),report.installer.sha256,'The installer tested for startup must remain byte-identical');
    report.status='passed';
    console.log('INSTALLED BUILDER STARTUP PASSED ('+process.platform+'): '+report.checks.join(', '));
  } catch(error) {
    report.status='failed';report.error=error.stack||String(error);
    if(logs)console.error(logs);
    const file=path.join(temporary,'builder.log');
    if(fs.existsSync(file))console.error(fs.readFileSync(file,'utf8').slice(-16000));
    throw error;
  } finally {
    progress('clean up installed test application');
    if(client)client.close();
    if(child&&!exit&&child.pid) {
      if(mac){try{process.kill(-child.pid,'SIGTERM');}catch(_) {}}
      else await execFileP('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15000}).catch(()=>{});
      await Promise.race([exited,wait(5000)]);
      if(mac&&!exit){try{process.kill(-child.pid,'SIGKILL');}catch(_){}try{child.kill('SIGKILL');}catch(_){}await Promise.race([exited,wait(5000)]);}
    }
    // A Chromium helper can outlive the main process with inherited pipes.
    // Do not let test-owned process handles keep the Node checker running.
    if(child){child.stdout?.destroy();child.stderr?.destroy();child.unref();}
    if(mounted)await execFileP('/usr/bin/hdiutil',['detach',mount,'-quiet'],{timeout:30000}).catch(()=>{});
    if(!mac) {
      const uninstaller=path.join(installedRoot||installDir,'Uninstall '+pkg.build.productName+'.exe');
      if(fs.existsSync(uninstaller))await execFileP(uninstaller,['/S'],{windowsHide:true,timeout:60000}).catch(error=>console.warn('Test uninstall:',error.message));
    }
    fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
    try{fs.rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){console.warn('Test temporary cleanup:',error.message);}
    clearTimeout(deadline);
  }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
