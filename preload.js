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
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, pct) => cb(pct)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (e, msg) => cb(msg)),
  onUpdateRestarting: (cb) => ipcRenderer.on('update-restarting', () => cb()),
  getVersion: () => ipcRenderer.invoke('get-version'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.send('install-update')
});
