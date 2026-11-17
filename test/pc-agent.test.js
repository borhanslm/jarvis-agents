'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runTask, sendKeys, parseMove, toScreen } = require('../lib/pc-agent');

test('pc agent: keys, JSON moves, coordinates', () => {
  assert.strictEqual(sendKeys('enter'), '{ENTER}');
  assert.strictEqual(sendKeys('ctrl+l'), '^l');
  assert.strictEqual(sendKeys('Ctrl+Shift+T'), '^+t');
  assert.strictEqual(sendKeys('alt+f4'), '%{F4}');
  assert.strictEqual(sendKeys('+'), '{+}');
  assert.throws(() => sendKeys('win+r'), /ویندوز/);
  assert.throws(() => sendKeys('ctrl+banana'), /نامعتبر/);
  assert.deepStrictEqual(parseMove('```json\n{"thought":"x","action":{"type":"done","say":"ok"}}\n```').action, { type: 'done', say: 'ok' });
  assert.strictEqual(parseMove('no json'), null);
  assert.deepStrictEqual(toScreen({ left: 1920, top: 0, scale: 0.5 }, 100, 50), [2120, 100]);
});

// a fake computer: records the PowerShell it is asked to run
function fakeHost({ moveMouseAt } = {}) {
  const ran = []; let obsN = 0;
  return { ran, run: async s => {
    ran.push(s);
    if (/CopyFromScreen/.test(s)) { obsN++; return { title: 'Spotify', left: 0, top: 0, width: 1920, height: 1080, scale: 0.5, w: 960, h: 540, cursor: obsN === moveMouseAt ? [5, 5] : [500, 500], els: [['Edit', 'Search', 400, 60], ['Button', 'Play Gol-haye Pooneh', 800, 400]] }; }
    if (/GetCursorPos/.test(s) && !/CopyFromScreen/.test(s)) return { cursor: [500, 500] };
    if (/MainWindowTitle/.test(s) && /First 25/.test(s)) return ['Spotify: Spotify'];
    return { ok: 1 };
  }, stop() {} };
}
const script = moves => { let i = 0; const seen = []; return { seen, llm: async o => { seen.push(o); const m = moves[Math.min(i++, moves.length - 1)]; return { text: JSON.stringify(m) }; } }; };

test('pc agent: plays a song by searching and clicking, with images', async () => {
  const host = fakeHost(), opened = [];
  const s = script([
    { thought: 'open', action: { type: 'open_app', name: 'Spotify' } },
    { thought: 'search', action: { type: 'type', element: 1, text: 'گل‌های پونه سیاوش قمیشی', enter: true } },
    { thought: 'play', action: { type: 'click', element: 2, double: true } },
    { thought: 'ok', action: { type: 'done', say: 'در حال پخش است.' } },
  ]);
  const r = await runTask('play Gol-haye Pooneh', { host, llm: s.llm, openApp: async n => opened.push(n), openUrl: async () => {}, pace: 0, readShot: () => 'AAAA', maxSteps: 10 });
  assert.strictEqual(r.status, 'done');
  assert.deepStrictEqual(opened, ['Spotify']);
  assert.ok(host.ran.some(x => /SetText\('گل‌های پونه سیاوش قمیشی'\)/.test(x)), 'typed through the clipboard');
  assert.ok(host.ran.some(x => /SetCursorPos\(800, 400\)/.test(x) && /\$i -lt 2/.test(x)), 'double-clicked the element at its real position');
  assert.ok(s.seen[0].messages[0].content.some(p => p.type === 'text' && /\[2\] Button "Play Gol-haye Pooneh" @400,200/.test(p.text)), 'element list in screenshot coordinates');
  assert.match(r.history.join('\n'), /typed .* \+ enter/);
});

test('pc agent: asks before risky moves, refuses card numbers, stops when the user moves the mouse, falls back without images', async () => {
  // a risky key needs approval
  let r = await runTask('close it', { host: fakeHost(), llm: script([{ action: { type: 'key', keys: 'alt+f4' } }]).llm, openApp: async () => {}, openUrl: async () => {}, pace: 0, readShot: () => 'AAAA' });
  assert.strictEqual(r.status, 'ask');
  // the model's own "ask" is passed on
  r = await runTask('send', { host: fakeHost(), llm: script([{ action: { type: 'ask', question: 'پیام به علی فرستاده شود؟' } }]).llm, openApp: async () => {}, openUrl: async () => {}, pace: 0, readShot: () => 'AAAA' });
  assert.deepStrictEqual([r.status, r.question], ['ask', 'پیام به علی فرستاده شود؟']);
  // card numbers are never typed
  const h = fakeHost();
  r = await runTask('pay', { host: h, llm: script([{ action: { type: 'type', text: '6037 9918 1234 5678' } }]).llm, openApp: async () => {}, openUrl: async () => {}, pace: 0, readShot: () => 'AAAA' });
  assert.strictEqual(r.status, 'ask'); assert.ok(!h.ran.some(x => /6037/.test(x)));
  // the user grabs the mouse on the 2nd look
  r = await runTask('x', { host: fakeHost({ moveMouseAt: 2 }), llm: script([{ action: { type: 'wait', seconds: 1 } }]).llm, openApp: async () => {}, openUrl: async () => {}, pace: 0, readShot: () => 'AAAA' });
  assert.strictEqual(r.status, 'stopped');
  // a model that cannot see images keeps going with the element list
  let calls = 0;
  r = await runTask('x', { host: fakeHost(), openApp: async () => {}, openUrl: async () => {}, pace: 0, readShot: () => 'AAAA', llm: async o => { calls++; if (Array.isArray(o.messages[0].content)) throw Object.assign(new Error('image input is not supported'), { image: true }); return { text: '{"action":{"type":"done","say":"ok"}}' }; } });
  assert.strictEqual(r.status, 'done'); assert.strictEqual(calls, 2);
  // the same move over and over ends it
  r = await runTask('x', { host: fakeHost(), llm: script([{ action: { type: 'key', keys: 'enter' } }]).llm, openApp: async () => {}, openUrl: async () => {}, pace: 0, readShot: () => 'AAAA', maxSteps: 10 });
  assert.strictEqual(r.status, 'fail');
});

test('chat: any model can act on the computer with an action block', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Talks, takeAction } = require('../lib/talks');
  assert.strictEqual(takeAction('hi'), null);
  assert.strictEqual(takeAction('x\n```jarvis-action\n{"type":"power","params":{"action":"shutdown"}}\n```'), null, 'power is not allowed from chat');
  const acted = []; let sys = '';
  const t = new Talks(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-talk-')), {
    chat: async o => { sys = o.system; const text = 'باشه، در اسپاتیفای پخش می‌کنم.\n```jarvis-action\n{"type":"pc_do","params":{"app":"Spotify","task":"play Gol-haye Pooneh by Siavash Ghomayshi"}}\n```'; o.onDelta(text); return { text }; },
    act: async a => { acted.push(a); return { ok: true, text: 'شروع شد' }; }, pcAllowed: () => true });
  const talk = t.create({ model: 'p:qwen:qwen-max' });
  const msg = await t.send(talk.id, { text: 'گل‌های پونه را پخش کن' });
  assert.match(sys, /jarvis-action/);
  assert.deepStrictEqual(acted[0], { type: 'pc_do', params: { app: 'Spotify', task: 'play Gol-haye Pooneh by Siavash Ghomayshi' } });
  assert.ok(!/jarvis-action/.test(msg.content)); assert.match(msg.content, /✓ شروع شد/);
  const t2 = new Talks(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-talk-')), { chat: async o => { sys = o.system; return { text: 'ok' }; }, act: async a => acted.push(a), pcAllowed: () => false });
  await t2.send(t2.create({ model: 'x' }).id, { text: 'hi' });
  assert.ok(!/jarvis-action/.test(sys)); assert.strictEqual(acted.length, 1);
  t.flush(); t2.flush();
});
