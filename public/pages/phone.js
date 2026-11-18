// Phone: turn the gateway for the Android app on/off, pair a phone with a QR code, see and revoke
// paired phones, and how to reach JARVIS from outside home (Tailscale) — no server needed.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? 'همین الان' : s < 3600 ? faN(Math.round(s / 60)) + ' دقیقه پیش' : s < 86400 ? faN(Math.round(s / 3600)) + ' ساعت پیش' : new Date(ms).toLocaleDateString('fa-IR'); };

const P = { el: null, st: null, pair: null, timer: null };
function enter(host) { P.el = host; load(); }
function leave() { clearInterval(P.timer); }
async function load() { try { P.st = await api('/mobile/status'); } catch (e) { window.toast(e.message, true); return; } render(); }

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '';
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push(`M${c + 4},${r + 4}h1v1h-1z`);
  return `<svg class="ph-qr" viewBox="0 0 ${n + 8} ${n + 8}" role="img" aria-label="QR جفت‌سازی"><rect width="100%" height="100%" fill="#fff"/><path d="${cells.join('')}" fill="#000"/></svg>`;
}

// «دانلود اپ»: the APK from the public download repo (QR to scan with the phone's camera)
function dlCard(a) {
  if (!a) return '';
  return `<section class="sl-card ph-dl"><h2>${ic('download', 'sm')}دانلود اپ اندروید</h2>
    <div class="ph-qr-wrap">${qrSvg(a.apk).replace('QR جفت‌سازی', 'QR دانلود اپ')}<div>
      <p class="help">با دوربین گوشی این QR را اسکن کنید تا فایل نصب (APK) دانلود شود، یا لینک را روی گوشی باز کنید. اگر اندروید پرسید، «نصب از منابع ناشناخته» را اجازه دهید.</p>
      <div class="row-gap"><a class="btn btn-primary" href="${esc(a.apk)}" target="_blank" rel="noopener">${ic('download', 'sm')}دانلود APK</a>
        <a class="btn" href="${esc(a.repo)}" target="_blank" rel="noopener">${ic('external-link', 'sm')}صفحه‌ی اپ در GitHub</a>
        <button type="button" class="btn ghost" id="phDlCopy">${ic('copy', 'sm')}کپی لینک</button></div>
      <p class="help ph-dl-note">${ic('key-round', 'sm')} دانلود رایگان است؛ استفاده از اپ لایسنس می‌خواهد (هر لایسنس برای یک گوشی، با یک سال آپدیت). خرید از داخل خود اپ، صفحه‌ی فعال‌سازی.</p>
    </div></div></section>`;
}
function render() {
  const s = P.st, on = s.on;
  P.el.innerHTML = `<div class="pg ph-page">
    <header class="pg-head"><div><h1>${ic('smartphone')}گوشی<span class="hud-tag" aria-hidden="true">MOBILE LINK</span></h1>
      <p class="help">اپ اندروید جارویس از این‌جا به کامپیوترتان وصل می‌شود: مرکز فرمان، چت، تسک‌ها و صدا روی گوشی. سرور لازم نیست.</p></div>
      <label class="set-tile ph-switch ${on ? 'on' : ''}"><span class="set-tile-ic">${ic('wifi')}</span><b>اتصال گوشی</b><span class="help">${on ? 'روشن · پورت ' + faN(s.port) : 'خاموش'}</span>
        <span class="switch big"><input type="checkbox" id="phOn" ${on ? 'checked' : ''} aria-label="اتصال گوشی"><span></span></span></label></header>
    ${dlCard(s.android)}
    ${!on ? `<div class="tk-empty">${ic('smartphone')}<h3>اتصال گوشی خاموش است</h3><p class="help">روشنش کنید تا گوشی‌هایی که با QR جفت می‌کنید بتوانند وصل شوند. فقط گوشی‌های جفت‌شده دسترسی دارند و تنظیمات، کلیدها و فروش هرگز از گوشی در دسترس نیستند.<br>ویندوز یک بار اجازه‌ی شبکه می‌پرسد: «شبکه‌ی خصوصی» را تأیید کنید.</p></div>` : `
    <div class="sl-grid">
      <section class="sl-card ph-pair">
        <h2>${ic('plus', 'sm')}جفت کردن گوشی تازه</h2>
        ${P.pair && P.pair.expires > Date.now() ? `<div class="ph-qr-wrap">${qrSvg(P.pair.qr)}<div><div class="help">در اپ: «اسکن QR» — یا دستی وارد کنید:</div>
            <div class="ph-code" dir="ltr">${esc(P.pair.code.replace(/(\d{4})(\d{4})/, '$1 $2'))}</div>
            <div class="help">آدرس کامپیوتر: <code dir="ltr">${esc((P.pair.hosts[0] || '?') + ':' + P.pair.port)}</code>${P.pair.hosts.length > 1 ? ` <span class="help">(یا ${P.pair.hosts.slice(1).map(h => `<code dir="ltr">${esc(h)}</code>`).join('، ')})</span>` : ''}</div>
            <div class="help" id="phLeft"></div></div></div>`
          : `<p class="help">یک کد یک‌بارمصرف (۵ دقیقه) و QR ساخته می‌شود. گوشی باید روی همان وای‌فای باشد (یا Tailscale).</p><button type="button" class="btn btn-primary" id="phPair">${ic('smartphone', 'sm')}جفت کردن گوشی</button>`}
      </section>
      <section class="sl-card">
        <h2>${ic('globe', 'sm')}بیرون از خانه (رایگان، بدون سرور)</h2>
        <ol class="help ph-steps"><li>برنامه‌ی رایگان <b>Tailscale</b> را روی همین کامپیوتر و روی گوشی نصب کنید و با یک حساب وارد شوید: <a href="https://tailscale.com/download" target="_blank" rel="noopener" dir="ltr">tailscale.com/download</a></li>
          <li>در اپ جارویس، آدرس Tailscale کامپیوتر (مثل <code dir="ltr">100.x.y.z</code>) را به‌جای آدرس خانه وارد کنید.</li>
          <li>ارتباط رمزنگاری‌شده و خصوصی است؛ هیچ پورتی روی اینترنت باز نمی‌شود.</li></ol>
        ${s.hosts.some(h => /^100\./.test(h)) ? `<p class="ok">${ic('circle-check', 'sm')} Tailscale روی این کامپیوتر فعال است: <code dir="ltr">${esc(s.hosts.find(h => /^100\./.test(h)))}</code></p>` : ''}
      </section>
    </div>
    <h2 class="pg-sub">گوشی‌های جفت‌شده (${faN(s.devices.length)})</h2>
    ${s.devices.length ? `<div class="ph-devs">${s.devices.map(d => `<div class="ph-dev"><span class="ag-ic">${ic('smartphone')}</span><div><b dir="auto">${esc(d.name)}</b><span class="help">${d.deviceCode ? `<code dir="ltr">${esc(d.deviceCode)}</code> · ` : ''}جفت شده ${esc(ago(d.createdAt))} · آخرین اتصال ${esc(ago(d.lastSeen))}</span></div>
      <button type="button" class="btn btn-sm ghost danger" data-revoke="${esc(d.id)}">${ic('x', 'sm')}لغو دسترسی</button></div>`).join('')}</div>` : '<p class="help">هنوز گوشی‌ای جفت نشده.</p>'}`}
  </div>`;
  const sw = $('#phOn'); sw.onchange = async () => { try { P.st = await api('/mobile/enable', { body: { on: sw.checked } }); P.pair = null; render(); } catch (e) { window.toast(e.message, true); } };
  const dc = $('#phDlCopy'); if (dc) dc.onclick = async () => { try { await navigator.clipboard.writeText(P.st.android.apk); window.toast('لینک دانلود کپی شد'); } catch { window.toast('کپی نشد', true); } };
  const pb = $('#phPair'); if (pb) pb.onclick = async () => { try { P.pair = await api('/mobile/pair', { body: {} }); render(); } catch (e) { window.toast(e.message, true); } };
  P.el.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { if (!confirm('دسترسی این گوشی قطع شود؟ برای استفاده‌ی دوباره باید دوباره جفت شود.')) return; P.st = await api('/mobile/devices/' + b.dataset.revoke, { method: 'DELETE' }); render(); });
  clearInterval(P.timer);
  if (P.pair) P.timer = setInterval(() => { const l = $('#phLeft'); if (!l) return; const left = Math.round((P.pair.expires - Date.now()) / 1000); if (left <= 0) { P.pair = null; render(); } else l.textContent = 'اعتبار کد: ' + faN(Math.floor(left / 60)) + ':' + String(left % 60).padStart(2, '0').replace(/\d/g, x => '۰۱۲۳۴۵۶۷۸۹'[x]); }, 1000);
}
window.addEventListener('jarvis:ev', e => { const ev = e.detail; if (ev && ev.type === 'mobile' && P.el && P.el.classList.contains('on')) { const hadPair = P.pair; P.st = ev.mobile; if (hadPair && !ev.mobile.pairing) { P.pair = null; window.toast('گوشی جفت شد'); } render(); } });

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('phone', { icon: 'smartphone', label: 'گوشی', enter, leave });
