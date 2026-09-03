const { contextBridge, ipcRenderer } = require('electron');

// Versão lida do package.json (fonte única) — deixa de haver 3 sítios para
// actualizar (package.json, preload.js, index.html) que ficavam dessincronizados.
const APP_VERSION = (() => { try { return require('./package.json').version; } catch (_) { return ''; } })();

contextBridge.exposeInMainWorld('icurator', {
  version: APP_VERSION,
  loadConfig: () => ipcRenderer.invoke('config:load'),
  projectsList: () => ipcRenderer.invoke('projects:list'),
  projectsCreate: (name) => ipcRenderer.invoke('projects:create', { name }),
  projectsOpen: (id) => ipcRenderer.invoke('projects:open', { id }),
  projectsRename: (id, name) => ipcRenderer.invoke('projects:rename', { id, name }),
  projectsDelete: (id) => ipcRenderer.invoke('projects:delete', { id }),
  projectsDuplicate: (id) => ipcRenderer.invoke('projects:duplicate', { id }),
  saveBrandConfig: (data) => ipcRenderer.invoke('brand:save', data),
  saveLeadsConfig: (data) => ipcRenderer.invoke('marketing:saveLeads', data),
  saveBannerConfig: (data) => ipcRenderer.invoke('marketing:saveBanners', data),
  saveSocialConfig: (data) => ipcRenderer.invoke('marketing:saveSocial', data),
  saveContent: (data) => ipcRenderer.invoke('content:save', data),
  resolveAssetPath: (relativePath) => ipcRenderer.invoke('asset:resolve', relativePath),
  pickFile: (category) => ipcRenderer.invoke('dialog:pickFile', category),
  pickFiles: (category) => ipcRenderer.invoke('dialog:pickFiles', category),
  iptvLoad: (payload) => ipcRenderer.invoke('iptv:load', payload),
  openViewer: () => ipcRenderer.invoke('viewer:open'),
  saveIcon: (data) => ipcRenderer.invoke('export:saveIcon', data),
  buildExe: (data) => ipcRenderer.invoke('export:buildExe', data),
  revealInFolder: (filePath) => ipcRenderer.invoke('export:revealInFolder', filePath),
  onExportLog: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('export:log', listener);
    return () => ipcRenderer.removeListener('export:log', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  loadLocale: (lang) => ipcRenderer.invoke('i18n:loadLocale', lang),
  saveLanguage: (lang) => ipcRenderer.invoke('language:save', lang)
});
