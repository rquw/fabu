const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const out = `// generated from package.json, dont edit
const APP_VERSION = ${JSON.stringify(version)};
`;

const dest = path.join(root, 'js', 'version.js');
const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
if (prev !== out) {
  fs.writeFileSync(dest, out);
  console.log('js/version.js -> ' + version);
} else {
  console.log('js/version.js already ' + version);
}
