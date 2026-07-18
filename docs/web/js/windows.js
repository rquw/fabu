// ---------- Floating in-app windows: mixer, clip inspector, settings, help ----------
'use strict';

const Windows = {
  wins: new Map(), // id -> { el, body, refresh }
  zTop: 30,

  create(id, title, iconId, { x = 120, y = 90, width = null } = {}) {
    this.close(id);
    const el = document.createElement('div');
    el.className = 'fwin';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (width) el.style.width = width + 'px';
    el.innerHTML = `
      <div class="fwin-head">
        <svg class="ic"><use href="#${iconId}"/></svg>
        <span class="fwin-title">${title}</span>
        <button class="fwin-close" data-tip="Close window"><svg class="ic"><use href="#i-x"/></svg></button>
      </div>
      <div class="fwin-body"></div>`;
    $('#workspace').appendChild(el);

    el.addEventListener('mousedown', () => { el.style.zIndex = ++this.zTop; });
    el.querySelector('.fwin-close').addEventListener('click', () => this.close(id));

    // drag by header
    const head = el.querySelector('.fwin-head');
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('.fwin-close')) return;
      const sx = e.clientX - el.offsetLeft;
      const sy = e.clientY - el.offsetTop;
      const move = (ev) => {
        el.style.left = clamp(ev.clientX - sx, -el.offsetWidth + 60, window.innerWidth - 60) + 'px';
        el.style.top = clamp(ev.clientY - sy, 0, window.innerHeight - 80) + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });

    const rec = { el, body: el.querySelector('.fwin-body'), refresh: null };
    this.wins.set(id, rec);
    return rec;
  },

  close(id) {
    const w = this.wins.get(id);
    if (w) { w.el.remove(); this.wins.delete(id); }
    App.syncWindowButtons();
  },

  isOpen(id) { return this.wins.has(id); },

  refreshAll() {
    for (const w of this.wins.values()) if (w.refresh) w.refresh();
  },

  // ---------- Mixer ----------

  toggleMixer() {
    if (this.isOpen('mixer')) { this.close('mixer'); return; }
    const width = clamp((S.tracks.length + 1) * 128 + 26, 300, window.innerWidth - 40);
    const x = clamp(140, 8, window.innerWidth - width - 8);
    const w = this.create('mixer', tr('win_mixer', 'Mixer'), 'i-mixer', { x, y: 96, width });
    w.refresh = () => this.buildMixer(w.body);
    w.refresh();
    App.syncWindowButtons();
  },

  // slider that pushes one undo per drag gesture
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

  // small keyframe toggle that opens the automation editor for a param
  autoDot(track, param) {
    const b = document.createElement('button');
    const has = track.autom && track.autom[param] && track.autom[param].length;
    b.className = 'auto-dot' + (has ? ' on' : '');
    b.textContent = 'A';
    b.dataset.tip = tr('tip_auto_dot', 'Automate this over time');
    b.addEventListener('click', () => Automation.open(track.id, param));
    return b;
  },

  // A little EQ curve you shape by dragging three points (low / mid / high).
  // Maps straight onto the existing 3-band chain, so it applies live.
  buildEqCanvas(t) {
    const W = 132, H = 64, PAD = 10;
    const box = document.createElement('div');
    box.className = 'eq-canvas';
    box.dataset.tip = tr('tip_eq_canvas', 'Drag the points to shape the EQ. Double-click a point to reset it.');
    const cv = document.createElement('canvas');
    box.appendChild(cv);
    const bands = ['low', 'mid', 'high'];
    const bandX = { low: PAD + (W - 2 * PAD) * 0.12, mid: PAD + (W - 2 * PAD) * 0.5, high: PAD + (W - 2 * PAD) * 0.88 };
    const gainToY = (g) => H / 2 - (g / 12) * (H / 2 - 8);
    const yToGain = (y) => clamp(((H / 2 - y) / (H / 2 - 8)) * 12, -12, 12);

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      const x = cv.getContext('2d');
      x.scale(dpr, dpr);
      x.clearRect(0, 0, W, H);
      x.fillStyle = 'rgba(255,255,255,0.04)';
      x.fillRect(0, 0, W, H);
      x.strokeStyle = 'rgba(255,255,255,0.12)';
      x.beginPath(); x.moveTo(0, H / 2); x.lineTo(W, H / 2); x.stroke();
      // the curve through the three points
      const pts = [[0, gainToY(t.eq.low)], [bandX.low, gainToY(t.eq.low)],
        [bandX.mid, gainToY(t.eq.mid)], [bandX.high, gainToY(t.eq.high)], [W, gainToY(t.eq.high)]];
      x.strokeStyle = t.color; x.lineWidth = 2;
      x.beginPath();
      x.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        const mx = (x0 + x1) / 2;
        x.bezierCurveTo(mx, y0, mx, y1, x1, y1);
      }
      x.stroke();
      // handles
      for (const b of bands) {
        x.fillStyle = t.color;
        x.beginPath(); x.arc(bandX[b], gainToY(t.eq[b]), 4.5, 0, Math.PI * 2); x.fill();
        x.strokeStyle = 'rgba(0,0,0,0.4)'; x.lineWidth = 1.2; x.stroke();
      }
    };
    draw();

    const nearBand = (mx) => {
      let best = null, bd = 1e9;
      for (const b of bands) { const d = Math.abs(mx - bandX[b]); if (d < bd) { bd = d; best = b; } }
      return bd < 26 ? best : null;
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
      const move = (ev) => {
        t.eq[b] = Math.round(yToGain(ev.clientY - r.top) * 2) / 2;
        Engine.updateTrack(t); // live, also while playing
        draw();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (typeof Sync !== 'undefined') Sync.setLock(lk, false);
      };
      move(e);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    return box;
  },

  buildMixer(body) {
    body.innerHTML = '<div id="mixerStrips"></div>';
    const strips = body.querySelector('#mixerStrips');
    const bandLabel = { high: tr('eq_high', 'HIGH'), mid: tr('eq_mid', 'MID'), low: tr('eq_low', 'LOW') };

    for (const t of S.tracks) {
      const strip = document.createElement('div');
      strip.className = 'strip';
      strip.innerHTML = `<div class="strip-name" style="color:${t.color}">${t.name}</div>`;

      const eqBox = document.createElement('div');
      eqBox.className = 'strip-eq';
      eqBox.appendChild(this.buildEqCanvas(t));
      // keep the automation dots reachable
      const dotRow = document.createElement('div');
      dotRow.className = 'eq-dots';
      for (const band of ['low', 'mid', 'high']) {
        const lbl = document.createElement('span');
        lbl.textContent = bandLabel[band][0];
        dotRow.appendChild(lbl);
        dotRow.appendChild(this.autoDot(t, band));
      }
      eqBox.appendChild(dotRow);
      strip.appendChild(eqBox);

      const panRow = document.createElement('div');
      panRow.className = 'mix-row';
      panRow.innerHTML = `<span class="mix-lbl">${tr('eq_pan', 'PAN')}</span>`;
      this.mixSlider(panRow, -1, 1, 0.05, t.pan, tr('tip_pan', 'Pan "{name}" left or right', { name: t.name }),
        (v) => { t.pan = v; Engine.updateTrack(t); }, tr('act_change_pan', 'Pan'), 'pan:' + t.id);
      panRow.appendChild(this.autoDot(t, 'pan'));
      strip.appendChild(panRow);

      const div = document.createElement('div');
      div.className = 'strip-div';
      strip.appendChild(div);

      const volRow = document.createElement('div');
      volRow.className = 'mix-row';
      volRow.innerHTML = `<span class="mix-lbl">${tr('mix_vol', 'VOL')}</span>`;
      const db = document.createElement('div');
      db.className = 'strip-db';
      const setDb = (v) => { db.textContent = v <= 0.001 ? '-inf' : (20 * Math.log10(v)).toFixed(1) + ' dB'; };
      this.mixSlider(volRow, 0, 3, 0.01, t.volume, tr('tip_vol', 'Volume of "{name}"', { name: t.name }),
        (v) => { t.volume = v; Engine.updateTrack(t); Timeline.syncHeads(); setDb(v); },
        tr('act_change_volume', 'Volume'), 'vol:' + t.id);
      volRow.appendChild(this.autoDot(t, 'volume'));
      strip.appendChild(volRow);
      setDb(t.volume);
      strip.appendChild(db);

      const ms = document.createElement('div');
      ms.className = 'strip-ms';
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
      ms.append(mBtn, sBtn);
      strip.appendChild(ms);

      strips.appendChild(strip);
    }

    // master strip
    const m = document.createElement('div');
    m.className = 'strip master';
    m.innerHTML = `<div class="strip-name" style="color:var(--accent)">${tr('mix_master', 'Master')}</div><div style="flex:1"></div>`;
    const volRow = document.createElement('div');
    volRow.className = 'mix-row';
    volRow.innerHTML = `<span class="mix-lbl">${tr('mix_vol', 'VOL')}</span>`;
    const mdb = document.createElement('div');
    mdb.className = 'strip-db';
    const setMdb = (v) => { mdb.textContent = v <= 0.001 ? '-inf' : (20 * Math.log10(v)).toFixed(1) + ' dB'; };
    this.mixSlider(volRow, 0, 3, 0.01, S.masterVol, tr('tip_master_vol', 'Overall volume'),
      (v) => { S.masterVol = v; Engine.updateAllTracks(); setMdb(v); }, tr('act_master_volume', 'Master volume'), 'vol:master');
    m.appendChild(volRow);
    setMdb(S.masterVol);
    m.appendChild(mdb);
    strips.appendChild(m);
  },

  // ---------- Clip inspector ----------

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

    const row = (labelText) => {
      const r = document.createElement('div');
      r.className = 'frow';
      const l = document.createElement('label');
      l.textContent = labelText;
      r.appendChild(l);
      body.appendChild(r);
      return r;
    };

    // name
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

    const slider = (labelText, min, max, step, value, fmt, tip, apply, undoLabel) => {
      const r = row(labelText);
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = min; inp.max = max; inp.step = step; inp.value = value;
      if (tip) inp.dataset.tip = tip;
      inp.dataset.lk = 'insp:' + clip.id + ':' + undoLabel;
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = fmt(value);
      inp.addEventListener('input', () => {
        if (!inp._gesture) { Undo.push(undoLabel); inp._gesture = true; }
        const v = parseFloat(inp.value);
        apply(v);
        val.textContent = fmt(v);
        Timeline.drawClip(clip.id);
      });
      inp.addEventListener('change', () => {
        inp._gesture = false;
        if (UI.playing) Engine.reschedule(); // apply the edit live, no stop/start
      });
      r.append(inp, val);
      return inp;
    };

    if (clip.kind === 'audio') {
      slider(tr('insp_gain', 'Gain'), 0, 3, 0.01, clip.gain ?? 1, v => Math.round(v * 100) + '%',
        tr('tip_clip_gain', 'Clip volume'), v => { clip.gain = v; }, 'Clip gain');
      slider(tr('insp_pitch', 'Pitch'), -12, 12, 1, clip.pitch ?? 0, v => (v > 0 ? '+' : '') + v + ' st',
        tr('tip_clip_pitch', 'Real pitch shift. Keeps the same length.'),
        v => { clip.pitch = v; Timeline.render(); }, 'Clip pitch');
      slider(tr('insp_speed', 'Speed'), 0.25, 4, 0.01, clip.speed ?? 1, v => v.toFixed(2) + 'x',
        tr('tip_speed', 'Playback speed. Changes length and pitch.'),
        v => { clip.speed = v; Timeline.render(); }, 'Clip speed');
      slider(tr('insp_drive', 'Drive'), 0, 100, 1, clip.drive ?? 0, v => Math.round(v) + '%',
        tr('tip_drive', 'Distortion / overdrive'), v => { clip.drive = v; }, 'Clip drive');
      slider(tr('insp_crush', 'Crush'), 0, 100, 1, clip.crush ?? 0, v => Math.round(v) + '%',
        tr('tip_crush', 'Bit crusher, lo-fi grit'), v => { clip.crush = v; }, 'Clip crush');
      slider(tr('insp_filter', 'Filter'), 200, 20000, 100, (clip.cutoff && clip.cutoff > 0) ? clip.cutoff : 20000,
        v => v >= 20000 ? tr('word_off', 'off') : Math.round(v) + ' Hz',
        tr('tip_filter', 'Low-pass filter, muffles the highs'),
        v => { clip.cutoff = v >= 20000 ? 0 : v; }, 'Clip filter');
      slider(tr('insp_fade_in', 'Fade in'), 0, 5, 0.05, clip.fadeIn ?? 0, v => v.toFixed(2) + ' s',
        tr('tip_fade_in', 'Fade in from silence'), v => { clip.fadeIn = v; }, 'Fade in');
      slider(tr('insp_fade_out', 'Fade out'), 0, 5, 0.05, clip.fadeOut ?? 0, v => v.toFixed(2) + ' s',
        tr('tip_fade_out', 'Fade out to silence'), v => { clip.fadeOut = v; }, 'Fade out');
    } else {
      // instrument (MIDI) clips get their own volume + transpose + effects
      slider(tr('insp_gain', 'Gain'), 0, 3, 0.01, clip.gain ?? 1, v => Math.round(v * 100) + '%',
        tr('tip_clip_gain', 'Clip volume'), v => { clip.gain = v; }, 'Clip gain');
      slider(tr('insp_transpose', 'Transpose'), -24, 24, 1, clip.pitch ?? 0, v => (v > 0 ? '+' : '') + v + ' st',
        tr('tip_transpose', 'Shift every note up or down'), v => { clip.pitch = v; }, 'Transpose');
      slider(tr('insp_drive', 'Drive'), 0, 100, 1, clip.drive ?? 0, v => Math.round(v) + '%',
        tr('tip_drive', 'Distortion / overdrive'), v => { clip.drive = v; }, 'Clip drive');
      slider(tr('insp_crush', 'Crush'), 0, 100, 1, clip.crush ?? 0, v => Math.round(v) + '%',
        tr('tip_crush', 'Bit crusher, lo-fi grit'), v => { clip.crush = v; }, 'Clip crush');
      slider(tr('insp_filter', 'Filter'), 200, 20000, 100, (clip.cutoff && clip.cutoff > 0) ? clip.cutoff : 20000,
        v => v >= 20000 ? tr('word_off', 'off') : Math.round(v) + ' Hz',
        tr('tip_filter', 'Low-pass filter, muffles the highs'),
        v => { clip.cutoff = v >= 20000 ? 0 : v; }, 'Clip filter');
      const info = document.createElement('div');
      info.style.cssText = 'color:var(--dim);font-size:11.5px;margin:10px 0';
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

  // ---------- Effects browser (drag onto clips) ----------

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
        });
        list.appendChild(item);
      }
      if (!list.children.length) list.innerHTML = `<div style="color:var(--faint);font-size:11.5px;padding:6px 2px">${tr('fx_none', 'No effect matches that.')}</div>`;
    };
    search.addEventListener('input', render);
    render();
    App.syncWindowButtons();
  },

  // ---------- Settings ----------

  toggleSettings() {
    if (this.isOpen('settings')) { this.close('settings'); return; }
    const w = this.create('settings', tr('win_settings', 'Settings'), 'i-gear', { x: 220, y: 140, width: 320 });
    w.refresh = () => {
      w.body.innerHTML = '';
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
        w.body.appendChild(r);
      };
      mkCheck(tr('set_countin', 'Count-in before recording'), S.countIn,
        tr('tip_countin', 'Four beats count you in before recording.'),
        (v) => { Undo.push('Count-in setting'); S.countIn = v; toast(tr(v ? 'toast_countin_on' : 'toast_countin_off', 'Count-in ' + (v ? 'on' : 'off'))); });
      mkCheck(tr('set_metro', 'Metronome while playing'), S.metronome,
        tr('tip_set_metro', 'Click on every beat (M)'),
        (v) => { App.setMetronome(v); w.refresh(); });
      mkCheck(tr('set_eco', 'Reduce CPU load (weaker computers)'), Engine.ecoMode(),
        tr('tip_eco', 'Turns off the room reverb and limits voices so playback stays smooth.'),
        (v) => { Engine.setEco(v); toast(tr(v ? 'toast_eco_on' : 'toast_eco_off', 'CPU saver ' + (v ? 'on' : 'off'))); });

      const r = document.createElement('div');
      r.className = 'frow';
      r.innerHTML = `<label>${tr('set_master_vol', 'Master vol.')}</label>`;
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = 0; inp.max = 3; inp.step = 0.01; inp.value = S.masterVol;
      inp.addEventListener('input', () => {
        if (!inp._gesture) { Undo.push('Master volume'); inp._gesture = true; }
        S.masterVol = parseFloat(inp.value);
        Engine.updateAllTracks();
      });
      inp.addEventListener('change', () => { inp._gesture = false; });
      r.appendChild(inp);
      w.body.appendChild(r);

      const note = document.createElement('div');
      note.style.cssText = 'color:var(--faint);font-size:10.5px;margin-top:10px;line-height:1.5';
      note.textContent = tr('set_note', 'Projects save as .fab files, sounds included. Export makes a WAV audio file.');
      w.body.appendChild(note);

      // Account
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
      w.body.appendChild(acct);

      // version + manual update check
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
          // 'update' shows the update banner by itself
        });
        ver.append(vLabel, vBtn);
      } else {
        vLabel.textContent = tr('set_web_version', 'fabu web, always the latest version');
        ver.appendChild(vLabel);
      }
      w.body.appendChild(ver);
    };
    w.refresh();
    App.syncWindowButtons();
  },

  // ---------- Help ----------

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
      [tr('help_col_drag_edges', 'Drag clip edges'), tr('help_trim', 'Trim a clip')],
      ['<kbd>Delete</kbd>', tr('help_delete', 'Delete clip or note')],
      ['<kbd>Cmd</kbd><kbd>S</kbd>', tr('help_save', 'Save project')],
      ['<kbd>Cmd</kbd><kbd>O</kbd>', tr('help_open', 'Open project')],
      ['<kbd>Cmd</kbd><kbd>E</kbd>', tr('help_export', 'Export song as WAV')],
      ['<kbd>Cmd</kbd><kbd>+</kbd> <kbd>&minus;</kbd>', tr('help_zoom', 'Zoom')],
      ['<kbd>A S D F</kbd>', tr('help_white_keys', 'White keys')],
      ['<kbd>W E T Z U</kbd>', tr('help_black_keys', 'Black keys')],
      ['<kbd>Z</kbd> <kbd>X</kbd>', tr('help_octave', 'Octave down, up')],
      [tr('help_col_double_lane', 'Double-click lane'), tr('help_new_pattern', 'New pattern')],
      [tr('help_col_double_clip', 'Double-click clip'), tr('help_edit_clip', 'Edit it')],
      [tr('help_col_rightclick', 'Right-click clip or note'), tr('help_rightclick', 'Delete it')],
      [tr('help_col_drag_sound', 'Drag a sound in'), tr('help_drag_sound', 'Add it where you drop')]
    ];
    w.body.innerHTML = '<table class="kbd-table">' +
      rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('') + '</table>';
    App.syncWindowButtons();
  }
};
