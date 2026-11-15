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
  async transcribe(wav, { lang } = {}) {
    await this.ensure();
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    fd.append('response_format', 'json');
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
  return new Error(r.status === 401 ? 'کلید API پذیرفته نشد' : `خطای ${r.status}: ${String(m).slice(0, 200)}`); }

// ---- Google Gemini (speech to text through a normal model; text to speech with a TTS model) ----
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
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
async function geminiTranscribe(t, wav, lang) {
  const say = lang === 'fa' ? 'The speech is Persian (Farsi).' : lang === 'en' ? 'The speech is English.' : 'The speech is Persian (Farsi) or English.';
  const parts = await gemini(t, t.sttModel || 'gemini-2.5-flash', { contents: [{ role: 'user', parts: [{ text: `Transcribe this audio exactly as spoken. ${say} Output only the transcript, in the original language and script, with no notes. If there is no speech, output nothing.` }, { inline_data: { mime_type: 'audio/wav', data: Buffer.from(wav).toString('base64') } }] }], generationConfig: { temperature: 0 } });
  return { text: parts.map(p => p.text || '').join('').trim() };
}
async function geminiSpeak(t, text, voice) {
  const parts = await gemini(t, t.ttsModel || 'gemini-2.5-flash-preview-tts', { contents: [{ role: 'user', parts: [{ text: String(text).slice(0, 4000) }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } } } });
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
  async transcribe(wav, { lang } = {}) {
    const t = this.getTarget();
    if (!t) throw new Error('برای گفتار با API، یک اتصال Gemini یا OpenAI با کلید در «هسته‌ی هوش مصنوعی» لازم است');
    if (t.kind === 'gemini') return geminiTranscribe(t, wav, lang);
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    fd.append('model', t.sttModel || 'gpt-4o-transcribe');
    if (lang && lang !== 'auto') fd.append('language', lang);
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
class Speech {
  constructor({ assets, apiTarget }) {
    this.whisper = new LocalWhisper(assets);
    this.apiStt = new ApiSTT(apiTarget);
    this.piper = new LocalPiper(assets);
    this.apiTts = new ApiTTS(apiTarget);
  }
  pick(pref, local, api, offline) {
    if (pref === 'local' || offline) return local;
    if (pref === 'api') return api;
    // free and local first; the paid API only when it is set up (a key exists); otherwise local,
    // which explains that the free parts are still downloading
    if (local.ready()) return local;
    return api.ready() ? api : local;
  }
  // offline: never use the API. When the API cannot be reached, fall back to the local engine (fellBack: true).
  async transcribe(wav, { engine = 'auto', lang, offline = false } = {}) {
    let e = this.pick(engine, this.whisper, this.apiStt, offline);
    const t0 = Date.now();
    let r, fellBack = false;
    try { r = await e.transcribe(wav, { lang }); }
    catch (err) { if (e === this.whisper || !isNetError(err) || !this.whisper.ready()) throw err; e = this.whisper; fellBack = true; r = await e.transcribe(wav, { lang }); }
    return { ...r, lang: detectLang(r.text), ms: Date.now() - t0, engine: e === this.whisper ? 'local' : 'api', fellBack };
  }
  async speak(text, { engine = 'auto', lang, prefs, offline = false } = {}) {
    let e = this.pick(engine, this.piper, this.apiTts, offline);
    const t0 = Date.now();
    const l = lang || detectLang(text);
    let r, fellBack = false;
    try { r = await e.speak(text, { lang: l, prefs }); }
    catch (err) { if (e === this.piper || !isNetError(err) || !this.piper.ready(l)) throw err; e = this.piper; fellBack = true; r = await e.speak(text, { lang: l, prefs }); }
    return { ...r, ms: Date.now() - t0, engine: e === this.piper ? 'local' : 'api', fellBack };
  }
  stop() { this.whisper.stop(); }
}

// 16-bit PCM WAV from Float32 samples (used by tests).
function wavFromFloat32(samples, rate = 16000) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

module.exports = { wavFromPcm, Speech, LocalWhisper, LocalPiper, ApiSTT, ApiTTS, detectLang, wavFromFloat32 };
