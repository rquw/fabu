// ---------- Automation: keyframe editor for volume, EQ and pan over time ----------
'use strict';

const Automation = {
  trackId: null,
  param: 'volume',
  fxTarget: null,   // { clipId, fx, key } when automating a dropped effect's param
  clipTarget: null, // { clipId, prop } when automating an audio clip's pitch / speed
  snapOn: true,     // snap keyframes to the grid
  pxb: 40,          // pixels per beat
  H: 150,
  PAD: 10,
  GUTTER: 40,       // left value-axis column (keeps labels off the graph)
  cv: null,
  wrap: null,

  RANGES: {
    volume: [0, 2],
    gain: [0, 4],
    low: [-12, 12],
    mid: [-12, 12],
    high: [-12, 12],
    pan: [-1, 1],
    drive: [0, 1],
    crush: [0, 1],
    filter: [200, 20000],
    transpose: [-96, 96],
    pitch: [-96, 96],
    speed: [0.05, 16]
  },
  PARAM_LABELS: {
    volume: 'Volume', gain: 'Gain', low: 'EQ Low', mid: 'EQ Mid', high: 'EQ High', pan: 'Pan',
    drive: 'Drive', crush: 'Crush', filter: 'Filter', transpose: 'Transpose'
  },

  // where a parameter "rests", drawn as a dashed guide so it's always findable
  DEFAULTS: { volume: 1, gain: 1, low: 0, mid: 0, high: 0, pan: 0, drive: 0, crush: 0, filter: 20000, transpose: 0, pitch: 0, speed: 1 },
  // initial visible slice of the huge no-limit ranges; scroll to reach the rest
  VIEWS: { transpose: [-12, 12], pitch: [-12, 12], speed: [0, 2], gain: [0, 2], volume: [0, 2] },
  viewLo: null, viewHi: null,   // current value-axis window

  defaultVal() {
    if (this.fxTarget) { const pd = this.fxDef(); return pd ? pd.def : 0; }
    if (this.clipTarget) return this.clipTarget.prop === 'speed' ? 1 : 0;
    return this.DEFAULTS[this.param] ?? 0;
  },
  resetView() {
    const [lo, hi] = this.range();
    let v = null;
    if (this.clipTarget) v = this.VIEWS[this.clipTarget.prop];
    else if (!this.fxTarget) v = this.VIEWS[this.param];
    this.viewLo = v ? Math.max(lo, v[0]) : lo;
    this.viewHi = v ? Math.min(hi, v[1]) : hi;
  },
  view() {
    if (this.viewLo == null || this.viewHi == null || !(this.viewHi > this.viewLo)) this.resetView();
    return [this.viewLo, this.viewHi];
  },
  // the editor fills whatever height the window is dragged to (like the piano roll)
  editorH() {
    const body = this.wrap ? this.wrap.closest('.fwin-body') : null;
    if (body && body.clientHeight) {
      let used = 0;
      for (const el of body.children) if (el !== this.wrap) used += el.offsetHeight;
      return clamp(body.clientHeight - used - 14, 110, 4000);
    }
    return this.H;
  },
  // 1/2/5-style steps so the axis reads 0, 5, 10 rather than 0, 48, 96
  niceStep(raw) {
    if (!(raw > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  },

  isOpen() { return Windows.isOpen('autom'); },

  paramLabel(p) { return tr('autoparam_' + p, this.PARAM_LABELS[p]); },

  track() { return getTrack(this.trackId); },

  // ----- target abstraction: a track param OR a dropped-effect param -----
  fxDef() {
    if (!this.fxTarget) return null;
    const d = FX_DEFS[this.fxTarget.fx.type];
    return d && d.p[this.fxTarget.key] ? d.p[this.fxTarget.key] : null;
  },
  // the [lo, hi] range of whatever we're editing
  range() {
    if (this.fxTarget) { const pd = this.fxDef(); return pd ? [pd.min, pd.max] : [0, 1]; }
    if (this.clipTarget) return this.RANGES[this.clipTarget.prop];
    return this.RANGES[this.param];
  },
  // the track we colour by / show the playhead against
  curTrack() {
    if (this.fxTarget) { const f = getClip(this.fxTarget.clipId); return f ? f.track : null; }
    if (this.clipTarget) { const f = getClip(this.clipTarget.clipId); return f ? f.track : null; }
    return getTrack(this.trackId);
  },
  // heading label for the current target
  targetLabel() {
    if (this.fxTarget) {
      const pd = this.fxDef();
      return fxName(this.fxTarget.fx.type) + ': ' + (pd ? tr(pd.labelKey, pd.labelFb) : this.fxTarget.key);
    }
    if (this.clipTarget) {
      const f = getClip(this.clipTarget.clipId);
      const nm = f ? (f.clip.name || tr('word_audio', 'Audio')) : tr('word_audio', 'Audio');
      return nm + ': ' + tr('autoparam_' + this.clipTarget.prop, this.clipTarget.prop === 'pitch' ? 'Pitch' : 'Speed');
    }
    return this.paramLabel(this.param);
  },

  open(trackId, param) {
    const first = S.tracks[0];
    this.fxTarget = null; this.clipTarget = null; this.viewLo = this.viewHi = null;
    this.trackId = getTrack(trackId) ? trackId : (first && first.id);
    this.param = this.RANGES[param] ? param : 'volume';
    if (!this.track()) { toast(tr('toast_add_instr_first', 'Add a track first'), 'red'); return; }
    this._openEditor();
  },

  // automate a dropped effect's parameter over time
  openFx(clipId, fx, key) {
    const found = getClip(clipId);
    if (!found || !fx) return;
    this.fxTarget = { clipId, fx, key }; this.clipTarget = null; this.viewLo = this.viewHi = null;
    this.trackId = found.track.id;
    this._openEditor();
  },

  // automate an audio clip's own pitch or speed over time
  openClip(clipId, prop) {
    const found = getClip(clipId);
    if (!found) return;
    this.clipTarget = { clipId, prop }; this.fxTarget = null; this.viewLo = this.viewHi = null;
    this.trackId = found.track.id;
    this._openEditor();
  },

  _openEditor() {
    const w = Windows.create('autom', tr('win_automation', 'Automation'), 'i-auto',
      { x: Math.max(20, window.innerWidth / 2 - 340), y: 150, width: 680, height: 340 });

    const tools = document.createElement('div');
    tools.className = 'proll-tools';
    if (this.fxTarget || this.clipTarget) {
      tools.innerHTML = `
        <span class="auto-fx-label">${this.targetLabel()}</span>
        <span style="flex:1"></span>
        <button id="autoClear" class="fbtn" style="padding:4px 10px" data-tip="${tr('tip_auto_clear', 'Remove all keyframes')}">${tr('auto_clear', 'Clear')}</button>`;
    } else {
      tools.innerHTML = `
        <select id="autoTrackSel" data-tip="${tr('tip_auto_track', 'Track')}"></select>
        <select id="autoParamSel" data-tip="${tr('tip_auto_param', 'Parameter to automate')}"></select>
        <span style="flex:1"></span>
        <button id="autoClear" class="fbtn" style="padding:4px 10px" data-tip="${tr('tip_auto_clear', 'Remove all keyframes')}">${tr('auto_clear', 'Clear')}</button>`;
    }
    w.body.appendChild(tools);
    w.body.classList.add('proll-body');

    if (!this.fxTarget && !this.clipTarget) {
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
      pSel.addEventListener('change', () => { this.param = pSel.value; this.viewLo = this.viewHi = null; this.redraw(); });
    }

    tools.querySelector('#autoClear').addEventListener('click', () => this.clear());
    // snap on/off toggle
    const snapBtn = document.createElement('button');
    snapBtn.className = 'fbtn pt-toggle' + (this.snapOn ? ' on' : '');
    snapBtn.style.cssText = 'padding:4px 10px';
    snapBtn.dataset.tip = tr('tip_auto_snap', 'Snap keyframes to the grid');
    snapBtn.textContent = tr('auto_snap', 'Snap');
    snapBtn.addEventListener('click', () => { this.snapOn = !this.snapOn; snapBtn.classList.toggle('on', this.snapOn); });
    tools.insertBefore(snapBtn, tools.querySelector('#autoClear'));

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
      // the automated target may be gone after a remote/undo state swap
      if (this.fxTarget) {
        const f = getClip(this.fxTarget.clipId);
        if (!f || !(f.clip.fx || []).includes(this.fxTarget.fx)) { Windows.close('autom'); return; }
      } else if (this.clipTarget) {
        if (!getClip(this.clipTarget.clipId)) { Windows.close('autom'); return; }
      } else if (!this.track()) { Windows.close('autom'); return; }
      this.redraw();
    }
  },

  // the span the automation actually covers: a dropped effect only exists for
  // the length of its clip, so keyframes can't sit before or after it
  contentRange() {
    const cid = this.fxTarget ? this.fxTarget.clipId : (this.clipTarget ? this.clipTarget.clipId : null);
    if (cid) { const f = getClip(cid); if (f) return [f.clip.start, f.clip.start + clipBeats(f.clip)]; }
    return [0, Math.max(4, songEndBeat())];
  },

  gridWidth() {
    const [b0, b1] = this.contentRange();
    return Math.max(this.wrap ? this.wrap.clientWidth : 640, (b1 - b0) * this.pxb + this.GUTTER + this.PAD);
  },

  beatToX(b) { return this.GUTTER + (b - this.contentRange()[0]) * this.pxb; },
  xToBeat(x) {
    const [b0, b1] = this.contentRange();
    return clamp(b0 + (x - this.GUTTER) / this.pxb, b0, b1);   // stay within the clip
  },
  snapB(x) { const b = this.xToBeat(x); return this.snapOn ? snapBeat(b, S.snap) : b; },
  valueToY(v) {
    const [lo, hi] = this.view();
    const H = this._H || this.H;
    const f = (v - lo) / ((hi - lo) || 1);
    return H - this.PAD - f * (H - 2 * this.PAD);
  },
  yToValue(y) {
    const [lo, hi] = this.view();
    const H = this._H || this.H;
    const f = (H - this.PAD - y) / (H - 2 * this.PAD);
    return clamp(lo + f * (hi - lo), lo, hi);
  },

  points() {
    if (this.fxTarget) {
      const fx = this.fxTarget.fx;
      if (!fx.autom) fx.autom = {};
      if (!fx.autom[this.fxTarget.key]) fx.autom[this.fxTarget.key] = [];
      return fx.autom[this.fxTarget.key];
    }
    if (this.clipTarget) {
      const f = getClip(this.clipTarget.clipId);
      if (!f) return [];
      if (!f.clip.autom) f.clip.autom = {};
      if (!f.clip.autom[this.clipTarget.prop]) f.clip.autom[this.clipTarget.prop] = [];
      return f.clip.autom[this.clipTarget.prop];
    }
    return automPoints(this.track(), this.param);
  },

  // faint melodic reference: the notes of the relevant clip(s), by pitch
  drawNoteBg(g, W, H, b0, b1) {
    if (this.clipTarget) return;   // audio clip has no notes to show
    const clips = [];
    if (this.fxTarget) { const f = getClip(this.fxTarget.clipId); if (f && f.clip.kind === 'midi') clips.push(f.clip); }
    else { const t = this.track(); if (t) for (const c of t.clips) if (c.kind === 'midi') clips.push(c); }
    let pMin = 127, pMax = 0, any = false;
    for (const c of clips) for (const n of c.notes) { any = true; if (n.pitch < pMin) pMin = n.pitch; if (n.pitch > pMax) pMax = n.pitch; }
    if (!any) return;
    if (pMax - pMin < 6) { pMin -= 3; pMax += 3; }
    const pad = 8;
    g.fillStyle = 'rgba(255,255,255,0.07)';
    for (const c of clips) for (const n of c.notes) {
      const bx = c.start + n.start;
      if (bx > b1 || bx + n.length < b0) continue;
      const x = this.beatToX(bx);
      const w = Math.max(2, n.length * this.pxb - 1);
      const f = (n.pitch - pMin) / (pMax - pMin || 1);
      const y = (H - pad) - f * (H - pad * 2);
      g.fillRect(x, y - 1.5, w, 3);
    }
  },

  fmtVal(v) {
    if (this.clipTarget) return this.clipTarget.prop === 'speed' ? (+v.toFixed(2)) + 'x' : (+v.toFixed(1)) + '';
    if (!this.fxTarget && this.param === 'filter') return v >= 1000 ? (Math.round(v / 100) / 10) + 'k' : String(Math.round(v));
    if (!this.fxTarget && ['volume', 'gain', 'drive', 'crush'].includes(this.param)) return Math.round(v * 100) + '';
    if (this.fxTarget) return String(Math.round(v * 100) / 100);
    return String(Math.round(v * 10) / 10);   // track params: 1 decimal is plenty
  },

  redraw() {
    if (!this.isOpen() || !this.cv || !this.curTrack()) return;
    const W = this.gridWidth();
    const H = this._H = this.editorH();   // fills the window, like the piano roll
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = W * dpr; this.cv.height = H * dpr;
    this.cv.style.width = W + 'px'; this.cv.style.height = H + 'px';
    const g = this.cv.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#161310';
    g.fillRect(0, 0, W, H);

    const [b0, b1] = this.contentRange();
    const [vlo, vhi] = this.view();

    // faint notes behind the curve so you can line keyframes up to the music
    this.drawNoteBg(g, W, H, b0, b1);

    // left value-axis gutter, so labels never sit on the graph
    g.fillStyle = '#120f0c'; g.fillRect(0, 0, this.GUTTER, H);
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(this.GUTTER - 1, 0, 1, H);
    // value gridlines at friendly 1/2/5 steps across the visible window
    g.textBaseline = 'middle'; g.textAlign = 'right'; g.font = '9px -apple-system, sans-serif';
    const vstep = this.niceStep((vhi - vlo) / Math.max(3, Math.round(H / 46)));
    for (let i = Math.ceil(vlo / vstep - 1e-9); i * vstep <= vhi + 1e-9; i++) {
      const v = i * vstep;
      const y = this.valueToY(v);
      if (y < 6 || y > H - 6) continue;
      g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(this.GUTTER, y, W - this.GUTTER, 1);
      g.fillStyle = 'rgba(255,255,255,0.4)'; g.fillText(this.fmtVal(v), this.GUTTER - 5, y);
    }
    g.textAlign = 'left';
    // bar lines, aligned to real bars inside the clip's span
    for (let bb = Math.ceil(b0 / 4) * 4; bb <= b1 + 1e-6; bb += 4) {
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(this.beatToX(bb), 0, 1, H);
    }
    // dashed guide at the parameter's resting value (1x speed, 0 st, ...)
    const dv = this.defaultVal();
    if (dv >= vlo && dv <= vhi) {
      const zy = this.valueToY(dv);
      g.strokeStyle = 'rgba(255,255,255,0.22)';
      g.setLineDash([4, 4]); g.beginPath(); g.moveTo(this.GUTTER, zy); g.lineTo(W, zy); g.stroke();
      g.setLineDash([]);
    }

    const pts = this.points();
    const color = (this.curTrack() && this.curTrack().color) || '#e07a3f';

    if (pts.length) {
      g.strokeStyle = color; g.lineWidth = 2;
      g.beginPath();
      g.moveTo(this.GUTTER, this.valueToY(pts[0].v));
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
      g.font = '11px -apple-system, sans-serif'; g.textBaseline = 'alphabetic';
      g.fillText(tr('auto_empty', 'No keyframes. Click to add one.'), this.GUTTER + 10, H - 12);
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
    // scroll = pan the value window up/down (how you reach the far ends of the
    // no-limit ranges); ctrl/cmd+scroll zooms the window around the cursor
    this.cv.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;   // sideways = lane scroll
      e.preventDefault();
      const [lo, hi] = this.range();
      let [vlo, vhi] = this.view();
      const span = vhi - vlo;
      if (e.ctrlKey || e.metaKey) {
        const r = this.cv.getBoundingClientRect();
        const at = this.yToValue(e.clientY - r.top);
        const ns = clamp(span * (e.deltaY > 0 ? 1.15 : 1 / 1.15), (hi - lo) / 400, hi - lo);
        const frac = span ? (at - vlo) / span : 0.5;
        vlo = at - ns * frac; vhi = vlo + ns;
      } else {
        const d = -e.deltaY * span / 300;   // wheel up shows higher values
        vlo += d; vhi += d;
      }
      if (vhi > hi) { vlo -= vhi - hi; vhi = hi; }
      if (vlo < lo) { vhi += lo - vlo; vlo = lo; }
      this.viewLo = Math.max(lo, vlo); this.viewHi = Math.min(hi, vhi);
      this.redraw();
    }, { passive: false });

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
        p = { beat: this.snapB(x), v: this.yToValue(y) };
        pts.push(p);
        pts.sort((a, b) => a.beat - b.beat);
        this.commit();
      }
      const move = (ev) => {
        if (!pushed) { Undo.push('Automation'); pushed = true; }
        p.beat = this.snapB(ev.clientX - r.left);
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
    // light up the "A" dot in the clip settings right away (it reflects whether
    // the param has keyframes) instead of only after reselecting the clip
    if (typeof Windows !== 'undefined' && Windows.isOpen && Windows.isOpen('inspector')) {
      const w = Windows.wins.get('inspector'); if (w && w.refresh) w.refresh();
    }
    if (this.fxTarget || this.clipTarget) {
      // speed/pitch keyframes change the clip's real length: resize + redraw
      // its block live so the timeline always shows what will actually play
      if (this.clipTarget) {
        const f = getClip(this.clipTarget.clipId);
        if (f) {
          const el = Timeline.lanes.querySelector(`[data-clip-id="${f.clip.id}"]`);
          if (el) {
            el.style.width = Math.max(10, clipBeats(f.clip) * UI.zoom - 2) + 'px';
            Timeline.drawClipCanvas(f.clip, el, el.querySelector('canvas'));
          }
        }
      }
      // effect / audio-source nodes are rebuilt from scratch, so re-collect the
      // schedule to pick up the new keyframes (and re-voice any sounding notes)
      if (UI.playing) { Engine.reschedule(); Engine.applyLiveClipEdits && Engine.applyLiveClipEdits(); }
      if (typeof Sync !== 'undefined' && Sync.admitted && !Sync.applyingRemote) Sync.broadcast();
    } else {
      const t = this.track();
      if (t) Engine.rescheduleAutomation(t);
    }
  }
};
