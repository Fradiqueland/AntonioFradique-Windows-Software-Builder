const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('icurator', {
  version: '0.1.0'
});
