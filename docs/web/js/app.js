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
    this.checkAutosave();
    this.startAutosave();
    this.loadLibrary();
    Auth.init();
    Sync.initCursors();
    // closing the app asks about unsaved changes
    if (window.electronAPI && window.electronAPI.onConfirmClose) {
      window.electronAPI.onConfirmClose(() => {
        if (!UI.dirty) { window.electronAPI.confirmClose(); return; }
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
    }
  },

  showUpdateBanner(version) {
    if (document.getElementById('updateBanner')) return;
    const b = document.createElement('div');
    b.id = 'updateBanner';
    b.innerHTML = `<span>${tr('update_available', 'Update available')}${version ? ' · v' + version : ''}</span>
      <button class="fbtn accent" id="updNow">${tr('update_now', 'Update')}</button>
      <button class="upd-x" id="updLater"><svg class="ic"><use href="#i-x"/></svg></button>`;
    document.body.appendChild(b);
    const btn = b.querySelector('#updNow');
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '0%';
      window.electronAPI.installUpdate();
    });
    b.querySelector('#updLater').addEventListener('click', () => b.remove());
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
      else { UI.dirty = false; this.checkAutosave(); this.showHome(); }
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
    if (UI.dirty) { this.confirmExit('home'); return; }
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
    for (const t of S.tracks) if (t.instrument === id) t.instrument = 'keys';
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
    S = freshProject();
    const drums = makeTrack('midi'); drums.name = 'Drums'; drums.instrument = 'drums';
    const keys = makeTrack('midi'); keys.name = 'Keys'; keys.instrument = 'keys';
    const audio = makeTrack('audio');
    S.tracks.push(drums, keys, audio);
    Undo.undoStack.length = 0;
    Undo.redoStack.length = 0;
    UI.playhead = 0;
    UI.selClipId = null;
    UI.selTrackId = null;
    UI.dirty = false;
    this.currentPath = null;
    $('#projName').value = 'Untitled';
    if (Engine.ctx) { Engine.rebuildTracks(); Engine.updateAllTracks(); }
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    updateUndoButtons();
    if (announce) toast(tr('toast_new_project', 'New project'));
  },

  // ---------- homescreen ----------

  wireHome() {
    $('#homeNew').addEventListener('click', () => { this.newProject(false); this.hideHome(); });
    $('#homeOpen').addEventListener('click', () => this.open());
    $('#homeContinue').addEventListener('click', () => this.continueSession());
    $('#homeMp').addEventListener('click', () => MP.openMenu());
    $('#logo').addEventListener('click', () => this.goHome());
  },

  showHome() {
    this.renderRecents();
    const home = $('#home');
    home.classList.remove('closing');
    home.style.display = 'flex';
  },

  hideHome() {
    const home = $('#home');
    if (home.style.display === 'none') return;
    home.classList.add('closing');
    setTimeout(() => { home.style.display = 'none'; home.classList.remove('closing'); }, 220);
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
        </div>
        <div class="home-card-name">${r.name || 'Untitled'}</div>
        <div class="home-card-sub">${this.agoText(r.at)}</div>`;
      card.addEventListener('click', () => this.openRecent(r.path));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.removeRecent(r.path);
        toast(tr('removed_recent', 'Removed from recents'));
      });
      box.appendChild(card);
    });
  },

  async openRecent(path) {
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

  selectClip(id) {
    UI.selClipId = id;
    for (const el of $$('.clip')) el.classList.toggle('sel', el.dataset.clipId === id);
    if (id) {
      const f = getClip(id);
      if (f) this.selectTrack(f.track.id);
      const w = Windows.wins.get('inspector');
      if (w) w.refresh();
      setHint(tr('hint_clip_selected', 'Drag to move, double-click to edit, right-click to delete, Cmd D to duplicate.'));
    } else {
      const w = Windows.wins.get('inspector');
      if (w) w.refresh();
    }
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
    toast(tr('toast_track_added', '{name} added', { name: t.name }));
  },

  deleteTrack(id) {
    const t = getTrack(id);
    if (!t) return;
    Undo.push('Delete track');
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
    if (!UI.selClipId) return;
    const f = getClip(UI.selClipId);
    if (!f) return;
    Undo.push('Delete clip');
    f.track.clips.splice(f.track.clips.indexOf(f.clip), 1);
    UI.selClipId = null;
    if (PianoRoll.clipId === f.clip.id) PianoRoll.close();
    Timeline.render();
    Windows.refreshAll();
    toast(tr('toast_clip_deleted', 'Clip deleted'));
  },

  duplicateClip() {
    if (!UI.selClipId) return;
    const f = getClip(UI.selClipId);
    if (!f) return;
    Undo.push('Duplicate clip');
    const c = JSON.parse(JSON.stringify(f.clip));
    c.id = uid('clip');
    if (c.notes) for (const n of c.notes) n.id = uid('note');
    c.start = f.clip.start + clipBeats(f.clip);
    f.track.clips.push(c);
    Timeline.render();
    this.selectClip(c.id);
    toast(tr('toast_clip_duplicated', 'Clip duplicated'));
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

  // ---------- audio file import ----------

  async importAudioFiles(files, beat, targetTrack) {
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
      track.clips.push(clip);
      at += clipBeats(clip);
    }
    Timeline.render();
    Windows.refreshAll();
    this.selectClip(track.clips[track.clips.length - 1].id);
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
      const res = await window.electronAPI.saveFile({
        defaultName: fname,
        filters: [{ name: 'fabu Project', extensions: ['fab'] }],
        data: json, encoding: 'utf8'
      });
      if (res.ok) {
        UI.dirty = false;
        this.currentPath = res.path;
        $('#projName').value = res.name.replace(/\.fab$/i, '');
        this.addRecent(res.path, res.name);
        toast(tr('toast_saved', 'Saved {name}', { name: res.name }), 'green');
      }
      return !!res.ok;
    } else {
      this.browserDownload(new Blob([json], { type: 'application/json' }), fname);
      UI.dirty = false;
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
        <div id="exportProg" class="export-prog hidden"><div id="exportBar"></div></div>
        <div id="exportStat" class="export-stat"></div>
        <div class="modal-btns"><button id="exportCancel" class="fbtn">${tr('cancel', 'Cancel')}</button></div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('#exportCancel').addEventListener('click', close);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    wrap.querySelectorAll('[data-fmt]').forEach(b => b.addEventListener('click', () => {
      if (b.disabled) return;
      this.runExport(b.dataset.fmt, wrap);
    }));
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
    $('#btnMetro').addEventListener('click', () => this.setMetronome(!S.metronome));
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
    $('#btnAddMidi').addEventListener('click', () => this.addTrack('midi'));
    $('#btnAddAudio').addEventListener('click', () => this.addTrack('audio'));
    $('#btnHome').addEventListener('click', () => this.goHome());
    $('#btnJam').addEventListener('click', () => Sync.togglePanel());

    $('#snapSelect').addEventListener('change', (e) => {
      S.snap = parseFloat(e.target.value);
      toast(tr('toast_snap', 'Snap: {v}', { v: snapLabel(S.snap) }));
    });

    const bpm = $('#bpmInput');
    bpm.addEventListener('change', () => this.setBpm(parseFloat(bpm.value) || 120));
    // drag the BPM number up/down
    bpm.addEventListener('mousedown', (e) => {
      const startY = e.clientY;
      const startV = S.bpm;
      let pushed = false;
      const move = (ev) => {
        const dv = Math.round((startY - ev.clientY) / 3);
        if (dv !== 0 && !pushed) { Undo.push('Change BPM'); pushed = true; }
        if (pushed) this.setBpm(startV + dv, false);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    $('#projName').addEventListener('change', () => { UI.dirty = true; });
  },

  syncWindowButtons() {
    $('#btnMixer').classList.toggle('on', Windows.isOpen('mixer'));
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
      const h = this.heldKeys.get(e.code);
      if (h) {
        Engine.noteOff(h.trackId, h.pitch);
        this.heldKeys.delete(e.code);
        KeysPanel.highlight(e.code, false);
      }
    });
  }
};

// ---------- On-screen keyboard panel ----------

const KeysPanel = {
  visible: false,

  init() {
    $('#octDown').addEventListener('click', () => this.setOctave(UI.keysOctave - 1));
    $('#octUp').addEventListener('click', () => this.setOctave(UI.keysOctave + 1));
    $('#keysTrackSel').addEventListener('change', (e) => { UI.keysTrackId = e.target.value; });
    $('#keysRecBtn').addEventListener('click', () => Engine.toggleMidiRecord());
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
