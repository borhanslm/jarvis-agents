// Smart-mode plan card, connectors (MCP) & plugins, task queue, cost estimate.
// SVG icons for the connector catalog (no emoji as icons)
const EXT_IC = { playwright: 'globe', context7: 'book-open', github: 'git-branch', memory: 'brain', thinking: 'sparkles', postgres: 'database', brave: 'search' };
const extIc = c => ic(EXT_IC[c.key] || EXT_IC[c.id] || 'plug');
// Loaded after app.js and uses its helpers ($, S, api, dialog, esc, ic, toast, fa, …).
'use strict';

const usd = n => '$' + (+n || 0).toFixed(n >= 1 ? 2 : 3);
const LEVEL_FA = { hard: 'سخت', medium: 'متوسط', easy: 'ساده' };

// ---------- smart mode: the plan card ----------
function buildSmartPlan(m) {
  const d = document.createElement('div');
  d.className = 'msg system';
  const plan = m.plan || [];
  const waiting = !m.approved && S.chat && S.chat.status === 'waiting';
  const opts = v => { const o = modelOptions('claude', v).filter(([x]) => x && x !== '__custom'); return m.split && !o.some(([x]) => x === 'codex') ? [['codex', 'Codex'], ...o] : o; };
  const saving = m.topUsd > 0 ? Math.max(0, Math.round((1 - m.estUsd / m.topUsd) * 100)) : 0;
  d.innerHTML = `<div class="smartcard" data-smartid="${esc(m.id)}">
    <div class="tc-head">${ic(m.split ? 'network' : 'sparkles')}<b>${m.split ? 'تقسیم بین هوش‌ها' : 'تقسیم کار هوشمند'}</b><span class="help">${fa(plan.length)} بخش · ${m.split ? 'هر بخش با یک هوش؛ بخش‌های «هم‌زمان» با هم انجام می‌شوند' : 'هر بخش با مدلی که لازم دارد'}</span></div>
    <ol class="sp-list">${plan.map((p, i) => `<li>
      <span class="lvl ${esc(p.level || '')}">${p.levelFa ? esc(p.levelFa) : LEVEL_FA[p.level] || esc(p.level)}</span>
      <span class="sp-title" dir="auto">${esc(p.title)}</span>
      ${waiting ? `<select data-spmodel="${i}" dir="ltr" aria-label="مدل بخش ${i + 1}">${opts(p.model).map(([v, l]) => `<option value="${esc(v)}" ${v === p.model ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
        : `<span class="sp-model" dir="ltr">${esc(p.label || prettyModel(p.model))}</span>`}
      <span class="sp-cost" dir="ltr" title="برآورد تقریبی">~${usd(p.estUsd)}</span></li>`).join('')}</ol>
    <div class="sp-foot">${ic('wallet', 'sm')}برآورد: <b dir="ltr">~${usd(m.estUsd)}</b>
      ${m.topUsd ? `<span class="help">در برابر <span dir="ltr">~${usd(m.topUsd)}</span> اگر همه با ${esc(m.topLabel || 'قوی‌ترین مدل')} انجام می‌شد${saving ? ` — حدود ${fa(saving)}٪ ارزان‌تر` : ''}</span>` : ''}
      <span class="help">بررسی و تست تستر جداگانه حساب می‌شود.</span></div>
    ${waiting ? `<div class="row-gap"><button type="button" class="btn small primary" data-smartok="1">${ic('play', 'sm')}شروع با همین برنامه</button><button type="button" class="btn small ghost danger" data-smartstop="1">${ic('circle-stop', 'sm')}لغو</button></div>`
      : m.approved ? '' : '<div class="help">منتظر تأیید نماند (اجرا تمام شد).</div>'}
  </div>`;
  return d;
}
window.buildSmartPlan = buildSmartPlan;
$('#stream').addEventListener('click', async e => {
  const ok = e.target.closest('[data-smartok]'), stop = e.target.closest('[data-smartstop]');
  if (!S.chat || (!ok && !stop)) return;
  if (stop) { try { await api(`/chats/${S.chat.id}/stop`, { body: {} }); } catch (err) { toast(err.message, true); } return; }
  const card = ok.closest('.smartcard');
  const models = [...card.querySelectorAll('[data-spmodel]')].sort((a, b) => a.dataset.spmodel - b.dataset.spmodel).map(s => s.value);
  ok.disabled = true;
  try { const r = await api(`/chats/${S.chat.id}/smart-approve`, { body: { models } }); if (!r.ok) toast('این برنامه دیگر منتظر تأیید نیست', true); } catch (err) { toast(err.message, true); ok.disabled = false; }
});

// ---------- cost estimate under the message box ----------
let estTimer = null, estKey = '';
function updateEstimate() {
  const key = S.chat ? [S.chat.id, S.chat.status, (document.querySelector('input[name=mode]:checked') || {}).value].join('|') : '';
  if (key === estKey) return;
  estKey = key;
  clearTimeout(estTimer);
  estTimer = setTimeout(async () => {
    const el = $('#estimate');
    if (!S.chat) { el.hidden = true; return; }
    const mode = (document.querySelector('input[name=mode]:checked') || {}).value || 'team';
    try {
      const r = await api(`/chats/${S.chat.id}/estimate?mode=${encodeURIComponent(mode)}`);
      if (r.usd == null || !(r.usd > 0)) { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = `${ic('wallet', 'sm')}<span>برآورد: <b dir="ltr">~${usd(r.usd)}</b></span>`;
      el.title = (r.basis === 'history' ? `میانه‌ی هزینه‌ی ${fa(r.n)} کار قبلی در همین حالت` : 'برآورد تقریبی (هنوز سابقه‌ی کافی نیست)') + (S.claudeAuth === 'claude.ai' ? ' — با اشتراک Pro/Max فقط معادل API است و پولی پرداخت نمی‌شود.' : '');
    } catch { el.hidden = true; }
  }, 250);
}
$('#modes').addEventListener('change', updateEstimate);
// refresh the estimate whenever another chat is shown or a run changes state
new MutationObserver(updateEstimate).observe($('#chatHead'), { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true });

// ---------- badges in the top bar ----------
function renderExtBadges() {
  const pend = (S.queueJobs || []).filter(j => j.status === 'pending' || j.status === 'running').length;
  const b = $('#queueBadge'); b.hidden = !pend; b.textContent = fa(pend);
}
window.renderExtBadges = renderExtBadges;

// ---------- connectors (MCP) & plugins ----------
const ROLE_FA = { builder: 'سازنده', reviewer: 'تستر اصلی', subs: 'ساب‌ایجنت‌ها' };
let extTab = 'connectors';
function extDialog(tab) {
  if (tab) extTab = tab;
  const tabs = `<div class="ext-tabs" role="tablist">
    <button type="button" role="tab" class="${extTab === 'connectors' ? 'on' : ''}" data-exttab="connectors">${ic('plug', 'sm')}اتصال‌دهنده‌ها (MCP)</button>
    <button type="button" role="tab" class="${extTab === 'plugins' ? 'on' : ''}" data-exttab="plugins">${ic('puzzle', 'sm')}پلاگین‌ها</button></div>`;
  dialog(`<div class="dlg-scroll"><h3>${ic('puzzle')}اتصال‌دهنده‌ها و پلاگین‌ها</h3>${tabs}<div id="extBody" class="ext-body">${extTab === 'connectors' ? connectorsHtml() : pluginsHtml()}</div></div>
    <div class="dlg-actions"><button class="btn ghost" value="cancel">بستن</button></div>`, true);
  $('#dlgBody').onclick = extClick;
}
window.extDialog = extDialog;
window.onExtChanged = () => { const b = document.getElementById('extBody'); if (b && $('#dlg').open && !document.getElementById('cnForm')) b.innerHTML = extTab === 'connectors' ? connectorsHtml() : pluginsHtml(); };

function connectorsHtml() {
  const list = S.connectors || [];
  const have = new Set(list.map(c => c.catalog).filter(Boolean));
  const rows = list.length ? list.map(c => {
    const missing = (c.secrets || []).some(s => !s.set);
    return `<div class="ext-row ${c.enabled ? '' : 'off'}">
      <label class="switch" title="فعال/غیرفعال"><input type="checkbox" data-cntoggle="${esc(c.id)}" ${c.enabled ? 'checked' : ''}><span></span></label>
      <span class="ext-ic">${extIc(c)}</span>
      <div class="ext-main"><b dir="auto">${esc(c.name)}</b>${c.plugin ? '<span class="pill">از پلاگین</span>' : ''}
        <div class="help" dir="auto">${esc(c.desc || '')}</div><code class="cn-cmd" dir="ltr">${esc(c.type === 'http' ? c.url : [c.command, ...(c.args || [])].join(' '))}</code>
        <div class="ext-roles">${Object.keys(ROLE_FA).map(r => `<span class="role ${c.roles && c.roles[r] ? 'on' : ''}">${ROLE_FA[r]}</span>`).join('')}
          ${missing ? `<span class="warn">${ic('triangle-alert', 'sm')}مقدار لازم وارد نشده</span>` : ''}<span class="cn-test" id="cnt-${esc(c.id)}"></span></div></div>
      <div class="ext-acts">
        <button type="button" class="btn small ghost" data-cntest="${esc(c.id)}">${ic('zap', 'sm')}آزمایش</button>
        <button type="button" class="btn small ghost" data-cnedit="${esc(c.id)}">${ic('pencil', 'sm')}ویرایش</button></div></div>`;
  }).join('') : '<div class="help empty-note">هنوز اتصال‌دهنده‌ای ندارید. از فهرست زیر یکی اضافه کنید — بعد ایجنت‌ها می‌توانند از ابزارهایش استفاده کنند.</div>';
  const cat = (S.connectorCatalog || []).map(c => `<button type="button" class="cat-card ${have.has(c.key) ? 'added' : ''}" data-cnadd="${esc(c.key)}" ${have.has(c.key) ? 'disabled' : ''}>
      <span class="ext-ic">${extIc(c)}</span><b>${esc(c.name)}</b><span class="help">${esc(c.desc)}</span>${have.has(c.key) ? '<em>اضافه شد</em>' : ''}</button>`).join('');
  return `<p class="help">${ic('info', 'sm')} اتصال‌دهنده‌ها همان سرورهای MCP هستند که Claude Code هم استفاده می‌کند. هر کدام را می‌توانید فقط به سازنده، تستر یا ساب‌ایجنت‌ها بدهید؛ روی همه‌ی موتورها (Claude، Codex و اتصال‌هایی مثل DeepSeek) کار می‌کند.</p>
    <div class="ext-list">${rows}</div>
    <h4>افزودن</h4><div class="cat-grid">${cat}
      <button type="button" class="cat-card custom" data-cnadd=""><span class="ext-ic">${ic('plus')}</span><b>اتصال‌دهنده‌ی دلخواه</b><span class="help">هر سرور MCP: یک فرمان (مثل npx …) یا یک آدرس https</span></button></div>`;
}

function connectorForm(c) {
  const isNew = !c.id;
  const secretRows = (c.secrets || []).map(s => `<div class="field"><label>${esc(s.label || s.name)} <code dir="ltr">${esc(s.name)}</code>${c.link ? ` <a href="${esc(c.link)}" target="_blank" rel="noopener">${ic('external-link', 'sm')}گرفتن</a>` : ''}</label>
      <input type="password" data-cnsecret="${esc(s.name)}" dir="ltr" autocomplete="off" placeholder="${s.set ? 'ذخیره شده — برای تغییر مقدار جدید وارد کنید' : ''}"></div>`).join('');
  $('#extBody').innerHTML = `<div id="cnForm" class="cn-form">
    <h4>${isNew ? 'اتصال‌دهنده‌ی جدید' : 'ویرایش اتصال‌دهنده'}</h4>
    <div class="field-row"><div class="field" style="flex:0 0 70px"><label>آیکون</label><input id="cnIcon" value="${esc(c.icon || '🔌')}" maxlength="4"></div>
      <div class="field"><label>نام</label><input id="cnName" value="${esc(c.name || '')}" dir="auto"></div></div>
    <div class="field"><label>نوع</label><select id="cnType"><option value="stdio">برنامه‌ی محلی (فرمان)</option><option value="http">آدرس اینترنتی (HTTP)</option></select></div>
    <div class="field cn-stdio"><label>فرمان</label><input id="cnCmd" dir="ltr" value="${esc(c.command || 'npx')}" placeholder="npx"></div>
    <div class="field cn-stdio"><label>آرگومان‌ها (هر خط یکی)</label><textarea id="cnArgs" dir="ltr" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-memory">${esc((c.args || []).join('\n'))}</textarea></div>
    <div class="field cn-http"><label>آدرس</label><input id="cnUrl" dir="ltr" value="${esc(c.url || '')}" placeholder="https://…/mcp"></div>
    ${secretRows}
    ${c.catalog || c.plugin ? '' : `<div class="field"><label>مقدارهای مخفی (هر خط NAME=مقدار — برای فرمان‌ها متغیر محیطی، برای آدرس‌ها هدر HTTP)</label><textarea id="cnNewSecrets" dir="ltr" rows="2" placeholder="API_KEY=…"></textarea>
      <div class="help">${ic('lock', 'sm')} رمزنگاری‌شده و فقط روی همین کامپیوتر ذخیره می‌شوند. در آرگومان‌ها می‌توانید \${NAME} بنویسید.</div></div>`}
    <div class="field"><label>به چه کسانی داده شود</label><div class="row-gap">${Object.entries(ROLE_FA).map(([r, l]) => `<label class="check"><input type="checkbox" data-cnrole="${r}" ${c.roles && c.roles[r] ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
    <div class="row-gap"><button type="button" class="btn primary" id="cnSave">${ic('save', 'sm')}ذخیره</button>
      <button type="button" class="btn ghost" data-exttab="connectors">بازگشت</button>
      ${isNew ? '' : `<button type="button" class="btn ghost danger" data-cndel="${esc(c.id)}" style="margin-inline-start:auto">${ic('trash-2', 'sm')}حذف</button>`}</div></div>`;
  const sync = () => { const h = $('#cnType').value === 'http'; document.querySelectorAll('.cn-stdio').forEach(x => x.hidden = h); document.querySelectorAll('.cn-http').forEach(x => x.hidden = !h); };
  $('#cnType').value = c.type || 'stdio'; $('#cnType').onchange = sync; sync();
  $('#cnSave').onclick = async () => {
    const values = {}; const secrets = [...(c.secrets || [])];
    document.querySelectorAll('[data-cnsecret]').forEach(i => { if (i.value.trim()) values[i.dataset.cnsecret] = i.value.trim(); });
    const extra = document.getElementById('cnNewSecrets');
    if (extra) for (const line of extra.value.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.+)$/); if (mm) { if (!secrets.some(s => s.name === mm[1])) secrets.push({ name: mm[1], label: mm[1] }); values[mm[1]] = mm[2].trim(); } }
    const body = { id: c.id, key: c.key, catalog: c.catalog, link: c.link, desc: c.desc, icon: $('#cnIcon').value, name: $('#cnName').value, type: $('#cnType').value, command: $('#cnCmd').value, args: $('#cnArgs').value,
      url: $('#cnUrl').value, secrets, values, enabled: c.enabled !== false, roles: Object.fromEntries([...document.querySelectorAll('[data-cnrole]')].map(i => [i.dataset.cnrole, i.checked])) };
    try { await api('/connectors', { body }); toast('ذخیره شد'); extDialog('connectors'); } catch (err) { toast(err.message, true); }
  };
}

function pluginsHtml() {
  const list = S.plugins || [];
  const rows = list.length ? list.map(p => `<div class="ext-row ${p.enabled ? '' : 'off'}">
      <label class="switch" title="فعال/غیرفعال"><input type="checkbox" data-pltoggle="${esc(p.id)}" ${p.enabled ? 'checked' : ''}><span></span></label>
      <span class="ext-ic">${ic('puzzle')}</span>
      <div class="ext-main"><b dir="ltr">${esc(p.name)}</b>${p.version ? `<span class="pill" dir="ltr">v${esc(p.version)}</span>` : ''}
        <div class="help" dir="auto">${esc(p.description || '')}</div>
        <div class="ext-roles">${p.subagents.length ? `<span class="role on">${fa(p.subagents.length)} ایجنت</span>` : ''}${p.skills.length ? `<span class="role on">${fa(p.skills.length)} اسکیل</span>` : ''}${(p.commands || []).length ? `<span class="role on">${fa(p.commands.length)} فرمان</span>` : ''}${p.connectors.length ? `<span class="role on">${fa(p.connectors.length)} اتصال‌دهنده</span>` : ''}
          ${(() => { const off = (p.connectors || []).filter(id => { const c = (S.connectors || []).find(x => x.id === id); return c && !c.enabled; }).length; return off ? `<span class="warn">${ic('triangle-alert', 'sm')}${fa(off)} اتصال‌دهنده‌ی این پلاگین خاموش است — در زبانه‌ی اتصال‌دهنده‌ها فرمانش را ببینید و اگر به آن اعتماد دارید روشنش کنید</span>` : ''; })()}</div></div>
      <div class="ext-acts"><button type="button" class="btn small ghost danger" data-pldel="${esc(p.id)}">${ic('trash-2', 'sm')}حذف</button></div></div>`).join('')
    : '<div class="help empty-note">پلاگینی نصب نشده.</div>';
  return `<p class="help">${ic('info', 'sm')} پلاگین‌ها با همان قالب پلاگین‌های Claude Code هستند. ایجنت‌های پلاگین به تیم اضافه می‌شوند (بررسی‌کننده‌ها کنار تستر، بقیه کمک سازنده)، اسکیل‌هایش به آن‌ها وصل می‌شود، فرمان‌هایش بالای کادر پیام می‌آید و سرورهای MCP آن به اتصال‌دهنده‌ها اضافه می‌شوند.</p>
    <div class="ext-list">${rows}</div>
    <h4>نصب از GitHub یا مارکت‌پلیس</h4>
    <div class="pl-install"><input id="plUrl" dir="ltr" placeholder="owner/repo یا https://github.com/…"><button type="button" class="btn primary small" id="plGit">${ic('download', 'sm')}دریافت</button></div>
    <div class="row-gap help">پیشنهاد: <button type="button" class="linkbtn" data-plurl="anthropics/claude-plugins-official">anthropics/claude-plugins-official</button> · <button type="button" class="linkbtn" data-plurl="anthropics/claude-code">anthropics/claude-code</button></div>
    <div id="plMarket"></div>
    <h4>از پلاگین‌های نصب‌شده در Claude Code یا یک پوشه</h4>
    <div class="row-gap"><button type="button" class="btn small ghost" id="plDiscover">${ic('folder-search', 'sm')}پیدا کردن پلاگین‌های Claude Code</button></div>
    <div class="pl-install"><input id="plDir" dir="ltr" placeholder="C:\\path\\to\\plugin"><button type="button" class="btn small ghost" id="plDirBtn">${ic('folder-plus', 'sm')}نصب از پوشه</button></div>
    <div id="plFound"></div>`;
}

async function installPlugin(body, btn) {
  const old = btn && btn.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'در حال نصب…'; }
  try {
    const r = await api('/plugins/install', { body });
    if (r.marketplace) {
      $('#plMarket').innerHTML = `<div class="market"><div class="help">مارکت‌پلیس ${esc(r.name || '')} — ${fa(r.plugins.length)} پلاگین</div>
        <input id="plFilter" dir="auto" placeholder="جستجو در پلاگین‌ها…">
        <div class="market-list">${r.plugins.map(p => `<div class="mk-row" data-mkname="${esc((p.name + ' ' + p.description).toLowerCase())}"><b dir="ltr">${esc(p.name)}</b><span class="help" dir="auto">${esc(p.description)}</span>
          <button type="button" class="btn small" data-plpick="${esc(p.name)}" data-plfrom="${esc(r.url)}">${ic('download', 'sm')}نصب</button></div>`).join('')}</div></div>`;
      $('#plFilter').oninput = e => { const q = e.target.value.trim().toLowerCase(); document.querySelectorAll('.mk-row').forEach(x => { x.hidden = q && !x.dataset.mkname.includes(q); }); };
      return;
    }
    toast(`پلاگین «${r.name}» نصب شد: ${fa(r.subagents.length)} ایجنت، ${fa(r.skills.length)} اسکیل، ${fa((r.commands || []).length)} فرمان، ${fa(r.connectors.length)} اتصال‌دهنده${r.connectors.length ? ' (اتصال‌دهنده‌ها خاموش‌اند تا خودتان روشنشان کنید)' : ''}`);
    if (btn && btn.dataset.plpick) { btn.textContent = 'نصب شد ✓'; return; }
    extDialog('plugins');
  } catch (err) { toast(err.message, true); }
  finally { if (btn && btn.textContent === 'در حال نصب…') { btn.disabled = false; btn.innerHTML = old; } }
}

async function extClick(e) {
  const t = e.target;
  const tab = t.closest('[data-exttab]'); if (tab) { extDialog(tab.dataset.exttab); return; }
  const add = t.closest('[data-cnadd]');
  if (add) { const c = (S.connectorCatalog || []).find(x => x.key === add.dataset.cnadd); connectorForm(c ? { ...c, catalog: c.key, secrets: (c.secrets || []).map(s => ({ ...s, set: false })) } : { roles: { builder: true, reviewer: true, subs: false } }); return; }
  const ed = t.closest('[data-cnedit]'); if (ed) { connectorForm((S.connectors || []).find(c => c.id === ed.dataset.cnedit)); return; }
  const tg = t.closest('[data-cntoggle]'); if (tg) { try { await api(`/connectors/${tg.dataset.cntoggle}/toggle`, { body: { enabled: tg.checked } }); } catch (err) { toast(err.message, true); } return; }
  const del = t.closest('[data-cndel]'); if (del) { if (!confirm('این اتصال‌دهنده حذف شود؟')) return; try { await api('/connectors/' + del.dataset.cndel, { method: 'DELETE' }); extDialog('connectors'); } catch (err) { toast(err.message, true); } return; }
  const ts = t.closest('[data-cntest]');
  if (ts) {
    const out = document.getElementById('cnt-' + ts.dataset.cntest);
    ts.disabled = true; out.className = 'cn-test'; out.textContent = 'در حال اجرا… (بار اول ممکن است یک دقیقه طول بکشد)';
    try { const r = await api(`/connectors/${ts.dataset.cntest}/test`, { body: {} }); out.className = 'cn-test ok'; out.textContent = `✓ ${fa(r.tools.length)} ابزار: ${r.tools.slice(0, 6).join('، ')}${r.tools.length > 6 ? '…' : ''}`; out.title = r.tools.join('\n'); }
    catch (err) { out.className = 'cn-test bad'; out.textContent = '✗ ' + err.message.slice(0, 200); }
    ts.disabled = false; return;
  }
  const pt = t.closest('[data-pltoggle]'); if (pt) { try { await api(`/plugins/${pt.dataset.pltoggle}/toggle`, { body: { enabled: pt.checked } }); } catch (err) { toast(err.message, true); } return; }
  const pd = t.closest('[data-pldel]'); if (pd) { if (!confirm('این پلاگین و ایجنت‌ها، اسکیل‌ها و اتصال‌دهنده‌هایش حذف شوند؟')) return; try { await api('/plugins/' + pd.dataset.pldel, { method: 'DELETE' }); extDialog('plugins'); } catch (err) { toast(err.message, true); } return; }
  const pu = t.closest('[data-plurl]'); if (pu) { $('#plUrl').value = pu.dataset.plurl; installPlugin({ url: pu.dataset.plurl }, $('#plGit')); return; }
  if (t.closest('#plGit')) { const u = $('#plUrl').value.trim(); if (!u) return toast('آدرس مخزن را وارد کنید', true); installPlugin({ url: u }, $('#plGit')); return; }
  const pk = t.closest('[data-plpick]'); if (pk) { installPlugin({ url: pk.dataset.plfrom, pick: pk.dataset.plpick }, pk); return; }
  if (t.closest('#plDirBtn')) { const d = $('#plDir').value.trim(); if (!d) return; installPlugin({ dir: d }, $('#plDirBtn')); return; }
  const fd = t.closest('[data-pldir]'); if (fd) { installPlugin({ dir: fd.dataset.pldir }, fd); return; }
  if (t.closest('#plDiscover')) {
    try {
      const list = await api('/plugins/discover');
      $('#plFound').innerHTML = list.length ? `<div class="market-list">${list.map(p => `<div class="mk-row"><b dir="ltr">${esc(p.name)}</b><span class="help" dir="auto">${esc(p.description)}</span>
        ${p.installed ? '<em>نصب شده</em>' : `<button type="button" class="btn small" data-pldir="${esc(p.dir)}">${ic('download', 'sm')}نصب</button>`}</div>`).join('')}</div>` : '<div class="help">پلاگینی در Claude Code پیدا نشد.</div>';
    } catch (err) { toast(err.message, true); }
  }
}
$('#btnExt').onclick = () => extDialog();

// ---------- task queue ----------
const QSTATUS = { pending: 'در انتظار', running: 'در حال اجرا', done: 'تمام شد', error: 'خطا', stopped: 'متوقف', budget: 'سقف هزینه', 'needs-attention': 'نیاز به بررسی', unverified: 'تست‌نشده' };
const QMODE = { team: 'تیمی', smart: 'هوشمند', split: 'تقسیم بین هوش‌ها', audit: 'بازرسی و رفع', plan: 'طراحی', claude: 'فقط سازنده', codex: 'فقط تستر' };
function queueListHtml() {
  const jobs = [...(S.queueJobs || [])].sort((a, b) => (a.startAt - b.startAt));
  if (!jobs.length) return '<div class="help empty-note">صف خالی است.</div>';
  return jobs.map(j => {
    const p = S.projects.find(x => x.id === j.projectId);
    const when = j.status === 'pending' ? (j.startAt > Date.now() + 60000 ? 'شروع: ' + new Date(j.startAt).toLocaleString('fa-IR', { hour: '2-digit', minute: '2-digit', weekday: 'short' }) : 'به‌زودی') : '';
    return `<div class="ext-row q-${esc(j.status)}"><span class="status-pill ${esc(j.status)}">${QSTATUS[j.status] || esc(j.status)}</span>
      <div class="ext-main"><b dir="auto">${esc(j.text.slice(0, 140))}</b><div class="help">${esc(p ? p.name : '؟')} · ${QMODE[j.mode] || esc(j.mode)}${when ? ' · ' + when : ''}${j.error ? ' · ' + esc(j.error) : ''}</div></div>
      <div class="ext-acts">${j.chatId ? `<button type="button" class="btn small ghost" data-qopen="${esc(j.chatId)}" data-qproj="${esc(j.projectId)}">${ic('message-square', 'sm')}گفتگو</button>` : ''}
        ${j.status !== 'running' ? `<button type="button" class="btn small ghost danger" data-qdel="${esc(j.id)}" aria-label="حذف">${ic('trash-2', 'sm')}</button>` : ''}</div></div>`;
  }).join('');
}
function queueDialog() {
  const projOpts = S.projects.map(p => `<option value="${esc(p.id)}" ${p.id === S.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  dialog(`<div class="dlg-scroll"><h3>${ic('clock')}صف کارها</h3>
    <p class="help">چند کار (حتی برای پروژه‌های مختلف) بچینید؛ یکی‌یکی اجرا می‌شوند — الان یا از ساعتی که تعیین می‌کنید (مثلاً شب). اگر «اعلان روی گوشی» را روشن کرده باشید، آخر کار خلاصه برایتان فرستاده می‌شود.</p>
    <div class="q-form">
      <div class="field-row"><div class="field"><label>پروژه</label><select id="qProj">${projOpts}</select></div>
        <div class="field"><label>حالت</label><select id="qMode">${Object.entries(QMODE).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>شروع</label><input id="qAt" type="time" dir="ltr" title="خالی = همین حالا"></div></div>
      <div class="field"><label>کار</label><textarea id="qText" rows="3" dir="auto" placeholder="مثلاً: تست‌های ماژول پرداخت را کامل کن"></textarea></div>
      <div class="row-gap"><button type="button" class="btn primary" id="qAdd">${ic('plus', 'sm')}افزودن به صف</button><span class="help">«شروع» خالی = همین حالا</span></div></div>
      <h4>کارها</h4><div class="ext-list" id="qList">${queueListHtml()}</div></div>
    <div class="dlg-actions"><button type="button" class="btn ghost" id="qClear">پاک کردن تمام‌شده‌ها</button><button class="btn ghost" value="cancel">بستن</button></div>`, true);
  $('#dlgBody').onclick = async e => {
    if (e.target.closest('#qAdd')) {
      try { await api('/queue', { body: { projectId: $('#qProj').value, mode: $('#qMode').value, at: $('#qAt').value, text: $('#qText').value } }); $('#qText').value = ''; toast('به صف اضافه شد'); }
      catch (err) { toast(err.message, true); }
      return;
    }
    if (e.target.closest('#qClear')) { try { await api('/queue/clear', { body: {} }); } catch (err) { toast(err.message, true); } return; }
    const del = e.target.closest('[data-qdel]'); if (del) { try { await api('/queue/' + del.dataset.qdel, { method: 'DELETE' }); } catch (err) { toast(err.message, true); } return; }
    const op = e.target.closest('[data-qopen]');
    if (op) { $('#dlg').close(); if (op.dataset.qproj !== S.projectId) selectProject(op.dataset.qproj); await openChat(op.dataset.qopen); }
  };
}
window.queueDialog = queueDialog;
window.onQueueChanged = () => { renderExtBadges(); const l = document.getElementById('qList'); if (l && $('#dlg').open) l.innerHTML = queueListHtml(); };
$('#btnQueue').onclick = queueDialog;
