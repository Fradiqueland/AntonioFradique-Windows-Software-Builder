'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Read the icon as project data, never as an arbitrary absolute config path.
function projectIcon(config, assetsDir) {
  const relative = config && config.export && config.export.iconPath;
  if (!relative) return null;
  if (typeof relative !== 'string' || !/^data\/icon(?:-source(?:-[A-Za-z0-9-]+)?)?\.(?:png|jpe?g|ico)$/i.test(relative)) throw new Error('Caminho do ícone do projeto inválido.');
  const root = fs.realpathSync.native(path.join(assetsDir, '..', 'data'));
  const absolute = path.join(root, path.posix.basename(relative));
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 ** 2) throw new Error('Ficheiro de ícone inválido.');
  return { relative, absolute, root, stat };
}
function imageToIco(image) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = sizes.map(size => image.resize({ width:size, height:size, quality:'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((bytes, index) => {
    const entry = 6 + index * 16, size = sizes[index];
    header[entry] = size === 256 ? 0 : size; header[entry+1] = header[entry];
    header.writeUInt16LE(1, entry+4); header.writeUInt16LE(32, entry+6);
    header.writeUInt32LE(bytes.length, entry+8); header.writeUInt32LE(offset, entry+12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...frames]);
}
function applyWindowIcon({ window, app, nativeImage, config, assetsDir, platform, standalone }) {
  const icon = projectIcon(config, assetsDir);
  if (!icon) return false;
  const image = nativeImage.createFromPath(icon.absolute);
  if (image.isEmpty()) throw new Error('Não foi possível ler o ícone escolhido. Use PNG, JPG ou ICO.');
  if (platform === 'darwin') {
    if (standalone && app.dock) app.dock.setIcon(image);
  } else {
    window.setIcon(image);
    if (platform === 'win32') {
      // Separate projects must not be grouped under the generic Electron icon.
      const identity = crypto.createHash('sha256').update(JSON.stringify([config.brand?.title || '', fs.readFileSync(icon.absolute).toString('base64')])).digest('hex').slice(0, 32);
      const directory = path.join(app.getPath('appData'), 'LaunchBox Viewer', 'window-icons');
      fs.mkdirSync(directory, {recursive:true});
      const iconPath = path.join(directory, identity + '.ico');
      // Retain a real ICO outside the disposable SFX directory for the taskbar.
      if (!fs.existsSync(iconPath)) fs.writeFileSync(iconPath, imageToIco(image));
      window.setAppDetails({ appId: 'net.antoniofradique.wsmb.' + identity, appIconPath: iconPath });
    }
  }
  return true;
}
module.exports = { projectIcon, applyWindowIcon, imageToIco };
