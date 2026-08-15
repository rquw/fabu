const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

const releases = [];
let cur = null;
for (const raw of md.split('\n')) {
  const line = raw.replace(/\s+$/, '');
  const head = line.match(/^##\s+(.+)$/);
  if (head) { cur = { version: head[1].trim(), items: [] }; releases.push(cur); continue; }
  if (!cur || !line.trim()) continue;
  if (/^#\s/.test(line)) continue;

  const bold = line.match(/^\*\*(.+?)\*\*\s*$/);
  if (bold) { cur.items.push({ title: bold[1].replace(/[.:]$/, ''), body: '' }); continue; }
  const bullet = line.match(/^[-*]\s+(.*)$/);
  if (bullet) { cur.items.push({ title: '', body: bullet[1] }); continue; }
  const last = cur.items[cur.items.length - 1];
  if (last && !last.body) last.body = line;
  else if (last) last.body += ' ' + line;
  else cur.items.push({ title: '', body: line });
}

const trimmed = releases.slice(0, 6).map(r => ({ version: r.version, items: r.items.slice(0, 12) }));

const out = `// generated from CHANGELOG.md, dont edit
const CHANGELOG = ${JSON.stringify(trimmed, null, 1)};
`;

const dest = path.join(root, 'js', 'changelog.js');
const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
if (prev !== out) {
  fs.writeFileSync(dest, out);
  console.log('js/changelog.js -> ' + trimmed.length + ' releases');
} else {
  console.log('js/changelog.js already current');
}
