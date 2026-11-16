// The JARVIS section: a large living orb that moves and changes colour with the conversation
// (cyan = waiting for "Hey Jarvis", green = listening to you, violet = thinking, gold = speaking),
// the conversation, a text box, and the voice services (every listening/speaking engine + keys).
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const api = (p, o) => window.api(p, o);
const st = () => window.JARVIS_STATE || {};
const V = () => window.jarvisVoice || { state: 'off', level: 0, log: [] };

const STATE = {
  off: { label: 'گوش دادن مکث شده', sub: 'برای ادامه، دکمه‌ی میکروفون را بزنید', rgb: [110, 130, 150] },
  idle: { label: 'منتظر «هی جارویس»', sub: 'بگویید «هی جارویس» یا بنویسید', rgb: [79, 216, 255] },
  recording: { label: 'گوش می‌دهم…', sub: 'صحبت کنید؛ وقتی ساکت شوید می‌فهمم تمام شد', rgb: [62, 255, 168] },
  thinking: { label: 'در حال فکر کردن…', sub: '', rgb: [180, 140, 255] },
  speaking: { label: 'در حال صحبت…', sub: 'برای قطع، دکمه‌ی توقف را بزنید', rgb: [255, 183, 71] },
};
const P = { el: null, raf: 0, rgb: [79, 216, 255], lvl: 0, t0: performance.now(), parts: [], eng: null, open: false };
const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

function enter(host) {
  P.el = host;
  document.body.classList.add('on-jarvis');
  host.innerHTML = `<div class="jv">
    <div class="jv-stage">
      <canvas id="jvOrb" class="jv-orb" aria-hidden="true"></canvas>
      <div class="jv-status" role="status" aria-live="polite"><h1 id="jvState"></h1><p id="jvSub" class="help"></p></div>
      <div class="jv-caption" id="jvCaption" dir="auto"></div>
      <div class="jv-controls">
        <button type="button" class="jv-btn" id="jvMic" aria-label="صحبت کنید">${ic('mic')}</button>
        <button type="button" class="jv-btn" id="jvStop" aria-label="توقف صحبت">${ic('circle-stop')}</button>
        <button type="button" class="jv-btn" id="jvPause" aria-label="مکث یا ادامه‌ی گوش دادن">${ic('pause')}</button>
      </div>
      <form class="jv-ask" id="jvAsk"><input id="jvText" dir="auto" placeholder="یا بنویسید… (مثلاً «کروم را باز کن»)" aria-label="پیام به جارویس" autocomplete="off"><button class="btn btn-primary" aria-label="بفرست">${ic('send', 'sm')}</button></form>
    </div>
    <aside class="jv-side">
      <section class="jv-card"><h2>${ic('messages-square', 'sm')}گفتگو</h2><div class="jv-log" id="jvLog"></div></section>
      <section class="jv-card"><h2>${ic('sliders-horizontal', 'sm')}سرویس‌های صدا</h2><div id="jvEng"><p class="help">در حال خواندن…</p></div></section>
    </aside>
  </div>`;
  $('#jvMic', host).onclick = () => V().talk && V().talk();
  $('#jvStop', host).onclick = () => V().stopSpeaking && V().stopSpeaking();
  $('#jvPause', host).onclick = () => { const v = V(); if (v.state === 'off') v.resume && v.resume(); else v.pause && v.pause(); };
  $('#jvAsk', host).onsubmit = e => { e.preventDefault(); const t = $('#jvText', host).value.trim(); if (!t) return; $('#jvText', host).value = ''; V().ask && V().ask(t); };
  status(); drawLog(); loadEngines();
  window.addEventListener('resize', size); size();
  cancelAnimationFrame(P.raf); P.raf = requestAnimationFrame(frame);
}
function leave() { document.body.classList.remove('on-jarvis'); cancelAnimationFrame(P.raf); P.raf = 0; window.removeEventListener('resize', size); P.el = null; }

function status() {
  if (!P.el) return;
  const v = V(), s = STATE[v.state] || STATE.idle;
  const micErr = v.state === 'off' && v.micError;
  $('#jvState', P.el).textContent = micErr ? 'میکروفون در دسترس نیست' : s.label;
  $('#jvSub', P.el).textContent = micErr ? v.micError + ' — میکروفون را وصل کنید یا اجازه بدهید، بعد دکمه‌ی میکروفون را بزنید. نوشتن همیشه کار می‌کند.' : s.sub;
  const pb = $('#jvPause', P.el); pb.innerHTML = ic(v.state === 'off' ? 'play' : 'pause'); pb.setAttribute('aria-label', v.state === 'off' ? 'ادامه‌ی گوش دادن' : 'مکث گوش دادن');
  $('#jvMic', P.el).classList.toggle('on', v.state === 'recording');
  P.el.querySelector('.jv').dataset.state = v.state;
}
function drawLog() {
  if (!P.el) return;
  const log = (V().log || []).slice(-30);
  $('#jvLog', P.el).innerHTML = log.length ? log.map(l => `<div class="jv-msg ${l.who}"><b>${l.who === 'user' ? 'شما' : l.who === 'jarvis' ? 'جارویس' : 'خطا'}</b><span dir="auto">${esc(l.text)}</span></div>`).join('') : '<p class="help">هنوز گفتگویی نشده. بگویید «هی جارویس».</p>';
  const box = $('#jvLog', P.el); box.scrollTop = box.scrollHeight;
  const last = log.filter(l => l.who !== 'error').slice(-1)[0];
  $('#jvCaption', P.el).textContent = last ? last.text : '';
}
window.addEventListener('jarvis:voice', status);
window.addEventListener('jarvis:voicelog', drawLog);

// ---------- the orb ----------
function size() {
  const c = P.el && $('#jvOrb', P.el); if (!c) return;
  const r = c.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
  c.width = Math.round(r.width * d); c.height = Math.round(r.height * d);
}
function frame(now) {
  if (!P.el) return;
  P.raf = requestAnimationFrame(frame);
  const c = $('#jvOrb', P.el); if (!c || !c.width) return;
  const g = c.getContext('2d'), w = c.width, h = c.height, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.26;
  const v = V(), s = STATE[v.state] || STATE.idle, t = (now - P.t0) / 1000, slow = reduce();
  // smooth colour and level changes
  for (let i = 0; i < 3; i++) P.rgb[i] += (s.rgb[i] - P.rgb[i]) * 0.06;
  const target = v.state === 'recording' || v.state === 'speaking' ? Math.min(1, v.level * 1.6) : v.state === 'thinking' ? 0.35 + 0.25 * Math.sin(t * 5) : 0.12 + 0.06 * Math.sin(t * 1.6);
  P.lvl += (target - P.lvl) * (target > P.lvl ? 0.35 : 0.08);
  const L = slow ? 0.15 : P.lvl, col = a => `rgba(${P.rgb.map(Math.round).join(',')},${a})`;
  g.clearRect(0, 0, w, h);
  // glow
  const glow = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * (2.2 + L));
  glow.addColorStop(0, col(0.55)); glow.addColorStop(0.35, col(0.18)); glow.addColorStop(1, col(0));
  g.fillStyle = glow; g.fillRect(0, 0, w, h);
  // core
  const core = g.createRadialGradient(cx - R * 0.25, cy - R * 0.25, R * 0.05, cx, cy, R * (0.95 + L * 0.25));
  core.addColorStop(0, 'rgba(255,255,255,0.95)'); core.addColorStop(0.25, col(0.9)); core.addColorStop(1, col(0.08));
  g.beginPath(); g.arc(cx, cy, R * (0.92 + L * 0.22), 0, Math.PI * 2); g.fillStyle = core; g.fill();
  // living rings: wobble grows with the voice
  g.lineWidth = Math.max(1, w / 400);
  for (let k = 0; k < 4; k++) {
    g.beginPath();
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const wob = (slow ? 0 : 1) * (Math.sin(a * (3 + k) + t * (1.2 + k * 0.7)) * 0.5 + Math.sin(a * (5 + k * 2) - t * (2 + k)) * 0.5);
      const r = R * (1.15 + k * 0.17) + wob * R * (0.03 + L * 0.22);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath(); g.strokeStyle = col(0.55 - k * 0.11); g.stroke();
  }
  // HUD ticks, turning
  g.save(); g.translate(cx, cy); g.rotate(slow ? 0 : t * (v.state === 'thinking' ? 0.9 : 0.15));
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2, r1 = R * 2.05, r2 = r1 + (i % 6 === 0 ? R * 0.12 : R * 0.05);
    g.beginPath(); g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
    g.strokeStyle = col(i % 6 === 0 ? 0.5 : 0.22); g.stroke();
  }
  g.restore();
  // particles drifting out when JARVIS speaks or hears you
  if (!slow && (v.state === 'speaking' || v.state === 'recording') && P.parts.length < 140 && Math.random() < 0.3 + L) {
    const a = Math.random() * Math.PI * 2;
    P.parts.push({ a, r: R * 1.1, v: R * (0.008 + Math.random() * 0.02) * (1 + L * 3), life: 1 });
  }
  for (const p of P.parts) { p.r += p.v; p.life -= 0.012; g.beginPath(); g.arc(cx + Math.cos(p.a) * p.r, cy + Math.sin(p.a) * p.r, Math.max(1, w / 500) * (1 + p.life), 0, Math.PI * 2); g.fillStyle = col(p.life * 0.8); g.fill(); }
  P.parts = P.parts.filter(p => p.life > 0);
}

// ---------- voice services ----------
const STT_LIST = [['auto', 'خودکار (محلی، وگرنه اولین سرویسِ دارای کلید)'], ['local', 'محلی — whisper.cpp (رایگان، آفلاین)'], ['gemini', 'Google Gemini'], ['openai', 'OpenAI'], ['groq', 'Groq (Whisper، سریع)'], ['elevenlabs', 'ElevenLabs'], ['azure', 'Azure Speech'], ['deepgram', 'Deepgram']];
const TTS_LIST = [['auto', 'خودکار (محلی، وگرنه اولین سرویسِ دارای کلید)'], ['local', 'محلی — Piper (رایگان، آفلاین)'], ['gemini', 'Google Gemini'], ['openai', 'OpenAI'], ['azure', 'Azure Speech (دلارا / فرید)'], ['elevenlabs', 'ElevenLabs']];
const KEYS = [
  ['groq', 'Groq', 'https://console.groq.com/keys', 'شنیدن سریع با Whisper؛ نسخه‌ی رایگان دارد. اگر Groq را در «هسته‌ی هوش مصنوعی» دارید، خودکار استفاده می‌شود.'],
  ['elevenlabs', 'ElevenLabs', 'https://elevenlabs.io/app/settings/api-keys', 'طبیعی‌ترین صداها؛ شنیدن هم دارد. پولی، با سهمیه‌ی رایگان کوچک.'],
  ['azure', 'Azure Speech', 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices', 'صداهای فارسی «دلارا» و «فرید» و شنیدن فارسی. سهمیه‌ی رایگان ماهانه. منطقه (Region) هم لازم است، مثل westeurope.'],
  ['deepgram', 'Deepgram', 'https://console.deepgram.com/', 'فقط شنیدن؛ برای انگلیسی عالی، فارسی محدود.'],
];
async function loadEngines() {
  try { P.eng = await api('/voice/engines'); } catch (e) { const b = P.el && $('#jvEng', P.el); if (b) b.innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  drawEngines();
}
function drawEngines() {
  const box = P.el && $('#jvEng', P.el); if (!box || !P.eng) return;
  const s = st().settings || {}, e = P.eng;
  const legacy = v => v === 'api' ? (s.voiceApi && s.voiceApi !== 'auto' ? s.voiceApi : 'auto') : v;
  const opt = (list, cur, avail) => list.map(([k, l]) => `<option value="${k}" ${k === legacy(cur || 'auto') ? 'selected' : ''}>${esc(l)}${k !== 'auto' && avail && avail[k] === false ? ' — ' + (k === 'local' ? 'دانلود نشده' : 'کلید ندارد') : k !== 'auto' && avail && avail[k] ? ' ✓' : ''}</option>`).join('');
  const azv = (lang, cur) => (e.azureVoices[lang] || []).map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
  box.innerHTML = `
    <div class="field"><label for="jvStt">شنیدن (گفتار به متن)</label><select id="jvStt">${opt(STT_LIST, s.voiceStt, e.stt)}</select></div>
    <div class="field"><label for="jvTts">صحبت کردن (متن به گفتار)</label><select id="jvTts">${opt(TTS_LIST, s.voiceTts, e.tts)}</select></div>
    <div class="jv-grid2">
      <div class="field"><label for="jvAzFa">صدای فارسی Azure</label><select id="jvAzFa">${azv('fa', s.voiceAzureFa)}</select></div>
      <div class="field"><label for="jvAzEn">صدای انگلیسی Azure</label><select id="jvAzEn" dir="ltr">${azv('en', s.voiceAzureEn)}</select></div>
      <div class="field"><label for="jvGem">صدای Gemini</label><select id="jvGem" dir="ltr">${['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Sulafat', 'Achird'].map(x => `<option ${x === (s.voiceGeminiVoice || 'Kore') ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label for="jvOai">صدای OpenAI</label><select id="jvOai" dir="ltr">${['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map(x => `<option ${x === (s.voiceApiVoice || 'alloy') ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label for="jvEl">صدای ElevenLabs</label><div class="row-gap"><input id="jvEl" dir="ltr" value="${esc(s.voiceElevenVoice || '')}" placeholder="voice id"><button type="button" class="btn btn-sm ghost" id="jvElList" ${e.services.elevenlabs.hasKey ? '' : 'disabled'}>فهرست</button></div></div>
    </div>
    <div class="row-gap"><button type="button" class="btn btn-sm btn-primary" id="jvSave">${ic('save', 'sm')}ذخیره</button><button type="button" class="btn btn-sm" id="jvTry">${ic('play', 'sm')}آزمایش صدا</button><span id="jvTryOut" class="help" aria-live="polite"></span></div>
    <h3 class="jv-h3">کلیدها</h3>
    <div class="jv-keys">${KEYS.map(([id, name, url, note]) => { const x = e.services[id] || {}; return `<div class="jv-key">
      <div class="jv-key-h"><b>${name}</b>${x.hasKey ? `<span class="ok">${ic('circle-check', 'sm')}ثبت شده</span>` : x.viaCore ? `<span class="ok">${ic('circle-check', 'sm')}از هسته‌ی هوش مصنوعی</span>` : '<span class="help">کلید ندارد</span>'}<a href="${url}" target="_blank" rel="noopener" class="help">گرفتن کلید</a></div>
      <p class="help">${note}</p>
      <div class="row-gap"><input type="password" dir="ltr" data-key="${id}" placeholder="${x.hasKey ? '(ذخیره شده — برای عوض کردن، تازه بنویسید)' : 'کلید API'}" aria-label="کلید ${name}">${id === 'azure' ? `<input dir="ltr" id="jvAzR" value="${esc(e.azureRegion)}" placeholder="region: westeurope" aria-label="منطقه‌ی Azure" class="jv-region">` : ''}
        <button type="button" class="btn btn-sm" data-savekey="${id}">ذخیره</button>${x.hasKey ? `<button type="button" class="btn btn-sm ghost" data-delkey="${id}" aria-label="پاک کردن کلید ${name}">${ic('trash-2', 'sm')}</button>` : ''}</div></div>`; }).join('')}</div>
    <p class="help">${ic('lock', 'sm')} کلیدها رمزنگاری‌شده روی همین کامپیوتر می‌مانند و فقط به همان سرویس فرستاده می‌شوند. Gemini و OpenAI از «هسته‌ی هوش مصنوعی» خوانده می‌شوند (${e.hasGemini ? 'Gemini ✓' : 'Gemini ندارد'}، ${e.hasOpenai ? 'OpenAI ✓' : 'OpenAI ندارد'}).</p>
    <button type="button" class="btn btn-sm ghost" id="jvMore">${ic('settings', 'sm')}اجزای آفلاین، مغز آفلاین و تنظیمات بیشتر</button>`;
  const val = id => $('#' + id, box).value;
  const save = async () => {
    const body = { voiceStt: val('jvStt'), voiceTts: val('jvTts'), voiceAzureFa: val('jvAzFa'), voiceAzureEn: val('jvAzEn'), voiceGeminiVoice: val('jvGem'), voiceApiVoice: val('jvOai'), voiceElevenVoice: val('jvEl').trim() };
    window.JARVIS_STATE.settings = await api('/settings', { body });
  };
  $('#jvSave', box).onclick = async () => { try { await save(); window.toast('ذخیره شد'); } catch (x) { window.toast(x.message, true); } };
  $('#jvTry', box).onclick = async () => {
    const out = $('#jvTryOut', box); out.textContent = 'در حال ساختن صدا…';
    try {
      await save();
      const r = await api('/voice/try', { body: { engine: val('jvTts'), text: 'سلام! من جارویس هستم. صدای من را خوب می‌شنوید؟' } });
      out.textContent = `${r.engine === 'local' ? 'محلی' : (e.names[r.engine] || r.engine)}${r.fellBack ? ' (سرویس جواب نداد؛ صدای محلی)' : ''} · ${(r.ms / 1000).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} ثانیه`;
      new Audio('data:audio/wav;base64,' + r.audio).play();
    } catch (x) { out.textContent = ''; window.toast(x.message, true); }
  };
  const el = $('#jvElList', box);
  if (el) el.onclick = async () => {
    try { const list = await api('/voice/eleven-voices'); const sel = document.createElement('select'); sel.id = 'jvEl'; sel.dir = 'ltr'; sel.innerHTML = list.map(([k, n]) => `<option value="${esc(k)}" ${k === val('jvEl') ? 'selected' : ''}>${esc(n)}</option>`).join(''); $('#jvEl', box).replaceWith(sel); }
    catch (x) { window.toast(x.message, true); }
  };
  box.querySelectorAll('[data-savekey]').forEach(b => b.onclick = async () => {
    const id = b.dataset.savekey, key = box.querySelector(`[data-key="${id}"]`).value.trim();
    if (!key && !(id === 'azure' && e.services.azure.hasKey)) return window.toast('کلید را بنویسید', true);
    try { P.eng = await api('/voice/keys', { body: { service: id, key: key || undefined, ...(id === 'azure' ? { region: $('#jvAzR', box).value } : {}) } }); window.toast('ذخیره شد'); drawEngines(); } catch (x) { window.toast(x.message, true); }
  });
  box.querySelectorAll('[data-delkey]').forEach(b => b.onclick = async () => {
    if (!confirm('کلید این سرویس از این کامپیوتر پاک شود؟')) return;
    try { P.eng = await api('/voice/keys', { body: { service: b.dataset.delkey, key: '' } }); drawEngines(); } catch (x) { window.toast(x.message, true); }
  });
  $('#jvMore', box).onclick = () => window.voiceDialog && window.voiceDialog();
}

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('jarvis', { icon: 'sparkles', label: 'جارویس', enter, leave });
