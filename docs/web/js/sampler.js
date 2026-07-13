// ---------- Sampler: build / edit a playable instrument from an audio file ----------
'use strict';

const Sampler = {
  trackId: null,
  editId: null,        // instrument id when editing an existing one
  sampleId: null,      // existing sample id being reused
  newFile: false,
  buffer: null,
  bytes: null,
  mime: '',
  fileName: '',
  customName: '',
  root: 60,
  start: 0,
  end: 0,
  attack: 0.005,
  release: 0.08,
  viewStart: 0,        // visible window into the buffer (seconds), for zooming
  viewEnd: 1,
  cv: null,
  body: null,
  previewSrc: null,
  MAX_SEC: 60,

  isOpen() { return Windows.isOpen('sampler'); },

  open(trackId, editId = null) {
    this.trackId = getTrack(trackId) ? trackId : ((S.tracks.find(t => t.kind === 'midi') || {}).id || null);
    this.editId = (editId && resolveInstrument(editId)) ? editId : null;
    this.newFile = false;

    if (this.editId) {
      const inst = resolveInstrument(this.editId);
      const s = Samples[inst.sampleId];
      this.buffer = s ? s.buffer : null;
      this.bytes = s ? s.bytes : null;
      this.mime = s ? s.mime : '';
      this.sampleId = inst.sampleId;
      this.fileName = inst.name;
      this.customName = inst.name;
      this.root = inst.root ?? 60;
      this.start = inst.start ?? 0;
      this.end = inst.end != null ? inst.end : (this.buffer ? this.buffer.duration : 0);
      this.attack = inst.attack ?? 0.005;
      this.release = inst.release ?? 0.08;
    } else {
      this.buffer = null; this.bytes = null; this.sampleId = null; this.fileName = '';
      this.customName = ''; this.root = 60; this.start = 0; this.end = 0;
      this.attack = 0.005; this.release = 0.08;
    }
    this.viewStart = 0;
    this.viewEnd = this.buffer ? this.buffer.duration : 1;

    const w = Windows.create('sampler',
      tr(this.editId ? 'win_sampler_edit' : 'win_sampler', this.editId ? 'Edit instrument' : 'New instrument'),
      'i-piano', { x: Math.max(20, window.innerWidth / 2 - 230), y: 120, width: 460 });
    this.body = w.body;
    this.build();
    App.syncWindowButtons();
  },

  build() {
    const body = this.body;
    body.innerHTML = '';

    const hint = document.createElement('div');
    hint.style.cssText = 'color:var(--dim);font-size:11.5px;line-height:1.5;margin-bottom:10px';
    hint.textContent = tr('samp_hint', 'Load a sound up to 1 minute, set where it starts and ends, then save it as an instrument you can play.');
    body.appendChild(hint);

    const fileRow = document.createElement('div');
    fileRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:10px';
    const pick = document.createElement('button');
    pick.className = 'fbtn';
    pick.textContent = tr('samp_choose', 'Choose audio file');
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'audio/*'; inp.style.display = 'none';
    pick.addEventListener('click', () => inp.click());
    inp.addEventListener('change', () => { if (inp.files[0]) this.loadFile(inp.files[0]); });
    const fname = document.createElement('span');
    fname.id = 'sampFname';
    fname.style.cssText = 'font-size:11.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    fname.textContent = this.buffer ? (this.fileName || tr('samp_loaded', 'Loaded')) : tr('samp_no_wave', 'No file loaded');
    fileRow.append(pick, inp, fname);
    body.appendChild(fileRow);

    this.cv = document.createElement('canvas');
    this.cv.style.cssText = 'display:block;width:100%;height:96px;border:1px solid var(--line);border-radius:8px;cursor:ew-resize;margin-bottom:6px';
    body.appendChild(this.cv);
    this.bindWave();

    // timestamps + zoom hint
    const times = document.createElement('div');
    times.id = 'sampTimes';
    times.style.cssText = 'display:flex;justify-content:space-between;font-size:10.5px;color:var(--dim);font-variant-numeric:tabular-nums;margin-bottom:12px';
    times.innerHTML = '<span id="sampSel"></span><span id="sampZoomHint" style="color:var(--faint)">' +
      tr('samp_zoom_hint', 'Scroll to zoom, drag the edges to trim') + '</span>';
    body.appendChild(times);

    body.appendChild(this.textRow(tr('samp_name', 'Name'), this.customName, (v) => { this.customName = v; }, 'sampName'));

    const rootRow = this.rowShell(tr('samp_root', 'Root note'));
    const sel = document.createElement('select');
    sel.style.cssText = 'flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:4px 6px;color:var(--text)';
    sel.dataset.tip = tr('tip_samp_root', 'The note the sample plays at its original pitch');
    for (let m = 36; m <= 84; m++) {
      const o = document.createElement('option');
      o.value = m; o.textContent = noteName(m);
      if (m === this.root) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { this.root = parseInt(sel.value); });
    rootRow.appendChild(sel);
    body.appendChild(rootRow);

    body.appendChild(this.sliderRow(tr('samp_attack', 'Attack'), 0, 1, 0.005, this.attack, v => v.toFixed(2) + ' s', v => { this.attack = v; }));
    body.appendChild(this.sliderRow(tr('samp_release', 'Release'), 0, 2, 0.01, this.release, v => v.toFixed(2) + ' s', v => { this.release = v; }));

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;margin-top:12px';
    const prev = document.createElement('button');
    prev.className = 'fbtn'; prev.style.flex = '1';
    prev.textContent = tr('samp_preview', 'Preview') + '  ⎵';
    prev.dataset.tip = tr('tip_samp_preview', 'Play the selected part (Space)');
    prev.addEventListener('click', () => this.preview());
    const save = document.createElement('button');
    save.className = 'fbtn'; save.style.flex = '1';
    save.style.borderColor = 'var(--accent)'; save.style.color = 'var(--accent)';
    save.textContent = tr('samp_save', 'Save instrument');
    save.addEventListener('click', () => this.save());
    btns.append(prev, save);
    if (this.editId) {
      const del = document.createElement('button');
      del.className = 'fbtn danger'; del.style.flex = '0 0 auto';
      del.textContent = tr('samp_delete', 'Delete');
      del.addEventListener('click', () => this.deleteInstrument());
      btns.appendChild(del);
    }
    body.appendChild(btns);

    this.drawWave();
    this.updateTimes();
  },

  rowShell(label) {
    const r = document.createElement('div');
    r.className = 'frow';
    const l = document.createElement('label'); l.textContent = label;
    r.appendChild(l);
    return r;
  },
  textRow(label, value, onInput, id) {
    const r = this.rowShell(label);
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = value || ''; inp.id = id;
    inp.style.cssText = 'flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px 8px;color:var(--text);outline:none';
    inp.addEventListener('input', () => onInput(inp.value));
    r.appendChild(inp);
    return r;
  },
  sliderRow(label, min, max, step, value, fmt, onInput) {
    const r = this.rowShell(label);
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
    const val = document.createElement('span');
    val.className = 'val'; val.textContent = fmt(value);
    inp.addEventListener('input', () => { const v = parseFloat(inp.value); onInput(v); val.textContent = fmt(v); });
    r.append(inp, val);
    return r;
  },

  async loadFile(file) {
    Engine.ensureCtx();
    try {
      const bytes = await file.arrayBuffer();
      const buffer = await Engine.ctx.decodeAudioData(bytes.slice(0));
      this.bytes = bytes;
      this.buffer = buffer;
      this.mime = file.type || 'audio/*';
      this.fileName = file.name.replace(/\.[^.]+$/, '');
      this.newFile = true;
      this.sampleId = null;
      this.start = 0;
      this.end = Math.min(buffer.duration, this.MAX_SEC);
      this.viewStart = 0;
      this.viewEnd = buffer.duration;
      if (buffer.duration > this.MAX_SEC) toast(tr('samp_too_long', 'Trimmed to 1 minute'));
      const nm = this.body.querySelector('#sampName');
      if (nm && !nm.value) { nm.value = this.fileName; this.customName = this.fileName; }
      this.body.querySelector('#sampFname').textContent = file.name;
      this.drawWave();
      this.updateTimes();
    } catch (e) {
      toast(tr('toast_decode_fail', 'Could not decode recording'), 'red');
    }
  },

  // --- coordinate helpers within the zoomed view ---
  viewLen() { return Math.max(0.0001, this.viewEnd - this.viewStart); },
  timeToX(t, W) { return ((t - this.viewStart) / this.viewLen()) * W; },
  xToTime(px, W) { return clamp(this.viewStart + (px / W) * this.viewLen(), 0, this.buffer ? this.buffer.duration : 0); },

  updateTimes() {
    const el = this.body && this.body.querySelector('#sampSel');
    if (!el) return;
    if (!this.buffer) { el.textContent = ''; return; }
    const f = (s) => s.toFixed(2) + 's';
    el.innerHTML =
      `${tr('samp_start', 'Start')} <b style="color:var(--green)">${f(this.start)}</b> · ` +
      `${tr('samp_end', 'End')} <b style="color:var(--red)">${f(this.end)}</b> · ` +
      `${tr('samp_length', 'Length')} <b style="color:var(--text)">${f(Math.max(0, this.end - this.start))}</b>`;
  },

  drawWave() {
    const cv = this.cv;
    if (!cv) return;
    const W = cv.clientWidth || 420, H = 96;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#161310';
    g.fillRect(0, 0, W, H);
    if (!this.buffer) {
      g.fillStyle = 'rgba(255,255,255,0.28)';
      g.font = '11px -apple-system, sans-serif';
      g.fillText(tr('samp_no_wave', 'No file loaded'), 10, H / 2);
      return;
    }
    const data = this.buffer.getChannelData(0);
    const sr = this.buffer.sampleRate;
    const i0v = Math.floor(this.viewStart * sr);
    const i1v = Math.min(data.length, Math.ceil(this.viewEnd * sr));
    const spp = Math.max(1, (i1v - i0v) / W);
    const mid = H / 2;
    g.fillStyle = 'rgba(224,122,63,0.7)';
    for (let x = 0; x < W; x++) {
      let mn = 1, mx = -1;
      const a = i0v + Math.floor(x * spp), b = Math.min(i1v, i0v + Math.floor((x + 1) * spp) + 1);
      for (let i = a; i < b; i += Math.max(1, Math.floor((b - a) / 40))) {
        const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v;
      }
      g.fillRect(x, mid - mx * mid * 0.9, 1, Math.max(1, (mx - mn) * mid * 0.9));
    }
    // dim outside the trimmed region
    const sx = this.timeToX(this.start, W), ex = this.timeToX(this.end, W);
    g.fillStyle = 'rgba(10,9,7,0.66)';
    if (sx > 0) g.fillRect(0, 0, sx, H);
    if (ex < W) g.fillRect(ex, 0, W - ex, H);
    // handles
    g.fillStyle = '#78b56a'; g.fillRect(clamp(sx, 0, W) - 1, 0, 2, H);
    g.fillStyle = '#d8594f'; g.fillRect(clamp(ex, 0, W) - 1, 0, 2, H);
  },

  bindWave() {
    this.cv.addEventListener('mousedown', (e) => {
      if (!this.buffer) return;
      const r = this.cv.getBoundingClientRect();
      const W = r.width;
      const px = e.clientX - r.left;
      const sx = this.timeToX(this.start, W), ex = this.timeToX(this.end, W);
      const which = Math.abs(px - sx) <= Math.abs(px - ex) ? 'start' : 'end';
      const move = (ev) => {
        const t = this.xToTime(ev.clientX - r.left, W);
        if (which === 'start') this.start = Math.min(t, this.end - 0.02);
        else this.end = Math.max(t, this.start + 0.02);
        this.drawWave(); this.updateTimes();
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      move(e);
    });

    // scroll to zoom (centered on cursor); two-finger horizontal pans
    this.cv.addEventListener('wheel', (e) => {
      if (!this.buffer) return;
      e.preventDefault();
      const r = this.cv.getBoundingClientRect();
      const W = r.width;
      const dur = this.buffer.duration;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // pan
        const shift = (e.deltaX / W) * this.viewLen();
        let vs = this.viewStart + shift, ve = this.viewEnd + shift;
        if (vs < 0) { ve -= vs; vs = 0; }
        if (ve > dur) { vs -= (ve - dur); ve = dur; }
        this.viewStart = Math.max(0, vs); this.viewEnd = Math.min(dur, ve);
      } else {
        // zoom around the cursor time
        const cursorT = this.xToTime(e.clientX - r.left, W);
        const factor = Math.pow(1.0015, e.deltaY);
        let len = clamp(this.viewLen() * factor, 0.02, dur);
        let vs = cursorT - (cursorT - this.viewStart) * (len / this.viewLen());
        let ve = vs + len;
        if (vs < 0) { vs = 0; ve = len; }
        if (ve > dur) { ve = dur; vs = dur - len; }
        this.viewStart = Math.max(0, vs); this.viewEnd = Math.min(dur, ve);
      }
      this.drawWave();
    }, { passive: false });
  },

  preview() {
    if (!this.buffer) { toast(tr('samp_need_file', 'Choose an audio file first'), 'red'); return; }
    Engine.ensureCtx();
    Engine.ctx.resume();
    const ac = Engine.ctx;
    if (this.previewSrc) { try { this.previewSrc.stop(); } catch (e) {} }
    const src = ac.createBufferSource();
    src.buffer = this.buffer;
    const g = ac.createGain();
    g.gain.value = 0.9;
    src.connect(g); g.connect(Engine.master);
    src.start(ac.currentTime, this.start, Math.max(0.02, this.end - this.start));
    this.previewSrc = src;
    src.onended = () => { if (this.previewSrc === src) this.previewSrc = null; };
  },

  save() {
    if (!this.buffer) { toast(tr('samp_need_file', 'Choose an audio file first'), 'red'); return; }
    Undo.push(this.editId ? 'Edit instrument' : 'Add instrument');
    const name = (this.customName || this.fileName || 'Instrument').trim() || 'Instrument';
    let sid = this.sampleId;
    if (!sid || this.newFile) {
      sid = uid('smp');
      Samples[sid] = { id: sid, name, buffer: this.buffer, bytes: this.bytes, mime: this.mime };
    }
    const id = this.editId || uid('samp');
    const def = { id, name, sampleId: sid, root: this.root, start: this.start, end: this.end, attack: this.attack, release: this.release };
    S.instruments[id] = Object.assign(S.instruments[id] || {}, def);
    App.addToLibrary(def);        // persist so it survives across projects
    if (!this.editId) {
      const t = getTrack(this.trackId);
      if (t && t.kind === 'midi') t.instrument = id;
    }
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    toast(tr('samp_saved', 'Instrument saved'), 'green');
    Windows.close('sampler');
  },

  deleteInstrument() {
    if (!this.editId) return;
    Undo.push('Delete instrument');
    for (const t of S.tracks) if (t.instrument === this.editId) t.instrument = 'keys';
    delete S.instruments[this.editId];
    App.removeFromLibrary(this.editId);   // remove from the persistent library too
    Timeline.render();
    Windows.refreshAll();
    KeysPanel.refreshTracks();
    toast(tr('samp_deleted', 'Instrument deleted'));
    Windows.close('sampler');
  }
};
