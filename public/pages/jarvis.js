// The JARVIS section: the whole page is the living orb. It moves and changes colour with the
// conversation (cyan = waiting for "Hey Jarvis", green = listening, violet = thinking, gold = speaking).
// One gear button opens every voice setting: general, voice services (engines, voices, keys), offline parts.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const fa = n => (+n || 0).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const st = () => window.JARVIS_STATE || {};
const V = () => window.jarvisVoice || { state: 'off', level: 0, log: [] };

const STATE = {
  off: { label: 'گوش دادن مکث شده', sub: 'برای ادامه، دکمه‌ی پخش را بزنید', rgb: [110, 130, 150] },
  idle: { label: 'منتظر «هی جارویس»', sub: 'بگویید «هی جارویس»، روی گوی بزنید یا بنویسید', rgb: [79, 216, 255] },
  recording: { label: 'گوش می‌دهم…', sub: 'صحبت کنید؛ وقتی ساکت شوید می‌فهمم تمام شد', rgb: [62, 255, 168] },
  thinking: { label: 'در حال فکر کردن…', sub: '', rgb: [180, 140, 255] },
  speaking: { label: 'در حال صحبت…', sub: 'برای قطع، روی گوی بزنید', rgb: [255, 183, 71] },
};
const P = { el: null, raf: 0, rgb: [79, 216, 255], lvl: 0, t0: performance.now(), parts: [], eng: null, vs: null, tab: 'general' };
const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

function enter(host) {
  P.el = host;
  document.body.classList.add('on-jarvis');
  host.innerHTML = `<div class="jv">
    <canvas id="jvOrb" class="jv-orb" aria-hidden="true"></canvas>
    <button type="button" class="jv-hit" id="jvHit" aria-label="روی گوی بزنید تا صحبت کنید"></button>
    <div class="jv-top">
      <div class="jv-brand"><span>J.A.R.V.I.S</span><small id="jvNet"></small></div>
      <div class="jv-tools">
        <button type="button" class="jv-tool" id="jvHist" title="گفتگو" aria-label="گفتگو">${ic('messages-square')}</button>
        <button type="button" class="jv-tool" id="jvGear" title="تنظیمات جارویس" aria-label="تنظیمات جارویس">${ic('settings')}</button>
      </div>
    </div>
    <div class="jv-bottom">
      <div class="jv-status" role="status" aria-live="polite"><h1 id="jvState"></h1><p id="jvSub"></p></div>
      <div class="jv-caption" id="jvCaption" dir="auto"></div>
      <form class="jv-bar" id="jvAsk">
        <button type="button" class="jv-round" id="jvMic" aria-label="صحبت کنید">${ic('mic')}</button>
        <input id="jvText" dir="auto" placeholder="بنویسید… (مثلاً «کروم را باز کن»)" aria-label="پیام به جارویس" autocomplete="off">
        <button class="jv-round send" aria-label="بفرست">${ic('send')}</button>
        <button type="button" class="jv-round" id="jvStop" aria-label="توقف صحبت">${ic('circle-stop')}</button>
        <button type="button" class="jv-round" id="jvPause" aria-label="مکث یا ادامه‌ی گوش دادن">${ic('pause')}</button>
      </form>
    </div>
    <aside class="jv-drawer" id="jvDrawer" aria-label="گفتگو" hidden><header><h2>${ic('messages-square', 'sm')}گفتگو</h2><button type="button" class="jv-tool" data-close aria-label="بستن">${ic('x')}</button></header><div class="jv-log" id="jvLog"></div></aside>
    <div class="jv-set" id="jvSet" hidden></div>
  </div>`;
  const talk = () => { const v = V(); if (v.state === 'speaking') return v.stopSpeaking && v.stopSpeaking(); v.talk && v.talk(); };
  $('#jvHit', host).onclick = talk; $('#jvMic', host).onclick = talk;
  $('#jvStop', host).onclick = () => V().stopSpeaking && V().stopSpeaking();
  $('#jvPause', host).onclick = () => { const v = V(); if (v.state === 'off') v.resume && v.resume(); else v.pause && v.pause(); };
  $('#jvAsk', host).onsubmit = e => { e.preventDefault(); const t = $('#jvText', host).value.trim(); if (!t) return; $('#jvText', host).value = ''; V().ask && V().ask(t); };
  $('#jvHist', host).onclick = () => { const d = $('#jvDrawer', host); d.hidden = !d.hidden; if (!d.hidden) drawLog(); };
  $('#jvDrawer', host).querySelector('[data-close]').onclick = () => { $('#jvDrawer', host).hidden = true; };
  $('#jvGear', host).onclick = () => openSettings();
  status(); drawLog();
  window.addEventListener('resize', size); requestAnimationFrame(size);
  cancelAnimationFrame(P.raf); P.raf = requestAnimationFrame(frame);
}
function leave() { document.body.classList.remove('on-jarvis'); cancelAnimationFrame(P.raf); P.raf = 0; window.removeEventListener('resize', size); P.el = null; }

function status() {
  if (!P.el) return;
  const v = V(), s = STATE[v.state] || STATE.idle;
  const micErr = v.state === 'off' && v.micError;
  $('#jvState', P.el).textContent = micErr ? 'میکروفون در دسترس نیست' : s.label;
  $('#jvSub', P.el).textContent = micErr ? v.micError + ' — از تنظیمات (چرخ‌دنده) میکروفون را انتخاب کنید. نوشتن همیشه کار می‌کند.' : s.sub;
  const pb = $('#jvPause', P.el); pb.innerHTML = ic(v.state === 'off' ? 'play' : 'pause'); pb.setAttribute('aria-label', v.state === 'off' ? 'ادامه‌ی گوش دادن' : 'مکث گوش دادن');
  $('#jvMic', P.el).classList.toggle('on', v.state === 'recording');
  P.el.querySelector('.jv').dataset.state = v.state;
}
function drawLog() {
  if (!P.el) return;
  const log = (V().log || []).slice(-40);
  const box = $('#jvLog', P.el);
  box.innerHTML = log.length ? log.map(l => `<div class="jv-msg ${l.who}"><b>${l.who === 'user' ? 'شما' : l.who === 'jarvis' ? 'جارویس' : 'خطا'}</b><span dir="auto">${esc(l.text)}</span></div>`).join('') : '<p class="help">هنوز گفتگویی نشده.</p>';
  box.scrollTop = box.scrollHeight;
  const last = log.filter(l => l.who !== 'error').slice(-1)[0];
  $('#jvCaption', P.el).textContent = last ? last.text : '';
}
window.addEventListener('jarvis:voice', status);
window.addEventListener('jarvis:voicelog', drawLog);

// ---------- the orb (fills the page) ----------
function size() {
  const c = P.el && $('#jvOrb', P.el); if (!c) return;
  // fill the window below where the page starts (the layout above may have bars)
  const jv = P.el.querySelector('.jv'); jv.style.height = Math.max(480, window.innerHeight - jv.getBoundingClientRect().top - 10) + 'px';
  const r = c.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
  c.width = Math.round(r.width * d); c.height = Math.round(r.height * d);
}
function frame(now) {
  if (!P.el) return;
  P.raf = requestAnimationFrame(frame);
  const c = $('#jvOrb', P.el); if (!c || !c.width) return;
  const g = c.getContext('2d'), w = c.width, h = c.height, cx = w / 2, cy = h * 0.45, R = Math.min(w, h) * 0.17;
  const v = V(), s = STATE[v.state] || STATE.idle, t = (now - P.t0) / 1000, slow = reduce();
  for (let i = 0; i < 3; i++) P.rgb[i] += (s.rgb[i] - P.rgb[i]) * 0.06;
  // while waiting it still breathes with the room sound, so you can see the microphone is alive
  const mic = Math.min(1, v.level || 0);
  const target = v.state === 'recording' || v.state === 'speaking' ? Math.min(1, mic * 1.6) : v.state === 'thinking' ? 0.35 + 0.25 * Math.sin(t * 5) : v.state === 'idle' ? 0.1 + 0.05 * Math.sin(t * 1.6) + mic * 0.5 : 0.06;
  P.lvl += (target - P.lvl) * (target > P.lvl ? 0.35 : 0.08);
  const L = slow ? 0.15 : P.lvl, col = a => `rgba(${P.rgb.map(Math.round).join(',')},${a})`;
  g.clearRect(0, 0, w, h);
  const glow = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * (3 + L * 1.5));
  glow.addColorStop(0, col(0.5)); glow.addColorStop(0.3, col(0.16)); glow.addColorStop(1, col(0));
  g.fillStyle = glow; g.fillRect(0, 0, w, h);
  const core = g.createRadialGradient(cx - R * 0.25, cy - R * 0.25, R * 0.05, cx, cy, R * (0.95 + L * 0.25));
  core.addColorStop(0, 'rgba(255,255,255,0.95)'); core.addColorStop(0.25, col(0.9)); core.addColorStop(1, col(0.08));
  g.beginPath(); g.arc(cx, cy, R * (0.92 + L * 0.22), 0, Math.PI * 2); g.fillStyle = core; g.fill();
  g.lineWidth = Math.max(1, w / 700);
  for (let k = 0; k < 5; k++) {
    g.beginPath();
    for (let i = 0; i <= 140; i++) {
      const a = (i / 140) * Math.PI * 2;
      const wob = (slow ? 0 : 1) * (Math.sin(a * (3 + k) + t * (1.2 + k * 0.7)) * 0.5 + Math.sin(a * (5 + k * 2) - t * (2 + k)) * 0.5);
      const r = R * (1.15 + k * 0.17) + wob * R * (0.03 + L * 0.24);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath(); g.strokeStyle = col(0.55 - k * 0.09); g.stroke();
  }
  g.save(); g.translate(cx, cy);
  for (const [rr, n, sp] of [[2.2, 90, 0.15], [2.6, 36, -0.08]]) {
    g.save(); g.rotate(slow ? 0 : t * (v.state === 'thinking' ? sp * 6 : sp));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, r1 = R * rr, r2 = r1 + (i % 6 === 0 ? R * 0.14 : R * 0.05);
      g.beginPath(); g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      g.strokeStyle = col(i % 6 === 0 ? 0.45 : 0.18); g.stroke();
    }
    g.restore();
  }
  g.restore();
  if (!slow && (v.state === 'speaking' || v.state === 'recording') && P.parts.length < 160 && Math.random() < 0.3 + L) {
    P.parts.push({ a: Math.random() * Math.PI * 2, r: R * 1.1, v: R * (0.008 + Math.random() * 0.02) * (1 + L * 3), life: 1 });
  }
  for (const p of P.parts) { p.r += p.v; p.life -= 0.011; g.beginPath(); g.arc(cx + Math.cos(p.a) * p.r, cy + Math.sin(p.a) * p.r, Math.max(1, w / 900) * (1 + p.life), 0, Math.PI * 2); g.fillStyle = col(p.life * 0.8); g.fill(); }
  P.parts = P.parts.filter(p => p.life > 0);
}

// ---------- settings (one gear button; everything in here) ----------
const STT_LIST = [['auto', 'خودکار (محلی، وگرنه اولین سرویسِ دارای کلید)'], ['local', 'محلی — whisper.cpp (رایگان، آفلاین)'], ['gemini', 'Google Gemini'], ['openai', 'OpenAI'], ['groq', 'Groq (Whisper، سریع)'], ['elevenlabs', 'ElevenLabs'], ['azure', 'Azure Speech'], ['deepgram', 'Deepgram']];
const TTS_LIST = [['auto', 'خودکار (محلی، وگرنه اولین سرویسِ دارای کلید)'], ['local', 'محلی — Piper (رایگان، آفلاین)'], ['gemini', 'Google Gemini'], ['openai', 'OpenAI'], ['azure', 'Azure Speech (دلارا / فرید)'], ['elevenlabs', 'ElevenLabs']];
const KEYS = [
  ['groq', 'Groq', 'https://console.groq.com/keys', 'شنیدن سریع با Whisper؛ نسخه‌ی رایگان دارد. اگر Groq را در «هسته‌ی هوش مصنوعی» دارید، خودکار استفاده می‌شود.'],
  ['elevenlabs', 'ElevenLabs', 'https://elevenlabs.io/app/settings/api-keys', 'طبیعی‌ترین صداها؛ شنیدن هم دارد. پولی، با سهمیه‌ی رایگان کوچک.'],
  ['azure', 'Azure Speech', 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices', 'صداهای فارسی «دلارا» و «فرید» و شنیدن فارسی؛ سهمیه‌ی رایگان ماهانه. منطقه (Region) هم لازم است، مثل westeurope.'],
  ['deepgram', 'Deepgram', 'https://console.deepgram.com/', 'فقط شنیدن؛ برای انگلیسی عالی، فارسی محدود.'],
];
const TABS = [['general', 'sliders-horizontal', 'عمومی'], ['services', 'mic', 'سرویس‌های صدا'], ['offline', 'download', 'اجزای آفلاین']];
const opts = (list, cur) => list.map(([k, l]) => `<option value="${esc(k)}" ${k === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');

async function openSettings(tab) {
  if (tab) P.tab = tab;
  const box = $('#jvSet', P.el); box.hidden = false;
  box.innerHTML = `<div class="jvs" role="dialog" aria-modal="true" aria-labelledby="jvsT">
    <header><h2 id="jvsT">${ic('settings', 'sm')}تنظیمات جارویس</h2><button type="button" class="jv-tool" id="jvsX" aria-label="بستن">${ic('x')}</button></header>
    <nav class="jvs-tabs" role="tablist">${TABS.map(([id, i, l]) => `<button type="button" role="tab" aria-selected="${P.tab === id}" data-t="${id}">${ic(i, 'sm')}${l}</button>`).join('')}</nav>
    <div class="jvs-body" id="jvsBody"><p class="help">در حال خواندن…</p></div></div>`;
  box.onclick = e => { if (e.target === box) closeSettings(); };
  $('#jvsX', box).onclick = closeSettings;
  box.querySelectorAll('[data-t]').forEach(b => b.onclick = () => openSettings(b.dataset.t));
  document.addEventListener('keydown', escClose);
  try { [P.vs, P.eng] = await Promise.all([api('/voice/status'), api('/voice/engines')]); } catch (e) { $('#jvsBody', box).innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  ({ general: tabGeneral, services: tabServices, offline: tabOffline })[P.tab]($('#jvsBody', box));
}
function closeSettings() { const b = P.el && $('#jvSet', P.el); if (b) { b.hidden = true; b.innerHTML = ''; } document.removeEventListener('keydown', escClose); stopMeter(); }
const escClose = e => { if (e.key === 'Escape') closeSettings(); };
const save = async body => { window.JARVIS_STATE.settings = await api('/settings', { body }); return window.JARVIS_STATE.settings; };

// -- general: microphone (with a live meter), wake word, language, online/offline, brains
let meter = null;
function stopMeter() { if (meter) { cancelAnimationFrame(meter.raf); meter.stream.getTracks().forEach(t => t.stop()); meter.ctx.close().catch(() => {}); meter = null; } }
async function startMeter(id, bar) {
  stopMeter();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined } });
    const ctx = new AudioContext(), an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
    const d = new Float32Array(512); meter = { stream, ctx, raf: 0 };
    const tick = () => { an.getFloatTimeDomainData(d); let s = 0; for (const x of d) s += x * x; bar.style.width = Math.min(100, Math.sqrt(s / d.length) * 900) + '%'; meter.raf = requestAnimationFrame(tick); };
    tick();
  } catch (e) { bar.style.width = '0'; bar.parentElement.title = e.name === 'OverconstrainedError' ? 'این میکروفون باز نشد' : e.message; bar.parentElement.classList.add('bad'); }
}
async function tabGeneral(el) {
  const s = st().settings || {}, ol = P.vs.ollama || { models: [] };
  let mics = []; try { mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications'); } catch {}
  const micOk = !s.voiceMicId || mics.some(m => m.deviceId === s.voiceMicId);
  const models = window.modelOptions ? window.modelOptions('claude', s.voiceModel).filter(([k]) => k && k !== '__custom') : [[s.voiceModel, s.voiceModel]];
  el.innerHTML = `
    <section class="jvs-sec"><h3>${ic('mic', 'sm')}میکروفون</h3>
      <div class="field"><label for="gMic">کدام میکروفون</label><select id="gMic">${opts([['', 'پیش‌فرض ویندوز (پیشنهادی)'], ...mics.filter(m => m.deviceId !== 'default').map(m => [m.deviceId, m.label || 'میکروفون'])], micOk ? s.voiceMicId || '' : '')}</select>
      ${micOk ? '' : `<div class="bad">میکروفونی که قبلاً انتخاب شده بود دیگر وصل نیست؛ پیش‌فرض ویندوز انتخاب شد. ذخیره را بزنید.</div>`}</div>
      <div class="jvs-meter" aria-label="سطح صدای میکروفون"><i id="gBar"></i></div><div class="help">حرف بزنید؛ این نوار باید تکان بخورد.</div></section>
    <section class="jvs-sec"><h3>${ic('sparkles', 'sm')}بیدار شدن</h3>
      <label class="check"><input type="checkbox" id="gWake" ${s.voiceWake !== false ? 'checked' : ''}> با گفتن «هی جارویس» بیدار شود</label>
      <div class="field"><label for="gThr">حساسیت (${fa(Math.round((+s.voiceWakeThreshold || 0.5) * 100))}٪ — کمتر = حساس‌تر)</label><input id="gThr" type="range" min="0.2" max="0.9" step="0.05" value="${+s.voiceWakeThreshold || 0.5}"></div>
      <label class="check"><input type="checkbox" id="gSpeak" ${s.voiceSpeak !== false ? 'checked' : ''}> جواب‌ها را بلند بخواند</label>
      <div class="field"><label for="gLang">زبان گفتار</label><select id="gLang">${opts([['auto', 'خودکار فارسی/انگلیسی'], ['fa', 'فقط فارسی (سریع‌تر)'], ['en', 'فقط انگلیسی (سریع‌تر)']], s.voiceLang || 'auto')}</select></div></section>
    <section class="jvs-sec"><h3>${ic('brain', 'sm')}مغز جارویس</h3>
      <div class="field"><label for="gMode">آنلاین یا آفلاین</label><select id="gMode">${opts([['auto', 'خودکار — با اینترنت آنلاین، بدون اینترنت آفلاین (پیشنهادی)'], ['online', 'همیشه آنلاین'], ['offline', 'همیشه آفلاین — هیچ چیز از این کامپیوتر بیرون نمی‌رود']], s.voiceMode || 'auto')}</select></div>
      <div class="jvs-2"><div class="field"><label for="gModel">مغز آنلاین</label><select id="gModel" dir="ltr">${opts(models, s.voiceModel)}</select></div>
      <div class="field"><label for="gOff">مغز آفلاین (Ollama)</label><select id="gOff" dir="ltr">${opts([['', ol.models.length ? '— انتخاب کنید —' : '— از تب «اجزای آفلاین» دانلود کنید —'], ...ol.models.map(x => [x.name, x.name])], s.voiceModelOffline || '')}</select></div></div></section>
    <div class="jvs-actions"><button type="button" class="btn btn-primary" id="gSave">${ic('save', 'sm')}ذخیره</button></div>`;
  $('#gMic', el).onchange = () => startMeter($('#gMic', el).value, $('#gBar', el));
  startMeter(micOk ? s.voiceMicId : '', $('#gBar', el));
  $('#gSave', el).onclick = async () => {
    const body = { voiceMicId: $('#gMic', el).value, voiceWake: $('#gWake', el).checked, voiceWakeThreshold: +$('#gThr', el).value, voiceSpeak: $('#gSpeak', el).checked, voiceLang: $('#gLang', el).value, voiceMode: $('#gMode', el).value, voiceModel: $('#gModel', el).value, voiceModelOffline: $('#gOff', el).value };
    if (body.voiceMode === 'offline' && !body.voiceModelOffline) return window.toast('برای حالت آفلاین، یک «مغز آفلاین» انتخاب کنید.', true);
    const micChanged = body.voiceMicId !== (s.voiceMicId || '') || !micOk;
    try { await save(body); stopMeter(); if (micChanged) await V().reloadMic(); await V().reloadWake(); window.toast('ذخیره شد'); tabGeneral(el); } catch (x) { window.toast(x.message, true); }
  };
}

// -- voice services: which engine listens / speaks, voices, keys
function tabServices(el) {
  const s = st().settings || {}, e = P.eng;
  const legacy = v => v === 'api' ? (s.voiceApi && s.voiceApi !== 'auto' ? s.voiceApi : 'auto') : v;
  const eopt = (list, cur, avail) => list.map(([k, l]) => `<option value="${k}" ${k === legacy(cur || 'auto') ? 'selected' : ''}>${esc(l)}${k !== 'auto' && avail && avail[k] === false ? ' — ' + (k === 'local' ? 'دانلود نشده' : 'کلید ندارد') : k !== 'auto' && avail && avail[k] ? ' ✓' : ''}</option>`).join('');
  const azv = (lang, cur) => opts(e.azureVoices[lang] || [], cur);
  el.innerHTML = `
    <section class="jvs-sec"><h3>${ic('mic', 'sm')}موتورها</h3>
      <div class="jvs-2"><div class="field"><label for="sStt">شنیدن (گفتار به متن)</label><select id="sStt">${eopt(STT_LIST, s.voiceStt, e.stt)}</select></div>
      <div class="field"><label for="sTts">صحبت کردن (متن به گفتار)</label><select id="sTts">${eopt(TTS_LIST, s.voiceTts, e.tts)}</select></div></div>
      <div class="help">اگر سرویسی شلوغ یا قطع باشد، جارویس خودش با صدای محلی ادامه می‌دهد.</div></section>
    <section class="jvs-sec"><h3>${ic('play', 'sm')}صداها</h3>
      <div class="jvs-2">
        <div class="field"><label for="sFa">صدای فارسی محلی</label><select id="sFa">${opts([['voice-fa-amir', 'امیر'], ['voice-fa-gyro', 'ژیرو']], s.voiceFaVoice)}</select></div>
        <div class="field"><label for="sAzFa">صدای فارسی Azure</label><select id="sAzFa">${azv('fa', s.voiceAzureFa)}</select></div>
        <div class="field"><label for="sAzEn">صدای انگلیسی Azure</label><select id="sAzEn" dir="ltr">${azv('en', s.voiceAzureEn)}</select></div>
        <div class="field"><label for="sGem">صدای Gemini</label><select id="sGem" dir="ltr">${opts(['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Sulafat', 'Achird'].map(x => [x, x]), s.voiceGeminiVoice || 'Kore')}</select></div>
        <div class="field"><label for="sOai">صدای OpenAI</label><select id="sOai" dir="ltr">${opts(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map(x => [x, x]), s.voiceApiVoice || 'alloy')}</select></div>
        <div class="field"><label for="sEl">صدای ElevenLabs</label><div class="row-gap"><input id="sEl" dir="ltr" value="${esc(s.voiceElevenVoice || '')}" placeholder="voice id"><button type="button" class="btn btn-sm ghost" id="sElList" ${e.services.elevenlabs.hasKey ? '' : 'disabled'}>فهرست</button></div></div>
      </div>
      <div class="jvs-actions"><button type="button" class="btn btn-primary" id="sSave">${ic('save', 'sm')}ذخیره</button><button type="button" class="btn" id="sTry">${ic('play', 'sm')}آزمایش صدا</button><span id="sTryOut" class="help" aria-live="polite"></span></div></section>
    <section class="jvs-sec"><h3>${ic('key-round', 'sm')}کلیدها</h3>
      <div class="jvs-keys">${KEYS.map(([id, name, url, note]) => { const x = e.services[id] || {}; return `<div class="jvs-key">
        <div class="jvs-key-h"><b>${name}</b>${x.hasKey ? `<span class="ok">${ic('circle-check', 'sm')}ثبت شده</span>` : x.viaCore ? `<span class="ok">${ic('circle-check', 'sm')}از هسته‌ی هوش مصنوعی</span>` : '<span class="help">کلید ندارد</span>'}<a href="${url}" target="_blank" rel="noopener" class="help">گرفتن کلید</a></div>
        <p class="help">${note}</p>
        <div class="row-gap"><input type="password" dir="ltr" data-key="${id}" placeholder="${x.hasKey ? '(ذخیره شده — برای عوض کردن، تازه بنویسید)' : 'کلید API'}" aria-label="کلید ${name}">${id === 'azure' ? `<input dir="ltr" id="sAzR" value="${esc(e.azureRegion)}" placeholder="westeurope" aria-label="منطقه‌ی Azure" class="jvs-region">` : ''}
          <button type="button" class="btn btn-sm" data-savekey="${id}">ذخیره</button>${x.hasKey ? `<button type="button" class="btn btn-sm ghost" data-delkey="${id}" aria-label="پاک کردن کلید ${name}">${ic('trash-2', 'sm')}</button>` : ''}</div></div>`; }).join('')}</div>
      <p class="help">${ic('lock', 'sm')} کلیدها رمزنگاری‌شده روی همین کامپیوتر می‌مانند. Gemini و OpenAI از «هسته‌ی هوش مصنوعی» خوانده می‌شوند (${e.hasGemini ? 'Gemini ✓' : 'Gemini ندارد'}، ${e.hasOpenai ? 'OpenAI ✓' : 'OpenAI ندارد'}).</p></section>`;
  const val = id => $('#' + id, el).value;
  const saveSvc = () => save({ voiceStt: val('sStt'), voiceTts: val('sTts'), voiceFaVoice: val('sFa'), voiceAzureFa: val('sAzFa'), voiceAzureEn: val('sAzEn'), voiceGeminiVoice: val('sGem'), voiceApiVoice: val('sOai'), voiceElevenVoice: val('sEl').trim() });
  $('#sSave', el).onclick = async () => { try { await saveSvc(); window.toast('ذخیره شد'); } catch (x) { window.toast(x.message, true); } };
  $('#sTry', el).onclick = async () => {
    const out = $('#sTryOut', el); out.textContent = 'در حال ساختن صدا…';
    try {
      await saveSvc();
      const r = await api('/voice/try', { body: { engine: val('sTts'), text: 'سلام! من جارویس هستم. صدای من را خوب می‌شنوید؟' } });
      out.textContent = `${r.engine === 'local' ? 'محلی' : (e.names[r.engine] || r.engine)}${r.fellBack ? ' (سرویس جواب نداد؛ صدای محلی)' : ''} · ${(r.ms / 1000).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} ثانیه`;
      new Audio('data:audio/wav;base64,' + r.audio).play();
    } catch (x) { out.textContent = ''; window.toast(x.message, true); }
  };
  const ell = $('#sElList', el);
  if (ell) ell.onclick = async () => {
    try { const list = await api('/voice/eleven-voices'); const sel = document.createElement('select'); sel.id = 'sEl'; sel.dir = 'ltr'; sel.innerHTML = opts(list, val('sEl')); $('#sEl', el).replaceWith(sel); }
    catch (x) { window.toast(x.message, true); }
  };
  el.querySelectorAll('[data-savekey]').forEach(b => b.onclick = async () => {
    const id = b.dataset.savekey, key = el.querySelector(`[data-key="${id}"]`).value.trim();
    if (!key && !(id === 'azure' && e.services.azure.hasKey)) return window.toast('کلید را بنویسید', true);
    try { P.eng = await api('/voice/keys', { body: { service: id, key: key || undefined, ...(id === 'azure' ? { region: $('#sAzR', el).value } : {}) } }); window.toast('ذخیره شد'); tabServices(el); } catch (x) { window.toast(x.message, true); }
  });
  el.querySelectorAll('[data-delkey]').forEach(b => b.onclick = async () => {
    if (!confirm('کلید این سرویس از این کامپیوتر پاک شود؟')) return;
    try { P.eng = await api('/voice/keys', { body: { service: b.dataset.delkey, key: '' } }); tabServices(el); } catch (x) { window.toast(x.message, true); }
  });
}

// -- offline parts: speech engine, voices, wake word, offline brain (Ollama)
const MB = n => fa(Math.round(n / 1e6)) + ' مگابایت';
function tabOffline(el) {
  const a = P.vs.assets, ol = P.vs.ollama || { models: [], suggested: [], pulls: {} };
  const ids = ['wakeword', 'whisper-bin', ...(P.vs.nvidia || (a['whisper-cuda'] || {}).installed ? ['whisper-cuda'] : []), 'whisper-turbo', 'whisper-base', 'piper-bin', 'voice-fa-amir', 'voice-fa-gyro', 'voice-en-lessac', 'ffmpeg'].filter(id => a[id]);
  const row = id => { const x = a[id]; return `<div class="jvs-row"><span dir="auto">${esc(x.label)}</span><span class="help">${MB(x.size)}</span>
    ${x.installed ? `<span class="ok">${ic('circle-check', 'sm')}نصب است</span><button type="button" class="btn btn-sm ghost" data-vdel="${id}">حذف</button>`
      : x.downloading ? `<progress max="${x.total}" value="${x.got}"></progress><span class="help">${fa(Math.round(x.got / x.total * 100))}٪</span>`
      : `<button type="button" class="btn btn-sm" data-vdl="${id}">${ic('download', 'sm')}دانلود</button>${x.error ? `<span class="bad">${esc(x.error)}</span>` : ''}`}</div>`; };
  el.innerHTML = `
    <section class="jvs-sec"><h3>${ic('download', 'sm')}صدا و «هی جارویس» (رایگان، آفلاین)</h3>
      ${P.vs.nvidia && !(a['whisper-cuda'] || {}).installed ? `<div class="help">${ic('zap', 'sm')} کارت گرافیک <b dir="ltr">${esc(P.vs.nvidia)}</b> دارید: «موتور گفتار روی کارت گرافیک» شنیدن را خیلی سریع‌تر می‌کند.</div>` : ''}
      <div class="jvs-list">${ids.map(row).join('')}</div></section>
    <section class="jvs-sec"><h3>${ic('brain', 'sm')}مغز آفلاین (Ollama)</h3>
      ${!ol.installed ? `<p class="help">برنامه‌ی رایگان Ollama را نصب کنید: <a href="${esc(ol.downloadUrl || 'https://ollama.com/download')}" target="_blank" rel="noopener" dir="ltr">ollama.com/download</a> — بعد این صفحه را دوباره باز کنید.</p>`
        : `${!ol.running ? `<p class="help">Ollama نصب است ولی اجرا نشده. <button type="button" class="btn btn-sm" id="oStart">${ic('play', 'sm')}اجرا</button></p>` : ''}
        <div class="jvs-list">${(ol.suggested || []).map(x => { const have = ol.models.some(m => m.name === x.name), p = ol.pulls[x.name];
          return `<div class="jvs-row"><span dir="ltr">${esc(x.name)}</span><span class="help">${fa((x.size / 1e9).toFixed(1))} گیگ · ${esc(x.note)}</span>
          ${have ? `<span class="ok">${ic('circle-check', 'sm')}نصب است</span>` : p && !p.done && !p.error ? `<progress max="${p.total || 1}" value="${p.completed || 0}"></progress>` : `<button type="button" class="btn btn-sm" data-olpull="${esc(x.name)}">${ic('download', 'sm')}دانلود</button>${p && p.error ? `<span class="bad">${esc(p.error)}</span>` : ''}`}</div>`; }).join('')}</div>`}</section>`;
  el.onclick = async e => {
    const dl = e.target.closest('[data-vdl]'), del = e.target.closest('[data-vdel]'), olp = e.target.closest('[data-olpull]');
    try {
      if (dl) { dl.disabled = true; dl.textContent = 'در حال دانلود…'; await api('/voice/download', { body: { id: dl.dataset.vdl } }); }
      else if (del) { if (!confirm('حذف شود؟')) return; await api('/voice/assets/' + del.dataset.vdel, { method: 'DELETE' }); openSettings('offline'); }
      else if (olp) { olp.disabled = true; olp.textContent = 'در حال دانلود…'; await api('/voice/ollama/pull', { body: { name: olp.dataset.olpull } }); }
      else if (e.target.closest('#oStart')) { await api('/voice/ollama/start', { body: {} }); openSettings('offline'); }
    } catch (x) { window.toast(x.message, true); }
  };
}
// refresh the offline tab as downloads progress
let refreshT = 0;
window.addEventListener('jarvis:ev', e => {
  const t = e.detail && e.detail.type;
  if ((t === 'voiceAssets' || t === 'ollamaPull') && P.el && P.tab === 'offline' && !$('#jvSet', P.el).hidden) { clearTimeout(refreshT); refreshT = setTimeout(() => openSettings('offline'), 1200); }
});

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('jarvis', { icon: 'sparkles', label: 'جارویس', enter, leave });
// the old voice dialog now opens these settings
window.jarvisSettings = tab => { if (window.showSection) window.showSection('jarvis'); setTimeout(() => openSettings(tab || 'general'), 60); };
