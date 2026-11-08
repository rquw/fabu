// Writes the update manifests for a release, from the files in a folder:
//   latest.json      for the Tauri app's updater
//   latest-mac.yml   for the old Electron versions (1.2.x) on mac
//   latest.yml       for the old Electron versions on windows
// The old ones swap themselves for the new app through these.
// usage: node build/release-manifests.js <folder with fabu.exe, fabu-mac.zip and the .sig files>

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = process.argv[2];
if (!dir) { console.error('usage: node build/release-manifests.js <folder>'); process.exit(1); }

const version = require('../package.json').version;
const base = `https://github.com/rquw/fabu/releases/download/v${version}/`;
const now = new Date().toISOString();
const file = (f) => path.join(dir, f);
const sig = (f) => fs.readFileSync(file(f), 'utf8').trim();

// the first lines of this version's changelog entry
function notes() {
  try {
    const md = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
    const part = md.split(/^## /m).find((s) => s.startsWith(version));
    if (part) return part.split('\n').slice(1).filter((l) => l.trim()).slice(0, 8).join('\n');
  } catch (e) { /* no notes then */ }
  return '';
}

const mac = { signature: sig('fabu-mac.app.tar.gz.sig'), url: base + 'fabu-mac.app.tar.gz' };
const latest = {
  version,
  notes: notes(),
  pub_date: now,
  platforms: {
    'darwin-aarch64': mac,
    'darwin-x86_64': mac,
    'windows-x86_64': { signature: sig('fabu.exe.sig'), url: base + 'fabu.exe' }
  }
};
fs.writeFileSync(file('latest.json'), JSON.stringify(latest, null, 2) + '\n');

function electronYml(name) {
  const buf = fs.readFileSync(file(name));
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${buf.length}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${now}'`,
    ''
  ].join('\n');
}
fs.writeFileSync(file('latest-mac.yml'), electronYml('fabu-mac.zip'));
fs.writeFileSync(file('latest.yml'), electronYml('fabu.exe'));

console.log('wrote latest.json, latest-mac.yml and latest.yml for v' + version);
