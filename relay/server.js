// fabu relay: a tiny room-based WebSocket broadcaster.
// Deploy on Render as a Node web service. Health check answers "fabu relay ok".
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('fabu relay ok');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });
const rooms = new Map(); // code -> Set(sockets)

function joinRoom(ws, room) {
  leaveRoom(ws);
  ws.room = room;
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
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

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      // join messages register the socket; everything else is relayed
      let room = ws.room;
      try {
        const head = JSON.parse(data.toString());
        if (head && head.type === 'join' && typeof head.room === 'string') {
          joinRoom(ws, head.room.slice(0, 32));
          return;
        }
        if (head && typeof head.room === 'string') room = head.room.slice(0, 32);
      } catch (e) { /* not JSON: relay to own room anyway */ }
      if (!room) return;
      const set = rooms.get(room);
      if (!set) return;
      for (const peer of set) {
        if (peer === ws || peer.readyState !== 1) continue;
        try { peer.send(data); } catch (e) { /* never let one dead socket kill the loop */ }
      }
    } catch (e) { /* never crash the handler */ }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// sweep dead connections so rooms never fill with ghosts
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);

const port = process.env.PORT || 10000;
server.listen(port, () => console.log('fabu relay listening on ' + port));
