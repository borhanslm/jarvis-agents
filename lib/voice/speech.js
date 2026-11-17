// Speech to text and text to speech — offline (whisper.cpp / Piper) or through an API (OpenAI).
// Same interface for every engine:
//   stt.transcribe(wavBuffer, { lang }) -> { text, lang, ms, engine }
//   tts.speak(text, { lang })           -> { wav: Buffer, ms, engine }
'use strict';

const { isNetError } = require('../net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const FA_RE = /[؀-ۿ]/;
const detectLang = t => (FA_RE.test(String(t || '')) ? 'fa' : 'en');

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const killTree = child => { try { if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); else child.kill(); } catch {} };

// ---------- whisper.cpp: a resident server, so the model is loaded once ----------
class LocalWhisper {
  constructor(assets) { this.assets = assets; this.proc = null; this.port = 0; this.model = null; this.starting = null; }
  modelId() { return this.assets.has('whisper-turbo') ? 'whisper-turbo' : this.assets.has('whisper-base') ? 'whisper-base' : null; }
  bin() {
    const name = IS_WIN ? 'whisper-server.exe' : 'whisper-server';
    const gpu = this.assets.find('whisper-cuda', name);
    return gpu ? { exe: gpu, gpu: true } : { exe: this.assets.find('whisper-bin', name), gpu: false };
  }
  ready() { return !!(this.bin().exe && this.modelId()); }
  gpu() { return this.bin().gpu; }
  async ensure() {
    const mid = this.modelId();
    if (this.proc && this.model === mid) return;
    if (this.starting) return this.starting;
    this.stop();
    const { exe, gpu } = this.bin();
    if (!exe || !mid) throw new Error('اول موتور و مدل گفتار محلی را از تنظیمات صدا دانلود کنید');
    this.starting = (async () => {
      this.port = await freePort();
      // greedy decoding + a 10 s audio window: about 5x faster than the defaults for short commands
      const threads = Math.max(2, Math.min(8, os.cpus().length - 1));
      const p = spawn(exe, ['-m', this.assets.find(mid, 'model.bin'), '--host', '127.0.0.1', '--port', String(this.port), '-t', String(gpu ? 4 : threads), '-l', 'auto', '-bs', '1', '-bo', '1', ...(gpu ? [] : ['-ac', '512'])],
        { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      p.stdout.on('data', d => { log = (log + d).slice(-4000); });
      p.stderr.on('data', d => { log = (log + d).slice(-4000); });
      p.on('exit', () => { if (this.proc === p) { this.proc = null; this.model = null; } });
      // wait until it answers (loading a large model takes a few seconds)
      const until = Date.now() + 120000;
      for (;;) {
        if (p.exitCode !== null) throw new Error('موتور گفتار اجرا نشد:\n' + log.slice(-600));
        try { const r = await fetch(`http://127.0.0.1:${this.port}/`); if (r.status < 500) break; } catch {}
        if (Date.now() > until) { killTree(p); throw new Error('موتور گفتار در زمان مقرر آماده نشد'); }
        await new Promise(r => setTimeout(r, 300));
      }
      this.proc = p; this.model = mid; this.isGpu = gpu;
      // first GPU use compiles kernels (can take ~30 s once); do it now, not on the user's first sentence
      if (gpu) { const fd = new FormData(); fd.append('file', new Blob([wavFromFloat32(new Float32Array(8000))], { type: 'audio/wav' }), 'w.wav'); await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: fd }).catch(() => {}); }
    })();
    try { await this.starting; } finally { this.starting = null; }
  }
  async transcribe(wav, { lang, hint } = {}) {
    await this.ensure();
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    fd.append('response_format', 'json');
    if (hint) fd.append('prompt', hint); // names and words JARVIS learned, so they are heard right
    fd.append('language', lang && lang !== 'auto' ? lang : 'auto');
    fd.append('temperature', '0');
    const r = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('خطای موتور گفتار: ' + r.status);
    const j = await r.json();
    return { text: String(j.text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() };
  }
  stop() { if (this.proc) { killTree(this.proc); this.proc = null; this.model = null; } }
}

// ---------- OpenAI-compatible API ----------
async function apiFail(r) { let t = ''; try { t = await r.text(); } catch {} let m = t; try { let j = JSON.parse(t); if (Array.isArray(j)) j = j[0]; m = (j.error && j.error.message) || t; } catch {}
  if (/location is not supported/i.test(m)) return new Error('Gemini در منطقه‌ی شما در دسترس نیست (Google ایران را پشتیبانی نمی‌کند). با VPN یا از صدای رایگان محلی استفاده کنید.');
  if (/api key not valid|API_KEY_INVALID|pass a valid API key/i.test(m)) return new Error('کلید API پذیرفته نشد');
  const busy = r.status >= 500 || /high demand|overloaded|unavailable/i.test(m);
  const e = new Error(r.status === 401 ? 'کلید API پذیرفته نشد' : r.status === 429 ? 'سهمیه‌ی این مدل پر شده (یا نسخه‌ی رایگان ندارد)'
    : busy ? 'سرویس صدای Gemini الان شلوغ است؛ کمی بعد دوباره امتحان کنید' : `خطای ${r.status}: ${String(m).slice(0, 200)}`);
  // the model itself is unusable (retired, not for this key, no free quota, wrong kind, overloaded): try the next one
  e.modelGone = busy || r.status === 404 || r.status === 429 || (r.status === 400 && /not found|no longer|not supported|modalit/i.test(m));
  e.busy = busy || r.status === 429; e.status = r.status; // temporary: the free local voice may stand in
  return e; }

// ---- Google Gemini (speech to text through a normal model; text to speech with a TTS model) ----
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
// Google retires models often (2.5 closed to new keys in late 2026): try the chosen one, then these in order
const GEMINI_MODELS = {
  stt: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'],
  tts: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts'],
};
const geminiWorks = {}; // role -> the model that last worked
const GEMINI_RETRY_MS = +process.env.JARVIS_GEMINI_RETRY_MS || 1500;
async function geminiAny(t, role, preferred, body) {
  const list = [...new Set([geminiWorks[role], preferred, ...GEMINI_MODELS[role]].filter(Boolean).map(m => String(m).replace(/^models\//, '')))];
  let last;
  let allBusy = true;
  for (const m of list) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const p = await gemini(t, m, body); geminiWorks[role] = m; return p; }
      catch (e) {
        last = e; if (!e.modelGone) throw e;
        if (!e.busy) { allBusy = false; break; }
        if (attempt === 0 && e.status !== 429) await new Promise(r => setTimeout(r, GEMINI_RETRY_MS)); // busy: one short retry, then the next model
        else break;
      }
    }
  }
  if (allBusy && last) last.busy = true;
  throw last;
}
async function gemini(t, model, body) {
  model = String(model || '').trim().replace(/^models\//, '');
  const r = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': t.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw await apiFail(r);
  const j = await r.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  if (!parts.length) throw new Error('Gemini جوابی نداد' + (j.promptFeedback && j.promptFeedback.blockReason ? ' (' + j.promptFeedback.blockReason + ')' : ''));
  return parts;
}
// raw 16-bit PCM (Gemini TTS) -> WAV
function wavFromPcm(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function geminiTranscribe(t, wav, lang, hint) {
  const say = (lang === 'fa' ? 'The speech is Persian (Farsi).' : lang === 'en' ? 'The speech is English.' : 'The speech is Persian (Farsi) or English.') + (hint ? ` Words and names the speaker often uses (spell them like this): ${hint}.` : '');
  const parts = await geminiAny(t, 'stt', t.sttModel, { contents: [{ role: 'user', parts: [{ text: `Transcribe this audio exactly as spoken. ${say} Output only the transcript, in the original language and script, with no notes. If there is no speech, output nothing.` }, { inline_data: { mime_type: 'audio/wav', data: Buffer.from(wav).toString('base64') } }] }], generationConfig: { temperature: 0 } });
  return { text: parts.map(p => p.text || '').join('').trim() };
}
async function geminiSpeak(t, text, voice) {
  const parts = await geminiAny(t, 'tts', t.ttsModel, { contents: [{ role: 'user', parts: [{ text: String(text).slice(0, 4000) }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } } } });
  const a = parts.find(p => p.inlineData || p.inline_data); const d = a && (a.inlineData || a.inline_data);
  if (!d || !d.data) throw new Error('Gemini صدا نساخت');
  const buf = Buffer.from(d.data, 'base64'); const mime = String(d.mimeType || d.mime_type || '');
  if (/wav/i.test(mime)) return { wav: buf };
  const rate = +((/rate=(\d+)/.exec(mime) || [])[1]) || 24000;
  return { wav: wavFromPcm(buf, rate) };
}

class ApiSTT {
  constructor(getTarget) { this.getTarget = getTarget; }
  ready() { try { return !!this.getTarget(); } catch { return false; } }
  async transcribe(wav, { lang, hint } = {}) {
    const t = this.getTarget();
    if (!t) throw new Error('برای گفتار با API، یک اتصال Gemini یا OpenAI با کلید در «هسته‌ی هوش مصنوعی» لازم است');
    if (t.kind === 'gemini') return geminiTranscribe(t, wav, lang, hint);
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    fd.append('model', t.sttModel || 'gpt-4o-transcribe');
    if (lang && lang !== 'auto') fd.append('language', lang);
    if (hint) fd.append('prompt', hint);
    const r = await fetch(t.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + t.key }, body: fd });
    if (!r.ok) throw await apiFail(r);
    const j = await r.json();
    return { text: String(j.text || '').trim() };
  }
}

class LocalPiper {
  constructor(assets) { this.assets = assets; }
  voiceFor(lang, prefs = {}) {
    const fa = prefs.faVoice && this.assets.has(prefs.faVoice) ? prefs.faVoice : ['voice-fa-amir', 'voice-fa-gyro'].find(v => this.assets.has(v));
    const en = this.assets.has('voice-en-lessac') ? 'voice-en-lessac' : null;
    return lang === 'fa' ? fa : (en || fa);
  }
  ready(lang = 'fa') { return !!(this.assets.find('piper-bin', IS_WIN ? 'piper.exe' : 'piper') && this.voiceFor(lang)); }
  speak(text, { lang, prefs } = {}) {
    const exe = this.assets.find('piper-bin', IS_WIN ? 'piper.exe' : 'piper');
    const v = this.voiceFor(lang || detectLang(text), prefs);
    if (!exe || !v) return Promise.reject(Object.assign(new Error('صدای فارسی رایگان هنوز دانلود نشده (بار اول خودکار دانلود می‌شود). تا آن موقع جواب‌ها فقط نوشته می‌شوند.'), { notReady: true }));
    const out = path.join(os.tmpdir(), `jarvis-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
    return new Promise((resolve, reject) => {
      const p = spawn(exe, ['-m', this.assets.find(v, 'voice.onnx'), '-f', out], { cwd: path.dirname(exe), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      const timer = setTimeout(() => { killTree(p); reject(new Error('ساخت صدا بیش از حد طول کشید')); }, 60000);
      p.stderr.on('data', d => { err = (err + d).slice(-2000); });
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', code => {
        clearTimeout(timer);
        try { const wav = fs.readFileSync(out); fs.rmSync(out, { force: true }); if (wav.length > 44) return resolve({ wav }); } catch {}
        reject(new Error('Piper صدا نساخت (کد ' + code + '):\n' + err.slice(-400)));
      });
      p.stdin.on('error', () => {});
      p.stdin.end(String(text).replace(/\s+/g, ' ').trim() + '\n');
    });
  }
}

class ApiTTS {
  constructor(getTarget) { this.getTarget = getTarget; }
  ready() { try { return !!this.getTarget(); } catch { return false; } }
  async speak(text, { prefs = {} } = {}) {
    const t = this.getTarget();
    if (!t) throw new Error('برای صدای API، یک اتصال Gemini یا OpenAI با کلید در «هسته‌ی هوش مصنوعی» لازم است');
    if (t.kind === 'gemini') return geminiSpeak(t, text, prefs.geminiVoice);
    const r = await fetch(t.baseUrl.replace(/\/+$/, '') + '/audio/speech', {
      method: 'POST', headers: { authorization: 'Bearer ' + t.key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: t.ttsModel || 'gpt-4o-mini-tts', voice: prefs.apiVoice || 'alloy', input: String(text).slice(0, 4000), response_format: 'wav' }),
    });
    if (!r.ok) throw await apiFail(r);
    return { wav: Buffer.from(await r.arrayBuffer()) };
  }
}

// Picks the engine from the voice settings: 'local' | 'api' | 'auto' (local when installed).
// The voice engines, by id. Listening: local (whisper.cpp), gemini, openai, groq, elevenlabs,
// azure, deepgram. Speaking: local (Piper), gemini, openai, elevenlabs, azure.
// "auto" = local when installed, otherwise the first service that has a key.
const cloud = require('./cloud');
const STT_ORDER = ['gemini', 'openai', 'groq', 'elevenlabs', 'azure', 'deepgram'];
const TTS_ORDER = ['gemini', 'openai', 'azure', 'elevenlabs'];
class Speech {
  // keys: { gemini(), openai(), groq(), elevenlabs(), azure() -> {key, region}, deepgram() } each returning null when not set up
  constructor({ assets, apiTarget, keys = {} }) {
    this.whisper = new LocalWhisper(assets);
    this.apiStt = new ApiSTT(apiTarget);
    this.piper = new LocalPiper(assets);
    this.apiTts = new ApiTTS(apiTarget);
    const k = name => { try { return keys[name] ? keys[name]() : null; } catch { return null; } };
    const geminiT = () => k('gemini'), openaiT = () => k('openai');
    const g = new ApiSTT(geminiT), o = new ApiSTT(openaiT), gt = new ApiTTS(geminiT), ot = new ApiTTS(openaiT);
    const wav = r => ({ wav: r.audio });
    this.stt = {
      local: this.whisper,
      gemini: { ready: () => !!geminiT(), transcribe: (w, o2) => g.transcribe(w, o2) },
      openai: { ready: () => !!openaiT(), transcribe: (w, o2) => o.transcribe(w, o2) },
      groq: { ready: () => !!k('groq'), transcribe: (w, o2) => cloud.groqTranscribe(k('groq'), w, o2) },
      elevenlabs: { ready: () => !!k('elevenlabs'), transcribe: (w, o2) => cloud.elevenTranscribe(k('elevenlabs'), w, o2) },
      azure: { ready: () => !!k('azure'), transcribe: (w, o2) => cloud.azureTranscribe(k('azure'), w, o2) },
      deepgram: { ready: () => !!k('deepgram'), transcribe: (w, o2) => cloud.deepgramTranscribe(k('deepgram'), w, o2) },
    };
    this.tts = {
      local: this.piper,
      gemini: { ready: () => !!geminiT(), speak: (t, o2) => gt.speak(t, o2) },
      openai: { ready: () => !!openaiT(), speak: (t, o2) => ot.speak(t, o2) },
      elevenlabs: { ready: () => !!k('elevenlabs'), speak: (t, o2) => cloud.elevenSpeak(k('elevenlabs'), t, { voice: (o2.prefs || {}).elevenVoice, model: (o2.prefs || {}).elevenModel }).then(wav) },
      azure: { ready: () => !!k('azure'), speak: (t, o2) => cloud.azureSpeak(k('azure'), t, { voice: (o2.lang === 'en' ? (o2.prefs || {}).azureEn || 'en-US-AndrewMultilingualNeural' : (o2.prefs || {}).azureFa || 'fa-IR-DilaraNeural') }).then(wav) },
    };
  }
  // which engines are usable now (for the panel)
  available() {
    const r = (set, lang) => Object.fromEntries(Object.entries(set).map(([id, e]) => [id, !!(id === 'local' && lang ? e.ready(lang) : e.ready())]));
    return { stt: r(this.stt), tts: r(this.tts, 'fa') };
  }
  pick(pref, local, api, offline, set, order) {
    if (pref === 'local' || offline) return local;
    if (pref === 'api') return api;
    if (set && set[pref]) {
      if (!set[pref].ready()) throw Object.assign(new Error(`برای «${NAMES[pref] || pref}» اول کلیدش را در بخش جارویس ← سرویس‌های صدا وارد کنید`), { notReady: true });
      return set[pref];
    }
    // free and local first; a paid service only when it is set up (a key exists); otherwise local,
    // which explains that the free parts are still downloading
    if (local.ready()) return local;
    if (api.ready()) return api;
    const other = set && order && order.map(id => set[id]).find(e => e.ready());
    return other || local;
  }
  // offline: never use a service. When the service cannot be reached or is busy, fall back to the local engine (fellBack: true).
  async transcribe(wav, { engine = 'auto', lang, offline = false, hint = '' } = {}) {
    let e = this.pick(engine, this.whisper, this.apiStt, offline, this.stt, STT_ORDER);
    const t0 = Date.now();
    let r, fellBack = false;
    try { r = await e.transcribe(wav, { lang, hint }); }
    catch (err) { if (e === this.whisper || !(isNetError(err) || err.busy) || !this.whisper.ready()) throw err; e = this.whisper; fellBack = true; r = await e.transcribe(wav, { lang, hint }); }
    return { ...r, lang: detectLang(r.text), ms: Date.now() - t0, engine: e === this.whisper ? 'local' : this.idOf(this.stt, e), fellBack };
  }
  async speak(text, { engine = 'auto', lang, prefs, offline = false } = {}) {
    let e = this.pick(engine, this.piper, this.apiTts, offline, this.tts, TTS_ORDER);
    const t0 = Date.now();
    const l = lang || detectLang(text);
    let r, fellBack = false;
    try { r = await e.speak(text, { lang: l, prefs: prefs || {} }); }
    catch (err) { if (e === this.piper || !(isNetError(err) || err.busy) || !this.piper.ready(l)) throw err; e = this.piper; fellBack = true; r = await e.speak(text, { lang: l, prefs }); }
    return { ...r, ms: Date.now() - t0, engine: e === this.piper ? 'local' : this.idOf(this.tts, e), fellBack };
  }
  idOf(set, e) { return (Object.entries(set).find(([, x]) => x === e) || ['api'])[0]; }
  stop() { this.whisper.stop(); }
}
const NAMES = { gemini: 'Google Gemini', openai: 'OpenAI', groq: 'Groq', elevenlabs: 'ElevenLabs', azure: 'Azure Speech', deepgram: 'Deepgram' };

// 16-bit PCM WAV from Float32 samples (used by tests).
function wavFromFloat32(samples, rate = 16000) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

module.exports = { NAMES: NAMES, STT_ORDER, TTS_ORDER, GEMINI_MODELS, wavFromPcm, Speech, LocalWhisper, LocalPiper, ApiSTT, ApiTTS, detectLang, wavFromFloat32 };
