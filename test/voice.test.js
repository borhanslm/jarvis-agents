'use strict';
// Voice assistant: direct LLM client, the brain (actions + yes/no), tasks, API speech,
// downloads, the server endpoints — and, when the offline models are present
// (JARVIS_VOICE_DATA=<folder with voice/>), real wake word + speech round trips.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const llm = require('../lib/llm');
const { Brain, parseReply } = require('../lib/voice/brain');
const { Tasks } = require('../lib/tasks');
const { ApiSTT, ApiTTS, Speech, wavFromFloat32, detectLang } = require('../lib/voice/speech');
const { VoiceAssets, ITEMS } = require('../lib/voice/assets');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`); res.end('data: [DONE]\n\n'); };

// A fake OpenAI-compatible API: chat (streaming), transcription, speech.
function fakeOpenAI(seen, reply) {
  return http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
      if (req.url.endsWith('/chat/completions')) {
        const j = JSON.parse(body);
        if (req.headers.authorization !== 'Bearer good') { res.writeHead(401); return res.end('{"error":{"message":"bad key"}}'); }
        const text = typeof reply === 'function' ? reply(j) : reply;
        return sse(res, [...text.match(/.{1,7}/gs).map(t => ({ choices: [{ delta: { content: t } }] })), { choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } }]);
      }
      if (req.url.endsWith('/audio/transcriptions')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: 'سلام جارویس' })); }
      if (req.url.endsWith('/audio/speech')) { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(wavFromFloat32(new Float32Array(1600))); }
      res.writeHead(404); res.end();
    });
  });
}

test('direct LLM client streams from OpenAI-compatible and Anthropic APIs', async () => {
  const seen = [];
  const o = fakeOpenAI(seen, 'Hello from the model');
  const op = await listen(o);
  const a = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-api-key'], body: JSON.parse(b) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = d => res.write(`event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`);
      ev({ type: 'message_start', message: { usage: { input_tokens: 9 } } });
      for (const t of ['سلام', '، ', 'خوبم']) ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
      ev({ type: 'message_delta', usage: { output_tokens: 4 } });
      res.end();
    });
  });
  const ap = await listen(a);
  try {
    let got = '';
    const r = await llm.chat({ target: { kind: 'openai', baseUrl: `http://127.0.0.1:${op}/v1`, key: 'good', model: 'm' }, system: 'be brief', messages: [{ role: 'user', content: 'hi' }], onDelta: d => { got += d; } });
    assert.equal(r.text, 'Hello from the model'); assert.equal(got, r.text); assert.deepEqual(r.usage, { input: 11, output: 5 });
    const sent = JSON.parse(seen.find(x => x.url === '/v1/chat/completions').body);
    assert.equal(sent.messages[0].role, 'system'); assert.equal(sent.stream, true);
    await assert.rejects(llm.chat({ target: { kind: 'openai', baseUrl: `http://127.0.0.1:${op}/v1`, key: 'bad', model: 'm' }, messages: [{ role: 'user', content: 'hi' }] }), /کلید API پذیرفته نشد/);
    const r2 = await llm.chat({ target: { kind: 'anthropic', baseUrl: `http://127.0.0.1:${ap}`, key: 'k-1', model: 'claude-x' }, system: 's', messages: [{ role: 'user', content: 'خوبی؟' }] });
    assert.equal(r2.text, 'سلام، خوبم'); assert.deepEqual(r2.usage, { input: 9, output: 4 });
    const an = seen.find(x => x.url === '/v1/messages');
    assert.equal(an.key, 'k-1'); assert.equal(an.body.system, 's');
    // spec resolution
    const providers = { get: id => id === 'ds' ? { id: 'ds', name: 'DS', kind: 'anthropic', baseUrl: 'https://x' } : null, key: () => 'kk' };
    assert.equal(llm.resolveTarget('p:ds:deepseek-chat', { providers }).model, 'deepseek-chat');
    assert.equal(llm.resolveTarget('claude-haiku-5-5', { anthropicKey: 'a' }).kind, 'anthropic');
    assert.equal(llm.resolveTarget('claude-haiku-5-5', {}).kind, 'claude-cli');
    assert.throws(() => llm.resolveTarget('p:none:x', { providers }), /پیدا نشد/);
  } finally { o.close(); a.close(); }
});

test('brain: JSON replies, actions, and yes/no confirmation in Persian and English', async () => {
  let next = '';
  const calls = [];
  const brain = new Brain({ chat: async o => { calls.push(o); return { text: next }; }, context: () => ({ now: 'now', projects: [{ id: 'p1', name: 'shop' }], running: [], recent: [], tasks: [] }) });
  next = 'Sure: {"say":"باشه، تسک خرید نان اضافه شد.","action":{"type":"add_task","params":{"title":"خرید نان","due":"2026-11-16T10:00"}}}';
  let r = await brain.handle('فردا ساعت ده نان بخرم');
  assert.equal(r.action.type, 'add_task'); assert.equal(r.confirm, false);
  assert.match(calls[0].system, /Projects: "shop"/);
  next = '{"say":"روی پروژه‌ی shop صفحه‌ی ورود را بسازم؟","action":{"type":"run_team","params":{"project":"shop","task":"login page"}}}';
  r = await brain.handle('برای shop صفحه‌ی ورود بساز');
  assert.equal(r.confirm, true);
  r = await brain.handle('بله');
  assert.equal(r.confirmed, true); assert.equal(r.action.type, 'run_team');
  assert.equal(calls.length, 2, 'the yes did not go to the model');
  // cancel in English
  await brain.handle('build it');
  r = await brain.handle('no');
  assert.equal(r.cancelled, true); assert.equal(r.action, null);
  // unknown action types are dropped, plain text is spoken
  assert.deepEqual(parseReply('{"say":"hi","action":{"type":"format_disk","params":{}}}'), { say: 'hi', action: null });
  assert.deepEqual(parseReply('Just text.'), { say: 'Just text.', action: null });
  // history goes along (last turns)
  next = '{"say":"ok","action":null}';
  await brain.handle('thanks');
  assert.ok(calls[calls.length - 1].messages.length > 1);
});

test('tasks: add, update, done, today', () => {
  const t = new Tasks(tmp('jarvis-tasks-'));
  assert.throws(() => t.add({ title: '  ' }), /خالی/);
  const a = t.add({ title: 'خرید نان', due: Date.now() + 3600000, priority: 'high' }, 'voice');
  const b = t.add({ title: 'شروع CRM', due: Date.now() + 5 * 86400000 });
  const c = t.add({ title: 'بدون تاریخ' });
  assert.deepEqual(t.today().map(x => x.id).sort(), [a.id, c.id].sort());
  t.update(a.id, { done: true });
  assert.ok(t.get(a.id).doneAt);
  assert.deepEqual(t.today().map(x => x.id), [c.id]);
  t.remove(b.id);
  assert.equal(new Tasks(path.dirname(t.file)).all().length, 2, 'saved to disk');
});

test('API speech: transcription and speech through an OpenAI-compatible endpoint', async () => {
  const seen = [];
  const srv = fakeOpenAI(seen, '');
  const port = await listen(srv);
  try {
    const target = () => ({ baseUrl: `http://127.0.0.1:${port}/v1`, key: 'kk' });
    const r = await new ApiSTT(target).transcribe(wavFromFloat32(new Float32Array(16000)), { lang: 'fa' });
    assert.equal(r.text, 'سلام جارویس');
    const up = seen.find(x => x.url === '/v1/audio/transcriptions');
    assert.match(up.type, /multipart\/form-data/); assert.ok(up.body.includes(Buffer.from('RIFF')));
    const s = await new ApiTTS(target).speak('سلام', { prefs: { apiVoice: 'nova' } });
    assert.equal(s.wav.slice(0, 4).toString(), 'RIFF');
    assert.equal(JSON.parse(seen.find(x => x.url === '/v1/audio/speech').body).voice, 'nova');
    // engine choice: auto falls back to the API when nothing local is installed
    const sp = new Speech({ assets: new VoiceAssets(tmp('jarvis-va-')), apiTarget: target });
    assert.equal((await sp.transcribe(wavFromFloat32(new Float32Array(16000)))).engine, 'api');
    await assert.rejects(sp.transcribe(wavFromFloat32(new Float32Array(16000)), { engine: 'local' }), /دانلود/);
    assert.equal(detectLang('hello'), 'en'); assert.equal(detectLang('سلام'), 'fa');
  } finally { srv.close(); }
});

test('voice downloads: progress, zip extraction, remove', async () => {
  const dir = tmp('jarvis-dl-');
  const src = tmp('jarvis-dlsrc-');
  fs.mkdirSync(path.join(src, 'pkg', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'pkg', 'bin', 'tool.exe'), 'x'.repeat(5000));
  const zip = path.join(dir, 't.zip');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  require('child_process').execFileSync(tar, process.platform === 'win32' ? ['-a', '-c', '-f', zip, '-C', src, 'pkg'] : ['-a', '-c', '-f', zip, '-C', src, 'pkg']);
  const srv = http.createServer((req, res) => { if (req.url === '/t.zip') { res.writeHead(200); return res.end(fs.readFileSync(zip)); } res.writeHead(200); res.end('model-bytes'); });
  const port = await listen(srv);
  ITEMS['test-zip'] = { label: 't', size: 100, zip: true, url: `http://127.0.0.1:${port}/t.zip` };
  ITEMS['test-file'] = { label: 't', size: 11, files: { 'model.bin': `http://127.0.0.1:${port}/m` } };
  try {
    const a = new VoiceAssets(dir);
    a.download('test-zip'); a.download('test-file');
    for (let i = 0; i < 100 && !(a.has('test-zip') && a.has('test-file')); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(a.find('test-zip', 'tool.exe'), 'zip extracted');
    assert.equal(fs.readFileSync(a.find('test-file', 'model.bin'), 'utf8'), 'model-bytes');
    assert.equal(a.status()['test-file'].installed, true);
    a.remove('test-zip');
    assert.equal(a.has('test-zip'), false);
  } finally { delete ITEMS['test-zip']; delete ITEMS['test-file']; srv.close(); }
});

test('server: voice asks add tasks through the brain; run_team waits for a yes', { timeout: 60000 }, async () => {
  const llmSeen = [];
  const fake = fakeOpenAI(llmSeen, j => {
    const said = j.messages[j.messages.length - 1].content;
    return /نان/.test(said) ? '{"say":"تسک خرید نان را اضافه کردم.","action":{"type":"add_task","params":{"title":"خرید نان","priority":"high"}}}'
      : /بساز/.test(said) ? '{"say":"صفحه‌ی ورود را روی demo بسازم؟","action":{"type":"run_team","params":{"project":"demo","task":"login page"}}}'
      : '{"say":"ok","action":null}';
  });
  const fp = await listen(fake);
  const { spawn } = require('child_process');
  const data = tmp('jarvis-vsrv-');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, JARVIS_PORT: '0', JARVIS_DATA: data, JARVIS_CLUB_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error(out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/localhost:(\d+)\//); if (m) { clearTimeout(t); res(+m[1]); } }); });
    const call = (p, body, method) => fetch(`http://127.0.0.1:${port}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-jarvis': '1' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
    const pv = await call('/providers', { name: 'Fake', kind: 'openai', baseUrl: `http://127.0.0.1:${fp}/v1`, models: 'brain-1', apiKey: 'good' });
    await call('/settings', { voiceModel: `p:${pv.id}:brain-1` });
    const r = await call('/voice/ask', { text: 'یادم بنداز نان بخرم' });
    assert.equal(r.action.type, 'add_task'); assert.equal(r.result.ok, true);
    const tasks = await call('/tasks');
    assert.equal(tasks[0].title, 'خرید نان'); assert.equal(tasks[0].priority, 'high'); assert.equal(tasks[0].source, 'voice');
    const r2 = await call('/voice/ask', { text: 'صفحه‌ی ورود بساز' });
    assert.equal(r2.confirm, true); assert.equal(r2.result, null, 'nothing started before the yes');
    const r3 = await call('/voice/ask', { text: 'نه' });
    assert.equal(r3.cancelled, true);
    assert.equal((await call('/chats')).length, 0, 'no chat was created');
    const st = await call('/voice/status');
    assert.equal(st.assets.wakeword.installed, false); assert.equal(st.stt.api, false);
    assert.equal(st.log.length, 3);
  } finally { child.kill(); fake.close(); }
});

// ---- real offline models (skipped unless they were downloaded) ----
const VDATA = process.env.JARVIS_VOICE_DATA;
const haveModels = VDATA && fs.existsSync(path.join(VDATA, 'voice', 'wakeword', '.done')) && fs.existsSync(path.join(VDATA, 'voice', 'piper-bin', '.done'));

test('real: "hey jarvis" wakes, other speech does not', { skip: !haveModels && 'offline voice models not present', timeout: 120000 }, async () => {
  const assets = new VoiceAssets(VDATA);
  const sp = new Speech({ assets, apiTarget: () => null });
  const ort = await import(pathToFileURL(path.join(__dirname, '..', 'node_modules/onnxruntime-web/dist/ort.node.min.mjs')).href);
  ort.env.wasm.numThreads = 1;
  const { WakeWord, resample } = await import(pathToFileURL(path.join(__dirname, '..', 'public/voice/wakeword.js')).href);
  const ww = await WakeWord.create(ort, async n => fs.readFileSync(assets.find('wakeword', n)));
  const score = async text => {
    const w = (await sp.speak(text, { lang: 'en' })).wav;
    const n = (w.length - 44) / 2, s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = w.readInt16LE(44 + i * 2) / 32768;
    const x = resample(s, w.readUInt32LE(24), 16000);
    const pad = new Float32Array(16000);
    const all = new Float32Array(pad.length * 2 + x.length); all.set(x, pad.length);
    ww.reset(); let max = 0;
    for (let i = 0; i < all.length; i += 1280) { const v = await ww.push(all.subarray(i, i + 1280)); if (v != null) max = Math.max(max, v); }
    return max;
  };
  assert.ok(await score('Hey Jarvis') > 0.5);
  assert.ok(await score('The weather is nice today and I like coffee.') < 0.2);
});

test('real: Persian speech -> local text -> back', { skip: !(haveModels && fs.existsSync(path.join(VDATA, 'voice', 'whisper-turbo', '.done'))) && 'offline voice models not present', timeout: 240000 }, async () => {
  const sp = new Speech({ assets: new VoiceAssets(VDATA), apiTarget: () => null });
  try {
    const w = await sp.speak('سلام، امروز چه کارهایی دارم؟', {});
    const r = await sp.transcribe(w.wav, { lang: 'fa' });
    assert.equal(r.engine, 'local'); assert.equal(r.lang, 'fa');
    assert.match(r.text, /سلام/); assert.match(r.text, /امروز/);
  } finally { sp.stop(); }
});

// Google retires Gemini models: speech falls through to the next model and remembers it
test('Gemini voice: a retired model falls back to the next one', async () => {
  const sp = require('../lib/voice/speech');
  const real = global.fetch, seen = [];
  global.fetch = async u => {
    const m = decodeURIComponent(String(u).split('/models/')[1].split(':')[0]); seen.push(m);
    if (m !== 'gemini-3.8-flash-lite-tts') return new Response(JSON.stringify([{ error: { message: `models/${m} is not found` } }]), { status: 404 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(64).toString('base64') } }] } }] }), { status: 200 });
  };
  try {
    const tts = new sp.ApiTTS(() => ({ kind: 'gemini', key: 'k', ttsModel: 'gemini-2.5-flash-preview-tts' }));
    await tts.speak('سلام');
    assert.deepEqual(seen, ['gemini-2.5-flash-preview-tts', 'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);
    seen.length = 0; await tts.speak('دوباره');
    assert.deepEqual(seen, ['gemini-3.8-flash-lite-tts'], 'remembers the working model');
    // a wrong key is not a model problem: stop at once
    global.fetch = async () => new Response(JSON.stringify([{ error: { message: 'API key not valid' } }]), { status: 400 });
    await assert.rejects(new sp.ApiTTS(() => ({ kind: 'gemini', key: 'bad' })).speak('x'), /کلید API/);
  } finally { global.fetch = real; }
});

// Gemini says "high demand" (503): retry once, then the next model; if every model is busy, the free local voice speaks
test('Gemini voice: busy (503) retries, moves on, then falls back to the local voice', async () => {
  process.env.JARVIS_GEMINI_RETRY_MS = '1';
  delete require.cache[require.resolve('../lib/voice/speech')];
  const sp = require('../lib/voice/speech');
  const real = global.fetch, seen = [];
  const busy = () => new Response(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.' } }), { status: 503 });
  global.fetch = async u => { const m = decodeURIComponent(String(u).split('/models/')[1].split(':')[0]); seen.push(m);
    if (m === 'gemini-3.8-flash-lite-tts') return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(64).toString('base64') } }] } }] }), { status: 200 });
    return busy(); };
  try {
    await new sp.ApiTTS(() => ({ kind: 'gemini', key: 'k', ttsModel: 'gemini-3.8-flash-tts' })).speak('سلام');
    assert.deepEqual(seen.slice(0, 3), ['gemini-3.8-flash-tts', 'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'], 'one retry, then the lighter model');
    // every model busy: the error is marked busy, and Speech uses the local voice instead
    global.fetch = async () => busy();
    delete require.cache[require.resolve('../lib/voice/speech')];
    const sp2 = require('../lib/voice/speech');
    const s = new sp2.Speech({ assets: { status: () => ({}), path: () => '' }, apiTarget: () => ({ kind: 'gemini', key: 'k' }) });
    s.piper = { ready: () => true, speak: async () => ({ wav: Buffer.alloc(4) }) };
    const r = await s.speak('سلام', { engine: 'api' });
    assert.equal(r.engine, 'local'); assert.equal(r.fellBack, true);
    s.piper = { ready: () => false };
    await assert.rejects(s.speak('سلام', { engine: 'api' }), /شلوغ/);
  } finally { global.fetch = real; delete process.env.JARVIS_GEMINI_RETRY_MS; }
});
