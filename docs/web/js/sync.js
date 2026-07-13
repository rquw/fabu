// ---------- Multiplayer: rooms, presence, cursors, host powers, locks ----------
// The relay (wss://fabu-relay.onrender.com) is a dumb room broadcaster that
// forwards messages as binary and excludes the sender, so all logic lives here.
'use strict';

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}

const Sync = {
  ws: null,
  room: null,
  connected: false,   // socket open
  admitted: false,    // allowed to exchange project state
  applyingRemote: false,
  relayUrl: 'wss://fabu-relay.onrender.com/',

  me: null,           // { id, name, color, joinTs }
  isHost: false,
  settings: { allowLate: true, approve: false, maxPlayers: 100 },
  started: false,     // set once the host presses play; gates late joins
  peers: new Map(),   // id -> { name, color, host, joinTs, lastSeen }
  pendingReqs: [],    // host only: [{id, name, ts}]
  bans: {},           // host only: name -> untilTs
  locks: new Map(),   // key -> { id, name, ts }
  myLocks: new Set(),
  cursors: new Map(), // id -> { beat, y, ts, name, color }

  sharedSamples: new Set(),
  lastSent: '',
  bcount: 0,
  periodTimer: null,
  presenceTimer: null,
  knockTimer: null,

  busy: false,
  pending: null,

  // ---------- connection ----------

  generateCode() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * A.length)];
    return c;
  },

  banKey(room) { return 'fabu.ban.' + room + '.' + ((Auth && Auth.user) || ''); },

  connect(room, asHost = false, settings = null) {
    room = room.toUpperCase().trim();
    const banUntil = parseInt(localStorage.getItem(this.banKey(room)) || '0');
    if (banUntil > Date.now()) {
      toast(tr('mp_banned', 'You were removed from this room. Try again later.'), 'red');
      return;
    }
    this.disconnect(true);
    this.room = room;
    this.isHost = asHost;
    this.admitted = asHost;
    this.started = false;
    if (settings) this.settings = Object.assign({ allowLate: true, approve: false, maxPlayers: 100 }, settings);
    this.settings.maxPlayers = clamp(this.settings.maxPlayers || 100, 2, 100);
    this.me = { id: uid('p'), name: (Auth && Auth.user) || 'anon', joinTs: Date.now() };
    this.me.color = hashColor(this.me.name);
    this.peers.clear(); this.locks.clear(); this.cursors.clear();
    this.pendingReqs = []; this.sharedSamples.clear(); this.lastSent = '';
    this.setStatus('connecting');

    try { this.ws = new WebSocket(this.relayUrl); } catch (e) { this.setStatus('offline'); return; }
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.connected = true;
      this.send({ type: 'join', room });
      if (asHost) {
        this.setStatus('online');
        toast(tr('mp_room_created', 'Room {room} created', { room }), 'green');
        this.afterAdmit();
      } else {
        this.setStatus('connecting');
        this.send({ type: 'knock', id: this.me.id, name: this.me.name });
        // if nobody answers, give up politely
        this.knockTimer = setTimeout(() => {
          if (!this.admitted) {
            toast(tr('mp_no_answer', 'No answer from that room'), 'red');
            this.disconnect();
          }
        }, 12000);
      }
      this.renderPanel();
    };

    this.ws.onmessage = async (ev) => {
      let text;
      if (typeof ev.data === 'string') text = ev.data;
      else if (ev.data instanceof ArrayBuffer) text = new TextDecoder().decode(ev.data);
      else if (ev.data && ev.data.text) text = await ev.data.text();
      else return;
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      this.onMessage(msg);
    };

    this.ws.onclose = () => { this.teardown(); };
    this.ws.onerror = () => { this.setStatus('offline'); };
  },

  afterAdmit() {
    this.admitted = true;
    clearTimeout(this.knockTimer);
    clearInterval(this.periodTimer);
    clearInterval(this.presenceTimer);
    this.periodTimer = setInterval(() => this.broadcast(), 150);
    this.presenceTimer = setInterval(() => { this.sendPresence(); this.sweep(); }, 2000);
    this.sendPresence();
    if (this.isHost) this.broadcast(true);
    this.setStatus('online');
    this.renderPanel();
    Timeline.render(); // show attribution tags
  },

  disconnect(silent = false) {
    if (this.connected && this.me) this.send({ type: 'bye', id: this.me.id, host: this.isHost });
    clearTimeout(this.knockTimer);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (e) {} }
    this.ws = null;
    this.teardown(silent);
  },

  teardown(silent = false) {
    const was = this.connected;
    this.connected = false; this.admitted = false; this.isHost = false;
    clearInterval(this.periodTimer); clearInterval(this.presenceTimer);
    this.peers.clear(); this.locks.clear(); this.cursors.clear(); this.pendingReqs = [];
    this.myLocks.clear();
    this.room = null;
    this.setStatus('offline');
    this.renderPanel();
    this.renderCursors();
    this.updateLockVisuals();
    if (was && !silent) { toast(tr('mp_left', 'Left the room')); Timeline.render(); }
  },

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return;
    obj.room = this.room;
    try { this.ws.send(JSON.stringify(obj)); } catch (e) {}
  },

  // ---------- message handling ----------

  onMessage(m) {
    switch (m.type) {
      case 'state':
        if (!this.admitted) return;
        if (this.busy) { this.pending = m; return; }
        this.applyRemote(m.state, m.samples);
        break;

      case 'presence': {
        const isNew = !this.peers.has(m.id);
        this.peers.set(m.id, { name: m.name, color: m.color, host: m.host, joinTs: m.joinTs, lastSeen: Date.now() });
        if (m.host && m.settings) {
          this.settings = m.settings;
          this.started = !!m.started;
        }
        if (isNew) {
          this.sharedSamples.clear();   // re-send our samples so the newcomer hears everything
          if (this.admitted) toast(tr('mp_joined_room', '{name} joined', { name: m.name }), 'green');
          this.renderPanel();
        }
        break;
      }

      case 'knock':
        if (this.isHost) this.handleKnock(m);
        break;

      case 'admit':
        if (m.to === this.me.id && !this.admitted) {
          this.settings = m.settings || this.settings;
          this.started = !!m.started;
          toast(tr('mp_admitted', 'Joined room {room}', { room: this.room }), 'green');
          this.afterAdmit();
        }
        break;

      case 'deny':
        if (m.to === this.me.id && !this.admitted) {
          const reasons = {
            full: tr('mp_deny_full', 'That room is full'),
            closed: tr('mp_deny_closed', 'That session has already started'),
            denied: tr('mp_deny_denied', 'The host declined your request'),
            banned: tr('mp_banned', 'You were removed from this room. Try again later.')
          };
          if (m.until) localStorage.setItem(this.banKey(this.room), String(m.until));
          toast(reasons[m.reason] || reasons.denied, 'red');
          this.disconnect(true);
        }
        break;

      case 'cursor':
        if (m.id !== this.me.id) {
          this.cursors.set(m.id, { beat: m.beat, y: m.y, ts: Date.now(), name: m.name, color: m.color });
          this.renderCursors();
        }
        break;

      case 'lock':
        if (m.on) this.locks.set(m.key, { id: m.id, name: m.name, ts: Date.now() });
        else this.locks.delete(m.key);
        this.updateLockVisuals();
        break;

      case 'kick':
        if (m.to === this.me.id) {
          localStorage.setItem(this.banKey(this.room), String(m.until || 0));
          this.disconnect(true);
          this.showKickedModal(m.until);
        }
        break;

      case 'bye': {
        const p = this.peers.get(m.id);
        this.peers.delete(m.id);
        this.cursors.delete(m.id);
        if (p) toast(tr('mp_left_room', '{name} left', { name: p.name }));
        if (m.host || (p && p.host)) this.hostLost();
        this.renderPanel();
        this.renderCursors();
        break;
      }
    }
  },

  handleKnock(m) {
    const ban = this.bans[m.name];
    if (ban && ban > Date.now()) { this.send({ type: 'deny', to: m.id, reason: 'banned', until: ban }); return; }
    if (this.peers.size + 1 >= this.settings.maxPlayers) { this.send({ type: 'deny', to: m.id, reason: 'full' }); return; }
    if (this.started && !this.settings.allowLate) { this.send({ type: 'deny', to: m.id, reason: 'closed' }); return; }
    if (this.settings.approve) {
      if (!this.pendingReqs.some(r => r.id === m.id)) {
        this.pendingReqs.push({ id: m.id, name: m.name, ts: Date.now() });
        toast(tr('mp_request', '{name} wants to join', { name: m.name }));
        this.renderPanel();
        this.renderRequests();
      }
    } else {
      this.admit(m.id);
    }
  },

  admit(id) {
    this.pendingReqs = this.pendingReqs.filter(r => r.id !== id);
    this.send({ type: 'admit', to: id, settings: this.settings, started: this.started });
    this.sharedSamples.clear();  // next broadcast carries every sample for the newcomer
    this.lastSent = '';
    this.renderPanel();
    this.renderRequests();
  },

  denyReq(id) {
    this.pendingReqs = this.pendingReqs.filter(r => r.id !== id);
    this.send({ type: 'deny', to: id, reason: 'denied' });
    this.renderPanel();
    this.renderRequests();
  },

  sendPresence() {
    const p = {
      type: 'presence', id: this.me.id, name: this.me.name, color: this.me.color,
      host: this.isHost, joinTs: this.me.joinTs
    };
    if (this.isHost) { p.settings = this.settings; p.started = this.started; }
    this.send(p);
  },

  sweep() {
    const now = Date.now();
    let lostHost = false, changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > 7000) {
        this.peers.delete(id);
        this.cursors.delete(id);
        if (p.host) lostHost = true;
        changed = true;
      }
    }
    for (const [key, l] of this.locks) if (now - l.ts > 15000) this.locks.delete(key);
    if (lostHost) this.hostLost();
    if (changed) { this.renderPanel(); this.renderCursors(); }
  },

  // ---------- host loss & roulette election ----------

  hostLost() {
    if (!this.admitted || this._electing) return;
    this._electing = true;
    // deterministic winner: earliest joiner still here (same result on every client)
    const cands = [{ id: this.me.id, name: this.me.name, color: this.me.color, joinTs: this.me.joinTs }];
    for (const [id, p] of this.peers) cands.push({ id, name: p.name, color: p.color, joinTs: p.joinTs });
    cands.sort((a, b) => a.joinTs - b.joinTs);
    const winner = cands[0];
    this.showRoulette(cands, winner, () => {
      this._electing = false;
      if (winner.id === this.me.id) {
        this.isHost = true;
        this.sendPresence();
        toast(tr('mp_you_host', 'You are the new host'), 'green');
      }
      this.renderPanel();
    });
  },

  showRoulette(cands, winner, done) {
    const old = document.getElementById('rouletteOverlay');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'rouletteOverlay';
    ov.innerHTML = `
      <div class="roul-box">
        <div class="roul-title">${tr('mp_host_left', 'Host left the session')}</div>
        <div class="roul-sub">${tr('mp_selecting', 'A new host is being selected')}</div>
        <div class="roul-name" id="roulName">…</div>
      </div>`;
    document.body.appendChild(ov);
    const nameEl = ov.querySelector('#roulName');
    let i = 0, delay = 70;
    const spin = () => {
      const c = cands[i % cands.length];
      nameEl.textContent = c.name;
      nameEl.style.color = c.color;
      i++;
      delay *= 1.13;                       // slow down like a wheel
      if (delay < 420) setTimeout(spin, delay);
      else {
        nameEl.textContent = winner.name;   // land on the deterministic winner
        nameEl.style.color = winner.color;
        nameEl.classList.add('roul-winner');
        setTimeout(() => { ov.classList.add('out'); setTimeout(() => { ov.remove(); done(); }, 350); }, 1400);
      }
    };
    spin();
  },

  // ---------- kick ----------

  kick(peerId, durationMs) {
    if (!this.isHost) return;
    const p = this.peers.get(peerId);
    if (!p) return;
    const until = durationMs > 0 ? Date.now() + durationMs : Date.now() + 100 * 365 * 24 * 3600e3;
    this.bans[p.name] = until;
    this.send({ type: 'kick', to: peerId, until });
    this.peers.delete(peerId);
    this.cursors.delete(peerId);
    toast(tr('mp_kicked_toast', '{name} was removed', { name: p.name }));
    this.renderPanel();
    this.renderCursors();
  },

  showKickedModal(until) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    const perm = !until || until - Date.now() > 50 * 365 * 24 * 3600e3;
    const when = perm ? '' : new Date(until).toLocaleTimeString().slice(0, 5);
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('mp_kicked_title', 'Removed from the room')}</div>
        <div class="modal-sub">${perm ? tr('mp_kicked_perm', 'The host removed you from this session.')
          : tr('mp_kicked_until', 'The host removed you. You can rejoin at {time}.', { time: when })}</div>
        <div class="modal-btns"><button class="fbtn accent">OK</button></div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('button').addEventListener('click', () => wrap.remove());
  },

  // ---------- locks (sliders, clips, notes) ----------

  lockedBy(key) {
    const l = this.locks.get(key);
    return l && l.id !== this.me?.id ? l : null;
  },

  setLock(key, on) {
    if (!this.admitted) return;
    if (on) this.myLocks.add(key); else this.myLocks.delete(key);
    this.send({ type: 'lock', id: this.me.id, name: this.me.name, key, on });
  },

  releaseAllLocks() {
    for (const k of this.myLocks) this.send({ type: 'lock', id: this.me.id, name: this.me.name, key: k, on: false });
    this.myLocks.clear();
  },

  updateLockVisuals() {
    // sliders
    for (const el of document.querySelectorAll('[data-lk]')) {
      const l = this.lockedBy(el.dataset.lk);
      el.disabled = !!l;
      el.classList.toggle('locked', !!l);
      if (l) el.dataset.tip = tr('mp_locked_by', '{name} is using this', { name: l.name });
    }
    // clips
    for (const el of document.querySelectorAll('.clip')) {
      const l = this.lockedBy('clip:' + el.dataset.clipId);
      el.classList.toggle('mp-locked', !!l);
      el.style.outline = l ? '2px solid ' + hashColor(l.name) : '';
    }
  },

  // ---------- live cursors ----------

  initCursors() {
    let last = 0;
    document.getElementById('tlScroll').addEventListener('mousemove', (e) => {
      if (!this.admitted) return;
      const now = performance.now();
      if (now - last < 66) return;
      last = now;
      const r = Timeline.lanes.getBoundingClientRect();
      this.send({
        type: 'cursor', id: this.me.id, name: this.me.name, color: this.me.color,
        beat: (e.clientX - r.left) / UI.zoom, y: e.clientY - r.top
      });
    });
  },

  renderCursors() {
    let layer = document.getElementById('cursorLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'cursorLayer';
      Timeline.lanes.appendChild(layer);
    }
    const now = Date.now();
    layer.innerHTML = '';
    if (!this.admitted) return;
    for (const [id, c] of this.cursors) {
      if (now - c.ts > 5000) continue;
      const el = document.createElement('div');
      el.className = 'mp-cursor';
      el.style.left = (c.beat * UI.zoom) + 'px';
      el.style.top = c.y + 'px';
      el.innerHTML = `<div class="mp-cursor-dot" style="background:${c.color}"></div>` +
        `<div class="mp-cursor-name" style="background:${c.color}">${c.name}</div>`;
      layer.appendChild(el);
    }
  },

  // ---------- state sync (same protocol as before) ----------

  usedSampleIds() {
    const used = new Set();
    for (const t of S.tracks) for (const c of t.clips) if (c.sampleId) used.add(c.sampleId);
    for (const inst of Object.values(S.instruments || {})) if (inst.sampleId) used.add(inst.sampleId);
    return used;
  },

  SIZE_LIMIT: 55 * 1024 * 1024,   // relay chokes past ~62 MB, leave a margin

  broadcast(force = false) {
    if (!this.admitted || this.applyingRemote) return;
    const stateJson = JSON.stringify(S);
    const samples = {};
    const added = [];
    for (const id of this.usedSampleIds()) {
      if (this.sharedSamples.has(id)) continue;
      const s = Samples[id];
      if (s && s.bytes) { samples[id] = { name: s.name, mime: s.mime, data: bufToB64(s.bytes) }; this.sharedSamples.add(id); added.push(id); }
    }
    const hasSamples = added.length > 0;
    if (!force && stateJson === this.lastSent && !hasSamples) return;
    const msg = { type: 'state', room: this.room, state: JSON.parse(stateJson) };
    if (hasSamples) msg.samples = samples;
    const json = JSON.stringify(msg);
    if (json.length > this.SIZE_LIMIT) {
      for (const id of added) this.sharedSamples.delete(id); // retry once the project shrinks
      if (!this._sizeWarned) { this._sizeWarned = true; this.showSizeLimit(); }
      return;
    }
    this._sizeWarned = false;
    this.lastSent = stateJson;
    try { this.ws.send(json); } catch (e) {}
  },

  showSizeLimit() {
    if (document.getElementById('sizeModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'sizeModal';
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('size_title', "I don't really know how you managed this.")}</div>
        <div class="modal-sub">${tr('size_sub', "You've hit the file size limit for a shared project. You can export it as it is, or keep editing on your own until it is smaller — the others will wait.")}</div>
        <div class="modal-btns" style="flex-direction:column;align-items:stretch">
          <button id="szExport" class="fbtn accent">${tr('size_export', 'Export as .wav')}</button>
          <button id="szWait" class="fbtn">${tr('size_wait', 'Let them wait')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#szExport').addEventListener('click', () => { wrap.remove(); App.export(); });
    wrap.querySelector('#szWait').addEventListener('click', () => wrap.remove());
  },

  async loadSamples(samples) {
    if (!samples) return false;
    Engine.ensureCtx();
    let any = false;
    for (const [id, s] of Object.entries(samples)) {
      if (Samples[id]) { this.sharedSamples.add(id); continue; }
      try {
        const bytes = b64ToBuf(s.data);
        Samples[id] = { id, name: s.name, buffer: await Engine.ctx.decodeAudioData(bytes.slice(0)), bytes, mime: s.mime };
        this.sharedSamples.add(id);
        any = true;
      } catch (e) { /* skip */ }
    }
    return any;
  },

  applyRemote(stateObj, samples) {
    const incoming = JSON.stringify(stateObj);
    const identical = incoming === JSON.stringify(S);
    this.applyingRemote = true;
    this.loadSamples(samples).then((got) => { if (got) { Timeline.render(); Windows.refreshAll(); } });
    if (!identical) {
      const sameStructure = S.tracks.length === stateObj.tracks.length &&
        S.tracks.every((t, i) => stateObj.tracks[i] && stateObj.tracks[i].id === t.id && stateObj.tracks[i].instrument === t.instrument);
      S = stateObj;
      if (UI.selClipId && !getClip(UI.selClipId)) UI.selClipId = null;
      if (UI.selTrackId && !getTrack(UI.selTrackId)) UI.selTrackId = null;
      if (Engine.ctx) {
        if (sameStructure) Engine.updateAllTracks();
        else { Engine.rebuildTracks(); Engine.updateAllTracks(); }
      }
      $('#bpmInput').value = S.bpm;
      $('#snapSelect').value = String(S.snap);
      $('#btnMetro').classList.toggle('on', S.metronome);
      Timeline.render();
      Windows.refreshAll();
      PianoRoll.onStateRestore();
      if (typeof Automation !== 'undefined') Automation.onStateRestore();
      KeysPanel.refreshTracks();
      updateUndoButtons();
      this.updateLockVisuals();
    }
    this.applyingRemote = false;
  },

  // ---------- players panel ----------

  setStatus(state) {
    const topBtn = document.getElementById('btnJam');
    if (topBtn) topBtn.classList.toggle('rec-on', state === 'online' && this.admitted);
    const pill = document.getElementById('jamPill');
    if (pill) pill.classList.toggle('hidden', !(this.connected && this.admitted));
  },

  togglePanel() {
    let p = document.getElementById('jamPanel');
    if (p) { p.remove(); App.syncWindowButtons(); return; }
    this.renderPanel(true);
  },

  renderPanel(create = false) {
    let p = document.getElementById('jamPanel');
    if (!p && !create) { this.updatePill(); return; }
    if (!p) {
      p = document.createElement('div');
      p.id = 'jamPanel';
      document.getElementById('workspace').appendChild(p);
    }
    this.updatePill();

    if (!this.connected || !this.admitted) {
      p.innerHTML = `
        <div class="jam-head"><svg class="ic"><use href="#i-users"/></svg>
          <span>${tr('jam_title', 'Jam together')}</span></div>
        <div class="jam-hint">${this.connected ? tr('mp_waiting', 'Waiting for the host to let you in…') : tr('mp_not_connected', 'Not in a room. Open Multiplayer from the home menu, or create a room now.')}</div>
        ${this.connected ? '' : `<div class="jam-row"><button id="jamCreateBtn" class="fbtn accent" style="flex:1">${tr('mp_create_room', 'Create a room')}</button></div>`}`;
      const cb = p.querySelector('#jamCreateBtn');
      if (cb) cb.addEventListener('click', () => Auth.require(() => MP.openCreate(true)));
      return;
    }

    // connected + admitted
    const players = [{ id: this.me.id, name: this.me.name, color: this.me.color, host: this.isHost, me: true }];
    for (const [id, peer] of this.peers) players.push({ id, name: peer.name, color: peer.color, host: peer.host });
    players.sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0));

    p.innerHTML = `
      <div class="jam-head"><svg class="ic"><use href="#i-users"/></svg>
        <span>${tr('mp_room', 'Room')}</span>
        <span style="flex:1"></span>
        <span class="jam-dot" style="background:var(--green)"></span>
        <span class="jam-status">${players.length}/${this.settings.maxPlayers}</span></div>
      <button id="jamCode" class="jam-code" data-tip="${tr('mp_code_tip', 'Click to reveal, click again to copy')}">${tr('mp_code_hidden', 'Code: click to reveal')}</button>
      <div id="jamPlayers"></div>
      ${this.isHost && this.settings.approve ? `<button id="jamReqBtn" class="fbtn jam-req">${tr('mp_requests', 'Requests')}${this.pendingReqs.length ? `<span class="req-badge">${this.pendingReqs.length}</span>` : ''}</button>` : ''}
      ${this.isHost ? `
      <div class="jam-set">
        <label class="jam-check"><input type="checkbox" id="jamAllowLate" ${this.settings.allowLate ? 'checked' : ''}> ${tr('mp_allow_late', 'Allow joining after start')}</label>
        <label class="jam-check"><input type="checkbox" id="jamApprove" ${this.settings.approve ? 'checked' : ''}> ${tr('mp_approve', 'Approve joining')}</label>
        <label class="jam-check">${tr('mp_max_players', 'Max players')} <input type="number" id="jamMax" min="2" max="100" value="${this.settings.maxPlayers}"></label>
      </div>` : ''}
      <div class="jam-row"><button id="jamLeave" class="fbtn danger" style="flex:1">${tr('jam_disconnect', 'Leave')}</button></div>`;

    // room code reveal / copy
    const codeBtn = p.querySelector('#jamCode');
    let revealed = false;
    codeBtn.addEventListener('click', () => {
      if (!revealed) { codeBtn.textContent = this.room; codeBtn.classList.add('revealed'); revealed = true; }
      else { navigator.clipboard && navigator.clipboard.writeText(this.room); toast(tr('mp_code_copied', 'Code copied')); }
    });

    // players
    const list = p.querySelector('#jamPlayers');
    for (const pl of players) {
      const row = document.createElement('div');
      row.className = 'jam-player';
      row.innerHTML = `
        <span class="jam-pdot" style="background:${pl.color}"></span>
        <span class="jam-pname">${pl.name}${pl.me ? ' <i>(' + tr('mp_you', 'you') + ')</i>' : ''}</span>
        ${pl.host ? `<span class="jam-crown" data-tip="${tr('mp_host', 'Host')}">♛</span>` : ''}`;
      if (this.isHost && !pl.me) {
        const kick = document.createElement('button');
        kick.className = 'jam-kick';
        kick.dataset.tip = tr('mp_kick', 'Remove this player');
        kick.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
        kick.addEventListener('click', (e) => this.openKickMenu(e.clientX, e.clientY, pl.id, pl.name));
        row.appendChild(kick);
      }
      list.appendChild(row);
    }

    const reqBtn = p.querySelector('#jamReqBtn');
    if (reqBtn) reqBtn.addEventListener('click', () => this.openRequests());
    p.querySelector('#jamLeave').addEventListener('click', () => this.disconnect());

    if (this.isHost) {
      p.querySelector('#jamAllowLate').addEventListener('change', (e) => { this.settings.allowLate = e.target.checked; this.sendPresence(); });
      p.querySelector('#jamApprove').addEventListener('change', (e) => { this.settings.approve = e.target.checked; this.sendPresence(); this.renderPanel(); });
      p.querySelector('#jamMax').addEventListener('change', (e) => { this.settings.maxPlayers = clamp(parseInt(e.target.value) || 100, 2, 100); this.sendPresence(); });
    }
  },

  updatePill() {
    let pill = document.getElementById('jamPill');
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'jamPill';
      pill.dataset.tip = tr('mp_players_tip', 'Players in this room');
      document.body.appendChild(pill);
      pill.addEventListener('click', () => this.togglePanel());
    }
    if (this.connected && this.admitted) {
      pill.classList.remove('hidden');
      const n = this.peers.size + 1;
      pill.innerHTML = `<span class="jam-dot" style="background:var(--green)"></span> ${n}`;
    } else {
      pill.classList.add('hidden');
    }
  },

  openKickMenu(x, y, id, name) {
    const old = document.getElementById('kickMenu');
    if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'kickMenu';
    m.className = 'ctx-menu';
    const opts = [
      [tr('mp_kick_5m', 'Remove for 5 minutes'), 5 * 60e3],
      [tr('mp_kick_1h', 'Remove for 1 hour'), 3600e3],
      [tr('mp_kick_24h', 'Remove for 24 hours'), 24 * 3600e3],
      [tr('mp_kick_forever', 'Remove forever'), 0]
    ];
    for (const [label, dur] of opts) {
      const b = document.createElement('button');
      b.className = 'ctx-item danger';
      b.textContent = label;
      b.addEventListener('click', () => { m.remove(); this.kick(id, dur); });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 8) + 'px';
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); window.removeEventListener('mousedown', close, true); } };
    window.addEventListener('mousedown', close, true);
  },

  // ---------- join requests (host) ----------

  openRequests() {
    this.renderRequests(true);
  },

  renderRequests(create = false) {
    let wrap = document.getElementById('reqModal');
    if (!wrap && !create) return;
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'reqModal';
      wrap.className = 'modal-back';
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });
      document.body.appendChild(wrap);
    }
    const filter = (wrap.querySelector('#reqSearch') || {}).value || '';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('mp_requests', 'Requests')}</div>
        <div class="modal-sub">${tr('mp_requests_sub', 'People asking to join your room.')}</div>
        <input id="reqSearch" type="text" placeholder="${tr('mp_search', 'Search names')}" value="${filter}">
        <div id="reqList"></div>
        <div class="modal-btns"><button id="reqClose" class="fbtn">${tr('close', 'Close')}</button></div>
      </div>`;
    const list = wrap.querySelector('#reqList');
    const shown = this.pendingReqs.filter(r => r.name.includes(filter.toLowerCase()));
    if (!shown.length) {
      list.innerHTML = `<div class="req-empty">${tr('mp_no_requests', 'No requests right now.')}</div>`;
    }
    for (const r of shown) {
      const row = document.createElement('div');
      row.className = 'req-row';
      row.innerHTML = `<span class="jam-pdot" style="background:${hashColor(r.name)}"></span><span class="jam-pname">${r.name}</span>`;
      const ok = document.createElement('button');
      ok.className = 'fbtn accent'; ok.textContent = tr('mp_admit', 'Admit');
      ok.addEventListener('click', () => this.admit(r.id));
      const no = document.createElement('button');
      no.className = 'fbtn danger'; no.textContent = tr('mp_deny', 'Deny');
      no.addEventListener('click', () => this.denyReq(r.id));
      row.append(ok, no);
      list.appendChild(row);
    }
    wrap.querySelector('#reqSearch').addEventListener('input', () => this.renderRequests());
    wrap.querySelector('#reqClose').addEventListener('click', () => wrap.remove());
  }
};

// ---------- Home-menu multiplayer flow ----------

const MP = {
  openMenu() {
    Auth.require(() => {
      const wrap = document.createElement('div');
      wrap.id = 'mpMenu';
      wrap.className = 'modal-back';
      wrap.innerHTML = `
        <div class="modal-card">
          <div class="modal-title">${tr('mp_title', 'Multiplayer')}</div>
          <div class="modal-sub">${tr('mp_sub', 'Make music together, live.')}</div>
          <div class="export-formats">
            <button id="mpJoin" class="fbtn">${tr('mp_join_room', 'Join a room')}</button>
            <button id="mpCreate" class="fbtn">${tr('mp_create_room', 'Create a room')}</button>
          </div>
          <div class="modal-btns"><button id="mpCancel" class="fbtn">${tr('cancel', 'Cancel')}</button></div>
        </div>`;
      document.body.appendChild(wrap);
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });
      wrap.querySelector('#mpCancel').addEventListener('click', () => wrap.remove());
      wrap.querySelector('#mpJoin').addEventListener('click', () => { wrap.remove(); this.openJoin(); });
      wrap.querySelector('#mpCreate').addEventListener('click', () => { wrap.remove(); this.openCreate(); });
    });
  },

  openJoin() {
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('mp_join_room', 'Join a room')}</div>
        <div class="modal-sub">${tr('mp_join_sub', 'Enter the code the host gave you.')}</div>
        <input id="mpCode" type="text" placeholder="${tr('jam_room', 'Room code')}" maxlength="6" spellcheck="false" style="text-transform:uppercase;letter-spacing:3px;font-weight:800;text-align:center">
        <div class="modal-btns">
          <button class="fbtn" id="mpJback">${tr('cancel', 'Cancel')}</button>
          <button class="fbtn accent" id="mpJgo">${tr('jam_connect', 'Connect')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const go = () => {
      const code = wrap.querySelector('#mpCode').value.trim().toUpperCase();
      if (code.length < 4) { toast(tr('jam_enter_room', 'Enter a room code'), 'red'); return; }
      wrap.remove();
      App.hideHome();
      Sync.connect(code, false);
      Sync.renderPanel(true);
    };
    wrap.querySelector('#mpJgo').addEventListener('click', go);
    wrap.querySelector('#mpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    wrap.querySelector('#mpJback').addEventListener('click', () => wrap.remove());
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });
    setTimeout(() => wrap.querySelector('#mpCode').focus(), 50);
  },

  openCreate(useCurrent = false) {
    const recents = App.getRecents().slice(0, 4);
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('mp_create_room', 'Create a room')}</div>
        <div class="modal-sub">${tr('mp_create_sub', 'Pick a project and your room rules.')}</div>
        <div class="mp-projects">
          ${useCurrent ? `<button class="fbtn mp-proj on" data-proj="current">${tr('mp_current_project', 'Current project')}</button>` : ''}
          <button class="fbtn mp-proj ${useCurrent ? '' : 'on'}" data-proj="new">${tr('new_project', 'New project')}</button>
          ${recents.map((r, i) => `<button class="fbtn mp-proj" data-proj="${i}">${r.name}</button>`).join('')}
        </div>
        <div class="jam-set" style="margin-top:12px">
          <label class="jam-check"><input type="checkbox" id="mpAllowLate" checked> ${tr('mp_allow_late', 'Allow joining after start')}</label>
          <label class="jam-check"><input type="checkbox" id="mpApprove"> ${tr('mp_approve', 'Approve joining')}</label>
          <label class="jam-check">${tr('mp_max_players', 'Max players')} <input type="number" id="mpMax" min="2" max="100" value="100"></label>
        </div>
        <div class="modal-btns">
          <button class="fbtn" id="mpCback">${tr('cancel', 'Cancel')}</button>
          <button class="fbtn accent" id="mpCgo">${tr('mp_create', 'Create')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    let chosen = useCurrent ? 'current' : 'new';
    wrap.querySelectorAll('.mp-proj').forEach(b => b.addEventListener('click', () => {
      chosen = b.dataset.proj;
      wrap.querySelectorAll('.mp-proj').forEach(x => x.classList.toggle('on', x === b));
    }));
    wrap.querySelector('#mpCback').addEventListener('click', () => wrap.remove());
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });
    wrap.querySelector('#mpCgo').addEventListener('click', async () => {
      const settings = {
        allowLate: wrap.querySelector('#mpAllowLate').checked,
        approve: wrap.querySelector('#mpApprove').checked,
        maxPlayers: clamp(parseInt(wrap.querySelector('#mpMax').value) || 100, 2, 100)
      };
      wrap.remove();
      if (chosen === 'new') App.newProject(false);
      else if (chosen !== 'current') {
        const r = recents[parseInt(chosen)];
        if (r) await App.openRecent(r.path);
      }
      App.hideHome();
      const code = Sync.generateCode();
      Sync.connect(code, true, settings);
      Sync.renderPanel(true);
    });
  }
};

// broadcast snappily right after discrete edits (periodic timer covers drags)
let _syncTimer = null;
function _wrapUndo(name) {
  const orig = Undo[name].bind(Undo);
  Undo[name] = function (...args) {
    const r = orig(...args);
    if (Sync.admitted && !Sync.applyingRemote) { clearTimeout(_syncTimer); _syncTimer = setTimeout(() => Sync.broadcast(), 70); }
    return r;
  };
}
['push', 'undo', 'redo'].forEach(_wrapUndo);

// the "session started" flag flips the first time the host plays
(function wrapPlay() {
  const orig = Engine.play.bind(Engine);
  Engine.play = function (...args) {
    if (Sync.isHost && !Sync.started) { Sync.started = true; Sync.sendPresence(); }
    return orig(...args);
  };
})();

// pause applying remote updates while the local user is dragging something
document.addEventListener('mousedown', () => { Sync.busy = true; }, true);
document.addEventListener('mouseup', () => {
  Sync.busy = false;
  if (Sync.pending) { const m = Sync.pending; Sync.pending = null; Sync.applyRemote(m.state, m.samples); }
}, true);

// slider locks: any range input carrying data-lk announces while dragged
document.addEventListener('pointerdown', (e) => {
  const el = e.target;
  if (!el.matches || !el.matches('input[type="range"][data-lk]')) return;
  const l = Sync.lockedBy(el.dataset.lk);
  if (l) { e.preventDefault(); toast(tr('mp_locked_by', '{name} is using this', { name: l.name })); return; }
  Sync.setLock(el.dataset.lk, true);
  const up = () => { Sync.setLock(el.dataset.lk, false); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointerup', up);
}, true);

window.addEventListener('beforeunload', () => { if (Sync.connected) Sync.disconnect(true); });
