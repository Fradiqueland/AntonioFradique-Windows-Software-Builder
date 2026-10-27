'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {projectIcon,applyWindowIcon}=require('../src/shared/project-icon');
function fixture(t) {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'project-icon-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'data'));fs.mkdirSync(path.join(root,'dist-assets'));
  fs.writeFileSync(path.join(root,'data/icon-source.png'),'IMAGE');
  return {root,assetsDir:path.join(root,'dist-assets'),config:{brand:{title:'App'},export:{iconPath:'data/icon-source.png'}}};
}
test('selected icon reaches Windows window/taskbar and Mac Dock; project identities stay separate',t=>{
  const f=fixture(t),calls=[],image={isEmpty:()=>false,resize:()=>({toPNG:()=>Buffer.from('PNG')})};
  const options={...f,nativeImage:{createFromPath:p=>{assert.equal(p,path.join(f.root,'data/icon-source.png'));return image;}},window:{setIcon:i=>calls.push(['icon',i]),setAppDetails:d=>calls.push(['details',d])},app:{getPath:()=>f.root,dock:{setIcon:i=>calls.push(['dock',i])}},standalone:true};
  assert.equal(applyWindowIcon({...options,platform:'win32'}),true);
  assert.equal(calls[0][1],image);const id=calls[1][1].appId;
  const ico=fs.readFileSync(calls[1][1].appIconPath);assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),6);assert.equal(ico[6+5*16],0);
  calls.length=0;applyWindowIcon({...options,config:{...f.config,brand:{title:'Different'}},platform:'win32'});
  assert.notEqual(calls[1][1].appId,id);
  calls.length=0;applyWindowIcon({...options,platform:'darwin'});assert.deepEqual(calls,[['dock',image]]);
  calls.length=0;applyWindowIcon({...options,platform:'darwin',standalone:false});assert.deepEqual(calls,[]);
  assert.equal(applyWindowIcon({...options,config:{},platform:'win32'}),false);
});
test('icon lookup rejects traversal, external files, symlinks and invalid images',t=>{
  const f=fixture(t);
  for(const iconPath of ['../secret.png','/etc/passwd','data/../icon.png','dist-assets/icon.png'])assert.throws(()=>projectIcon({export:{iconPath}},f.assetsDir),/Caminho/);
  assert.throws(()=>applyWindowIcon({...f,nativeImage:{createFromPath:()=>({isEmpty:()=>true})}}),/ler o ícone/);
  fs.unlinkSync(path.join(f.root,'data/icon-source.png'));
  const target=path.join(f.root,'outside.png');fs.writeFileSync(target,'OUTSIDE');
  // Junctions cover directory tests on Windows; file symlinks need Developer Mode.
  if(process.platform!=='win32') {
    fs.symlinkSync(target,path.join(f.root,'data/icon-source.png'));
    assert.throws(()=>projectIcon(f.config,f.assetsDir),/inválido/);
  }
});
