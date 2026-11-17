// Email & calendar: the inbox of the user's email account (IMAP with an app password), reading,
// writing and replying (AI can write the draft), and upcoming calendar events (private iCal address).
// Nothing is sent without the user's explicit confirmation.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const when = ms => {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' });
};
const evWhen = e => {
  const d = new Date(e.start), today = new Date(), tom = new Date(); tom.setDate(today.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? 'امروز' : d.toDateString() === tom.toDateString() ? 'فردا' : d.toLocaleDateString('fa-IR', { weekday: 'long', month: 'short', day: 'numeric' });
  return e.allDay ? day + ' — تمام روز' : day + ' ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
};
const avatar = n => { const l = String(n || '').replace(/[^\p{L}]/gu, '')[0]; return `<span class="sms-av" aria-hidden="true">${l ? esc(l.toUpperCase()) : ic('at-sign', 'sm')}</span>`; };

const M = { el: null, info: null, acc: '', list: null, sel: null, msg: null, compose: null, events: null, setup: false, busy: false, q: '', error: '' };
function enter(host) { M.el = host; load(); }
function leave() { M.el = null; }
async function load() {
  try { M.info = await api('/mail'); } catch (e) { M.info = { accounts: [], presets: {}, calendars: [] }; M.error = e.message; }
  if (!M.acc || !M.info.accounts.some(a => a.id === M.acc)) M.acc = (M.info.accounts[0] || {}).id || '';
  if (!M.info.accounts.length && !M.info.calendars.length) M.setup = true;
  render();
  inbox(false); events(false);
}
async function inbox(fresh) {
  if (!M.acc) { M.list = null; return render(); }
  M.error = '';
  try { M.list = (await api(`/mail/inbox?account=${encodeURIComponent(M.acc)}${fresh ? '&fresh=1' : ''}`)).list; } catch (e) { M.error = e.message; M.list = M.list || []; }
  render();
}
async function events(fresh) {
  if (!M.info || !M.info.calendars.length) { M.events = null; return render(); }
  try { M.events = (await api('/mail/events?days=14' + (fresh ? '&fresh=1' : ''))).events; } catch { M.events = []; }
  render();
}
async function open(uid) {
  M.sel = uid; M.msg = { loading: true }; M.compose = null; render();
  try { M.msg = await api(`/mail/message?account=${encodeURIComponent(M.acc)}&uid=${uid}`); const x = (M.list || []).find(y => y.uid === uid); if (x) x.seen = true; }
  catch (e) { M.msg = { error: e.message }; }
  render();
}

function render() {
  if (!M.el || !M.info) return;
  const accs = M.info.accounts;
  const focusId = document.activeElement && M.el.contains(document.activeElement) ? document.activeElement.id : '';
  const keep = ['mcTo', 'mcSubj', 'mcText', 'mcAsk'].reduce((o, id) => { const i = $('#' + id, M.el); if (i) o[id] = i.value; return o; }, {});
  if (M.compose) Object.assign(M.compose, { to: keep.mcTo ?? M.compose.to, subject: keep.mcSubj ?? M.compose.subject, text: keep.mcText ?? M.compose.text, ask: keep.mcAsk ?? M.compose.ask });
  M.el.innerHTML = `<div class="pg sms-page mail-page">
    <header class="pg-head"><div><h1>${ic('mail')}ایمیل و تقویم<span class="hud-tag" aria-hidden="true">MAIL</span></h1>
      <p class="help">صندوق ایمیل و رویدادهای پیش‌رو. جارویس می‌تواند ایمیل بنویسد و جواب بدهد، ولی <b>هیچ ایمیلی بدون تأیید شما فرستاده نمی‌شود</b>.</p></div>
      <div class="sms-actions">${accs.length > 1 ? `<label class="sr-only" for="mAcc">حساب</label><select id="mAcc">${accs.map(a => `<option value="${esc(a.id)}" ${a.id === M.acc ? 'selected' : ''}>${esc(a.email)}</option>`).join('')}</select>` : ''}
        ${accs.length ? `<button type="button" class="btn" id="mRefresh">${ic('refresh-cw', 'sm')}به‌روزرسانی</button><button type="button" class="btn btn-primary" id="mNew">${ic('pencil', 'sm')}ایمیل تازه</button>` : ''}
        <button type="button" class="btn ghost" id="mSetup" aria-expanded="${M.setup}">${ic('settings', 'sm')}حساب‌ها و تقویم‌ها</button></div></header>
    ${M.setup ? setupHtml() : ''}
    <div class="mail-grid">
      <section class="sms-list" aria-label="صندوق ورودی">
        <div class="sms-search">${ic('search', 'sm')}<input id="mQ" type="search" placeholder="جستجو در فرستنده و موضوع" value="${esc(M.q)}" aria-label="جستجو"></div>
        ${listHtml()}
      </section>
      <section class="sms-conv mail-read" aria-label="${M.compose ? 'نوشتن ایمیل' : 'متن ایمیل'}">${M.compose ? composeHtml() : readHtml()}</section>
      <aside class="sms-list mail-cal" aria-label="رویدادهای پیش‌رو"><div class="sms-conv-h"><b>${ic('calendar', 'sm')} رویدادهای پیش‌رو</b>${M.info.calendars.length ? `<button type="button" class="btn btn-sm ghost" id="mEvRefresh" aria-label="به‌روزرسانی تقویم">${ic('refresh-cw', 'sm')}</button>` : ''}</div>${calHtml()}</aside>
    </div></div>`;
  bind();
  if (focusId && $('#' + focusId, M.el)) { const f = $('#' + focusId, M.el); f.focus(); if (f.setSelectionRange && f.value) try { f.setSelectionRange(f.value.length, f.value.length); } catch {} }
}
function listHtml() {
  if (!M.info.accounts.length) return `<div class="sms-empty"><p class="help">هنوز حساب ایمیلی وصل نشده. «حساب‌ها و تقویم‌ها» را بزنید.</p></div>`;
  if (M.list == null) return `<div class="sms-empty">${'<div class="sms-skel"></div>'.repeat(5)}</div>`;
  const q = M.q.trim().toLowerCase();
  const list = M.list.filter(x => !q || (x.from.name + ' ' + x.from.email + ' ' + x.subject).toLowerCase().includes(q));
  return `${M.error ? `<p class="sk-warn" role="alert">${ic('triangle-alert', 'sm')}${esc(M.error)}</p>` : ''}
    ${list.length ? `<ul role="list" class="mail-ul">${list.map(x => `<li><button type="button" class="sms-th ${M.sel === x.uid ? 'on' : ''} ${x.seen ? '' : 'unread'}" data-uid="${x.uid}">${avatar(x.from.name || x.from.email)}
      <span class="sms-th-b"><b dir="auto">${esc(x.from.name || x.from.email)}</b><span class="help mail-subj" dir="auto">${esc(x.subject || '(بدون موضوع)')}</span></span>
      <span class="sms-th-t">${esc(when(x.date))}${x.seen ? '' : '<span class="mail-dot" aria-label="خوانده‌نشده"></span>'}</span></button></li>`).join('')}</ul>`
      : `<p class="help sms-empty">${q ? 'چیزی پیدا نشد.' : 'صندوق خالی است.'}</p>`}`;
}
function readHtml() {
  const m = M.msg;
  if (!m) return `<div class="sms-none">${ic('inbox')}<p class="help">یک ایمیل را انتخاب کنید.</p></div>`;
  if (m.loading) return `<div class="sms-none"><p class="help">در حال باز کردن…</p></div>`;
  if (m.error) return `<div class="sms-none"><p class="sk-warn" role="alert">${esc(m.error)}</p></div>`;
  return `<div class="sms-conv-h mail-h"><div class="mail-hb"><h2 dir="auto">${esc(m.subject || '(بدون موضوع)')}</h2>
      <span class="help"><b dir="auto">${esc(m.from.name || '')}</b> <span dir="ltr">&lt;${esc(m.from.email)}&gt;</span> · ${esc(new Date(m.date).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }))}</span></div>
    <div class="row-gap"><button type="button" class="btn btn-sm" id="mReply">${ic('reply', 'sm')}جواب</button><button type="button" class="btn btn-sm btn-primary" id="mAiReply">${ic('sparkles', 'sm')}جواب با هوش مصنوعی</button></div></div>
    <div class="mail-body" dir="auto">${esc(m.text || '(متنی ندارد)')}</div>
    ${m.attachments && m.attachments.length ? `<div class="mail-att help">${ic('paperclip', 'sm')} ${m.attachments.map(a => esc(a.name)).join('، ')} <span>(پیوست‌ها را در خود سرویس ایمیل باز کنید)</span></div>` : ''}`;
}
function composeHtml() {
  const c = M.compose;
  return `<div class="sms-conv-h"><b>${ic('pencil', 'sm')} ${c.inReplyTo ? 'جواب' : 'ایمیل تازه'}</b><button type="button" class="btn btn-sm ghost" id="mcClose" style="margin-inline-start:auto">${ic('x', 'sm')}انصراف</button></div>
    <div class="mail-compose">
      <div class="field"><label for="mcTo">به</label><input id="mcTo" dir="ltr" value="${esc(c.to)}" placeholder="name@example.com" autocomplete="off"></div>
      <div class="field"><label for="mcSubj">موضوع</label><input id="mcSubj" dir="auto" value="${esc(c.subject)}"></div>
      <div class="mail-ai"><label for="mcAsk" class="help">${ic('sparkles', 'sm')} به جارویس بگویید چه بنویسد</label>
        <div class="sk-ai-row"><input id="mcAsk" dir="auto" value="${esc(c.ask || '')}" placeholder="${c.inReplyTo ? 'مثلاً: تشکر کن و بگو پنجشنبه ساعت ۱۰ وقت دارم' : 'مثلاً: از آقای احمدی بپرس فاکتور ماه پیش کی می‌رسد'}">
          <button type="button" class="btn" id="mcAi" ${M.busy ? 'disabled' : ''}>${ic('sparkles', 'sm')}${M.busy ? 'در حال نوشتن…' : 'بنویس'}</button></div></div>
      <div class="field mail-text"><label for="mcText">متن</label><textarea id="mcText" dir="auto" rows="12">${esc(c.text)}</textarea></div>
      <div class="row-gap"><button type="button" class="btn btn-primary" id="mcSend">${ic('send', 'sm')}ارسال…</button><span class="help">قبل از ارسال یک بار دیگر تأیید می‌خواهد.</span></div>
    </div>`;
}
function calHtml() {
  if (!M.info.calendars.length) return `<div class="sms-empty"><p class="help">تقویمی وصل نیست. در «حساب‌ها و تقویم‌ها» آدرس iCal تقویم گوگل یا Outlook را بگذارید.</p></div>`;
  if (M.events == null) return `<div class="sms-empty">${'<div class="sms-skel"></div>'.repeat(3)}</div>`;
  const errs = M.info.calendars.filter(c => c.error);
  return `${errs.length ? `<p class="sk-warn">${ic('triangle-alert', 'sm')}${errs.map(c => esc(c.name + ': ' + c.error)).join('<br>')}</p>` : ''}
    ${M.events.length ? `<ul role="list" class="mail-ev">${M.events.slice(0, 60).map(e => `<li style="${e.color ? '--ev:' + esc(e.color) : ''}"><b dir="auto">${esc(e.title)}</b><span class="help">${esc(evWhen(e))}${e.location ? ' · ' + esc(e.location) : ''}</span><small class="help">${esc(e.calendar)}</small></li>`).join('')}</ul>`
      : '<p class="help sms-empty">در دو هفته‌ی آینده رویدادی نیست.</p>'}`;
}
function setupHtml() {
  const P = M.info.presets || {};
  return `<section class="sl-card mail-setup" aria-label="حساب‌ها و تقویم‌ها">
    <div class="mail-setup-g">
      <div><h2>${ic('mail', 'sm')}حساب ایمیل</h2>
        ${M.info.accounts.map(a => `<div class="ext-row"><span class="ext-ic">${ic('at-sign')}</span><div class="ext-main"><b dir="ltr">${esc(a.email)}</b><div class="help">${esc((P[a.preset] || {}).name || a.preset)} · ${a.hasPass ? 'رمز برنامه ذخیره شده (رمزنگاری‌شده)' : 'رمز ندارد'}</div></div>
          <div class="ext-acts"><button type="button" class="btn btn-sm ghost danger" data-maildel="${esc(a.id)}">${ic('trash-2', 'sm')}حذف</button></div></div>`).join('')}
        <div class="field"><label for="msPreset">سرویس</label><select id="msPreset">${Object.entries(P).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select></div>
        <p class="help" id="msNote"></p>
        <div class="field"><label for="msEmail">آدرس ایمیل</label><input id="msEmail" dir="ltr" type="email" autocomplete="off" placeholder="you@gmail.com"></div>
        <div class="field"><label for="msPass">رمز برنامه (App password)</label><input id="msPass" dir="ltr" type="password" autocomplete="off"></div>
        <div class="field"><label for="msName">نام شما در ایمیل‌ها (اختیاری)</label><input id="msName" dir="auto" autocomplete="off"></div>
        <div class="ms-custom" hidden><div class="field-row"><div class="field"><label for="msImap">سرور IMAP</label><input id="msImap" dir="ltr" placeholder="imap.example.com"></div><div class="field" style="flex:0 0 90px"><label for="msImapPort">پورت</label><input id="msImapPort" dir="ltr" value="993"></div></div>
          <div class="field-row"><div class="field"><label for="msSmtp">سرور SMTP</label><input id="msSmtp" dir="ltr" placeholder="smtp.example.com"></div><div class="field" style="flex:0 0 90px"><label for="msSmtpPort">پورت</label><input id="msSmtpPort" dir="ltr" value="465"></div></div></div>
        <button type="button" class="btn btn-primary" id="msSave" ${M.busy ? 'disabled' : ''}>${ic('plug', 'sm')}${M.busy ? 'در حال آزمایش اتصال…' : 'وصل کن'}</button>
        <p class="help">${ic('lock', 'sm')} رمز رمزنگاری‌شده فقط روی همین کامپیوتر می‌ماند. ایمیل‌ها مستقیم از سرور خوانده می‌شوند و جایی ذخیره نمی‌شوند.</p></div>
      <div><h2>${ic('calendar', 'sm')}تقویم</h2>
        ${M.info.calendars.map(c => `<div class="ext-row"><span class="ext-ic">${ic('calendar')}</span><div class="ext-main"><b dir="auto">${esc(c.name)}</b>${c.error ? `<div class="warn help">${esc(c.error)}</div>` : ''}</div>
          <div class="ext-acts"><button type="button" class="btn btn-sm ghost danger" data-caldel="${esc(c.id)}">${ic('trash-2', 'sm')}حذف</button></div></div>`).join('')}
        <div class="field"><label for="mcName">نام</label><input id="mcName" dir="auto" placeholder="کار، خانواده…"></div>
        <div class="field"><label for="mcUrl">آدرس خصوصی iCal</label><input id="mcUrl" dir="ltr" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"></div>
        <button type="button" class="btn" id="mcAdd">${ic('plus', 'sm')}افزودن تقویم</button>
        <details class="help"><summary>این آدرس را از کجا بیاورم؟</summary>
          <p><b>تقویم گوگل:</b> calendar.google.com ← چرخ‌دنده ← تنظیمات ← روی نام تقویم بزنید ← «آدرس مخفی در قالب iCal» را کپی کنید.</p>
          <p><b>Outlook:</b> تنظیمات ← Calendar ← Shared calendars ← Publish a calendar ← لینک ICS.</p>
          <p><b>اپل:</b> در iCloud تقویم را «Public» کنید و لینک webcal را بگذارید.</p>
          <p>جارویس فقط می‌خواند؛ برای قرار گذاشتن از «تسک‌ها» یا صدا استفاده کنید («فردا ساعت ده جلسه را یادم بنداز»).</p></details></div>
    </div></section>`;
}

function bind() {
  const el = M.el;
  const on = (id, fn) => { const x = $('#' + id, el); if (x) x.onclick = fn; };
  on('mSetup', () => { M.setup = !M.setup; render(); });
  on('mRefresh', () => { M.list = null; render(); inbox(true); events(true); });
  on('mEvRefresh', () => { M.events = null; render(); events(true); });
  on('mNew', () => { M.compose = { to: '', subject: '', text: '', ask: '' }; M.sel = null; render(); $('#mcTo', el).focus(); });
  const acc = $('#mAcc', el); if (acc) acc.onchange = () => { M.acc = acc.value; M.list = null; M.msg = null; M.sel = null; render(); inbox(false); };
  const q = $('#mQ', el); if (q) q.oninput = () => { M.q = q.value; render(); };
  el.querySelectorAll('[data-uid]').forEach(b => b.onclick = () => open(+b.dataset.uid));
  const reply = ai => {
    const m = M.msg; M.compose = { to: m.from.email, subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, text: '', ask: '', uid: m.uid, inReplyTo: m.messageId, references: m.references };
    render(); if (ai) draft(); else $('#mcText', el).focus();
  };
  on('mReply', () => reply(false)); on('mAiReply', () => reply(true));
  on('mcClose', () => { M.compose = null; render(); });
  on('mcAi', () => draft());
  on('mcSend', async () => {
    render(); const c = M.compose;
    if (!c.to.trim() || !c.text.trim()) return window.toast('گیرنده و متن را بنویسید', true);
    if (!confirm(`این ایمیل فرستاده شود؟\n\nبه: ${c.to}\nموضوع: ${c.subject || '(بدون موضوع)'}\n\n${c.text.slice(0, 400)}${c.text.length > 400 ? '…' : ''}`)) return;
    const b = $('#mcSend', el); b.disabled = true; b.textContent = 'در حال ارسال…';
    try { await api('/mail/send', { body: { account: M.acc, to: c.to, subject: c.subject, text: c.text, inReplyTo: c.inReplyTo || '', references: c.references || '', confirmed: true } }); window.toast('ایمیل فرستاده شد'); M.compose = null; render(); }
    catch (e) { window.toast(e.message, true); b.disabled = false; b.innerHTML = ic('send', 'sm') + 'ارسال…'; }
  });
  if (M.setup) {
    const sel = $('#msPreset', el), P = M.info.presets;
    const sync = () => { const p = P[sel.value] || {}; $('#msNote', el).innerHTML = esc(p.note || '') + (p.help ? ` <a href="${esc(p.help)}" target="_blank" rel="noopener">${ic('external-link', 'sm')}ساختن رمز برنامه</a>` : ''); el.querySelector('.ms-custom').hidden = sel.value !== 'custom'; };
    sel.onchange = sync; sync();
    on('msSave', async () => {
      const v = id => $('#' + id, el).value.trim();
      M.busy = true; const btn = $('#msSave', el); btn.disabled = true; btn.textContent = 'در حال آزمایش اتصال…';
      try { const r = await api('/mail/accounts', { body: { preset: sel.value, email: v('msEmail'), pass: $('#msPass', el).value, fromName: v('msName'), imap: v('msImap'), imapPort: v('msImapPort'), smtp: v('msSmtp'), smtpPort: v('msSmtpPort') }, timeout: 60000 });
        M.info.accounts = r.accounts; M.acc = M.acc || (r.accounts[0] || {}).id; window.toast('حساب ایمیل وصل شد'); M.setup = false; M.busy = false; M.list = null; render(); inbox(false); }
      catch (e) { M.busy = false; window.toast(e.message, true); btn.disabled = false; btn.innerHTML = ic('plug', 'sm') + 'وصل کن'; }
    });
    on('mcAdd', async () => {
      const b = $('#mcAdd', el); b.disabled = true;
      try { const r = await api('/mail/calendars', { body: { name: $('#mcName', el).value, url: $('#mcUrl', el).value }, timeout: 40000 }); M.info.calendars = r.calendars; window.toast('تقویم اضافه شد'); M.events = null; render(); events(false); }
      catch (e) { window.toast(e.message, true); b.disabled = false; }
    });
    el.querySelectorAll('[data-maildel]').forEach(b => b.onclick = async () => { if (!confirm('این حساب ایمیل از جارویس برداشته شود؟ (خود ایمیل‌ها پاک نمی‌شوند)')) return; const r = await api('/mail/accounts/' + b.dataset.maildel, { method: 'DELETE' }); M.info.accounts = r.accounts; M.acc = (r.accounts[0] || {}).id || ''; M.list = null; M.msg = null; render(); inbox(false); });
    el.querySelectorAll('[data-caldel]').forEach(b => b.onclick = async () => { if (!confirm('این تقویم برداشته شود؟')) return; const r = await api('/mail/calendars/' + b.dataset.caldel, { method: 'DELETE' }); M.info.calendars = r.calendars; render(); events(false); });
  }
}
async function draft() {
  render(); const c = M.compose; if (!c) return;
  M.busy = true; render();
  try {
    const d = await api('/mail/draft', { body: { account: M.acc, uid: c.uid || 0, instruction: c.ask || '' }, timeout: 160000 });
    if (M.compose === c) { c.text = d.text; if (!c.subject || !c.uid) c.subject = d.subject || c.subject; if (!c.to && d.to) c.to = d.to; }
    window.toast('پیش‌نویس آماده است؛ بخوانید و اگر خوب بود بفرستید');
  } catch (e) { window.toast(e.message, true); }
  M.busy = false; render();
}
window.addEventListener('jarvis:ev', e => { const d = e.detail || {}; if (d.type === 'mail' && M.el && d.account === M.acc && !M.compose) inbox(false); });
window.openMail = () => window.showSection && window.showSection('mail');

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('mail', { icon: 'mail', label: 'ایمیل و تقویم', enter, leave });
