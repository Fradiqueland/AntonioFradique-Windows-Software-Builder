'use strict';
const fs = process.versions.electron ? require('original-fs') : require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const MAGIC = Buffer.from('WSMB-LAUNCH-V1\0\0', 'ascii');
const FOOTER_BYTES = 256;
const ENGINE_MANIFEST = '.wsmb-engine-files';
function writeEngineManifest(root) {
  const path = require('path');
  const names = fs.readdirSync(root).filter(name => /\.(?:exe|dll|pak|bin|dat|json)$/i.test(name));
  names.push('resources/app.asar', 'resources/app-mode.json');
  if (fs.existsSync(path.join(root, 'locales/en-US.pak'))) names.push('locales/en-US.pak');
  const files = names.map(name => ({ name, stat: fs.lstatSync(path.join(root, name)) }))
    .filter(({stat}) => stat.isFile() && !stat.isSymbolicLink() && stat.size > 0)
    .map(({name,stat}) => ({ name, size: stat.size }));
  if (!files.some(f => f.name === 'LaunchBox Viewer.exe') || !files.some(f => f.name === 'resources/app.asar') || !files.some(f => f.name === 'resources/app-mode.json') || files.length > 64) throw new Error('Motor Windows incompleto.');
  const bytes = Buffer.alloc(24 + files.length * 264);
  bytes.write('WSMB-RUNTIME-V1\0', 0, 'ascii'); bytes.writeUInt32LE(files.length, 16);
  files.forEach(({name,size}, index) => {
    if (!/^[A-Za-z0-9._ /-]+$/.test(name) || name.includes('..') || name.startsWith('/') || name.length > 127 || !Number.isSafeInteger(size)) throw new Error('Componente Windows inválido.');
    const offset = 24 + index * 264;
    bytes.write(name.replace(/\//g, '\\'), offset, 254, 'utf16le');
    bytes.writeBigUInt64LE(BigInt(size), offset + 256);
  });
  fs.writeFileSync(path.join(root, ENGINE_MANIFEST), bytes, {flag:'wx'});
  return files;
}
async function hashFile(file) {
  const hash=crypto.createHash('sha256');
  for await(const bytes of fs.createReadStream(file))hash.update(bytes);
  return hash.digest();
}
function footerFor({stubBytes,extractorBytes,archiveBytes,extractorSha256,archiveSha256}) {
  for(const size of [stubBytes,extractorBytes,archiveBytes])if(!Number.isSafeInteger(size)||size<=0)throw new Error('Tamanho inválido no lançador Windows.');
  if(stubBytes>16*1024**2||extractorBytes>16*1024**2||archiveBytes>32*1024**3)throw new Error('Pacote Windows demasiado grande.');
  const footer=Buffer.alloc(FOOTER_BYTES);MAGIC.copy(footer);
  footer.writeUInt32LE(1,16);footer.writeUInt32LE(FOOTER_BYTES,20);
  [stubBytes,extractorBytes,archiveBytes].forEach((n,i)=>footer.writeBigUInt64LE(BigInt(n),24+8*i));
  for(const [value,offset] of [[extractorSha256,48],[archiveSha256,80]]) {
    const digest=Buffer.isBuffer(value)?value:Buffer.from(value,'hex');
    if(digest.length!==32)throw new Error('SHA-256 inválido no lançador Windows.');digest.copy(footer,offset);
  }
  crypto.createHash('sha256').update(footer.subarray(0,224)).digest().copy(footer,224);
  return footer;
}
function parseFooter(footer,totalBytes) {
  if(footer.length!==FOOTER_BYTES||!footer.subarray(0,MAGIC.length).equals(MAGIC)||footer.readUInt32LE(16)!==1||footer.readUInt32LE(20)!==FOOTER_BYTES||
    !crypto.createHash('sha256').update(footer.subarray(0,224)).digest().equals(footer.subarray(224)))throw new Error('Lançador Windows incompleto ou corrompido.');
  const values=[24,32,40].map(offset=>Number(footer.readBigUInt64LE(offset)));
  const [stubBytes,extractorBytes,archiveBytes]=values;
  footerFor({stubBytes,extractorBytes,archiveBytes,extractorSha256:footer.subarray(48,80),archiveSha256:footer.subarray(80,112)});
  if(!Number.isSafeInteger(totalBytes)||stubBytes+extractorBytes+archiveBytes+FOOTER_BYTES!==totalBytes)throw new Error('Tamanho do executável Windows inválido.');
  return {stubBytes,extractorBytes,archiveBytes,extractorSha256:footer.subarray(48,80).toString('hex'),archiveSha256:footer.subarray(80,112).toString('hex')};
}
async function readBundle(file) {
  const handle=await fs.promises.open(file,'r');
  try {
    const stat=await handle.stat();if(stat.size<FOOTER_BYTES)throw new Error('Lançador Windows incompleto.');
    const footer=Buffer.alloc(FOOTER_BYTES);
    const {bytesRead}=await handle.read(footer,0,FOOTER_BYTES,stat.size-FOOTER_BYTES);
    if(bytesRead!==FOOTER_BYTES)throw new Error('Lançador Windows incompleto.');
    return parseFooter(footer,stat.size);
  }finally{await handle.close();}
}
async function packBundle({stubPath,extractorPath,archivePath,outputPath}) {
  const info={stubBytes:fs.statSync(stubPath).size,extractorBytes:fs.statSync(extractorPath).size,archiveBytes:fs.statSync(archivePath).size,
    extractorSha256:await hashFile(extractorPath),archiveSha256:await hashFile(archivePath)};
  const footer=footerFor(info);
  async function* chunks(){for(const file of [stubPath,extractorPath,archivePath])yield* fs.createReadStream(file);yield footer;}
  let created=false;const output=fs.createWriteStream(outputPath,{flags:'wx'});output.once('open',()=>{created=true;});
  try {await pipeline(Readable.from(chunks()),output);}
  catch(error){if(created)await fs.promises.rm(outputPath,{force:true});throw error;}
  return readBundle(outputPath);
}
async function extractTransport(file,{extractorPath,archivePath}) {
  const info=await readBundle(file);
  for(const [output,start,size,expected] of [[extractorPath,info.stubBytes,info.extractorBytes,info.extractorSha256],[archivePath,info.stubBytes+info.extractorBytes,info.archiveBytes,info.archiveSha256]]) {
    await pipeline(fs.createReadStream(file,{start,end:start+size-1}),fs.createWriteStream(output,{flags:'wx'}));
    if((await hashFile(output)).toString('hex')!==expected)throw new Error('Transporte Windows corrompido.');
  }
  return info;
}
module.exports={MAGIC,FOOTER_BYTES,ENGINE_MANIFEST,writeEngineManifest,footerFor,parseFooter,readBundle,packBundle,extractTransport};
