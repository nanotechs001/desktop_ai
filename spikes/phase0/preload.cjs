const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, cb) => ipcRenderer.on(channel, (_e, arg) => cb(arg)),
});
