const { app, BrowserWindow, ipcMain, dialog, session, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

let win;

// ---- updates ----
let updateInfo = null;
let updater = null;
let pendingRestart = null; // set once an update is downloaded/ready; run on 'restart-now'

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { return; }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  updater.on('update-available', (info) => {
    updateInfo = info;
    if (win) win.webContents.send('update-ready', info && info.version);
  });
  updater.on('download-progress', (p) => {
    if (win) win.webContents.send('update-progress', Math.floor(p.percent || 0));
  });
  updater.on('update-downloaded', () => {
    pendingRestart = () => {
      quitOk = true;
      try { updater.quitAndInstall(false, true); }
      catch (e) { if (win) win.webContents.send('update-error', String(e && e.message)); }
    };
    if (win) win.webContents.send('update-downloaded');
  });
  updater.on('error', () => {
    if (win) win.webContents.send('update-error', 'err');
    shell.openExternal('https://rquw.github.io/fabu/').catch(() => {});
  });
  updater.checkForUpdates().catch(() => {});
  setInterval(() => updater.checkForUpdates().catch(() => {}), 15 * 60 * 1000);
}

function versionNewer(a, b) { // a > b, "1.0.10" style
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
  return false;
}

ipcMain.handle('check-updates', async () => {
  if (!app.isPackaged || !updater) return { status: 'dev', version: app.getVersion() };
  try {
    const res = await updater.checkForUpdates();
    const info = res && res.updateInfo;
    if (info && versionNewer(info.version, app.getVersion())) {
      updateInfo = info;
      return { status: 'update', version: info.version };
    }
    return { status: 'latest', version: app.getVersion() };
  } catch (e) {
    return { status: 'error', version: app.getVersion() };
  }
});

function downloadAsset(meta, destPath) {
  return new Promise((resolve, reject) => {
    const { net } = require('electron');
    const crypto = require('crypto');
    const url = 'https://github.com/rquw/fabu/releases/download/v' + updateInfo.version + '/' + meta.url;
    const req = net.request(url);
    req.on('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error('http ' + res.statusCode)); return; }
      const cl = res.headers['content-length'];
      const total = parseInt(Array.isArray(cl) ? cl[0] : cl) || meta.size || 0;
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(destPath);
      let got = 0, lastPct = -1;
      res.on('data', (chunk) => {
        hash.update(chunk);
        out.write(chunk);
        got += chunk.length;
        if (total && win) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct) { lastPct = pct; win.webContents.send('update-progress', pct); }
        }
      });
      res.on('end', () => {
        out.end(() => {
          const sum = hash.digest('base64');
          if (meta.sha512 && sum !== meta.sha512) reject(new Error('checksum mismatch'));
          else resolve();
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function cleanUpdateLeftovers() {
  try {
    const tmp = app.getPath('temp');
    for (const f of fs.readdirSync(tmp)) {
      if (f.startsWith('fabu-update-') || f.startsWith('fabu-old-')) {
        fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
      }
    }
  } catch (e) { /* ignore */ }
}

async function applyUpdateMac() {
  const files = (updateInfo && updateInfo.files) || [];
  const meta = files.find((f) => f.url && f.url.endsWith('.zip'));
  if (!meta) throw new Error('no installer in this release');
  const tmp = app.getPath('temp');
  const dest = path.join(tmp, 'fabu-update-' + updateInfo.version + '.zip');
  try {
    await downloadAsset(meta, dest);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1500));
    if (win) win.webContents.send('update-progress', 0);
    await downloadAsset(meta, dest);
  }

  const { execFile } = require('child_process');
  const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, (e) => (e ? rej(e) : res())));
  const dir = path.join(tmp, 'fabu-update-' + updateInfo.version);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await run('/usr/bin/ditto', ['-x', '-k', dest, dir]);
  const newApp = path.join(dir, 'fabu.app');
  if (!fs.existsSync(newApp)) throw new Error('no app in the update');
  const curApp = path.resolve(process.execPath, '..', '..', '..');
  if (!curApp.endsWith('.app')) throw new Error('not running from an .app');
  try { await run('/usr/bin/xattr', ['-cr', newApp]); } catch (e) { /* none set */ }
  try { await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', newApp]); } catch (e) { /* best effort */ }
  const oldApp = path.join(tmp, 'fabu-old-' + Date.now() + '.app');
  await run('/bin/mv', [curApp, oldApp]);
  try {
    await run('/bin/mv', [newApp, curApp]);
  } catch (e) {
    await run('/bin/mv', [oldApp, curApp]); // put the old one back
    throw e;
  }
  pendingRestart = () => { quitOk = true; app.relaunch(); app.quit(); };
  if (win) win.webContents.send('update-downloaded');
}

async function applyUpdateWin() {
  const files = (updateInfo && updateInfo.files) || [];
  const meta = files.find((f) => f.url && /\.exe$/i.test(f.url));
  if (!meta) throw new Error('no installer in this release');
  const tmp = app.getPath('temp');
  const dest = path.join(tmp, 'fabu-update-' + updateInfo.version + '.exe');
  try {
    await downloadAsset(meta, dest);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1500));   // one quiet retry
    if (win) win.webContents.send('update-progress', 0);
    await downloadAsset(meta, dest);
  }

  let backup = null;
  try {
    backup = path.join(app.getPath('downloads'), 'fabu-' + updateInfo.version + '-installer.exe');
    fs.copyFileSync(dest, backup);
  } catch (e) { backup = null; }

  pendingRestart = () => {
    quitOk = true;
    const { spawn } = require('child_process');
    try {
      spawn('cmd.exe', ['/c', 'timeout /t 4 /nobreak >nul & start "" "' + dest + '" --force-run'], {
        detached: true, stdio: 'ignore', windowsHide: true
      }).unref();
    } catch (e) { /* fall through to quitting; the backup copy is the way out */ }
    setTimeout(() => app.quit(), 300);
  };
  if (win) win.webContents.send('update-downloaded', backup);
}

ipcMain.on('restart-now', () => {
  if (!pendingRestart) return;
  const fn = pendingRestart; pendingRestart = null;
  if (win) win.webContents.send('update-restarting'); // triggers a final autosave
  setTimeout(fn, 500);
});

ipcMain.on('install-update', () => {
  if (!updateInfo) { shell.openExternal('https://rquw.github.io/fabu/').catch(() => {}); return; }
  const fail = (e) => {
    if (win) win.webContents.send('update-error', String((e && e.message) || e));
    shell.openExternal('https://rquw.github.io/fabu/').catch(() => {}); // the site always works
  };
  if (process.platform === 'darwin') {
    applyUpdateMac().catch(fail);
  } else if (process.platform === 'win32') {
    if (updater) {
      updater.downloadUpdate().catch((e) => {
        applyUpdateWin().catch(fail);
      });
    } else {
      applyUpdateWin().catch(fail);
    }
  } else {
    if (!updater) { fail(new Error('no updater')); return; }
    updater.downloadUpdate().catch(fail);
  }
});

// ---- main window size and position ----
const WIN_STATE = () => path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  const def = { width: 1440, height: 900, firstRun: true };
  let s;
  try { s = JSON.parse(fs.readFileSync(WIN_STATE(), 'utf8')); } catch (e) { return def; }
  if (!s || !s.width || !s.height) return def;
  try {
    const { screen } = require('electron');
    const onScreen = s.x != null && s.y != null && screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x < b.x + b.width && s.x + s.width > b.x && s.y < b.y + b.height && s.y + s.height > b.y;
    });
    if (!onScreen) { delete s.x; delete s.y; }
  } catch (e) { delete s.x; delete s.y; }
  return s;
}

function trackWindowState(w) {
  let t = null;
  const writeNow = () => {
    if (!w || w.isDestroyed()) return;
    try {
      const b = w.isMaximized() || w.isFullScreen() ? w.getNormalBounds() : w.getBounds();
      fs.writeFileSync(WIN_STATE(), JSON.stringify({
        x: b.x, y: b.y, width: b.width, height: b.height,
        maximized: w.isMaximized(), fullscreen: w.isFullScreen()
      }));
    } catch (e) { /* disk full or read-only profile: not worth a crash */ }
  };
  const save = () => { clearTimeout(t); t = setTimeout(writeNow, 400); };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) w.on(ev, save);
  w.on('close', () => { clearTimeout(t); writeNow(); });
}

function createWindow() {
  const st = readWindowState();
  win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 980,
    minHeight: 620,
    title: 'fabu',
    backgroundColor: '#15130f',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (st.maximized) win.maximize();
  else if (st.firstRun) {
    try {
      const { screen } = require('electron');
      const a = screen.getPrimaryDisplay().workArea;
      win.setBounds({ x: a.x + 12, y: a.y + 12, width: a.width - 24, height: a.height - 24 });
    } catch (e) { win.maximize(); }
  }
  if (st.fullscreen) win.setFullScreen(true);
  trackWindowState(win);

  win.loadFile('index.html');

  const sendFS = () => { if (win && !win.isDestroyed()) win.webContents.send('fullscreen-changed', win.isFullScreen()); };
  win.on('enter-full-screen', sendFS);
  win.on('leave-full-screen', sendFS);
  win.webContents.on('did-finish-load', sendFS);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (quitOk) return;
    e.preventDefault();
    if (!rendererDirty) { beginQuit(); return; }
    win.webContents.send('confirm-close');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!quitOk) beginQuit(); }, 3000);
  });
}

let quitOk = false;
let rendererDirty = false;
let closeTimer = null;

function beginQuit() {
  if (quitOk) return;
  quitOk = true;
  clearTimeout(closeTimer);
  try { if (win && !win.isDestroyed()) win.hide(); } catch (e) {}
  app.quit();
}

ipcMain.on('close-confirmed', () => beginQuit());
ipcMain.on('close-cancelled', () => { clearTimeout(closeTimer); });
ipcMain.on('set-dirty', (e, dirty) => { rendererDirty = !!dirty; });

ipcMain.handle('get-version', () => app.getVersion());

function setupMenu() {
  if (process.platform === 'darwin') return;
  Menu.setApplicationMenu(null);
}

app.whenReady().then(() => {
  setupMenu();
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media');
  });
  createWindow();
  setupAutoUpdate();
  cleanUpdateLeftovers();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- file dialogs ----
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

function projectsDir() {
  const dir = path.join(app.getPath('documents'), 'fabu projects');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('projects-dir', async () => {
  try { return { ok: true, path: projectsDir() }; }
  catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('save-to-projects', async (e, { name, data }) => {
  try {
    const dir = projectsDir();
    const base = String(name || 'Untitled').replace(/[\\/:*?"<>|]/g, '').trim() || 'Untitled';
    let file = path.join(dir, base + '.fab');
    let n = 2;
    while (fs.existsSync(file)) file = path.join(dir, base + ' ' + (n++) + '.fab');
    fs.writeFileSync(file, data, 'utf8');
    return { ok: true, path: file, name: path.basename(file) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('reveal-path', async (e, { filePath }) => {
  try {
    if (filePath) shell.showItemInFolder(filePath);
    else shell.openPath(projectsDir());
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('write-file', async (e, { filePath, data, encoding }) => {
  try {
    if (encoding === 'base64') fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    else fs.writeFileSync(filePath, data, 'utf8');
    return { ok: true, path: filePath, name: path.basename(filePath) };
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

ipcMain.handle('open-path', async (e, { filePath }) => {
  try {
    const buf = fs.readFileSync(filePath);
    return { ok: true, name: path.basename(filePath), path: filePath, data: buf.toString('base64') };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

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
