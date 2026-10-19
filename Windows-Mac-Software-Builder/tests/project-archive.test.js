'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const { exportArchive, importArchive } = require('../src/shared/project-archive');
const portable = require('../src/shared/portable-app');
const readConfig = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmb-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'original'), data = path.join(projectRoot, 'data'), assets = path.join(projectRoot, 'dist-assets');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(assets);
  const config = { brand: { title: 'Árvore & música', logo: 'dist-assets/logo.png' }, marketing: { banners: { top: { enabled: true, image: 'dist-assets/logo.png', url: 'https://example.org' } } }, export: { iconPath: 'data/icon-source.png' },
    content: [{ id: 'video', type: 'local-video', data: { file: 'dist-assets/movie.bin', fileName: 'Movie' } }] };
  fs.writeFileSync(path.join(assets, 'logo.png'), crypto.randomBytes(128));
  fs.writeFileSync(path.join(assets, 'movie.bin'), crypto.randomBytes(1024 * 1024));
  fs.writeFileSync(path.join(data, 'icon-source.png'), crypto.randomBytes(256));
  const save = () => fs.writeFileSync(path.join(data, 'project-config.json'), JSON.stringify(config)); save();
  const archivePath = path.join(root, 'backup.wsmb'), destination = path.join(root, 'imported');
  const exportIt = () => exportArchive({ projectRoot, outputPath: archivePath, name: 'My editable project', appVersion: '2.6.0', readConfig });
  const importIt = (more = {}) => importArchive({ archivePath, destination, readConfig, ...more });
  return { root, projectRoot, data, assets, config, save, archivePath, destination, exportIt, importIt };
}

test('editable archive round trip preserves settings, icons, binary bytes and HTML resources', async t => {
  const f = fixture(t);
  const webRoot = 'web-' + crypto.randomUUID(); fs.mkdirSync(path.join(f.assets, webRoot));
  fs.writeFileSync(path.join(f.assets, webRoot, 'index.html'), '<h1>Olá</h1>');
  fs.mkdirSync(path.join(f.assets, webRoot, 'css')); fs.writeFileSync(path.join(f.assets, webRoot, 'css/style.css'), 'h1{color:red}');
  f.config.content.push({ id: 'web', type: 'local-web', data: { root: 'dist-assets/' + webRoot, entry: 'index.html' } }); f.save();
  await f.exportIt();
  const restored = await f.importIt();
  assert.equal(restored.name, 'My editable project');
  assert.deepEqual(restored.config, f.config);
  for (const rel of ['dist-assets/logo.png', 'dist-assets/movie.bin', 'data/icon-source.png', 'dist-assets/' + webRoot + '/css/style.css']) {
    assert.deepEqual(fs.readFileSync(path.join(f.destination, rel)), fs.readFileSync(path.join(f.projectRoot, rel)));
  }
  assert.deepEqual(readConfig(path.join(f.data, 'project-config.json')), f.config);
});

test('archive failure preserves an existing backup and does not create a partial file', async t => {
  const f = fixture(t); fs.writeFileSync(f.archivePath, 'PREVIOUS BACKUP');
  fs.unlinkSync(path.join(f.assets, 'movie.bin'));
  await assert.rejects(f.exportIt(), /falta/);
  assert.equal(fs.readFileSync(f.archivePath, 'utf8'), 'PREVIOUS BACKUP');
  assert.ok(!fs.readdirSync(f.root).some(name => name.endsWith('.tmp')));
});

test('imports never replace an existing destination and clean up rejected configurations', async t => {
  const f = fixture(t); await f.exportIt();
  fs.mkdirSync(f.destination); fs.writeFileSync(path.join(f.destination, 'keep'), 'KEEP');
  await assert.rejects(f.importIt(), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'keep'), 'utf8'), 'KEEP');
  fs.rmSync(f.destination, { recursive: true });
  await assert.rejects(f.importIt({ readConfig() { throw new Error('Invalid settings'); } }), /Invalid settings/);
  assert.equal(fs.existsSync(f.destination), false);
});

async function synthetic(filename, items, mutateManifest = () => {}) {
  const zip = new yazl.ZipFile(); const done = pipeline(zip.outputStream, fs.createWriteStream(filename));
  const manifest = { format: 'windows-mac-software-builder-project', version: 1, name: 'Fixture', files: [] };
  for (const item of items) {
    const data = Buffer.from(item.data || ''); const kind = item.kind || 'file'; const mode = kind === 'symlink' ? 0o120777 : kind === 'directory' ? 0o40755 : 0o100644;
    manifest.files.push({ path: item.name.replace(/\/$/, ''), kind, mode: mode & 0o777, size: data.length, ...(kind === 'directory' ? {} : { sha256: crypto.createHash('sha256').update(data).digest('hex') }) });
    if (kind === 'directory') zip.addEmptyDirectory(item.name, { mode }); else zip.addBuffer(data, item.name, { mode, compress: false });
  }
  mutateManifest(manifest);
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'project.wsmb.json', { mode: 0o100644 });zip.end();await done;
}

test('imports reject corrupt checksums, undeclared files and newer format versions before committing', async t => {
  const f = fixture(t);
  for (const mutate of [m => m.files[0].sha256 = '0'.repeat(64), m => m.files = [], m => m.version = 999]) {
    await synthetic(f.archivePath, [{ name: 'data/project-config.json', data: JSON.stringify({ content: [] }) }], mutate);
    await assert.rejects(f.importIt()); assert.equal(fs.existsSync(f.destination), false);
  }
});

test('imports reject ZIP path traversal, case collisions and unsafe configuration references', async t => {
  const f = fixture(t);
  // yazl rejects traversal itself, so patch same-length raw entry names in a valid archive.
  await synthetic(f.archivePath, [{ name: 'data/project-config.json', data: '{"content":[]}' }, { name: 'dist-assets/x.txt', data: 'x' }]);
  let archive = fs.readFileSync(f.archivePath); archive = Buffer.from(archive.toString('latin1').replaceAll('dist-assets/x.txt', '../outside/xx.txt'), 'latin1'); fs.writeFileSync(f.archivePath, archive);
  await assert.rejects(f.importIt()); assert.equal(fs.existsSync(f.destination), false);
  await synthetic(f.archivePath, [{ name: 'data/project-config.json', data: '{"content":[]}' }, { name: 'dist-assets/a.txt', data: 'a' }, { name: 'dist-assets/A.txt', data: 'a' }]);
  await assert.rejects(f.importIt(), /duplicados/);
  await synthetic(f.archivePath, [{ name: 'data/project-config.json', data: '{"brand":{"logo":"../../private.png"},"content":[]}' }]);
  await assert.rejects(f.importIt(), /Referência/);
});

test('CRC corruption is rejected and a staged import is removed', async t => {
  const f = fixture(t);
  await synthetic(f.archivePath, [{ name: 'data/project-config.json', data: '{"content":[]}' }, { name: 'dist-assets/marker.txt', data: 'UNIQUE-MARKER' }]);
  const bytes = fs.readFileSync(f.archivePath); const index = bytes.indexOf(Buffer.from('UNIQUE-MARKER'));assert.ok(index > 0);bytes[index] ^= 1;fs.writeFileSync(f.archivePath, bytes);
  await assert.rejects(f.importIt(), /CRC|corrompido/);assert.equal(fs.existsSync(f.destination), false);
});

test('archive round trip preserves portable bytes, executable permission and independent runtime revision', async t => {
  const f = fixture(t);const source=path.join(f.root,'app');fs.mkdirSync(source);
  const pe=Buffer.alloc(512);pe.write('MZ');pe.writeUInt32LE(128,60);pe.write('PE\0\0',128);pe.writeUInt16LE(0x8664,132);pe.writeUInt16LE(0xf0,148);pe.writeUInt16LE(2,150);pe.writeUInt16LE(0x20b,152);fs.writeFileSync(path.join(source,'run.exe'),pe,{mode:0o755});
  const data=portable.importPortableProject({sourcePath:source,assetsDir:f.assets,entries:{windows:'run.exe',mac:null}});
  f.config.content.push({id:'portable',type:'portable',data});f.save();
  await f.exportIt();const result=await f.importIt();const imported=result.config.content.at(-1).data;
  assert.notEqual(imported.revision,data.revision);assert.equal(imported.root,data.root);
  assert.deepEqual(fs.readFileSync(path.join(f.destination,imported.root,'run.exe')),pe);
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(f.destination,imported.root,'run.exe')).mode&0o777,0o755);
});

test('unmanaged symlinks cannot leave the project archive', async t => {
  if(process.platform==='win32')return t.skip('Creating symlinks requires Windows privileges');
  const f=fixture(t);fs.symlinkSync(f.archivePath,path.join(f.assets,'escape'));
  await assert.rejects(f.exportIt(),/não permitido/);assert.equal(fs.existsSync(f.archivePath),false);
});

for (const platform of ['win32', ...(process.platform === 'win32' ? [] : ['darwin'])]) {
  test('portable archive links remain inside the module and restore on ' + platform, async t => {
    const f = fixture(t), root = 'dist-assets/portable-' + crypto.randomUUID();
    const pe = Buffer.alloc(512);pe.write('MZ');pe.writeUInt32LE(128,60);pe.write('PE\0\0',128);
    pe.writeUInt16LE(0x8664,132);pe.writeUInt16LE(0xf0,148);pe.writeUInt16LE(2,150);pe.writeUInt16LE(0x20b,152);
    const config = {content:[{id:'portable',type:'portable',data:{root,revision:crypto.randomUUID(),entries:{windows:'run.exe',mac:null}}}]};
    await synthetic(f.archivePath, [
      {name:'data/project-config.json',data:JSON.stringify(config)},
      {name:root,kind:'directory'}, {name:root+'/run.exe',data:pe},
      {name:root+'/lib',kind:'directory'}, {name:root+'/lib/data.txt',data:'PRESERVED'},
      {name:root+'/alias',kind:'symlink',data:'lib'},
      {name:root+'/lib/link.txt',kind:'symlink',data:'data.txt'}
    ]);
    await f.importIt({platform});
    const alias=path.join(f.destination,root,'alias');
    assert.equal(fs.lstatSync(alias).isSymbolicLink(),platform!=='win32');
    assert.equal(fs.readFileSync(path.join(alias,'link.txt'),'utf8'),'PRESERVED');
  });
}

test('escaping, dangling and cyclic portable links are rejected before extraction', async t => {
  const f=fixture(t),root='dist-assets/portable-'+crypto.randomUUID();
  const config={content:[{id:'portable',type:'portable',data:{root}}]};
  for(const target of ['../../outside','missing','cycle','.']) {
    await synthetic(f.archivePath,[{name:'data/project-config.json',data:JSON.stringify(config)},
      {name:root,kind:'directory'},{name:root+'/cycle',kind:'symlink',data:target}]);
    await assert.rejects(f.importIt(),/Ligação|Ciclo/);
    assert.equal(fs.existsSync(f.destination),false);
  }
});
