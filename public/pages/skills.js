// Skills: what JARVIS's agents know how to do. Make one with AI from a description, write one by hand,
// or upload one (SKILL.md or .zip — shown first, installed only after you confirm).
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const SRC = { custom: 'ساخت شما', imported: 'وارد‌شده', uploaded: 'آپلودشده', voice: 'یادگرفته با صدا' };

const K = { el: null, list: [], edit: null, preview: null, busy: false };
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
      try { const s = await api('/skills', { body: { id: K.edit.id, name: $('#skName', el).value, description: $('#skDesc', el).value, content: $('#skBody', el).value } }); window.toast(`اسکیل «${s.name}» ذخیره شد`); K.edit = null; load(); }
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
  }, 60);
};
