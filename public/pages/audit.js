// Permissions & audit log: what JARVIS may do on its own, and a record of everything it did
// (who asked, what, when, did it work) — searchable and exportable.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const api = (p, o) => window.api(p, o);

const WHO = { voice: ['mic', 'صدا'], telegram: ['send', 'تلگرام / بله'], chat: ['messages-square', 'چت'], phone: ['smartphone', 'گوشی'], agent: ['monitor', 'ایجنت کامپیوتر'], panel: ['layout-dashboard', 'پنل'], system: ['info', 'سیستم'] };
const ACT = { run_team: 'شروع کار تیم', stop: 'توقف', add_task: 'افزودن تسک', complete_task: 'انجام تسک', open: 'باز کردن بخش', open_app: 'باز کردن برنامه', open_url: 'باز کردن سایت', web_search: 'جستجوی وب', open_folder: 'باز کردن پوشه',
  volume: 'صدا', media: 'پخش', screenshot: 'اسکرین‌شات', close_app: 'بستن برنامه', power: 'خاموش/ری‌استارت', pc_do: 'کار با ایجنت کامپیوتر', pc_continue: 'جواب به ایجنت کامپیوتر', send_email: 'ارسال ایمیل',
  remember: 'به خاطر سپردن', forget: 'فراموش کردن', teach_skill: 'یاد دادن روال', approve_purchase: 'تأیید خرید', reject_purchase: 'رد خرید', find_extension: 'جستجوی افزونه', settings: 'تغییر تنظیمات',
  connector_save: 'ذخیره‌ی اتصال‌دهنده', connector_on: 'روشن کردن اتصال‌دهنده', connector_off: 'خاموش کردن اتصال‌دهنده', connector_delete: 'حذف اتصال‌دهنده', plugin_install: 'نصب پلاگین', skill_install: 'نصب اسکیل' };
const actName = a => ACT[a] || (/^pc_/.test(a) ? 'ایجنت کامپیوتر: ' + a.slice(3) : /^phone_/.test(a) ? 'گوشی: ' + a.slice(6) : a);
const PERMS = [
  ['pcControl', 'monitor', 'کنترل برنامه‌ها با موس و کیبورد', 'ایجنت کامپیوتر داخل هر برنامه کار کند (قبل از ارسال، خرید و حذف همیشه می‌پرسد).'],
  ['permApps', 'external-link', 'باز کردن برنامه، سایت و پوشه؛ صدا و پخش؛ اسکرین‌شات', 'کارهای ساده و بی‌خطر روی کامپیوتر.'],
  ['permPower', 'triangle-alert', 'بستن برنامه‌ها، خاموش و ری‌استارت کامپیوتر', 'همیشه قبلش «بله» می‌خواهد.'],
  ['permMail', 'mail', 'ارسال ایمیل با صدا، تلگرام یا چت', 'با «بله» شما. ارسال از صفحه‌ی ایمیل همیشه مجاز است.'],
  ['permPhone', 'smartphone', 'کار روی گوشی (پیامک، تماس، اپ‌ها)', 'خود گوشی هم قبل از ارسال و تماس می‌پرسد.'],
  ['permTeam', 'code', 'شروع و توقف کار تیم کدنویسی', 'با صدا، تلگرام یا از تسک‌ها.'],
  ['permMemory', 'brain', 'حافظه و یاد گرفتن روال‌ها', 'به خاطر سپردن، فراموش کردن و ذخیره‌ی روال‌های تازه.'],
  ['permSales', 'wallet', 'تأیید یا رد درخواست‌های خرید', 'فقط برای فروشنده (حالت فروش).'],
];

const U = { el: null, tab: 'log', items: [], months: [], f: { who: '', q: '', failed: false, month: '' } };
async function enter(host) { U.el = host; await load(); }
function leave() { U.el = null; }
async function load() {
  const p = new URLSearchParams({ who: U.f.who, q: U.f.q, month: U.f.month, ...(U.f.failed ? { failed: '1' } : {}) });
  try { const r = await api('/audit?' + p); U.items = r.items; U.months = r.months; } catch (e) { window.toast(e.message, true); }
  render();
}
function render() {
  if (!U.el) return;
  const s = (window.JARVIS_STATE || {}).settings || {};
  U.el.innerHTML = `<div class="pg au-page">
    <header class="pg-head"><div><h1>${ic('shield')}مجوزها و گزارش<span class="hud-tag" aria-hidden="true">AUDIT</span></h1>
      <p class="help">ببینید جارویس چه کارهایی کرده (چه کسی خواست، چه شد) و تعیین کنید چه کارهایی اجازه دارد. همه‌چیز فقط روی همین کامپیوتر ذخیره می‌شود و رمزها هیچ‌وقت نوشته نمی‌شوند.</p></div></header>
    <nav class="bell-tabs" role="tablist"><button type="button" role="tab" aria-selected="${U.tab === 'log'}" data-utab="log">${ic('history', 'sm')} گزارش کارها</button><button type="button" role="tab" aria-selected="${U.tab === 'perms'}" data-utab="perms">${ic('lock', 'sm')} مجوزها</button><button type="button" role="tab" aria-selected="${U.tab === 'budget'}" data-utab="budget">${ic('wallet', 'sm')} بودجه‌ها</button></nav>
    ${U.tab === 'budget' ? budgetHtml() : U.tab === 'perms' ? `<section class="sl-card au-perms">${PERMS.map(([k, i, t, h]) => `<label class="au-perm"><span class="ext-ic">${ic(i)}</span><span class="au-pt"><b>${t}</b><small class="help">${h}</small></span><span class="switch"><input type="checkbox" data-perm="${k}" ${s[k] !== false ? 'checked' : ''}><span></span></span></label>`).join('')}
      <p class="help">${ic('info', 'sm')} وقتی یک مورد خاموش باشد، جارویس آن کار را با صدا، تلگرام، چت یا ایجنت انجام نمی‌دهد و در گزارش با «رد شد» ثبت می‌شود.</p></section>` : `
    <div class="au-filters">
      <div class="sms-search">${ic('search', 'sm')}<input id="auQ" type="search" value="${esc(U.f.q)}" placeholder="جستجو در کارها" aria-label="جستجو"></div>
      <select id="auWho" aria-label="چه کسی">${[['', 'همه'], ...Object.entries(WHO).map(([k, v]) => [k, v[1]])].map(([k, l]) => `<option value="${k}" ${U.f.who === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="auMonth" aria-label="ماه"><option value="">۳ ماه اخیر</option>${U.months.map(m => `<option value="${m}" ${U.f.month === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="auFailed" ${U.f.failed ? 'checked' : ''}> فقط ناموفق‌ها</label>
      <a class="btn btn-sm" id="auCsv" href="#">${ic('download', 'sm')}خروجی CSV</a></div>
    ${U.items.length ? `<table class="ar-board au-table"><thead><tr><th>زمان</th><th>از طرف</th><th>کار</th><th>جزئیات</th><th>نتیجه</th></tr></thead><tbody>${U.items.map(e => { const w = WHO[e.who] || WHO.system; return `<tr class="${e.ok ? '' : 'bad-row'}"><td class="au-t">${new Date(e.at).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'medium' })}</td><td>${ic(w[0], 'sm')} ${w[1]}</td><td>${esc(actName(e.action))}</td><td class="au-d" dir="auto">${esc(e.detail)}</td><td>${e.ok ? `<span class="ok">${ic('check', 'sm')}</span>` : `<span class="bad" title="${esc(e.error || '')}">${ic('x', 'sm')} ${esc(e.error === 'blocked by permissions' ? 'رد شد (مجوز)' : (e.error || 'ناموفق').slice(0, 60))}</span>`}</td></tr>`; }).join('')}</tbody></table>`
      : `<div class="tk-empty">${ic('history')}<h3>چیزی ثبت نشده</h3><p class="help">هر کاری که جارویس انجام بدهد این‌جا می‌آید.</p></div>`}`}
  </div>`;
  bind();
}
const usd = n => '$' + (+n || 0).toFixed(2);
function bar(spent, budget) { if (!budget) return '<span class="help">بدون سقف</span>'; const p = Math.min(100, Math.round(100 * spent / budget)); return `<div class="au-bar ${p >= 100 ? 'full' : p >= 80 ? 'warn' : ''}" role="img" aria-label="${p}٪ مصرف شده"><i style="width:${p}%"></i></div><small class="help">${Number(p).toLocaleString('fa-IR')}٪</small>`; }
function budgetHtml() {
  const b = U.budgets; if (!b) return '<p class="help">در حال خواندن…</p>';
  const row = (kind, x) => `<tr><td dir="auto">${esc(x.name)}</td><td dir="ltr">${usd(x.spent)}</td><td class="au-bw">${bar(x.spent, x.budget)}</td><td><span class="au-in" dir="ltr">$ <input type="number" min="0" step="1" value="${x.budget || ''}" placeholder="0" data-bkind="${kind}" data-bid="${esc(x.id)}" aria-label="بودجه‌ی ماهانه‌ی ${esc(x.name)}"></span></td></tr>`;
  return `<p class="help">${ic('info', 'sm')} سقف خرج هر ماه (دلار). وقتی یک پروژه به سقفش برسد کار تازه‌ای برایش شروع نمی‌شود و کار در حال اجرا هم سر سقف می‌ایستد؛ ایجنتی که به سقفش برسد آن ماه بررسی نمی‌کند. با ۸۰٪ یک اعلان می‌آید. ۰ یعنی بدون سقف. با اشتراک Pro/Max هزینه‌ی Claude تخمینی است.</p>
    <div class="au-total">خرج این ماه روی همه‌ی پروژه‌ها: <b dir="ltr">${usd(b.total)}</b>${b.runCap ? ` · سقف هر اجرا: <b dir="ltr">${usd(b.runCap)}</b>` : ''}</div>
    <h2 class="pg-sub">${ic('folder', 'sm')} پروژه‌ها</h2>
    ${b.projects.length ? `<table class="ar-board au-btable"><thead><tr><th>پروژه</th><th>این ماه</th><th>مصرف</th><th>سقف ماهانه</th></tr></thead><tbody>${b.projects.map(x => row('project', x)).join('')}</tbody></table>` : '<p class="help">پروژه‌ای نیست.</p>'}
    <h2 class="pg-sub">${ic('bot', 'sm')} ایجنت‌ها</h2>
    ${b.agents.length ? `<table class="ar-board au-btable"><thead><tr><th>ایجنت</th><th>این ماه</th><th>مصرف</th><th>سقف ماهانه</th></tr></thead><tbody>${b.agents.map(x => row('agent', x)).join('')}</tbody></table>` : '<p class="help">ایجنتی نیست.</p>'}`;
}
async function loadBudgets() { try { U.budgets = await api('/budgets'); } catch (e) { window.toast(e.message, true); } render(); }
function bind() {
  const el = U.el;
  el.querySelectorAll('[data-bkind]').forEach(i => i.onchange = async () => {
    const v = Math.max(0, +i.value || 0);
    try {
      if (i.dataset.bkind === 'project') { const p = U.budgets.projects.find(x => x.id === i.dataset.bid); await api(`/projects/${p.id}/settings`, { body: { settings: { ...(p.override || {}), projectBudgetUsd: v } } }); }
      else { const list = await api('/subagents'); const a = list.find(x => x.id === i.dataset.bid); if (!a) throw new Error('ایجنت پیدا نشد'); await api('/subagents', { body: { ...a, budgetMonthUsd: v } }); }
      window.toast(v ? 'سقف ماهانه ذخیره شد' : 'سقف برداشته شد'); loadBudgets();
    } catch (e) { window.toast(e.message, true); }
  });
  el.querySelectorAll('[data-utab]').forEach(b => b.onclick = () => { U.tab = b.dataset.utab; render(); if (U.tab === 'budget') loadBudgets(); });
  el.querySelectorAll('[data-perm]').forEach(c => c.onchange = async () => {
    try { const out = await api('/settings', { body: { [c.dataset.perm]: c.checked } }); if (window.JARVIS_STATE) window.JARVIS_STATE.settings = out; window.toast(c.checked ? 'اجازه داده شد' : 'خاموش شد'); } catch (e) { window.toast(e.message, true); c.checked = !c.checked; }
  });
  let t; const q = $('#auQ', el); if (q) q.oninput = () => { clearTimeout(t); t = setTimeout(() => { U.f.q = q.value; load().then(() => { const n = $('#auQ', U.el); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }, 300); };
  const w = $('#auWho', el); if (w) w.onchange = () => { U.f.who = w.value; load(); };
  const mo = $('#auMonth', el); if (mo) mo.onchange = () => { U.f.month = mo.value; load(); };
  const fl = $('#auFailed', el); if (fl) fl.onchange = () => { U.f.failed = fl.checked; load(); };
  const csv = $('#auCsv', el); if (csv) csv.onclick = async e => {
    e.preventDefault();
    try {
      const p = new URLSearchParams({ who: U.f.who, q: U.f.q, month: U.f.month, ...(U.f.failed ? { failed: '1' } : {}) });
      const r = await api('/audit/export?' + p); const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'jarvis-audit.csv' }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) { window.toast(err.message, true); }
  };
}
let rt = null;
window.addEventListener('jarvis:ev', e => { const d = e.detail || {}; if (U.el && U.tab === 'log' && ['pcAgent', 'notice', 'confirmDone'].includes(d.type)) { clearTimeout(rt); rt = setTimeout(load, 1500); } });

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('audit', { icon: 'shield', label: 'مجوزها و گزارش', end: true, enter, leave });
