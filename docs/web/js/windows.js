// ---------- floating in-app windows ----------
'use strict';

const Windows = {
  wins: new Map(), // id -> { el, body, refresh }
  zTop: 30,

  // ---------- remembered geometry ----------
  GEO_KEY: 'fabu.winGeo',

  allGeo() {
    try { return JSON.parse(localStorage.getItem(this.GEO_KEY) || '{}'); } catch (e) { return {}; }
  },

  saveGeo(id, el) {
    if (!id || !el) return;
    try {
      const all = this.allGeo();
      all[id] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      localStorage.setItem(this.GEO_KEY, JSON.stringify(all));
    } catch (e) { /* private mode or quota: not worth breaking a window over */ }
  },

  loadGeo(id, fallback) {
    const g = this.allGeo()[id];
    if (!g) return fallback;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = g.w ? clamp(g.w, 260, vw) : fallback.width;
    const h = g.h ? clamp(g.h, 150, vh) : fallback.height;
    return {
      x: clamp(g.x, 0, Math.max(0, vw - 80)),
      y: clamp(g.y, 0, Math.max(0, vh - 80)),
      width: w, height: h
    };
  },

  forgetGeo() {
    try { localStorage.removeItem(this.GEO_KEY); } catch (e) {}
  },

  // home overlay sits at 400, modals 2000, ctx menu 2500. dont reshuffle these
  Z_BASE: 20,
  Z_OVER_HOME: 1000,
  raise(el) {
    const base = el.classList.contains('fwin-over-home') ? this.Z_OVER_HOME : this.Z_BASE;
    el.style.zIndex = base + (this.zTop = (this.zTop + 1) % 400);
  },

  create(id, title, iconId, opts = {}) {
    this.close(id);
    let { x = 120, y = 90, width = null, height = null } =
      this.loadGeo(id, { x: opts.x ?? 120, y: opts.y ?? 90, width: opts.width ?? null, height: opts.height ?? null });
    const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
    if (width) width = Math.min(width, vw - 16);
    if (height) height = Math.min(height, vh - 90);
    const el = document.createElement('div');
    el.className = 'fwin';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (width) el.style.width = width + 'px';
    if (height) { el.style.height = height + 'px'; el.style.maxHeight = 'none'; }
    const overHome = typeof App !== 'undefined' && App.homeVisible && App.homeVisible();
    if (overHome) el.classList.add('fwin-over-home');
    el.innerHTML = `
      <div class="fwin-head">
        <svg class="ic"><use href="#${iconId}"/></svg>
        <span class="fwin-title">${title}</span>
        <button class="fwin-close" data-tip="Close window"><svg class="ic"><use href="#i-x"/></svg></button>
      </div>
      <div class="fwin-body"></div>`;
    (overHome ? document.body : $('#workspace')).appendChild(el);

    el.addEventListener('mousedown', () => { this.raise(el); this.syncSheetBackdrop(); });
    el.querySelector('.fwin-close').addEventListener('click', () => this.close(id));

    const head = el.querySelector('.fwin-head');
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('.fwin-close')) return;
      const sx = e.clientX - el.offsetLeft;
      const sy = e.clientY - el.offsetTop;
      el.classList.add('dragging'); // goes slightly transparent while moving
      const move = (ev) => {
        el.style.left = clamp(ev.clientX - sx, -el.offsetWidth + 60, window.innerWidth - 60) + 'px';
        el.style.top = clamp(ev.clientY - sy, 0, window.innerHeight - 80) + 'px';
      };
      const up = () => {
        el.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.saveGeo(id, el);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });

    const rec = { el, body: el.querySelector('.fwin-body'), refresh: null };
    this._bindResize(el, rec, id);
    this.wins.set(id, rec);
    this.keepOnScreen(el);
    setTimeout(() => { if (this.wins.get(id) === rec) this.keepOnScreen(el); }, 0);
    this.raise(el);
    this.syncSheetBackdrop();
    return rec;
  },

  keepOnScreen(el) {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!vw || !vh) return;                       // headless: nothing to fit into
    if (el.classList.contains('fwin-sheet')) return;
    let r = el.getBoundingClientRect();
    if (r.height > vh - 20) {
      el.style.height = (vh - 20) + 'px';
      el.style.maxHeight = (vh - 20) + 'px';
      r = el.getBoundingClientRect();
    }
    if (r.width > vw - 16) { el.style.width = (vw - 16) + 'px'; r = el.getBoundingClientRect(); }
    const dx = r.right > vw - 8 ? (vw - 8 - r.right) : (r.left < 8 ? 8 - r.left : 0);
    const dy = r.bottom > vh - 8 ? (vh - 8 - r.bottom) : (r.top < 8 ? 8 - r.top : 0);
    if (dx) el.style.left = (el.offsetLeft + dx) + 'px';
    if (dy) el.style.top = (el.offsetTop + dy) + 'px';
  },

  _bindResize(el, rec, id) {
    const mk = (cls, mode) => {
      const h = document.createElement('div');
      h.className = 'fwin-rz ' + cls;
      el.appendChild(h);
      h.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        this.raise(el);
        const sx = e.clientX, sy = e.clientY, sw = el.offsetWidth, sh = el.offsetHeight;
        el.classList.add('resizing');
        el.style.maxHeight = 'none';   // let the user size it freely
        const move = (ev) => {
          if (mode !== 'b') el.style.width = Math.max(260, sw + (ev.clientX - sx)) + 'px';
          if (mode !== 'r') el.style.height = Math.max(150, sh + (ev.clientY - sy)) + 'px';
        };
        const up = () => {
          el.classList.remove('resizing');
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          if (rec.refresh) rec.refresh();
          this.saveGeo(id, el);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    };
    mk('rz-r', 'r');   // right edge  -> width
    mk('rz-b', 'b');   // bottom edge -> height
    mk('rz-c', 'c');   // corner      -> both
  },

  close(id) {
    const w = this.wins.get(id);
    this.wins.delete(id);
    if (w) {
      const el = w.el;
      const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) el.remove();
      else {
        el.classList.add('fwin-closing');
        setTimeout(() => el.remove(), 130);
      }
    }
    App.syncWindowButtons();
    this.syncSheetBackdrop();
  },

  isOpen(id) { return this.wins.has(id); },

  phone() { return window.matchMedia && matchMedia('(max-width: 760px)').matches; },

  syncSheetBackdrop() {
    let b = document.getElementById('sheetBack');
    const want = this.phone() && this.wins.size > 0;
    if (!want) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = 'sheetBack';
      b.addEventListener('click', () => this.closeTopSheet());
      document.body.appendChild(b);
    }
    let top = 0;
    for (const w2 of this.wins.values()) top = Math.max(top, parseInt(w2.el.style.zIndex || '0', 10));
    b.style.zIndex = Math.max(1, top - 1);
  },

  closeTopSheet() {
    let id = null, top = -1;
    for (const [k, w2] of this.wins) {
      const z = parseInt(w2.el.style.zIndex || '0', 10);
      if (z >= top) { top = z; id = k; }
    }
    if (id) this.close(id);
  },

  refreshAll() {
    for (const w of this.wins.values()) if (w.refresh) w.refresh();
  },

  // ---------- mixer ----------
  toggleMixer() {
    if (this.isOpen('mixer')) { this.close('mixer'); return; }
    const width = Math.min(360, window.innerWidth - 40);
    const x = clamp(140, 8, window.innerWidth - width - 8);
    const w = this.create('mixer', tr('win_mixer', 'Mixer'), 'i-mixer', { x, y: 96, width });
    w.refresh = () => this.buildMixer(w.body);
    w.refresh();
    App.syncWindowButtons();
  },

  mixSlider(parent, min, max, step, value, tip, onInput, undoLabel, lockKey) {
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = min; inp.max = max; inp.step = step; inp.value = value;
    if (tip) inp.dataset.tip = tip;
    if (lockKey) inp.dataset.lk = lockKey;
    inp.addEventListener('input', () => {
      if (!inp._gesture) { Undo.push(undoLabel); inp._gesture = true; }
      onInput(parseFloat(inp.value));
    });
    inp.addEventListener('change', () => { inp._gesture = false; });
    parent.appendChild(inp);
    return inp;
  },

  autoDot(track, param) {
    const b = document.createElement('button');
    const has = track.autom && track.autom[param] && track.autom[param].length;
    b.className = 'auto-dot' + (has ? ' on' : '');
    b.textContent = 'A';
    b.dataset.tip = tr('tip_auto_dot', 'Show this as a lane under the track');
    b.addEventListener('click', () => {
      Timeline.toggleAutomLane(track.id, param, true);
      toast(tr('toast_autom_lane', '{name} lane added under {track}',
        { name: Automation.paramLabel(param), track: track.name }), 'green');
    });
    return b;
  },

  buildEqCanvas(t, W = 132, H = 64, big = false) {
    const box = document.createElement('div');
    box.className = 'eq-canvas' + (big ? ' big' : '');
    box.dataset.tip = tr('tip_eq_canvas', 'Drag a handle up or down. Double-click it to reset.');
    const cv = document.createElement('canvas');
    box.appendChild(cv);
    const bands = ['low', 'mid', 'high'];
    const bandLbl = { low: tr('eq_low', 'LOW'), mid: tr('eq_mid', 'MID'), high: tr('eq_high', 'HIGH') };
    const bandHz = { low: '220 Hz', mid: '1 kHz', high: '4.5 kHz' };
    const L = big ? 30 : 8;          // left gutter for dB labels
    const R = W - 8;
    const topPad = big ? 16 : 6;     // readout row
    const botPad = big ? 22 : 6;     // band label rows
    const midY = (topPad + (H - botPad)) / 2;
    const halfH = (H - topPad - botPad) / 2;
    const bandX = { low: L + (R - L) * 0.14, mid: L + (R - L) * 0.5, high: L + (R - L) * 0.86 };
    const gainToY = (g) => midY - (g / 12) * halfH;
    const yToGain = (y) => clamp(((midY - y) / halfH) * 12, -12, 12);
    let active = null;               // band under the cursor, for the live readout

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      const x = cv.getContext('2d');
      x.scale(dpr, dpr);
      x.clearRect(0, 0, W, H);
      x.fillStyle = 'rgba(255,255,255,0.03)';
      x.fillRect(0, 0, W, H);

      const lines = big ? [12, 6, 0, -6, -12] : [0];
      x.textBaseline = 'middle'; x.font = '600 8.5px -apple-system, sans-serif';
      for (const db of lines) {
        const y = gainToY(db);
        x.strokeStyle = db === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
        x.lineWidth = 1;
        x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke();
        if (big) { x.fillStyle = 'rgba(255,255,255,0.38)'; x.textAlign = 'right'; x.fillText((db > 0 ? '+' : '') + db, L - 5, y); }
      }

      const pts = [[L, gainToY(t.eq.low)], [bandX.low, gainToY(t.eq.low)],
        [bandX.mid, gainToY(t.eq.mid)], [bandX.high, gainToY(t.eq.high)], [R, gainToY(t.eq.high)]];
      const trace = () => {
        x.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
          const mx = (x0 + x1) / 2;
          x.bezierCurveTo(mx, y0, mx, y1, x1, y1);
        }
      };
      x.beginPath(); trace(); x.lineTo(R, gainToY(0)); x.lineTo(L, gainToY(0)); x.closePath();
      x.globalAlpha = 0.12; x.fillStyle = t.color; x.fill(); x.globalAlpha = 1;
      x.beginPath(); trace(); x.strokeStyle = t.color; x.lineWidth = big ? 2.5 : 2; x.stroke();

      x.textAlign = 'center';
      for (const b of bands) {
        const hx = bandX[b], hy = gainToY(t.eq[b]);
        const rad = big ? 6.5 : 4.5;
        if (active === b) { x.globalAlpha = 0.25; x.fillStyle = t.color; x.beginPath(); x.arc(hx, hy, rad + 4, 0, 7); x.fill(); x.globalAlpha = 1; }
        x.fillStyle = t.color; x.beginPath(); x.arc(hx, hy, rad, 0, Math.PI * 2); x.fill();
        x.strokeStyle = 'rgba(0,0,0,0.45)'; x.lineWidth = 1.4; x.stroke();
        x.fillStyle = 'rgba(255,255,255,0.9)'; x.beginPath(); x.arc(hx, hy, rad - 2.6, 0, Math.PI * 2); x.fill();
        if (big) {
          x.fillStyle = 'rgba(255,255,255,0.5)'; x.font = '700 9px -apple-system, sans-serif';
          x.fillText(bandLbl[b], hx, H - botPad + 9);
          x.fillStyle = 'rgba(255,255,255,0.3)'; x.font = '600 8px -apple-system, sans-serif';
          x.fillText(bandHz[b], hx, H - botPad + 18);
          const g = t.eq[b];
          x.fillStyle = active === b ? t.color : 'rgba(255,255,255,0.62)';
          x.font = '700 9.5px -apple-system, sans-serif';
          x.fillText((g > 0 ? '+' : '') + g.toFixed(1) + ' dB', hx, topPad - 6);
        }
      }
    };
    draw();

    const nearBand = (mx) => {
      let best = null, bd = 1e9;
      for (const b of bands) { const d = Math.abs(mx - bandX[b]); if (d < bd) { bd = d; best = b; } }
      return bd < 30 ? best : null;
    };

    cv.addEventListener('dblclick', (e) => {
      const r = cv.getBoundingClientRect();
      const b = nearBand(e.clientX - r.left);
      if (!b) return;
      Undo.push(tr('act_change_eq', 'EQ') + ' ' + b);
      t.eq[b] = 0; Engine.updateTrack(t); draw();
      toast(tr('toast_eq_reset', 'EQ {band} reset', { band: b.toUpperCase() }));
    });

    cv.addEventListener('mousedown', (e) => {
      const r = cv.getBoundingClientRect();
      const b = nearBand(e.clientX - r.left);
      if (!b) return;
      const lk = 'eq:' + t.id + ':' + b;
      if (typeof Sync !== 'undefined' && Sync.admitted) {
        const l = Sync.lockedBy(lk);
        if (l) { toast(tr('mp_locked_by', '{name} is using this', { name: l.name })); return; }
        Sync.setLock(lk, true);
      }
      Undo.push(tr('act_change_eq', 'EQ') + ' ' + b);
      active = b;
      const move = (ev) => {
        t.eq[b] = Math.round(yToGain(ev.clientY - r.top) * 2) / 2;
        Engine.updateTrack(t); // live, also while playing
        draw();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        active = null; draw();
        if (typeof Sync !== 'undefined') Sync.setLock(lk, false);
      };
      move(e);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    return box;
  },

  buildMixer(body) {
    body.innerHTML = '<div id="mixEq"></div><div id="mixFocus"></div><div id="mixPicker"></div><div id="mixMaster"></div>';
    const bandLabel = { high: tr('eq_high', 'HIGH'), mid: tr('eq_mid', 'MID'), low: tr('eq_low', 'LOW') };
    if (!UI.selTrackId && S.tracks.length) UI.selTrackId = S.tracks[0].id;
    const selT = UI.selTrackId ? getTrack(UI.selTrackId) : null;

    // --- one clear EQ for the track you're working on ---
    const eqBox = body.querySelector('#mixEq');
    if (selT) {
      const head = document.createElement('div');
      head.className = 'mixeq-head';
      head.innerHTML = `<span>${tr('mixeq_title', 'Equalizer')}</span> <b style="color:${selT.color}">${selT.name}</b>`;
      eqBox.appendChild(head);
      eqBox.appendChild(this.buildEqCanvas(selT, 300, 116, true));
      const dotRow = document.createElement('div');
      dotRow.className = 'eq-dots';
      for (const band of ['low', 'mid', 'high']) {
        const lbl = document.createElement('span');
        lbl.textContent = bandLabel[band];
        dotRow.appendChild(lbl);
        dotRow.appendChild(this.autoDot(selT, band));
      }
      eqBox.appendChild(dotRow);
    } else {
      eqBox.innerHTML = `<div class="mixeq-empty">${tr('mixeq_pick', 'Click a track below to shape its EQ.')}</div>`;
    }

    // --- the selected track's controls ---
    const focus = body.querySelector('#mixFocus');
    if (selT) {
      const row = (labelKey, labelFb, min, max, step, value, tip, apply, undoLabel, lockKey, fmt, automParam) => {
        const r = document.createElement('div');
        r.className = 'mixf-row';
        r.innerHTML = `<span class="mixf-lbl">${tr(labelKey, labelFb)}</span>`;
        const val = document.createElement('span');
        val.className = 'mixf-val';
        val.textContent = fmt(value);
        this.mixSlider(r, min, max, step, value, tip,
          (v) => { apply(v); val.textContent = fmt(v); }, undoLabel, lockKey);
        r.appendChild(val);
        if (automParam) r.appendChild(this.autoDot(selT, automParam));
        focus.appendChild(r);
        return r;
      };
      const dbTxt = (v) => v <= 0.001 ? '-inf' : (20 * Math.log10(v)).toFixed(1) + ' dB';
      row('eq_pan', 'PAN', -1, 1, 0.05, selT.pan, tr('tip_pan', 'Pan "{name}" left or right', { name: selT.name }),
        (v) => { selT.pan = v; Engine.updateTrack(selT); }, tr('act_change_pan', 'Pan'), 'pan:' + selT.id,
        (v) => v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100), 'pan');
      row('mix_vol', 'VOL', 0, 3, 0.01, selT.volume, tr('tip_vol', 'Volume of "{name}"', { name: selT.name }),
        (v) => { selT.volume = v; Engine.updateTrack(selT); Timeline.syncHeads(); }, tr('act_change_volume', 'Volume'), 'vol:' + selT.id,
        dbTxt, 'volume');
      row('mix_swing', 'SWING', 0, 0.6, 0.02, selT.swing || 0, tr('tip_track_swing', 'Swing "{name}": nudges its offbeats for groove', { name: selT.name }),
        (v) => { selT.swing = v; if (UI.playing) Engine.liveEdit(); }, tr('act_change_swing', 'Swing'), 'swing:' + selT.id,
        (v) => Math.round(v * 100) + '%');
      row('mix_pump', 'PUMP', 0, 1, 0.02, selT.sidechain || 0, tr('tip_pump', 'Sidechain "{name}": ducks it on every beat for a pumping groove', { name: selT.name }),
        (v) => { selT.sidechain = v; Engine.rescheduleSidechain(selT); }, tr('act_change_pump', 'Pump'), 'pump:' + selT.id,
        (v) => Math.round(v * 100) + '%');
    }

    // --- compact track picker ---
    const picker = body.querySelector('#mixPicker');
    for (const t of S.tracks) {
      const chip = document.createElement('div');
      chip.className = 'mixchip' + (t.id === UI.selTrackId ? ' on' : '');
      chip.innerHTML = `<span class="mixchip-dot" style="background:${t.color}"></span><span class="mixchip-name">${t.name}</span>`;
      chip.addEventListener('click', (e) => {
        if (e.target.closest('.ms-btn')) return;
        App.selectTrack(t.id); this.buildMixer(body);
      });
      const mBtn = document.createElement('button');
      mBtn.className = 'ms-btn mute' + (t.mute ? ' on' : '');
      mBtn.textContent = tr('mix_mute', 'M');
      mBtn.dataset.tip = tr('tip_mute', 'Mute this track');
      mBtn.addEventListener('click', () => { App.toggleMute(t); this.buildMixer(body); });
      const sBtn = document.createElement('button');
      sBtn.className = 'ms-btn solo' + (t.solo ? ' on' : '');
      sBtn.textContent = tr('mix_solo', 'S');
      sBtn.dataset.tip = tr('tip_solo', 'Solo this track');
      sBtn.addEventListener('click', () => { App.toggleSolo(t); this.buildMixer(body); });
      chip.append(mBtn, sBtn);
      picker.appendChild(chip);
    }

    // --- master ---
    const mw = body.querySelector('#mixMaster');
    const mrow = document.createElement('div');
    mrow.className = 'mixf-row master';
    mrow.innerHTML = `<span class="mixf-lbl" style="color:var(--accent)">${tr('mix_master', 'Master')}</span>`;
    const mval = document.createElement('span');
    mval.className = 'mixf-val';
    const setMdb = (v) => { mval.textContent = v <= 0.001 ? '-inf' : (20 * Math.log10(v)).toFixed(1) + ' dB'; };
    this.mixSlider(mrow, 0, 3, 0.01, S.masterVol, tr('tip_master_vol', 'Overall volume'),
      (v) => { S.masterVol = v; Engine.updateAllTracks(); setMdb(v); }, tr('act_master_volume', 'Master volume'), 'vol:master');
    mrow.appendChild(mval);
    setMdb(S.masterVol);
    mw.appendChild(mrow);
  },

  // ---------- clip inspector ----------
  toggleInspector() {
    if (this.isOpen('inspector')) { this.close('inspector'); return; }
    const w = this.create('inspector', tr('win_clip', 'Clip'), 'i-info', { x: window.innerWidth - 360, y: 110, width: 300 });
    w.refresh = () => this.buildInspector(w.body);
    w.refresh();
    App.syncWindowButtons();
  },

  openInspector() {
    if (!this.isOpen('inspector')) this.toggleInspector();
    else this.wins.get('inspector').refresh();
  },

  buildInspector(body) {
    const found = UI.selClipId ? getClip(UI.selClipId) : null;
    if (!found) {
      body.innerHTML = `<div style="color:var(--dim);padding:8px 4px">${tr('insp_select', 'Select a clip on the timeline to edit it here.')}</div>`;
      return;
    }
    const { clip, track } = found;
    body.innerHTML = '';
    body.classList.add('insp-body');

    const row = (labelText) => {
      const r = document.createElement('div');
      r.className = 'frow';
      const l = document.createElement('label');
      l.textContent = labelText;
      r.appendChild(l);
      body.appendChild(r);
      return r;
    };

    const nameRow = row(tr('insp_name', 'Name'));
    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.value = clip.name || '';
    nameInp.style.cssText = 'flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px 8px;color:var(--text);outline:none';
    nameInp.addEventListener('change', () => {
      Undo.push('Rename clip');
      clip.name = nameInp.value;
      Timeline.render();
    });
    nameRow.appendChild(nameInp);

    const numField = (labelText, read, { min, max, step = 1, unit = '', tip, clipAuto }, apply, undoLabel, automParam) => {
      const r = row(labelText);
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'insp-num';
      inp.min = min; inp.max = max; inp.step = step;
      if (tip) inp.dataset.tip = tip;
      const rnd = (v) => Math.round(v * 1000) / 1000;
      inp.value = rnd(read());
      const commit = () => {
        let v = parseFloat(inp.value);
        if (isNaN(v)) v = read();
        v = clamp(v, min, max);
        inp.value = rnd(v);
        Undo.push(undoLabel);
        apply(v);
        Timeline.drawClip(clip.id);
        if (UI.playing) Engine.reschedule();
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      r.appendChild(inp);
      if (unit) { const u = document.createElement('span'); u.className = 'insp-unit'; u.textContent = unit; r.appendChild(u); }
      if (automParam && Engine.AUTOM_PARAMS.includes(automParam)) r.appendChild(this.autoDot(track, automParam));
      else if (clipAuto) {   // per-clip automation of an audio clip's pitch / speed
        const dot = document.createElement('button');
        const has = clip.autom && clip.autom[clipAuto] && clip.autom[clipAuto].length;
        dot.className = 'auto-dot' + (has ? ' on' : '');
        dot.textContent = 'A';
        dot.dataset.tip = tr('tip_auto_dot', 'Automate this over time');
        dot.addEventListener('click', () => Automation.openClip(clip.id, clipAuto));
        r.appendChild(dot);
      }
      return inp;
    };

    if (clip.kind === 'audio') {
      numField(tr('insp_gain', 'Gain'), () => (clip.gain ?? 1) * 100, { min: 0, max: 6400, step: 1, unit: '%', tip: tr('tip_clip_gain', 'Clip volume') },
        v => { clip.gain = v / 100; }, 'Clip gain', 'gain');
      numField(tr('insp_pitch', 'Pitch'), () => clip.pitch ?? 0, { min: -96, max: 96, step: 1, unit: 'st', tip: tr('tip_clip_pitch', 'Real pitch shift. Keeps the same length.'), clipAuto: 'pitch' },
        v => { clip.pitch = v; Timeline.render(); }, 'Clip pitch');
      numField(tr('insp_speed', 'Speed'), () => clip.speed ?? 1, { min: 0.05, max: 64, step: 0.05, unit: 'x', tip: tr('tip_speed', 'Playback speed. Changes length and pitch.'), clipAuto: 'speed' },
        v => { clip.speed = v; Timeline.render(); }, 'Clip speed');
      numField(tr('insp_drive', 'Drive'), () => clip.drive ?? 0, { min: 0, max: 100, step: 1, unit: '%', tip: tr('tip_drive', 'Distortion / overdrive') },
        v => { clip.drive = v; }, 'Clip drive', 'drive');
      numField(tr('insp_crush', 'Crush'), () => clip.crush ?? 0, { min: 0, max: 100, step: 1, unit: '%', tip: tr('tip_crush', 'Bit crusher, lo-fi grit') },
        v => { clip.crush = v; }, 'Clip crush', 'crush');
      numField(tr('insp_filter', 'Filter'), () => (clip.cutoff && clip.cutoff > 0) ? clip.cutoff : 20000, { min: 20, max: 22000, step: 10, unit: 'Hz', tip: tr('tip_filter', 'Low-pass filter, muffles the highs') },
        v => { clip.cutoff = v >= 20000 ? 0 : v; }, 'Clip filter', 'filter');
      numField(tr('insp_fade_in', 'Fade in'), () => clip.fadeIn ?? 0, { min: 0, max: 30, step: 0.05, unit: 's', tip: tr('tip_fade_in', 'Fade in from silence') },
        v => { clip.fadeIn = v; }, 'Fade in');
      numField(tr('insp_fade_out', 'Fade out'), () => clip.fadeOut ?? 0, { min: 0, max: 30, step: 0.05, unit: 's', tip: tr('tip_fade_out', 'Fade out to silence') },
        v => { clip.fadeOut = v; }, 'Fade out');
    } else {
      numField(tr('insp_gain', 'Gain'), () => (clip.gain ?? 1) * 100, { min: 0, max: 6400, step: 1, unit: '%', tip: tr('tip_clip_gain', 'Clip volume') },
        v => { clip.gain = v / 100; }, 'Clip gain', 'gain');
      numField(tr('insp_transpose', 'Transpose'), () => clip.pitch ?? 0, { min: -96, max: 96, step: 1, unit: 'st', tip: tr('tip_transpose', 'Shift every note up or down') },
        v => { clip.pitch = v; }, 'Transpose', 'transpose');
      numField(tr('insp_finepitch', 'Pitch'), () => clip.detune ?? 0, { min: -2400, max: 2400, step: 1, unit: 'cents', tip: tr('tip_finepitch', 'Fine pitch, in cents (100 = one semitone)') },
        v => { clip.detune = v; }, 'Pitch');
      numField(tr('insp_speed', 'Speed'), () => clip.speed ?? 1, { min: 0.05, max: 64, step: 0.05, unit: 'x', tip: tr('tip_pattern_speed', 'Play the pattern faster or slower. Changes how much timeline it takes up.') },
        v => { clip.speed = v; Timeline.render(); }, 'Pattern speed');
      numField(tr('insp_drive', 'Drive'), () => clip.drive ?? 0, { min: 0, max: 100, step: 1, unit: '%', tip: tr('tip_drive', 'Distortion / overdrive') },
        v => { clip.drive = v; }, 'Clip drive', 'drive');
      numField(tr('insp_crush', 'Crush'), () => clip.crush ?? 0, { min: 0, max: 100, step: 1, unit: '%', tip: tr('tip_crush', 'Bit crusher, lo-fi grit') },
        v => { clip.crush = v; }, 'Clip crush', 'crush');
      numField(tr('insp_filter', 'Filter'), () => (clip.cutoff && clip.cutoff > 0) ? clip.cutoff : 20000, { min: 20, max: 22000, step: 10, unit: 'Hz', tip: tr('tip_filter', 'Low-pass filter, muffles the highs') },
        v => { clip.cutoff = v >= 20000 ? 0 : v; }, 'Clip filter', 'filter');
      const info = document.createElement('div');
      info.className = 'insp-info';
      info.textContent = tr('insp_info', '{notes} notes, {beats} beats, {instr}',
        { notes: clip.notes.length, beats: clip.length, instr: instrLabel(track.instrument) });
      body.appendChild(info);
      const openBtn = document.createElement('button');
      openBtn.className = 'fbtn';
      openBtn.textContent = tr('insp_open_roll', 'Open piano roll');
      openBtn.dataset.tip = tr('tip_open_roll', 'Edit the notes');
      openBtn.style.width = '100%';
      openBtn.addEventListener('click', () => PianoRoll.open(clip.id));
      body.appendChild(openBtn);
    }

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;margin-top:12px';
    const dup = document.createElement('button');
    dup.className = 'fbtn';
    dup.style.flex = '1';
    dup.textContent = tr('insp_duplicate', 'Duplicate');
    dup.dataset.tip = tr('tip_duplicate', 'Copy after itself (Cmd D)');
    dup.addEventListener('click', () => App.duplicateClip());
    const split = document.createElement('button');
    split.className = 'fbtn';
    split.style.flex = '1';
    split.textContent = tr('insp_split', 'Split');
    split.dataset.tip = tr('tip_split', 'Split at the playhead (Cmd B)');
    split.addEventListener('click', () => App.splitSelectedClip());
    const del = document.createElement('button');
    del.className = 'fbtn danger';
    del.style.flex = '1';
    del.textContent = tr('insp_delete', 'Delete');
    del.dataset.tip = tr('tip_delete_clip', 'Delete (Backspace)');
    del.addEventListener('click', () => App.deleteSelectedClip());
    btns.append(dup, split, del);
    body.appendChild(btns);
  },

  // ---------- effects browser ----------
  toggleFxBrowser() {
    if (this.isOpen('fxbrowser')) { this.close('fxbrowser'); return; }
    const w = this.create('fxbrowser', tr('fx_title', 'Effects'), 'i-fx', { x: window.innerWidth - 320, y: 130, width: 240 });
    w.body.innerHTML = `
      <input id="fxSearch" type="text" placeholder="${tr('fx_search', 'Search effects')}" spellcheck="false"
        style="width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:6px 9px;color:var(--text);outline:none;font-size:12px;margin-bottom:8px">
      <div id="fxList"></div>
      <div style="color:var(--faint);font-size:10.5px;margin-top:8px;line-height:1.5">${tr('fx_hint', 'Drag an effect onto a clip. Right-click the clip to edit or remove it.')}</div>`;
    const list = w.body.querySelector('#fxList');
    const search = w.body.querySelector('#fxSearch');
    const render = () => {
      this.stopSamplePreview();
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      for (const type of Object.keys(FX_DEFS)) {
        const name = fxName(type);
        if (q && !name.toLowerCase().includes(q) && !type.includes(q)) continue;
        const item = document.createElement('div');
        item.className = 'fx-item';
        item.draggable = true;
        item.innerHTML = `<svg class="ic"><use href="#i-fx"/></svg><span>${name}</span>`;
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/fabu-fx', type);
          e.dataTransfer.effectAllowed = 'copy';
          item.classList.add('card-lifted');
          DragGhost.start(item, e);
          DragGhost.setPaint(e.shiftKey);
          Timeline.beginBrush(type);
        });
        item.addEventListener('dragend', () => {
          item.classList.remove('card-lifted');
          Timeline.endBrush();
        });
        list.appendChild(item);
      }
      if (!list.children.length) list.innerHTML = `<div style="color:var(--faint);font-size:11.5px;padding:6px 2px">${tr('fx_none', 'No effect matches that.')}</div>`;
    };
    search.addEventListener('input', render);
    render();
    App.syncWindowButtons();
  },

  _preview: null,
  stopSamplePreview() {
    clearTimeout(this._previewTimer);
    try { Engine.stopAudition(); } catch (e) {}
    const el = this._preview && this._preview.el;
    if (el && el.isConnected) {
      el.classList.remove('playing');
      const u = el.querySelector('.samp-play use');
      if (u) u.setAttribute('href', '#i-play');
    }
    this._preview = null;
  },

  toggleSamplePreview(sample, el) {
    if (this._preview && this._preview.id === sample.id) { this.stopSamplePreview(); return; }
    this.stopSamplePreview();
    Engine.auditionSample(sample);
    this._preview = { id: sample.id, el };
    el.classList.add('playing');
    const u = el.querySelector('.samp-play use');
    if (u) u.setAttribute('href', '#i-stop');
    const beats = Math.max(1, sample.length || 4);
    this._previewTimer = setTimeout(() => this.stopSamplePreview(),
      (beats * 60 / (S.bpm || 120)) * 1000 + 400);
  },

  // ---------- samples browser ----------
  toggleSampleBrowser() {
    if (this.isOpen('samples')) { this.close('samples'); return; }
    const w = this.create('samples', tr('samp_title', 'Loops'), 'i-loops',
      { x: 60, y: 130, width: 272, height: 330 });
    w.body.innerHTML = `
      <div class="samp-links">
        <button id="sampGallery" class="fbtn" data-tip="${tr('tip_browse_gallery', 'Loops other people have shared')}">
          <svg class="ic"><use href="#i-library"/></svg>${tr('nav_gallery', 'Gallery')}</button>
        <button id="sampProfile" class="fbtn" data-tip="${tr('samp_your_profile', 'Your profile')}">
          <svg class="ic"><use href="#i-users"/></svg>${tr('nav_profile', 'Profile')}</button>
      </div>
      <input id="sampSearch" type="text" placeholder="${tr('samp_search', 'Search loops')}" spellcheck="false"
        style="width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:6px 9px;color:var(--text);outline:none;font-size:12px;margin-bottom:8px">
      <div id="sampList" class="samp-scroll"></div>`;
    w.body.querySelector('#sampGallery').addEventListener('click', () => Gallery.toggle());
    w.body.querySelector('#sampProfile').addEventListener('click', () => Gallery.openMyProfile());
    const list = w.body.querySelector('#sampList');
    const search = w.body.querySelector('#sampSearch');
    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      const pool = MyLoops.asPresets().concat(SAMPLE_LIB);
      for (const cat of SAMPLE_CATS) {
        const items = pool.filter(s => s.cat === cat && (!q || s.name.toLowerCase().includes(q)));
        if (!items.length && cat !== 'mine') continue;
        const head = document.createElement('div');
        head.className = 'samp-cat';
        head.textContent = sampleCatName(cat);
        list.appendChild(head);
        for (const s of items) {
          const item = document.createElement('div');
          item.className = 'fx-item samp-item';
          item.draggable = true;
          item.dataset.tip = tr('tip_samp_item', 'Click to hear it, drag or double-click to add it');
          const inst = s.cat === 'fx' ? '' : `<span class="samp-inst">${instrLabel(s.instrument)}</span>`;
          const credit = s.from ? `<span class="samp-from">${escapeHtml(tr('loop_by', 'by {name}', { name: s.from }))}</span>` : '';
          item.innerHTML = `<button class="samp-play" title="${tr('samp_preview', 'Preview')}"><svg class="ic"><use href="#i-play"/></svg></button>` +
            `<span class="samp-txt"><span class="samp-nm">${escapeHtml(s.name)}</span>` +
            `<span class="samp-meta">${inst}${credit}</span></span>`;
          item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/fabu-sample', s.id);
            e.dataTransfer.effectAllowed = 'copy';
            Windows._dragSample = s;   // so the timeline can preview its size
            item.classList.add('card-lifted');
            DragGhost.start(item, e);
          });
          item.addEventListener('dragend', () => { Windows._dragSample = null; item.classList.remove('card-lifted'); });
          item.addEventListener('click', () => this.toggleSamplePreview(s, item));
          item.addEventListener('dblclick', () => { Engine.stopAudition(); App.addSampleToProject(s.id); });
          if (s.mine) {
            item.classList.add('samp-mine');
            const edit = document.createElement('button');
            edit.className = 'samp-edit';
            edit.dataset.tip = tr('loop_edit_tip', 'Rename, change the instrument, share or delete');
            edit.innerHTML = '<svg class="ic"><use href="#i-edit"/></svg>';
            edit.addEventListener('click', (e) => { e.stopPropagation(); this.editMyLoop(s.id, render); });
            item.appendChild(edit);
          }
          list.appendChild(item);
        }
        if (cat === 'mine' && !q) list.appendChild(this.newLoopTile(render));
      }
      if (!list.children.length) list.innerHTML = `<div style="color:var(--faint);font-size:11.5px;padding:6px 2px">${tr('samp_none', 'No loop matches that.')}</div>`;
    };
    this._sampRender = render;
    search.addEventListener('input', render);
    render();
    App.syncWindowButtons();
  },

  newLoopTile(rerender) {
    const tile = document.createElement('div');
    tile.className = 'samp-new';
    tile.innerHTML = `<span class="samp-new-plus">+</span>`;
    const say = () => {
      tile.classList.add('samp-new-hint');
      const hint = tile.querySelector('.samp-new-say') || document.createElement('span');
      hint.className = 'samp-new-say';
      hint.textContent = tr('loop_new_hint', 'Drag a pattern from your song anywhere into this window, or drop a .fabloop file here.');
      tile.appendChild(hint);
      clearTimeout(tile._t);
      tile._t = setTimeout(() => { tile.classList.remove('samp-new-hint'); hint.remove(); }, 4000);
    };
    tile.addEventListener('click', say);

    const take = (loop) => {
      if (!loop) { toast(tr('loop_bad_file', 'That file is not a loop fabu can read.'), 'red'); return; }
      if (!MyLoops.add(loop)) return;
      rerender();
      toast(tr('loop_added', '{name} added to your loops', { name: loop.name }), 'green');
      this.editMyLoop(loop.id, rerender);
    };

    tile.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (!types.includes('text/fabu-clip') && !types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      tile.classList.add('samp-new-over');
    });
    tile.addEventListener('dragleave', () => tile.classList.remove('samp-new-over'));
    tile.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      tile.classList.remove('samp-new-over');
      const clipId = e.dataTransfer.getData('text/fabu-clip');
      if (clipId) {
        const f = getClip(clipId);
        if (!f) return;
        const loop = MyLoops.fromClip(f.clip, f.track);
        if (!loop) { toast(tr('loop_empty', 'That pattern has no notes in it.'), 'red'); return; }
        take(loop);
        return;
      }
      const file = [...(e.dataTransfer.files || [])].find(f => MyLoops.isLoopFile(f));
      if (!file) { toast(tr('loop_bad_file', 'That file is not a loop fabu can read.'), 'red'); return; }
      take(MyLoops.parseFile(await file.text()));
    });
    return tile;
  },

  editMyLoop(id, rerender) {
    const loop = MyLoops.all().find(l => l.id === id);
    if (!loop) return;
    const old = document.getElementById('loopEdit');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'loopEdit';
    wrap.className = 'modal-back';
    const opts = INSTR_CATS.map(c =>
      `<optgroup label="${tr(c.key, c.label)}">` +
      c.ids.filter(i => INSTRUMENTS[i]).map(i =>
        `<option value="${i}"${i === loop.instrument ? ' selected' : ''}>${instrLabel(i)}</option>`).join('') +
      '</optgroup>').join('');
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('loop_edit_title', 'Your loop')}</div>
        <label class="loop-field"><span>${tr('loop_name', 'Name')}</span>
          <input id="loopName" type="text" maxlength="40" spellcheck="false"></label>
        <label class="loop-field"><span>${tr('loop_instr', 'Plays on')}</span>
          <select id="loopInstr">${opts}</select></label>
        <div class="loop-meta" id="loopMeta"></div>
        <div class="loop-send">
          <button id="loopShare" class="fbtn">${tr('loop_share', 'Share as file')}</button>
          <button id="loopPublish" class="fbtn">${tr('loop_publish', 'Put in the gallery')}</button>
        </div>
        <div class="modal-btns loop-end">
          <button id="loopDelete" class="fbtn danger-outline">${tr('loop_delete', 'Delete')}</button>
          <button id="loopDone" class="fbtn accent">${tr('loop_done', 'Done')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const nameI = wrap.querySelector('#loopName');
    const instrI = wrap.querySelector('#loopInstr');
    nameI.value = loop.name;
    wrap.querySelector('#loopMeta').textContent =
      tr('loop_meta', '{n} notes, {b} beats', { n: loop.notes.length, b: +loop.length.toFixed(2) });

    const commit = () => {
      const nm = nameI.value.trim().slice(0, 40) || tr('loop_untitled', 'My loop');
      MyLoops.update(id, { name: nm, instrument: instrI.value });
      rerender && rerender();
    };
    const close = () => { commit(); wrap.remove(); };
    nameI.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(); });
    instrI.addEventListener('change', commit);
    wrap.querySelector('#loopDone').addEventListener('click', close);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    wrap.querySelector('#loopShare').addEventListener('click', () => {
      commit();
      const l = MyLoops.all().find(x => x.id === id);
      const safe = (l.name || 'loop').replace(/[\\/:*?"<>|]/g, '') || 'loop';
      App.browserDownload(new Blob([MyLoops.toFile(l)], { type: 'application/json' }), safe + MyLoops.EXT);
      toast(tr('loop_shared', 'Saved {name}{ext}, send it to anyone', { name: safe, ext: MyLoops.EXT }), 'green');
    });
    wrap.querySelector('#loopPublish').addEventListener('click', () => {
      commit();
      wrap.remove();
      Gallery.publish(MyLoops.all().find(x => x.id === id));
    });
    wrap.querySelector('#loopDelete').addEventListener('click', async () => {
      const yes = await App.askYesNo({
        title: tr('loop_del_title', 'Delete this loop?'),
        body: tr('loop_del_body', 'It is only stored on this computer, so this cannot be undone.'),
        yes: tr('loop_delete', 'Delete'), no: tr('cancel', 'Cancel')
      });
      if (!yes) return;
      MyLoops.remove(id);
      wrap.remove();
      rerender && rerender();
    });
    setTimeout(() => { nameI.focus(); nameI.select(); }, 40);
  },

  // ---------- settings ----------
  toggleSettings() {
    if (this.isOpen('settings')) { this.close('settings'); return; }
    const w = this.create('settings', tr('win_settings', 'Settings'), 'i-gear', { x: 220, y: 140, width: 320 });
    w.refresh = () => this.buildSettings(w.body);
    w.refresh();
    App.syncWindowButtons();
  },

  buildSettings(box) {
    box.innerHTML = '';
    const inProject = !!S && !App.homeVisible();
    const head = (text, note) => {
      const h = document.createElement('div');
      h.className = 'set-head';
      h.innerHTML = `<span>${text}</span>` + (note ? `<em>${note}</em>` : '');
      box.appendChild(h);
    };
    const mkCheck = (labelText, checked, tip, onChange) => {
      const r = document.createElement('div');
      r.className = 'frow';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.style.cssText = 'width:16px;height:16px;accent-color:var(--accent)';
      const l = document.createElement('label');
      l.textContent = labelText;
      l.style.width = 'auto';
      l.style.flex = '1';
      if (tip) r.dataset.tip = tip;
      cb.addEventListener('change', () => onChange(cb.checked));
      r.append(cb, l);
      box.appendChild(r);
    };
    if (inProject) {
      head(tr('set_sec_project', 'This song'), tr('set_sec_project_note', 'saved in the file'));
      mkCheck(tr('set_countin', 'Count-in before recording'), S.countIn,
        tr('tip_countin', 'Four beats count you in before recording.'),
        (v) => { Undo.push('Count-in setting'); S.countIn = v; toast(tr(v ? 'toast_countin_on' : 'toast_countin_off', 'Count-in ' + (v ? 'on' : 'off'))); });
      mkCheck(tr('set_metro', 'Metronome while playing'), S.metronome,
        tr('tip_set_metro', 'Click on every beat (M)'),
        (v) => { App.setMetronome(v); w.refresh(); });
    }

    head(tr('set_sec_app', 'fabu'));
    mkCheck(tr('set_eco', 'Reduce CPU load (weaker computers)'), Engine.ecoMode(),
      tr('tip_eco', 'Turns off the room reverb and limits voices so playback stays smooth.'),
      (v) => { Engine.setEco(v); toast(tr(v ? 'toast_eco_on' : 'toast_eco_off', 'CPU saver ' + (v ? 'on' : 'off'))); });
    mkCheck(tr('set_scrub', 'Scrub while dragging the playhead'), Engine.scrubOn(),
      tr('tip_scrub', 'Hear the notes under the playhead as you drag it (when stopped).'),
      (v) => { Engine.setScrub(v); toast(tr(v ? 'toast_scrub_on' : 'toast_scrub_off', 'Scrubbing ' + (v ? 'on' : 'off'))); });

    if (typeof MIDI !== 'undefined' && MIDI.supported()) {
      mkCheck(tr('set_midi', 'MIDI keyboard input'), MIDI.enabled,
        tr('tip_midi', 'Play and record instruments from a connected MIDI keyboard.'),
        (v) => { MIDI.setEnabled(v); w.refresh(); });
      const midiInfo = document.createElement('div');
      midiInfo.style.cssText = 'font-size:11px;color:var(--faint);margin:-4px 0 8px 26px';
      const devs = MIDI.deviceNames();
      midiInfo.textContent = !MIDI.enabled ? tr('set_midi_off', 'Turned off.')
        : devs.length ? tr('set_midi_devices', 'Connected: {list}', { list: devs.join(', ') })
        : tr('set_midi_none', 'No MIDI keyboard detected. Plug one in and it appears here.');
      box.appendChild(midiInfo);
    }

    const r = document.createElement('div');
    r.className = 'frow';
    if (!inProject) r.style.display = 'none';   // master volume is part of the song
    r.innerHTML = `<label>${tr('set_master_vol', 'Master vol.')}</label>`;
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = 0; inp.max = 3; inp.step = 0.01; inp.value = S ? S.masterVol : 0.9;
    inp.addEventListener('input', () => {
      if (!inp._gesture) { Undo.push('Master volume'); inp._gesture = true; }
      S.masterVol = parseFloat(inp.value);
      Engine.updateAllTracks();
    });
    inp.addEventListener('change', () => { inp._gesture = false; });
    r.appendChild(inp);
    box.appendChild(r);

    const micRow = document.createElement('div');
    micRow.className = 'frow';
    micRow.style.marginTop = '4px';
    const micLbl = document.createElement('label');
    micLbl.textContent = tr('set_mic', 'Microphone');
    micLbl.style.cssText = 'flex:0 0 auto;width:auto';
    const micSel = document.createElement('select');
    micSel.style.cssText = 'flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:4px 6px;color:var(--text)';
    const optDefault = document.createElement('option');
    optDefault.value = ''; optDefault.textContent = tr('set_mic_default', 'System default');
    micSel.appendChild(optDefault);
    micSel.value = Engine.micId();
    micSel.addEventListener('change', () => { Engine.setMicId(micSel.value); toast(tr('toast_mic_set', 'Microphone changed')); });
    micRow.append(micLbl, micSel);
    box.appendChild(micRow);
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then((devs) => {
        const ins = devs.filter(d => d.kind === 'audioinput');
        for (const d of ins) {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || tr('set_mic_generic', 'Microphone');
          micSel.appendChild(o);
        }
        micSel.value = Engine.micId();
        if (!ins.some(d => d.label)) {
          const hint = document.createElement('div');
          hint.style.cssText = 'color:var(--faint);font-size:10px;margin:-2px 0 4px';
          hint.textContent = tr('set_mic_hint', 'Record once to see device names.');
          micRow.after(hint);
        }
      }).catch(() => {});
    }

    const note = document.createElement('div');
    note.style.cssText = 'color:var(--faint);font-size:10.5px;margin-top:10px;line-height:1.5';
    note.textContent = tr('set_note', 'Projects save as .fab files, sounds included. Export makes a WAV audio file.');
    box.appendChild(note);

    const acct = document.createElement('div');
    acct.className = 'frow';
    acct.style.cssText = 'margin-top:12px;border-top:1px solid var(--line);padding-top:12px';
    const label = document.createElement('label');
    label.style.cssText = 'flex:1;width:auto';
    label.textContent = Auth.isLoggedIn()
      ? tr('set_signed_in', 'Signed in as {name}', { name: Auth.user })
      : tr('set_no_account', 'Not signed in');
    const btn = document.createElement('button');
    btn.className = 'fbtn';
    btn.textContent = Auth.isLoggedIn() ? tr('set_manage_acct', 'Account') : tr('auth_login', 'Log in');
    btn.addEventListener('click', () => { Auth.openAccount(); });
    acct.append(label, btn);
    box.appendChild(acct);

    const ver = document.createElement('div');
    ver.className = 'frow';
    ver.style.marginTop = '10px';
    const vLabel = document.createElement('label');
    vLabel.style.cssText = 'flex:1;width:auto;color:var(--faint)';
    if (window.electronAPI && window.electronAPI.checkUpdates) {
      vLabel.textContent = 'fabu v' + (App.version || '…');
      const vBtn = document.createElement('button');
      vBtn.className = 'fbtn';
      vBtn.textContent = tr('set_check_updates', 'Check for updates');
      vBtn.addEventListener('click', async () => {
        vBtn.disabled = true;
        vBtn.textContent = tr('set_checking', 'Checking…');
        const r = await App.checkForUpdates();
        vBtn.disabled = false;
        vBtn.textContent = tr('set_check_updates', 'Check for updates');
        if (r === 'latest') toast(tr('set_up_to_date', "You're on the latest version."), 'green');
        else if (r === 'error') toast(tr('set_check_failed', 'Could not check. Are you online?'), 'red');
      });
      ver.append(vLabel, vBtn);
    } else {
      vLabel.textContent = tr('set_web_version', 'fabu web, always the latest version');
      ver.appendChild(vLabel);
    }
    box.appendChild(ver);
  },

  // ---------- help ----------
  toggleHelp() {
    if (this.isOpen('help')) { this.close('help'); return; }
    const w = this.create('help', tr('win_shortcuts', 'Shortcuts'), 'i-help', { x: 300, y: 80, width: 430 });
    const rows = [
      ['<kbd>Space</kbd>', tr('help_play', 'Play or pause')],
      ['<kbd>Enter</kbd>', tr('help_stop', 'Stop')],
      ['<kbd>R</kbd>', tr('help_record', 'Record')],
      ['<kbd>M</kbd>', tr('help_metronome', 'Metronome')],
      ['<kbd>K</kbd>', tr('help_keyboard', 'Keyboard')],
      ['<kbd>X</kbd>', tr('help_mixer', 'Mixer')],
      ['<kbd>Cmd</kbd><kbd>Z</kbd>', tr('help_undo', 'Undo')],
      ['<kbd>Cmd</kbd><kbd>Y</kbd>', tr('help_redo', 'Redo')],
      ['<kbd>Cmd</kbd><kbd>C</kbd> <kbd>X</kbd> <kbd>V</kbd>', tr('help_copy', 'Copy, cut, paste')],
      ['<kbd>Cmd</kbd><kbd>D</kbd>', tr('help_duplicate', 'Duplicate clip')],
      ['<kbd>Cmd</kbd><kbd>B</kbd>', tr('help_split', 'Split clip at the playhead')],
      ['<kbd>Cmd</kbd><kbd>G</kbd>', tr('help_group', 'Group the selected clips')],
      ['<kbd>Cmd</kbd><kbd>Shift</kbd><kbd>G</kbd>', tr('help_ungroup', 'Ungroup')],
      ['<kbd>L</kbd>', tr('help_loop', 'Repeat a section on and off')],
      [tr('help_col_shift_ruler', 'Shift-drag the ruler'), tr('help_set_loop', 'Set the repeat region')],
      [tr('help_col_right_ruler', 'Right-click the ruler'), tr('help_ruler_menu', 'Section markers and repeat options')],
      [tr('help_col_drag_playhead', 'Drag the playhead'), tr('help_scrub', 'Hear what is under it')],
      [tr('help_col_drag_edges', 'Drag clip edges'), tr('help_trim', 'Trim a clip')],
      ['<kbd>Delete</kbd>', tr('help_delete', 'Delete clip or note')],
      ['<kbd>Cmd</kbd><kbd>S</kbd>', tr('help_save', 'Save project')],
      ['<kbd>Cmd</kbd><kbd>O</kbd>', tr('help_open', 'Open project')],
      ['<kbd>Cmd</kbd><kbd>E</kbd>', tr('help_export', 'Export song as WAV')],
      ['<kbd>Cmd</kbd><kbd>+</kbd> <kbd>&minus;</kbd>', tr('help_zoom', 'Zoom')],
      ['<kbd>A S D F</kbd>', tr('help_white_keys', 'White keys')],
      ['<kbd>W E T Z U</kbd>', tr('help_black_keys', 'Black keys')],
      ['<kbd>Z</kbd> <kbd>X</kbd>', tr('help_octave', 'Octave down, up')],
      ['<kbd>Shift</kbd>', tr('help_pedal', 'Sustain pedal, while the keyboard is open')],
      [tr('help_col_pedal_strip', 'Drag under the bar numbers'), tr('help_pedal_edit', 'Paint the sustain pedal in the piano roll')],
      [tr('help_col_drop_midi', 'Drop a MIDI file in'), tr('help_drop_midi', 'Turns it into patterns you can edit')],
      [tr('help_col_double_lane', 'Double-click lane'), tr('help_new_pattern', 'New pattern')],
      [tr('help_col_double_clip', 'Double-click clip'), tr('help_edit_clip', 'Edit it')],
      [tr('help_col_rightclick', 'Right-click clip or note'), tr('help_rightclick', 'Delete it')],
      [tr('help_col_drag_sound', 'Drag a sound in'), tr('help_drag_sound', 'Add it where you drop')],
      [tr('help_col_drag_between', 'Drag a clip between tracks'), tr('help_new_track', 'Drop in the gap for a new track')],
      [tr('help_col_shift_click', 'Shift-click clips'), tr('help_multi', 'Select several at once')],
      [tr('help_col_a_button', 'The A buttons'), tr('help_autom', 'Automate that value over time')]
    ];
    w.body.innerHTML = '<table class="kbd-table">' +
      rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('') + '</table>';
    App.syncWindowButtons();
  }
};
