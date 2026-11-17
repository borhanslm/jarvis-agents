// Command Center data and the voice brain's prompt (real numbers, real dates).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const system = require('../lib/system');
const { systemPrompt } = require('../lib/voice/brain');

test('system snapshot: real CPU / memory / disk numbers', () => {
  const s = system.snapshot();
  assert.ok(s.cpu.cores > 0);
  assert.ok(s.mem.total > s.mem.used && s.mem.used > 0);
  assert.ok(s.cpu.percent === null || (s.cpu.percent >= 0 && s.cpu.percent <= 100));
  if (s.disk) assert.ok(s.disk.total >= s.disk.used);
});

test('weather: no place -> nothing; unreachable -> an error, never made-up numbers', async () => {
  assert.strictEqual(await system.weather(null), null);
  const realFetch = global.fetch;
  global.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  try {
    const w = await system.weather({ name: 'X', lat: 1.234, lon: 5.678 });
    assert.ok(w.error); assert.strictEqual(w.now, undefined);
  } finally { global.fetch = realFetch; }
});

test('brain prompt: examples carry real dates (small offline models copy placeholders)', () => {
  const p = systemPrompt({ now: 'Sunday 15 November 2026 at 08:00', nowIso: '2026-11-15T08:00:00+03:30', projects: [], running: [], recent: [], tasks: [] });
  assert.match(p, /"due": "2026-11-16T10:00:00"/);
  assert.match(p, /"due": "2026-11-15T09:00:00"/);
  assert.doesNotMatch(p, /<tomorrow>/);
});
