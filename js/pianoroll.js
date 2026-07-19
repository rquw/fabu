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
        this.selNoteIds = new Set([n.id]);
        this.selNoteId = n.id;
        this.extendClipIfNeeded(n);
        Engine.previewNote(f.track, n.pitch, 0.25);
        toast(tr('toast_note_added', 'Note {name} added', { name: noteName(n.pitch) }));
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
