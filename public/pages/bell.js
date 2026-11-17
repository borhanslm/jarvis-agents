// The bell in the top bar: a small list of what happened (reminders, finished jobs, purchase requests,
// phone results, new SMS) and the phone's own notifications. A click goes to the related section.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const ago = ms => { if (!ms) return ''; const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? 'همین الان' : s < 3600 ? faN(Math.round(s / 60)) + ' دقیقه پیش' : s < 86400 ? faN(Math.round(s / 3600)) + ' ساعت پیش' : new Date(ms).toLocaleDateString('fa-IR'); };
const KIND = { reminder: ['clock', 'یادآوری'], job: ['code', 'کار ایجنت‌ها'], sale: ['wallet', 'فروش'], phone: ['smartphone', 'گوشی'], sms: ['message-square', 'پیامک'], mail: ['mail', 'ایمیل'], calendar: ['calendar', 'تقویم'], notification: ['bell', 'اعلان'], system: ['info', 'جارویس'] };

const B = { open: false, tab: 'jarvis', list: [], unread: 0, phone: null };

function mount() {
  const anchor = document.getElementById('btnFull');
  if (!anchor || document.getElementById('btnBell')) return;
  anchor.insertAdjacentHTML('beforebegin', `<div class="bell-wrap"><button class="icon-btn" id="btnBell" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="اعلان‌ها" title="اعلان‌ها">${ic('bell')}<span class="bell-n" id="bellN" hidden></span></button>
    <div class="bell-pop" id="bellPop" role="dialog" aria-label="اعلان‌ها" hidden></div></div>`);
  $('#btnBell').onclick = () => (B.open ? close() : open());
  document.addEventListener('pointerdown', e => { if (B.open && !e.target.closest('.bell-wrap')) close(); });
  document.addEventListener('keydown', e => { if (B.open && e.key === 'Escape') { close(); $('#btnBell').focus(); } });
  load();
}
async function load() {
  try { const r = await api('/notices'); B.list = r.notices; B.unread = r.unread; } catch { return; }
  badge(); if (B.open) draw();
}
function badge() {
  const n = $('#bellN'); if (!n) return;
  n.hidden = !B.unread; n.textContent = B.unread > 99 ? '۹۹+' : faN(B.unread);
  $('#btnBell').setAttribute('aria-label', B.unread ? `اعلان‌ها (${faN(B.unread)} تازه)` : 'اعلان‌ها');
}
async function open() {
  B.open = true; $('#bellPop').hidden = false; $('#btnBell').setAttribute('aria-expanded', 'true');
  draw(); load();
  try { B.phone = await api('/voice/phone-data'); if (B.tab === 'phone') draw(); } catch {}
}
function close() { B.open = false; const p = $('#bellPop'); if (p) p.hidden = true; const b = $('#btnBell'); if (b) b.setAttribute('aria-expanded', 'false'); }

function draw() {
  const pop = $('#bellPop'); if (!pop) return;
  const ph = B.phone || {}, pn = ph.notifications || [];
  pop.innerHTML = `<header><h2>${ic('bell', 'sm')}اعلان‌ها</h2>${B.tab === 'jarvis' && B.unread ? `<button type="button" class="link" id="bellAll">همه خوانده شد</button>` : ''}</header>
    <nav class="bell-tabs" role="tablist"><button type="button" role="tab" aria-selected="${B.tab === 'jarvis'}" data-bt="jarvis">جارویس${B.unread ? ` <span class="bell-chip">${faN(B.unread)}</span>` : ''}</button><button type="button" role="tab" aria-selected="${B.tab === 'phone'}" data-bt="phone">گوشی</button></nav>
    <div class="bell-list">${B.tab === 'jarvis'
      ? (B.list.length ? B.list.slice(0, 40).map(n => { const k = KIND[n.kind] || KIND.system; return `<button type="button" class="bell-item ${n.read ? '' : 'new'}" data-id="${esc(n.id)}" data-sec="${esc(n.section || '')}">
          <span class="bell-ic k-${esc(n.kind)}">${ic(k[0], 'sm')}</span><span class="bell-b"><b dir="auto">${esc(n.title)}</b>${n.body ? `<span dir="auto">${esc(n.body)}</span>` : ''}<small>${esc(k[1])} · ${esc(ago(n.at))}</small></span></button>`; }).join('')
        : `<p class="help bell-empty">${ic('bell')}خبر تازه‌ای نیست.</p>`)
      : !ph.paired ? `<p class="help bell-empty">${ic('smartphone')}گوشی جفت نشده.</p>`
      : pn.length ? pn.slice(0, 30).map(n => `<div class="bell-item"><span class="bell-ic">${ic('smartphone', 'sm')}</span><span class="bell-b"><b dir="auto">${esc(n.app)}${n.title ? ' — ' + esc(n.title) : ''}</b>${n.text ? `<span dir="auto">${esc(n.text)}</span>` : ''}${n.at ? `<small>${esc(ago(n.at))}</small>` : ''}</span></div>`).join('')
        + `<p class="help bell-foot">به‌روز: ${esc(ago(ph.notificationsAt))}</p>`
      : `<p class="help bell-empty">${ic('smartphone')}${ph.notifications ? 'اعلانی روی گوشی نیست.' : 'هنوز چیزی از گوشی نیامده (اپ جارویس باید وصل باشد و دسترسی «اعلان‌ها» روشن).'}</p>`}</div>
    <footer>${B.tab === 'jarvis' ? (B.list.length ? `<button type="button" class="link" id="bellClear">پاک کردن همه</button>` : '') : ph.paired ? `<button type="button" class="link" id="bellSync">${ic('refresh-cw', 'sm')}به‌روزرسانی از گوشی</button>` : ''}<button type="button" class="link" id="bellSms">${ic('message-square', 'sm')}پیامک‌ها</button></footer>`;
  pop.querySelectorAll('[data-bt]').forEach(b => b.onclick = () => { B.tab = b.dataset.bt; draw(); });
  pop.querySelectorAll('[data-id]').forEach(b => b.onclick = async () => {
    const n = B.list.find(x => x.id === b.dataset.id); if (n && !n.read) { n.read = true; B.unread = Math.max(0, B.unread - 1); badge(); api('/notices/read', { body: { ids: [n.id] } }).catch(() => {}); }
    if (b.dataset.sec && window.showSection) { close(); window.showSection(b.dataset.sec); } else draw();
  });
  const all = $('#bellAll', pop); if (all) all.onclick = async () => { B.list.forEach(n => { n.read = true; }); B.unread = 0; badge(); draw(); api('/notices/read', { body: { ids: 'all' } }).catch(() => {}); };
  const clr = $('#bellClear', pop); if (clr) clr.onclick = async () => { if (!confirm('همه‌ی اعلان‌ها پاک شوند؟')) return; await api('/notices/clear', { body: {} }); B.list = []; B.unread = 0; badge(); draw(); };
  const sy = $('#bellSync', pop); if (sy) sy.onclick = async () => { try { await api('/voice/phone-sync', { body: {} }); sy.disabled = true; sy.textContent = 'در حال گرفتن از گوشی…'; } catch (e) { window.toast(e.message, true); } };
  $('#bellSms', pop).onclick = () => { close(); window.showSection && window.showSection('sms'); };
}

window.addEventListener('jarvis:ev', async e => {
  const ev = e.detail || {};
  if (ev.type === 'notice') {
    B.list.unshift(ev.notice); B.unread = ev.unread; badge(); if (B.open) draw();
    // ring once (a short pulse on the bell) — not for every SMS while the SMS page is open
    const b = $('#btnBell'); if (b) { b.classList.remove('ring'); void b.offsetWidth; b.classList.add('ring'); }
  }
  if (ev.type === 'noticesRead') { B.unread = ev.unread; badge(); }
  if (ev.type === 'phoneData' && ev.what === 'notifications' && B.open) { try { B.phone = await api('/voice/phone-data'); draw(); } catch {} }
});
// the top bar exists once the panel is unlocked
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
window.addEventListener('jarvis:ready', load);
window.jarvisNotices = { load, open };
