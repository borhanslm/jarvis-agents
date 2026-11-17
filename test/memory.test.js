// JARVIS remembers: "remember X" is kept, related memories and all preferences reach the brain,
// learning mode picks facts up by itself, and secrets are never kept.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { Memory, parseExtract, SENSITIVE } = require('../lib/memory');

test('memory: add, near-duplicates update, recall related + preferences, forget', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem-'));
  const m = new Memory(d);
  m.add({ text: 'همسر کاربر سارا است', kind: 'person' });
  m.add({ text: 'کاربر جواب‌های کوتاه دوست دارد', kind: 'preference' });
  m.add({ text: 'تولد سارا ۱۲ تیر است', kind: 'fact' });
  m.add({ text: 'دفتر کاربر در خیابان ولیعصر است', kind: 'place' });
  assert.ok(m.add({ text: 'همسر کاربر سارا است', kind: 'person' }).updated, 'no duplicate');
  assert.equal(m.all().length, 4);
  const r = m.recall('تولد سارا کیه؟').map(x => x.text);
  assert.ok(r.includes('تولد سارا ۱۲ تیر است')); assert.ok(r.includes('کاربر جواب‌های کوتاه دوست دارد'), 'preferences always');
  assert.ok(!r.includes('دفتر کاربر در خیابان ولیعصر است'), 'unrelated places stay out');
  assert.equal(new Memory(d).all().length, 4, 'kept on disk');
  assert.equal(m.forget('تولد سارا').length, 1); assert.equal(m.all().length, 3);
  assert.deepEqual(parseExtract('[{"text":"کاربر در تهران زندگی می‌کند","kind":"place"},{"text":"x"}]'), [{ text: 'کاربر در تهران زندگی می‌کند', kind: 'place' }]);
  assert.ok(SENSITIVE.test('رمز ایمیلم 1234 است')); assert.ok(!SENSITIVE.test('اسم همسرم ساراست'));
});

test('server: "remember" by voice, recalled next time, learning mode adds facts by itself', { timeout: 40000 }, async () => {
  const prompts = [];
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      const j = JSON.parse(b || '{}'); const sys = j.messages[0].content, said = j.messages[j.messages.length - 1].content;
      prompts.push({ sys, said });
      let text;
      if (/long-lasting personal facts/.test(sys)) text = /سگ/.test(said) ? '[{"text":"کاربر یک سگ به اسم رکس دارد","kind":"fact"}]' : '[]';
      else if (/یادت باشه/.test(said)) text = '{"say":"باشه، یادم می‌ماند.","action":{"type":"remember","params":{"text":"همسر کاربر سارا است","kind":"person"}}}';
      else text = '{"say":"باشه.","action":null}';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  const fp = await new Promise(r => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memsrv-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, JARVIS_PORT: '0', JARVIS_DATA: data, JARVIS_CLUB_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error(out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/localhost:(\d+)\//); if (m) { clearTimeout(t); res(+m[1]); } }); });
    const call = (p, body, method) => fetch(`http://127.0.0.1:${port}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-jarvis': '1' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
    const pv = await call('/providers', { name: 'Fake', kind: 'openai', baseUrl: `http://127.0.0.1:${fp}/v1`, models: 'brain-1', apiKey: 'good' });
    await call('/settings', { voiceModel: `p:${pv.id}:brain-1`, voiceMode: 'online' });
    const r = await call('/voice/ask', { text: 'یادت باشه اسم همسرم ساراست' });
    assert.equal(r.result.memory.text, 'همسر کاربر سارا است');
    await call('/voice/ask', { text: 'سارا امروز خونه‌ست؟' });
    assert.match(prompts.filter(p => !/long-lasting/.test(p.sys)).pop().sys, /What you remember about the user[\s\S]*\[person\] همسر کاربر سارا است/);
    // learning mode: a fact in normal talk is picked up by itself
    await call('/voice/ask', { text: 'امروز سگم رکس را بردم پارک، خیلی خوش گذشت' });
    let items = [];
    for (let i = 0; i < 40; i++) { items = (await call('/memory')).items; if (items.some(m => /رکس/.test(m.text))) break; await new Promise(r => setTimeout(r, 100)); }
    const rex = items.find(m => /رکس/.test(m.text));
    assert.ok(rex && rex.source === 'learned');
    // secrets never go to the learner
    const before = prompts.filter(p => /long-lasting/.test(p.sys)).length;
    await call('/voice/ask', { text: 'رمز وای‌فای خانه 88776655 است' });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(prompts.filter(p => /long-lasting/.test(p.sys)).length, before);
    // learning mode off: nothing is extracted
    await call('/settings', { memoryLearn: false });
    await call('/voice/ask', { text: 'من هر روز صبح ساعت شش ورزش می‌کنم' });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(prompts.filter(p => /long-lasting/.test(p.sys)).length, before);
    // forget from the settings
    await call('/memory/' + rex.id, null, 'DELETE');
    assert.ok(!(await call('/memory')).items.some(m => /رکس/.test(m.text)));
  } finally { child.kill(); fake.close(); }
});
