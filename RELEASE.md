# releasing

```bash
# bump the version in package.json, rename ## Unreleased in CHANGELOG.md, then:
git commit -am "1.2.7"
git push origin main          # push commits BEFORE the tag or it lands on the wrong one
git tag v1.2.7
git push origin v1.2.7
```

The tag kicks off .github/workflows/release.yml which builds the mac dmg and
the windows exe and drops them into one draft release. Go to Releases and hit
publish. The website and the auto updater only look at published ones.

The web version is just `npm run build:web`, which copies the app into docs/.
Pages serves that. It has to be /docs, not root.

Installers are not signed because certificates cost money. Mac says
unidentified developer, windows SmartScreen moans about an unknown publisher.
The download page explains both.
