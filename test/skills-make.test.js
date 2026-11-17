// Phase 8: skills — write one with AI, upload SKILL.md / .zip (preview first), teach a routine by voice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execFileSync } = require('child_process');

test('server: draft with AI, upload md and zip with a preview, teach a routine by voice', { timeout: 60000 }, async () => {
  const prompts = [];
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      const j = JSON.parse(b || '{}'); const sys = j.messages[0].content, said = j.messages[j.messages.length - 1].content;
      prompts.push({ sys, said });
      let text = '{"say":"باشه.","action":null}';
      if (/Agent Skills/.test(sys)) text = '{"name":"Release Checklist!","description":"Use before every release.","body":"## Steps\\n1. run tests\\n2. bump version"}';
      else if (/long-lasting personal facts/.test(sys)) text = '[]';
      else if (/یاد بگیر/.test(said)) text = '{"say":"یاد می‌گیرم: تسک‌های امروز، بعد پیامک‌های تازه. ذخیره کنم؟","action":{"type":"teach_skill","params":{"name":"daily-report","when":"گزارش روزانه","steps":["تسک‌های امروز را بگو","پیامک‌های تازه را بگو"]}}}';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  const fp = await new Promise(r => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skmk-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, JARVIS_PORT: '0', JARVIS_DATA: data, JARVIS_CLUB_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error(out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/localhost:(\d+)\//); if (m) { clearTimeout(t); res(+m[1]); } }); });
    const call = (p, body) => fetch(`http://127.0.0.1:${port}/api${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-jarvis': '1' }, body: body ? JSON.stringify(body) : undefined }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
    const pv = await call('/providers', { name: 'Fake', kind: 'openai', baseUrl: `http://127.0.0.1:${fp}/v1`, models: 'brain-1', apiKey: 'good' });
    await call('/settings', { voiceModel: `p:${pv.id}:brain-1`, voiceMode: 'online', memoryLearn: false });

    // 1) draft with AI: shown, not saved
    const d = await call('/skills/draft', { idea: 'قبل از هر انتشار تست‌ها را اجرا کن و نسخه را بالا ببر' });
    assert.equal(d.name, 'release-checklist'); assert.match(d.body, /run tests/);
    assert.equal((await call('/skills')).length, 0, 'nothing saved before the user saves');

    // 2) upload a single SKILL.md
    const md = '---\nname: polite-email\ndescription: Write polite Persian emails\n---\n\n## Steps\n1. greet\n';
    const p1 = await call('/skills/upload', { fileName: 'SKILL.md', data: Buffer.from(md).toString('base64') });
    assert.equal(p1.name, 'polite-email'); assert.deepEqual(p1.runnable, []);
    assert.equal((await call('/skills')).length, 0, 'preview only');
    const s1 = await call('/skills/upload/confirm', { token: p1.token });
    assert.equal(s1.name, 'polite-email'); assert.equal(s1.source, 'uploaded');

    // 3) upload a zip with a script inside: warned
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skzip-'));
    fs.mkdirSync(path.join(src, 'pdf-tools', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(src, 'pdf-tools', 'SKILL.md'), '---\nname: pdf-tools\ndescription: Work with PDFs\n---\n\nUse scripts/fill.py\n');
    fs.writeFileSync(path.join(src, 'pdf-tools', 'scripts', 'fill.py'), 'print(1)\n');
    const zip = path.join(src, 'pdf.zip');
    execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-a', '-cf', zip, '-C', src, 'pdf-tools']);
    const p2 = await call('/skills/upload', { fileName: 'pdf.zip', data: fs.readFileSync(zip).toString('base64') });
    assert.equal(p2.name, 'pdf-tools'); assert.deepEqual(p2.runnable, ['scripts/fill.py']);
    await call('/skills/upload/cancel', { token: p2.token });
    await assert.rejects(call('/skills/upload/confirm', { token: p2.token }), /منقضی/);
    await assert.rejects(call('/skills/upload', { fileName: 'x.exe', data: Buffer.from('MZ').toString('base64') }), /SKILL\.md|zip/);

    // 4) teach a routine by voice: asks first, then saved as a skill; next time it is in the brain's context
    const t = await call('/voice/ask', { text: 'جارویس یاد بگیر: هر وقت گفتم گزارش روزانه، تسک‌های امروز و پیامک‌های تازه را بگو' });
    assert.equal(t.confirm, true); assert.equal((await call('/skills')).length, 1, 'not saved before the yes');
    const y = await call('/voice/ask', { text: 'بله' });
    assert.equal(y.result.skill.name, 'daily-report');
    const sk = (await call('/skills')).find(k => k.name === 'daily-report');
    assert.equal(sk.source, 'voice');
    await call('/voice/ask', { text: 'گزارش روزانه' });
    assert.match(prompts.filter(p => /You are JARVIS/.test(p.sys)).pop().sys, /Routines the user taught you[\s\S]*"گزارش روزانه" \(daily-report\): 1\. تسک‌های امروز را بگو 2\. پیامک‌های تازه را بگو/);
  } finally { child.kill(); fake.close(); }
});
