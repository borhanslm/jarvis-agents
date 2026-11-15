// Workflows: a visual editor (drag nodes, drag from an output dot to another node to connect),
// templates, "build from my description", run with input, live run timeline, answers to
// "ask me" / "approve" steps, pause / resume / stop.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);

const ICON = { start: 'play', llm: 'sparkles', agent: 'bot', ask: 'messages-square', approve: 'circle-check', condition: 'git-branch', task: 'list-checks', notify: 'send', http: 'globe', delay: 'clock', end: 'square' };
const PORT_FA = { next: '', yes: 'بله', no: 'نه', fail: 'خطا' };
const HELP = {
  llm: 'یک دستور به هوش مصنوعی. از {{last}} (خروجی قدم قبل)، {{input}} (ورودی اجرا)، {{n.شناسه}} و {{date}} استفاده کنید.',
  agent: 'کار برنامه‌نویسی را به تیم ایجنت‌ها می‌دهد و تا پایان صبر می‌کند. اگر شکست بخورد از خروجی «خطا» ادامه می‌دهد.',
  ask: 'از شما سؤال می‌پرسد (در پنل و تلگرام) و تا جواب ندهید صبر می‌کند. جواب شما خروجی این قدم است.',
  approve: 'از شما «بله / نه» می‌خواهد و بر اساس جواب شاخه می‌شود.',
  condition: 'اگر شرط درست بود از «بله» و گرنه از «نه» ادامه می‌دهد. «هوش مصنوعی» یعنی یک مدل درباره‌ی متن تصمیم بگیرد.',
  task: 'یک تسک می‌سازد.', notify: 'به تلگرام/بله‌ی شما پیام می‌دهد (و در پنل نشان می‌دهد).', http: 'متن یک صفحه‌ی وب (فقط https) را می‌خواند.', delay: 'چند دقیقه صبر می‌کند.',
};
const W = { el: null, data: null, cur: null, sel: null, run: null, dirty: false, drag: null, link: null };

function enter(host) { W.el = host; if (!host.dataset.built) build(); load(); }
function build() {
  W.el.dataset.built = '1';
  W.el.innerHTML = `<div class="wf">
    <aside class="wf-side">
      <div class="wf-side-head"><h2>${ic('git-branch')}ورک‌فلوها</h2></div>
      <button type="button" class="btn btn-primary btn-block" id="wfGen">${ic('sparkles', 'sm')}ساخت از توصیف</button>
      <button type="button" class="btn btn-block" id="wfNew">${ic('plus', 'sm')}ورک‌فلوی خالی</button>
      <ul class="tk-list" id="wfList"></ul>
      <h3 class="pg-sub">قالب‌ها</h3><ul class="tk-list" id="wfTpl"></ul>
      <div id="wfWaiting"></div>
    </aside>
    <section class="wf-main">
      <header class="tk-head wf-head"><input id="wfName" dir="auto" class="wf-name" placeholder="نام ورک‌فلو">
        <label class="help wf-sched">${ic('clock', 'sm')}هر روز ساعت <input id="wfSched" type="time" dir="ltr"></label>
        <button type="button" class="btn btn-sm" id="wfSave">${ic('save', 'sm')}ذخیره</button>
        <button type="button" class="btn btn-sm btn-primary" id="wfRun">${ic('play', 'sm')}اجرا</button>
        <button type="button" class="icon-btn" id="wfDel" title="حذف" aria-label="حذف">${ic('trash-2')}</button></header>
      <div class="wf-palette" id="wfPal"></div>
      <div class="wf-body"><div class="wf-scroll"><div class="wf-canvas" id="wfCanvas"><svg class="wf-edges" id="wfEdges"></svg><div id="wfNodes"></div></div></div>
        <aside class="wf-props" id="wfProps"></aside></div>
      <section class="wf-runs" id="wfRuns"></section>
    </section></div>`;
  $('#wfNew').onclick = () => openWf({ name: 'ورک‌فلوی تازه', desc: '', schedule: '', nodes: [{ id: 's', type: 'start', x: 40, y: 140 }, { id: 'e', type: 'end', x: 520, y: 140 }], edges: [] });
  $('#wfGen').onclick = genDialog;
  $('#wfList').onclick = e => { const li = e.target.closest('[data-id]'); if (li) loadWf(li.dataset.id); };
  $('#wfTpl').onclick = e => { const li = e.target.closest('[data-tpl]'); if (li) openWf(JSON.parse(JSON.stringify(W.data.templates[+li.dataset.tpl]))); };
  $('#wfSave').onclick = save;
  $('#wfRun').onclick = runDialog;
  $('#wfDel').onclick = async () => { if (!W.cur || !W.cur.id || !confirm('این ورک‌فلو حذف شود؟')) return; await api('/workflows/' + W.cur.id, { method: 'DELETE' }); W.cur = null; load(); };
  $('#wfName').oninput = () => { if (W.cur) { W.cur.name = $('#wfName').value; W.dirty = true; } };
  $('#wfSched').onchange = () => { if (W.cur) { W.cur.schedule = $('#wfSched').value; W.dirty = true; } };
  const cv = $('#wfCanvas');
  cv.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  $('#wfWaiting').onclick = onAnswerClick;
  $('#wfRuns').onclick = async e => { const b = e.target.closest('[data-run-act]'); if (b) { try { await api(`/workflows/runs/${b.dataset.run}/${b.dataset.runAct}`, { body: {} }); } catch (err) { window.toast(err.message, true); } } else onAnswerClick(e); };
}

async function load() {
  try { W.data = await api('/workflows'); } catch (e) { window.toast(e.message, true); return; }
  $('#wfList').innerHTML = W.data.list.length ? W.data.list.map(w => `<li data-id="${esc(w.id)}" class="${W.cur && W.cur.id === w.id ? 'on' : ''}"><b dir="auto">${esc(w.name)}</b><span class="help">${w.schedule ? '⏰ ' + w.schedule + ' · ' : ''}${w.lastRun ? stFa(w.lastRun.status) : 'هنوز اجرا نشده'}</span></li>`).join('') : '<li class="help tk-none">هنوز ورک‌فلویی نیست.</li>';
  $('#wfTpl').innerHTML = W.data.templates.map((t, i) => `<li data-tpl="${i}"><b dir="auto">${esc(t.name)}</b><span class="help" dir="auto">${esc(t.desc)}</span></li>`).join('');
  renderWaiting();
  if (W.cur && W.cur.id) { const fresh = W.data.list.find(w => w.id === W.cur.id); if (fresh && !W.dirty) loadWf(fresh.id); }
  else if (!W.cur) { if (W.data.list[0]) loadWf(W.data.list[0].id); else openWf(JSON.parse(JSON.stringify(W.data.templates[1]))); }
}
const ST_FA = { running: 'در حال اجرا', waiting: 'منتظر شما', paused: 'متوقف موقت', done: 'تمام شد', error: 'خطا', stopped: 'متوقف شد' };
const stFa = s => ST_FA[s] || s;
async function loadWf(id) {
  try { const w = await api('/workflows/' + id); openWf(w, w.runs); } catch (e) { window.toast(e.message, true); }
}
function openWf(w, runs = []) {
  W.cur = w; W.sel = null; W.dirty = !w.id; W.run = null; W.runs = [];
  $('#wfName').value = w.name || ''; $('#wfSched').value = w.schedule || '';
  $('#wfDel').disabled = !w.id;
  document.querySelectorAll('#wfList [data-id]').forEach(li => li.classList.toggle('on', li.dataset.id === w.id));
  $('#wfPal').innerHTML = Object.entries(W.data.types).filter(([k]) => k !== 'start').map(([k, t]) => `<button type="button" class="wf-pal" data-add="${k}" title="افزودن «${esc(t.label)}»">${ic(ICON[k], 'sm')}${esc(t.label)}</button>`).join('');
  $('#wfPal').onclick = e => { const b = e.target.closest('[data-add]'); if (b) addNode(b.dataset.add); };
  renderCanvas(); renderProps(); renderRuns(runs);
}
function addNode(type) {
  const xs = W.cur.nodes.map(n => n.x);
  const n = { id: type.slice(0, 2) + Math.random().toString(36).slice(2, 6), type, x: Math.max(40, ...xs) + 240 > 1400 ? 120 : Math.max(40, ...xs) + 60, y: 300 + (W.cur.nodes.length % 4) * 30, title: '', config: {} };
  W.cur.nodes.push(n); W.sel = n.id; W.dirty = true; renderCanvas(); renderProps();
}

// ---- canvas ----
const NW = 190, NH = 74;
function renderCanvas() {
  const w = W.cur, types = W.data.types;
  const active = W.run && ['running', 'waiting'].includes(W.run.status) ? W.run.at : null;
  const doneIds = new Set(W.run ? W.run.steps.filter(s => s.status === 'done').map(s => s.nodeId) : []);
  $('#wfNodes').innerHTML = w.nodes.map(n => {
    const t = types[n.type];
    return `<div class="wf-node t-${n.type} ${W.sel === n.id ? 'sel' : ''} ${active === n.id ? 'live' : ''} ${doneIds.has(n.id) ? 'did' : ''}" data-node="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px">
      <div class="wf-n-head">${ic(ICON[n.type], 'sm')}<span>${esc(t.label)}</span><code>${esc(n.id)}</code></div>
      <div class="wf-n-title" dir="auto">${esc(n.title || summary(n) || '—')}</div>
      <div class="wf-ports">${t.outs.map(p => `<span class="wf-port p-${p}" data-port="${p}" title="کشیدن برای وصل کردن${PORT_FA[p] ? ' (' + PORT_FA[p] + ')' : ''}">${PORT_FA[p] ? `<i>${PORT_FA[p]}</i>` : ''}</span>`).join('')}</div>
      ${n.type !== 'start' ? '<span class="wf-in"></span>' : ''}</div>`;
  }).join('');
  const maxX = Math.max(900, ...w.nodes.map(n => n.x + NW + 80)), maxY = Math.max(420, ...w.nodes.map(n => n.y + NH + 80));
  $('#wfCanvas').style.width = maxX + 'px'; $('#wfCanvas').style.height = maxY + 'px';
  drawEdges();
}
function portPos(n, port) {
  const outs = W.data.types[n.type].outs, i = Math.max(0, outs.indexOf(port));
  return { x: n.x + NW, y: n.y + (outs.length === 1 ? NH / 2 : 20 + i * ((NH - 30) / Math.max(1, outs.length - 1))) };
}
function drawEdges(temp) {
  const w = W.cur; const svg = $('#wfEdges');
  const path = (a, b) => { const dx = Math.max(40, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };
  const took = new Set(W.run ? W.run.steps.filter(s => s.port).map(s => s.nodeId + ':' + s.port) : []);
  svg.innerHTML = w.edges.map((e, i) => {
    const a = w.nodes.find(n => n.id === e.from), b = w.nodes.find(n => n.id === e.to); if (!a || !b) return '';
    const pa = portPos(a, e.port), pb = { x: b.x, y: b.y + NH / 2 };
    return `<path class="wf-edge p-${e.port} ${took.has(e.from + ':' + e.port) ? 'took' : ''}" d="${path(pa, pb)}" data-edge="${i}"><title>برای حذف این اتصال کلیک کنید</title></path>`;
  }).join('') + (temp ? `<path class="wf-edge temp" d="${path(temp.a, temp.b)}"/>` : '');
}
function canvasPoint(e) { const r = $('#wfCanvas').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function onDown(e) {
  const edge = e.target.closest('[data-edge]');
  if (edge) { if (confirm('این اتصال حذف شود؟')) { W.cur.edges.splice(+edge.dataset.edge, 1); W.dirty = true; drawEdges(); } return; }
  const port = e.target.closest('[data-port]'), node = e.target.closest('[data-node]');
  if (!node) { W.sel = null; renderCanvas(); renderProps(); return; }
  const n = W.cur.nodes.find(x => x.id === node.dataset.node);
  if (port) { W.link = { from: n, port: port.dataset.port }; e.preventDefault(); return; }
  const p = canvasPoint(e);
  W.drag = { n, dx: p.x - n.x, dy: p.y - n.y, moved: false };
  if (W.sel !== n.id) { W.sel = n.id; renderCanvas(); renderProps(); }
  e.preventDefault();
}
function onMove(e) {
  if (W.drag) {
    const p = canvasPoint(e), n = W.drag.n;
    n.x = Math.max(0, Math.round((p.x - W.drag.dx) / 10) * 10); n.y = Math.max(0, Math.round((p.y - W.drag.dy) / 10) * 10);
    const el = document.querySelector(`[data-node="${CSS.escape(n.id)}"]`); if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
    W.drag.moved = true; drawEdges();
  } else if (W.link) drawEdges({ a: portPos(W.link.from, W.link.port), b: canvasPoint(e) });
}
function onUp(e) {
  if (W.drag) { if (W.drag.moved) W.dirty = true; W.drag = null; }
  if (W.link) {
    const t = document.elementFromPoint(e.clientX, e.clientY); const node = t && t.closest('[data-node]');
    if (node && node.dataset.node !== W.link.from.id) {
      const to = W.cur.nodes.find(x => x.id === node.dataset.node);
      if (to.type !== 'start') {
        W.cur.edges = W.cur.edges.filter(x => !(x.from === W.link.from.id && x.port === W.link.port)); // one target per output
        W.cur.edges.push({ from: W.link.from.id, to: to.id, port: W.link.port }); W.dirty = true;
      }
    }
    W.link = null; drawEdges();
  }
}
function summary(n) {
  const c = n.config || {};
  return ({ llm: c.prompt, agent: c.task, ask: c.question, approve: c.question, condition: c.op === 'ai' ? '🤖 ' + (c.arg || '') : (c.op || 'contains') + ' «' + (c.arg || '') + '»', task: c.title, notify: c.text, http: c.url, delay: c.minutes ? faN(c.minutes) + ' دقیقه' : '' }[n.type] || '').slice(0, 60);
}

// ---- properties of the selected node ----
function renderProps() {
  const box = $('#wfProps');
  const n = W.cur && W.cur.nodes.find(x => x.id === W.sel);
  if (!n) { box.innerHTML = `<div class="help wf-tip">${ic('info', 'sm')} یک گره را انتخاب کنید تا تنظیماتش را ببینید.<br><br>• گره‌ها را بکشید تا جابه‌جا شوند.<br>• از نقطه‌ی سمت راست هر گره بکشید و روی گره‌ی بعدی رها کنید تا وصل شوند.<br>• روی یک خط کلیک کنید تا حذف شود.<br>• از نوار بالا گره‌ی تازه اضافه کنید.</div>`; return; }
  const c = n.config || (n.config = {});
  const S = window.JARVIS_STATE || {};
  const f = (k, label, type = 'text', extra = '') => type === 'area' ? `<div class="field"><label>${label}</label><textarea data-k="${k}" dir="auto" rows="5">${esc(c[k] || '')}</textarea>${extra}</div>`
    : `<div class="field"><label>${label}</label><input data-k="${k}" type="${type}" dir="${type === 'text' ? 'auto' : 'ltr'}" value="${esc(c[k] ?? '')}">${extra}</div>`;
  const sel = (k, label, list) => `<div class="field"><label>${label}</label><select data-k="${k}">${list.map(([v, l]) => `<option value="${esc(v)}" ${String(c[k] ?? '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  const fields = {
    llm: f('prompt', 'دستور', 'area') + f('model', 'مدل (خالی = مدل دستیار)', 'text'),
    agent: sel('projectId', 'پروژه', (S.projects || []).map(p => [p.id, p.name])) + f('task', 'کار', 'area') + sel('mode', 'روش', [['team', 'تیمی'], ['smart', 'هوشمند'], ['plan', 'طراحی'], ['audit', 'بازرسی']]),
    ask: f('question', 'سؤال', 'area'), approve: f('question', 'سؤال تأیید', 'area'),
    condition: f('value', 'چه چیزی بررسی شود', 'text', '<div class="help">پیش‌فرض: {{last}}</div>') + sel('op', 'شرط', [['contains', 'شامل باشد'], ['equals', 'برابر باشد'], ['regex', 'الگو (regex)'], ['empty', 'خالی باشد'], ['ai', 'هوش مصنوعی تصمیم بگیرد']]) + f('arg', 'مقدار / سؤال', 'text'),
    task: f('title', 'عنوان تسک') + f('due', 'زمان (اختیاری، مثل 2026-11-20T10:00)', 'text') + sel('category', 'دسته', [['life', 'زندگی'], ['work', 'کار']]),
    notify: f('text', 'متن پیام', 'area'), http: f('url', 'آدرس (https)', 'url'), delay: f('minutes', 'چند دقیقه', 'number'),
  }[n.type] || '';
  box.innerHTML = `<h3>${ic(ICON[n.type], 'sm')}${esc(W.data.types[n.type].label)} <code dir="ltr">${esc(n.id)}</code></h3>
    ${n.type !== 'start' && n.type !== 'end' ? `<div class="field"><label>عنوان (اختیاری)</label><input data-title dir="auto" value="${esc(n.title || '')}"></div>` : ''}
    ${fields}${HELP[n.type] ? `<p class="help">${esc(HELP[n.type])}</p>` : ''}
    ${n.type !== 'start' ? `<button type="button" class="btn btn-sm ghost danger" id="wfDelNode">${ic('trash-2', 'sm')}حذف این گره</button>` : ''}`;
  box.oninput = box.onchange = e => {
    const t = e.target;
    if (t.matches('[data-title]')) n.title = t.value;
    else if (t.dataset.k) c[t.dataset.k] = t.type === 'number' ? +t.value : t.value;
    else return;
    W.dirty = true;
    const el = document.querySelector(`[data-node="${CSS.escape(n.id)}"] .wf-n-title`); if (el) el.textContent = n.title || summary(n) || '—';
  };
  const del = $('#wfDelNode'); if (del) del.onclick = () => { W.cur.nodes = W.cur.nodes.filter(x => x.id !== n.id); W.cur.edges = W.cur.edges.filter(x => x.from !== n.id && x.to !== n.id); W.sel = null; W.dirty = true; renderCanvas(); renderProps(); };
}

async function save() {
  try { const w = await api('/workflows', { body: W.cur }); W.cur.id = w.id; W.dirty = false; window.toast('ذخیره شد'); await load(); return w; }
  catch (e) { window.toast(e.message, true); return null; }
}
function runDialog() {
  window.dialog(`<div class="dlg-scroll"><h3>${ic('play')}اجرای «${esc(W.cur.name)}»</h3>
    <div class="field"><label>ورودی (اختیاری — در ورک‌فلو با {{input}})</label><textarea id="wfIn" dir="auto" rows="4" placeholder="مثلاً: صفحه‌ی ورود با کد پیامکی بساز"></textarea></div></div>
    <div class="dlg-actions"><button type="button" class="btn primary" id="wfGo">${ic('play', 'sm')}اجرا</button><button class="btn ghost" value="cancel">انصراف</button></div>`);
  $('#wfGo').onclick = async () => {
    const input = $('#wfIn').value; $('#dlg').close();
    if (W.dirty || !W.cur.id) { if (!(await save())) return; }
    try {
      const r = await api(`/workflows/${W.cur.id}/run`, { body: { input } });
      // live events for this run may have arrived before this reply: keep the newer state
      if (!(W.run && W.run.id === r.id)) W.run = r;
      renderCanvas(); renderRuns([W.run, ...(W.runs || []).filter(x => x.id !== r.id)]);
    } catch (e) { window.toast(e.message, true); }
  };
}
function genDialog() {
  window.dialog(`<div class="dlg-scroll"><h3>${ic('sparkles')}ساخت ورک‌فلو از توصیف</h3>
    <p class="help">کامل بگویید چه می‌خواهید؛ جارویس ورک‌فلو را می‌سازد و قبل از اجرا آن را می‌بینید و ویرایش می‌کنید.</p>
    <div class="field"><textarea id="wfDesc" dir="auto" rows="6" placeholder="مثلاً: هر روز ساعت ۹ صبح، تسک‌های کاری امروز را بخوان، برای هر کدام که برنامه‌نویسی است از من تأیید بگیر و به تیم ایجنت‌ها بده، و آخر کار خلاصه را به تلگرامم بفرست."></textarea></div>
    <div id="wfGenOut" class="help"></div></div>
    <div class="dlg-actions"><button type="button" class="btn primary" id="wfGenGo">${ic('sparkles', 'sm')}بساز</button><button class="btn ghost" value="cancel">انصراف</button></div>`, true);
  $('#wfGenGo').onclick = async () => {
    const text = $('#wfDesc').value.trim(); if (!text) return;
    $('#wfGenGo').disabled = true; $('#wfGenOut').textContent = 'در حال طراحی… (چند ثانیه)';
    try { const w = await api('/workflows/generate', { body: { text } }); $('#dlg').close(); openWf(w); W.dirty = true; window.toast('ساخته شد — بررسی کنید و «ذخیره» بزنید'); }
    catch (e) { $('#wfGenGo').disabled = false; $('#wfGenOut').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  };
}

// ---- runs ----
function renderRuns(runs) {
  W.runs = runs || W.runs || [];
  if (!W.run && W.runs[0]) W.run = W.runs[0];
  const r = W.run;
  if (!r) { $('#wfRuns').innerHTML = '<div class="help">هنوز اجرا نشده.</div>'; return; }
  const acts = r.status === 'running' ? `<button type="button" class="btn btn-sm" data-run="${r.id}" data-run-act="pause">${ic('pause', 'sm')}مکث</button><button type="button" class="btn btn-sm btn-danger" data-run="${r.id}" data-run-act="stop">${ic('circle-stop', 'sm')}توقف</button>`
    : r.status === 'paused' ? `<button type="button" class="btn btn-sm btn-primary" data-run="${r.id}" data-run-act="resume">${ic('play', 'sm')}ادامه</button><button type="button" class="btn btn-sm" data-run="${r.id}" data-run-act="stop">توقف</button>`
    : r.status === 'waiting' ? `<button type="button" class="btn btn-sm" data-run="${r.id}" data-run-act="stop">توقف</button>` : '';
  $('#wfRuns').innerHTML = `<div class="wf-run-head"><b>آخرین اجرا</b><span class="wf-st s-${r.status}">${stFa(r.status)}</span><span class="help">${new Date(r.startedAt).toLocaleString('fa-IR', { timeStyle: 'short', dateStyle: 'short' })}</span>${acts}</div>
    ${r.error ? `<div class="bad">${esc(r.error)}</div>` : ''}${r.note ? `<div class="help">${esc(r.note)}</div>` : ''}
    ${r.status === 'waiting' && r.pending ? answerBox(r) : ''}
    <ol class="wf-steps">${r.steps.map(s => `<li class="s-${s.status}"><span class="wf-st s-${s.status}">${ic(ICON[s.type], 'sm')}</span><div><b dir="auto">${esc(s.title)}</b>${s.port && PORT_FA[s.port] ? ` <em>→ ${PORT_FA[s.port]}</em>` : ''}${s.ms != null ? ` <span class="help">${faN((s.ms / 1000).toFixed(1))} ثانیه</span>` : ''}
      ${s.output ? `<div class="wf-out" dir="auto">${esc(s.output).slice(0, 400)}</div>` : ''}${s.answer ? `<div class="wf-out">جواب شما: ${esc(s.answer)}</div>` : ''}${s.error ? `<div class="bad">${esc(s.error)}</div>` : ''}</div></li>`).join('')}</ol>`;
}
function answerBox(r) {
  const p = r.pending;
  return `<div class="wf-ask" data-run-id="${esc(r.id)}"><div dir="auto">${esc(p.question).replace(/\n/g, '<br>')}</div>
    ${p.kind === 'approve' ? `<div class="row-gap"><button type="button" class="btn btn-sm btn-primary" data-ans="yes">${ic('circle-check', 'sm')}بله</button><button type="button" class="btn btn-sm" data-ans="no">نه</button></div>`
      : `<div class="row-gap"><input dir="auto" class="wf-ans-in" placeholder="جواب شما…"><button type="button" class="btn btn-sm btn-primary" data-ans="text">ارسال</button></div>`}</div>`;
}
async function onAnswerClick(e) {
  const b = e.target.closest('[data-ans]'); if (!b) return;
  const box = b.closest('[data-run-id]');
  const value = b.dataset.ans === 'text' ? box.querySelector('.wf-ans-in').value : b.dataset.ans === 'yes';
  try { await api(`/workflows/runs/${box.dataset.runId}/answer`, { body: { value } }); box.remove(); } catch (err) { window.toast(err.message, true); }
}
function renderWaiting() {
  const list = (W.data && W.data.waiting) || [];
  $('#wfWaiting').innerHTML = list.length ? `<h3 class="pg-sub">منتظر جواب شما</h3>` + list.map(r => `<div class="wf-wait"><b dir="auto">${esc(r.name)}</b>${answerBox(r)}</div>`).join('') : '';
}

window.addEventListener('jarvis:ev', e => {
  const ev = e.detail; if (!ev || !W.el || !W.el.dataset.built) return;
  if (ev.type === 'wfRun') {
    if (W.cur && ev.run.workflowId === W.cur.id) { W.run = ev.run; renderCanvas(); renderRuns(); }
    if (['waiting', 'done', 'error', 'stopped'].includes(ev.run.status)) { clearTimeout(W._l); W._l = setTimeout(load, 300); }
  }
  if (ev.type === 'wfAsk' && !(W.el.classList.contains('on'))) window.toast('ورک‌فلوی «' + ev.run.name + '» منتظر جواب شماست (بخش ورک‌فلوها)');
  if (ev.type === 'wfNotify' && W.el.classList.contains('on')) window.toast(String(ev.text).slice(0, 140));
});

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('workflows', { icon: 'git-branch', label: 'ورک‌فلوها', enter, leave() {} });
