// ---------- Piano roll: the MIDI note editor (floating window) ----------
'use strict';

const PianoRoll = {
  clipId: null,
  selNoteId: null,
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

  isOpen() { return Windows.isOpen('proll'); },

  clip() {
    if (!this.clipId) return null;
    const f = getClip(this.clipId);
    return f ? f : null;
  },

  open(clipId) {
    this.clipId = clipId;
    this.selNoteId = null;
    const f = this.clip();
    if (!f) return;

    const w = Windows.create('proll', tr('win_pianoroll', 'Piano roll: {name}', { name: f.clip.name || 'Pattern' }), 'i-note',
      { x: Math.max(20, window.innerWidth / 2 - 420), y: 120 });
    w.body.classList.add('proll-body');

    const tools = document.createElement('div');
    tools.className = 'proll-tools';
    tools.innerHTML = `
      <span style="color:${f.track.color};font-weight:700">${f.track.name}, ${instrLabel(f.track.instrument)}</span>
      <span style="flex:1"></span>
      <svg class="ic dim" style="width:13px;height:13px"><use href="#i-magnet"/></svg>
      <select id="prollSnap" data-tip="${tr('tip_proll_snap', 'Note snap grid')}">
        <option value="1">${tr('snap_beat', 'Beat')}</option>
        <option value="0.5">1/8</option>
        <option value="0.25" selected>1/16</option>
        <option value="0.125">1/32</option>
        <option value="0">${tr('snap_off', 'Off')}</option>
      </select>
      <span style="color:var(--faint);font-size:10.5px">${tr('proll_hint', 'click to add, drag to move, edge for length, right-click to delete')}</span>`;
    w.body.appendChild(tools);
    tools.querySelector('#prollSnap').value = String(this.snap);
    tools.querySelector('#prollSnap').addEventListener('change', (e) => {
      this.snap = parseFloat(e.target.value);
      toast(tr('toast_proll_snap', 'Piano roll snap: {v}', { v: this.snap ? snapLabel(this.snap) : tr('word_off', 'off') }));
    });

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start';
    this.keysCv = document.createElement('canvas');
    this.wrap = document.createElement('div');
    this.wrap.style.cssText = 'overflow-x:auto;overflow-y:hidden;max-width:780px';
    this.gridCv = document.createElement('canvas');
    this.gridCv.style.cursor = 'crosshair';
    this.wrap.appendChild(this.gridCv);
    row.append(this.keysCv, this.wrap);
    w.body.appendChild(row);

    w.refresh = () => this.redraw();

    this.bindGrid();
    this.bindKeys();
    this.redraw();
    App.syncWindowButtons();
  },

  close() { Windows.close('proll'); this.clipId = null; },

  onStateRestore() {
    if (!this.isOpen()) return;
    const f = this.clip();
    if (!f) { this.close(); return; }
    if (this.selNoteId && !f.clip.notes.find(n => n.id === this.selNoteId)) this.selNoteId = null;
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
    const isDrums = f.track.instrument === 'drums';
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
    for (let p = this.topPitch; p >= bottomPitch; p--) {
      const y = this.pitchToY(p);
      if ([1, 3, 6, 8, 10].includes(p % 12)) {
        g.fillStyle = 'rgba(0,0,0,0.22)';
        g.fillRect(0, y, W, this.rowH);
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
      const sel = n.id === this.selNoteId;
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
        Undo.push('Delete note');
        const f = this.clip();
        f.clip.notes.splice(f.clip.notes.indexOf(n), 1);
        if (this.selNoteId === n.id) this.selNoteId = null;
        this.redraw();
        Timeline.drawClip(this.clipId);
        toast(tr('toast_note_deleted', 'Note deleted'));
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
        this.selNoteId = n.id;
        Engine.previewNote(f.track, n.pitch, 0.25);
      } else {
        // add note
        Undo.push('Add note');
        pushed = true;
        const beat = this.snap ? Math.floor(this.xToBeat(x) / this.snap) * this.snap : this.xToBeat(x);
        n = {
          id: uid('note'),
          pitch: this.yToPitch(y),
          start: clamp(beat, 0, Math.max(0, f.clip.length - 0.05)),
          length: this.lastLen,
          vel: 0.9
        };
        f.clip.notes.push(n);
        this.selNoteId = n.id;
        this.extendClipIfNeeded(n);
        Engine.previewNote(f.track, n.pitch, 0.25);
        toast(tr('toast_note_added', 'Note {name} added', { name: noteName(n.pitch) }));
      }
      this.redraw();

      const startX = e.clientX, startY = e.clientY;
      const orig = { start: n.start, pitch: n.pitch, length: n.length };
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
        } else {
          const raw = orig.start + dx;
          n.start = Math.max(0, this.snap ? Math.round(raw / this.snap) * this.snap : raw);
          n.pitch = clamp(orig.pitch - dy, 12, 120);
          if (n.pitch !== lastPreview) {
            Engine.previewNote(f.track, n.pitch, 0.15);
            lastPreview = n.pitch;
          }
        }
        this.extendClipIfNeeded(n);
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

  // note operations used by global shortcuts (only while the roll is open,
  // otherwise the shortcut should fall through to the clip-level action)
  deleteSelected() {
    if (!this.isOpen()) return false;
    const f = this.clip();
    if (!f || !this.selNoteId) return false;
    const n = f.clip.notes.find(n => n.id === this.selNoteId);
    if (!n) return false;
    Undo.push('Delete note');
    f.clip.notes.splice(f.clip.notes.indexOf(n), 1);
    this.selNoteId = null;
    this.redraw();
    Timeline.drawClip(this.clipId);
    toast('Note deleted');
    return true;
  },

  copySelected(cut) {
    if (!this.isOpen()) return false;
    const f = this.clip();
    if (!f || !this.selNoteId) return false;
    const n = f.clip.notes.find(n => n.id === this.selNoteId);
    if (!n) return false;
    UI.clipboard = { type: 'note', data: JSON.parse(JSON.stringify(n)) };
    if (cut) {
      Undo.push('Cut note');
      f.clip.notes.splice(f.clip.notes.indexOf(n), 1);
      this.selNoteId = null;
      this.redraw();
      Timeline.drawClip(this.clipId);
      toast(tr('toast_note_cut', 'Note cut'));
    } else {
      toast(tr('toast_note_copied', 'Note copied'));
    }
    return true;
  },

  paste() {
    if (!this.isOpen()) return false;
    const f = this.clip();
    if (!f || !UI.clipboard || UI.clipboard.type !== 'note') return false;
    Undo.push('Paste note');
    const n = JSON.parse(JSON.stringify(UI.clipboard.data));
    n.id = uid('note');
    n.start = n.start + n.length; // lands right after the original
    f.clip.notes.push(n);
    this.selNoteId = n.id;
    this.extendClipIfNeeded(n);
    this.redraw();
    Timeline.drawClip(this.clipId);
    toast(tr('toast_note_pasted', 'Note pasted'));
    return true;
  }
};
