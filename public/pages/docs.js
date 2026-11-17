// Knowledge base: folders of your own documents, indexed on this computer; ask a question and
// JARVIS answers from them with the sources ([1] file name). Also used by chat («از اسناد من») and voice.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const md = t => (window.md ? window.md(t) : `<p dir="auto">${esc(t)}</p>`);
const base = f => String(f).split(/[\\/]/).pop();

const D = { el: null, v: null, q: '', answer: null, busy: false, progress: null, showFiles: false };
async function enter(host) { D.el = host; await load(); }
function leave() { D.el = null; }
async function load() { try { D.v = await api('/kb'); } catch (e) { window.toast(e.message, true); } render(); }

function render() {
  if (!D.el || !D.v) return;
  const v = D.v, idx = D.progress || v.busy;
  const errs = v.list.filter(x => x.error);
  D.el.innerHTML = `<div class="pg kb-page">
    <header class="pg-head"><div><h1>${ic('book-open')}پایگاه دانش<span class="hud-tag" aria-hidden="true">DOCS</span></h1>
      <p class="help">پوشه‌های اسنادتان را بدهید: یادداشت، قرارداد، فاکتور، کتابچه، گزارش (Word، PDF، متن، Markdown، CSV، HTML). جارویس روی همین کامپیوتر فهرستشان می‌کند و از رویشان جواب می‌دهد، با نام فایل به‌عنوان منبع. فایل‌ها جایی فرستاده نمی‌شوند؛ فقط چند تکه‌ی مرتبط برای جواب به مدل می‌رود.</p></div></header>
    <section class="sl-card kb-ask"><h2>${ic('search', 'sm')}از اسنادتان بپرسید</h2>
      <div class="sk-ai-row"><input id="kbQ" dir="auto" value="${esc(D.q)}" placeholder="مثلاً: مهلت پرداخت قرارداد اجاره کی است؟" ${v.chunks ? '' : 'disabled'}>
        <button type="button" class="btn btn-primary" id="kbAsk" ${D.busy || !v.chunks ? 'disabled' : ''}>${ic('sparkles', 'sm')}${D.busy ? 'در حال خواندن…' : 'بپرس'}</button>
        <button type="button" class="btn" id="kbFind" ${!v.chunks ? 'disabled' : ''}>${ic('search', 'sm')}فقط پیدا کن</button></div>
      ${!v.chunks ? '<p class="help">اول یک پوشه اضافه کنید.</p>' : ''}
      ${D.answer ? `${D.answer.answer ? `<div class="md kb-answer" dir="auto">${md(D.answer.answer)}</div>` : ''}
        ${D.answer.hits.length ? `<h3 class="pg-sub">منبع‌ها</h3><ol class="kb-hits">${D.answer.hits.map(h => `<li><b dir="auto" title="${esc(h.file)}">${esc(h.name)}</b> <small class="help">بخش ${faN(h.part)}</small><p class="help" dir="auto">${esc(h.text.slice(0, 320))}${h.text.length > 320 ? '…' : ''}</p></li>`).join('')}</ol>` : '<p class="help">چیزی پیدا نشد.</p>'}` : ''}
    </section>
    <section class="sl-card kb-folders"><h2>${ic('folder', 'sm')}پوشه‌ها</h2>
      ${v.folders.length ? `<ul class="kb-fl" role="list">${v.folders.map(f => `<li><span dir="ltr">${esc(f)}</span><button type="button" class="btn btn-sm ghost danger" data-kbrm="${esc(f)}">${ic('trash-2', 'sm')}برداشتن</button></li>`).join('')}</ul>` : '<p class="help">هنوز پوشه‌ای اضافه نشده.</p>'}
      <div class="row-gap">${window.jarvisDesktop && window.jarvisDesktop.pickFolder ? `<button type="button" class="btn btn-primary" id="kbPick">${ic('folder-plus', 'sm')}انتخاب پوشه…</button>` : ''}
        <button type="button" class="btn" data-kbadd="documents">${ic('folder', 'sm')}Documents</button><button type="button" class="btn" data-kbadd="desktop">${ic('folder', 'sm')}Desktop</button>
        <button type="button" class="btn ghost" id="kbRe" ${idx ? 'disabled' : ''}>${ic('refresh-cw', 'sm')}به‌روزرسانی فهرست</button></div>
      <div class="pl-install"><input id="kbPath" dir="ltr" placeholder="C:\\Users\\you\\Documents\\Contracts" aria-label="مسیر پوشه"><button type="button" class="btn btn-sm" id="kbAddPath">${ic('plus', 'sm')}افزودن مسیر</button></div>
      <p class="help" role="status">${idx ? `در حال خواندن فایل‌ها… ${faN(idx.done || 0)} از ${faN(idx.total || 0)}` : `${faN(v.files)} فایل، ${faN(v.chunks)} تکه‌ی متن${errs.length ? ` · ${faN(errs.length)} فایل خوانده نشد` : ''}`}${v.pdfTool ? '' : ' · برای PDFهای پیچیده (مثلاً فارسی) ابزار pdftotext نصب نیست؛ فقط PDFهای ساده خوانده می‌شوند.'}</p>
      ${v.list.length ? `<details ${D.showFiles ? 'open' : ''} id="kbFilesD"><summary>فهرست فایل‌ها</summary><ul class="kb-files">${v.list.slice(0, 500).map(x => `<li class="${x.error ? 'bad' : ''}" title="${esc(x.file)}"><span dir="auto">${esc(base(x.file))}</span><small class="help">${x.error ? (x.error === 'no text' ? 'متنی ندارد' : x.error === 'too big' ? 'خیلی بزرگ' : 'خوانده نشد') : faN(x.chunks) + ' تکه'}</small></li>`).join('')}</ul></details>` : ''}
    </section></div>`;
  bind();
}
async function addFolder(dir) { try { D.v = await api('/kb/folders', { body: { dir } }); D.progress = { done: 0, total: 0 }; window.toast('پوشه اضافه شد؛ در حال خواندن فایل‌ها…'); render(); } catch (e) { window.toast(e.message, true); } }
function bind() {
  const el = D.el, on = (id, f) => { const x = $('#' + id, el); if (x) x.onclick = f; };
  const q = $('#kbQ', el); if (q) { q.oninput = () => { D.q = q.value; }; q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ask(); } }; }
  on('kbAsk', ask);
  on('kbFind', async () => { if (!D.q.trim()) return; try { const r = await api('/kb/search?q=' + encodeURIComponent(D.q.trim())); D.answer = { answer: '', hits: r.hits }; render(); } catch (e) { window.toast(e.message, true); } });
  on('kbPick', async () => { const d = await window.jarvisDesktop.pickFolder('پوشه‌ی اسناد'); if (d) addFolder(d); });
  el.querySelectorAll('[data-kbadd]').forEach(b => b.onclick = () => addFolder(b.dataset.kbadd));
  on('kbAddPath', () => { const p = $('#kbPath', el).value.trim(); if (p) addFolder(p); });
  on('kbRe', async () => { try { await api('/kb/reindex', { body: {} }); D.progress = { done: 0, total: 0 }; render(); } catch (e) { window.toast(e.message, true); } });
  el.querySelectorAll('[data-kbrm]').forEach(b => b.onclick = async () => { if (!confirm('این پوشه از پایگاه دانش برداشته شود؟ (خود فایل‌ها پاک نمی‌شوند)')) return; try { D.v = await api('/kb/remove', { body: { dir: b.dataset.kbrm } }); render(); } catch (e) { window.toast(e.message, true); } });
  const fd = $('#kbFilesD', el); if (fd) fd.ontoggle = () => { D.showFiles = fd.open; };
}
async function ask() {
  if (!D.q.trim() || D.busy) return;
  D.busy = true; D.answer = null; render();
  try { D.answer = await api('/kb/ask', { body: { q: D.q.trim() }, timeout: 160000 }); } catch (e) { window.toast(e.message, true); }
  D.busy = false; render();
}
window.addEventListener('jarvis:ev', e => {
  const d = e.detail || {}; if (d.type !== 'kb') return;
  if (d.progress) { D.progress = d.progress; const s = D.el && D.el.querySelector('.kb-folders [role=status]'); if (s) s.textContent = `در حال خواندن فایل‌ها… ${faN(d.progress.done)} از ${faN(d.progress.total)}`; }
  if (d.done) { D.progress = null; D.v = d.view; if (D.el) render(); window.toast(`فهرست اسناد آماده است: ${faN(d.view.files)} فایل`); }
  if (d.error) { D.progress = null; window.toast(d.error, true); load(); }
});

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('docs', { icon: 'book-open', label: 'پایگاه دانش', enter, leave });
