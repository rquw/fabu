# Releasing fabu

Everything is wired for `github.com/rquw/fabu`. Here is the whole pipeline and
exactly what to click.

## 1. One-time setup

- The repo is public (needed for free GitHub Pages + it's open-source anyway).
- **Enable the website:** repo → Settings → Pages → Source: `Deploy from a
  branch`, Branch: `main`, folder: `/docs` → Save. In a minute the site is live
  at **https://rquw.github.io/fabu/**.
- **Fix the relay** (multiplayer): the old Render service stopped forwarding
  messages. Redeploy `relay/server.js` (see `relay/README.md`). Until then,
  everything except live multiplayer works.

## 2. Cut a release

Releases are built by GitHub Actions and published to the Releases page. The
website and the in-app auto-updater both read from there.

```bash
# bump the version in package.json first (e.g. 1.0.0 -> 1.0.1), then:
git commit -am "release 1.0.1"
git tag v1.0.1
git push origin main --tags
```

Pushing the `v*` tag runs `.github/workflows/release.yml`, which:
- builds the **macOS universal .dmg** (Apple Silicon + Intel) on a Mac runner,
- builds the **Windows .exe installer** on a Windows runner,
- uploads both (plus the `latest*.yml` update files) to a GitHub Release.

You can also run it by hand: repo → Actions → "Release fabu" → Run workflow.

## 3. How downloads work

- The website fetches the latest release from the GitHub API and points the big
  button at the right file for the visitor's OS (`.dmg` for Mac, `.exe` for
  Windows), with the other OS as a secondary link.
- No servers of your own — GitHub hosts the files.

## 4. How auto-update works

- On launch (packaged app only), fabu checks the GitHub Release for a newer
  version, downloads it in the background, and shows a "Restart" banner.
- **To ship an update:** just cut a new release with a higher version number.
  Everyone gets it automatically the next time they open the app.

## 5. Code signing (the "not a virus" part)

The installers are **not code-signed** (certificates cost money):

- **macOS:** first open shows "unidentified developer". Right-click the app →
  **Open** → Open. Only needed once. (A real fix is an Apple Developer account,
  $99/yr, then set `mac.identity` + notarization.)
- **Windows:** SmartScreen may warn ("unknown publisher"). Click **More info →
  Run anyway**. The custom icon still shows so it looks legit. (A real fix is a
  Windows code-signing certificate.)

The download page can mention these one-time steps so people aren't scared off.

## 6. Crossplay

Already works — the multiplayer relay is plain WebSocket, so a Mac and a Windows
player can be in the same room with no extra work.
