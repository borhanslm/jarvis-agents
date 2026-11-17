// Gemini free through Google's Antigravity CLI (lib/agy.js) with a fake `agy` program — no real install or sign-in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');

const fake = path.join(os.tmpdir(), 'jarvis-fake-agy.js');
fs.writeFileSync(fake, `
const a = process.argv.slice(2), p = a[a.indexOf('-p') + 1] || '';
if (process.env.FAKE_AGY === 'auth') { process.stderr.write('Error: authentication required. Run agy to sign in.'); process.exit(1); }
if (process.env.FAKE_AGY === 'quota') { process.stderr.write('Error: weekly quota exhausted'); process.exit(1); }
if (a[a.indexOf('--output-format') + 1] !== 'text') process.exit(3);
const m = a.includes('--model') ? a[a.indexOf('--model') + 1] : '';
process.stdout.write('سلام از Gemini' + (m ? ' [' + m + ']' : '') + (p.includes('plain chat') && p.includes('جارویس') ? ' ✓' : ''));
`);

test('Gemini free (Antigravity): plain answer, model choice, sign-in and quota errors are clear', async () => {
  process.env.JARVIS_AGY_BIN = fake;
  delete require.cache[require.resolve('../lib/agy')];
  const agy = require('../lib/agy');
  assert.ok(agy.agyCli(true));
  const r = await agy.chat({ messages: [{ role: 'user', content: 'سلام' }], system: 'تو جارویس هستی' });
  assert.equal(r.text, 'سلام از Gemini ✓');
  assert.match((await agy.chat({ messages: [{ role: 'user', content: 'x' }], model: 'gemini-3.8-flash-medium' })).text, /gemini-3\.8-flash-medium/);
  process.env.FAKE_AGY = 'auth';
  await assert.rejects(agy.chat({ messages: [{ role: 'user', content: 'x' }] }), e => e.needLogin && /Google/.test(e.message));
  process.env.FAKE_AGY = 'quota';
  await assert.rejects(agy.chat({ messages: [{ role: 'user', content: 'x' }] }), e => e.busy && /سهمیه/.test(e.message));
  delete process.env.FAKE_AGY;
  const llm = require('../lib/llm');
  assert.equal((await llm.chat({ spec: 'agy', messages: [{ role: 'user', content: 'سلام' }], system: 'تو جارویس هستی' })).text, 'سلام از Gemini ✓');
  delete process.env.JARVIS_AGY_BIN;
});
