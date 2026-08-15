// ---------- load test ----------
'use strict';

const LoadTest = {
  bots: [],
  panel: null,
  statTimer: null,
  sent: 0,
  recv: 0,
  _lastSent: 0,
  _lastRecv: 0,

  NAMES: ['alex', 'sam', 'jordan', 'casey', 'riley', 'noah', 'mia', 'liam', 'emma', 'lucas',
    'ava', 'finn', 'zoe', 'kai', 'ruby', 'theo', 'nina', 'omar', 'iris', 'leo',
    'juno', 'remy', 'sage', 'wren', 'cleo', 'otis', 'vera', 'milo', 'hazel', 'ezra'],

  randomName() {
    const n = this.NAMES[Math.floor(Math.random() * this.NAMES.length)];
    return n + Math.floor(Math.random() * 900 + 100);
  },

  enabled() {
    try { return localStorage.getItem('fabu.dev') === '1'; } catch (e) { return false; }
  },

  spawn(n = 1) {
    if (!this.enabled()) return;
    if (typeof Sync === 'undefined' || !Sync.room || !Sync.connected) {
      toast(tr('lt_need_room', 'Load test: create or join a room first.'), 'red');
      return;
    }
    for (let i = 0; i < n; i++) this.addBot(Sync.room);
    this.showPanel();
  },

  addBot(room) {
    const bot = {
      id: 'bot_' + Math.random().toString(36).slice(2, 10),
      name: this.randomName(),
      color: 'hsl(' + Math.floor(Math.random() * 360) + ' 55% 55%)',
      joinTs: Date.now(),
      ws: null, admitted: false, alive: true,
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.02, vy: (Math.random() - 0.5) * 0.02,
      timers: []
    };
    try { bot.ws = new WebSocket(Sync.relayUrl); } catch (e) { return; }

    const send = (o) => {
      if (!bot.ws || bot.ws.readyState !== 1) return;
      o.room = room;
      try { bot.ws.send(JSON.stringify(o)); this.sent++; } catch (e) {}
    };
    bot.send = send;

    bot.ws.onopen = () => {
      send({ type: 'join', room });
      send({ type: 'knock', id: bot.id, name: bot.name });
      bot.timers.push(setInterval(() => {
        send({ type: 'presence', id: bot.id, name: bot.name, color: bot.color, host: false, joinTs: bot.joinTs });
      }, 2000));
      bot.timers.push(setInterval(() => {
        bot.x += bot.vx; bot.y += bot.vy;
        if (bot.x < 0 || bot.x > 1) { bot.vx *= -1; bot.x = Math.min(1, Math.max(0, bot.x)); }
        if (bot.y < 0 || bot.y > 1) { bot.vy *= -1; bot.y = Math.min(1, Math.max(0, bot.y)); }
        if (Math.random() < 0.02) { bot.vx = (Math.random() - 0.5) * 0.03; bot.vy = (Math.random() - 0.5) * 0.03; }
        send({ type: 'cursor', id: bot.id, name: bot.name, color: bot.color,
               over: 'c', fx: bot.x, fy: bot.y, beat: bot.x * 64, y: bot.y * 300,
               sl: 0, st: 0, zoom: 40 });
      }, 60));
      bot.timers.push(setInterval(() => {
        send({ type: 'ph', id: bot.id, name: bot.name, color: bot.color,
               beat: Math.random() * 64, playing: Math.random() < 0.5 });
      }, 900 + Math.random() * 900));
    };
    bot.ws.onmessage = () => { this.recv++; };
    bot.ws.onclose = () => { bot.alive = false; };
    bot.ws.onerror = () => { bot.alive = false; };

    this.bots.push(bot);
  },

  stopAll() {
    for (const b of this.bots) {
      for (const t of b.timers) clearInterval(t);
      try { b.send({ type: 'bye', id: b.id }); } catch (e) {}
      try { b.ws && b.ws.close(); } catch (e) {}
    }
    this.bots = [];
    this.sent = this.recv = 0;
    if (this.panel) { this.panel.remove(); this.panel = null; }
    clearInterval(this.statTimer); this.statTimer = null;
    toast(tr('lt_stopped', 'Load test stopped.'));
  },

  showPanel() {
    if (this.panel) return;
    const p = document.createElement('div');
    p.id = 'ltPanel';
    p.innerHTML = `
      <div class="lt-head">${tr('lt_title', 'Load test')} <span class="lt-warn">${tr('lt_dev', 'dev only')}</span></div>
      <div class="lt-stats" id="ltStats"></div>
      <div class="lt-row">
        <button class="fbtn" data-add="1">+1</button>
        <button class="fbtn" data-add="10">+10</button>
        <button class="fbtn" data-add="25">+25</button>
        <button class="fbtn" data-add="100">+100</button>
      </div>
      <div class="lt-row"><button class="fbtn danger" id="ltStop" style="flex:1">${tr('lt_stop', 'Stop all')}</button></div>`;
    document.body.appendChild(p);
    this.panel = p;
    p.querySelectorAll('[data-add]').forEach(b =>
      b.addEventListener('click', () => this.spawn(parseInt(b.dataset.add, 10))));
    p.querySelector('#ltStop').addEventListener('click', () => this.stopAll());

    this.statTimer = setInterval(() => this.updateStats(), 1000);
    this.updateStats();
  },

  updateStats() {
    if (!this.panel) return;
    const open = this.bots.filter(b => b.ws && b.ws.readyState === 1).length;
    const dead = this.bots.filter(b => !b.ws || b.ws.readyState > 1).length;
    const outRate = this.sent - this._lastSent;
    const inRate = this.recv - this._lastRecv;
    this._lastSent = this.sent; this._lastRecv = this.recv;
    this.panel.querySelector('#ltStats').innerHTML =
      `<div><b>${open}</b> ${tr('lt_connected', 'connected')}${dead ? ` <span class="lt-warn">(${dead} ${tr('lt_dropped', 'dropped')})</span>` : ''}</div>` +
      `<div>${tr('lt_out', 'out')} <b>${outRate}</b>/s &nbsp; ${tr('lt_in', 'in')} <b>${inRate}</b>/s</div>` +
      `<div class="lt-dim">${tr('lt_total', 'total')} ${this.sent} / ${this.recv}</div>`;
  }
};
