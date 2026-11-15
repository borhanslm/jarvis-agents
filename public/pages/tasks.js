// Tasks: life and work, with dates, reminders and repeats. Work tasks can be handed to the coding team.
// Also shows reminders (anywhere in the app): a card with "done" / "later", spoken when voice is on.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const REPEAT = [['', 'بدون تکرار'], ['daily', 'هر روز'], ['weekdays', 'روزهای کاری (شنبه تا پنج‌شنبه)'], ['weekly', 'هر هفته'], ['monthly', 'هر ماه']];
const REMIND = [[0, 'سر وقت'], [5, '۵ دقیقه قبل'], [15, '۱۵ دقیقه قبل'], [30, '۳۰ دقیقه قبل'], [60, '۱ ساعت قبل'], [1440, '۱ روز قبل']];
const FILTERS = [['open', 'همه‌ی باز'], ['today', 'امروز'], ['work', 'کار'], ['life', 'زندگی'], ['done', 'انجام‌شده']];
const opts = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
const pad = n => String(n).padStart(2, '0');
const localInput = ms => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const T = { el: null, list: [], filter: lsGet('jarvis.taskFilter', 'open'), q: '' };

function enter(host) {
  T.el = host;
  if (!host.dataset.built) build();
  load();
}
function build() {
  T.el.dataset.built = '1';
  T.el.innerHTML = `<div class="pg">
    <header class="pg-head"><div><h1>${ic('list-checks')}تسک‌ها</h1>
      <p class="help">کارهای زندگی و کار، با یادآور. با صدا یا تلگرام هم می‌شود: «فردا ساعت ده یادم بنداز…». کارهای برنامه‌نویسی را با یک کلیک به تیم ایجنت‌ها بدهید.</p></div>
      <div class="pg-stat"><b id="tkOpenN">۰</b><span>باز</span></div></header>
    <section class="tq-add" id="tqAdd">
      <input id="tqTitle" dir="auto" placeholder="چه کاری؟ (مثلاً نان بخرم، شروع پروژه‌ی CRM)" autocomplete="off">
      <input id="tqDue" type="datetime-local" dir="ltr" aria-label="زمان">
      <select id="tqCat" aria-label="دسته">${opts([['life', 'زندگی'], ['work', 'کار']], 'life')}</select>
      <select id="tqPri" aria-label="اولویت">${opts([['normal', 'معمولی'], ['high', 'مهم'], ['low', 'کم‌اهمیت']], 'normal')}</select>
      <select id="tqRep" aria-label="تکرار">${opts(REPEAT, '')}</select>
      <select id="tqRem" aria-label="یادآوری">${opts(REMIND, 0)}</select>
      <button type="button" class="btn btn-primary" id="tqGo">${ic('plus', 'sm')}افزودن</button>
    </section>
    <div class="tq-bar"><div class="tq-filters" role="tablist">${FILTERS.map(([k, l]) => `<button type="button" role="tab" data-f="${k}">${l}</button>`).join('')}</div>
      <div class="chat-search">${ic('search', 'sm')}<input id="tqSearch" type="search" dir="auto" placeholder="جستجو…" autocomplete="off"></div></div>
    <div id="tqList"></div>
  </div>`;
  const add = async () => {
    const title = $('#tqTitle').value.trim(); if (!title) { $('#tqTitle').focus(); return; }
    const due = $('#tqDue').value ? new Date($('#tqDue').value).toISOString() : null;
    try { await api('/tasks', { body: { title, due, category: $('#tqCat').value, priority: $('#tqPri').value, repeat: $('#tqRep').value, remindBefore: +$('#tqRem').value } }); $('#tqTitle').value = ''; $('#tqDue').value = ''; load(); }
    catch (e) { window.toast(e.message, true); }
  };
  $('#tqGo').onclick = add;
  $('#tqTitle').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  T.el.querySelector('.tq-filters').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; T.filter = b.dataset.f; lsSet('jarvis.taskFilter', T.filter); render(); };
  $('#tqSearch').oninput = e => { T.q = e.target.value.trim().toLowerCase(); render(); };
  $('#tqList').onclick = onListClick;
}
async function load() { try { T.list = await api('/tasks'); } catch { T.list = []; } render(); }

function groupOf(t, now = Date.now()) {
  if (t.done) return 'done';
  if (!t.due) return 'nodate';
  const d = new Date(now); d.setHours(0, 0, 0, 0); const today = d.getTime(), tomorrow = today + 864e5, after = today + 2 * 864e5;
  if (t.due < now) return 'late';
  if (t.due < tomorrow) return 'today';
  if (t.due < after) return 'tomorrow';
  return 'later';
}
const GROUPS = [['late', 'عقب‌افتاده'], ['today', 'امروز'], ['tomorrow', 'فردا'], ['later', 'بعداً'], ['nodate', 'بدون تاریخ'], ['done', 'انجام‌شده']];
function render() {
  const now = Date.now();
  T.el.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === T.filter));
  const open = T.list.filter(t => !t.done);
  $('#tkOpenN').textContent = faN(open.length);
  let list = T.list.filter(t => {
    if (T.q && !(t.title + ' ' + (t.notes || '')).toLowerCase().includes(T.q)) return false;
    if (T.filter === 'done') return t.done;
    if (t.done) return false;
    if (T.filter === 'today') return ['late', 'today'].includes(groupOf(t, now)) || !t.due;
    if (T.filter === 'work' || T.filter === 'life') return (t.category || 'life') === T.filter;
    return true;
  });
  list.sort((a, b) => (a.due || 9e15) - (b.due || 9e15) || (a.priority === 'high' ? -1 : 0));
  if (T.filter === 'done') list = list.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 100);
  const by = {}; for (const t of list) (by[groupOf(t, now)] = by[groupOf(t, now)] || []).push(t);
  $('#tqList').innerHTML = list.length ? GROUPS.filter(([g]) => by[g]).map(([g, label]) => `<section class="tq-group ${g}"><h2 class="pg-sub">${label} <span>${faN(by[g].length)}</span></h2><ul class="tq-list">${by[g].map(row).join('')}</ul></section>`).join('')
    : `<div class="tk-empty">${ic('list-checks')}<h3>${T.filter === 'done' ? 'هنوز تسکی انجام نشده' : 'تسکی نیست'}</h3><p class="help">از بالا اضافه کنید، یا بگویید «هی جارویس، فردا ساعت ده یادم بنداز…».</p></div>`;
}
const REP_FA = Object.fromEntries(REPEAT);
function row(t) {
  const when = t.due ? new Date(t.due).toLocaleString('fa-IR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const meta = [when, t.repeat ? '🔁 ' + REP_FA[t.repeat] : '', t.due && t.remindBefore ? '🔔 ' + (REMIND.find(([k]) => k === t.remindBefore) || [0, t.remindBefore + ' دقیقه قبل'])[1] : '', t.snoozeUntil && t.snoozeUntil > Date.now() ? '⏰ تا ' + new Date(t.snoozeUntil).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) : '', t.source === 'voice' ? 'با صدا' : '', t.chatId ? 'به تیم داده شد' : ''].filter(Boolean).join(' · ');
  return `<li class="tq-item ${t.done ? 'done' : ''} ${t.priority === 'high' ? 'hi' : ''}" data-id="${esc(t.id)}">
    <button type="button" class="cc-check ${t.done ? 'on' : ''}" data-act="done" aria-label="${t.done ? 'برگرداندن' : 'انجام شد'}" title="${t.done ? 'برگرداندن' : 'انجام شد'}"></button>
    <div class="tq-body"><b dir="auto">${esc(t.title)}</b>${t.notes ? `<div class="help" dir="auto">${esc(t.notes).slice(0, 160)}</div>` : ''}<div class="tq-meta">${esc(meta)}</div></div>
    <span class="tq-cat ${t.category || 'life'}">${t.category === 'work' ? 'کار' : 'زندگی'}</span>${t.priority === 'high' ? '<span class="cc-pri">مهم</span>' : ''}
    <div class="tq-acts">${!t.done && t.category === 'work' && !t.chatId ? `<button type="button" class="btn btn-sm" data-act="run" title="این کار را تیم ایجنت‌ها انجام بدهند">${ic('bot', 'sm')}به تیم</button>` : ''}
      ${!t.done && t.due ? `<button type="button" class="cc-mini" data-act="snooze" title="۱ ساعت بعد یادآوری کن" aria-label="بعداً">${ic('clock', 'sm')}</button>` : ''}
      <button type="button" class="cc-mini" data-act="edit" title="ویرایش" aria-label="ویرایش">${ic('pencil', 'sm')}</button>
      <button type="button" class="cc-mini" data-act="del" title="حذف" aria-label="حذف">${ic('trash-2', 'sm')}</button></div></li>`;
}
async function onListClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.closest('[data-id]').dataset.id, t = T.list.find(x => x.id === id); if (!t) return;
  try {
    if (b.dataset.act === 'done') { if (t.done) await api('/tasks/' + id, { body: { done: false } }); else { const r = await api(`/tasks/${id}/done`, { body: {} }); if (!r.done) window.toast('انجام شد. دفعه‌ی بعد: ' + new Date(r.due).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' })); } }
    else if (b.dataset.act === 'snooze') { await api(`/tasks/${id}/snooze`, { body: { minutes: 60 } }); window.toast('یک ساعت دیگر یادآوری می‌کنم'); }
    else if (b.dataset.act === 'del') { if (!confirm('این تسک حذف شود؟')) return; await api('/tasks/' + id, { method: 'DELETE' }); }
    else if (b.dataset.act === 'edit') return editDialog(t);
    else if (b.dataset.act === 'run') return runDialog(t);
    load();
  } catch (err) { window.toast(err.message, true); }
}
function editDialog(t) {
  window.dialog(`<div class="dlg-scroll"><h3>${ic('pencil')}ویرایش تسک</h3>
    <div class="field"><label>عنوان</label><input id="teTitle" dir="auto" value="${esc(t.title)}"></div>
    <div class="field"><label>توضیح</label><textarea id="teNotes" dir="auto" rows="3">${esc(t.notes || '')}</textarea></div>
    <div class="field-row"><div class="field"><label>زمان</label><input id="teDue" type="datetime-local" dir="ltr" value="${localInput(t.due)}"></div>
      <div class="field"><label>یادآوری</label><select id="teRem">${opts(REMIND, t.remindBefore || 0)}</select></div></div>
    <div class="field-row"><div class="field"><label>تکرار</label><select id="teRep">${opts(REPEAT, t.repeat || '')}</select></div>
      <div class="field"><label>دسته</label><select id="teCat">${opts([['life', 'زندگی'], ['work', 'کار']], t.category || 'life')}</select></div>
      <div class="field"><label>اولویت</label><select id="tePri">${opts([['normal', 'معمولی'], ['high', 'مهم'], ['low', 'کم‌اهمیت']], t.priority || 'normal')}</select></div></div></div>
    <div class="dlg-actions"><button type="button" class="btn primary" id="teSave">ذخیره</button><button class="btn ghost" value="cancel">بستن</button></div>`);
  $('#teSave').onclick = async () => {
    try { await api('/tasks/' + t.id, { body: { title: $('#teTitle').value, notes: $('#teNotes').value, due: $('#teDue').value ? new Date($('#teDue').value).toISOString() : null, remindBefore: +$('#teRem').value, repeat: $('#teRep').value, category: $('#teCat').value, priority: $('#tePri').value } }); $('#dlg').close(); load(); }
    catch (e) { window.toast(e.message, true); }
  };
}
function runDialog(t) {
  const S = window.JARVIS_STATE || {}; const projects = S.projects || [];
  if (!projects.length) { window.toast('اول یک پروژه در «تیم کدنویسی» اضافه کنید.', true); return; }
  window.dialog(`<div class="dlg-scroll"><h3>${ic('bot')}دادن به تیم ایجنت‌ها</h3>
    <p class="help" dir="auto">«${esc(t.title)}»${t.notes ? ' — ' + esc(t.notes).slice(0, 200) : ''}</p>
    <div class="field"><label>روی کدام پروژه؟</label><select id="trProj">${projects.map(p => `<option value="${esc(p.id)}" ${p.id === (t.projectId || S.projectId) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="field"><label>روش</label><select id="trMode">${opts([['team', 'تیمی: سازنده + تستر'], ['smart', 'هوشمند: تقسیم کار و انتخاب مدل'], ['plan', 'طراحی: اول نقشه'], ['audit', 'بازرسی']], 'team')}</select></div>
    <p class="help">کار در یک گفتگوی تازه شروع می‌شود؛ پیشرفتش را در «تیم کدنویسی» یا اتاق عملیات ببینید.</p></div>
    <div class="dlg-actions"><button type="button" class="btn primary" id="trGo">${ic('play', 'sm')}شروع</button><button class="btn ghost" value="cancel">انصراف</button></div>`);
  $('#trGo').onclick = async () => {
    $('#trGo').disabled = true;
    try { await api(`/tasks/${t.id}/run`, { body: { projectId: $('#trProj').value, mode: $('#trMode').value } }); $('#dlg').close(); window.toast('کار به تیم داده شد'); load(); }
    catch (e) { $('#trGo').disabled = false; window.toast(e.message, true); }
  };
}

// ---- reminders (anywhere in the app) ----
function reminderCard(ev) {
  let box = document.getElementById('remBox');
  if (!box) { box = document.createElement('div'); box.id = 'remBox'; box.className = 'rem-box'; box.setAttribute('aria-live', 'assertive'); document.body.appendChild(box); }
  const t = ev.task;
  const c = document.createElement('div'); c.className = 'rem-card'; c.dataset.id = t.id;
  c.innerHTML = `<div class="rem-ic">${ic('bell')}</div><div class="rem-body"><b dir="auto">${esc(t.title)}</b><span class="help" dir="auto">${esc(ev.text.replace(/^یادآوری: /, '').replace(t.title, '').replace(/^ — /, '')) || 'الان'}</span></div>
    <div class="rem-acts"><button type="button" class="btn btn-sm btn-primary" data-r="done">انجام شد</button><button type="button" class="btn btn-sm" data-r="10">۱۰ دقیقه بعد</button><button type="button" class="btn btn-sm" data-r="60">۱ ساعت بعد</button><button type="button" class="cc-mini" data-r="x" aria-label="بستن">${ic('x', 'sm')}</button></div>`;
  c.onclick = async e => {
    const b = e.target.closest('[data-r]'); if (!b) return;
    try { if (b.dataset.r === 'done') await api(`/tasks/${t.id}/done`, { body: {} }); else if (b.dataset.r !== 'x') await api(`/tasks/${t.id}/snooze`, { body: { minutes: +b.dataset.r } }); } catch (err) { window.toast(err.message, true); }
    c.remove(); if (T.el && T.el.classList.contains('on')) load();
  };
  box.querySelectorAll(`[data-id="${CSS.escape(t.id)}"]`).forEach(x => x.remove());
  box.appendChild(c);
}
window.addEventListener('jarvis:ev', e => {
  const ev = e.detail; if (!ev) return;
  if (ev.type === 'reminder') {
    reminderCard(ev);
    if (ev.speak && window.voiceSpeak) window.voiceSpeak(ev.text);
    if (window.jarvisDesktop && window.jarvisDesktop.voice) window.jarvisDesktop.voice({ state: '', reply: '⏰ ' + ev.text });
  }
  if (ev.type === 'tasks' && T.el && T.el.classList.contains('on')) { T.list = ev.tasks || T.list; render(); }
});

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('tasks', { icon: 'list-checks', label: 'تسک‌ها', enter, leave() {} });
