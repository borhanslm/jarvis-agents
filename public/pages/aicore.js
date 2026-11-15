// AI Core: every language model JARVIS can use, in one place — Claude, Codex, saved API
// connections (Gemini, Grok, OpenRouter, Groq, NVIDIA, DeepSeek, OpenAI…) and local Ollama models.
// Add, test, edit, remove; pick the offline model.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const faN = n => Number(n).toLocaleString('fa-IR');
const api = (p, o) => window.api(p, o);
const S = () => window.JARVIS_STATE || {};

const KIND = { anthropic: 'سازگار با Anthropic · چت + تیم کدنویسی (Claude Code)', openai: 'OpenAI Responses · چت + تیم کدنویسی (Codex)', chat: 'OpenAI Chat · چت، صدا و تلگرام' };
// a short mark for each service (letters, no logos)
const MARK = { gemini: 'G', grok: 'X', openrouter: 'OR', groq: 'GQ', nvidia: 'NV', deepseek: 'DS', 'deepseek-chat': 'DS', openai: 'AI', 'openai-chat': 'AI', kimi: 'K', glm: 'Z', minimax: 'MM', anthropic: 'A', lmstudio: 'LM', custom: '+' };

let el = null, tests = {};
function enter(host) { el = host; render(); }

async function render() {
  if (!el) return;
  const st = S();
  let models = [], cc = null, ol = null;
  try { [models, cc, ol] = await Promise.all([api('/llms'), api('/cc').catch(() => null), api('/voice/status').then(v => v.ollama).catch(() => null)]); } catch (e) { el.innerHTML = `<div class="pg"><p class="bad">${esc(e.message)}</p></div>`; return; }
  const s = st.settings || {};
  const provs = st.providers || [];
  const claude = cc && cc.llms.find(l => l.id === 'claude');
  const codex = cc && cc.llms.find(l => l.id === 'codex');
  const presets = (st.providerPresets || []).filter(p => p.id !== 'custom');
  const testBtn = spec => `<button type="button" class="btn btn-sm" data-test="${esc(spec)}">${ic('zap', 'sm')}آزمایش</button><span class="ai-test" data-res="${esc(spec)}">${tests[spec] ? testHtml(tests[spec]) : ''}</span>`;
  const card = (mark, title, sub, ok, body, actions = '') => `<article class="ai-card ${ok ? 'ok' : ''}"><header><span class="ai-mark">${esc(mark)}</span><div><h3 dir="auto">${esc(title)}</h3><div class="help">${sub}</div></div><span class="ai-dot" title="${ok ? 'آماده' : 'آماده نیست'}"></span></header>${body}<footer>${actions}</footer></article>`;
  const modelRows = list => `<ul class="ai-models">${list.map(m => `<li><code dir="ltr">${esc(m.name)}</code>${m.note ? `<span class="help">${esc(m.note)}</span>` : ''}${testBtn(m.spec)}</li>`).join('')}</ul>`;

  el.innerHTML = `<div class="pg">
    <header class="pg-head"><div><h1>${ic('brain')}هسته‌ی هوش مصنوعی<span class="hud-tag" aria-hidden="true">AI CORE</span></h1>
      <p class="help">همه‌ی مدل‌هایی که جارویس با آن‌ها کار می‌کند. هر کدام را اینجا اضافه و آزمایش کنید؛ بعد در چت، صدا، تلگرام و تیم کدنویسی قابل انتخاب‌اند.</p></div>
      <div class="pg-stat"><b>${faN(models.length)}</b><span>مدل آماده</span></div></header>

    <section class="ai-offline"><div><h2>${ic('wifi-off', 'sm')}مدل آفلاین</h2><p class="help">وقتی اینترنت قطع است (یا حالت «همیشه آفلاین» را انتخاب کرده‌اید)، چت و دستیار صوتی با این مدل روی همین کامپیوتر جواب می‌دهند.</p></div>
      <select id="aiOffline" dir="ltr">${[['', '— هیچ —'], ...(ol ? ol.models.map(m => [m.name, m.name]) : [])].map(([k, l]) => `<option value="${esc(k)}" ${k === (s.voiceModelOffline || '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <select id="aiMode">${[['auto', 'خودکار: آنلاین با اینترنت، آفلاین بدون آن'], ['online', 'همیشه آنلاین'], ['offline', 'همیشه آفلاین']].map(([k, l]) => `<option value="${k}" ${k === (s.voiceMode || 'auto') ? 'selected' : ''}>${l}</option>`).join('')}</select></section>

    <h2 class="pg-sub">متصل</h2>
    <div class="ai-grid">
      ${card('C', 'Claude', claude && claude.ok ? (st.claudeAuth === 'api-key' ? 'با کلید API' : 'با ورود Claude Code') : 'وصل نیست', claude && claude.ok,
        modelRows(models.filter(m => m.group === 'Claude')), `<button type="button" class="btn btn-sm" data-setup="1">${ic('plug', 'sm')}اتصال حساب‌ها</button>`)}
      ${card('CX', 'Codex', codex && codex.ok ? 'نصب است · برای تیم کدنویسی' : 'نصب نیست', codex && codex.ok, `<p class="help">Codex CLI برای سازنده/تستر تیم کدنویسی استفاده می‌شود (چت ساده از آن استفاده نمی‌کند).</p>`, `<button type="button" class="btn btn-sm" data-setup="1">${ic('plug', 'sm')}اتصال حساب‌ها</button>`)}
      ${provs.map(p => card(MARK[p.preset] || p.name.slice(0, 2).toUpperCase(), p.name, `${esc(KIND[p.kind] || p.kind)}${p.hasKey ? '' : /^http:\/\/(localhost|127\.)/.test(p.baseUrl) ? ' · محلی' : ' · <span class="bad">کلید ندارد</span>'}`, p.hasKey || /^http:\/\/(localhost|127\.)/.test(p.baseUrl),
        modelRows(models.filter(m => m.spec.startsWith('p:' + p.id + ':'))),
        `<button type="button" class="btn btn-sm" data-edit="${esc(p.id)}">${ic('pencil', 'sm')}ویرایش</button><button type="button" class="btn btn-sm ghost danger" data-del="${esc(p.id)}">${ic('trash-2', 'sm')}حذف</button>`)).join('')}
      ${card('OL', 'Ollama — مدل‌های محلی', !ol || !ol.installed ? 'نصب نیست' : ol.running ? 'در حال اجرا · بدون اینترنت کار می‌کند' : 'نصب است، اجرا نشده', !!(ol && ol.running && ol.models.length),
        !ol || !ol.installed ? `<p class="help">برنامه‌ی رایگان Ollama را نصب کنید تا مدل‌ها روی همین کامپیوتر و بدون اینترنت اجرا شوند: <a href="https://ollama.com/download" target="_blank" rel="noopener" dir="ltr">ollama.com/download</a></p>`
          : modelRows(models.filter(m => m.spec.startsWith('ollama:'))) + `<div class="ai-pull">${ol.suggested.filter(x => !ol.models.some(m => m.name === x.name)).map(x => { const p = ol.pulls[x.name];
            return `<div class="ai-pull-row"><code dir="ltr">${esc(x.name)}</code><span class="help">${faN((x.size / 1e9).toFixed(1))} گیگ · ${esc(x.note)}</span>${p && !p.done && !p.error ? `<progress max="${p.total || 1}" value="${p.completed || 0}"></progress>` : `<button type="button" class="btn btn-sm" data-pull="${esc(x.name)}">${ic('download', 'sm')}دانلود</button>`}${p && p.error ? `<span class="bad">${esc(p.error)}</span>` : ''}</div>`; }).join('')}</div>`,
        ol && ol.installed && !ol.running ? `<button type="button" class="btn btn-sm" data-olstart="1">${ic('play', 'sm')}اجرای Ollama</button>` : '')}
    </div>

    <h2 class="pg-sub">افزودن سرویس</h2>
    <div class="ai-presets">${presets.map(p => `<button type="button" class="ai-preset" data-add="${esc(p.id)}"><span class="ai-mark">${esc(MARK[p.id] || p.name.slice(0, 2))}</span><b dir="auto">${esc(p.name)}</b><span class="help">${p.kind === 'chat' ? 'چت و دستیار' : 'چت + کدنویسی'}</span></button>`).join('')}
      <button type="button" class="ai-preset" data-add="custom"><span class="ai-mark">+</span><b>سفارشی</b><span class="help">هر API سازگار</span></button></div>
    <p class="help">${ic('lock', 'sm')} کلیدها فقط روی همین کامپیوتر و رمزنگاری‌شده ذخیره می‌شوند و فقط به همان سرویس فرستاده می‌شوند.</p>
  </div>`;
}

function testHtml(r) {
  if (r === 'wait') return `<span class="help">در حال آزمایش…</span>`;
  return r.ok ? `<span class="ok">${ic('circle-check', 'sm')}${faN((r.ms / 1000).toFixed(1))} ثانیه</span>` : `<span class="bad" title="${esc(r.error)}">${ic('circle-x', 'sm')}${esc(String(r.error).slice(0, 80))}</span>`;
}

document.addEventListener('click', async e => {
  if (!el || !el.contains(e.target)) return;
  const t = e.target.closest('[data-test],[data-edit],[data-del],[data-add],[data-setup],[data-pull],[data-olstart]');
  if (!t) return;
  try {
    if (t.dataset.test) {
      const spec = t.dataset.test; tests[spec] = 'wait';
      const out = el.querySelector(`[data-res="${CSS.escape(spec)}"]`); if (out) out.innerHTML = testHtml('wait');
      tests[spec] = await api('/llms/test', { body: { spec } });
      const o2 = el.querySelector(`[data-res="${CSS.escape(spec)}"]`); if (o2) o2.innerHTML = testHtml(tests[spec]);
    } else if (t.dataset.edit) { window.__pvReturn = render; window.providerDialog(t.dataset.edit); }
    else if (t.dataset.del) {
      if (!confirm('این اتصال و کلیدش حذف شود؟')) return;
      await api('/providers/' + t.dataset.del, { method: 'DELETE' }); render();
    } else if (t.dataset.add) {
      window.__pvReturn = render; await window.providerDialog();
      const sel = $('#pvPreset'); if (sel) { sel.value = t.dataset.add; sel.dispatchEvent(new Event('change')); }
    } else if (t.dataset.setup) window.setupDialog();
    else if (t.dataset.pull) { await api('/voice/ollama/pull', { body: { name: t.dataset.pull } }); t.disabled = true; t.textContent = 'در حال دانلود…'; }
    else if (t.dataset.olstart) { t.disabled = true; await api('/voice/ollama/start', { body: {} }); render(); }
  } catch (err) { window.toast(err.message, true); }
});
document.addEventListener('change', async e => {
  if (!el || !el.contains(e.target)) return;
  if (e.target.id === 'aiOffline' || e.target.id === 'aiMode') {
    try { S().settings = await api('/settings', { body: { voiceModelOffline: $('#aiOffline').value, voiceMode: $('#aiMode').value } }); if ($('#aiOffline').value) api('/voice/warm', { body: {} }).catch(() => {}); window.toast('ذخیره شد'); }
    catch (err) { window.toast(err.message, true); }
  }
});
window.addEventListener('jarvis:ev', e => {
  const t = e.detail && e.detail.type;
  if (!el || !el.classList.contains('on')) return;
  if (t === 'providers' || (t === 'ollamaPull' && (e.detail.pull.done || e.detail.pull.error))) { clearTimeout(window.__aiR); window.__aiR = setTimeout(render, 300); }
  if (t === 'ollamaPull' && !e.detail.pull.done) { const b = el.querySelector(`[data-pull="${CSS.escape(e.detail.name)}"]`); const row = b && b.closest('.ai-pull-row'); if (row && b) { const pr = document.createElement('progress'); b.replaceWith(pr); } const pr = [...el.querySelectorAll('.ai-pull-row')].find(r => r.querySelector('code').textContent === e.detail.name); const p = pr && pr.querySelector('progress'); if (p) { p.max = e.detail.pull.total || 1; p.value = e.detail.pull.completed || 0; } }
});

window.registerView = window.registerView || ((id, def) => { (window.JARVIS_VIEWS = window.JARVIS_VIEWS || {})[id] = def; });
window.registerView('ai', { icon: 'brain', label: 'هسته‌ی هوش مصنوعی', enter, leave() {} });
window.aiCoreRender = render;
