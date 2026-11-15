// Telegram/Bale assistant against a fake Bot API server (no network).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Bot } = require('../lib/bot');

const OWNER = '1001';
function fakeApi() {
  const sent = []; let queue = []; const waiters = [];
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const m = /\/bot[^/]+\/(\w+)$/.exec(req.url);
      if (/\/file\/bot/.test(req.url)) return res.end(Buffer.from('OggS-fake-voice'));
      const method = m && m[1];
      let body = {}; try { body = JSON.parse(raw.toString() || '{}'); } catch { body = { multipart: raw.length, voice: /name="voice"/.test(raw.toString('latin1')) }; }
      const ok = result => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getUpdates') {
        if (body.offset === -1) return ok([{ update_id: 50, message: { chat: { id: +OWNER, type: 'private' }, text: 'old message' } }]);
        const give = () => { const q = queue; queue = []; ok(q); };
        if (queue.length || !body.timeout) return give();
        waiters.push(give); setTimeout(() => { const i = waiters.indexOf(give); if (i >= 0) { waiters.splice(i, 1); give(); } }, 300); return;
      }
      if (method === 'getMe') return ok({ username: 'jarvis_test_bot' });
      if (method === 'getFile') return ok({ file_path: 'voice/file_1.oga' });
      sent.push({ method, body });
      ok({ message_id: sent.length });
    });
  });
  const push = (...ups) => { queue.push(...ups); const w = waiters.shift(); if (w) w(); };
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, sent, push, base: 'http://127.0.0.1:' + srv.address().port })));
}

function makeBot(f, over = {}) {
  process.env.JARVIS_NOTIFY_BASE = f.base;
  delete require.cache[require.resolve('../lib/notify')];
  const notify = require('../lib/notify');
  const calls = { ask: [], confirm: [], heard: [] };
  const bot = new Bot({
    config: () => ({ enabled: true, channel: 'telegram', token: '123456:ABCDEFGHIJ', chatId: OWNER, voiceReply: 'auto' }),
    call: notify.call, fileUrl: notify.fileUrl,
    media: { toWav16k: async b => { calls.heard.push(b.toString()); return Buffer.from('WAV'); }, toOggOpus: async () => Buffer.from('OGG') },
    ask: async t => { calls.ask.push(t); return over.ask ? over.ask(t) : { say: 'باشه.', action: { type: 'add_task', params: {} }, result: { ok: true, task: { title: 'نان بخرم', due: null } }, confirm: false }; },
    confirm: async yes => { calls.confirm.push(yes); return { action: yes ? { type: 'run_team' } : null, result: yes ? { ok: true } : null }; },
    reset() {}, status: async () => 'وضعیت', tasks: async () => '📋 تسک‌ها', stopAll: async () => 2,
    transcribe: async () => ({ text: 'یادم بنداز نان بخرم' }), speak: async () => ({ wav: Buffer.from('RIFF') }),
  });
  return { bot, calls };
}
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };

test('bot: skips old messages, answers only the owner, describes the action', async () => {
  const f = await fakeApi();
  const { bot, calls } = makeBot(f);
  try {
    bot.start();
    await until(() => bot.state.connected);
    f.push({ update_id: 51, message: { chat: { id: 999, type: 'private' }, text: 'من غریبه‌ام' } });
    f.push({ update_id: 52, message: { chat: { id: +OWNER, type: 'private' }, text: 'فردا یادم بنداز نان بخرم' } });
    assert.ok(await until(() => f.sent.some(s => s.method === 'sendMessage')));
    assert.deepStrictEqual(calls.ask, ['فردا یادم بنداز نان بخرم']); // not the stranger, not the old message
    const msg = f.sent.find(s => s.method === 'sendMessage');
    assert.match(msg.body.text, /تسک اضافه شد: نان بخرم/);
    assert.strictEqual(String(msg.body.chat_id), OWNER);
  } finally { bot.stop(); f.srv.close(); }
});

test('bot: actions that change things ask with buttons; "yes" runs them once', async () => {
  const f = await fakeApi();
  const { bot, calls } = makeBot(f, { ask: () => ({ say: 'روی پروژه‌ی shop شروع کنم؟', action: { type: 'run_team' }, result: null, confirm: true }) });
  try {
    bot.start(); await until(() => bot.state.connected);
    f.push({ update_id: 60, message: { chat: { id: +OWNER, type: 'private' }, text: 'صفحه‌ی ورود shop را درست کن' } });
    assert.ok(await until(() => f.sent.some(s => s.body.reply_markup)));
    const q = f.sent.find(s => s.body.reply_markup);
    assert.strictEqual(q.body.reply_markup.inline_keyboard[0][0].callback_data, 'yes');
    f.push({ update_id: 61, callback_query: { id: 'cb1', data: 'yes', from: { id: +OWNER }, message: { message_id: 1, chat: { id: +OWNER } } } });
    assert.ok(await until(() => f.sent.some(s => /کار شروع شد/.test(s.body.text || ''))));
    assert.deepStrictEqual(calls.confirm, [true]);
    assert.ok(f.sent.some(s => s.method === 'editMessageReplyMarkup')); // buttons removed
  } finally { bot.stop(); f.srv.close(); }
});

test('bot: voice note -> download -> text -> answer as a voice note', async () => {
  const f = await fakeApi();
  const { bot, calls } = makeBot(f);
  try {
    bot.start(); await until(() => bot.state.connected);
    f.push({ update_id: 70, message: { chat: { id: +OWNER, type: 'private' }, voice: { file_id: 'v1', duration: 2, file_size: 900 } } });
    assert.ok(await until(() => f.sent.some(s => s.method === 'sendVoice')));
    assert.deepStrictEqual(calls.heard, ['OggS-fake-voice']);
    assert.deepStrictEqual(calls.ask, ['یادم بنداز نان بخرم']);
    assert.ok(f.sent.find(s => s.method === 'sendVoice').body.voice, 'voice uploaded as multipart');
    assert.ok(f.sent.some(s => /«یادم بنداز نان بخرم»/.test(s.body.text || ''))); // shows what it heard
  } finally { bot.stop(); f.srv.close(); }
});

test('bot: commands', async () => {
  const f = await fakeApi();
  const { bot } = makeBot(f);
  try {
    bot.start(); await until(() => bot.state.connected);
    f.push({ update_id: 80, message: { chat: { id: +OWNER, type: 'private' }, text: '/tasks' } });
    f.push({ update_id: 81, message: { chat: { id: +OWNER, type: 'private' }, text: '/stop' } });
    assert.ok(await until(() => f.sent.filter(s => s.method === 'sendMessage').length >= 2));
    const texts = f.sent.map(s => s.body.text).join('|');
    assert.match(texts, /📋 تسک‌ها/); assert.match(texts, /۲|2 کار متوقف شد/);
  } finally { bot.stop(); f.srv.close(); delete process.env.JARVIS_NOTIFY_BASE; }
});
