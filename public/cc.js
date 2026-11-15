// Command Center: the start screen. A section rail on the side, a live AI core in the middle
// and cards with REAL data only (system, network, weather, world clocks, agents, models, tasks).
import * as THREE from 'three';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const GB = b => faN((b / 1073741824).toFixed(b >= 1073741824 * 100 ? 0 : 1));
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------- section rail ----------
const SECTIONS = [
  { id: 'cc', icon: 'radar', label: 'مرکز فرمان', go: () => show('cc') },
  { id: 'code', icon: 'code', label: 'تیم کدنویسی', go: () => show('code') },
  { id: 'tasks', icon: 'list-checks', label: 'تسک‌ها', go: () => tasksDialog() },
  { id: 'voice', icon: 'mic', label: 'دستیار صوتی', go: () => window.voiceDialog && window.voiceDialog() },
  { id: 'ops', icon: 'activity', label: 'اتاق عملیات', go: () => window.openOps && window.openOps() },
  { id: 'queue', icon: 'clock', label: 'صف کارها', go: () => window.queueDialog && window.queueDialog() },
  { id: 'ext', icon: 'puzzle', label: 'اتصال‌ها و پلاگین‌ها', go: () => window.extDialog && window.extDialog() },
  { id: 'settings', icon: 'settings', label: 'تنظیمات', go: () => $('#btnSettings') && $('#btnSettings').click() },
];

function buildRail() {
  const layout = $('.layout');
  if (!layout || $('#rail')) return;
  const nav = document.createElement('nav');
  nav.id = 'rail'; nav.className = 'rail'; nav.setAttribute('aria-label', 'بخش‌ها');
  nav.innerHTML = SECTIONS.map(s => `<button type="button" class="rail-btn" data-sec="${s.id}" title="${esc(s.label)}" aria-label="${esc(s.label)}">${ic(s.icon)}<span>${esc(s.label)}</span></button>`).join('');
  nav.onclick = e => { const b = e.target.closest('[data-sec]'); if (b) SECTIONS.find(s => s.id === b.dataset.sec).go(); };
  layout.prepend(nav);
  document.body.classList.add('has-rail');
  const view = document.createElement('section');
  view.id = 'ccView'; view.className = 'cc-view'; view.setAttribute('aria-label', 'مرکز فرمان');
  layout.append(view);
}

let current = null;
function show(id) {
  current = id;
  document.body.classList.toggle('cc-on', id === 'cc');
  document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('on', b.dataset.sec === id));
  lsSet('jarvis.view', id);
  if (id === 'cc') { renderShell(); refresh(); startTimers(); core && core.resume(); }
  else { stopTimers(); core && core.pause(); }
}
window.showSection = show;

// ---------- the page ----------
function renderShell() {
  const v = $('#ccView');
  if (v.dataset.built) return;
  v.dataset.built = '1';
  v.innerHTML = `
  <div class="cc-grid">
    <header class="cc-top">
      <div><div class="cc-hello" id="ccHello"></div><div class="cc-date" id="ccDate"></div></div>
      <div class="cc-clock" id="ccClock" dir="ltr"></div>
    </header>

    <section class="cc-card cc-sys" aria-label="وضعیت سیستم"><h3>${ic('cpu', 'sm')}سیستم</h3><div class="cc-gauges" id="ccGauges"></div><div class="cc-sub" id="ccSysSub"></div></section>
    <section class="cc-card cc-net" aria-label="اینترنت"><h3>${ic('wifi', 'sm')}اینترنت</h3><div id="ccNet" class="cc-net-body"></div></section>
    <section class="cc-card cc-weather" aria-label="آب‌وهوا"><h3>${ic('cloud-sun', 'sm')}آب‌وهوا <button type="button" class="cc-mini" id="ccCity" title="انتخاب شهر">${ic('map-pin', 'sm')}</button></h3><div id="ccWeather"></div></section>

    <section class="cc-core" aria-label="هسته‌ی جارویس">
      <div class="cc-orb" id="ccOrb"></div>
      <div class="cc-core-label"><b>JARVIS</b><span id="ccCoreState">در حال خواندن وضعیت…</span></div>
      <button type="button" class="cc-talk" id="ccTalk">${ic('mic')}<span>با جارویس صحبت کنید</span><kbd dir="ltr">Ctrl+Space</kbd></button>
      <form class="cc-cmd" id="ccCmd" autocomplete="off"><input id="ccCmdIn" dir="auto" placeholder="یا بنویسید: «فردا ساعت ۱۰ یادم بنداز…»، «وضعیت ایجنت‌ها؟»"><button class="btn btn-primary" type="submit">${ic('send', 'sm flip-rtl')}</button></form>
      <div class="cc-reply" id="ccReply" dir="auto" hidden></div>
    </section>

    <section class="cc-card cc-agents" aria-label="ایجنت‌های فعال"><h3>${ic('bot', 'sm')}ایجنت‌های فعال <button type="button" class="cc-mini" id="ccOps" title="اتاق عملیات">${ic('radar', 'sm')}</button></h3><div id="ccAgents"></div></section>
    <section class="cc-card cc-llms" aria-label="مدل‌های هوش مصنوعی"><h3>${ic('brain', 'sm')}هسته‌ی هوش مصنوعی</h3><div id="ccLlms" class="cc-llm-list"></div></section>
    <section class="cc-card cc-tasks" aria-label="تسک‌های امروز"><h3>${ic('list-checks', 'sm')}تسک‌های امروز <button type="button" class="cc-mini" id="ccAllTasks" title="همه‌ی تسک‌ها">${ic('maximize-2', 'sm')}</button></h3>
      <div id="ccTasks"></div><form class="cc-addtask" id="ccAddTask" autocomplete="off"><input id="ccTaskIn" dir="auto" placeholder="تسک تازه…"><button class="cc-mini" type="submit" title="افزودن">${ic('plus', 'sm')}</button></form></section>
    <section class="cc-card cc-clocks" aria-label="ساعت جهانی"><h3>${ic('globe', 'sm')}ساعت جهانی <button type="button" class="cc-mini" id="ccEditClocks" title="تغییر شهرها">${ic('pencil', 'sm')}</button></h3><div id="ccClocks" class="cc-clock-list"></div></section>
    <section class="cc-card cc-quick" aria-label="کارهای سریع"><h3>${ic('zap', 'sm')}کارهای سریع</h3><div class="cc-quick-list">
      <button type="button" data-q="code">${ic('code')}<span>کار تازه با تیم</span></button>
      <button type="button" data-q="queue">${ic('clock')}<span>صف کارها</span></button>
      <button type="button" data-q="ext">${ic('puzzle')}<span>اتصال‌ها</span></button>
      <button type="button" data-q="voice">${ic('mic')}<span>تنظیمات صدا</span></button>
      <button type="button" data-q="ops">${ic('radar')}<span>اتاق عملیات</span></button>
      <button type="button" data-q="settings">${ic('settings')}<span>تنظیمات</span></button></div></section>
  </div>`;
  v.querySelector('#ccTalk').onclick = () => window.voiceStart && window.voiceStart(true);
  v.querySelector('#ccOps').onclick = () => window.openOps && window.openOps();
  v.querySelector('#ccCity').onclick = cityDialog;
  v.querySelector('#ccEditClocks').onclick = clocksDialog;
  v.querySelector('#ccAllTasks').onclick = () => tasksDialog();
  v.querySelector('.cc-quick-list').onclick = e => { const b = e.target.closest('[data-q]'); if (!b) return; if (b.dataset.q === 'code') { show('code'); setTimeout(() => { const i = $('#homeInput'); if (i) i.focus(); }, 50); } else SECTIONS.find(s => s.id === b.dataset.q).go(); };
  v.querySelector('#ccAddTask').onsubmit = async e => { e.preventDefault(); const i = $('#ccTaskIn'); const t = i.value.trim(); if (!t) return; i.value = ''; try { await api('/tasks', { body: { title: t } }); refresh(); } catch (err) { window.toast(err.message, true); } };
  v.querySelector('#ccTasks').onclick = async e => { const c = e.target.closest('[data-done]'); if (!c) return; try { await api('/tasks/' + c.dataset.done, { body: { done: true } }); refresh(); } catch (err) { window.toast(err.message, true); } };
  v.querySelector('#ccCmd').onsubmit = async e => {
    e.preventDefault(); const i = $('#ccCmdIn'); const t = i.value.trim(); if (!t) return;
    const out = $('#ccReply'); out.hidden = false; out.textContent = 'در حال فکر کردن…'; i.value = '';
    try { const r = await api('/voice/ask', { body: { text: t } }); out.textContent = r.say || (r.result && r.result.ok ? 'انجام شد.' : '');
      if (r.result && r.result.open && window.voiceOpen) window.voiceOpen(r.result.open);
      if (r.confirm) out.innerHTML = esc(r.say) + ` <button type="button" class="btn btn-sm btn-primary" data-yes="1">بله</button> <button type="button" class="btn btn-sm" data-yes="0">نه</button>`;
      refresh();
    } catch (err) { out.textContent = err.message; }
  };
  v.querySelector('#ccReply').onclick = async e => { const b = e.target.closest('[data-yes]'); if (!b) return; try { await api('/voice/confirm', { body: { yes: b.dataset.yes === '1' } }); $('#ccReply').textContent = b.dataset.yes === '1' ? 'انجام شد.' : 'لغو شد.'; refresh(); } catch (err) { window.toast(err.message, true); } };
  core = makeCore($('#ccOrb'));
}

// ---------- live data ----------
let last = null;
async function refresh() {
  if (current !== 'cc') return;
  let d; try { d = await api('/cc'); } catch { return; }
  last = d; render(d);
}
function gauge(label, pct, sub) {
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const r = 30, c = 2 * Math.PI * r, warn = p >= 90 ? 'bad' : p >= 75 ? 'warn' : '';
  return `<div class="cc-gauge ${warn}"><svg viewBox="0 0 76 76" aria-hidden="true"><circle class="g-bg" cx="38" cy="38" r="${r}"/><circle class="g-fg" cx="38" cy="38" r="${r}" stroke-dasharray="${(c * p / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 38 38)"/></svg>
    <div class="g-val">${pct == null ? '—' : faN(Math.round(p)) + '٪'}</div><div class="g-lbl">${label}</div><div class="g-sub" dir="auto">${sub || ''}</div></div>`;
}
function render(d) {
  const s = d.system;
  $('#ccGauges').innerHTML = gauge('پردازنده', s.cpu.percent, faN(s.cpu.cores) + ' هسته')
    + gauge('حافظه', s.mem.used / s.mem.total * 100, GB(s.mem.used) + ' از ' + GB(s.mem.total) + ' گیگ')
    + (s.disk ? gauge('دیسک ' + s.disk.root.replace(/\\$/, ''), s.disk.used / s.disk.total * 100, GB(s.disk.free) + ' گیگ آزاد') : gauge('دیسک', null, 'خوانده نشد'));
  const up = s.uptimeSec, h = Math.floor(up / 3600);
  $('#ccSysSub').textContent = 'روشن از ' + (h >= 24 ? faN(Math.floor(h / 24)) + ' روز و ' + faN(h % 24) + ' ساعت' : faN(h) + ' ساعت و ' + faN(Math.floor(up % 3600 / 60)) + ' دقیقه') + ' پیش';

  const n = d.net;
  $('#ccNet').innerHTML = n.online
    ? `<div class="cc-big ok">${ic('circle-check')}وصل</div><div class="cc-sub">${n.latency != null ? 'تأخیر: <b>' + faN(n.latency) + '</b> میلی‌ثانیه' + (n.latency > 400 ? ' — کند' : n.latency > 150 ? ' — معمولی' : ' — خوب') : ''}</div>`
    : `<div class="cc-big bad">${ic('wifi-off')}قطع</div><div class="cc-sub">دستیار با اجزای آفلاین کار می‌کند${d.voice.mode === 'online' ? ' (حالت «همیشه آنلاین» انتخاب شده)' : ''}.</div>`;

  const w = d.weather;
  $('#ccWeather').innerHTML = !d.place ? `<div class="cc-empty">شهر را انتخاب کنید <button type="button" class="btn btn-sm" id="ccCity2">${ic('map-pin', 'sm')}انتخاب شهر</button></div>`
    : !w || w.error ? `<div class="cc-empty">${esc(d.place.name)}: ${esc(w ? w.error : 'اینترنت نیست')}</div>`
    : `<div class="cc-wnow"><span class="cc-temp">${faN(Math.round(w.now.temp))}°</span><div><b>${esc(d.place.name)}</b><div class="cc-sub">${esc(w.now.text)} · احساس ${faN(Math.round(w.now.feels))}° · رطوبت ${faN(w.now.humidity)}٪ · باد ${faN(Math.round(w.now.wind))} km/h</div></div></div>
      <div class="cc-days">${w.days.slice(1, 4).map(x => `<div><span>${new Date(x.date + 'T12:00').toLocaleDateString('fa-IR', { weekday: 'short' })}</span><b>${faN(Math.round(x.max))}° / ${faN(Math.round(x.min))}°</b><span class="cc-sub">${esc(x.text)}</span></div>`).join('')}</div>
      ${w.stale ? '<div class="cc-sub">آخرین داده‌ی دریافت‌شده (الان اینترنت نیست)</div>' : ''}`;
  const c2 = $('#ccCity2'); if (c2) c2.onclick = cityDialog;

  const run = d.agents.running;
  $('#ccAgents').innerHTML = run.length ? `<ul class="cc-list">${run.map(c => `<li><span class="dot live"></span><div><b dir="auto">${esc(c.title)}</b><div class="cc-sub">${esc(c.project)} · ${esc(statusFa(c.status))}</div></div><button type="button" class="cc-mini" data-open="${esc(c.id)}" title="باز کردن">${ic('arrow-up-left', 'sm')}</button></li>`).join('')}</ul>`
    : `<div class="cc-empty">الان هیچ ایجنتی کار نمی‌کند.${d.queue ? ' ' + faN(d.queue) + ' کار در صف است.' : ''}</div>`;
  $('#ccAgents').onclick = e => { const b = e.target.closest('[data-open]'); if (b && window.openChat) { show('code'); window.openChat(b.dataset.open); } };

  $('#ccLlms').innerHTML = d.llms.map(l => `<div class="cc-llm ${l.ok ? 'ok' : ''}"><span class="dot"></span><b dir="auto">${esc(l.name)}</b><span class="cc-sub">${esc(l.note)}</span></div>`).join('');

  $('#ccTasks').innerHTML = d.tasks.length ? `<ul class="cc-list">${d.tasks.map(t => `<li><button type="button" class="cc-check" data-done="${esc(t.id)}" title="انجام شد" aria-label="انجام شد"></button><div><b dir="auto">${esc(t.title)}</b>${t.due ? `<div class="cc-sub ${t.due < Date.now() ? 'bad' : ''}">${new Date(t.due).toLocaleString('fa-IR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>` : ''}</div>${t.priority === 'high' ? '<span class="cc-pri">مهم</span>' : ''}</li>`).join('')}</ul>`
    : '<div class="cc-empty">برای امروز تسکی نیست.</div>';

  const working = run.length > 0;
  $('#ccCoreState').textContent = working ? faN(run.length) + ' کار در حال انجام' : n.online ? 'همه‌ی سیستم‌ها آماده' : 'آفلاین — آماده با اجزای محلی';
  if (core) core.setBusy(working);
  renderClocks(d.clocks);
}
const STATUS_FA = { running: 'در حال کار', building: 'در حال ساخت', reviewing: 'در حال تست', waiting: 'منتظر', fixing: 'در حال رفع' };
const statusFa = s => STATUS_FA[s] || s || '';

// ---------- clocks (client side, every second) ----------
const CITY_FA = { 'Asia/Tehran': 'تهران', 'Europe/London': 'لندن', 'America/New_York': 'نیویورک', 'Asia/Dubai': 'دبی', 'Asia/Tokyo': 'توکیو', 'Europe/Paris': 'پاریس', 'Europe/Berlin': 'برلین', 'Europe/Istanbul': 'استانبول', 'America/Los_Angeles': 'لس‌آنجلس', 'America/Toronto': 'تورنتو', 'Asia/Shanghai': 'پکن', 'Asia/Kolkata': 'دهلی', 'Asia/Singapore': 'سنگاپور', 'Australia/Sydney': 'سیدنی', 'Europe/Moscow': 'مسکو', 'UTC': 'UTC' };
const cityName = z => CITY_FA[z] || z.split('/').pop().replace(/_/g, ' ');
let clockZones = [];
function renderClocks(zones) { if (zones) clockZones = zones; tick(); }
function tick() {
  const now = new Date();
  const el = $('#ccClock'); if (!el) return;
  el.textContent = now.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const h = now.getHours();
  $('#ccHello').textContent = h < 5 ? 'شب بخیر' : h < 12 ? 'صبح بخیر' : h < 17 ? 'عصر بخیر' : 'شب بخیر';
  $('#ccDate').textContent = now.toLocaleDateString('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · ' + now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const box = $('#ccClocks'); if (!box) return;
  box.innerHTML = clockZones.map(z => {
    let t = '—', diff = '';
    try { t = now.toLocaleTimeString('fa-IR', { timeZone: z, hour: '2-digit', minute: '2-digit' }); const hz = +now.toLocaleString('en-US', { timeZone: z, hour: 'numeric', hour12: false }) % 24; diff = hz >= 6 && hz < 18 ? 'sun' : 'moon'; } catch {}
    return `<div class="cc-zone"><span>${ic(diff || 'clock', 'sm')}${esc(cityName(z))}</span><b>${t}</b></div>`;
  }).join('');
}

let timers = [];
function startTimers() { stopTimers(); timers = [setInterval(tick, 1000), setInterval(refresh, 10000)]; tick(); }
function stopTimers() { timers.forEach(clearInterval); timers = []; }
window.addEventListener('jarvis:ev', e => { const t = e.detail && e.detail.type; if (current === 'cc' && ['tasks', 'chat', 'agent', 'finished', 'status', 'queue'].includes(t)) { clearTimeout(window.__ccR); window.__ccR = setTimeout(refresh, 600); } });

// ---------- dialogs ----------
// A "form" inside a dialog: Enter in a text field or the [data-go] button runs fn.
function submitLike(box, fn) {
  box.querySelector('[data-go]').addEventListener('click', e => { e.preventDefault(); fn(); });
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox])')) { e.preventDefault(); fn(); } });
}
async function cityDialog() {
  window.dialog(`<div class="dlg-scroll"><h3>${ic('map-pin')}شهر برای آب‌وهوا</h3>
    <p class="help">فقط نام شهری که انتخاب می‌کنید به Open-Meteo (سرویس رایگان آب‌وهوا) فرستاده می‌شود.</p>
    <div id="cityF" class="field-row"><div class="field"><input id="cityQ" dir="auto" placeholder="مثلاً تهران، Mashhad، Berlin"></div><button class="btn" type="button" data-go>${ic('search', 'sm')}جستجو</button></div>
    <ul class="cc-list" id="cityR"></ul></div><div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`);
  const r = $('#cityR');
  submitLike($('#cityF'), async () => { r.innerHTML = '<li class="cc-sub">در حال جستجو…</li>';
    try { const list = await api('/cc/geocode', { body: { q: $('#cityQ').value } });
      r.innerHTML = list.length ? list.map((x, i) => `<li><button type="button" class="btn btn-sm" data-i="${i}">${esc(x.name)}</button><span class="cc-sub">${esc([x.admin, x.country].filter(Boolean).join('، '))}</span></li>`).join('') : '<li class="cc-sub">پیدا نشد</li>';
      r.onclick = async ev => { const b = ev.target.closest('[data-i]'); if (!b) return; const x = list[+b.dataset.i];
        await api('/settings', { body: { ccPlace: JSON.stringify({ name: x.name, country: x.country, lat: x.lat, lon: x.lon }) } }); $('#dlg').close(); refresh(); };
    } catch (err) { r.innerHTML = `<li class="bad">${esc(err.message)}</li>`; } });
  setTimeout(() => $('#cityQ').focus(), 50);
}
function clocksDialog() {
  const all = Object.keys(CITY_FA);
  const sel = new Set(clockZones);
  window.dialog(`<div class="dlg-scroll"><h3>${ic('globe')}ساعت جهانی</h3><p class="help">شهرهایی که می‌خواهید ببینید (حداکثر ۸).</p>
    <div class="cc-zones-pick">${all.map(z => `<label class="check"><input type="checkbox" value="${z}" ${sel.has(z) ? 'checked' : ''}> ${esc(cityName(z))}</label>`).join('')}</div></div>
    <div class="dlg-actions"><button class="btn primary" id="zSave" type="button">ذخیره</button><button class="btn ghost" value="cancel">بستن</button></div>`);
  $('#zSave').onclick = async () => { const z = [...document.querySelectorAll('.cc-zones-pick input:checked')].map(i => i.value).slice(0, 8); await api('/settings', { body: { ccClocks: z } }); clockZones = z; $('#dlg').close(); tick(); };
}
async function tasksDialog() {
  let list; try { list = await api('/tasks'); } catch (e) { window.toast(e.message, true); return; }
  const open = list.filter(t => !t.done), done = list.filter(t => t.done).slice(-20).reverse();
  const row = t => `<li class="${t.done ? 'done' : ''}"><button type="button" class="cc-check ${t.done ? 'on' : ''}" data-t="${esc(t.id)}" aria-label="${t.done ? 'برگرداندن' : 'انجام شد'}"></button>
    <div><b dir="auto">${esc(t.title)}</b><div class="cc-sub">${t.due ? new Date(t.due).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }) : 'بدون تاریخ'}${t.source === 'voice' ? ' · با صدا' : ''}</div></div>
    ${t.priority === 'high' ? '<span class="cc-pri">مهم</span>' : ''}<button type="button" class="cc-mini" data-del="${esc(t.id)}" title="حذف" aria-label="حذف">${ic('trash-2', 'sm')}</button></li>`;
  window.dialog(`<div class="dlg-scroll"><h3>${ic('list-checks')}تسک‌ها</h3>
    <div id="tF" class="field-row"><div class="field"><input id="tT" dir="auto" placeholder="چه کاری؟ (مثلاً نان بخرم)"></div>
      <div class="field"><input id="tD" type="datetime-local" dir="ltr"></div>
      <div class="field"><select id="tP"><option value="normal">معمولی</option><option value="high">مهم</option><option value="low">کم‌اهمیت</option></select></div><button class="btn btn-primary" type="button" data-go>${ic('plus', 'sm')}افزودن</button></div>
    <h4>باز (${faN(open.length)})</h4><ul class="cc-list" id="tOpen">${open.map(row).join('') || '<li class="cc-sub">تسک بازی نیست.</li>'}</ul>
    ${done.length ? `<h4>انجام‌شده</h4><ul class="cc-list">${done.map(row).join('')}</ul>` : ''}
    <p class="help">با صدا هم می‌شود: «هی جارویس، فردا ساعت ده یادم بنداز…»</p></div>
    <div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`, true);
  submitLike($('#tF'), async () => { const title = $('#tT').value.trim(); if (!title) return;
    try { await api('/tasks', { body: { title, due: $('#tD').value ? new Date($('#tD').value).toISOString() : null, priority: $('#tP').value } }); tasksDialog(); refresh(); } catch (err) { window.toast(err.message, true); } });
  $('#dlgBody').onclick = async e => {
    const c = e.target.closest('[data-t]'), d = e.target.closest('[data-del]');
    try {
      if (c) { const t = list.find(x => x.id === c.dataset.t); await api('/tasks/' + t.id, { body: { done: !t.done } }); tasksDialog(); refresh(); }
      if (d) { await api('/tasks/' + d.dataset.del, { method: 'DELETE' }); tasksDialog(); refresh(); }
    } catch (err) { window.toast(err.message, true); }
  };
}
window.tasksDialog = tasksDialog;

// ---------- the AI core (three.js) ----------
let core = null;
function makeCore(host) {
  if (!host) return null;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { host.classList.add('no-gl'); return null; }
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100); cam.position.set(0, 0, 7.2);
  const group = new THREE.Group(); scene.add(group);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#4fd1ff';
  let mats = [];
  function build() {
    group.clear(); mats.forEach(m => m.dispose()); mats = [];
    const pri = new THREE.Color(css('--color-primary')), acc = new THREE.Color(css('--color-info') || css('--color-primary'));
    const wire = new THREE.MeshBasicMaterial({ color: pri, wireframe: true, transparent: true, opacity: 0.55 });
    const inner = new THREE.MeshBasicMaterial({ color: pri, transparent: true, opacity: 0.16 });
    const ring = new THREE.MeshBasicMaterial({ color: acc, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
    const pts = new THREE.PointsMaterial({ color: acc, size: 0.035, transparent: true, opacity: 0.8 });
    mats.push(wire, inner, ring, pts);
    group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.55, 2), wire));
    group.add(new THREE.Mesh(new THREE.SphereGeometry(1.05, 32, 32), inner));
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.012, 8, 160), ring); r1.rotation.x = Math.PI / 2.3; group.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(2.65, 0.008, 8, 160), ring); r2.rotation.x = Math.PI / 1.8; r2.rotation.y = 0.5; group.add(r2);
    const g = new THREE.BufferGeometry(); const N = 700; const p = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const a = Math.random() * Math.PI * 2, rr = 2.0 + Math.random() * 1.1, y = (Math.random() - 0.5) * 0.5; p[i * 3] = Math.cos(a) * rr; p[i * 3 + 1] = y; p[i * 3 + 2] = Math.sin(a) * rr; }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const cloud = new THREE.Points(g, pts); cloud.rotation.x = 0.35; group.add(cloud);
    group.userData = { r1, r2, cloud };
  }
  build();
  new MutationObserver(build).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin', 'class'] });
  function size() { const w = host.clientWidth || 300, h = host.clientHeight || 300; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
  new ResizeObserver(size).observe(host); size();
  let busy = false, raf = 0, t = 0, running = true;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    const sp = reduce ? 0 : busy ? 2.2 : 1;
    t += 0.008 * sp;
    group.rotation.y = t * 0.6;
    const u = group.userData; if (u.r1) { u.r1.rotation.z = t * 1.3; u.r2.rotation.z = -t; u.cloud.rotation.y = -t * 0.8; }
    const s = 1 + (reduce ? 0 : Math.sin(t * (busy ? 6 : 3)) * 0.025); group.scale.setScalar(s);
    renderer.render(scene, cam);
  }
  frame();
  return {
    setBusy(b) { busy = b; host.classList.toggle('busy', b); },
    pause() { if (running) { cancelAnimationFrame(raf); running = false; } },
    resume() { if (!running) { running = true; frame(); } },
  };
}

// ---------- start ----------
function boot() {
  buildRail();
  const v = lsGet('jarvis.view', 'cc');
  show(v === 'code' ? 'code' : 'cc');
  // opening a chat / project from anywhere switches to the code view
  document.addEventListener('click', e => { if (current === 'cc' && e.target.closest('#chatList li, #projectList li, #btnNewChat')) show('code'); }, true);
  const brand = $('#brand'); if (brand) brand.addEventListener('click', () => show('cc'));
}
if (window.api) boot(); else window.addEventListener('load', boot);
