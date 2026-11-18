'use strict';
// Every program JARVIS starts must run hidden on Windows (windowsHide), or a console window
// flashes up — e.g. «where», «taskkill» at startup.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
test('every spawn / execFile / execFileSync / spawnSync passes windowsHide', () => {
  const bad = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!['node_modules', 'public', 'test', 'dist', 'dist-test', '.git', 'graphify-out', 'design', 'club'].includes(e.name)) walk(p); } else if (/\.c?js$/.test(e.name)) {
    const s = fs.readFileSync(p, 'utf8'), re = /\b(spawnSync|execFileSync|execSync|spawn|execFile)\s*\(/g; let m;
    while ((m = re.exec(s))) {
      if (/function\s+$|\.\s*$/.test(s.slice(Math.max(0, m.index - 10), m.index)) && !/child_process\.\s*$|cp\.\s*$/.test(s.slice(Math.max(0, m.index - 20), m.index))) continue;
      let depth = 0, end = m.index; for (let i = s.indexOf('(', m.index); i < s.length; i++) { if (s[i] === '(') depth++; else if (s[i] === ')' && !--depth) { end = i; break; } }
      const call = s.slice(m.index, end);
      if (!/windowsHide|\.\.\.\w*[oO]pt|, opts\b|, o\)/.test(call) && !/['"]darwin['"]|xdg-open/.test(s.slice(Math.max(0, m.index - 80), m.index))) bad.push(`${path.relative(root, p)}:${s.slice(0, m.index).split('\n').length}`);
    } } } };
  walk(root);
  assert.deepStrictEqual(bad, []);
});
