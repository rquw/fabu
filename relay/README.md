# fabu relay

The little server that connects players in a room. Deploy it on Render.

## Update your Render service

Your current relay at `fabu-relay.onrender.com` answers HTTP but stopped
relaying messages, so replace its code with `server.js` from this folder:

1. Open your `fabu-relay` service on render.com.
2. Wherever its code lives (the GitHub repo you connected when creating it),
   replace the main file with this folder's `server.js`.
3. Make sure `package.json` there has `"ws"` as a dependency and the start
   command is `node server.js`:

```json
{
  "name": "fabu-relay",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "ws": "^8.18.0" }
}
```

4. Push / redeploy. When it says Live, opening the URL in a browser should
   show `fabu relay ok`.

This version never crashes on a dead connection, cleans up ghost sockets
every 30 seconds, and caps messages at 64 MB (plenty for project + samples).

## Test locally

```bash
cd relay
npm install
PORT=8472 node server.js
```

## What the relay enforces (added 2026-08)

The relay is deliberately ignorant of music: it does not know what a note is,
who the host is, or what the room rules are. That is the app's job. But it is
the only place that can enforce anything against a MODIFIED client, because a
modified client simply skips whatever the app would have checked.

- **A socket only reaches the room it joined.** Previously any message carrying
  a `room` field was broadcast to that room, so anyone who knew a room code
  could inject into it without ever joining. Nothing the host does could stop
  that, because host moderation only applies to people who actually joined.
- **Room codes must match `[A-Z0-9]{4,12}`.**
- **Caps:** 120 sockets per room, 12 sockets per IP, 512 KB per ordinary
  message, 12 MB for a project state (which carries samples).
- **Rate budget** per socket per second (150 messages / 6 MB). Bursts are
  dropped, repeated bursts close the socket, because one burst is usually a
  laggy connection catching up.
- Refusals are sent back as `{type:'relay_refused', reason}` and the app turns
  them into real messages.
- `GET /health` returns room and client counts.

**Still not solved:** there is no identity. Anyone with a room code can join,
and the relay cannot tell one person from another, so a banned user can rejoin
under a new name. Fixing that properly needs accounts and signed room tokens,
which is a bigger piece of work than this file.
