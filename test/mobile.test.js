// Mobile gateway: pairing, device tokens, allow-list, revoke.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Mobile } = require('../lib/mobile');

test('pair once with the code, then only allowed sections; revoke works', async () => {
  const seen = [];
  const m = new Mobile({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jv-mob-')), handleApi: (req, res, url) => { seen.push(url.pathname); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); } });
  const port = await m.start(0);
  const base = 'http://127.0.0.1:' + port;
  try {
    assert.strictEqual((await (await fetch(base + '/m/hello')).json()).jarvis, true);
    // no pairing started yet
    assert.strictEqual((await fetch(base + '/m/pair', { method: 'POST', body: JSON.stringify({ code: '12345678' }) })).status, 410);
    const p = m.startPairing();
    assert.match(p.code, /^\d{8}$/); assert.ok(JSON.parse(p.qr).c === p.code);
    assert.strictEqual((await fetch(base + '/m/pair', { method: 'POST', body: JSON.stringify({ code: '00000000' }) })).status, 403);
    const r = await (await fetch(base + '/m/pair', { method: 'POST', body: JSON.stringify({ code: p.code, name: 'Pixel', deviceCode: 'Q7MX-2KPA-VB4R' }) })).json();
    assert.ok(r.token && r.token.length > 30);
    // the code is single-use
    assert.strictEqual((await fetch(base + '/m/pair', { method: 'POST', body: JSON.stringify({ code: p.code }) })).status, 410);
    const H = { authorization: 'Bearer ' + r.token };
    assert.strictEqual((await fetch(base + '/m/api/tasks')).status, 401);
    assert.strictEqual((await fetch(base + '/m/api/tasks', { headers: H })).status, 200);
    assert.deepStrictEqual(seen, ['/api/tasks']);
    for (const blocked of ['settings', 'seller', 'seller/backup', 'seller/keys', 'seller/issue', 'backup', 'providers', 'notify']) assert.strictEqual((await fetch(base + '/m/api/' + blocked, { headers: H })).status, 403, blocked);
    assert.notStrictEqual((await fetch(base + '/m/api/seller/purchases', { headers: H })).status, 403, 'purchase requests are reachable');
    assert.strictEqual((await fetch(base + '/m/api/events?dt=' + r.token)).status, 200); // SSE uses a query token
    assert.ok(!JSON.stringify(m.list()).includes(r.token)); // only a hash is stored
    m.revoke(m.list()[0].id);
    assert.strictEqual((await fetch(base + '/m/api/tasks', { headers: H })).status, 401);
  } finally { m.stop(); }
});

test('too many wrong codes cancel the pairing', async () => {
  const m = new Mobile({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jv-mob-')), handleApi: () => {} });
  m.server = {}; // pretend it is listening
  const p = m.startPairing();
  for (let i = 0; i < 5; i++) assert.throws(() => m.pair({ code: '00000000' }), /اشتباه/);
  assert.throws(() => m.pair({ code: p.code }), /زیاد/);
});
