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
