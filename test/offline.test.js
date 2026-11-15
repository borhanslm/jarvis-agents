// Online / offline: internet check, Ollama (offline brain), speech fallback to local engines.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('../lib/net');
const llm = require('../lib/llm');
const { Ollama } = require('../lib/ollama');
const { Speech } = require('../lib/voice/speech');

function fakeOllama() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.9.0' }));
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma3:4b', size: 3.3e9 }] }));
      if (req.url === '/api/pull') {
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', total: 100, completed: 50 }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', total: 100, completed: 100 }) + '\n');
        return res.end(JSON.stringify({ status: 'success' }) + '\n');
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"say":"سلام","action":null}' } }] }) + '\n\n');
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, seen, base: 'http://127.0.0.1:' + srv.address().port })));
}

test('net: network errors are told apart from service refusals', () => {
  assert.ok(net.isNetError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })));
  assert.ok(net.isNetError({ name: 'TimeoutError', message: 'timed out' }));
  assert.ok(net.isNetError(new Error('API Error: Connection error.')));
  assert.ok(!net.isNetError(new Error('کلید API پذیرفته نشد (401)')));
  assert.ok(!net.isNetError(null));
});

test('net: offline when nothing answers, and markOffline sticks', async () => {
  net._reset();
  assert.strictEqual(await net.online({ force: true, probe: 'http://127.0.0.1:1/' }), false);
  net._reset(); net.markOffline();
  assert.strictEqual(await net.online(), false);
  net._reset();
});

test('ollama: status, model list, pull with progress', async () => {
  const f = await fakeOllama();
  try {
    const ev = [];
    const o = new Ollama({ base: f.base, onProgress: (n, st) => ev.push([n, st.completed, st.done]) });
    const st = await o.status();
    assert.strictEqual(st.running, true);
    assert.deepStrictEqual(st.models.map(x => x.name), ['gemma3:4b']);
    assert.throws(() => o.pull('bad name; rm -rf'), /معتبر/);
    o.pull('gemma3:4b');
    for (let i = 0; i < 50 && !(o.pulls['gemma3:4b'].done || o.pulls['gemma3:4b'].error); i++) await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(o.pulls['gemma3:4b'].error, null);
    assert.strictEqual(o.pulls['gemma3:4b'].done, true);
    assert.strictEqual(o.pulls['gemma3:4b'].completed, 100);
    assert.strictEqual(f.seen.find(x => x.url === '/api/pull').body.model, 'gemma3:4b');
  } finally { f.srv.close(); }
});

test('llm: "ollama:<model>" chats with the local model and asks for JSON', async () => {
  const f = await fakeOllama();
  try {
    const r = await llm.chat({ spec: 'ollama:gemma3:4b', deps: { ollamaBase: f.base }, json: true, messages: [{ role: 'user', content: 'سلام' }] });
    assert.match(r.text, /سلام/);
    const req = f.seen.find(x => x.url === '/v1/chat/completions').body;
    assert.strictEqual(req.model, 'gemma3:4b');
    assert.deepStrictEqual(req.response_format, { type: 'json_object' });
    assert.strictEqual(llm.resolveTarget('ollama:qwen2.5:7b').local, true);
  } finally { f.srv.close(); }
});

function speechWith({ apiFails }) {
  const sp = new Speech({ assets: { find: () => null, has: () => false }, apiTarget: () => null });
  const calls = [];
  sp.whisper = { ready: () => true, gpu: () => false, stop() {}, transcribe: async () => { calls.push('local'); return { text: 'سلام' }; } };
  sp.apiStt = { ready: () => true, transcribe: async () => { calls.push('api'); if (apiFails) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); return { text: 'hello' }; } };
  sp.piper = { ready: () => true, speak: async () => { calls.push('piper'); return { wav: Buffer.alloc(50) }; } };
  sp.apiTts = { ready: () => true, speak: async () => { calls.push('apitts'); throw new Error('خطای 401'); } };
  return { sp, calls };
}

test('speech: offline never touches the API', async () => {
  const { sp, calls } = speechWith({ apiFails: false });
  const r = await sp.transcribe(Buffer.alloc(2000), { engine: 'api', offline: true });
  assert.strictEqual(r.engine, 'local');
  await sp.speak('سلام', { engine: 'api', offline: true });
  assert.deepStrictEqual(calls, ['local', 'piper']);
});

test('speech: no internet -> falls back to the local engine; a refusal is not hidden', async () => {
  const { sp, calls } = speechWith({ apiFails: true });
  const r = await sp.transcribe(Buffer.alloc(2000), { engine: 'api' });
  assert.strictEqual(r.engine, 'local'); assert.strictEqual(r.fellBack, true);
  assert.deepStrictEqual(calls, ['api', 'local']);
  await assert.rejects(sp.speak('سلام', { engine: 'api' }), /401/); // a key problem is shown, not silently replaced
});

test('speech auto: free local first; never the paid API without a key', async () => {
  const sp = new Speech({ assets: { find: () => null, has: () => false }, apiTarget: () => null });
  // nothing local yet, no OpenAI key: explains the free voice is still downloading (no API attempt)
  await assert.rejects(sp.speak('سلام', { engine: 'auto' }), /رایگان هنوز دانلود نشده/);
  const { sp: sp2, calls } = speechWith({ apiFails: false });
  sp2.piper.ready = () => false; sp2.apiTts.ready = () => true; sp2.apiTts.speak = async () => { calls.push('apitts'); return { wav: Buffer.alloc(10) }; };
  await sp2.speak('سلام', { engine: 'auto' }); // a key exists and local is missing: API is fine
  assert.deepStrictEqual(calls, ['apitts']);
});

test('a refused Anthropic key falls back to the Claude Code sign-in', async () => {
  const realFetch = global.fetch; let hits = 0;
  global.fetch = async () => { hits++; return new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }); };
  const agents = require('../lib/agents'); const real = agents.runClaude; let cli = 0;
  try {
    // resolveTarget picks the key; the 401 must lead to the CLI path (stubbed through the target kind)
    const t = llm.resolveTarget('claude-haiku-5-5', { anthropicKey: 'sk-bad' });
    assert.strictEqual(t.kind, 'anthropic');
    await llm.chat({ spec: 'claude-haiku-5-5', deps: { anthropicKey: 'sk-bad' }, messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    assert.strictEqual(hits, 1);
    // afterwards the bad key is not used again
    assert.strictEqual(llm.resolveTarget('claude-haiku-5-5', { anthropicKey: 'sk-bad' }).kind, 'claude-cli');
  } finally { global.fetch = realFetch; agents.runClaude = real; }
});

test('Gemini speech: transcribe and speak through generateContent (mock server)', async () => {
  const { Speech, wavFromPcm } = require('../lib/voice/speech');
  const realFetch = global.fetch; const calls = [];
  global.fetch = async (url, o) => {
    const body = JSON.parse(o.body); calls.push({ url, key: o.headers['x-goog-api-key'], body });
    if (/tts/.test(url)) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(4800).toString('base64') } }] } }] }));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'سلام جارویس' }] } }] }));
  };
  try {
    const sp = new Speech({ assets: { find: () => null, has: () => false }, apiTarget: () => ({ kind: 'gemini', key: 'AIza-test' }) });
    const r = await sp.transcribe(wavFromPcm(Buffer.alloc(32000), 16000), { engine: 'api', lang: 'fa' });
    assert.strictEqual(r.text, 'سلام جارویس'); assert.strictEqual(r.engine, 'api');
    assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent$/); assert.strictEqual(calls[0].key, 'AIza-test');
    assert.strictEqual(calls[0].body.contents[0].parts[1].inline_data.mime_type, 'audio/wav');
    const s = await sp.speak('سلام', { engine: 'api', prefs: { geminiVoice: 'Puck' } });
    assert.strictEqual(s.wav.slice(0, 4).toString(), 'RIFF'); assert.strictEqual(s.wav.readUInt32LE(24), 24000); assert.strictEqual(s.wav.length, 44 + 4800);
    assert.strictEqual(calls[1].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
    assert.deepStrictEqual(calls[1].body.generationConfig.responseModalities, ['AUDIO']);
  } finally { global.fetch = realFetch; }
});
