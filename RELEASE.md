# releasing

```bash
# bump the version in package.json, rename ## Unreleased in CHANGELOG.md, then:
git commit -am "1.3.0"
git push origin main          # push commits BEFORE the tag or it lands on the wrong one
git tag v1.3.0
git push origin v1.3.0
```

The tag kicks off .github/workflows/release.yml which builds the mac dmg and
the windows exe with Tauri and drops them into one draft release, together with
the update files (latest.json for the app, latest.yml and latest-mac.yml so
people still on the old Electron 1.2.x versions get moved over). Go to Releases
and hit publish. The website and the updater only look at published ones.

Updates are signed. The private key lives in ~/.tauri/fabu.key and in the repo
secret TAURI_SIGNING_PRIVATE_KEY. Lose it and the app can't update itself
anymore, so keep a copy somewhere safe.

Running it locally: `npm start` (needs Rust, `brew install rustup`).
`npm run dist` builds the installer for the machine you're on.

The web version is just `npm run build:web`, which copies the app into docs/.
Pages serves that. It has to be /docs, not root.

Installers are not signed because certificates cost money. Mac says
unidentified developer, windows SmartScreen moans about an unknown publisher.
The download page explains both.
