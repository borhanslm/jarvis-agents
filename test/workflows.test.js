// Workflow engine: steps, branches, waiting for the user, pause/stop, templates, validation.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Workflows, TEMPLATES, validate, autoLayout, fromDescription } = require('../lib/workflows');

function make(over = {}) {
  const log = { chat: [], team: [], tasks: [], notify: [], ask: [] };
  const wf = new Workflows(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-wf-')), {
    chat: async o => { log.chat.push(o.messages[0].content); return { text: over.reply ? over.reply(o) : 'نقشه: مرحله ۱' }; },
    runTeam: async o => { log.team.push(o); return { ok: true, status: 'done', report: 'وضعیت: done' }; },
    addTask: b => { log.tasks.push(b); return { title: b.title }; },
    notify: async t => { log.notify.push(t); },
    ask: async (run, p) => { log.ask.push(p); },
    defaultModel: () => 'claude-haiku-5-5',
  });
  return { wf, log };
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 10)); } return false; };

test('validate: exactly one start, unknown types refused, bad edges dropped', () => {
  assert.throws(() => validate({ nodes: [{ id: 'a', type: 'llm' }] }), /شروع/);
  assert.throws(() => validate({ nodes: [{ id: 's', type: 'start' }, { id: 'x', type: 'shell' }] }), /نامعتبر/);
  const g = validate({ nodes: [{ id: 's', type: 'start' }, { id: 'e', type: 'end' }], edges: [{ from: 's', to: 'e' }, { from: 's', to: 'zz' }, { from: 'e', to: 'e' }] });
  assert.strictEqual(g.edges.length, 1); assert.strictEqual(g.edges[0].port, 'next');
});

test('approval template: plan -> wait for me -> yes -> agent team -> phone', async () => {
  const { wf, log } = make();
  const w = wf.save(TEMPLATES[1]);
  const r = wf.start(w.id, 'صفحه‌ی ورود با کد پیامکی');
  assert.ok(await until(() => r.status === 'waiting'));
  assert.match(log.ask[0].question, /نقشه: مرحله ۱/);          // {{last}} filled in
  wf.answer(r.id, true);
  assert.ok(await until(() => r.status === 'done'));
  assert.match(log.team[0].task, /صفحه‌ی ورود با کد پیامکی[\s\S]*نقشه: مرحله ۱/); // {{input}} + {{n.p}}
  assert.match(log.notify[0], /کار تمام شد/);
  assert.deepStrictEqual(r.steps.filter(s => s.status === 'done').map(s => s.type), ['start', 'llm', 'approve', 'agent', 'notify', 'end']);
});

test('approval "no" takes the other branch; nothing is built', async () => {
  const { wf, log } = make();
  const r = wf.start(wf.save(TEMPLATES[1]).id, 'x');
  await until(() => r.status === 'waiting');
  wf.answer(r.id, false);
  assert.ok(await until(() => r.status === 'done'));
  assert.strictEqual(log.team.length, 0);
  assert.match(log.notify[0], /تأیید نشد/);
});

test('ask me -> my answer flows into the next steps; condition branches', async () => {
  const { wf, log } = make({ reply: o => /YES or NO/.test(o.messages[0].content) ? 'YES' : 'گزارش' });
  const w = wf.save({ name: 't', nodes: [{ id: 's', type: 'start' }, { id: 'q', type: 'ask', config: { question: 'موضوع؟' } },
    { id: 'c', type: 'condition', config: { value: '{{last}}', op: 'contains', arg: 'بیمه' } },
    { id: 'y', type: 'task', config: { title: 'تمدید {{n.q}}' } }, { id: 'n', type: 'notify', config: { text: 'نه' } }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'q' }, { from: 'q', to: 'c' }, { from: 'c', to: 'y', port: 'yes' }, { from: 'c', to: 'n', port: 'no' }, { from: 'y', to: 'e' }, { from: 'n', to: 'e' }] });
  const r = wf.start(w.id);
  await until(() => r.status === 'waiting');
  wf.answer(r.id, 'بیمه‌ی ماشین');
  assert.ok(await until(() => r.status === 'done'));
  assert.deepStrictEqual(log.tasks.map(t => t.title), ['تمدید بیمه‌ی ماشین']);
  assert.strictEqual(log.notify.length, 0);
});

test('endless loops stop; stop() ends a waiting run', async () => {
  const { wf } = make();
  const loop = wf.save({ name: 'loop', nodes: [{ id: 's', type: 'start' }, { id: 'a', type: 'delay', config: { minutes: 0 } }, { id: 'b', type: 'delay', config: { minutes: 0 } }],
    edges: [{ from: 's', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
  const r = wf.start(loop.id);
  assert.ok(await until(() => r.status === 'error'));
  assert.match(r.error, /حلقه/);
  const r2 = wf.start(wf.save(TEMPLATES[2]).id);
  await until(() => r2.status === 'waiting');
  wf.stop(r2.id);
  assert.strictEqual(r2.status, 'stopped');
  assert.throws(() => wf.answer(r2.id, 'x'), /منتظر/);
});

test('daily schedule starts once a day', () => {
  const { wf } = make();
  const w = wf.save(TEMPLATES[0]);
  const at = new Date('2026-11-15T08:00:10');
  wf.tick(at); wf.tick(at);
  assert.strictEqual(wf.runsOf(w.id).length, 1);
});

test('from a description: the model JSON becomes a laid-out, valid workflow', async () => {
  const chat = async () => ({ text: JSON.stringify({ name: 'خبر روزانه', nodes: [{ id: 's', type: 'start' }, { id: 'h', type: 'http', config: { url: 'https://example.com' } }, { id: 'l', type: 'llm', config: { prompt: 'خلاصه کن: {{last}}' } }, { id: 'n', type: 'notify' }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'h' }, { from: 'h', to: 'l' }, { from: 'l', to: 'n' }, { from: 'n', to: 'e' }], schedule: '07:30' }) });
  const w = await fromDescription(chat, 'x', 'هر روز ساعت ۷:۳۰ خبرهای سایت را خلاصه کن و بفرست');
  assert.strictEqual(w.nodes.length, 5); assert.strictEqual(w.schedule, '07:30');
  assert.ok(w.nodes.find(n => n.id === 'l').x > w.nodes.find(n => n.id === 'h').x);
});
