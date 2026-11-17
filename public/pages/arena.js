// Arena: one question to several models side by side (vote for the best → a leaderboard),
// and debates where models read each other's answers, improve them, and a moderator writes the result.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const md = t => (window.md ? window.md(t) : `<p dir="auto">${esc(t)}</p>`);

const A = { el: null, tab: 'compare', models: [], pick: [], view: { board: [], history: [] }, run: null, rounds: 2, judge: '' };
const nameOf = spec => { const m = A.models.find(x => x.spec === spec); return m ? `${m.name}${m.group && !m.name.includes(m.group) ? ' · ' + m.group : ''}` : spec; };

async function enter(host) {
  A.el = host;
  try { A.models = (await api('/llms')).filter(m => m.ok !== false && !m.voice && !m.agent); } catch { A.models = []; }
  try { A.view = await api('/arena'); } catch {}
  try { A.pick = JSON.parse(localStorage.getItem('jarvis.arenaPick') || '[]').filter(s => A.models.some(m => m.spec === s)); } catch { A.pick = []; }
  render();
}
function leave() { A.el = null; }

function render() {
  if (!A.el) return;
  const groups = [...new Set(A.models.map(m => m.group))];
  const run = A.run;
  A.el.innerHTML = `<div class="pg ar-page">
    <header class="pg-head"><div><h1>${ic('swords')}میدان مدل‌ها<span class="hud-tag" aria-hidden="true">ARENA</span></h1>
      <p class="help">یک سؤال را هم‌زمان به چند مدل بدهید و جواب‌ها را کنار هم ببینید، یا بگذارید با هم بحث کنند تا بهترین جواب دربیاید.</p></div></header>
    <nav class="bell-tabs" role="tablist"><button type="button" role="tab" aria-selected="${A.tab === 'compare'}" data-atab="compare">${ic('chart-column', 'sm')} مقایسه</button><button type="button" role="tab" aria-selected="${A.tab === 'debate'}" data-atab="debate">${ic('messages-square', 'sm')} بحث چند ایجنت</button><button type="button" role="tab" aria-selected="${A.tab === 'board'}" data-atab="board">${ic('activity', 'sm')} جدول امتیاز</button></nav>
    ${A.tab === 'board' ? boardHtml() : `
    <section class="sl-card ar-setup">
      <div class="ar-models" role="group" aria-label="مدل‌ها">${groups.map(g => `<div class="ar-group"><b class="help">${esc(g)}</b>${A.models.filter(m => m.group === g).map(m => `<label class="check ar-m"><input type="checkbox" data-amodel="${esc(m.spec)}" ${A.pick.includes(m.spec) ? 'checked' : ''}> <span dir="auto">${esc(m.name)}</span></label>`).join('')}</div>`).join('') || '<p class="help">مدلی وصل نیست؛ از «هسته‌ی هوش مصنوعی» اضافه کنید.</p>'}</div>
      <p class="help">${faN(A.pick.length)} مدل انتخاب شده ${A.tab === 'debate' ? '(۲ تا ۴)' : '(۲ تا ۶)'}</p>
      ${A.tab === 'debate' ? `<div class="field-row"><div class="field"><label for="arRounds">دور بحث</label><select id="arRounds">${[1, 2, 3].map(n => `<option value="${n}" ${A.rounds === n ? 'selected' : ''}>${faN(n)}</option>`).join('')}</select></div>
        <div class="field"><label for="arJudge">داور (نتیجه‌ی نهایی را می‌نویسد)</label><select id="arJudge">${A.pick.map(s => `<option value="${esc(s)}" ${A.judge === s ? 'selected' : ''}>${esc(nameOf(s))}</option>`).join('')}</select></div></div>` : ''}
      <div class="sk-ai-row"><textarea id="arQ" rows="3" dir="auto" placeholder="${A.tab === 'debate' ? 'مثلاً: برای یک فروشگاه کوچک، Next.js بهتر است یا Laravel؟' : 'سؤال یا کار را بنویسید…'}">${esc(A.q || '')}</textarea>
        ${run && !run.done ? `<button type="button" class="btn danger" id="arStop">${ic('circle-stop', 'sm')}توقف</button>` : `<button type="button" class="btn btn-primary" id="arGo">${ic(A.tab === 'debate' ? 'messages-square' : 'zap', 'sm')}${A.tab === 'debate' ? 'شروع بحث' : 'بپرس'}</button>`}</div>
    </section>
    ${run && run.mode === A.tab ? (run.mode === 'compare' ? compareHtml(run) : debateHtml(run)) : historyHtml()}`}
  </div>`;
  bind();
}
function compareHtml(run) {
  return `<div class="ar-cols">${run.specs.map(s => { const r = run.results[s] || {}; return `<section class="sl-card ar-col ${run.vote === s ? 'win' : ''}" aria-label="${esc(nameOf(s))}">
    <header class="ar-col-h"><b dir="auto">${esc(nameOf(s))}</b><span class="help">${r.ms != null ? faN((r.ms / 1000).toFixed(1)) + ' ثانیه · ' + faN(r.text.length) + ' نویسه' : run.done ? '' : 'در حال نوشتن…'}</span></header>
    <div class="ar-text md" dir="auto">${r.error ? `<p class="bad">${esc(r.error)}</p>` : md(r.text || '')}</div>
    ${run.done && r.ok ? `<button type="button" class="btn btn-sm ${run.vote === s ? 'btn-primary' : ''}" data-avote="${esc(s)}" ${run.vote ? 'disabled' : ''}>${ic('check', 'sm')}${run.vote === s ? 'برنده' : 'این بهتر بود'}</button>` : ''}</section>`; }).join('')}</div>`;
}
function debateHtml(run) {
  const byRound = {}; for (const a of run.log) (byRound[a.round] = byRound[a.round] || []).push(a);
  return `<div class="ar-debate">${Object.keys(byRound).map(r => `<h2 class="pg-sub">دور ${faN(r)}${+r === 1 ? ' — جواب اول' : ' — بعد از خواندن جواب بقیه'}</h2>
    <div class="ar-cols">${byRound[r].map(a => `<section class="sl-card ar-col"><header class="ar-col-h"><b dir="auto">${esc(nameOf(a.spec))}</b><span class="help">${a.ms != null ? faN((a.ms / 1000).toFixed(1)) + ' ثانیه' : ''}</span></header><div class="ar-text md" dir="auto">${a.error ? `<p class="bad">${esc(a.error)}</p>` : md(a.text || '')}</div></section>`).join('')}</div>`).join('')}
    ${!run.done && Object.keys(run.live || {}).length ? `<h2 class="pg-sub">دور ${faN(run.round || 1)} — در حال نوشتن</h2><div class="ar-cols">${Object.entries(run.live).map(([s, t]) => `<section class="sl-card ar-col"><header class="ar-col-h"><b dir="auto">${esc(nameOf(s))}</b></header><div class="ar-text md" dir="auto">${md(t)}</div></section>`).join('')}</div>` : ''}
    ${run.status ? `<p class="help ar-status" role="status">${esc(run.status)}</p>` : ''}
    ${run.final ? `<section class="sl-card ar-final"><h2>${ic('sparkles', 'sm')}نتیجه‌ی نهایی — داور: <span dir="auto">${esc(nameOf(run.judge))}</span></h2><div class="md" dir="auto">${run.final.error ? `<p class="bad">${esc(run.final.error)}</p>` : md(run.final.text || '')}</div></section>` : ''}</div>`;
}
function boardHtml() {
  const b = A.view.board || [];
  return b.length ? `<table class="ar-board"><thead><tr><th>مدل</th><th>برد</th><th>باخت</th><th>درصد برد</th><th>میانگین زمان</th></tr></thead><tbody>${b.map(x => `<tr><td dir="auto">${esc(nameOf(x.spec))}</td><td>${faN(x.wins)}</td><td>${faN(x.losses)}</td><td>${x.wins + x.losses ? faN(Math.round(100 * x.wins / (x.wins + x.losses))) + '٪' : '—'}</td><td>${x.runs ? faN((x.msTotal / x.runs / 1000).toFixed(1)) + ' ثانیه' : '—'}</td></tr>`).join('')}</tbody></table>`
    : '<div class="tk-empty">' + ic('activity') + '<h3>هنوز رأیی نداده‌اید</h3><p class="help">در «مقایسه» بعد از هر جواب، بهترین را انتخاب کنید تا جدول ساخته شود.</p></div>';
}
function historyHtml() {
  const h = (A.view.history || []).filter(x => x.mode === A.tab).slice(0, 12);
  return h.length ? `<h2 class="pg-sub">قبلی‌ها</h2><ul class="ar-hist" role="list">${h.map(x => `<li><button type="button" class="ar-h" data-ahist="${esc(x.id)}"><span dir="auto">${esc(x.prompt.slice(0, 120))}</span><small class="help">${new Date(x.at).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })}${x.vote ? ' · برنده: ' + esc(nameOf(x.vote)) : ''}</small></button></li>`).join('')}</ul>` : '';
}
function fromHistory(x) {
  if (x.mode === 'compare') return { id: x.id, mode: 'compare', specs: x.results.map(r => r.spec), results: Object.fromEntries(x.results.map(r => [r.spec, { ...r, text: r.text || '' }])), done: true, vote: x.vote };
  return { id: x.id, mode: 'debate', specs: x.specs, judge: x.judge, log: x.log, final: x.final, done: true };
}
function bind() {
  const el = A.el, on = (id, f) => { const x = $('#' + id, el); if (x) x.onclick = f; };
  el.querySelectorAll('[data-atab]').forEach(b => b.onclick = () => { A.tab = b.dataset.atab; render(); });
  el.querySelectorAll('[data-amodel]').forEach(c => c.onchange = () => {
    A.pick = c.checked ? [...A.pick, c.dataset.amodel] : A.pick.filter(s => s !== c.dataset.amodel);
    try { localStorage.setItem('jarvis.arenaPick', JSON.stringify(A.pick)); } catch {}
    A.q = ($('#arQ', el) || {}).value || A.q; render();
  });
  const q = $('#arQ', el); if (q) q.oninput = () => { A.q = q.value; };
  const rd = $('#arRounds', el); if (rd) rd.onchange = () => { A.rounds = +rd.value; };
  const jd = $('#arJudge', el); if (jd) jd.onchange = () => { A.judge = jd.value; };
  on('arGo', async () => {
    const text = (A.q || '').trim(); if (!text) return window.toast('سؤال را بنویسید', true);
    const max = A.tab === 'debate' ? 4 : 6;
    if (A.pick.length < 2 || A.pick.length > max) return window.toast(`${faN(2)} تا ${faN(max)} مدل انتخاب کنید`, true);
    try {
      const r = A.tab === 'debate' ? await api('/arena/debate', { body: { question: text, models: A.pick, rounds: A.rounds, judge: A.judge || A.pick[0] } }) : await api('/arena/compare', { body: { prompt: text, models: A.pick } });
      A.run = A.tab === 'debate' ? { id: r.id, mode: 'debate', specs: A.pick.slice(), judge: A.judge || A.pick[0], log: [], final: null, done: false, live: {} } : { id: r.id, mode: 'compare', specs: A.pick.slice(), results: {}, done: false };
      render();
    } catch (e) { window.toast(e.message, true); }
  });
  on('arStop', () => { if (A.run) api('/arena/stop', { body: { id: A.run.id } }).catch(() => {}); });
  el.querySelectorAll('[data-avote]').forEach(b => b.onclick = async () => { try { A.view = await api('/arena/vote', { body: { id: A.run.id, spec: b.dataset.avote } }); A.run.vote = b.dataset.avote; window.toast('ثبت شد؛ در «جدول امتیاز» می‌بینید'); render(); } catch (e) { window.toast(e.message, true); } });
  el.querySelectorAll('[data-ahist]').forEach(b => b.onclick = () => { const x = (A.view.history || []).find(y => y.id === b.dataset.ahist); if (x) { A.run = fromHistory(x); A.q = x.prompt; render(); } });
}
// live updates
let tm = null;
const soon = () => { clearTimeout(tm); tm = setTimeout(render, 120); };
window.addEventListener('jarvis:ev', e => {
  const ev = e.detail; if (!ev || ev.type !== 'arena' || !A.run || ev.id !== A.run.id) return;
  const run = A.run;
  if (ev.delta != null) {
    if (run.mode === 'compare') { const r = run.results[ev.spec] = run.results[ev.spec] || { text: '' }; r.text += ev.delta; }
    else { run.live[ev.spec] = (run.live[ev.spec] || '') + ev.delta; run.status = 'در حال نوشتن…'; }
  }
  if (ev.state === 'round') { if (run.round) for (const [s, t] of Object.entries(run.live || {})) run.log.push({ round: run.round, spec: s, ok: true, text: t }); run.round = ev.round; run.live = {}; run.status = `دور ${faN(ev.round)} در جریان است…`; }
  if (ev.state === 'answer') run.status = `${nameOf(ev.spec)} جوابش را داد (دور ${faN(ev.round)})`;
  if (ev.state === 'judge') run.status = `داور (${nameOf(ev.spec)}) در حال نوشتن نتیجه…`;
  if (ev.state === 'done') {
    const x = ev.run; A.view.history = [x, ...(A.view.history || []).filter(y => y.id !== x.id)];
    A.run = fromHistory(x); A.run.status = '';
    api('/arena').then(v => { A.view = v; }).catch(() => {});
  }
  if (A.el) soon();
});

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('arena', { icon: 'swords', label: 'میدان مدل‌ها', enter, leave });
