// Skills: what JARVIS's agents know how to do. Make one with AI from a description, write one by hand,
// or upload one (SKILL.md or .zip — shown first, installed only after you confirm).
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const SRC = { custom: 'ساخت شما', imported: 'وارد‌شده', uploaded: 'آپلودشده', voice: 'یادگرفته با صدا', video: 'یادگرفته از ویدیو' };

const K = { el: null, list: [], edit: null, preview: null, busy: false, vid: null };
function enter(host) { K.el = host; load(); }
function leave() { K.el = null; }
async function load() { try { K.list = await api('/skills'); } catch (e) { window.toast(e.message, true); } render(); }

function render() {
  if (!K.el) return;
  K.el.innerHTML = `<div class="pg sk-page">
    <header class="pg-head"><div><h1>${ic('graduation-cap')}اسکیل‌ها<span class="hud-tag" aria-hidden="true">SKILLS</span></h1>
      <p class="help">اسکیل یعنی «روش انجام یک کار» که ایجنت‌ها و جارویس دنبالش می‌کنند. با هوش مصنوعی بسازید، دستی بنویسید یا فایلش را آپلود کنید.</p></div>
      <div class="sk-actions"><button type="button" class="btn ghost" id="skBack" title="اتصال‌ها، پلاگین‌ها و اسکیل‌ها">${ic('puzzle', 'sm')}اتصال‌ها و پلاگین‌ها</button><button type="button" class="btn" id="skUpBtn">${ic('upload', 'sm')}آپلود اسکیل</button><button type="button" class="btn btn-primary" id="skNew">${ic('plus', 'sm')}اسکیل تازه</button>
        <input type="file" id="skFile" accept=".md,.markdown,.zip,.txt" hidden></div></header>
    <section class="sl-card sk-ai"><h2>${ic('sparkles', 'sm')}ساخت با هوش مصنوعی</h2>
      <p class="help">بنویسید اسکیل چه کار کند؛ جارویس متنش را می‌نویسد و شما قبل از ذخیره می‌بینید و ویرایش می‌کنید.</p>
      <div class="sk-ai-row"><textarea id="skIdea" rows="2" dir="auto" placeholder="مثلاً: قبل از هر انتشار، تست‌ها را اجرا کن، نسخه را بالا ببر، تغییرات را در CHANGELOG بنویس و یک خلاصه به فارسی بده"></textarea>
        <button type="button" class="btn btn-primary" id="skDraft" ${K.busy ? 'disabled' : ''}>${ic('sparkles', 'sm')}${K.busy ? 'در حال نوشتن…' : 'بنویس'}</button></div></section>
    <section class="sl-card sk-ai sk-vid"><h2>${ic('play', 'sm')}یادگیری با ویدیو</h2>
      <p class="help">یک فیلم از صفحه (ضبط صفحه‌ی کامپیوتر یا گوشی) یا یک ویدیوی آموزشی بدهید، مثلاً «خرید از دیجی‌کالا» یا «سفارش از اسنپ». جارویس فریم‌ها و صدای ویدیو را می‌بیند و می‌شنود، قدم‌ها را می‌نویسد و شما قبل از ذخیره بررسی می‌کنید. بعد کافی است بگویید «از دیجی‌کالا فلان چیز را بخر» تا خودش همان قدم‌ها را انجام دهد. <b>پرداخت آخر همیشه با تأیید خود شماست.</b></p>
      <div class="sk-vid-row"><label class="btn" for="skVidFile">${ic('upload', 'sm')}انتخاب ویدیو</label><input type="file" id="skVidFile" accept="video/*" hidden>
        <select id="skVidTarget" aria-label="کجا انجام شود"><option value="computer">روی این کامپیوتر انجام شود</option><option value="phone">روی گوشی انجام شود</option></select></div>
      <textarea id="skVidNote" rows="2" dir="auto" placeholder="اختیاری: این ویدیو چه چیزی یاد می‌دهد؟ (مثلاً: سفارش غذا از اسنپ‌فود)"></textarea>
      ${K.vid ? `<div class="sk-vid-st" role="status">${K.vid.error ? `<span class="sk-warn">${ic('triangle-alert', 'sm')}${esc(K.vid.error)}</span>` : `<progress max="1" value="${K.vid.p || 0}"></progress><span>${esc(K.vid.msg || '')}</span>`}</div>` : ''}
      ${K.vid && K.vid.frames ? `<div class="sk-vid-frames" aria-label="فریم‌های انتخاب‌شده">${K.vid.frames.map(f => `<img src="data:image/jpeg;base64,${f.data}" alt="فریم ${esc(mmss(f.t))}" title="${esc(mmss(f.t))}">`).join('')}</div>` : ''}
    </section>
    <div class="sk-drop" id="skDrop" aria-hidden="true">${ic('upload')}<span>فایل SKILL.md یا zip را این‌جا رها کنید</span></div>
    ${K.preview ? previewHtml() : ''}
    ${K.edit ? editorHtml() : ''}
    <h2 class="pg-sub">کتابخانه (${faN(K.list.length)})</h2>
    ${K.list.length ? `<div class="sk-list">${K.list.map(s => `<div class="sk-item"><span class="ag-ic">${ic('book-open')}</span><div class="sk-b"><b dir="ltr">${esc(s.name)}</b><span class="help" dir="auto">${esc(s.description)}</span><small class="help">${esc(SRC[s.source] || s.source || '')}</small></div>
      <button type="button" class="btn btn-sm ghost" data-skedit="${esc(s.id)}">${ic('pencil', 'sm')}ویرایش</button><button type="button" class="btn btn-sm ghost danger" data-skdel="${esc(s.id)}" aria-label="حذف ${esc(s.name)}">${ic('trash-2', 'sm')}</button></div>`).join('')}</div>`
      : `<div class="tk-empty">${ic('graduation-cap')}<h3>هنوز اسکیلی ندارید</h3><p class="help">با «ساخت با هوش مصنوعی» شروع کنید یا یک فایل اسکیل آپلود کنید.</p></div>`}
  </div>`;
  bind();
}
function editorHtml() {
  const e = K.edit;
  return `<section class="sl-card sk-edit" aria-label="ویرایش اسکیل"><h2>${ic('pencil', 'sm')}${e.id ? 'ویرایش اسکیل' : 'اسکیل تازه'}</h2>
    <div class="field"><label for="skName">نام (انگلیسی، با خط تیره)</label><input id="skName" dir="ltr" value="${esc(e.name)}" placeholder="release-checklist"></div>
    <div class="field"><label for="skDesc">توضیح — ایجنت از روی این تصمیم می‌گیرد کی از آن استفاده کند</label><input id="skDesc" dir="auto" value="${esc(e.description)}"></div>
    <div class="field"><label for="skBody">دستورالعمل (Markdown)</label><textarea id="skBody" rows="14" dir="auto">${esc(e.body || '')}</textarea></div>
    <div class="row-gap"><button type="button" class="btn btn-primary" id="skSave">${ic('save', 'sm')}ذخیره</button><button type="button" class="btn ghost" id="skCancel">انصراف</button></div></section>`;
}
function previewHtml() {
  const p = K.preview;
  return `<section class="sl-card sk-prev" aria-label="پیش‌نمایش آپلود"><h2>${ic('eye', 'sm')}پیش‌نمایش: <span dir="ltr">${esc(p.name)}</span></h2>
    <p class="help" dir="auto">${esc(p.description || '(بدون توضیح)')}</p>
    <div class="help">${faN(p.fileCount)} فایل: <span dir="ltr">${p.files.slice(0, 12).map(esc).join('، ')}${p.fileCount > 12 ? '، …' : ''}</span></div>
    ${p.runnable.length ? `<div class="sk-warn">${ic('triangle-alert', 'sm')}این اسکیل فایل‌های اجرایی دارد (<span dir="ltr">${p.runnable.slice(0, 6).map(esc).join('، ')}</span>). فقط اگر به منبعش اعتماد دارید نصب کنید؛ ایجنت‌ها ممکن است آن‌ها را اجرا کنند.</div>` : ''}
    <details><summary>متن SKILL.md</summary><pre class="sk-pre" dir="auto">${esc(p.body)}</pre></details>
    <div class="row-gap"><button type="button" class="btn btn-primary" id="skInstall">${ic('download', 'sm')}نصب در کتابخانه</button><button type="button" class="btn ghost" id="skDrop2">انصراف</button></div></section>`;
}
// ---------- learning from a video ----------
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const vstate = o => { K.vid = { ...(K.vid || {}), ...o }; render(); };
const seek = (v, t) => new Promise(r => { v.onseeked = () => r(); v.currentTime = t; });
// frames where the screen changed (at most 20), downscaled to 1024px JPEG
async function videoFrames(file, onP) {
  const url = URL.createObjectURL(file), v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('این ویدیو باز نشد؛ mp4 یا webm بدهید')); });
    // recorded webm files often have no duration: jumping far ahead makes the browser work it out
    if (!isFinite(v.duration)) { await new Promise(r => { const t = setTimeout(r, 8000); v.ondurationchange = () => { if (isFinite(v.duration)) { clearTimeout(t); r(); } }; v.currentTime = 1e7; }); await seek(v, 0); }
    const dur = v.duration; if (!isFinite(dur) || dur <= 0) throw new Error('طول ویدیو معلوم نیست');
    if (dur > 20 * 60) throw new Error('ویدیو حداکثر ۲۰ دقیقه باشد');
    const W = Math.min(1024, v.videoWidth || 1024), H = Math.round((v.videoHeight || 576) * W / (v.videoWidth || 1024));
    const big = Object.assign(document.createElement('canvas'), { width: W, height: H }), bg = big.getContext('2d');
    const sm = Object.assign(document.createElement('canvas'), { width: 48, height: 27 }), sg = sm.getContext('2d', { willReadFrequently: true });
    const step = Math.max(0.75, dur / 150), picks = []; let prev = null;
    for (let t = 0; t < dur; t += step) {
      await seek(v, Math.min(t, dur - 0.05)); sg.drawImage(v, 0, 0, 48, 27);
      const px = sg.getImageData(0, 0, 48, 27).data; let diff = 0;
      if (prev) { for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - prev[i]) + Math.abs(px[i + 1] - prev[i + 1]) + Math.abs(px[i + 2] - prev[i + 2]); diff /= (px.length / 4) * 3; }
      if (!prev || diff > 6) { bg.drawImage(v, 0, 0, W, H); picks.push({ t, diff: prev ? diff : 999, data: big.toDataURL('image/jpeg', 0.72).split(',')[1] }); }
      prev = px; onP(t / dur);
    }
    await seek(v, Math.max(0, dur - 0.1)); bg.drawImage(v, 0, 0, W, H); picks.push({ t: dur, diff: 998, data: big.toDataURL('image/jpeg', 0.72).split(',')[1] }); // the end result
    // the 20 biggest changes, back in time order
    return picks.sort((a, b) => b.diff - a.diff).slice(0, 20).sort((a, b) => a.t - b.t).map(({ t, data }) => ({ t, data }));
  } finally { URL.revokeObjectURL(url); }
}
function wav16(samples) {
  const b = new ArrayBuffer(44 + samples.length * 2), d = new DataView(b), w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); d.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, 16000, true); d.setUint32(28, 32000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  const u8 = new Uint8Array(b); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s);
}
// the narration: decoded at 16 kHz, sent in ~50 s pieces to the same speech recognition as the voice assistant
async function videoSpeech(file, onP) {
  let audio; try { const ctx = new AudioContext({ sampleRate: 16000 }); audio = await ctx.decodeAudioData(await file.arrayBuffer()); ctx.close(); } catch { return ''; } // no sound track
  const x = audio.getChannelData(0), n = 16000 * 50, out = [];
  for (let i = 0; i < x.length; i += n) {
    const part = x.subarray(i, i + n); let e = 0; for (let j = 0; j < part.length; j += 16) e += part[j] * part[j];
    if (Math.sqrt(e / (part.length / 16)) > 0.006) { try { const r = await api('/voice/stt', { body: { audio: wav16(part) }, timeout: 120000 }); if (r.text) out.push(r.text); } catch {} }
    onP(Math.min(1, (i + n) / x.length));
  }
  return out.join(' ');
}
async function learnVideo(file, target, note) {
  if (file.size > 800e6) return window.toast('ویدیو بزرگ‌تر از ۸۰۰ مگابایت است', true);
  const bar = v => { const pr = K.el && K.el.querySelector('.sk-vid-st progress'); if (pr) pr.value = v; if (K.vid) K.vid.p = v; };
  try {
    vstate({ p: 0, msg: 'دیدن ویدیو و برداشتن فریم‌ها…', error: '', frames: null });
    const frames = await videoFrames(file, p => bar(p * 0.4));
    vstate({ frames, p: 0.4, msg: `${frames.length} فریم برداشته شد؛ گوش دادن به صدای ویدیو…` });
    const transcript = await videoSpeech(file, p => bar(0.4 + p * 0.3));
    vstate({ p: 0.7, msg: 'نوشتن قدم‌ها با هوش مصنوعی… (ممکن است یکی دو دقیقه طول بکشد)' });
    const d = await api('/skills/from-video', { body: { frames, transcript, note, target }, timeout: 420000 });
    K.vid = null; K.edit = { name: d.name, description: d.description, body: d.body, source: 'video' }; K.preview = null;
    window.toast('قدم‌ها آماده است؛ بخوانید، اگر لازم است اصلاح کنید و ذخیره کنید'); render();
    const e = K.el && $('#skName', K.el); if (e) e.scrollIntoView({ block: 'center' });
  } catch (e) { vstate({ error: e.message }); }
}
async function upload(file) {
  if (!file) return;
  if (file.size > 5e6) return window.toast('فایل بزرگ‌تر از ۵ مگابایت است', true);
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
  try { K.preview = await api('/skills/upload', { body: { fileName: file.name, data: b64 } }); K.edit = null; render(); } catch (e) { window.toast(e.message, true); }
}
function bind() {
  const el = K.el;
  $('#skNew', el).onclick = () => { K.edit = { name: '', description: '', body: '## When to use\n\n## Steps\n1. \n\n## Output\n' }; K.preview = null; render(); $('#skName', el).focus(); };
  $('#skUpBtn', el).onclick = () => $('#skFile', el).click();
  $('#skVidFile', el).onchange = e => { const f = e.target.files[0]; if (f) learnVideo(f, $('#skVidTarget', el).value, $('#skVidNote', el).value); };
  $('#skBack', el).onclick = () => window.extDialog && window.extDialog('skills');
  $('#skFile', el).onchange = e => upload(e.target.files[0]);
  // drag a file anywhere on the page
  el.ondragover = e => { e.preventDefault(); el.classList.add('sk-dragging'); };
  el.ondragleave = e => { if (!el.contains(e.relatedTarget)) el.classList.remove('sk-dragging'); };
  el.ondrop = e => { e.preventDefault(); el.classList.remove('sk-dragging'); upload(e.dataTransfer.files[0]); };
  $('#skDraft', el).onclick = async () => {
    const idea = $('#skIdea', el).value.trim(); if (!idea) return window.toast('بنویسید اسکیل چه کار کند', true);
    K.busy = true; render(); $('#skIdea', el).value = idea;
    try { const d = await api('/skills/draft', { body: { idea }, timeout: 200000 }); K.edit = { ...d }; K.preview = null; window.toast('پیش‌نویس آماده است؛ ببینید و ذخیره کنید'); }
    catch (e) { window.toast(e.message, true); }
    K.busy = false; render();
  };
  if (K.edit) {
    $('#skCancel', el).onclick = () => { K.edit = null; render(); };
    $('#skSave', el).onclick = async () => {
      try { const s = await api('/skills', { body: { id: K.edit.id, name: $('#skName', el).value, description: $('#skDesc', el).value, content: $('#skBody', el).value, ...(K.edit.source ? { source: K.edit.source } : {}) } }); window.toast(`اسکیل «${s.name}» ذخیره شد`); K.edit = null; load(); }
      catch (e) { window.toast(e.message, true); }
    };
  }
  if (K.preview) {
    $('#skInstall', el).onclick = async () => { try { const s = await api('/skills/upload/confirm', { body: { token: K.preview.token } }); window.toast(`اسکیل «${s.name}» نصب شد`); K.preview = null; load(); } catch (e) { window.toast(e.message, true); K.preview = null; render(); } };
    $('#skDrop2', el).onclick = () => { api('/skills/upload/cancel', { body: { token: K.preview.token } }).catch(() => {}); K.preview = null; render(); };
  }
  el.querySelectorAll('[data-skedit]').forEach(b => b.onclick = async () => { try { const s = await api('/skills/' + b.dataset.skedit); K.edit = { id: s.id, name: s.name, description: s.description, body: s.body }; K.preview = null; render(); } catch (e) { window.toast(e.message, true); } });
  el.querySelectorAll('[data-skdel]').forEach(b => b.onclick = async () => { const s = K.list.find(x => x.id === b.dataset.skdel); if (!confirm(`اسکیل «${s.name}» حذف شود؟ از ساب‌ایجنت‌ها هم جدا می‌شود.`)) return; await api('/skills/' + s.id, { method: 'DELETE' }); load(); });
}
window.addEventListener('jarvis:ev', e => { if (e.detail && e.detail.type === 'skills' && K.el && !K.edit && !K.preview) { K.list = e.detail.skills; render(); } });

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
// lives inside «اتصال‌ها، پلاگین‌ها و اسکیل‌ها» (a tab there opens this page), so no rail button of its own
window.registerView('skills', { icon: 'graduation-cap', label: 'اسکیل‌ها', norail: true, enter, leave });
window.openSkills = (what) => {
  window.showSection && window.showSection('skills');
  setTimeout(() => {
    if (!K.el) return;
    if (what === 'ai') { const i = $('#skIdea', K.el); if (i) { i.focus(); i.scrollIntoView({ block: 'center' }); } }
    if (what === 'upload') $('#skFile', K.el).click();
    if (what === 'new') $('#skNew', K.el).click();
    if (what === 'video') { const v = K.el.querySelector('.sk-vid'); if (v) v.scrollIntoView({ block: 'center' }); }
  }, 60);
};
