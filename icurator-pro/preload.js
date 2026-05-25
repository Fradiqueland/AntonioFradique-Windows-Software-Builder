const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('icurator', {
  version: '0.1.0',
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveBrandConfig: (data) => ipcRenderer.invoke('brand:save', data),
  resolveAssetPath: (relativePath) => ipcRenderer.invoke('asset:resolve', relativePath)
});
