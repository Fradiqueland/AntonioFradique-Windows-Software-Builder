'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {projectIcon,applyWindowIcon,readIconImage,imageToIco}=require('../src/shared/project-icon');
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

test('removing a preview icon restores the default Windows icon and taskbar identity', t => {
  const f=fixture(t), calls=[], fallback=path.join(f.root,'default.png'), image={isEmpty:()=>false};
  applyWindowIcon({...f,config:{},platform:'win32',standalone:false,defaultIconPath:fallback,
    nativeImage:{createFromPath:file=>{assert.equal(file,fallback);return image;}},app:{},
    window:{setIcon:value=>calls.push(value),setAppDetails:details=>calls.push(details)}});
  assert.equal(calls[0],image);assert.deepEqual(calls[1],{appId:'com.launchbox.builder',appIconPath:fallback});
});

test('ICO bitmap and PNG frames decode on hosts that cannot load Windows ICO paths', async t => {
  const f=fixture(t), png=require('pngjs').PNG;
  const pixels=new png({width:16,height:16});
  for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=200;pixels.data[i+1]=100;pixels.data[i+2]=50;pixels.data[i+3]=255;}
  pixels.data[3]=0; pixels.data[7]=128;
  const pngBytes=png.sync.write(pixels), dib=await require('png-to-ico')([pngBytes]);
  const file=path.join(f.root,'data/icon-source.ico');fs.writeFileSync(file,dib);
  const empty={isEmpty:()=>true},decoded={isEmpty:()=>false};let bitmap;
  const native={createFromPath:()=>empty,createFromBitmap:(data,size)=>{bitmap={data,...size};return decoded;},createFromBuffer:()=>decoded};
  assert.equal(readIconImage(file,native),decoded);assert.equal(bitmap.width,16);assert.equal(bitmap.height,16);
  assert.deepEqual([...bitmap.data.subarray(0,12)],[0,0,0,0,25,50,100,128,50,100,200,255]);
  fs.writeFileSync(file,imageToIco({resize:()=>({toPNG:()=>pngBytes})}));
  assert.equal(readIconImage(file,native),decoded);
  const corrupted=Buffer.from(dib);corrupted.writeUInt32LE(corrupted.length+1,18);fs.writeFileSync(file,corrupted);
  assert.throws(()=>readIconImage(file,native),/ICO incompleto/);
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
