'use strict';

// The legacy SFX extracts only the short-named Viewer and this opaque payload.
// Electron/Node restores project assets through long-path-capable filesystem
// APIs before the Viewer opens. No source file or portable profile is pruned.
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const engine = require('./project-export');
const PACKAGE_FILE = 'project-assets.zip';
const DESCRIPTOR_FILE = 'project-assets.json';
const RECEIPT_FILE = '.wsmb-assets-ready.json';
const FORMAT = 'wsmb-sfx-assets';
const disk = filename => path.toNamespacedPath(filename);
const exists = filename => fs.existsSync(disk(filename));

async function hashFile(filename) {
  const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(disk(filename))) digest.update(bytes);
  return digest.digest('hex');
}
function metadata(filename) {
  const stat = fs.lstatSync(disk(filename));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Metadados dos recursos inválidos.');
  return JSON.parse(fs.readFileSync(disk(filename), 'utf8'));
}
function validateDescriptor(d) {
  if (!d || d.format !== FORMAT || d.version !== 1 || !/^[a-f0-9]{64}$/.test(d.sha256 || '') ||
      ![d.entries,d.bytes,d.archiveBytes].every(n => Number.isSafeInteger(n) && n >= 0) ||
      d.entries>engine.archiveIO.LIMITS.entries || d.bytes>engine.archiveIO.LIMITS.totalBytes) throw new Error('Formato dos recursos da aplicação inválido.');
  return d;
}
function ready(root, d) {
  if (!exists(root)) return false;
  const stat = fs.lstatSync(disk(root));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Destino dos recursos inválido.');
  const marker = path.join(root, RECEIPT_FILE);
  if (!exists(marker)) return false;
  const receipt = metadata(marker);
  return receipt.format === FORMAT && receipt.version === 1 && receipt.sha256 === d.sha256;
}

async function packAssets({ assetsDir, resourcesDir, config }) {
  const yazl = require('yazl');
  fs.mkdirSync(disk(resourcesDir), {recursive:true});
  const realAssets = fs.realpathSync(disk(assetsDir));
  const realResources = fs.realpathSync(disk(resourcesDir));
  const rel = path.relative(realAssets,realResources);
  if (!rel || (rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel))) throw new Error('A preparação da exportação deve ficar fora dos recursos originais.');
  const assets = await engine.inspectProjectAssets({ config, assetsDir, target:'windows' });
  if (assets.links.length) throw new Error('Recursos com ligações simbólicas requerem a exportação Windows ZIP.');
  if (assets.entries.some(e=>e.relative.toLowerCase()===RECEIPT_FILE)) throw new Error('Nome de recurso reservado: '+RECEIPT_FILE);
  const output = path.join(resourcesDir,PACKAGE_FILE), descriptor = path.join(resourcesDir,DESCRIPTOR_FILE);
  if (exists(output) || exists(descriptor)) throw new Error('O modelo contém recursos de outra exportação.');
  const temporary = output+'.'+crypto.randomUUID()+'.tmp';
  const archive = new yazl.ZipFile();
  let createdOutput=false,createdDescriptor=false;
  const writing = pipeline(archive.outputStream,fs.createWriteStream(disk(temporary),{flags:'wx'}));writing.catch(()=>{});
  const streams = new Set();
  try {
    for (const asset of assets.entries) {
      const options={mode:asset.mode,mtime:asset.stat.mtime,compress:false};
      if (asset.kind==='directory') archive.addEmptyDirectory(asset.relative+'/',{mode:asset.mode,mtime:asset.stat.mtime});
      else archive.addReadStreamLazy(asset.relative,{...options,size:asset.stat.size},callback=>{
        engine.archiveIO.assetStream(asset,assets.root).then(stream=>{
          streams.add(stream);stream.once('close',()=>streams.delete(stream));
          stream.once('error',error=>archive.outputStream.destroy(error));callback(null,stream);
        },error=>{callback(error);archive.outputStream.destroy(error);});
      });
    }
    archive.end();await writing;
    const d={format:FORMAT,version:1,sha256:await hashFile(temporary),entries:assets.entries.length,
      bytes:assets.files.reduce((sum,e)=>sum+e.stat.size,0),archiveBytes:fs.statSync(disk(temporary)).size};
    // resourcesDir is the export's private staging directory.
    fs.renameSync(disk(temporary),disk(output));createdOutput=true;
    const fd=fs.openSync(disk(descriptor),'wx');createdDescriptor=true;
    try {fs.writeFileSync(fd,JSON.stringify(d));}finally{fs.closeSync(fd);}
    return d;
  } catch(error) {
    for(const stream of streams)stream.destroy();archive.outputStream.destroy();await writing.catch(()=>{});
    if(createdOutput)fs.rmSync(disk(output),{force:true});
    if(createdDescriptor)fs.rmSync(disk(descriptor),{force:true});throw error;
  } finally {fs.rmSync(disk(temporary),{force:true});}
}

async function restoreAssets(resourcesDir) {
  const descriptor = path.join(resourcesDir,DESCRIPTOR_FILE),archivePath = path.join(resourcesDir,PACKAGE_FILE);
  const destination = path.join(resourcesDir,'dist-assets');
  if (!exists(descriptor)) {
    if (exists(archivePath)) throw new Error('Faltam os metadados dos recursos. Volte a exportar a aplicação.');
    return {restored:false,legacy:true};
  }
  const d=validateDescriptor(metadata(descriptor));
  if (ready(destination,d)) return {restored:false,reused:true};
  if (exists(destination) && fs.readdirSync(disk(destination)).length) throw new Error('Já existem recursos diferentes nesta pasta. Abra uma cópia completa da aplicação numa pasta nova.');
  const stat=fs.lstatSync(disk(archivePath));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size!==d.archiveBytes || await hashFile(archivePath)!==d.sha256) throw new Error('Os recursos da aplicação estão incompletos ou corrompidos. Volte a exportar ou descarregar a aplicação.');
  const archive=await engine.archiveIO.openZip(disk(archivePath));
  const entries=[],paths=new Map();let bytes=0,zipError;
  archive.on('error',error=>{zipError=error;});
  const staging=path.join(resourcesDir,'.assets-unpack-'+crypto.randomUUID());
  try {
    await new Promise((resolve,reject)=>{
      archive.once('error',reject);archive.once('end',resolve);
      archive.on('entry',entry=>{
        try {
          const mode=entry.externalFileAttributes>>>16,type=mode&0o170000;
          const kind=entry.fileName.endsWith('/')?'directory':'file';
          if (entry.isEncrypted() || ![0,8].includes(entry.compressionMethod) ||
              (type && type!==(kind==='directory'?0o040000:0o100000)) ||
              !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize<0 || entry.uncompressedSize>engine.archiveIO.LIMITS.fileBytes ||
              (kind==='directory' && entry.uncompressedSize)) throw new Error('Tipo de recurso inválido no pacote.');
          engine.archiveIO.registerPath(paths,entry.fileName,kind);
          const relative=entry.fileName.replace(/\/$/,'');
          if (relative.toLowerCase()===RECEIPT_FILE) throw new Error('Recurso reservado no pacote.');
          bytes+=entry.uncompressedSize;
          if (!Number.isSafeInteger(bytes) || bytes>d.bytes || entries.length>=d.entries) throw new Error('O pacote não corresponde aos recursos declarados.');
          entries.push({entry,relative,kind,mode:mode&0o777});archive.readEntry();
        } catch(error){reject(error);}
      });archive.readEntry();
    });
    if (entries.length!==d.entries || bytes!==d.bytes) throw new Error('O pacote está incompleto.');
    fs.mkdirSync(disk(staging),{mode:0o700});
    for (const item of entries) {
      const filename=path.join(staging,...item.relative.split('/'));
      if (item.kind==='directory') fs.mkdirSync(disk(filename),{recursive:true,mode:0o700});
      else {
        fs.mkdirSync(disk(path.dirname(filename)),{recursive:true,mode:0o700});
        await pipeline(await engine.archiveIO.entryStream(archive,item.entry),fs.createWriteStream(disk(filename),{flags:'wx',mode:0o600}));
        fs.chmodSync(disk(filename),item.mode);
      }
    }
    if (zipError) throw zipError;
    for (const item of entries.filter(e=>e.kind==='directory').sort((a,b)=>b.relative.length-a.relative.length)) fs.chmodSync(disk(path.join(staging,...item.relative.split('/'))),item.mode);
    fs.writeFileSync(disk(path.join(staging,RECEIPT_FILE)),JSON.stringify({format:FORMAT,version:1,sha256:d.sha256}),{flag:'wx'});
    if (exists(destination)) {
      if (ready(destination,d)) return {restored:false,reused:true};
      try {fs.rmdirSync(disk(destination));} // Only an existing empty directory may go.
      catch(error){if(ready(destination,d))return {restored:false,reused:true};throw error;}
    }
    try {fs.renameSync(disk(staging),disk(destination));}
    catch(error){if(!ready(destination,d))throw error;}
    // Reclaim the opaque transport after a complete atomic restore. A receipt
    // permits later starts from a manually retained, already expanded folder.
    try {fs.unlinkSync(disk(archivePath));}catch(_){}
    return {restored:true,files:entries.filter(e=>e.kind==='file').length,bytes};
  } finally {archive.close();fs.rmSync(disk(staging),{recursive:true,force:true});}
}
function cleanupTemporaryAssets(resourcesDir,temporaryRoot) {
  // Only the SFX launch flag calls this, and only inside its temporary root.
  // Plain ZIP exports and manually expanded Viewers keep their resources.
  const root=fs.realpathSync(disk(temporaryRoot));
  const resources=fs.realpathSync(disk(resourcesDir));
  const relative=path.relative(root,resources);
  if(!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative) || path.basename(resources)!=='resources') throw new Error('Pasta temporária SFX inválida.');
  const d=validateDescriptor(metadata(path.join(resources,DESCRIPTOR_FILE)));
  const destination=path.join(resources,'dist-assets');
  if(!ready(destination,d))return false;
  // The old SFX cannot reliably remove these same long paths at shutdown.
  fs.rmSync(disk(destination),{recursive:true,force:true,maxRetries:3,retryDelay:100});
  return true;
}
module.exports={PACKAGE_FILE,DESCRIPTOR_FILE,RECEIPT_FILE,packAssets,restoreAssets,cleanupTemporaryAssets};
