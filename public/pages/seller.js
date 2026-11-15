// Selling the Android app (seller mode only): signing key, price & payment instructions,
// issuing a license for a buyer's device code, checking a key, and the sales log.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const st = () => window.JARVIS_STATE || {};
const fdate = ms => new Date(ms).toLocaleDateString('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric' });
const copy = async t => { try { await navigator.clipboard.writeText(t); window.toast('کپی شد'); } catch { window.toast('کپی نشد', true); } };

const P = { el: null, d: null, last: null, q: '' };
function enter(host) { P.el = host; load(); }
async function load() { try { P.d = await api('/seller'); } catch (e) { window.toast(e.message, true); return; } render(); }

function buyerMessage(s) {
  const price = s.sellPrice ? `${s.sellPrice} ${s.sellCurrency || ''}`.trim() : '(قیمت را در تنظیمات فروش وارد کنید)';
  return `سلام! برای خرید اپ اندروید جارویس:
۱) مبلغ ${price} را به کارت ${s.sellCard || '(شماره‌ی کارت)'} واریز کنید.
۲) اپ را نصب کنید و «کد دستگاه» را از صفحه‌ی فعال‌سازی کپی کنید.
۳) کد دستگاه و عکس رسید را برای ${s.sellContact || '(راه تماس شما)'} بفرستید.
کلید فعال‌سازی را همان‌جا برایتان می‌فرستم. هر کلید برای یک گوشی است و تا یک سال آپدیت رایگان دارد.${s.sellNote ? '\n' + s.sellNote : ''}`;
}
function keyMessage(r) {
  const online = !!(P.d && P.d.repo) && r.code;
  return online ? `کد فعال‌سازی اپ جارویس شما:
${r.code}

در اپ: صفحه‌ی فعال‌سازی ← این کد را وارد کنید (اینترنت لازم است). فقط روی همین گوشی (${r.device}) کار می‌کند و آپدیت‌ها تا ${fdate(r.updatesUntil)} رایگان است.

اگر کد وصل نشد، این کلید کامل را بچسبانید (بدون اینترنت کار می‌کند):
${r.key}

ممنون از خریدتان!` : `کلید فعال‌سازی اپ جارویس شما:
${r.key}

در اپ: فعال‌سازی ← چسباندن کلید. این کلید فقط روی همین گوشی (${r.device}) کار می‌کند و آپدیت‌ها تا ${fdate(r.updatesUntil)} رایگان است. ممنون از خریدتان!`;
}

function render() {
  const d = P.d, s = st().settings || {};
  const sales = d.sales.filter(x => !P.q || (x.buyer + ' ' + x.contact + ' ' + x.device + ' ' + x.note).toLowerCase().includes(P.q));
  P.el.innerHTML = `<div class="pg sl-page">
    <header class="pg-head"><div><h1>${ic('wallet')}فروش اپ اندروید<span class="hud-tag" aria-hidden="true">LICENSES</span></h1>
      <p class="help">اپ اندروید پولی است و بقیه‌ی جارویس رایگان. پرداخت کارت‌به‌کارت است و کلید را خودتان برای گوشی خریدار می‌سازید؛ اپ بدون اینترنت و سرور آن را بررسی می‌کند.</p></div>
      <div class="ag-stats"><div class="pg-stat"><b>${faN(d.totals.count)}</b><span>لایسنس</span></div><div class="pg-stat"><b>${faN(d.totals.year)}</b><span>یک سال اخیر</span></div><div class="pg-stat"><b>${faN(d.totals.amount)}</b><span>${esc(s.sellCurrency || 'تومان')}</span></div></div></header>

    <div class="sl-grid">
      <section class="sl-card">
        <h2>${ic('key-round', 'sm')}۱. کلید امضای فروش</h2>
        ${d.hasKeys ? `<p class="ok">${ic('circle-check', 'sm')} ساخته شده است.</p>
          <div class="help">کلید عمومی (داخل اپ اندروید قرار می‌گیرد):</div><code class="sl-pub" dir="ltr">${esc(d.publicKey)}</code>
          <div class="row-gap"><button type="button" class="btn btn-sm" id="slBackup">${ic('download', 'sm')}پشتیبان کلیدها</button><button type="button" class="btn btn-sm ghost" id="slRestore">${ic('upload', 'sm')}بازگردانی از پشتیبان</button></div>
          <p class="help sl-warn">${ic('triangle-alert', 'sm')} پشتیبان را جای امن نگه دارید و به هیچ‌کس ندهید. اگر کلید گم شود، دیگر نمی‌توانید برای اپ فعلی لایسنس بسازید.</p>`
        : `<p class="help">یک بار، روی همین کامپیوتر. نیمه‌ی خصوصی فقط اینجا (رمزنگاری‌شده) می‌ماند.</p>
          <div class="row-gap"><button type="button" class="btn btn-primary" id="slGen">${ic('key-round', 'sm')}ساخت کلید امضا</button><button type="button" class="btn btn-sm ghost" id="slRestore">${ic('upload', 'sm')}بازگردانی از پشتیبان</button></div>`}
      </section>

      <section class="sl-card">
        <h2>${ic('wallet', 'sm')}۲. قیمت و روش پرداخت</h2>
        <div class="field-row"><div class="field"><label>قیمت</label><input id="slPrice" dir="auto" value="${esc(s.sellPrice || '')}" placeholder="مثلاً ۴۹۰٬۰۰۰"></div>
          <div class="field" style="flex:0 0 120px"><label>واحد</label><input id="slCur" dir="auto" value="${esc(s.sellCurrency || 'تومان')}"></div></div>
        <div class="field"><label>شماره‌ی کارت (در پیام خرید نشان داده می‌شود)</label><input id="slCard" dir="ltr" value="${esc(s.sellCard || '')}" placeholder="6037 …"></div>
        <div class="field"><label>راه تماس برای فرستادن رسید (تلگرام، واتساپ، ایمیل)</label><input id="slContact" dir="auto" value="${esc(s.sellContact || '')}" placeholder="@my_username"></div>
        <div class="field"><label>توضیح اضافه (اختیاری)</label><input id="slNote" dir="auto" value="${esc(s.sellNote || '')}"></div>
        <div class="help">پیام آماده برای کسی که می‌خواهد بخرد:</div><pre class="sl-msg" id="slBuyMsg" dir="auto">${esc(buyerMessage(s))}</pre>
        <button type="button" class="btn btn-sm" id="slCopyBuy">${ic('copy', 'sm')}کپی پیام خرید</button>
      </section>

      <section class="sl-card sl-issue">
        <h2>${ic('send', 'sm')}۳. ساخت کلید برای خریدار</h2>
        ${d.hasKeys ? `<div class="field"><label>کد دستگاه خریدار</label><input id="slDev" dir="ltr" placeholder="ABCD-EF23-GH45" autocomplete="off" class="sl-dev"></div>
          <div class="field-row"><div class="field"><label>نام خریدار</label><input id="slBuyer" dir="auto"></div><div class="field"><label>راه تماس</label><input id="slBuyerC" dir="auto" placeholder="@username یا شماره"></div></div>
          ${(window.JARVIS_CLUB||{}).required ? `<div class="field"><label>ایمیل عضو باشگاه <span class="help">(اختیاری — لایسنس در حساب خریدار نشان داده می‌شود و اپ خودش فعال می‌شود)</span></label><input id="slMember" type="email" dir="ltr" placeholder="buyer@example.com"></div>` : ""}
          <div class="field-row"><div class="field"><label>مبلغ دریافتی</label><input id="slAmt" type="number" min="0" dir="ltr" value="${esc(String(s.sellPrice || '').replace(/[^\d۰-۹]/g, '').replace(/[۰-۹]/g, x => '۰۱۲۳۴۵۶۷۸۹'.indexOf(x)))}"></div>
            <div class="field"><label>نوع</label><div class="segm" id="slKind"><button type="button" role="radio" aria-checked="true" data-kind="sale">خرید تازه</button><button type="button" role="radio" aria-checked="false" data-kind="transfer">انتقال به گوشی تازه</button></div></div></div>
          <div class="field"><label>یادداشت (مثلاً شماره‌ی رسید)</label><input id="slNoteB" dir="auto"></div>
          <button type="button" class="btn btn-primary" id="slIssue">${ic('key-round', 'sm')}ساخت کلید</button>
          <div id="slOut"></div>` : `<p class="help">اول کلید امضا را بسازید (کارت ۱).</p>`}
      </section>

      <section class="sl-card">
        <h2>${ic('globe', 'sm')}فعال‌سازی آنلاین با کد کوتاه (GitHub)</h2>
        <p class="help">فهرست امضاشده‌ی لایسنس‌ها در یک مخزن <b>عمومی</b> GitHub منتشر می‌شود (فقط هش کدها و کلیدهای بدون نام؛ هیچ اطلاعات خریداری در آن نیست). خریدار فقط یک کد کوتاه مثل <code dir="ltr">JRV-7K2M-Q9XD</code> وارد می‌کند، و شما می‌توانید هر لایسنس را از راه دور لغو کنید. کلید کامل آفلاین هم همیشه کار می‌کند.</p>
        <div class="field"><label>مخزن GitHub</label><input id="slRepo" dir="ltr" value="${esc(d.repo)}" placeholder="username/jarvis-licenses"></div>
        <button type="button" class="btn btn-sm btn-primary" id="slPublish" ${d.hasKeys ? '' : 'disabled'}>${ic('upload', 'sm')}${d.repo ? 'انتشار دوباره' : 'ساخت مخزن و انتشار'}</button>
        ${d.listUrl ? `<div class="help mt">آدرس فهرست (داخل اپ قرار می‌گیرد): <code dir="ltr" class="sl-pub">${esc(d.listUrl)}</code></div>` : ''}
        <div id="slPubOut" class="help"></div>
      </section>

      <section class="sl-card">
        <h2>${ic('shield', 'sm')}بررسی یک کلید</h2>
        <div class="field"><label>کلید</label><textarea id="slVKey" dir="ltr" rows="3" placeholder="JRV1.…"></textarea></div>
        <div class="field"><label>کد دستگاه (اختیاری)</label><input id="slVDev" dir="ltr" placeholder="ABCD-EF23-GH45"></div>
        <button type="button" class="btn btn-sm" id="slVerify">${ic('search', 'sm')}بررسی</button><div id="slVOut" class="help"></div>
      </section>
    </div>

    <div class="tq-bar"><h2 class="pg-sub">فروش‌ها</h2><div class="chat-search">${ic('search', 'sm')}<input id="slSearch" type="search" dir="auto" placeholder="جستجو: نام، تماس، کد دستگاه…" value="${esc(P.q)}"></div></div>
    ${sales.length ? `<div class="sl-table-wrap"><table class="sl-table"><thead><tr><th>تاریخ</th><th>خریدار</th><th>کد فعال‌سازی</th><th>کد دستگاه</th><th>نوع</th><th>مبلغ</th><th>آپدیت تا</th><th></th></tr></thead><tbody>
      ${sales.map(x => `<tr data-id="${esc(x.id)}"><td>${fdate(x.issuedAt)}</td><td><b dir="auto">${esc(x.buyer || '—')}</b><div class="help" dir="auto">${esc(x.contact || '')}</div></td><td>${x.code ? `<code dir="ltr">${esc(x.code)}</code>` : '—'}${x.revoked ? ' <span class="chip hi ag-chip" style="color:var(--color-danger)">لغو شده</span>' : ''}</td><td><code dir="ltr">${esc(x.device)}</code></td>
        <td>${x.kind === 'transfer' ? '<span class="ag-chip">انتقال</span>' : 'خرید'}</td><td>${x.amount ? faN(x.amount) : '—'}</td><td>${fdate(x.updatesUntil)}</td>
        <td class="sl-acts"><button type="button" class="cc-mini" data-revoke="${esc(x.id)}" data-undo="${x.revoked ? 1 : ''}" title="${x.revoked ? 'برگرداندن لایسنس' : 'لغو لایسنس (از راه دور)'}" aria-label="لغو">${ic(x.revoked ? 'rotate-ccw' : 'circle-x', 'sm')}</button><button type="button" class="cc-mini" data-copykey="${esc(x.id)}" title="کپی پیام کلید" aria-label="کپی">${ic('copy', 'sm')}</button><button type="button" class="cc-mini" data-delsale="${esc(x.id)}" title="حذف از فهرست" aria-label="حذف">${ic('trash-2', 'sm')}</button></td></tr>`).join('')}
    </tbody></table></div>` : `<div class="tk-empty">${ic('wallet')}<h3>هنوز فروشی ثبت نشده</h3></div>`}
  </div>`;
  wire();
}

function wire() {
  const r = P.el;
  const saveSetting = async (k, v) => { try { st().settings = await api('/settings', { body: { [k]: v } }); $('#slBuyMsg').textContent = buyerMessage(st().settings); } catch (e) { window.toast(e.message, true); } };
  [['#slPrice', 'sellPrice'], ['#slCur', 'sellCurrency'], ['#slCard', 'sellCard'], ['#slContact', 'sellContact'], ['#slNote', 'sellNote']].forEach(([sel, k]) => { const el = r.querySelector(sel); if (el) el.onchange = () => saveSetting(k, el.value.trim()); });
  const on = (sel, fn) => { const el = r.querySelector(sel); if (el) el.onclick = fn; };
  on('#slCopyBuy', () => copy($('#slBuyMsg').textContent));
  on('#slGen', async () => { try { P.d = await api('/seller/keys', { body: {} }); window.toast('کلید امضا ساخته شد — حتماً پشتیبان بگیرید'); render(); } catch (e) { window.toast(e.message, true); } });
  on('#slBackup', async () => {
    if (!confirm('فایل پشتیبان شامل کلید خصوصی است. آن را جای امن نگه دارید و به هیچ‌کس ندهید. ادامه؟')) return;
    const b = await api('/seller/backup');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' })), download: 'jarvis-seller-keys.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  on('#slRestore', () => {
    window.dialog(`<div class="dlg-scroll"><h3>${ic('upload')}بازگردانی کلید فروش</h3><p class="help">فایل jarvis-seller-keys.json را انتخاب کنید. ${P.d.hasKeys ? '<b class="bad">کلید فعلی جایگزین می‌شود.</b>' : ''}</p><input type="file" id="rsFile" accept=".json"></div>
      <div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`);
    $('#rsFile').onchange = async e => { try { const j = JSON.parse(await e.target.files[0].text()); P.d = await api('/seller/restore', { body: j }); $('#dlg').close(); window.toast('کلید بازگردانده شد'); render(); } catch (err) { window.toast(err.message, true); } };
  });
  const kindBox = r.querySelector('#slKind'); let kind = 'sale';
  if (kindBox) kindBox.onclick = e => { const b = e.target.closest('[data-kind]'); if (!b) return; kind = b.dataset.kind; kindBox.querySelectorAll('[data-kind]').forEach(x => x.setAttribute('aria-checked', String(x === b))); };
  on('#slIssue', async () => {
    try {
      const res = await api('/seller/issue', { body: { device: $('#slDev').value, buyer: $('#slBuyer').value, contact: $('#slBuyerC').value, amount: +$('#slAmt').value || 0, note: $('#slNoteB').value, kind, memberEmail: ($('#slMember') || {}).value || '' } });
      P.last = res;
      const warn = res.previousForContact ? `<div class="va-tip">${ic('triangle-alert', 'sm')} این خریدار در یک سال اخیر ${faN(res.previousForContact)} کلید دیگر هم گرفته است.</div>` : '';
      const pub = res.published ? (res.published.ok ? `<div class="ok">${ic('circle-check', 'sm')} در GitHub منتشر شد؛ کد کوتاه کار می‌کند.</div>` : `<div class="bad">انتشار نشد: ${esc(res.published.error)} — فعلاً کلید کامل را بفرستید.</div>`) : '';
      const mem = res.member ? (res.member.ok ? `<div class="ok">${ic('circle-check', 'sm')} در حساب باشگاه خریدار ثبت شد.</div>` : `<div class="bad">ثبت در باشگاه نشد: ${esc(res.member.error)}</div>`) : '';
      $('#slOut').innerHTML = `<div class="sl-key">${warn}${pub}${mem}<div class="help">کد کوتاه:</div><div class="ph-code" dir="ltr">${esc(res.code)}</div><div class="help">کلید کامل (آفلاین):</div><code dir="ltr">${esc(res.key)}</code>
        <pre class="sl-msg" dir="auto">${esc(keyMessage(res))}</pre><div class="row-gap"><button type="button" class="btn btn-sm btn-primary" id="slCopyMsg">${ic('copy', 'sm')}کپی پیام برای خریدار</button><button type="button" class="btn btn-sm" id="slCopyKey">${ic('copy', 'sm')}فقط کلید</button></div></div>`;
      $('#slCopyMsg').onclick = () => copy(keyMessage(res)); $('#slCopyKey').onclick = () => copy(res.key);
      P.d = await api('/seller'); const out = $('#slOut').innerHTML; render(); $('#slOut').innerHTML = out; $('#slCopyMsg').onclick = () => copy(keyMessage(res)); $('#slCopyKey').onclick = () => copy(res.key);
    } catch (e) { window.toast(e.message, true); }
  });
  on('#slVerify', async () => { try { const v = await api('/seller/verify', { body: { key: $('#slVKey').value, device: $('#slVDev').value.trim() || null } }); $('#slVOut').innerHTML = v.ok ? `<span class="ok">${ic('circle-check', 'sm')} معتبر — دستگاه <code dir="ltr">${esc(v.payload.d)}</code>، ${esc(v.payload.b || 'بدون نام')}، آپدیت تا ${fdate(v.payload.u * 864e5)}</span>` : `<span class="bad">${ic('circle-x', 'sm')} ${esc(v.message)}</span>`; } catch (e) { window.toast(e.message, true); } });
  const se = r.querySelector('#slSearch'); if (se) se.oninput = () => { P.q = se.value.trim().toLowerCase(); clearTimeout(P._t); P._t = setTimeout(() => { render(); const s2 = $('#slSearch'); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }, 200); };
  r.querySelectorAll('[data-copykey]').forEach(b => b.onclick = () => { const x = P.d.sales.find(y => y.id === b.dataset.copykey); if (x) copy(keyMessage(x)); });
  on('#slPublish', async () => {
    const b = $('#slPublish'); b.disabled = true; $('#slPubOut').textContent = 'در حال انتشار…';
    try { const r2 = await api('/seller/publish', { body: { repo: $('#slRepo').value } }); P.d = r2.view; render(); $('#slPubOut').innerHTML = `<span class="ok">${ic('circle-check', 'sm')} منتشر شد: ${faN(r2.count)} لایسنس، ${faN(r2.revoked)} لغوشده</span>`; }
    catch (e) { $('#slPubOut').innerHTML = `<span class="bad">${esc(e.message)}</span>`; b.disabled = false; }
  });
  r.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
    const undo = !!b.dataset.undo;
    if (!undo && !confirm('این لایسنس لغو شود؟ اپ آن گوشی دفعه‌ی بعد که به اینترنت وصل شود غیرفعال می‌شود (اگر فهرست در GitHub منتشر شده باشد).')) return;
    try { const r2 = await api('/seller/revoke/' + b.dataset.revoke, { body: { undo } }); P.d = r2.view; render(); if (r2.published && !r2.published.ok) window.toast('انتشار نشد: ' + r2.published.error, true); else window.toast(undo ? 'برگردانده شد' : 'لغو شد'); }
    catch (e) { window.toast(e.message, true); }
  });
  r.querySelectorAll('[data-delsale]').forEach(b => b.onclick = async () => { if (!confirm('این ردیف از فهرست حذف شود؟ (کلیدی که فرستاده‌اید همچنان کار می‌کند)')) return; P.d = await api('/seller/sales/' + b.dataset.delsale, { method: 'DELETE' }); render(); });
}

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('seller', { icon: 'wallet', label: 'فروش اپ اندروید', end: true, when: () => !!((window.JARVIS_STATE || {}).settings || {}).sellerMode, enter, leave() {} });
