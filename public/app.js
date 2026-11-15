'use strict';
const $ = s => document.querySelector(s);
const S = {
  projects: [], settings: {}, agents: {}, subagents: [], skills: [], versions: {}, clis: {},
  projectId: localStorage.getItem('jarvis.project') || null,
  chats: [], chat: null, running: new Set(), queue: {}, delivered: new Set(),
};

window.JARVIS_STATE = S; // read by dashboard.js
S.attach = []; S.previews = {};

// ---------- utils ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Access token (only needed when "requireToken" is on): taken from ?token= once, then kept locally.
(() => {
  const u = new URL(location.href), t = u.searchParams.get('token');
  if (t) { try { localStorage.setItem('jarvis.token', t); } catch {} u.searchParams.delete('token'); history.replaceState(null, '', u.pathname + u.search); }
})();
const token = () => { try { return localStorage.getItem('jarvis.token') || ''; } catch { return ''; } };
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Jarvis': '1', 'X-Jarvis-Token': token() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) {
    const t = prompt('این جارویس توکن دسترسی می‌خواهد. توکن را وارد کنید (در ترمینال سرور یا فایل data/token):');
    if (t && t.trim()) { localStorage.setItem('jarvis.token', t.trim()); return api(path, opts); }
  }
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, data: j });
  return j;
}
function toast(msg, err) {
  const d = document.createElement('div');
  d.className = 'toast' + (err ? ' err' : '');
  d.textContent = msg;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), 4500);
}
const fmtTime = ts => new Date(ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
const STATUS = { idle: 'آماده', running: 'در حال اجرا', done: 'تمام شد', error: 'خطا', stopped: 'متوقف', 'needs-attention': 'نیاز به بررسی', unverified: 'تست‌نشده', budget: 'سقف هزینه', waiting: 'منتظر سهمیه' };
const AGENT = { claude: 'Claude', codex: 'Codex', user: 'شما', system: 'جارویس' };
// SVG icon from the local Lucide sprite (public/icons.svg).
const ic = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="icons.svg#i-${name}"/></svg>`;
// Server status lines start with an emoji; show a matching SVG icon instead.
const EMOJI_ICON = { '🕸': 'network', '🧭': 'compass', '📨': 'inbox', '⚠': 'triangle-alert', '⏳': 'hourglass', '🌿': 'git-branch', '💰': 'wallet', '✔': 'circle-check', '✅': 'circle-check', '🧩': 'puzzle', '💾': 'save', '📊': 'chart-column', '❌': 'circle-x', '💡': 'lightbulb' };
function iconText(t) {
  const s = String(t ?? '');
  const m = s.match(/^\s*(\p{Extended_Pictographic}|✔)\uFE0F?\s*/u);
  return m && EMOJI_ICON[m[1]] ? { icon: EMOJI_ICON[m[1]], text: s.slice(m[0].length) } : { icon: null, text: s };
}

// Minimal, safe markdown: escape first, then format.
// Small local syntax highlighter (no dependencies): comments, strings, numbers, keywords.
const KW = new Set('async await break case catch class const continue def default delete do elif else enum except export extends false finally for from function if import in instanceof interface is lambda let new None not null of or pass private public raise return self static super switch this throw true True False try type typeof undefined var void while with yield fn pub mut impl use struct match package func go defer'.split(' '));
const HASH_COMMENT = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'ps1', 'powershell', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'r', 'dockerfile', 'makefile', 'ini', 'conf']);
function highlight(code, lang) {
  const re = HASH_COMMENT.has(lang)
    ? /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g
    : /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += `<span class="tk-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tk-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tk-n">${esc(m[3])}</span>`;
    else out += KW.has(m[4]) ? `<span class="tk-k">${esc(m[4])}</span>` : esc(m[4]);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

function md(src) {
  const blocks = [];
  const langs = [];
  let s = String(src || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => { blocks.push(code.replace(/\n$/, '')); langs.push(lang.toLowerCase()); return `\u0000${blocks.length - 1}\u0000`; });
  s = esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,4} (.+)$/gm, '<h4>$1</h4>');
  const lines = s.split('\n'); const out = []; let list = null;
  for (const ln of lines) {
    const m = ln.match(/^\s*([-*]|\d+\.) (.*)$/);
    if (m) { const t = /\d/.test(m[1]) ? 'ol' : 'ul'; if (list !== t) { if (list) out.push(`</${list}>`); out.push(`<${t}>`); list = t; } out.push(`<li>${m[2]}</li>`); continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    out.push(ln.trim() ? `<p dir="auto">${ln}</p>` : '');
  }
  if (list) out.push(`</${list}>`);
  return out.join('').replace(/<p dir="auto">\u0000(\d+)\u0000<\/p>|\u0000(\d+)\u0000/g, (_, a, b) => { const i = a ?? b; return `<div class="code"><button type="button" class="copy" data-copy="${esc(encodeURIComponent(blocks[i]))}" title="کپی" aria-label="کپی کد">${ic('copy', 'sm')}</button><pre><code>${highlight(blocks[i], langs[i])}</code></pre></div>`; });
}

// ---------- rendering: sidebar ----------
function renderProjects() {
  const ul = $('#projectList');
  if (!S.projects.length) { ul.innerHTML = '<li class="empty">هنوز پروژه‌ای اضافه نشده.</li>'; }
  else ul.innerHTML = S.projects.map(p => `<li data-id="${esc(p.id)}" class="${p.id === S.projectId ? 'active' : ''}" title="${esc(p.path)}">
      ${ic(p.id === S.projectId ? 'folder-open' : 'folder')}<span class="name">${esc(p.name)}</span><button class="x" data-del="${esc(p.id)}" title="حذف از لیست" aria-label="حذف ${esc(p.name)} از لیست">${ic('x', 'sm')}</button></li>`).join('');
  $('#btnNewChat').disabled = !S.projectId;
  renderHomeCommand();
}
async function renderProjectInfo() {
  const box = $('#projectInfo');
  const p = S.projects.find(x => x.id === S.projectId);
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="path">${esc(p.path)}</div><div>در حال خواندن…</div>`;
  try {
    const i = await api(`/projects/${p.id}/info`);
    box.innerHTML = `<div class="path">${esc(p.path)}</div>
      ${!i.exists ? `<div class="pi-line pi-bad">${ic('circle-x')}پوشه وجود ندارد!</div>` : i.git
        ? `${i.testCommand ? `<div class="pi-line">${ic('list-checks')}تست: <code dir="ltr">${esc(i.testCommand)}</code>${(S.settings || {}).testCommand || p.settings && p.settings.testCommand ? '' : ' <span class="help">(خاموش — در تنظیمات پروژه روشن کنید)</span>'}</div>` : ''}<div class="pi-line">${ic('git-branch')}<b dir="ltr">${esc(i.branch)}</b> · ${i.changes.toLocaleString('fa-IR')} فایل تغییر کرده</div><div class="path">${esc(i.lastCommit)}</div>`
        : `<div class="pi-line pi-warn">${ic('triangle-alert')}گیت نیست — نقطه‌ی بازگشت و نمایش تغییرات غیرفعال است.</div>`}
      <div class="row-gap">
        <button class="btn small ghost" data-psettings="1" title="تنظیمات اختصاصی همین پروژه">${ic('sliders-horizontal')}تنظیمات پروژه${p.settings ? ' •' : ''}</button>
        <button class="btn small ghost" data-rules="1" title="ویرایش CLAUDE.md و AGENTS.md (قوانینی که هر دو ایجنت می‌خوانند)">${ic('file-text')}قوانین پروژه</button>
        <button class="btn small ghost" data-preview="1" title="اجرای سرور توسعه‌ی پروژه و دیدن نتیجه">${ic('play')}پیش‌نمایش${S.previews && S.previews[p.id] && S.previews[p.id].running ? ' •' : ''}</button>
      </div>`;
  } catch (e) { box.innerHTML = `<div class="path">${esc(p.path)}</div><div>${esc(e.message)}</div>`; }
}
function renderAgents() {
  const a = S.agents || {}, v = S.versions || {};
  const busy = n => (a[n] && a[n].busy) > 0;
  const dot = n => !S.clis[n] ? 'off' : busy(n) ? 'busy' : (n === 'codex' && a.codex && a.codex.limitHit) ? 'warn' : 'on';
  $('#agentChips').innerHTML = ['claude', 'codex'].map(n => `<span class="chip"><span class="dot ${dot(n)}"></span>${AGENT[n]}${busy(n) ? ' · مشغول' : ''}</span>`).join('');
  const card = (n, role) => `<div class="agent-card ${n}">
      <div class="top"><span class="dot ${dot(n)}"></span>${AGENT[n]}<span class="ver">${esc(v[n] || (S.clis[n] ? '…' : 'not found'))}</span></div>
      <div class="role">${role}</div>
      <div class="model" dir="ltr">${esc(n === 'claude' ? prettyModel((S.settings || {}).builderModel) || 'Claude CLI default' : prettyModel((S.settings || {}).codexModel || S.codexDefaultModel) || 'Codex default')}</div>
      ${busy(n) ? `<div class="act">${ic('zap', 'sm')}${esc(a[n].last || '')}</div>` : `<div class="act">${ic('circle-check', 'sm')}آماده</div>`}
      ${n === 'codex' && a.codex && a.codex.limitHit ? `<div class="warn">${ic('triangle-alert', 'sm')}<span>${esc(a.codex.limitHit).slice(0, 160)}</span></div>` : ''}
    </div>`;
  const roleOf = n => { const b = roleAgent('builder'), r = roleAgent('reviewer'); const who = n === 'claude' ? 'Claude' : 'Codex'; const roles = [b.provider ? null : (b.name === who ? 'سازنده' : null), r.provider ? null : (r.name === who ? 'تستر اصلی' : null)].filter(Boolean); return roles.length ? 'الان: ' + roles.join(' و ') : 'الان نقشی ندارد (برای ساب‌ایجنت‌ها یا جایگزینی در دسترس است)'; };
  $('#agentCards').innerHTML = card('claude', roleOf('claude')) + card('codex', roleOf('codex'));
  $('#reactor').classList.toggle('busy', busy('claude') || busy('codex'));
  document.documentElement.classList.toggle('agents-busy', busy('claude') || busy('codex'));
  const orb = (n, role) => {
    const ra = roleAgent(n === 'claude' ? 'builder' : 'reviewer');
    if (ra.provider) {
      const pv = ra.provider;
      return `<div class="orb-head"><span class="orb-dot ${pv.hasKey ? 'on' : 'warn'}"></span><b>${esc(pv.name)}</b><span class="orb-state">${pv.hasKey ? 'اتصال API' : 'کلید ندارد'}</span></div>
      <div class="orb-role">${n === 'claude' ? 'سازنده · کد را می‌نویسد و رفع می‌کند' : 'تستر · بررسی و تست می‌کند'}</div>
      <div class="orb-model" dir="ltr">${esc(ra.model)}</div><div class="orb-act">${esc(pv.kind === 'openai' ? 'موتور Codex' : 'موتور Claude Code')}</div>`;
    }
    const model = n === 'claude' ? prettyModel((S.settings || {}).builderModel) || 'Claude CLI' : prettyModel((S.settings || {}).codexModel || S.codexDefaultModel) || 'Codex CLI';
    const lim = a[n] && a[n].limitHit;
    const state = !S.clis[n] ? 'پیدا نشد' : (lim && lim.until) ? `منتظر سهمیه تا ${new Date(lim.until).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}` : busy(n) ? 'در حال کار' : (n === 'codex' && lim) ? 'سقف مصرف' : 'آماده';
    return `<div class="orb-head"><span class="orb-dot ${dot(n)}"></span><b>${AGENT[n]}</b><span class="orb-state">${state}</span></div>
      <div class="orb-role">${role}</div>
      <div class="orb-model" dir="ltr">${esc(model)}</div>
      <div class="orb-act">${busy(n) ? esc(a[n].last || '') : esc(v[n] || '')}</div>`;
  };
  homeEl('#orbClaude').innerHTML = orb('claude', 'سازنده · کد را می‌نویسد و رفع می‌کند');
  homeEl('#orbCodex').innerHTML = orb('codex', 'تستر · بررسی و تست می‌کند');
  renderRoles();
  homeEl('#orbClaude').classList.toggle('busy', busy('claude'));
  homeEl('#orbCodex').classList.toggle('busy', busy('codex'));
  const anyBusy = busy('claude') || busy('codex');
  homeEl('#homeState').textContent = anyBusy ? 'تیم در حال کار است' : (!S.clis.claude || !S.clis.codex) ? 'نیاز به اتصال' : 'همه‌ی سیستم‌ها آماده';
}

function renderHomeCommand() {
  const p = S.projects.find(x => x.id === S.projectId);
  homeEl('#homeProj').innerHTML = p ? `${ic('folder', 'sm')}<span>${esc(p.name)}</span>` : '';
  homeEl('#homeProj').hidden = !p;
  homeEl('#homeSteps').hidden = S.projects.length > 0;
  homeEl('#homeInput').placeholder = p ? `به جارویس بگویید در «${p.name}» چه بسازد یا چه چیزی را بررسی کند…` : 'اول یک پروژه اضافه کنید، بعد فرمان بدهید…';
}
function renderChats() {
  const ul = $('#chatList');
  if (S.searchQ) return renderSearch();
  const list = S.chats.filter(c => c.projectId === S.projectId);
  if (!S.projectId) { ul.innerHTML = '<li class="empty">یک پروژه انتخاب کنید.</li>'; return; }
  if (!list.length) { ul.innerHTML = '<li class="empty">گفتگویی نیست — «گفتگوی جدید» را بزنید.</li>'; return; }
  ul.innerHTML = list.map(c => `<li data-id="${esc(c.id)}" class="${S.chat && S.chat.id === c.id ? 'active' : ''}">
      <span class="dot ${c.status === 'running' ? 'busy' : c.status === 'done' ? 'on' : ['error', 'stopped'].includes(c.status) ? 'off' : c.status === 'idle' ? '' : 'warn'}"></span>
      <span class="name" dir="auto">${esc(c.title)}</span><span class="sub">${fmtTime(c.updatedAt)}</span></li>`).join('');
}

// ---------- rendering: chat ----------
function renderChatHead() {
  const c = S.chat;
  $('#chatHead').hidden = !c; $('#composer').hidden = !c;
  if (!c) return;
  $('#chatTitle').textContent = c.title;
  const st = $('#chatStatus'); st.className = 'status-pill ' + c.status; st.textContent = STATUS[c.status] || c.status;
  const pro = S.claudeAuth === 'claude.ai';
  const usd = (c.cost?.claudeUsd || 0) + (c.cost?.otherUsd || 0);
  $('#chatCost').textContent = `هزینه: ${pro || c.cost?.otherUsd ? '≈' : ''}$${usd.toFixed(3)}${pro ? ' (معادل API)' : ''}${c.cost?.codexTokens ? ` · توکن حساب ChatGPT: ${c.cost.codexTokens.toLocaleString('fa-IR')}` : ''}`;
  $('#chatCost').title = pro ? 'با اشتراک Pro/Max پولی پرداخت نمی‌شود؛ این فقط تخمین هزینه‌ی همین کار با API است.' : '';
  const running = c.status === 'running';
  $('#btnStop').hidden = !running;
  const pending = S.queue[c.id] || 0;
  $('#btnSend').disabled = false;
  $('#btnSend').innerHTML = running ? `${ic('inbox')}<span>به صف${pending ? ` (${pending.toLocaleString('fa-IR')})` : ''}</span>` : `${ic('send', 'flip-rtl')}<span>ارسال</span>`;
  $('#btnSend').title = running ? 'تیم در حال کار است؛ پیام شما در مرحله‌ی بعدیِ سازنده به او تحویل داده می‌شود' : '';
  $('#input').placeholder = running
    ? 'تیم در حال کار است — هر دستور یا اصلاحی دارید بنویسید؛ در مرحله‌ی بعد به سازنده می‌رسد…'
    : 'به جارویس بگویید چه بسازد یا چه چیزی را بررسی کند…';
  $('#composer').classList.toggle('queueing', running);
}
function renderStream() {
  const st = $('#stream');
  st.innerHTML = '';
  if (!S.chat) { st.appendChild(welcomeEl); st.scrollTop = 0; window.JarvisDash && window.JarvisDash.show(); return; }
  window.JarvisDash && window.JarvisDash.hide();
  if (!S.chat.messages.length) st.innerHTML = `<div class="welcome"><p>دستور اول را بنویسید. در حالت «تیمی»، ${esc(roleAgent('builder').name)} کد را می‌نویسد و ${esc(roleAgent('reviewer').name)} تست و بررسی می‌کند تا همه‌چیز درست شود.</p></div>`;
  const msgs = S.chat.messages;
  const from = Math.max(0, msgs.length - (S.renderLimit || RENDER_PAGE));
  if (from > 0) {
    const more = document.createElement('div');
    more.className = 'sys load-older';
    more.innerHTML = `<button type="button" class="btn small ghost" id="btnOlder">${ic('arrow-up', 'sm')}نمایش ${fa(Math.min(from, RENDER_PAGE))} پیام قدیمی‌تر (${fa(from)} پیام پنهان)</button>`;
    st.appendChild(more);
    more.querySelector('button').onclick = () => {
      const h = st.scrollHeight;
      S.renderLimit = (S.renderLimit || RENDER_PAGE) + RENDER_PAGE;
      renderStream(true);
      st.scrollTop = st.scrollHeight - h;
    };
  }
  // Results of tools whose call is hidden are skipped with it.
  for (let i = from; i < msgs.length; i++) appendMessage(msgs[i], false);
  if (!arguments[0]) st.scrollTop = st.scrollHeight;
}
const RENDER_PAGE = 300;
const welcomeEl = $('#welcome');
// Home-screen nodes live inside #welcome, which is detached while a chat is open.
const homeEl = sel => welcomeEl.querySelector(sel);

function appendMessage(m, scroll = true) {
  const st = $('#stream');
  const nearBottom = st.scrollHeight - st.scrollTop - st.clientHeight < 160;
  if (st.querySelector('.welcome')) st.innerHTML = '';
  const el = buildMessage(m);
  if (!el) return;
  st.appendChild(el);
  if (scroll && nearBottom) st.scrollTop = st.scrollHeight;
}

function buildMessage(m) {
  const d = document.createElement('div');
  const agent = m.agent || 'system';
  const who = `<div class="who"><span class="tag ${agent}" dir="auto">${m.name ? esc(m.name) : (AGENT[agent] || agent)}</span>${m.sub ? `<span class="tag sub">${esc(m.sub)}</span>` : ''}${m.via ? `<span class="via">↳ ساب‌ایجنت ${esc(m.via)}</span>` : ''}${m.round ? `<span>دور ${m.round}</span>` : ''}<span>${fmtTime(m.ts)}</span></div>`;
  switch (m.kind) {
    case 'phase':
      d.className = 'phase';
      d.innerHTML = `<span class="tag ${agent}">${AGENT[agent] || agent}</span>${m.sub ? ` <span class="tag sub">${esc(m.sub)}</span>` : ''} ${esc(m.text)}`;
      return d;
    case 'text':
      d.className = `msg ${agent}${m.via ? ' nested' : ''}`;
      d.innerHTML = who + `<div class="bubble md">${agent === 'user' ? `<p dir="auto" style="white-space:pre-wrap">${esc(m.text)}</p>` : md(m.text)}${(m.attachments || []).length ? `<div class="msg-att">${m.attachments.map(f => `<img alt="تصویر پیوست" data-att="${esc(f)}" loading="lazy">`).join('')}</div>` : ''}</div>`;
      if ((m.attachments || []).length) setTimeout(() => d.querySelectorAll('img[data-att]').forEach(loadAttachment));
      if (m.queued) {
        d.dataset.qid = m.id;
        const done = S.delivered.has(m.id);
        d.querySelector('.who').insertAdjacentHTML('beforeend', `<span class="qtag ${done ? 'done' : ''}">${done ? 'تحویل شد' : 'در صف'}</span>`);
      }
      return d;
    case 'delivered':
      for (const id of m.ids || []) {
        S.delivered.add(id);
        const t = document.querySelector(`[data-qid="${CSS.escape(id)}"] .qtag`);
        if (t) { t.classList.add('done'); t.textContent = 'تحویل شد'; }
      }
      d.className = 'sys';
      d.innerHTML = `${ic('inbox')}<span class="status-text">${esc(iconText(m.text).text)}</span>`;
      return d;
    case 'tool': {
      d.className = 'msg ' + agent;
      const input = typeof m.input === 'string' ? m.input : JSON.stringify(m.input, null, 2);
      let firstLine = '';
      try {
        const o = typeof m.input === 'string' ? JSON.parse(m.input) : m.input;
        firstLine = o && (o.file_path || o.command || o.pattern || o.url || o.query || o.description || o.prompt) || '';
      } catch {}
      if (!firstLine) firstLine = (input || '').split('\n').find(l => l.trim()) || '';
      if (m.via) d.classList.add('nested');
      if (m.delegate) firstLine = `→ ${m.delegate}: ` + firstLine;
      d.innerHTML = `<details class="tool" data-tool="${esc(m.id || '')}"><summary>${ic(m.delegate ? 'bot' : /^(Bash|PowerShell|shell)$/.test(m.name) ? 'terminal' : /^(Read|Glob|Grep)$/.test(m.name) ? 'file-text' : /^(Edit|Write|MultiEdit|file_change)$/.test(m.name) ? 'pencil' : 'wrench', 'sm')}<span class="tag ${agent}">${AGENT[agent] || agent}</span><span class="tname">${esc(m.name)}</span><span class="tin">${esc(firstLine.slice(0, 200))}</span><span class="res"></span></summary><pre>${esc(input)}</pre></details>`;
      return d;
    }
    case 'tool_result': {
      const host = m.id && document.querySelector(`details.tool[data-tool="${CSS.escape(m.id)}"]`);
      const out = `<pre class="${m.isError ? 'res-err' : ''}">${esc(m.output || '(بدون خروجی)')}</pre>`;
      if (host) {
        host.insertAdjacentHTML('beforeend', out);
        host.querySelector('.res').innerHTML = m.isError ? `<span class="res-err" title="خطا">${ic('circle-x', 'sm')}</span>` : `<span class="res-ok" title="موفق">${ic('circle-check', 'sm')}</span>`;
        return null;
      }
      d.className = 'msg ' + agent;
      d.innerHTML = `<details class="tool"><summary><span class="tname">${esc(m.name || 'result')}</span><span class="${m.isError ? 'res-err' : 'res-ok'}">${ic(m.isError ? 'circle-x' : 'circle-check', 'sm')}</span></summary>${out}</details>`;
      return d;
    }
    case 'thinking':
      d.className = 'msg ' + agent;
      d.innerHTML = `<details class="thinking"><summary>${ic('brain', 'sm')}استدلال ${AGENT[agent]}</summary><div class="md">${md(m.text)}</div></details>`;
      return d;
    case 'review': return buildReview(m, who);
    case 'report': return buildReport(m);
    case 'tests': {
      const t = m.tests || {};
      d.className = 'msg system';
      d.innerHTML = `<div class="testcard ${t.ok ? 'ok' : 'bad'}"><div class="tc-head">${ic(t.ok ? 'circle-check' : 'circle-x')}<b>${t.ok ? 'تست‌های پروژه پاس شدند' : t.timedOut ? 'تست‌ها بیش از حد طول کشیدند' : 'تست‌های پروژه شکست خوردند'}</b><code dir="ltr">${esc(t.command)}</code><span class="help">${fa(Math.round((t.durationMs || 0) / 1000))} ثانیه</span></div>
        ${t.output ? `<details ${t.ok ? '' : 'open'}><summary>خروجی</summary><pre dir="ltr">${esc(t.output)}</pre></details>` : ''}</div>`;
      return d;
    }
    case 'smartplan': return window.buildSmartPlan ? buildSmartPlan(m) : null;
    case 'summary':
      d.className = 'msg system';
      d.innerHTML = `<div class="sumcard"><div class="tc-head">${ic('layers')}<b>خلاصه‌ی گفتگو</b><span class="help">از اینجا ایجنت‌ها با نشست تازه و همین خلاصه ادامه می‌دهند.</span></div><div class="md">${md(m.text)}</div></div>`;
      return d;
    case 'memory': {
      d.className = 'msg system';
      const items = m.items || [];
      d.innerHTML = `<div class="memcard" data-memproject="${esc(m.projectId || '')}"><div class="tc-head">${ic('lightbulb')}<b>پیشنهاد برای حافظه‌ی پروژه</b><span class="help">هر کدام را می‌خواهید تیک بزنید؛ به CLAUDE.md و AGENTS.md اضافه می‌شوند تا ایجنت‌ها دفعه‌ی بعد بدانند.</span></div>
        ${items.length ? `<div class="mem-list">${items.map((x, i) => `<label class="check"><input type="checkbox" data-memitem="${i}" checked> <span dir="auto">${esc(x)}</span></label>`).join('')}</div>
        <div class="row-gap"><button type="button" class="btn small primary" data-memsave="1">${ic('save', 'sm')}افزودن به قوانین پروژه</button></div>` : '<div class="help">پیشنهادی پیدا نشد.</div>'}</div>`;
      d.querySelector('.memcard').dataset.items = JSON.stringify(items);
      return d;
    }
    case 'checkpoint':
      d.className = 'sys';
      d.innerHTML = `${ic('save')}<span class="status-text">${esc(m.text)}</span><button class="btn small ghost" data-restore="${esc(m.checkpoint)}">${ic('rotate-ccw')}بازگشت به این نقطه</button>`;
      return d;
    case 'diffstat':
      d.className = 'sys';
      d.innerHTML = `${ic('chart-column')}<span class="status-text">خلاصه‌ی تغییرات پروژه</span><pre>${esc(m.text)}</pre>`;
      return d;
    case 'error':
      d.className = 'sys error';
      d.innerHTML = `${ic(iconText(m.text).icon || 'circle-x')}<span class="tag ${agent}">${AGENT[agent] || agent}</span><span class="status-text" dir="auto">${esc(iconText(m.text).text)}</span>`;
      return d;
    case 'status': default:
      d.className = 'sys';
      { const t = iconText(m.text); d.innerHTML = `${ic(t.icon || 'info')}<span class="tag ${agent}">${AGENT[agent] || agent}</span>${m.sub ? `<span class="tag sub">${esc(m.sub)}</span>` : ''}<span class="status-text" dir="auto">${esc(t.text)}</span>`; }
      return d;
  }
}

function buildReview(m, who) {
  const r = m.review || {};
  const d = document.createElement('div');
  d.className = 'msg ' + (m.agent || 'codex');
  const counts = ['critical', 'major', 'minor'].map(s => [s, (r.bugs || []).filter(b => b.severity === s).length]).filter(x => x[1]);
  d.innerHTML = who + `<div class="review ${r.verdict}">
    <div class="verdict">${r.verdict === 'pass' ? `${ic('circle-check')}تأیید شد` : `${ic('circle-x')}مشکل پیدا شد`} ${counts.map(([s, n]) => `<span class="sev ${s}">${n} ${s}</span>`).join(' ')}</div>
    <div dir="auto" class="review-sum">${esc(r.summary)}</div>
    ${(r.bugs || []).length ? `<h4>باگ‌ها</h4>` + r.bugs.map(b => `<div class="bug">
        <div class="bt"><span class="sev ${esc(b.severity)}">${esc(b.severity)}</span><b dir="auto">${esc(b.title)}</b>${b.by ? `<span class="by">(${esc(b.by)})</span>` : ''}${b.file ? `<span class="loc">${esc(b.file)}${b.line ? ':' + b.line : ''}</span>` : ''}</div>
        <div dir="auto">${esc(b.description)}</div>
        ${b.fix_hint ? `<div class="hint" dir="auto">${ic('lightbulb', 'sm')}<span>${esc(b.fix_hint)}</span></div>` : ''}</div>`).join('') : ''}
    ${(r.tests_run || []).length ? `<h4>تست‌های اجراشده</h4><div class="tests">${r.tests_run.map(t => `<div><b>$ ${esc(t.command)}</b> → ${esc(t.result)}</div>`).join('')}</div>` : ''}
  </div>`;
  return d;
}

// ---------- data flow ----------
async function loadState() {
  const s = await api('/state');
  Object.assign(S, { skills: s.skills || [], defaults: s.defaults || {}, queue: s.queues || {}, subagents: s.subagents || [], projects: s.projects, settings: s.settings, agents: s.agents, versions: s.versions, clis: s.clis, codexDefaultModel: s.codexDefaultModel, claudeAuth: s.claudeAuth || null, providers: s.providers || [], providerPresets: s.providerPresets || [], modelCatalog: (s.modelCatalog && s.modelCatalog.claude) || [] });
  if (S.projectId && !S.projects.some(p => p.id === S.projectId)) S.projectId = null;
  if (!S.projectId && S.projects[0]) S.projectId = S.projects[0].id;
  Object.assign(S, { connectors: s.connectors || [], plugins: s.plugins || [], pluginCommands: s.pluginCommands || [], connectorCatalog: s.connectorCatalog || [], queueJobs: s.queueJobs || [] });
  S.chats = await api('/chats');
  if (window.renderExtBadges) renderExtBadges();
  renderProjects(); renderAgents(); renderSubagents(); renderChats(); renderProjectInfo(); renderQuick();
  const last = localStorage.getItem('jarvis.chat');
  if (last && S.chats.some(c => c.id === last && c.projectId === S.projectId)) openChat(last);
}
function selectProject(id) {
  S.projectId = id; localStorage.setItem('jarvis.project', id);
  if (S.chat && S.chat.projectId !== id) { S.chat = null; renderChatHead(); renderStream(); }
  renderProjects(); renderChats(); renderProjectInfo();
  if (!S.chat && window.JarvisDash) window.JarvisDash.show();
}
async function openChat(id) {
  S.chat = await api('/chats/' + id);
  S.renderLimit = 0;
  localStorage.setItem('jarvis.chat', id);
  renderChats(); renderChatHead(); renderStream(); renderModelBar(); renderQuick(); clearAttachments(); renderPresets();
  $('#sidebar').classList.remove('open');
  $('#input').focus();
}
async function newChat() {
  if (!S.projectId) return;
  const c = await api('/chats', { body: { projectId: S.projectId } });
  // A new chat starts with the models chosen last time.
  const last = lsGet('jarvis.models.last', null);
  if (last && Object.values(last).some(Boolean)) { try { c.models = (await api(`/chats/${c.id}/models`, { body: { models: last } })).models; } catch {} }
  if (!S.chats.some(x => x.id === c.id)) S.chats.unshift({ ...c, updatedAt: c.createdAt });
  await openChat(c.id);
}

let liveEs = null, liveRetry = null;
function connectEvents() {
  clearTimeout(liveRetry);
  if (liveEs) liveEs.close();
  // The token is read at connect time, so reconnecting picks up a token enabled later.
  const es = liveEs = new EventSource('/api/events' + (token() ? '?token=' + encodeURIComponent(token()) : ''));
  es.onopen = () => { if (S.liveLost) { S.liveLost = false; toast('اتصال زنده دوباره برقرار شد'); loadState().catch(() => {}); } };
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    window.dispatchEvent(new CustomEvent('jarvis:ev', { detail: ev })); // ops room, etc.
    switch (ev.type) {
      case 'message':
        if (S.chat && S.chat.id === ev.chatId) {
          if (ev.message.kind === 'text' && ev.message.agent === 'claude') liveDelta({ type: 'delta_reset', chatId: ev.chatId });
          S.chat.messages.push(ev.message); appendMessage(ev.message);
        }
        break;
      case 'chat': {
        const i = S.chats.findIndex(c => c.id === ev.chat.id);
        if (i >= 0) S.chats[i] = ev.chat; else S.chats.unshift(ev.chat);
        S.chats.sort((a, b) => b.updatedAt - a.updatedAt);
        if (S.chat && S.chat.id === ev.chat.id) { Object.assign(S.chat, { status: ev.chat.status, title: ev.chat.title, cost: ev.chat.cost }); renderChatHead(); }
        renderChats();
        break;
      }
      case 'chatDeleted':
        S.chats = S.chats.filter(c => c.id !== ev.chatId);
        if (S.chat && S.chat.id === ev.chatId) { S.chat = null; renderChatHead(); renderStream(); }
        renderChats();
        break;
      case 'agents': S.agents = ev.agents; renderAgents(); break;
      case 'providers': S.providers = ev.providers || []; renderAgents(); renderModelBar(); break;
      case 'preview': S.previews = S.previews || {}; S.previews[ev.projectId] = ev; if (S.previewOpen === ev.projectId) previewDialog(true); renderProjectInfo(); break;
      case 'usage': if (!S.chat && window.JarvisDash) window.JarvisDash.refresh(); break;
      case 'delta': case 'delta_reset': liveDelta(ev); break;
      case 'settings': S.settings = ev.settings; break;
      case 'subagents': S.subagents = ev.subagents; renderSubagents(); break;
      case 'skills': S.skills = ev.skills; break;
      case 'versions': S.versions = ev.versions; renderAgents(); break;
      case 'projects': S.projects = ev.projects; renderProjects(); break;
      case 'queue': S.queue[ev.chatId] = ev.pending; if (S.chat && S.chat.id === ev.chatId) renderChatHead(); break;
      case 'finished': onFinished(ev); break;
      case 'msgUpdate':
        if (S.chat && S.chat.id === ev.chatId) {
          const i = S.chat.messages.findIndex(x => x.id === ev.message.id);
          if (i >= 0) { S.chat.messages[i] = ev.message; const st = $('#stream'), top = st.scrollTop; renderStream(); st.scrollTop = top; }
        }
        break;
      case 'ext': Object.assign(S, { connectors: ev.connectors || [], plugins: ev.plugins || [], pluginCommands: ev.pluginCommands || [] }); renderQuick(); if (window.onExtChanged) onExtChanged(); break;
      case 'queueJobs': S.queueJobs = ev.jobs || []; if (window.onQueueChanged) onQueueChanged(); break;
      case 'hello': break;
    }
  };
  // The browser retries on its own after a network drop, but gives up for good on an
  // HTTP error (e.g. 401 after the token was turned on). Then reconnect ourselves.
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) return;
    if (!S.liveLost) { S.liveLost = true; toast('اتصال زنده قطع شد — دوباره تلاش می‌کنم…', true); }
    liveRetry = setTimeout(connectEvents, 3000);
  };
}

function onFinished(ev) {
  const msg = `«${ev.title}» — ${STATUS[ev.status] || ev.status}`;
  toast('جارویس: ' + msg, ev.status === 'error');
  if (S.settings.notify && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification('JARVIS', { body: msg });
  }
  if (S.settings.speak && 'speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(ev.status === 'done' ? 'کار تمام شد و تستر تأیید کرد.' : 'کار متوقف شد. لطفاً بررسی کنید.');
    u.lang = 'fa-IR';
    speechSynthesis.speak(u);
  }
}

// ---------- dialogs ----------
function dialog(html, wide) {
  const dlg = $('#dlg');
  dlg.className = wide ? 'wide' : '';
  $('#dlgBody').onclick = null; // drop the previous dialog's click handler
  $('#dlgBody').innerHTML = html;
  if (!dlg.open) dlg.showModal();
  return dlg;
}
// Every dialog = a scrolling content area + a fixed action bar at the bottom.
// (A sticky footer drifted into the middle of the form when focusing a lower field
// scrolled the dialog itself.) Runs for any content put into #dlgBody, including
// dialogs that replace its innerHTML later.
function layoutDialog() {
  const body = $('#dlgBody');
  const loose = [...body.children].filter(c => !c.classList.contains('dlg-scroll') && !c.classList.contains('dlg-actions'));
  if (!loose.length) return;
  const active = document.activeElement; // moving a focused element blurs it
  let scroll = body.querySelector(':scope > .dlg-scroll');
  if (!scroll) { scroll = document.createElement('div'); scroll.className = 'dlg-scroll'; body.prepend(scroll); }
  for (const c of loose) scroll.appendChild(c);
  const actions = body.querySelector(':scope > .dlg-scroll > .dlg-actions');
  if (actions) body.appendChild(actions);
  // Put the cursor where the user will type: the previously focused field, else the
  // first text field of the dialog (so typing works right after it opens).
  if (active && body.contains(active) && active !== document.body) active.focus({ preventScroll: true });
  else if ($('#dlg').open) {
    const first = body.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not(:disabled), textarea:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }
}
new MutationObserver(layoutDialog).observe($('#dlgBody'), { childList: true });
function addProjectDialog(prefill = '') {
  dialog(`<h3>افزودن پروژه</h3>
    <div class="field"><label>مسیر پوشه‌ی پروژه</label><input id="fPath" dir="ltr" placeholder="C:\\Users\\you\\code\\my-app" value="${esc(prefill)}" required></div>
    <div class="field"><label>نام (اختیاری)</label><input id="fName"></div>
    <div class="dlg-actions"><button class="btn primary" value="ok" id="fOk">افزودن</button><button class="btn ghost" value="cancel" formnovalidate>انصراف</button></div>`);
  $('#fOk').onclick = async e => {
    e.preventDefault();
    try {
      const p = await api('/projects', { body: { path: $('#fPath').value.trim(), name: $('#fName').value.trim() || undefined } });
      $('#dlg').close();
      if (!S.projects.some(x => x.id === p.id)) S.projects.push(p);
      selectProject(p.id);
    } catch (err) { toast(err.message, true); }
  };
}
async function discoverDialog() {
  dialog(`<h3>${ic('folder-search')}کشف پروژه‌ها</h3><div class="help">در حال جستجو در تاریخچه‌ی Claude و Codex…</div>`);
  const list = await api('/discover').catch(() => []);
  $('#dlgBody').innerHTML = `<h3>کشف پروژه‌ها</h3>
    ${list.length ? list.map((p, i) => `<div class="discover-item"><b>${esc(p.name)}</b><span class="p">${esc(p.path)}</span><span class="sub">${p.sources.join('+')}</span><button class="btn small" data-add="${i}">افزودن</button></div>`).join('') : '<div>پروژه‌ی جدیدی پیدا نشد.</div>'}
    <div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`;
  $('#dlgBody').onclick = async e => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    e.preventDefault();
    const p = await api('/projects', { body: { path: list[+b.dataset.add].path } });
    if (!S.projects.some(x => x.id === p.id)) S.projects.push(p);
    b.disabled = true; b.textContent = '✓';
    selectProject(p.id);
  };
}
// ---------- settings (data-driven; global or per project) ----------
const MODEL_HELP = 'یکی از مدل‌های Claude، یا «سفارشی…» برای هر شناسه‌ی دیگر؛ پیش‌فرض = مدل پیش‌فرض Claude CLI';
const EFFORTS = [['', 'پیش‌فرض'], ['low', 'low — سریع و ارزان'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max — کند و گران']];
const SETTINGS_SCHEMA = [
  { title: 'سرعت و هزینه', icon: 'gauge', fields: [
    { k: 'leanMode', t: 'bool', l: 'حالت سبک: بدون MCP، اسکیل‌ها و هوک‌های کاربر؛ فقط ابزارهای لازم هر نقش', h: 'در تست‌ها هزینه‌ی هر فراخوانی را نصف و سرعت را دو برابر کرد. اگر Claude به یک سرور MCP نیاز دارد خاموشش کنید.' },
    { k: 'maxRunCostUsd', t: 'number', step: 0.5, l: 'سقف هزینه‌ی Claude برای هر اجرا (دلار، ۰ = بدون سقف)', h: 'وقتی پر شود کار متوقف می‌شود. با اشتراک Pro/Max این سقف خاموش است، چون پولی پرداخت نمی‌شود (گزینه‌ی بعدی).' },
    { k: 'codexPriceIn', t: 'number', step: 0.05, l: 'قیمت ورودی Codex برای هر ۱ میلیون توکن (دلار، برای نمودار هزینه)', h: 'Codex با اشتراک ChatGPT دلاری گزارش نمی‌دهد. اگر قیمت API مدل Codex را وارد کنید، نمودار «Claude در برابر ChatGPT» هزینه‌ی تخمینی را هم نشان می‌دهد. ۰ = فقط توکن.' },
    { k: 'codexPriceCached', t: 'number', step: 0.01, l: 'قیمت ورودی کش‌شده‌ی Codex برای هر ۱ میلیون توکن (دلار)' },
    { k: 'codexPriceOut', t: 'number', step: 0.05, l: 'قیمت خروجی Codex برای هر ۱ میلیون توکن (دلار)' },
    { k: 'budgetOnSubscription', t: 'bool', l: 'سقف هزینه روی اشتراک Pro/Max هم اعمال شود', h: 'روی اشتراک، دلارها فقط «معادل API» هستند. روشنش کنید اگر می‌خواهید کارهای خیلی سنگین هم زودتر متوقف شوند.' },
    { k: 'onClaudeLimit', t: 'select', l: 'وقتی سهمیه‌ی Claude (Pro/Max) پر شد', o: [['wait', 'صبر کن و بعد از تمدید با Claude ادامه بده'], ['codex', 'Codex جای Claude کد بنویسد تا سهمیه تمدید شود']], h: 'در حالت Codex، نوشتن و رفع کد به Codex سپرده می‌شود و بررسی همچنان با Codex است؛ بعد از ساعت تمدید، Claude دوباره سازنده می‌شود. اگر سهمیه‌ی Codex هم پر باشد، صبر می‌کند.' },
    { k: 'waitOnLimit', t: 'bool', l: 'وقتی سهمیه‌ی Pro پر شد، صبر کن و بعد از تمدید خودکار ادامه بده', h: 'کار متوقف نمی‌شود؛ گفتگو «منتظر سهمیه» می‌شود و سر ساعت تمدید از همان‌جا ادامه می‌دهد. «توقف» آن را لغو می‌کند.' },
    { k: 'limitMaxWaitHours', t: 'number', step: 1, l: 'حداکثر زمان انتظار برای تمدید سهمیه (ساعت)' },
    { k: 'specialistsTiming', t: 'select', l: 'زمان اجرای ساب‌ایجنت‌های تستر', o: [['after-pass', 'فقط بعد از تأیید تستر اصلی (ارزان‌تر)'], ['every-round', 'هر دور، موازی با تستر اصلی (سریع‌تر، گران‌تر)']] },
    { k: 'reviewDiffChars', t: 'number', step: 5000, l: 'حداکثر طول diff که به تستر داده می‌شود (کاراکتر، ۰ = خاموش)', h: 'تستر به‌جای گشتن دنبال تغییرات، مستقیم diff همین اجرا را می‌بیند → سریع‌تر و ارزان‌تر.' },
    { k: 'liveStreaming', t: 'bool', l: 'نمایش زنده‌ی متن سازنده هنگام نوشتن' },
    { k: 'useGraphify', t: 'bool', l: 'گراف کد graphify: ایجنت‌ها به‌جای جستجو و خواندن کل فایل‌ها از گراف پروژه استفاده کنند', h: 'گراف کاملاً محلی و بدون LLM ساخته می‌شود (tree-sitter). نیاز به نصب: uv tool install graphifyy' },
    { k: 'graphifyAutoUpdate', t: 'bool', l: 'به‌روزرسانی خودکار گراف قبل از هر اجرا و هر دور بررسی' },
    { k: 'graphifyBudget', t: 'number', step: 250, l: 'سقف توکن پاسخ هر پرس‌وجوی گراف' },
    { k: 'graphifyPreQuery', t: 'bool', l: 'جارویس خودش قبل از شروع از گراف بپرسد و مکان‌های مرتبط (فایل:خط) را به ایجنت‌ها بدهد', h: 'آزمایشی. در تست ما روی Flask باعث شد Claude فایل‌های بیشتری بخواند (+۴۴٪ هزینه)، برای همین پیش‌فرض خاموش است. روی پروژه‌های خیلی بزرگ و ناآشنا امتحانش کنید و نتیجه را در داشبورد مقایسه کنید.' },
  ] },
  { title: 'مدل‌ها', icon: 'brain', fields: [
    { k: 'builderModel', t: 'model', m: 'claude', l: 'مدل سازنده (نوشتن و رفع کد)', h: MODEL_HELP, ph: 'sonnet' },
    { k: 'builderEffort', t: 'select', l: 'میزان فکر سازنده', o: EFFORTS },
    { k: 'reviewerModel', t: 'model', m: 'claude', l: 'مدل تستر وقتی «تستر اصلی» روی Claude است', h: MODEL_HELP, ph: 'sonnet' },
    { k: 'reviewerEffort', t: 'select', l: 'میزان فکر تستر', o: EFFORTS },
    { k: 'builderFallback', t: 'model', m: 'claude', l: 'جایگزین سازنده وقتی خطا داد', h: 'اگر سازنده خطا داد (قطعی سرویس، سقف مصرف، کلید)، همان مرحله یک بار با این مدل دوباره انجام می‌شود. پیش‌فرض = بدون جایگزین.' },
    { k: 'reviewerFallback', t: 'model', m: 'codex', l: 'جایگزین تستر وقتی جوابی نداد', h: 'اگر تستر اصلی گزارشی نداد، بررسی یک بار با این مدل تکرار می‌شود.' },
    { k: 'teamPresets', t: 'lines', l: 'ترکیب‌های ذخیره‌شده (هر خط: نام | سازنده | تستر)', h: 'با «ذخیره‌ی ترکیب فعلی…» در پایین کادر پیام اضافه می‌شوند. برای حذف، خطش را پاک کنید.' },
    { k: 'specialistModel', t: 'model', m: 'claude', l: 'مدل ساب‌ایجنت‌هایی که «اجرا با: Claude» دارند', h: 'هر ساب‌ایجنت را می‌توانید در ویرایش خودش روی هر مدل یا اتصالی بگذارید.', ph: 'haiku' },
    { k: 'specialistEffort', t: 'select', l: 'میزان فکر ساب‌ایجنت‌ها', o: EFFORTS },
    { k: 'codexModel', t: 'model', m: 'codex', l: 'مدل تستر اصلی (Codex یا یکی از اتصال‌ها)', h: 'پیش‌فرض = مدل تنظیم‌شده در ~/.codex/config.toml. اتصال‌هایی مثل DeepSeek هم اینجا هستند.' },
    { k: 'codexEffort', t: 'select', l: 'میزان فکر Codex', o: [['', 'پیش‌فرض'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']] },
  ] },
  { title: 'حالت هوشمند', icon: 'sparkles', fields: [
    { k: 'routerModel', t: 'model', m: 'claude', l: 'برنامه‌ریز (تقسیم کار)', h: 'یک مدل ارزان و سریع پیام را می‌خواند و کار را به چند بخش با سطح سختی تقسیم می‌کند.' },
    { k: 'routeHard', t: 'model', m: 'claude', l: 'بخش‌های سخت (طراحی، الگوریتم، امنیت)' },
    { k: 'routeMedium', t: 'model', m: 'claude', l: 'بخش‌های متوسط (کد معمولی و رفع باگ)', h: 'رفع باگ‌های گزارش‌شده‌ی تستر هم با همین مدل انجام می‌شود.' },
    { k: 'routeEasy', t: 'model', m: 'claude', l: 'بخش‌های ساده (تست، مستندات، تنظیمات)' },
    { k: 'smartAutoApprove', t: 'bool', l: 'برنامه‌ی تقسیم کار خودکار اجرا شود', h: 'خاموش باشد، قبل از شروع کارت برنامه را نشان می‌دهد تا مدل هر بخش را عوض یا تأیید کنید.' },
  ] },
  { title: 'تست‌های پروژه', icon: 'list-checks', fields: [
    { k: 'testCommand', t: 'text', ltr: 1, ph: 'auto', l: 'دستور تست پروژه (auto = تشخیص خودکار، خالی = خاموش)', h: 'جارویس بعد از هر دور، تست‌های خود پروژه را اجرا می‌کند و نتیجه را به تستر می‌دهد. مثلاً auto، npm test یا python -m pytest. بهتر است در «تنظیمات پروژه» بگذارید.' },
    { k: 'testGate', t: 'bool', l: 'تا تست‌ها پاس نشده‌اند، کار تأیید نشود', h: 'اگر تست‌ها شکست بخورند، حتی اگر تستر تأیید کرده باشد، یک باگ «بحرانی» به فهرست رفع اضافه می‌شود.' },
    { k: 'testTimeoutSec', t: 'number', step: 30, l: 'حداکثر زمان اجرای تست‌ها (ثانیه)' },
  ] },
  { title: 'جریان کار تیمی', icon: 'handshake', fields: [
    { k: 'maxRounds', t: 'number', step: 1, l: 'حداکثر دورهای «تست ← رفع»' },
    { k: 'reviewer', t: 'select', l: 'تستر اصلی', o: [['codex', 'طبق «مدل تستر اصلی» (Codex یا یکی از اتصال‌ها)'], ['claude', 'Claude در نشست جداگانه']] },
    { k: 'fallbackToClaude', t: 'bool', l: 'اگر تستر Codex در دسترس نبود (مثلاً سقف مصرف)، Claude در نشستی جدا تست کند' },
    { k: 'codexSandbox', t: 'select', l: 'سندباکس تستر (موتور Codex) هنگام تست', o: [['workspace-write', 'workspace-write — می‌تواند تست اجرا کند'], ['read-only', 'read-only — فقط خواندن']] },
    { k: 'finalReport', t: 'bool', l: 'گزارش نهایی در پایان هر اجرا (هزینه، زمان، فایل‌ها، تست‌ها)' },
  ] },
  { title: 'ایمنی', icon: 'shield', fields: [
    { k: 'claudePermission', t: 'select', l: 'مجوز سازنده برای ویرایش فایل و اجرای دستور', o: [['acceptEdits', 'acceptEdits — ویرایش آزاد، فقط دستورات مجاز'], ['bypassPermissions', 'bypassPermissions — همه‌چیز بدون سؤال'], ['default', 'default — محدودترین']], h: 'bypassPermissions فقط برای پروژه‌هایی که به آن‌ها اعتماد دارید.' },
    { k: 'claudeAllowedBash', t: 'lines', l: 'دستوراتی که سازنده بدون تأیید اجرا می‌کند (هر خط یک پیشوند)', h: 'مثلاً «npm test» اجازه‌ی npm test و npm test -- --watch=false را می‌دهد.' },
    { k: 'projectLock', t: 'bool', l: 'قفل پروژه: در هر لحظه فقط یک اجرا روی هر پروژه (بقیه منتظر می‌مانند)' },
    { k: 'guardReviewerEdits', t: 'select', l: 'اگر تستر فایلی را تغییر داد', o: [['warn', 'هشدار بده'], ['revert', 'خودکار برگردان'], ['off', 'کاری نکن']] },
    { k: 'requireToken', t: 'bool', global: 1, l: 'توکن دسترسی لازم باشد (جلوی برنامه‌های دیگرِ همین کامپیوتر را می‌گیرد)', h: 'بعد از فعال شدن، فقط این مرورگر (و لینک چاپ‌شده در ترمینال) دسترسی دارد.' },
  ] },
  { title: 'گیت', icon: 'git-branch', fields: [
    { k: 'gitBranchPerChat', t: 'bool', l: 'هر چت روی شاخه‌ی جداگانه‌ی jarvis/… کار کند' },
    { k: 'autoCommit', t: 'bool', l: 'بعد از تأیید تستر خودکار commit کن' },
    { k: 'commitAsk', t: 'bool', l: 'قبل از commit از من تأیید بگیر', h: 'به‌جای commit خودکار، در گزارش پایان کار دکمه‌ی «commit» می‌آید تا اول تغییرات را ببینید.' },
  ] },
  { title: 'فرمان‌های آماده', icon: 'zap', fields: [
    { k: 'savedPrompts', t: 'lines', l: 'هر خط یک فرمان. برای عنوان کوتاه: «عنوان: متن فرمان»', h: 'بالای کادر پیام به‌صورت دکمه نشان داده می‌شوند. مثال: «تست کامل: همه‌ی تست‌ها را اجرا کن و هر باگی بود رفع کن»' },
  ] },
  { title: 'زمان‌بندی و پیش‌نمایش', icon: 'clock', fields: [
    { k: 'scheduleAuditAt', t: 'text', ltr: 1, projectOnly: 1, ph: '02:00', l: 'بازرسی خودکار روزانه‌ی این پروژه در ساعت (HH:MM، خالی = خاموش)', h: 'جارویس هر روز در این ساعت یک گفتگوی «بازرسی خودکار» می‌سازد. جارویس باید باز باشد (یا در پس‌زمینه). از سهمیه‌ی شما کم می‌کند؛ ساعت‌های شب بهترند.' },
    { k: 'scheduleAuditPrompt', t: 'long', projectOnly: 1, l: 'دستور بازرسی خودکار' },
    { k: 'previewCommand', t: 'text', ltr: 1, ph: 'npm run dev', l: 'دستور اجرای پیش‌نمایش پروژه', h: 'سرور توسعه‌ی پروژه را اجرا می‌کند تا نتیجه را داخل جارویس ببینید.' },
    { k: 'previewUrl', t: 'text', ltr: 1, ph: 'http://localhost:5173', l: 'آدرس پیش‌نمایش (خالی = از خروجی دستور پیدا شود)' },
  ] },
  { title: 'MCP', icon: 'puzzle', fields: [
    { k: 'mcpConfig', t: 'long', ltr: 1, ph: '{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }', l: 'سرورهای MCP برای Claude (JSON با کلید mcpServers)', h: 'در حالت سبک، MCPهای عمومی شما خاموش‌اند؛ فقط همین‌ها روشن می‌شوند. بهتر است در «تنظیمات پروژه» بگذارید تا هر پروژه MCP خودش را داشته باشد.' },
  ] },
  { title: 'اپ دسکتاپ', icon: 'panel-right', fields: [
    { k: 'desktopTray', t: 'bool', global: 1, l: 'با بستن پنجره، جارویس در پس‌زمینه (کنار ساعت ویندوز) بماند', h: 'کار ایجنت‌ها ادامه پیدا می‌کند و در پایان اعلان می‌آید. خروج کامل: راست‌کلیک روی آیکون کنار ساعت.' },
    { k: 'desktopStartup', t: 'bool', global: 1, l: 'با روشن شدن ویندوز، جارویس در پس‌زمینه اجرا شود' },
    { k: 'desktopAutoUpdate', t: 'bool', global: 1, l: 'به‌روزرسانی خودکار از GitHub', h: 'نسخه‌ی تازه در پس‌زمینه دانلود می‌شود و با یک کلیک (یا با بستن کامل برنامه) نصب می‌شود.' },
    { k: 'desktopHotkey', t: 'bool', global: 1, l: 'میانبر سراسری Ctrl+Shift+J برای نمایش یا پنهان کردن جارویس' },
  ] },
  { title: 'اعلان‌ها', icon: 'bell', fields: [
    { k: 'notify', t: 'bool', l: 'اعلان دسکتاپ وقتی کار تمام شد' },
    { k: 'speak', t: 'bool', l: 'اعلام صوتی پایان کار' },
  ] },
];

function fieldHtml(f, v, isProject) {
  const dis = isProject && f.global ? 'disabled title="این تنظیم فقط سراسری است"' : !isProject && f.projectOnly ? 'disabled title="این تنظیم فقط در «تنظیمات پروژه» است"' : '';
  const help = f.h ? `<div class="help">${esc(f.h)}</div>` : '';
  if (f.t === 'bool') return `<label class="check"><input type="checkbox" data-k="${f.k}" ${v ? 'checked' : ''} ${dis}> ${esc(f.l)}</label>${help}`;
  let input;
  if (f.t === 'model') input = `<select data-k="${f.k}" data-model="${f.m}" dir="ltr" ${dis}>${modelOptions(f.m, v).map(([val, lab]) => [val, !val && /Fallback$/.test(f.k) ? 'بدون جایگزین' : lab]).map(([val, lab]) => `<option value="${esc(val)}" ${String(v ?? '') === val ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  else if (f.t === 'select') input = `<select data-k="${f.k}" ${dis}>${f.o.map(([val, lab]) => `<option value="${esc(val)}" ${String(v ?? '') === val ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  else if (f.t === 'long') input = `<textarea data-k="${f.k}" rows="4" ${f.ltr ? 'dir="ltr"' : 'dir="auto" class="prose"'} placeholder="${esc(f.ph || '')}" ${dis}>${esc(v || '')}</textarea>`;
  else if (f.t === 'lines') input = `<textarea data-k="${f.k}" rows="5" ${dis}>${esc((v || []).join('\n'))}</textarea>`;
  else if (f.t === 'number') input = `<input type="number" min="0" step="${f.step || 1}" data-k="${f.k}" value="${esc(v)}" ${dis}>`;
  else input = `<input data-k="${f.k}" value="${esc(v)}" ${f.ltr ? 'dir="ltr"' : ''} placeholder="${esc(f.ph || '')}" ${dis}>`;
  return `<div class="field"><label>${esc(f.l)}</label>${input}${help}</div>`;
}

function readSettingsForm() {
  const out = {};
  for (const sec of SETTINGS_SCHEMA) for (const f of sec.fields) {
    const el = document.querySelector(`#dlgBody [data-k="${f.k}"]`);
    if (!el || el.disabled) continue;
    if (f.t === 'bool') out[f.k] = el.checked;
    else if (f.t === 'number') out[f.k] = Number(el.value) || 0;
    else if (f.t === 'lines') out[f.k] = el.value.split('\n').map(x => x.trim()).filter(Boolean);
    else if (f.t === 'model') { if (el.value !== '__custom') out[f.k] = el.value; }
    else if (f.k === 'scheduleAuditAt') { const m = el.value.trim().replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).match(/^(\d{1,2}):(\d{2})$/); out[f.k] = m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; }
    else out[f.k] = el.value.trim();
  }
  return out;
}

async function settingsDialog(scope) {
  const proj = S.projects.find(p => p.id === S.projectId);
  scope = scope === 'project' && proj ? 'project' : 'global';
  let values = S.settings, override = null;
  if (scope === 'project') {
    const r = await api(`/projects/${proj.id}/settings`);
    values = r.settings; override = r.override;
  }
  const isProject = scope === 'project';
  dialog(`<h3>تنظیمات</h3>
    <div class="scope">
      <label><input type="radio" name="scope" value="global" ${!isProject ? 'checked' : ''}><span>${ic('globe')}سراسری</span></label>
      ${proj ? `<label><input type="radio" name="scope" value="project" ${isProject ? 'checked' : ''}><span>${ic('folder')}فقط پروژه‌ی «${esc(proj.name)}»</span></label>` : ''}
    </div>
    ${isProject ? `<div class="help scope-help">${override ? 'این پروژه تنظیمات اختصاصی دارد.' : 'این پروژه از تنظیمات سراسری پیروی می‌کند؛ با ذخیره، تنظیمات اختصاصی برایش ساخته می‌شود.'}</div>` : ''}
    <div class="settings-tabs">${SETTINGS_SCHEMA.map((s, i) => `<button type="button" class="stab ${i === 0 ? 'on' : ''}" data-tab="${i}">${s.icon ? ic(s.icon) : ''}${s.title}</button>`).join('')}</div>
    ${SETTINGS_SCHEMA.map((s, i) => `<section class="spane" data-pane="${i}" ${i ? 'hidden' : ''}>${s.fields.map(f => fieldHtml(f, values[f.k], isProject)).join('')}</section>`).join('')}
    ${!isProject && S.settings.requireToken && localStorage.getItem('jarvis.token') ? `<div class="help">${ic('key-round', 'sm')} لینک ورود با توکن: <code dir="ltr">${esc(location.origin)}/?token=${esc(localStorage.getItem('jarvis.token'))}</code></div>` : ''}
    <div class="dlg-actions">
      <button class="btn primary" id="sSave">ذخیره${isProject ? ' برای این پروژه' : ''}</button>
      <button class="btn ghost" value="cancel">انصراف</button>
      ${isProject && override ? '<button class="btn ghost danger" id="sReset" style="margin-inline-start:auto">حذف تنظیمات اختصاصی (پیروی از سراسری)</button>' : ''}
      ${!isProject ? '<button class="btn ghost" id="sDefaults" style="margin-inline-start:auto">بازگشت به پیش‌فرض‌ها</button>' : ''}
    </div>`, true);
  const body = $('#dlgBody');
  body.querySelectorAll('input[name=scope]').forEach(r => r.onchange = () => settingsDialog(r.value));
  body.querySelectorAll('.stab').forEach(b => b.onclick = () => {
    body.querySelectorAll('.stab').forEach(x => x.classList.toggle('on', x === b));
    body.querySelectorAll('.spane').forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
  });
  $('#sSave').onclick = async e => {
    e.preventDefault();
    const vals = readSettingsForm();
    try {
      if (isProject) await api(`/projects/${proj.id}/settings`, { body: { settings: vals } });
      else {
        const r = await api('/settings', { body: vals });
        if (r.token) { localStorage.setItem('jarvis.token', r.token); delete r.token; toast('توکن دسترسی فعال شد و در این مرورگر ذخیره شد'); connectEvents(); }
        S.settings = r;
      }
      if (vals.notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      if (!isProject && window.jarvisDesktop && window.jarvisDesktop.applySettings) window.jarvisDesktop.applySettings();
      renderQuick(); renderAgents(); renderModelBar();
      $('#dlg').close();
      toast(isProject ? `تنظیمات پروژه‌ی «${proj.name}» ذخیره شد` : 'ذخیره شد');
    } catch (err) { toast(err.message, true); }
  };
  if ($('#sReset')) $('#sReset').onclick = async e => {
    e.preventDefault();
    await api(`/projects/${proj.id}/settings`, { body: { reset: true } });
    toast('این پروژه دوباره از تنظیمات سراسری پیروی می‌کند');
    settingsDialog('project');
  };
  if ($('#sDefaults')) $('#sDefaults').onclick = async e => {
    e.preventDefault();
    if (!confirm('همه‌ی تنظیمات سراسری به پیش‌فرض برگردند؟ (توکن دسترسی تغییر نمی‌کند)')) return;
    const d = { ...(S.defaults || {}) };
    delete d.requireToken;
    S.settings = await api('/settings', { body: d });
    settingsDialog('global');
  };
}

// ---------- restore checkpoint ----------
async function restoreDialog(commit) {
  dialog(`<h3>بازگشت به نقطه‌ی بازگشت</h3>
    <p>فایل‌های پروژه به وضعیت لحظه‌ی <code dir="ltr">${esc(commit.slice(0, 8))}</code> برمی‌گردند. تغییراتی که بعد از آن روی این فایل‌ها انجام شده از بین می‌رود. (staging گیت دست نمی‌خورد.)</p>
    <label class="check"><input type="checkbox" id="rDel"> فایل‌هایی را که بعد از این نقطه ساخته شده‌اند هم حذف کن</label>
    <div class="dlg-actions"><button class="btn danger" id="rGo">بازگردانی</button><button class="btn ghost" value="cancel">انصراف</button></div>`);
  $('#rGo').onclick = async e => {
    e.preventDefault();
    try {
      const r = await api(`/projects/${S.chat.projectId}/restore`, { body: { commit, deleteNewer: $('#rDel').checked } });
      if (!r.ok) throw new Error(r.err);
      $('#dlg').close();
      toast('بازگردانی شد'
        + (r.deletedFiles?.length ? ` — ${r.deletedFiles.length} فایل جدید حذف شد` : '')
        + (r.newerFiles?.length ? ` — ${r.newerFiles.length} فایل جدید باقی ماند` : ''));
      renderProjectInfo();
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- final report card ----------
function buildReport(m) {
  const r = m.report || {};
  const d = document.createElement('div');
  d.className = 'msg system';
  const sec = Math.round((r.durationMs || 0) / 1000);
  const dur = sec >= 60 ? `${Math.floor(sec / 60)} دقیقه و ${sec % 60} ثانیه` : `${sec} ثانیه`;
  const n = x => Number(x || 0).toLocaleString('fa-IR');
  d.innerHTML = `<div class="report ${esc(r.status)}">
    <div class="rhead">${ic('list-checks')}گزارش اجرا <span class="status-pill ${esc(r.status)}">${STATUS[r.status] || esc(r.status)}</span></div>
    <div class="rgrid">
      <div><span>زمان</span><b>${dur}</b></div>
      <div><span>دورها</span><b>${n(r.rounds)}</b></div>
      <div><span>هزینه (تخمینی)</span><b dir="ltr">$${(r.claudeUsd || 0).toFixed(3)}</b></div>
      ${r.codexTokens ? `<div><span>توکن حساب ChatGPT</span><b>${n(r.codexTokens)}</b></div>` : ''}
      <div><span>فایل‌های تغییرکرده</span><b>${n((r.files || []).length)}</b></div>
      ${r.openBugs ? `<div><span>باگ باز</span><b class="bad">${n(r.openBugs)}</b></div>` : ''}
    </div>
    ${r.branch ? `<div class="rline">${ic('git-branch', 'sm')}شاخه: <code dir="ltr">${esc(r.branch)}</code>${r.commit ? ` · commit <code dir="ltr">${esc(r.commit)}</code>` : ''}</div>` : r.commit ? `<div class="rline">${ic('circle-check', 'sm')}commit <code dir="ltr">${esc(r.commit)}</code></div>` : ''}
    ${(r.files || []).length ? `<details><summary>فایل‌ها</summary><pre>${esc(r.stat || r.files.join('\n'))}</pre></details>` : ''}
    ${(() => {
      const acts = [];
      if (['error', 'stopped', 'budget', 'needs-attention', 'unverified'].includes(r.status)) {
        acts.push(`<button class="btn small" data-retry="1">${ic('rotate-cw', 'sm')}دوباره اجرا کن</button>`);
        acts.push(`<button class="btn small ghost" data-editlast="1">${ic('pencil', 'sm')}ویرایش آخرین پیام</button>`);
      }
      if (r.pendingCommit) acts.push(`<button class="btn small primary" data-commit="1">${ic('git-commit-horizontal', 'sm')}commit تغییرات</button><button class="btn small ghost" data-showdiff="1">${ic('file-diff', 'sm')}دیدن تغییرات</button>`);
      if (r.status === 'done') acts.push(`<button class="btn small ghost" data-memory="1">${ic('lightbulb', 'sm')}پیشنهاد برای حافظه‌ی پروژه</button>`);
      if (r.status === 'done' && (r.branch || r.commit)) acts.push(`<button class="btn small ghost" data-pr="1">${ic('git-pull-request', 'sm')}ساخت Pull Request</button>`);
      return acts.length ? `<div class="rline ractions">${acts.join('')}</div>` : '';
    })()}
    ${(r.tests || []).length ? `<details><summary>تست‌های اجراشده (${n(r.tests.length)})</summary><div class="tests">${r.tests.map(t => `<div><b>$ ${esc(t.command)}</b> → ${esc(t.result)}</div>`).join('')}</div></details>` : ''}
  </div>`;
  return d;
}

// ---------- live text (not stored; replaced by the final message) ----------
function liveDelta(ev) {
  if (!S.chat || S.chat.id !== ev.chatId) return;
  const st = $('#stream');
  let el = st.querySelector('.live');
  if (ev.type === 'delta_reset') { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.className = `msg claude live${ev.via ? ' nested' : ''}`;
    el.innerHTML = `<div class="who"><span class="tag claude">Claude</span>${ev.sub ? `<span class="tag sub">${esc(ev.sub)}</span>` : ''}${ev.via ? `<span class="via">↳ ${esc(ev.via)}</span>` : ''}<span class="typing">در حال نوشتن…</span></div><div class="bubble"><p dir="auto" class="livetext"></p></div>`;
    st.appendChild(el);
  }
  const nearBottom = st.scrollHeight - st.scrollTop - st.clientHeight < 160;
  el.querySelector('.livetext').textContent += ev.text || '';
  if (nearBottom) st.scrollTop = st.scrollHeight;
}

// Per-file changes: list, side-by-side view, revert one file.
async function diffDialog() {
  const p = S.projects.find(x => x.id === (S.chat ? S.chat.projectId : S.projectId));
  if (!p) return;
  dialog('<h3>تغییرات پروژه</h3><div>…</div>', true);
  let r;
  try { r = await api(`/projects/${p.id}/changes`); } catch (e) { $('#dlgBody').innerHTML = `<div class="dlg-scroll"><h3>تغییرات پروژه</h3><p>${esc(e.message)}</p></div><div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`; return; }
  const body = !r.git ? '<p class="help">این پروژه گیت نیست؛ نمایش تغییرات فایل به فایل فقط برای پروژه‌های گیت کار می‌کند.</p>'
    : !r.files.length ? '<p class="help">تغییری نسبت به آخرین commit نیست.</p>'
    : `<ul class="cf-list">${r.files.map(f => `<li data-file="${esc(f.path)}">
        <button type="button" class="cf-name" data-show="${esc(f.path)}" dir="ltr">${ic(f.status === 'new' ? 'plus' : 'file-diff', 'sm')}<span>${esc(f.path)}</span></button>
        <span class="cf-stat">${f.status === 'new' ? '<em class="new">جدید</em>' : f.add === null ? '<em>باینری</em>' : `<b class="a">+${fa(f.add)}</b> <b class="d">−${fa(f.del)}</b>`}</span>
        <button type="button" class="btn small ghost danger" data-revert="${esc(f.path)}" title="${f.status === 'new' ? 'حذف این فایل جدید' : 'برگرداندن این فایل به آخرین commit'}">${ic('rotate-ccw', 'sm')}<span>${f.status === 'new' ? 'حذف' : 'برگرداندن'}</span></button>
      </li>`).join('')}</ul><div class="cf-view" id="cfView"><p class="help">روی نام یک فایل بزنید تا تغییراتش کنار هم نشان داده شود.</p></div>`;
  $('#dlgBody').innerHTML = `<div class="dlg-scroll"><h3>${ic('file-diff')}تغییرات پروژه — ${esc(p.name)}<span class="help">${r.files ? fa(r.files.length) + ' فایل' : ''}</span></h3>${body}</div>
    <div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`;
  const show = async file => {
    document.querySelectorAll('.cf-list li').forEach(li => li.classList.toggle('on', li.dataset.file === file));
    $('#cfView').innerHTML = '<p class="help">…</p>';
    const d = await api(`/projects/${p.id}/changes?file=${encodeURIComponent(file)}`).catch(e => ({ ok: false, err: e.message }));
    $('#cfView').innerHTML = d.ok ? sideBySide(d) : `<p class="help">${esc(d.err || 'خطا')}</p>`;
  };
  $('#dlgBody').onclick = async e => {
    const sh = e.target.closest('[data-show]');
    if (sh) return show(sh.dataset.show);
    const rv = e.target.closest('[data-revert]');
    if (!rv) return;
    const file = rv.dataset.revert;
    const isNew = !!rv.closest('li').querySelector('em.new');
    if (!confirm(isNew ? `فایل جدید «${file}» حذف شود؟ این کار برگشت‌پذیر نیست.` : `تغییرات «${file}» دور ریخته شود و به آخرین commit برگردد؟`)) return;
    try {
      const x = await api(`/projects/${p.id}/revert-file`, { body: { file } });
      if (!x.ok) throw new Error(x.err || 'ناموفق');
      toast(isNew ? 'فایل حذف شد' : 'فایل برگردانده شد');
      diffDialog();
    } catch (err) { toast(err.message, true); }
  };
  if (r.files && r.files[0]) show(r.files[0].path);
}
// Unified diff -> two columns (before | after).
function sideBySide(d) {
  if (d.status === 'new') {
    const lines = d.diff.split('\n');
    return `<div class="sbs"><div class="sbs-row head"><span>قبل</span><span>بعد (فایل جدید)</span></div>${lines.map((l, i) =>
      `<div class="sbs-row"><code class="n"></code><code></code><code class="n">${i + 1}</code><code class="a">${esc(l)}</code></div>`).join('')}</div>`;
  }
  const rows = []; let ln = 0, rn = 0, dels = [], adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push([dels[i] ? dels[i][0] : '', dels[i] ? dels[i][1] : null, adds[i] ? adds[i][0] : '', adds[i] ? adds[i][1] : null, dels[i] ? 'd' : '', adds[i] ? 'a' : '']);
    dels = []; adds = [];
  };
  for (const l of d.diff.split('\n')) {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (h) { flush(); ln = +h[1]; rn = +h[2]; rows.push(['…', null, '…', null, 'h', 'h']); continue; }
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) continue;
    if (l.startsWith('-')) dels.push([ln++, l.slice(1)]);
    else if (l.startsWith('+')) adds.push([rn++, l.slice(1)]);
    else if (l.startsWith(' ') || l === '') { flush(); if (!ln && !rn) continue; rows.push([ln++, l.slice(1), rn++, l.slice(1), '', '']); }
  }
  flush();
  return `<div class="sbs"><div class="sbs-row head"><span>قبل</span><span>بعد</span></div>${rows.map(([a, x, b, y, ca, cb]) =>
    `<div class="sbs-row ${ca === 'h' ? 'hunk' : ''}"><code class="n">${a}</code><code class="${ca}">${x === null ? '' : esc(x)}</code><code class="n">${b}</code><code class="${cb}">${y === null ? '' : esc(y)}</code></div>`).join('')}</div>`;
}
const fa = n => (+n || 0).toLocaleString('fa-IR');

// Save the open chat as a Markdown file.
async function exportChat() {
  if (!S.chat) return;
  try {
    const r = await fetch(`/api/chats/${S.chat.id}/export`, { headers: { 'X-Jarvis': '1', 'X-Jarvis-Token': token() } });
    if (!r.ok) throw new Error(r.statusText);
    const blob = new Blob([await r.text()], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.chat.title || 'jarvis-chat').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) + '.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast('خروجی ناموفق بود: ' + e.message, true); }
}

// ---------- chat search ----------
let searchTimer = null;
function renderSearch() {
  const ul = $('#chatList');
  const list = S.searchResults || [];
  if (!list.length) { ul.innerHTML = `<li class="empty">${S.searchResults ? 'چیزی پیدا نشد.' : 'در حال جستجو…'}</li>`; return; }
  ul.innerHTML = list.map(c => `<li data-id="${esc(c.id)}" class="${S.chat && S.chat.id === c.id ? 'active' : ''} found">
      <span class="name" dir="auto">${esc(c.title)}</span><span class="sub">${fmtTime(c.updatedAt)}</span>
      ${c.snippet ? `<span class="snip" dir="auto">${esc(c.snippet)}</span>` : ''}</li>`).join('');
}
$('#chatSearch').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  S.searchQ = q; S.searchResults = null;
  if (!q) { renderChats(); return; }
  renderSearch();
  searchTimer = setTimeout(async () => {
    try {
      const r = await api(`/chats/search?q=${encodeURIComponent(q)}${S.projectId ? '&projectId=' + encodeURIComponent(S.projectId) : ''}`);
      if (S.searchQ === q) { S.searchResults = r; renderSearch(); }
    } catch (err) { toast(err.message, true); }
  }, 250);
});
$('#chatSearch').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; e.target.dispatchEvent(new Event('input')); } });

// ---------- events ----------
$('#projectList').onclick = async e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm('این پروژه از لیست جارویس حذف شود؟ (فایل‌ها حذف نمی‌شوند)')) return;
    await api('/projects/' + del.dataset.del, { method: 'DELETE' });
    S.projects = S.projects.filter(p => p.id !== del.dataset.del);
    if (S.projectId === del.dataset.del) S.projectId = S.projects[0]?.id || null;
    renderProjects(); renderChats(); renderProjectInfo();
    return;
  }
  const li = e.target.closest('li[data-id]');
  if (li) selectProject(li.dataset.id);
};
$('#projectInfo').onclick = async e => {
  if (e.target.closest('[data-psettings]')) return settingsDialog('project');
  if (e.target.closest('[data-rules]')) return rulesDialog();
  if (e.target.closest('[data-preview]')) return previewDialog();
  const b = e.target.closest('[data-sync]');
  if (!b) return;
  const dir = b.dataset.sync;
  try {
    const r = await api(`/projects/${S.projectId}/agents-md`, { body: { direction: dir } }).catch(async err => {
      if (err.status === 409 && confirm(err.message + ' — بازنویسی شود؟')) return api(`/projects/${S.projectId}/agents-md`, { body: { direction: dir, overwrite: true } });
      throw err;
    });
    if (r) toast(`${r.wrote} نوشته شد`);
  } catch (err) { toast(err.message, true); }
};
$('#chatList').onclick = e => { const li = e.target.closest('li[data-id]'); if (li) openChat(li.dataset.id); };
// Logo -> home screen (closes the open chat; running work continues in the background).
function goHome() {
  S.chat = null;
  try { localStorage.removeItem('jarvis.chat'); } catch {}
  $('#sidebar').classList.remove('open');
  renderChats(); renderChatHead(); renderStream();
}
$('#brand').onclick = goHome;
$('#brand').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } };
$('#btnAddProject').onclick = () => addProjectDialog();
$('#btnDiscover').onclick = discoverDialog;
$('#btnNewChat').onclick = newChat;
$('#btnSettings').onclick = () => settingsDialog('global');
$('#btnMenu').onclick = () => $('#sidebar').classList.toggle('open');
$('#btnDiff').onclick = diffDialog;
$('#btnExport').onclick = exportChat;
$('#btnStop').onclick = () => S.chat && api(`/chats/${S.chat.id}/stop`, { body: {} });
$('#btnReset').onclick = async () => {
  if (!S.chat || !confirm('حافظه‌ی گفتگوی سازنده و تستر برای این چت پاک شود و نشست تازه شروع شود؟')) return;
  await api(`/chats/${S.chat.id}/reset`, { body: {} });
  toast('دفعه‌ی بعد هر دو ایجنت با نشست تازه شروع می‌کنند');
};
$('#btnDeleteChat').onclick = async () => {
  if (!S.chat || !confirm('این چت حذف شود؟')) return;
  await api('/chats/' + S.chat.id, { method: 'DELETE' });
};
$('#chatTitle').ondblclick = async () => {
  const t = prompt('نام جدید چت:', S.chat.title);
  if (t && t.trim()) await api(`/chats/${S.chat.id}/rename`, { body: { title: t.trim() } });
};
$('#stream').onclick = async e => {
  const cp = e.target.closest('[data-copy]');
  if (cp) { try { await navigator.clipboard.writeText(decodeURIComponent(cp.dataset.copy)); cp.classList.add('ok'); setTimeout(() => cp.classList.remove('ok'), 1200); } catch { toast('کپی نشد', true); } return; }
  const im = e.target.closest('img[data-att]');
  if (im && im.src) { dialog(`<div class="dlg-scroll"><img class="att-full" src="${im.src}" alt="تصویر پیوست"></div><div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`, true); return; }
  if (S.chat && e.target.closest('[data-retry]')) { try { await api(`/chats/${S.chat.id}/retry`, { body: {} }); } catch (err) { toast(err.message, true); if (err.data && err.data.needSetup) setupDialog(); } return; }
  if (S.chat && e.target.closest('[data-editlast]')) {
    const last = [...S.chat.messages].reverse().find(x => x.agent === 'user' && x.kind === 'text');
    if (last) { $('#input').value = last.text; $('#input').focus(); }
    return;
  }
  if (S.chat && e.target.closest('[data-showdiff]')) return diffDialog();
  if (S.chat && e.target.closest('[data-memory]')) return runSpecial('memory');
  const ms = e.target.closest('[data-memsave]');
  if (ms) {
    const card = ms.closest('.memcard'); const items = JSON.parse(card.dataset.items || '[]');
    const pick = [...card.querySelectorAll('[data-memitem]:checked')].map(x => items[+x.dataset.memitem]).filter(Boolean);
    if (!pick.length) return toast('چیزی انتخاب نشده', true);
    try { await api(`/projects/${card.dataset.memproject || S.chat.projectId}/rules/append`, { body: { items: pick } }); toast(`${fa(pick.length)} مورد به قوانین پروژه اضافه شد`); ms.disabled = true; ms.textContent = 'اضافه شد ✓'; } catch (err) { toast(err.message, true); }
    return;
  }
  const cm = e.target.closest('[data-commit]');
  if (S.chat && cm) {
    const msg = prompt('پیام commit:', `jarvis: ${S.chat.title}`);
    if (msg === null) return;
    try { const r = await api(`/chats/${S.chat.id}/commit`, { body: { message: msg } }); cm.closest('.ractions').querySelectorAll('[data-commit],[data-showdiff]').forEach(x => x.remove()); if (r.nothing) toast('چیزی برای commit نبود'); } catch (err) { toast(err.message, true); }
    return;
  }
  const pr = e.target.closest('[data-pr]');
  if (S.chat && pr) {
    pr.disabled = true;
    try { const r = await api(`/chats/${S.chat.id}/pr`, { body: {} }); toast('Pull Request ساخته شد'); if (r.url) window.open(r.url, '_blank'); } catch (err) { toast(err.message, true); }
    pr.disabled = false;
    return;
  }
  const b = e.target.closest('[data-restore]');
  if (b && S.chat) restoreDialog(b.dataset.restore);
};
$('#composer').onsubmit = async e => {
  e.preventDefault();
  const text = $('#input').value.trim();
  if (!text || !S.chat) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  try {
    const running = S.chat.status === 'running' || S.chat.status === 'waiting';
    if (running && S.attach.length) toast('تصویرها فقط با پیامی که کار تازه شروع می‌کند فرستاده می‌شوند؛ این پیام بدون تصویر در صف رفت.');
    const r = await api(`/chats/${S.chat.id}/send`, { body: { text, mode, attachments: running ? [] : S.attach.map(a => a.file) } });
    $('#input').value = '';
    pushHistory(text);
    if (!running) clearAttachments();
    if (r.queued) toast('در صف قرار گرفت — در مرحله‌ی بعد به سازنده می‌رسد');
  } catch (err) {
    toast(err.message, true);
    if (err.data && err.data.needSetup) setupDialog(); // Claude not connected yet
  }
};
$('#input').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit(); };

// Voice input (Web Speech API; works in Chrome/Edge)
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#btnMic');
  let micBroken = null; try { micBroken = localStorage.getItem('jarvis.micBroken'); } catch {}
  if (!SR || micBroken) { btn.hidden = true; return; }
  let rec = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'fa-IR'; rec.interimResults = false; rec.continuous = false;
    const before = $('#input').value;
    rec.onresult = ev => { $('#input').value = (before ? before + ' ' : '') + [...ev.results].map(r => r[0].transcript).join(' '); };
    rec.onend = () => { rec = null; btn.classList.remove('rec'); };
    rec.onerror = ev => {
      if (ev.error === 'network') { toast('ورودی صوتی در این برنامه در دسترس نیست (سرویس تبدیل گفتار گوگل فقط داخل Chrome کار می‌کند). از تایپ یا ورودی صوتی ویندوز (Win+H) استفاده کنید.', true); try { localStorage.setItem('jarvis.micBroken', '1'); } catch {} btn.hidden = true; }
      else if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') toast('اجازه‌ی میکروفون داده نشده است.', true);
      else if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast('میکروفون: ' + ev.error, true);
    };
    btn.classList.add('rec'); rec.start();
  };
})();

// ---------- sub-agents ----------
const STAGE = { review: 'تستر موازی', builder: 'کمکِ سازنده' };
function renderSubagents() {
  const ul = $('#subList');
  ul.innerHTML = S.subagents.length ? S.subagents.map(a => `<li data-sub="${esc(a.id)}" class="${a.enabled ? '' : 'off'}" title="${esc(a.description || a.prompt.slice(0, 200))}">
      <input type="checkbox" data-toggle="${esc(a.id)}" ${a.enabled ? 'checked' : ''} title="فعال/غیرفعال">
      <span>${esc(a.icon)}</span><span class="name" dir="ltr" style="text-align:right">${esc(a.name)}</span>
      ${(a.skills || []).length ? `<span class="skc" title="اسکیل‌ها">${ic('puzzle', 'sm')}${(a.skills.length).toLocaleString('fa-IR')}</span>` : ''}<span class="stage ${a.stage}" title="${a.stage === 'review' ? 'اجرا با: ' + esc(subRunnerLabel(a)) : 'داخل نشست سازنده اجرا می‌شود'}">${STAGE[a.stage]}${a.stage === 'review' ? ' · ' + esc(subRunnerShort(a)) : ''}</span></li>`).join('')
    : '<li class="empty">ساب‌ایجنتی تعریف نشده.</li>';
  $('#mentions').innerHTML = S.subagents.map(a => `<button type="button" data-mention="${esc(a.name)}">${esc(a.icon)} @${esc(a.name)}</button>`).join('');
}
function subagentDialog(a, draft) {
  const isNew = !a;
  a = a || { name: '', icon: '🤖', engine: 'claude', model: '', stage: 'review', enabled: true, description: '', prompt: '', skills: [] };
  const v = { ...a, skills: a.skills || [], ...(draft || {}) };
  const kb = n => (n / 1024).toLocaleString('fa-IR', { maximumFractionDigits: 1 });
  const skillRows = (S.skills || []).length ? S.skills.map(s => `
      <label class="skill-row">
        <input type="checkbox" data-skill="${esc(s.id)}" ${v.skills.includes(s.id) ? 'checked' : ''}>
        <span class="sname" dir="ltr">${esc(s.name)}</span>
        <span class="sdesc" dir="auto" title="${esc(s.description)}">${esc(s.description)}</span>
        <span class="sbadge ${s.inline ? 'inl' : 'lazy'}" title="${s.inline ? 'کامل در دستورالعمل قرار می‌گیرد' : 'فقط نام و توضیح؛ ایجنت هر وقت لازم شد فایل را می‌خواند'}">${s.inline ? 'درون‌خطی' : 'در صورت نیاز'} · ${kb(s.size)}KB</span>
        <button type="button" class="icon-mini" data-skill-edit="${esc(s.id)}" title="${s.source === 'imported' ? 'مشاهده/ویرایش' : 'ویرایش'}" aria-label="ویرایش ${esc(s.name)}">${ic('pencil', 'sm')}</button>
      </label>`).join('')
    : '<div class="help">کتابخانه‌ی اسکیل خالی است — یکی بسازید یا از اسکیل‌های نصب‌شده وارد کنید.</div>';
  dialog(`<h3>${isNew ? 'ساب‌ایجنت جدید' : 'ویرایش ساب‌ایجنت'}</h3>
    <div class="field-row">
      <div class="field" style="flex:0 0 70px"><label>آیکون</label><input id="aIcon" value="${esc(v.icon)}" maxlength="4"></div>
      <div class="field"><label>نام (انگلیسی، برای @mention)</label><input id="aName" dir="ltr" value="${esc(v.name)}" placeholder="db-expert" required></div>
    </div>
    <div class="field-row">
      <div class="field"><label>نقش</label>
        <select id="aStage">
          <option value="review">تستر موازی — هر دور، کنار تستر اصلی بررسی می‌کند و باگ‌هایش به لیست رفع اضافه می‌شود</option>
          <option value="builder">کمکِ سازنده — سازنده هنگام نوشتن کد می‌تواند کار را به او بسپارد</option>
        </select></div>
      <div class="field" style="flex:1 1 220px"><label>اجرا با</label>
        <select id="aModel" dir="auto">${subRunnerOptions(v).map(([val, lab]) => `<option value="${esc(val)}">${esc(lab)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>توضیح کوتاه (برای «کمکِ سازنده»: سازنده از روی این تصمیم می‌گیرد کی صدایش کند)</label><input id="aDesc" value="${esc(v.description)}"></div>
    <div class="field"><label>دستورالعمل (system prompt)</label><textarea id="aPrompt" placeholder="You are a database specialist. Check migrations, indexes, transactions...">${esc(v.prompt)}</textarea></div>
    <div class="field skills-field">
      <label>${ic('puzzle', 'sm')} اسکیل‌های این ساب‌ایجنت</label>
      <div class="skill-pick">${skillRows}</div>
      <div class="row-gap">
        <button type="button" class="btn small" id="aNewSkill">+ اسکیل جدید</button>
        <button type="button" class="btn small ghost" id="aImportSkill">${ic('download')}از اسکیل‌های نصب‌شده</button>
      </div>
      <div class="help">اسکیل‌های کوچک کامل در دستورالعمل قرار می‌گیرند؛ اسکیل‌های بزرگ فقط با نام و توضیح، و ساب‌ایجنت فقط وقتی لازم شد فایلش را می‌خواند — تا توکن هدر نرود. برای Claude و Codex هر دو کار می‌کند.</div>
    </div>
    <label class="check"><input type="checkbox" id="aEnabled" ${v.enabled ? 'checked' : ''}> فعال در جریان تیمی</label>
    <div class="help" style="font-size:12px;color:var(--muted)">در هر چت می‌توانید مستقیم صدایش کنید: <code dir="ltr">@${esc(v.name || 'name')} ...</code></div>
    <div class="dlg-actions">
      <button class="btn primary" id="aSave">ذخیره</button>
      <button class="btn ghost" value="cancel">انصراف</button>
      ${isNew ? '<button class="btn ghost" id="aReset" style="margin-inline-start:auto">بازگردانی پیش‌فرض‌ها</button>' : '<button class="btn ghost danger" id="aDel" style="margin-inline-start:auto">حذف</button>'}
    </div>`, true);
  $('#aStage').value = v.stage; $('#aModel').value = subSpec(v);
  const syncEngine = () => { const b = $('#aStage').value === 'builder'; $('#aModel').disabled = b; if (b) $('#aModel').value = ''; $('#aModel').title = b ? 'ساب‌ایجنت‌های «کمک سازنده» داخل نشست خود سازنده اجرا می‌شوند' : ''; };
  $('#aStage').onchange = syncEngine; syncEngine();
  // Current form state, so sub-dialogs (new/import/edit skill) can come back to it.
  const readForm = () => ({
    icon: $('#aIcon').value, name: $('#aName').value, stage: $('#aStage').value, model: $('#aModel').value, engine: $('#aModel').value === 'engine:codex' ? 'codex' : 'claude',
    description: $('#aDesc').value, prompt: $('#aPrompt').value, enabled: $('#aEnabled').checked,
    skills: [...document.querySelectorAll('#dlgBody [data-skill]:checked')].map(x => x.dataset.skill),
  });
  const back = extra => d => subagentDialog(isNew ? null : a, { ...d, ...(extra || {}) });
  $('#aNewSkill').onclick = () => { const d = readForm(); skillDialog(null, s => back()({ ...d, skills: [...d.skills, s.id] }), () => back()(d)); };
  $('#aImportSkill').onclick = () => { const d = readForm(); importSkillsDialog(ids => back()({ ...d, skills: [...new Set([...d.skills, ...ids])] }), () => back()(d)); };
  $('#dlgBody').querySelectorAll('[data-skill-edit]').forEach(b => b.onclick = e => {
    e.preventDefault();
    const d = readForm();
    skillDialog(b.dataset.skillEdit, () => back()(d), () => back()(d), id => back()({ ...d, skills: d.skills.filter(x => x !== id) }));
  });
  $('#aSave').onclick = async e => {
    e.preventDefault();
    try {
      await api('/subagents', { body: { id: a.id, ...readForm() } });
      $('#dlg').close();
    } catch (err) { toast(err.message, true); }
  };
  if ($('#aDel')) $('#aDel').onclick = async e => {
    e.preventDefault();
    if (!confirm(`ساب‌ایجنت «${a.name}» حذف شود؟`)) return;
    await api('/subagents/' + a.id, { method: 'DELETE' });
    $('#dlg').close();
  };
  if ($('#aReset')) $('#aReset').onclick = async e => {
    e.preventDefault();
    if (!confirm('همه‌ی ساب‌ایجنت‌ها به حالت پیش‌فرض برگردند؟ (ساب‌ایجنت‌های ساخته‌شده‌ی شما حذف می‌شوند)')) return;
    await api('/subagents/reset', { body: {} });
    $('#dlg').close();
  };
}

// Create or edit a skill (SKILL.md). onSaved(skill), onBack(), onDeleted(id)
async function skillDialog(id, onSaved, onBack, onDeleted) {
  let s = { name: '', description: '', body: '' };
  if (id) { try { s = await api('/skills/' + id); } catch (e) { toast(e.message, true); return onBack(); } }
  dialog(`<h3>${id ? 'ویرایش اسکیل' : 'اسکیل جدید'}</h3>
    ${s.source === 'imported' ? `<div class="help">وارد‌شده از <code dir="ltr">${esc(s.origin || '')}</code> — یک کپی در جارویس نگه داشته می‌شود؛ تغییرات روی اصل اثری ندارد.</div>` : ''}
    <div class="field"><label>نام (انگلیسی)</label><input id="kName" dir="ltr" value="${esc(s.name)}" placeholder="owasp-checklist"></div>
    <div class="field"><label>توضیح — ایجنت از روی این تصمیم می‌گیرد کی از اسکیل استفاده کند</label><input id="kDesc" value="${esc(s.description)}" placeholder="Use when reviewing web endpoints for injection, auth and input validation issues."></div>
    <div class="field"><label>دستورالعمل اسکیل (Markdown)</label><textarea id="kBody" rows="14" placeholder="## Steps&#10;1. ...&#10;2. ...">${esc((s.body || '').trim())}</textarea>
      <div class="help">زیر ~۲۵۰۰ کاراکتر: کامل در دستورالعمل ساب‌ایجنت قرار می‌گیرد. بیشتر از آن: فقط نام و توضیح، و ساب‌ایجنت هر وقت لازم شد فایل را می‌خواند.</div></div>
    <div class="dlg-actions">
      <button class="btn primary" id="kSave">ذخیره${id ? '' : ' و افزودن به ساب‌ایجنت'}</button>
      <button class="btn ghost" id="kBack">بازگشت</button>
      ${id ? '<button class="btn ghost danger" id="kDel" style="margin-inline-start:auto">حذف از کتابخانه</button>' : ''}
    </div>`, true);
  $('#kBack').onclick = e => { e.preventDefault(); onBack(); };
  $('#kSave').onclick = async e => {
    e.preventDefault();
    try {
      const saved = await api('/skills', { body: { id, name: $('#kName').value, description: $('#kDesc').value, content: $('#kBody').value } });
      S.skills = await api('/skills');
      toast(`اسکیل «${saved.name}» ذخیره شد`);
      onSaved(saved);
    } catch (err) { toast(err.message, true); }
  };
  if ($('#kDel')) $('#kDel').onclick = async e => {
    e.preventDefault();
    if (!confirm(`اسکیل «${s.name}» از کتابخانه حذف شود؟ از همه‌ی ساب‌ایجنت‌ها هم جدا می‌شود.`)) return;
    await api('/skills/' + id, { method: 'DELETE' });
    S.skills = await api('/skills');
    (onDeleted || onBack)(id);
  };
}

// Pick installed skills (Claude Code / Codex / project) to copy into the library.
async function importSkillsDialog(onDone, onBack) {
  dialog('<h3>اسکیل‌های نصب‌شده</h3><div class="help">در حال جستجو…</div>', true);
  let list = [];
  try { list = await api('/skills/installed'); } catch (e) { toast(e.message, true); }
  const kb = n => (n / 1024).toLocaleString('fa-IR', { maximumFractionDigits: 1 });
  $('#dlgBody').innerHTML = `<h3>${ic('download')}وارد کردن اسکیل</h3>
    <div class="help">از ~/.claude/skills، ~/.codex/skills، ~/.agents/skills و پوشه‌ی .claude/skills پروژه‌ها. یک کپی در جارویس ساخته می‌شود.</div>
    <div class="skill-pick tall">${list.length ? list.map((s, i) => `
      <label class="skill-row">
        <input type="checkbox" data-imp="${i}" ${s.imported ? 'checked disabled' : ''}>
        <span class="sname" dir="ltr">${esc(s.name)}</span>
        <span class="sdesc" dir="auto" title="${esc(s.description)}">${esc(s.description)}</span>
        <span class="sbadge">${esc(s.from)} · ${kb(s.size)}KB${s.imported ? ' · وارد شده' : ''}</span>
      </label>`).join('') : '<div class="help">اسکیل نصب‌شده‌ای پیدا نشد.</div>'}</div>
    <div class="field"><label>یا مسیر پوشه‌ی یک اسکیل (دارای SKILL.md)</label><input id="impPath" dir="ltr" placeholder="C:\\path\\to\\my-skill"></div>
    <div class="dlg-actions">
      <button class="btn primary" id="impGo">وارد کن و به ساب‌ایجنت اضافه کن</button>
      <button class="btn ghost" id="impBack">بازگشت</button>
    </div>`;
  $('#impBack').onclick = e => { e.preventDefault(); onBack(); };
  $('#impGo').onclick = async e => {
    e.preventDefault();
    const dirs = [...document.querySelectorAll('#dlgBody [data-imp]:checked:not(:disabled)')].map(x => list[+x.dataset.imp].dir);
    const p = $('#impPath').value.trim();
    if (p) dirs.push(p);
    // already-imported ones that were listed are attached too
    const ids = [];
    for (const d of dirs) {
      try { const s = await api('/skills/import', { body: { dir: d } }); ids.push(s.id); }
      catch (err) { toast(`${d}: ${err.message}`, true); }
    }
    S.skills = await api('/skills');
    if (ids.length) toast(`${ids.length.toLocaleString('fa-IR')} اسکیل وارد شد`);
    onDone(ids);
  };
}
$('#btnAddSub').onclick = () => subagentDialog(null);
$('#subList').onclick = async e => {
  const t = e.target.closest('[data-toggle]');
  if (t) {
    const a = S.subagents.find(x => x.id === t.dataset.toggle);
    try { await api('/subagents', { body: { ...a, enabled: t.checked } }); } catch (err) { toast(err.message, true); }
    return;
  }
  const li = e.target.closest('li[data-sub]');
  if (li) subagentDialog(S.subagents.find(x => x.id === li.dataset.sub));
};
$('#mentions').onclick = e => {
  const b = e.target.closest('[data-mention]');
  if (!b) return;
  const inp = $('#input');
  inp.value = `@${b.dataset.mention} ` + inp.value.replace(/^@[\w-]+\s*/, '');
  inp.focus();
};

// ---------- account connection wizard ----------
let setupPoll = null;
async function setupDialog(opts = {}) {
  clearTimeout(setupPoll);
  let st, gfy = { installed: false };
  try { [st, gfy] = await Promise.all([api('/setup/status'), api('/graphify').catch(() => ({ installed: false }))]); }
  catch (e) { toast('وضعیت حساب‌ها خوانده نشد: ' + e.message, true); return; }
  const c = st.claude, x = st.codex;
  const okState = (ok, yes, no) => `<span class="wz-state ${ok ? 'ok' : 'no'}">${ic(ok ? 'circle-check' : 'triangle-alert', 'sm')}${ok ? yes : no}</span>`;
  const claudeVia = { apiKey: 'با کلید API', 'claude.ai': 'با حساب Claude', console: 'با حساب Console' }[c.via] || 'متصل';
  const codexVia = { apiKey: 'با کلید API', chatgpt: 'با حساب ChatGPT' }[x.via] || 'متصل';
  const pending = n => st[n].login && !st[n].login.done;
  try { S.providers = await api('/providers'); } catch {}
  dialog(`<h3>${ic('plug')}اتصال‌ها</h3>
    <p class="help">${ic('lock', 'sm')} همه‌چیز روی همین کامپیوتر می‌ماند. کلیدها ${st.encryptedSecrets ? 'با رمزنگاری ویندوز (DPAPI) ذخیره می‌شوند' : 'فقط روی همین کامپیوتر ذخیره می‌شوند'} و فقط به خودِ CLI داده می‌شوند.</p>
    <div class="wizard-steps">
      <div class="wz-item ${c.connected ? 'ok' : ''}">
        <div class="wz-icon claude">${ic(c.connected ? 'circle-check' : 'bot')}</div>
        <div class="wz-body">
          <h4>Claude <small class="help">حساب Anthropic — موتور Claude Code</small></h4>
          ${!c.installed ? `${okState(false, '', 'Claude CLI نصب نیست')}
            <div class="row-gap"><button type="button" class="btn btn-primary btn-sm" data-install="claude">${ic('download')}نصب Claude CLI</button></div>
            <div class="wz-note">${ic('info', 'sm')}نصب‌کننده‌ی رسمی در یک پنجره باز می‌شود. بعد از پایان، «بررسی دوباره» را بزنید.</div>`
          : `${okState(c.connected, `${claudeVia} وصل است`, 'هنوز وصل نیست')} <span class="help" dir="ltr">${esc(c.version || '')}</span>
            ${c.subscriptionBlocked ? `<div class="wz-note">${ic('info', 'sm')}<span>ورود با اشتراک Claude (Pro/Max) در برنامه‌های شخص ثالث بدون تأیید Anthropic مجاز نیست؛ برای این نسخه یک کلید API لازم است.</span></div>` : ''}
            <div class="wz-key">
              <input type="password" id="wzClaudeKey" placeholder="${c.apiKey ? 'کلید ذخیره شده است — برای تغییر، کلید جدید را وارد کنید' : 'sk-ant-…'}" autocomplete="off" aria-label="کلید API Anthropic">
              <button type="button" class="btn btn-primary btn-sm" id="wzClaudeSave">${ic('key-round')}ذخیره‌ی کلید</button>
            </div>
            <div class="row-gap">
              <button type="button" class="btn btn-ghost btn-sm" data-install="anthropic-keys">${ic('external-link')}گرفتن کلید از Anthropic Console</button>
              ${c.apiKey ? `<button type="button" class="btn btn-ghost btn-sm btn-danger-text" data-logout="claude">${ic('trash-2')}حذف کلید</button>` : ''}
              ${st.allowClaudeAiLogin && !c.connected ? `<button type="button" class="btn btn-secondary btn-sm" data-login="claude" ${pending('claude') ? 'disabled' : ''}>${ic('log-in')}${pending('claude') ? 'منتظر ورود در مرورگر…' : 'ورود با حساب Claude'}</button>` : ''}
            </div>`}
        </div>
      </div>

      <div class="wz-item ${x.connected ? 'ok' : ''}">
        <div class="wz-icon codex">${ic(x.connected ? 'circle-check' : 'scan-search')}</div>
        <div class="wz-body">
          <h4>Codex <small class="help">حساب OpenAI / ChatGPT — موتور Codex</small></h4>
          ${!x.installed ? `${okState(false, '', 'Codex CLI نصب نیست')}
            ${st.node.npm ? `<div class="row-gap"><button type="button" class="btn btn-primary btn-sm" data-install="codex">${ic('download')}نصب Codex CLI</button></div>`
              : `<div class="wz-note">${ic('info', 'sm')}<span>برای نصب Codex اول Node.js لازم است.</span></div><div class="row-gap"><button type="button" class="btn btn-secondary btn-sm" data-install="node">${ic('external-link')}دانلود Node.js</button></div>`}
            <div class="wz-note">${ic('info', 'sm')}بدون Codex هم کار می‌کند: تستر می‌تواند Claude (در نشست جدا) یا یکی از «اتصال‌های دیگر» مثل DeepSeek باشد.</div>`
          : `${okState(x.connected, `${codexVia} وصل است`, 'هنوز وصل نیست')} <span class="help" dir="ltr">${esc(x.version || '')}</span>
            <div class="row-gap">
              ${x.connected ? `<button type="button" class="btn btn-ghost btn-sm btn-danger-text" data-logout="codex">${ic('log-out')}خروج</button>`
                : `<button type="button" class="btn btn-primary btn-sm" data-login="codex" ${pending('codex') ? 'disabled' : ''}>${ic('log-in')}${pending('codex') ? 'منتظر ورود در مرورگر…' : 'ورود با حساب ChatGPT'}</button>`}
            </div>
            ${x.connected ? '' : `<div class="wz-key">
              <input type="password" id="wzCodexKey" placeholder="یا کلید API OpenAI: sk-…" autocomplete="off" aria-label="کلید API OpenAI">
              <button type="button" class="btn btn-secondary btn-sm" id="wzCodexSave">${ic('key-round')}ذخیره‌ی کلید</button>
            </div>`}`}
        </div>
      </div>

      <div class="wz-item ${st.git.installed ? 'ok' : ''}">
        <div class="wz-icon">${ic(st.git.installed ? 'circle-check' : 'git-branch')}</div>
        <div class="wz-body">
          <h4>Git <small class="help">اختیاری — نقطه‌ی بازگشت، diff و commit</small></h4>
          ${st.git.installed ? okState(true, 'نصب است', '') : `${okState(false, '', 'نصب نیست')}<div class="row-gap"><button type="button" class="btn btn-secondary btn-sm" data-install="git">${ic('external-link')}دانلود Git</button></div>`}
        </div>
      </div>

      ${providersBlock()}

      ${notifyBlock()}

      <div class="wz-item ${gfy.installed ? 'ok' : ''}">
        <div class="wz-icon">${ic(gfy.installed ? 'circle-check' : 'network')}</div>
        <div class="wz-body">
          <h4>graphify <small class="help">اختیاری — گراف کد پروژه</small></h4>
          ${gfy.installed ? okState(true, 'نصب است', '') : `${okState(false, '', 'نصب نیست')}<div class="wz-note">${ic('terminal', 'sm')}<span>نصب: <code dir="ltr">uv tool install graphifyy</code></span></div>`}
        </div>
      </div>
    </div>
    <div class="dlg-actions">
      <button type="button" class="btn btn-primary" id="wzDone">${c.connected ? `${ic('check')}شروع کار` : 'بعداً'}</button>
      <button type="button" class="btn btn-ghost" id="wzRefresh">${ic('refresh-cw')}بررسی دوباره</button>
    </div>`, true);

  const body = $('#dlgBody');
  const refresh = () => setupDialog(opts);
  try { localStorage.setItem('jarvis.setupSeen', '1'); } catch {}
  $('#wzRefresh').onclick = refresh;
  body.querySelectorAll('[data-addprov]').forEach(b => b.onclick = () => providerDialog());
  body.querySelectorAll('[data-notify]').forEach(b => b.onclick = () => notifyDialog());
  body.querySelectorAll('[data-editprov]').forEach(b => b.onclick = () => providerDialog(b.dataset.editprov));
  $('#wzDone').onclick = () => { clearTimeout(setupPoll); $('#dlg').close(); };
  body.querySelectorAll('[data-install]').forEach(b => b.onclick = async () => {
    try {
      const r = await api('/setup/install', { body: { name: b.dataset.install } });
      if (r.needNode) toast('اول Node.js را نصب کنید؛ صفحه‌ی دانلود باز شد.');
      else toast(/keys|git|node/.test(b.dataset.install) ? 'صفحه در مرورگر باز شد' : 'نصب‌کننده در یک پنجره‌ی جدا باز شد — بعد از پایان «بررسی دوباره» را بزنید.');
    } catch (e) { toast(e.message, true); }
  });
  body.querySelectorAll('[data-login]').forEach(b => b.onclick = async () => {
    try { await api('/setup/login', { body: { name: b.dataset.login } }); toast('صفحه‌ی ورود در مرورگر باز شد'); refresh(); }
    catch (e) { toast(e.message, true); }
  });
  body.querySelectorAll('[data-logout]').forEach(b => b.onclick = async () => {
    if (!confirm(b.dataset.logout === 'claude' ? 'کلید API Claude حذف شود؟' : 'از حساب Codex خارج شوید؟')) return;
    try { await api('/setup/logout', { body: { name: b.dataset.logout } }); refresh(); } catch (e) { toast(e.message, true); }
  });
  const saveKey = (id, path, label) => { const btn = $(id + 'Save'); if (!btn) return; btn.onclick = async () => {
    const v = $(id + 'Key').value.trim(); if (!v) return toast('کلید را وارد کنید', true);
    btn.disabled = true;
    try { await api(path, { body: { key: v } }); toast(`کلید ${label} ذخیره شد`); refresh(); }
    catch (e) { toast(e.message, true); btn.disabled = false; }
  }; };
  saveKey('#wzClaude', '/setup/claude-key', 'Claude');
  saveKey('#wzCodex', '/setup/codex-key', 'Codex');
  // While a browser sign-in is in progress, keep checking until it finishes.
  if (pending('claude') || pending('codex')) setupPoll = setTimeout(() => { if ($('#dlg').open && $('#wzRefresh')) refresh(); }, 3000);
}

// First run: open the wizard if an agent is not connected yet.
async function maybeFirstRunSetup() {
  try {
    if (localStorage.getItem('jarvis.setupSeen')) return;
    const st = await api('/setup/status');
    if (!st.claude.connected || !st.codex.connected) setupDialog();
    else localStorage.setItem('jarvis.setupSeen', '1');
  } catch {}
}

// ---------- per-chat model picker (composer) ----------
// Exact model names (catalog comes from the server: lib/models.js).
const FALLBACK_CLAUDE = [['claude-fable-5-2', 'Claude Fable 5.2'], ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5']];
function claudeModels() { return (S.modelCatalog && S.modelCatalog.length) ? S.modelCatalog.map(m => [m.id, m.name]) : FALLBACK_CLAUDE; }
function prettyModel(id) {
  if (!id) return '';
  const raw = String(id).trim(), low = raw.toLowerCase();
  const pm = /^p:([a-z0-9-]+):(.+)$/.exec(raw);
  if (pm) { const p = (S.providers || []).find(x => x.id === pm[1]); return `${p ? p.name : pm[1]} · ${pm[2]}`; }
  const k = claudeModels().find(([i]) => i === raw || i.split('-')[1] === low);
  if (k) return k[1];
  const c = raw.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(\[1m\])?$/i);
  if (c) return `Claude ${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}.${c[3]}${c[4] ? ' (1M)' : ''}`;
  const g = raw.match(/^gpt-([\d.]+)(?:-(.+))?$/i);
  if (g) return `GPT-${g[1]}${g[2] ? ' ' + g[2].split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') : ''}`;
  return raw;
}
window.prettyModel = prettyModel;
// Options for a model <select>: default, the catalog, saved custom IDs, the current value, "custom…".
function modelOptions(kind, value) {
  const cm = customModels(), s = S.settings || {};
  const base = claudeModels(); // both slots can run Claude models
  const def = kind === 'claude' ? 'پیش‌فرض CLI' : `پیش‌فرض · ${prettyModel(S.codexDefaultModel) || 'CLI'}`;
  const extra = [...cm[kind], value].filter(v => v && v !== '__custom' && !base.some(([i]) => i === v));
  const conn = (S.providers || []).filter(p => p.kind !== 'chat').flatMap(p => p.models.map(m => [`p:${p.id}:${m}`, `${p.name} · ${m}`]));
  const extra2 = extra.filter(v => !conn.some(([c]) => c === v));
  return [['', def], ...base, ...conn, ...[...new Set(extra2)].map(v => [v, prettyModel(v) === v ? v : /^p:/.test(v) ? `${prettyModel(v)} (حذف‌شده)` : `${prettyModel(v)} (${v})`]), ['__custom', 'سفارشی…']];
}
const CLAUDE_MODELS = claudeModels;
const CLAUDE_EFFORT = [['low', 'فکر: کم'], ['medium', 'فکر: متوسط'], ['high', 'فکر: زیاد'], ['xhigh', 'فکر: خیلی زیاد'], ['max', 'فکر: حداکثر']];
const CODEX_EFFORT = [['minimal', 'فکر: حداقل'], ['low', 'فکر: کم'], ['medium', 'فکر: متوسط'], ['high', 'فکر: زیاد']];
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
function customModels() { return lsGet('jarvis.customModels', { claude: [], codex: [] }); }

function fillSelect(sel, options, value) {
  sel.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if (value && !options.some(([v]) => v === value)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(value)}">${esc(value)}</option>`);
  sel.value = value || '';
}
function renderModelBar() {
  if (!S.chat) return;
  const m = S.chat.models || {}, s = S.settings || {};
  const effLabel = (list, v) => (list.find(x => x[0] === v) || [, v || 'پیش‌فرض CLI'])[1].replace('فکر: ', '');
  fillSelect($('#mClaude'), [['', `پیش‌فرض · ${prettyModel(s.builderModel) || 'CLI'}`], ...modelOptions('claude', m.builderModel).slice(1)], m.builderModel);
  fillSelect($('#mClaudeEffort'), [['', `فکر · ${effLabel(CLAUDE_EFFORT, s.builderEffort)}`], ...CLAUDE_EFFORT], m.builderEffort);
  fillSelect($('#mCodex'), [['', `پیش‌فرض · ${prettyModel(s.codexModel || S.codexDefaultModel) || 'CLI'}`], ...modelOptions('codex', m.codexModel).slice(1)], m.codexModel);
  fillSelect($('#mCodexEffort'), [['', `فکر · ${effLabel(CODEX_EFFORT, s.codexEffort)}`], ...CODEX_EFFORT], m.codexEffort);
}
function readModelBar() {
  return { builderModel: $('#mClaude').value, builderEffort: $('#mClaudeEffort').value, codexModel: $('#mCodex').value, codexEffort: $('#mCodexEffort').value };
}
async function saveModelBar() {
  if (!S.chat) return;
  try {
    const r = await api(`/chats/${S.chat.id}/models`, { body: { models: readModelBar() } });
    S.chat.models = r.models;
    renderAgents(); renderPresets();
    lsSet('jarvis.models.last', r.models); // new chats start with the last choice
    if (r.running) toast('از اجرای بعدی اعمال می‌شود');
  } catch (e) { toast(e.message, true); renderModelBar(); }
}
for (const [id, kind] of [['#mClaude', 'claude'], ['#mCodex', 'codex']]) {
  $(id).addEventListener('change', async e => {
    if (e.target.value === '__custom') {
      const v = (prompt(kind === 'claude' ? 'شناسه‌ی مدل Claude (مثلاً claude-opus-5-5 یا opus):' : 'شناسه‌ی مدل Codex:') || '').trim();
      if (!v || !/^[\w.:\-[\]/]{1,80}$/.test(v)) { if (v) toast('شناسه‌ی مدل نامعتبر است', true); renderModelBar(); return; }
      const cm = customModels();
      if (!cm[kind].includes(v)) { cm[kind].unshift(v); cm[kind] = cm[kind].slice(0, 8); lsSet('jarvis.customModels', cm); }
      S.chat.models = { ...(S.chat.models || {}), [kind === 'claude' ? 'builderModel' : 'codexModel']: v };
      renderModelBar();
    }
    saveModelBar();
  });
}
['#mClaudeEffort', '#mCodexEffort'].forEach(id => $(id).addEventListener('change', saveModelBar));

// ---------- theme: dark / light / follow Windows ----------
const THEME_NEXT = { dark: 'light', light: 'system', system: 'dark' };
const THEME_LABEL = { dark: 'تیره', light: 'روشن', system: 'هماهنگ با ویندوز' };
const lightQuery = matchMedia('(prefers-color-scheme: light)');
function themePref() { try { const t = localStorage.getItem('jarvis.theme'); return THEME_NEXT[t] ? t : 'dark'; } catch { return 'dark'; } }
function currentTheme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
function applyTheme(pref, notify = true) {
  const resolved = pref === 'system' ? (lightQuery.matches ? 'light' : 'dark') : pref;
  const changed = document.documentElement.dataset.theme !== resolved;
  document.documentElement.dataset.theme = resolved;
  const b = $('#btnTheme');
  b.innerHTML = ic(pref === 'system' ? 'monitor' : pref === 'light' ? 'sun' : 'moon');
  b.setAttribute('aria-label', `تم: ${THEME_LABEL[pref]}`);
  b.title = `تم: ${THEME_LABEL[pref]} — کلیک برای «${THEME_LABEL[THEME_NEXT[pref]]}»`;
  if (changed && notify) window.dispatchEvent(new Event('jarvis-theme')); // 3D charts re-read their colours
  if (window.jarvisDesktop && window.jarvisDesktop.setTheme) window.jarvisDesktop.setTheme(pref);
}
$('#btnTheme').onclick = () => {
  const next = THEME_NEXT[themePref()];
  try { localStorage.setItem('jarvis.theme', next); } catch {}
  applyTheme(next);
  toast(`تم: ${THEME_LABEL[next]}`);
};
lightQuery.addEventListener('change', () => { if (themePref() === 'system') applyTheme('system'); });
applyTheme(themePref(), false);

// ---------- sidebar tabs (chats / team), keyboard-accessible ----------
function showSideTab(name, focus) {
  document.querySelectorAll('.side-tab').forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  $('#tabChats').hidden = name !== 'chats';
  $('#tabTeam').hidden = name !== 'team';
  try { localStorage.setItem('jarvis.sidetab', name); } catch {}
}
document.querySelector('.side-tabs').addEventListener('click', e => { const t = e.target.closest('.side-tab'); if (t) showSideTab(t.dataset.tab); });
document.querySelector('.side-tabs').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const tabs = ['chats', 'team'];
  const cur = tabs.indexOf(document.querySelector('.side-tab.on').dataset.tab);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : (cur + 1) % 2;
  showSideTab(tabs[next], true);
});
try { const t = localStorage.getItem('jarvis.sidetab'); if (t === 'team') showSideTab('team'); } catch {}

// Escape closes the mobile sidebar.
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#sidebar').classList.remove('open'); });

loadState().then(maybeFirstRunSetup).catch(e => toast('اتصال به سرور برقرار نشد: ' + e.message, true));
$('#btnSetup').onclick = () => setupDialog();
connectEvents();

// dashboard.js is a module and may load after this script.
window.addEventListener('jarvis-dash-ready', () => { if (!S.chat) window.JarvisDash.show(); });

// ---------- settings: "custom…" model option ----------
document.getElementById('dlgBody').addEventListener('change', e => {
  const sel = e.target.closest('select[data-model]');
  if (!sel || sel.value !== '__custom') return;
  const kind = sel.dataset.model;
  const v = (prompt(kind === 'claude' ? 'شناسه‌ی مدل Claude (مثلاً claude-opus-5-5):' : 'شناسه‌ی مدل Codex:') || '').trim();
  if (!v || !/^[\w.:\-[\]/]{1,80}$/.test(v)) { if (v) toast('شناسه‌ی مدل نامعتبر است', true); sel.value = ''; return; }
  const cm = customModels();
  if (!cm[kind].includes(v)) { cm[kind].unshift(v); cm[kind] = cm[kind].slice(0, 8); lsSet('jarvis.customModels', cm); }
  const label = prettyModel(v) === v ? v : `${prettyModel(v)} (${v})`;
  sel.insertAdjacentHTML('afterbegin', `<option value="${esc(v)}">${esc(label)}</option>`);
  sel.value = v;
});

// ---------- desktop shell: custom title bar ----------
(function windowControls() {
  const d = window.jarvisDesktop;
  if (!d || !d.minimize) return;
  document.documentElement.classList.add('desktop');
  $('#winControls').hidden = false;
  $('#winMin').onclick = () => d.minimize();
  $('#winMax').onclick = () => d.toggleMaximize();
  $('#winClose').onclick = () => d.close();
  $('.topbar').addEventListener('dblclick', e => { if (!e.target.closest('button, a, select, input, .brand, .chip')) d.toggleMaximize(); });
  const sync = st => {
    const b = $('#winMax');
    b.innerHTML = ic(st.maximized ? 'copy' : 'square');
    b.setAttribute('aria-label', st.maximized ? 'برگرداندن اندازه' : 'تمام‌صفحه');
    b.title = b.getAttribute('aria-label');
  };
  d.windowState().then(sync).catch(() => {});
  d.onWindowState(sync);
})();

// ---------- HUD clock ----------
(function hudClock() {
  const t = $('#hudTime'), dEl = $('#hudDate');
  if (!t) return;
  const tf = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const df = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long' });
  const greet = h => h < 5 ? 'شب بخیر' : h < 12 ? 'صبح بخیر' : h < 15 ? 'ظهر بخیر' : h < 19 ? 'عصر بخیر' : 'شب بخیر';
  const tick = () => { const n = new Date(); t.textContent = tf.format(n); dEl.textContent = df.format(n); homeEl('#homeGreet').textContent = `${greet(n.getHours())}. جارویس آماده‌ی خدمت است.`; };
  tick(); setInterval(tick, 1000);
})();

// ---------- home command: new chat in the current project + first message ----------
$('#homeCmd').onsubmit = async e => {
  e.preventDefault();
  const text = homeEl('#homeInput').value.trim();
  if (!S.projectId) { toast('اول یک پروژه اضافه کنید'); addProjectDialog(); return; }
  if (!text) { homeEl('#homeInput').focus(); return; }
  const btn = $('#homeSend');
  btn.disabled = true;
  try {
    await newChat();
    const mode = document.querySelector('input[name=mode]:checked').value;
    await api(`/chats/${S.chat.id}/send`, { body: { text, mode } });
    homeEl('#homeInput').value = '';
  } catch (err) {
    toast(err.message, true);
    if (err.data && err.data.needSetup) setupDialog();
  } finally { btn.disabled = false; }
};

// ---------- image attachments (paste, drop, or the paperclip) ----------
async function loadAttachment(img) {
  if (!S.chat || img.src) return;
  try {
    const r = await fetch(`/api/chats/${S.chat.id}/attachment?file=${encodeURIComponent(img.dataset.att)}`, { headers: { 'X-Jarvis': '1', 'X-Jarvis-Token': token() } });
    if (!r.ok) throw new Error(r.status);
    img.src = URL.createObjectURL(await r.blob());
  } catch { img.alt = 'تصویر پیدا نشد'; img.classList.add('missing'); }
}
function renderAttachments() {
  const strip = $('#attachStrip');
  strip.hidden = !S.attach.length;
  strip.innerHTML = S.attach.map((a, i) => `<span class="att"><img src="${a.url}" alt="تصویر ${i + 1}"><button type="button" data-unattach="${i}" aria-label="حذف تصویر" title="حذف">${ic('x', 'sm')}</button></span>`).join('')
    + (S.attach.length ? `<span class="att-note">${ic('image', 'sm')}${S.attach.length.toLocaleString('fa-IR')} تصویر — سازنده آن‌ها را می‌بیند</span>` : '');
}
function clearAttachments() { S.attach.forEach(a => URL.revokeObjectURL(a.url)); S.attach = []; renderAttachments(); }
async function addImages(files) {
  if (!S.chat) { toast('اول یک گفتگو باز کنید'); return; }
  for (const f of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast('فقط تصویر png، jpg، gif یا webp', true); continue; }
    if (f.size > 10 * 1024 * 1024) { toast('تصویر بزرگ‌تر از ۱۰ مگابایت است', true); continue; }
    if (S.attach.length >= 8) { toast('حداکثر ۸ تصویر در هر پیام', true); break; }
    const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(f); });
    try {
      const r = await api(`/chats/${S.chat.id}/attach`, { body: { type: f.type, data } });
      S.attach.push({ file: r.file, url: URL.createObjectURL(f) });
      renderAttachments();
    } catch (e) { toast(e.message, true); }
  }
}
$('#btnAttach').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => { addImages([...e.target.files]); e.target.value = ''; };
$('#attachStrip').onclick = e => { const b = e.target.closest('[data-unattach]'); if (!b) return; const [a] = S.attach.splice(+b.dataset.unattach, 1); if (a) URL.revokeObjectURL(a.url); renderAttachments(); };
$('#input').addEventListener('paste', e => { const imgs = [...(e.clipboardData || {}).files || []].filter(f => f.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); addImages(imgs); } });
const composerEl = $('#composer');
composerEl.addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); composerEl.classList.add('drop'); } });
composerEl.addEventListener('dragleave', () => composerEl.classList.remove('drop'));
composerEl.addEventListener('drop', e => { composerEl.classList.remove('drop'); const imgs = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); addImages(imgs); } });

// ---------- prompt history (↑ / ↓ in an empty or top-of-text composer) ----------
function pushHistory(text) {
  let h = []; try { h = JSON.parse(localStorage.getItem('jarvis.history')) || []; } catch {}
  h = [text, ...h.filter(x => x !== text)].slice(0, 100);
  try { localStorage.setItem('jarvis.history', JSON.stringify(h)); } catch {}
  histPos = -1;
}
let histPos = -1, histDraft = '';
function historyList() {
  let h = []; try { h = JSON.parse(localStorage.getItem('jarvis.history')) || []; } catch {}
  const own = S.chat ? S.chat.messages.filter(m => m.agent === 'user' && m.kind === 'text').map(m => m.text).reverse() : [];
  return [...new Set([...own, ...h])];
}
$('#input').addEventListener('keydown', e => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const el = e.target;
  const atTop = el.selectionStart === 0 && el.selectionEnd === 0;
  const atEnd = el.selectionStart === el.value.length;
  if (e.key === 'ArrowUp' && !(atTop || !el.value) && histPos < 0) return;
  if (e.key === 'ArrowDown' && (histPos < 0 || !atEnd)) return;
  const list = historyList();
  if (!list.length) return;
  e.preventDefault();
  if (histPos < 0) histDraft = el.value;
  histPos = e.key === 'ArrowUp' ? Math.min(histPos + 1, list.length - 1) : histPos - 1;
  el.value = histPos < 0 ? histDraft : list[histPos];
  const p = e.key === 'ArrowUp' ? 0 : el.value.length;
  el.setSelectionRange(p, p);
});
$('#input').addEventListener('input', () => { histPos = -1; });

// ---------- quick prompts ----------
function quickItems() {
  return ((S.settings && S.settings.savedPrompts) || []).map(line => {
    const m = line.match(/^([^:：]{1,30})[:：]\s*(.+)$/);
    return m ? { title: m[1].trim(), text: m[2].trim() } : { title: line.length > 28 ? line.slice(0, 27) + '…' : line, text: line };
  }).concat((S.pluginCommands || []).map(c => ({ title: c.title, text: c.text })));
}
function renderQuick() {
  const box = $('#quickPrompts');
  const items = quickItems();
  box.innerHTML = items.map((q, i) => `<button type="button" data-quick="${i}" title="${esc(q.text)}">${ic('zap', 'sm')}${esc(q.title)}</button>`).join('')
    + `<button type="button" class="add" data-quickedit="1" title="افزودن یا ویرایش فرمان‌های آماده">${ic(items.length ? 'pencil' : 'plus', 'sm')}${items.length ? '' : 'فرمان آماده'}</button>`;
}
$('#quickPrompts').onclick = e => {
  if (e.target.closest('[data-quickedit]')) { settingsDialog('global').then(() => { const t = [...document.querySelectorAll('#dlgBody .stab')].find(b => /فرمان/.test(b.textContent)); if (t) t.click(); }); return; }
  const b = e.target.closest('[data-quick]'); if (!b) return;
  const q = quickItems()[+b.dataset.quick]; if (!q) return;
  const el = $('#input');
  el.value = el.value.trim() ? el.value.trimEnd() + '\n' + q.text : q.text;
  el.focus();
};

// ---------- Ctrl+K: search & command palette ----------
function paletteItems() {
  const p = S.projects.find(x => x.id === S.projectId);
  const acts = [
    { icon: 'house', label: 'صفحه‌ی اصلی', run: goHome },
    S.projectId && { icon: 'plus', label: 'گفتگوی جدید', run: newChat },
    { icon: 'settings', label: 'تنظیمات', run: () => settingsDialog('global') },
    p && { icon: 'sliders-horizontal', label: `تنظیمات پروژه — ${p.name}`, run: () => settingsDialog('project') },
    p && { icon: 'file-diff', label: 'تغییرات پروژه (فایل به فایل)', run: diffDialog },
    p && { icon: 'file-text', label: 'قوانین پروژه (CLAUDE.md / AGENTS.md)', run: rulesDialog },
    p && { icon: 'play', label: 'پیش‌نمایش پروژه', run: previewDialog },
    S.chat && { icon: 'download', label: 'خروجی این گفتگو', run: exportChat },
    { icon: 'plug', label: 'اتصال حساب‌ها', run: () => setupDialog() },
    { icon: 'activity', label: 'عیب‌یابی و به‌روزرسانی CLIها', run: diagDialog },
    { icon: 'archive', label: 'پشتیبان‌گیری و بازگردانی', run: backupDialog },
    { icon: 'folder-plus', label: 'افزودن پروژه', run: () => addProjectDialog() },
    { icon: 'palette', label: 'ظاهر برنامه (۱۲ مدل)', run: skinDialog },
    { icon: 'puzzle', label: 'اتصال‌دهنده‌ها و پلاگین‌ها', run: () => extDialog('connectors') },
    { icon: 'clock', label: 'صف کارها (اجرای شبانه)', run: () => queueDialog() },
    { icon: 'radar', label: 'اتاق عملیات سه‌بعدی', run: () => window.openOps && openOps() },
    { icon: 'sun', label: 'تغییر تم', run: () => $('#btnTheme').click() },
  ].filter(Boolean).map(a => ({ ...a, kind: 'فرمان' }));
  const projs = S.projects.map(x => ({ icon: 'folder', label: x.name, sub: x.path, kind: 'پروژه', run: () => selectProject(x.id) }));
  const chats = S.chats.map(c => ({ icon: 'message-square', label: c.title, sub: (S.projects.find(x => x.id === c.projectId) || {}).name || '', kind: 'گفتگو',
    run: async () => { if (c.projectId !== S.projectId) selectProject(c.projectId); await openChat(c.id); } }));
  return [...acts, ...projs, ...chats];
}
function paletteDialog() {
  const all = paletteItems();
  dialog(`<div class="dlg-scroll palette"><div class="pal-input">${ic('search')}<input id="palQ" dir="auto" placeholder="دنبال پروژه، گفتگو یا فرمان بگردید…" autocomplete="off" aria-label="جستجو" aria-controls="palList"></div>
    <ul class="pal-list" id="palList" role="listbox"></ul><div class="help">↑ ↓ برای حرکت · Enter برای اجرا · Esc برای بستن</div></div>`);
  let sel = 0, shown = [];
  const draw = () => {
    const q = $('#palQ').value.trim().toLowerCase();
    shown = (q ? all.filter(i => (i.label + ' ' + (i.sub || '')).toLowerCase().includes(q)) : all).slice(0, 40);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    $('#palList').innerHTML = shown.length ? shown.map((i, n) => `<li role="option" data-i="${n}" aria-selected="${n === sel}" class="${n === sel ? 'on' : ''}">${ic(i.icon, 'sm')}<span class="pl" dir="auto">${esc(i.label)}</span>${i.sub ? `<span class="ps" dir="auto">${esc(i.sub)}</span>` : ''}<em>${i.kind}</em></li>`).join('') : '<li class="empty">چیزی پیدا نشد.</li>';
    const on = $('#palList .on'); if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const go = n => { const it = shown[n]; if (!it) return; $('#dlg').close(); Promise.resolve(it.run()).catch(e => toast(e.message, true)); };
  $('#palQ').oninput = () => { sel = 0; draw(); };
  $('#palQ').onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
  };
  $('#palList').onclick = e => { const li = e.target.closest('li[data-i]'); if (li) go(+li.dataset.i); };
  draw();
  setTimeout(() => $('#palQ').focus(), 30);
}
$('#btnPalette').onclick = paletteDialog;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK')) { e.preventDefault(); paletteDialog(); }
});

// ---------- project rules: CLAUDE.md / AGENTS.md ----------
async function rulesDialog() {
  const p = S.projects.find(x => x.id === S.projectId);
  if (!p) return;
  dialog('<div class="dlg-scroll"><h3>قوانین پروژه</h3><div>…</div></div>', true);
  let r; try { r = await api(`/projects/${p.id}/rules`); } catch (e) { toast(e.message, true); return; }
  const tab = (k, name, who) => `<div class="field"><label>${ic('file-text', 'sm')} <span dir="ltr">${name}</span> <span class="help">— ${who}${r[k] === null ? ' · هنوز ساخته نشده' : ''}</span></label>
    <textarea id="rule_${k}" class="rules" dir="auto" rows="12" placeholder="مثلاً: از TypeScript استفاده کن · تست‌ها با vitest · نام‌ها انگلیسی · …">${esc(r[k] || '')}</textarea>
    <div class="row-gap"><button type="button" class="btn small primary" data-rsave="${k}">${ic('save', 'sm')}ذخیره‌ی ${name}</button><button type="button" class="btn small ghost" data-rcopy="${k}">${ic('copy', 'sm')}کپی به ${k === 'claude' ? 'AGENTS.md' : 'CLAUDE.md'}</button></div></div>`;
  $('#dlgBody').innerHTML = `<div class="dlg-scroll"><h3>${ic('file-text')}قوانین پروژه — ${esc(p.name)}</h3>
    <p class="help">قوانین و قراردادهای پروژه که ایجنت‌ها در هر اجرا می‌خوانند. Claude فایل CLAUDE.md و Codex فایل AGENTS.md را می‌خواند؛ بهتر است هر دو یکی باشند.</p>
    ${tab('claude', 'CLAUDE.md', 'برای Claude')}${tab('agents', 'AGENTS.md', 'برای Codex')}</div>
    <div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`;
  $('#dlgBody').onclick = async e => {
    const sv = e.target.closest('[data-rsave]'), cp = e.target.closest('[data-rcopy]');
    if (cp) { const from = cp.dataset.rcopy, to = from === 'claude' ? 'agents' : 'claude'; $('#rule_' + to).value = $('#rule_' + from).value; toast('کپی شد؛ برای ثبت «ذخیره» را بزنید'); return; }
    if (!sv) return;
    try { await api(`/projects/${p.id}/rules`, { body: { which: sv.dataset.rsave, text: $('#rule_' + sv.dataset.rsave).value } }); toast('ذخیره شد'); } catch (err) { toast(err.message, true); }
  };
}

// ---------- live preview of the project ----------
async function previewDialog(refresh) {
  const p = S.projects.find(x => x.id === S.projectId);
  if (!p) return;
  if (refresh && (!$('#dlg').open || S.previewOpen !== p.id)) return;
  S.previewOpen = p.id;
  let st; try { st = await api(`/projects/${p.id}/preview`); } catch (e) { toast(e.message, true); return; }
  const s = S.settings || {};
  const html = `<div class="dlg-scroll"><h3>${ic('play')}پیش‌نمایش — ${esc(p.name)}</h3>
    <p class="help">سرور توسعه‌ی پروژه را اجرا می‌کند تا نتیجه‌ی کار ایجنت‌ها را ببینید. دستور و آدرس در «تنظیمات پروژه ← زمان‌بندی و پیش‌نمایش» تنظیم می‌شوند.</p>
    <div class="pv-state ${st.running ? 'on' : ''}">${ic(st.running ? 'circle-check' : 'circle-stop', 'sm')}${st.running ? 'در حال اجرا' : 'خاموش'}${st.url ? ` · <code dir="ltr">${esc(st.url)}</code>` : st.running ? ' · در انتظار آدرس…' : ''}</div>
    ${st.log ? `<pre class="pv-log" dir="ltr">${esc(st.log.replace(/\x1b\[[0-9;]*m/g, ''))}</pre>` : ''}</div>
    <div class="dlg-actions">
      ${st.running ? `<button type="button" class="btn primary" id="pvOpen" ${st.url ? '' : 'disabled'}>${ic('external-link', 'sm')}باز کردن</button><button type="button" class="btn danger" id="pvStop">${ic('circle-stop', 'sm')}توقف</button>`
        : `<button type="button" class="btn primary" id="pvStart">${ic('play', 'sm')}اجرا</button>`}
      <button type="button" class="btn ghost" id="pvSettings">${ic('sliders-horizontal', 'sm')}تنظیمات پروژه</button>
      <button class="btn ghost" value="cancel">بستن</button></div>`;
  dialog(html, true);
  const act = async action => { try { await api(`/projects/${p.id}/preview`, { body: { action } }); } catch (e) { toast(e.message, true); } previewDialog(); renderProjectInfo(); };
  if ($('#pvStart')) $('#pvStart').onclick = () => act('start');
  if ($('#pvStop')) $('#pvStop').onclick = () => act('stop');
  if ($('#pvOpen')) $('#pvOpen').onclick = () => window.open(st.url, '_blank');
  $('#pvSettings').onclick = () => settingsDialog('project');
  $('#dlg').addEventListener('close', () => { S.previewOpen = null; }, { once: true });
}

// ---------- diagnostics + CLI updates ----------
async function diagDialog() {
  dialog('<div class="dlg-scroll"><h3>عیب‌یابی</h3><div>…</div></div>', true);
  let d; try { d = await api('/diagnostics'); } catch (e) { toast(e.message, true); return; }
  const row = (k, v, bad) => `<tr><th>${k}</th><td dir="ltr" class="${bad ? 'bad' : ''}">${esc(v ?? '—')}</td></tr>`;
  const auth = { 'claude.ai': 'اشتراک Claude (Pro/Max)', apiKey: 'کلید API', cli: 'ورود CLI' }[d.auth] || (d.auth ? d.auth : 'وصل نیست');
  $('#dlgBody').innerHTML = `<div class="dlg-scroll"><h3>${ic('activity')}عیب‌یابی</h3>
    <table class="diag">
      ${row('Claude CLI', d.clis.claude || 'پیدا نشد', !d.clis.claude)}${row('نسخه‌ی Claude', d.versions.claude)}
      ${row('Codex CLI', d.clis.codex || 'پیدا نشد', !d.clis.codex)}${row('نسخه‌ی Codex', d.versions.codex)}
      ${row('git', d.clis.git || 'پیدا نشد', !d.clis.git)}${row('GitHub CLI (gh)', d.clis.gh || 'نصب نیست (برای ساخت PR لازم است)')}${row('graphify', d.clis.graphify || 'نصب نیست')}
      <tr><th>ورود Claude</th><td>${esc(auth)}</td></tr>
      ${row('پوشه‌ی داده', d.dataDir)}${row('Node', d.node)}${row('سیستم', d.platform)}
      <tr><th>اجراهای فعال</th><td>${fa(d.running)}</td></tr>
    </table>
    <h4>نسخه‌ی جارویس</h4><div id="appVer" class="upd">…</div>
    <h4>به‌روزرسانی CLIها</h4><div id="updBox" class="help">در حال بررسی نسخه‌های تازه (نیاز به اینترنت)…</div>
    ${d.log ? `<details><summary>آخرین خطوط لاگ (<span dir="ltr">${esc(d.log.file)}</span>)</summary><pre class="pv-log" dir="ltr">${esc(d.log.tail || '(خالی)')}</pre></details>` : ''}
    </div><div class="dlg-actions"><button type="button" class="btn ghost" id="diagCopy">${ic('copy', 'sm')}کپی گزارش</button><button class="btn ghost" value="cancel">بستن</button></div>`;
  renderAppVersion();
  $('#diagCopy').onclick = async () => { const { setup, ...rest } = d; try { await navigator.clipboard.writeText(JSON.stringify(rest, null, 2)); toast('گزارش کپی شد'); } catch { toast('کپی نشد', true); } };
  try {
    const u = await api('/setup/updates');
    const line = (n, x) => `<div class="upd">${n}: <b dir="ltr">${esc(x.current || '?')}</b> ${x.latest ? (x.update ? `→ نسخه‌ی تازه <b dir="ltr">${esc(x.latest)}</b> <button type="button" class="btn small primary" data-upd="${n.toLowerCase()}">به‌روزرسانی</button>` : '· به‌روز است') : '· بررسی نشد'}</div>`;
    if ($('#updBox')) $('#updBox').innerHTML = line('Claude', u.claude) + line('Codex', u.codex);
  } catch { if ($('#updBox')) $('#updBox').textContent = 'بررسی نسخه‌ها ناموفق بود.'; }
  $('#dlgBody').onclick = async e => {
    const b = e.target.closest('[data-upd]'); if (!b) return;
    try { await api('/setup/update', { body: { name: b.dataset.upd } }); toast('پنجره‌ی به‌روزرسانی باز شد؛ بعد از پایان، جارویس را دوباره باز کنید.'); } catch (err) { toast(err.message, true); }
  };
}
$('#btnDiag').onclick = diagDialog;

// ---------- backup / restore ----------
function backupDialog() {
  dialog(`<div class="dlg-scroll"><h3>${ic('archive')}پشتیبان‌گیری و بازگردانی</h3>
    <p class="help">تنظیمات، پروژه‌ها، ساب‌ایجنت‌ها و همه‌ی گفتگوها در یک فایل JSON ذخیره می‌شوند. کلیدهای API و توکن‌ها داخل فایل نیستند.</p>
    <div class="row-gap"><button type="button" class="btn primary" id="bkExport">${ic('download', 'sm')}ذخیره‌ی فایل پشتیبان</button>
    <button type="button" class="btn" id="bkImport">${ic('folder-open', 'sm')}بازگردانی از فایل…</button><input type="file" id="bkFile" accept="application/json,.json" hidden></div>
    <p class="help">بازگردانی چیزی را پاک نمی‌کند: فقط پروژه‌ها، ساب‌ایجنت‌ها و گفتگوهایی که اینجا نیستند اضافه می‌شوند و تنظیمات با فایل جایگزین می‌شود.</p></div>
    <div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`);
  $('#bkExport').onclick = async () => {
    try {
      const data = await api('/backup');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
      a.download = `jarvis-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast(e.message, true); }
  };
  $('#bkImport').onclick = () => $('#bkFile').click();
  $('#bkFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const r = await api('/backup/restore', { body: { data } });
      toast(`بازگردانی شد: ${fa(r.projects)} پروژه، ${fa(r.subagents)} ساب‌ایجنت، ${fa(r.chats)} گفتگو`);
      $('#dlg').close();
      await loadState();
    } catch (err) { toast('بازگردانی ناموفق بود: ' + err.message, true); }
  };
}
$('#btnBackup').onclick = backupDialog;

// ---------- looks: 12 skins (design/skins.cjs) ----------
const SKINS = window.JARVIS_SKINS || [];
function currentSkin() { return document.documentElement.dataset.skin || 'holo'; }
function applySkin(id) {
  if (!SKINS.some(k => k.id === id)) id = 'holo';
  if (id === 'holo') delete document.documentElement.dataset.skin; else document.documentElement.dataset.skin = id;
  try { localStorage.setItem('jarvis.skin', id); } catch {}
  window.dispatchEvent(new Event('jarvis-theme')); // 3D charts re-read their colours
}
function skinCard(k, mode, on) {
  const c = k[mode], r = Math.round(k.radius * 0.5);
  const bgPattern = k.bg === 'grid' ? `background-image:linear-gradient(${c.muted}22 1px,transparent 1px),linear-gradient(90deg,${c.muted}22 1px,transparent 1px);background-size:10px 10px;`
    : k.bg === 'dots' ? `background-image:radial-gradient(${c.muted}55 1px,transparent 1.2px);background-size:8px 8px;`
    : k.bg === 'aurora' ? `background-image:radial-gradient(60% 50% at 20% 20%,${c.ga}55,transparent 70%),radial-gradient(50% 50% at 85% 40%,${c.gb}44,transparent 70%);` : '';
  return `<button type="button" class="skin ${on ? 'on' : ''}" data-skin="${k.id}" aria-pressed="${on}" title="${esc(k.desc)}">
    <span class="sk-prev" style="background-color:${c.bg};${bgPattern}">
      <span class="sk-side" style="background:${c.s1};border-radius:${r}px"><i style="background:${c.ga}"></i><i style="background:${c.s3}"></i><i style="background:${c.s3}"></i></span>
      <span class="sk-main" style="background:${c.s1};border-radius:${r}px${k.glass ? ';opacity:.92' : ''}">
        <span class="sk-orb" style="border-color:${c.ga};box-shadow:0 0 10px ${c.ga}66"></span>
        <span class="sk-line" style="background:${c.fg}"></span><span class="sk-line short" style="background:${c.muted}"></span>
        <span class="sk-row"><i style="background:${c.claude}"></i><i style="background:${c.codex}"></i><b style="background:linear-gradient(135deg,${c.ga},${c.gb});border-radius:${Math.max(2, r)}px"></b></span>
      </span>
    </span>
    <span class="sk-name">${esc(k.name)} <em dir="ltr">${esc(k.en)}</em>${on ? ` <span class="sk-check">${ic('check', 'sm')}</span>` : ''}</span>
    <span class="sk-desc">${esc(k.desc)}</span>
  </button>`;
}
function skinDialog() {
  const draw = () => {
    const mode = currentTheme();
    const pref = themePref();
    $('#dlgBody').innerHTML = `<div class="dlg-scroll"><h3>${ic('palette')}ظاهر برنامه</h3>
      <p class="help">یکی از ۱۲ مدل را انتخاب کنید؛ فوراً اعمال می‌شود. هر مدل نسخه‌ی تیره و روشن دارد.</p>
      <div class="sk-modes" role="radiogroup" aria-label="حالت رنگ">${['dark', 'light', 'system'].map(m => `<button type="button" data-mode="${m}" class="${pref === m ? 'on' : ''}" aria-pressed="${pref === m}">${ic(m === 'system' ? 'monitor' : m === 'light' ? 'sun' : 'moon', 'sm')}${THEME_LABEL[m]}</button>`).join('')}</div>
      <div class="skins">${SKINS.map(k => skinCard(k, mode, k.id === currentSkin())).join('')}</div></div>
      <div class="dlg-actions"><button class="btn primary" value="cancel">تمام</button></div>`;
  };
  dialog('<div class="dlg-scroll"></div>', true);
  draw();
  $('#dlgBody').onclick = e => {
    const k = e.target.closest('#dlgBody button[data-skin]'); // not <html data-skin>
    if (k) { applySkin(k.dataset.skin); draw(); const sel = $(`#dlgBody [data-skin="${k.dataset.skin}"]`); if (sel) sel.focus(); return; }
    const m = e.target.closest('#dlgBody button[data-mode]');
    if (m) { try { localStorage.setItem('jarvis.theme', m.dataset.mode); } catch {} applyTheme(m.dataset.mode); draw(); }
  };
}
$('#btnSkin').onclick = skinDialog;

// ---------- app updates (desktop: GitHub Releases) ----------
const UPDATE_TEXT = {
  checking: 'در حال بررسی نسخه‌ی تازه…', latest: 'جارویس به‌روز است.', unsupported: 'به‌روزرسانی خودکار فقط در نسخه‌ی نصب‌شده کار می‌کند.',
};
let lastUpdate = { state: 'idle' };
function updateBar(st) {
  let bar = document.getElementById('updateBar');
  if (st.state !== 'ready') { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'updateBar'; bar.className = 'update-bar'; bar.setAttribute('role', 'status'); document.body.appendChild(bar); }
  bar.innerHTML = `${ic('download', 'sm')}<span>نسخه‌ی تازه‌ی جارویس (${esc(st.version || '')}) آماده‌ی نصب است.</span><button type="button" class="btn small primary" id="updInstall">نصب و راه‌اندازی دوباره</button><button type="button" class="icon-btn sm" id="updLater" aria-label="بعداً" title="بعداً (با بستن کامل برنامه خودکار نصب می‌شود)">${ic('x', 'sm')}</button>`;
  $('#updInstall').onclick = () => {
    if (S.chats.some(c => c.status === 'running' || c.status === 'waiting') && !confirm('ایجنت‌ها در حال کارند و با نصب متوقف می‌شوند. ادامه می‌دهید؟')) return;
    window.jarvisDesktop.updateAction('install');
  };
  $('#updLater').onclick = () => bar.remove();
}
async function renderAppVersion() {
  const box = document.getElementById('appVer');
  if (!box) return;
  const d = window.jarvisDesktop;
  if (!d || !d.appInfo) { box.textContent = 'نسخه‌ی وب (بدون به‌روزرسانی خودکار)'; return; }
  const info = await d.appInfo().catch(() => null);
  const st = lastUpdate.state !== 'idle' ? lastUpdate : (info && info.update) || {};
  const msg = st.state === 'downloading' ? `در حال دانلود نسخه‌ی ${esc(st.version || '')}… ${fa(st.percent || 0)}٪`
    : st.state === 'ready' ? `نسخه‌ی ${esc(st.version || '')} آماده‌ی نصب است`
    : st.state === 'error' ? `خطا در بررسی: <span dir="ltr">${esc(st.message || '')}</span>` : (UPDATE_TEXT[st.state] || '');
  box.innerHTML = `نسخه‌ی فعلی: <b dir="ltr">${esc(info ? info.version : '?')}</b> ${msg ? '· ' + msg : ''}
    ${st.state === 'ready' ? '<button type="button" class="btn small primary" id="verInstall">نصب</button>' : `<button type="button" class="btn small" id="verCheck" ${st.state === 'checking' || st.state === 'downloading' ? 'disabled' : ''}>بررسی به‌روزرسانی</button>`}`;
  if ($('#verCheck')) $('#verCheck').onclick = () => d.updateAction('check');
  if ($('#verInstall')) $('#verInstall').onclick = () => d.updateAction('install');
}
if (window.jarvisDesktop && window.jarvisDesktop.onUpdate) {
  window.jarvisDesktop.onUpdate(st => {
    lastUpdate = st;
    updateBar(st);
    renderAppVersion();
    if (st.manual && st.state === 'latest') toast(UPDATE_TEXT.latest);
    if (st.manual && st.state === 'error') toast('بررسی به‌روزرسانی ناموفق بود: ' + (st.message || ''), true);
  });
}

// ---------- roles: who builds and who reviews (an account or a connection) ----------
function roleAgent(role) {
  const st = (S.chat && S.chat.models) ? { ...(S.settings || {}), ...Object.fromEntries(Object.entries(S.chat.models).filter(([, v]) => v)) } : (S.settings || {});
  const spec = role === 'builder' ? st.builderModel : st.reviewer === 'claude' ? st.reviewerModel : st.codexModel;
  const m = /^p:([a-z0-9-]+):(.+)$/.exec(spec || '');
  if (m) { const p = (S.providers || []).find(x => x.id === m[1]); return { name: p ? p.name : m[1], model: m[2], provider: p || { id: m[1], name: m[1] + ' (حذف‌شده)', hasKey: false } }; }
  if (role === 'builder') return { name: 'Claude', model: spec || '' };
  return st.reviewer === 'claude' ? { name: 'Claude', model: spec || '' } : { name: 'Codex', model: spec || '' };
}
function renderRoles() {
  const b = roleAgent('builder').name, r = roleAgent('reviewer').name;
  const sub = document.getElementById('brandSub');
  if (sub) sub.textContent = 'تیم ایجنت‌های برنامه‌نویس';
  const p = homeEl('#homeRoles');
  if (S.subagents) renderSubagents();
  const ba = roleAgent('builder'), ra = roleAgent('reviewer');
  const who = x => prettyModel(x.provider ? `p:${x.provider.id}:${x.model}` : x.model || (x.name === 'Codex' ? S.codexDefaultModel : '')) || x.name;
  if (p) p.textContent = `سازنده (${who(ba)}) کد را می‌نویسد، تستر (${who(ra)}) تحلیل و تست می‌کند و باگ‌ها را گزارش می‌دهد، و سازنده آن‌ها را رفع می‌کند — تا وقتی تستر تأیید کند.`;
}

// ---------- connections (custom APIs: DeepSeek, Kimi, GLM, OpenAI, …) ----------
function providersBlock() {
  const list = S.providers || [];
  const rows = list.map(p => `<div class="prov-row">
      <span class="dot ${p.hasKey ? 'on' : 'warn'}"></span><b>${esc(p.name)}</b>
      <span class="help">${p.kind === 'chat' ? 'فقط چت، صدا و تلگرام' : p.kind === 'openai' ? 'OpenAI Responses · موتور Codex' : 'سازگار با Anthropic · موتور Claude Code'} · ${fa(p.models.length)} مدل${p.hasKey ? '' : ' · <span class="pi-warn">کلید ندارد</span>'}</span>
      <button type="button" class="btn small ghost" data-editprov="${esc(p.id)}">${ic('pencil', 'sm')}ویرایش</button></div>`).join('');
  return `<div class="wz-item ${list.some(p => p.hasKey) ? 'ok' : ''}">
    <div class="wz-icon">${ic('globe')}</div>
    <div class="wz-body">
      <h4>اتصال‌های دیگر <small class="help">DeepSeek، Kimi، GLM، MiniMax، OpenAI و هر API سازگار</small></h4>
      ${rows || '<div class="help">هنوز اتصالی اضافه نشده.</div>'}
      <div class="row-gap"><button type="button" class="btn btn-primary btn-sm" data-addprov="1">${ic('plus')}افزودن اتصال</button></div>
      <div class="wz-note">${ic('info', 'sm')}<span>بعد از افزودن، در «تنظیمات ← مدل‌ها» یا پایین کادر پیام، آن را برای <b>سازنده</b> یا <b>تستر</b> انتخاب کنید. هر ترکیبی کار می‌کند؛ مثلاً DeepSeek بسازد و Codex تست کند.</span></div>
    </div></div>`;
}

async function providerDialog(id) {
  const p = id ? (S.providers || []).find(x => x.id === id) : null;
  const presets = S.providerPresets || [];
  const pre = p ? presets.find(x => x.id === p.preset) : presets[0];
  const v = p || { name: pre.name, kind: pre.kind, baseUrl: pre.baseUrl, models: pre.models, preset: pre.id };
  dialog(`<div class="dlg-scroll"><h3>${ic('globe')}${p ? 'ویرایش اتصال — ' + esc(p.name) : 'افزودن اتصال'}</h3>
    ${p ? '' : `<div class="field"><label for="pvPreset">سرویس</label><select id="pvPreset">${presets.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>`}
    <div class="field"><label for="pvName">نام (هر چه دوست دارید)</label><input id="pvName" value="${esc(v.name)}" dir="auto"></div>
    <div class="field"><label>نوع API</label>
      <label class="check"><input type="radio" name="pvKind" value="anthropic" ${v.kind !== 'openai' ? 'checked' : ''}> سازگار با Anthropic — با موتور Claude Code اجرا می‌شود (DeepSeek، Kimi، GLM، MiniMax)</label>
      <label class="check"><input type="radio" name="pvKind" value="openai" ${v.kind === 'openai' ? 'checked' : ''}> سازگار با OpenAI Responses — با موتور Codex اجرا می‌شود (OpenAI)</label>
      <label class="check"><input type="radio" name="pvKind" value="chat" ${v.kind === 'chat' ? 'checked' : ''}> سازگار با OpenAI Chat — فقط برای چت، صدا و تلگرام (Gemini، Grok، OpenRouter، Groq، NVIDIA، Ollama)</label>
      <div class="help" id="pvKindHelp"></div></div>
    <div class="field"><label for="pvUrl">آدرس API (Base URL)</label><input id="pvUrl" dir="ltr" value="${esc(v.baseUrl)}" placeholder="https://api.example.com/anthropic"></div>
    <div class="field"><label for="pvKey">کلید API <a href="#" id="pvKeyLink" hidden>گرفتن کلید ↗</a></label>
      <input id="pvKey" type="password" dir="ltr" autocomplete="off" placeholder="${p && p.hasKey ? 'کلید ذخیره شده — برای تغییر، کلید جدید را وارد کنید' : 'sk-…'}">
      <div class="help">${ic('lock', 'sm')} فقط روی همین کامپیوتر و رمزنگاری‌شده ذخیره می‌شود و فقط به همین سرویس فرستاده می‌شود. ورود Claude و ChatGPT شما هرگز به این سرویس داده نمی‌شود.</div></div>
    <div class="field"><label for="pvModels">مدل‌ها (با کاما جدا کنید)</label><input id="pvModels" dir="ltr" value="${esc((v.models || []).join(', '))}" placeholder="deepseek-chat, deepseek-reasoner">
      <div class="row-gap"><button type="button" class="btn small" id="pvFetch">${ic('refresh-cw', 'sm')}دریافت فهرست مدل‌ها</button><button type="button" class="btn small" id="pvTest">${ic('zap', 'sm')}آزمایش اتصال</button>${p && p.hasKey ? `<button type="button" class="btn small" id="pvTrial" title="یک کار کوچک واقعی: یک بار در نقش سازنده (ساختن یک فایل) و یک بار در نقش تستر">${ic('play', 'sm')}آزمایش کامل (سازنده و تستر)</button>` : ''}</div>
      <div id="pvOut" class="help" role="status"></div></div>
    <div class="field"><label>قیمت برای هر ۱ میلیون توکن (دلار، اختیاری — برای محاسبه‌ی هزینه)</label>
      <div class="field-row"><div class="field"><label for="pvPin" class="help">ورودی</label><input id="pvPin" type="number" min="0" step="0.01" dir="ltr" value="${esc(v.priceIn || 0)}"></div>
      <div class="field"><label for="pvPc" class="help">ورودی کش‌شده</label><input id="pvPc" type="number" min="0" step="0.01" dir="ltr" value="${esc(v.priceCached || 0)}"></div>
      <div class="field"><label for="pvPout" class="help">خروجی</label><input id="pvPout" type="number" min="0" step="0.01" dir="ltr" value="${esc(v.priceOut || 0)}"></div></div>
      <div class="help">قیمت‌ها را از صفحه‌ی قیمت خود سرویس بردارید. با ۰، فقط توکن‌ها شمرده می‌شوند.</div></div>
    </div>
    <div class="dlg-actions"><button type="button" class="btn primary" id="pvSave">${ic('save', 'sm')}ذخیره</button>
      ${p ? `<button type="button" class="btn danger" id="pvDel">${ic('trash-2', 'sm')}حذف</button>` : ''}
      <button type="button" class="btn ghost" id="pvBack">بازگشت</button></div>`);
  const preset = () => presets.find(x => x.id === (p ? p.preset : $('#pvPreset').value)) || {};
  const kind = () => (document.querySelector('input[name=pvKind]:checked') || {}).value || 'anthropic';
  const syncHelp = () => {
    $('#pvKindHelp').textContent = kind() === 'chat' ? 'برای گفتگو و دستیار. تیم کدنویسی از این نوع استفاده نمی‌کند.' : kind() === 'openai'
      ? 'فقط سرویس‌هایی که Responses API دارند. سرویس‌هایی که فقط Chat Completions دارند (مثل DeepSeek) از این راه کار نمی‌کنند؛ برای آن‌ها نوع Anthropic را انتخاب کنید.'
      : 'سرویس باید API سازگار با Anthropic (/v1/messages) داشته باشد. DeepSeek، Kimi، GLM و MiniMax چنین آدرسی دارند.';
    const pr = preset(); const l = $('#pvKeyLink');
    l.hidden = !pr.keyUrl; l.onclick = e => { e.preventDefault(); if (pr.keyUrl) window.open(pr.keyUrl, '_blank'); };
  };
  syncHelp();
  document.querySelectorAll('input[name=pvKind]').forEach(r => r.onchange = syncHelp);
  if ($('#pvPreset')) $('#pvPreset').onchange = () => {
    const pr = preset();
    $('#pvName').value = pr.name === 'سفارشی' ? '' : pr.name; $('#pvUrl').value = pr.baseUrl || ''; $('#pvModels').value = (pr.models || []).join(', ');
    document.querySelector(`input[name=pvKind][value=${pr.kind}]`).checked = true; syncHelp();
  };
  const form = () => ({ id: p ? p.id : undefined, preset: p ? p.preset : $('#pvPreset').value, name: $('#pvName').value, kind: kind(), baseUrl: $('#pvUrl').value.trim().replace(/\/+$/, ''), models: $('#pvModels').value, apiKey: $('#pvKey').value.trim(), priceIn: +$('#pvPin').value || 0, priceCached: +$('#pvPc').value || 0, priceOut: +$('#pvPout').value || 0 });
  if ($('#pvTrial')) $('#pvTrial').onclick = async () => {
    const model = String($('#pvModels').value).split(/[,،\n]/)[0].trim();
    if (!model) return out('اول یک مدل بنویسید.', true);
    $('#pvTrial').disabled = true;
    out(`در حال آزمایش کامل با <code dir="ltr">${esc(model)}</code>… (ممکن است یکی دو دقیقه طول بکشد؛ از اعتبار حسابتان مقدار خیلی کمی مصرف می‌شود)`);
    try {
      const r = await api(`/providers/${p.id}/trial`, { body: { model } });
      const line = (name, x) => `<div>${ic(x.ok ? 'circle-check' : 'circle-x', 'sm')} <b>${name}:</b> ${x.ok ? `کار کرد (${fa(Math.round(x.ms / 1000))} ثانیه)` : esc(x.error || 'ناموفق')}</div>`;
      out(line('سازنده', r.builder) + line('تستر', r.reviewer) + (r.builder.ok && r.reviewer.ok ? '<div>همه‌چیز درست است؛ این اتصال را برای هر دو نقش می‌توانید استفاده کنید.</div>' : ''), !(r.builder.ok && r.reviewer.ok));
    } catch (e) { out(esc(e.message), true); }
    $('#pvTrial').disabled = false;
  };
  const out = (html, bad) => { $('#pvOut').innerHTML = html; $('#pvOut').className = 'help ' + (bad ? 'pi-bad' : ''); };
  $('#pvFetch').onclick = async () => {
    const f = form(); out('در حال دریافت…');
    try { const r = await api('/providers/models', { body: { ...f, modelsUrl: preset().modelsUrl } }); $('#pvModels').value = r.models.slice(0, 40).join(', '); out(`${fa(r.models.length)} مدل پیدا شد${r.models.length > 40 ? ' (۴۰ تای اول گذاشته شد؛ بقیه را پاک کنید یا دستی بنویسید)' : ''}. مدل‌هایی را که لازم ندارید پاک کنید.`); }
    catch (e) { out(esc(e.message), true); }
  };
  $('#pvTest').onclick = async () => {
    const f = form(); const model = String(f.models).split(/[,،\n]/)[0].trim();
    if (!model) return out('اول یک مدل بنویسید.', true);
    out(`در حال آزمایش با <code dir="ltr">${esc(model)}</code>…`);
    try {
      const r = await api('/providers/test', { body: { ...f, model } });
      out(r.ok ? `${ic('circle-check', 'sm')} اتصال برقرار است (${fa(r.ms)} میلی‌ثانیه).` : `${ic('circle-x', 'sm')} ${esc(r.hint || '')} <span dir="ltr">${esc(r.status ? r.status + ' — ' : '')}${esc(r.error || '')}</span>`, !r.ok);
    } catch (e) { out(esc(e.message), true); }
  };
  // opened from AI Core: go back there instead of the setup wizard
  const pvDone = () => { const f = window.__pvReturn; window.__pvReturn = null; if (f) { $('#dlg').close(); f(); } else setupDialog(); };
  $('#pvSave').onclick = async () => {
    try {
      const r = await api('/providers', { body: form() });
      S.providers = await api('/providers');
      toast(`اتصال «${r.name}» ذخیره شد${r.hasKey ? '' : ' — کلید API را هم وارد کنید'}`);
      renderAgents(); renderModelBar();
      pvDone();
    } catch (e) { out(esc(e.message), true); }
  };
  if ($('#pvDel')) $('#pvDel').onclick = async () => {
    if (!confirm(`اتصال «${p.name}» و کلیدش حذف شود؟`)) return;
    try { await api('/providers/' + p.id, { method: 'DELETE' }); S.providers = await api('/providers'); toast('حذف شد'); renderAgents(); renderModelBar(); pvDone(); } catch (e) { toast(e.message, true); }
  };
  $('#pvBack').onclick = () => pvDone();
}

// ---------- sub-agents: who runs each one ----------
function subSpec(a) { return a.model !== undefined ? a.model : (a.engine === 'codex' ? 'engine:codex' : 'engine:claude'); }
function subRunnerOptions(a) {
  const st = S.settings || {};
  const opts = [['', 'مثل تستر اصلی'], ['engine:claude', `Claude · ${prettyModel(st.specialistModel) || 'پیش‌فرض'}`], ['engine:codex', 'Codex (حساب شما)'],
    ...claudeModels().map(([id, name]) => [id, name]),
    ...(S.providers || []).flatMap(p => p.models.map(m => [`p:${p.id}:${m}`, `${p.name} · ${m}`]))];
  const cur = subSpec(a);
  if (cur && !opts.some(([v]) => v === cur)) opts.push([cur, prettyModel(cur) + (/^p:/.test(cur) ? ' (حذف‌شده)' : '')]);
  return opts;
}
function subRunnerLabel(a) {
  const spec = subSpec(a);
  if (!spec) return 'مثل تستر اصلی';
  if (spec === 'engine:codex') return 'Codex';
  if (spec === 'engine:claude') return `Claude · ${prettyModel((S.settings || {}).specialistModel) || 'پیش‌فرض'}`;
  return prettyModel(spec);
}
// short label for the list: the agent's name only
function subRunnerShort(a) {
  const spec = subSpec(a);
  if (!spec) return roleAgent('reviewer').name;
  if (spec === 'engine:codex') return 'Codex';
  const m = /^p:([a-z0-9-]+):/.exec(spec);
  if (m) { const p = (S.providers || []).find(x => x.id === m[1]); return p ? p.name : m[1]; }
  return prettyModel(spec === 'engine:claude' ? (S.settings || {}).specialistModel : spec).replace(/^Claude /, '') || 'Claude';
}

// ---------- summary / project memory runs ----------
async function runSpecial(mode) {
  if (!S.chat) return;
  if (S.chat.status === 'running' || S.chat.status === 'waiting') return toast('صبر کنید کار فعلی تمام شود', true);
  const text = mode === 'compact' ? 'گفتگو را خلاصه کن و با نشست تازه ادامه بده' : 'از این گفتگو، قانون‌ها و نکته‌های ماندگار این پروژه را پیشنهاد بده';
  try { await api(`/chats/${S.chat.id}/send`, { body: { text, mode } }); }
  catch (err) { toast(err.message, true); if (err.data && err.data.needSetup) setupDialog(); }
}
$('#btnCompact').onclick = () => {
  if (!S.chat || !S.chat.messages.length) return toast('این گفتگو هنوز چیزی برای خلاصه کردن ندارد');
  if (confirm('سازنده کل گفتگو را خلاصه می‌کند و از این به بعد همه‌ی ایجنت‌ها با نشست تازه و همین خلاصه ادامه می‌دهند. ادامه می‌دهید؟')) runSpecial('compact');
};

// ---------- team presets (builder + reviewer in one click) ----------
function builtinPresets() {
  const out = [
    { name: 'قوی: Claude Opus 5.5 + Codex', builder: 'claude-opus-5-5', reviewer: '' },
    { name: 'متعادل: Claude Sonnet 5.5 + Codex', builder: 'claude-sonnet-5-5', reviewer: '' },
    { name: 'اقتصادی: Claude Haiku 5.5 + Codex', builder: 'claude-haiku-5-5', reviewer: '' },
    { name: 'فقط Claude: Sonnet می‌سازد، Opus تست می‌کند', builder: 'claude-sonnet-5-5', reviewer: 'claude-opus-5-5' },
  ];
  for (const p of S.providers || []) {
    if (!p.models.length) continue;
    const m = `p:${p.id}:${p.models[0]}`;
    out.push({ name: `${p.name} برای هر دو نقش`, builder: m, reviewer: m });
    out.push({ name: `${p.name} می‌سازد + Codex`, builder: m, reviewer: '' });
  }
  return out;
}
function savedPresets() {
  return ((S.settings && S.settings.teamPresets) || []).map(line => { const [name, builder, reviewer] = line.split('|').map(x => x.trim()); return name ? { name, builder: builder || '', reviewer: reviewer || '', saved: true } : null; }).filter(Boolean);
}
function renderPresets() {
  const sel = $('#mPreset');
  if (!sel) return;
  const m = (S.chat && S.chat.models) || {};
  const all = [...savedPresets(), ...builtinPresets()];
  const cur = all.findIndex(p => (p.builder || '') === (m.builderModel || '') && (p.reviewer || '') === (m.codexModel || ''));
  sel.innerHTML = `<option value="">ترکیب تیم…</option>` + all.map((p, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${p.saved ? '★ ' : ''}${esc(p.name)}</option>`).join('') + '<option value="__save">ذخیره‌ی ترکیب فعلی…</option>';
  sel.dataset.list = JSON.stringify(all);
}
document.addEventListener('change', async e => {
  if (e.target.id !== 'mPreset' || !S.chat) return;
  const sel = e.target, v = sel.value, all = JSON.parse(sel.dataset.list || '[]');
  if (v === '__save') {
    const name = (prompt('اسم این ترکیب:') || '').replace(/\|/g, ' ').trim();
    if (name) {
      const m = S.chat.models || {};
      const lines = [...((S.settings || {}).teamPresets || []).filter(l => l.split('|')[0].trim() !== name), `${name} | ${m.builderModel || ''} | ${m.codexModel || ''}`];
      try { S.settings = await api('/settings', { body: { teamPresets: lines } }); toast(`ترکیب «${name}» ذخیره شد`); } catch (err) { toast(err.message, true); }
    }
    return renderPresets();
  }
  const p = all[+v];
  if (!p) return;
  S.chat.models = { ...(S.chat.models || {}), builderModel: p.builder, codexModel: p.reviewer };
  renderModelBar(); await saveModelBar(); toast(`ترکیب: ${p.name}`);
});

// ---------- phone notifications (Bale / Telegram) ----------
function notifyBlock() {
  const st = S.settings || {};
  const on = !!(st.notifyPhone && st.notifyChatId);
  return `<div class="wz-item ${on ? 'ok' : ''}">
    <div class="wz-icon">${ic('bell')}</div>
    <div class="wz-body"><h4>دستیار تلگرام / بله <small class="help">اعلان + گفتگو با جارویس از گوشی</small></h4>
      ${on ? `<span class="wz-state ok">${ic('circle-check', 'sm')}روشن · ${st.notifyPhone === 'bale' ? 'بله' : 'تلگرام'}${st.botEnabled ? ' · دستیار دوطرفه' : ''}</span>` : '<span class="help">وقتی کاری تمام شد، به گوشی‌تان پیام می‌دهد.</span>'}
      <div class="row-gap"><button type="button" class="btn btn-secondary btn-sm" data-notify="1">${ic('bell')}${on ? 'تنظیم' : 'راه‌اندازی'}</button></div></div></div>`;
}
async function notifyDialog() {
  let cur = {}, bt = {}; try { [cur, bt] = await Promise.all([api('/notify'), api('/bot')]); } catch {}
  dialog(`<div class="dlg-scroll"><h3>${ic('bell')}دستیار تلگرام / بله</h3>
    <ol class="help nt-steps">
      <li>در بله یا تلگرام به <b dir="ltr">@BotFather</b> پیام بدهید، <code>/newbot</code> را بفرستید و یک ربات بسازید. توکنی که می‌دهد را کپی کنید.</li>
      <li>ربات تازه‌تان را باز کنید و یک پیام (مثلاً «سلام») برایش بفرستید.</li>
      <li>این‌جا کانال و توکن را وارد کنید و «پیدا کردن خودکار» را بزنید، بعد «پیام آزمایشی».</li>
    </ol>
    <div class="field"><label for="ntCh">کانال</label><select id="ntCh"><option value="">خاموش</option><option value="bale">بله</option><option value="telegram">تلگرام</option></select></div>
    <div class="field"><label for="ntTok">توکن ربات</label><input id="ntTok" type="password" dir="ltr" autocomplete="off" placeholder="${cur.hasToken ? 'توکن ذخیره شده — برای تغییر، توکن جدید را وارد کنید' : '123456:ABC…'}"><div class="help">${ic('lock', 'sm')} رمزنگاری‌شده و فقط روی همین کامپیوتر ذخیره می‌شود.</div></div>
    <div class="field"><label for="ntChat">شناسه‌ی گفتگو (chat id)</label><input id="ntChat" dir="ltr" value="${esc(cur.chatId || '')}">
      <div class="row-gap"><button type="button" class="btn small" id="ntDetect">${ic('search', 'sm')}پیدا کردن خودکار</button><button type="button" class="btn small" id="ntTest">${ic('send', 'sm')}پیام آزمایشی</button></div>
      <div id="ntOut" class="help" role="status"></div></div>
    <div class="field"><label for="ntWhen">کی خبر بدهد</label><select id="ntWhen"><option value="all">پایان هر کار</option><option value="problems">فقط وقتی مشکلی بود</option></select></div>
    <p class="help">در اعلان‌ها فقط وضعیت کار (تمام شد / خطا)، اسم گفتگو و مدت زمان فرستاده می‌شود؛ هیچ کدی فرستاده نمی‌شود.</p>
    <h4>${ic('messages-square', 'sm')} گفتگو با جارویس از گوشی</h4>
    <label class="check"><input type="checkbox" id="ntBot" ${bt.enabled ? 'checked' : ''}> جارویس در همین ربات به پیام‌ها و پیام‌های صوتی شما جواب بدهد (تسک، شروع کار تیمی، وضعیت ایجنت‌ها، سؤال)</label>
    <div class="field"><label for="ntVoice">جواب صوتی</label><select id="ntVoice"><option value="auto">وقتی پیام صوتی فرستادم</option><option value="always">همیشه</option><option value="never">هرگز — فقط متن</option></select></div>
    <div class="help" id="ntBotSt">${bt.running ? (bt.connected ? `${ic('circle-check', 'sm')} وصل است${bt.botName ? ' به <b dir="ltr">@' + esc(bt.botName) + '</b>' : ''}` : 'در حال وصل شدن…' + (bt.lastError ? ' — ' + esc(bt.lastError) : '')) : 'خاموش'}</div>
    ${bt.ffmpeg ? '' : `<div class="va-tip">${ic('download', 'sm')} برای پیام صوتی، «FFmpeg» را از تنظیمات صدا دانلود کنید. <button type="button" class="btn small" id="ntFf">باز کردن تنظیمات صدا</button></div>`}
    <p class="help">${ic('lock', 'sm')} فقط به همین شناسه‌ی گفتگو (شما) جواب می‌دهد؛ پیام بقیه نادیده گرفته می‌شود. کارهایی که چیزی را تغییر می‌دهند، قبل از اجرا با دکمه‌ی «بله» تأیید می‌خواهند. هیچ چیز روی اینترنت باز نمی‌شود.</p></div>
    <div class="dlg-actions"><button type="button" class="btn primary" id="ntSave">${ic('save', 'sm')}ذخیره</button><button type="button" class="btn ghost" id="ntBack">بازگشت</button></div>`);
  $('#ntCh').value = cur.channel || ''; $('#ntWhen').value = cur.when || 'all'; $('#ntVoice').value = bt.voiceReply || 'auto';
  if ($('#ntFf')) $('#ntFf').onclick = () => window.voiceDialog && window.voiceDialog();
  const out = (h, bad) => { $('#ntOut').innerHTML = h; $('#ntOut').className = 'help ' + (bad ? 'pi-bad' : ''); };
  const f = () => ({ channel: $('#ntCh').value, token: $('#ntTok').value.trim(), chatId: $('#ntChat').value.trim(), when: $('#ntWhen').value });
  $('#ntDetect').onclick = async () => {
    if (!f().channel) return out('اول کانال را انتخاب کنید.', true);
    out('در حال جستجو…');
    try { const r = await api('/notify/detect', { body: f() }); $('#ntChat').value = r.chatId; out(`پیدا شد: ${esc(r.name || r.chatId)}`); } catch (e) { out(esc(e.message), true); }
  };
  $('#ntTest').onclick = async () => {
    if (!f().channel) return out('اول کانال را انتخاب کنید.', true);
    out('در حال ارسال…');
    try { await api('/notify/test', { body: f() }); out('پیام فرستاده شد؛ گوشی‌تان را نگاه کنید.'); } catch (e) { out(esc(e.message), true); }
  };
  $('#ntSave').onclick = async () => {
    try {
      await api('/notify', { body: f() });
      await api('/bot', { body: { enabled: $('#ntBot').checked, voiceReply: $('#ntVoice').value } });
      S.settings = await api('/settings', { body: {} });
      toast($('#ntBot').checked ? 'ذخیره شد — حالا در ربات به جارویس پیام بدهید' : 'ذخیره شد');
      if (window.__ntReturn) { const r = window.__ntReturn; window.__ntReturn = null; $('#dlg').close(); r(); } else setupDialog();
    } catch (e) { out(esc(e.message), true); }
  };
  $('#ntBack').onclick = () => setupDialog();
}
