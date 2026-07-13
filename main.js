const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const fs = require('fs');
const path = require('path');

let win;

// ---- Auto update (from GitHub Releases) ----
// Checks quietly on launch; if a newer version is published, downloads it in
// the background and installs on next quit. Only runs in the packaged app.
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    if (win) win.webContents.send('update-ready', info && info.version);
  });
  autoUpdater.on('error', () => { /* offline or no release: ignore silently */ });
  autoUpdater.checkForUpdates().catch(() => {});
  // check again every 3 hours for long sessions
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 3 * 3600 * 1000);
}

ipcMain.on('install-update', () => {
  try { require('electron-updater').autoUpdater.quitAndInstall(); } catch (e) {}
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    title: 'fabu',
    backgroundColor: '#15130f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');

  // ask the renderer before really closing (unsaved changes dialog)
  win.on('close', (e) => {
    if (quitOk) return;
    e.preventDefault();
    win.webContents.send('confirm-close');
  });
}

let quitOk = false;
ipcMain.on('close-confirmed', () => {
  quitOk = true;
  app.quit();
});

app.whenReady().then(() => {
  // Allow microphone access for voice recording
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media');
  });
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- File dialogs ----

ipcMain.handle('save-file', async (e, { defaultName, filters, data, encoding }) => {
  let defaultPath = defaultName;
  try {
    const dir = path.join(app.getPath('documents'), 'fabu projects');
    fs.mkdirSync(dir, { recursive: true });
    defaultPath = path.join(dir, defaultName);
  } catch (err) { /* fall back to bare filename */ }
  const res = await dialog.showSaveDialog(win, {
    defaultPath,
    filters
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    if (encoding === 'base64') {
      fs.writeFileSync(res.filePath, Buffer.from(data, 'base64'));
    } else {
      fs.writeFileSync(res.filePath, data, 'utf8');
    }
    return { ok: true, path: res.filePath, name: path.basename(res.filePath) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('open-file', async (e, { filters }) => {
  let defaultPath;
  try {
    const dir = path.join(app.getPath('documents'), 'fabu projects');
    fs.mkdirSync(dir, { recursive: true });
    defaultPath = dir;
  } catch (err) { /* ignore */ }
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    defaultPath,
    filters
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try {
    const p = res.filePaths[0];
    const buf = fs.readFileSync(p);
    return { ok: true, name: path.basename(p), path: p, data: buf.toString('base64') };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Open a known file by path (used by the homescreen recents list)
ipcMain.handle('open-path', async (e, { filePath }) => {
  try {
    const buf = fs.readFileSync(filePath);
    return { ok: true, name: path.basename(filePath), path: filePath, data: buf.toString('base64') };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// The persistent instrument library lives in userData too
function libraryPath() { return path.join(app.getPath('userData'), 'instruments.json'); }

ipcMain.handle('library-write', async (e, { data }) => {
  try {
    fs.writeFileSync(libraryPath(), data, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('library-read', async () => {
  try {
    const p = libraryPath();
    if (!fs.existsSync(p)) return { ok: false };
    return { ok: true, data: fs.readFileSync(p, 'utf8') };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Autosave lives in the app's userData folder so big projects are fine
function autosavePath() { return path.join(app.getPath('userData'), 'autosave.fab'); }

ipcMain.handle('autosave-write', async (e, { data }) => {
  try {
    fs.writeFileSync(autosavePath(), data, 'utf8');
    return { ok: true, at: Date.now() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('autosave-read', async () => {
  try {
    const p = autosavePath();
    if (!fs.existsSync(p)) return { ok: false };
    const stat = fs.statSync(p);
    return { ok: true, data: fs.readFileSync(p, 'utf8'), at: stat.mtimeMs };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Read every .json in the languages folder. A language exists only if its
// file exists. The editable copy (Resources/languages) wins over the bundled one.
ipcMain.handle('get-languages', async () => {
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'languages'));
  dirs.push(path.join(__dirname, 'languages'));
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of files.sort()) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      if (f === 'index.json') continue; // the web manifest, not a language
      if (seen.has(f)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        out.push({ file: f, data });
        seen.add(f);
      } catch (e) { /* skip broken files */ }
    }
  }
  return out;
});
