// Cloud voice services beyond Gemini/OpenAI: ElevenLabs, Azure Speech (the Persian voices
// Dilara and Farid; free monthly quota), Groq (Whisper) and Deepgram. Every function returns the same shapes as
// speech.js: speak -> { audio: Buffer, mime }, transcribe -> { text }.
'use strict';

const fail = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, ...extra });
async function httpFail(r, name) {
  let t = ''; try { t = await r.text(); } catch {}
  let m = t; try { let j = JSON.parse(t); if (Array.isArray(j)) j = j[0]; m = (j.detail && (j.detail.message || j.detail)) || (j.error && (j.error.message || j.error)) || j.message || j.err_msg || t; } catch {}
  m = String(typeof m === 'object' ? JSON.stringify(m) : m).slice(0, 200);
  if (r.status === 401 || r.status === 403) return fail(r.status, `${name}: کلید پذیرفته نشد`);
  if (r.status === 429) return fail(429, `${name}: سهمیه یا محدودیت سرعت پر شده`, { busy: true });
  if (r.status >= 500) return fail(r.status, `${name} الان شلوغ است یا جواب نمی‌دهد`, { busy: true });
  return fail(r.status, `${name}: خطای ${r.status} — ${m}`, { modelGone: r.status === 404 || /model/i.test(m) });
}
async function net(url, opts, name) {
  try { return await fetch(url, { signal: AbortSignal.timeout(60000), ...opts }); }
  catch (e) { throw Object.assign(new Error(`${name}: وصل نشد (اینترنت یا فیلتر)`), { code: 'ENETUNREACH', busy: true }); }
}
const xml = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
function wavFromPcm(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------------- ElevenLabs ----------------
const ELEVEN = 'https://api.elevenlabs.io/v1';
const ELEVEN_TTS_MODELS = ['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5'];
const ELEVEN_STT_MODELS = ['scribe_v2', 'scribe_v1'];
async function elevenSpeak(key, text, { voice = 'JBFqnCBsd6RMkjVDRZzb', model } = {}) {
  let last;
  for (const m of [...new Set([model, ...ELEVEN_TTS_MODELS].filter(Boolean))]) {
    const r = await net(`${ELEVEN}/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text: String(text).slice(0, 3000), model_id: m }) }, 'ElevenLabs');
    if (r.ok) return { audio: wavFromPcm(Buffer.from(await r.arrayBuffer()), 24000), mime: 'audio/wav' };
    last = await httpFail(r, 'ElevenLabs'); if (!last.modelGone) throw last;
  }
  throw last;
}
async function elevenTranscribe(key, wav, { lang } = {}) {
  let last;
  for (const m of ELEVEN_STT_MODELS) {
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav'); fd.append('model_id', m);
    if (lang === 'fa') fd.append('language_code', 'fas'); else if (lang === 'en') fd.append('language_code', 'eng');
    const r = await net(`${ELEVEN}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key }, body: fd }, 'ElevenLabs');
    if (r.ok) { const j = await r.json(); return { text: String(j.text || '').trim() }; }
    last = await httpFail(r, 'ElevenLabs'); if (!last.modelGone) throw last;
  }
  throw last;
}
async function elevenVoices(key) {
  const r = await net(`${ELEVEN}/voices`, { headers: { 'xi-api-key': key } }, 'ElevenLabs');
  if (!r.ok) throw await httpFail(r, 'ElevenLabs');
  return ((await r.json()).voices || []).map(v => [v.voice_id, v.name]);
}

// ---------------- Azure Speech (key + region) ----------------
const AZURE_VOICES = { fa: [['fa-IR-DilaraNeural', 'دلارا (زن)'], ['fa-IR-FaridNeural', 'فرید (مرد)']], en: [['en-US-AndrewMultilingualNeural', 'Andrew'], ['en-US-AvaMultilingualNeural', 'Ava'], ['en-US-EmmaMultilingualNeural', 'Emma'], ['en-GB-RyanNeural', 'Ryan (UK)'], ['en-GB-SoniaNeural', 'Sonia (UK)']] };
async function azureSpeak({ key, region }, text, { voice = 'fa-IR-DilaraNeural' } = {}) {
  const lang = /^fa-/.test(voice) ? 'fa-IR' : 'en-US';
  const r = await net(`https://${encodeURIComponent(region)}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'JARVIS' },
    body: `<speak version='1.0' xml:lang='${lang}'><voice name='${xml(voice)}'>${xml(String(text).slice(0, 3000))}</voice></speak>` }, 'Azure');
  if (!r.ok) throw await httpFail(r, 'Azure');
  return { audio: Buffer.from(await r.arrayBuffer()), mime: 'audio/wav' };
}
async function azureTranscribe({ key, region }, wav, { lang } = {}) {
  const code = lang === 'en' ? 'en-US' : 'fa-IR';
  const r = await net(`https://${encodeURIComponent(region)}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${code}&format=simple`, { method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000' }, body: wav }, 'Azure');
  if (!r.ok) throw await httpFail(r, 'Azure');
  const j = await r.json();
  return { text: String(j.DisplayText || '').trim() };
}

// ---------------- Groq (Whisper, OpenAI-compatible) ----------------
async function groqTranscribe(key, wav, { lang, hint } = {}) {
  let last;
  for (const m of ['whisper-large-v3-turbo', 'whisper-large-v3']) {
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav'); fd.append('model', m); fd.append('temperature', '0');
    if (lang && lang !== 'auto') fd.append('language', lang);
    if (hint) fd.append('prompt', hint);
    const r = await net('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: fd }, 'Groq');
    if (r.ok) return { text: String((await r.json()).text || '').trim() };
    last = await httpFail(r, 'Groq'); if (!last.modelGone) throw last;
  }
  throw last;
}

// ---------------- Deepgram ----------------
async function deepgramTranscribe(key, wav, { lang } = {}) {
  const q = lang === 'en' ? 'model=nova-3&language=en' : lang === 'fa' ? 'model=whisper-large&language=fa' : 'model=nova-3&detect_language=true';
  const r = await net(`https://api.deepgram.com/v1/listen?${q}&smart_format=true`, { method: 'POST', headers: { authorization: 'Token ' + key, 'content-type': 'audio/wav' }, body: wav }, 'Deepgram');
  if (!r.ok) throw await httpFail(r, 'Deepgram');
  const j = await r.json();
  return { text: String((((j.results || {}).channels || [])[0] || { alternatives: [{}] }).alternatives[0].transcript || '').trim() };
}

module.exports = { elevenSpeak, elevenTranscribe, elevenVoices, azureSpeak, azureTranscribe, AZURE_VOICES, groqTranscribe, deepgramTranscribe, wavFromPcm };
