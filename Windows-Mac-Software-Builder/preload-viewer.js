const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload isolado para o Viewer (modo SFX).
 * Sem APIs de gravação do projeto. Sem fluxo de "carregar projeto" — o projeto
 * está sempre stamped-in dentro do .exe SFX que o aluno abriu.
 *
 * Única exceção de escrita: os favoritos IPTV do aluno (favs:*), guardados
 * pelo processo principal FORA da pasta temporária do SFX, para sobreviverem
 * ao fecho do curso.
 */
contextBridge.exposeInMainWorld('viewer', {
  platform: process.platform,
  launchPortable: (moduleId) => ipcRenderer.invoke('portable:launch', moduleId),
  configurePortableWine: () => ipcRenderer.invoke('portable:configureWine'),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  getAndroidRuntimeStatus: (locale) => ipcRenderer.invoke('android:status', { locale }),
  openWebModule: (moduleId) => ipcRenderer.invoke('web:open', moduleId),
  closeWebModule: (token) => ipcRenderer.invoke('web:close', token),
  resolveAssetPath: (relativePath) => ipcRenderer.invoke('asset:resolve', relativePath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  launchFile: (relativePath) => ipcRenderer.invoke('shell:launchFile', relativePath),
  saveFileAs: (payload) => ipcRenderer.invoke('dialog:saveFileAs', payload),
  loadLocale: (lang) => ipcRenderer.invoke('i18n:loadLocale', lang),
  youtubeHostUrl: (id) => ipcRenderer.invoke('youtube:hostUrl', id),
  iptvHosts: (hosts) => ipcRenderer.invoke('iptv:hosts', hosts),
  iptvHasFfmpeg: () => ipcRenderer.invoke('iptv:hasFfmpeg'),
  iptvProxyUrl: (url) => ipcRenderer.invoke('iptv:proxyUrl', url),
  iptvProxyStatus: (token) => ipcRenderer.invoke('iptv:proxyStatus', token),
  iptvProxyStop: (token) => ipcRenderer.invoke('iptv:proxyStop', token),
  loadFavs: (key) => ipcRenderer.invoke('favs:load', key),
  saveFavs: (key, data) => ipcRenderer.invoke('favs:save', { key, data }),
  loadState: (key) => ipcRenderer.invoke('state:load', key),
  saveState: (key, data) => ipcRenderer.invoke('state:save', { key, data })
});
