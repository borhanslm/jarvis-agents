// Voice services beyond Gemini/OpenAI (lib/voice/cloud.js) and choosing among every engine
// (lib/voice/speech.js), against a fake fetch — no real keys or network.
const test = require('node:test');
const assert = require('node:assert');
const cloud = require('../lib/voice/cloud');
const { Speech } = require('../lib/voice/speech');

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60)]);
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts = {}) => { const u = String(url); calls.push({ url: u, opts }); return handler(u, opts); };
  f.calls = calls; return f;
}
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
async function withFetch(f, fn) { const real = global.fetch; global.fetch = f; try { return await fn(); } finally { global.fetch = real; } }

test('ElevenLabs: speak (PCM -> WAV, falls to the next model), transcribe, wrong key', async () => {
  const f = fakeFetch((u, o) => {
    if (u.includes('/text-to-speech/')) return /eleven_v3/.test(o.body) ? json({ detail: { message: 'model not found' } }, 404) : new Response(Buffer.alloc(480), { status: 200 });
    if (u.includes('/speech-to-text')) return json({ text: ' سلام دنیا ' });
    return json({}, 404);
  });
  await withFetch(f, async () => {
    const r = await cloud.elevenSpeak('k', 'سلام', { voice: 'v1' });
    assert.equal(r.mime, 'audio/wav'); assert.equal(r.audio.toString('ascii', 0, 4), 'RIFF'); assert.equal(r.audio.length, 44 + 480);
    assert.equal(f.calls.filter(c => c.url.includes('text-to-speech')).length, 2, 'eleven_v3 refused -> eleven_multilingual_v2');
    assert.equal(f.calls[0].opts.headers['xi-api-key'], 'k');
    assert.equal((await cloud.elevenTranscribe('k', WAV, { lang: 'fa' })).text, 'سلام دنیا');
  });
  await withFetch(fakeFetch(() => json({ detail: { message: 'invalid' } }, 401)), async () => {
    await assert.rejects(cloud.elevenSpeak('bad', 'x'), /کلید پذیرفته نشد/);
  });
});

test('Azure: Persian SSML with the chosen voice and region; transcribe fa-IR', async () => {
  const f = fakeFetch((u, o) => u.includes('.tts.') ? new Response(WAV, { status: 200 }) : json({ RecognitionStatus: 'Success', DisplayText: 'کروم را باز کن.' }));
  await withFetch(f, async () => {
    const r = await cloud.azureSpeak({ key: 'k', region: 'westeurope' }, 'سلام <دنیا>', { voice: 'fa-IR-FaridNeural' });
    assert.equal(r.audio.toString('ascii', 0, 4), 'RIFF');
    assert.match(f.calls[0].url, /^https:\/\/westeurope\.tts\.speech\.microsoft\.com\//);
    assert.match(f.calls[0].opts.body, /xml:lang='fa-IR'.*fa-IR-FaridNeural.*سلام &lt;دنیا&gt;/);
    assert.equal(f.calls[0].opts.headers['Ocp-Apim-Subscription-Key'], 'k');
    assert.equal((await cloud.azureTranscribe({ key: 'k', region: 'westeurope' }, WAV, { lang: 'fa' })).text, 'کروم را باز کن.');
    assert.match(f.calls[1].url, /language=fa-IR/);
  });
});

test('Groq and Deepgram transcribe; a busy service is marked busy', async () => {
  await withFetch(fakeFetch(u => u.includes('groq') ? json({ text: 'hello' }) : json({ results: { channels: [{ alternatives: [{ transcript: 'hi there' }] }] } })), async () => {
    assert.equal((await cloud.groqTranscribe('k', WAV)).text, 'hello');
    assert.equal((await cloud.deepgramTranscribe('k', WAV, { lang: 'en' })).text, 'hi there');
  });
  await withFetch(fakeFetch(() => json({ error: { message: 'overloaded' } }, 503)), async () => {
    await assert.rejects(cloud.groqTranscribe('k', WAV), e => e.busy === true);
  });
});

test('Speech: pick any engine by id; missing key says so; busy service falls back to the local voice', async () => {
  const assets = { has: () => false, find: () => null };
  const keys = { elevenlabs: () => 'k', azure: () => null };
  const sp = new Speech({ assets, apiTarget: () => null, keys });
  const av = sp.available();
  assert.equal(av.tts.elevenlabs, true); assert.equal(av.tts.azure, false); assert.equal(av.stt.groq, false);
  await assert.rejects(sp.speak('سلام', { engine: 'azure' }), /Azure Speech/);
  await withFetch(fakeFetch(() => new Response(Buffer.alloc(100), { status: 200 })), async () => {
    const r = await sp.speak('سلام', { engine: 'elevenlabs' });
    assert.equal(r.engine, 'elevenlabs'); assert.equal(r.wav.toString('ascii', 0, 4), 'RIFF');
  });
  // auto with no local voice: the first service that has a key
  await withFetch(fakeFetch(() => new Response(Buffer.alloc(100), { status: 200 })), async () => {
    assert.equal((await sp.speak('سلام', { engine: 'auto' })).engine, 'elevenlabs');
  });
  // busy -> local Piper stands in
  sp.piper = { ready: () => true, speak: async () => ({ wav: WAV }) };
  sp.tts.local = sp.piper;
  await withFetch(fakeFetch(() => json({}, 503)), async () => {
    const r = await sp.speak('سلام', { engine: 'elevenlabs' });
    assert.equal(r.engine, 'local'); assert.equal(r.fellBack, true);
  });
  // offline: never a service
  assert.equal((await sp.speak('سلام', { engine: 'elevenlabs', offline: true })).engine, 'local');
});
