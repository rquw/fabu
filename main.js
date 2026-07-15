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
let updater = null;

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { return; }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // full download instead of the differential/blockmap one — the diff download
  // was what kept cancelling halfway on the unsigned build.
  updater.disableDifferentialDownload = true;
  updater.on('update-available', (info) => {
    updateInfo = info;
    if (win) win.webContents.send('update-ready', info && info.version);
  });
  // Windows: electron-updater does the download + install (it sequences the
  // app-quit-then-install correctly; the old hand-rolled spawn raced it and
  // never actually replaced the files).
  updater.on('download-progress', (p) => {
    if (win) win.webContents.send('update-progress', Math.floor(p.percent || 0));
  });
  updater.on('update-downloaded', async () => {
    if (win) win.webContents.send('update-restarting');
    quitOk = true;
    await new Promise((r) => setTimeout(r, 700)); // let the renderer autosave
    try { updater.quitAndInstall(false, true); } catch (e) { /* ignore */ }
  });
  updater.on('error', () => {
    if (win) win.webContents.send('update-error', 'err');
  });
  updater.checkForUpdates().catch(() => {});
  // check again every 3 hours for long sessions
  setInterval(() => updater.checkForUpdates().catch(() => {}), 3 * 3600 * 1000);
}

function versionNewer(a, b) { // a > b, "1.0.10" style
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
  return false;
}

// manual "check for updates" from the settings window
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

// old installers and swapped-out bundles from previous updates; best-effort
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
    // flaky network: one quiet retry before giving up
    await new Promise((r) => setTimeout(r, 1500));
    if (win) win.webContents.send('update-progress', 0);
    await downloadAsset(meta, dest);
  }

  // give the renderer a moment to autosave before we go down
  if (win) win.webContents.send('update-restarting');
  await new Promise((r) => setTimeout(r, 700));

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
  // strip quarantine and ad-hoc sign so Gatekeeper doesn't re-warn on the swap
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
  quitOk = true;
  app.relaunch();
  app.quit();
}

ipcMain.on('install-update', () => {
  if (!updateInfo) { shell.openExternal('https://rquw.github.io/fabu/').catch(() => {}); return; }
  const fail = (e) => {
    if (win) win.webContents.send('update-error', String((e && e.message) || e));
    shell.openExternal('https://rquw.github.io/fabu/').catch(() => {}); // the site always works
  };
  if (process.platform === 'darwin') {
    // macOS can't use electron-updater unsigned, so we swap the .app ourselves
    applyUpdateMac().catch(fail);
  } else {
    // Windows: electron-updater downloads then installs (fires download-progress
    // + update-downloaded above)
    if (!updater) { fail(new Error('no updater')); return; }
    updater.downloadUpdate().catch(fail);
  }
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

ipcMain.handle('get-version', () => app.getVersion());

app.whenReady().then(() => {
  // Allow microphone access for voice recording
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
