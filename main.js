const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');

let win;

// ---- Updates ----
// The app is unsigned, so electron-updater's own background installer is off
// (its differential download kept failing halfway and could even remove the
// app). We only use it to CHECK for new versions. When the user clicks Update,
// we download the FULL installer ourselves, verify its sha512 against the
// release manifest, and only then hand over — the installed app is never
// touched until a complete, verified new version is on disk.
let updateInfo = null;

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('update-available', (info) => {
    updateInfo = info;
    if (win) win.webContents.send('update-ready', info && info.version);
  });
  autoUpdater.on('error', () => { /* offline or no release: ignore silently */ });
  autoUpdater.checkForUpdates().catch(() => {});
  // check again every 3 hours for long sessions
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 3 * 3600 * 1000);
}

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

async function applyUpdate() {
  const files = (updateInfo && updateInfo.files) || [];
  const wantExt = process.platform === 'darwin' ? '.zip' : '.exe';
  const meta = files.find((f) => f.url && f.url.endsWith(wantExt));
  if (!meta) throw new Error('no installer in this release');
  const tmp = app.getPath('temp');
  const dest = path.join(tmp, 'fabu-update-' + updateInfo.version + wantExt);
  await downloadAsset(meta, dest);

  if (process.platform === 'darwin') {
    // unpack the new fabu.app and swap it in place, then relaunch
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
    try { await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]); } catch (e) { /* none set */ }
    const oldApp = path.join(tmp, 'fabu-old-' + Date.now() + '.app');
    await run('/bin/mv', [curApp, oldApp]);
    try {
      await run('/bin/mv', [newApp, curApp]);
    } catch (e) {
      await run('/bin/mv', [oldApp, curApp]); // put the old one back
      throw e;
    }
    quitOk = true;
    app.relaunch();
    app.quit();
  } else {
    // windows: run the verified one-click installer silently; it swaps the app
    // and starts the new version
    const { spawn } = require('child_process');
    spawn(dest, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    quitOk = true;
    app.quit();
  }
}

ipcMain.on('install-update', () => {
  if (!updateInfo) { shell.openExternal('https://rquw.github.io/fabu/').catch(() => {}); return; }
  applyUpdate().catch((e) => {
    if (win) win.webContents.send('update-error', String((e && e.message) || e));
    // fallback: the site always works
    shell.openExternal('https://rquw.github.io/fabu/').catch(() => {});
  });
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

  // open external links (Ko-fi, GitHub, etc.) in the real browser, not a blank window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });

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
