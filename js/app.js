// ---------- App glue: transport, shortcuts, keyboard instrument, files ----------
'use strict';

// physical key codes to scale degrees (layout independent, QWERTZ friendly)
const WHITE_CODES = { KeyA: 0, KeyS: 2, KeyD: 4, KeyF: 5, KeyG: 7, KeyH: 9, KeyJ: 11, KeyK: 12, KeyL: 14, Semicolon: 16, Quote: 17 };
const BLACK_CODES = { KeyW: 1, KeyE: 3, KeyT: 6, KeyY: 8, KeyU: 10, KeyO: 13, KeyP: 15 };

const App = {

  init() {
    S = freshProject(); // exists before Timeline's playhead loop reads it
    Timeline.init();
    KeysPanel.init();
    this.wireTopbar();
    this.wireKeys();
    this.wireHome();

    this.newProject(false); // safe now that Timeline/KeysPanel are ready
    updateUndoButtons();

    window.addEventListener('resize', () => Timeline.render());
    window.addEventListener('blur', () => this.releaseAllKeys());
    // buttons must not keep focus, otherwise Space would re-trigger them
    document.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) b.blur();
    });

    this.showHome();
    this.initLanguages();
    if (typeof Auth !== 'undefined' && Auth.verifyCached) Auth.verifyCached();
    this.checkAutosave();
    this.startAutosave();
    this.loadLibrary();
    Auth.init();
    if (typeof MIDI !== 'undefined') MIDI.init();
    Sync.initCursors();
    // closing the app asks about unsaved changes
    if (window.electronAPI && window.electronAPI.onConfirmClose) {
      window.electronAPI.onConfirmClose(() => {
        if (!UI.fileDirty) { window.electronAPI.confirmClose(); return; }
        this.confirmExit('close');
      });
    }
    // one-click update: fabu downloads the new version itself and swaps over
    if (window.electronAPI && window.electronAPI.onUpdateReady) {
      window.electronAPI.onUpdateReady((version) => this.showUpdateBanner(version));
      window.electronAPI.onUpdateProgress((pct) => {
        const btn = document.getElementById('updNow');
        if (btn) btn.textContent = pct + '%';
      });
      window.electronAPI.onUpdateError(() => {
        const btn = document.getElementById('updNow');
        if (btn) { btn.disabled = false; btn.textContent = tr('update_now', 'Update'); }
        toast(tr('update_failed', 'Could not update by itself. The download page is open, grab the new version there.'), 'red');
      });
      if (window.electronAPI.onUpdateRestarting) {
        window.electronAPI.onUpdateRestarting(() => {
          const btn = document.getElementById('updNow');
          if (btn) btn.textContent = tr('update_restarting', 'Restarting…');
          this.autosaveTick(); // last save before the swap
        });
      }
      // update finished downloading: let the user pick when to restart
      if (window.electronAPI.onUpdateDownloaded) {
        window.electronAPI.onUpdateDownloaded((backupPath) => this.showRestartPrompt(backupPath));
      }
      // macOS traffic lights overlap the top-left unless we reserve space when
      // windowed; reclaim that gutter in fullscreen (no traffic lights there)
      if (/Mac/i.test(navigator.platform)) document.body.classList.add('is-mac');
      if (window.electronAPI.onFullscreen) window.electronAPI.onFullscreen((fs) => document.body.classList.toggle('is-fullscreen', fs));
    }
    // greet the user once after an update went through
    if (window.electronAPI && window.electronAPI.getVersion) {
      window.electronAPI.getVersion().then((v) => {
        if (!v) return;
        this.version = v;
        const hv = document.getElementById('homeVer');
        if (hv) hv.textContent = 'v' + v;
        // a "Check for updates" button by the version, like the one in Settings
        const cu = document.getElementById('homeCheckUpd');
        if (cu && window.electronAPI.checkUpdates) {
          cu.classList.remove('hidden');
          cu.addEventListener('click', async () => {
            cu.disabled = true;
            cu.textContent = tr('set_checking', 'Checking…');
            const r = await this.checkForUpdates();
            cu.disabled = false;
            cu.textContent = tr('set_check_updates', 'Check for updates');
            if (r === 'latest') toast(tr('set_up_to_date', "You're on the latest version."), 'green');
            else if (r === 'error') toast(tr('set_check_failed', 'Could not check. Are you online?'), 'red');
          });
        }
        const last = localStorage.getItem('fabu.lastVersion');
        localStorage.setItem('fabu.lastVersion', v);
        if (last && last !== v) setTimeout(() => toast(tr('updated_to', 'Updated to fabu v{v}', { v }), 'green'), 900);
      }).catch(() => {});
    }
  },

  // manual update check from the settings window
  async checkForUpdates() {
    if (!(window.electronAPI && window.electronAPI.checkUpdates)) return 'unsupported';
    try {
      const r = await window.electronAPI.checkUpdates();
      if (r && r.status === 'update') { this.showUpdateBanner(r.version); return 'update'; }
      if (r && (r.status === 'latest' || r.status === 'dev')) return 'latest';
      return 'error';
    } catch (e) { return 'error'; }
  },

  showUpdateBanner(version) {
    if (document.getElementById('updateBanner')) return;
    if (document.getElementById('restartModal')) return; // already downloaded
    const b = document.createElement('div');
    b.id = 'updateBanner';
    b.innerHTML = `
      <span class="upd-dot"></span>
      <div class="upd-text">
        <div class="upd-title">${tr('update_available', 'A new version of fabu is out')}${version ? ' · v' + version : ''}</div>
        <div class="upd-note">${tr('update_note', 'Click update and fabu will install it for you.')}</div>
      </div>
      <button class="fbtn accent" id="updNow">${tr('update_now', 'Update')}</button>
      <button class="upd-x" id="updLater" data-tip="${tr('update_later', 'Later')}"><svg class="ic"><use href="#i-x"/></svg></button>`;
    document.body.appendChild(b);
    const btn = b.querySelector('#updNow');
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '0%';
      window.electronAPI.installUpdate();
    });
    b.querySelector('#updLater').addEventListener('click', () => b.remove());
  },

  // the update finished downloading — ask when to restart so work can be saved
  showRestartPrompt(backupPath) {
    const banner = document.getElementById('updateBanner');
    if (banner) banner.remove();
    if (document.getElementById('restartModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'restartModal';
    wrap.className = 'modal-back';
    // Windows installs by replacing the app, so name where the spare installer
    // is: if the install ever fails, that file is the way back in.
    const fallback = backupPath
      ? `<div class="modal-sub" style="font-size:11.5px;opacity:.75">${tr('upd_backup_note', 'A copy of the installer is in your Downloads folder, in case anything goes wrong.')}</div>`
      : '';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('upd_ready_title', 'Update ready to install')}</div>
        <div class="modal-sub" id="rsSub">${tr('upd_ready_sub', 'The new version is downloaded. fabu needs to restart to finish. Save your work first.')}</div>
        ${fallback}
        <div class="modal-btns" style="flex-direction:column;align-items:stretch">
          <button id="rsNow" class="fbtn accent">${tr('upd_restart_now', 'Restart fabu now')}</button>
          <button id="rsSoon" class="fbtn">${tr('upd_restart_soon', 'Restart in 1 minute')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const doRestart = () => {
      if (wrap._iv) clearInterval(wrap._iv);
      this.autosaveTick();
      if (window.electronAPI && window.electronAPI.restartNow) window.electronAPI.restartNow();
    };
    wrap.querySelector('#rsNow').addEventListener('click', doRestart);
    // "in 1 minute" means "let me save first", so the modal has to get out of
    // the way — it used to sit there blocking the whole app until it restarted
    wrap.querySelector('#rsSoon').addEventListener('click', () => {
      wrap.remove();
      this.showRestartCountdown(60, doRestart);
    });
  },

  // A small bar in the corner while the delayed restart counts down: you can
  // keep working and save, restart early, or cancel it entirely.
  showRestartCountdown(secs, doRestart) {
    const old = document.getElementById('restartBar');
    if (old) { clearInterval(old._iv); old.remove(); }
    const bar = document.createElement('div');
    bar.id = 'restartBar';
    bar.innerHTML = `
      <span class="rb-text"></span>
      <button id="rbNow" class="fbtn accent">${tr('upd_restart_now_short', 'Restart now')}</button>
      <button id="rbCancel" class="rb-x" data-tip="${tr('upd_restart_cancel', 'Not yet')}">&times;</button>`;
    document.body.appendChild(bar);
    const txt = bar.querySelector('.rb-text');
    let left = secs;
    const tick = () => {
      if (left <= 0) { clearInterval(bar._iv); bar.remove(); doRestart(); return; }
      txt.textContent = tr('upd_restart_countdown', 'Restarting in {n} seconds. Save now if you need to.', { n: left });
      left--;
    };
    tick();
    bar._iv = setInterval(tick, 1000);
    bar.querySelector('#rbNow').addEventListener('click', () => { clearInterval(bar._iv); bar.remove(); doRestart(); });
    bar.querySelector('#rbCancel').addEventListener('click', () => {
      clearInterval(bar._iv); bar.remove();
      toast(tr('upd_restart_later', 'Update will finish next time you open fabu.'));
    });
  },

  // ---------- leave confirmation (home / quit) ----------

  confirmExit(kind) {
    const old = document.getElementById('exitModal');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'exitModal';
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('exit_title', 'Unsaved changes')}</div>
        <div class="modal-sub">${tr('exit_sub', 'Your project has changes that are not saved to a file.')}</div>
        <div class="modal-btns" style="flex-direction:column;align-items:stretch">
          <button id="exSave" class="fbtn accent">${tr('exit_save', 'Save and exit')}</button>
          <button id="exDiscard" class="fbtn danger">${tr('exit_discard', 'Exit without saving')}</button>
          <button id="exStay" class="fbtn">${tr('exit_stay', 'Stay')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const done = () => {
      wrap.remove();
      if (kind === 'close') window.electronAPI.confirmClose();
      else { UI.dirty = false; UI.fileDirty = false; this.checkAutosave(); this.showHome(); }
    };
    wrap.querySelector('#exSave').addEventListener('click', async () => {
      const ok = await this.save();
      if (ok) done(); // if the save dialog was cancelled, stay
    });
    wrap.querySelector('#exDiscard').addEventListener('click', done);
    wrap.querySelector('#exStay').addEventListener('click', () => wrap.remove());
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });
  },

  goHome() {
    if (UI.fileDirty) { this.confirmExit('home'); return; }
    this.checkAutosave();
    this.showHome();
  },

  // ---------- autosave ----------

  AUTOSAVE_MS: 6000,
  _autosaveData: null,

  startAutosave() {
    setInterval(() => this.autosaveTick(), this.AUTOSAVE_MS);
  },

  async autosaveTick() {
    if (!UI.dirty) return;
    UI.dirty = false;
    this.setAutosaveLabel(tr('autosave_saving', 'Saving…'));
    try {
      const json = this.collectFab();
      if (window.electronAPI && window.electronAPI.autosaveWrite) {
        await window.electronAPI.autosaveWrite({ data: json });
      } else {
        localStorage.setItem('fabu.autosave', json);
      }
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      this.setAutosaveLabel(tr('autosave_saved', 'Saved') + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()));
    } catch (e) {
      UI.dirty = true;
      this.setAutosaveLabel(tr('autosave_failed', 'Autosave failed'));
    }
  },

  setAutosaveLabel(text) {
    const el = $('#autosaveLabel');
    if (el) el.textContent = text;
  },

  async checkAutosave() {
    let data = null;
    try {
      if (window.electronAPI && window.electronAPI.autosaveRead) {
        const r = await window.electronAPI.autosaveRead();
        if (r.ok && r.data) data = r.data;
      } else {
        data = localStorage.getItem('fabu.autosave');
      }
    } catch (e) { /* ignore */ }
    this._autosaveData = data && data.length > 40 ? data : null;
    const btn = $('#homeContinue');
    if (btn) btn.classList.toggle('hidden', !this._autosaveData);
  },

  async continueSession() {
    if (!this._autosaveData) return;
    await this.loadFab(new TextEncoder().encode(this._autosaveData).buffer, 'Autosave.fab');
    this.currentPath = null;
    this.hideHome();
  },

  // ---------- persistent instrument library ----------

  LIB_KEY: 'fabu.instruments',

  async loadLibrary() {
    let text = null;
    try {
      if (window.electronAPI && window.electronAPI.libraryRead) {
        const r = await window.electronAPI.libraryRead();
        if (r.ok && r.data) text = r.data;
      } else {
        text = localStorage.getItem(this.LIB_KEY);
      }
    } catch (e) { /* ignore */ }
    if (!text) return;
    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    Engine.ensureCtx();
    for (const [sid, s] of Object.entries(data.samples || {})) {
      if (Samples[sid]) continue;
      try {
        const bytes = b64ToBuf(s.data);
        const buffer = await Engine.ctx.decodeAudioData(bytes.slice(0));
        Samples[sid] = { id: sid, name: s.name, buffer, bytes, mime: s.mime };
      } catch (e) { /* skip broken */ }
    }
    LIB = data.instruments || {};
    if (Timeline.lanes) { Timeline.render(); KeysPanel.refreshTracks(); }
  },

  async saveLibrary() {
    const samples = {};
    for (const inst of Object.values(LIB)) {
      const s = Samples[inst.sampleId];
      if (s && s.bytes && !samples[inst.sampleId]) {
        samples[inst.sampleId] = { name: s.name, mime: s.mime, data: bufToB64(s.bytes) };
      }
    }
    const json = JSON.stringify({ instruments: LIB, samples });
    try {
      if (window.electronAPI && window.electronAPI.libraryWrite) {
        await window.electronAPI.libraryWrite({ data: json });
      } else {
        localStorage.setItem(this.LIB_KEY, json);
      }
    } catch (e) { /* ignore quota */ }
  },

  addToLibrary(def) {
    LIB[def.id] = JSON.parse(JSON.stringify(def));
    this.saveLibrary();
  },

  removeFromLibrary(id) {
    if (LIB[id]) { delete LIB[id]; this.saveLibrary(); }
  },

  // quick delete of a custom instrument (from the track header trash button)
  deleteInstrument(id) {
    if (!resolveInstrument(id)) return;
    Undo.push('Delete instrument');
    for (const t of S.tracks) if (t.instrument === id) t.instrument = 'rpiano';
    delete S.instruments[id];
    this.removeFromLibrary(id);
    if (Sampler.isOpen() && Sampler.editId === id) Windows.close('sampler');
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    toast(tr('samp_deleted', 'Instrument deleted'));
  },

  // ---------- fresh project ----------

  newProject(announce = true) {
    if (UI.playing || UI.recording) { Engine.stopRecord && Engine.stopRecord(); Engine.stop && Engine.stop(); }
    // A new project starts genuinely empty. Prefilled lanes look like a mess
    // you have to clear out before you can start; the tutorial points at the
    // Instrument button instead.
    S = freshProject();
    Undo.undoStack.length = 0;
    Undo.redoStack.length = 0;
    UI.playhead = 0;
    UI.selClipId = null;
    UI.selTrackId = null;
    UI.dirty = false;
    UI.fileDirty = false;
    this.currentPath = null;
    $('#projName').value = 'Untitled';
    if (Engine.ctx) { Engine.rebuildTracks(); Engine.updateAllTracks(); }
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    updateUndoButtons();
    if (announce) toast(tr('toast_new_project', 'New project'));
    if (typeof Tutor !== 'undefined') Tutor.maybeStartEmpty();
  },

  // A finished little track built from the built-in loops, so a first-timer has
  // something to press play on and take apart.
  loadDemo() {
    if (UI.playing || UI.recording) { Engine.stopRecord && Engine.stopRecord(); Engine.stop && Engine.stop(); }
    S = freshProject();
    S.bpm = 100;
    const lib = (id) => SAMPLE_LIB.find(s => s.id === id);
    const clipAt = (sampleId, start) => {
      const s = lib(sampleId);
      if (!s) return null;
      return {
        id: uid('clip'), kind: 'midi', name: s.name, by: authorName(), start, length: s.length,
        notes: s.notes.map(n => ({ id: uid('note'), pitch: n.pitch, start: n.start, length: n.length, vel: n.vel ?? 0.9 }))
      };
    };
    const layTrack = (name, instrument, sampleId, bars, fromBar = 0) => {
      const t = makeTrack('midi');
      t.name = name; t.instrument = instrument; t.clips = [];
      for (let i = fromBar; i < bars; i++) { const c = clipAt(sampleId, i * 4); if (c) t.clips.push(c); }
      return t;
    };
    const BARS = 8;
    const drums = layTrack('Drums', 'drums', 'dr_house', BARS);
    const chords = layTrack('Chords', 'rpiano', 'me_chords', BARS);
    drums.swing = 0.14; chords.swing = 0.14;   // a little shared groove
    S.tracks.push(
      drums,
      layTrack('Bass', 'bass', 'ba_house', BARS),
      chords,
      layTrack('Lead', 'pluck', 'me_arp', BARS, 2)   // the arp enters at bar 3
    );
    Undo.undoStack.length = 0;
    Undo.redoStack.length = 0;
    UI.playhead = 0;
    UI.selClipId = null;
    UI.selClipIds = new Set();
    UI.selTrackId = null;
    UI.dirty = true;
    UI.fileDirty = false;   // freshly loaded example; editing it will mark it unsaved
    this.currentPath = null;
    $('#projName').value = tr('demo_name', 'Example song');
    $('#bpmInput').value = S.bpm;
    if (Engine.ctx) { Engine.rebuildTracks(); Engine.updateAllTracks(); }
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    updateUndoButtons();
    toast(tr('toast_demo_loaded', 'Example loaded. Press play, then take it apart.'));
  },

  // ---------- homescreen ----------

  wireHome() {
    $('#homeNew').addEventListener('click', () => { this.stopHomePreview(); this.newProject(false); this.hideHome(); });
    $('#homeDemo').addEventListener('click', () => { this.stopHomePreview(); this.loadDemo(); this.hideHome(); });
    $('#homeOpen').addEventListener('click', () => { this.stopHomePreview(); this.open(); });
    $('#homeContinue').addEventListener('click', () => { this.stopHomePreview(); this.continueSession(); });
    $('#homeMp').addEventListener('click', () => { this.stopHomePreview(); MP.openMenu(); });
    $('#logo').addEventListener('click', () => this.goHome());
  },

  showHome() {
    this.renderRecents();
    const home = $('#home');
    home.classList.remove('closing');
    home.style.display = 'flex';
  },

  homeVisible() {
    const home = document.getElementById('home');
    return !!home && home.style.display !== 'none';
  },

  hideHome() {
    const home = $('#home');
    if (home.style.display === 'none') return;
    home.classList.add('closing');
    setTimeout(() => {
      home.style.display = 'none';
      home.classList.remove('closing');
      // Now the workspace is actually on screen, so the first-run walkthrough
      // has something real to point at.
      if (typeof Tutor !== 'undefined') Tutor.maybeStartEmpty();
    }, 220);
  },

  RECENTS_KEY: 'fabu.recents',

  getRecents() {
    try { return JSON.parse(localStorage.getItem(this.RECENTS_KEY)) || []; }
    catch (e) { return []; }
  },

  addRecent(path, name) {
    if (!path) return;
    let list = this.getRecents().filter(r => r.path !== path);
    list.unshift({ path, name: name.replace(/\.fab$/i, ''), at: Date.now() });
    list = list.slice(0, 12);
    localStorage.setItem(this.RECENTS_KEY, JSON.stringify(list));
  },

  removeRecent(path) {
    const list = this.getRecents().filter(r => r.path !== path);
    localStorage.setItem(this.RECENTS_KEY, JSON.stringify(list));
    this.renderRecents();
  },

  agoText(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return tr('just_now', 'just now');
    if (s < 3600) return tr('min_ago', '{n} min ago', { n: Math.floor(s / 60) });
    if (s < 86400) return tr('h_ago', '{n} h ago', { n: Math.floor(s / 3600) });
    const d = Math.floor(s / 86400);
    return d === 1 ? tr('yesterday', 'yesterday') : tr('days_ago', '{n} days ago', { n: d });
  },

  renderRecents() {
    const box = $('#homeRecentList');
    const list = this.getRecents();
    box.innerHTML = '';
    if (!list.length) {
      const el = document.createElement('div');
      el.className = 'home-empty';
      el.textContent = t('no_projects') || 'No projects yet. Make one and save it.';
      box.appendChild(el);
      return;
    }
    list.forEach((r, i) => {
      const card = document.createElement('button');
      card.className = 'home-card';
      card.style.setProperty('--i', i);
      const hue = (r.name.charCodeAt(0) * 47) % 360;
      card.innerHTML = `
        <div class="home-card-art" style="--h:${hue}">
          <svg class="ic"><use href="#i-note"/></svg>
          <div class="card-acts">
            <span class="card-act" data-act="listen" data-tip="${this.homePreviewPath === r.path ? tr('recent_stop', 'Stop') : tr('recent_listen', 'Open and play')}"><svg class="ic"><use href="#${this.homePreviewPath === r.path ? 'i-stop' : 'i-play'}"/></svg></span>
            <span class="card-act" data-act="edit" data-tip="${tr('recent_edit', 'Open to edit')}"><svg class="ic"><use href="#i-edit"/></svg></span>
          </div>
        </div>
        <div class="home-card-name">${r.name || 'Untitled'}</div>
        <div class="home-card-sub">${this.agoText(r.at)}</div>`;
      card.addEventListener('click', (e) => {
        const act = e.target.closest && e.target.closest('.card-act');
        if (act && act.dataset.act === 'listen') {
          if (this.homePreviewPath === r.path) this.stopHomePreview();
          else this.previewRecent(r.path);
        }
        else this.openRecent(r.path);
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.removeRecent(r.path);
        toast(tr('removed_recent', 'Removed from recents'));
      });
      box.appendChild(card);
    });
  },

  async openRecent(path) {
    this.stopHomePreview();
    if (!window.electronAPI) { toast(tr('toast_recents_need_app', 'Recents need the app'), 'red'); return; }
    const res = await window.electronAPI.openPath({ filePath: path });
    if (!res.ok) {
      toast(tr('toast_open_failed', 'File could not be opened'), 'red');
      this.removeRecent(path);
      return;
    }
    await this.loadFab(b64ToBuf(res.data), res.name, res.path);
    this.hideHome();
  },

  // "Listen" plays a recent project without leaving the home screen
  async previewRecent(path) {
    if (!window.electronAPI) { toast(tr('toast_recents_need_app', 'Recents need the app'), 'red'); return; }
    Engine.ensureCtx(); Engine.ctx.resume(); // use the click gesture for audio permission
    const res = await window.electronAPI.openPath({ filePath: path });
    if (!res.ok) { toast(tr('toast_open_failed', 'File could not be opened'), 'red'); this.removeRecent(path); return; }
    await this.loadFab(b64ToBuf(res.data), res.name, res.path);
    this.homePreviewing = true;
    this.homePreviewPath = path;
    this.showHomePlayer(res.name || 'Untitled');
    this.renderRecents();
    UI.playhead = 0;
    if (!UI.playing) this.togglePlay();
  },

  showHomePlayer(name) {
    let bar = document.getElementById('homePlayer');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'homePlayer';
      $('#home').appendChild(bar);
    }
    bar.innerHTML = `
      <button id="hpStop" class="hp-btn" aria-label="stop"><svg class="ic"><use href="#i-stop"/></svg></button>
      <span class="hp-name">${tr('home_now_playing', 'Playing')} · ${name}</span>
      <button id="hpEdit" class="hp-edit">${tr('home_open_editor', 'Open editor')}</button>`;
    bar.querySelector('#hpStop').addEventListener('click', () => this.stopHomePreview());
    bar.querySelector('#hpEdit').addEventListener('click', () => { this.homePreviewing = false; const b = document.getElementById('homePlayer'); if (b) b.remove(); this.hideHome(); });
  },

  stopHomePreview() {
    if (!this.homePreviewing) return;
    this.homePreviewing = false;
    this.homePreviewPath = null;
    Engine.stop();
    const bar = document.getElementById('homePlayer');
    if (bar) bar.remove();
    this.renderRecents();
  },

  // ---------- languages (file-driven i18n) ----------

  languages: [],
  currentLangFile: null,
  LANG_KEY: 'fabu.lang',

  // Find every languages/*.json. Uses the Electron bridge, or in a plain
  // browser reads the folder listing that the dev server hands back.
  async discoverLanguages() {
    if (window.electronAPI && window.electronAPI.getLanguages) {
      try { return await window.electronAPI.getLanguages(); } catch (e) { return []; }
    }
    // browser: read a manifest (works on static hosts like GitHub Pages),
    // falling back to a dev-server directory listing.
    let names = [];
    try {
      const man = await fetch('languages/index.json');
      if (man.ok) names = await man.json();
    } catch (e) { /* no manifest */ }
    if (!names.length) {
      try {
        const html = await (await fetch('languages/')).text();
        names = [...new Set([...html.matchAll(/href="([^"]+\.json)"/g)].map(m => m[1].split('/').pop()))];
      } catch (e) { /* no listing */ }
    }
    names = names.filter(f => f !== 'index.json');
    const out = [];
    for (const f of names) {
      try { out.push({ file: f, data: await (await fetch('languages/' + f)).json() }); } catch (e) {}
    }
    return out;
  },

  async initLanguages() {
    this.languages = await this.discoverLanguages();
    this.renderFlags();
    if (!this.languages.length) return; // no files, no flags, keep built-in English
    const saved = localStorage.getItem(this.LANG_KEY);
    const pick = this.languages.find(l => l.file === saved)
      || this.languages.find(l => l.file === 'english.json')
      || this.languages[0];
    this.setLanguage(pick, false);
  },

  setLanguage(entry, announce = true) {
    if (!entry) return;
    I18N = entry.data || {};
    this.currentLangFile = entry.file;
    localStorage.setItem(this.LANG_KEY, entry.file);
    this.applyI18n();
    this.renderFlags();
    this.renderRecents();
    // re-render the parts that build their text in JS
    if (Timeline.lanes) { Timeline.render(); Windows.refreshAll(); KeysPanel.refreshTracks(); }
    KeysPanel.syncRecButton();
    if (announce) toast(entry.data.language_name || entry.file);
  },

  // Replace text of [data-i18n] and tooltips of [data-i18n-tip]. Missing keys
  // are left alone so the built-in English text stays.
  applyI18n(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) {
      const v = t(el.dataset.i18n);
      if (v != null) el.textContent = v;
    }
    for (const el of root.querySelectorAll('[data-i18n-tip]')) {
      const v = t(el.dataset.i18nTip);
      if (v != null) el.dataset.tip = v;
    }
  },

  renderFlags() {
    const box = $('#homeLangs');
    box.innerHTML = '';
    if (this.languages.length < 1) { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    for (const L of this.languages) {
      const name = (L.data && L.data.language_name) || L.file.replace(/\.json$/i, '');
      const b = document.createElement('button');
      b.className = 'lang-flag' + (L.file === this.currentLangFile ? ' active' : '');
      b.dataset.tip = name;
      const url = L.data && L.data.image_adress;
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = name;
        img.onerror = () => { b.classList.add('noimg'); b.textContent = name.slice(0, 2).toUpperCase(); };
        b.appendChild(img);
      } else {
        b.classList.add('noimg');
        b.textContent = name.slice(0, 2).toUpperCase();
      }
      b.addEventListener('click', () => this.setLanguage(L));
      box.appendChild(b);
    }
  },

  // ---------- snap coach (nudge to change grid when fighting the snap) ----------

  _coachUntil: 0,
  _coachTimer: null,

  showSnapCoach() {
    const now = Date.now();
    if (now < this._coachUntil) return;      // cooldown so it is not naggy
    this._coachUntil = now + 25000;
    const el = $('#snapCoach');
    // sit it right under the snap control wherever that ends up (wrapped topbar,
    // narrow window, etc.) instead of a fixed screen-centre spot
    const snap = $('#snapSelect');
    if (snap) {
      const r = snap.getBoundingClientRect();
      el.style.left = Math.round(r.left + r.width / 2) + 'px';
      el.style.top = Math.round(r.bottom + 6) + 'px';
    }
    clearTimeout(this._coachTimer);
    el.classList.remove('hidden', 'hide');
    // restart the entrance animation
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    this._coachTimer = setTimeout(() => {
      el.classList.remove('show');
      el.classList.add('hide');
      setTimeout(() => el.classList.add('hidden'), 320);
    }, 4200);
  },

  // ---------- transport ----------

  onTransport() {
    const use = $('#btnPlay use');
    use.setAttribute('href', UI.playing ? '#i-pause' : '#i-play');
    $('#btnPlay').classList.toggle('playing', UI.playing);
    $('#btnRec').classList.toggle('on', UI.recording);
    Timeline.updatePlayhead();
  },

  togglePlay() {
    if (UI.playing) { Engine.pause(); toast(tr('toast_paused', 'Paused')); }
    else { Engine.play(); toast(tr('toast_playing', 'Playing')); }
  },

  stop() {
    if (UI.recording) Engine.stopRecord();
    Engine.stop();
    toast(tr('toast_stopped', 'Stopped'));
  },

  setMetronome(v) {
    S.metronome = v;
    $('#btnMetro').classList.toggle('on', v);
    toast(tr(v ? 'toast_metro_on' : 'toast_metro_off', 'Metronome ' + (v ? 'on' : 'off')));
  },

  // repeat a section while you work on it
  // Nudge about the L key, but only when the user has actually shown they want
  // it: replaying the same passage over and over, or fighting a loop that is
  // holding the playhead in. Each nudge is said once and then never again.
  _loopHinted: {},
  hintLoop(kind) {
    if (this._loopHinted[kind]) return;
    this._loopHinted[kind] = true;
    const msg = {
      made: tr('hint_loop_made', 'Press L to repeat this section'),
      repeat: tr('hint_loop_repeat', 'Playing that part a lot? Press L to repeat it automatically'),
      escape: tr('hint_loop_escape', 'Repeat is on, so the playhead stays in the loop. Press L to turn it off.')
    }[kind];
    if (msg) toast(msg);
  },

  // Count deliberate replays of roughly the same spot. Three is enough to say
  // the user is looping by hand.
  noteReplay(beat) {
    const near = this._lastPlayFrom != null && Math.abs(beat - this._lastPlayFrom) < 1;
    this._replays = near ? (this._replays || 1) + 1 : 1;
    this._lastPlayFrom = beat;
    if (this._replays >= 3 && !S.loopOn) this.hintLoop('repeat');
  },

  setLoop(v) {
    S.loopOn = v;
    const b = document.getElementById('btnLoop');
    if (b) b.classList.toggle('on', v);
    if (v && !(S.loopEnd > S.loopStart)) { S.loopStart = snapBeat(UI.playhead, 4); S.loopEnd = S.loopStart + 8; }
    Timeline.drawRuler();
    UI.dirty = UI.fileDirty = true;
    toast(v ? tr('toast_loop_on', 'Repeating bar {a} to {b}', { a: Math.floor(S.loopStart / 4) + 1, b: Math.floor(S.loopEnd / 4) + 1 })
            : tr('toast_loop_off', 'Repeat off'));
  },

  // section markers (Intro, Drop, Chorus, ...) along the ruler
  addMarker(beat) {
    const at = beat != null ? beat : snapBeat(UI.playhead, S.snap || 1);
    // a real dialog: Electron has no window.prompt, so the old one just vanished
    this.askText(tr('marker_prompt', 'Section name'), tr('marker_default', 'Section'), (name) => {
      if (!name) return;
      Undo.push('Add marker');
      if (!S.markers) S.markers = [];
      S.markers.push({ id: uid('mk'), beat: at, name: String(name).slice(0, 24) });
      S.markers.sort((a, b) => a.beat - b.beat);
      Timeline.drawRuler();
      UI.dirty = UI.fileDirty = true;
      toast(tr('toast_marker_added', 'Section marker added'), 'green');
    });
  },

  // small in-app text prompt (quick presets for section names)
  askText(title, initial, done) {
    const old = document.getElementById('askModal');
    if (old) old.remove();
    const presets = ['Intro', 'Verse', 'Chorus', 'Drop', 'Bridge', 'Outro'];
    const wrap = document.createElement('div');
    wrap.id = 'askModal';
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${title}</div>
        <input id="askInput" type="text" maxlength="24" spellcheck="false" value="${initial || ''}">
        <div class="ask-presets">${presets.map(p => `<button class="fbtn ask-preset">${p}</button>`).join('')}</div>
        <div class="modal-btns">
          <button id="askCancel" class="fbtn">${tr('cancel', 'Cancel')}</button>
          <button id="askOk" class="fbtn accent">${tr('ask_ok', 'Add')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const inp = wrap.querySelector('#askInput');
    const close = () => wrap.remove();
    const ok = () => { const v = inp.value.trim(); close(); done(v); };
    wrap.querySelectorAll('.ask-preset').forEach(b => b.addEventListener('click', () => { inp.value = b.textContent; ok(); }));
    wrap.querySelector('#askOk').addEventListener('click', ok);
    wrap.querySelector('#askCancel').addEventListener('click', close);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); });
    setTimeout(() => { inp.focus(); inp.select(); }, 40);
  },

  // A plain yes/no, in the app's own dialog style. Resolves false if the user
  // dismisses it, because "no" is always the safe answer here.
  askYesNo({ title, body, yes, no }) {
    return new Promise((resolve) => {
      const old = document.getElementById('confirmModal');
      if (old) old.remove();
      const wrap = document.createElement('div');
      wrap.id = 'confirmModal';
      wrap.className = 'modal-back';
      wrap.innerHTML = `
        <div class="modal-card">
          <div class="modal-title"></div>
          <div class="modal-sub"></div>
          <div class="modal-btns">
            <button id="cfNo" class="fbtn"></button>
            <button id="cfYes" class="fbtn accent"></button>
          </div>
        </div>`;
      wrap.querySelector('.modal-title').textContent = title;
      wrap.querySelector('.modal-sub').textContent = body;
      wrap.querySelector('#cfYes').textContent = yes || tr('yes', 'Yes');
      wrap.querySelector('#cfNo').textContent = no || tr('no', 'No');
      document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); window.removeEventListener('keydown', key, true); resolve(v); };
      const key = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        if (e.key === 'Enter') { e.stopPropagation(); done(true); }
      };
      wrap.querySelector('#cfYes').addEventListener('click', () => done(true));
      wrap.querySelector('#cfNo').addEventListener('click', () => done(false));
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(false); });
      window.addEventListener('keydown', key, true);
      setTimeout(() => wrap.querySelector('#cfYes').focus(), 40);
    });
  },

  // get rid of the repeat region entirely
  clearLoop() {
    S.loopOn = false; S.loopStart = 0; S.loopEnd = 0;
    const b = document.getElementById('btnLoop');
    if (b) b.classList.remove('on');
    Timeline.drawRuler();
    UI.dirty = UI.fileDirty = true;
    toast(tr('toast_loop_cleared', 'Repeat region cleared'));
  },
  removeMarkerNear(beat) {
    if (!S.markers || !S.markers.length) return false;
    const tol = 12 / UI.zoom;   // within ~12px
    const i = S.markers.findIndex(m => Math.abs(m.beat - beat) <= tol);
    if (i < 0) return false;
    Undo.push('Remove marker');
    S.markers.splice(i, 1);
    Timeline.drawRuler();
    toast(tr('toast_marker_removed', 'Section marker removed'));
    return true;
  },

  setBpm(v, pushUndo = true) {
    v = clamp(Math.round(v), 40, 300);
    if (v === S.bpm) return;
    if (pushUndo) Undo.push('Change BPM');
    S.bpm = v;
    $('#bpmInput').value = v;
    if (UI.playing) Engine.seek(Engine.currentBeat()); // restart scheduling at new tempo
    Timeline.render();
  },

  // ---------- selection ----------

  selectClip(id, add = false) {
    if (!add) {
      UI.selClipIds = new Set(id ? [id] : []);
      UI.selClipId = id;
    } else if (id) {
      // shift-click: toggle membership, last one clicked becomes primary
      if (UI.selClipIds.has(id) && UI.selClipIds.size > 1) {
        UI.selClipIds.delete(id);
        if (UI.selClipId === id) UI.selClipId = [...UI.selClipIds].pop() || null;
      } else {
        UI.selClipIds.add(id);
        UI.selClipId = id;
      }
    }
    this.paintClipSelection();
    if (UI.selClipId) {
      const f = getClip(UI.selClipId);
      if (f) this.selectTrack(f.track.id);
      const w = Windows.wins.get('inspector');
      if (w) w.refresh();
      setHint(UI.selClipIds.size > 1
        ? tr('hint_clips_selected', '{n} clips selected. Drag moves them together, edge-drag resizes them together.', { n: UI.selClipIds.size })
        : tr('hint_clip_selected', 'Drag to move, double-click to edit, right-click to delete, Cmd D to duplicate.'));
    } else {
      const w = Windows.wins.get('inspector');
      if (w) w.refresh();
    }
  },

  // replace the whole selection at once (marquee)
  selectClipSet(ids) {
    UI.selClipIds = new Set(ids);
    UI.selClipId = ids.length ? ids[ids.length - 1] : null;
    this.paintClipSelection();
    const w = Windows.wins.get('inspector');
    if (w) w.refresh();
    if (ids.length > 1) setHint(tr('hint_clips_selected', '{n} clips selected. Drag moves them together, edge-drag resizes them together.', { n: ids.length }));
  },

  paintClipSelection() {
    for (const el of $$('.clip')) el.classList.toggle('sel', UI.selClipIds.has(el.dataset.clipId));
  },

  selectTrack(id) {
    if (UI.selTrackId === id) return;
    UI.selTrackId = id;
    for (const el of $$('.thead')) el.classList.toggle('sel', el.dataset.trackId === id);
    for (const el of $$('.lane')) el.classList.toggle('sel', el.dataset.trackId === id);
  },

  // ---------- track / clip operations (all undoable) ----------

  addTrack(kind) {
    Undo.push(kind === 'midi' ? 'Add instrument track' : 'Add audio track');
    const t = makeTrack(kind);
    S.tracks.push(t);
    Engine.rebuildTracks();
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    this.selectTrack(t.id);
    if (typeof Sync !== 'undefined') Sync.logAction('add_track', t.name);
    toast(tr('toast_track_added', '{name} added', { name: t.name }));
  },

  deleteTrack(id) {
    const t = getTrack(id);
    if (!t) return;
    Undo.push('Delete track');
    if (typeof Sync !== 'undefined') Sync.logAction('del_track', t.name);
    S.tracks.splice(S.tracks.indexOf(t), 1);
    if (UI.selTrackId === id) UI.selTrackId = null;
    if (UI.selClipId && !getClip(UI.selClipId)) UI.selClipId = null;
    Engine.rebuildTracks();
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    PianoRoll.onStateRestore();
    toast(tr('toast_track_deleted', 'Track "{name}" deleted', { name: t.name }));
  },

  toggleMute(t) {
    Undo.push(t.mute ? 'Unmute track' : 'Mute track');
    t.mute = !t.mute;
    Engine.updateAllTracks();
    Timeline.syncHeads();
    Windows.refreshAll();
    toast(tr(t.mute ? 'toast_muted' : 'toast_unmuted', '{name}' + (t.mute ? ' muted' : ' unmuted'), { name: t.name }));
  },

  toggleSolo(t) {
    Undo.push(t.solo ? 'Unsolo track' : 'Solo track');
    t.solo = !t.solo;
    Engine.updateAllTracks();
    Timeline.syncHeads();
    Windows.refreshAll();
    toast(t.solo ? tr('toast_solo', 'Solo: {name}', { name: t.name }) : tr('toast_solo_off', 'Solo off'));
  },

  deleteSelectedClip() {
    if (!UI.selClipIds.size) return;
    const found = [...UI.selClipIds].map(getClip).filter(Boolean);
    if (!found.length) return;
    Undo.push(found.length > 1 ? 'Delete clips' : 'Delete clip');
    for (const f of found) {
      if (typeof Sync !== 'undefined') Sync.logAction('del_clip', f.clip.name || (f.clip.kind === 'midi' ? 'Pattern' : 'Audio'));
      f.track.clips.splice(f.track.clips.indexOf(f.clip), 1);
      if (PianoRoll.clipId === f.clip.id) PianoRoll.close();
    }
    // a group track left empty by deleting its group clip has no purpose
    S.tracks = S.tracks.filter(t => t.kind !== 'group' || t.clips.length);
    Engine.rebuildTracks();
    this.selectClip(null);
    Timeline.render();
    Windows.refreshAll();
    toast(found.length > 1 ? tr('toast_clips_deleted', '{n} clips deleted', { n: found.length }) : tr('toast_clip_deleted', 'Clip deleted'));
  },

  duplicateClip() {
    if (!UI.selClipIds.size) return;
    const found = [...UI.selClipIds].map(getClip).filter(Boolean);
    if (!found.length) return;
    Undo.push(found.length > 1 ? 'Duplicate clips' : 'Duplicate clip');
    const newIds = [];
    for (const f of found) {
      const c = JSON.parse(JSON.stringify(f.clip));
      c.id = uid('clip');
      if (c.notes) for (const n of c.notes) n.id = uid('note');
      c.start = f.clip.start + clipBeats(f.clip);
      f.track.clips.push(c);
      newIds.push(c.id);
    }
    Timeline.render();
    this.selectClipSet(newIds);
    toast(found.length > 1 ? tr('toast_clips_duplicated', '{n} clips duplicated', { n: found.length }) : tr('toast_clip_duplicated', 'Clip duplicated'));
  },

  // ---------- groups (compound clips) ----------

  // bundle the selected clips (across tracks) into one group clip on a new track.
  // Non-destructive: the originals are kept inside and restored on ungroup.
  async groupSelectedClips() {
    const items = [...UI.selClipIds].map(getClip).filter(Boolean);
    if (items.length < 2) { toast(tr('toast_group_need2', 'Select at least two clips to group')); return; }
    if (items.some(it => it.clip.kind === 'group')) { toast(tr('toast_group_nested', 'Ungroup the old-style group first')); return; }
    const start = Math.min(...items.map(it => it.clip.start));
    const end = Math.max(...items.map(it => it.clip.start + clipBeats(it.clip)));
    const lenBeats = Math.max(0.25, end - start);
    // keep the originals so Ungroup can bring them back exactly
    const children = items.map(it => ({
      origTrackId: it.track.id,
      origTrackName: it.track.name,
      origTrackKind: it.track.kind,
      origInstrument: it.track.instrument,
      origColor: it.track.color,
      clip: Object.assign(JSON.parse(JSON.stringify(it.clip)), { start: it.clip.start - start })
    }));
    toast(tr('toast_bouncing', 'Bouncing group…'));
    let buf;
    try { buf = await Engine.bounceClips(items, start, lenBeats); }
    catch (e) { console.warn('bounce failed', e); toast(tr('toast_group_fail', 'Could not bounce the group'), 'red'); return; }
    // selection may have changed while rendering; make sure the clips still exist
    if (items.some(it => !getClip(it.clip.id))) { toast(tr('toast_group_fail', 'Could not bounce the group'), 'red'); return; }
    Undo.push('Group clips');
    const id = uid('smp');
    Samples[id] = { id, name: tr('group_name', 'Group'), buffer: buf, bytes: Engine.encodeWav(buf), mime: 'audio/wav' };
    for (const it of items) it.track.clips.splice(it.track.clips.indexOf(it.clip), 1);
    const gt = makeTrack('audio');
    gt.name = tr('group_track', 'Group');
    gt.color = '#7d8bb0';   // a distinct slate so groups read as their own thing
    gt.fromGroup = true;
    const clip = {
      id: uid('clip'), kind: 'audio', name: tr('group_name', 'Group'), by: authorName(),
      start, sampleId: id, gain: 1, pitch: 0, speed: 1, fadeIn: 0, fadeOut: 0,
      bounce: { children, bpm: S.bpm }   // real audio now, but reversible
    };
    gt.clips.push(clip);
    S.tracks.push(gt);
    Engine.rebuildTracks();
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    this.selectClip(clip.id);
    if (UI.playing) Engine.liveEdit();
    if (typeof Sync !== 'undefined') Sync.logAction('group', clip.name);
    toast(tr('toast_grouped', 'Grouped {n} clips', { n: items.length }), 'green');
  },

  // undo a group: put every child back on its original track, drop the group.
  // Works for a bounced audio group (new) or an old-style container group.
  ungroupClip(clipId) {
    const f = getClip(clipId);
    if (!f) return;
    const group = f.clip, gt = f.track;
    const children = group.kind === 'group' ? group.children : (group.bounce && group.bounce.children);
    if (!children) return;
    Undo.push('Ungroup');
    const restored = [];
    for (const child of children) {
      const clip = Object.assign(JSON.parse(JSON.stringify(child.clip)), { start: group.start + (child.clip.start || 0) });
      let track = getTrack(child.origTrackId);
      if (!track || track.kind !== child.origTrackKind) {
        track = makeTrack(child.origTrackKind || 'midi');
        track.name = child.origTrackName || track.name;
        if (child.origInstrument) track.instrument = child.origInstrument;
        if (child.origColor) track.color = child.origColor;
        S.tracks.push(track);
      }
      clip.start = Timeline.nearestFreeStart(track, clipBeats(clip), clip.start, null);
      track.clips.push(clip);
      restored.push(clip.id);
    }
    gt.clips.splice(gt.clips.indexOf(group), 1);
    // keep the flattened sample in memory so undoing the ungroup can find it
    // again (Undo only snapshots the project, not the decoded audio); unused
    // samples are dropped from the saved file automatically anyway.
    if (!gt.clips.length && (gt.fromGroup || gt.kind === 'group')) S.tracks.splice(S.tracks.indexOf(gt), 1);
    Engine.rebuildTracks();
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    this.selectClipSet(restored);
    if (UI.playing) Engine.liveEdit();
    if (typeof Sync !== 'undefined') Sync.logAction('ungroup', group.name || 'Group');
    toast(tr('toast_ungrouped', 'Ungrouped'), 'green');
  },

  // Flatten the selected clip(s) into a plain audio clip — exactly like an
  // audio file you dragged in. One-way (no "revert to pattern"); undo with Cmd Z.
  async convertToAudio() {
    const items = [...UI.selClipIds].map(getClip).filter(Boolean);
    if (!items.length) return;
    if (items.some(it => it.clip.kind === 'group')) { toast(tr('toast_convert_group', 'Ungroup it first, then convert')); return; }
    const start = Math.min(...items.map(it => it.clip.start));
    const end = Math.max(...items.map(it => it.clip.start + clipBeats(it.clip)));
    const lenBeats = Math.max(0.25, end - start);
    const name = (items.length === 1 && items[0].clip.name) ? items[0].clip.name : tr('word_audio', 'Audio');
    toast(tr('toast_converting', 'Converting to audio…'));
    let buf;
    try { buf = await Engine.bounceClips(items, start, lenBeats); }
    catch (e) { console.warn('convert failed', e); toast(tr('toast_group_fail', 'Could not bounce the group'), 'red'); return; }
    if (items.some(it => !getClip(it.clip.id))) { toast(tr('toast_group_fail', 'Could not bounce the group'), 'red'); return; }
    Undo.push('Convert to audio');
    const id = uid('smp');
    Samples[id] = { id, name, buffer: buf, bytes: Engine.encodeWav(buf), mime: 'audio/wav' };
    for (const it of items) it.track.clips.splice(it.track.clips.indexOf(it.clip), 1);
    let track = items[0].track.kind === 'audio' ? items[0].track : null;
    if (!track) { track = makeTrack('audio'); track.name = name; S.tracks.push(track); }
    const clip = { id: uid('clip'), kind: 'audio', name, by: authorName(), start, sampleId: id, gain: 1, pitch: 0, speed: 1, fadeIn: 0, fadeOut: 0 };
    clip.start = Timeline.nearestFreeStart(track, clipBeats(clip), start, null);
    track.clips.push(clip);
    Engine.rebuildTracks();
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    this.selectClip(clip.id);
    if (UI.playing) Engine.liveEdit();
    if (typeof Sync !== 'undefined') Sync.logAction('add_audio', name);
    toast(tr('toast_converted', 'Converted to audio'), 'green');
  },

  // slice the selected clip in two at the playhead
  splitSelectedClip() {
    if (!UI.selClipId) { toast(tr('toast_select_clip_split', 'Select a clip to split first'), 'red'); return; }
    const f = getClip(UI.selClipId);
    if (!f) return;
    const clip = f.clip;
    const beat = UI.playing ? Engine.currentBeat() : UI.playhead;
    const lenB = clipBeats(clip);
    if (beat <= clip.start + 0.02 || beat >= clip.start + lenB - 0.02) {
      toast(tr('toast_move_playhead_split', 'Move the playhead inside the clip to split it'), 'red');
      return;
    }
    Undo.push('Split clip');
    const len1 = beat - clip.start;
    const c2 = JSON.parse(JSON.stringify(clip));
    c2.id = uid('clip');
    c2.start = beat;

    if (clip.kind === 'midi') {
      clip.length = len1;
      c2.length = lenB - len1;
      c2.notes = [];
      clip.notes = clip.notes.filter(n => {
        if (n.start < len1) {
          n.length = Math.min(n.length, len1 - n.start); // truncate at the cut
          return true;
        }
        n.start -= len1;
        n.id = uid('note');
        c2.notes.push(n);
        return false;
      });
    } else {
      const rate = Math.pow(2, (clip.pitch || 0) / 12);
      const cutSec = len1 * (60 / S.bpm) * rate; // sample-domain seconds before the cut
      const off = clipOffSec(clip);
      const dur = clipDurSec(clip);
      clip.dur = cutSec;
      clip.fadeOut = 0;
      c2.offset = off + cutSec;
      c2.dur = dur - cutSec;
      c2.fadeIn = 0;
    }

    f.track.clips.push(c2);
    Timeline.render();
    this.selectClip(c2.id);
    Windows.refreshAll();
    toast(tr('toast_clip_split', 'Clip split'));
  },

  copyClip(cut) {
    if (!UI.selClipId) return false;
    const f = getClip(UI.selClipId);
    if (!f) return false;
    UI.clipboard = { type: 'clip', kind: f.track.kind, data: JSON.parse(JSON.stringify(f.clip)) };
    if (cut) {
      Undo.push('Cut clip');
      f.track.clips.splice(f.track.clips.indexOf(f.clip), 1);
      UI.selClipId = null;
      Timeline.render();
      Windows.refreshAll();
      toast(tr('toast_clip_cut', 'Clip cut'));
    } else {
      toast(tr('toast_clip_copied', 'Clip copied'));
    }
    return true;
  },

  pasteClip() {
    if (!UI.clipboard || UI.clipboard.type !== 'clip') return false;
    let track = getTrack(UI.selTrackId);
    if (!track || track.kind !== UI.clipboard.kind) {
      track = S.tracks.find(t => t.kind === UI.clipboard.kind);
    }
    if (!track) { toast(tr('toast_no_paste_track', 'No matching track to paste on'), 'red'); return true; }
    Undo.push('Paste clip');
    const c = JSON.parse(JSON.stringify(UI.clipboard.data));
    c.id = uid('clip');
    if (c.notes) for (const n of c.notes) n.id = uid('note');
    c.start = snapBeat(UI.playhead, S.snap);
    track.clips.push(c);
    Timeline.render();
    this.selectClip(c.id);
    toast(tr('toast_clip_pasted', 'Clip pasted at playhead'));
    return true;
  },

  // ---------- built-in sample loops ----------

  // Add a preset loop as an editable pattern clip. Drops onto a matching-
  // instrument track, otherwise spins up a fresh track with the right sound.
  addSampleToProject(id, beat = null, laneIdx = null) {
    const preset = SAMPLE_LIB.find(s => s.id === id);
    if (!preset) return;
    if (beat == null) beat = snapBeat(UI.playing ? Engine.currentBeat() : UI.playhead, S.snap || 1);
    Undo.push('Add loop');
    let track = (laneIdx != null) ? S.tracks[laneIdx] : null;
    if (!(track && track.kind === 'midi' && track.instrument === preset.instrument)) {
      // ensure the instrument exists as a built-in; make a track for the loop
      track = makeTrack('midi');
      track.instrument = preset.instrument;
      track.name = preset.name;
      S.tracks.push(track);
      Engine.rebuildTracks();
      KeysPanel.refreshTracks();
    }
    const clip = {
      id: uid('clip'), kind: 'midi', name: preset.name, by: authorName(),
      start: Timeline.firstFreeStart(track, preset.length, beat, null), length: preset.length,
      notes: preset.notes.map(n => ({ id: uid('note'), pitch: n.pitch, start: n.start, length: n.length, vel: n.vel }))
    };
    track.clips.push(clip);
    Timeline.render();
    Windows.refreshAll();
    this.selectClip(clip.id);
    if (UI.playing) Engine.liveEdit();
    toast(tr('samp_added', '{name} added', { name: preset.name }), 'green');
  },

  // ---------- droppable clip effects ----------

  addFxToClip(clip, type) {
    if (!FX_DEFS[type]) return;
    Undo.push('Add effect');
    clip.fx = clip.fx || [];
    const p = {};
    for (const [k, def] of Object.entries(FX_DEFS[type].p)) p[k] = def.def;
    clip.fx.push({ id: uid('fx'), type, p });
    Timeline.render();
    if (UI.playing) Engine.reschedule();
    toast(tr('fx_added', '{name} added to the clip', { name: fxName(type) }), 'green');
  },

  openFxEditor(clipId) {
    const f = getClip(clipId);
    if (!f) return;
    const old = document.getElementById('fxEditor');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'fxEditor';
    wrap.className = 'modal-back';
    document.body.appendChild(wrap);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });

    const render = () => {
      const clip = getClip(clipId) && getClip(clipId).clip;
      if (!clip) { wrap.remove(); return; }
      const list = clip.fx || [];
      wrap.innerHTML = `
        <div class="modal-card">
          <div class="modal-title">${tr('fx_editor_title', 'Effects on "{name}"', { name: clip.name || 'Clip' })}</div>
          <div id="fxRows"></div>
          <div class="modal-btns"><button id="fxClose" class="fbtn accent">${tr('close', 'Close')}</button></div>
        </div>`;
      const rows = wrap.querySelector('#fxRows');
      if (!list.length) rows.innerHTML = `<div style="color:var(--faint);font-size:12px;padding:6px 0">${tr('fx_none_on_clip', 'No effects on this clip. Drag some from the Effects window.')}</div>`;
      for (const fx of list) {
        const def = FX_DEFS[fx.type];
        if (!def) continue;
        const sec = document.createElement('div');
        sec.className = 'fx-sec';
        const head = document.createElement('div');
        head.className = 'fx-sec-head';
        head.innerHTML = `<span>${fxName(fx.type)}</span>`;
        const rm = document.createElement('button');
        rm.className = 'fbtn danger';
        rm.textContent = tr('fx_remove', 'Remove');
        rm.addEventListener('click', () => {
          Undo.push('Remove effect');
          clip.fx.splice(clip.fx.indexOf(fx), 1);
          Timeline.render();
          if (UI.playing) Engine.reschedule();
          toast(tr('fx_removed', '{name} removed', { name: fxName(fx.type) }));
          render();
        });
        head.appendChild(rm);
        sec.appendChild(head);
        for (const [k, pd] of Object.entries(def.p)) {
          const row = document.createElement('div');
          row.className = 'frow';
          const lbl = document.createElement('label');
          lbl.textContent = tr(pd.labelKey, pd.labelFb);
          const inp = document.createElement('input');
          inp.type = 'range';
          inp.min = pd.min; inp.max = pd.max; inp.step = pd.step; inp.value = fx.p[k] ?? pd.def;
          const val = document.createElement('span');
          val.className = 'val';
          const fmt = (v) => pd.max <= 1 ? Math.round(v * 100) + '%' : (k === 'freq' ? Math.round(v) + ' Hz' : (k === 'time' ? v.toFixed(2) + ' s' : Math.round(v)));
          val.textContent = fmt(parseFloat(inp.value));
          inp.addEventListener('input', () => {
            if (!inp._g) { Undo.push('Edit effect'); inp._g = true; }
            fx.p[k] = parseFloat(inp.value);
            val.textContent = fmt(fx.p[k]);
          });
          inp.addEventListener('change', () => { inp._g = false; if (UI.playing) Engine.reschedule(); });
          row.append(lbl, inp, val);
          // automation dot — keyframe this effect param over time
          if (Engine.fxAutomatable(fx.type, k)) {
            const dot = document.createElement('button');
            const has = fx.autom && fx.autom[k] && fx.autom[k].length;
            dot.className = 'auto-dot' + (has ? ' on' : '');
            dot.textContent = 'A';
            dot.dataset.tip = tr('tip_auto_dot', 'Automate this over time');
            dot.addEventListener('click', () => Automation.openFx(clip.id, fx, k));
            row.appendChild(dot);
          }
          sec.appendChild(row);
        }
        rows.appendChild(sec);
      }
      wrap.querySelector('#fxClose').addEventListener('click', () => wrap.remove());
    };
    render();
  },

  // ---------- audio file import ----------

  async importAudioFiles(files, beat, targetTrack) {
    if (typeof Sync !== 'undefined' && Sync.connected) {
      const act = Sync.audioAction();
      if (act === 'approve') { Sync.requestAudioFiles(files, { beat, trackId: targetTrack && targetTrack.id }); return; }
      if (act !== 'allow') { Sync.blockCustomAudio(); return; }
    }
    Engine.ensureCtx();
    const decoded = [];
    for (const f of files) {
      try {
        const bytes = await f.arrayBuffer();
        const buffer = await Engine.ctx.decodeAudioData(bytes.slice(0));
        decoded.push({ file: f, bytes, buffer });
      } catch (e) {
        toast(tr('toast_read_fail', 'Could not read "{name}"', { name: f.name }), 'red');
      }
    }
    if (!decoded.length) return;

    Undo.push(decoded.length > 1 ? 'Add audio files' : 'Add audio file');
    let track = targetTrack && targetTrack.kind === 'audio' ? targetTrack : null;
    if (!track) {
      track = makeTrack('audio');
      S.tracks.push(track);
      Engine.rebuildTracks();
    }
    let at = beat;
    for (const d of decoded) {
      const id = uid('smp');
      const name = d.file.name.replace(/\.[^.]+$/, '');
      Samples[id] = { id, name, buffer: d.buffer, bytes: d.bytes, mime: d.file.type || 'audio/*' };
      const clip = {
        id: uid('clip'), kind: 'audio', name, by: authorName(),
        start: at, sampleId: id, fadeIn: 0, fadeOut: 0, pitch: 0, gain: 1
      };
      clip.start = Timeline.firstFreeStart(track, clipBeats(clip), at, null);  // no overlap
      track.clips.push(clip);
      at = clip.start + clipBeats(clip);
    }
    Timeline.render();
    Windows.refreshAll();
    this.selectClip(track.clips[track.clips.length - 1].id);
    if (typeof Sync !== 'undefined') for (const d of decoded) Sync.logAction('add_audio', d.file.name);
    toast(decoded.length > 1
      ? tr('toast_sounds_added', '{n} sounds added', { n: decoded.length })
      : tr('toast_sound_added', '{name} added', { name: decoded[0].file.name }), 'green');
    setHint(tr('hint_audio_clip', 'Double-click an audio clip for gain, pitch and fades.'));
  },

  // ---------- save / load / export (.fab & .wav) ----------

  projectFileName(ext) {
    return ($('#projName').value.trim() || 'Untitled') + ext;
  },

  collectFab() {
    const data = JSON.parse(JSON.stringify(S));
    data.name = $('#projName').value;
    data.samples = {};
    const used = new Set();
    for (const t of S.tracks)
      for (const c of t.clips)
        if (c.sampleId) used.add(c.sampleId);
    for (const inst of Object.values(S.instruments || {}))
      if (inst.sampleId) used.add(inst.sampleId);   // custom instruments carry their sample
    for (const id of used) {
      const s = Samples[id];
      if (s && s.bytes) data.samples[id] = { name: s.name, mime: s.mime, data: bufToB64(s.bytes) };
    }
    return JSON.stringify(data);
  },

  async save() {
    const json = this.collectFab();
    const fname = this.projectFileName('.fab');
    if (window.electronAPI) {
      // already has a file? save straight to it, no "save as" prompt
      if (this.currentPath && window.electronAPI.writeFile) {
        const wr = await window.electronAPI.writeFile({ filePath: this.currentPath, data: json, encoding: 'utf8' });
        if (wr.ok) {
          UI.dirty = false;
          UI.fileDirty = false;
          this.addRecent(wr.path, wr.name);
          toast(tr('toast_saved', 'Saved {name}', { name: wr.name }), 'green');
          return true;
        }
        // file moved/deleted: fall through to the dialog
      }
      const res = await window.electronAPI.saveFile({
        defaultName: fname,
        filters: [{ name: 'fabu Project', extensions: ['fab'] }],
        data: json, encoding: 'utf8'
      });
      if (res.ok) {
        UI.dirty = false;
        UI.fileDirty = false;
        this.currentPath = res.path;
        $('#projName').value = res.name.replace(/\.fab$/i, '');
        this.addRecent(res.path, res.name);
        toast(tr('toast_saved', 'Saved {name}', { name: res.name }), 'green');
      }
      return !!res.ok;
    } else {
      this.browserDownload(new Blob([json], { type: 'application/json' }), fname);
      UI.dirty = false;
      UI.fileDirty = false;
      toast(tr('toast_saved', 'Saved {name}', { name: fname }), 'green');
      return true;
    }
  },

  async open() {
    if (window.electronAPI) {
      const res = await window.electronAPI.openFile({
        filters: [{ name: 'fabu Project', extensions: ['fab'] }]
      });
      if (!res.ok) return;
      await this.loadFab(b64ToBuf(res.data), res.name, res.path);
      this.hideHome();
    } else {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.fab';
      inp.onchange = async () => {
        if (inp.files[0]) { await this.loadFab(await inp.files[0].arrayBuffer(), inp.files[0].name); this.hideHome(); }
      };
      inp.click();
    }
  },

  async loadFab(arrayBuffer, fileName, filePath = null) {
    try {
      const text = new TextDecoder().decode(arrayBuffer);
      const data = JSON.parse(text);
      if (data.app !== 'fabu' && data.app !== 'FabStudio') throw new Error('not a fab file');
      Engine.ensureCtx();
      if (UI.playing || UI.recording) { Engine.stopRecord(); Engine.stop(); }

      // decode embedded samples
      for (const [id, s] of Object.entries(data.samples || {})) {
        const bytes = b64ToBuf(s.data);
        try {
          const buffer = await Engine.ctx.decodeAudioData(bytes.slice(0));
          Samples[id] = { id, name: s.name, buffer, bytes, mime: s.mime };
        } catch (e) {
          toast(tr('toast_sound_decode_fail', 'A sound could not be decoded'), 'red');
        }
      }

      const name = data.name || fileName.replace(/\.fab$/i, '');
      delete data.samples;
      delete data.name;
      S = Object.assign(freshProject(), data);
      Undo.undoStack.length = 0;
      Undo.redoStack.length = 0;
      UI.playhead = 0;
      UI.selClipId = null;
      UI.selTrackId = null;
      UI.dirty = false;
      UI.fileDirty = false;
      this.currentPath = filePath;
      $('#projName').value = name;
      if (filePath) this.addRecent(filePath, name);
      afterStateRestore();
      updateUndoButtons();
      toast(tr('toast_opened', 'Opened {name}', { name }), 'green');
    } catch (e) {
      toast(tr('toast_open_file_fail', 'Could not open that file'), 'red');
    }
  },

  export() {
    if (!S.tracks.some(t => t.clips.length)) { toast(tr('toast_nothing_export', 'Nothing to export yet'), 'red'); return; }
    this.openExportModal();
  },

  openExportModal() {
    if (document.getElementById('exportModal')) return;
    const oggOk = typeof WasmMediaEncoder !== 'undefined' && !!window.FABU_OGG_WASM; // bundled vorbis encoder
    const wrap = document.createElement('div');
    wrap.id = 'exportModal';
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('export_title', 'Export song')}</div>
        <div class="modal-sub">${tr('export_sub', 'Choose a format.')}</div>
        <div class="export-formats">
          <button class="fbtn" data-fmt="wav">WAV</button>
          <button class="fbtn" data-fmt="mp3">MP3</button>
          <button class="fbtn" data-fmt="ogg"${oggOk ? '' : ' disabled'}>OGG</button>
        </div>
        <button id="expMidi" class="fbtn" style="width:100%;margin-top:8px">${tr('export_midi', 'Export MIDI (the notes, for another program)')}</button>
        <button id="expStems" class="fbtn" style="width:100%;margin-top:8px">${tr('export_stems', 'Export stems (one file per track)')}</button>
        <div id="exportProg" class="export-prog hidden"><div id="exportBar"></div></div>
        <div id="exportStat" class="export-stat"></div>
        <div class="modal-btns"><button id="exportCancel" class="fbtn">${tr('cancel', 'Cancel')}</button></div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    // MIDI is notes, not audio, so it needs none of the rendering machinery
    const midiBtn = wrap.querySelector('#expMidi');
    if (midiBtn) midiBtn.addEventListener('click', () => { MidiFile.exportFile(); close(); });
    wrap.querySelector('#exportCancel').addEventListener('click', close);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    wrap.querySelectorAll('[data-fmt]').forEach(b => b.addEventListener('click', () => {
      if (b.disabled) return;
      this.runExport(b.dataset.fmt, wrap);
    }));
    wrap.querySelector('#expStems').addEventListener('click', () => this.runStemExport(wrap));
  },

  async runExport(fmt, wrap) {
    const prog = wrap.querySelector('#exportProg');
    const bar = wrap.querySelector('#exportBar');
    const stat = wrap.querySelector('#exportStat');
    wrap.querySelectorAll('[data-fmt]').forEach(b => b.disabled = true);
    prog.classList.remove('hidden');
    const setP = (f) => { bar.style.width = Math.round(f * 100) + '%'; };
    stat.textContent = tr('export_rendering', 'Rendering…');
    setP(0.05);
    try {
      const buffer = await Engine.renderSong();
      setP(fmt === 'wav' ? 0.5 : 0.15);
      let data, mime, ext;
      if (fmt === 'wav') {
        stat.textContent = tr('export_encoding', 'Encoding…');
        data = Engine.encodeWav(buffer); mime = 'audio/wav'; ext = 'wav'; setP(1);
      } else if (fmt === 'mp3') {
        stat.textContent = tr('export_encoding', 'Encoding…');
        data = await Engine.encodeMp3(buffer, 192, (f) => setP(0.15 + f * 0.85));
        mime = 'audio/mpeg'; ext = 'mp3';
      } else {
        stat.textContent = tr('export_encoding', 'Encoding…');
        data = await Engine.encodeOggVorbis(buffer, 0.5, (f) => setP(0.15 + f * 0.85));
        mime = 'audio/ogg'; ext = 'ogg';
      }
      const fname = this.projectFileName('.' + ext);
      if (window.electronAPI) {
        const res = await window.electronAPI.saveFile({
          defaultName: fname,
          filters: [{ name: ext.toUpperCase() + ' Audio', extensions: [ext] }],
          data: bufToB64(data), encoding: 'base64'
        });
        if (res.ok) toast(tr('toast_exported', 'Exported {name}', { name: res.name }), 'green');
      } else {
        this.browserDownload(new Blob([data], { type: mime }), fname);
        toast(tr('toast_exported', 'Exported {name}', { name: fname }), 'green');
      }
      wrap.remove();
    } catch (e) {
      stat.textContent = tr('toast_export_failed', 'Export failed');
      wrap.querySelectorAll('[data-fmt]').forEach(b => b.disabled = false);
    }
  },

  // one WAV per track, so parts can go into another tool or to a collaborator
  async runStemExport(wrap) {
    const prog = wrap.querySelector('#exportProg');
    const bar = wrap.querySelector('#exportBar');
    const stat = wrap.querySelector('#exportStat');
    const btns = wrap.querySelectorAll('[data-fmt], #expStems');
    btns.forEach(b => b.disabled = true);
    prog.classList.remove('hidden');
    stat.textContent = tr('toast_stems_working', 'Rendering stems…');
    try {
      const stems = await Engine.renderStems((f, name) => {
        bar.style.width = Math.round(f * 100) + '%';
        if (name) stat.textContent = name;
      });
      if (!stems.length) { stat.textContent = tr('toast_export_failed', 'Export failed'); btns.forEach(b => b.disabled = false); return; }
      const safe = (n, i) => String(i + 1).padStart(2, '0') + ' ' + String(n || 'Track').replace(/[\\/:*?"<>|]/g, '_');
      const base = ($('#projName').value.trim() || 'Untitled');
      let saved = 0;
      for (let i = 0; i < stems.length; i++) {
        const data = Engine.encodeWav(stems[i].buffer);
        const fname = base + ' - ' + safe(stems[i].name, i) + '.wav';
        if (window.electronAPI) {
          const res = await window.electronAPI.saveFile({
            defaultName: fname,
            filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
            data: bufToB64(data), encoding: 'base64'
          });
          if (res.ok) saved++;
        } else {
          this.browserDownload(new Blob([data], { type: 'audio/wav' }), fname);
          saved++;
        }
      }
      toast(tr('toast_stems_done', 'Exported {n} stems', { n: saved }), 'green');
      wrap.remove();
    } catch (e) {
      console.warn('stem export failed', e);
      stat.textContent = tr('toast_export_failed', 'Export failed');
      btns.forEach(b => b.disabled = false);
    }
  },

  browserDownload(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },

  // ---------- top bar wiring ----------

  wireTopbar() {
    $('#btnPlay').addEventListener('click', () => this.togglePlay());
    $('#btnStop').addEventListener('click', () => this.stop());
    $('#btnRec').addEventListener('click', () => Engine.toggleRecord());
    // metronome: click toggles, long-press (or right-click) picks the sound
    const metroBtn = $('#btnMetro');
    let metroHeld = false, metroTimer = null;
    const openMetroMenu = () => {
      metroHeld = true;
      const old = document.getElementById('metroMenu');
      if (old) old.remove();
      const m = document.createElement('div');
      m.id = 'metroMenu';
      m.className = 'ctx-menu';
      const names = {
        classic: tr('metro_classic', 'Classic beep'),
        tick: tr('metro_tick', 'Metronome tick'),
        wood: tr('metro_wood', 'Woodblock'),
        beep: tr('metro_beep', 'Soft beep')
      };
      const current = Engine.metroSound();
      for (const k of Engine.METRO_SOUNDS) {
        const b = document.createElement('button');
        b.className = 'ctx-item';
        b.textContent = (k === current ? '✓ ' : '  ') + names[k];
        b.addEventListener('click', () => {
          Engine.setMetroSound(k);
          Engine.previewClick(k);
          m.remove();
          toast(tr('metro_set', 'Metronome sound: {name}', { name: names[k] }));
        });
        m.appendChild(b);
      }
      document.body.appendChild(m);
      const r = metroBtn.getBoundingClientRect();
      m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
      m.style.top = (r.bottom + 6) + 'px';
      const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); window.removeEventListener('mousedown', close, true); } };
      setTimeout(() => window.addEventListener('mousedown', close, true), 0);
    };
    metroBtn.addEventListener('pointerdown', () => {
      metroHeld = false;
      metroTimer = setTimeout(openMetroMenu, 480);
    });
    metroBtn.addEventListener('pointerup', () => clearTimeout(metroTimer));
    metroBtn.addEventListener('pointerleave', () => clearTimeout(metroTimer));
    metroBtn.addEventListener('click', () => { if (!metroHeld) this.setMetronome(!S.metronome); });
    const loopBtn = document.getElementById('btnLoop');
    if (loopBtn) loopBtn.addEventListener('click', () => this.setLoop(!S.loopOn));
    metroBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); openMetroMenu(); });
    $('#btnUndo').addEventListener('click', () => Undo.undo());
    $('#btnRedo').addEventListener('click', () => Undo.redo());
    $('#btnSave').addEventListener('click', () => this.save());
    $('#btnOpen').addEventListener('click', () => this.open());
    $('#btnExport').addEventListener('click', () => this.export());
    $('#btnMixer').addEventListener('click', () => Windows.toggleMixer());
    $('#btnSettings').addEventListener('click', () => Windows.toggleSettings());
    $('#btnHelp').addEventListener('click', () => Windows.toggleHelp());
    $('#btnKeys').addEventListener('click', () => KeysPanel.toggle());
    $('#btnZoomIn').addEventListener('click', () => Timeline.setZoom(UI.zoom * 1.3));
    $('#btnZoomOut').addEventListener('click', () => Timeline.setZoom(UI.zoom / 1.3));
    $('#btnFx').addEventListener('click', () => Windows.toggleFxBrowser());
    $('#btnSamples').addEventListener('click', () => Windows.toggleSampleBrowser());
    $('#btnHome').addEventListener('click', () => this.goHome());
    $('#btnJam').addEventListener('click', () => Sync.togglePanel());

    $('#snapSelect').addEventListener('change', (e) => {
      S.snap = parseFloat(e.target.value);
      toast(tr('toast_snap', 'Snap: {v}', { v: snapLabel(S.snap) }));
    });

    const bpm = $('#bpmInput');
    bpm.addEventListener('change', () => this.setBpm(parseFloat(bpm.value) || 120));
    // drag the BPM number up/down to change it (no pointer lock — that never
    // worked on macOS). A full-window overlay keeps the drag going anywhere.
    let bpmStart = 120, bpmPushed = false;
    this.bindVDrag(bpm, {
      onStart: () => { bpmStart = S.bpm; bpmPushed = false; },
      onMove: (acc) => {
        const dv = Math.round(-acc / 3);
        if (dv !== 0 && !bpmPushed) { Undo.push('Change BPM'); bpmPushed = true; }
        if (bpmPushed) this.setBpm(bpmStart + dv, false);
      }
    });

    $('#projName').addEventListener('change', () => { UI.dirty = true; UI.fileDirty = true; });

    // the bar counter is where the time signature lives now
    const pos = $('#posDisplay');
    if (pos) {
      pos.style.cursor = 'pointer';
      pos.addEventListener('click', () => Timeline.openTimeSigMenu(pos));
    }

    // Settings is reachable before you open a project too, showing only the
    // things that really are app-wide.
    const homeSet = $('#homeSettings');
    if (homeSet) homeSet.addEventListener('click', () => Windows.toggleSettings());
  },

  // vertical drag on a number field, cross-platform. Overlay captures the drag
  // so the cursor can leave the field and nothing else reacts mid-drag.
  // A plain CLICK is not a drag: it falls through to the input, which focuses
  // and selects itself so you can just type a number. The old version called
  // preventDefault + blur on mousedown, which made typing impossible.
  bindVDrag(el, opts) {
    el.addEventListener('mousedown', (e) => {
      // already typing in it: leave the mouse alone (text selection etc.)
      if (document.activeElement === el) return;
      // stop the browser focusing on mousedown; a clean click focuses in `up`
      e.preventDefault();
      let lastY = e.clientY, acc = 0, dragging = false, overlay = null;
      if (opts.onStart) opts.onStart();
      const move = (ev) => {
        acc += ev.clientY - lastY; lastY = ev.clientY;
        if (!dragging && Math.abs(acc) < 4) return;   // give a click room to be a click
        if (!dragging) {
          dragging = true;
          if (el.blur) el.blur();
          overlay = document.createElement('div');
          overlay.className = 'vdrag-overlay';
          document.body.appendChild(overlay);
        }
        ev.preventDefault();
        opts.onMove(acc);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (overlay) overlay.remove();
        if (dragging && opts.onEnd) opts.onEnd();
        if (!dragging && el.select) {
          // A click means "let me type a number". Focusing alone leaves the old
          // value sitting there to be deleted by hand, so select it: the first
          // keystroke replaces it. select() works on number inputs even though
          // selectionStart does not report it.
          el.focus();
          try { el.select(); } catch (e) { /* older engines */ }
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    // Enter or clicking away commits, like every other field
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
  },


  syncWindowButtons() {
    $('#btnMixer').classList.toggle('on', Windows.isOpen('mixer'));
    $('#btnFx').classList.toggle('on', Windows.isOpen('fxbrowser'));
    $('#btnSamples').classList.toggle('on', Windows.isOpen('samples'));
    $('#btnSettings').classList.toggle('on', Windows.isOpen('settings'));
    $('#btnHelp').classList.toggle('on', Windows.isOpen('help'));
    $('#btnKeys').classList.toggle('on', KeysPanel.visible);
  },

  // ---------- keyboard: shortcuts + playing notes ----------

  heldKeys: new Map(), // code -> {trackId, pitch}

  releaseAllKeys() {
    for (const [code, h] of this.heldKeys) Engine.noteOff(h.trackId, h.pitch);
    this.heldKeys.clear();
    KeysPanel.clearHighlights();
  },

  wireKeys() {
    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      const mod = e.metaKey || e.ctrlKey;

      // Sustain pedal. Held, not toggled, so it behaves like the real thing.
      if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !mod && !e.altKey && !typing
          && KeysPanel.visible && !e.repeat) {
        Engine.setPedal(true);
        return;
      }

      // dev-only load test. This has to be checked BEFORE the mod block below:
      // that block ends in a bare return, so anything Cmd-based placed after it
      // is unreachable. On macOS Alt also rewrites e.key, so match on e.code.
      if (mod && e.altKey && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        if (typeof LoadTest === 'undefined') return;
        if (!LoadTest.enabled()) { toast(tr('lt_off', 'Developer mode is off.')); return; }
        LoadTest.spawn(1);
        return;
      }

      // --- command shortcuts ---
      if (mod) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); Undo.undo(); return; }
        if (k === 'z' && e.shiftKey) { e.preventDefault(); Undo.redo(); return; }
        if (k === 'y') { e.preventDefault(); Undo.redo(); return; }
        if (typing) return;
        if (k === 's') { e.preventDefault(); this.save(); return; }
        if (k === 'o') { e.preventDefault(); this.open(); return; }
        if (k === 'e') { e.preventDefault(); this.export(); return; }
        if (k === 'd') { e.preventDefault(); this.duplicateClip(); return; }
        if (k === 'b') { e.preventDefault(); this.splitSelectedClip(); return; }
        if (k === 'g' && !e.shiftKey) { e.preventDefault(); this.groupSelectedClips(); return; }
        if (k === 'g' && e.shiftKey) { e.preventDefault(); const g = [...UI.selClipIds].map(getClip).find(x => x && (x.clip.kind === 'group' || x.clip.bounce)); if (g) this.ungroupClip(g.clip.id); return; }
        if (k === 'c') { e.preventDefault(); if (!PianoRoll.copySelected(false)) this.copyClip(false); return; }
        if (k === 'x') { e.preventDefault(); if (!PianoRoll.copySelected(true)) this.copyClip(true); return; }
        if (k === 'v') { e.preventDefault(); if (!PianoRoll.paste()) this.pasteClip(); return; }
        if (e.key === '+' || e.key === '=') { e.preventDefault(); Timeline.setZoom(UI.zoom * 1.3); toast(tr('toast_zoom_in', 'Zoom in')); return; }
        if (e.key === '-') { e.preventDefault(); Timeline.setZoom(UI.zoom / 1.3); toast(tr('toast_zoom_out', 'Zoom out')); return; }
        return;
      }

      // Space always plays/pauses — even with a floating window, slider, checkbox
      // or menu focused — unless the user is actually typing into a text field.
      const ae = document.activeElement;
      const textField = ae && (ae.tagName === 'TEXTAREA' || ae.isContentEditable ||
        (ae.tagName === 'INPUT' && /^(text|password|email|search|url|tel|number|)$/i.test(ae.type || 'text')));
      if (e.code === 'Space' && !textField) {
        e.preventDefault();
        if (Sampler.isOpen()) { Sampler.preview(); return; } // preview the sample, not the song
        if (UI.recording) { Engine.stopRecord(); Engine.pause(); return; }
        if (ae && ae.blur && ae !== document.body) ae.blur(); // don't also toggle the focused control
        this.togglePlay();
        return;
      }

      if (typing) return;

      // --- transport & panels ---
      if (e.code === 'Enter') { e.preventDefault(); this.stop(); return; }
      if (e.code === 'F1') { e.preventDefault(); Windows.toggleHelp(); return; }
      if (e.code === 'Escape') {
        if (typeof Tutor !== 'undefined' && Tutor.active) { Tutor.finish(); return; }
        if (UI.recording) { Engine.stopRecord(); Engine.pause(); return; } // cancel a count-in / recording
        if (KeysPanel.visible) { KeysPanel.toggle(); return; }
        this.selectClip(null);
        return;
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        e.preventDefault();
        if (!PianoRoll.deleteSelected()) this.deleteSelectedClip();
        return;
      }

      // --- playing notes (only while the keyboard panel is open) ---
      if (KeysPanel.visible && !e.repeat) {
        const deg = WHITE_CODES[e.code] ?? BLACK_CODES[e.code];
        if (deg !== undefined) {
          e.preventDefault();
          const t = KeysPanel.targetTrack();
          if (!t) { toast(tr('toast_add_instr_first', 'Add an instrument track first'), 'red'); return; }
          const pitch = (UI.keysOctave + 1) * 12 + deg;
          Engine.noteOn(t.id, pitch);
          this.heldKeys.set(e.code, { trackId: t.id, pitch });
          KeysPanel.highlight(e.code, true);
          return;
        }
        if (e.code === 'KeyZ') { KeysPanel.setOctave(UI.keysOctave - 1); return; }
        if (e.code === 'KeyX') { KeysPanel.setOctave(UI.keysOctave + 1); return; }
      }

      // --- single letter shortcuts (disabled while playing keys) ---
      if (e.repeat) return;
      if (e.code === 'KeyM') { this.setMetronome(!S.metronome); return; }
      if (e.code === 'KeyL') { this.setLoop(!S.loopOn); return; }
      if (e.code === 'KeyR') {
        if (KeysPanel.visible) Engine.toggleMidiRecord();
        else Engine.toggleRecord();
        return;
      }
      if (!KeysPanel.visible) {
        if (e.code === 'KeyK') { KeysPanel.toggle(); return; }
        if (e.code === 'KeyX') { Windows.toggleMixer(); return; }
      }
    });

    window.addEventListener('keyup', (e) => {
      // let the pedal up on release no matter what else was going on, so it can
      // never get stuck down after a shortcut or a lost focus
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') Engine.setPedal(false);
      const h = this.heldKeys.get(e.code);
      if (h) {
        Engine.noteOff(h.trackId, h.pitch);
        this.heldKeys.delete(e.code);
        KeysPanel.highlight(e.code, false);
      }
    });
    // focus lost mid-press (alt-tab) would otherwise leave the pedal held
    window.addEventListener('blur', () => Engine.setPedal(false));
  }
};

// ---------- On-screen keyboard panel ----------

const KeysPanel = {
  visible: false,

  // reflect the pedal wherever it came from: Shift, the button, or hardware
  showPedal(down) {
    const b = document.getElementById('keysPedal');
    if (b) b.classList.toggle('on', !!down);
  },

  init() {
    // controls steal keyboard focus, which then swallows the note keys until you
    // click back into the app; blur them so playing keeps working right away.
    const blurSoon = (el) => setTimeout(() => { if (el && el.blur) el.blur(); }, 0);
    $('#octDown').addEventListener('click', (e) => { this.setOctave(UI.keysOctave - 1); blurSoon(e.currentTarget); });
    $('#octUp').addEventListener('click', (e) => { this.setOctave(UI.keysOctave + 1); blurSoon(e.currentTarget); });
    $('#keysTrackSel').addEventListener('change', (e) => { UI.keysTrackId = e.target.value; blurSoon(e.target); });
    $('#keysRecBtn').addEventListener('click', (e) => { Engine.toggleMidiRecord(); blurSoon(e.currentTarget); });
    // the pedal: click to latch, or hold Shift, or use a real one over MIDI
    const ped = $('#keysPedal');
    if (ped) ped.addEventListener('click', (e) => { Engine.setPedal(!Engine.pedalDown); blurSoon(e.currentTarget); });

    // a close button (X) on the keyboard panel
    const close = document.createElement('button');
    close.id = 'keysClose';
    close.className = 'keys-close';
    close.setAttribute('aria-label', 'close');
    close.dataset.tip = tr('tip_keys_close', 'Close the keyboard (K)');
    close.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    close.addEventListener('click', () => this.toggle());
    $('#keysPanel').appendChild(close);

    this.refreshTracks();
  },

  toggle() {
    this.visible = !this.visible;
    $('#keysPanel').classList.toggle('hidden', !this.visible);
    if (this.visible) { this.refreshTracks(); this.build(); this.syncRecButton(); }
    else App.releaseAllKeys();
    App.syncWindowButtons();
    toast(this.visible ? tr('toast_keyboard_on', 'Keyboard on') : tr('toast_keyboard_off', 'Keyboard off'));
  },

  syncRecButton() {
    const btn = $('#keysRecBtn');
    if (!btn) return;
    const on = !!Engine.midiRec;
    btn.classList.toggle('on', on);
    btn.textContent = on ? (t('stop') || 'Stop') : (t('record_notes') || 'Record notes');
  },

  targetTrack() {
    const t = getTrack(UI.keysTrackId);
    if (t && t.kind === 'midi') return t;
    return S.tracks.find(t => t.kind === 'midi') || null;
  },

  refreshTracks() {
    const sel = $('#keysTrackSel');
    sel.innerHTML = '';
    for (const t of S.tracks.filter(t => t.kind === 'midi')) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.name + ' (' + instrLabel(t.instrument) + ')';
      sel.appendChild(o);
    }
    const cur = this.targetTrack();
    if (cur) { sel.value = cur.id; UI.keysTrackId = cur.id; }
  },

  setOctave(o) {
    UI.keysOctave = clamp(o, 1, 7);
    $('#octLabel').textContent = UI.keysOctave;
    if (this.visible) this.build();
    toast(tr('toast_octave', 'Octave {n}', { n: UI.keysOctave }));
  },

  // build 1.5 visual octaves matching the computer-key mapping
  build() {
    const box = $('#pianoKeys');
    box.innerHTML = '';
    const whiteDegs = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17];
    const whiteLabels = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'Ö', 'Ä'];
    const blackInfo = [ // degree, after which white index, QWERTZ label
      [1, 0, 'W'], [3, 1, 'E'], [6, 3, 'T'], [8, 4, 'Z'], [10, 5, 'U'], [13, 7, 'O'], [15, 8, 'P']
    ];
    const base = (UI.keysOctave + 1) * 12;

    whiteDegs.forEach((deg, i) => {
      const k = document.createElement('div');
      k.className = 'pkey';
      k.dataset.pitch = base + deg;
      k.dataset.code = Object.keys(WHITE_CODES)[i];
      k.innerHTML = `<span class="klabel">${whiteLabels[i]}</span>`;
      k.dataset.tip = noteName(base + deg);
      this.bindKey(k);
      box.appendChild(k);
    });
    for (const [deg, afterWhite, label] of blackInfo) {
      const k = document.createElement('div');
      k.className = 'pkey-black';
      k.style.left = ((afterWhite + 1) * 34 - 11) + 'px';
      k.dataset.pitch = base + deg;
      k.dataset.code = Object.keys(BLACK_CODES)[blackInfo.findIndex(b => b[0] === deg)];
      k.innerHTML = `<span class="klabel">${label}</span>`;
      k.dataset.tip = noteName(base + deg);
      this.bindKey(k);
      box.appendChild(k);
    }
  },

  bindKey(el) {
    let heldPitch = null;
    let heldTrack = null;
    const on = (e) => {
      e.preventDefault();
      const t = this.targetTrack();
      if (!t) return;
      heldPitch = parseInt(el.dataset.pitch);
      heldTrack = t.id;
      Engine.noteOn(heldTrack, heldPitch);
      el.classList.add('down');
    };
    const off = () => {
      if (heldPitch !== null) {
        Engine.noteOff(heldTrack, heldPitch);
        heldPitch = null;
        el.classList.remove('down');
      }
    };
    el.addEventListener('mousedown', on);
    el.addEventListener('mouseup', off);
    el.addEventListener('mouseleave', off);
  },

  highlight(code, down) {
    const el = $(`#pianoKeys [data-code="${code}"]`);
    if (el) el.classList.toggle('down', down);
  },

  clearHighlights() {
    for (const el of $$('#pianoKeys .down')) el.classList.remove('down');
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
