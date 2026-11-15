// Chat: plain conversations with any model (Claude, Gemini, Grok, DeepSeek, Ollama…), no project.
// Answers stream in over the event channel (talkStart / talkDelta / talkDone).
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const md = t => (window.md ? window.md(t) : `<p dir="auto">${esc(t)}</p>`);

const C = { el: null, list: [], talk: null, models: [], built: false, q: '' };

function enter(host) {
  C.el = host;
  if (!C.built) build();
  loadAll();
}

function build() {
  C.built = true;
  C.el.innerHTML = `<div class="tk">
    <aside class="tk-side">
      <button type="button" class="btn btn-primary btn-block" id="tkNew">${ic('plus', 'sm')}گفتگوی تازه</button>
      <div class="chat-search">${ic('search', 'sm')}<input id="tkSearch" type="search" dir="auto" placeholder="جستجو در گفتگوها…" autocomplete="off"></div>
      <ul class="tk-list" id="tkList"></ul>
    </aside>
    <section class="tk-main">
      <header class="tk-head"><h2 id="tkTitle" dir="auto" title="برای تغییر نام دوبار کلیک کنید"></h2>
        <select id="tkModel" dir="ltr" aria-label="مدل"></select>
        <button type="button" class="icon-btn" id="tkExport" title="خروجی Markdown" aria-label="خروجی">${ic('download')}</button>
        <button type="button" class="icon-btn" id="tkDel" title="حذف گفتگو" aria-label="حذف">${ic('trash-2')}</button></header>
      <div class="tk-stream" id="tkStream" aria-live="polite"></div>
      <form class="tk-compose" id="tkForm" autocomplete="off">
        <textarea id="tkInput" dir="auto" rows="1" placeholder="پیام به جارویس… (Enter برای ارسال، Shift+Enter خط تازه)"></textarea>
        <button type="button" class="btn btn-danger" id="tkStop" hidden>${ic('circle-stop', 'sm')}توقف</button>
        <button type="submit" class="btn btn-primary" id="tkSend" aria-label="ارسال">${ic('send', 'sm flip-rtl')}</button>
      </form>
      <div class="tk-foot help" id="tkFoot"></div>
    </section></div>`;
  $('#tkNew').onclick = () => newTalk();
  $('#tkSearch').oninput = e => { C.q = e.target.value; clearTimeout(C._sq); C._sq = setTimeout(loadList, 200); };
  $('#tkList').onclick = e => { const li = e.target.closest('[data-id]'); if (li) open(li.dataset.id); };
  $('#tkForm').onsubmit = e => { e.preventDefault(); sendMsg(); };
  const inp = $('#tkInput');
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); } });
  inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(220, inp.scrollHeight) + 'px'; });
  $('#tkStop').onclick = () => C.talk && api(`/talks/${C.talk.id}/stop`, { body: {} });
  $('#tkModel').onchange = async e => { lsSet('jarvis.chatModel', e.target.value); if (C.talk) { C.talk.model = e.target.value; try { await api('/talks/' + C.talk.id, { body: { model: e.target.value } }); } catch {} } foot(); };
  $('#tkDel').onclick = async () => { if (!C.talk || !confirm('این گفتگو حذف شود؟')) return; await api('/talks/' + C.talk.id, { method: 'DELETE' }); C.talk = null; lsSet('jarvis.talk', ''); loadAll(); };
  $('#tkExport').onclick = async () => {
    if (!C.talk) return;
    const r = await fetch(`/api/talks/${C.talk.id}/export`, { headers: { 'X-Jarvis': '1', 'X-Jarvis-Token': localStorage.getItem('jarvis.token') || '' } });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([await r.text()], { type: 'text/markdown' })), download: (C.talk.title || 'chat').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60) + '.md' });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#tkTitle').ondblclick = async () => { if (!C.talk) return; const t = prompt('نام گفتگو:', C.talk.title); if (t && t.trim()) { await api('/talks/' + C.talk.id, { body: { title: t } }); C.talk.title = t.trim(); $('#tkTitle').textContent = C.talk.title; loadList(); } };
  $('#tkStream').onclick = async e => {
    const cp = e.target.closest('[data-copy]'); if (cp) { const m = C.talk.messages[+cp.dataset.copy]; try { await navigator.clipboard.writeText(m.content); window.toast('کپی شد'); } catch {} return; }
    const cpc = e.target.closest('.code .copy'); if (cpc && cpc.dataset.copy) { try { await navigator.clipboard.writeText(decodeURIComponent(cpc.dataset.copy)); window.toast('کپی شد'); } catch {} return; }
    if (e.target.closest('[data-regen]')) { try { await api(`/talks/${C.talk.id}/regenerate`, { body: { model: $('#tkModel').value } }); } catch (err) { window.toast(err.message, true); } }
  };
}

async function loadAll() {
  try { C.models = await api('/llms'); } catch { C.models = []; }
  await loadList();
  const want = (C.talk && C.talk.id) || lsGet('jarvis.talk', '');
  if (want && C.list.some(t => t.id === want)) await open(want); else if (C.list.length) await open(C.list[0].id); else { C.talk = null; renderTalk(); }
}
async function loadList() {
  try { C.list = await api('/talks' + (C.q.trim() ? '?q=' + encodeURIComponent(C.q.trim()) : '')); } catch { C.list = []; }
  renderList();
}
function renderList() {
  const ul = $('#tkList'); if (!ul) return;
  ul.innerHTML = C.list.length ? C.list.map(t => `<li data-id="${esc(t.id)}" class="${C.talk && C.talk.id === t.id ? 'on' : ''}"><b dir="auto">${esc(t.title)}</b>
    <span class="help" dir="auto">${t.running ? '<span class="tk-live"></span>در حال نوشتن… ' : ''}${esc(t.hit || t.preview || '')}</span></li>`).join('')
    : `<li class="help tk-none">${C.q ? 'چیزی پیدا نشد.' : 'هنوز گفتگویی نیست.'}</li>`;
}
function modelOptions(value) {
  const groups = {};
  for (const m of C.models) (groups[m.group] = groups[m.group] || []).push(m);
  const has = C.models.some(m => m.spec === value);
  return (value && !has ? `<option value="${esc(value)}" selected>${esc(value)} (در دسترس نیست)</option>` : '')
    + Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(m => `<option value="${esc(m.spec)}" ${m.spec === value ? 'selected' : ''} ${m.ok ? '' : 'disabled'}>${esc(m.name)}${m.note ? ' — ' + esc(m.note) : ''}</option>`).join('')}</optgroup>`).join('');
}
function defaultModel() {
  const saved = lsGet('jarvis.chatModel', '');
  if (saved && C.models.some(m => m.spec === saved && m.ok)) return saved;
  return (C.models.find(m => m.spec === 'claude-sonnet-5-5') || C.models.find(m => m.ok) || {}).spec || '';
}
async function newTalk() {
  try { const t = await api('/talks', { body: { model: ($('#tkModel') && $('#tkModel').value) || defaultModel() } }); C.q = ''; $('#tkSearch').value = ''; await loadList(); await open(t.id); $('#tkInput').focus(); }
  catch (e) { window.toast(e.message, true); }
}
async function open(id) {
  try { C.talk = await api('/talks/' + id); } catch (e) { window.toast(e.message, true); return; }
  lsSet('jarvis.talk', id);
  renderList(); renderTalk();
}
function msgHtml(m, i, last) {
  if (m.role === 'user') return `<div class="tk-msg user"><div class="tk-bubble" dir="auto">${esc(m.content).replace(/\n/g, '<br>')}</div></div>`;
  const meta = [m.model && (window.prettyModel ? window.prettyModel(m.model) : m.model), m.via && m.via !== m.model ? 'آفلاین: ' + m.via.replace(/^ollama:/, '') : '', m.ms && !m.pending ? faN((m.ms / 1000).toFixed(1)) + ' ثانیه' : '', m.stopped ? 'متوقف شد' : ''].filter(Boolean).join(' · ');
  return `<div class="tk-msg bot ${m.error ? 'err' : ''}" data-i="${i}"><div class="tk-av">${ic('sparkles', 'sm')}</div><div class="tk-body">
    <div class="tk-text md">${m.error ? `<p class="bad">${esc(m.error)}</p>` : m.pending && !m.content ? '<span class="tk-dots"><i></i><i></i><i></i></span>' : md(m.content)}</div>
    <div class="tk-meta"><span class="help" dir="auto">${esc(meta)}</span>${!m.pending && m.content ? `<button type="button" class="icon-btn sm" data-copy="${i}" title="کپی" aria-label="کپی">${ic('copy', 'sm')}</button>` : ''}${last && !m.pending ? `<button type="button" class="icon-btn sm" data-regen="1" title="جواب دوباره" aria-label="جواب دوباره">${ic('refresh-cw', 'sm')}</button>` : ''}</div></div></div>`;
}
function renderTalk() {
  const t = C.talk;
  $('#tkTitle').textContent = t ? t.title : 'چت';
  $('#tkModel').innerHTML = modelOptions(t && t.model ? t.model : defaultModel());
  $('#tkDel').disabled = $('#tkExport').disabled = !t;
  const box = $('#tkStream');
  if (!t || !t.messages.length) {
    box.innerHTML = `<div class="tk-empty">${ic('messages-square')}<h3>با هر مدلی گفتگو کنید</h3><p class="help">Claude، Gemini، Grok، DeepSeek یا مدل‌های آفلاین Ollama — مدل را از بالا انتخاب کنید. وقتی اینترنت قطع است، جواب با مدل آفلاین می‌آید.</p>
      <div class="tk-sugg">${['یک برنامه‌ی ورزشی سه‌روزه برایم بنویس', 'Explain how HTTPS works in simple terms', 'این متن را خلاصه کن:', 'یک ایمیل رسمی برای مرخصی بنویس'].map(s => `<button type="button" class="btn btn-sm" data-sugg="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
    box.querySelectorAll('[data-sugg]').forEach(b => b.onclick = () => { $('#tkInput').value = b.dataset.sugg; $('#tkInput').focus(); });
  } else {
    const lastBot = t.messages.length - 1;
    box.innerHTML = t.messages.map((m, i) => msgHtml(m, i, i === lastBot && m.role === 'assistant')).join('');
  }
  busy(!!(t && t.running));
  foot();
  box.scrollTop = box.scrollHeight;
}
function foot() {
  const m = C.models.find(x => x.spec === $('#tkModel').value);
  $('#tkFoot').textContent = m ? (m.local ? 'این مدل روی همین کامپیوتر اجرا می‌شود؛ پیام‌ها بیرون نمی‌روند.' : `پیام‌ها به ${m.group} فرستاده می‌شوند.`) : '';
}
function busy(on) { $('#tkStop').hidden = !on; $('#tkSend').disabled = on; }
async function sendMsg() {
  const inp = $('#tkInput'); const text = inp.value.trim(); if (!text) return;
  if (!C.talk) { try { const t = await api('/talks', { body: { model: $('#tkModel').value || defaultModel() } }); C.talk = await api('/talks/' + t.id); lsSet('jarvis.talk', t.id); } catch (e) { window.toast(e.message, true); return; } }
  if (C.talk.running) return;
  inp.value = ''; inp.style.height = 'auto';
  try { await api(`/talks/${C.talk.id}/send`, { body: { text, model: $('#tkModel').value } }); }
  catch (e) { window.toast(e.message, true); inp.value = text; }
}

// ---- live events ----
window.addEventListener('jarvis:ev', async e => {
  const ev = e.detail; if (!ev || !C.built) return;
  if (ev.type === 'talk') { const i = C.list.findIndex(t => t.id === ev.talk.id); if (i >= 0) C.list[i] = { ...C.list[i], ...ev.talk }; else if (!C.q) C.list.unshift(ev.talk); C.list.sort((a, b) => b.updatedAt - a.updatedAt); renderList(); }
  if (ev.type === 'talkRemoved') { C.list = C.list.filter(t => t.id !== ev.id); renderList(); }
  if (!C.talk || ev.id !== C.talk.id) return;
  if (ev.type === 'talkStart') { try { C.talk = await api('/talks/' + ev.id); } catch {} renderTalk(); busy(true); }
  if (ev.type === 'talkDelta') {
    const m = C.talk.messages[C.talk.messages.length - 1]; if (!m || m.role !== 'assistant') return;
    m.content += ev.text;
    const node = $('#tkStream').lastElementChild && $('#tkStream').lastElementChild.querySelector('.tk-text');
    if (node) { node.innerHTML = md(m.content); const box = $('#tkStream'); if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight; }
  }
  if (ev.type === 'talkDone') { try { C.talk = await api('/talks/' + ev.id); } catch {} renderTalk(); if (ev.message && ev.message.error) window.toast(ev.message.error, true); }
});

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('chat', { icon: 'messages-square', label: 'چت', enter, leave() {} });
