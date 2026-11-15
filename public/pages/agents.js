// Agents: every agent in one place — standalone assistants, the builder's helpers and the reviewers.
// Step-by-step builder (template → role → instructions → model & test), versions, import/export,
// test conversation, and "chat with this agent".
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const st = () => window.JARVIS_STATE || {};
const icon = (a, cls = '') => window.agentIcon ? window.agentIcon(a, cls) : ic(/^[a-z0-9-]+$/.test(a.icon || '') ? a.icon : 'bot', cls);
const pretty = m => (window.prettyModel ? window.prettyModel(m) : m);

const STAGE = {
  assistant: { label: 'دستیار مستقل', short: 'دستیار', icon: 'messages-square', desc: 'در چت، ورک‌فلو، صدا و تلگرام با آن کار می‌کنید.' },
  builder: { label: 'کمک‌دست سازنده', short: 'سازنده', icon: 'code', desc: 'سازنده‌ی تیم کدنویسی کارهایی را به او می‌سپارد (داخل همان نشست Claude Code).' },
  review: { label: 'بازبین تخصصی', short: 'بازبین', icon: 'search', desc: 'بعد از سازنده، تغییرات را از دید تخصص خودش بررسی و باگ گزارش می‌کند.' },
};
const ICONS = ['bot', 'sparkles', 'brain', 'shield', 'zap', 'palette', 'search', 'book-open', 'flask-conical', 'git-branch', 'plug', 'server', 'database', 'languages', 'pencil', 'send', 'list-checks', 'chart-bar', 'graduation-cap', 'clock', 'heart', 'terminal', 'smartphone', 'globe', 'layout-dashboard', 'package', 'messages-square', 'code'];
const FILTERS = [['all', 'همه'], ['assistant', 'دستیارها'], ['builder', 'کمک‌دست سازنده'], ['review', 'بازبین‌ها']];
const A = { el: null, list: [], templates: [], llms: [], filter: 'all', q: '', running: [] };

function enter(host) { A.el = host; if (!host.dataset.built) build(); load(); }
function build() {
  A.el.dataset.built = '1';
  A.el.innerHTML = `<div class="pg ag-page">
    <header class="pg-head"><div><h1>${ic('bot')}ایجنت‌ها<span class="hud-tag" aria-hidden="true">AGENTS</span></h1>
      <p class="help">ایجنت‌های خودتان را بسازید: دستیار مستقل برای چت و کارهای روزانه، یا متخصص برای تیم کدنویسی — روی هر مدلی (Claude، ChatGPT/Codex، DeepSeek، Gemini، مدل‌های آفلاین…).</p></div>
      <div class="ag-stats" id="agStats"></div></header>
    <div class="ag-bar">
      <div class="segm" role="tablist">${FILTERS.map(([k, l]) => `<button type="button" role="tab" aria-checked="${k === A.filter}" data-f="${k}">${l}</button>`).join('')}</div>
      <div class="ag-acts"><div class="chat-search">${ic('search', 'sm')}<input id="agSearch" type="search" dir="auto" placeholder="جستجو…" autocomplete="off"></div>
        <button type="button" class="btn" id="agImport">${ic('upload', 'sm')}وارد کردن</button>
        <button type="button" class="btn btn-primary" id="agNew">${ic('plus', 'sm')}ساخت ایجنت</button></div></div>
    <div id="agLive"></div>
    <div class="ag-grid" id="agGrid"></div>
  </div>`;
  A.el.querySelector('.ag-bar .segm').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; A.filter = b.dataset.f; A.el.querySelectorAll('[data-f]').forEach(x => x.setAttribute('aria-checked', String(x === b))); render(); };
  $('#agSearch').oninput = e => { A.q = e.target.value.trim().toLowerCase(); render(); };
  $('#agNew').onclick = () => wizard();
  $('#agImport').onclick = importDialog;
  $('#agGrid').onclick = onCard;
  $('#agGrid').onchange = async e => { const t = e.target.closest('[data-toggle]'); if (!t) return; const a = A.list.find(x => x.id === t.dataset.toggle); try { await api('/subagents', { body: { ...a, enabled: t.checked } }); } catch (err) { window.toast(err.message, true); t.checked = !t.checked; } };
}
async function load() {
  try { [A.list, A.templates] = await Promise.all([api('/subagents'), A.templates.length ? A.templates : api('/subagents/templates')]); } catch (e) { window.toast(e.message, true); return; }
  try { const cc = await api('/cc'); A.running = cc.agents.running; } catch { A.running = []; }
  render();
}
function modelLabel(a) {
  if (a.stage === 'builder') return 'داخل نشست سازنده';
  if (!a.model) return a.stage === 'assistant' ? 'مدل دستیار (پیش‌فرض)' : 'مثل تستر اصلی';
  if (a.model === 'engine:codex') return 'Codex (حساب ChatGPT)';
  if (a.model === 'engine:claude') return 'Claude Code';
  if (/^p:/.test(a.model)) { const p = (st().providers || []).find(x => a.model.startsWith('p:' + x.id + ':')); return (p ? p.name + ' · ' : '') + a.model.split(':').slice(2).join(':'); }
  if (/^ollama:/.test(a.model)) return 'Ollama · ' + a.model.slice(7) + ' (آفلاین)';
  return pretty(a.model);
}
function render() {
  const all = A.list;
  $('#agStats').innerHTML = `<div class="pg-stat"><b>${faN(all.length)}</b><span>ایجنت</span></div><div class="pg-stat"><b>${faN(all.filter(a => a.enabled).length)}</b><span>فعال</span></div><div class="pg-stat"><b>${faN(all.filter(a => a.stage === 'assistant').length)}</b><span>دستیار</span></div>`;
  $('#agLive').innerHTML = A.running.length ? `<div class="ag-live"><span class="dot live"></span><b>الان در حال کار:</b> ${A.running.map(r => `<button type="button" class="linkbtn" data-openchat="${esc(r.id)}">${esc(r.title)}</button>`).join('، ')} <button type="button" class="btn btn-sm" data-ops="1">${ic('radar', 'sm')}اتاق عملیات</button></div>` : '';
  $('#agLive').onclick = e => { if (e.target.closest('[data-ops]')) window.openOps && window.openOps(); const c = e.target.closest('[data-openchat]'); if (c) { window.showSection('code'); window.openChat(c.dataset.openchat); } };
  const list = all.filter(a => (A.filter === 'all' || a.stage === A.filter) && (!A.q || (a.name + ' ' + a.description + ' ' + a.prompt).toLowerCase().includes(A.q)));
  const order = { assistant: 0, builder: 1, review: 2 };
  list.sort((x, y) => order[x.stage] - order[y.stage] || x.name.localeCompare(y.name));
  $('#agGrid').innerHTML = (list.length ? list.map(card).join('') : `<div class="tk-empty">${ic('bot')}<h3>ایجنتی پیدا نشد</h3></div>`)
    + `<button type="button" class="ag-card ag-add" data-new="1">${ic('plus')}<b>ساخت ایجنت تازه</b><span class="help">از ${faN(A.templates.length)} قالب آماده یا از صفر</span></button>`;
}
function card(a) {
  const s = STAGE[a.stage] || STAGE.review;
  return `<article class="ag-card ${a.enabled ? '' : 'off'} st-${a.stage}" data-id="${esc(a.id)}">
    <header><span class="ag-ic">${icon(a)}</span><div><h3 dir="ltr">${esc(a.name)}</h3><span class="ag-stage">${ic(s.icon, 'sm')}${s.short}</span></div>
      <label class="switch big" title="فعال / غیرفعال"><input type="checkbox" data-toggle="${esc(a.id)}" ${a.enabled ? 'checked' : ''} aria-label="فعال"><span></span></label></header>
    <p class="ag-desc" dir="auto">${esc(a.description || a.prompt.slice(0, 140))}</p>
    <div class="ag-model">${ic('cpu', 'sm')}<span dir="auto">${esc(modelLabel(a))}</span>${(a.skills || []).length ? `<span class="ag-chip">${ic('puzzle', 'sm')}${faN(a.skills.length)} اسکیل</span>` : ''}${a.plugin ? `<span class="ag-chip">پلاگین</span>` : ''}</div>
    <footer>${a.stage === 'assistant' ? `<button type="button" class="btn btn-sm btn-primary" data-act="chat">${ic('messages-square', 'sm')}گفتگو</button>` : ''}
      <button type="button" class="btn btn-sm" data-act="test">${ic('flask-conical', 'sm')}آزمایش</button>
      <button type="button" class="btn btn-sm" data-act="edit">${ic('pencil', 'sm')}ویرایش</button>
      ${(a.versions || []).length ? `<button type="button" class="cc-mini" data-act="versions" title="نسخه‌های قبلی (${faN(a.versions.length)})" aria-label="نسخه‌ها">${ic('history', 'sm')}</button>` : ''}
      <button type="button" class="cc-mini" data-act="export" title="خروجی (فایل)" aria-label="خروجی">${ic('download', 'sm')}</button>
      <button type="button" class="cc-mini" data-act="del" title="حذف" aria-label="حذف">${ic('trash-2', 'sm')}</button></footer></article>`;
}
async function onCard(e) {
  if (e.target.closest('[data-new]')) return wizard();
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = A.list.find(x => x.id === b.closest('[data-id]').dataset.id); if (!a) return;
  const act = b.dataset.act;
  try {
    if (act === 'edit') wizard(a);
    else if (act === 'test') testDialog(a);
    else if (act === 'versions') versionsDialog(a);
    else if (act === 'export') exportAgent(a);
    else if (act === 'chat') { const t = await api('/talks', { body: { model: 'agent:' + a.id, title: 'گفتگو با ' + a.name } }); try { localStorage.setItem('jarvis.talk', JSON.stringify(t.id)); } catch {} window.showSection('chat'); }
    else if (act === 'del') { if (!confirm(`ایجنت «${a.name}» حذف شود؟`)) return; await api('/subagents/' + a.id, { method: 'DELETE' }); load(); }
  } catch (err) { window.toast(err.message, true); }
}

// ---------- the builder (wizard) ----------
async function wizard(edit) {
  if (!A.llms.length) { try { A.llms = (await api('/llms')).filter(m => !m.agent); } catch { A.llms = []; } }
  const d = edit ? JSON.parse(JSON.stringify(edit)) : { name: '', icon: 'bot', stage: 'assistant', model: '', description: '', prompt: '', enabled: true, skills: [] };
  let step = edit ? 1 : 0;
  const steps = ['قالب', 'نقش', 'دستورالعمل', 'مدل و آزمایش'];
  const draw = () => {
    const head = `<ol class="wz-steps">${steps.map((s, i) => `<li class="${i === step ? 'on' : i < step ? 'done' : ''}"><span>${faN(i + 1)}</span>${s}</li>`).join('')}</ol>`;
    let body = '';
    if (step === 0) {
      const groups = ['assistant', 'builder', 'review'];
      body = `<button type="button" class="ag-tpl blank" data-tpl="-1"><span class="ag-ic">${ic('plus')}</span><div><b>از صفر</b><span class="help">خودم همه‌چیز را می‌نویسم</span></div></button>
        ${groups.map(g => `<h4>${ic(STAGE[g].icon, 'sm')}${STAGE[g].label}</h4><div class="ag-tpls">${A.templates.map((t, i) => [t, i]).filter(([t]) => t.stage === g).map(([t, i]) => `<button type="button" class="ag-tpl" data-tpl="${i}"><span class="ag-ic">${ic(t.icon)}</span><div><b dir="ltr">${esc(t.name)}</b><span class="help" dir="auto">${esc(t.description)}</span></div></button>`).join('')}</div>`).join('')}`;
    } else if (step === 1) {
      body = `<div class="field"><label>نوع ایجنت</label><div class="ag-kinds">${Object.entries(STAGE).map(([k, s]) => `<button type="button" class="ag-kind ${d.stage === k ? 'on' : ''}" data-kind="${k}">${ic(s.icon)}<b>${s.label}</b><span class="help">${s.desc}</span></button>`).join('')}</div></div>
        <div class="field-row"><div class="field"><label>نام (انگلیسی، مثل research-helper)</label><input id="wzName" dir="ltr" value="${esc(d.name)}" placeholder="my-agent"></div></div>
        <div class="field"><label>توضیح کوتاه (فارسی هم می‌شود)</label><input id="wzDesc" dir="auto" value="${esc(d.description)}" placeholder="مثلاً: ایمیل‌های رسمی را می‌نویسد"></div>
        <div class="field"><label>آیکون</label><div class="ag-icons">${ICONS.map(n => `<button type="button" class="${d.icon === n ? 'on' : ''}" data-icon="${n}" aria-label="${n}">${ic(n)}</button>`).join('')}</div></div>`;
    } else if (step === 2) {
      body = `<div class="field"><label>دستورالعمل ایجنت (System prompt)</label><textarea id="wzPrompt" dir="auto" rows="12" placeholder="You are …">${esc(d.prompt)}</textarea>
        <div class="row-gap"><button type="button" class="btn btn-sm" id="wzImprove">${ic('sparkles', 'sm')}${d.prompt.trim() ? 'بهتر کن با هوش مصنوعی' : 'بنویس با هوش مصنوعی (از توضیح)'}</button><span class="help" id="wzImpOut"></span></div>
        <div class="help">نکته: دستورالعمل انگلیسی معمولاً دقیق‌تر اجرا می‌شود؛ جواب‌ها به زبان شما خواهد بود.</div></div>`;
    } else {
      const S = st();
      let opts;
      if (d.stage === 'builder') opts = null;
      else if (d.stage === 'assistant') { const g = {}; for (const m of A.llms) (g[m.group] = g[m.group] || []).push(m); opts = `<option value="" ${!d.model ? 'selected' : ''}>مدل دستیار (پیش‌فرض)</option>` + Object.entries(g).map(([k, l]) => `<optgroup label="${esc(k)}">${l.map(m => `<option value="${esc(m.spec)}" ${m.spec === d.model ? 'selected' : ''} ${m.ok ? '' : 'disabled'}>${esc(m.name)}</option>`).join('')}</optgroup>`).join(''); }
      else { const list = window.modelOptions ? window.modelOptions('claude', d.model).filter(([v]) => v !== '__custom') : []; opts = `<option value="" ${!d.model ? 'selected' : ''}>مثل تستر اصلی</option><option value="engine:codex" ${d.model === 'engine:codex' ? 'selected' : ''}>Codex (حساب ChatGPT شما)</option>` + list.filter(([v]) => v).map(([v, l]) => `<option value="${esc(v)}" ${v === d.model ? 'selected' : ''}>${esc(l)}</option>`).join(''); }
      body = `${opts ? `<div class="field"><label>چه مدلی این ایجنت را اجرا کند؟</label><select id="wzModel" dir="ltr">${opts}</select></div>` : `<div class="va-tip">${ic('info', 'sm')} کمک‌دست سازنده داخل همان نشست Claude Code سازنده اجرا می‌شود و مدل جدا ندارد.</div>`}
        <label class="check"><input type="checkbox" id="wzOn" ${d.enabled !== false ? 'checked' : ''}> فعال باشد</label>
        <div class="ag-summary"><span class="ag-ic">${icon(d)}</span><div><b dir="ltr">${esc(d.name || '—')}</b><span class="help">${esc(STAGE[d.stage].label)} · ${esc(d.description || '')}</span></div></div>
        <h4>${ic('flask-conical', 'sm')}آزمایش</h4>
        <div class="help">بعد از ذخیره، یک پیام بفرستید و جوابش را ببینید (بدون دسترسی به فایل‌ها).</div>
        <div class="row-gap ag-test"><input id="wzTestIn" dir="auto" placeholder="${d.stage === 'assistant' ? 'مثلاً: یک ایمیل برای مرخصی فردا بنویس' : 'مثلاً: این تابع لاگین را بررسی کن: …'}"><button type="button" class="btn btn-sm" id="wzTest" ${d.id ? '' : 'disabled'}>${ic('play', 'sm')}آزمایش</button></div>
        <div id="wzTestOut" class="ag-test-out" dir="auto"></div>`;
    }
    window.dialog(`<div class="dlg-scroll ag-wz"><h3>${ic('bot')}${edit ? 'ویرایش ایجنت — ' + esc(edit.name) : 'ساخت ایجنت'}</h3>${head}${body}</div>
      <div class="dlg-actions">${step > 0 ? `<button type="button" class="btn ghost" id="wzBack">${ic('chevron-right', 'sm')}قبلی</button>` : ''}
        ${step > 0 && step < 3 ? `<button type="button" class="btn primary" id="wzNext">بعدی${ic('chevron-left', 'sm')}</button>` : ''}
        ${step === 3 ? `<button type="button" class="btn primary" id="wzSave">${ic('save', 'sm')}${d.id ? 'ذخیره' : 'ساختن'}</button>` : ''}
        <button class="btn ghost" value="cancel">بستن</button></div>`, true);
    wire();
  };
  const collect = () => {
    if ($('#wzName')) { d.name = $('#wzName').value.trim(); d.description = $('#wzDesc').value.trim(); }
    if ($('#wzPrompt')) d.prompt = $('#wzPrompt').value;
    if ($('#wzModel')) d.model = $('#wzModel').value;
    if ($('#wzOn')) d.enabled = $('#wzOn').checked;
  };
  const check = () => {
    if (step === 1 && !/^[a-z0-9][a-z0-9_-]{1,39}$/i.test(d.name)) { window.toast('نام را با حروف انگلیسی، عدد و خط تیره بنویسید (مثل email-helper)', true); return false; }
    if (step === 2 && !d.prompt.trim()) { window.toast('دستورالعمل خالی است — بنویسید یا «بنویس با هوش مصنوعی» را بزنید', true); return false; }
    return true;
  };
  const wire = () => {
    const body = $('#dlgBody');
    body.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => { const i = +b.dataset.tpl; if (i >= 0) { const t = A.templates[i]; Object.assign(d, { name: t.name, icon: t.icon, stage: t.stage, description: t.description, prompt: t.prompt, model: t.model || '' }); let n = d.name, k = 2; while (A.list.some(x => x.name === n)) n = t.name + '-' + k++; d.name = n; } step = 1; draw(); });
    body.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { collect(); d.stage = b.dataset.kind; if (d.stage === 'builder') d.model = ''; draw(); });
    body.querySelectorAll('[data-icon]').forEach(b => b.onclick = () => { collect(); d.icon = b.dataset.icon; body.querySelectorAll('[data-icon]').forEach(x => x.classList.toggle('on', x === b)); });
    if ($('#wzBack')) $('#wzBack').onclick = () => { collect(); step = Math.max(edit ? 1 : 0, step - 1); draw(); };
    if ($('#wzNext')) $('#wzNext').onclick = () => { collect(); if (check()) { step++; draw(); } };
    if ($('#wzImprove')) $('#wzImprove').onclick = async () => {
      collect(); const btn = $('#wzImprove'); btn.disabled = true; $('#wzImpOut').textContent = 'در حال نوشتن…';
      try { const r = await api('/subagents/improve', { body: d }); d.prompt = r.prompt; $('#wzPrompt').value = r.prompt; $('#wzImpOut').textContent = 'انجام شد — بررسی و در صورت نیاز ویرایش کنید.'; }
      catch (e) { $('#wzImpOut').textContent = e.message; }
      btn.disabled = false;
    };
    if ($('#wzSave')) $('#wzSave').onclick = async () => {
      collect();
      try { const { versions, ...clean } = d; const r = await api('/subagents', { body: clean }); d.id = r.id; window.toast(edit ? 'ذخیره شد' : 'ایجنت ساخته شد'); load(); draw(); $('#wzTestIn') && $('#wzTestIn').focus(); }
      catch (e) { window.toast(e.message, true); }
    };
    if ($('#wzTest')) $('#wzTest').onclick = () => runTest(d, $('#wzTestIn').value, $('#wzTestOut'));
  };
  draw();
}
async function runTest(a, text, out, btn) {
  if (!String(text || '').trim()) { out.textContent = 'یک پیام بنویسید.'; return; }
  out.innerHTML = '<span class="tk-dots"><i></i><i></i><i></i></span>';
  try {
    const r = await api(`/subagents/${a.id}/test`, { body: { text } });
    out.innerHTML = r.ok ? `<div class="md">${window.md ? window.md(r.text) : esc(r.text)}</div><div class="help">${esc(pretty(r.model))} · ${faN((r.ms / 1000).toFixed(1))} ثانیه</div>` : `<span class="bad">${esc(r.error)}</span>`;
  } catch (e) { out.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
}
function testDialog(a) {
  window.dialog(`<div class="dlg-scroll"><h3>${icon(a)}آزمایش «${esc(a.name)}»</h3><p class="help">یک پیام نمونه بفرستید. ایجنت با دستورالعمل خودش جواب می‌دهد (در این آزمایش به فایل‌ها دسترسی ندارد).</p>
    <div class="field"><textarea id="tdIn" dir="auto" rows="4"></textarea></div><div id="tdOut" class="ag-test-out" dir="auto"></div></div>
    <div class="dlg-actions"><button type="button" class="btn primary" id="tdGo">${ic('play', 'sm')}اجرا</button><button class="btn ghost" value="cancel">بستن</button></div>`, true);
  $('#tdGo').onclick = () => runTest(a, $('#tdIn').value, $('#tdOut'));
  setTimeout(() => $('#tdIn').focus(), 50);
}
function versionsDialog(a) {
  const vs = a.versions || [];
  window.dialog(`<div class="dlg-scroll"><h3>${ic('history')}نسخه‌های «${esc(a.name)}»</h3>
    <ol class="ag-vers">${vs.map((v, i) => `<li><div><b>${new Date(v.savedAt).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' })}</b><span class="help" dir="auto">${esc(v.description || '')} · ${esc(modelLabel(v))}</span>
      <pre dir="auto">${esc(v.prompt.slice(0, 400))}${v.prompt.length > 400 ? '…' : ''}</pre></div><button type="button" class="btn btn-sm" data-restore="${i}">${ic('rotate-ccw', 'sm')}بازگردانی</button></li>`).join('')}</ol></div>
    <div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`, true);
  $('#dlgBody').onclick = async e => { const b = e.target.closest('[data-restore]'); if (!b) return; try { await api(`/subagents/${a.id}/restore`, { body: { index: +b.dataset.restore } }); $('#dlg').close(); window.toast('بازگردانده شد (نسخه‌ی فعلی هم در تاریخچه ماند)'); load(); } catch (err) { window.toast(err.message, true); } };
}
async function exportAgent(a) {
  const r = await api(`/subagents/${a.id}/export`);
  window.dialog(`<div class="dlg-scroll"><h3>${ic('download')}خروجی «${esc(a.name)}»</h3><p class="help">فایل Markdown با جارویس و Claude Code (پوشه‌ی .claude/agents) سازگار است؛ JSON همه‌ی جزئیات را دارد.</p></div>
    <div class="dlg-actions"><button type="button" class="btn primary" data-dl="md">${ic('download', 'sm')}${esc(a.name)}.md</button><button type="button" class="btn" data-dl="json">${ic('download', 'sm')}${esc(a.name)}.json</button><button class="btn ghost" value="cancel">بستن</button></div>`);
  document.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => {
    const kind = b.dataset.dl, blob = new Blob([kind === 'md' ? r.md : r.json], { type: kind === 'md' ? 'text/markdown' : 'application/json' });
    const l = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: a.name + '.' + kind }); l.click(); setTimeout(() => URL.revokeObjectURL(l.href), 2000);
  });
}
function importDialog() {
  window.dialog(`<div class="dlg-scroll"><h3>${ic('upload')}وارد کردن ایجنت</h3><p class="help">فایل .json (خروجی جارویس) یا .md (ایجنت Claude Code با front matter) را انتخاب کنید یا متنش را بچسبانید.</p>
    <div class="field"><input type="file" id="imFile" accept=".md,.json,.txt"></div><div class="field"><textarea id="imText" dir="ltr" rows="10" placeholder="---&#10;name: my-agent&#10;description: …&#10;---&#10;You are …"></textarea></div></div>
    <div class="dlg-actions"><button type="button" class="btn primary" id="imGo">${ic('upload', 'sm')}وارد کن</button><button class="btn ghost" value="cancel">انصراف</button></div>`, true);
  $('#imFile').onchange = async e => { const f = e.target.files[0]; if (f) $('#imText').value = await f.text(); };
  $('#imGo').onclick = async () => { try { const r = await api('/subagents/import', { body: { text: $('#imText').value } }); $('#dlg').close(); window.toast(faN(r.length) + ' ایجنت وارد شد'); load(); } catch (e) { window.toast(e.message, true); } };
}

window.addEventListener('jarvis:ev', e => { const t = e.detail && e.detail.type; if (A.el && A.el.classList.contains('on') && ['subagents', 'chat', 'finished'].includes(t)) { clearTimeout(A._t); A._t = setTimeout(load, 400); } });
window.agentWizard = wizard;
window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('agents', { icon: 'bot', label: 'ایجنت‌ها', enter, leave() {} });
