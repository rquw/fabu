# Releasing fabu

Everything is wired for `github.com/rquw/fabu`. Here is the whole pipeline and
exactly what to click.

## 1. One-time setup

- The repo is public (needed for free GitHub Pages + it's open-source anyway).
- **Enable the website:** repo → Settings → Pages → Source: `Deploy from a
  branch`, Branch: `main`, folder: **`/docs`** → Save. This is already set. The
  folder **must** be `/docs`, not `/(root)` — with root, `https://rquw.github.io/fabu/`
  serves the app instead of the landing page and `/web` 404s. In a minute the
  site is live at **https://rquw.github.io/fabu/** (landing) and
  **https://rquw.github.io/fabu/web/** (the in-browser app).
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
- creates one **draft** release, then
- builds the **macOS universal .dmg** (Apple Silicon + Intel) on a Mac runner,
- builds the **Windows .exe installer** on a Windows runner,
- uploads both (plus the `latest*.yml` update files) into that same release.

You can also run it by hand: repo → Actions → "Release fabu" → Run workflow.

**Then publish it:** the release lands as a **draft** so nothing goes public
until you're ready. Go to repo → Releases, open the new `vX.Y.Z` draft (it
should have both `.dmg` and `.exe`), and click **Publish release**. The website
and auto-updater only see published releases. You can delete the old
`[MACOS] fabu v1.0` release once the combined one is live.

## 3. How downloads work

- The website fetches the latest release from the GitHub API and points the big
  button at the right file for the visitor's OS (`.dmg` for Mac, `.exe` for
  Windows), with the other OS as a secondary link.
- No servers of your own — GitHub hosts the files.

## 4. How updates work (from 1.0.7)

- On launch (packaged app only), fabu checks the GitHub Release for a newer
  version and shows an "Update available" banner.
- Clicking **Update** makes fabu download the full installer itself (with a
  percent counter), verify its sha512 against the release manifest, and only
  then apply it: Windows runs the one-click installer silently and relaunches;
  macOS swaps the .app bundle in place and relaunches. The installed app is
  never touched until a complete verified copy is on disk, so a failed
  download can't break anything (worst case it falls back to opening the
  download page).
- Background/silent auto-install stays OFF on purpose — the app is unsigned,
  and electron-updater's differential background updates kept failing halfway
  (and once removed the app).
- **To ship an update:** cut a new release with a higher version number.

## 5. Code signing (the "not a virus" part)

The installers are **not code-signed** (certificates cost money):

- **macOS:** first open shows "unidentified developer". Right-click the app →
  **Open** → Open. Only needed once. (A real fix is an Apple Developer account,
  $99/yr, then set `mac.identity` + notarization.)
- **Windows:** SmartScreen may warn ("unknown publisher"). Click **More info →
  Run anyway**. The custom icon still shows so it looks legit. (A real fix is a
  Windows code-signing certificate.)

The download page can mention these one-time steps so people aren't scared off.

## 6. The in-browser version

fabu also runs as a web app (no install) at **https://rquw.github.io/fabu/web/**.
It is a copy of the app under `docs/web/`, built with:

```bash
npm run build:web   # re-copies the app into docs/web
```

Run that whenever you change the app and want the online version updated, then
commit. The landing page links to it ("Play in your browser"), and on iPhone /
Android / Linux / anything without an installer it becomes the main button.

Browser limits: file save/open use normal download/upload, projects autosave to
the browser instead of a file, and there is no auto-update (they always get the
latest on refresh).

## 7. Crossplay

Already works — the multiplayer relay is plain WebSocket, so a Mac and a Windows
player can be in the same room with no extra work.
