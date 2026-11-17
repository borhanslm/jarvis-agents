// Browser test with a report: open a site (your project's preview or any address) in a hidden
// browser at desktop and phone sizes, follow its links a few pages deep, and get screenshots,
// console errors, failed requests, layout overflow and accessibility problems — plus, if you
// want, a model's verdict. The report can be saved as one HTML file.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const md = t => (window.md ? window.md(t) : `<p dir="auto">${esc(t)}</p>`);
const SEV = { critical: ['bad', 'بحرانی'], major: ['warn', 'مهم'], minor: ['', 'جزئی'], nit: ['', 'سلیقه‌ای'] };
const VP = { desktop: 'دسکتاپ', mobile: 'موبایل' };

const W = { el: null, v: null, url: '', proj: '', pages: 6, vps: { desktop: true, mobile: true }, ai: true, model: '', models: [], progress: null, judging: false, rep: null, shots: {}, filter: 'all' };
async function enter(host) {
  W.el = host; await load();
  try { W.models = (await api('/llms')).filter(m => m.ok !== false && !m.voice && !m.agent); } catch {}
  render();
}
function leave() { W.el = null; }
async function load() {
  try { W.v = await api('/webtest'); } catch (e) { window.toast(e.message, true); return; }
  if (!W.url) { const p = W.v.projects.find(x => x.url); if (p) { W.url = p.url; W.proj = p.id; } }
  if (W.v.running && !W.progress) W.progress = { done: 0, total: 0 };
  render();
}
async function openRep(id) {
  try { W.rep = await api('/webtest/' + id); W.shots = {}; W.filter = 'all'; render(); loadShots(); } catch (e) { window.toast(e.message, true); }
}
async function loadShots() {
  const r = W.rep; if (!r) return;
  for (const p of r.pages) {
    if (p.shot == null || W.shots[p.shot]) continue;
    try { const x = await api(`/webtest/${r.id}/shot/${p.shot}`); if (W.rep !== r) return; W.shots[p.shot] = 'data:image/png;base64,' + x.data; const im = W.el && W.el.querySelector(`[data-shot="${p.shot}"]`); if (im) { im.src = W.shots[p.shot]; im.closest('.wt-shot').classList.remove('loading'); } } catch {}
  }
}

function render() {
  if (!W.el || !W.v) return;
  const v = W.v, busy = !!(W.progress || v.running), groups = [...new Set(W.models.map(m => m.group))];
  W.el.innerHTML = `<div class="pg wt-page">
    <header class="pg-head"><div><h1>${ic('monitor')}تست مرورگر<span class="hud-tag" aria-hidden="true">QA</span></h1>
      <p class="help">سایت را در یک مرورگر پنهان، در اندازه‌ی دسکتاپ و موبایل باز می‌کند و چند صفحه از لینک‌های خودش را می‌گردد: عکس صفحه، خطاهای کنسول، درخواست‌های ناموفق، بیرون‌زدگی صفحه، کندی و مشکلات دسترسی‌پذیری. روی دکمه‌ها کلیک نمی‌کند و فرمی نمی‌فرستد.</p></div></header>
    ${!v.available ? `<p class="sk-warn" role="alert">${ic('triangle-alert', 'sm')}تست مرورگر فقط داخل برنامه‌ی دسکتاپ جارویس کار می‌کند.</p>` : ''}
    <section class="sl-card wt-form"><h2>${ic('scan-search', 'sm')}تست تازه</h2>
      ${v.projects.length ? `<div class="row-gap wt-projs">${v.projects.map(p => `<button type="button" class="btn btn-sm ${W.proj === p.id ? 'btn-primary' : ''}" data-wtproj="${esc(p.id)}" ${p.url ? '' : 'disabled title="آدرس پیش‌نمایش در تنظیمات پروژه نیست"'}>${ic(p.running ? 'circle-check' : 'folder', 'sm')}${esc(p.name)}</button>`).join('')}</div>` : ''}
      <div class="sk-ai-row"><input id="wtUrl" dir="ltr" value="${esc(W.url)}" placeholder="http://localhost:3000" aria-label="آدرس سایت">
        ${busy ? `<button type="button" class="btn danger" id="wtStop">${ic('square', 'sm')}توقف</button>` : `<button type="button" class="btn btn-primary" id="wtGo" ${v.available ? '' : 'disabled'}>${ic('play', 'sm')}شروع تست</button>`}</div>
      <div class="row-gap wt-opts">
        <label class="chk"><input type="checkbox" id="wtD" ${W.vps.desktop ? 'checked' : ''}> دسکتاپ</label>
        <label class="chk"><input type="checkbox" id="wtM" ${W.vps.mobile ? 'checked' : ''}> موبایل</label>
        <label>حداکثر صفحه <input type="number" id="wtN" min="1" max="20" value="${W.pages}" style="width:4.5em"></label>
        <label class="chk"><input type="checkbox" id="wtAi" ${W.ai ? 'checked' : ''}> نظر هوش مصنوعی</label>
        <select id="wtModel" aria-label="مدل نظردهنده" ${W.ai ? '' : 'disabled'}><option value="">مدل تستر تیم</option>${groups.map(g => `<optgroup label="${esc(g)}">${W.models.filter(m => m.group === g).map(m => `<option value="${esc(m.spec)}" ${m.spec === W.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('')}</select></div>
      ${busy ? `<p class="help" role="status">${ic('refresh-cw', 'sm spin')}در حال تست… ${W.progress && W.progress.url ? `<code dir="ltr">${esc(W.progress.url)}</code> (${VP[W.progress.viewport]}) · ${faN(W.progress.done)} از ${faN(W.progress.total)}` : ''}</p>` : W.judging ? `<p class="help" role="status">${ic('sparkles', 'sm')}هوش مصنوعی در حال نوشتن نظر…</p>` : ''}
    </section>
    <div class="wt-grid">
      <section class="sl-card wt-hist"><h2>${ic('history', 'sm')}گزارش‌ها</h2>
        ${v.list.length ? `<ul class="wt-list" role="list">${v.list.map(x => `<li><button type="button" class="wt-item ${W.rep && W.rep.id === x.id ? 'on' : ''}" data-wtrep="${x.id}"><span class="wt-score ${cls(x.score)}">${faN(x.score)}</span><span><b dir="ltr">${esc(x.url.replace(/^https?:\/\//, ''))}</b><small class="help">${new Date(x.at).toLocaleString('fa-IR')} · ${faN(x.problems)} مشکل</small></span></button></li>`).join('')}</ul>` : '<p class="help">هنوز تستی اجرا نشده.</p>'}
      </section>
      <section class="sl-card wt-rep" aria-live="polite">${repHtml()}</section>
    </div></div>`;
  bind();
}
const cls = s => s >= 85 ? 'ok' : s >= 60 ? 'warn' : 'bad';
function repHtml() {
  const r = W.rep;
  if (!r) return `<div class="sms-none">${ic('monitor')}<p class="help">یک گزارش را انتخاب کنید یا تست تازه بزنید.</p></div>`;
  const probs = r.problems.filter(p => W.filter === 'all' || p.sev === W.filter);
  const cnt = s => r.problems.filter(p => p.sev === s).length;
  return `<div class="wt-head"><div class="wt-big ${cls(r.score)}"><b>${faN(r.score)}</b><small>از ۱۰۰</small></div>
      <div><h2 dir="ltr">${esc(r.url)}</h2><p class="help">${new Date(r.at).toLocaleString('fa-IR')} · ${faN(r.pages.length)} بازدید${r.stopped ? ' · متوقف شد' : ''}</p>
      <div class="row-gap"><button type="button" class="btn btn-sm" id="wtHtml">${ic('download', 'sm')}ذخیره‌ی گزارش HTML</button>
        ${r.verdict ? '' : `<button type="button" class="btn btn-sm" id="wtJudge" ${W.judging ? 'disabled' : ''}>${ic('sparkles', 'sm')}نظر هوش مصنوعی</button>`}
        <button type="button" class="btn btn-sm" id="wtAgain">${ic('refresh-cw', 'sm')}تکرار تست</button>
        <button type="button" class="btn btn-sm ghost danger" id="wtDel">${ic('trash-2', 'sm')}حذف</button></div></div></div>
    ${r.verdict ? `<details open class="wt-verdict"><summary>${ic('sparkles', 'sm')}نظر هوش مصنوعی</summary><div class="md" dir="auto">${md(r.verdict)}</div></details>` : ''}
    <h3 class="pg-sub">مشکلات (${faN(r.problems.length)})</h3>
    <div class="row-gap wt-filt" role="group" aria-label="فیلتر">${['all', 'critical', 'major', 'minor', 'nit'].map(s => `<button type="button" class="role ${W.filter === s ? 'on' : ''}" data-wtf="${s}">${s === 'all' ? 'همه' : SEV[s][1]} ${faN(s === 'all' ? r.problems.length : cnt(s))}</button>`).join('')}</div>
    ${probs.length ? `<ul class="pr-issues" role="list">${probs.slice(0, 120).map(p => `<li class="${SEV[p.sev][0]}"><span class="role on">${SEV[p.sev][1]}</span> <b dir="ltr">${esc(p.where)}</b><div dir="auto">${esc(p.text)}</div>${p.sample ? `<code dir="ltr">${esc(p.sample)}</code>` : ''}${p.src ? `<small class="help" dir="ltr">${esc(p.src)}</small>` : ''}</li>`).join('')}</ul>` : `<p class="help">${r.problems.length ? 'در این دسته مشکلی نیست.' : 'مشکلی پیدا نشد. 🎉'}</p>`}
    <h3 class="pg-sub">صفحه‌ها</h3>
    <div class="wt-pages">${r.pages.map(p => `<figure class="wt-pg ${p.viewport}"><div class="wt-shot ${p.shot != null && !W.shots[p.shot] ? 'loading' : ''}">${p.shot != null ? `<img data-shot="${p.shot}" alt="عکس ${esc(p.path)} در ${VP[p.viewport]}" src="${W.shots[p.shot] || 'data:,'}">` : `<div class="wt-noshot">${ic('triangle-alert')}</div>`}</div>
      <figcaption><b dir="auto">${esc(p.title || p.path)}</b><small class="help"><span dir="ltr">${esc(p.path)}</span> · ${VP[p.viewport]} · ${p.error ? `<span class="bad">${esc(p.error)}</span>` : `${faN((p.ms / 1000).toFixed(1))} ثانیه${p.status ? ` · ${p.status}` : ''}`}</small></figcaption></figure>`).join('')}</div>`;
}
function bind() {
  const el = W.el, on = (id, f) => { const x = $('#' + id, el); if (x) x.onclick = f; };
  const u = $('#wtUrl', el); if (u) { u.oninput = () => { W.url = u.value; W.proj = ''; }; u.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); start(); } }; }
  const chk = (id, f) => { const x = $('#' + id, el); if (x) x.onchange = () => f(x); };
  chk('wtD', x => { W.vps.desktop = x.checked; }); chk('wtM', x => { W.vps.mobile = x.checked; });
  chk('wtN', x => { W.pages = Math.max(1, Math.min(20, +x.value || 6)); });
  chk('wtAi', x => { W.ai = x.checked; render(); }); chk('wtModel', x => { W.model = x.value; });
  el.querySelectorAll('[data-wtproj]').forEach(b => b.onclick = () => { const p = W.v.projects.find(x => x.id === b.dataset.wtproj); if (p) { W.url = p.url; W.proj = p.id; render(); } });
  el.querySelectorAll('[data-wtrep]').forEach(b => b.onclick = () => openRep(b.dataset.wtrep));
  el.querySelectorAll('[data-wtf]').forEach(b => b.onclick = () => { W.filter = b.dataset.wtf; render(); });
  on('wtGo', start);
  on('wtStop', async () => { try { await api('/webtest/stop', { body: {} }); } catch (e) { window.toast(e.message, true); } });
  on('wtAgain', () => { W.url = W.rep.url; W.proj = W.rep.projectId || ''; start(); });
  on('wtDel', async () => { if (!confirm('این گزارش حذف شود؟')) return; try { await api('/webtest/' + W.rep.id, { method: 'DELETE' }); W.rep = null; load(); } catch (e) { window.toast(e.message, true); } });
  on('wtJudge', async () => { W.judging = true; render(); try { W.rep = await api(`/webtest/${W.rep.id}/verdict`, { body: { model: W.model }, timeout: 320000 }); } catch (e) { window.toast(e.message, true); } W.judging = false; render(); loadShots(); });
  on('wtHtml', async () => {
    try { const { html } = await api(`/webtest/${W.rep.id}/html`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' })); a.download = `jarvis-webtest-${W.rep.id}.html`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); } catch (e) { window.toast(e.message, true); }
  });
}
async function start() {
  const vps = Object.keys(W.vps).filter(k => W.vps[k]);
  if (!W.url.trim()) return window.toast('آدرس سایت را بنویسید', true);
  if (!vps.length) return window.toast('حداقل یکی از دسکتاپ یا موبایل را انتخاب کنید', true);
  try { await api('/webtest/run', { body: { url: W.url.trim(), projectId: W.proj, maxPages: W.pages, viewports: vps, ai: W.ai, model: W.model } }); W.progress = { done: 0, total: W.pages * vps.length }; W.rep = null; render(); } catch (e) { window.toast(e.message, true); }
}
window.addEventListener('jarvis:ev', e => {
  const d = e.detail || {}; if (d.type !== 'webtest') return;
  if (d.progress) { W.progress = d.progress; if (W.el) render(); }
  if (d.judging) { W.progress = null; W.judging = true; if (W.el) render(); }
  if (d.done) { W.progress = null; W.judging = false; const same = W.rep && W.rep.id === d.report.id; W.rep = d.report; if (!same) W.shots = {}; if (W.el) load().then(loadShots); if (!d.report.verdict) window.toast(`تست مرورگر تمام شد: امتیاز ${faN(d.report.score)} — ${faN(d.report.problems.length)} مشکل`); }
  if (d.error) { W.progress = null; W.judging = false; window.toast(d.error, true); if (W.el) load(); }
});

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('webtest', { icon: 'monitor', label: 'تست مرورگر', enter, leave });
