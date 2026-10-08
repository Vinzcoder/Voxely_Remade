const { contextBridge, ipcRenderer } = require('electron');
const call = (name, ...a) => ipcRenderer.invoke(name, ...a);
contextBridge.exposeInMainWorld('voxely', {
  info: () => call('v:info'), session: () => call('v:session'), guest: () => call('v:guest'), logout: () => call('v:logout'),
  store: () => call('v:store'), studio: () => call('v:studio'), install: () => call('v:install'), open: u => call('v:open', u),
  updateState: () => call('v:update-state'), onUpdate: cb => ipcRenderer.on('v:update', (_e, s) => cb(s))
});
