const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  openFile: (opts) => ipcRenderer.invoke('open-file', opts),
  openPath: (opts) => ipcRenderer.invoke('open-path', opts),
  getLanguages: () => ipcRenderer.invoke('get-languages'),
  autosaveWrite: (opts) => ipcRenderer.invoke('autosave-write', opts),
  autosaveRead: () => ipcRenderer.invoke('autosave-read'),
  libraryWrite: (opts) => ipcRenderer.invoke('library-write', opts),
  libraryRead: () => ipcRenderer.invoke('library-read'),
  onConfirmClose: (cb) => ipcRenderer.on('confirm-close', cb),
  confirmClose: () => ipcRenderer.send('close-confirmed'),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (e, version) => cb(version)),
  installUpdate: () => ipcRenderer.send('install-update')
});
