// Voice assistant in the panel: microphone, "Hey Jarvis" (English model + Persian check through
// local speech-to-text), end-of-speech detection, the conversation, spoken replies.
// Nothing is recorded or sent anywhere until the wake word, the hotkey or the mic button.
import { WakeWord, resample, CHUNK } from './wakeword.js';

const S = window.JARVIS_STATE;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const fa = n => (+n || 0).toLocaleString('fa-IR');
const api = (...a) => window.api(...a);
const WAKE_TEXT = /(جارویس|جاروس|جارویز|جاروِیس|jarvis|jervis)/i;

const V = {
  state: 'off',            // off | idle | recording | thinking | speaking
  stream: null, ctx: null, node: null, src: null,
  ww: null, wwError: null,
  buf: [],                 // recorded 16 kHz samples while recording
  pre: [],                 // last ~1 s before the wake word (so the first word isn't cut)
  noise: 0.004, speechMs: 0, silenceMs: 0, recMs: 0, heardSpeech: false,
  idleSeg: [], idleSegMs: 0, idleVoiced: false, idleSilence: 0, faChecking: false,
  audio: null, followUp: false, lastLevel: 0, lastWakeAt: 0, log: [],
};
const settings = () => S.settings || {};

// ---------- audio plumbing ----------
const WORKLET = `class P extends AudioWorkletProcessor { process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor('jarvis-mic', P);`;

async function startMic() {
  if (V.stream) return;
  const id = settings().voiceMicId;
  V.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  V.ctx = new AudioContext({ sampleRate: 16000 });
  await V.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
  V.src = V.ctx.createMediaStreamSource(V.stream);
  V.node = new AudioWorkletNode(V.ctx, 'jarvis-mic');
  let acc = new Float32Array(0);
  const rate = V.ctx.sampleRate;
  V.node.port.onmessage = e => {
    const x = rate === 16000 ? e.data : resample(e.data, rate, 16000);
    const n = new Float32Array(acc.length + x.length); n.set(acc); n.set(x, acc.length); acc = n;
    while (acc.length >= CHUNK) { const c = acc.slice(0, CHUNK); acc = acc.slice(CHUNK); onChunk(c); }
  };
  V.src.connect(V.node);
}
function stopMic() {
  try { V.src && V.src.disconnect(); V.node && V.node.disconnect(); } catch {}
  if (V.stream) V.stream.getTracks().forEach(t => t.stop());
  if (V.ctx) V.ctx.close().catch(() => {});
  V.stream = V.ctx = V.node = V.src = null;
}

async function loadWakeWord() {
  if (V.ww || V.wwError) return;
  try {
    const ort = await import('../vendor/ort/ort.wasm.min.mjs');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
    const tok = (() => { try { return localStorage.getItem('jarvis.token') || ''; } catch { return ''; } })();
    V.ww = await WakeWord.create(ort, async n => {
      const r = await fetch('/api/voice/model/' + n, { headers: { 'x-jarvis': '1', ...(tok ? { 'x-jarvis-token': tok } : {}) } });
      if (!r.ok) throw new Error('model ' + n);
      return r.arrayBuffer();
    });
  } catch (e) { V.wwError = e.message; }
}

// ---------- per 80 ms of audio ----------
const rms = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
function onChunk(c) {
  const level = rms(c);
  V.lastLevel = level;
  meter(level);
  const loud = level > Math.max(0.012, V.noise * 3);
  if (V.state === 'idle') {
    if (!loud) V.noise = V.noise * 0.95 + level * 0.05; // track background noise while quiet
    V.pre.push(c); if (V.pre.length > 12) V.pre.shift();
    if (settings().voiceWake !== false) {
      if (V.ww) V.ww.push(c).then(score => { if (score != null && score > (+settings().voiceWakeThreshold || 0.5) && V.state === 'idle') wake('en'); }).catch(() => {});
      idleSegment(c, loud);
    }
  } else if (V.state === 'recording') {
    V.buf.push(c);
    V.recMs += 80;
    if (loud) { V.speechMs += 80; V.silenceMs = 0; if (V.speechMs >= 160) V.heardSpeech = true; } else V.silenceMs += 80;
    const quietEnd = V.heardSpeech && V.silenceMs >= 900;
    const nothing = !V.heardSpeech && V.recMs >= (V.followUp ? 5000 : 7000);
    if (quietEnd || V.recMs >= (V.gpu || !V.localStt ? 25000 : 10000)) finishRecording(); // the local CPU model hears at most 10 s at once
    else if (nothing) { V.followUp = false; setState('idle', V.followUp ? '' : 'چیزی نشنیدم.'); }
  }
}

// Persian wake word: short phrases heard while idle go through LOCAL speech-to-text only,
// and wake JARVIS when they contain «جارویس». Nothing leaves this computer.
function idleSegment(c, loud) {
  if (!V.localStt || V.faChecking) return;
  if (loud) { V.idleVoiced = true; V.idleSilence = 0; }
  if (V.idleVoiced) { V.idleSeg.push(c); V.idleSegMs += 80; if (!loud) V.idleSilence += 80; }
  if (V.idleVoiced && V.idleSilence >= 500) {
    const seg = V.idleSeg, ms = V.idleSegMs;
    V.idleSeg = []; V.idleSegMs = 0; V.idleVoiced = false; V.idleSilence = 0;
    if (ms < 400 || ms > 4000) return;
    V.faChecking = true;
    stt(concat(seg), 'local', 'fa').then(r => {
      const m = WAKE_TEXT.exec(r.text || '');
      if (m && V.state === 'idle') {
        const rest = (r.text.slice(m.index + m[0].length) || '').replace(/^[\s,.،!?؟]+/, '').trim();
        if (rest.split(/\s+/).length >= 2) { addLog('user', r.text); ask(rest); } // «جارویس، ساعت چنده؟» in one breath
        else wake('fa');
      }
    }).catch(() => {}).finally(() => { V.faChecking = false; });
  } else if (V.idleSegMs > 4000) { V.idleSeg = []; V.idleSegMs = 0; V.idleVoiced = false; }
}

function wake(lang) {
  if (Date.now() - V.lastWakeAt < 1500) return;
  V.lastWakeAt = Date.now();
  if (V.ww) V.ww.reset();
  beep(880, 0.08);
  startRecording(false);
  setHint(lang === 'fa' ? 'بله؟ بفرمایید…' : 'Yes? I\'m listening…');
}
function startRecording(followUp) {
  stopSpeaking();
  V.buf = followUp ? [] : V.pre.slice(-4); V.pre = [];
  V.speechMs = 0; V.silenceMs = 0; V.recMs = 0; V.heardSpeech = false; V.followUp = !!followUp;
  setState('recording');
}
async function finishRecording() {
  const samples = concat(V.buf); V.buf = [];
  setState('thinking', 'در حال شنیدن…');
  try {
    const r = await stt(samples);
    if (!r.text || r.text.replace(/[\s.,!?؟،]/g, '').length < 2) { setState('idle', 'متوجه نشدم.'); return; }
    addLog('user', r.text);
    await ask(r.text);
  } catch (e) { setState('idle'); addLog('error', e.message); }
}

// ---------- server round trips ----------
function wav16(samples) {
  const b = new ArrayBuffer(44 + samples.length * 2), d = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); d.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, 16000, true); d.setUint32(28, 32000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(b);
}
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const concat = arr => { const n = arr.reduce((t, a) => t + a.length, 0), o = new Float32Array(n); let p = 0; for (const a of arr) { o.set(a, p); p += a.length; } return o; };
function stt(samples, engine, lang) { return api('/voice/stt', { body: { audio: b64(wav16(samples)), ...(engine ? { engine } : {}), ...(lang ? { lang } : {}) } }); }

async function ask(text) {
  setState('thinking', 'در حال فکر کردن…');
  let r;
  try { r = await api('/voice/ask', { body: { text } }); }
  catch (e) { addLog('error', e.message); setState('idle'); speakText(/[؀-ۿ]/.test(text) ? 'متأسفم، الان نتوانستم جواب بدهم.' : 'Sorry, I could not answer right now.'); return; }
  handleReply(r);
}
function handleReply(r) {
  if (r.brain) setNet(!r.brain.offline, r.brain.offline);
  if (r.say) addLog('jarvis', r.say);
  if (r.say && window.jarvisDesktop && window.jarvisDesktop.voice) window.jarvisDesktop.voice({ state: 'speaking', label: 'در حال صحبت', reply: r.say });
  if (r.result) doResult(r.result);
  renderConfirm(r.confirm ? r.action : null);
  speakText(r.say, { thenListen: r.confirm || /[?؟]\s*$/.test(r.say || '') });
}
function doResult(res) {
  if (!res) return;
  if (res.ok === false) { addLog('error', res.error); return; }
  if (res.open) openSection(res.open);
  if (res.chatId) window.selectProject && res.projectId && window.selectProject(res.projectId), window.openChat && window.openChat(res.chatId);
  if (res.task) window.toast && window.toast('تسک: ' + res.task.title);
}
function openSection(o) {
  const go = {
    home: () => (window.showSection ? window.showSection('cc') : window.goHome && window.goHome()), settings: () => window.settingsDialog && window.settingsDialog('global'),
    connectors: () => window.extDialog && window.extDialog('connectors'), plugins: () => window.extDialog && window.extDialog('plugins'),
    queue: () => window.queueDialog && window.queueDialog(), ops: () => window.openOps && window.openOps(), voice: () => voiceDialog(),
    chat: () => o.chat && window.openChat && window.openChat(o.chat),
  }[o.section];
  if (go) go();
}

// ---------- speaking ----------
async function speakText(text, { thenListen = false } = {}) {
  if (!text || settings().voiceSpeak === false) { afterSpeech(thenListen); return; }
  setState('speaking');
  try {
    const r = await api('/voice/tts', { body: { text } });
    if (V.state !== 'speaking') return;
    const bytes = Uint8Array.from(atob(r.audio), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const a = V.audio = new Audio(url);
    a.onended = () => { URL.revokeObjectURL(url); if (V.audio === a) { V.audio = null; afterSpeech(thenListen || true); } };
    await a.play();
  } catch (e) {
    // free voice still downloading: say it once, quietly, and keep answering in text
    if (/هنوز دانلود نشده/.test(e.message)) { if (!V.ttsNoted) { V.ttsNoted = true; setHint(e.message); } }
    else addLog('error', 'پخش صدا: ' + e.message);
    if (V.state === 'speaking') setState('idle');
    afterSpeech(thenListen);
  }
}
function stopSpeaking() { if (V.audio) { V.audio.pause(); V.audio = null; } }
// after an answer, listen a few seconds for a follow-up without the wake word
function afterSpeech(listen) {
  if (V.state === 'off') return;
  if (listen && V.stream) { setTimeout(() => { if (V.state === 'speaking' || V.state === 'thinking' || V.state === 'idle') startRecording(true); }, 250); }
  else setState('idle');
}
function beep(f, d) { try { const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(); o.frequency.value = f; g.gain.value = 0.06; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + d); o.onended = () => c.close(); } catch {} }

// ---------- UI ----------
function ui() {
  let el = $('#voiceDock');
  if (el) return el;
  el = document.createElement('section');
  el.id = 'voiceDock'; el.className = 'voice-dock'; el.hidden = true;
  el.setAttribute('aria-label', 'دستیار صوتی');
  el.innerHTML = `<div class="vd-orb" id="vdOrb"><canvas id="vdWave" width="120" height="120"></canvas></div>
    <div class="vd-main"><div class="vd-state"><span id="vdState"></span><span class="vd-net" id="vdNet" hidden></span></div><div class="vd-hint" id="vdHint" dir="auto"></div>
      <div class="vd-confirm" id="vdConfirm" hidden></div></div>
    <div class="vd-acts"><button type="button" class="icon-btn" id="vdTalk" title="صحبت (Ctrl+Space)" aria-label="صحبت">${ic('mic')}</button>
      <button type="button" class="icon-btn" id="vdStop" title="قطع" aria-label="قطع">${ic('circle-stop')}</button>
      <button type="button" class="icon-btn" id="vdSettings" title="تنظیمات صدا" aria-label="تنظیمات صدا">${ic('settings')}</button>
      <button type="button" class="icon-btn" id="vdClose" title="خاموش کردن دستیار صوتی" aria-label="خاموش">${ic('x')}</button></div>`;
  document.body.appendChild(el);
  el.querySelector('#vdTalk').onclick = () => { if (V.state === 'recording') finishRecording(); else start(true); };
  el.querySelector('#vdStop').onclick = () => { stopSpeaking(); if (V.state !== 'off') setState('idle'); };
  el.querySelector('#vdSettings').onclick = () => voiceDialog();
  el.querySelector('#vdClose').onclick = () => stop();
  return el;
}
const STATE_FA = { off: 'خاموش', idle: 'منتظر «هی جارویس»', recording: 'در حال گوش دادن…', thinking: 'در حال فکر کردن…', speaking: 'در حال صحبت…' };
function setState(s, hint) {
  V.state = s;
  const el = ui();
  el.hidden = s === 'off';
  el.dataset.state = s;
  el.querySelector('#vdState').textContent = STATE_FA[s] + (s === 'idle' && settings().voiceWake === false ? '' : '');
  if (s === 'idle' && settings().voiceWake === false) el.querySelector('#vdState').textContent = 'آماده — Ctrl+Space یا دکمه‌ی میکروفون';
  if (hint !== undefined) setHint(hint);
  if (window.jarvisDesktop && window.jarvisDesktop.voice) window.jarvisDesktop.voice({ state: s, label: STATE_FA[s] });
  const b = $('#btnVoice'); if (b) { b.classList.toggle('on', s !== 'off'); b.dataset.state = s; b.title = s === 'off' ? 'دستیار صوتی (خاموش)' : 'دستیار صوتی — ' + STATE_FA[s] + ' · میکروفون روشن است'; }
}
// online / offline badge on the dock
const MODE_FA = { auto: 'خودکار', online: 'آنلاین', offline: 'آفلاین' };
function setNet(online, brainOffline) {
  const b = $('#vdNet'); if (!b) return;
  const mode = settings().voiceMode || 'auto';
  const off = mode === 'offline' || online === false || !!brainOffline;
  b.hidden = false; b.dataset.net = off ? 'off' : 'on';
  b.textContent = off ? 'آفلاین' : 'آنلاین';
  b.title = 'حالت اتصال: ' + MODE_FA[mode] + (mode === 'auto' ? (off ? ' — الان اینترنت نیست، با اجزای محلی کار می‌کند' : ' — الان آنلاین') : '');
}
function setHint(t) { const h = $('#vdHint'); if (h) h.textContent = t || ''; }
function renderConfirm(action) {
  const box = $('#vdConfirm'); if (!box) return;
  box.hidden = !action;
  if (!action) { box.innerHTML = ''; return; }
  box.innerHTML = `<span>${ic('triangle-alert', 'sm')}انجام بدهم؟ «بله» یا «نه» بگویید.</span><button type="button" class="btn small primary" data-vyes="1">بله</button><button type="button" class="btn small ghost" data-vno="1">نه</button>`;
  box.onclick = async e => {
    const yes = !!e.target.closest('[data-vyes]'), no = !!e.target.closest('[data-vno]');
    if (!yes && !no) return;
    renderConfirm(null);
    try { const r = await api('/voice/confirm', { body: { yes } }); if (r.result) doResult(r.result); addLog('jarvis', yes ? 'انجام شد.' : 'لغو شد.'); } catch (err) { addLog('error', err.message); }
    if (V.state === 'recording') setState('idle');
  };
}
let raf = 0;
function meter(level) {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const c = $('#vdWave'); if (!c) return;
    const g = c.getContext('2d'), w = c.width, h = c.height, t = performance.now() / 1000;
    g.clearRect(0, 0, w, h);
    const col = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#7dd3fc';
    const amp = V.state === 'speaking' ? 0.5 + 0.4 * Math.abs(Math.sin(t * 9)) : Math.min(1, V.lastLevel * 18);
    g.strokeStyle = col; g.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      g.globalAlpha = 1 - k * 0.3;
      g.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const r = 30 + k * 6 + amp * 14 * Math.sin(a * (3 + k) + t * (2 + k));
        const x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath(); g.stroke();
    }
    g.globalAlpha = 1;
  });
}
function addLog(who, text) {
  V.log.push({ who, text, ts: Date.now() }); if (V.log.length > 100) V.log.shift();
  if (who === 'error') setHint('⚠ ' + text); else setHint(text);
  const l = document.getElementById('vLog'); if (l) l.innerHTML = logHtml();
}
const logHtml = () => V.log.slice().reverse().map(l => `<div class="vl ${l.who}"><b>${l.who === 'user' ? 'شما' : l.who === 'jarvis' ? 'جارویس' : 'خطا'}</b><span dir="auto">${esc(l.text)}</span></div>`).join('') || '<div class="help">هنوز گفتگویی نشده.</div>';

// ---------- on / off ----------
async function start(talkNow) {
  try {
    if (!settings().voiceEnabled) await api('/settings', { body: { voiceEnabled: true } });
    ui(); setState('idle', 'در حال آماده شدن…');
    await startMic();
    let st = await api('/voice/status');
    V.localStt = st.stt.local; V.gpu = st.stt.gpu;
    if (await autoSetup(st)) st = await api('/voice/status');
    setNet(st.online, false);
    api('/voice/warm', { body: {} }).catch(() => {}); // load the offline model in the background
    if (settings().voiceWake !== false && st.assets.wakeword.installed) await loadWakeWord();
    setState('idle', V.wwError ? 'تشخیص «هی جارویس» بار نشد: ' + V.wwError : !st.assets.wakeword.installed && settings().voiceWake !== false ? 'برای «هی جارویس» مدلش را از تنظیمات صدا دانلود کنید. فعلاً Ctrl+Space.' : '');
    if (talkNow) startRecording(false);
  } catch (e) {
    stopMic(); setState('off');
    window.toast && window.toast(e.name === 'NotAllowedError' ? 'اجازه‌ی میکروفون داده نشد.' : e.name === 'NotFoundError' ? 'میکروفونی پیدا نشد.' : 'دستیار صوتی: ' + e.message, true);
  }
}
// First run: download the parts the assistant needs to listen and answer offline (once; official sources).
// "Hey JARVIS" (4 MB) first so wake-up works at once; then speech engine, accurate Persian model, voice.
const ESSENTIAL = ['wakeword', 'whisper-bin', 'piper-bin', 'voice-fa-amir', 'voice-en-lessac', 'whisper-turbo'];
async function autoSetup(st) {
  if (settings().voiceAutoSetup) return false;
  const missing = ESSENTIAL.filter(id => st.assets[id] && !st.assets[id].installed && !st.assets[id].downloading);
  try { S.settings = await api('/settings', { body: { voiceAutoSetup: true } }); } catch {}
  if (!missing.length) return false;
  for (const id of missing) { try { await api('/voice/download', { body: { id } }); } catch {} }
  V.setupIds = missing;
  setHint('دستیار صوتی در حال آماده شدن است (دانلود اجزای آفلاین، فقط بار اول)…');
  return true;
}
// progress of the first-run download on the dock, and switch things on as parts arrive
window.addEventListener('jarvis:ev', async e => {
  const ev = e.detail;
  if (ev.type !== 'voiceAssets' || !V.setupIds || V.state === 'off') return;
  const a = ev.assets, ids = V.setupIds;
  const tot = ids.reduce((t, id) => t + (a[id].total || a[id].size || 0), 0), got = ids.reduce((t, id) => t + (a[id].installed ? (a[id].size || 0) : a[id].got || 0), 0);
  if (a.wakeword && a.wakeword.installed && !V.ww && settings().voiceWake !== false) { try { await loadWakeWord(); } catch {} }
  if (ids.every(id => a[id].installed || a[id].error)) {
    V.setupIds = null;
    const st = await api('/voice/status'); V.localStt = st.stt.local;
    setHint(ids.some(id => a[id].error) ? 'بعضی اجزا دانلود نشدند؛ از تنظیمات صدا دوباره امتحان کنید.' : 'دستیار صوتی آماده است. بگویید «هی جارویس».');
  } else if (V.state === 'idle') setHint('آماده‌سازی دستیار صوتی (فقط بار اول): ' + fa(Math.round(got / Math.max(1, tot) * 100)) + '٪');
});

async function stop() {
  stopSpeaking(); stopMic(); setState('off');
  try { await api('/settings', { body: { voiceEnabled: false } }); } catch {}
}

// ---------- settings dialog ----------
const MB = n => fa(Math.round(n / 1e6)) + ' مگابایت';
async function voiceDialog() {
  let st; try { st = await api('/voice/status'); } catch (e) { window.toast(e.message, true); return; }
  const s = settings();
  let mics = [];
  try { mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); } catch {}
  const a = st.assets;
  const row = (id, extra = '') => { const x = a[id]; return `<div class="va-row"><span dir="auto">${esc(x.label)}</span><span class="help">${MB(x.size)}</span>
    ${x.installed ? `<span class="ok">${ic('circle-check', 'sm')}نصب است</span><button type="button" class="btn small ghost danger" data-vdel="${id}">حذف</button>`
      : x.downloading ? `<progress max="${x.total}" value="${x.got}"></progress><span class="help">${fa(Math.round(x.got / x.total * 100))}٪</span>`
      : `<button type="button" class="btn small" data-vdl="${id}">${ic('download', 'sm')}دانلود</button>${x.error ? `<span class="bad">${esc(x.error)}</span>` : ''}`}${extra}</div>`; };
  const opts = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const ol = st.ollama || { models: [], suggested: [], pulls: {} };
  const olModels = ol.models.map(x => [x.name, x.name + ' — ' + fa((x.size / 1e9).toFixed(1)) + ' گیگ']);
  const olHtml = !ol.installed ? `<div class="va-tip">${ic('download', 'sm')} برای «مغز آفلاین»، برنامه‌ی رایگان Ollama را نصب کنید: <a href="${esc(ol.downloadUrl)}" target="_blank" rel="noopener" dir="ltr">ollama.com/download</a> — بعد این پنجره را دوباره باز کنید.</div>`
    : `${!ol.running ? `<div class="help">Ollama نصب است ولی اجرا نشده. <button type="button" class="btn small" id="vOlStart">${ic('play', 'sm')}اجرای Ollama</button></div>` : ''}
      <div class="va-list">${ol.suggested.map(x => { const have = ol.models.some(mm => mm.name === x.name); const p = ol.pulls[x.name];
        return `<div class="va-row" data-olrow="${esc(x.name)}"><span dir="ltr">${esc(x.name)}</span><span class="help">${fa((x.size / 1e9).toFixed(1))} گیگ · ${esc(x.note)}</span>
        ${have ? `<span class="ok">${ic('circle-check', 'sm')}نصب است</span>` : p && !p.done && !p.error ? `<progress max="${p.total || 1}" value="${p.completed || 0}"></progress><span class="help pct">${p.total ? fa(Math.round(p.completed / p.total * 100)) + '٪' : esc(p.status)}</span>`
          : `<button type="button" class="btn small" data-olpull="${esc(x.name)}">${ic('download', 'sm')}دانلود</button>${p && p.error ? `<span class="bad">${esc(p.error)}</span>` : ''}`}</div>`; }).join('')}</div>`;
  const models = window.modelOptions ? window.modelOptions('claude', s.voiceModel).filter(([k]) => k && k !== '__custom') : [[s.voiceModel, s.voiceModel]];
  window.dialog(`<div class="dlg-scroll"><h3>${ic('mic')}دستیار صوتی</h3>
    <p class="help">${ic('lock', 'sm')} تا «هی جارویس» نگویید یا Ctrl+Space نزنید، هیچ صدایی ضبط یا جایی فرستاده نمی‌شود. تشخیص «هی جارویس» کاملاً روی همین کامپیوتر است.</p>
    <h4>آنلاین یا آفلاین</h4>
    <div class="field"><label>حالت اتصال</label><select id="vMode">${opts([['auto', 'خودکار — با اینترنت آنلاین، بدون اینترنت آفلاین (پیشنهادی)'], ['online', 'همیشه آنلاین — سریع‌تر و دقیق‌تر'], ['offline', 'همیشه آفلاین — هیچ چیز از این کامپیوتر بیرون نمی‌رود']], s.voiceMode || 'auto')}</select></div>
    <div class="help">الان: ${s.voiceMode === 'offline' ? 'آفلاین' : st.online ? '<span class="ok">اینترنت وصل است</span>' : '<span class="bad">اینترنت در دسترس نیست</span>'}. «هی جارویس» همیشه آفلاین است.</div>
    <div class="field-row"><div class="field"><label>مغز آنلاین</label><select id="vModel" dir="ltr">${opts(models, s.voiceModel)}</select></div>
      <div class="field"><label>مغز آفلاین (Ollama)</label><select id="vModelOff" dir="ltr">${opts([['', olModels.length ? '— انتخاب کنید —' : '— هنوز مدلی نصب نیست —'], ...olModels], s.voiceModelOffline || '')}</select></div></div>
    ${olHtml}
    <h4>صدا</h4>
    <div class="field-row"><div class="field"><label>میکروفون</label><select id="vMic">${opts([['', 'پیش‌فرض ویندوز'], ...mics.map(m => [m.deviceId, m.label || 'میکروفون'])], s.voiceMicId)}</select></div></div>
    <div class="field-row"><div class="field"><label>گفتار به متن</label><select id="vStt">${opts([['auto', 'خودکار (محلی اگر نصب باشد)'], ['local', 'آفلاین — whisper.cpp، رایگان'], ['api', 'آنلاین — API (Gemini یا OpenAI)']], s.voiceStt)}</select></div>
      <div class="field"><label>متن به گفتار</label><select id="vTts">${opts([['auto', 'خودکار (محلی اگر نصب باشد)'], ['local', 'آفلاین — Piper، رایگان'], ['api', 'آنلاین — API (Gemini یا OpenAI)']], s.voiceTts)}</select></div></div>
    <div class="field-row"><div class="field"><label>صدای فارسی (محلی)</label><select id="vFa">${opts([['voice-fa-amir', 'امیر'], ['voice-fa-gyro', 'ژیرو']], s.voiceFaVoice)}</select></div>
      <div class="field"><label>صدای OpenAI</label><select id="vApiVoice" dir="ltr">${opts(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map(x => [x, x]), s.voiceApiVoice)}</select></div></div>
    <div class="field-row"><div class="field"><label>سرویس API صدا</label><select id="vApi">${opts([['auto', 'خودکار — Gemini اگر کلید دارد، وگرنه OpenAI'], ['gemini', 'Google Gemini'], ['openai', 'OpenAI']], s.voiceApi || 'auto')}</select>${st.hasGemini ? '' : '<div class="help">برای Gemini: «هسته‌ی هوش مصنوعی» ← افزودن Google Gemini با کلید (رایگان از aistudio.google.com/apikey).</div>'}</div>
      <div class="field"><label>صدای Gemini</label><select id="vGemVoice" dir="ltr">${opts(['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Sulafat', 'Achird'].map(x => [x, x]), s.voiceGeminiVoice || 'Kore')}</select></div></div>
    <div class="field"><label>زبان گفتار</label><select id="vLang">${opts([['auto', 'خودکار فارسی/انگلیسی (کمی کندتر)'], ['fa', 'فقط فارسی (سریع‌تر)'], ['en', 'فقط انگلیسی (سریع‌تر)']], s.voiceLang || 'auto')}</select></div>
    <label class="check"><input type="checkbox" id="vWake" ${s.voiceWake !== false ? 'checked' : ''}> با گفتن «هی جارویس» بیدار شود</label>
    <div class="field"><label>حساسیت «هی جارویس» (${fa(Math.round((+s.voiceWakeThreshold || 0.5) * 100))}٪ — کمتر = حساس‌تر)</label><input id="vThr" type="range" min="0.2" max="0.9" step="0.05" value="${+s.voiceWakeThreshold || 0.5}"></div>
    <label class="check"><input type="checkbox" id="vSpeak" ${s.voiceSpeak !== false ? 'checked' : ''}> جواب‌ها را بلند بخواند</label>
    <h4>اجزای آفلاین</h4>
    <div class="help">برای فارسی خوب، «مدل گفتار دقیق» را بگیرید. «هی جارویس» فارسی هم با همین مدل محلی تشخیص داده می‌شود.</div>
    ${st.nvidia && !a['whisper-cuda'].installed ? `<div class="va-tip">${ic('zap', 'sm')} کارت گرافیک <b dir="ltr">${esc(st.nvidia)}</b> دارید: «موتور گفتار روی کارت گرافیک» را بگیرید تا تشخیص گفتار حدود ۲۰ برابر سریع‌تر شود (کمتر از نیم ثانیه).</div>` : ''}
    <div class="va-list">${['wakeword', 'whisper-bin', ...(st.nvidia || a['whisper-cuda'].installed ? ['whisper-cuda'] : []), 'whisper-turbo', 'whisper-base', 'piper-bin', 'voice-fa-amir', 'voice-fa-gyro', 'voice-en-lessac', 'ffmpeg'].map(id => row(id)).join('')}</div>
    <div class="help">وضعیت: گفتار به متن ${st.stt.local ? 'محلی آماده' : 'محلی ناقص'}${st.stt.api ? '، API آماده' : ''} · متن به گفتار ${st.tts.local ? 'محلی آماده' : 'محلی ناقص'}${st.tts.api ? '، API آماده' : ''}${st.apiKind ? ' · API: ' + (st.apiKind === 'gemini' ? 'Gemini' : 'OpenAI') : ' · برای صدای API، Gemini یا OpenAI را با کلید در «هسته‌ی هوش مصنوعی» اضافه کنید.'}</div>
    <div class="row-gap"><button type="button" class="btn small" id="vTestTts">${ic('play', 'sm')}آزمایش صدا</button></div>
    <h4>گفتگوهای اخیر</h4><div class="v-log" id="vLog">${logHtml()}</div></div>
    <div class="dlg-actions"><button type="button" class="btn primary" id="vSave">ذخیره</button>
      <button type="button" class="btn ${V.state === 'off' ? '' : 'ghost'}" id="vToggle">${V.state === 'off' ? 'روشن کردن دستیار' : 'خاموش کردن دستیار'}</button>
      <button class="btn ghost" value="cancel">بستن</button></div>`, true);
  $('#dlgBody').onclick = async e => {
    const olp = e.target.closest('[data-olpull]');
    if (olp) { try { await api('/voice/ollama/pull', { body: { name: olp.dataset.olpull } }); olp.disabled = true; olp.textContent = 'در حال دانلود…'; } catch (err) { window.toast(err.message, true); } return; }
    if (e.target.closest('#vOlStart')) { try { await api('/voice/ollama/start', { body: {} }); voiceDialog(); } catch (err) { window.toast(err.message, true); } return; }
    const dl = e.target.closest('[data-vdl]'), del = e.target.closest('[data-vdel]');
    if (dl) { try { await api('/voice/download', { body: { id: dl.dataset.vdl } }); dl.disabled = true; dl.textContent = 'در حال دانلود…'; } catch (err) { window.toast(err.message, true); } return; }
    if (del) { if (!confirm('حذف شود؟')) return; try { await api('/voice/assets/' + del.dataset.vdel, { method: 'DELETE' }); voiceDialog(); } catch (err) { window.toast(err.message, true); } return; }
    if (e.target.closest('#vTestTts')) { await save(false); speakText(/fa/.test(navigator.language) || true ? 'سلام! من جارویس هستم. صدایم را می‌شنوید؟' : 'Hello, I am JARVIS.'); return; }
    if (e.target.closest('#vSave')) { await save(true); return; }
    if (e.target.closest('#vToggle')) { $('#dlg').close(); if (V.state === 'off') start(false); else stop(); }
  };
  async function save(close) {
    const body = { voiceMode: $('#vMode').value, voiceModelOffline: $('#vModelOff').value, voiceMicId: $('#vMic').value, voiceModel: $('#vModel').value, voiceStt: $('#vStt').value, voiceTts: $('#vTts').value, voiceFaVoice: $('#vFa').value,
      voiceApiVoice: $('#vApiVoice').value, voiceApi: $('#vApi').value, voiceGeminiVoice: $('#vGemVoice').value, voiceLang: $('#vLang').value, voiceWake: $('#vWake').checked, voiceWakeThreshold: +$('#vThr').value, voiceSpeak: $('#vSpeak').checked };
    const micChanged = body.voiceMicId !== (settings().voiceMicId || '');
    if (body.voiceMode === 'offline' && !body.voiceModelOffline) { window.toast('برای حالت آفلاین، یک «مغز آفلاین» انتخاب کنید (اول یکی از مدل‌ها را دانلود کنید).', true); return; }
    try { S.settings = await api('/settings', { body }); if (body.voiceModelOffline) api('/voice/warm', { body: {} }).catch(() => {}); setNet(body.voiceMode === 'offline' ? false : undefined); if (close) { $('#dlg').close(); window.toast('ذخیره شد'); } } catch (err) { window.toast(err.message, true); return; }
    if (micChanged && V.stream) { stopMic(); await startMic().catch(() => {}); }
    if (body.voiceWake && V.state !== 'off') { const st2 = await api('/voice/status'); V.localStt = st2.stt.local; if (st2.assets.wakeword.installed) await loadWakeWord(); }
  }
}
window.addEventListener('jarvis:ev', e => {
  const ev = e.detail;
  if (ev.type === 'ollamaPull' && document.getElementById('vLog') && $('#dlg').open) {
    if (ev.pull.done || ev.pull.error) { clearTimeout(window.__vdRefresh); window.__vdRefresh = setTimeout(voiceDialog, 400); return; }
    const row = document.querySelector(`[data-olrow="${CSS.escape(ev.name)}"]`);
    if (row) {
      let pr = row.querySelector('progress');
      if (!pr) { const b = row.querySelector('[data-olpull]'); if (b) b.remove(); pr = document.createElement('progress'); const sp = document.createElement('span'); sp.className = 'help pct'; row.append(pr, sp); }
      pr.max = ev.pull.total || 1; pr.value = ev.pull.completed || 0;
      row.querySelector('.pct').textContent = ev.pull.total ? fa(Math.round(ev.pull.completed / ev.pull.total * 100)) + '٪' : ev.pull.status;
    }
    return;
  }
  if (ev.type === 'voiceAssets' && document.getElementById('vLog') && $('#dlg').open) {
    for (const [id, x] of Object.entries(ev.assets || {})) {
      const row = document.querySelector(`[data-vdl="${id}"]`)?.closest('.va-row') || document.querySelector(`.va-row progress`)?.closest('.va-row');
      if (x.installed || x.error) { clearTimeout(window.__vdRefresh); window.__vdRefresh = setTimeout(voiceDialog, 400); return; }
    }
    clearTimeout(window.__vdProg); window.__vdProg = setTimeout(voiceDialog, 1500);
  }
});

// ---------- entry points ----------
window.voiceDialog = voiceDialog;
window.voiceOpen = openSection;
// reminders etc. speak through the assistant when it is on
window.voiceSpeak = text => { if (V.state !== "off" && settings().voiceSpeak !== false) speakText(text); };
window.voiceStart = start;
const btn = document.getElementById('btnVoice');
if (btn) btn.onclick = () => (V.state === 'off' ? start(false) : voiceDialog());
document.addEventListener('keydown', e => {
  if (e.ctrlKey && (e.code === 'Space') && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (V.state === 'off') start(true);
    else if (V.state === 'recording') finishRecording();
    else startRecording(false);
  }
});
// turn back on after a restart if it was on (the mic permission is the app's own)
setTimeout(() => { if (settings().voiceEnabled) start(false); }, 1500);
