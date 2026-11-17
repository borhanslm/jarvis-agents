// SMS of the paired phone on the computer: conversations, read, and write. Sending always goes through
// the phone, which asks you to confirm there. The messages live only in memory on this computer.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const when = ms => {
  if (!ms) return '';
  const d = new Date(ms), now = new Date(), s = (Date.now() - ms) / 1000;
  if (s < 90) return 'همین الان';
  if (s < 3600) return faN(Math.round(s / 60)) + ' دقیقه پیش';
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
};
// a letter for named senders (بانک ملت → ب), a phone icon for plain numbers
const avatar = from => { const l = String(from || '').replace(/[^\p{L}]/gu, '')[0]; return `<span class="sms-av" aria-hidden="true">${l ? esc(l.toUpperCase()) : ic('smartphone', 'sm')}</span>`; };
const codeIn = t => { const m = /(?:^|\D)(\d{4,8})(?!\d)/.exec(String(t || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))); return m ? m[1] : null; };

const S = { el: null, data: null, sel: null, q: '', waiting: false, sending: new Map(), newTo: false };

function enter(host) { S.el = host; load(true); }
function leave() { S.el = null; }
async function load(ask) {
  try { S.data = await api('/voice/phone-data'); } catch (e) { S.data = { error: e.message }; }
  if (ask && S.data.paired && (!S.data.smsAt || Date.now() - S.data.smsAt > 60000)) refresh(true);
  render();
}
async function refresh(silent) {
  try { await api('/voice/phone-sync', { body: {} }); S.waiting = true; if (!silent) render(); clearTimeout(S.wt); S.wt = setTimeout(() => { S.waiting = false; render(); }, 25000); }
  catch (e) { if (!silent) window.toast(e.message, true); }
}

function render() {
  if (!S.el) return;
  const d = S.data || {};
  if (d.error) { S.el.innerHTML = `<div class="pg"><p class="bad">${esc(d.error)}</p></div>`; return; }
  const head = `<header class="pg-head"><div><h1>${ic('message-square')}پیامک<span class="hud-tag" aria-hidden="true">SMS LINK</span></h1>
    <p class="help">پیامک‌های گوشی جفت‌شده، روی کامپیوتر. فرستادن همیشه از خود گوشی است و گوشی اول از شما تأیید می‌گیرد.</p></div>
    ${d.paired ? `<div class="sms-actions"><span class="help" aria-live="polite">${S.waiting ? 'در حال گرفتن از گوشی…' : d.smsAt ? 'به‌روز: ' + when(d.smsAt) : ''}</span>
      <button type="button" class="btn" id="smsRefresh" ${S.waiting ? 'disabled' : ''}>${ic('refresh-cw', 'sm')}به‌روزرسانی</button>
      <button type="button" class="btn btn-primary" id="smsNew">${ic('plus', 'sm')}پیامک تازه</button></div>` : ''}</header>`;
  if (!d.paired) {
    S.el.innerHTML = `<div class="pg">${head}<div class="tk-empty">${ic('smartphone')}<h3>گوشی جفت نشده</h3>
      <p class="help">اپ اندروید جارویس را با QR به این کامپیوتر وصل کنید. بعد در اپ، دسترسی «پیامک» را در «بیشتر ← دسترسی‌های گوشی» روشن کنید.</p>
      <button type="button" class="btn btn-primary" id="smsPair">${ic('smartphone', 'sm')}رفتن به «گوشی»</button></div></div>`;
    $('#smsPair', S.el).onclick = () => window.showSection && window.showSection('phone');
    return;
  }
  const all = d.threads || [];
  const q = S.q.trim();
  const list = q ? all.filter(t => (t.from + ' ' + t.messages.map(m => m.body).join(' ')).includes(q)) : all;
  if (!S.newTo && S.sel && !all.some(t => t.key === S.sel)) S.sel = null;
  if (!S.newTo && !S.sel && list[0] && matchMedia('(min-width: 900px)').matches) S.sel = list[0].key;
  const cur = all.find(t => t.key === S.sel);
  S.el.innerHTML = `<div class="pg sms-page">${head}
    <div class="sms-grid ${cur || S.newTo ? 'has-sel' : ''}">
      <aside class="sms-list" aria-label="گفتگوها">
        <div class="sms-search">${ic('search', 'sm')}<input id="smsQ" type="search" placeholder="جستجو در پیامک‌ها" value="${esc(S.q)}" aria-label="جستجو در پیامک‌ها"></div>
        ${d.threads == null ? `<div class="sms-empty">${S.waiting ? `<div class="sms-skel"></div><div class="sms-skel"></div><div class="sms-skel"></div><p class="help">اپ جارویس روی گوشی باید باز یا در پس‌زمینه وصل باشد.</p>` : `<p class="help">هنوز چیزی از گوشی نیامده. «به‌روزرسانی» را بزنید و اپ جارویس را روی گوشی باز کنید.</p>`}</div>`
          : list.length ? `<ul role="list">${list.map(t => { const code = !t.last.out && Date.now() - t.last.date < 30 * 6e4 && codeIn(t.last.body);
            return `<li><button type="button" class="sms-th ${t.key === S.sel && !S.newTo ? 'on' : ''}" data-th="${esc(t.key)}">${avatar(t.from)}
              <span class="sms-th-b"><b dir="auto">${esc(t.from)}</b><span dir="auto" class="help">${t.last.out ? 'شما: ' : ''}${esc(t.last.body.slice(0, 70))}</span></span>
              <span class="sms-th-t">${esc(when(t.last.date))}${code ? `<span class="sms-code" dir="ltr">${esc(code)}</span>` : ''}</span></button></li>`; }).join('')}</ul>`
          : `<p class="help sms-empty">${q ? 'چیزی پیدا نشد.' : 'پیامکی نیست.'}</p>`}
      </aside>
      <section class="sms-conv" aria-label="گفتگو">
        ${S.newTo ? `<header class="sms-conv-h"><button type="button" class="icon-btn sms-back" data-back aria-label="برگشت">${ic('chevron-right')}</button><div class="field sms-to"><label for="smsTo">به</label><input id="smsTo" dir="auto" placeholder="نام مخاطب یا شماره (مثل ۰۹۱۲…)" autocomplete="off"></div></header><div class="sms-msgs"><p class="help sms-hint">نام مخاطبِ ذخیره‌شده در گوشی یا شماره را بنویسید. گوشی قبل از فرستادن از شما می‌پرسد.</p></div>`
          : cur ? `<header class="sms-conv-h"><button type="button" class="icon-btn sms-back" data-back aria-label="برگشت">${ic('chevron-right')}</button>${avatar(cur.from)}<b dir="auto">${esc(cur.from)}</b></header>
            <div class="sms-msgs" id="smsMsgs">${cur.messages.map(m => { const code = !m.out && codeIn(m.body); return `<div class="sms-msg ${m.out ? 'out' : 'in'}"><p dir="auto">${esc(m.body)}</p><span class="help">${esc(when(m.date))}${code ? ` · <button type="button" class="link" data-copy="${esc(code)}">کپی کد ${esc(code)}</button>` : ''}</span></div>`; }).join('')}
              ${[...S.sending.values()].filter(x => x.key === cur.key).map(x => `<div class="sms-msg out pending"><p dir="auto">${esc(x.text)}</p><span class="help">${x.error ? `<span class="bad">${esc(x.error)}</span>` : 'منتظر تأیید شما روی گوشی…'}</span></div>`).join('')}</div>`
          : `<div class="sms-none">${ic('messages-square')}<p class="help">یک گفتگو را انتخاب کنید.</p></div>`}
        ${cur || S.newTo ? `<form class="sms-compose" id="smsForm"><textarea id="smsText" dir="auto" rows="1" maxlength="1000" placeholder="پیامک…" aria-label="متن پیامک"></textarea><button class="btn btn-primary" aria-label="فرستادن از گوشی">${ic('send', 'sm')}<span>فرستادن</span></button></form>` : ''}
      </section>
    </div></div>`;
  const msgs = $('#smsMsgs', S.el); if (msgs) msgs.scrollTop = msgs.scrollHeight;
  const rb = $('#smsRefresh', S.el); if (rb) rb.onclick = () => refresh();
  $('#smsNew', S.el).onclick = () => { S.newTo = true; S.sel = null; render(); setTimeout(() => { const t = $('#smsTo', S.el); if (t) t.focus(); }); };
  const qi = $('#smsQ', S.el); qi.oninput = () => { S.q = qi.value; clearTimeout(S.qt); S.qt = setTimeout(() => { render(); const n = $('#smsQ', S.el); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 200); };
  S.el.querySelectorAll('[data-th]').forEach(b => b.onclick = () => { S.sel = b.dataset.th; S.newTo = false; render(); });
  S.el.querySelectorAll('[data-back]').forEach(b => b.onclick = () => { S.sel = null; S.newTo = false; render(); });
  S.el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); window.toast('کد کپی شد'); } catch {} });
  const ta = $('#smsText', S.el);
  if (ta) {
    ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; };
    ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#smsForm', S.el).requestSubmit(); } };
    $('#smsForm', S.el).onsubmit = async e => {
      e.preventDefault();
      const text = ta.value.trim(); const to = S.newTo ? ($('#smsTo', S.el).value || '').trim() : cur.from;
      if (!to) return window.toast('گیرنده را بنویسید', true);
      if (!text) return;
      try {
        const r = await api('/voice/phone-sms', { body: { to, text } });
        S.sending.set(r.id, { key: S.newTo ? null : cur.key, to, text });
        if (S.newTo) window.toast('روی گوشی تأیید کنید تا فرستاده شود');
        ta.value = ''; render();
      } catch (x) { window.toast(x.message, true); }
    };
  }
}

window.addEventListener('jarvis:ev', e => {
  const ev = e.detail || {};
  if (ev.type === 'phoneData' && ev.what === 'sms') {
    S.waiting = false; clearTimeout(S.wt);
    if (ev.error && S.el) window.toast('گوشی: ' + ev.error, true);
    if (S.el) load(false);
  }
  if (ev.type === 'phoneResult' && S.sending.has(ev.id)) {
    const x = S.sending.get(ev.id);
    if (ev.ok) { S.sending.delete(ev.id); window.toast(/نفرستادم/.test(ev.say) ? 'پیامک فرستاده نشد (روی گوشی لغو شد)' : 'پیامک به ' + x.to + ' فرستاده شد'); }
    else x.error = ev.say;
    render();
  }
});

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('sms', { icon: 'message-square', label: 'پیامک', enter, leave });
