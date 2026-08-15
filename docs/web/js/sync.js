// ---------- multiplayer ----------
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
  settings: { allowLate: true, approve: false, maxPlayers: 100, allowMic: true, allowCustomAudio: true, approveAudio: false, perms: {} },
  started: false,     // set once the host presses play; gates late joins
  peers: new Map(),   // id -> { name, color, host, joinTs, lastSeen }
  pendingReqs: [],    // host only: [{id, name, ts}]
  pendingAudio: [],   // host only: [{reqId, from, name, sample, place, buffer, ts}]
  selPlayers: new Set(), // host only: shift-selected player ids (for kick-all-except)
  kicked: new Set(),  // host only: ids we removed; their messages are ignored from then on
  history: [],        // host only: [{ ts, name, action, what }] notable room activity
  bans: {},           // host only: name -> untilTs (display only; names are not identity)
  banInstalls: {},    // host only: install id -> untilTs
  banConns: {},       // host only: relay connection key -> { until, iids: [] }
  allowInstalls: {},  // host only: install ids the host let back in by hand
  locks: new Map(),   // key -> { id, name, ts }
  myLocks: new Set(),
  cursors: new Map(), // id -> { beat, y, ts, name, color }
  remotePH: new Map(), // id -> { beat, ts, name, color, playing } (other players' playheads)

  sharedSamples: new Set(),
  lastSent: '',
  bcount: 0,
  periodTimer: null,
  presenceTimer: null,
  knockTimer: null,

  busy: false,
  pending: null,
  rev: 0,             // state revision: rejects late/stale states that would undo newer edits

  // ---------- connection health ----------
  lastRx: 0,          // when we last heard anything from the relay
  lastTx: 0,
  rtt: null,          // ms, from ping/pong
  quality: 'good',    // good | slow | bad
  retryTries: 0,
  retryTimer: null,
  healthTimer: null,
  hostGraceUntil: 0,  // don't elect a new host while the old one may still be reconnecting
  sendFails: 0,
  banner: null,

  FAIL: {
    no_socket:    ['Could not open a connection', 'Your browser or network blocked the connection to the server.'],
    dns:          ['Cannot reach the server', 'The multiplayer server did not answer. It may be restarting.'],
    offline:      ['You are offline', 'Your internet connection dropped. Waiting for it to come back.'],
    server_down:  ['Servers went down', 'The multiplayer server stopped responding. Trying to get back in.'],
    server_sleep: ['Waking up the server', 'The server was asleep. This might take a minute.'],
    timeout:      ['The server stopped answering', 'No reply for a while, so the connection was treated as dead.'],
    host_gone:    ['Host disconnected', 'Waiting a moment in case they come back.'],
    host_lost:    ['Host left the session', '{name} is the host now.'],
    room_gone:    ['The room is gone', 'Everyone else disconnected and the room closed.'],
    kicked_out:   ['You were removed from this room', ''],
    evade_blocked: ['You cannot join this room',
                    'Somebody on this internet connection was removed from it. If that was not you, ask the host to let you in.'],
    room_full:    ['That room is full', 'The host set a player limit and it has been reached.'],
    bad_code:     ['Invalid code', 'No room is using that code right now.'],
    denied:       ['The host declined your request', ''],
    send_fail:    ['Your changes are not going through', 'The connection is up but the server is not accepting messages.'],
    gave_up:      ['Could not reconnect', 'Your work is safe and saved locally. You can try again any time.'],
    reconnected:  ['Back in the room', ''],
    unknown:      ['Something went wrong with the connection', 'The connection closed for an unknown reason.'],
    relay_rate:   ['You were sending too fast', 'The server slowed you down to keep the room usable for everyone.'],
    relay_big:    ['That was too large to send', 'Try a shorter recording or a smaller sound file.'],
    relay_many:   ['Too many connections from here', 'Close some other fabu windows and try again.'],
    relay_full:   ['That room is full', 'The room has reached the number of people the server allows.']
  },
  failText(code, params) {
    const f = this.FAIL[code] || this.FAIL.unknown;
    return {
      title: tr('mpf_' + code + '_t', f[0], params),
      body: f[1] ? tr('mpf_' + code + '_b', f[1], params) : ''
    };
  },

  showBanner(code, kind, params, onRetry) {
    const t = this.failText(code, params);
    let b = this.banner;
    if (!b || !b.isConnected) {
      b = document.createElement('div');
      b.id = 'mpBanner';
      document.body.appendChild(b);
      this.banner = b;
    }
    b.className = 'mpb-' + kind;
    b.innerHTML =
      `<div class="mpb-dot"></div>
       <div class="mpb-text"><div class="mpb-title"></div>${t.body ? '<div class="mpb-body"></div>' : ''}</div>
       <div class="mpb-actions"></div>`;
    b.querySelector('.mpb-title').textContent = t.title;
    if (t.body) b.querySelector('.mpb-body').textContent = t.body;
    const acts = b.querySelector('.mpb-actions');
    if (kind === 'bad' && onRetry) {
      const r = document.createElement('button');
      r.className = 'fbtn';
      r.textContent = tr('mp_retry', 'Try again');
      r.addEventListener('click', () => { this.hideBanner(); onRetry(); });
      acts.appendChild(r);
    }
    if (kind !== 'working') {
      const x = document.createElement('button');
      x.className = 'fbtn ghost mpb-x';
      x.textContent = '×';
      x.title = tr('mp_dismiss', 'Dismiss');
      x.addEventListener('click', () => this.hideBanner());
      acts.appendChild(x);
    }
    clearTimeout(this._bannerHide);
    if (kind === 'ok') this._bannerHide = setTimeout(() => this.hideBanner(), 4000);
  },

  hideBanner() {
    clearTimeout(this._bannerHide);
    if (this.banner) { this.banner.remove(); this.banner = null; }
  },

  onRefused(reason) {
    const map = { rate: 'relay_rate', too_big: 'relay_big', too_many: 'relay_many',
                  full: 'relay_full', bad_code: 'bad_code' };
    const code = map[reason];
    if (!code) return;
    if (reason === 'rate' || reason === 'too_big') {
      const now = Date.now();
      if (this._lastRefuse && now - this._lastRefuse < 10000) return;
      this._lastRefuse = now;
      toast(this.failText(code).title, 'red');
      return;
    }
    this.fail(code);
  },

  fail(code, params, opts = {}) {
    const t = this.failText(code, params);
    if (opts.banner === false) toast(t.title, opts.tone || 'red');
    else this.showBanner(code, opts.kind || 'bad', params, opts.retry);
    if (opts.log !== false) console.warn('[jam] ' + code, params || '');
  },

  typingBusy() {
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' ||
      a.tagName === 'SELECT' ||
      (a.tagName === 'INPUT' && a.type !== 'range' && a.type !== 'checkbox' && a.type !== 'number'))) return true;
    if (document.querySelector('.ctx-menu, #metroMenu, #clipMenu, #kickMenu')) return true;
    return false;
  },

  // ---------- connection ----------
  generateCode() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * A.length)];
    return c;
  },

  banKey(room) { return 'fabu.ban.' + room + '.' + ((Auth && Auth.user) || ''); },

  // ---------- identity ----------
  installId() {
    try {
      let v = localStorage.getItem('fabu.installId');
      if (!v) {
        const b = new Uint8Array(16);
        (crypto.getRandomValues ? crypto : window.crypto).getRandomValues(b);
        v = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('fabu.installId', v);
      }
      return v;
    } catch (e) { return 'anon'; }
  },

  // ---------- per-user permissions ----------
  permOverride(name) {
    const perms = (this.settings && this.settings.perms) || {};
    return perms[name] || null;
  },
  overrideLive(ov) { return ov && !(ov.customAudioUntil && ov.customAudioUntil < Date.now()); },
  micRight(name) {
    const ov = this.permOverride(name);
    if (ov && ov.mic != null) return !!ov.mic;
    return this.settings.allowMic !== false;
  },
  canMic(name) {
    if (!this.connected || !this.admitted || this.isHost) return true;
    return this.micRight(name || (this.me && this.me.name));
  },
  customAudioRight(name) {
    name = name || (this.me && this.me.name);
    const ov = this.permOverride(name);
    if (ov && ov.customAudio != null && this.overrideLive(ov)) return ov.customAudio ? true : false;
    if (this.settings.approveAudio) return 'approve';
    if (this.settings.allowCustomAudio === false) return false;
    return true;
  },
  canCustomAudio(name) {
    if (!this.connected || !this.admitted || this.isHost) return true;
    return this.customAudioRight(name) === true;
  },
  audioAction() {
    if (!this.connected || !this.admitted || this.isHost) return 'allow';
    const r = this.customAudioRight(this.me.name);
    return r === true ? 'allow' : (r === 'approve' ? 'approve' : 'block');
  },
  blockCustomAudio() {
    const a = this.audioAction();
    if (a === 'allow') return false;
    if (a === 'approve') toast(tr('mp_audio_needs_approval', 'Drop the file onto the timeline so the host can review it.'));
    else toast(tr('mp_no_custom_audio', 'The host turned off custom sounds in this room.'), 'red');
    return true;
  },
  blockMic() {
    if (this.canMic()) return false;
    toast(tr('mp_no_mic', 'The host turned off microphone recording in this room.'), 'red');
    return true;
  },

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
    this.synced = asHost;
    this.started = false;
    if (settings) this.settings = Object.assign({ allowLate: true, approve: false, maxPlayers: 100, allowMic: true, allowCustomAudio: true, approveAudio: false, perms: {} }, settings);
    if (!this.settings.perms) this.settings.perms = {};
    this.settings.maxPlayers = clamp(this.settings.maxPlayers || 100, 2, 100);
    this.me = { id: uid('p'), name: (Auth && Auth.user) || 'anon', joinTs: Date.now() };
    this.me.color = hashColor(this.me.name);
    this.peers.clear(); this.locks.clear(); this.cursors.clear();
    this.pendingReqs = []; this.pendingAudio = []; this.kicked = new Set(); this.sharedSamples.clear(); this.lastSent = '';
    this.banInstalls = {}; this.banConns = {}; this.allowInstalls = {};
    this.rev = 0; this.pending = null;
    this.setStatus('connecting');

    this._manualClose = false;
    this.retryTries = 0;
    this._lastConnect = { room, asHost, settings };
    this.hideBanner();

    if (!navigator.onLine) {
      this.fail('offline', null, { retry: () => this.connect(room, asHost, settings) });
      this.setStatus('offline');
      return;
    }
    try { this.ws = new WebSocket(this.relayUrl); } catch (e) {
      this.setStatus('offline');
      this.fail('no_socket', null, { retry: () => this.connect(room, asHost, settings) });
      return;
    }
    this.wireSocket();

    clearTimeout(this._slowTimer);
    this._slowTimer = setTimeout(() => {
      if (!this.connected) this.showBanner('server_sleep', 'working');
    }, 3000);
    clearTimeout(this._openTimer);
    this._openTimer = setTimeout(() => {
      if (this.connected) return;
      this.disconnect(true);
      this.fail('dns', null, { retry: () => this.connect(room, asHost, settings) });
    }, 60000);

    this.ws.onopen = () => {
      clearTimeout(this._slowTimer);
      clearTimeout(this._openTimer);
      this.hideBanner();
      this.connected = true;
      this.lastRx = this.lastTx = Date.now();
      this.startHealth();
      this.send({ type: 'join', room });
      if (asHost) {
        this.setStatus('online');
        toast(tr('mp_room_created', 'Room created'), 'green');
        this.warnIfHostOutdated();
        this.afterAdmit();
      } else {
        this.setStatus('connecting');
        this.send({ type: 'knock', id: this.me.id, name: this.me.name, iid: this.installId(), gz: this.gzSupported ? 1 : 0, ver: App.version });
        this.knockTimer = setTimeout(() => {
          if (!this.admitted) {
            this.disconnect(true);
            this.fail('bad_code');
          }
        }, 8000);
      }
      this.renderPanel();
    };
  },

  // ---------- compressed state frames ----------
  GZ_MAGIC: [0x46, 0x5a, 0x30, 0x31],   // "FZ01"
  gzSupported: typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined',
  knockGz: new Map(),                    // id -> gz flag from a knock we have seen

  canGz() {
    if (!this.gzSupported || !this.peers.size) return false;
    for (const [, p] of this.peers) if (!p.gz) return false;
    for (const [, g] of this.knockGz) if (!g) return false;
    return true;
  },

  async gzip(str) {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([str]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  },

  async gunzip(u8) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return await new Response(stream).text();
  },

  isGzFrame(u8) {
    return u8.length > 4 && this.GZ_MAGIC.every((b, i) => u8[i] === b);
  },

  wireSocket() {
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = async (ev) => {
      let text;
      if (typeof ev.data === 'string') text = ev.data;
      else if (ev.data instanceof ArrayBuffer) {
        const u8 = new Uint8Array(ev.data);
        if (this.isGzFrame(u8)) {
          try { text = await this.gunzip(u8.subarray(4)); } catch (e) { return; } // corrupt frame: drop it
        } else {
          text = new TextDecoder().decode(u8);
        }
      }
      else if (ev.data && ev.data.text) text = await ev.data.text();
      else return;
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      this.lastRx = Date.now();
      this.sendFails = 0;
      if (msg.type === 'pong' && msg.to === (this.me && this.me.id)) {
        this.rtt = Date.now() - (msg.t || Date.now());
        return;
      }
      if (msg.type === 'ping' && msg.id && this.me && msg.id !== this.me.id) {
        this.send({ type: 'pong', to: msg.id, t: msg.t });
        return;
      }
      if (msg.type === 'relay_refused') {
        this.onRefused(msg.reason);
        return;
      }
      this.onMessage(msg);
    };
    this.ws.onclose = (ev) => {
      if (this._manualClose) { this.teardown(); return; }
      if (this.room) this.tryReconnect(ev);
      else this.teardown();
    };
    this.ws.onerror = () => {
      this.connected = false;
      this.setStatus('connecting');
      this.updatePill();
    };
  },

  // ---------- reconnect ----------
  MAX_RETRIES: 14,

  retryDelay() {
    const base = Math.min(30000, 1200 * Math.pow(1.8, this.retryTries));
    return base + Math.random() * 600;   // jitter, so 100 clients don't all hit at once
  },

  killSocket(sock) {
    if (!sock) return;
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try { sock.close(); } catch (e) {}
  },

  tryReconnect(ev) {
    if (this._manualClose || this.retryTimer) return;
    const wasAdmitted = this.admitted;
    this.killSocket(this.ws);
    this.ws = null;
    this.connected = false;
    this.admitted = false;
    this.setStatus('connecting');
    clearInterval(this.periodTimer); clearInterval(this.presenceTimer);
    clearInterval(this.healthTimer); this.healthTimer = null;
    this.updatePill();
    this.saveRecovery();
    this.hostGraceUntil = Date.now() + 45000;

    if (!navigator.onLine) this.showBanner('offline', 'working');
    else if (wasAdmitted) this.showBanner('server_down', 'working');
    else this.showBanner('dns', 'working');

    this.attemptReconnect();
  },

  attemptReconnect() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    if (this._manualClose || !this.room) return;

    if (!navigator.onLine) {
      this.showBanner('offline', 'working');
      this.retryTimer = setTimeout(() => this.attemptReconnect(), 2000);
      return;
    }
    if (this.retryTries >= this.MAX_RETRIES) {
      this.giveUp();
      return;
    }
    this.retryTries++;

    const room = this.room, wasHost = this.isHost, me = this.me;
    const settings = this.settings, started = this.started, rev = this.rev;

    let sock;
    try { sock = new WebSocket(this.relayUrl); } catch (e) {
      this.retryTimer = setTimeout(() => this.attemptReconnect(), this.retryDelay());
      return;
    }
    this.killSocket(this.ws);   // an attempt that is being replaced must not linger
    this.ws = sock;
    this.wireSocket();

    const giveUpOnThis = setTimeout(() => {
      if (sock.readyState === 1) return;
      try { sock.onclose = null; sock.close(); } catch (e) {}
      this.retryTimer = setTimeout(() => this.attemptReconnect(), this.retryDelay());
    }, 30000);

    sock.onclose = () => {
      clearTimeout(giveUpOnThis);
      if (this._manualClose) return;
      this.retryTimer = setTimeout(() => this.attemptReconnect(), this.retryDelay());
    };

    sock.onopen = () => {
      clearTimeout(giveUpOnThis);
      this.connected = true;
      this.lastRx = this.lastTx = Date.now();
      this.room = room; this.me = me; this.isHost = wasHost;
      this.settings = settings; this.started = started; this.rev = rev;
      this.wireSocket();                       // restore the normal close handler
      this.send({ type: 'join', room });
      this.startHealth();
      if (wasHost) {
        this.retryTries = 0;
        this.afterAdmit();
        this.showBanner('reconnected', 'ok');
      } else {
        this.admitted = false;
        this.send({ type: 'knock', id: me.id, name: me.name, iid: this.installId(), gz: this.gzSupported ? 1 : 0, ver: App.version });
        clearTimeout(this.knockTimer);
        this.knockTimer = setTimeout(() => {
          if (this.admitted) return;
          if (this.retryTries >= this.MAX_RETRIES) { this.giveUp('room_gone'); return; }
          try { this.ws.close(); } catch (e) {}
        }, 12000);
      }
    };
  },

  reconnectSucceeded() {
    this.retryTries = 0;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.showBanner('reconnected', 'ok');
  },

  giveUp(code) {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    const last = this._lastConnect;
    this.saveRecovery();
    this.teardown(true);
    this.fail(code || 'gave_up', null, {
      retry: last ? () => this.connect(last.room, last.asHost, last.settings) : null
    });
  },

  // ---------- health ----------
  startHealth() {
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => this.checkHealth(), 4000);
  },

  checkHealth() {
    if (!this.connected || !this.ws) return;
    const now = Date.now();

    if (this.ws.readyState > 1) {   // closed under us without firing onclose
      if (!this._manualClose && this.room) this.tryReconnect();
      return;
    }
    if (now - this.lastTx > 15000) this.send({ type: 'ping', id: this.me && this.me.id, t: now });

    const silent = now - this.lastRx;
    const expectReplies = this.peers.size > 0;
    if (expectReplies && silent > 45000) {
      this.fail('timeout', null, { kind: 'working' });
      try { this.ws.close(); } catch (e) {}   // onclose starts the reconnect
      return;
    }
    const q = !expectReplies ? 'good' : silent > 20000 ? 'bad' : silent > 8000 ? 'slow' : 'good';
    if (q !== this.quality) { this.quality = q; this.updatePill(); }
  },

  saveRecovery() {
    try {
      if (!S || !S.tracks || !S.tracks.length) return;
      localStorage.setItem('fabu.jamRecovery', JSON.stringify({
        ts: Date.now(), room: this.room, name: S.name || 'Jam', state: S
      }));
    } catch (e) {}   // quota, private mode: not worth breaking the room over
  },

  clearRecovery() { try { localStorage.removeItem('fabu.jamRecovery'); } catch (e) {} },

  offerRecovery() {
    let r;
    try { r = JSON.parse(localStorage.getItem('fabu.jamRecovery') || 'null'); } catch (e) { return; }
    if (!r || !r.state || Date.now() - r.ts > 24 * 3600e3) return;
    const empty = !S.tracks || !S.tracks.some(t => (t.clips || []).length);
    if (!empty) return;
    this.showBanner('gave_up', 'bad', null, null);
    const b = this.banner;
    if (!b) return;
    b.querySelector('.mpb-title').textContent = tr('mp_recovered', 'Recovered your project from the last session');
    b.querySelector('.mpb-body').textContent = r.name || '';
    const btn = document.createElement('button');
    btn.className = 'fbtn';
    btn.textContent = tr('mp_restore', 'Restore');
    btn.addEventListener('click', () => {
      try {
        Undo.push('Restore session');
        Object.assign(S, r.state);
        afterStateRestore();   // Mixer never existed, so this always threw and said the backup was broken
        toast(tr('mp_recovered', 'Recovered your project from the last session'), 'green');
      } catch (e) { toast(tr('mp_restore_fail', 'That backup could not be opened'), 'red'); }
      this.clearRecovery();
      this.hideBanner();
    });
    b.querySelector('.mpb-actions').prepend(btn);
  },

  afterAdmit() {
    this.admitted = true;
    clearTimeout(this.knockTimer);
    clearInterval(this.periodTimer);
    clearInterval(this.presenceTimer);
    this.periodTimer = setInterval(() => {
      if (this.pending && !this.busy && !this.typingBusy()) {
        const m = this.pending; this.pending = null;
        this.applyRemote(m.state, m.samples);
      }
      this.broadcast();
    }, 150);
    this._lastPresence = 0;
    this.presenceTimer = setInterval(() => {
      const now = Date.now();
      if (now - this._lastPresence >= this.presenceInterval()) { this._lastPresence = now; this.sendPresence(); }
      this.sweep();
    }, 1000);
    this._lastPresence = Date.now();
    this.sendPresence();
    if (this.isHost) this.broadcast(true);
    this.setStatus('online');
    this.renderPanel(true); // force the panel to reflect the now-connected room
    Timeline.render(); // show attribution tags
  },

  disconnect(silent = false) {
    this._manualClose = true;
    if (!silent) this.clearRecovery();   // leaving on purpose is not a crash
    if (this.connected && this.me) this.send({ type: 'bye', id: this.me.id, host: this.isHost });
    clearTimeout(this.knockTimer);
    clearTimeout(this._slowTimer);
    clearTimeout(this._openTimer);
    clearTimeout(this.retryTimer); this.retryTimer = null;
    clearInterval(this.healthTimer); this.healthTimer = null;
    this.retryTries = 0;
    if (this.ws) { this.ws.onclose = null; this.ws.onerror = null; try { this.ws.close(); } catch (e) {} }
    this.ws = null;
    this.teardown(silent);
  },

  teardown(silent = false) {
    const was = this.connected;
    this.connected = false; this.admitted = false; this.isHost = false; this.synced = false;
    clearInterval(this.periodTimer); clearInterval(this.presenceTimer);
    clearInterval(this.healthTimer); this.healthTimer = null;
    this._hostWait = 0; this._electing = false; this.quality = 'good'; this.rtt = null;
    this._cursorsOffNoted = false;   // a new room deserves the explanation again
    this.peers.clear(); this.locks.clear(); this.cursors.clear(); this.remotePH.clear(); this.pendingReqs = [];
    this.knockGz.clear();
    this.pendingAudio = []; this.history = [];
    for (const id of ['audioReview','histModal','manageModal']) { const el = document.getElementById(id); if (el) el.remove(); }
    this.myLocks.clear();
    this.room = null;
    this.setStatus('offline');
    this.renderPanel();
    this.renderCursors();
    this.renderRemotePlayheads();
    this.updateLockVisuals();
    if (was && !silent) { toast(tr('mp_left', 'Left the room')); Timeline.render(); }
  },

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    obj.room = this.room;
    try {
      this.ws.send(JSON.stringify(obj));
      this.lastTx = Date.now();
      return true;
    } catch (e) {
      if (++this.sendFails === 3) this.fail('send_fail', null, { kind: 'working' });
      if (this.sendFails > 6) { try { this.ws.close(); } catch (e2) {} }
      return false;
    }
  },

  // ---------- message handling ----------
  onMessage(m) {
    if (m.id && this.me && m.id === this.me.id) return;
    if (this.isHost && m.id && this.kicked && this.kicked.has(m.id)) return;
    if (this.isHost && m.from && this.kicked && this.kicked.has(m.from)) return;
    switch (m.type) {
      case 'state': {
        if (!this.admitted) return;
        if (this.isHost) {
          const why = this.judgeState(m);
          if (why) { this.rejectState(m, why); return; }
        }
        if (m.rev && m.rev < this.rev) return;
        if (m.rev) this.rev = m.rev;
        if (this.busy || this.typingBusy()) { this.pending = m; return; }
        this.applyRemote(m.state, m.samples);
        break;
      }

      case 'presence': {
        if (this.isHost && m.id !== this.me.id && this.banCheck(m)) {
          this.kicked.add(m.id);
          this.send({ type: 'kick', to: m.id, until: (m.iid && this.banInstalls[m.iid]) || 0 });
          return;
        }
        const isNew = !this.peers.has(m.id);
        this.peers.set(m.id, { name: m.name, color: m.color, host: m.host, joinTs: m.joinTs,
                               iid: m.iid || null, pk: m._pk || null, lastSeen: Date.now(), gz: !!m.gz });
        this.knockGz.delete(m.id);
        if (m.host && m.settings) {
          this.settings = m.settings;
          this.started = !!m.started;
        }
        if (m.host) this.hostSeen();   // a host is alive, so stop the "host gone" wait
        if (m.host && this.isHost && m.id !== this.me.id) {
          const iLose = (m.joinTs < this.me.joinTs) || (m.joinTs === this.me.joinTs && m.id < this.me.id);
          if (iLose) {
            this.isHost = false;
            this.sendPresence();
            toast(tr('mp_host_is', '{name} is the host', { name: m.name }));
            this.renderPanel();
          }
        }
        if (isNew) {
          this.sharedSamples.clear();   // re-send our samples so the newcomer hears everything
          if (this.admitted) toast(tr('mp_joined_room', '{name} joined', { name: m.name }), 'green');
          if (this.isHost) this.pushHistory({ ts: Date.now(), name: m.name, action: 'joined' });
          this.renderPanel();
        }
        break;
      }

      case 'relay_hello':
        this._relaySid = m.sid; this._relayPk = m.pk;
        return;

      case 'knock':
        if (m.id) this.knockGz.set(m.id, !!m.gz);
        if (this.isHost) this.handleKnock(m);
        break;

      case 'admit':
        if (m.to === this.me.id && !this.admitted) {
          this.settings = m.settings || this.settings;
          this.started = !!m.started;
          const wasRetrying = this.retryTries > 0;
          this.afterAdmit();
          if (wasRetrying) this.reconnectSucceeded();
          else toast(tr('mp_admitted', 'Joined room {room}', { room: this.room }), 'green');
        }
        break;

      case 'deny':
        if (m.to === this.me.id && !this.admitted) {
          const codes = { full: 'room_full', closed: 'closed', denied: 'denied', banned: 'kicked_out', evade: 'evade_blocked' };
          if (m.until) localStorage.setItem(this.banKey(this.room), String(m.until));
          this._manualClose = true;              // a refusal is final, do not retry into it
          this.disconnect(true);
          if (m.reason === 'version') this.showVersionMismatch(m.hostVer);
          else if (m.reason === 'closed') toast(tr('mp_deny_closed', 'That session has already started'), 'red');
          else this.fail(codes[m.reason] || 'denied');
        }
        break;

      case 'act':
        if (this.isHost && m.entry && m.entry.name) this.pushHistory(m.entry);
        break;

      case 'soundban':
        if (m.to === this.me.id) this.showSoundBanNotice(m.until);
        break;

      case 'audioreq':
        if (this.isHost) this.handleAudioReq(m);
        break;

      case 'audiookay':
        if (m.to === this.me.id) toast(tr('mp_audio_approved', 'The host added your sound'), 'green');
        break;

      case 'audiodeny':
        if (m.to === this.me.id) toast(tr('mp_audio_denied', 'The host declined your sound'), 'red');
        break;

      case 'cursor':
        if (m.id !== this.me.id) {
          const p = this.peers.get(m.id);
          const prev = this.cursors.get(m.id);
          const name = m.name || (p && p.name) || (prev && prev.name) || '';
          this.cursors.set(m.id, {
            beat: m.beat, y: m.y, fx: m.fx, fy: m.fy, over: m.over, ts: Date.now(),
            name, color: m.color || (p && p.color) || (prev && prev.color) || hashColor(name)
          });
          this.renderCursors();
        }
        break;

      case 'ph':
        if (m.id !== this.me.id) {
          this.remotePH.set(m.id, { beat: m.beat, ts: Date.now(), name: m.name, color: m.color, playing: !!m.playing });
          this.renderRemotePlayheads();
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
          this._manualClose = true;              // being kicked must not trigger a reconnect
          this.disconnect(true);
          this.showKickedModal(m.until);
        }
        break;

      case 'migrate':
        if (!this.isHost && m.to && m.from) {
          const src = this.peers.get(m.from);
          if (src && src.host && m.to !== this.room) {
            this.room = m.to;
            this.send({ type: 'join', room: m.to });
            this.renderPanel();
          }
        }
        break;

      case 'bye': {
        const p = this.peers.get(m.id);
        this.peers.delete(m.id);
        this.cursors.delete(m.id);
        this.remotePH.delete(m.id);
        if (p) {
          toast(tr('mp_left_room', '{name} left', { name: p.name }));
          if (this.isHost) this.pushHistory({ ts: Date.now(), name: p.name, action: 'left' });
        }
        if (m.host || (p && p.host)) this.hostLost();
        this.renderPanel();
        this.renderCursors();
        this.renderRemotePlayheads();
        break;
      }
    }
  },

  // ---------- host-side validation ----------
  judgeState(m) {
    if (!this.isHost) return null;
    const from = m.from;
    if (from && this.kicked && this.kicked.has(from)) return 'kicked';
    const peer = from ? this.peers.get(from) : null;
    const name = (peer && peer.name) || m.by;
    if (!name || name === this.me.name) return null;   // our own / unattributable
    if (m.samples && Object.keys(m.samples).length && this.customAudioRight(name) !== true) return 'audio';
    return null;
  },

  rejectState(m, why) {
    const who = ((this.peers.get(m.from) || {}).name) || m.by || '?';
    this.rev = Math.max(this.rev, m.rev || 0) + 1;
    this.lastSent = '';               // force a full resend
    this.sharedSamples.clear();
    this.broadcast(true);
    this.pushHistory({ ts: Date.now(), name: who, action: 'blocked', what: why });
    const now = Date.now();
    if (!this._lastBlockToast || now - this._lastBlockToast > 4000) {
      this._lastBlockToast = now;
      toast(tr('mp_blocked_change', 'Blocked a change from {name}', { name: who }), 'red');
    }
  },

  banCheck(m) {
    const now = Date.now();
    const iid = m.iid || null, pk = m._pk || null;
    if (iid && this.allowInstalls[iid]) return null;   // the host let this one back in
    if (iid && this.banInstalls[iid] > now) return 'banned';

    const c = pk ? this.banConns[pk] : null;
    if (c && c.until > now && iid && !c.iids.includes(iid)) {
      c.iids.push(iid);
      this.noteEvasion(m.name, iid, c.name);
      return 'evade';
    }
    return null;
  },

  rememberBan(peer, until) {
    if (peer.iid) {
      this.banInstalls[peer.iid] = until;
      (this._banNames = this._banNames || {})[peer.iid] = peer.name;
    }
    if (peer.pk) {
      const c = this.banConns[peer.pk] || { until: 0, iids: [], name: peer.name };
      c.until = Math.max(c.until, until);
      c.name = peer.name;
      if (peer.iid && !c.iids.includes(peer.iid)) c.iids.push(peer.iid);
      this.banConns[peer.pk] = c;
    }
  },

  noteEvasion(name, iid, wasName) {
    this.pushHistory({ ts: Date.now(), name: name || 'someone', action: 'evaded', what: wasName || '' });
    if (this._evadeSeen && this._evadeSeen.has(iid)) return;
    (this._evadeSeen = this._evadeSeen || new Set()).add(iid);
    this.pendingEvades = this.pendingEvades || [];
    this.pendingEvades.push({ iid, name: name || 'someone', wasName: wasName || '', ts: Date.now() });
    toast(tr('mp_evade_blocked', 'Blocked a rejoin from {name}, on the same connection as {was}',
      { name: name || 'someone', was: wasName || tr('word_someone', 'someone removed') }), 'red');
    this.renderPanel();
  },

  allowEvader(iid) {
    if (!this.isHost || !iid) return;
    this.allowInstalls[iid] = true;
    this.pendingEvades = (this.pendingEvades || []).filter(e => e.iid !== iid);
    toast(tr('mp_evade_allowed', 'They can join now'), 'green');
    this.renderPanel();
  },

  handleKnock(m) {
    if (this.kicked && this.kicked.has(m.id)) { this.send({ type: 'deny', to: m.id, reason: 'banned' }); return; }
    const why = this.banCheck(m);
    if (why) { this.send({ type: 'deny', to: m.id, reason: why, until: (m.iid && this.banInstalls[m.iid]) || 0 }); return; }
    if (App.cmpVersion(m.ver || '0.0.0', App.version) !== 0) {
      this.send({ type: 'deny', to: m.id, reason: 'version', hostVer: App.version });
      this.noteVersionRefusal(m.name, m.ver);
      return;
    }
    if (this.peers.has(m.id)) {
      const ex = this.peers.get(m.id);
      if (m.iid) ex.iid = m.iid;
      if (m._pk) ex.pk = m._pk;
      this.admit(m.id); return;
    }
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
    this.broadcast(true);        // push the full project right away so they sync before they can edit
    this.renderPanel();
    this.renderRequests();
  },

  denyReq(id) {
    this.pendingReqs = this.pendingReqs.filter(r => r.id !== id);
    this.send({ type: 'deny', to: id, reason: 'denied' });
    this.renderPanel();
    this.renderRequests();
  },

  // ---------- custom-audio approval ----------
  async requestAudioFiles(files, place) {
    const hostEntry = [...this.peers].find(([, p]) => p.host);
    const hostId = hostEntry ? hostEntry[0] : null;
    let sent = 0;
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { toast(tr('mp_audio_too_big', '"{name}" is too big to send for review', { name: f.name }), 'red'); continue; }
      try {
        const bytes = await f.arrayBuffer();
        this.send({
          type: 'audioreq', to: hostId, reqId: uid('areq'),
          from: this.me.id, name: this.me.name,
          sample: { name: f.name.replace(/\.[^.]+$/, ''), mime: f.type || 'audio/*', data: bufToB64(bytes) },
          place: { beat: place && place.beat != null ? place.beat : null, trackId: (place && place.trackId) || null }
        });
        sent++;
      } catch (e) { /* unreadable file */ }
    }
    if (sent) toast(tr('mp_audio_sent', 'Sent to the host for review'));
  },

  async handleAudioReq(m) {
    if (!m.sample || !m.sample.data) return;
    const ov = this.permOverride(m.name);
    if (ov && ov.customAudio === false && this.overrideLive(ov)) { this.send({ type: 'audiodeny', to: m.from, reqId: m.reqId }); return; }
    if (this.pendingAudio.some(r => r.reqId === m.reqId)) return;
    if (this.pendingAudio.length > 40) return; // flood guard
    let buffer = null;
    try { Engine.ensureCtx(); buffer = await Engine.ctx.decodeAudioData(b64ToBuf(m.sample.data).slice(0)); }
    catch (e) { this.send({ type: 'audiodeny', to: m.from, reqId: m.reqId }); return; }
    this.pendingAudio.push({ reqId: m.reqId, from: m.from, name: m.name, sample: m.sample, place: m.place || {}, buffer, ts: Date.now() });
    toast(tr('mp_audio_wants', '{name} wants to add a sound', { name: m.name }));
    this.showAudioReview();
  },

  stopReviewAudio() {
    if (this._revSrc) { try { this._revSrc.onended = null; this._revSrc.stop(); } catch (e) {} this._revSrc = null; }
    if (this._revRAF) { cancelAnimationFrame(this._revRAF); this._revRAF = null; }
  },

  showAudioReview() {
    let wrap = document.getElementById('audioReview');
    if (!this.pendingAudio.length) { this.stopReviewAudio(); if (this._revGain) { try { this._revGain.disconnect(); } catch (e) {} this._revGain = null; } if (wrap) wrap.remove(); return; }
    const req = this.pendingAudio[0];
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'audioReview';
      wrap.className = 'modal-back';
      document.body.appendChild(wrap);
    }
    const more = this.pendingAudio.length - 1;
    wrap.innerHTML = `
      <div class="modal-card ar-card">
        <div class="modal-title">${tr('mp_audio_review_title', '{name} wants to add this sound:', { name: req.name })}</div>
        <div class="ar-name">${req.sample.name}</div>
        <div class="ar-player">
          <canvas class="ar-wave" width="520" height="72"></canvas>
          <div class="ar-scrub"><div class="ar-scrub-fill"></div><div class="ar-scrub-head"></div></div>
          <div class="ar-controls">
            <button class="fbtn ar-play"><svg class="ic"><use href="#i-play"/></svg></button>
            <span class="ar-time">0:00</span>
            <span style="flex:1"></span>
            <span class="ar-vol-lbl">${tr('mp_volume', 'Vol')}</span>
            <input type="range" class="ar-vol" min="0" max="1" step="0.01" value="1">
          </div>
        </div>
        ${more > 0 ? `<div class="ar-more">${tr('mp_audio_more', '{n} more waiting', { n: more })}</div>` : ''}
        <div class="modal-btns">
          <button class="fbtn danger ar-deny">${tr('mp_deny', 'Deny')}</button>
          <button class="fbtn accent ar-approve">${tr('mp_approve_btn', 'Approve')}</button>
        </div>
      </div>`;
    this.stopReviewAudio();
    this.wireReviewPlayer(wrap, req);
    wrap.querySelector('.ar-approve').addEventListener('click', () => this.approveAudioReq(req));
    wrap.querySelector('.ar-deny').addEventListener('click', () => this.denyAudioReq(req, wrap));
  },

  wireReviewPlayer(wrap, req) {
    const buf = req.buffer;
    const canvas = wrap.querySelector('.ar-wave');
    const cx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const ch = buf.getChannelData(0);
    const bars = 130, step = Math.floor(ch.length / bars) || 1;
    const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#e07a3f').trim();
    const drawWave = (progress) => {
      cx.clearRect(0, 0, W, H);
      const bw = W / bars;
      for (let i = 0; i < bars; i++) {
        let peak = 0;
        for (let j = 0; j < step; j++) { const v = Math.abs(ch[i * step + j] || 0); if (v > peak) peak = v; }
        const h = Math.max(1, peak * (H * 0.9));
        cx.fillStyle = (i / bars) <= progress ? accent : 'rgba(255,255,255,0.18)';
        cx.fillRect(i * bw, (H - h) / 2, Math.max(1, bw - 1), h);
      }
    };
    const playBtn = wrap.querySelector('.ar-play');
    const fill = wrap.querySelector('.ar-scrub-fill');
    const head = wrap.querySelector('.ar-scrub-head');
    const timeEl = wrap.querySelector('.ar-time');
    const vol = wrap.querySelector('.ar-vol');
    const dur = buf.duration || 0.01;
    let offset = 0, startedAt = 0, playing = false;
    if (this._revGain) { try { this._revGain.disconnect(); } catch (e) {} }
    const gain = Engine.ctx.createGain(); gain.gain.value = parseFloat(vol.value); gain.connect(Engine.ctx.destination);
    this._revGain = gain;
    const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    const setProg = (p) => { p = clamp(p, 0, 1); fill.style.width = (p * 100) + '%'; head.style.left = (p * 100) + '%'; drawWave(p); timeEl.textContent = fmt(p * dur); };
    const setIcon = (name) => { const u = playBtn.querySelector('use'); if (u) u.setAttribute('href', '#i-' + name); };
    setProg(0);
    const stop = () => { this.stopReviewAudio(); playing = false; playBtn.classList.remove('on'); setIcon('play'); };
    const tick = () => {
      if (!playing) return;
      const t = offset + (Engine.ctx.currentTime - startedAt);
      if (t >= dur) { stop(); setProg(0); offset = 0; return; }
      setProg(t / dur);
      this._revRAF = requestAnimationFrame(tick);
    };
    const play = (from) => {
      this.stopReviewAudio();
      offset = from != null ? from : offset;
      const src = Engine.ctx.createBufferSource();
      src.buffer = buf; src.connect(gain);
      src.onended = () => { if (this._revSrc === src) { playing = false; playBtn.classList.remove('on'); setIcon('play'); } };
      src.start(0, offset);
      this._revSrc = src; startedAt = Engine.ctx.currentTime; playing = true;
      playBtn.classList.add('on'); setIcon('pause');
      this._revRAF = requestAnimationFrame(tick);
    };
    playBtn.addEventListener('click', () => { Engine.ctx.resume(); playing ? stop() : play(); });
    vol.addEventListener('input', () => { gain.gain.value = parseFloat(vol.value); });
    const scrub = wrap.querySelector('.ar-scrub');
    scrub.addEventListener('click', (e) => {
      const r = scrub.getBoundingClientRect();
      const p = clamp((e.clientX - r.left) / r.width, 0, 1);
      offset = p * dur; setProg(p);
      if (playing) play(offset);
    });
  },

  approveAudioReq(req) {
    const id = uid('smp');
    const bytes = b64ToBuf(req.sample.data);
    Samples[id] = { id, name: req.sample.name, buffer: req.buffer, bytes, mime: req.sample.mime };
    Undo.push('Add reviewed sound');
    let track = req.place && req.place.trackId ? getTrack(req.place.trackId) : null;
    if (!track || track.kind !== 'audio') track = S.tracks.find(t => t.kind === 'audio') || null;
    if (!track) { track = makeTrack('audio'); S.tracks.push(track); Engine.rebuildTracks(); }
    const at = (req.place && req.place.beat != null) ? req.place.beat : 0;
    const clip = { id: uid('clip'), kind: 'audio', name: req.sample.name, by: req.name, start: at, sampleId: id, fadeIn: 0, fadeOut: 0, pitch: 0, gain: 1 };
    clip.start = Timeline.firstFreeStart(track, clipBeats(clip), at, null);
    track.clips.push(clip);
    Timeline.render(); Windows.refreshAll();
    this.sharedSamples.clear(); this.lastSent = '';
    this.broadcast(true);
    this.send({ type: 'audiookay', to: req.from, reqId: req.reqId });
    this.pushHistory({ ts: Date.now(), name: req.name, action: 'sound_approved', what: req.sample.name });
    toast(tr('mp_audio_added', 'Added {name} from {who}', { name: req.sample.name, who: req.name }), 'green');
    this.pendingAudio = this.pendingAudio.filter(r => r !== req);
    this.showAudioReview();
  },

  denyAudioReq(req, wrap) {
    this.stopReviewAudio();
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('mp_ban_audio_title', 'Ban {name} from adding sounds?', { name: req.name })}</div>
        <div class="modal-sub">${tr('mp_ban_audio_sub', 'They will not be able to add or request custom sounds for a while.')}</div>
        <div class="ar-ban-row">
          <span>${tr('mp_ban_for', 'For')}</span>
          <input type="number" class="ar-ban-num" min="1" value="15">
          <select class="ar-ban-unit">
            <option value="1000">${tr('mp_unit_sec', 'seconds')}</option>
            <option value="60000" selected>${tr('mp_unit_min', 'minutes')}</option>
            <option value="3600000">${tr('mp_unit_hr', 'hours')}</option>
          </select>
        </div>
        <div class="modal-btns" style="flex-direction:column;align-items:stretch">
          <button class="fbtn danger ar-ban-go">${tr('mp_deny_and_ban', 'Deny and ban')}</button>
          <button class="fbtn ar-just-deny">${tr('mp_just_deny', 'Just deny')}</button>
        </div>
      </div>`;
    const finish = () => { this.pendingAudio = this.pendingAudio.filter(r => r !== req); this.showAudioReview(); };
    wrap.querySelector('.ar-just-deny').addEventListener('click', () => {
      this.send({ type: 'audiodeny', to: req.from, reqId: req.reqId });
      this.pushHistory({ ts: Date.now(), name: req.name, action: 'sound_denied', what: req.sample.name });
      finish();
    });
    wrap.querySelector('.ar-ban-go').addEventListener('click', () => {
      const n = Math.max(1, parseInt(wrap.querySelector('.ar-ban-num').value) || 15);
      const unit = parseInt(wrap.querySelector('.ar-ban-unit').value) || 60000;
      this.setAudioBan(req.name, n * unit);
      this.send({ type: 'audiodeny', to: req.from, reqId: req.reqId });
      this.pushHistory({ ts: Date.now(), name: req.name, action: 'sound_denied', what: req.sample.name });
      finish();
    });
  },

  setAudioBan(name, durMs) {
    if (!this.settings.perms) this.settings.perms = {};
    const prev = this.settings.perms[name] || {};
    const until = durMs > 0 ? Date.now() + durMs : 0;
    this.settings.perms[name] = Object.assign({}, prev, { customAudio: false, customAudioUntil: until });
    this.sendPresence();
    for (const [id, p] of this.peers) if (p.name === name) this.send({ type: 'soundban', to: id, until });
    toast(tr('mp_audio_banned', '{name} can no longer add sounds', { name }), 'red');
  },

  showSoundBanNotice(until) {
    const old = document.getElementById('soundBanModal');
    if (old) old.remove();
    const ms = until ? until - Date.now() : 0;
    let howLong;
    if (!until) howLong = tr('mp_ban_until_host', 'until the host allows it again');
    else if (ms < 60 * 60e3) howLong = tr('mp_ban_for_mins', 'for {n} minutes', { n: Math.max(1, Math.round(ms / 60e3)) });
    else howLong = tr('mp_ban_for_hours', 'for {n} hours', { n: Math.max(1, Math.round(ms / 3600e3)) });
    const wrap = document.createElement('div');
    wrap.id = 'soundBanModal';
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${tr('mp_soundban_title', 'You can no longer add sounds')}</div>
        <div class="modal-sub">${tr('mp_soundban_sub', 'The host turned off your custom sounds {how}.', { how: howLong })}</div>
        <div class="modal-btns"><button class="fbtn accent">OK</button></div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('button').addEventListener('click', () => wrap.remove());
  },

  pruneAudioBans() {
    if (!this.isHost || !this.settings.perms) return;
    const now = Date.now();
    let changed = false;
    for (const [name, ov] of Object.entries(this.settings.perms)) {
      if (ov && ov.customAudio === false && ov.customAudioUntil && ov.customAudioUntil < now) {
        delete ov.customAudio; delete ov.customAudioUntil;
        if (!Object.keys(ov).length) delete this.settings.perms[name];
        changed = true;
      }
    }
    if (changed) this.sendPresence();
  },

  // ---------- change history ----------
  logAction(action, what) {
    if (!this.connected || !this.admitted || !this.me) return;
    const entry = { ts: Date.now(), name: this.me.name, action, what: String(what || '').slice(0, 60) };
    if (this.isHost) this.pushHistory(entry);
    else this.send({ type: 'act', entry });
  },
  pushHistory(entry) {
    this.history.push(entry);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    this.renderHistory();
  },
  historyText(e) {
    const map = {
      add_pattern: tr('hist_add_pattern', '{name} added pattern "{what}"'),
      add_audio: tr('hist_add_audio', '{name} added sound "{what}"'),
      del_clip: tr('hist_del_clip', '{name} removed "{what}"'),
      add_track: tr('hist_add_track', '{name} added track "{what}"'),
      del_track: tr('hist_del_track', '{name} removed track "{what}"'),
      group: tr('hist_group', '{name} grouped clips into "{what}"'),
      ungroup: tr('hist_ungroup', '{name} ungrouped "{what}"'),
      joined: tr('hist_joined', '{name} joined'),
      left: tr('hist_left', '{name} left'),
      kicked: tr('hist_kicked', '{name} was removed'),
      sound_approved: tr('hist_sound_ok', '{name} got sound "{what}" approved'),
      sound_denied: tr('hist_sound_no', '{name} had sound "{what}" denied'),
      blocked: tr('hist_blocked', '{name} tried a change that was blocked ({what})'),
      evaded: tr('hist_evaded', '{name} was blocked: same connection as {what}')
    };
    return (map[e.action] || '{name}: {what}').replace('{name}', e.name).replace('{what}', e.what || '');
  },

  openHistory() { this.renderHistory(true); },

  renderHistory(create = false) {
    let wrap = document.getElementById('histModal');
    if (!wrap && !create) return;
    if (!this.isHost) { if (wrap) wrap.remove(); return; }
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'histModal';
      wrap.className = 'modal-back';
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });
      document.body.appendChild(wrap);
      wrap.innerHTML = `
        <div class="modal-card mg-card">
          <div class="modal-title">${tr('mp_history', 'Change history')}</div>
          <div class="modal-sub">${tr('mp_history_sub', 'What people have added or removed in this room.')}</div>
          <div id="histList" class="mg-list"></div>
          <div class="modal-btns"><button id="histClose" class="fbtn">${tr('close', 'Close')}</button></div>
        </div>`;
      wrap.querySelector('#histClose').addEventListener('click', () => wrap.remove());
    }
    const list = wrap.querySelector('#histList');
    list.innerHTML = '';
    if (!this.history.length) {
      list.innerHTML = `<div class="req-empty">${tr('mp_history_empty', 'Nothing yet.')}</div>`;
      return;
    }
    for (const e of [...this.history].reverse()) {
      const row = document.createElement('div');
      row.className = 'hist-row';
      const t = new Date(e.ts);
      row.innerHTML = `<span class="hist-time">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}</span>
        <span class="jam-pdot" style="background:${hashColor(e.name)}"></span>
        <span class="hist-text">${this.historyText(e)}</span>`;
      list.appendChild(row);
    }
  },

  // ---------- manage people (host) ----------
  openManage() { this.renderManage(true); },

  setPerm(name, key, val) {
    if (!this.isHost) return;
    if (!this.settings.perms) this.settings.perms = {};
    const ov = this.settings.perms[name] || (this.settings.perms[name] = {});
    ov[key] = val;
    if (key === 'customAudio') delete ov.customAudioUntil; // a manual choice clears any timed ban
    this.sendPresence();
    this.renderManage();
    this.renderPanel();
  },
  clearPerm(name) {
    if (this.settings.perms) delete this.settings.perms[name];
    this.sendPresence();
    this.renderManage();
  },
  liftRoomBan(name) {
    if (this.bans) delete this.bans[name];
    for (const [id, p] of this.peers) { if (p.name === name && p.iid) delete this.banInstalls[p.iid]; }
    for (const iid of Object.keys(this.banInstalls)) {
      if (this._banNames && this._banNames[iid] === name) delete this.banInstalls[iid];
    }
    for (const [pk, c] of Object.entries(this.banConns)) { if (c.name === name) delete this.banConns[pk]; }
    toast(tr('mp_unbanned', '{name} can rejoin', { name }), 'green');
    this.renderManage();
  },

  banLabel(until) {
    if (!until) return '';
    const ms = until - Date.now();
    if (ms <= 0) return '';
    const m = Math.ceil(ms / 60000);
    if (m < 60) return tr('mp_ban_mins', '{n}m left', { n: m });
    return tr('mp_ban_hrs', '{n}h left', { n: Math.ceil(m / 60) });
  },

  renderManage(create = false) {
    let wrap = document.getElementById('manageModal');
    if (!wrap && !create) return;
    if (!this.isHost) { if (wrap) wrap.remove(); return; }
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'manageModal';
      wrap.className = 'modal-back';
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });
      document.body.appendChild(wrap);
    }
    const filter = ((wrap.querySelector('#mgSearch') || {}).value || '').toLowerCase();
    const now = Date.now();
    const fresh = !wrap.querySelector('#mgList');
    const inRoom = new Set([this.me && this.me.name, ...[...this.peers.values()].map(p => p.name)]);
    const names = new Set([...inRoom]);
    for (const n of Object.keys(this.settings.perms || {})) names.add(n);
    for (const [n, until] of Object.entries(this.bans || {})) if (until > now) names.add(n);
    const list = [...names].filter(n => n && n !== (this.me && this.me.name) && n.toLowerCase().includes(filter)).sort();

    if (fresh) wrap.innerHTML = `
      <div class="modal-card mg-card">
        <div class="modal-title">${tr('mp_manage', 'Manage people')}</div>
        <div class="modal-sub">${tr('mp_manage_sub', 'Choose who can add custom sounds or record from the mic, and lift bans.')}</div>
        <input id="mgSearch" type="text" placeholder="${tr('mp_search', 'Search names')}">
        <div class="mg-head"><span class="mg-h-name"></span><span class="mg-h-col">${tr('mp_col_mic', 'Mic')}</span><span class="mg-h-col">${tr('mp_col_sounds', 'Sounds')}</span></div>
        <div id="mgList" class="mg-list"></div>
        <div class="modal-btns"><button id="mgClose" class="fbtn">${tr('close', 'Close')}</button></div>
      </div>`;
    const listEl = wrap.querySelector('#mgList');
    listEl.innerHTML = '';
    if (!list.length) {
      listEl.innerHTML = `<div class="req-empty">${tr('mp_manage_empty', 'Nobody to manage yet.')}</div>`;
    }
    for (const name of list) {
      const here = inRoom.has(name);
      const roomBan = this.bans && this.bans[name] > now ? this.bans[name] : 0;
      const ov = this.permOverride(name);
      const soundBan = ov && ov.customAudio === false && this.overrideLive(ov) ? (ov.customAudioUntil || -1) : 0;
      const row = document.createElement('div');
      row.className = 'mg-row';
      row.innerHTML = `
        <span class="jam-pdot" style="background:${hashColor(name)}"></span>
        <span class="mg-name">${name}${here ? '' : ` <i class="mg-away">(${tr('mp_not_here', 'not here')})</i>`}
          ${roomBan ? `<span class="mg-badge">${tr('mp_room_banned', 'Room banned')} ${this.banLabel(roomBan)}</span>` : ''}
          ${soundBan ? `<span class="mg-badge">${tr('mp_sound_banned', 'Sound banned')}${soundBan > 0 ? ' ' + this.banLabel(soundBan) : ''}</span>` : ''}
        </span>
        <label class="mg-tog"><input type="checkbox" class="mg-mic" ${this.micRight(name) ? 'checked' : ''}></label>
        <label class="mg-tog"><input type="checkbox" class="mg-snd" ${this.customAudioRight(name) === true ? 'checked' : ''}></label>`;
      row.querySelector('.mg-mic').addEventListener('change', (e) => this.setPerm(name, 'mic', e.target.checked));
      row.querySelector('.mg-snd').addEventListener('change', (e) => this.setPerm(name, 'customAudio', e.target.checked));
      if (roomBan) {
        const un = document.createElement('button');
        un.className = 'fbtn mg-unban';
        un.textContent = tr('mp_unban', 'Unban');
        un.addEventListener('click', () => this.liftRoomBan(name));
        row.appendChild(un);
      }
      listEl.appendChild(row);
    }
    if (fresh) {
      wrap.querySelector('#mgSearch').addEventListener('input', () => this.renderManage());
      wrap.querySelector('#mgClose').addEventListener('click', () => wrap.remove());
    }
  },

  sendPresence() {
    const p = {
      type: 'presence', id: this.me.id, name: this.me.name, color: this.me.color,
      host: this.isHost, joinTs: this.me.joinTs, iid: this.installId(),
      gz: this.gzSupported ? 1 : 0
    };
    if (this.isHost) { p.settings = this.settings; p.started = this.started; }
    this.send(p);
  },

  sweep() {
    const now = Date.now();
    if (this.knockGz.size && !this._knockSweep) this._knockSweep = now;
    if (this._knockSweep && now - this._knockSweep > 30000) { this.knockGz.clear(); this._knockSweep = 0; }
    if (!this.knockGz.size) this._knockSweep = 0;
    let lostHost = false, changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > this.peerTimeout()) {
        this.peers.delete(id);
        this.cursors.delete(id);
        if (p.host) lostHost = true;
        changed = true;
      }
    }
    for (const [key, l] of this.locks) if (now - l.ts > 15000) this.locks.delete(key);
    if (this.isHost) this.pruneAudioBans();
    if (lostHost) this.hostLost();
    if (changed) { this.renderPanel(); this.renderCursors(); }
  },

  noteVersionRefusal(name, theirVer) {
    const who = name || tr('mp_someone', 'Someone');
    const ver = theirVer && /^\d/.test(theirVer) ? theirVer : tr('ver_pre123', 'an older version');
    this._refused = this._refused || new Map();
    const last = this._refused.get(who) || 0;
    if (Date.now() - last < 20000) return;
    this._refused.set(who, Date.now());

    const line = tr('ver_share', '{who}: you need fabu {need} to join this room. Get it here: {url}',
      { who, need: App.version, url: App.RELEASES_URL + '/tag/v' + App.version });

    App.askChoice({
      title: tr('ver_refused_title', '{who} could not join', { who }),
      body: tr('ver_refused_body',
        "They are on {theirs} and this room is on {mine}. Everyone has to be on the same version. Older versions of fabu cannot show them why, so you will need to tell them.",
        { theirs: ver, mine: App.version }),
      buttons: [
        { label: tr('ver_copy', 'Copy message for them'), value: 'copy', style: 'accent' },
        { label: tr('close', 'Close'), value: null }
      ]
    }).then((v) => {
      if (v !== 'copy') return;
      const done = () => toast(tr('ver_copied', 'Copied. Paste it to them.'), 'green');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(line).then(done, () => {});
      else {
        const ta = document.createElement('textarea');
        ta.value = line; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        ta.remove();
      }
    });
  },

  async showVersionMismatch(hostVer) {
    const mine = App.version;
    const newer = App.cmpVersion(mine, hostVer) > 0;
    const latest = await App.latestVersion();
    const params = { mine, host: hostVer };

    if (newer) {
      const go = await App.askChoice({
        title: tr('ver_title', 'Version mismatch!'),
        body: tr('ver_newer', "You're on a newer version of fabu ({mine}) than the host ({host}). This is not your fault! You can download an older version here:", params) + ' ' + App.RELEASES_URL,
        buttons: [
          { label: tr('ver_open_releases', 'Open downloads'), value: 'go', style: 'accent' },
          { label: tr('close', 'Close'), value: null }
        ]
      });
      if (go === 'go') App.openReleases();
      return;
    }

    const hostIsLatest = latest ? App.cmpVersion(hostVer, latest) >= 0 : true;
    const go = await App.askChoice({
      title: tr('ver_title', 'Version mismatch!'),
      body: hostIsLatest
        ? tr('ver_older_latest', "You're on an older version of fabu ({mine}) than the host ({host}). You can update to the newest version here:", params)
        : tr('ver_older_pinned', "You're on an older version of fabu ({mine}) than the host ({host}). You can download this version here:", params) + ' ' + App.RELEASES_URL + '/tag/v' + hostVer,
      buttons: [
        { label: hostIsLatest ? tr('ver_update', 'Download update') : tr('ver_get_that', 'Download {host}', params), value: 'go', style: 'accent' },
        { label: tr('close', 'Close'), value: null }
      ]
    });
    if (go === 'go') App.openReleases(hostIsLatest ? null : hostVer);
  },

  async warnIfHostOutdated() {
    const latest = await App.latestVersion();
    if (!latest || App.cmpVersion(App.version, latest) >= 0) return;
    await App.askChoice({
      title: tr('ver_host_title', "You're not on the latest version!"),
      body: tr('ver_host_body', "It's recommended you use the latest version of fabu. Other people might not be able to join you."),
      buttons: [
        { label: tr('ver_update', 'Download update'), value: 'go', style: 'accent' },
        { label: tr('ver_continue', 'Continue anyway'), value: null }
      ]
    }).then(v => { if (v === 'go') App.openReleases(); });
  },

  // ---------- host loss & handover ----------
  // took forever to get right, be careful in here
  hostLost() {
    if (!this.admitted || this._electing) return;

    if (Date.now() < this.hostGraceUntil) return;
    if (!this._hostWait) {
      this._hostWait = Date.now();
      this.showBanner('host_gone', 'working');
      return;
    }
    if (Date.now() - this._hostWait < 15000) return;   // grace period
    this._hostWait = 0;

    this._electing = true;
    const cands = [{ id: this.me.id, name: this.me.name, joinTs: this.me.joinTs }];
    for (const [id, p] of this.peers) cands.push({ id, name: p.name, joinTs: p.joinTs });
    cands.sort((a, b) => (a.joinTs - b.joinTs) || (a.id < b.id ? -1 : 1));
    const winner = cands[0];

    if (cands.length === 1) {
      this._electing = false;
      this.saveRecovery();
      this.disconnect(true);
      this.fail('room_gone');
      return;
    }

    this._electing = false;
    if (winner.id === this.me.id) {
      this.isHost = true;
      this.sendPresence();
      this.showBanner('host_lost', 'ok', { name: tr('mp_you', 'You') });
      toast(tr('mp_you_host', 'You are the host now'), 'green');
    } else {
      this.showBanner('host_lost', 'ok', { name: winner.name });
    }
    this.renderPanel();
  },

  hostSeen() {
    this._hostWait = 0;
    if (this.banner && this.banner.classList.contains('mpb-working')) this.hideBanner();
  },

  // ---------- kick ----------
  kick(peerId, durationMs) {
    if (!this.isHost) return;
    const p = this.peers.get(peerId);
    if (!p) return;
    const until = durationMs > 0 ? Date.now() + durationMs : Date.now() + 100 * 365 * 24 * 3600e3;
    this.bans[p.name] = until;
    this.rememberBan(p, until);     // a rename must not undo this
    this.kicked.add(peerId);        // do not take their word for it that they left
    this.send({ type: 'kick', to: peerId, until });
    this.peers.delete(peerId);
    this.cursors.delete(peerId);
    this.pushHistory({ ts: Date.now(), name: p.name, action: 'kicked' });
    toast(tr('mp_kicked_toast', '{name} was removed', { name: p.name }));
    this.renderPanel();
    this.renderCursors();
  },

  cycleCode() {
    if (!this.isHost) return;
    const newCode = this.generateCode();
    this.send({ type: 'migrate', from: this.me.id, to: newCode }); // tell current members (sent on the old channel)
    this.room = newCode;
    this.send({ type: 'join', room: newCode });
    this.renderPanel();
    toast(tr('mp_code_cycled', 'New room code set. The old one no longer works.'), 'green');
  },

  kickAllExcept(keepIds, durationMs) {
    if (!this.isHost) return;
    const keep = new Set(keepIds);
    keep.add(this.me.id);
    const targets = [...this.peers.keys()].filter(id => !keep.has(id));
    const until = durationMs > 0 ? Date.now() + durationMs : Date.now() + 100 * 365 * 24 * 3600e3;
    for (const id of targets) {
      const pr = this.peers.get(id);
      if (!pr) continue;
      this.bans[pr.name] = until;
      this.rememberBan(pr, until);
      this.kicked.add(id);
      this.send({ type: 'kick', to: id, until });
      this.peers.delete(id);
      this.cursors.delete(id);
    }
    if (this.selPlayers) this.selPlayers.clear();
    toast(tr('mp_kicked_all', 'Removed {n} people', { n: targets.length }));
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

  // ---------- locks ----------
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
    for (const el of document.querySelectorAll('[data-lk]')) {
      const l = this.lockedBy(el.dataset.lk);
      el.disabled = !!l;
      el.classList.toggle('locked', !!l);
      if (l) el.dataset.tip = tr('mp_locked_by', '{name} is using this', { name: l.name });
    }
    for (const el of document.querySelectorAll('.clip')) {
      const l = this.lockedBy('clip:' + el.dataset.clipId);
      el.classList.toggle('mp-locked', !!l);
      el.style.outline = l ? '2px solid ' + hashColor(l.name) : '';
    }
  },

  // ---------- live cursors ----------
  viewportData() {
    const sc = document.getElementById('tlScroll');
    return { sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0, zoom: UI.zoom };
  },

  // ---------- cursor rate control ----------
  CURSOR_BUDGET: 1500,   // relay messages/sec allowed for cursor chatter
  CURSOR_MAX_ROOM: 40,   // past this, cursors cost more than they are worth

  cursorInterval() {
    const n = this.peers.size + 1;
    if (n > this.CURSOR_MAX_ROOM) return 0;          // 0 = do not send at all
    let ms = (n * (n - 1)) / this.CURSOR_BUDGET * 1000;
    if (this.quality === 'slow') ms *= 2;
    else if (this.quality === 'bad') ms *= 4;
    return clamp(ms, 55, 1000);
  },

  presenceInterval() {
    const n = this.peers.size + 1;
    return clamp(2000 * Math.ceil(n / 20), 2000, 8000);
  },

  peerTimeout() { return this.presenceInterval() * 3 + 3000; },

  noteCursorsOff() {
    if (this._cursorsOffNoted) return;
    this._cursorsOffNoted = true;
    toast(tr('mp_cursors_off', 'Live cursors are off in rooms this big, to keep the room stable.'));
  },

  initCursors() {
    let lastC = 0, lastV = 0;
    document.addEventListener('mousemove', (e) => {
      if (!this.admitted) return;
      const iv = this.cursorInterval();
      if (!iv) { this.noteCursorsOff(); return; }
      const now = performance.now();
      if (now - lastC < iv) return;
      lastC = now;
      const r = Timeline.lanes.getBoundingClientRect();
      const overCanvas = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      const r3 = (v) => Math.round(v * 1000) / 1000;
      const msg = {
        type: 'cursor', id: this.me.id,
        over: overCanvas ? 'c' : 'w',
        fx: r3(e.clientX / window.innerWidth), fy: r3(e.clientY / window.innerHeight)
      };
      if (overCanvas) { msg.beat = r3((e.clientX - r.left) / UI.zoom); msg.y = Math.round(e.clientY - r.top); }
      if (this.peers.size < 12) Object.assign(msg, this.viewportData());
      this.send(msg);
    });
    const sc = document.getElementById('tlScroll');
    if (sc) sc.addEventListener('scroll', () => {
      if (!this.admitted) return;
      const iv = this.cursorInterval();
      if (!iv) return;
      const now = performance.now();
      if (now - lastV < Math.max(60, iv)) return;
      lastV = now;
      this.send(Object.assign({ type: 'view', id: this.me.id }, this.viewportData()));
    });
  },

  renderCursors() {
    let layer = document.getElementById('cursorLayer');
    if (!layer) { layer = document.createElement('div'); layer.id = 'cursorLayer'; Timeline.lanes.appendChild(layer); }
    let winLayer = document.getElementById('cursorLayerWin');
    if (!winLayer) { winLayer = document.createElement('div'); winLayer.id = 'cursorLayerWin'; document.body.appendChild(winLayer); }
    if (!this._cursorEls) this._cursorEls = new Map();
    if (!this.admitted) {
      for (const [, el] of this._cursorEls) el.remove();
      this._cursorEls.clear();
      return;
    }
    const now = Date.now();
    const seen = new Set();
    for (const [id, c] of this.cursors) {
      if (now - c.ts > 5000) continue;
      seen.add(id);
      let el = this._cursorEls.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mp-cursor';
        el.innerHTML = '<div class="mp-cursor-dot"></div><div class="mp-cursor-name"></div>';
        this._cursorEls.set(id, el);
      }
      const onCanvas = c.over !== 'w';
      const wantLayer = onCanvas ? layer : winLayer;
      if (el.parentNode !== wantLayer) wantLayer.appendChild(el);
      el.classList.toggle('mp-cursor-win', !onCanvas);
      if (onCanvas && c.beat != null) { el.style.left = (c.beat * UI.zoom) + 'px'; el.style.top = c.y + 'px'; }
      else { el.style.left = (c.fx * window.innerWidth) + 'px'; el.style.top = (c.fy * window.innerHeight) + 'px'; }
      el.querySelector('.mp-cursor-dot').style.background = c.color;
      const nm = el.querySelector('.mp-cursor-name');
      nm.style.background = c.color;
      if (nm.textContent !== c.name) nm.textContent = c.name;
    }
    for (const [id, el] of this._cursorEls) {
      if (!seen.has(id)) { el.remove(); this._cursorEls.delete(id); }
    }
  },

  sendPlayhead(beat, playing) {
    if (!this.admitted) return;
    const now = performance.now();
    if (playing) {
      const iv = Math.max(80, this.cursorInterval());
      if (!this.cursorInterval()) return;
      if (this._lastPh && now - this._lastPh < iv) return;
    }
    this._lastPh = now;
    this.send({ type: 'ph', id: this.me.id, name: this.me.name, color: this.me.color, beat, playing });
  },

  renderRemotePlayheads() {
    let layer = document.getElementById('remotePhLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'remotePhLayer';
      Timeline.lanes.appendChild(layer);
    }
    if (!this._phEls) this._phEls = new Map();
    if (!this.admitted) {
      for (const [, el] of this._phEls) el.remove();
      this._phEls.clear();
      return;
    }
    const now = Date.now();
    const h = (S.tracks.length * 84 + 30);
    const seen = new Set();
    for (const [id, ph] of this.remotePH) {
      if (!ph.playing || now - ph.ts > 3000) continue;
      seen.add(id);
      let el = this._phEls.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mp-playhead';
        el.innerHTML = '<div class="mp-ph-flag"></div>';
        layer.appendChild(el);
        this._phEls.set(id, el);
      }
      el.style.height = h + 'px';
      el.style.setProperty('--pc', ph.color);
      el.style.left = (ph.beat * UI.zoom) + 'px';
      const flag = el.querySelector('.mp-ph-flag');
      if (flag.textContent !== ph.name) flag.textContent = ph.name;
    }
    for (const [id, el] of this._phEls) {
      if (!seen.has(id)) { el.remove(); this._phEls.delete(id); }
    }
  },

  // ---------- state sync ----------
  usedSampleIds() {
    const used = new Set();
    for (const t of S.tracks) for (const c of t.clips) if (c.sampleId) used.add(c.sampleId);
    for (const inst of Object.values(S.instruments || {})) if (inst.sampleId) used.add(inst.sampleId);
    return used;
  },

  SIZE_LIMIT: 55 * 1024 * 1024,   // relay chokes past ~62 MB, leave a margin

  broadcast(force = false) {
    if (!this.admitted || this.applyingRemote || !this.synced) return;
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
    const msg = { type: 'state', room: this.room, rev: this.rev + 1, state: JSON.parse(stateJson), from: this.me && this.me.id, by: this.me && this.me.name };
    if (hasSamples) msg.samples = samples;
    const json = JSON.stringify(msg);
    if (json.length > this.SIZE_LIMIT) {
      for (const id of added) this.sharedSamples.delete(id); // retry once the project shrinks
      if (!this._sizeWarned) { this._sizeWarned = true; this.showSizeLimit(); }
      return;
    }
    this._sizeWarned = false;
    this.rev += 1;
    this.lastSent = stateJson;
    if (json.length > 1024 && this.canGz()) {
      this.gzip(json).then((gz) => {
        if (!this.ws || this.ws.readyState !== 1) return;
        const frame = new Uint8Array(4 + gz.length);
        frame.set(this.GZ_MAGIC); frame.set(gz, 4);
        try { this.ws.send(frame.buffer); this.lastTx = Date.now(); } catch (e) {}
      }).catch(() => { try { this.ws.send(json); } catch (e) {} });
      return;
    }
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
        <div class="modal-sub">${tr('size_sub', "You've hit the file size limit for a shared project. You can export it as it is, or keep editing on your own until it is smaller, and the others will wait.")}</div>
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
    this.synced = true;
    this.lastSent = incoming;
    this.applyingRemote = true;
    this.loadSamples(samples).then((got) => { if (got) { Timeline.render(); Windows.refreshAll(); } });
    try {
      this.applyRemoteState(stateObj, identical);
    } catch (e) {
      console.warn('applyRemote failed', e);
    }
    this.applyingRemote = false;
  },

  applyRemoteState(stateObj, identical) {
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
      const inRoom = !!this.room; // we've started joining/creating a room
      const hint = !inRoom
        ? tr('mp_not_connected', 'Not in a room. Open Multiplayer from the home menu, or create a room now.')
        : this.connected
          ? tr('mp_waiting', 'Waiting for the host to let you in…')
          : tr('mp_connecting', 'Connecting (might take a minute)');
      p.innerHTML = `
        <div class="jam-head"><svg class="ic"><use href="#i-users"/></svg>
          <span>${inRoom ? tr('mp_room', 'Room') : tr('jam_title', 'Jam together')}</span></div>
        <div class="jam-hint">${hint}</div>
        ${inRoom ? '' : `<div class="jam-row"><button id="jamCreateBtn" class="fbtn accent" style="flex:1">${tr('mp_create_room', 'Create a room')}</button></div>`}`;
      const cb = p.querySelector('#jamCreateBtn');
      if (cb) cb.addEventListener('click', () => Auth.require(() => MP.openCreate(true)));
      return;
    }

    const players = [{ id: this.me.id, name: this.me.name, color: this.me.color, host: this.isHost, me: true }];
    for (const [id, peer] of this.peers) players.push({ id, name: peer.name, color: peer.color, host: peer.host });
    players.sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0));

    p.innerHTML = `
      <div class="jam-head"><svg class="ic"><use href="#i-users"/></svg>
        <span>${tr('mp_room', 'Room')}</span>
        <span style="flex:1"></span>
        <span class="jam-dot" style="background:var(--green)"></span>
        <span class="jam-status">${players.length}/${this.settings.maxPlayers}</span></div>
      <div class="jam-code-row">
        <button id="jamCode" class="jam-code" data-tip="${tr('mp_code_tip', 'Click to reveal, again to copy, again to hide')}">${tr('mp_code_hidden', 'Code: click to reveal')}</button>
        ${this.isHost ? `<button id="jamCycle" class="jam-cycle" data-tip="${tr('mp_cycle_tip', 'New code, old one gets made invalid but everyone stays')}"><svg class="ic"><use href="#i-redo"/></svg></button>` : ''}
      </div>
      <div id="jamPlayers"></div>
      ${this.isHost && (this.settings.approve || (this.pendingEvades || []).length) ? `<button id="jamReqBtn" class="fbtn jam-req">${tr('mp_requests', 'Requests')}${this.pendingReqs.length + (this.pendingEvades || []).length ? `<span class="req-badge">${this.pendingReqs.length + (this.pendingEvades || []).length}</span>` : ''}</button>` : ''}
      ${this.isHost ? `
      <div class="jam-set">
        <label class="jam-check"><input type="checkbox" id="jamApprove" ${this.settings.approve ? 'checked' : ''}> ${tr('mp_approve', 'Approve joining')}</label>
        <label class="jam-check">${tr('mp_max_players', 'Max players')} <input type="number" id="jamMax" min="2" max="100" value="${this.settings.maxPlayers}"></label>
        <div class="jam-set-sep">${tr('mp_rules', 'Room rules')}</div>
        <label class="jam-check"><input type="checkbox" id="jamAllowMic" ${this.settings.allowMic !== false ? 'checked' : ''}> ${tr('mp_allow_mic', 'Allow microphone recording for everybody')}</label>
        <label class="jam-check"><input type="checkbox" id="jamAllowAudio" ${this.settings.allowCustomAudio !== false ? 'checked' : ''}> ${tr('mp_allow_audio', 'Allow custom audio files from everybody')}</label>
        <label class="jam-check"><input type="checkbox" id="jamApproveAudio" ${this.settings.approveAudio ? 'checked' : ''}> ${tr('mp_approve_audio', 'Manually approve custom audio files')}</label>
        <button id="jamHistory" class="fbtn jam-manage">${tr('mp_history', 'Change history')}</button>
        <button id="jamManage" class="fbtn jam-manage">${tr('mp_manage', 'Manage people')}</button>
      </div>` : ''}
      <div class="jam-row"><button id="jamLeave" class="fbtn danger" style="flex:1">${tr('jam_disconnect', 'Leave')}</button></div>`;

    const codeBtn = p.querySelector('#jamCode');
    let codeState = 0; // 0 hidden, 1 revealed, 2 copied
    codeBtn.addEventListener('click', () => {
      if (codeState === 0) { codeBtn.textContent = this.room; codeBtn.classList.add('revealed'); codeState = 1; }
      else if (codeState === 1) { if (navigator.clipboard) navigator.clipboard.writeText(this.room); toast(tr('mp_code_copied', 'Code copied')); codeState = 2; }
      else { codeBtn.textContent = tr('mp_code_hidden', 'Code: click to reveal'); codeBtn.classList.remove('revealed'); codeState = 0; }
    });
    const cyc = p.querySelector('#jamCycle');
    if (cyc) cyc.addEventListener('click', () => this.cycleCode());

    const list = p.querySelector('#jamPlayers');
    if (!this.selPlayers) this.selPlayers = new Set();
    for (const pl of players) {
      const row = document.createElement('div');
      const sel = this.isHost && this.selPlayers.has(pl.id);
      row.className = 'jam-player' + (sel ? ' mp-selected' : '') + (this.isHost && !pl.me ? ' clickable' : '');
      row.innerHTML = `
        <span class="jam-pdot" style="background:${pl.color}"></span>
        <span class="jam-pname">${pl.name}${pl.me ? ' <i>(' + tr('mp_you', 'you') + ')</i>' : ''}</span>
        ${pl.host ? `<span class="jam-crown" data-tip="${tr('mp_host', 'Host')}">♛</span>` : ''}`;
      if (!pl.me && this.isHost) {
        row.dataset.tip = tr('mp_player_tip', 'Shift-click to select, right-click for options');
        row.addEventListener('click', (e) => {
          if (e.target.closest('.jam-kick')) return;
          if (e.shiftKey) {
            if (this.selPlayers.has(pl.id)) this.selPlayers.delete(pl.id); else this.selPlayers.add(pl.id);
            this.renderPanel();
          }
        });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.openPlayerMenu(e.clientX, e.clientY, pl.id, pl.name); });
      }
      if (this.isHost && !pl.me) {
        const kick = document.createElement('button');
        kick.className = 'jam-kick';
        kick.dataset.tip = tr('mp_kick', 'Remove this player');
        kick.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
        kick.addEventListener('click', (e) => { e.stopPropagation(); this.openKickMenu(e.clientX, e.clientY, pl.id, pl.name); });
        row.appendChild(kick);
      }
      list.appendChild(row);
    }

    const reqBtn = p.querySelector('#jamReqBtn');
    if (reqBtn) reqBtn.addEventListener('click', () => this.openRequests());
    p.querySelector('#jamLeave').addEventListener('click', () => this.disconnect());

    if (this.isHost) {
      p.querySelector('#jamApprove').addEventListener('change', (e) => { this.settings.approve = e.target.checked; this.sendPresence(); this.renderPanel(); });
      p.querySelector('#jamMax').addEventListener('change', (e) => { this.settings.maxPlayers = clamp(parseInt(e.target.value) || 100, 2, 100); this.sendPresence(); });
      p.querySelector('#jamAllowMic').addEventListener('change', (e) => { this.settings.allowMic = e.target.checked; this.sendPresence(); toast(tr(e.target.checked ? 'mp_mic_on' : 'mp_mic_off', 'Mic recording ' + (e.target.checked ? 'allowed' : 'off'))); });
      p.querySelector('#jamAllowAudio').addEventListener('change', (e) => { this.settings.allowCustomAudio = e.target.checked; this.sendPresence(); toast(tr(e.target.checked ? 'mp_audio_on' : 'mp_audio_off', 'Custom sounds ' + (e.target.checked ? 'allowed' : 'off'))); });
      p.querySelector('#jamApproveAudio').addEventListener('change', (e) => { this.settings.approveAudio = e.target.checked; this.sendPresence(); });
      p.querySelector('#jamHistory').addEventListener('click', () => this.openHistory());
      p.querySelector('#jamManage').addEventListener('click', () => this.openManage());
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
      const col = this.quality === 'bad' ? 'var(--red)' : this.quality === 'slow' ? 'var(--yellow, #d9a441)' : 'var(--green)';
      pill.innerHTML = `<span class="jam-dot" style="background:${col}"></span> ${n}`;
      pill.dataset.tip = this.quality === 'good'
        ? tr('mp_players_tip', 'Players in this room')
        : tr('mp_quality_poor', 'Connection is struggling. Your changes may be delayed.');
    } else if (this.room) {
      pill.classList.remove('hidden');
      pill.innerHTML = `<span class="jam-dot" style="background:var(--red)"></span> …`;
      pill.dataset.tip = tr('mp_reconnecting', 'Connection lost, reconnecting…');
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

  openPlayerMenu(x, y, id, name) {
    const old = document.getElementById('kickMenu');
    if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'kickMenu';
    m.className = 'ctx-menu';
    const add = (label, danger, fn) => {
      const b = document.createElement('button');
      b.className = 'ctx-item' + (danger ? ' danger' : '');
      b.textContent = label;
      b.addEventListener('click', () => { m.remove(); fn(); });
      m.appendChild(b);
    };
    const sel = this.selPlayers && this.selPlayers.size ? [...this.selPlayers] : null;
    if (sel && sel.length) {
      const names = sel.map(pid => (this.peers.get(pid) || {}).name).filter(Boolean);
      const label = names.length <= 3
        ? tr('mp_kick_except_these', 'Kick all except {list}', { list: names.join(', ') })
        : tr('mp_kick_except_n', 'Kick all except these {n}', { n: names.length });
      add(label, true, () => this.kickAllExcept(sel, 0));
      add(tr('mp_clear_sel', 'Clear selection'), false, () => { this.selPlayers.clear(); this.renderPanel(); });
    } else {
      add(tr('mp_kick_except', 'Kick all except {name}', { name }), true, () => this.kickAllExcept([id], 0));
    }
    add(tr('mp_remove_player', 'Remove {name}…', { name }), true, () => this.openKickMenu(x, y, id, name));
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

    for (const e of (this.pendingEvades || [])) {
      const row = document.createElement('div');
      row.className = 'req-row req-blocked';
      row.innerHTML = `<span class="req-who">
          <span class="req-line"><span class="jam-pdot" style="background:${hashColor(e.name)}"></span><span class="jam-pname">${e.name}</span></span>
          <span class="req-why">${tr('mp_evade_why', 'same connection as {was}', { was: e.wasName || tr('word_someone', 'someone removed') })}</span>
        </span>`;
      const ok = document.createElement('button');
      ok.className = 'fbtn accent'; ok.textContent = tr('mp_evade_allow', 'Let them in');
      ok.addEventListener('click', () => this.allowEvader(e.iid));
      const no = document.createElement('button');
      no.className = 'fbtn danger'; no.textContent = tr('mp_evade_keep', 'Keep blocked');
      no.addEventListener('click', () => {
        this.pendingEvades = this.pendingEvades.filter(x => x.iid !== e.iid);
        this.renderRequests(); this.renderPanel();
      });
      row.append(ok, no);
      list.appendChild(row);
    }

    const shown = this.pendingReqs.filter(r => r.name.includes(filter.toLowerCase()));
    if (!shown.length && !(this.pendingEvades || []).length) {
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

// ---------- home-menu multiplayer flow ----------
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
          <label class="jam-check"><input type="checkbox" id="mpApprove"> ${tr('mp_approve', 'Approve joining')}</label>
          <label class="jam-check">${tr('mp_max_players', 'Max players')} <input type="number" id="mpMax" min="2" max="100" value="100"></label>
          <div class="jam-set-sep">${tr('mp_rules', 'Room rules')}</div>
          <label class="jam-check"><input type="checkbox" id="mpAllowMic" checked> ${tr('mp_allow_mic', 'Allow microphone recording for everybody')}</label>
          <label class="jam-check"><input type="checkbox" id="mpAllowAudio" checked> ${tr('mp_allow_audio', 'Allow custom audio files from everybody')}</label>
          <label class="jam-check"><input type="checkbox" id="mpApproveAudio"> ${tr('mp_approve_audio', 'Manually approve custom audio files')}</label>
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
        allowLate: true,
        approve: wrap.querySelector('#mpApprove').checked,
        maxPlayers: clamp(parseInt(wrap.querySelector('#mpMax').value) || 100, 2, 100),
        allowMic: wrap.querySelector('#mpAllowMic').checked,
        allowCustomAudio: wrap.querySelector('#mpAllowAudio').checked,
        approveAudio: wrap.querySelector('#mpApproveAudio').checked,
        perms: {}
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

let _syncTimer = null;
function _wrapUndo(name) {
  const orig = Undo[name].bind(Undo);
  Undo[name] = function (...args) {
    const r = orig(...args);
    if (typeof Engine !== 'undefined') Engine.liveEdit(); // apply the edit to live playback
    if (Sync.admitted && !Sync.applyingRemote) { clearTimeout(_syncTimer); _syncTimer = setTimeout(() => Sync.broadcast(), 70); }
    return r;
  };
}
['push', 'undo', 'redo'].forEach(_wrapUndo);

(function wrapPlay() {
  const orig = Engine.play.bind(Engine);
  Engine.play = function (...args) {
    if (Sync.isHost && !Sync.started) { Sync.started = true; Sync.sendPresence(); }
    return orig(...args);
  };
})();

document.addEventListener('mousedown', () => { Sync.busy = true; }, true);
document.addEventListener('mouseup', () => {
  Sync.busy = false;
  if (Sync.pending && !Sync.typingBusy()) {
    const m = Sync.pending; Sync.pending = null;
    Sync.applyRemote(m.state, m.samples);
  }
}, true);

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
window.addEventListener('DOMContentLoaded', () => { try { Sync.offerRecovery(); } catch (e) {} });

window.addEventListener('offline', () => {
  if (!Sync.room) return;
  Sync.showBanner('offline', 'working');
  if (Sync.ws) { try { Sync.ws.close(); } catch (e) {} }
});
window.addEventListener('online', () => {
  if (!Sync.room || Sync._manualClose || Sync.connected) return;
  Sync.retryTries = 0;                       // a fresh network deserves a fresh budget
  clearTimeout(Sync.retryTimer); Sync.retryTimer = null;
  Sync.attemptReconnect();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Sync.connected) Sync.checkHealth();
});
