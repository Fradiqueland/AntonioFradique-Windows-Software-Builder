const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload isolado para o Viewer.
 * Expõe APENAS leitura de configuração e funções de "abrir/lançar".
 * Não tem acesso aos handlers de gravação do Construtor.
 */
contextBridge.exposeInMainWorld('viewer', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  resolveAssetPath: (relativePath) => ipcRenderer.invoke('asset:resolve', relativePath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  launchFile: (relativePath) => ipcRenderer.invoke('shell:launchFile', relativePath)
});
