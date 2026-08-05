// ---------- Piano roll: the MIDI note editor (floating window) ----------
'use strict';

function isDrumInstrSafe(i){ try { return isDrumInstr(i); } catch (e) { return false; } }

const PianoRoll = {
  clipId: null,
  selNoteId: null,        // primary
  selNoteIds: new Set(),  // full selection
  topPitch: 84,       // highest visible pitch
  rowH: 14,
  pxb: 96,            // pixels per beat
  snap: 0.25,
  lastLen: 1,
  keysCv: null,
  gridCv: null,
  wrap: null,

  KEYS_W: 52,
  GRID_H: 336,
  VEL_H: 58,          // velocity lane height
  RULER_H: 23,        // seek ruler height, including the pedal strip below it
  DRUM_ROW_H: 24,     // taller rows in drum-lane mode
  _rowMap: null,      // drum mode: pitches top->bottom (null = chromatic)
  _rowMeta: null,     // drum mode: [{pitch,label}]
  _rh: 14,            // active row height (rowH chromatic, DRUM_ROW_H drums)
  velCv: null,
  rulerCv: null,
  inner: null,
  playEl: null,
  _viewBeats: 0,      // grows as you scroll past the pattern end

  // key helper (session preference, remembered across projects)
  keyRoot: 0,         // 0..11 (C..B)
  keyScale: 'major',
  scaleOn: false,     // tint in-key rows
  snapScale: false,   // pull drawn notes onto the key
  chordMode: false,   // click drops a diatonic chord

  loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem('fabu.prollKey') || '{}');
      if (typeof p.root === 'number') this.keyRoot = p.root;
      if (p.scale && SCALES[p.scale]) this.keyScale = p.scale;
      this.scaleOn = !!p.scaleOn; this.snapScale = !!p.snapScale; this.chordMode = !!p.chordMode;
    } catch (e) {}
  },
  savePrefs() {
    try {
      localStorage.setItem('fabu.prollKey', JSON.stringify({
        root: this.keyRoot, scale: this.keyScale, scaleOn: this.scaleOn, snapScale: this.snapScale, chordMode: this.chordMode
      }));
    } catch (e) {}
  },

  isOpen() { return Windows.isOpen('proll'); },

  clip() {
    if (!this.clipId) return null;
    const f = getClip(this.clipId);
    return f ? f : null;
  },

  // Where the keyboard should sit when the roll opens. Landing on C4-C6 for a
  // bass meant the 808 only ever got played in the register it sounds worst in.
  INSTR_CENTER: { sub: 33, bass: 40, rharp: 60, rvibes: 72, rglock: 88, bell: 76, pluck: 64 },
  defaultTopPitch(track, clip) {
    const rows = Math.max(6, Math.floor(this.gridH() / this.rowH));
    let center;
    if (clip.notes && clip.notes.length) {
      const ps = clip.notes.map(n => n.pitch);
      center = Math.round((Math.max(...ps) + Math.min(...ps)) / 2);
    } else {
      center = this.INSTR_CENTER[track.instrument];
      if (center == null) center = 60;
    }
    return clamp(center + Math.floor(rows / 2), 24 + rows, 120);
  },

  open(clipId) {
    this.clipId = clipId;
    this.selNoteId = null;
    this.selNoteIds = new Set();
    this._viewBeats = 0;
    const f = this.clip();
    if (!f) return;

    if (!isDrumInstrSafe(f.track.instrument)) this.topPitch = this.defaultTopPitch(f.track, f.clip);
    const w = Windows.create('proll', tr('win_pianoroll', 'Piano roll: {name}', { name: f.clip.name || 'Pattern' }), 'i-note',
      { x: Math.max(20, window.innerWidth / 2 - 420), y: 120, width: 860, height: Math.min(560, Math.max(380, window.innerHeight - 180)) });
    w.body.classList.add('proll-body');

    this.loadPrefs();

    const drumTrack = isDrumInstr(f.track.instrument);
    const tools = document.createElement('div');
    tools.className = 'proll-tools';
    const rootOpts = NOTE_NAMES.map((nm, i) => `<option value="${i}"${i === this.keyRoot ? ' selected' : ''}>${nm}</option>`).join('');
    const scaleOpts = Object.keys(SCALES).map(id => `<option value="${id}"${id === this.keyScale ? ' selected' : ''}>${scaleName(id)}</option>`).join('');
    // the key/scale/chord helper is meaningless on drum lanes, so hide it there
    const keyGroup = drumTrack ? '' : `
      <div class="pt-group pt-key">
        <label>${tr('proll_key', 'KEY')}</label>
        <select id="pkRoot" data-tip="${tr('tip_key_root', 'Song key')}">${rootOpts}</select>
        <select id="pkScale" data-tip="${tr('tip_key_scale', 'Scale')}">${scaleOpts}</select>
        <button id="pkScaleOn" class="pt-toggle" data-tip="${tr('tip_scale_show', 'Shade the notes that fit the key')}">${tr('proll_highlight', 'Highlight')}</button>
        <button id="pkSnapScale" class="pt-toggle" data-tip="${tr('tip_scale_snap', 'Pull drawn notes onto the key')}">${tr('proll_tokey', 'To key')}</button>
        <button id="pkChord" class="pt-toggle" data-tip="${tr('tip_chord', 'Click drops a full chord in the key')}">${tr('proll_chord', 'Chord')}</button>
      </div>` + `
      <div id="pkSuggest" class="chord-sug hidden" data-tip="${tr('tip_chord_sug', 'The chord that usually comes next. Tab to add it.')}">
        <span class="cs-next">${tr('chord_next', 'Next')}</span>
        <span class="cs-name"></span>
        <kbd class="cs-key">Tab</kbd><span class="cs-lbl">${tr('chord_add', 'add')}</span>
        <span class="cs-alt"><kbd class="cs-key">Shift Tab</kbd><span class="cs-lbl">${tr('chord_other', 'other')}</span></span>
      </div>
`;
    tools.innerHTML = `
      <span class="pt-track" style="color:${f.track.color}">${f.track.name}</span>
      ${keyGroup}
      <span class="pt-spacer"></span>
      <div class="pt-group">
        <svg class="ic dim" style="width:13px;height:13px"><use href="#i-magnet"/></svg>
        <select id="prollSnap" data-tip="${tr('tip_proll_snap', 'Note snap grid')}">
          <option value="1">${tr('snap_beat', 'Beat')}</option>
          <option value="0.5">1/8</option>
          <option value="0.25" selected>1/16</option>
          <option value="0.125">1/32</option>
          <option value="0">${tr('snap_off', 'Off')}</option>
        </select>
        <div class="pt-quant" data-tip="${tr('tip_quantize', 'Line notes up to the grid')}">
          <span class="pt-qlabel">${tr('proll_quantize', 'Quantize')}</span>
          <button id="pkQuantSel" class="pt-seg">${tr('proll_q_sel', 'Selected')}</button>
          <button id="pkQuantAll" class="pt-seg">${tr('proll_q_all', 'All')}</button>
        </div>
        <div class="pt-quant" data-tip="${tr('tip_humanize', 'Nudge timing and loudness slightly, so it sounds played rather than programmed')}">
          <span class="pt-qlabel">${tr('proll_humanize', 'Humanize')}</span>
          <button id="pkHumanSel" class="pt-seg">${tr('proll_q_sel', 'Selected')}</button>
          <button id="pkHumanAll" class="pt-seg">${tr('proll_q_all', 'All')}</button>
        </div>
      </div>`;
    w.body.appendChild(tools);

    const q = (sel) => tools.querySelector(sel);
    q('#prollSnap').value = String(this.snap);
    q('#prollSnap').addEventListener('change', (e) => {
      this.snap = parseFloat(e.target.value);
      toast(tr('toast_proll_snap', 'Piano roll snap: {v}', { v: this.snap ? snapLabel(this.snap) : tr('word_off', 'off') }));
    });
    if (!drumTrack) {
      q('#pkRoot').addEventListener('change', (e) => { this.keyRoot = parseInt(e.target.value, 10); this.savePrefs(); this.redraw(); });
      q('#pkScale').addEventListener('change', (e) => { this.keyScale = e.target.value; this.savePrefs(); this.redraw(); });
      const wireToggle = (sel, prop) => {
        const b = q(sel);
        b.classList.toggle('on', this[prop]);
        b.addEventListener('click', () => { this[prop] = !this[prop]; b.classList.toggle('on', this[prop]); this.savePrefs(); this.redraw(); });
      };
      wireToggle('#pkScaleOn', 'scaleOn');
      wireToggle('#pkSnapScale', 'snapScale');
      wireToggle('#pkChord', 'chordMode');
    this._sugEl = q('#pkSuggest');
    if (this._sugEl) {
      this._sugEl.addEventListener('click', () => this.acceptSuggestion());
      this._sugEl.addEventListener('contextmenu', (e) => { e.preventDefault(); this.cycleSuggestion(); });
    }
    }
    q('#pkQuantSel').addEventListener('click', () => this.quantize('sel'));
    q('#pkQuantAll').addEventListener('click', () => this.quantize('all'));
    q('#pkHumanSel').addEventListener('click', () => this.humanize('sel'));
    q('#pkHumanAll').addEventListener('click', () => this.humanize('all'));

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start';
    const leftCol = document.createElement('div');
    leftCol.style.cssText = 'display:flex;flex-direction:column;flex-shrink:0';
    const rulerSpacer = document.createElement('div');
    rulerSpacer.className = 'pt-ruler-spacer';
    rulerSpacer.style.height = this.RULER_H + 'px';
    this.keysCv = document.createElement('canvas');
    this.keysCv.className = 'proll-keys';
    const velLabel = document.createElement('div');
    velLabel.className = 'pt-vel-label';
    velLabel.style.height = this.VEL_H + 'px';
    velLabel.textContent = tr('proll_vel', 'VEL');
    leftCol.append(rulerSpacer, this.keysCv, velLabel);

    this.wrap = document.createElement('div');
    this.wrap.style.cssText = 'overflow-x:auto;overflow-y:hidden;flex:1;min-width:0';
    this.inner = document.createElement('div');
    this.inner.style.cssText = 'position:relative';
    this.rulerCv = document.createElement('canvas');
    this.rulerCv.className = 'proll-ruler';
    this.gridCv = document.createElement('canvas');
    this.gridCv.className = 'proll-grid';
    this.gridCv.style.cursor = 'crosshair';
    this.velCv = document.createElement('canvas');
    this.velCv.className = 'proll-vel';
    this.playEl = document.createElement('div');
    this.playEl.className = 'proll-playhead';
    this.inner.append(this.rulerCv, this.gridCv, this.velCv, this.playEl);
    this.wrap.append(this.inner);
    // scrolling toward the right edge reveals more empty bars to write into
    this.wrap.addEventListener('scroll', () => {
      const w = this.wrap;
      if (w.scrollLeft + w.clientWidth > this.gridWidth() - 160) {
        this._viewBeats = Math.ceil((this.gridWidth() / this.pxb) + 8);
      }
      this.scheduleRedraw();   // repaint the on-screen window as it moves
    });
    row.append(leftCol, this.wrap);
    w.body.appendChild(row);

    w.refresh = () => this.redraw();

    this.bindGrid();
    this.bindKeys();
    this.bindVel();
    this.bindRuler();
    this.redraw();
    this.syncPlayhead();
    App.syncWindowButtons();
  },

  close() { Windows.close('proll'); this.clipId = null; },

  onStateRestore() {
    if (!this.isOpen()) return;
    const f = this.clip();
    if (!f) { this.close(); return; }
    const live = new Set(f.clip.notes.map(n => n.id));
    for (const id of [...this.selNoteIds]) if (!live.has(id)) this.selNoteIds.delete(id);
    if (this.selNoteId && !live.has(this.selNoteId)) this.selNoteId = [...this.selNoteIds].pop() || null;
    this.redraw();
  },

  // ---------- geometry ----------

  gridWidth() {
    const f = this.clip();
    const len = f ? f.clip.length : 4;
    // always keep a couple of empty bars past the end so you can scroll further
    // and write there; _viewBeats grows as you scroll toward the edge. This is
    // only a div width now (the canvases window themselves), so the cap is
    // just a sanity bound, not a browser canvas limit.
    const beats = Math.min(16384, Math.max(len + 8, this._viewBeats || 0));
    return Math.max(384, beats * this.pxb);
  },
  // drum tracks use a fixed set of labeled lanes; melodic tracks are chromatic
  setupRows() {
    const f = this.clip();
    if (f && isDrumInstr(f.track.instrument)) {
      this._rowMeta = drumRowsFor(f.track.instrument);
      this._rowMap = this._rowMeta.map(r => r.pitch);
      this._rh = this.DRUM_ROW_H;
    } else {
      this._rowMeta = null; this._rowMap = null; this._rh = this.rowH;
    }
  },
  gridH() {
    if (this._rowMap) return this._rowMap.length * this._rh;   // drum lanes: fixed set of rows
    // fill the window: grow the grid to the body height so resizing shows more keys
    const body = this.wrap ? this.wrap.closest('.fwin-body') : null;
    if (body && body.clientHeight) {
      const tools = body.querySelector('.proll-tools');
      const avail = body.clientHeight - (tools ? tools.offsetHeight : 0) - this.RULER_H - this.VEL_H - 28;
      return clamp(Math.floor(avail), 168, 4000);
    }
    return this.GRID_H;
  },
  // coalesce redraws to one per frame (scroll fires many events)
  scheduleRedraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.redraw(); });
  },
  yToPitch(y) {
    if (this._rowMap) return this._rowMap[clamp(Math.floor(y / this._rh), 0, this._rowMap.length - 1)];
    return this.topPitch - Math.floor(y / this.rowH);
  },
  pitchToY(p) {
    if (this._rowMap) {
      const i = this._rowMap.findIndex(rp => rp % 12 === ((p % 12) + 12) % 12);
      return i < 0 ? -9999 : i * this._rh;
    }
    return (this.topPitch - p) * this.rowH;
  },
  xToBeat(x) { return x / this.pxb; },

  noteAt(x, y) {
    const f = this.clip();
    if (!f) return null;
    const pitch = this.yToPitch(y);
    const beat = this.xToBeat(x);
    const drum = !!this._rowMap;
    // topmost drawn last wins
    for (let i = f.clip.notes.length - 1; i >= 0; i--) {
      const n = f.clip.notes[i];
      const hit = drum ? (n.pitch % 12 === pitch % 12) : (n.pitch === pitch);
      if (hit && beat >= n.start && beat <= n.start + n.length) return n;
    }
    return null;
  },

  // ---------- drawing ----------

  // Resize a canvas only when its size actually changes. Reallocating the
  // (potentially huge) backing store every frame was what made scrolling a long
  // pattern lag. setTransform is idempotent whether or not we reallocated.
  sizeCanvas(cv, w, h, dpr) {
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (cv.width !== cw || cv.height !== ch) {
      cv.width = cw; cv.height = ch;
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  },

  // Allocate only the slice of a wide canvas that can actually be seen.
  // A canvas as wide as the clip dies past the browser limit (65,535 device
  // px, which a long song crosses easily: this is what broke Bohemian
  // Rhapsody) and lags long before that from sheer backing-store size. The
  // window is quantized to 256px so scrolling reuses the allocation instead
  // of reallocating every frame, and the context is translated so all
  // drawing keeps using absolute content coordinates.
  windowCanvas(cv, W, H, dpr) {
    const sc = this.wrap;
    const vw = sc ? sc.clientWidth : W;
    const scL = sc ? sc.scrollLeft : 0;
    const x0 = Math.max(0, scL - vw), x1 = Math.min(W, scL + vw * 2);
    const qx0 = Math.floor(x0 / 256) * 256;
    const qx1 = Math.min(W, Math.ceil(x1 / 256) * 256);
    const cw = Math.max(384, qx1 - qx0);
    const dw = Math.round(cw * dpr), dh = Math.round(H * dpr);
    if (cv.width !== dw || cv.height !== dh) {
      cv.width = dw; cv.height = dh;
      cv.style.width = cw + 'px'; cv.style.height = H + 'px';
    }
    if (cv._mL !== qx0) { cv._mL = qx0; cv.style.marginLeft = qx0 + 'px'; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, -qx0 * dpr, 0);
    this._winX0 = qx0;
    return ctx;
  },

  // content-space x for an event on a windowed canvas (its rect starts at the
  // window's margin, not at content 0)
  evX(e, rect) { return e.clientX - rect.left + (this._winX0 || 0); },

  redraw() {
    const f = this.clip();
    if (!f || !this.gridCv) return;
    this.setupRows();
    const dpr = window.devicePixelRatio || 1;
    const W = this.gridWidth();
    const rh = this._rh;
    const H = this.gridH();
    const isDrums = !!this._rowMap;

    // --- keys column ---
    const kc = this.keysCv;
    const kx = this.sizeCanvas(kc, this.KEYS_W, H, dpr);
    kx.clearRect(0, 0, this.KEYS_W, H);
    kx.font = '600 9px -apple-system, sans-serif';
    if (isDrums) {
      for (let i = 0; i < this._rowMeta.length; i++) {
        const y = i * rh;
        kx.fillStyle = i % 2 ? '#20242f' : '#262b38';
        kx.fillRect(0, y, this.KEYS_W, rh - 0.5);
        kx.fillStyle = '#c7ccdb';
        kx.fillText(this._rowMeta[i].label, 4, y + rh / 2 + 3);
      }
    } else {
      const rows = Math.floor(H / rh);
      const bottomPitch = this.topPitch - rows + 1;
      for (let p = this.topPitch; p >= bottomPitch; p--) {
        const y = this.pitchToY(p);
        const black = [1, 3, 6, 8, 10].includes(p % 12);
        kx.fillStyle = black ? '#232839' : '#e9ebf4';
        kx.fillRect(0, y, this.KEYS_W, rh - 0.5);
        kx.fillStyle = black ? '#69708c' : '#3a3f55';
        if (p % 12 === 0) kx.fillText(noteName(p), 4, y + 10);
      }
    }

    // --- grid ---
    // Only paint the horizontal window that's actually on screen (plus a margin).
    // A long pattern's grid can be many thousands of px wide; painting all of it
    // every frame is what made up/down scrolling lag. The canvas keeps a matching
    // CSS background so the unpainted parts look identical.
    const gc = this.gridCv;
    gc.style.background = '#161927';
    const sc = this.wrap;
    const vw = sc ? sc.clientWidth : W;
    const scL = sc ? sc.scrollLeft : 0;
    const x0 = Math.max(0, scL - vw);
    const x1 = Math.min(W, scL + vw * 2);
    const ww = Math.max(0, x1 - x0);
    const g = this.windowCanvas(gc, W, H, dpr);
    g.fillStyle = '#161927';
    g.fillRect(x0, 0, ww, H);
    if (isDrums) {
      for (let i = 0; i < this._rowMeta.length; i++) {
        const y = i * rh;
        if (i % 2) { g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(x0, y, ww, rh); }
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(x0, y + rh - 1, ww, 1);   // row separator
      }
    } else {
      const rows = Math.floor(H / rh);
      const bottomPitch = this.topPitch - rows + 1;
      const showScale = this.scaleOn;
      for (let p = this.topPitch; p >= bottomPitch; p--) {
        const y = this.pitchToY(p);
        if ([1, 3, 6, 8, 10].includes(p % 12)) {
          g.fillStyle = 'rgba(0,0,0,0.22)';
          g.fillRect(x0, y, ww, rh);
        }
        if (showScale) {
          if (((p - this.keyRoot) % 12 + 12) % 12 === 0) { g.fillStyle = 'rgba(224,122,63,0.16)'; g.fillRect(x0, y, ww, rh); }
          else if (inScale(p, this.keyRoot, this.keyScale)) { g.fillStyle = 'rgba(86,182,166,0.08)'; g.fillRect(x0, y, ww, rh); }
          else { g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x0, y, ww, rh); }
        }
        if (p % 12 === 0) { g.fillStyle = 'rgba(255,255,255,0.09)'; g.fillRect(x0, y + rh - 1, ww, 1); }
      }
    }
    const sub = this.snap || 0.25;
    const bStart = Math.max(0, Math.floor((x0 / this.pxb) / sub) * sub);
    for (let b = bStart; b * this.pxb <= x1 + 0.001; b += sub) {
      const x = b * this.pxb;
      if (x < x0) continue;
      const isBar = Math.abs(b % 4) < 1e-6;
      const isBeat = Math.abs(b % 1) < 1e-6;
      g.fillStyle = isBar ? 'rgba(255,255,255,0.16)' : isBeat ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)';
      g.fillRect(x, 0, 1, H);
    }
    // shade the area past the pattern end so you can see where it stops (drawing
    // a note out there extends the pattern automatically)
    const endX = f.clip.length * this.pxb;
    if (endX < x1) {
      const sx = Math.max(endX, x0);
      g.fillStyle = 'rgba(0,0,0,0.34)';
      g.fillRect(sx, 0, x1 - sx, H);
      if (endX >= x0) { g.fillStyle = 'rgba(224,122,63,0.5)'; g.fillRect(endX, 0, 1, H); }
    }

    // notes (only those inside the painted window)
    for (const n of f.clip.notes) {
      const y = this.pitchToY(n.pitch);
      if (y < -rh || y > H) continue;
      const x = n.start * this.pxb;
      const nw = Math.max(4, n.length * this.pxb - 1);
      if (x + nw < x0 || x > x1) continue;
      const sel = this.selNoteIds.has(n.id);
      g.fillStyle = sel ? '#ffffff' : f.track.color;
      g.beginPath();
      g.roundRect(x, y + 1, nw, rh - 2.5, 3);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x + nw - 3, y + 2, 2, rh - 5);
      if (nw > 34 && !isDrums) {
        g.fillStyle = 'rgba(0,0,0,0.6)';
        g.font = '700 9px -apple-system, sans-serif';
        g.fillText(noteName(n.pitch), x + 4, y + 10.5);
      }
    }

    if (this._marquee) {
      const m = this._marquee;
      g.fillStyle = 'rgba(224,122,63,0.14)';
      g.fillRect(m.L, m.T, m.R - m.L, m.B - m.T);
      g.strokeStyle = 'rgba(224,122,63,0.85)';
      g.lineWidth = 1;
      g.strokeRect(m.L + 0.5, m.T + 0.5, m.R - m.L - 1, m.B - m.T - 1);
    }

    this.drawVel(W);
    this.drawRuler(W);
    this.refreshSuggestion();
    if (this.inner) this.inner.style.width = W + 'px';
    if (this.playEl) this.playEl.style.height = (this.RULER_H + H + this.VEL_H) + 'px';
    this.syncPlayhead();
  },

  // top ruler: bar/beat ticks you can click and drag to move the playhead
  drawRuler(W) {
    const rc = this.rulerCv;
    if (!rc) return;
    const dpr = window.devicePixelRatio || 1;
    const H = this.RULER_H;
    const x = this.windowCanvas(rc, W, H, dpr);
    rc.style.background = '#1b1e2b';
    const sc = this.wrap; const vw = sc ? sc.clientWidth : W; const scL = sc ? sc.scrollLeft : 0;
    const x0 = Math.max(0, scL - vw), x1 = Math.min(W, scL + vw * 2);
    x.fillStyle = '#1b1e2b';
    x.fillRect(x0, 0, x1 - x0, H);
    x.font = '600 8.5px -apple-system, sans-serif'; x.textBaseline = 'middle';
    const b0 = Math.max(0, Math.floor(x0 / this.pxb));
    const b1 = Math.ceil(x1 / this.pxb);
    for (let b = b0; b <= b1; b++) {
      const px = b * this.pxb;
      if (px < x0) continue;
      const bpb = beatsPerBar();
      const isBar = b % bpb === 0;
      x.fillStyle = isBar ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.14)';
      x.fillRect(px, isBar ? 3 : 7, 1, isBar ? H - 3 : H - 7);
      if (isBar) { x.fillStyle = 'rgba(255,255,255,0.5)'; x.fillText(String(b / bpb + 1), px + 3, H / 2); }
    }
    this.drawPedal(x, H);
  },

  PEDAL_H: 7,   // the strip along the bottom of the ruler you paint the pedal on

  // Sustain pedal spans. Drawn where you can always see them against the bars,
  // and paintable: drag along the strip to hold the pedal, right-click to lift.
  drawPedal(x, H) {
    const f = this.clip();
    if (!f) return;
    const y = H - this.PEDAL_H;
    x.fillStyle = 'rgba(255,255,255,0.05)';
    x.fillRect(0, y, f.clip.length * this.pxb, this.PEDAL_H);
    const spans = pedalSpans(f.clip);
    for (const sp of spans) {
      const px = sp.from * this.pxb;
      const pw = Math.max(2, (sp.to - sp.from) * this.pxb);
      x.fillStyle = 'rgba(226,146,74,0.85)';
      x.fillRect(px, y, pw, this.PEDAL_H);
      x.fillStyle = 'rgba(0,0,0,0.35)';
      x.fillRect(px, y, 1, this.PEDAL_H);
    }
  },

  // move the playhead line to the song position, in clip-local coordinates
  syncPlayhead(beat) {
    const f = this.clip();
    const el = this.playEl;
    if (!f || !el) return;
    const songBeat = beat != null ? beat : (UI.playing && Engine.ctx ? Engine.currentBeat() : UI.playhead);
    const local = songBeat - f.clip.start;
    if (local < -0.01 || local > f.clip.length + 0.01) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = (local * this.pxb) + 'px';
  },

  bindRuler() {
    const seek = (clientX) => {
      const f = this.clip();
      if (!f) return;
      const r = this.rulerCv.getBoundingClientRect();
      const local = clamp((clientX - r.left + (this._winX0 || 0)) / this.pxb, 0, f.clip.length);
      Engine.seek(f.clip.start + local);
      this.syncPlayhead();
    };
    const onPedalStrip = (e) => {
      const r = this.rulerCv.getBoundingClientRect();
      return (e.clientY - r.top) >= this.RULER_H - this.PEDAL_H;
    };
    const beatAt = (clientX) => {
      const f = this.clip();
      const r = this.rulerCv.getBoundingClientRect();
      return clamp((clientX - r.left + (this._winX0 || 0)) / this.pxb, 0, f ? f.clip.length : 0);
    };
    // right-click the strip lifts the pedal over whatever you drag across
    this.rulerCv.addEventListener('contextmenu', (e) => {
      if (!onPedalStrip(e)) return;
      e.preventDefault();
      const f = this.clip();
      if (!f) return;
      Undo.push('Sustain pedal');
      const a = beatAt(e.clientX);
      const mv = (ev) => { clearPedalRange(f.clip, Math.min(a, beatAt(ev.clientX)), Math.max(a, beatAt(ev.clientX))); this.redraw(); };
      mv(e);
      const up = () => {
        window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
        UI.dirty = UI.fileDirty = true;
        if (UI.playing) Engine.liveEdit();
      };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    });
    this.rulerCv.style.cursor = 'pointer';
    this.rulerCv.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (e.button === 0 && onPedalStrip(e)) {
        const f = this.clip();
        if (!f) return;
        Undo.push('Sustain pedal');
        const a = beatAt(e.clientX);
        const paint = (ev) => {
          const b = beatAt(ev.clientX);
          setPedalSpan(f.clip, Math.min(a, b), Math.max(a, b));
          this.redraw();
        };
        paint(e);
        const up = () => {
          window.removeEventListener('mousemove', paint); window.removeEventListener('mouseup', up);
          UI.dirty = UI.fileDirty = true;
          if (UI.playing) Engine.liveEdit();
        };
        window.addEventListener('mousemove', paint); window.addEventListener('mouseup', up);
        return;
      }
      seek(e.clientX);
      const mv = (ev) => seek(ev.clientX);
      const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    });
  },

  // velocity lane: one bar per note, height = how loud it is; drag to reshape dynamics
  drawVel(W) {
    const f = this.clip();
    const vc = this.velCv;
    if (!vc || !f) return;
    const dpr = window.devicePixelRatio || 1;
    const H = this.VEL_H;
    const v = this.windowCanvas(vc, W, H, dpr);
    vc.style.background = '#12151f';
    const sc = this.wrap; const vw = sc ? sc.clientWidth : W; const scL = sc ? sc.scrollLeft : 0;
    const vX0 = Math.max(0, scL - vw), vX1 = Math.min(W, scL + vw * 2);
    v.fillStyle = '#12151f';
    v.fillRect(vX0, 0, vX1 - vX0, H);
    // faint quarter/full markers so it lines up with the grid
    for (let b = 0; b <= f.clip.length + 0.001; b += 1) {
      const x = b * this.pxb;
      v.fillStyle = Math.abs(b % 4) < 1e-6 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
      v.fillRect(x, 0, 1, H);
    }
    const pad = 5;
    const usable = H - pad * 2;
    for (const n of f.clip.notes) {
      const x = n.start * this.pxb;
      const nw = Math.max(3, n.length * this.pxb - 1);
      const vel = clamp(n.vel ?? 0.9, 0, 1);
      const barH = Math.max(2, vel * usable);
      const y = H - pad - barH;
      const sel = this.selNoteIds.has(n.id);
      v.fillStyle = sel ? '#ffffff' : f.track.color;
      v.globalAlpha = sel ? 1 : 0.85;
      v.fillRect(x, y, nw, barH);
      v.globalAlpha = 1;
      // a cap line so short bars are still visible
      v.fillStyle = 'rgba(255,255,255,0.5)';
      v.fillRect(x, y, nw, 1.5);
    }
  },

  // ---------- interaction ----------

  bindGrid() {
    const gc = this.gridCv;

    gc.addEventListener('wheel', (e) => {
      if (this._rowMap) return;   // drum lanes are fixed; nothing to scroll to
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      // normalise wheel units to pixels, then move whole rows as they accumulate,
      // so scrolling is smooth and proportional (not a fixed 2-semitone jump)
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;            // lines -> px
      else if (e.deltaMode === 2) dy *= this.gridH(); // pages -> px
      this._scrollAcc = (this._scrollAcc || 0) + dy;
      const rows = Math.trunc(this._scrollAcc / this.rowH);
      if (!rows) return;
      this._scrollAcc -= rows * this.rowH;
      const rowsVisible = Math.floor(this.gridH() / this.rowH);
      const minTop = Math.min(84, 12 + rowsVisible); // keep the lowest keys reachable
      this.topPitch = clamp(this.topPitch - rows, minTop, 120);
      this.scheduleRedraw();
    }, { passive: false });

    gc.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = gc.getBoundingClientRect();
      const n = this.noteAt(this.evX(e, r), e.clientY - r.top);
      if (n) {
        const f = this.clip();
        // delete the whole selection if the note is part of a multi-selection
        const ids = (this.selNoteIds.has(n.id) && this.selNoteIds.size > 1) ? new Set(this.selNoteIds) : new Set([n.id]);
        Undo.push(ids.size > 1 ? 'Delete notes' : 'Delete note');
        f.clip.notes = f.clip.notes.filter(nn => !ids.has(nn.id));
        for (const id of ids) this.selNoteIds.delete(id);
        this.selNoteId = [...this.selNoteIds].pop() || null;
        this.redraw();
        Timeline.drawClip(this.clipId);
        toast(ids.size > 1 ? tr('toast_notes_deleted', '{n} notes deleted', { n: ids.size }) : tr('toast_note_deleted', 'Note deleted'));
      }
    });

    gc.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const f = this.clip();
      if (!f) return;
      const r = gc.getBoundingClientRect();
      const x = this.evX(e, r);
      const y = e.clientY - r.top;
      let n = this.noteAt(x, y);

      // shift toggles a note, or draws a marquee over empty grid
      if (e.shiftKey) {
        if (n) {
          if (this.selNoteIds.has(n.id)) this.selNoteIds.delete(n.id); else this.selNoteIds.add(n.id);
          this.selNoteId = [...this.selNoteIds].pop() || null;
          this.redraw();
          return;
        }
        const preSel = new Set(this.selNoteIds);
        const mmove = (ev) => {
          const x1 = this.evX(ev, r), y1 = ev.clientY - r.top;
          const L = Math.min(x, x1), T = Math.min(y, y1), R = Math.max(x, x1), B = Math.max(y, y1);
          this._marquee = { L, T, R, B };
          const hits = new Set(preSel);
          for (const nn of f.clip.notes) {
            const nx = nn.start * this.pxb, nw = Math.max(4, nn.length * this.pxb), ny = this.pitchToY(nn.pitch);
            if (nx < R && nx + nw > L && ny < B && ny + this._rh > T) hits.add(nn.id);
          }
          this.selNoteIds = hits; this.selNoteId = [...hits].pop() || null;
          this.redraw();
        };
        const mup = () => {
          window.removeEventListener('mousemove', mmove); window.removeEventListener('mouseup', mup);
          this._marquee = null; this.redraw();
        };
        window.addEventListener('mousemove', mmove); window.addEventListener('mouseup', mup);
        return;
      }

      let mode = 'move';
      let pushed = false;

      if (n) {
        // in a room, a note someone else is dragging is locked for you
        if (typeof Sync !== 'undefined' && Sync.admitted) {
          const l = Sync.lockedBy('note:' + n.id);
          if (l) { toast(tr('mp_locked_by', '{name} is using this', { name: l.name })); return; }
          Sync.setLock('note:' + n.id, true);
        }
        // right edge = resize
        if (x > (n.start + n.length) * this.pxb - 7) mode = 'resize';
        // clicking an unselected note selects just it; keep the group otherwise
        if (!this.selNoteIds.has(n.id)) this.selNoteIds = new Set([n.id]);
        this.selNoteId = n.id;
        Engine.previewNote(f.track, n.pitch, 0.25);
      } else {
        // add note (or a whole chord in chord mode)
        const isDrums = isDrumInstr(f.track.instrument);
        const beat = this.snap ? Math.floor(this.xToBeat(x) / this.snap) * this.snap : this.xToBeat(x);
        // no upper clamp: writing past the end grows the pattern (extendClipIfNeeded)
        const start = Math.max(0, beat);
        let pitch = this.yToPitch(y);
        if (this.snapScale && !isDrums) pitch = nearestInScale(pitch, this.keyRoot, this.keyScale);

        const pitches = (this.chordMode && !isDrums)
          ? diatonicChord(pitch, this.keyRoot, this.keyScale, 3)
          : [pitch];
        Undo.push(pitches.length > 1 ? 'Add chord' : 'Add note');
        pushed = true;
        const made = pitches.map(p => {
          const nn = { id: uid('note'), pitch: clamp(p, 12, 120), start, length: this.lastLen, vel: 0.9 };
          f.clip.notes.push(nn);
          this.extendClipIfNeeded(nn);
          return nn;
        });
        n = made[0]; // the root drives the drag; the rest follow as a group
        this.selNoteIds = new Set(made.map(nn => nn.id));
        this.selNoteId = n.id;
        for (const p of pitches) Engine.previewNote(f.track, clamp(p, 12, 120), 0.25);
        toast(pitches.length > 1
          ? tr('toast_chord_added', '{name} chord added', { name: noteName(n.pitch) })
          : tr('toast_note_added', 'Note {name} added', { name: noteName(n.pitch) }));
      }
      this.redraw();

      const startX = e.clientX, startY = e.clientY;
      const orig = { start: n.start, pitch: n.pitch, length: n.length };
      // the rest of the selection moves along with the primary note
      const groupNotes = [...this.selNoteIds].filter(id => id !== n.id)
        .map(id => f.clip.notes.find(nn => nn.id === id)).filter(Boolean)
        .map(nn => ({ note: nn, start: nn.start, pitch: nn.pitch, length: nn.length }));
      let lastPreview = n.pitch;

      const move = (ev) => {
        const dx = (ev.clientX - startX) / this.pxb;
        const dy = Math.round((ev.clientY - startY) / this.rowH);
        if (!pushed && (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3)) {
          Undo.push(mode === 'resize' ? 'Resize note' : 'Move note');
          pushed = true;
        }
        if (!pushed) return;
        if (mode === 'resize') {
          const raw = orig.length + dx;
          n.length = Math.max(this.snap || 0.05,
            this.snap ? Math.round(raw / this.snap) * this.snap : raw);
          this.lastLen = n.length;
          // resizing one note fits every selected note to the same length
          for (const gr of groupNotes) gr.note.length = n.length;
        } else {
          const raw = orig.start + dx;
          n.start = Math.max(0, this.snap ? Math.round(raw / this.snap) * this.snap : raw);
          // drum notes stay on their lane; melodic notes move in pitch
          n.pitch = this._rowMap ? orig.pitch : clamp(orig.pitch - dy, 12, 120);
          if (this.snapScale && !isDrumInstr(f.track.instrument)) n.pitch = nearestInScale(n.pitch, this.keyRoot, this.keyScale);
          if (n.pitch !== lastPreview) {
            Engine.previewNote(f.track, n.pitch, 0.15);
            lastPreview = n.pitch;
          }
          const dStart = n.start - orig.start, dPitch = n.pitch - orig.pitch;
          for (const gr of groupNotes) {
            gr.note.start = Math.max(0, gr.start + dStart);
            gr.note.pitch = clamp(gr.pitch + dPitch, 12, 120);
          }
        }
        this.extendClipIfNeeded(n);
        for (const gr of groupNotes) this.extendClipIfNeeded(gr.note);
        this.redraw();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (typeof Sync !== 'undefined') Sync.setLock('note:' + n.id, false);
        Timeline.drawClip(this.clipId);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  },

  extendClipIfNeeded(n) {
    const f = this.clip();
    const end = n.start + n.length;
    if (end > f.clip.length) {
      f.clip.length = Math.ceil(end);
      Timeline.render();
    }
  },

  bindKeys() {
    this.keysCv.addEventListener('mousedown', (e) => {
      const f = this.clip();
      if (!f) return;
      const r = this.keysCv.getBoundingClientRect();
      const pitch = this.yToPitch(e.clientY - r.top);
      Engine.previewNote(f.track, pitch, 0.4);
    });
  },

  // drag in the velocity lane to shape how loud notes are. With several notes
  // selected it sets them together; otherwise it paints the notes under the cursor.
  bindVel() {
    const vc = this.velCv;
    const velFromY = (y) => clamp((this.VEL_H - 5 - y) / (this.VEL_H - 10), 0.05, 1);
    const notesAtBeat = (bx) => {
      const f = this.clip();
      return f ? f.clip.notes.filter(n => bx >= n.start && bx <= n.start + Math.max(n.length, 0.05)) : [];
    };
    vc.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const f = this.clip();
      if (!f) return;
      const r = vc.getBoundingClientRect();
      const useSel = this.selNoteIds.size > 1;
      let pushed = false;
      const apply = (ev) => {
        const vel = velFromY(ev.clientY - r.top);
        const targets = useSel ? this.selectedNotes() : notesAtBeat((ev.clientX - r.left + (this._winX0 || 0)) / this.pxb);
        if (!targets.length) return;
        if (!pushed) { Undo.push('Velocity'); pushed = true; }
        for (const n of targets) n.vel = vel;
        this.redraw();
      };
      apply(e);
      const up = () => {
        window.removeEventListener('mousemove', apply);
        window.removeEventListener('mouseup', up);
        if (pushed) Timeline.drawClip(this.clipId);
      };
      window.addEventListener('mousemove', apply);
      window.addEventListener('mouseup', up);
    });
  },

  // tighten note starts onto the current grid. scope: 'sel' = selected notes, 'all' = whole clip
  quantize(scope) {
    const f = this.clip();
    if (!f) return;
    const grid = this.snap || 0.25;
    const targets = scope === 'sel' ? this.selectedNotes() : f.clip.notes;
    if (!targets.length) {
      toast(tr(scope === 'sel' ? 'toast_quantize_none_sel' : 'toast_nothing_quantize',
        scope === 'sel' ? 'Select some notes first' : 'No notes to line up'));
      return;
    }
    Undo.push('Quantize');
    for (const n of targets) n.start = Math.max(0, Math.round(n.start / grid) * grid);
    this.redraw();
    Timeline.drawClip(this.clipId);
    toast(tr('toast_quantized', 'Lined {n} notes up to the grid', { n: targets.length }));
  },

  // ---------- what chord comes next ----------
  // Reads the chords already in the pattern, works out where the last one sits
  // in the key, and offers the chord that usually follows it. Tab accepts,
  // and it never does anything on its own.

  // group notes that start together into chords, in time order
  chordGroups() {
    const f = this.clip();
    if (!f) return [];
    const by = new Map();
    for (const n of f.clip.notes) {
      const k = Math.round(n.start * 16) / 16;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(n);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0])
      .map(([start, notes]) => ({ start, notes, len: Math.max(...notes.map(n => n.length)) }));
  },

  // Work out the suggestion without showing it, so the same logic serves the
  // hint, the preview and Tab.
  computeSuggestion() {
    const f = this.clip();
    if (!f || this._rowMap) return null;                    // meaningless on drums
    if (!ChordSuggest.enabled() || !ChordSuggest.usable(this.keyScale)) return null;
    const groups = this.chordGroups().filter(g => g.notes.length >= 2);
    const last = groups[groups.length - 1];
    let prevDegree = null, at = 0, octaveRoot = 60 + this.keyRoot, len = 1;
    if (last) {
      prevDegree = ChordSuggest.degreeOf(last.notes.map(n => n.pitch), this.keyRoot, this.keyScale);
      if (prevDegree == null) return null;                  // not a chord we understand
      at = last.start + last.len;
      len = last.len;
      octaveRoot = Math.min(...last.notes.map(n => n.pitch));
      octaveRoot -= ((octaveRoot - this.keyRoot) % 12 + 12) % 12;   // the key's root below it
    } else {
      const all = this.chordGroups();
      if (all.length) return null;                          // notes, but no chords yet
    }
    if (at > f.clip.length - 0.25) return null;             // no room left in the pattern
    const opts = ChordSuggest.optionsFor(prevDegree, this.keyScale);
    const idx = (this._sugIdx || 0) % opts.length;
    const chord = ChordSuggest.chordAt(opts[idx], this.keyRoot, this.keyScale, octaveRoot);
    return { chord, at, len, options: opts, idx };
  },

  refreshSuggestion() {
    this._sug = this.computeSuggestion();
    const el = this._sugEl;
    if (!el) return;
    if (!this._sug) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.querySelector('.cs-name').textContent = this._sug.chord.name;
    // The roman numeral is real information for anyone who wants it, just not
    // the first thing a beginner should have to read.
    el.dataset.tip = tr('tip_chord_sug', 'The chord that usually comes next. Tab to add it.')
      + ' (' + this._sug.chord.roman + ')';
    el.querySelector('.cs-alt').classList.toggle('hidden', this._sug.options.length < 2);
  },

  acceptSuggestion() {
    const s = this._sug;
    const f = this.clip();
    if (!s || !f) return false;
    Undo.push('Add chord');
    for (const pitch of s.chord.pitches) {
      f.clip.notes.push({ id: uid('note'), pitch: clamp(pitch, 0, 127),
                          start: s.at, length: Math.max(0.25, s.len), vel: 0.8 });
    }
    if (s.at + s.len > f.clip.length) f.clip.length = s.at + s.len;
    this._sugIdx = 0;
    this.redraw();
    Timeline.drawClip(this.clipId);
    if (UI.playing) Engine.liveEdit();
    toast(tr('chord_added', 'Added {roman}', { roman: s.chord.roman }), 'green');
    return true;
  },

  cycleSuggestion() {
    if (!this._sug) return false;
    this._sugIdx = (this._sugIdx || 0) + 1;
    this.redraw();
    return true;
  },

  // Nudge timing and loudness a little. Perfectly gridded notes at one velocity
  // are the main thing that makes a pattern sound programmed, and a real player
  // is never exactly on the beat or exactly as loud twice.
  //
  // Two rules keep it musical rather than sloppy: the nudge is a fraction of the
  // grid rather than a fixed number of beats, so it stays proportional at any
  // resolution, and the first note of a bar is nudged less, because that is the
  // one the ear uses to find the beat.
  humanize(scope) {
    const f = this.clip();
    if (!f) return;
    const targets = scope === 'sel' ? this.selectedNotes() : f.clip.notes;
    if (!targets.length) {
      toast(tr(scope === 'sel' ? 'toast_humanize_none_sel' : 'toast_humanize_none',
        scope === 'sel' ? 'Select some notes first' : 'No notes to humanize'));
      return;
    }
    const grid = this.snap || 0.25;
    const timeAmt = grid * 0.11;        // about a hundredth of a bar at 1/16
    const velAmt = 0.13;
    const bpb = beatsPerBar();
    // triangular rather than flat: small nudges common, large ones rare, which
    // is how human timing actually scatters
    const jitter = () => (Math.random() + Math.random() - 1);

    Undo.push('Humanize');
    for (const n of targets) {
      const onDownbeat = Math.abs(n.start % bpb) < 1e-6;
      const t = jitter() * timeAmt * (onDownbeat ? 0.35 : 1);
      n.start = Math.max(0, +(n.start + t).toFixed(4));
      const v = (n.vel ?? 0.85) + jitter() * velAmt;
      n.vel = +clamp(v, 0.15, 1).toFixed(3);
    }
    // notes must not end up sitting past the end of their own pattern
    for (const n of targets) if (n.start > f.clip.length - 0.01) n.start = Math.max(0, f.clip.length - 0.01);
    this.redraw();
    Timeline.drawClip(this.clipId);
    if (UI.playing) Engine.liveEdit();
    toast(tr('toast_humanized', 'Loosened {n} notes', { n: targets.length }));
  },

  // note operations used by global shortcuts (only while the roll is open,
  // otherwise the shortcut should fall through to the clip-level action)
  selectedNotes() {
    const f = this.clip();
    if (!f) return [];
    return f.clip.notes.filter(n => this.selNoteIds.has(n.id));
  },

  deleteSelected() {
    if (!this.isOpen()) return false;
    const f = this.clip();
    const sel = this.selectedNotes();
    if (!f || !sel.length) return false;
    Undo.push(sel.length > 1 ? 'Delete notes' : 'Delete note');
    f.clip.notes = f.clip.notes.filter(n => !this.selNoteIds.has(n.id));
    this.selNoteIds.clear();
    this.selNoteId = null;
    this.redraw();
    Timeline.drawClip(this.clipId);
    toast(sel.length > 1 ? tr('toast_notes_deleted', '{n} notes deleted', { n: sel.length }) : tr('toast_note_deleted', 'Note deleted'));
    return true;
  },

  copySelected(cut) {
    if (!this.isOpen()) return false;
    const f = this.clip();
    const sel = this.selectedNotes();
    if (!f || !sel.length) return false;
    const base = Math.min(...sel.map(n => n.start));
    UI.clipboard = { type: 'notes', data: sel.map(n => ({ ...JSON.parse(JSON.stringify(n)), start: n.start - base })) };
    if (cut) {
      Undo.push(sel.length > 1 ? 'Cut notes' : 'Cut note');
      f.clip.notes = f.clip.notes.filter(n => !this.selNoteIds.has(n.id));
      this.selNoteIds.clear();
      this.selNoteId = null;
      this.redraw();
      Timeline.drawClip(this.clipId);
      toast(sel.length > 1 ? tr('toast_notes_cut', '{n} notes cut', { n: sel.length }) : tr('toast_note_cut', 'Note cut'));
    } else {
      toast(sel.length > 1 ? tr('toast_notes_copied', '{n} notes copied', { n: sel.length }) : tr('toast_note_copied', 'Note copied'));
    }
    return true;
  },

  paste() {
    if (!this.isOpen()) return false;
    const f = this.clip();
    if (!f || !UI.clipboard) return false;
    // accept both a single legacy note and a group of notes
    let notes;
    if (UI.clipboard.type === 'notes') notes = UI.clipboard.data;
    else if (UI.clipboard.type === 'note') notes = [{ ...UI.clipboard.data, start: 0 }];
    else return false;
    Undo.push(notes.length > 1 ? 'Paste notes' : 'Paste note');
    // drop the group at the playhead (or at the start of the clip)
    const at = this.snap ? Math.round((this.selNoteId ? 0 : 0) / this.snap) * this.snap : 0;
    const newIds = new Set();
    for (const src of notes) {
      const n = JSON.parse(JSON.stringify(src));
      n.id = uid('note');
      n.start = at + src.start;
      f.clip.notes.push(n);
      this.extendClipIfNeeded(n);
      newIds.add(n.id);
    }
    this.selNoteIds = newIds;
    this.selNoteId = [...newIds].pop() || null;
    this.redraw();
    Timeline.drawClip(this.clipId);
    toast(notes.length > 1 ? tr('toast_notes_pasted', '{n} notes pasted', { n: notes.length }) : tr('toast_note_pasted', 'Note pasted'));
    return true;
  }
};
