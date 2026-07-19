// ---------- Timeline: the song view. Tracks, clips, waveforms, drag & drop ----------
'use strict';

const TRACK_H = 84;

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
    });

    // scrolling while the pointer is over the track-headers column (which is
    // itself clipped) should still scroll the timeline vertically.
    $('#headsCol').addEventListener('wheel', (e) => {
      this.scroller.scrollTop += e.deltaY;
    }, { passive: true });

    // trackpad pinch (ctrl+wheel) zooms the timeline around the cursor
    this.scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return; // let normal two-finger scrolling through
      e.preventDefault();
      this.setZoom(UI.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    // click ruler = move playhead
    this.ruler.addEventListener('mousedown', (e) => {
      const move = (ev) => {
        const beat = snapBeat(this.xToBeat(ev.clientX), S.snap);
        Engine.seek(beat);
      };
      move(e);
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // background: click deselects, drag draws a selection box (marquee)
    this.lanes.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!(e.target === this.lanes || e.target.classList.contains('lane'))) return;
      const rect = this.lanes.getBoundingClientRect();
      const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
      const idx = Math.floor(y0 / TRACK_H);
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
          const laneY = ti * TRACK_H;
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

    // double-click empty lane on an instrument track = new pattern clip
    this.lanes.addEventListener('dblclick', (e) => {
      if (!e.target.classList.contains('lane')) return;
      const idx = Math.floor((e.clientY - this.lanes.getBoundingClientRect().top) / TRACK_H);
      const track = S.tracks[idx];
      if (!track) return;
      const beat = snapBeat(this.xToBeat(e.clientX), S.snap || 1);
      if (track.kind === 'midi') {
        Undo.push('New pattern');
        const clip = {
          id: uid('clip'), kind: 'midi', name: 'Pattern', by: authorName(),
          start: beat, length: 4, notes: []
        };
        track.clips.push(clip);
        this.render();
        App.selectClip(clip.id);
        toast(tr('toast_pattern_added', 'Pattern added'));
      } else {
        toast(tr('toast_drop_here', 'Drop an audio file here, or record with R'));
      }
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

  // ---------- full render ----------

  render() {
    // drop selection entries whose clips no longer exist
    for (const id of [...UI.selClipIds]) if (!getClip(id)) UI.selClipIds.delete(id);
    if (UI.selClipId && !UI.selClipIds.has(UI.selClipId)) UI.selClipId = [...UI.selClipIds].pop() || null;

    const width = this.totalBeats() * UI.zoom;
    this.lanes.style.width = width + 'px';
    this.ruler.style.width = width + 'px';

    // remove stale lanes/clips (keep playhead, dropGhost and the live overlays)
    for (const el of [...this.lanes.children]) {
      if (el.id !== 'playhead' && el.id !== 'dropGhost' && el.id !== 'cursorLayer' && el.id !== 'remotePhLayer') el.remove();
    }

    const beat = UI.zoom;
    const bar = UI.zoom * 4;
    let clipCount = 0;
    const firstMidiIdx = S.tracks.findIndex(t => t.kind === 'midi');
    for (const t of S.tracks) {
      const lane = document.createElement('div');
      lane.className = 'lane' + (t.id === UI.selTrackId ? ' sel' : '');
      lane.dataset.trackId = t.id;
      lane.style.backgroundImage =
        `repeating-linear-gradient(90deg, rgba(255,255,255,0.07) 0 1px, transparent 1px ${bar}px),` +
        `repeating-linear-gradient(90deg, rgba(255,255,255,0.028) 0 1px, transparent 1px ${beat}px)`;
      this.lanes.appendChild(lane);
      for (const c of t.clips) { lane.appendChild(this.buildClip(c, t)); clipCount++; }
    }

    // brand-new/empty project: gentle "double-click to add a pattern" nudge
    if (clipCount === 0 && firstMidiIdx >= 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.style.top = (firstMidiIdx * TRACK_H + TRACK_H / 2 - 18) + 'px';
      hint.textContent = tr('empty_hint', 'Double-click here to add a pattern');
      this.lanes.appendChild(hint);
    }

    this.lanes.style.height = (S.tracks.length * TRACK_H) + 'px';
    $('#playhead').style.height = (S.tracks.length * TRACK_H + 30) + 'px';
    this.renderHeads();
    this.drawRuler();
    this.updatePlayhead();
    if (typeof Sync !== 'undefined') { Sync.renderCursors(); Sync.renderRemotePlayheads(); Sync.updateLockVisuals(); }
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
    const firstBar = Math.floor(scrollX / (UI.zoom * 4));
    const lastBar = Math.ceil((scrollX + w) / (UI.zoom * 4));
    ctx.font = '600 10px -apple-system, sans-serif';
    for (let b = firstBar; b <= lastBar; b++) {
      const x = b * UI.zoom * 4 - scrollX;
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
  },

  // ---------- track headers ----------

  renderHeads() {
    const box = $('#trackHeads');
    box.innerHTML = '';
    for (const t of S.tracks) {
      const el = document.createElement('div');
      el.className = 'thead' + (t.id === UI.selTrackId ? ' sel' : '');
      el.dataset.trackId = t.id;

      const top = document.createElement('div');
      top.className = 'thead-top';
      const dot = document.createElement('div');
      dot.className = 'tcolor';
      dot.style.background = t.color;
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
        const sel = document.createElement('select');
        sel.dataset.tip = tr('tip_track_instr', 'Instrument sound');
        for (const k of Object.keys(INSTRUMENTS)) {
          const o = document.createElement('option');
          o.value = k; o.textContent = instrLabel(k);
          sel.appendChild(o);
        }
        // merge the persistent library with this project's instruments
        const customs = {};
        for (const [id, def] of Object.entries(LIB)) customs[id] = def;
        for (const [id, def] of Object.entries(S.instruments || {})) customs[id] = def;
        const customList = Object.values(customs);
        if (customList.length) {
          const og = document.createElement('optgroup');
          og.label = tr('samp_custom_group', 'Your instruments');
          for (const inst of customList) {
            const o = document.createElement('option');
            o.value = inst.id; o.textContent = inst.name;
            og.appendChild(o);
          }
          sel.appendChild(og);
        }
        const oNew = document.createElement('option');
        oNew.value = '__new_sampler';
        oNew.textContent = tr('instr_new', 'New from audio…');
        sel.appendChild(oNew);
        sel.value = t.instrument;
        sel.addEventListener('change', () => {
          if (sel.value === '__new_sampler') { sel.value = t.instrument; Sampler.open(t.id); return; }
          Undo.push('Change instrument');
          const id = sel.value;
          // pulling a library instrument into the project makes it self-contained
          if (!S.instruments[id] && LIB[id]) S.instruments[id] = JSON.parse(JSON.stringify(LIB[id]));
          t.instrument = id;
          toast(tr('toast_instr_changed', '{name} to {instr}', { name: t.name, instr: instrLabel(id) }));
          this.render();
          KeysPanel.refreshTracks();
        });
        mid.appendChild(sel);
        // edit + delete buttons for custom (sampler) instruments
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
        k.textContent = tr('track_audio', 'AUDIO');
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
      mid.append(mBtn, sBtn);

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

    // the "add a track" slot sits right below the last track, like an empty slot
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

  syncHeads() {
    // light refresh of mute/solo/volume without rebuilding inputs
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
    el.className = 'clip' + (UI.selClipIds.has(clip.id) ? ' sel' : '');
    el.dataset.clipId = clip.id;
    const lenB = clipBeats(clip);
    el.style.left = (clip.start * UI.zoom) + 'px';
    el.style.width = Math.max(10, lenB * UI.zoom - 2) + 'px';
    el.style.background = track.color;

    const label = document.createElement('div');
    label.className = 'clip-label';
    const inRoom = typeof Sync !== 'undefined' && Sync.connected;
    const byTag = inRoom && clip.by ? '  · ' + clip.by : '';
    label.textContent = (clip.name || (clip.kind === 'midi' ? 'Pattern' : 'Audio')) + byTag;
    el.appendChild(label);

    if (clip.kind === 'audio' && (clip.pitch || 0) !== 0) {
      const badge = document.createElement('div');
      badge.className = 'clip-badge';
      badge.textContent = (clip.pitch > 0 ? '+' : '') + clip.pitch + 'st';
      el.appendChild(badge);
    }
    if (clip.fx && clip.fx.length) {
      const fxb = document.createElement('div');
      fxb.className = 'clip-fx-badge';
      fxb.textContent = 'fx' + (clip.fx.length > 1 ? clip.fx.length : '');
      fxb.dataset.tip = clip.fx.map(f => fxName(f.type)).join(', ');
      el.appendChild(fxb);
    }

    // effects from the browser can be dropped straight onto the clip
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/fabu-fx')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('fx-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('fx-over'));
    el.addEventListener('drop', (e) => {
      const type = e.dataTransfer.getData('text/fabu-fx');
      if (!type) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('fx-over');
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

    el.addEventListener('mousedown', (e) => this.clipMouseDown(e, clip, track, el));
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
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

  // right-click menu on a clip: everything you can do with it, in one place
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
    if (clip.kind === 'midi') add(tr('menu_pianoroll', 'Open piano roll'), () => PianoRoll.open(clip.id));
    add(tr('menu_settings', 'Clip settings'), () => Windows.openInspector());
    if (clip.fx && clip.fx.length) {
      const b = document.createElement('button');
      b.className = 'ctx-item fx';
      b.textContent = tr('menu_edit_fx', 'Edit effects');
      b.addEventListener('click', () => { m.remove(); App.openFxEditor(clip.id); });
      m.appendChild(b);
    }
    add(tr('insp_duplicate', 'Duplicate'), () => App.duplicateClip());
    add(tr('insp_split', 'Split at playhead'), () => App.splitSelectedClip());
    add(tr('insp_delete', 'Delete'), () => App.deleteSelectedClip(), true);
    document.body.appendChild(m);
    m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 8) + 'px';
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); window.removeEventListener('mousedown', close, true); } };
    window.addEventListener('mousedown', close, true);
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
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (clip.kind === 'audio') {
      const s = Samples[clip.sampleId];
      if (!s || !s.buffer) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.font = '10px sans-serif';
        ctx.fillText(tr('clip_missing', 'missing sample'), 6, h / 2);
        return;
      }
      // waveform of the trimmed window only (min/max per pixel)
      const data = s.buffer.getChannelData(0);
      const sr = s.buffer.sampleRate;
      const first = Math.floor(clipOffSec(clip) * sr);
      const last = Math.min(data.length, Math.ceil((clipOffSec(clip) + clipDurSec(clip)) * sr));
      const spp = Math.max(1, (last - first) / w);
      const mid = h / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        let mn = 1, mx = -1;
        const i0 = first + Math.floor(x * spp);
        const i1 = Math.min(last, first + Math.floor((x + 1) * spp) + 1);
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
      // fade triangles
      const durOut = clipDurSec(clip) / (clip.speed || 1);
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
      // midi note preview
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
        const y = h - ((n.pitch - lo) / range) * h - 2;
        ctx.fillRect(x, y, nw, 3);
      }
    }
  },

  // drag to move (and vertical re-track), drag either edge to trim
  clipMouseDown(e, clip, track, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // shift-click just toggles this clip in the selection, no drag
    if (e.shiftKey) { App.selectClip(clip.id, true); return; }
    // in a room, a clip someone else is dragging is locked for you
    const clipLock = 'clip:' + clip.id;
    if (typeof Sync !== 'undefined' && Sync.admitted) {
      const l = Sync.lockedBy(clipLock);
      if (l) { toast(tr('mp_locked_by', '{name} is using this', { name: l.name })); return; }
      Sync.setLock(clipLock, true);
    }
    // clicking an unselected clip selects just it; clicking one that's already in
    // a multi-selection keeps the group so you can drag them all together
    if (!UI.selClipIds.has(clip.id)) App.selectClip(clip.id);
    else App.selectTrack(track.id);
    // the other selected clips that move/resize along with this one
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
    // if the snapped position keeps landing on the same spot, the user is
    // fighting the grid, so nudge them to change the snapping
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
    // move/resize the rest of the selection along with the primary clip
    const applyGroup = () => {
      if (!group.length) return;
      if (mode === 'move') {
        const delta = clip.start - orig.start;
        for (const g of group) g.clip.start = Math.max(0, g.start + delta);
      } else if (mode === 'right') {
        // resizing one pattern fits every selected pattern to the same length
        for (const g of group) if (g.clip.kind === 'midi') g.clip.length = clip.length;
      } else if (mode === 'left') {
        const delta = clip.start - orig.start;
        for (const g of group) { g.clip.start = Math.max(0, g.start + delta); }
      }
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
          clip.length = Math.max(S.snap || 0.25, snapBeat(orig.length + dxBeats, S.snap));
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
          // can't reveal material before the sample's own start
          const minStart = orig.start - orig.offset / (rate * spb);
          newStart = clamp(newStart, Math.max(0, minStart), orig.start + orig.length - 0.1);
          const d = newStart - orig.start;
          clip.start = newStart;
          clip.offset = orig.offset + d * spb * rate;
          clip.dur = orig.dur - d * spb * rate;
        }
      } else {
        clip.start = snapBeat(orig.start + dxBeats, S.snap);
        // vertical move between tracks of the same kind (single clip only)
        if (!group.length) {
          const laneIdx = clamp(
            orig.trackIdx + Math.round((ev.clientY - startY) / TRACK_H),
            0, S.tracks.length - 1);
          const target = S.tracks[laneIdx];
          const cur = getClip(clip.id).track;
          if (target && target !== cur && target.kind === cur.kind) {
            cur.clips.splice(cur.clips.indexOf(clip), 1);
            target.clips.push(clip);
            this.render();
          }
        }
      }
      applyGroup();
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
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (typeof Sync !== 'undefined') Sync.setLock(clipLock, false);
      if (moved) {
        this.render();
        Windows.refreshAll();
        PianoRoll.onStateRestore();
        toast(mode === 'move' ? tr('toast_clip_moved', 'Clip moved') : tr('toast_clip_trimmed', 'Clip trimmed'));
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  },

  // ---------- OS drag & drop of audio files ----------

  initDropZone() {
    const ghost = $('#dropGhost');
    const area = this.scroller;

    area.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('text/fabu-fx')) return; // effect drags target clips
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const beat = snapBeat(this.xToBeat(e.clientX), S.snap);
      ghost.style.display = 'block';
      ghost.style.left = (beat * UI.zoom) + 'px';
      ghost.style.height = Math.max(S.tracks.length * TRACK_H, TRACK_H) + 'px';
      setHint(tr('hint_drop_at_bar', 'Drop to place the sound at bar {bar}.', { bar: Math.floor(beat / 4) + 1 }));
    });
    area.addEventListener('dragleave', () => { ghost.style.display = 'none'; });
    area.addEventListener('drop', async (e) => {
      e.preventDefault();
      ghost.style.display = 'none';
      const beat = snapBeat(this.xToBeat(e.clientX), S.snap);
      const laneIdx = Math.floor((e.clientY - this.lanes.getBoundingClientRect().top) / TRACK_H);
      const files = [...e.dataTransfer.files].filter(f =>
        /\.(wav|mp3|ogg|m4a|aac|flac|aiff?|webm|opus)$/i.test(f.name) || f.type.startsWith('audio/'));
      if (!files.length) { toast(tr('toast_not_audio', 'That is not an audio file'), 'red'); return; }
      await App.importAudioFiles(files, beat, S.tracks[laneIdx]);
    });
  },

  // ---------- playhead ----------

  startPlayheadLoop() {
    const loop = () => {
      // one stray error must never kill the rAF chain (that froze the playhead
      // until the next play/pause); catch and keep going.
      try { this.updatePlayhead(); } catch (e) { /* keep looping */ }
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
  },

  updatePlayhead() {
    // when idle (not playing, no pending move), skip the work entirely — saves
    // battery/CPU since this fires ~60x a second forever
    if (!UI.playing && this._lastX === UI.playhead * UI.zoom) return;

    const beat = Engine.ctx && UI.playing ? Engine.currentBeat() : UI.playhead;
    const x = beat * UI.zoom;
    this._lastX = x;
    // cached refs + throttled text: this runs every frame, so keep it lean
    if (!this._phEl || !this._phEl.isConnected) {
      this._phEl = $('#playhead');
      this._posBars = $('#posBars');
      this._posTime = $('#posTime');
    }
    if (this._phEl) this._phEl.style.left = x + 'px';

    // let the others see where our playhead is (in our colour) while we play
    if (typeof Sync !== 'undefined' && Sync.admitted) {
      if (UI.playing) Sync.sendPlayhead(beat, true);
      else if (Sync._phWasPlaying) Sync.sendPlayhead(beat, false);
      Sync._phWasPlaying = UI.playing;
    }

    const now = performance.now();
    if (this._posBars && (!this._lastTxt || now - this._lastTxt > 100)) {
      this._lastTxt = now;
      const bars = Math.floor(beat / 4) + 1;
      const beats = Math.floor(beat % 4) + 1;
      this._posBars.textContent = bars + '.' + beats;
      this._posTime.textContent = fmtSec(beat * (60 / S.bpm));
    }

    if (UI.playing) {
      // keep the playhead in view (skip while following someone — their scroll wins)
      const viewL = this.scroller.scrollLeft;
      const viewR = viewL + this.scroller.clientWidth;
      const following = typeof Sync !== 'undefined' && Sync.following;
      if (!following && (x > viewR - 80 || x < viewL)) {
        this.scroller.scrollLeft = Math.max(0, x - 120);
      }
      // grow lanes if we run past the end
      if (x > this.lanes.clientWidth - 200) this.render();
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
