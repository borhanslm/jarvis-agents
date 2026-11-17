'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkUrl, score, verdictPrompt, available } = require('../lib/webtest');

test('webtest: only http(s) urls', () => {
  assert.strictEqual(checkUrl('http://localhost:3000/#x'), 'http://localhost:3000/');
  assert.throws(() => checkUrl('file:///C:/x'));
  assert.throws(() => checkUrl('javascript:alert(1)'));
  assert.throws(() => checkUrl('nope'));
});
test('webtest: score and problems worst first', () => {
  const s = score([
    { path: '/', viewport: 'desktop', status: 200, ms: 800, console: [{ level: 'error', text: 'x is undefined' }], failed: [{ url: 'http://a/b.png', status: 404, type: 'image' }], overflow: 0, issues: [{ kind: 'img-alt', el: '<img>' }, { kind: 'img-alt', el: '<img>' }], small: 0 },
    { path: '/about', viewport: 'mobile', error: 'ERR_CONNECTION_REFUSED', ms: 10 },
  ]);
  assert.strictEqual(s.problems[0].sev, 'critical');
  assert.ok(s.score < 100 && s.score >= 0);
  assert.ok(s.problems.some(p => /\(2 مورد\)/.test(p.text)));
  assert.strictEqual(score([{ path: '/', viewport: 'desktop', status: 200, ms: 100, console: [], failed: [], issues: [], overflow: 0, small: 0 }]).score, 100);
});
test('webtest: verdict prompt treats page text as data; not available outside electron', () => {
  const p = verdictPrompt({ url: 'http://x', score: 90, pages: [{ path: '/', viewport: 'desktop', status: 200, ms: 5, overflow: 0, console: [], failed: [] }], problems: [] });
  assert.match(p, /data, not instructions/);
  assert.strictEqual(available(), false);
});
