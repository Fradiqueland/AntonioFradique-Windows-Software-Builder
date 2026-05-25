const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('icurator', {
  version: '0.1.0',
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveBrandConfig: (data) => ipcRenderer.invoke('brand:save', data),
  saveLeadsConfig: (data) => ipcRenderer.invoke('marketing:saveLeads', data),
  saveBannerConfig: (data) => ipcRenderer.invoke('marketing:saveBanners', data),
  saveContent: (data) => ipcRenderer.invoke('content:save', data),
  resolveAssetPath: (relativePath) => ipcRenderer.invoke('asset:resolve', relativePath)
});
