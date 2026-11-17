// Pull request review: open PRs of your projects' GitHub repos, an AI review (any model),
// and — only after you confirm — the review posted on GitHub, or the issues handed to the team.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const md = t => (window.md ? window.md(t) : `<p dir="auto">${esc(t)}</p>`);
const SEV = { critical: ['bad', 'بحرانی'], major: ['warn', 'مهم'], minor: ['', 'جزئی'], nit: ['', 'سلیقه‌ای'] };
const VERD = { approve: ['circle-check', 'قابل ادغام'], comment: ['message-square', 'نظر'], request_changes: ['triangle-alert', 'نیاز به اصلاح'] };

const R = { el: null, projects: null, project: '', list: null, repo: '', error: '', models: [], model: '', sel: null, busy: false, res: null };
async function enter(host) {
  R.el = host; render();
  try { R.projects = (await api('/prs/projects')).projects; } catch (e) { R.projects = []; R.error = e.message; }
  try { R.models = (await api('/llms')).filter(m => m.ok !== false && !m.voice && !m.agent); } catch {}
  if (!R.project && R.projects.length) R.project = R.projects[0].id;
  render(); if (R.project) loadList();
}
function leave() { R.el = null; }
async function loadList() {
  R.list = null; R.error = ''; render();
  try { const r = await api('/prs?project=' + encodeURIComponent(R.project)); R.list = r.list; R.repo = r.repo; } catch (e) { R.list = []; R.error = e.message; }
  render();
}
function render() {
  if (!R.el) return;
  const groups = [...new Set(R.models.map(m => m.group))];
  R.el.innerHTML = `<div class="pg pr-page">
    <header class="pg-head"><div><h1>${ic('git-pull-request')}بررسی Pull Request<span class="hud-tag" aria-hidden="true">REVIEW</span></h1>
      <p class="help">PRهای باز مخزن‌های GitHub پروژه‌هایتان را با هر مدلی بررسی کنید. نتیجه فقط وقتی در GitHub ثبت می‌شود که خودتان «ارسال» را بزنید و تأیید کنید. از ورود «gh» روی همین کامپیوتر استفاده می‌شود.</p></div>
      <div class="sms-actions">${R.projects && R.projects.length ? `<select id="prProj" aria-label="پروژه">${R.projects.map(p => `<option value="${esc(p.id)}" ${p.id === R.project ? 'selected' : ''}>${esc(p.name)} — ${esc(p.repo)}</option>`).join('')}</select>
        <button type="button" class="btn" id="prRefresh">${ic('refresh-cw', 'sm')}به‌روزرسانی</button>` : ''}</div></header>
    ${R.error ? `<p class="sk-warn" role="alert">${ic('triangle-alert', 'sm')}${esc(R.error)}</p>` : ''}
    ${R.projects == null ? '<p class="help">در حال خواندن…</p>' : !R.projects.length ? `<div class="tk-empty">${ic('git-pull-request')}<h3>پروژه‌ای با مخزن GitHub نیست</h3><p class="help">پروژه‌ای اضافه کنید که remote به نام origin روی github.com دارد.</p></div>` : `
    <div class="pr-grid">
      <section class="sms-list" aria-label="PRهای باز">${R.list == null ? '<div class="sms-empty"><div class="sms-skel"></div><div class="sms-skel"></div></div>' : R.list.length ? `<ul class="mail-ul" role="list">${R.list.map(p => `<li><button type="button" class="sms-th ${R.sel === p.number ? 'on' : ''}" data-pr="${p.number}">
        <span class="sms-av" aria-hidden="true">#${p.number}</span><span class="sms-th-b"><b dir="auto">${esc(p.title)}</b><span class="help" dir="ltr">${esc(p.author || '')} · ${esc(p.headRefName)} → ${esc(p.baseRefName)}${p.isDraft ? ' · draft' : ''}</span></span>
        <span class="sms-th-t" dir="ltr"><span class="ok">+${p.additions}</span><span class="bad">−${p.deletions}</span></span></button></li>`).join('')}</ul>` : '<p class="help sms-empty">PR بازی نیست.</p>'}</section>
      <section class="sms-conv pr-detail" aria-label="بررسی">${detailHtml(groups)}</section>
    </div>`}
  </div>`;
  bind();
}
function detailHtml(groups) {
  if (!R.sel) return `<div class="sms-none">${ic('git-pull-request')}<p class="help">یک PR را انتخاب کنید.</p></div>`;
  const p = (R.list || []).find(x => x.number === R.sel) || {};
  const r = R.res;
  return `<div class="sms-conv-h mail-h"><div class="mail-hb"><h2 dir="auto">#${R.sel} ${esc(p.title || '')}</h2>${p.url ? `<a class="help" href="${esc(p.url)}" target="_blank" rel="noopener" dir="ltr">${ic('external-link', 'sm')} ${esc(p.url.replace('https://', ''))}</a>` : ''}</div>
    <div class="row-gap"><select id="prModel" aria-label="مدل بررسی‌کننده"><option value="">مدل تستر تیم</option>${groups.map(g => `<optgroup label="${esc(g)}">${R.models.filter(m => m.group === g).map(m => `<option value="${esc(m.spec)}" ${m.spec === R.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('')}</select>
      <button type="button" class="btn btn-primary" id="prGo" ${R.busy ? 'disabled' : ''}>${ic('scan-search', 'sm')}${R.busy ? 'در حال بررسی… (ممکن است چند دقیقه طول بکشد)' : 'بررسی کن'}</button></div></div>
    <div class="mail-body pr-body">${!r ? '<p class="help">«بررسی کن» را بزنید.</p>' : `
      <div class="pr-verdict">${ic(VERD[r.review.verdict][0])} <b>${VERD[r.review.verdict][1]}</b> <small class="help">· ${esc(r.model)} · ${faN(r.pr.files.length)} فایل · +${faN(r.pr.additions)} −${faN(r.pr.deletions)}${r.pr.diffChars > 140000 ? ' · diff طولانی بود و بخشی خوانده شد' : ''}</small></div>
      <div class="md" dir="auto">${md(r.review.summary)}</div>
      ${r.review.issues.length ? `<h3 class="pg-sub">مشکلات (${faN(r.review.issues.length)})</h3><ul class="pr-issues" role="list">${r.review.issues.map(i => `<li class="${SEV[i.severity][0]}"><span class="role on">${SEV[i.severity][1]}</span> <b dir="auto">${esc(i.title)}</b> ${i.file ? `<code dir="ltr">${esc(i.file)}${i.line ? ':' + i.line : ''}</code>` : ''}<div dir="auto">${esc(i.detail)}</div>${i.suggestion ? `<div class="help" dir="auto">پیشنهاد: ${esc(i.suggestion)}</div>` : ''}</li>`).join('')}</ul>` : '<p class="help">مشکلی پیدا نشد.</p>'}
      ${r.review.good.length ? `<h3 class="pg-sub">خوب‌ها</h3><ul>${r.review.good.map(g => `<li dir="auto">${esc(g)}</li>`).join('')}</ul>` : ''}
      <h3 class="pg-sub">متنی که در GitHub ثبت می‌شود (قابل ویرایش)</h3>
      <textarea id="prText" rows="10" dir="auto">${esc(r.markdown)}</textarea>
      <div class="row-gap"><select id="prEvent" aria-label="نوع بررسی"><option value="comment" ${r.review.verdict === 'comment' ? 'selected' : ''}>فقط نظر (Comment)</option><option value="approve" ${r.review.verdict === 'approve' ? 'selected' : ''}>تأیید (Approve)</option><option value="request_changes" ${r.review.verdict === 'request_changes' ? 'selected' : ''}>درخواست اصلاح (Request changes)</option></select>
        <button type="button" class="btn btn-primary" id="prPost">${ic('send', 'sm')}ارسال به GitHub…</button>
        ${r.review.issues.length ? `<button type="button" class="btn" id="prFix">${ic('wrench', 'sm')}اصلاح با تیم ایجنت‌ها…</button>` : ''}</div>`}</div>`;
}
function bind() {
  const el = R.el, on = (id, f) => { const x = $('#' + id, el); if (x) x.onclick = f; };
  const pj = $('#prProj', el); if (pj) pj.onchange = () => { R.project = pj.value; R.sel = null; R.res = null; loadList(); };
  on('prRefresh', loadList);
  el.querySelectorAll('[data-pr]').forEach(b => b.onclick = () => { R.sel = +b.dataset.pr; R.res = null; render(); });
  const mo = $('#prModel', el); if (mo) mo.onchange = () => { R.model = mo.value; };
  on('prGo', async () => {
    R.busy = true; R.res = null; render();
    try { R.res = await api('/prs/review', { body: { project: R.project, number: R.sel, model: R.model }, timeout: 420000 }); } catch (e) { window.toast(e.message, true); }
    R.busy = false; render();
  });
  on('prPost', async () => {
    const text = $('#prText', el).value, ev = $('#prEvent', el).value;
    if (!confirm(`این بررسی با حساب GitHub شما روی PR #${R.sel} در ${R.repo} ثبت شود؟\nنوع: ${$('#prEvent', el).selectedOptions[0].text}\n\nهمه‌ی کسانی که به مخزن دسترسی دارند آن را می‌بینند.`)) return;
    try { await api('/prs/post', { body: { project: R.project, number: R.sel, event: ev, body: text, confirmed: true } }); window.toast('در GitHub ثبت شد'); } catch (e) { window.toast(e.message, true); }
  });
  on('prFix', async () => {
    const r = R.res, issues = r.review.issues.map((i, n) => `${n + 1}. [${i.severity}] ${i.file}${i.line ? ':' + i.line : ''} — ${i.title}: ${i.detail}${i.suggestion ? ' Fix: ' + i.suggestion : ''}`).join('\n');
    if (!confirm(`پروژه روی شاخه‌ی این PR (${r.pr.head}) می‌رود و تیم ایجنت‌ها ${faN(r.review.issues.length)} مشکل را اصلاح می‌کند. چیزی push نمی‌شود.\nاگر در پوشه‌ی پروژه تغییرات ذخیره‌نشده دارید، اول آن‌ها را commit کنید. ادامه؟`)) return;
    try { await api('/prs/fix', { body: { project: R.project, number: R.sel, issues, confirmed: true }, timeout: 180000 }); window.toast('تیم شروع کرد؛ در «تیم کدنویسی» ببینید'); } catch (e) { window.toast(e.message, true); }
  });
}

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('prs', { icon: 'git-pull-request', label: 'بررسی PR', enter, leave });
