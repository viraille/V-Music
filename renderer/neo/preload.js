const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neo', {
  home: () => ipcRenderer.invoke('neo:home'),
  search: (q, params) => ipcRenderer.invoke('neo:search', q, params),
  browse: (id) => ipcRenderer.invoke('neo:browse', id),
  more: (token, kind) => ipcRenderer.invoke('neo:more', token, kind),
  service: (spec) => ipcRenderer.invoke('neo:service', spec),
  playlistsFor: (videoId) => ipcRenderer.invoke('neo:playlistsFor', videoId),
  addToPlaylist: (playlistId, videoId) => ipcRenderer.invoke('neo:addToPlaylist', playlistId, videoId),
  library: (kind) => ipcRenderer.invoke('neo:library', kind),
  play: (target) => ipcRenderer.send('neo:play', target),
  cmd: (name, arg) => ipcRenderer.send('neo:cmd', name, arg),
  login: () => ipcRenderer.send('neo:login'),
  openSettings: () => ipcRenderer.send('open-settings'),
  getState: () => ipcRenderer.invoke('neo:getState'),
  onLogin: (cb) => ipcRenderer.on('neo:login-done', () => cb()),
  onState: (cb) => ipcRenderer.on('neo:state', (_e, s) => cb(s)),
});
