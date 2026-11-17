// Settings as a graphical page (replaces the old long form dialog). Same schema (SETTINGS_SCHEMA in
// app.js): category cards, quick switches, toggles, steppers, segmented choices, search, and
// automatic saving (no "save" button). Global or per-project scope.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const st = () => window.JARVIS_STATE || {};
const schema = () => window.SETTINGS_SCHEMA || []; // admin-only groups are already left out

// the switches people change most, as big tiles on the overview
const QUICK = [
  ['leanMode', 'zap', 'حالت سبک', 'ارزان‌تر و سریع‌تر'],
  ['notify', 'bell', 'اعلان پایان کار', 'اعلان دسکتاپ'],
  ['speak', 'mic', 'اعلام صوتی', 'پایان کار را بگوید'],
  ['projectLock', 'shield', 'قفل پروژه', 'یک اجرا در هر زمان'],
  ['autoCommit', 'git-branch', 'commit خودکار', 'بعد از تأیید تستر'],
  ['desktopTray', 'panel-right', 'ماندن در پس‌زمینه', 'با بستن پنجره'],
  ['desktopStartup', 'play', 'شروع با ویندوز', 'پنهان کنار ساعت'],
  ['desktopAutoUpdate', 'download', 'آپدیت خودکار', 'از GitHub'],
];
// other places where things are set up
const LINKS = [
  ['plug', 'حساب‌ها و اتصال‌ها', 'Claude، Codex، کلیدها', () => window.setupDialog && window.setupDialog()],
  ['brain', 'هسته‌ی هوش مصنوعی', 'همه‌ی مدل‌ها و آفلاین', () => window.showSection && window.showSection('ai')],
  ['mic', 'دستیار صوتی', '«هی جارویس»، صدا', () => window.voiceDialog && window.voiceDialog()],
  ['send', 'تلگرام / بله', 'دستیار روی گوشی', () => window.notifyDialog && window.notifyDialog()],
  ['palette', 'ظاهر', '۱۳ ظاهر، روشن/تیره', () => { const b = $('#btnSkin'); if (b) b.click(); }],
  ['puzzle', 'اتصال‌دهنده‌ها و پلاگین‌ها', 'MCP و مارکت‌پلیس', () => window.extDialog && window.extDialog()],
];

const P = { el: null, scope: 'global', values: {}, override: false, cat: -1, q: '', pending: {}, timer: null, focusKey: null };

function enter(host) { P.el = host; load(); }
async function load() {
  const S = st();
  const proj = (S.projects || []).find(p => p.id === S.projectId);
  if (P.scope === 'project' && !proj) P.scope = 'global';
  if (P.scope === 'project') { const r = await api(`/projects/${proj.id}/settings`); P.values = r.settings; P.override = r.override; }
  else { P.values = { ...(S.settings || {}) }; P.override = false; }
  render(proj);
}

function control(f) {
  const v = P.values[f.k];
  const isProject = P.scope === 'project';
  const off = (isProject && f.global) || (!isProject && f.projectOnly);
  const dis = off ? 'disabled' : '';
  if (f.t === 'bool') return `<label class="switch big"><input type="checkbox" data-k="${f.k}" ${v ? 'checked' : ''} ${dis} aria-label="${esc(f.l)}"><span></span></label>`;
  if (f.t === 'number') return `<div class="stepper"><button type="button" data-step="-1" data-for="${f.k}" aria-label="کمتر" ${dis}>${ic('minus', 'sm')}</button><input type="number" min="0" step="${f.step || 1}" data-k="${f.k}" value="${esc(v ?? 0)}" dir="ltr" ${dis}><button type="button" data-step="1" data-for="${f.k}" aria-label="بیشتر" ${dis}>${ic('plus', 'sm')}</button></div>`;
  if (f.t === 'select' && f.o.length <= 3 && f.o.every(([, l]) => l.length < 34)) return `<div class="segm" role="radiogroup" aria-label="${esc(f.l)}">${f.o.map(([val, lab]) => `<button type="button" role="radio" aria-checked="${String(v ?? '') === val}" data-seg="${f.k}" data-val="${esc(val)}" ${dis}>${esc(lab)}</button>`).join('')}</div>`;
  if (f.t === 'select') return `<select data-k="${f.k}" ${dis}>${f.o.map(([val, lab]) => `<option value="${esc(val)}" ${String(v ?? '') === val ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  if (f.t === 'model') { const opts = (window.modelOptions ? window.modelOptions(f.m, v) : [[v, v]]).filter(([x]) => x !== '__custom').map(([val, lab]) => [val, !val && /Fallback$/.test(f.k) ? 'بدون جایگزین' : lab]);
    return `<select data-k="${f.k}" dir="ltr" ${dis}>${opts.map(([val, lab]) => `<option value="${esc(val)}" ${String(v ?? '') === val ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`; }
  if (f.t === 'long') return `<textarea data-k="${f.k}" rows="4" ${f.ltr ? 'dir="ltr"' : 'dir="auto"'} placeholder="${esc(f.ph || '')}" ${dis}>${esc(v || '')}</textarea>`;
  if (f.t === 'lines') return `<textarea data-k="${f.k}" rows="4" dir="auto" ${dis}>${esc((v || []).join('\n'))}</textarea>`;
  return `<input data-k="${f.k}" value="${esc(v ?? '')}" ${f.ltr ? 'dir="ltr"' : 'dir="auto"'} placeholder="${esc(f.ph || '')}" ${dis}>`;
}
const wide = f => ['long', 'lines', 'text'].includes(f.t) || f.t === 'model' || (f.t === 'select' && !(f.o.length <= 3 && f.o.every(([, l]) => l.length < 34)));
function row(f) {
  const isProject = P.scope === 'project';
  const note = isProject && f.global ? 'فقط سراسری' : !isProject && f.projectOnly ? 'فقط در تنظیمات پروژه' : '';
  return `<div class="set-row ${wide(f) ? 'wide' : ''} ${note ? 'off' : ''}" data-key="${f.k}">
    <div class="set-txt"><b>${esc(f.l)}</b>${f.h ? `<span class="help">${esc(f.h)}</span>` : ''}${note ? `<span class="set-note">${note}</span>` : ''}</div>
    <div class="set-ctl">${control(f)}</div></div>`;
}

function render(proj) {
  const S = st(), sc = schema();
  const isProject = P.scope === 'project';
  const q = P.q.trim().toLowerCase();
  const matches = f => !q || (f.l + ' ' + (f.h || '') + ' ' + f.k).toLowerCase().includes(q);
  let body;
  if (q) {
    const hits = sc.flatMap((s, i) => s.fields.filter(f => matches(f) || s.title.toLowerCase().includes(q)).map(f => ({ f, i })));
    body = hits.length ? `<h2 class="pg-sub">${faN(hits.length)} نتیجه</h2><div class="set-list">${hits.map(({ f, i }) => row(f).replace('<div class="set-txt">', `<div class="set-txt"><span class="set-crumb">${ic(sc[i].icon, 'sm')}${esc(sc[i].title)}</span>`)).join('')}</div>`
      : `<div class="tk-empty">${ic('search')}<h3>چیزی پیدا نشد</h3></div>`;
  } else if (P.cat < 0) {
    body = `<h2 class="pg-sub">کلیدهای سریع</h2>
      <div class="set-quick">${QUICK.filter(([k]) => sc.some(s => s.fields.some(f => f.k === k))).map(([k, icon, title, sub]) => {
        const f = sc.flatMap(s => s.fields).find(x => x.k === k); const off = (isProject && f.global);
        return `<label class="set-tile ${P.values[k] ? 'on' : ''} ${off ? 'off' : ''}"><span class="set-tile-ic">${ic(icon)}</span><b>${esc(title)}</b><span class="help">${esc(sub)}</span>
          <span class="switch big"><input type="checkbox" data-k="${k}" ${P.values[k] ? 'checked' : ''} ${off ? 'disabled' : ''} aria-label="${esc(title)}"><span></span></span></label>`; }).join('')}</div>
      <h2 class="pg-sub">سقف هزینه‌ی هر اجرا</h2>
      <div class="set-budget"><input type="range" min="0" max="30" step="0.5" data-k="maxRunCostUsd" value="${esc(P.values.maxRunCostUsd ?? 5)}" aria-label="سقف هزینه"><output id="setBudget">${budgetText(P.values.maxRunCostUsd)}</output></div>
      <h2 class="pg-sub">بخش‌های دیگر</h2>
      <div class="set-links">${LINKS.map(([icon, t, sub], i) => `<button type="button" class="set-link" data-link="${i}"><span class="set-tile-ic">${ic(icon)}</span><b>${esc(t)}</b><span class="help">${esc(sub)}</span>${ic('chevron-left', 'sm')}</button>`).join('')}</div>`;
  } else {
    const s = sc[P.cat];
    body = `<h2 class="set-h">${ic(s.icon)}${esc(s.title)}</h2><div class="set-list">${s.fields.map(row).join('')}</div>`;
  }
  P.el.innerHTML = `<div class="pg set-page">
    <header class="pg-head"><div><h1>${ic('settings')}تنظیمات<span class="hud-tag" aria-hidden="true">SYSTEM CONFIG</span></h1>
      <p class="help">هر تغییر خودکار ذخیره می‌شود. ${isProject ? `این تنظیمات فقط برای پروژه‌ی «${esc(proj.name)}» است${P.override ? '' : ' (الان از سراسری پیروی می‌کند؛ اولین تغییر، تنظیمات اختصاصی می‌سازد)'}.` : 'این تنظیمات برای همه‌ی پروژه‌هاست.'}</p></div>
      <div class="set-save" id="setSave" aria-live="polite">${ic('circle-check', 'sm')}ذخیره شده</div></header>
    <div class="set-top">
      <div class="segm scope" role="radiogroup" aria-label="دامنه"><button type="button" role="radio" aria-checked="${!isProject}" data-scope="global">${ic('globe', 'sm')}سراسری</button>${proj ? `<button type="button" role="radio" aria-checked="${isProject}" data-scope="project">${ic('folder', 'sm')}پروژه‌ی «${esc(proj.name)}»</button>` : ''}</div>
      <div class="chat-search">${ic('search', 'sm')}<input id="setSearch" type="search" dir="auto" placeholder="جستجو در تنظیمات… (مثلاً هزینه، گیت، تستر)" value="${esc(P.q)}" autocomplete="off"></div>
    </div>
    <div class="set-body">
      <nav class="set-nav" aria-label="بخش‌های تنظیمات">
        <button type="button" class="set-cat ${P.cat < 0 && !q ? 'on' : ''}" data-cat="-1"><span class="set-tile-ic">${ic('layout-dashboard')}</span><b>نمای کلی</b><span class="help">کلیدهای سریع</span></button>
        ${sc.map((s, i) => `<button type="button" class="set-cat ${P.cat === i && !q ? 'on' : ''}" data-cat="${i}"><span class="set-tile-ic">${ic(s.icon)}</span><b>${esc(s.title)}</b><span class="help">${faN(s.fields.length)} تنظیم</span></button>`).join('')}
      </nav>
      <section class="set-main">${body}
        <div class="set-foot">${isProject && P.override ? `<button type="button" class="btn btn-sm ghost danger" id="setReset">${ic('rotate-ccw', 'sm')}حذف تنظیمات اختصاصی این پروژه</button>` : ''}${!isProject ? `<button type="button" class="btn btn-sm ghost" id="setDefaults">${ic('rotate-ccw', 'sm')}بازگشت همه به پیش‌فرض</button>` : ''}
          ${!isProject && S.settings && S.settings.requireToken && localStorage.getItem('jarvis.token') ? `<span class="help">${ic('key-round', 'sm')} لینک ورود: <code dir="ltr">${esc(location.origin)}/?token=…</code></span>` : ''}</div>
      </section></div></div>`;
  wire();
  if (P.focusKey) { const el = P.el.querySelector(`[data-k="${P.focusKey}"]`); P.focusKey = null; if (el) { el.closest('.set-row, .set-tile')?.classList.add('flash'); el.scrollIntoView({ block: 'center' }); el.focus(); } }
}
const budgetText = v => (+v ? '$' + (+v).toFixed(1) + ' در هر اجرا' : 'بدون سقف');

function readValue(el, f) {
  if (f.t === 'bool') return el.checked;
  if (f.t === 'number') return Number(el.value) || 0;
  if (f.t === 'lines') return el.value.split('\n').map(x => x.trim()).filter(Boolean);
  if (f.k === 'scheduleAuditAt') { const m = el.value.trim().replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).match(/^(\d{1,2}):(\d{2})$/); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; }
  return el.value.trim();
}
const fieldOf = k => schema().flatMap(s => s.fields).find(f => f.k === k);
function queue(k, v, delay = 600) {
  P.values[k] = v; P.pending[k] = v;
  const s = $('#setSave'); if (s) { s.className = 'set-save busy'; s.innerHTML = `${ic('refresh-cw', 'sm')}در حال ذخیره…`; }
  clearTimeout(P.timer); P.timer = setTimeout(flush, delay);
}
async function flush() {
  const vals = P.pending; P.pending = {};
  if (!Object.keys(vals).length) return;
  const S = st(), proj = (S.projects || []).find(p => p.id === S.projectId);
  const s = $('#setSave');
  try {
    if (P.scope === 'project' && proj) { await api(`/projects/${proj.id}/settings`, { body: { settings: { ...P.values } } }); P.override = true; }
    else {
      const r = await api('/settings', { body: vals });
      if (r.token) { localStorage.setItem('jarvis.token', r.token); delete r.token; window.toast('توکن دسترسی فعال شد و در این مرورگر ذخیره شد'); window.connectEvents && window.connectEvents(); }
      S.settings = r;
      if (window.jarvisDesktop && window.jarvisDesktop.applySettings && Object.keys(vals).some(k => /^desktop/.test(k))) window.jarvisDesktop.applySettings();
      if ('sellerMode' in vals && window.rebuildRail) window.rebuildRail();
    }
    if (vals.notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    try { window.renderQuick && window.renderQuick(); window.renderAgents && window.renderAgents(); window.renderModelBar && window.renderModelBar(); } catch {}
    if (s) { s.className = 'set-save ok'; s.innerHTML = `${ic('circle-check', 'sm')}ذخیره شد`; }
  } catch (e) { if (s) { s.className = 'set-save bad'; s.innerHTML = `${ic('circle-x', 'sm')}${esc(e.message)}`; } }
}

function wire() {
  const root = P.el;
  root.querySelector('.set-nav').onclick = e => { const b = e.target.closest('[data-cat]'); if (!b) return; P.cat = +b.dataset.cat; P.q = ''; render(currentProj()); root.querySelector('.set-main').scrollTop = 0; };
  root.querySelector('.scope').onclick = e => { const b = e.target.closest('[data-scope]'); if (b && b.dataset.scope !== P.scope) { flush(); P.scope = b.dataset.scope; load(); } };
  const search = root.querySelector('#setSearch');
  search.oninput = () => { P.q = search.value; clearTimeout(P._s); P._s = setTimeout(() => { render(currentProj()); const s2 = root.querySelector('#setSearch'); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }, 180); };
  root.oninput = root.onchange = e => {
    const el = e.target.closest('[data-k]'); if (!el || el.id === 'setSearch') return;
    const k = el.dataset.k, f = fieldOf(k); if (!f) return;
    if (k === 'maxRunCostUsd' && el.type === 'range') { const o = root.querySelector('#setBudget'); if (o) o.textContent = budgetText(el.value); }
    if (e.type === 'input' && ['long', 'lines', 'text'].includes(f.t)) { queue(k, readValue(el, f), 1200); return; }
    if (e.type === 'change' || f.t === 'bool') { queue(k, readValue(el, f), f.t === 'bool' || f.t === 'select' || f.t === 'model' ? 150 : 600); const t = el.closest('.set-tile'); if (t) t.classList.toggle('on', el.checked); }
  };
  root.onclick = async e => {
    const step = e.target.closest('[data-step]');
    if (step) { const inp = root.querySelector(`input[data-k="${step.dataset.for}"]`); const f = fieldOf(step.dataset.for); const n = Math.max(0, +(+inp.value + (+step.dataset.step) * (f.step || 1)).toFixed(3)); inp.value = n; queue(f.k, n); return; }
    const seg = e.target.closest('[data-seg]');
    if (seg) { seg.parentElement.querySelectorAll('[data-seg]').forEach(b => b.setAttribute('aria-checked', String(b === seg))); queue(seg.dataset.seg, seg.dataset.val, 150); return; }
    const link = e.target.closest('[data-link]'); if (link) { LINKS[+link.dataset.link][3](); return; }
    if (e.target.closest('#setDefaults')) {
      if (!confirm('همه‌ی تنظیمات سراسری به پیش‌فرض برگردند؟ (توکن دسترسی تغییر نمی‌کند)')) return;
      const d = { ...(st().defaults || {}) }; delete d.requireToken;
      st().settings = await api('/settings', { body: d }); window.toast('به پیش‌فرض برگشت'); load(); return;
    }
    if (e.target.closest('#setReset')) { const proj = currentProj(); await api(`/projects/${proj.id}/settings`, { body: { reset: true } }); window.toast('این پروژه دوباره از تنظیمات سراسری پیروی می‌کند'); load(); }
  };
}
const currentProj = () => { const S = st(); return (S.projects || []).find(p => p.id === S.projectId); };

// every old entry point (top-bar button, palette, project menu) opens this page
window.settingsDialog = async (scope, focusKey) => {
  P.scope = scope === 'project' ? 'project' : 'global';
  if (focusKey) { P.focusKey = focusKey; P.q = ''; P.cat = schema().findIndex(s => s.fields.some(f => f.k === focusKey)); }
  if (window.showSection) window.showSection('settings'); else enter(document.getElementById('view-settings'));
};
window.addEventListener('beforeunload', () => { if (Object.keys(P.pending).length) flush(); });

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('settings', { icon: 'settings', label: 'تنظیمات', end: true, enter, leave() { if (Object.keys(P.pending).length) { clearTimeout(P.timer); flush(); } } });
