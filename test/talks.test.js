// Plain chat: conversations, streaming, stop, regenerate, offline switch.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Talks } = require('../lib/talks');

function make(reply = 'سلام!') {
  const ev = [];
  const calls = [];
  const t = new Talks(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-talk-')), {
    onEvent: e => ev.push(e),
    chat: async o => { calls.push(o); for (const ch of reply) { if (o.signal.aborted) throw Object.assign(new Error('stopped'), { aborted: true }); o.onDelta(ch); await new Promise(r => setTimeout(r, 2)); } return { text: reply, usage: { input: 1, output: 1 } }; },
  });
  return { t, ev, calls };
}

test('talks: send streams the answer, titles the talk, keeps history', async () => {
  const { t, ev, calls } = make('Hello there');
  const c = t.create({ model: 'claude-haiku-5-5' });
  const m = await t.send(c.id, { text: 'سلام جارویس' });
  assert.strictEqual(m.content, 'Hello there');
  assert.strictEqual(t.get(c.id).title, 'سلام جارویس');
  assert.ok(ev.some(e => e.type === 'talkDelta'));
  assert.ok(ev.some(e => e.type === 'talkDone'));
  await t.send(c.id, { text: 'دوباره' });
  assert.deepStrictEqual(calls[1].messages.map(x => x.role), ['user', 'assistant', 'user']);
});

test('talks: regenerate replaces the last answer; stop keeps what was written', async () => {
  const { t } = make('abcdefghijklmnopqrstuvwxyz');
  const c = t.create({ model: 'x' });
  await t.send(c.id, { text: 'q' });
  await t.send(c.id, { regenerate: true });
  assert.strictEqual(t.get(c.id).messages.length, 2);
  const p = t.send(c.id, { text: 'q2' });
  await new Promise(r => setTimeout(r, 15)); t.stop(c.id);
  const m = await p;
  assert.ok(m.stopped); assert.ok(m.content.length > 0 && m.content.length < 26);
});

test('talks: the offline switch (resolveSpec) is used and recorded', async () => {
  const { t, calls } = make('ok');
  const c = t.create({ model: 'claude-sonnet-5-5' });
  const m = await t.send(c.id, { text: 'hi', resolveSpec: async () => 'ollama:gemma3:4b' });
  assert.strictEqual(calls[0].spec, 'ollama:gemma3:4b');
  assert.strictEqual(m.via, 'ollama:gemma3:4b');
  assert.strictEqual(m.model, 'claude-sonnet-5-5');
});

test('talks: search and markdown export', async () => {
  const { t } = make('پاریس');
  const c = t.create({ model: 'x' });
  await t.send(c.id, { text: 'پایتخت فرانسه؟' });
  assert.strictEqual(t.search('پاریس').length, 1);
  assert.match(t.markdown(c.id), /پایتخت فرانسه/);
});
