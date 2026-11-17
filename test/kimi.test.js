// Kimi through the Kimi Code CLI (lib/kimi.js) with a fake `kimi` program — no real install or sign-in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');

const fake = path.join(os.tmpdir(), 'jarvis-fake-kimi.js');
fs.writeFileSync(fake, `
const a = process.argv.slice(2), p = a[a.indexOf('-p') + 1] || '';
if (process.env.FAKE_KIMI === 'nologin') { process.stderr.write('Error: not logged in. Run kimi login'); process.exit(1); }
if (!a.includes('--output-format') || a[a.indexOf('--output-format') + 1] !== 'text') process.exit(3);
const m = a.includes('-m') ? a[a.indexOf('-m') + 1] : '';
process.stdout.write('سلام از کیمی' + (m ? ' [' + m + ']' : '') + (p.includes('plain chat') && p.includes('جارویس هستی') ? ' ✓' : ''));
`);

test('Kimi: plain answer through the CLI; model choice; sign-in error is clear', async () => {
  process.env.JARVIS_KIMI_BIN = fake;
  delete require.cache[require.resolve('../lib/kimi')];
  const kimi = require('../lib/kimi');
  assert.ok(kimi.kimiCli(true));
  let streamed = '';
  const r = await kimi.chat({ messages: [{ role: 'user', content: 'سلام' }], system: 'تو جارویس هستی', onDelta: d => { streamed += d; } });
  assert.equal(r.text, 'سلام از کیمی ✓'); assert.equal(streamed, r.text);
  assert.match((await kimi.chat({ messages: [{ role: 'user', content: 'x' }], model: 'kimi-k3' })).text, /\[kimi-k3\]/);
  process.env.FAKE_KIMI = 'nologin';
  await assert.rejects(kimi.chat({ messages: [{ role: 'user', content: 'x' }] }), /وارد حساب Kimi/);
  delete process.env.FAKE_KIMI;
  // Kimi's real answer when the account has no Kimi Code plan
  const e = kimi.explain('kimi version 2.5.3\nerror: failed to run prompt: provider.auth_error: Your current subscription does not have access to Kimi Code right now. Upgrade your plan', 1);
  assert.equal(e.subscription, true); assert.match(e.message, /اشتراک/); assert.match(e.raw, /subscription/);
  // through lib/llm.js like any other model
  const llm = require('../lib/llm');
  const out = await llm.chat({ spec: 'kimi', messages: [{ role: 'user', content: 'سلام' }], system: 'تو جارویس هستی' });
  assert.equal(out.text, 'سلام از کیمی ✓');
  delete process.env.JARVIS_KIMI_BIN;
});
