// ---------- Automation: keyframe editor for volume, EQ and pan over time ----------
'use strict';

const Automation = {
  trackId: null,
  param: 'volume',
  pxb: 40,          // pixels per beat
  H: 150,
  PAD: 10,
  cv: null,
  wrap: null,

  RANGES: {
    volume: [0, 1.2],
    low: [-12, 12],
    mid: [-12, 12],
    high: [-12, 12],
    pan: [-1, 1]
  },
  PARAM_LABELS: {
    volume: 'Volume', low: 'EQ Low', mid: 'EQ Mid', high: 'EQ High', pan: 'Pan'
  },

  isOpen() { return Windows.isOpen('autom'); },

  paramLabel(p) { return tr('autoparam_' + p, this.PARAM_LABELS[p]); },

  track() { return getTrack(this.trackId); },

  open(trackId, param) {
    const first = S.tracks[0];
    this.trackId = getTrack(trackId) ? trackId : (first && first.id);
    this.param = this.RANGES[param] ? param : 'volume';
    if (!this.track()) { toast(tr('toast_add_instr_first', 'Add a track first'), 'red'); return; }

    const w = Windows.create('autom', tr('win_automation', 'Automation'), 'i-auto',
      { x: Math.max(20, window.innerWidth / 2 - 340), y: 150, width: 680 });

    const tools = document.createElement('div');
    tools.className = 'proll-tools';
    tools.innerHTML = `
      <select id="autoTrackSel" data-tip="${tr('tip_auto_track', 'Track')}"></select>
      <select id="autoParamSel" data-tip="${tr('tip_auto_param', 'Parameter to automate')}"></select>
      <span style="flex:1"></span>
      <button id="autoClear" class="fbtn" style="padding:4px 10px" data-tip="${tr('tip_auto_clear', 'Remove all keyframes')}">${tr('auto_clear', 'Clear')}</button>`;
    w.body.appendChild(tools);
    w.body.classList.add('proll-body');

    const tSel = tools.querySelector('#autoTrackSel');
    for (const t of S.tracks) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name;
      if (t.id === this.trackId) o.selected = true;
      tSel.appendChild(o);
    }
    tSel.addEventListener('change', () => { this.trackId = tSel.value; this.redraw(); });

    const pSel = tools.querySelector('#autoParamSel');
    for (const p of Engine.AUTOM_PARAMS) {
      const o = document.createElement('option');
      o.value = p; o.textContent = this.paramLabel(p);
      if (p === this.param) o.selected = true;
      pSel.appendChild(o);
    }
    pSel.addEventListener('change', () => { this.param = pSel.value; this.redraw(); });

    tools.querySelector('#autoClear').addEventListener('click', () => this.clear());

    const hint = document.createElement('div');
    hint.style.cssText = 'padding:6px 12px;font-size:10.5px;color:var(--faint);border-bottom:1px solid var(--line)';
    hint.textContent = tr('auto_hint', 'Click to add a point, drag to move, right-click to delete.');
    w.body.appendChild(hint);

    this.wrap = document.createElement('div');
    this.wrap.style.cssText = 'overflow-x:auto;overflow-y:hidden';
    this.cv = document.createElement('canvas');
    this.cv.style.cursor = 'crosshair';
    this.wrap.appendChild(this.cv);
    w.body.appendChild(this.wrap);

    w.refresh = () => this.redraw();
    this.bind();
    this.redraw();
    App.syncWindowButtons();
  },

  onStateRestore() {
    if (this.isOpen()) {
      if (!this.track()) { Windows.close('autom'); return; }
      this.redraw();
    }
  },

  gridWidth() { return Math.max(this.wrap ? this.wrap.clientWidth : 640, (songEndBeat() + 4) * this.pxb); },

  beatToX(b) { return this.PAD + b * this.pxb; },
  xToBeat(x) { return Math.max(0, (x - this.PAD) / this.pxb); },
  valueToY(v) {
    const [lo, hi] = this.RANGES[this.param];
    const f = (v - lo) / (hi - lo);
    return this.H - this.PAD - f * (this.H - 2 * this.PAD);
  },
  yToValue(y) {
    const [lo, hi] = this.RANGES[this.param];
    const f = (this.H - this.PAD - y) / (this.H - 2 * this.PAD);
    return clamp(lo + f * (hi - lo), lo, hi);
  },

  points() { return automPoints(this.track(), this.param); },

  redraw() {
    if (!this.isOpen() || !this.cv || !this.track()) return;
    const W = this.gridWidth();
    const H = this.H;
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = W * dpr; this.cv.height = H * dpr;
    this.cv.style.width = W + 'px'; this.cv.style.height = H + 'px';
    const g = this.cv.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#161310';
    g.fillRect(0, 0, W, H);

    // bar lines
    const barPx = this.pxb * 4;
    for (let x = this.PAD; x <= W; x += barPx) {
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(x, 0, 1, H);
    }
    // zero / default reference line
    const [lo, hi] = this.RANGES[this.param];
    if (lo < 0 && hi > 0) {
      const zy = this.valueToY(0);
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, zy); g.lineTo(W, zy); g.stroke();
      g.setLineDash([]);
    }

    const pts = this.points();
    const color = this.track().color || '#e07a3f';

    if (pts.length) {
      g.strokeStyle = color; g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, this.valueToY(pts[0].v));
      for (const p of pts) g.lineTo(this.beatToX(p.beat), this.valueToY(p.v));
      g.lineTo(W, this.valueToY(pts[pts.length - 1].v));
      g.stroke();
      for (const p of pts) {
        g.fillStyle = color;
        g.beginPath();
        g.arc(this.beatToX(p.beat), this.valueToY(p.v), 4.5, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#161310'; g.lineWidth = 1.5; g.stroke();
      }
    } else {
      g.fillStyle = 'rgba(255,255,255,0.28)';
      g.font = '11px -apple-system, sans-serif';
      g.fillText(tr('auto_empty', 'No keyframes. Click to add one.'), this.PAD + 6, H / 2);
    }

    // playhead
    const phx = this.beatToX(Engine.ctx && UI.playing ? Engine.currentBeat() : UI.playhead);
    g.fillStyle = 'rgba(86,182,166,0.9)';
    g.fillRect(phx, 0, 1.5, H);
  },

  pointAt(x, y) {
    const pts = this.points();
    for (const p of pts) {
      if (Math.hypot(this.beatToX(p.beat) - x, this.valueToY(p.v) - y) < 8) return p;
    }
    return null;
  },

  bind() {
    this.cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = this.cv.getBoundingClientRect();
      const p = this.pointAt(e.clientX - r.left, e.clientY - r.top);
      if (p) {
        Undo.push('Automation');
        const pts = this.points();
        pts.splice(pts.indexOf(p), 1);
        this.commit();
      }
    });

    this.cv.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const r = this.cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const pts = this.points();
      let p = this.pointAt(x, y);
      let pushed = false;
      if (!p) {
        Undo.push('Automation'); pushed = true;
        p = { beat: snapBeat(this.xToBeat(x), S.snap), v: this.yToValue(y) };
        pts.push(p);
        pts.sort((a, b) => a.beat - b.beat);
        this.commit();
      }
      const move = (ev) => {
        if (!pushed) { Undo.push('Automation'); pushed = true; }
        p.beat = snapBeat(this.xToBeat(ev.clientX - r.left), S.snap);
        p.v = this.yToValue(ev.clientY - r.top);
        pts.sort((a, b) => a.beat - b.beat);
        this.commit();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  },

  clear() {
    const pts = this.points();
    if (!pts.length) return;
    Undo.push('Automation');
    pts.length = 0;
    this.commit();
    toast(tr('toast_auto_cleared', 'Keyframes cleared'));
  },

  commit() {
    UI.dirty = true;
    UI.fileDirty = true;
    this.redraw();
    const t = this.track();
    if (t) Engine.rescheduleAutomation(t);
  }
};
