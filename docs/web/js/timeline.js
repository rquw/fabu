// ---------- timeline ----------
'use strict';

const TRACK_H = 84;
const AUTOM_H = 52;
const AUTOM_HEAD_H = 22;

function autoLanes(track) { return (track && track.autoLanes) || []; }
function automOpen(track) { return autoLanes(track).length > 0 && !track.autoCollapsed; }
function trackHeight(track) {
  const n = autoLanes(track).length;
  if (!n) return TRACK_H;
  return TRACK_H + AUTOM_HEAD_H + (track.autoCollapsed ? 0 : n * AUTOM_H);
}
function trackTop(idx) {
  let y = 0;
  for (let i = 0; i < idx && i < S.tracks.length; i++) y += trackHeight(S.tracks[i]);
  return y;
}
function tracksHeight() { return trackTop(S.tracks.length); }
function trackAtY(y) {
  let acc = 0;
  for (let i = 0; i < S.tracks.length; i++) {
    const h = trackHeight(S.tracks[i]);
    if (y < acc + h) return i;
    acc += h;
  }
  return Math.max(0, S.tracks.length - 1);
}

const INSTR_CATS = [
  { key: 'cat_keys', label: 'Keys & Piano', ids: ['rpiano', 'rupright', 'epiano', 'organ'] },
  { key: 'cat_mallets', label: 'Mallets & Bells', ids: ['rvibes', 'rglock', 'bell'] },
  { key: 'cat_strings', label: 'Strings', ids: ['rharp', 'strings'] },
  { key: 'cat_wind', label: 'Wind & Brass', ids: ['rflute', 'rsax', 'rtrumpet'] },
  { key: 'cat_synth', label: 'Synth', ids: ['synth', 'pad', 'pluck'] },
  { key: 'cat_guitar', label: 'Guitar', ids: ['reguitar', 'rguitar'] },
  { key: 'cat_bass', label: 'Bass', ids: ['bass', 'sub'] },
  { key: 'cat_drums', label: 'Drums', ids: ['drums', 'drumkit'] }
];

const Timeline = {
  lanes: null,
  ruler: null,
  scroller: null,
  rafId: null,

  init() {
    this.lanes = $('#lanes');
    this.ruler = $('#ruler');
    this.scroller = $('#tlScroll');

    this.scroller.addEventListener('scroll', () => {
      $('#trackHeads').scrollTop = this.scroller.scrollTop;
      this.drawRuler();
      const vw = this.scroller.clientWidth;
      const from = (this.scroller.scrollLeft - vw * 0.4) / UI.zoom;
      const to = (this.scroller.scrollLeft + vw * 1.4) / UI.zoom;
      if (this._viewFrom == null || from < this._viewFrom || to > this._viewTo) this.renderSoon();
    });

    $('#headsCol').addEventListener('wheel', (e) => {
      this.scroller.scrollTop += e.deltaY;
    }, { passive: true });

    this.scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return; // let normal two-finger scrolling through
      e.preventDefault();
      this.setZoom(UI.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    this.ruler.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;        // right-click is the marker menu, not a drag
      const inLoopStrip = (e.clientY - this.ruler.getBoundingClientRect().top) < 11;
      if (e.shiftKey || inLoopStrip) {
        const anchor = snapBeat(this.xToBeat(e.clientX), S.snap || 1);
        const setLoop = (ev) => {
          const b = snapBeat(this.xToBeat(ev.clientX), S.snap || 1);
          S.loopStart = Math.max(0, Math.min(anchor, b));
          S.loopEnd = Math.max(anchor, b);
          if (S.loopEnd - S.loopStart < 0.25) S.loopEnd = S.loopStart + (S.snap || 1);
          this.drawRuler();
        };
        setLoop(e);
        const done = () => {
          window.removeEventListener('mousemove', setLoop);
          window.removeEventListener('mouseup', done);
          this.drawRuler();
          UI.dirty = UI.fileDirty = true;
          if (!S.loopOn) App.hintLoop('made');
        };
        window.addEventListener('mousemove', setLoop);
        window.addEventListener('mouseup', done);
        return;
      }
      const scrubbing = !UI.playing && Engine.scrubOn();
      const move = (ev) => {
        const beat = snapBeat(this.xToBeat(ev.clientX), S.snap);
        Engine.seek(beat);
        if (scrubbing) Engine.scrub(beat);
      };
      move(e);
      const up = () => {
        if (scrubbing) Engine.scrubEnd();
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    this.ruler.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openRulerMenu(e.clientX, e.clientY);
    });

    this.lanes.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!(e.target === this.lanes || e.target.classList.contains('lane'))) return;
      const rect = this.lanes.getBoundingClientRect();
      const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
      const idx = trackAtY(y0);
      if (!e.shiftKey) App.selectClip(null);
      if (S.tracks[idx]) App.selectTrack(S.tracks[idx].id);
      const preSel = new Set(UI.selClipIds);

      const box = document.createElement('div');
      box.className = 'marquee';
      this.lanes.appendChild(box);
      let dragging = false;

      const move = (ev) => {
        const x1 = ev.clientX - rect.left, y1 = ev.clientY - rect.top;
        if (!dragging && Math.abs(x1 - x0) < 4 && Math.abs(y1 - y0) < 4) return;
        dragging = true;
        const L = Math.min(x0, x1), Tp = Math.min(y0, y1), R = Math.max(x0, x1), B = Math.max(y0, y1);
        box.style.cssText = `display:block;left:${L}px;top:${Tp}px;width:${R - L}px;height:${B - Tp}px`;
        const hits = [];
        S.tracks.forEach((t, ti) => {
          const laneY = trackTop(ti);
          if (laneY >= B || laneY + TRACK_H <= Tp) return;
          for (const c of t.clips) {
            const cx = c.start * UI.zoom, cw = Math.max(10, clipBeats(c) * UI.zoom);
            if (cx < R && cx + cw > L) hits.push(c.id);
          }
        });
        App.selectClipSet(e.shiftKey ? [...new Set([...preSel, ...hits])] : hits);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        box.remove();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    this.lanes.addEventListener('dblclick', (e) => {
      if (!e.target.classList.contains('lane')) return;
      const idx = trackAtY(e.clientY - this.lanes.getBoundingClientRect().top);
      const track = S.tracks[idx];
      if (!track) return;
      const beat = snapBeat(this.xToBeat(e.clientX), S.snap || 1);
      if (track.kind === 'midi') {
        Undo.push('New pattern');
        const clip = {
          id: uid('clip'), kind: 'midi', name: 'Pattern', by: authorName(),
          start: this.firstFreeStart(track, 4, beat, null), length: 4, notes: []
        };
        track.clips.push(clip);
        this.render();
        App.selectClip(clip.id);
        if (typeof Sync !== 'undefined') Sync.logAction('add_pattern', clip.name);
        toast(tr('toast_pattern_added', 'Pattern added'));
        if (typeof Tutor !== 'undefined') Tutor.maybeStart(clip.id);
      } else {
        toast(tr('toast_drop_here', 'Drop an audio file here, or record with R'));
      }
    });

    this.scroller.addEventListener('scroll', () => {
      if (this._following) return;
      if (this._followLeft != null && Math.abs(this.scroller.scrollLeft - this._followLeft) < 2) return;
      if (UI.playing) this._userScrolled = true;
    });

    this.initDropZone();
    this.startPlayheadLoop();
  },

  xToBeat(clientX) {
    const r = this.lanes.getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / UI.zoom);
  },

  totalBeats() {
    const viewportBeats = Math.ceil(this.scroller.clientWidth / UI.zoom);
    return Math.max(songEndBeat() + 32, viewportBeats + 8, 64);
  },

  laneBounds(track, clip, origStart, origEnd) {
    let left = 0, right = Infinity;
    for (const o of track.clips) {
      if (o === clip) continue;
      const oS = o.start, oE = o.start + clipBeats(o);
      if (oE <= origStart + 1e-6) left = Math.max(left, oE);
      else if (oS >= origEnd - 1e-6) right = Math.min(right, oS);
    }
    return { left, right };
  },
  // scroll just enough to bring a beat into view
  revealBeat(beat) {
    const sc = this.scroller;
    if (!sc || !sc.clientWidth) return;
    const x = beat * UI.zoom;
    const l = sc.scrollLeft;
    if (x < l + 40) sc.scrollLeft = Math.max(0, x - 80);
    else if (x > l + sc.clientWidth - 60) sc.scrollLeft = Math.max(0, x - sc.clientWidth + 140);
  },

  nearestFreeStart(track, len, desired, ignore) {
    desired = Math.max(0, desired);
    const overlaps = (s) => track.clips.some(c => c !== ignore &&
      s < c.start + clipBeats(c) - 1e-6 && s + len > c.start + 1e-6);
    if (!overlaps(desired)) return desired;
    const cands = [0];
    for (const c of track.clips) {
      if (c === ignore) continue;
      cands.push(c.start + clipBeats(c));   // butt to its right
      cands.push(c.start - len);            // butt to its left
    }
    const valid = cands.map(s => Math.max(0, s)).filter(s => !overlaps(s));
    valid.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired));
    return valid.length ? valid[0] : desired;
  },
  firstFreeStart(track, len, from, ignore) {
    const spans = track.clips
      .filter(c => c !== ignore)
      .map(c => [c.start, c.start + clipBeats(c)])
      .sort((a, b) => a[0] - b[0]);
    let start = Math.max(0, from);
    for (const [s, e] of spans) {
      if (start + len <= s + 1e-6) break;   // fits before this clip
      if (start < e) start = e;             // pushed past it
    }
    return start;
  },

  // ---------- full render ----------
  renderSoon() {
    if (this._renderRaf) return;
    this._renderRaf = requestAnimationFrame(() => { this._renderRaf = null; this.render(); });
  },

  redrawClip(clip) {
    const el = this.lanes.querySelector(`[data-clip-id="${clip.id}"]`);
    if (!el) return;
    el.style.width = Math.max(10, clipBeats(clip) * UI.zoom - 2) + 'px';
    this.drawClipCanvas(clip, el, el.querySelector('canvas'));
  },

  render() {
    if (this._renderRaf) { cancelAnimationFrame(this._renderRaf); this._renderRaf = null; }
    for (const id of [...UI.selClipIds]) if (!getClip(id)) UI.selClipIds.delete(id);
    if (UI.selClipId && !UI.selClipIds.has(UI.selClipId)) UI.selClipId = [...UI.selClipIds].pop() || null;

    const width = this.totalBeats() * UI.zoom;
    this.lanes.style.width = width + 'px';
    this.ruler.style.width = width + 'px';

    for (const el of [...this.lanes.children]) {
      if (el.id !== 'playhead' && el.id !== 'dropGhost' && el.id !== 'cursorLayer' && el.id !== 'remotePhLayer') el.remove();
    }

    const beat = UI.zoom;
    const bar = UI.zoom * beatsPerBar();
    let clipCount = 0;
    const firstMidiIdx = S.tracks.findIndex(t => t.kind === 'midi');
    const vw = this.scroller ? this.scroller.clientWidth : 1200;
    const sl = this.scroller ? this.scroller.scrollLeft : 0;
    const viewFrom = (sl - vw) / UI.zoom;          // one screen of margin each side
    const viewTo = (sl + vw * 2) / UI.zoom;
    this._viewFrom = viewFrom; this._viewTo = viewTo;
    for (const t of S.tracks) {
      const lane = document.createElement('div');
      lane.className = 'lane' + (t.id === UI.selTrackId ? ' sel' : '');
      lane.dataset.trackId = t.id;
      lane.style.backgroundImage =
        `repeating-linear-gradient(90deg, rgba(255,255,255,0.07) 0 1px, transparent 1px ${bar}px),` +
        `repeating-linear-gradient(90deg, rgba(255,255,255,0.028) 0 1px, transparent 1px ${beat}px)`;
      this.lanes.appendChild(lane);
      for (const c of t.clips) {
        clipCount++;
        if (c.start > viewTo || c.start + clipBeats(c) < viewFrom) continue;   // off screen
        lane.appendChild(this.buildClip(c, t));
      }
      if (autoLanes(t).length) {
        this.lanes.appendChild(this.buildAutomHead(t, width));
        if (!t.autoCollapsed) {
          for (const param of autoLanes(t)) this.lanes.appendChild(this.buildAutomLane(t, param, width));
        }
      }
    }

    if (clipCount === 0 && firstMidiIdx >= 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.style.top = (trackTop(firstMidiIdx) + TRACK_H / 2 - 18) + 'px';
      hint.textContent = tr('empty_hint', 'Double-click here to add a pattern');
      this.lanes.appendChild(hint);
    }

    this.lanes.style.height = (tracksHeight() + 90) + 'px';
    $('#playhead').style.height = (tracksHeight() + 30) + 'px';
    this.renderHeads();
    this.drawRuler();
    this.updatePlayhead();
    if (typeof Sync !== 'undefined') { Sync.renderCursors(); Sync.renderRemotePlayheads(); Sync.updateLockVisuals(); }
  },

  // ---------- automation lanes ----------
  automRange(param) {
    const r = Automation.RANGES[param] || [0, 1];
    return { min: r[0], max: r[1] };
  },

  buildAutomHead(track, width) {
    const el = document.createElement('div');
    el.className = 'autom-head' + (track.autoCollapsed ? ' collapsed' : '');
    el.style.width = width + 'px';
    el.style.height = AUTOM_HEAD_H + 'px';
    const n = autoLanes(track).length;
    el.innerHTML = `
      <button class="ah-fold" data-tip="${track.autoCollapsed
        ? tr('autom_expand', 'Show the automation') : tr('autom_collapse', 'Fold the automation away')}">
        <svg class="ic"><use href="#i-chev"/></svg>
      </button>
      <span class="ah-title">${n === 1
        ? tr('autom_title', 'Automation') : tr('autom_title_pl', 'Automations')}</span>
      <span class="ah-count">${n}</span>`;
    const fold = () => {
      track.autoCollapsed = !track.autoCollapsed;
      UI.dirty = UI.fileDirty = true;
      this.render();
    };
    el.querySelector('.ah-fold').addEventListener('click', (e) => { e.stopPropagation(); fold(); });
    el.addEventListener('click', fold);
    return el;
  },

  buildAutomLane(track, param, width) {
    const el = document.createElement('div');
    el.className = 'autom-lane';
    el.dataset.trackId = track.id;
    el.dataset.param = param;
    el.style.width = width + 'px';
    el.style.height = AUTOM_H + 'px';

    const label = document.createElement('div');
    label.className = 'al-label';
    label.innerHTML = `<span class="al-name">${escapeHtml(Automation.paramLabel(param))}</span>` +
      `<button class="al-del" data-tip="${tr('autom_delete', 'Delete this automation')}">` +
      `<svg class="ic"><use href="#i-trash"/></svg></button>`;
    label.querySelector('.al-del').addEventListener('mousedown', (e) => {
      e.stopPropagation();
      this.deleteAutomLane(track, param);
    });
    el.appendChild(label);

    const cv = document.createElement('canvas');
    cv.className = 'al-canvas';
    el.appendChild(cv);
    this.drawAutomLane(track, param, cv, width);
    this.wireAutomLane(el, cv, track, param);
    return el;
  },

  drawAutomLane(track, param, cv, width) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.min(width, Math.floor(32000 / dpr));
    const h = AUTOM_H;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const { min, max } = this.automRange(param);
    const pad = 7;
    const yOf = (v) => {
      const f = (v - min) / (max - min || 1);
      return h - pad - clamp(f, 0, 1) * (h - pad * 2);
    };
    const xOf = (b) => b * UI.zoom;

    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, Math.round(yOf((min + max) / 2)) + 0.5);
    g.lineTo(w, Math.round(yOf((min + max) / 2)) + 0.5); g.stroke();

    const pts = (track.autom && track.autom[param]) || [];
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e07a3f';

    g.beginPath();
    const step = Math.max(1, Math.round(1 / (UI.zoom / 8)));
    let started = false;
    for (let px = 0; px <= w; px += step) {
      const b = px / UI.zoom;
      const v = automValueAt(track, param, b);
      if (v == null) continue;
      const y = yOf(v);
      if (!started) { g.moveTo(px, y); started = true; } else g.lineTo(px, y);
    }
    if (started) {
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.stroke();
      g.lineTo(w, h); g.lineTo(0, h); g.closePath();
      g.fillStyle = accent.startsWith('#')
        ? accent + '22'
        : 'rgba(224,122,63,0.13)';
      g.fill();
    }

    for (const p of pts) {
      const x = xOf(p.beat), y = yOf(p.v);
      if (x < -8 || x > w + 8) continue;
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2);
      g.fillStyle = accent; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1.5; g.stroke();
    }

    if (!pts.length) {
      g.fillStyle = 'rgba(255,255,255,0.3)';
      g.font = '11px system-ui, sans-serif';
      g.fillText(tr('autom_empty', 'Click to add a point'), 78, h / 2 + 4);
    }
  },

  wireAutomLane(el, cv, track, param) {
    const { min, max } = this.automRange(param);
    const pad = 7;
    const valueAtY = (y) => {
      const f = 1 - clamp((y - pad) / (AUTOM_H - pad * 2), 0, 1);
      return min + f * (max - min);
    };
    const hit = (bx, by) => {
      const pts = (track.autom && track.autom[param]) || [];
      for (let i = pts.length - 1; i >= 0; i--) {
        const x = pts[i].beat * UI.zoom;
        const f = (pts[i].v - min) / (max - min || 1);
        const y = AUTOM_H - pad - clamp(f, 0, 1) * (AUTOM_H - pad * 2);
        if (Math.abs(x - bx) < 7 && Math.abs(y - by) < 9) return i;
      }
      return -1;
    };
    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const { x, y } = local(e);
      const i = hit(x, y);
      const pts = track.autom && track.autom[param];
      if (i < 0 || !pts) return;
      ctxMenu({ currentTarget: cv, stopPropagation() {} }, [
        [tr('autom_del_point', 'Remove this point'), () => {
          Undo.push('Automation');
          pts.splice(i, 1);
          UI.dirty = UI.fileDirty = true;
          Engine.rescheduleAutomation(track);
          this.render();
        }],
        [tr('autom_curve', 'Curve shape'), () => Automation.open(track.id, param)],
        [tr('autom_clear', 'Clear this lane'), () => {
          Undo.push('Automation');
          track.autom[param] = [];
          UI.dirty = UI.fileDirty = true;
          Engine.rescheduleAutomation(track);
          this.render();
        }]
      ]);
    });

    cv.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();               // not a clip drag, not a track select
      App.selectTrack(track.id);
      const { x, y } = local(e);
      if (!track.autom) track.autom = {};
      if (!track.autom[param]) track.autom[param] = [];
      const pts = track.autom[param];

      Undo.push('Automation');
      let i = hit(x, y);
      if (i < 0) {
        const beat = Math.max(0, snapBeat(x / UI.zoom, S.snap));
        pts.push({ beat, v: valueAtY(y) });
        pts.sort((a, b) => a.beat - b.beat);
        i = pts.findIndex(p => p.beat === beat);
      }

      const move = (ev) => {
        const l = local(ev);
        const p = pts[i];
        if (!p) return;
        p.beat = Math.max(0, snapBeat(l.x / UI.zoom, S.snap));
        p.v = valueAtY(l.y);
        pts.sort((a, b) => a.beat - b.beat);
        i = pts.indexOf(p);
        this.drawAutomLane(track, param, cv, parseFloat(el.style.width));
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        UI.dirty = UI.fileDirty = true;
        Engine.rescheduleAutomation(track);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      this.drawAutomLane(track, param, cv, parseFloat(el.style.width));
    });
  },

  deleteAutomLane(track, param) {
    const had = track.autom && track.autom[param] && track.autom[param].length;
    Undo.push('Automation');
    if (track.autom) delete track.autom[param];
    const i = (track.autoLanes || []).indexOf(param);
    if (i >= 0) track.autoLanes.splice(i, 1);
    UI.dirty = UI.fileDirty = true;
    Engine.rescheduleAutomation(track);
    this.render();
    if (had) toast(tr('toast_autom_deleted', '{name} automation deleted', { name: Automation.paramLabel(param) }));
  },

  toggleAutomLane(trackId, param, on) {
    const t = getTrack(trackId);
    if (!t) return;
    if (!t.autoLanes) t.autoLanes = [];
    const i = t.autoLanes.indexOf(param);
    const want = on == null ? i < 0 : on;
    if (want && i < 0) { t.autoLanes.push(param); t.autoCollapsed = false; }
    else if (!want && i >= 0) t.autoLanes.splice(i, 1);
    UI.dirty = UI.fileDirty = true;
    this.render();
  },

  openAutomMenu(e, track) {
    const open = autoLanes(track);
    const items = Engine.AUTOM_PARAMS.map(p => [
      (open.includes(p) ? '\u2713 ' : '   ') + Automation.paramLabel(p),
      () => this.toggleAutomLane(track.id, p)
    ]);
    ctxMenu(e, items);
  },

  drawRuler() {
    let cv = this.ruler.querySelector('canvas');
    if (!cv) {
      cv = document.createElement('canvas');
      this.ruler.appendChild(cv);
    }
    const w = this.scroller.clientWidth;
    const h = 30;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    cv.style.position = 'sticky';
    cv.style.left = '0';
    cv.style.display = 'block';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const scrollX = this.scroller.scrollLeft;
    const bpb = beatsPerBar();
    const firstBar = Math.floor(scrollX / (UI.zoom * bpb));
    const lastBar = Math.ceil((scrollX + w) / (UI.zoom * bpb));
    ctx.font = '600 10px -apple-system, sans-serif';
    for (let b = firstBar; b <= lastBar; b++) {
      const x = b * UI.zoom * bpb - scrollX;
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(x, 14, 1, 16);
      ctx.fillStyle = '#8b91a7';
      ctx.fillText(String(b + 1), x + 4, 12);
      if (UI.zoom >= 24) {
        for (let q = 1; q < 4; q++) {
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.fillRect(x + q * UI.zoom, 22, 1, 8);
        }
      }
    }

    if (S.loopEnd > S.loopStart) {
      const lx = S.loopStart * UI.zoom - scrollX;
      const lw = (S.loopEnd - S.loopStart) * UI.zoom;
      ctx.fillStyle = S.loopOn ? 'rgba(224,122,63,0.30)' : 'rgba(255,255,255,0.07)';
      ctx.fillRect(lx, 0, lw, 11);
      ctx.fillStyle = S.loopOn ? 'var(--accent)' : 'rgba(255,255,255,0.28)';
      ctx.fillStyle = S.loopOn ? '#e07a3f' : 'rgba(255,255,255,0.3)';
      ctx.fillRect(lx, 0, 2, 11);
      ctx.fillRect(lx + lw - 2, 0, 2, 11);
    }

    for (const mk of (S.markers || [])) {
      const mx = mk.beat * UI.zoom - scrollX;
      if (mx < -60 || mx > w + 60) continue;
      ctx.fillStyle = '#56b6a6';
      ctx.fillRect(mx, 0, 1.5, h);
      ctx.font = '700 9px -apple-system, sans-serif';
      const tw = ctx.measureText(mk.name).width;
      ctx.fillRect(mx, 0, tw + 8, 11);
      ctx.fillStyle = '#0d1117';
      ctx.fillText(mk.name, mx + 4, 8.5);
      ctx.font = '600 10px -apple-system, sans-serif';
    }
  },

  // ---------- track headers ----------
  renderHeads() {
    const box = $('#trackHeads');
    box.innerHTML = '';
    for (const t of S.tracks) {
      const el = document.createElement('div');
      el.className = 'thead' + (t.id === UI.selTrackId ? ' sel' : '');
      el.style.height = trackHeight(t) + 'px';
      el.dataset.trackId = t.id;

      const top = document.createElement('div');
      top.className = 'thead-top';
      const dot = document.createElement('div');
      dot.className = 'tcolor';
      dot.style.background = t.color;
      dot.dataset.tip = tr('tip_track_color', 'Track colour');
      dot.addEventListener('click', (e) => { e.stopPropagation(); this.openColorMenu(t, dot); });
      const name = document.createElement('input');
      name.className = 'tname';
      name.value = t.name;
      name.spellcheck = false;
      name.dataset.tip = tr('tip_track_name', 'Track name');
      name.addEventListener('change', () => {
        Undo.push('Rename track');
        t.name = name.value || t.name;
        this.render(); Windows.refreshAll(); KeysPanel.refreshTracks();
      });
      name.addEventListener('focus', () => App.selectTrack(t.id));
      const del = document.createElement('button');
      del.className = 'tdel';
      del.dataset.tip = tr('tip_track_delete', 'Delete this track and its clips');
      del.innerHTML = '<svg class="ic"><use href="#i-trash"/></svg>';
      del.addEventListener('click', () => App.deleteTrack(t.id));
      top.append(dot, name, del);

      const mid = document.createElement('div');
      mid.className = 'thead-mid';
      if (t.kind === 'midi') {
        const btn = document.createElement('button');
        btn.className = 'tinst-btn';
        btn.dataset.tip = tr('tip_track_instr', 'Instrument sound');
        btn.innerHTML = `<span class="tinst-name">${instrLabel(t.instrument)}</span><span class="tinst-chev">▾</span>`;
        btn.addEventListener('click', (e) => { e.stopPropagation(); this.openInstrMenu(t, btn); });
        mid.appendChild(btn);
        if (resolveInstrument(t.instrument)) {
          const edit = document.createElement('button');
          edit.className = 'tinst-edit';
          edit.dataset.tip = tr('tip_edit_instr', 'Edit this instrument');
          edit.innerHTML = '<svg class="ic"><use href="#i-edit"/></svg>';
          edit.addEventListener('click', (e) => { e.stopPropagation(); Sampler.open(t.id, t.instrument); });
          const del = document.createElement('button');
          del.className = 'tinst-edit tinst-del';
          del.dataset.tip = tr('tip_delete_instr', 'Delete this instrument');
          del.innerHTML = '<svg class="ic"><use href="#i-trash"/></svg>';
          del.addEventListener('click', (e) => { e.stopPropagation(); App.deleteInstrument(t.instrument); });
          mid.append(edit, del);
        }
      } else {
        const k = document.createElement('span');
        k.className = 'tkind';
        k.textContent = t.kind === 'group' ? tr('track_group', 'GROUP') : tr('track_audio', 'AUDIO');
        mid.appendChild(k);
      }
      const mBtn = document.createElement('button');
      mBtn.className = 'ms-btn mute' + (t.mute ? ' on' : '');
      mBtn.textContent = tr('mix_mute', 'M');
      mBtn.dataset.tip = tr('tip_mute', 'Mute this track');
      mBtn.addEventListener('click', () => App.toggleMute(t));
      const sBtn = document.createElement('button');
      sBtn.className = 'ms-btn solo' + (t.solo ? ' on' : '');
      sBtn.textContent = tr('mix_solo', 'S');
      sBtn.dataset.tip = tr('tip_solo', 'Solo this track');
      sBtn.addEventListener('click', () => App.toggleSolo(t));
      const aBtn = document.createElement('button');
      aBtn.className = 'ms-btn autom' + (autoLanes(t).length ? ' on' : '');
      aBtn.textContent = tr('mix_autom', 'A');
      aBtn.dataset.tip = tr('tip_autom_lanes', 'Show a value changing over time under this track');
      aBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openAutomMenu(e, t); });
      mid.append(mBtn, sBtn, aBtn);

      const volRow = document.createElement('div');
      volRow.className = 'thead-vol';
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = 0; vol.max = 3; vol.step = 0.01; vol.value = t.volume;
      vol.dataset.tip = tr('tip_track_vol', 'Track volume');
      vol.dataset.lk = 'vol:' + t.id;
      vol.addEventListener('input', () => {
        if (!vol._gesture) { Undo.push('Volume (' + t.name + ')'); vol._gesture = true; }
        t.volume = parseFloat(vol.value);
        Engine.updateTrack(t);
      });
      vol.addEventListener('change', () => { vol._gesture = false; });
      volRow.appendChild(vol);

      el.append(top, mid, volRow);
      el.addEventListener('mousedown', () => App.selectTrack(t.id));
      box.appendChild(el);
    }

    const slot = document.createElement('div');
    slot.className = 'thead-add';
    const mkAdd = (kind, icon, key, fb) => {
      const b = document.createElement('button');
      b.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg> <span>${tr(key, fb)}</span>`;
      b.dataset.tip = tr(kind === 'midi' ? 'tip_add_instrument' : 'tip_add_audio', 'Add a track');
      b.addEventListener('click', () => App.addTrack(kind));
      return b;
    };
    slot.append(mkAdd('midi', 'i-note', 'add_instrument', 'Instrument'), mkAdd('audio', 'i-mic', 'add_audio', 'Audio'));
    box.appendChild(slot);
  },

  openTimeSigMenu(anchor) {
    const old = document.getElementById('sigMenu');
    if (old) { old.remove(); return; }
    const m = document.createElement('div');
    m.id = 'sigMenu';
    m.className = 'ctx-menu';
    const cur = ((S.timeSig && S.timeSig[0]) || 4) + '/' + ((S.timeSig && S.timeSig[1]) || 4);
    for (const sig of ['4/4', '3/4', '2/4', '5/4', '6/4', '6/8', '7/8', '12/8']) {
      const b = document.createElement('button');
      b.className = 'ctx-item' + (sig === cur ? ' on' : '');
      b.textContent = sig;
      b.addEventListener('click', () => {
        m.remove();
        if (sig === cur) return;
        Undo.push('Time signature');
        const [n, d] = sig.split('/').map(Number);
        S.timeSig = [n, d];
        UI.dirty = UI.fileDirty = true;
        const lbl = document.getElementById('posSig');
        if (lbl) lbl.textContent = sig;
        this.drawRuler();
        this.render();
        Windows.refreshAll();
        toast(tr('toast_timesig', 'Time signature: {v}', { v: sig }));
      });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 8) + 'px';
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); window.removeEventListener('mousedown', close, true); } };
    setTimeout(() => window.addEventListener('mousedown', close, true), 0);
  },

  openColorMenu(track, anchor) {
    const old = document.getElementById('colorMenu');
    if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'colorMenu';
    m.className = 'color-menu';
    const grid = document.createElement('div');
    grid.className = 'color-grid';
    for (const c of TRACK_COLORS) {
      const b = document.createElement('button');
      b.className = 'color-sw' + (c.toLowerCase() === String(track.color).toLowerCase() ? ' on' : '');
      b.style.background = c;
      b.addEventListener('click', () => { m.remove(); this.setTrackColor(track, c); });
      grid.appendChild(b);
    }
    m.appendChild(grid);
    const row = document.createElement('label');
    row.className = 'color-custom';
    row.innerHTML = `<span>${tr('color_custom', 'Custom')}</span>`;
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = /^#[0-9a-f]{6}$/i.test(track.color) ? track.color : '#e0894a';
    inp.addEventListener('input', () => this.setTrackColor(track, inp.value, true));
    inp.addEventListener('change', () => { this.setTrackColor(track, inp.value); m.remove(); });
    row.appendChild(inp);
    m.appendChild(row);
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left - 4, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 8) + 'px';
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); window.removeEventListener('mousedown', close, true); } };
    window.addEventListener('mousedown', close, true);
  },

  setTrackColor(track, color, live) {
    if (!live) Undo.push('Track colour');
    track.color = color;
    UI.dirty = UI.fileDirty = true;
    this.render();
    if (typeof Windows !== 'undefined') Windows.refreshAll();
  },

  setInstrument(track, id) {
    Undo.push('Change instrument');
    if (!S.instruments[id] && LIB[id]) S.instruments[id] = JSON.parse(JSON.stringify(LIB[id]));
    track.instrument = id;
    if (id === 'drumkit') Engine.ensureDrumkit();
    if (typeof MELODIC !== 'undefined' && MELODIC[id]) Engine.ensureMelodic();
    toast(tr('toast_instr_changed', '{name} to {instr}', { name: track.name, instr: instrLabel(id) }));
    if (UI.playing) Engine.liveEdit();
    this.render();
    KeysPanel.refreshTracks();
  },

  openInstrMenu(track, anchor) {
    const old = document.getElementById('instrMenu');
    if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'instrMenu';
    m.className = 'instr-menu';
    const search = document.createElement('input');
    search.className = 'instr-search';
    search.placeholder = tr('instr_search', 'Search sounds');
    search.spellcheck = false;
    const list = document.createElement('div');
    list.className = 'instr-list';
    m.append(search, list);

    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      const addCat = (label, pairs) => {
        const frag = document.createDocumentFragment();
        let any = false;
        for (const [id, name] of pairs) {
          if (q && !name.toLowerCase().includes(q)) continue;
          any = true;
          const it = document.createElement('button');
          it.className = 'instr-item' + (id === track.instrument ? ' on' : '');
          it.innerHTML = `<span>${name}</span>${id === track.instrument ? '<span class="instr-check">✓</span>' : ''}`;
          it.addEventListener('click', () => { m.remove(); this.setInstrument(track, id); });
          frag.appendChild(it);
        }
        if (any) {
          const h = document.createElement('div'); h.className = 'instr-cat'; h.textContent = label;
          list.append(h, frag);
        }
      };
      for (const cat of INSTR_CATS) addCat(tr(cat.key, cat.label), cat.ids.map(id => [id, instrLabel(id)]));
      const customs = {};
      for (const [id, def] of Object.entries(LIB)) customs[id] = def;
      for (const [id, def] of Object.entries(S.instruments || {})) customs[id] = def;
      const cl = Object.values(customs);
      if (cl.length) addCat(tr('samp_custom_group', 'Your instruments'), cl.map(inst => [inst.id, inst.name]));
      const known = new Set([...INSTR_CATS.flatMap(c => c.ids), ...cl.map(i => i.id)]);
      if (!known.has(track.instrument)) addCat(tr('cat_other', 'Other'), [[track.instrument, instrLabel(track.instrument)]]);
      const nb = document.createElement('button');
      nb.className = 'instr-item instr-new';
      nb.innerHTML = `<svg class="ic"><use href="#i-mic"/></svg><span>${tr('instr_new', 'New from audio…')}</span>`;
      nb.addEventListener('click', () => { m.remove(); Sampler.open(track.id); });
      list.appendChild(nb);
    };
    search.addEventListener('input', render);
    render();

    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.minWidth = Math.max(r.width, 180) + 'px';
    m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8) + 'px';
    setTimeout(() => search.focus(), 30);
    const close = (ev) => { if (!m.contains(ev.target) && ev.target !== anchor) { m.remove(); window.removeEventListener('mousedown', close, true); } };
    window.addEventListener('mousedown', close, true);
  },

  syncHeads() {
    for (const el of $$('#trackHeads .thead')) {
      const t = getTrack(el.dataset.trackId);
      if (!t) continue;
      el.querySelector('.ms-btn.mute').classList.toggle('on', t.mute);
      el.querySelector('.ms-btn.solo').classList.toggle('on', t.solo);
      const vol = el.querySelector('.thead-vol input');
      if (!vol._gesture) vol.value = t.volume;
    }
  },

  // ---------- clips ----------
  buildClip(clip, track) {
    const el = document.createElement('div');
    el.className = 'clip' + (clip.kind === 'group' ? ' group' : '') + (UI.selClipIds.has(clip.id) ? ' sel' : '');
    el.dataset.clipId = clip.id;
    const lenB = clipBeats(clip);
    el.style.left = (clip.start * UI.zoom) + 'px';
    el.style.width = Math.max(10, lenB * UI.zoom - 2) + 'px';
    el.style.background = track.color;

    const label = document.createElement('div');
    label.className = 'clip-label';
    const inRoom = typeof Sync !== 'undefined' && Sync.connected;
    const byTag = inRoom && clip.by ? '  ' + clip.by : '';
    label.textContent = (clip.name || (clip.kind === 'midi' ? 'Pattern' : 'Audio')) + byTag;
    el.appendChild(label);

    if (clip.kind === 'audio' && (clip.pitch || 0) !== 0) {
      const badge = document.createElement('div');
      badge.className = 'clip-badge';
      badge.textContent = (clip.pitch > 0 ? '+' : '') + clip.pitch + 'st';
      el.appendChild(badge);
    }
    if (clip.fx && clip.fx.length) {
      el.classList.add('has-fx');
      const fxb = document.createElement('div');
      const fresh = this._fxFresh === clip.id;
      fxb.className = 'clip-fx-badge' + (fresh ? ' fresh' : '');
      const names = clip.fx.map(f => fxName(f.type));
      fxb.innerHTML = '<span class="fx-spark"></span>' +
        `<span class="fx-names">${names.slice(0, 2).join(', ')}${names.length > 2 ? ' +' + (names.length - 2) : ''}</span>`;
      fxb.dataset.tip = names.join(', ');
      el.appendChild(fxb);
    }
    if (clip.kind === 'group') {
      const gb = document.createElement('div');
      gb.className = 'clip-group-badge';
      gb.textContent = '▦ ' + (clip.children ? clip.children.length : 0);
      gb.dataset.tip = tr('tip_group_badge', 'Grouped clips. Right-click to ungroup.');
      el.appendChild(gb);
    }

    el.addEventListener('dragover', (e) => {
      if (clip.kind === 'group') return;   // groups are containers, not fx targets
      if (![...e.dataTransfer.types].includes('text/fabu-fx')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('fx-over');
      if (e.shiftKey) Timeline.paintFx(clip);
    });
    el.addEventListener('dragleave', () => el.classList.remove('fx-over'));
    el.addEventListener('drop', (e) => {
      const type = e.dataTransfer.getData('text/fabu-fx');
      if (!type) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('fx-over');
      if (Timeline._brush && Timeline._brush.painted.size) return;
      App.addFxToClip(clip, type);
    });

    const cv = document.createElement('canvas');
    el.appendChild(cv);
    requestAnimationFrame(() => this.drawClipCanvas(clip, el, cv));

    const rsL = document.createElement('div');
    rsL.className = 'clip-resize-l';
    rsL.dataset.tip = tr('tip_trim_start', 'Drag to trim the start');
    const rsR = document.createElement('div');
    rsR.className = 'clip-resize';
    rsR.dataset.tip = clip.kind === 'midi' ? tr('tip_pattern_len', 'Drag to change length') : tr('tip_trim_end', 'Drag to trim the end');
    el.append(rsL, rsR);

    if (clip.kind === 'midi') {
      const label = el.querySelector('.clip-label');
      if (label) {
        label.draggable = true;
        label.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/fabu-clip', clip.id);
          e.dataTransfer.effectAllowed = 'copy';
          e.stopPropagation();
          DragGhost.start(el, e);
        });
        label.addEventListener('mousedown', (e) => e.stopPropagation());
      }
    }
    el.addEventListener('mousedown', (e) => this.clipMouseDown(e, clip, track, el));
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (clip.kind === 'group') { App.selectClip(clip.id); return; }
      if (clip.kind === 'midi') PianoRoll.open(clip.id);
      else { App.selectClip(clip.id); Windows.openInspector(); }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!UI.selClipIds.has(clip.id)) App.selectClip(clip.id);
      this.openClipMenu(e.clientX, e.clientY, clip);
    });

    return el;
  },

  openClipMenu(x, y, clip) {
    const old = document.getElementById('clipMenu');
    if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'clipMenu';
    m.className = 'ctx-menu';
    const add = (label, fn, danger) => {
      const b = document.createElement('button');
      b.className = 'ctx-item' + (danger ? ' danger' : '');
      b.textContent = label;
      b.addEventListener('click', () => { m.remove(); fn(); });
      m.appendChild(b);
    };
    if (clip.kind === 'group') {
      add(tr('menu_ungroup', 'Ungroup'), () => App.ungroupClip(clip.id));
      add(tr('insp_delete', 'Delete group'), () => App.deleteSelectedClip(), true);
    } else {
      if (clip.kind === 'midi') add(tr('menu_pianoroll', 'Open piano roll'), () => PianoRoll.open(clip.id));
      if (clip.kind === 'midi') add(tr('menu_save_loop', 'Save to my loops'), () => App.saveClipAsLoop(clip.id));
      if (clip.bounce) add(tr('menu_ungroup', 'Ungroup'), () => App.ungroupClip(clip.id));
      add(tr('menu_settings', 'Clip settings'), () => Windows.openInspector());
      if (clip.fx && clip.fx.length) {
        const b = document.createElement('button');
        b.className = 'ctx-item fx';
        b.textContent = tr('menu_edit_fx', 'Edit effects');
        b.addEventListener('click', () => { m.remove(); App.openFxEditor(clip.id); });
        m.appendChild(b);
      }
      if (UI.selClipIds.size >= 2) add(tr('menu_group', 'Group into one'), () => App.groupSelectedClips());
      else add(tr('menu_convert_audio', 'Convert to Audio'), () => App.convertToAudio());
      add(tr('insp_duplicate', 'Duplicate'), () => App.duplicateClip());
      add(tr('insp_split', 'Split at playhead'), () => App.splitSelectedClip());
      add(tr('insp_delete', 'Delete'), () => App.deleteSelectedClip(), true);
    }
    document.body.appendChild(m);
    m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 8) + 'px';
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); window.removeEventListener('mousedown', close, true); } };
    window.addEventListener('mousedown', close, true);
  },

  // ---------- painting effects across clips ----------
  beginBrush(type) { this._brush = { type, painted: new Set() }; },
  endBrush() { this._brush = null; },

  paintFx(clip) {
    const b = this._brush;
    if (!b || !clip || clip.kind === 'group' || b.painted.has(clip.id)) return;
    b.painted.add(clip.id);
    App.addFxToClip(clip, b.type);
  },

  flashFx(clipId) {
    this._fxFresh = clipId;
    clearTimeout(this._fxFreshTimer);
    this._fxFreshTimer = setTimeout(() => {
      this._fxFresh = null;
      const b = this.lanes.querySelector(`[data-clip-id="${clipId}"] .clip-fx-badge`);
      if (b) b.classList.remove('fresh');
    }, 3000);
    const el = this.lanes.querySelector(`[data-clip-id="${clipId}"]`);
    if (!el) return;
    const badge = el.querySelector('.clip-fx-badge');
    if (badge) badge.classList.add('fresh');
    el.classList.remove('fx-landed');
    void el.offsetWidth;                 // restart it if one is already running
    el.classList.add('fx-landed');
    const done = () => { clearTimeout(timer); el.classList.remove('fx-landed'); };
    const timer = setTimeout(done, 900);
    el.addEventListener('animationend', done, { once: true });
  },

  drawClip(clipId) {
    const el = this.lanes.querySelector(`[data-clip-id="${clipId}"]`);
    const found = getClip(clipId);
    if (el && found) this.drawClipCanvas(found.clip, el, el.querySelector('canvas'));
  },

  drawClipCanvas(clip, el, cv) {
    const w = Math.max(2, el.clientWidth);
    const h = Math.max(2, el.clientHeight - 17);
    const dpr = window.devicePixelRatio || 1;
    const sc = this.scroller;
    const vw = sc ? sc.clientWidth : w;
    const clipLeft = clip.start * UI.zoom;
    const scL = sc ? sc.scrollLeft : 0;
    let x0 = Math.max(0, Math.floor(((scL - clipLeft) - vw) / 256) * 256);
    let x1 = Math.min(w, Math.ceil(((scL - clipLeft) + vw * 2) / 256) * 256);
    if (x1 <= x0) { x0 = 0; x1 = Math.min(w, 256); }
    const cw = Math.max(2, x1 - x0);
    cv.width = Math.round(cw * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = cw + 'px'; cv.style.height = h + 'px';
    cv.style.marginLeft = x0 + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, -x0 * dpr, 0);
    ctx.clearRect(x0, 0, cw, h);

    if (clip.kind === 'group') {
      const len = clip.length || 1;
      const buckets = new Array(Math.ceil(cw)).fill(0);   // window-sized, not clip-sized
      for (const child of clip.children || []) {
        const cs = child.clip.start || 0;
        if (child.clip.kind === 'midi' && child.clip.notes) {
          for (const n of child.clip.notes) {
            const a = Math.max(x0, Math.floor(((cs + n.start) / len) * w));
            const b = Math.min(x1, Math.ceil(((cs + n.start + Math.max(0.05, n.length)) / len) * w));
            for (let x = a; x < b; x++) buckets[x - x0] = Math.max(buckets[x - x0], n.vel ?? 0.9);
          }
        } else {
          const a = Math.max(x0, Math.floor((cs / len) * w));
          const b = Math.min(x1, Math.ceil(((cs + clipBeats(child.clip)) / len) * w));
          for (let x = a; x < b; x++) buckets[x - x0] = Math.max(buckets[x - x0], 0.7);
        }
      }
      const mid = h / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      for (let x = x0; x < x1; x++) {
        const bh = buckets[x - x0] * mid * 0.88;
        ctx.fillRect(x, mid - bh - 0.5, 1, bh * 2 + 1);
      }
      return;
    }

    if (clip.kind === 'audio') {
      const s = Samples[clip.sampleId];
      if (!s || !s.buffer) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.font = '10px sans-serif';
        ctx.fillText(tr('clip_missing', 'missing sample'), 6, h / 2);
        return;
      }
      const data = s.buffer.getChannelData(0);
      const sr = s.buffer.sampleRate;
      const first = Math.floor(clipOffSec(clip) * sr);
      const last = Math.min(data.length, Math.ceil((clipOffSec(clip) + clipDurSec(clip)) * sr));
      const spp = Math.max(1, (last - first) / w);
      const auto = clipRateAutom(clip) ? clipAutoInfo(clip) : null;
      const srcIdx = auto
        ? (x) => first + Math.floor(auto.sourceAt((x / w) * auto.durSec) * sr)
        : (x) => first + Math.floor(x * spp);
      const mid = h / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      for (let x = x0; x < x1; x++) {
        let mn = 1, mx = -1;
        const i0 = srcIdx(x);
        const i1 = Math.min(last, srcIdx(x + 1) + 1);
        const step = Math.max(1, Math.floor((i1 - i0) / 50));
        for (let i = i0; i < i1; i += step) {
          const v = data[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const g = clip.gain ?? 1;
        ctx.rect(x, mid - mx * mid * 0.92 * g, 1, Math.max(1, (mx - mn) * mid * 0.92 * g));
      }
      ctx.fill();
      const durOut = auto ? auto.durSec : clipDurSec(clip) / (clip.speed || 1);
      const fiX = ((clip.fadeIn || 0) / durOut) * w;
      const foX = ((clip.fadeOut || 0) / durOut) * w;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 1.5;
      if (fiX > 1) {
        ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(fiX, 0); ctx.stroke();
      }
      if (foX > 1) {
        ctx.beginPath(); ctx.moveTo(w, h); ctx.lineTo(w - foX, 0); ctx.stroke();
      }
    } else {
      const notes = clip.notes;
      if (!notes.length) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.font = '10px sans-serif';
        ctx.fillText(tr('clip_empty', 'double-click to edit'), 6, h / 2 + 3);
        return;
      }
      let lo = 127, hi = 0;
      for (const n of notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
      lo -= 2; hi += 2;
      const range = hi - lo;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      for (const n of notes) {
        const x = (n.start / clip.length) * w;
        const nw = Math.max(2, (n.length / clip.length) * w - 1);
        if (x + nw < x0 || x > x1) continue;    // outside the painted window
        const y = h - ((n.pitch - lo) / range) * h - 2;
        ctx.fillRect(x, y, nw, 3);
      }
    }
  },

  clipMouseDown(e, clip, track, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey) { App.selectClip(clip.id, true); return; }
    const clipLock = 'clip:' + clip.id;
    if (typeof Sync !== 'undefined' && Sync.admitted) {
      const l = Sync.lockedBy(clipLock);
      if (l) { toast(tr('mp_locked_by', '{name} is using this', { name: l.name })); return; }
      Sync.setLock(clipLock, true);
    }
    if (!UI.selClipIds.has(clip.id)) App.selectClip(clip.id);
    else App.selectTrack(track.id);
    const group = [...UI.selClipIds]
      .filter(id => id !== clip.id).map(getClip).filter(Boolean)
      .map(f => ({ clip: f.clip, start: f.clip.start, len: f.clip.kind === 'midi' ? f.clip.length : clipBeats(f.clip) }));
    const mode = e.target.classList.contains('clip-resize') ? 'right'
      : e.target.classList.contains('clip-resize-l') ? 'left' : 'move';
    const startX = e.clientX;
    const startY = e.clientY;
    const spb = 60 / S.bpm;
    const rate = clip.kind === 'audio' ? (clip.speed || 1) : 1; // sample seconds per output second
    const orig = {
      start: clip.start,
      length: clip.kind === 'midi' ? clip.length : clipBeats(clip),
      offset: clip.kind === 'audio' ? clipOffSec(clip) : 0,
      dur: clip.kind === 'audio' ? clipDurSec(clip) : 0,
      notes: clip.kind === 'midi' ? JSON.parse(JSON.stringify(clip.notes)) : null,
      trackIdx: S.tracks.indexOf(track)
    };
    let moved = false;
    const snapSeen = new Map();
    let lastSnapKey = null, coached = false;

    const drawEl = (cl) => {
      const cel = this.lanes.querySelector(`[data-clip-id="${cl.id}"]`);
      if (!cel) return;
      cel.style.left = (cl.start * UI.zoom) + 'px';
      cel.style.width = Math.max(10, clipBeats(cl) * UI.zoom - 2) + 'px';
      this.drawClipCanvas(cl, cel, cel.querySelector('canvas'));
    };
    const applyVisual = () => {
      el = this.lanes.querySelector(`[data-clip-id="${clip.id}"]`) || el;
      drawEl(clip);
      for (const g of group) drawEl(g.clip);
    };
    const applyGroup = () => {
      if (!group.length) return;
      if (mode === 'move') {
        const delta = clip.start - orig.start;
        for (const g of group) g.clip.start = Math.max(0, g.start + delta);
      } else if (mode === 'right') {
        for (const g of group) if (g.clip.kind === 'midi') g.clip.length = clip.length;
      } else if (mode === 'left') {
        const delta = clip.start - orig.start;
        for (const g of group) { g.clip.start = Math.max(0, g.start + delta); }
      }
    };

    let tilt = 0, lastTiltX = startX;
    const applyTilt = () => {
      const els = [el, ...group.map(g => this.lanes.querySelector(`[data-clip-id="${g.clip.id}"]`))];
      for (const e of els) if (e) e.style.transform = tilt ? `rotate(${tilt}deg)` : '';
    };
    const nudgeTilt = (clientX) => {
      const dx = clientX - lastTiltX;
      if (Math.abs(dx) < 2) return;          // ignore jitter, keep the current lean
      lastTiltX = clientX;
      const want = dx > 0 ? 5 : -5;
      if (want === tilt) return;
      tilt = want;
      applyTilt();
    };
    const clearTilt = () => { tilt = 0; applyTilt(); };

    const loopsBox = () => {
      const w = Windows.wins && Windows.wins.get('samples');
      return w && w.el ? w.el : null;
    };
    const overLoops = (ev) => {
      if (mode !== 'move' || clip.kind !== 'midi') return false;
      const box = loopsBox();
      if (!box) return false;
      const r = box.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    };
    let loopsArmed = false;
    const markLoops = (on) => {
      if (on === loopsArmed) return;
      loopsArmed = on;
      const box = loopsBox();
      if (box) box.classList.toggle('samp-catch', on);
    };

    const move = (ev) => {
      const dxBeats = (ev.clientX - startX) / UI.zoom;
      if (!moved && Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
      if (!moved) {
        Undo.push(mode === 'move' ? 'Move clip' : 'Trim clip');
        moved = true;
      }

      if (mode === 'right') {
        if (clip.kind === 'midi') {
          clip.length = clamp(snapBeat(orig.length + dxBeats, S.snap),
                              S.snap || 0.25, maxPatternBeats());
          if (!group.length) {   // don't grow into the next clip on this track
            const { right } = this.laneBounds(getClip(clip.id).track, clip, orig.start, orig.start + orig.length);
            if (right !== Infinity) clip.length = Math.min(clip.length, Math.max(S.snap || 0.25, right - clip.start));
          }
        } else {
          const endBeat = snapBeat(orig.start + orig.length + dxBeats, S.snap);
          const lenB = Math.max(0.1, endBeat - clip.start);
          const s = Samples[clip.sampleId];
          const maxDur = s && s.buffer ? s.buffer.duration - clipOffSec(clip) : lenB * spb * rate;
          clip.dur = clamp(lenB * spb * rate, 0.05, maxDur);
        }
      } else if (mode === 'left') {
        let newStart = snapBeat(orig.start + dxBeats, S.snap);
        if (clip.kind === 'midi') {
          newStart = clamp(newStart, 0, orig.start + orig.length - (S.snap || 0.25));
          const d = newStart - orig.start;
          clip.start = newStart;
          clip.length = orig.length - d;
          clip.notes = orig.notes
            .map(n => ({ ...n, start: n.start - d }))
            .filter(n => n.start + n.length > 0.01)
            .map(n => n.start < 0 ? { ...n, length: n.length + n.start, start: 0 } : n);
        } else {
          const minStart = orig.start - orig.offset / (rate * spb);
          newStart = clamp(newStart, Math.max(0, minStart), orig.start + orig.length - 0.1);
          const d = newStart - orig.start;
          clip.start = newStart;
          clip.offset = orig.offset + d * spb * rate;
          clip.dur = orig.dur - d * spb * rate;
        }
      } else {
        clip.start = Math.max(0, snapBeat(orig.start + dxBeats, S.snap));
        if (!group.length) {
          const N = S.tracks.length;
          const py = ev.clientY - this.lanes.getBoundingClientRect().top;
          const laneF = trackAtY(py) + 0.5;
          const nb = Math.round(laneF);                 // nearest track boundary
          const nearBoundary = Math.abs(py - trackTop(nb)) < 18;
          if (nearBoundary && nb >= 0 && nb <= N && py > -40 && py < tracksHeight() + 60) {
            this._clipInsertAt = nb;
            this.showTrackInsert(nb);
          } else {
            this._clipInsertAt = null;
            this.hideTrackInsert();
            const laneIdx = clamp(Math.floor(laneF), 0, N - 1);
            const target = S.tracks[laneIdx];
            const cur = getClip(clip.id).track;
            if (target && target !== cur && target.kind === cur.kind) {
              cur.clips.splice(cur.clips.indexOf(clip), 1);
              target.clips.push(clip);
              this.render();
            }
          }
        }
      }
      applyGroup();
      if (mode === 'right' && clip.kind === 'midi'
          && clip.length >= maxPatternBeats() - 1e-6 && !this._toldMaxLen) {
        this._toldMaxLen = true;
        toast(tr('toast_pattern_max', 'A pattern tops out at two minutes. Use another one after it.'));
        setTimeout(() => { this._toldMaxLen = false; }, 4000);
      }
      if (mode === 'move') nudgeTilt(ev.clientX);
      if (S.snap && !coached) {
        const key = (mode === 'right' ? clip.start + clipBeats(clip) : clip.start).toFixed(3);
        if (key !== lastSnapKey) {
          lastSnapKey = key;
          const c = (snapSeen.get(key) || 0) + 1;
          snapSeen.set(key, c);
          if (c >= 3) { App.showSnapCoach(); coached = true; }
        }
      }
      applyVisual();
      markLoops(overLoops(ev));
    };
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      clearTilt();
      const intoLoops = loopsArmed && ev && overLoops(ev);
      markLoops(false);
      if (typeof Sync !== 'undefined') Sync.setLock(clipLock, false);
      this.hideTrackInsert();
      if (intoLoops) {
        clip.start = orig.start;
        if (clip.kind === 'midi') clip.length = orig.length;
        for (const g of group) g.clip.start = g.start;
        this._clipInsertAt = null;
        this.render();
        App.saveClipAsLoop(clip.id);
        return;
      }
      if (moved) {
        if (this._clipInsertAt != null && !group.length && mode === 'move') {
          const idx = this._clipInsertAt; this._clipInsertAt = null;
          this.createTrackForClip(clip, idx);
          return;
        }
        this._clipInsertAt = null;
        if (!group.length) {
          const track = getClip(clip.id).track;
          clip.start = this.nearestFreeStart(track, clipBeats(clip), clip.start, clip);
        }
        this.render();
        Windows.refreshAll();
        PianoRoll.onStateRestore();
        toast(mode === 'move' ? tr('toast_clip_moved', 'Clip moved') : tr('toast_clip_trimmed', 'Clip trimmed'));
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  },

  openRulerMenu(x, y) {
    const old = document.getElementById('rulerMenu');
    if (old) old.remove();
    const beat = snapBeat(this.xToBeat(x), S.snap || 1);
    const m = document.createElement('div');
    m.id = 'rulerMenu';
    m.className = 'ctx-menu';
    const add = (label, fn, danger) => {
      const b = document.createElement('button');
      b.className = 'ctx-item' + (danger ? ' danger' : '');
      b.textContent = label;
      b.addEventListener('click', () => { m.remove(); fn(); });
      m.appendChild(b);
    };
    const onMarker = (S.markers || []).some(mk => Math.abs(mk.beat - this.xToBeat(x)) <= 12 / UI.zoom);
    if (onMarker) add(tr('menu_marker_remove', 'Remove this section marker'), () => App.removeMarkerNear(this.xToBeat(x)), true);
    else add(tr('menu_marker_add', 'Add section marker here'), () => App.addMarker(beat));
    if (S.loopEnd > S.loopStart) {
      add(S.loopOn ? tr('menu_loop_off', 'Turn repeat off') : tr('menu_loop_on', 'Turn repeat on'), () => App.setLoop(!S.loopOn));
      add(tr('menu_loop_clear', 'Clear repeat region'), () => App.clearLoop(), true);
    } else {
      add(tr('menu_loop_here', 'Repeat this bar'), () => {
        const bpb = beatsPerBar();
        const bar = Math.floor(beat / bpb) * bpb;
        S.loopStart = bar; S.loopEnd = bar + bpb;
        App.setLoop(true);
      });
    }
    document.body.appendChild(m);
    m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 8) + 'px';
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); window.removeEventListener('mousedown', close, true); } };
    window.addEventListener('mousedown', close, true);
  },

  showTrackInsert(idx) {
    let el = document.getElementById('trackInsert');
    if (!el) {
      el = document.createElement('div');
      el.id = 'trackInsert';
      el.innerHTML = `<span class="ti-plus">+</span><span class="ti-label">${tr('drag_new_track', 'New track')}</span>`;
      this.lanes.appendChild(el);
    }
    el.style.display = 'flex';
    el.style.top = trackTop(idx) + 'px';
    el.style.width = Math.max(this.scroller.scrollWidth, this.scroller.clientWidth) + 'px';
  },
  hideTrackInsert() {
    const el = document.getElementById('trackInsert');
    if (el) el.style.display = 'none';
  },

  createTrackForClip(clip, idx) {
    const found = getClip(clip.id);
    if (!found) return;
    const src = found.track;
    const nt = makeTrack(clip.kind === 'audio' ? 'audio' : 'midi');
    if (clip.kind !== 'audio') nt.instrument = src.instrument;   // sound stays the same
    src.clips.splice(src.clips.indexOf(clip), 1);
    S.tracks.splice(clamp(idx, 0, S.tracks.length), 0, nt);
    clip.start = this.nearestFreeStart(nt, clipBeats(clip), clip.start, clip);
    nt.clips.push(clip);
    Engine.rebuildTracks();
    this.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    App.selectClip(clip.id);
    if (UI.playing) Engine.liveEdit();
    if (typeof Sync !== 'undefined') Sync.logAction('add_track', nt.name);
    toast(tr('toast_track_created', 'New track'), 'green');
  },

  // ---------- OS drag & drop of audio files ----------
  initDropZone() {
    const ghost = $('#dropGhost');
    const area = this.scroller;

    area.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (types.includes('text/fabu-fx')) return; // effect drags target clips
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const beat = snapBeat(this.xToBeat(e.clientX), S.snap);
      const laneIdx = trackAtY(e.clientY - this.lanes.getBoundingClientRect().top);
      const samp = types.includes('text/fabu-sample') ? (typeof Windows !== 'undefined' && Windows._dragSample) : null;
      const items = e.dataTransfer.items;
      let isMidi = false;
      if (!samp && items) for (const it of items) {
        if (it.kind === 'file' && /midi/.test(it.type || '')) { isMidi = true; break; }
      }
      const lenB = samp ? samp.length : 4; // audio: real length unknown until dropped, show a placeholder
      ghost.className = 'preview';
      ghost.style.display = 'block';
      ghost.style.left = (beat * UI.zoom) + 'px';
      ghost.style.top = (trackTop(laneIdx) + 2) + 'px';
      ghost.style.width = Math.max(24, lenB * UI.zoom - 2) + 'px';
      ghost.style.height = (TRACK_H - 6) + 'px';
      ghost.innerHTML = `<span class="dp-name">${samp ? samp.name : (isMidi ? tr('drop_midi', 'MIDI') : tr('drop_audio', 'Audio'))}</span>`;
      if (samp) this.drawGhostNotes(ghost, samp, lenB * UI.zoom - 2);
      const dropBar = Math.floor(beat / beatsPerBar()) + 1;
      setHint(samp ? tr('hint_drop_loop', 'Drop to add this loop at bar {bar}.', { bar: dropBar })
        : isMidi ? tr('hint_drop_midi', 'Drop to turn this MIDI into patterns at bar {bar}.', { bar: dropBar })
        : tr('hint_drop_at_bar', 'Drop to place the sound at bar {bar}.', { bar: dropBar }));
    });
    area.addEventListener('dragleave', () => { ghost.style.display = 'none'; ghost.className = ''; ghost.innerHTML = ''; });
    area.addEventListener('drop', async (e) => {
      e.preventDefault();
      ghost.style.display = 'none'; ghost.className = ''; ghost.innerHTML = '';
      const beat = snapBeat(this.xToBeat(e.clientX), S.snap);
      const laneIdx = trackAtY(e.clientY - this.lanes.getBoundingClientRect().top);
      const sampleId = e.dataTransfer.getData('text/fabu-sample');
      if (sampleId) { App.addSampleToProject(sampleId, beat, S.tracks[laneIdx] ? laneIdx : null); return; }
      const dropped = [...e.dataTransfer.files];
      const midis = dropped.filter(f => MidiFile.isMidiFile(f));
      if (midis.length) { await MidiFile.importFiles(midis, beat); return; }
      const files = dropped.filter(f =>
        /\.(wav|mp3|ogg|m4a|aac|flac|aiff?|webm|opus)$/i.test(f.name) || f.type.startsWith('audio/'));
      if (!files.length) { toast(tr('toast_not_audio', 'That is not an audio or MIDI file'), 'red'); return; }
      await App.importAudioFiles(files, beat, S.tracks[laneIdx]);
    });
  },

  drawGhostNotes(ghost, samp, w) {
    const h = TRACK_H - 6;
    const cv = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(2, w) * dpr; cv.height = h * dpr;
    cv.style.width = Math.max(2, w) + 'px'; cv.style.height = h + 'px';
    const x = cv.getContext('2d'); x.scale(dpr, dpr);
    const notes = samp.notes;
    let lo = 127, hi = 0;
    for (const n of notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
    if (lo > hi) { lo = 60; hi = 72; }
    lo -= 1; hi += 1;
    const range = Math.max(1, hi - lo);
    x.fillStyle = 'rgba(255,255,255,0.85)';
    for (const n of notes) {
      const nx = (n.start / samp.length) * w;
      const nw = Math.max(2, (n.length / samp.length) * w - 1);
      const ny = h - ((n.pitch - lo) / range) * (h - 20) - 6;
      x.fillRect(nx, ny, nw, 3);
    }
    ghost.appendChild(cv);
  },

  // ---------- playhead ----------
  startPlayheadLoop() {
    const loop = () => {
      try { this.updatePlayhead(); } catch (e) { /* keep looping */ }
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
  },

  updatePlayhead() {
    if (!UI.playing && this._lastX === UI.playhead * UI.zoom) return;

    const beat = Engine.ctx && UI.playing ? Engine.currentBeat() : UI.playhead;
    const x = beat * UI.zoom;
    this._lastX = x;
    if (typeof PianoRoll !== 'undefined' && PianoRoll.isOpen()) PianoRoll.syncPlayhead(beat);
    if (!this._phEl || !this._phEl.isConnected) {
      this._phEl = $('#playhead');
      this._posBars = $('#posBars');
      this._posTime = $('#posTime');
    }
    if (this._phEl) this._phEl.style.left = x + 'px';

    if (typeof Sync !== 'undefined' && Sync.admitted) {
      if (UI.playing) Sync.sendPlayhead(beat, true);
      else if (Sync._phWasPlaying) Sync.sendPlayhead(beat, false);
      Sync._phWasPlaying = UI.playing;
    }

    const now = performance.now();
    if (this._posBars && (!this._lastTxt || now - this._lastTxt > 100)) {
      this._lastTxt = now;
      const bpb = beatsPerBar();
      const bars = Math.floor(beat / bpb) + 1;
      const beats = Math.floor(beat % bpb) + 1;
      this._posBars.textContent = bars + '.' + beats;
      this._posTime.textContent = fmtSec(beat * (60 / S.bpm));
      if (!this._posSig) this._posSig = $('#posSig');
      if (this._posSig) {
        const sig = ((S.timeSig && S.timeSig[0]) || 4) + '/' + ((S.timeSig && S.timeSig[1]) || 4);
        if (this._posSig.textContent !== sig) this._posSig.textContent = sig;
      }
    }

    if (UI.playing) {
      const viewL = this.scroller.scrollLeft;
      const viewR = viewL + this.scroller.clientWidth;
      const inView = x >= viewL && x <= viewR - 80;
      if (this._userScrolled && inView) this._userScrolled = false;  // it caught up
      if (!this._userScrolled && !inView) {
        this._following = true;
        this.scroller.scrollLeft = Math.max(0, x - 120);
        this._followLeft = this.scroller.scrollLeft;
        this._following = false;
      }
      if (x > this.lanes.clientWidth - 200) this.renderSoon();
      if (typeof Automation !== 'undefined' && Automation.isOpen()) Automation.redraw();
    }
  },

  setZoom(z) {
    const centerBeat = (this.scroller.scrollLeft + this.scroller.clientWidth / 2) / UI.zoom;
    UI.zoom = clamp(z, 8, 160);
    this.render();
    this.scroller.scrollLeft = Math.max(0, centerBeat * UI.zoom - this.scroller.clientWidth / 2);
  }
};
