# relay

The little websocket server rooms connect through.

Careful: Render does NOT deploy from this folder. It deploys from the separate
`rquw/fabu-relay` repo. Editing this file does nothing to production, you have
to copy server.js over there too.

Run it locally:

```bash
cd relay
npm install
PORT=8472 node server.js
```

`GET /health` gives back room and client counts.

Set `RELAY_SECRET` in Render, otherwise it makes up a new one every boot and
kicks stop sticking once the free tier goes to sleep.

It only lets a socket talk to the room it actually joined, room codes have to
look like `[A-Z0-9]{4,12}`, and there are caps on sockets per room, per IP,
message size and rate. Everything else (who the host is, what a note is) is the
app's problem, not the relay's.
