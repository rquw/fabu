// ---------- Piano roll: the MIDI note editor (floating window) ----------
'use strict';

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
  RULER_H: 16,        // seek ruler height
  velCv: null,
  rulerCv: null,
  inner: null,
  playEl: null,

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

  open(clipId) {
    this.clipId = clipId;
    this.selNoteId = null;
    this.selNoteIds = new Set();
    const f = this.clip();
    if (!f) return;

    const w = Windows.create('proll', tr('win_pianoroll', 'Piano roll: {name}', { name: f.clip.name || 'Pattern' }), 'i-note',
      { x: Math.max(20, window.innerWidth / 2 - 420), y: 120 });
    w.body.classList.add('proll-body');

    this.loadPrefs();

    const tools = document.createElement('div');
    tools.className = 'proll-tools';
    const rootOpts = NOTE_NAMES.map((nm, i) => `<option value="${i}"${i === this.keyRoot ? ' selected' : ''}>${nm}</option>`).join('');
    const scaleOpts = Object.keys(SCALES).map(id => `<option value="${id}"${id === this.keyScale ? ' selected' : ''}>${scaleName(id)}</option>`).join('');
    tools.innerHTML = `
      <span class="pt-track" style="color:${f.track.color}">${f.track.name}</span>
      <div class="pt-group pt-key">
        <label>${tr('proll_key', 'KEY')}</label>
        <select id="pkRoot" data-tip="${tr('tip_key_root', 'Song key')}">${rootOpts}</select>
        <select id="pkScale" data-tip="${tr('tip_key_scale', 'Scale')}">${scaleOpts}</select>
        <button id="pkScaleOn" class="pt-toggle" data-tip="${tr('tip_scale_show', 'Shade the notes that fit the key')}">${tr('proll_highlight', 'Highlight')}</button>
        <button id="pkSnapScale" class="pt-toggle" data-tip="${tr('tip_scale_snap', 'Pull drawn notes onto the key')}">${tr('proll_tokey', 'To key')}</button>
        <button id="pkChord" class="pt-toggle" data-tip="${tr('tip_chord', 'Click drops a full chord in the key')}">${tr('proll_chord', 'Chord')}</button>
      </div>
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
      </div>`;
    w.body.appendChild(tools);

    const q = (sel) => tools.querySelector(sel);
    q('#prollSnap').value = String(this.snap);
    q('#prollSnap').addEventListener('change', (e) => {
      this.snap = parseFloat(e.target.value);
      toast(tr('toast_proll_snap', 'Piano roll snap: {v}', { v: this.snap ? snapLabel(this.snap) : tr('word_off', 'off') }));
    });
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
    q('#pkQuantSel').addEventListener('click', () => this.quantize('sel'));
    q('#pkQuantAll').addEventListener('click', () => this.quantize('all'));

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start';
    const leftCol = document.createElement('div');
    leftCol.style.cssText = 'display:flex;flex-direction:column;flex-shrink:0';
    const rulerSpacer = document.createElement('div');
    rulerSpacer.className = 'pt-ruler-spacer';
    rulerSpacer.style.height = this.RULER_H + 'px';
    this.keysCv = document.createElement('canvas');
    const velLabel = document.createElement('div');
    velLabel.className = 'pt-vel-label';
    velLabel.style.height = this.VEL_H + 'px';
    velLabel.textContent = tr('proll_vel', 'VEL');
    leftCol.append(rulerSpacer, this.keysCv, velLabel);

    this.wrap = document.createElement('div');
    this.wrap.style.cssText = 'overflow-x:auto;overflow-y:hidden;max-width:780px';
    this.inner = document.createElement('div');
    this.inner.style.cssText = 'position:relative';
    this.rulerCv = document.createElement('canvas');
    this.rulerCv.className = 'proll-ruler';
    this.gridCv = document.createElement('canvas');
    this.gridCv.style.cursor = 'crosshair';
    this.velCv = document.createElement('canvas');
    this.velCv.className = 'proll-vel';
    this.playEl = document.createElement('div');
    this.playEl.className = 'proll-playhead';
    this.inner.append(this.rulerCv, this.gridCv, this.velCv, this.playEl);
    this.wrap.append(this.inner);
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
    return Math.max(384, (f ? f.clip.length : 4) * this.pxb);
  },
  yToPitch(y) { return this.topPitch - Math.floor(y / this.rowH); },
  pitchToY(p) { return (this.topPitch - p) * this.rowH; },
  xToBeat(x) { return x / this.pxb; },

  noteAt(x, y) {
    const f = this.clip();
    if (!f) return null;
    const pitch = this.yToPitch(y);
    const beat = this.xToBeat(x);
    // topmost drawn last wins
    for (let i = f.clip.notes.length - 1; i >= 0; i--) {
      const n = f.clip.notes[i];
      if (n.pitch === pitch && beat >= n.start && beat <= n.start + n.length) return n;
    }
    return null;
  },

  // ---------- drawing ----------

  redraw() {
    const f = this.clip();
    if (!f || !this.gridCv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = this.gridWidth();
    const H = this.GRID_H;
    const rows = Math.floor(H / this.rowH);
    const bottomPitch = this.topPitch - rows + 1;

    // --- keys column ---
    const kc = this.keysCv;
    kc.width = this.KEYS_W * dpr; kc.height = H * dpr;
    kc.style.width = this.KEYS_W + 'px'; kc.style.height = H + 'px';
    const kx = kc.getContext('2d');
    kx.scale(dpr, dpr);
    const isDrums = isDrumInstr(f.track.instrument);
    for (let p = this.topPitch; p >= bottomPitch; p--) {
      const y = this.pitchToY(p);
      const black = [1, 3, 6, 8, 10].includes(p % 12);
      kx.fillStyle = black ? '#232839' : '#e9ebf4';
      kx.fillRect(0, y, this.KEYS_W, this.rowH - 0.5);
      kx.fillStyle = black ? '#69708c' : '#3a3f55';
      kx.font = '600 9px -apple-system, sans-serif';
      const dName = isDrums ? drumLabel(p % 12) : null;
      if (dName) {
        kx.fillText(dName, 4, y + 10);
      } else if (p % 12 === 0) {
        kx.fillText(noteName(p), 4, y + 10);
      }
    }

    // --- grid ---
    const gc = this.gridCv;
    gc.width = W * dpr; gc.height = H * dpr;
    gc.style.width = W + 'px'; gc.style.height = H + 'px';
    const g = gc.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#161927';
    g.fillRect(0, 0, W, H);
    const showScale = this.scaleOn && !isDrums;
    for (let p = this.topPitch; p >= bottomPitch; p--) {
      const y = this.pitchToY(p);
      if ([1, 3, 6, 8, 10].includes(p % 12)) {
        g.fillStyle = 'rgba(0,0,0,0.22)';
        g.fillRect(0, y, W, this.rowH);
      }
      if (showScale) {
        if (((p - this.keyRoot) % 12 + 12) % 12 === 0) {
          g.fillStyle = 'rgba(224,122,63,0.16)';           // the root note, strongest
          g.fillRect(0, y, W, this.rowH);
        } else if (inScale(p, this.keyRoot, this.keyScale)) {
          g.fillStyle = 'rgba(86,182,166,0.08)';           // other in-key notes
          g.fillRect(0, y, W, this.rowH);
        } else {
          g.fillStyle = 'rgba(0,0,0,0.28)';                // dim out-of-key rows
          g.fillRect(0, y, W, this.rowH);
        }
      }
      if (p % 12 === 0) {
        g.fillStyle = 'rgba(255,255,255,0.09)';
        g.fillRect(0, y + this.rowH - 1, W, 1);
      }
    }
    const sub = this.snap || 0.25;
    for (let b = 0; b <= f.clip.length + 0.001; b += sub) {
      const x = b * this.pxb;
      const isBar = Math.abs(b % 4) < 1e-6;
      const isBeat = Math.abs(b % 1) < 1e-6;
      g.fillStyle = isBar ? 'rgba(255,255,255,0.16)' : isBeat ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)';
      g.fillRect(x, 0, 1, H);
    }

    // notes
    for (const n of f.clip.notes) {
      const y = this.pitchToY(n.pitch);
      if (y < -this.rowH || y > H) continue;
      const x = n.start * this.pxb;
      const nw = Math.max(4, n.length * this.pxb - 1);
      const sel = this.selNoteIds.has(n.id);
      g.fillStyle = sel ? '#ffffff' : f.track.color;
      g.beginPath();
      g.roundRect(x, y + 1, nw, this.rowH - 2.5, 3);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x + nw - 3, y + 2, 2, this.rowH - 5);
      if (nw > 34) {
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
    rc.width = W * dpr; rc.height = H * dpr;
    rc.style.width = W + 'px'; rc.style.height = H + 'px';
    const x = rc.getContext('2d');
    x.scale(dpr, dpr);
    x.fillStyle = '#1b1e2b';
    x.fillRect(0, 0, W, H);
    x.font = '600 8.5px -apple-system, sans-serif'; x.textBaseline = 'middle';
    const f = this.clip();
    const beats = f ? f.clip.length : 4;
    for (let b = 0; b <= beats + 0.001; b++) {
      const px = b * this.pxb;
      const isBar = b % 4 === 0;
      x.fillStyle = isBar ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.14)';
      x.fillRect(px, isBar ? 3 : 7, 1, isBar ? H - 3 : H - 7);
      if (isBar) { x.fillStyle = 'rgba(255,255,255,0.5)'; x.fillText(String(b / 4 + 1), px + 3, H / 2); }
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
      const local = clamp((clientX - r.left) / this.pxb, 0, f.clip.length);
      Engine.seek(f.clip.start + local);
      this.syncPlayhead();
    };
    this.rulerCv.style.cursor = 'pointer';
    this.rulerCv.addEventListener('mousedown', (e) => {
      e.preventDefault();
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
    vc.width = W * dpr; vc.height = H * dpr;
    vc.style.width = W + 'px'; vc.style.height = H + 'px';
    const v = vc.getContext('2d');
    v.scale(dpr, dpr);
    v.fillStyle = '#12151f';
    v.fillRect(0, 0, W, H);
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
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        this.topPitch = clamp(this.topPitch - Math.sign(e.deltaY) * 2, 40, 118);
        this.redraw();
      }
    }, { passive: false });

    gc.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = gc.getBoundingClientRect();
      const n = this.noteAt(e.clientX - r.left, e.clientY - r.top);
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
      const x = e.clientX - r.left;
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
          const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
          const L = Math.min(x, x1), T = Math.min(y, y1), R = Math.max(x, x1), B = Math.max(y, y1);
          this._marquee = { L, T, R, B };
          const hits = new Set(preSel);
          for (const nn of f.clip.notes) {
            const nx = nn.start * this.pxb, nw = Math.max(4, nn.length * this.pxb), ny = this.pitchToY(nn.pitch);
            if (nx < R && nx + nw > L && ny < B && ny + this.rowH > T) hits.add(nn.id);
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
        const start = clamp(beat, 0, Math.max(0, f.clip.length - 0.05));
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
          n.pitch = clamp(orig.pitch - dy, 12, 120);
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
        const targets = useSel ? this.selectedNotes() : notesAtBeat((ev.clientX - r.left) / this.pxb);
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
