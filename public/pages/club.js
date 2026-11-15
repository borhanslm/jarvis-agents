// The members club: required sign-in (a full-screen gate) + the «باشگاه» section.
// Members see their profile, Android licenses, announcements and support tickets;
// admins also manage members, announcements and tickets. Before a club exists,
// the section shows the one-click Cloudflare setup.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n || 0).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const fdate = ms => ms ? new Date(ms).toLocaleDateString('fa-IR-u-ca-persian', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const ftime = ms => ms ? new Date(ms).toLocaleString('fa-IR-u-ca-persian', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const toast = (m, e) => window.toast && window.toast(m, e);

const C = { st: null, el: null, tab: 'me', gateMode: 'login', users: null, q: '', stats: null, tickets: null, tfilter: 'open', thread: null, busy: false };
const isAdmin = () => !!(C.st && C.st.user && C.st.user.role === 'admin');

// ---------------- the gate ----------------
async function loadState() {
  try { C.st = await api('/club'); } catch { return; }
  window.JARVIS_CLUB = C.st;
  gate();
}
function gate() {
  const need = C.st && C.st.required && !C.st.loggedIn;
  let g = document.getElementById('clubGate');
  if (!need) { if (g) g.remove(); document.documentElement.classList.remove('club-locked'); return; }
  document.documentElement.classList.add('club-locked');
  if (!g) { g = document.createElement('div'); g.id = 'clubGate'; g.className = 'cg'; g.setAttribute('role', 'dialog'); g.setAttribute('aria-modal', 'true'); g.setAttribute('aria-labelledby', 'cgTitle'); document.body.appendChild(g); }
  const reg = C.gateMode === 'register';
  g.innerHTML = `<div class="cg-box">
    <img src="logo.svg" alt="" class="cg-logo" width="64" height="64">
    <h1 id="cgTitle">باشگاه جارویس</h1>
    <p class="help">${C.st.expired ? `${ic('wifi-off', 'sm')} مدت زیادی است به باشگاه وصل نشده‌اید. برای ادامه یک بار به اینترنت وصل شوید و دوباره وارد شوید.` : 'برای استفاده از جارویس عضو باشگاه شوید. عضویت رایگان است.'}</p>
    <div class="segm cg-seg" role="radiogroup" aria-label="ورود یا عضویت">
      <button type="button" role="radio" aria-checked="${!reg}" data-mode="login">${ic('log-in', 'sm')}ورود</button>
      <button type="button" role="radio" aria-checked="${reg}" data-mode="register">${ic('users', 'sm')}عضویت</button>
    </div>
    <form id="cgForm" class="cg-form" novalidate>
      ${reg ? `<div class="field"><label for="cgName">نام</label><input id="cgName" autocomplete="name" required maxlength="60"></div>` : ''}
      <div class="field"><label for="cgEmail">ایمیل</label><input id="cgEmail" type="email" dir="ltr" autocomplete="email" required value="${esc(C.st.user ? C.st.user.email : '')}"></div>
      ${reg ? `<div class="field"><label for="cgPhone">شماره‌ی موبایل <span class="help">(اختیاری)</span></label><input id="cgPhone" type="tel" dir="ltr" autocomplete="tel" maxlength="16"></div>` : ''}
      <div class="field"><label for="cgPass">رمز ${reg ? '<span class="help">(دست‌کم ۸ کاراکتر)</span>' : ''}</label><input id="cgPass" type="password" dir="ltr" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="${reg ? 8 : 1}"></div>
      <div id="cgErr" class="bad" role="alert"></div>
      <button type="submit" class="btn btn-primary cg-go">${reg ? 'ساخت حساب و ورود' : 'ورود'}</button>
    </form>
    ${reg ? `<p class="help cg-note">${ic('lock', 'sm')} فقط نام، ایمیل و در صورت تمایل شماره‌ی موبایل ذخیره می‌شود. رمز به‌صورت هش‌شده نگه داشته می‌شود و هر وقت بخواهید می‌توانید حسابتان را کامل پاک کنید.</p>` : ''}
  </div>`;
  g.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { C.gateMode = b.dataset.mode; gate(); });
  const f = g.querySelector('#cgForm');
  f.onsubmit = async e => {
    e.preventDefault();
    const v = id => (g.querySelector('#' + id) || {}).value || '';
    const err = g.querySelector('#cgErr'), go = g.querySelector('.cg-go');
    err.textContent = ''; go.disabled = true; go.textContent = 'لطفاً صبر کنید…';
    try {
      C.st = reg ? await api('/club/register', { body: { name: v('cgName'), email: v('cgEmail'), phone: v('cgPhone'), password: v('cgPass') } })
                 : await api('/club/login', { body: { email: v('cgEmail'), password: v('cgPass') } });
      window.JARVIS_CLUB = C.st; gate(); toast('خوش آمدید، ' + (C.st.user ? C.st.user.name : ''));
      if (window.rebuildRail) window.rebuildRail();
    } catch (x) { err.textContent = x.message; go.disabled = false; go.textContent = reg ? 'ساخت حساب و ورود' : 'ورود'; }
  };
  setTimeout(() => { const first = g.querySelector(reg ? '#cgName' : '#cgEmail'); if (first && !first.value) first.focus(); else g.querySelector('#cgPass').focus(); });
}
window.addEventListener('jarvis:ev', e => {
  const ev = e.detail; if (!ev || ev.type !== 'club') return;
  C.st = { ...ev.club, deploy: ev.club.deploy !== undefined ? ev.club.deploy : C.st && C.st.deploy }; window.JARVIS_CLUB = C.st; gate();
  if (C.el && C.el.classList.contains('on') && !C.busy) render();
});

// ---------------- the section ----------------
async function enter(host) { C.el = host; if (!C.st) await loadState(); render(); if (C.st && C.st.loggedIn && C.st.required) api('/club/refresh', { body: {} }).then(s => { C.st = s; render(); }).catch(() => {}); }
const call = (method, p, body) => api('/club' + p, { method, body });

function render() {
  if (!C.el) return;
  const st = C.st || {};
  if (!st.required) return renderSetup();
  if (!st.loggedIn) { C.el.innerHTML = `<div class="pg"><p class="help">برای دیدن باشگاه وارد شوید.</p></div>`; return; }
  const u = st.user || {}, admin = isAdmin();
  const tabs = [['me', 'users', 'حساب من'], ['support', 'messages-square', 'پشتیبانی']].concat(admin ? [['members', 'shield', 'اعضا'], ['news', 'bell', 'اطلاعیه‌ها'], ['inbox', 'inbox', 'درخواست‌ها']] : []);
  if (!tabs.some(t => t[0] === C.tab)) C.tab = 'me';
  C.el.innerHTML = `<div class="pg cl-page">
    <header class="pg-head"><div><h1>${ic('users')}باشگاه جارویس<span class="hud-tag" aria-hidden="true">CLUB</span></h1>
      <p class="help">${esc(u.name)} · <span dir="ltr">${esc(u.email)}</span> · <span class="chip cl-role ${admin ? 'is-admin' : ''}">${admin ? 'مدیر' : 'کاربر'}</span>${st.offline ? ` · <span class="chip">${ic('wifi-off', 'sm')}آفلاین — آخرین بررسی ${fdate(st.verifiedAt)}</span>` : ''}</p></div>
      <div class="row-gap"><button type="button" class="btn btn-sm ghost" id="clOut">${ic('log-out', 'sm')}خروج</button></div></header>
    <div class="segm cl-tabs" role="tablist">${tabs.map(([id, i, l]) => `<button type="button" role="tab" aria-checked="${C.tab === id}" aria-selected="${C.tab === id}" data-tab="${id}">${ic(i, 'sm')}${l}</button>`).join('')}</div>
    <div id="clBody" class="cl-body"></div></div>`;
  C.el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { C.tab = b.dataset.tab; C.thread = null; render(); });
  C.el.querySelector('#clOut').onclick = async () => { if (!confirm('از حساب باشگاه خارج شوید؟ برای استفاده از جارویس باید دوباره وارد شوید.')) return; C.st = await api('/club/logout', { body: {} }); C.gateMode = 'login'; gate(); render(); };
  const body = C.el.querySelector('#clBody');
  ({ me: tabMe, support: tabSupport, members: tabMembers, news: tabNews, inbox: tabInbox })[C.tab](body);
}

function tabMe(el) {
  const st = C.st, u = st.user || {}, me = st.me || {};
  const lic = me.licenses || [], ann = me.announcements || [];
  el.innerHTML = `<div class="sl-grid">
    <section class="sl-card"><h2>${ic('users', 'sm')}مشخصات</h2>
      <form id="clProf" class="cl-form">
        <div class="field"><label for="clName">نام</label><input id="clName" value="${esc(u.name)}" maxlength="60"></div>
        <div class="field"><label for="clPhone">شماره‌ی موبایل</label><input id="clPhone" dir="ltr" type="tel" value="${esc(u.phone)}" maxlength="16"></div>
        <div class="help">عضو از ${fdate(u.created)}</div>
        <button class="btn btn-sm btn-primary">${ic('save', 'sm')}ذخیره</button></form></section>
    <section class="sl-card"><h2>${ic('lock', 'sm')}تغییر رمز</h2>
      <form id="clPw" class="cl-form">
        <div class="field"><label for="clPw0">رمز فعلی</label><input id="clPw0" type="password" dir="ltr" autocomplete="current-password"></div>
        <div class="field"><label for="clPw1">رمز تازه (دست‌کم ۸ کاراکتر)</label><input id="clPw1" type="password" dir="ltr" autocomplete="new-password" minlength="8"></div>
        <button class="btn btn-sm">${ic('key-round', 'sm')}تغییر رمز</button></form></section>
    <section class="sl-card"><h2>${ic('smartphone', 'sm')}اپ اندروید</h2>
      ${lic.length ? lic.map(l => `<div class="cl-lic ${l.revoked ? 'off' : ''}"><div><b dir="ltr">${esc(l.code || '—')}</b>${l.revoked ? ' <span class="chip">لغو شده</span>' : ''}</div>
        <div class="help">گوشی <code dir="ltr">${esc(l.device || '—')}</code> · آپدیت تا ${fdate(l.updatesUntil)}</div>
        ${l.revoked ? '' : `<button type="button" class="cc-mini" data-copy="${esc(l.key)}">${ic('copy', 'sm')}کپی کلید کامل</button>`}</div>`).join('')
        : `<p class="help">هنوز اپ اندروید نخریده‌اید. اپ اندروید پولی است و بقیه‌ی جارویس رایگان. بعد از خرید، لایسنس اینجا نشان داده می‌شود و اپ با همین حساب خودش فعال می‌شود.</p>`}</section>
    <section class="sl-card"><h2>${ic('bell', 'sm')}اطلاعیه‌ها</h2>
      ${ann.length ? ann.map(a => `<article class="cl-ann"><h3>${esc(a.title)}${a.audience === 'buyers' ? ' <span class="chip">خریداران</span>' : ''}</h3><p>${esc(a.body)}</p><div class="help">${fdate(a.created)}</div></article>`).join('') : '<p class="help">اطلاعیه‌ای نیست.</p>'}</section>
    <section class="sl-card cl-danger"><h2>${ic('trash-2', 'sm')}پاک کردن حساب</h2>
      <p class="help">حساب، لایسنس‌های ثبت‌شده در باشگاه و درخواست‌های پشتیبانی شما برای همیشه پاک می‌شود. بعد از آن برای استفاده از جارویس باید دوباره عضو شوید.</p>
      <button type="button" class="btn btn-sm" id="clDel">${ic('trash-2', 'sm')}پاک کردن حساب من</button></section>
  </div>`;
  el.querySelector('#clProf').onsubmit = async e => { e.preventDefault(); try { await call('PATCH', '/api/me', { name: el.querySelector('#clName').value, phone: el.querySelector('#clPhone').value }); C.st = await api('/club/refresh', { body: {} }); toast('ذخیره شد'); render(); } catch (x) { toast(x.message, true); } };
  el.querySelector('#clPw').onsubmit = async e => { e.preventDefault(); try { await call('PATCH', '/api/me', { password: el.querySelector('#clPw0').value, newPassword: el.querySelector('#clPw1').value }); toast('رمز عوض شد'); e.target.reset(); } catch (x) { toast(x.message, true); } };
  el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('کپی شد'); } catch { toast('کپی نشد', true); } });
  el.querySelector('#clDel').onclick = async () => {
    const pw = prompt('برای پاک کردن همیشگی حساب، رمزتان را وارد کنید. این کار برگشت‌پذیر نیست.');
    if (!pw) return;
    try { await call('DELETE', '/api/me', { password: pw }); await api('/club/logout', { body: {} }).catch(() => {}); C.st = await api('/club'); C.gateMode = 'register'; gate(); toast('حساب پاک شد'); } catch (x) { toast(x.message, true); }
  };
}

// ---- tickets (shared by members and admins) ----
async function tabSupport(el) {
  if (C.thread) return renderThread(el, false);
  el.innerHTML = `<div class="sl-grid">
    <section class="sl-card"><h2>${ic('send', 'sm')}درخواست تازه</h2>
      <form id="clNewT" class="cl-form"><div class="field"><label for="clTs">موضوع</label><input id="clTs" maxlength="120" required></div>
      <div class="field"><label for="clTb">متن</label><textarea id="clTb" class="cl-ta" maxlength="4000" required></textarea></div>
      <button class="btn btn-sm btn-primary">${ic('send', 'sm')}ارسال</button></form></section>
    <section class="sl-card"><h2>${ic('messages-square', 'sm')}درخواست‌های من</h2><div id="clTl" class="help">در حال بارگذاری…</div></section></div>`;
  el.querySelector('#clNewT').onsubmit = async e => { e.preventDefault(); try { const r = await call('POST', '/api/tickets', { subject: el.querySelector('#clTs').value, body: el.querySelector('#clTb').value }); C.thread = r.id; render(); } catch (x) { toast(x.message, true); } };
  try { const r = await call('GET', '/api/tickets'); el.querySelector('#clTl').outerHTML = ticketList(r.tickets, false); bindTickets(el); } catch (x) { el.querySelector('#clTl').textContent = x.message; }
}
const ticketList = (list, admin) => list.length ? `<ul class="cl-tl">${list.map(t => `<li><button type="button" data-t="${esc(t.id)}" class="cl-t ${t.unread ? 'unread' : ''}">
  <span class="cl-t-s">${t.unread ? '<i class="cl-dot" aria-label="خوانده نشده"></i>' : ''}${esc(t.subject)}</span>
  <span class="help">${admin ? esc(t.userName) + ' · ' : ''}${t.status === 'open' ? 'باز' : 'بسته'} · ${ftime(t.updated)}</span></button></li>`).join('')}</ul>` : '<p class="help">درخواستی نیست.</p>';
const bindTickets = el => el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { C.thread = b.dataset.t; render(); });
async function renderThread(el, admin) {
  el.innerHTML = `<section class="sl-card"><div class="help">در حال بارگذاری…</div></section>`;
  let r; try { r = await call('GET', '/api/tickets/' + C.thread); } catch (x) { el.innerHTML = `<p class="bad">${esc(x.message)}</p>`; return; }
  const t = r.ticket;
  el.innerHTML = `<section class="sl-card cl-thread">
    <div class="cl-th-head"><button type="button" class="btn btn-sm ghost" id="clBack">${ic('chevron-right', 'sm')}بازگشت</button>
      <h2>${esc(t.subject)}</h2><span class="chip">${t.status === 'open' ? 'باز' : 'بسته'}</span>
      ${admin ? `<span class="help">${esc(t.userName)} · <span dir="ltr">${esc(t.userEmail)}</span></span><button type="button" class="btn btn-sm" id="clTst">${t.status === 'open' ? 'بستن' : 'باز کردن'}</button>` : ''}</div>
    <div class="cl-msgs">${r.messages.map(m => `<div class="cl-msg ${m.fromAdmin ? 'adm' : 'usr'}"><div class="cl-msg-who">${m.fromAdmin ? 'پشتیبانی' : esc(admin ? t.userName : 'شما')} · ${ftime(m.created)}</div><p>${esc(m.body)}</p></div>`).join('')}</div>
    <form id="clRep" class="cl-form"><div class="field"><label for="clRb">پاسخ</label><textarea id="clRb" class="cl-ta" maxlength="4000" required></textarea></div>
      <button class="btn btn-sm btn-primary">${ic('send', 'sm')}ارسال</button></form></section>`;
  el.querySelector('#clBack').onclick = () => { C.thread = null; render(); };
  el.querySelector('#clRep').onsubmit = async e => { e.preventDefault(); try { await call('POST', '/api/tickets/' + t.id, { body: el.querySelector('#clRb').value }); renderThread(el, admin); } catch (x) { toast(x.message, true); } };
  const s = el.querySelector('#clTst'); if (s) s.onclick = async () => { try { await call('PATCH', '/api/admin/tickets/' + t.id, { status: t.status === 'open' ? 'closed' : 'open' }); renderThread(el, admin); } catch (x) { toast(x.message, true); } };
}

// ---- admin ----
async function tabMembers(el) {
  el.innerHTML = `<div class="ag-stats cl-stats" id="clStats"></div>
    <div class="cl-bar"><input id="clQ" class="cl-q" type="search" placeholder="جستجوی نام، ایمیل یا شماره…" aria-label="جستجوی اعضا" value="${esc(C.q)}"></div>
    <div class="sl-table-wrap"><table class="sl-table"><thead><tr><th>نام</th><th>ایمیل</th><th>موبایل</th><th>نقش</th><th>وضعیت</th><th>آخرین حضور</th><th>اپ</th><th></th></tr></thead><tbody id="clUsers"><tr><td colspan="8" class="help">در حال بارگذاری…</td></tr></tbody></table></div>
    <div class="help" id="clTot"></div>
    <section class="sl-card cl-addr"><h2>${ic('globe', 'sm')}آدرس باشگاه</h2><div class="help">این آدرس داخل نسخه‌های بعدی جارویس و اپ اندروید قرار می‌گیرد:</div><code dir="ltr" class="sl-pub">${esc(C.st.url)}</code></section>`;
  call('GET', '/api/admin/stats').then(s => {
    el.querySelector('#clStats').innerHTML = [['users', 'عضو'], ['new7', 'تازه (۷ روز)'], ['active7', 'فعال (۷ روز)'], ['buyers', 'خریدار'], ['openTickets', 'درخواست باز'], ['blocked', 'مسدود']].map(([k, l]) => `<div class="pg-stat"><b>${faN(s[k])}</b><span>${l}</span></div>`).join('');
  }).catch(() => {});
  let tmr; el.querySelector('#clQ').oninput = e => { clearTimeout(tmr); tmr = setTimeout(() => { C.q = e.target.value.trim(); loadUsers(el); }, 300); };
  loadUsers(el);
}
async function loadUsers(el) {
  let r; try { r = await call('GET', '/api/admin/users?q=' + encodeURIComponent(C.q)); } catch (x) { el.querySelector('#clUsers').innerHTML = `<tr><td colspan="8" class="bad">${esc(x.message)}</td></tr>`; return; }
  const me = C.st.user.id;
  el.querySelector('#clTot').textContent = faN(r.total) + ' عضو' + (C.q ? ' پیدا شد' : '');
  el.querySelector('#clUsers').innerHTML = r.users.map(u => `<tr>
    <td>${esc(u.name)}</td><td dir="ltr">${esc(u.email)}</td><td dir="ltr">${esc(u.phone || '—')}</td>
    <td><span class="chip cl-role ${u.role === 'admin' ? 'is-admin' : ''}">${u.role === 'admin' ? 'مدیر' : 'کاربر'}</span></td>
    <td>${u.status === 'blocked' ? '<span class="chip cl-blocked">مسدود</span>' : 'فعال'}</td>
    <td>${fdate(u.lastSeen)}${u.client ? ` <span class="help">(${u.client === 'android' ? 'اندروید' : u.client === 'desktop' ? 'دسکتاپ' : 'وب'})</span>` : ''}</td>
    <td>${u.licenses ? faN(u.licenses) : '—'}</td>
    <td class="sl-acts">${u.id === me ? '<span class="help">شما</span>' : `
      <button type="button" class="cc-mini" data-role="${esc(u.id)}" data-to="${u.role === 'admin' ? 'user' : 'admin'}" title="${u.role === 'admin' ? 'برداشتن نقش مدیر' : 'مدیر کردن'}" aria-label="${u.role === 'admin' ? 'برداشتن نقش مدیر' : 'مدیر کردن'}">${ic('shield', 'sm')}</button>
      <button type="button" class="cc-mini" data-block="${esc(u.id)}" data-to="${u.status === 'blocked' ? 'active' : 'blocked'}" title="${u.status === 'blocked' ? 'رفع مسدودی' : 'مسدود کردن'}" aria-label="${u.status === 'blocked' ? 'رفع مسدودی' : 'مسدود کردن'}">${ic(u.status === 'blocked' ? 'rotate-ccw' : 'circle-x', 'sm')}</button>
      <button type="button" class="cc-mini" data-deluser="${esc(u.id)}" data-name="${esc(u.name)}" title="پاک کردن عضو" aria-label="پاک کردن عضو">${ic('trash-2', 'sm')}</button>`}</td></tr>`).join('') || '<tr><td colspan="8" class="help">عضوی پیدا نشد.</td></tr>';
  const act = async (fn, msg) => { try { await fn(); toast(msg); loadUsers(el); } catch (x) { toast(x.message, true); } };
  el.querySelectorAll('[data-role]').forEach(b => b.onclick = () => { if (b.dataset.to === 'admin' && !confirm('این عضو مدیر شود؟ مدیرها به همه‌ی اعضا و درخواست‌ها دسترسی دارند.')) return; act(() => call('PATCH', '/api/admin/users/' + b.dataset.role, { role: b.dataset.to }), 'نقش عوض شد'); });
  el.querySelectorAll('[data-block]').forEach(b => b.onclick = () => { if (b.dataset.to === 'blocked' && !confirm('این عضو مسدود شود؟ از همه‌ی دستگاه‌ها خارج می‌شود و دیگر نمی‌تواند وارد شود.')) return; act(() => call('PATCH', '/api/admin/users/' + b.dataset.block, { status: b.dataset.to }), b.dataset.to === 'blocked' ? 'مسدود شد' : 'آزاد شد'); });
  el.querySelectorAll('[data-deluser]').forEach(b => b.onclick = () => { if (!confirm(`حساب «${b.dataset.name}» برای همیشه پاک شود؟ این کار برگشت‌پذیر نیست.`)) return; act(() => call('DELETE', '/api/admin/users/' + b.dataset.deluser), 'پاک شد'); });
}
function tabNews(el) {
  const ann = (C.st.me && C.st.me.announcements) || [];
  el.innerHTML = `<div class="sl-grid">
    <section class="sl-card"><h2>${ic('bell', 'sm')}اطلاعیه‌ی تازه</h2>
      <form id="clAn" class="cl-form"><div class="field"><label for="clAt">عنوان</label><input id="clAt" maxlength="120" required></div>
      <div class="field"><label for="clAb">متن</label><textarea id="clAb" class="cl-ta" maxlength="4000" required></textarea></div>
      <div class="field"><label for="clAa">برای</label><select id="clAa"><option value="all">همه‌ی اعضا</option><option value="buyers">فقط خریداران اپ اندروید</option></select></div>
      <button class="btn btn-sm btn-primary">${ic('send', 'sm')}انتشار</button></form></section>
    <section class="sl-card"><h2>${ic('history', 'sm')}منتشرشده‌ها</h2>
      ${ann.length ? ann.map(a => `<article class="cl-ann"><h3>${esc(a.title)} <span class="chip">${a.audience === 'buyers' ? 'خریداران' : 'همه'}</span>
        <button type="button" class="cc-mini" data-delann="${esc(a.id)}" aria-label="پاک کردن اطلاعیه" title="پاک کردن">${ic('trash-2', 'sm')}</button></h3><p>${esc(a.body)}</p><div class="help">${fdate(a.created)}</div></article>`).join('') : '<p class="help">هنوز اطلاعیه‌ای منتشر نشده.</p>'}</section></div>`;
  el.querySelector('#clAn').onsubmit = async e => { e.preventDefault(); try { await call('POST', '/api/admin/announcements', { title: el.querySelector('#clAt').value, body: el.querySelector('#clAb').value, audience: el.querySelector('#clAa').value }); C.st = await api('/club/refresh', { body: {} }); toast('منتشر شد'); render(); } catch (x) { toast(x.message, true); } };
  el.querySelectorAll('[data-delann]').forEach(b => b.onclick = async () => { if (!confirm('این اطلاعیه پاک شود؟')) return; try { await call('DELETE', '/api/admin/announcements/' + b.dataset.delann); C.st = await api('/club/refresh', { body: {} }); render(); } catch (x) { toast(x.message, true); } });
}
async function tabInbox(el) {
  if (C.thread) return renderThread(el, true);
  el.innerHTML = `<section class="sl-card"><div class="cl-bar"><div class="segm" role="radiogroup" aria-label="فیلتر درخواست‌ها">${[['open', 'باز'], ['closed', 'بسته'], ['all', 'همه']].map(([k, l]) => `<button type="button" role="radio" aria-checked="${C.tfilter === k}" data-f="${k}">${l}</button>`).join('')}</div></div><div id="clTl" class="help">در حال بارگذاری…</div></section>`;
  el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { C.tfilter = b.dataset.f; tabInbox(el); });
  try { const r = await call('GET', '/api/admin/tickets?status=' + C.tfilter); el.querySelector('#clTl').outerHTML = ticketList(r.tickets, true); bindTickets(el); } catch (x) { el.querySelector('#clTl').textContent = x.message; }
}

// ---- setup (no club yet) ----
function renderSetup() {
  const d = (C.st && C.st.deploy) || null;
  C.el.innerHTML = `<div class="pg cl-page">
    <header class="pg-head"><div><h1>${ic('users')}باشگاه جارویس<span class="hud-tag" aria-hidden="true">SETUP</span></h1>
      <p class="help">باشگاه هنوز راه‌اندازی نشده. بعد از راه‌اندازی، هر کس جارویس (دسکتاپ یا اندروید) را باز کند باید عضو شود یا وارد شود. شما مدیر هستید و بقیه کاربر.</p></div></header>
    <div class="sl-grid">
      <section class="sl-card"><h2>${ic('cloud-sun', 'sm')}راه‌اندازی رایگان در Cloudflare</h2>
        <ol class="cl-steps">
          <li>یک حساب رایگان Cloudflare بسازید: <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener" dir="ltr">dash.cloudflare.com/sign-up</a></li>
          <li><button type="button" class="btn btn-sm" id="clCf">${ic('log-in', 'sm')}ورود به Cloudflare</button> <span class="help">(مرورگر باز می‌شود؛ «Allow» را بزنید)</span></li>
          <li><div class="field"><label for="clAdm">ایمیل مدیر (همان ایمیلی که با آن در باشگاه عضو می‌شوید)</label><input id="clAdm" type="email" dir="ltr" placeholder="you@example.com"></div>
            <button type="button" class="btn btn-sm btn-primary" id="clDeploy" ${d && d.running ? 'disabled' : ''}>${ic('upload', 'sm')}${d && d.running ? 'در حال راه‌اندازی…' : 'ساخت باشگاه'}</button></li>
        </ol>
        ${d ? `<pre class="sl-msg cl-log" aria-live="polite">${esc((d.log || []).join('\n'))}${d.error ? '\n✖ ' + esc(d.error) : ''}</pre>` : ''}
        <p class="help sl-warn">${ic('triangle-alert', 'sm')} آدرس‌های <span dir="ltr">workers.dev</span> ممکن است در ایران فیلتر باشند. اگر کاربران ایرانی دارید، بعداً یک دامنه‌ی اختصاصی در Cloudflare به سرویس وصل کنید و آدرسش را پایین وارد کنید.</p></section>
      <section class="sl-card"><h2>${ic('globe', 'sm')}باشگاه موجود</h2>
        <p class="help">اگر باشگاه از قبل ساخته شده، آدرسش را وارد کنید.</p>
        <div class="field"><label for="clUrl">آدرس باشگاه</label><input id="clUrl" dir="ltr" placeholder="https://jarvis-club.you.workers.dev"></div>
        <button type="button" class="btn btn-sm" id="clSave">${ic('save', 'sm')}اتصال</button></section>
    </div></div>`;
  C.el.querySelector('#clCf').onclick = async e => { const b = e.currentTarget; b.disabled = true; toast('مرورگر برای ورود به Cloudflare باز می‌شود…'); try { const r = await api('/club/cf-login', { body: {} }); toast(r.ok ? 'وارد Cloudflare شدید' : 'ورود انجام نشد', !r.ok); } catch (x) { toast(x.message, true); } b.disabled = false; };
  C.el.querySelector('#clDeploy').onclick = async () => { try { C.st = await api('/club/deploy', { body: { adminEmail: C.el.querySelector('#clAdm').value } }); renderSetup(); } catch (x) { toast(x.message, true); } };
  C.el.querySelector('#clSave').onclick = async () => { try { C.st = await api('/club/address', { body: { url: C.el.querySelector('#clUrl').value } }); window.JARVIS_CLUB = C.st; gate(); render(); } catch (x) { toast(x.message, true); } };
}

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('club', { icon: 'users', label: 'باشگاه', end: true, enter, leave() { C.el = null; } });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadState); else loadState();
