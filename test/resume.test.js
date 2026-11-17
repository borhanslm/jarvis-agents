'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Store } = require('../lib/store');

test('resume: a chat cut off mid-run comes back as interrupted with its request; one without a request is just stopped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-resume-'));
  let s = new Store(dir);
  const p = s.addProject ? s.addProject({ name: 'shop', path: dir }) : null;
  const a = s.newChat(p ? p.id : 'p', 'build shop'), b = s.newChat(p ? p.id : 'p', 'other');
  a.status = 'running'; a.activeRun = { text: 'build the cart page', mode: 'team', at: Date.now() };
  b.status = 'running';
  s.saveChat(a, true); s.saveChat(b, true); if (s.flush) s.flush();
  s = new Store(dir);
  assert.strictEqual(s.chat(a.id).status, 'interrupted');
  assert.strictEqual(s.chat(a.id).activeRun.text, 'build the cart page');
  assert.strictEqual(s.chat(b.id).status, 'stopped');
  assert.strictEqual(s.settings().autoResume, false, 'asks by default');
});
