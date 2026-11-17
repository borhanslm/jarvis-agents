'use strict';
// The build regenerates public/icons.svg from design/icons/*.svg, so every icon the panel uses
// must have a source file there — otherwise it shows up blank in the installed app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
test('icons: every icon used by the panel has a source in design/icons', () => {
  const have = new Set(fs.readdirSync(path.join(root, 'design/icons')).filter(f => f.endsWith('.svg')).map(f => f.slice(0, -4)));
  const used = new Set();
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (/\.(js|html)$/.test(e.name)) { const s = fs.readFileSync(p, 'utf8'); for (const m of s.matchAll(/\bic\('([a-z0-9-]+)'|icon: '([a-z0-9-]+)'|icons\.svg#i-([a-z0-9-]+)/g)) used.add(m[1] || m[2] || m[3]); } } };
  walk(path.join(root, 'public'));
  const missing = [...used].filter(n => !have.has(n));
  assert.deepStrictEqual(missing, [], 'add these to design/icons: ' + missing.join(', '));
});
