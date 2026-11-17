// JARVIS can reach every section by voice: tomorrow's tasks, the bell, phone SMS, purchase requests.
// Private lists (SMS, notifications, purchases) reach the model only when the request is about them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { Brain, systemPrompt } = require('../lib/voice/brain');

test('brain: purchase approval is admin-only in the prompt and always waits for a yes', async () => {
  const base = { now: 'x', projects: [], running: [], recent: [], tasks: [] };
  assert.doesNotMatch(systemPrompt(base), /approve_purchase/);
  const ctx = { ...base, admin: true, purchases: [{ id: 'pq1', name: 'Sara', amount: '۵۰۰٬۰۰۰', ref: '7788', ago: '5 min ago' }] };
  const sp = systemPrompt(ctx);
  assert.match(sp, /approve_purchase/); assert.match(sp, /\[pq1\] Sara, ۵۰۰٬۰۰۰, tracking 7788/);
  const b = new Brain({ chat: async () => ({ text: '{"say":"خرید سارا را تأیید کنم؟","action":{"type":"approve_purchase","params":{"id":"pq1"}}}' }), context: async () => ctx });
  const r = await b.handle('خرید سارا را تایید کن');
  assert.equal(r.confirm, true, 'needs a yes');
  const yes = await b.handle('بله');
  assert.deepEqual(yes.action, { type: 'approve_purchase', params: { id: 'pq1' } });
});

test('server: tasks for tomorrow always; SMS and the bell only when asked about messages', { timeout: 40000 }, async () => {
  const prompts = [];
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      const j = JSON.parse(b || '{}'); prompts.push(j.messages[0].content);
      const said = j.messages[j.messages.length - 1].content;
      const text = /اعلان|پیامک/.test(said) ? '{"say":"یک پیامک از رضا دارید.","action":{"type":"mark_read","params":{}}}' : '{"say":"باشه.","action":null}';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  const fp = await new Promise(r => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-access-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, JARVIS_PORT: '0', JARVIS_DATA: data, JARVIS_CLUB_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error(out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/localhost:(\d+)\//); if (m) { clearTimeout(t); res(+m[1]); } }); });
    const call = (p, body) => fetch(`http://127.0.0.1:${port}/api${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-jarvis': '1' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
    const pv = await call('/providers', { name: 'Fake', kind: 'openai', baseUrl: `http://127.0.0.1:${fp}/v1`, models: 'brain-1', apiKey: 'good' });
    await call('/settings', { voiceModel: `p:${pv.id}:brain-1`, voiceMode: 'online' });
    const tom = new Date(); tom.setDate(tom.getDate() + 1); tom.setHours(10, 0, 0, 0);
    await call('/tasks', { title: 'جلسه با تیم فروش', due: tom.toISOString() });
    // a phone with one SMS and a bell notice
    let st = await call('/mobile/enable', { on: true });
    for (let i = 0; i < 20 && !st.on; i++) { await new Promise(r => setTimeout(r, 200)); st = await call('/mobile/status'); }
    const pair = await call('/mobile/pair', {});
    const g = `http://127.0.0.1:${pair.port}`;
    const { token } = await fetch(g + '/m/pair', { method: 'POST', body: JSON.stringify({ code: pair.code }) }).then(r => r.json());
    const phone = (p, body) => fetch(g + '/m/api' + p, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
    const T = Date.now();
    const job = (await phone('/voice/phone-tasks')).tasks.find(t => t.action.params.what === 'sms');
    await phone('/voice/phone-result', { id: job.id, ok: true, data: { sms: [{ from: 'Reza', body: 'کد ورود شما 5521 است', date: T - 1000 }] } });
    await call('/voice/phone-sync', {});
    const job2 = (await phone('/voice/phone-tasks')).tasks.find(t => t.action.params.what === 'sms');
    await phone('/voice/phone-result', { id: job2.id, ok: true, data: { sms: [{ from: 'Sara', body: 'سلام، فردا میای؟', date: T }, { from: 'Reza', body: 'کد ورود شما 5521 است', date: T - 1000 }] } });
    assert.equal((await call('/notices')).unread, 1);

    await call('/voice/ask', { text: 'سلام، حالت چطوره' });
    let sp = prompts[prompts.length - 1];
    assert.match(sp, /Upcoming tasks \(next 7 days\): \[[^\]]+\] جلسه با تیم فروش/, 'tomorrow is in the context');
    assert.doesNotMatch(sp, /5521|Sara|Unread JARVIS notifications/, 'no SMS or bell for small talk');

    const r = await call('/voice/ask', { text: 'پیامک جدید دارم؟ اعلان‌ها را بخوان' });
    sp = prompts[prompts.length - 1];
    assert.match(sp, /from Sara \(just now\): سلام، فردا میای؟/);
    assert.match(sp, /Unread JARVIS notifications: \[sms\] پیامک از Sara/);
    assert.equal(r.action.type, 'mark_read'); assert.equal(r.result.ok, true);
    assert.equal((await call('/notices')).unread, 0, 'read after JARVIS told them');
    assert.doesNotMatch(sp, /Pending purchase requests/, 'no club account here, so no sales list');
  } finally { child.kill(); fake.close(); }
});
