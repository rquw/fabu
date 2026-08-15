const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ---- limits ----
const MAX_ROOM = 120;                // sockets in one room
const MAX_PER_IP = 12;               // sockets from one address
const MAX_MSG = 512 * 1024;          // an ordinary message (cursor, presence, chat)
const MAX_STATE = 12 * 1024 * 1024;  // a project state, which carries samples
const RATE_WINDOW = 1000;            // ms
const RATE_MSGS = 150;               // messages per window per socket
const RATE_BYTES = 6 * 1024 * 1024;  // bytes per window per socket
const STRIKES = 10;                  // rate violations tolerated before closing
const ROOM_RE = /^[A-Z0-9]{4,12}$/;

const STAMPED = new Set(['knock', 'presence', 'bye']);

const SECRET = process.env.RELAY_SECRET || crypto.randomBytes(32).toString('hex');
function connKey(ip) {
  return crypto.createHmac('sha256', SECRET).update('conn:' + ip).digest('hex').slice(0, 12);
}

const rooms = new Map();  // code -> Set(sockets)
const perIp = new Map();  // ip -> socket count

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: wss.clients.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('fabu relay ok');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_STATE + 256 * 1024 });

function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function joinRoom(ws, room) {
  if (!ROOM_RE.test(room)) return 'bad_code';
  const set = rooms.get(room) || new Set();
  if (!set.has(ws) && set.size >= MAX_ROOM) return 'full';
  leaveRoom(ws);
  ws.room = room;
  set.add(ws);
  rooms.set(room, set);
  return null;
}

function leaveRoom(ws) {
  if (!ws.room) return;
  const set = rooms.get(ws.room);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(ws.room);
  }
  ws.room = null;
}

function refuse(ws, why) {
  try { ws.send(JSON.stringify({ type: 'relay_refused', reason: why })); } catch (e) {}
}

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  const count = (perIp.get(ip) || 0) + 1;
  if (count > MAX_PER_IP) {
    refuse(ws, 'too_many');
    try { ws.close(1013, 'too many connections'); } catch (e) {}
    return;
  }
  perIp.set(ip, count);

  ws.isAlive = true;
  ws.room = null;
  ws.pk = connKey(ip);
  ws.sid = crypto.randomBytes(6).toString('hex');
  try { ws.send(JSON.stringify({ type: 'relay_hello', sid: ws.sid, pk: ws.pk })); } catch (e) {}
  ws.winStart = Date.now();
  ws.winMsgs = 0;
  ws.winBytes = 0;
  ws.strikes = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      const size = data.length || data.byteLength || 0;

      // ---- rate budget ----
      const now = Date.now();
      if (now - ws.winStart >= RATE_WINDOW) { ws.winStart = now; ws.winMsgs = 0; ws.winBytes = 0; }
      ws.winMsgs++;
      ws.winBytes += size;
      if (ws.winMsgs > RATE_MSGS || ws.winBytes > RATE_BYTES) {
        if (++ws.strikes > STRIKES) {
          refuse(ws, 'rate');
          try { ws.close(1008, 'rate limit'); } catch (e) {}
        }
        return;
      }

      let head = null;
      try { head = JSON.parse(data.toString()); } catch (e) { /* compressed state frame */ }

      // ---- joining ----
      if (head && head.type === 'join' && typeof head.room === 'string') {
        const err = joinRoom(ws, head.room.slice(0, 12).toUpperCase());
        if (err) refuse(ws, err);
        return;
      }

      // ---- size caps by kind ----
      const isState = !head || head.type === 'state';
      if (size > (isState ? MAX_STATE : MAX_MSG)) { refuse(ws, 'too_big'); return; }

      // ---- routing ----
      const room = ws.room;
      if (!room) return;
      const set = rooms.get(room);
      if (!set) return;

      let out = data;
      if (head && STAMPED.has(head.type)) {
        head._pk = ws.pk;
        head._sid = ws.sid;
        out = JSON.stringify(head);
      }
      for (const peer of set) {
        if (peer === ws || peer.readyState !== 1) continue;
        try { peer.send(out); } catch (e) { /* never let one dead socket kill the loop */ }
      }
    } catch (e) { /* never crash the handler */ }
  });

  const bye = () => {
    leaveRoom(ws);
    const left = (perIp.get(ip) || 1) - 1;
    if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
  };
  ws.on('close', bye);
  ws.on('error', bye);
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);

const port = process.env.PORT || 10000;
server.listen(port, () => console.log('fabu relay listening on ' + port));
