const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload isolado para o Viewer.
 * Expõe APENAS leitura de configuração, abertura de URLs/ficheiros
 * permitidos, e o fluxo de carregar/extrair um ficheiro .lbpro.
 * Não tem acesso aos handlers de gravação do Construtor.
 */
contextBridge.exposeInMainWorld('viewer', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  resolveAssetPath: (relativePath) => ipcRenderer.invoke('asset:resolve', relativePath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  launchFile: (relativePath) => ipcRenderer.invoke('shell:launchFile', relativePath),

  // .lbpro flow
  hasProject: () => ipcRenderer.invoke('viewer:hasProject'),
  loadProject: () => ipcRenderer.invoke('viewer:loadProject'),

  // i18n
  detectLocale: () => ipcRenderer.invoke('viewer:locale'),
  loadLocale: (lang) => ipcRenderer.invoke('i18n:loadLocale', lang)
});
