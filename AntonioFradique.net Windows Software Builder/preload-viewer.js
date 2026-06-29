const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload isolado para o Viewer (modo SFX).
 * Sem APIs de gravação. Sem fluxo de "carregar projeto" — o projeto está
 * sempre stamped-in dentro do .exe SFX que o aluno abriu.
 */
contextBridge.exposeInMainWorld('viewer', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  resolveAssetPath: (relativePath) => ipcRenderer.invoke('asset:resolve', relativePath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  launchFile: (relativePath) => ipcRenderer.invoke('shell:launchFile', relativePath),
  saveFileAs: (payload) => ipcRenderer.invoke('dialog:saveFileAs', payload),
  loadLocale: (lang) => ipcRenderer.invoke('i18n:loadLocale', lang)
});
