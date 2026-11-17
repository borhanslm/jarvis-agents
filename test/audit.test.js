'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Audit, summarize, allowed, permFor } = require('../lib/audit');

test('audit: records actions without secrets, filters, exports CSV', () => {
  const a = new Audit(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-audit-')));
  assert.strictEqual(summarize({ to: 'a@b.com', password: 'hunter2', api_key: 'sk-1', keys: 'ctrl+n', text: 'x'.repeat(400) }).includes('hunter2'), false);
  assert.match(summarize({ keys: 'ctrl+n' }), /keys=ctrl\+n/);
  a.log('voice', 'open_app', { name: 'Spotify' });
  a.log('chat', 'send_email', { to: 'ali@x.com', subject: 'hi', pass: 'secret!' });
  a.log('agent', 'pc_click', { element: 3 }, { ok: false, error: 'no element' });
  const all = a.list();
  assert.deepStrictEqual(all.map(e => e.action), ['pc_click', 'send_email', 'open_app'], 'newest first');
  assert.ok(!JSON.stringify(all).includes('secret!'));
  assert.deepStrictEqual(a.list({ who: 'chat' }).map(e => e.action), ['send_email']);
  assert.deepStrictEqual(a.list({ failed: true }).map(e => e.action), ['pc_click']);
  assert.deepStrictEqual(a.list({ q: 'spotify' }).map(e => e.action), ['open_app']);
  const csv = a.csv({});
  assert.match(csv, /^\ufefftime,who,action,detail,ok,error/); assert.match(csv, /"no element"/);
  assert.strictEqual(a.months().length, 1);
});

test('permissions: each action needs its switch; unknown actions are allowed', () => {
  const s = { permMail: false, pcControl: false, permPhone: false };
  assert.strictEqual(allowed(s, 'send_email'), false);
  assert.strictEqual(allowed(s, 'pc_do'), false);
  assert.strictEqual(allowed(s, 'phone_sms_send'), false);
  assert.strictEqual(allowed(s, 'open_app'), true);
  assert.strictEqual(allowed({}, 'power'), true);
  assert.strictEqual(permFor('add_task'), null);
});
