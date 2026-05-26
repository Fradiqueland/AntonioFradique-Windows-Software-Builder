const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('icurator', {
  version: '0.1.0',
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveBrandConfig: (data) => ipcRenderer.invoke('brand:save', data),
  saveLeadsConfig: (data) => ipcRenderer.invoke('marketing:saveLeads', data),
  saveBannerConfig: (data) => ipcRenderer.invoke('marketing:saveBanners', data),
  saveContent: (data) => ipcRenderer.invoke('content:save', data),
  resolveAssetPath: (relativePath) => ipcRenderer.invoke('asset:resolve', relativePath),
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
