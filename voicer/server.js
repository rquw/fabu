const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 800) * 1024 * 1024;
const MAX_TAKE = 4 * 1024 * 1024;
const MAX_PLAYERS = 12;
const ROOM_IDLE_MS = 15 * 60 * 1000;   // nobody connected for this long -> room gone
const ROOM_MAX_MS = 6 * 60 * 60 * 1000;
const STORE = process.env.STORE_DIR || path.join(os.tmpdir(), 'voicer');
const PUBLIC = path.join(__dirname, 'public');

const T = {
  loading: 25000,
  countdown: 3200,
  recordGrace: 15000,
  judge: 6500,
  vote: 25000,
  reveal: 9000,
};

fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(STORE, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};
const VIDEO_MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  ogv: 'video/ogg', avi: 'video/x-msvideo',
};

const rooms = new Map();
const COLORS = ['#ff4d6d', '#ffb703', '#3ddc97', '#4cc9f0', '#b388ff', '#ff8fab', '#f77f00', '#06d6a0', '#8ecae6', '#e9ff70', '#ff70a6', '#70d6ff'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

// ---------- rooms ----------

function createRoom() {
  const room = {
    code: newCode(),
    created: Date.now(),
    lastSeen: Date.now(),
    hostId: null,
    players: new Map(),
    phase: 'lobby',
    settings: { rounds: 5, listen: true, voting: true, removal: 'center' },
    media: null,
    clips: [],
    clipsRev: 0,
    order: [],
    round: -1,
    takes: new Map(),
    votes: new Map(),
    loaded: new Set(),
    showIdx: 0,
    showOrder: [],
    deadline: 0,
    timer: null,
    history: [],
    prep: null,
    dir: null,
  };
  room.dir = path.join(STORE, room.code);
  fs.mkdirSync(room.dir, { recursive: true });
  rooms.set(room.code, room);
  return room;
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  for (const p of room.players.values()) if (p.ws) try { p.ws.close(4000, 'room closed'); } catch {}
  rooms.delete(room.code);
  fs.rm(room.dir, { recursive: true, force: true }, () => {});
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color, face: p.face, connected: !!p.ws,
    points: p.points, judgePts: p.judgePts, votesGot: p.votesGot, accSum: p.accSum, rounds: p.rounds,
    joinedRound: p.joinedRound,
  };
}

function snapshot(room) {
  const cur = room.round >= 0 ? room.order[room.round] : null;
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    media: room.media && { id: room.media.id, name: room.media.name, size: room.media.size, mime: room.media.mime, url: `/m/${room.code}/${room.media.id}` },
    clipsRev: room.clipsRev,
    clipCount: room.clips.length,
    rounds: room.order.length,
    round: room.round,
    clip: cur,
    deadline: room.deadline,
    now: Date.now(),
    players: [...room.players.values()].map(publicPlayer),
    takes: [...room.takes.values()].map(t => ({ pid: t.pid, url: `/t/${room.code}/${t.id}`, fmt: t.fmt, score: t.score, votes: t.votes || 0, points: t.points || 0 })),
    voted: [...room.votes.keys()],
    loaded: [...room.loaded],
    showIdx: room.showIdx,
    showOrder: room.showOrder,
    history: room.history,
    prep: room.prep,
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.ws && p.ws !== except && p.ws.readyState === 1) p.ws.send(s);
}
function sync(room) { broadcast(room, { t: 'state', room: snapshot(room) }); }

function activePlayers(room) {
  return [...room.players.values()].filter(p => p.ws && p.joinedRound <= room.round);
}

function setPhase(room, phase, ms) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.deadline = ms ? Date.now() + ms : 0;
  if (ms) room.timer = setTimeout(() => advance(room, phase), ms);
  sync(room);
}

function clipDur(room) {
  const c = room.clips[room.order[room.round]];
  return c ? (c.end - c.start) * 1000 : 10000;
}

function startRound(room, i) {
  room.round = i;
  room.takes = new Map();
  room.votes = new Map();
  room.loaded = new Set();
  room.showIdx = 0;
  room.showOrder = [];
  setPhase(room, 'loading', T.loading);
}

function advance(room, from) {
  if (room.phase !== from) return;
  switch (from) {
    case 'loading':
      if (room.settings.listen) setPhase(room, 'preview', clipDur(room) + 2500);
      else setPhase(room, 'record', T.countdown + clipDur(room) + T.recordGrace);
      break;
    case 'preview':
      setPhase(room, 'record', T.countdown + clipDur(room) + T.recordGrace);
      break;
    case 'record': {
      room.showOrder = [...room.takes.keys()].sort(() => Math.random() - 0.5);
      if (!room.showOrder.length) return toReveal(room);
      room.showIdx = 0;
      setPhase(room, 'showcase', clipDur(room) + T.judge);
      break;
    }
    case 'showcase':
      if (room.showIdx < room.showOrder.length - 1) {
        room.showIdx++;
        setPhase(room, 'showcase', clipDur(room) + T.judge);
      } else if (room.settings.voting && room.takes.size >= 2) {
        setPhase(room, 'vote', T.vote);
      } else toReveal(room);
      break;
    case 'vote':
      toReveal(room);
      break;
    case 'reveal':
      if (room.round < room.order.length - 1) startRound(room, room.round + 1);
      else setPhase(room, 'final', 0);
      break;
  }
}

function toReveal(room) {
  const tally = new Map();
  for (const target of room.votes.values()) tally.set(target, (tally.get(target) || 0) + 1);
  const entry = { clip: room.order[room.round], takes: [] };
  for (const t of room.takes.values()) {
    const p = room.players.get(t.pid);
    t.votes = tally.get(t.pid) || 0;
    const judges = Math.max(0, Math.min(5, t.score?.judgePts | 0));
    t.points = judges + t.votes;
    if (p) {
      p.points += t.points;
      p.judgePts += judges;
      p.votesGot += t.votes;
      p.accSum += Math.max(0, Math.min(100, +t.score?.total || 0));
      p.rounds++;
    }
    entry.takes.push({ pid: t.pid, name: p ? p.name : '?', url: `/t/${room.code}/${t.id}`, fmt: t.fmt, total: t.score?.total || 0, judges, votes: t.votes, points: t.points });
  }
  entry.takes.sort((a, b) => b.points - a.points || b.total - a.total);
  room.history.push(entry);
  setPhase(room, 'reveal', T.reveal);
}

function maybeProgress(room) {
  const act = activePlayers(room);
  if (room.phase === 'loading' && act.every(p => room.loaded.has(p.id))) advance(room, 'loading');
  else if (room.phase === 'record' && act.length && act.every(p => room.takes.has(p.id))) advance(room, 'record');
  else if (room.phase === 'vote') {
    const voters = act.filter(p => [...room.takes.keys()].some(k => k !== p.id));
    if (voters.every(p => room.votes.has(p.id))) advance(room, 'vote');
  }
}

function resetScores(room) {
  for (const p of room.players.values()) Object.assign(p, { points: 0, judgePts: 0, votesGot: 0, accSum: 0, rounds: 0, joinedRound: -1 });
  room.history = [];
}

function pickHost(room) {
  const next = [...room.players.values()].find(p => p.ws);
  room.hostId = next ? next.id : room.hostId;
}

// ---------- ws ----------

function onMessage(ws, msg) {
  const t = msg && msg.t;
  if (t === 'ping') return send(ws, { t: 'pong', c: msg.c, s: Date.now() });

  if (t === 'create' || t === 'join') {
    let room;
    if (t === 'create') room = createRoom();
    else {
      room = rooms.get(String(msg.code || '').toUpperCase());
      if (!room) return send(ws, { t: 'error', code: 'no_room', msg: 'That room does not exist (anymore).' });
    }
    let p = msg.pid && room.players.get(msg.pid);
    if (p && p.token !== msg.token) p = null;
    if (!p) {
      if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', code: 'full', msg: 'Room is full.' });
      const used = new Set([...room.players.values()].map(x => x.color));
      p = {
        id: rid(6), token: rid(18), name: clean(msg.name, 20) || 'Player',
        color: COLORS.find(c => !used.has(c)) || COLORS[room.players.size % COLORS.length],
        face: +msg.face | 0, points: 0, judgePts: 0, votesGot: 0, accSum: 0, rounds: 0,
        joinedRound: room.phase === 'lobby' || room.phase === 'final' ? -1 : room.round + 1,
      };
      room.players.set(p.id, p);
    } else if (p.ws && p.ws !== ws) {
      try { p.ws.close(4001, 'replaced'); } catch {}
    }
    if (msg.name) p.name = clean(msg.name, 20) || p.name;
    p.ws = ws;
    ws.room = room;
    ws.pid = p.id;
    if (!room.hostId || !room.players.get(room.hostId)?.ws) room.hostId = p.id;
    room.lastSeen = Date.now();
    send(ws, { t: 'welcome', pid: p.id, token: p.token, code: room.code });
    if (room.clips.length) send(ws, { t: 'clips', clips: room.clips, rev: room.clipsRev });
    sync(room);
    return;
  }

  const room = ws.room;
  if (!room) return;
  const p = room.players.get(ws.pid);
  if (!p) return;
  room.lastSeen = Date.now();
  const isHost = room.hostId === p.id;

  switch (t) {
    case 'leave':
      room.players.delete(p.id);
      ws.room = null;
      if (room.hostId === p.id) pickHost(room);
      if (!room.players.size) return destroyRoom(room);
      sync(room);
      maybeProgress(room);
      break;
    case 'profile':
      p.name = clean(msg.name, 20) || p.name;
      if (msg.face != null) p.face = +msg.face | 0;
      sync(room);
      break;
    case 'settings':
      if (!isHost) return;
      room.settings = {
        rounds: Math.max(1, Math.min(30, +msg.settings.rounds || 5)),
        listen: !!msg.settings.listen,
        voting: !!msg.settings.voting,
        removal: ['center', 'mute', 'original'].includes(msg.settings.removal) ? msg.settings.removal : 'center',
      };
      sync(room);
      break;
    case 'prep':
      if (!isHost) return;
      room.prep = msg.prep ? { stage: clean(msg.prep.stage, 60), pct: Math.max(0, Math.min(100, +msg.prep.pct || 0)) } : null;
      sync(room);
      break;
    case 'clips': {
      if (!isHost || !Array.isArray(msg.clips)) return;
      const s = JSON.stringify(msg.clips);
      if (s.length > 2_000_000) return send(ws, { t: 'error', msg: 'Clip data too large.' });
      room.clips = msg.clips.slice(0, 200).map(c => ({
        start: +c.start || 0, end: +c.end || 0, lines: Array.isArray(c.lines) ? c.lines : [],
        env: typeof c.env === 'string' ? c.env : '', thumb: typeof c.thumb === 'string' && c.thumb.length < 40000 ? c.thumb : '',
        stereo: !!c.stereo,
      })).filter(c => c.end > c.start);
      room.clipsRev++;
      broadcast(room, { t: 'clips', clips: room.clips, rev: room.clipsRev });
      sync(room);
      break;
    }
    case 'start': {
      if (!isHost || !room.media || !room.clips.length) return;
      if (!['lobby', 'final'].includes(room.phase)) return;
      resetScores(room);
      const idx = room.clips.map((_, i) => i);
      if (msg.shuffle !== false) idx.sort(() => Math.random() - 0.5);
      room.order = idx.slice(0, room.settings.rounds);
      startRound(room, 0);
      break;
    }
    case 'loaded':
      if (room.phase === 'loading' && msg.round === room.round) { room.loaded.add(p.id); sync(room); maybeProgress(room); }
      break;
    case 'vote':
      if (room.phase !== 'vote' || msg.target === p.id || !room.takes.has(msg.target)) return;
      room.votes.set(p.id, msg.target);
      sync(room);
      maybeProgress(room);
      break;
    case 'react':
      broadcast(room, { t: 'react', pid: p.id, e: clean(msg.e, 4) });
      break;
    case 'chat':
      broadcast(room, { t: 'chat', pid: p.id, text: clean(msg.text, 200) });
      break;
    case 'skip':
      if (isHost && room.phase !== 'lobby' && room.phase !== 'final') advance(room, room.phase);
      break;
    case 'lobby':
      if (!isHost) return;
      clearTimeout(room.timer);
      room.round = -1; room.order = []; room.takes = new Map();
      setPhase(room, 'lobby', 0);
      break;
    case 'kick': {
      if (!isHost || msg.pid === p.id) return;
      const k = room.players.get(msg.pid);
      if (!k) return;
      room.players.delete(k.id);
      if (k.ws) { send(k.ws, { t: 'kicked' }); k.ws.room = null; try { k.ws.close(4002, 'kicked'); } catch {} }
      sync(room);
      maybeProgress(room);
      break;
    }
    case 'host':
      if (isHost && room.players.has(msg.pid)) { room.hostId = msg.pid; sync(room); }
      break;
  }
}

function onClose(ws) {
  const room = ws.room;
  if (!room) return;
  const p = room.players.get(ws.pid);
  if (p && p.ws === ws) {
    p.ws = null;
    if (room.hostId === p.id) pickHost(room);
    room.lastSeen = Date.now();
    sync(room);
    maybeProgress(room);
  }
}

// ---------- http ----------

function auth(req, room) {
  const p = room && room.players.get(req.headers['x-pid']);
  return p && p.token === req.headers['x-token'] ? p : null;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', d => { n += d.length; if (n > max) { reject(new Error('too big')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function handleUpload(req, res, room) {
  const p = auth(req, room);
  if (!p || room.hostId !== p.id) return json(res, 403, { error: 'Only the host can upload.' });
  const len = +req.headers['content-length'] || 0;
  if (len > MAX_UPLOAD) return json(res, 413, { error: `File too big (max ${MAX_UPLOAD / 1048576 | 0} MB).` });
  const name = clean(decodeURIComponent(req.headers['x-name'] || 'video'), 120);
  const ext = (name.split('.').pop() || '').toLowerCase();
  const mime = /^video\//.test(req.headers['content-type'] || '') ? req.headers['content-type'] : (VIDEO_MIME[ext] || 'video/mp4');
  const id = rid(9);
  const file = path.join(room.dir, id);
  const out = fs.createWriteStream(file);
  let n = 0, failed = false;
  const fail = (code, error) => {
    if (failed) return; failed = true;
    out.destroy(); fs.rm(file, { force: true }, () => {});
    if (!res.headersSent) json(res, code, { error });
    req.destroy();
  };
  req.on('data', d => {
    n += d.length;
    if (n > MAX_UPLOAD) return fail(413, 'File too big.');
    if (!out.write(d)) { req.pause(); out.once('drain', () => req.resume()); }
  });
  req.on('error', () => fail(400, 'Upload interrupted.'));
  req.on('aborted', () => fail(400, 'Upload interrupted.'));
  req.on('end', () => {
    if (failed) return;
    out.end(() => {
      if (!rooms.has(room.code)) return fs.rm(file, { force: true }, () => {});
      const old = room.media;
      room.media = { id, name, size: n, mime, file };
      if (old) fs.rm(old.file, { force: true }, () => {});
      room.clips = []; room.clipsRev++;
      json(res, 200, { id, url: `/m/${room.code}/${id}` });
      broadcast(room, { t: 'clips', clips: [], rev: room.clipsRev });
      sync(room);
    });
  });
}

async function handleTake(req, res, room, round) {
  const p = auth(req, room);
  if (!p) return json(res, 403, { error: 'Not in this room.' });
  if (room.phase !== 'record' || round !== room.round) return json(res, 409, { error: 'Too late for this round.' });
  let buf;
  try { buf = await readBody(req, MAX_TAKE); } catch { return json(res, 413, { error: 'Take too big.' }); }
  let score = {};
  try { score = JSON.parse(decodeURIComponent(req.headers['x-meta'] || '{}')); } catch {}
  const s = {
    total: Math.max(0, Math.min(100, +score.total || 0)), rhythm: +score.rhythm || 0, duration: +score.duration || 0,
    coverage: +score.coverage || 0, judgePts: Math.max(0, Math.min(5, score.judgePts | 0)),
    judges: Array.isArray(score.judges) ? score.judges.slice(0, 5).map(j => ({ yes: !!j.yes, line: clean(j.line, 80) })) : [],
  };
  const id = rid(9);
  fs.writeFileSync(path.join(room.dir, 't_' + id), buf);
  room.takes.set(p.id, { id, pid: p.id, fmt: clean(req.headers['x-fmt'] || 'cvop', 8), score: s, size: buf.length });
  json(res, 200, { ok: true });
  sync(room);
  maybeProgress(room);
}

function serveFile(req, res, file, mime, immutable) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const headers = {
      'Content-Type': mime, 'Accept-Ranges': 'bytes',
      'Cache-Control': immutable ? 'private, max-age=86400, immutable' : 'no-cache',
    };
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? +range[1] : st.size - +range[2];
      let end = range[1] && range[2] ? +range[2] : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() | 0 });
    if (parts[0] === 'api' && req.method === 'POST') {
      const room = rooms.get((parts[2] || '').toUpperCase());
      if (!room) return json(res, 404, { error: 'Room not found.' });
      room.lastSeen = Date.now();
      if (parts[1] === 'upload') return handleUpload(req, res, room);
      if (parts[1] === 'take') return handleTake(req, res, room, +parts[3]);
      return json(res, 404, { error: 'nope' });
    }
    if ((parts[0] === 'm' || parts[0] === 't') && parts.length === 3 && (req.method === 'GET' || req.method === 'HEAD')) {
      const room = rooms.get(parts[1]);
      if (!room) { res.writeHead(404); return res.end(); }
      room.lastSeen = Date.now();
      if (parts[0] === 'm') {
        if (!room.media || room.media.id !== parts[2]) { res.writeHead(404); return res.end(); }
        return serveFile(req, res, room.media.file, room.media.mime, true);
      }
      if (!/^[\w-]+$/.test(parts[2])) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, path.join(room.dir, 't_' + parts[2]), 'application/octet-stream', true);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 3 * 1024 * 1024 });
wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  let bucket = 0, stamp = Date.now();
  ws.on('message', data => {
    const now = Date.now();
    if (now - stamp > 1000) { stamp = now; bucket = 0; }
    if (++bucket > 60) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    try { onMessage(ws, msg); } catch (e) { console.error(e); }
  });
  ws.on('close', () => onClose(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = [...room.players.values()].some(p => p.ws);
    if ((!anyone && now - room.lastSeen > ROOM_IDLE_MS) || now - room.created > ROOM_MAX_MS) destroyRoom(room);
  }
}, 25000);

server.listen(PORT, () => console.log(`choicer voicer on :${PORT}`));
