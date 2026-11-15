#!/usr/bin/env node
// JARVIS — Claude Code ⇄ Codex connector with a local web panel.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./lib/store');
const { Orchestrator } = require('./lib/orchestrator');
const agents = require('./lib/agents');
const git = require('./lib/git');
const crypto = require('crypto');
const { execFile } = require('child_process');

// JARVIS_PORT=0 picks a free port (used by the desktop app). PORT is updated after listen.
let PORT = process.env.JARVIS_PORT !== undefined && process.env.JARVIS_PORT !== '' ? +process.env.JARVIS_PORT : 4777;
// Desktop app: the access token is always required (the window gets it from the main process).
const DESKTOP = process.env.JARVIS_DESKTOP === '1';
const tokenRequired = () => DESKTOP || store.settings().requireToken;
const HOST = '127.0.0.1'; // local only: this server can run agents that edit files
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const DATA = process.env.JARVIS_DATA || path.join(ROOT, 'data');
const store = new Store(DATA);

// Access token: when settings.requireToken is on, every /api request must carry it
// (header X-Jarvis-Token, or ?token= for EventSource). Keeps other local programs out.
const TOKEN_FILE = path.join(DATA, 'token');
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!TOKEN || TOKEN.length < 32) { TOKEN = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); }
// Compare as bytes: a same-length string with multi-byte characters has a different
// byte length, and timingSafeEqual throws on that (which used to crash the server).
const TOKEN_BUF = Buffer.from(TOKEN, 'utf8');
const tokenOk = t => {
  if (typeof t !== 'string') return false;
  const b = Buffer.from(t, 'utf8');
  return b.length === TOKEN_BUF.length && crypto.timingSafeEqual(b, TOKEN_BUF);
};
const clients = new Set();
function broadcast(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
}
const { Usage } = require('./lib/usage');
const graph = require('./lib/graph');
const usage = new Usage(DATA);
const { Skills } = require('./lib/skills');
const skills = new Skills(DATA);
const orch = new Orchestrator({ store, broadcast, usage, skills });
// Account connection (first-run setup): CLI detection, API keys (encrypted), sign-in.
const { Setup } = require('./lib/setup');
const setup = new Setup(DATA);
// How Claude is signed in ('claude.ai' = Pro/Max subscription), cached for a minute.
let authCache = { at: 0, method: null };
async function claudeAuthMethod() {
  if (Date.now() - authCache.at < 60000) return authCache.method;
  let method = null;
  try {
    if (setup.secrets.get('anthropicApiKey')) method = 'apiKey';
    else { const r = await agents.runOnce('claude', ['auth', 'status'], { timeout: 20000 }); const j = JSON.parse(r.out); method = j.loggedIn ? (j.authMethod || 'cli') : null; }
  } catch {}
  authCache = { at: Date.now(), method };
  return method;
}
orch.authMethod = claudeAuthMethod;
// Custom connections (DeepSeek, Kimi, GLM, OpenAI, …)
const { Providers, PRESETS } = require('./lib/providers');
const providers = new Providers(DATA, setup.secrets);
orch.resolveProvider = spec => providers.resolve(spec);

// ---- connectors (MCP servers) and plugins (Claude Code plugin format) ----
const { Connectors, CATALOG: CONNECTOR_CATALOG } = require('./lib/connectors');
const connectors = new Connectors(DATA, setup.secrets);
orch.connectors = connectors;
const { Plugins } = require('./lib/plugins');
const plugins = new Plugins(DATA, { store, skills, connectors });
orch.pluginSkills = () => plugins.all().filter(p => p.enabled && !p.subagents.length).flatMap(p => p.skills);
// ---- voice assistant: speech in/out, the brain, tasks ----
const llm = require('./lib/llm');
const { Tasks } = require('./lib/tasks');
const tasks = new Tasks(DATA, { onChange: list => broadcast({ type: 'tasks', tasks: list }) });
const { VoiceAssets } = require('./lib/voice/assets');
const voiceAssets = new VoiceAssets(DATA, { onProgress: () => broadcast({ type: 'voiceAssets', assets: voiceAssets.status() }) });
const { Speech } = require('./lib/voice/speech');
// OpenAI-compatible connection used for API speech (the first OpenAI connection that has a key)
// API speech: Google Gemini (preferred) or OpenAI — whichever has a key in AI Core (setting voiceApi: auto | gemini | openai)
const openaiTarget = () => { const p = providers.view().find(x => x.hasKey && /api\.openai\.com/.test(x.baseUrl)); return p ? { kind: 'openai', baseUrl: p.baseUrl, key: providers.key(p.id) } : null; };
const geminiTarget = () => { const s = store.settings(); const p = providers.view().find(x => x.hasKey && /generativelanguage\.googleapis\.com/.test(x.baseUrl)); return p ? { kind: 'gemini', key: providers.key(p.id), sttModel: s.voiceGeminiStt, ttsModel: s.voiceGeminiTts } : null; };
const voiceApiTarget = () => { const w = store.settings().voiceApi || 'auto'; if (w === 'openai') return openaiTarget(); if (w === 'gemini') return geminiTarget(); return geminiTarget() || openaiTarget(); };
const speech = new Speech({ assets: voiceAssets, apiTarget: voiceApiTarget });
const net = require('./lib/net');
const system = require('./lib/system');
const { Ollama } = require('./lib/ollama');
const ollama = new Ollama({ onProgress: (name, st) => broadcast({ type: 'ollamaPull', name, pull: st }) });
const llmDeps = () => ({ providers, anthropicKey: setup.secrets.get('anthropicApiKey'), ollamaBase: ollama.base });
// Voice connection mode: 'offline' never sends anything out; 'online' always uses online services;
// 'auto' uses them while the internet is reachable and switches to the local ones when it is not.
async function voiceOnline(s) {
  const mode = s.voiceMode || 'auto';
  if (mode === 'offline') return false;
  if (mode === 'online') return true;
  return net.online();
}
const offlineSpec = s => (s.voiceModelOffline ? 'ollama:' + s.voiceModelOffline : null);
const isLocalSpec = spec => /^ollama:/.test(spec || '') || (() => { const m = /^p:([a-z0-9-]+):/.exec(spec || ''); const p = m && providers.get(m[1]); return !!(p && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(p.baseUrl)); })();
// Any language model, for chat / voice / Telegram (starts Ollama when needed)
// "agent:<id>" = a standalone assistant agent: its instructions + its model (or the assistant's model)
function agentSpec(spec, system) {
  const m = /^agent:([\w-]{1,40})$/.exec(spec || '');
  if (!m) return { spec, system };
  const a = store.subagents().find(x => x.id === m[1]);
  if (!a) throw new Error('ایجنت پیدا نشد');
  const own = /^(claude-|p:|ollama:|chatgpt)/.test(a.model || '') ? a.model : (store.settings().voiceModel || 'claude-haiku-5-5');
  // the agent's own instructions lead; JARVIS's general chat persona is not added on top
  const extra = system && !/^You are JARVIS/.test(system) ? '\n\n' + system : '';
  return { spec: own, system: a.prompt + extra + '\n\n(Today: ' + new Date().toDateString() + '.)' };
}
const chatLLM = async opts => { const r = agentSpec(opts.spec, opts.system); if (/^ollama:/.test(r.spec || '')) await ollama.ensureRunning(); return llm.chat({ ...opts, spec: r.spec, system: r.system, deps: llmDeps() }); };
// Every model the panel can chat with: Claude, saved connections, local Ollama models.
// Models the user's ChatGPT account offers in Codex (Codex keeps this list in ~/.codex/models_cache.json)
const CODEX_NOTE = { sol: 'همه‌کاره', astra: 'قوی‌ترین', terra: 'متعادل', luna: 'سریع و ارزان' };
function codexModels() {
  let list = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    list = (j.models || []).filter(m => m && m.slug && m.visibility === 'list').map(m => { const k = Object.keys(CODEX_NOTE).find(x => m.slug.includes(x)); return { slug: m.slug, name: m.display_name || m.slug, note: (CODEX_NOTE[k] || '') + (/^gpt-5/.test(m.slug) ? ' · نسل قبل' : '') }; });
  } catch {}
  if (!list.length) { const d = agents.codexConfigModel(); list = [{ slug: d === 'codex' ? '' : d, name: 'ChatGPT', note: '' }]; }
  return list;
}
async function chatModels() {
  const viaKey = !!setup.secrets.get('anthropicApiKey');
  const out = require('./lib/models').CLAUDE.map(m => ({ spec: m.id, name: m.name, group: 'Claude', note: viaKey ? 'کلید API' : 'Claude Code', ok: true, local: false }));
  for (const p of providers.view()) for (const m of p.models) { const local = isLocalSpec('p:' + p.id + ':' + m); out.push({ spec: 'p:' + p.id + ':' + m, name: m, group: p.name, note: p.hasKey || local ? '' : 'کلید ندارد', ok: p.hasKey || local, local }); }
  // ChatGPT with the user's own ChatGPT sign-in, through the Codex CLI
  if (agents.CLIS.codex) for (const m of codexModels()) out.push({ spec: 'chatgpt:' + m.slug, name: m.name, group: 'ChatGPT (حساب شما)', note: m.note, ok: true, local: false });
  for (const a of store.subagents().filter(x => x.stage === 'assistant' && x.enabled)) out.push({ spec: 'agent:' + a.id, name: a.name, group: 'ایجنت‌های من', note: a.description.slice(0, 40), ok: true, local: false, agent: true });
  const ol = await ollama.status();
  for (const m of ol.models) out.push({ spec: 'ollama:' + m.name, name: m.name, group: 'Ollama (آفلاین)', note: (m.size / 1e9).toFixed(1) + ' GB', ok: true, local: true });
  return out;
}
// ---- workflows ----
const { Workflows, TEMPLATES: WF_TEMPLATES, TYPES: WF_TYPES, fromDescription } = require('./lib/workflows');
const wfAskMsgs = new Map(); // Telegram message id -> run id (answers to "ask me")
// run the coding team on a project and wait until it finishes
async function runTeam({ projectId, task, mode, signal }) {
  const proj = store.project(String(projectId || '')) || store.projects()[0];
  if (!proj) throw new Error('پروژه‌ای برای تیم ایجنت‌ها نیست');
  const text = String(task || '').trim(); if (!text) throw new Error('کار مشخص نشده');
  const m = ['team', 'smart', 'audit', 'plan'].includes(mode) ? mode : 'team';
  const chat = store.newChat(proj.id, ('⚙ ' + text).replace(/\s+/g, ' ').slice(0, 48));
  if (needsClaudeAccount(chat, m) && !(await claudeReady())) { store.deleteChat(chat.id); throw new Error('Claude هنوز وصل نیست'); }
  broadcast({ type: 'chat', chat: store.chatSummary(chat) });
  const onAbort = () => orch.stop(chat.id);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try { await orch.run(chat, proj, text, m, { autoApprove: true }); } finally { if (signal) signal.removeEventListener('abort', onAbort); }
  const c = store.chat(chat.id) || chat;
  const rep = [...c.messages].reverse().find(x => x.kind === 'report');
  const ok = ['done', 'unverified'].includes(c.status);
  return { ok, status: c.status, chatId: chat.id, report: rep ? `وضعیت: ${c.status}، ${(rep.report.files || []).length} فایل تغییر کرد${rep.report.openBugs ? '، ' + rep.report.openBugs + ' باگ باز' : ''}` : c.status };
}
const workflows = new Workflows(DATA, {
  chat: chatLLM, runTeam,
  addTask: b => tasks.add(b, 'workflow'),
  defaultModel: () => store.settings().voiceModel || 'claude-haiku-5-5',
  notify: async text => {
    const s = store.settings(), token = setup.secrets.get('notifyToken');
    broadcast({ type: 'wfNotify', text });
    if (s.notifyPhone && s.notifyChatId && token) await notify.call(s.notifyPhone, token, 'sendMessage', { chat_id: s.notifyChatId, text: String(text).slice(0, 3900) });
  },
  ask: async (run, p) => {
    broadcast({ type: 'wfAsk', run, pending: p });
    const s = store.settings(), token = setup.secrets.get('notifyToken');
    if (!(s.notifyPhone && s.notifyChatId && token)) return;
    const head = '🔀 ' + run.name + '\n\n' + p.question;
    const msg = p.kind === 'approve'
      ? await notify.call(s.notifyPhone, token, 'sendMessage', { chat_id: s.notifyChatId, text: head.slice(0, 3900), reply_markup: { inline_keyboard: [[{ text: '✅ بله', callback_data: 'wf:' + run.id + ':yes' }, { text: '❌ نه', callback_data: 'wf:' + run.id + ':no' }]] } })
      : await notify.call(s.notifyPhone, token, 'sendMessage', { chat_id: s.notifyChatId, text: (head + '\n\n↩️ جواب را به‌صورت «پاسخ» (Reply) به همین پیام بفرستید.').slice(0, 3900), reply_markup: { force_reply: true } });
    if (msg && msg.message_id) { wfAskMsgs.set(msg.message_id, run.id); if (wfAskMsgs.size > 200) wfAskMsgs.delete(wfAskMsgs.keys().next().value); }
  },
  onEvent: ev => broadcast(ev),
});
async function handleHook(req, res, url, id, key) {
  const w = workflows.get(id);
  const crypto = require('crypto');
  if (!w || !w.hookOn || !w.hookKey || w.hookKey.length !== key.length || !crypto.timingSafeEqual(Buffer.from(w.hookKey), Buffer.from(key))) return send(res, 404, { error: 'not found' });
  let input = url.searchParams.get('input') || '';
  if (req.method === 'POST') { const b = await readBody(req).catch(() => null); if (b && typeof b === 'object') input = typeof b.input === 'string' ? b.input : JSON.stringify(b); }
  const r = workflows.start(id, String(input).slice(0, 20000), { via: 'webhook' });
  if (url.searchParams.get('wait') !== '1') return send(res, 202, { ok: true, runId: r.id });
  const until = Date.now() + 120000;
  while (!['done', 'error', 'stopped', 'waiting'].includes(r.status) && Date.now() < until) await new Promise(x => setTimeout(x, 300));
  return send(res, 200, { ok: r.status === 'done', status: r.status, runId: r.id, output: String(r.ctx.last || ''), error: r.error || null });
}
// n8n: list workflows that start with a Webhook node (to pick one in the editor)
async function n8nWorkflows() {
  const s = store.settings(), base = String(s.n8nUrl || '').replace(/\/+$/, ''), key = setup.secrets.get('n8nApiKey');
  if (!base) throw new Error('آدرس n8n را وارد کنید');
  const r = await fetch(base + '/api/v1/workflows?limit=200', { headers: key ? { 'X-N8N-API-KEY': key } : {}, signal: AbortSignal.timeout(15000) });
  if (r.status === 401) throw new Error('کلید API n8n پذیرفته نشد (n8n ← Settings ← n8n API)');
  if (!r.ok) throw new Error('n8n جواب نداد: ' + r.status);
  const j = await r.json();
  return (j.data || []).map(w => {
    const hooks = (w.nodes || []).filter(n => /webhook$/i.test(n.type || '') && !/respond/i.test(n.type || ''));
    return { id: w.id, name: w.name, active: !!w.active, hooks: hooks.map(n => ({ name: n.name, method: (n.parameters && n.parameters.httpMethod) || 'GET', url: base + '/webhook/' + String((n.parameters && n.parameters.path) || n.webhookId || '').replace(/^\/+/, ''), testUrl: base + '/webhook-test/' + String((n.parameters && n.parameters.path) || n.webhookId || '').replace(/^\/+/, '') })) };
  });
}
setInterval(() => { try { workflows.tick(); } catch (e) { console.error('workflows', e.message); } }, 30000).unref();
const agentKit = require('./lib/agent-kit');
// ---- the members club (required when a club address is set) ----
const clubLib = require('./lib/club');
const club = new clubLib.Club({ dataDir: DATA, secrets: setup.secrets, settings: () => store.settings(), defaultUrl: ((require('./package.json').jarvis || {}).clubUrl) || '' });
const clubView = () => ({ ...club.state(), deploy: clubDeploy, cfLogin: clubLogin });
const clubBroadcast = () => broadcast({ type: 'club', club: clubView() });
setTimeout(() => club.refresh().then(clubBroadcast).catch(() => {}), 3000).unref();
setInterval(() => club.refresh().then(clubBroadcast).catch(() => {}), 6 * 36e5).unref();
let clubDeploy = null; // { running, log[], error, url }
let clubLogin = null;  // Cloudflare sign-in: { running, url, ok, error }
// tell the club about a license issued to a member (the seller must be signed in as the club admin)
async function clubLicense(sale, revoked) {
  if (!sale.memberEmail || !club.url() || !club.token()) return null;
  try {
    if (revoked != null) await club.call('PATCH', '/api/admin/licenses/' + sale.id, { revoked });
    else await club.call('POST', '/api/admin/licenses', { id: sale.id, email: sale.memberEmail, key: sale.key, code: sale.code, device: sale.device, updatesUntil: sale.updatesUntil });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
// ---- the Android app: a separate gateway on the home network (off by default) ----
const { Mobile } = require('./lib/mobile');
const mobile = new Mobile({ dataDir: DATA, handleApi: (req, res, url) => api(req, res, url), onChange: () => broadcast({ type: 'mobile', mobile: mobile.status() }) });
async function syncMobile() {
  const s = store.settings();
  if (s.mobileEnabled && !mobile.server) { try { await mobile.start(+s.mobilePort || 47780); } catch (e) { console.error('mobile gateway', e.message); try { await mobile.start(0); } catch {} } }
  else if (!s.mobileEnabled && mobile.server) mobile.stop();
  broadcast({ type: 'mobile', mobile: mobile.status() });
}
setTimeout(syncMobile, 1200);
// ---- selling the Android app: signing keys and the sales log (seller mode only) ----
const license = require('./lib/license');
const SALES_FILE = path.join(DATA, 'sales.json');
const readSales = () => { try { const v = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeSales = list => { fs.writeFileSync(SALES_FILE + '.tmp', JSON.stringify(list, null, 1)); fs.renameSync(SALES_FILE + '.tmp', SALES_FILE); };
// Publish the signed license list (short codes -> keys, revoked ids; no names) to a public GitHub repo
const ghRun = args => new Promise(resolve => require('child_process').execFile('gh', args, { windowsHide: true, timeout: 60000, maxBuffer: 4 << 20 }, (err, so, se) => resolve({ ok: !err, out: String(so || ''), err: String(se || (err && err.message) || '') })));
async function publishLicenses() {
  const s = store.settings(), repo = String(s.sellRepo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('نام مخزن GitHub را مثل username/jarvis-licenses وارد کنید');
  if (!agents.which('gh').length) throw new Error('GitHub CLI (gh) نصب نیست');
  const priv = setup.secrets.get('sellerPrivateKey'); if (!priv) throw new Error('کلید امضای فروش ساخته نشده');
  const sales = readSales();
  const list = license.signList(priv, { entries: sales.filter(x => x.codeHash && !x.revoked).map(x => ({ c: x.codeHash, k: x.key })), revoked: sales.filter(x => x.revoked).map(x => x.id) });
  // the repo: create it (public) the first time
  if (!(await ghRun(['repo', 'view', repo, '--json', 'name'])).ok) {
    const c = await ghRun(['repo', 'create', repo, '--public', '--description', 'JARVIS app activation list (signed; contains no personal data)']);
    if (!c.ok) throw new Error('ساخت مخزن نشد: ' + c.err.slice(0, 200));
  }
  const cur = await ghRun(['api', `repos/${repo}/contents/licenses.json`, '--jq', '.sha']);
  const args = ['api', '-X', 'PUT', `repos/${repo}/contents/licenses.json`, '-f', 'message=update licenses', '-f', 'content=' + Buffer.from(JSON.stringify(list, null, 1)).toString('base64')];
  if (cur.ok && cur.out.trim()) args.push('-f', 'sha=' + cur.out.trim());
  const r = await ghRun(args);
  if (!r.ok) throw new Error('انتشار در GitHub نشد: ' + r.err.slice(0, 200));
  return { ok: true, count: list.entries.length, revoked: list.revoked.length, url: `https://raw.githubusercontent.com/${repo}/main/licenses.json` };
}
function sellerView() {
  const s = store.settings(), sales = readSales();
  const year = Date.now() - 365 * 864e5;
  return { hasKeys: !!(s.sellerPublicKey && setup.secrets.get('sellerPrivateKey')), publicKey: s.sellerPublicKey || '', sales: sales.slice().reverse(),
    repo: s.sellRepo || '', listUrl: s.sellRepo ? `https://raw.githubusercontent.com/${s.sellRepo}/main/licenses.json` : '',
    totals: { count: sales.length, year: sales.filter(x => x.issuedAt > year).length, amount: sales.reduce((t, x) => t + (+x.amount || 0), 0) } };
}
const { Talks } = require('./lib/talks');
const talks = new Talks(DATA, { chat: chatLLM, onEvent: ev => broadcast(ev) });
// No internet + an online model chosen: answer with the offline model (mode "auto" only)
async function talkSpec(spec) {
  const s = store.settings();
  if (/^agent:/.test(spec) || isLocalSpec(spec) || s.voiceMode === 'online' || !s.voiceModelOffline) return spec;
  return (await net.online()) ? spec : 'ollama:' + s.voiceModelOffline;
}
const { Brain } = require('./lib/voice/brain');
// an NVIDIA card makes local speech recognition ~20x faster (checked once)
let _gpu;
function nvidiaGpu() {
  if (_gpu !== undefined) return _gpu;
  _gpu = null;
  if (process.platform === 'win32') require('child_process').execFile('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'], { windowsHide: true, timeout: 15000 }, (e, out) => { const n = String(out || '').split(/\r?\n/).find(l => /nvidia/i.test(l)); _gpu = n ? n.trim() : null; });
  return _gpu;
}
nvidiaGpu();
// local date-time with offset, e.g. 2026-11-15T08:02:46+03:30 (models turn "tomorrow 10am" into a date with it)
function localIso(d = new Date()) { const o = -d.getTimezoneOffset(), p = n => String(Math.floor(Math.abs(n))).padStart(2, '0'); return new Date(d.getTime() + o * 60000).toISOString().slice(0, 19) + (o >= 0 ? '+' : '-') + p(o / 60) + ':' + p(o % 60); }
const voiceContext = () => {
  const chats = [...store.chats.values()];
  const proj = id => (store.project(id) || {}).name || '?';
  const lastReport = c => { const m = [...c.messages].reverse().find(x => x.kind === 'report'); return m ? `${m.report.rounds || 0} rounds, ${(m.report.files || []).length} files changed${m.report.openBugs ? ', ' + m.report.openBugs + ' open bugs' : ''}` : ''; };
  return {
    now: new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }),
    nowIso: localIso(),
    projects: store.projects().map(p => ({ id: p.id, name: p.name })),
    running: [...orch.running.keys()].map(id => store.chat(id)).filter(Boolean).map(c => ({ id: c.id, title: c.title, project: proj(c.projectId), status: c.status })),
    recent: chats.filter(c => !orch.running.has(c.id) && c.messages.length && ['done', 'error', 'needs-attention', 'unverified', 'stopped', 'budget'].includes(c.status))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 3).map(c => ({ title: c.title, status: c.status, report: lastReport(c) })),
    tasks: tasks.today().slice(0, 25),
  };
};
const brain = new Brain({ chat: chatLLM, context: voiceContext });
// ---- Telegram / Bale assistant (two-way) ----
const { Media } = require('./lib/media');
const media = new Media(voiceAssets);
const { Bot } = require('./lib/bot');
const botBrain = new Brain({ chat: chatLLM, context: () => ({ ...voiceContext(), channel: 'telegram' }) });
const botLog = [];
// the brain's model: online when possible, the offline model when the internet is down (like voice)
async function brainAsk(b, text) {
  const s = store.settings();
  const on = await voiceOnline(s);
  const off = offlineSpec(s);
  let spec = on ? (s.voiceModel || 'claude-haiku-5-5') : off;
  if (!spec) throw new Error('اینترنت در دسترس نیست و مدل آفلاین انتخاب نشده (هسته‌ی هوش مصنوعی ← مدل آفلاین).');
  let r;
  try { r = await b.handle(text, { spec }); }
  catch (e) { if (!on || s.voiceMode === 'online' || !off || !net.isNetError(e)) throw e; net.markOffline(); spec = off; r = await b.handle(text, { spec }); }
  r.brain = { spec, offline: spec === off };
  return r;
}
const bot = new Bot({
  config: () => { const s = store.settings(); return { enabled: !!s.botEnabled, channel: s.notifyPhone, token: setup.secrets.get('notifyToken'), chatId: s.notifyChatId, voiceReply: s.botVoiceReply || 'auto' }; },
  call: (...x) => notify.call(...x), fileUrl: (...x) => notify.fileUrl(...x), media, // notify is defined further down
  ask: async text => { const r = await brainAsk(botBrain, text); const result = r.confirm ? null : await voiceAct(r.action); return { ...r, result }; },
  confirm: async yes => { const a = botBrain.confirm(yes); return { action: a, result: a ? await voiceAct(a) : null }; },
  reset: () => botBrain.reset(),
  taskAction,
  onCallback: async data => { const m = /^wf:([\w-]+):(yes|no)$/.exec(data); if (!m) return null; try { workflows.answer(m[1], m[2] === 'yes'); return m[2] === 'yes' ? '✅ تأیید شد؛ ورک‌فلو ادامه می‌دهد.' : '❌ رد شد.'; } catch (e) { return '⚠️ ' + e.message; } },
  onReply: async (msgId, text) => { const id = wfAskMsgs.get(msgId); if (!id) return null; try { workflows.answer(id, text); wfAskMsgs.delete(msgId); return '👍 جواب ثبت شد؛ ورک‌فلو ادامه می‌دهد.'; } catch (e) { return '⚠️ ' + e.message; } },
  status: async () => {
    const run = [...orch.running.keys()].map(id => store.chat(id)).filter(Boolean);
    const q = taskQueue.all().filter(j => j.status === 'pending').length;
    return (run.length ? '🟢 در حال کار:\n' + run.map(c => '• ' + c.title + ' — ' + ((store.project(c.projectId) || {}).name || '')).join('\n') : '⚪ الان هیچ ایجنتی کار نمی‌کند.') + (q ? '\n\n⏳ ' + q + ' کار در صف.' : '') + '\n\n🌐 ' + ((await net.online()) ? 'آنلاین' : 'آفلاین');
  },
  tasks: async () => { const t = tasks.today(); return t.length ? '📋 تسک‌های امروز:\n' + t.map(x => '• ' + x.title + (x.due ? ' — ' + new Date(x.due).toLocaleString('fa-IR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '') + (x.priority === 'high' ? ' ❗' : '')).join('\n') : 'برای امروز تسکی نیست.'; },
  stopAll: async () => { const ids = [...orch.running.keys()]; for (const id of ids) orch.stop(id); return ids.length; },
  transcribe: async wav => { const s = store.settings(); return speech.transcribe(wav, { engine: s.voiceStt, offline: !(await voiceOnline(s)), lang: s.voiceLang }); },
  speak: async text => { const s = store.settings(); return speech.speak(text, { engine: s.voiceTts, offline: !(await voiceOnline(s)), prefs: { faVoice: s.voiceFaVoice, apiVoice: s.voiceApiVoice, geminiVoice: s.voiceGeminiVoice } }); },
  onLog: e => { botLog.push(e); if (botLog.length > 200) botLog.splice(0, botLog.length - 200); broadcast({ type: 'botLog', entry: e }); },
});
function syncBot() { const c = bot.d.config(); if (c.enabled && c.token && c.chatId && c.channel) { if (!bot.running) bot.start(); } else if (bot.running) bot.stop(); }
setTimeout(syncBot, 1500);

// ---- reminders: the panel (toast + spoken), Windows notification, and Telegram/Bale with buttons ----
const remindKeyboard = t => ({ inline_keyboard: [[{ text: '✅ انجام شد', callback_data: 'done:' + t.id }, { text: '⏰ ۱۰ دقیقه بعد', callback_data: 'snz:' + t.id + ':10' }, { text: '۱ ساعت بعد', callback_data: 'snz:' + t.id + ':60' }]] });
function reminderText(t) {
  const at = t.due ? new Date(t.due) : null;
  const soon = at && at.getTime() - Date.now() > 60000 ? ' — ' + at.toLocaleString('fa-IR', { weekday: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  return 'یادآوری: ' + t.title + soon;
}
function fireReminder(t) {
  tasks.markReminded(t.id);
  const text = reminderText(t);
  broadcast({ type: 'reminder', task: t, text, speak: store.settings().remindSpeak !== false });
  const s = store.settings(), token = setup.secrets.get('notifyToken');
  if (s.remindPhone !== false && s.notifyPhone && s.notifyChatId && token) notify.call(s.notifyPhone, token, 'sendMessage', { chat_id: s.notifyChatId, text: '⏰ ' + text, reply_markup: remindKeyboard(t) }).catch(e => console.error('reminder', e.message));
}
setInterval(() => { try { for (const t of tasks.dueReminders()) fireReminder(t); } catch (e) { console.error('reminders', e.message); } }, 15000).unref();
// "done" / "later" from a reminder (panel or Telegram)
function taskAction(kind, id, arg) {
  const t = tasks.get(id); if (!t) return 'این تسک دیگر وجود ندارد.';
  if (kind === 'done') { const r = tasks.complete(id); return r.done ? '✅ انجام شد: ' + t.title : '✅ انجام شد. دفعه‌ی بعد: ' + new Date(r.due).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }); }
  if (kind === 'snz') { tasks.snooze(id, +arg || 10); return '⏰ ' + (+arg >= 60 ? (+arg / 60).toLocaleString('fa-IR') + ' ساعت' : (+arg || 10).toLocaleString('fa-IR') + ' دقیقه') + ' دیگر یادآوری می‌کنم: ' + t.title; }
  return '';
}
const voiceLog = [];
const findByName = (list, name, key = 'name') => { const n = String(name || '').trim().toLowerCase(); if (!n) return null; return list.find(x => String(x[key]).toLowerCase() === n) || list.find(x => String(x[key]).toLowerCase().includes(n) || n.includes(String(x[key]).toLowerCase())) || null; };
// Carry out the action the brain chose. Returns what happened (shown and spoken by the panel).
async function voiceAct(a) {
  if (!a) return null;
  const p = a.params || {};
  if (a.type === 'run_team') {
    const proj = findByName(store.projects(), p.project);
    if (!proj) return { ok: false, error: 'پروژه پیدا نشد: ' + (p.project || '') };
    const text = String(p.task || '').trim();
    if (!text) return { ok: false, error: 'کار مشخص نشد' };
    const mode = ['team', 'smart', 'audit', 'plan'].includes(p.mode) ? p.mode : 'team';
    const chat = store.newChat(proj.id, text.replace(/\s+/g, ' ').slice(0, 48));
    if (needsClaudeAccount(chat, mode) && !(await claudeReady())) { store.deleteChat(chat.id); return { ok: false, error: 'Claude هنوز وصل نیست' }; }
    broadcast({ type: 'chat', chat: store.chatSummary(chat) });
    orch.run(chat, proj, text, mode).catch(e => console.error('voice run', e));
    return { ok: true, chatId: chat.id, projectId: proj.id };
  }
  if (a.type === 'stop') {
    const running = [...orch.running.keys()].map(id => store.chat(id)).filter(Boolean);
    const target = p.chat ? [findByName(running, p.chat, 'title')].filter(Boolean) : running;
    for (const c of target) orch.stop(c.id);
    return { ok: true, stopped: target.length };
  }
  if (a.type === 'add_task') { const d = p.due ? Date.parse(p.due) : NaN; const t = tasks.add({ title: p.title, due: Number.isFinite(d) ? new Date(d).toISOString() : null, priority: p.priority, category: p.category, repeat: p.repeat, remindBefore: p.remindBefore }, 'voice'); return { ok: true, task: t }; }
  if (a.type === 'complete_task') { const t = tasks.get(String(p.id || '')); if (!t) return { ok: false, error: 'تسک پیدا نشد' }; tasks.complete(t.id); return { ok: true, task: t }; }
  if (a.type === 'open') return { ok: true, open: { section: String(p.section || 'home'), chat: p.chat ? (findByName([...store.chats.values()], p.chat, 'title') || {}).id || null : null } };
  return null;
}

const extState = () => ({ connectors: connectors.view(), plugins: plugins.all(), pluginCommands: plugins.commands() });
const extChanged = () => { broadcast({ type: 'ext', ...extState() }); broadcast({ type: 'subagents', subagents: store.subagents() }); broadcast({ type: 'skills', skills: skills.all() }); };

// ---- phone notifications (Bale / Telegram bot) when a run finishes ----
const notify = require('./lib/notify');
const STATUS_FA = { done: '✅ تمام شد', error: '❌ خطا', stopped: '⏹ متوقف شد', budget: '💰 سقف هزینه', 'needs-attention': '⚠️ نیاز به بررسی', unverified: '❔ تست‌نشده' };
orch.onFinish = (chat, final, info) => {
  const s = store.settings(chat.projectId);
  const token = setup.secrets.get('notifyToken');
  if (!s.notifyPhone || !token || !s.notifyChatId) return;
  if (s.notifyWhen === 'problems' && final === 'done') return;
  const min = Math.round((info.durationMs || 0) / 60000);
  const text = `${STATUS_FA[final] || final} — جارویس\n«${chat.title}»\nپروژه: ${info.project ? info.project.name : ''}\n⏱ ${min ? min + ' دقیقه' : 'کمتر از یک دقیقه'}${info.rounds ? ' · ' + info.rounds + ' دور' : ''}`;
  notify.send({ channel: s.notifyPhone, token, chatId: s.notifyChatId, text }).catch(e => console.error('notify', e.message));
};

// ---- full trial of a connection: a tiny real task as builder, then as reviewer ----
async function providerTrial(id, model) {
  const pv = providers.resolve(`p:${id}:${model}`);
  if (!pv || pv.missing) throw new Error('اتصال پیدا نشد');
  if (!pv.hasKey) throw new Error('اول کلید API این اتصال را ذخیره کنید');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jarvis-trial-'));
  const runOne = (prompt, write) => {
    const h = pv.engine === 'claude'
      ? agents.runClaude({ cwd: dir, prompt, model: pv.model, extraEnv: pv.env, permissionMode: write ? 'acceptEdits' : 'default', lean: true,
          tools: write ? ['Read', 'Write', 'Edit'] : ['Read', 'Glob'], allowedTools: write ? ['Read', 'Write', 'Edit'] : ['Read', 'Glob'], emit() {} })
      : agents.runCodex({ cwd: dir, prompt, model: pv.model, extraEnv: pv.env, configArgs: pv.configArgs, sandbox: write ? 'workspace-write' : 'read-only', emit() {} });
    const timer = setTimeout(() => h.kill(), 180000);
    return h.promise.finally(() => clearTimeout(timer));
  };
  const out = { engine: pv.engine };
  try {
    let t = Date.now();
    const b = await runOne('Create a file named hello.txt in the current folder whose entire content is exactly: hello from JARVIS\nThen reply with the single word DONE.', true);
    let content = null; try { content = fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8').trim(); } catch {}
    const bOk = b.ok && /hello from jarvis/i.test(content || '');
    out.builder = { ok: bOk, ms: Date.now() - t, error: bOk ? null : !b.ok ? String(b.error || 'خطا').slice(0, 400) : content === null ? 'مدل جواب داد ولی فایل را نساخت (ابزارها کار نکردند).' : 'فایل ساخته شد ولی محتوایش درست نبود.' };
    if (!fs.existsSync(path.join(dir, 'hello.txt'))) fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello from JARVIS\n');
    t = Date.now();
    const r = await runOne('Read the file hello.txt in the current folder. Reply ONLY with this JSON and nothing else: {"verdict":"pass","summary":"..."} if it contains the text "hello from JARVIS", otherwise {"verdict":"fail","summary":"..."}.', false);
    const v = (String(r.text || '').match(/"verdict"\s*:\s*"(pass|fail)"/) || [])[1];
    out.reviewer = { ok: r.ok && v === 'pass', ms: Date.now() - t, error: r.ok ? (v ? (v === 'pass' ? null : 'تستر نتیجه را اشتباه تشخیص داد.') : 'تستر جواب JSON نداد.') : String(r.error || 'خطا').slice(0, 400) };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  return out;
}
let claudeReadyCache = { at: 0, ok: false };
async function claudeReady() {
  if (Date.now() - claudeReadyCache.at < 60000) return claudeReadyCache.ok;
  claudeReadyCache = { at: Date.now(), ok: await setup.claudeReady() };
  return claudeReadyCache.ok;
}

const versions = { claude: null, codex: null };
setImmediate(() => {
  versions.claude = agents.version('claude');
  versions.codex = agents.version('codex');
  broadcast({ type: 'versions', versions });
});

// ---- attachments (images pasted into the composer) --------------------------
const ATTACH_DIR = path.join(DATA, 'attachments');
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const attachPath = (chatId, file) => /^[\w-]{8,64}$/.test(chatId) && /^[\w.-]{1,80}$/.test(file) && !file.includes('..') ? path.join(ATTACH_DIR, chatId, file) : null;

// ---- live preview of a project (its dev server) ------------------------------
const previews = new Map(); // projectId -> { child, url, log[] }
function previewState(id) { const p = previews.get(id); return p ? { running: true, url: p.url, log: p.log.slice(-40).join('') } : { running: false }; }
function stopPreview(id) {
  const p = previews.get(id);
  if (!p) return;
  previews.delete(id);
  try { if (process.platform === 'win32') require('child_process').execFile('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { windowsHide: true }, () => {}); else p.child.kill(); } catch {}
}
function startPreview(proj) {
  const s = store.settings(proj.id);
  if (!s.previewCommand) throw new Error('اول در «تنظیمات پروژه» دستور اجرای پیش‌نمایش را بنویسید (مثلاً npm run dev)');
  stopPreview(proj.id);
  const child = require('child_process').spawn(s.previewCommand, { cwd: proj.path, shell: true, windowsHide: true, env: { ...process.env, BROWSER: 'none' } });
  const p = { child, url: s.previewUrl || '', log: [] };
  const add = d => { p.log.push(String(d)); if (p.log.length > 200) p.log.splice(0, p.log.length - 200); if (!p.url) { const m = String(d).match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s'"\x1b]*/); if (m) { p.url = m[0]; broadcast({ type: 'preview', projectId: proj.id, ...previewState(proj.id) }); } } };
  child.stdout.on('data', add); child.stderr.on('data', add);
  child.on('exit', code => { if (previews.get(proj.id) === p) { previews.delete(proj.id); broadcast({ type: 'preview', projectId: proj.id, running: false, exitCode: code, log: p.log.slice(-40).join('') }); } });
  previews.set(proj.id, p);
  return previewState(proj.id);
}

// ---- scheduled audits (per project, "HH:MM" in the project settings) ---------
const schedDone = new Map(); // projectId -> day key
setInterval(async () => {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const day = now.toDateString();
  for (const p of store.projects()) {
    const at = p.settings && p.settings.scheduleAuditAt;
    if (!at || at !== hhmm || schedDone.get(p.id) === day) continue;
    schedDone.set(p.id, day);
    if (!fs.existsSync(p.path) || [...orch.running.keys()].some(id => store.chat(id)?.projectId === p.id)) continue;
    if (!(await claudeReady())) continue;
    const s = store.settings(p.id);
    const chat = store.newChat(p.id, `بازرسی خودکار — ${now.toLocaleDateString('fa-IR')}`);
    broadcast({ type: 'chat', chat: store.chatSummary(chat) });
    orch.run(chat, p, s.scheduleAuditPrompt, 'audit').catch(e => console.error('scheduled audit', e));
  }
}, 30000).unref();

// ---- task queue (overnight runs) ----
const { TaskQueue } = require('./lib/queue');
const taskQueue = new TaskQueue(DATA, {
  onChange: jobs => broadcast({ type: 'queueJobs', jobs }),
  runJob: async job => {
    const p = store.project(job.projectId);
    if (!p || !fs.existsSync(p.path)) throw new Error('پروژه پیدا نشد');
    const chat = store.newChat(p.id, '🌙 ' + job.text.replace(/\s+/g, ' ').slice(0, 44));
    broadcast({ type: 'chat', chat: store.chatSummary(chat) });
    await orch.run(chat, p, job.text, job.mode, { autoApprove: true }); // nobody is there to approve a plan at night
    const c = store.chat(chat.id);
    return { status: c ? c.status : 'done', chatId: chat.id };
  },
  onBatchDone: async jobs => {
    const s = store.settings();
    const token = setup.secrets.get('notifyToken');
    if (!s.notifyPhone || !token || !s.notifyChatId) return;
    const ok = jobs.filter(j => j.status === 'done').length;
    const lines = jobs.map(j => (STATUS_FA[j.status] || j.status) + ' — ' + j.text.replace(/\s+/g, ' ').slice(0, 60));
    await notify.send({ channel: s.notifyPhone, token, chatId: s.notifyChatId, text: '🌙 صف کارهای جارویس تمام شد: ' + ok + ' از ' + jobs.length + ' موفق\n\n' + lines.join('\n') });
  },
});

// Cost estimate for the next run in this mode: median of earlier finished runs, else a rough guess.
function estimateRun(chat, mode) {
  const costs = [];
  for (const c of store.chats.values()) for (const mm of c.messages) {
    const r = mm.kind === 'report' && mm.report;
    if (r && r.mode === mode && r.status === 'done' && r.claudeUsd > 0) costs.push(r.claudeUsd);
  }
  costs.sort((a, b) => a - b);
  if (costs.length >= 2) return { usd: +costs[Math.floor(costs.length / 2)].toFixed(3), basis: 'history', n: costs.length };
  const s = { ...store.settings(chat.projectId), ...Object.fromEntries(Object.entries(chat.models || {}).filter(([, v]) => v)) };
  const step = orch.stepCost(s.builderModel);
  const guess = { team: step * 2.5, smart: step * 2, audit: step * 2, plan: step * 2, claude: step, codex: 0 }[mode];
  return guess == null ? { usd: null } : { usd: +guess.toFixed(3), basis: 'guess' };
}

const cliPath = c => c ? (c.pre && c.pre.length ? c.pre[c.pre.length - 1] : c.cmd) : null;
// Does this run use the user's own Claude account? (Not when connections fill the roles.)
function needsClaudeAccount(chat, mode) {
  const s = { ...store.settings(chat.projectId), ...Object.fromEntries(Object.entries(chat.models || {}).filter(([, v]) => v)) };
  const own = spec => !/^p:/.test(spec || '');
  const builder = own(s.builderModel);
  const reviewerOnClaude = s.reviewer === 'claude' ? own(s.reviewerModel) : false;
  if (mode === 'codex') return reviewerOnClaude;
  return builder || reviewerOnClaude;
}
function tailFile(file, lines = 150) {
  try { const t = fs.readFileSync(file, 'utf8'); return t.split('\n').slice(-lines).join('\n'); } catch { return null; }
}
function npmLatest(pkg) {
  return new Promise(resolve => {
    require('child_process').exec(`npm view ${pkg} version`, { timeout: 20000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim()));
  });
}
function validMcp(v) {
  if (v === undefined || v === null || !String(v).trim()) return true;
  try { const j = JSON.parse(v); return j && typeof j === 'object' && j.mcpServers && typeof j.mcpServers === 'object'; } catch { return false; }
}

// ---- chat export (Markdown) -----------------------------------------------
const WHO = { user: 'شما', claude: 'Claude', codex: 'Codex', system: 'جارویس' };
function exportChat(chat, proj) {
  const L = [`# ${chat.title}`, '', `- پروژه: ${proj ? proj.name + ' (' + proj.path + ')' : '—'}`, `- تاریخ: ${new Date(chat.createdAt).toLocaleString('fa-IR')}`,
    `- هزینه‌ی Claude (معادل API): $${(chat.cost.claudeUsd || 0).toFixed(3)} · توکن Codex: ${chat.cost.codexTokens || 0}`, ''];
  for (const m of chat.messages) {
    const who = (WHO[m.agent] || m.agent) + (m.sub ? ' · ' + m.sub : '');
    const time = new Date(m.ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    if (m.kind === 'phase') L.push('', `## ${m.text}`, '');
    else if (m.kind === 'text') L.push(`**${who}** (${time}):`, '', m.text || '', '');
    else if (m.kind === 'tool_use') L.push(`> 🔧 ${who}: \`${m.name}\` ${String(m.input || '').replace(/\s+/g, ' ').slice(0, 160)}`);
    else if (m.kind === 'review' && m.review) {
      L.push('', `### نتیجه‌ی بررسی: ${m.review.verdict === 'pass' ? 'تأیید ✅' : 'رد ❌'}`, '', m.review.summary || '');
      for (const b of m.review.bugs || []) L.push(`- [${b.severity}] ${b.title}${b.file ? ' — ' + b.file + (b.line ? ':' + b.line : '') : ''}`);
      L.push('');
    } else if (m.kind === 'report' && m.report) L.push('', `### گزارش اجرا: ${m.report.status || ''}`, '');
    else if (m.kind === 'error') L.push(`> ⚠️ ${m.text}`, '');
    else if (m.kind === 'status' && m.text) L.push(`> ${m.text}`);
  }
  return L.join('\n') + '\n';
}

// ---- helpers ---------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };

function send(res, code, body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 8e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

// Candidate project folders from Claude Code's and Codex's own history.
function discover() {
  const out = new Map();
  const add = (p, src) => {
    if (!p) return;
    const n = path.resolve(p);
    if (/scratch-workspaces|\\system32$|\\Temp\\/i.test(n) || n.toLowerCase() === os.homedir().toLowerCase()) return;
    try { if (!fs.statSync(n).isDirectory()) return; } catch { return; } // missing/unreadable: skip, keep scanning
    const k = n.toLowerCase();
    if (!out.has(k)) out.set(k, { path: n, name: path.basename(n), sources: [] });
    if (!out.get(k).sources.includes(src)) out.get(k).sources.push(src);
  };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    for (const p of Object.keys(j.projects || {})) add(p, 'claude');
  } catch {}
  // Codex rollouts: ~/.codex/sessions/YYYY/MM/DD/*.jsonl; first line has cwd.
  try {
    const base = path.join(os.homedir(), '.codex', 'sessions');
    const files = [];
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
      }
    };
    walk(base, 0);
    for (const f of files.slice(-200)) {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = buf.slice(0, n).toString('utf8').match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) add(JSON.parse(`"${m[1]}"`), 'codex');
    }
  } catch {}
  const known = new Set(store.projects().map(p => p.path.toLowerCase()));
  return [...out.values()].filter(p => !known.has(p.path.toLowerCase()));
}

// ---- routes ----------------------------------------------------------------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const m = req.method;
  const body = m === 'POST' || m === 'PUT' || ((m === 'PATCH' || m === 'DELETE') && url.pathname.startsWith('/api/club/')) ? await readBody(req) : null;

  if (parts[0] === 'events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (parts[0] === 'state' && m === 'GET') {
    return send(res, 200, {
      projects: store.projects(), settings: store.settings(), defaults: store.defaults(), agents: orch.agentState, versions, subagents: store.subagents(), skills: skills.all(),
      clis: { claude: !!agents.CLIS.claude, codex: !!agents.CLIS.codex },
      codexDefaultModel: agents.codexConfigModel(),
      claudeAuth: await claudeAuthMethod(),
      tasks: tasks.all(), voiceAssets: voiceAssets.status(),
      providers: providers.view(), providerPresets: PRESETS, ...extState(), connectorCatalog: CONNECTOR_CATALOG, queueJobs: taskQueue.all(),
      modelCatalog: { claude: require('./lib/models').CLAUDE },
      running: [...orch.running.keys()],
      queues: Object.fromEntries([...orch.running].map(([id, r]) => [id, r.inbox.length])),
    });
  }
  if (parts[0] === 'settings' && m === 'POST') {
    if (!validMcp(body.mcpConfig)) return send(res, 400, { error: 'پیکربندی MCP باید JSON معتبر با کلید mcpServers باشد' });
    const wasOff = !store.settings().requireToken;
    const out = store.updateSettings(body);
    broadcast({ type: 'settings', settings: out });
    // The panel that turns the token on gets it, so it can keep talking to the server.
    return send(res, 200, wasOff && out.requireToken ? { ...out, token: TOKEN } : out);
  }

  if (parts[0] === 'providers') {
    const done = out => { broadcast({ type: 'providers', providers: providers.view() }); return send(res, 200, out); };
    try {
      if (!parts[1] && m === 'GET') return send(res, 200, providers.view());
      if (!parts[1] && m === 'POST') return done(providers.save(body || {}));
      if (parts[1] === 'models' && m === 'POST') return send(res, 200, { models: await providers.models(body || {}) });
      if (parts[1] === 'test' && m === 'POST') return send(res, 200, await providers.test(body || {}));
      if (parts[1] && parts[2] === 'trial' && m === 'POST') return send(res, 200, await providerTrial(parts[1], String(body.model || '')));
      if (parts[1] && !parts[2] && m === 'DELETE') { providers.remove(parts[1]); return done({ ok: true }); }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'notify') {
    try {
      if (!parts[1] && m === 'GET') { const s = store.settings(); return send(res, 200, { channel: s.notifyPhone, chatId: s.notifyChatId, when: s.notifyWhen, hasToken: !!setup.secrets.get('notifyToken') }); }
      if (!parts[1] && m === 'POST') {
        const channel = ['bale', 'telegram'].includes(body.channel) ? body.channel : '';
        if (typeof body.token === 'string' && body.token.trim()) { if (!notify.TOKEN_RE.test(body.token.trim())) throw new Error('توکن ربات معتبر نیست'); setup.secrets.set('notifyToken', body.token.trim()); }
        if (body.clearToken) setup.secrets.set('notifyToken', null);
        const out = store.updateSettings({ notifyPhone: channel, notifyChatId: String(body.chatId || '').trim().slice(0, 40), notifyWhen: body.when === 'problems' ? 'problems' : 'all' });
        broadcast({ type: 'settings', settings: out });
        bot.stop(); setTimeout(syncBot, 400);
        return send(res, 200, { ok: true });
      }
      const token = (typeof body?.token === 'string' && body.token.trim()) || setup.secrets.get('notifyToken');
      if (parts[1] === 'detect' && m === 'POST') { bot.stop(); try { return send(res, 200, await notify.detect({ channel: body.channel, token })); } finally { setTimeout(syncBot, 500); } }
      if (parts[1] === 'test' && m === 'POST') return send(res, 200, await notify.send({ channel: body.channel, token, chatId: body.chatId, text: '🤖 جارویس: پیام آزمایشی. از این به بعد پایان کارها اینجا خبر داده می‌شود.' }));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'bot') {
    try {
      if (!parts[1] && m === 'GET') return send(res, 200, { ...bot.status(), enabled: !!store.settings().botEnabled, voiceReply: store.settings().botVoiceReply, ffmpeg: media.ready(), log: botLog.slice(-40) });
      if (!parts[1] && m === 'POST') {
        const out = store.updateSettings({ ...(body.enabled !== undefined ? { botEnabled: !!body.enabled } : {}), ...(['auto', 'always', 'never'].includes(body.voiceReply) ? { botVoiceReply: body.voiceReply } : {}) });
        broadcast({ type: 'settings', settings: out });
        bot.stop(); setTimeout(syncBot, 400);
        return send(res, 200, { ok: true });
      }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'backup' && m === 'GET') return send(res, 200, store.backup());
  if (parts[0] === 'backup' && parts[1] === 'restore' && m === 'POST') {
    try { const n = store.restore(body.data); broadcast({ type: 'projects', projects: store.projects() }); return send(res, 200, { ok: true, ...n }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'diagnostics' && m === 'GET') {
    let st = null; try { st = await setup.status(); } catch (e) { st = { error: e.message }; }
    return send(res, 200, {
      desktop: DESKTOP, node: process.version, platform: `${process.platform} ${require('os').release()}`, dataDir: DATA,
      clis: { claude: cliPath(agents.CLIS.claude), codex: cliPath(agents.CLIS.codex), git: agents.which('git')[0] || null, gh: agents.which('gh')[0] || null, graphify: graph.graphifyBin() || null },
      versions, auth: await claudeAuthMethod(), setup: st, running: [...orch.running.keys()].length,
      log: process.env.JARVIS_LOG ? { file: process.env.JARVIS_LOG, tail: tailFile(process.env.JARVIS_LOG) } : null,
    });
  }

  if (parts[0] === 'usage' && m === 'GET') {
    const days = Math.min(365, Math.max(1, +url.searchParams.get('days') || 14));
    return send(res, 200, usage.summary({ days, projectId: url.searchParams.get('projectId') || null }));
  }
  if (parts[0] === 'graphify' && m === 'GET') return send(res, 200, { installed: !!graph.refresh() });

  // ---- account connection / first-run setup ----
  if (parts[0] === 'setup') {
    const changed = r => {
      claudeReadyCache.at = 0;
      versions.claude = agents.version('claude'); versions.codex = agents.version('codex');
      broadcast({ type: 'versions', versions });
      return send(res, 200, r);
    };
    try {
      if (parts[1] === 'status' && m === 'GET') return send(res, 200, { ...(await setup.status()), desktop: DESKTOP });
      if (parts[1] === 'claude-key' && m === 'POST') return changed(setup.setClaudeKey(body.key));
      if (parts[1] === 'codex-key' && m === 'POST') return changed(await setup.setCodexKey(body.key));
      if (parts[1] === 'login' && m === 'POST') return changed(setup.login(String(body.name)));
      if (parts[1] === 'logout' && m === 'POST') return changed(await setup.logout(String(body.name)));
      if (parts[1] === 'install' && m === 'POST') return send(res, 200, setup.install(String(body.name)));
      if (parts[1] === 'updates' && m === 'GET') {
        const [c, x] = await Promise.all([npmLatest('@anthropic-ai/claude-code'), npmLatest('@openai/codex')]);
        const cur = v => (String(v || '').match(/\d+\.\d+\.\d+/) || [null])[0];
        const newer = (a, b) => { if (!a || !b) return false; const p = s => s.split('.').map(Number); const [x1, y1] = [p(a), p(b)]; for (let i = 0; i < 3; i++) { if (x1[i] !== y1[i]) return x1[i] > y1[i]; } return false; };
        return send(res, 200, {
          claude: { current: cur(versions.claude), latest: c, update: newer(c, cur(versions.claude)) },
          codex: { current: cur(versions.codex), latest: x, update: newer(x, cur(versions.codex)) },
        });
      }
      if (parts[1] === 'update' && m === 'POST') return send(res, 200, setup.update(String(body.name)));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  // ---- skill library (attached to sub-agents) ----
  if (parts[0] === 'skills') {
    const changed = () => broadcast({ type: 'skills', skills: skills.all() });
    try {
      if (!parts[1] && m === 'GET') return send(res, 200, skills.all());
      if (parts[1] === 'installed' && m === 'GET') return send(res, 200, skills.discover(store.projects().map(p => p.path)));
      if (parts[1] === 'import' && m === 'POST') { const s = skills.importDir(body.dir); changed(); return send(res, 200, s); }
      if (!parts[1] && m === 'POST') { const s = skills.save(body); changed(); return send(res, 200, s); }
      if (parts[1] && m === 'GET') { const s = skills.get(parts[1]); return s ? send(res, 200, s) : send(res, 404, { error: 'اسکیل پیدا نشد' }); }
      if (parts[1] && m === 'DELETE') {
        skills.remove(parts[1]);
        // detach it from every sub-agent
        for (const a of store.subagents()) if ((a.skills || []).includes(parts[1])) store.saveSubagent({ ...a, skills: a.skills.filter(x => x !== parts[1]) });
        changed(); broadcast({ type: 'subagents', subagents: store.subagents() });
        return send(res, 200, { ok: true });
      }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  if (parts[0] === 'subagents') {
    const done = () => { broadcast({ type: 'subagents', subagents: store.subagents() }); };
    if (!parts[1] && m === 'GET') return send(res, 200, store.subagents());
    if (parts[1] === 'reset' && m === 'POST') { store.resetSubagents(); done(); return send(res, 200, store.subagents()); }
    if (!parts[1] && m === 'POST') {
      try { const a = store.saveSubagent(body); done(); return send(res, 200, a); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (parts[1] === 'templates' && m === 'GET') return send(res, 200, agentKit.TEMPLATES);
    if (parts[1] === 'import' && m === 'POST') {
      try { const list = agentKit.parseImport(body.text); const saved = []; for (const a of list) { let n = String(a.name || 'agent'), k = 2; while (store.subagents().some(x => x.name === n.toLowerCase())) n = a.name + '-' + k++; saved.push(store.saveSubagent({ ...a, name: n })); } done(); return send(res, 200, saved); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (parts[1] === 'improve' && m === 'POST') {
      try { const s = store.settings(); const spec = (await voiceOnline(s)) ? (s.voiceModel || 'claude-haiku-5-5') : offlineSpec(s); if (!spec) throw new Error('اینترنت نیست و مدل آفلاین انتخاب نشده'); return send(res, 200, { prompt: await agentKit.improvePrompt(chatLLM, spec, body || {}) }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    const ag = parts[1] && store.subagents().find(x => x.id === parts[1]);
    if (ag && parts[2] === 'export' && m === 'GET') return send(res, 200, { json: JSON.stringify((({ versions, ...x }) => x)(ag), null, 2), md: agentKit.toMarkdown(ag) });
    if (ag && parts[2] === 'restore' && m === 'POST') {
      try { const v = (ag.versions || [])[+body.index]; if (!v) throw new Error('نسخه پیدا نشد'); const { savedAt, ...old } = v; const a = store.saveSubagent({ ...old, id: ag.id }); done(); return send(res, 200, a); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (ag && parts[2] === 'test' && m === 'POST') {
      // a conversation test of the agent's instructions (no file access)
      const t0 = Date.now();
      try {
        const s = store.settings();
        const own = /^(claude-|p:|ollama:|chatgpt)/.test(ag.model || '') ? ag.model : (s.voiceModel || 'claude-haiku-5-5');
        const r = await chatLLM({ spec: String(body.model || '') || own, system: ag.prompt + '\n\n(Test run inside JARVIS: there is no file or tool access here. Follow your instructions exactly as in real use.)', messages: [{ role: 'user', content: String(body.text || '').slice(0, 8000) }], maxTokens: 1500, signal: AbortSignal.timeout(120000) });
        return send(res, 200, { ok: true, text: r.text, ms: Date.now() - t0, model: String(body.model || '') || own });
      } catch (e) { return send(res, 200, { ok: false, error: e.message, ms: Date.now() - t0 }); }
    }
    if (parts[1] && m === 'DELETE') { store.deleteSubagent(parts[1]); done(); return send(res, 200, { ok: true }); }
  }
  if (parts[0] === 'discover' && m === 'GET') return send(res, 200, discover());

  if (parts[0] === 'tasks') {
    try {
      if (!parts[1] && m === 'GET') return send(res, 200, tasks.all());
      if (!parts[1] && m === 'POST') return send(res, 200, tasks.add(body || {}, 'ui'));
      if (parts[1] && parts[2] === 'done' && m === 'POST') return send(res, 200, tasks.complete(parts[1]));
      if (parts[1] && parts[2] === 'snooze' && m === 'POST') return send(res, 200, tasks.snooze(parts[1], body.minutes));
      if (parts[1] && parts[2] === 'run' && m === 'POST') {
        // hand a work task to the coding team (same path as the voice action)
        const t = tasks.get(parts[1]); const proj = store.project(String(body.projectId || ''));
        if (!t || !proj) return send(res, 400, { error: !t ? 'تسک پیدا نشد' : 'پروژه را انتخاب کنید' });
        const r = await voiceAct({ type: 'run_team', params: { project: proj.name, task: t.title + (t.notes ? '\n\n' + t.notes : ''), mode: body.mode } });
        if (r && r.ok) tasks.update(t.id, { projectId: proj.id, notes: t.notes });
        if (r && r.ok) { const tt = tasks.get(t.id); tt.chatId = r.chatId; tasks._save(); }
        return send(res, r && r.ok ? 200 : 400, r && r.ok ? r : { error: (r && r.error) || 'شروع نشد' });
      }
      if (parts[1] && m === 'POST') return send(res, 200, tasks.update(parts[1], body || {}));
      if (parts[1] && m === 'DELETE') { tasks.remove(parts[1]); return send(res, 200, { ok: true }); }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // ---- plain chat (any model) and the model list for it ----
  if (parts[0] === 'llms' && m === 'GET') { try { return send(res, 200, await chatModels()); } catch (e) { return send(res, 400, { error: e.message }); } }
  if (parts[0] === 'llms' && parts[1] === 'test' && m === 'POST') {
    const t0 = Date.now();
    try { const r = await chatLLM({ spec: String(body.spec || ''), messages: [{ role: 'user', content: 'Reply with exactly: ok' }], maxTokens: 16, signal: AbortSignal.timeout(60000) }); return send(res, 200, { ok: true, ms: Date.now() - t0, text: String(r.text || '').slice(0, 80) }); }
    catch (e) { return send(res, 200, { ok: false, error: e.name === 'TimeoutError' ? 'جواب نداد (بیش از ۶۰ ثانیه)' : e.message }); }
  }
  if (parts[0] === 'talks') {
    try {
      const id = parts[1];
      if (!id && m === 'GET') return send(res, 200, url.searchParams.get('q') ? talks.search(url.searchParams.get('q')) : talks.all());
      if (!id && m === 'POST') { const t = talks.create(body || {}); broadcast({ type: 'talk', talk: talks.summary(t) }); return send(res, 200, t); }
      const t = talks.get(id);
      if (!t) return send(res, 404, { error: 'گفتگو پیدا نشد' });
      if (!parts[2] && m === 'GET') return send(res, 200, { ...t, running: talks.running.has(id) });
      if (!parts[2] && m === 'POST') { talks.update(id, body || {}); broadcast({ type: 'talk', talk: talks.summary(t) }); return send(res, 200, talks.summary(t)); }
      if (!parts[2] && m === 'DELETE') { talks.remove(id); broadcast({ type: 'talkRemoved', id }); return send(res, 200, { ok: true }); }
      if ((parts[2] === 'send' || parts[2] === 'regenerate') && m === 'POST') {
        // answer streams over the event channel; this request returns at once
        talks.send(id, { text: body.text, model: body.model, regenerate: parts[2] === 'regenerate', resolveSpec: talkSpec }).catch(e => broadcast({ type: 'talkDone', id, message: { role: 'assistant', error: e.message } }));
        return send(res, 200, { ok: true });
      }
      if (parts[2] === 'stop' && m === 'POST') { talks.stop(id); return send(res, 200, { ok: true }); }
      if (parts[2] === 'export' && m === 'GET') { res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(talks.markdown(id)); }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'mobile') {
    try {
      if (parts[1] === 'status' && m === 'GET') return send(res, 200, mobile.status());
      if (parts[1] === 'enable' && m === 'POST') { store.updateSettings({ mobileEnabled: !!body.on }); await syncMobile(); return send(res, 200, mobile.status()); }
      if (parts[1] === 'pair' && m === 'POST') return send(res, 200, mobile.startPairing());
      if (parts[1] === 'devices' && parts[2] && m === 'DELETE') { mobile.revoke(parts[2]); return send(res, 200, mobile.status()); }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'club') {
    try {
      if (!parts[1] && m === 'GET') return send(res, 200, clubView());
      if (parts[1] === 'login' && m === 'POST') { const st = await club.login(body); clubBroadcast(); return send(res, 200, st); }
      if (parts[1] === 'register' && m === 'POST') { const st = await club.register(body); clubBroadcast(); return send(res, 200, st); }
      if (parts[1] === 'logout' && m === 'POST') { const st = await club.logout(); clubBroadcast(); return send(res, 200, st); }
      if (parts[1] === 'refresh' && m === 'POST') { const st = await club.refresh(); clubBroadcast(); return send(res, 200, st); }
      if (parts[1] === 'address' && m === 'POST') {
        const u = String(body.url || '').trim().replace(/\/+$/, '');
        if (u && !/^https:\/\/[\w.-]+(:\d+)?$/.test(u)) throw new Error('آدرس باید مثل https://jarvis-club.example.workers.dev باشد');
        if (u) { const r = await fetch(u + '/api/health', { signal: AbortSignal.timeout(10000) }).then(x => x.json()).catch(() => ({})); if (r.name !== 'jarvis-club') throw new Error('این آدرس باشگاه جارویس نیست یا در دسترس نیست'); }
        store.updateSettings({ clubUrl: u }); clubBroadcast(); return send(res, 200, club.state());
      }
      if (parts[1] === 'cf-login' && m === 'POST') {
        if (!(clubLogin && clubLogin.running)) {
          clubLogin = { running: true, url: '', ok: false, error: '' };
          clubLib.login({ onUrl: u => { clubLogin.url = u; require('./lib/setup').openExternal(u); clubBroadcast(); } })
            .then(r => { clubLogin = { running: false, url: '', ok: r.ok, error: r.error }; })
            .catch(e => { clubLogin = { running: false, url: '', ok: false, error: e.message }; })
            .finally(clubBroadcast);
        }
        return send(res, 200, clubView());
      }
      if (parts[1] === 'cf-open' && m === 'POST') { if (clubLogin && clubLogin.url) require('./lib/setup').openExternal(clubLogin.url); return send(res, 200, { ok: !!(clubLogin && clubLogin.url) }); }
      if (parts[1] === 'deploy' && m === 'POST') {
        if (clubDeploy && clubDeploy.running) throw new Error('در حال راه‌اندازی است');
        clubDeploy = { running: true, log: [], error: '', url: '' };
        clubLib.deploy({ dataDir: DATA, adminEmail: body.adminEmail, log: l => { clubDeploy.log.push(l); clubBroadcast(); } })
          .then(r => { store.updateSettings({ clubUrl: r.url }); clubDeploy = { running: false, log: clubDeploy.log.concat('آماده شد: ' + r.url), error: '', url: r.url }; })
          .catch(e => { clubDeploy = { running: false, log: clubDeploy.log, error: e.message, needLogin: !!e.needLogin, url: '' }; })
          .finally(clubBroadcast);
        return send(res, 200, { ...club.state(), deploy: clubDeploy });
      }
      if (parts[1] === 'api' && parts.length > 2) {
        const p = '/' + parts.slice(1).map(encodeURIComponent).join('/') + (url.search || ''); // /api/club/api/x → club /api/x
        const d = await club.call(m, p, m === 'GET' || (m === 'DELETE' && !Object.keys(body || {}).length) ? undefined : body);
        if (p.startsWith('/api/me')) club.refresh().then(clubBroadcast).catch(() => {});
        return send(res, 200, d);
      }
    } catch (e) { const st = e.status === 401 ? 400 : e.status && e.status < 600 ? e.status : 400; if (e.status === 401) clubBroadcast(); return send(res, st, { error: e.message, offline: !!e.offline, relogin: e.status === 401 }); }
  }
  if (parts[0] === 'seller') {
    try {
      const s = store.settings();
      if (!parts[1] && m === 'GET') return send(res, 200, sellerView());
      if (parts[1] === 'keys' && m === 'POST') {
        if (s.sellerPublicKey && setup.secrets.get('sellerPrivateKey') && !body.force) throw new Error('کلید از قبل ساخته شده است. ساخت دوباره، همه‌ی لایسنس‌های قبلی را بی‌اعتبار می‌کند.');
        const k = license.generateKeys();
        setup.secrets.set('sellerPrivateKey', k.privateKey);
        store.updateSettings({ sellerPublicKey: k.publicKey });
        return send(res, 200, sellerView());
      }
      if (parts[1] === 'backup' && m === 'GET') {
        const priv = setup.secrets.get('sellerPrivateKey');
        if (!priv) throw new Error('کلیدی ساخته نشده');
        return send(res, 200, { kind: 'jarvis-seller-keys', v: 1, publicKey: s.sellerPublicKey, privateKey: priv, createdOn: new Date().toISOString() });
      }
      if (parts[1] === 'restore' && m === 'POST') {
        const pub = String(body.publicKey || ''), priv = String(body.privateKey || '');
        const t = license.issue({ privateKey: priv, device: 'AAAA-AAAA-AAAA' });
        if (!license.verify(t.key, pub, 'AAAA-AAAA-AAAA').ok) throw new Error('این دو کلید با هم جور نیستند');
        setup.secrets.set('sellerPrivateKey', priv); store.updateSettings({ sellerPublicKey: pub });
        return send(res, 200, sellerView());
      }
      if (parts[1] === 'issue' && m === 'POST') {
        const r = license.issue({ privateKey: setup.secrets.get('sellerPrivateKey'), device: body.device, buyer: '', updateMonths: body.updateMonths }); // names stay only in the local sales log
        const sales = readSales();
        const contact = String(body.contact || '').trim().slice(0, 80);
        const before = contact ? sales.filter(x => x.contact === contact && x.issuedAt > Date.now() - 365 * 864e5) : [];
        const code = license.shortCode();
        const sale = { id: r.payload.id, code, codeHash: license.codeHash(code), device: r.payload.d, buyer: String(body.buyer || '').trim().slice(0, 40), contact, amount: Math.max(0, +body.amount || 0), note: String(body.note || '').slice(0, 300),
          kind: body.kind === 'transfer' ? 'transfer' : 'sale', issuedAt: Date.now(), updatesUntil: r.payload.u * 864e5, key: r.key, memberEmail: String(body.memberEmail || '').trim().toLowerCase().slice(0, 120) };
        sales.push(sale); writeSales(sales);
        let published = null; if (s.sellRepo) { try { published = await publishLicenses(); } catch (e) { published = { ok: false, error: e.message }; } }
        const member = await clubLicense(sale);
        return send(res, 200, { ...sale, previousForContact: before.length, published, member });
      }
      if (parts[1] === 'verify' && m === 'POST') { const v = license.verify(body.key, s.sellerPublicKey, body.device || null); return send(res, 200, { ...v, message: v.ok ? 'معتبر است' : license.REASON_FA[v.reason] }); }
      if (parts[1] === 'publish' && m === 'POST') { if (typeof body.repo === 'string') store.updateSettings({ sellRepo: body.repo.trim() }); return send(res, 200, { ...(await publishLicenses()), view: sellerView() }); }
      if (parts[1] === 'revoke' && parts[2] && m === 'POST') {
        const sales = readSales(); const x = sales.find(y => y.id === parts[2]); if (!x) throw new Error('پیدا نشد');
        x.revoked = !body.undo; writeSales(sales); await clubLicense(x, x.revoked);
        let published = null; if (s.sellRepo) { try { published = await publishLicenses(); } catch (e) { published = { ok: false, error: e.message }; } }
        return send(res, 200, { view: sellerView(), published });
      }
      if (parts[1] === 'sales' && parts[2] && m === 'DELETE') { writeSales(readSales().filter(x => x.id !== parts[2])); return send(res, 200, sellerView()); }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // ---- workflows ----
  if (parts[0] === 'workflows') {
    try {
      const id = parts[1];
      if (!id && m === 'GET') return send(res, 200, { list: workflows.all(), templates: WF_TEMPLATES, types: WF_TYPES, waiting: workflows.waiting().map(r => workflows.view(r)) });
      if (!id && m === 'POST') { const w = workflows.save(body || {}); broadcast({ type: 'workflows' }); return send(res, 200, w); }
      if (id === 'n8n' && m === 'GET') return send(res, 200, { url: store.settings().n8nUrl || '', hasKey: !!setup.secrets.get('n8nApiKey'), list: store.settings().n8nUrl ? await n8nWorkflows().catch(e => ({ error: e.message })) : [] });
      if (id === 'n8n' && m === 'POST') {
        const u = String(body.url || '').trim().replace(/\/+$/, '');
        if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw new Error('آدرس n8n معتبر نیست');
        store.updateSettings({ n8nUrl: u });
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) setup.secrets.set('n8nApiKey', body.apiKey.trim().slice(0, 400));
        if (body.clearKey) setup.secrets.set('n8nApiKey', null);
        return send(res, 200, { ok: true, list: u ? await n8nWorkflows().catch(e => ({ error: e.message })) : [] });
      }
      if (id === 'generate' && m === 'POST') {
        const s = store.settings();
        const spec = String(body.model || '') || ((await voiceOnline(s)) ? (s.voiceModel || 'claude-haiku-5-5') : offlineSpec(s));
        if (!spec) throw new Error('اینترنت نیست و مدل آفلاین انتخاب نشده');
        return send(res, 200, await fromDescription(chatLLM, spec, String(body.text || ''), store.projects().map(p => ({ id: p.id, name: p.name }))));
      }
      if (id === 'runs' && parts[2] && m === 'GET') { const r = workflows.run(parts[2]); return r ? send(res, 200, workflows.view(r)) : send(res, 404, { error: 'اجرا پیدا نشد' }); }
      if (id === 'runs' && parts[2] && parts[3] && m === 'POST') {
        const act = parts[3];
        if (act === 'answer') return send(res, 200, workflows.answer(parts[2], body.value));
        if (act === 'pause') return send(res, 200, workflows.pause(parts[2]));
        if (act === 'resume') return send(res, 200, workflows.resume(parts[2]));
        if (act === 'stop') return send(res, 200, workflows.stop(parts[2]));
      }
      const w = workflows.get(id);
      if (!w) return send(res, 404, { error: 'ورک‌فلو پیدا نشد' });
      if (!parts[2] && m === 'GET') return send(res, 200, { ...w, hookUrl: `http://127.0.0.1:${PORT}/hook/${w.id}/${w.hookKey}`, runs: workflows.runsOf(id).map(r => workflows.view(r)) });
      if (parts[2] === 'hook-key' && m === 'POST') { w.hookKey = require('crypto').randomBytes(12).toString('hex'); workflows._save(); return send(res, 200, { hookUrl: `http://127.0.0.1:${PORT}/hook/${w.id}/${w.hookKey}` }); }
      if (!parts[2] && m === 'DELETE') { workflows.remove(id); broadcast({ type: 'workflows' }); return send(res, 200, { ok: true }); }
      if (parts[2] === 'run' && m === 'POST') return send(res, 200, workflows.view(workflows.start(id, body.input)));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // ---- Command Center: real system, network, weather, agents, models and tasks ----
  if (parts[0] === 'cc') {
    try {
      const s = store.settings();
      if (!parts[1] && m === 'GET') {
        let place = null; try { place = s.ccPlace ? JSON.parse(s.ccPlace) : null; } catch {}
        const [online, ms] = await Promise.all([net.online(), system.latency()]);
        const [weather, ol, claudeOk] = await Promise.all([online || place ? system.weather(place) : null, ollama.status(), claudeReady()]);
        const running = [...orch.running.keys()].map(id => store.chat(id)).filter(Boolean)
          .map(c => ({ id: c.id, title: c.title, status: c.status, project: (store.project(c.projectId) || {}).name || '', since: c.updatedAt || 0 }));
        return send(res, 200, {
          system: system.snapshot(),
          net: { online: ms != null ? true : online, latency: ms },
          weather, place,
          agents: { running, state: orch.agentState },
          llms: [
            { id: 'claude', name: 'Claude', ok: !!claudeOk, note: claudeOk ? 'وصل' : 'وصل نیست' },
            { id: 'codex', name: 'Codex', ok: !!agents.CLIS.codex, note: agents.CLIS.codex ? 'نصب است' : 'نصب نیست' },
            ...providers.view().map(p => ({ id: p.id, name: p.name, ok: !!p.hasKey, note: p.hasKey ? 'کلید دارد' : 'بدون کلید' })),
            { id: 'ollama', name: 'Ollama (آفلاین)', ok: ol.running && ol.models.length > 0, note: !ol.installed ? 'نصب نیست' : !ol.running ? 'اجرا نشده' : ol.models.length.toLocaleString('fa-IR') + ' مدل' },
          ],
          tasks: tasks.today().slice(0, 12),
          queue: taskQueue.all().filter(j => j.status === 'pending' || j.status === 'running').length,
          voice: { enabled: !!s.voiceEnabled, mode: s.voiceMode || 'auto' },
          clocks: s.ccClocks,
        });
      }
      if (parts[1] === 'geocode' && m === 'POST') return send(res, 200, await system.geocode(body.q));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'voice') {
    try {
      const s = store.settings();
      if (parts[1] === 'status' && m === 'GET') return send(res, 200, { mode: s.voiceMode || 'auto', online: s.voiceMode === 'offline' ? null : await net.online(), ollama: await ollama.status(), assets: voiceAssets.status(), stt: { local: speech.whisper.ready(), api: speech.apiStt.ready(), gpu: speech.whisper.gpu() }, nvidia: nvidiaGpu(), tts: { local: speech.piper.ready('fa'), api: speech.apiTts.ready() }, apiKind: (voiceApiTarget() || {}).kind || null, hasGemini: !!geminiTarget(), hasOpenai: !!openaiTarget(), log: voiceLog.slice(-60) });
      if (parts[1] === 'download' && m === 'POST') return send(res, 200, voiceAssets.download(String(body.id || '')));
      if (parts[1] === 'assets' && parts[2] && m === 'DELETE') { if (parts[2].startsWith('whisper')) speech.stop(); voiceAssets.remove(parts[2]); broadcast({ type: 'voiceAssets', assets: voiceAssets.status() }); return send(res, 200, { ok: true }); }
      // wake-word model files for the panel (only these three names)
      if (parts[1] === 'model' && m === 'GET') {
        const f = ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis.onnx'].includes(parts[2]) && voiceAssets.find('wakeword', parts[2]);
        if (!f) return send(res, 404, { error: 'مدل تشخیص «هی جارویس» دانلود نشده' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
        return fs.createReadStream(f).pipe(res);
      }
      if (parts[1] === 'stt' && m === 'POST') {
        let wav = Buffer.from(String(body.audio || ''), 'base64');
        if (body.format && body.format !== 'wav' && wav.length > 100) { if (!media.ready()) return send(res, 400, { error: 'برای صدای گوشی، FFmpeg را از تنظیمات صدا دانلود کنید' }); wav = await media.toWav16k(wav); }
        if (wav.length < 1000) return send(res, 400, { error: 'صدایی ضبط نشد' });
        // the panel's Persian wake-word check may only ever use the local engine
        const offline = body.engine === 'local' || !(await voiceOnline(s));
        return send(res, 200, await speech.transcribe(wav, { engine: body.engine === 'local' ? 'local' : s.voiceStt, offline, lang: ['fa', 'en'].includes(body.lang) ? body.lang : s.voiceLang }));
      }
      if (parts[1] === 'tts' && m === 'POST') {
        const r = await speech.speak(String(body.text || '').slice(0, 2000), { engine: s.voiceTts, offline: !(await voiceOnline(s)), prefs: { faVoice: s.voiceFaVoice, apiVoice: s.voiceApiVoice, geminiVoice: s.voiceGeminiVoice } });
        return send(res, 200, { audio: r.wav.toString('base64'), ms: r.ms, engine: r.engine });
      }
      if (parts[1] === 'ask' && m === 'POST') {
        const text = String(body.text || '').trim().slice(0, 2000);
        const on = await voiceOnline(s);
        const off = offlineSpec(s);
        let spec = on ? (s.voiceModel || 'claude-haiku-5-5') : off;
        if (!spec) throw new Error('اینترنت در دسترس نیست و مغز آفلاین انتخاب نشده. در تنظیمات صدا یک مدل Ollama انتخاب کنید.');
        let r;
        try { r = await brain.handle(text, { spec }); }
        catch (e) {
          // the online model could not be reached: answer with the offline one (not when the user chose "online only")
          if (!on || s.voiceMode === 'online' || !off || !net.isNetError(e)) throw e;
          net.markOffline(); spec = off; r = await brain.handle(text, { spec });
        }
        r.brain = { spec, offline: spec === off };
        const result = r.confirm ? null : await voiceAct(r.action);
        voiceLog.push({ ts: Date.now(), user: text, say: r.say, action: r.action, confirm: r.confirm, result });
        if (voiceLog.length > 200) voiceLog.splice(0, voiceLog.length - 200);
        return send(res, 200, { ...r, result });
      }
      if (parts[1] === 'confirm' && m === 'POST') {
        const a = brain.confirm(!!body.yes);
        const result = a ? await voiceAct(a) : null;
        voiceLog.push({ ts: Date.now(), user: body.yes ? '(تأیید)' : '(لغو)', say: '', action: a, result });
        return send(res, 200, { action: a, result });
      }
      if (parts[1] === 'reset' && m === 'POST') { brain.reset(); return send(res, 200, { ok: true }); }
      // offline brain (Ollama): start it, download a model (only on the user's click)
      if (parts[1] === 'ollama' && parts[2] === 'start' && m === 'POST') { await ollama.ensureRunning(); return send(res, 200, await ollama.status()); }
      if (parts[1] === 'ollama' && parts[2] === 'pull' && m === 'POST') return send(res, 200, ollama.pull(String(body.name || '')));
      if (parts[1] === 'warm' && m === 'POST') { const off = s.voiceModelOffline; if (off && s.voiceMode !== 'online') ollama.warm(off).catch(() => {}); return send(res, 200, { ok: true }); }
      if (parts[1] === 'net' && m === 'GET') return send(res, 200, { online: await net.online({ force: true }) });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'connectors') {
    try {
      if (!parts[1] && m === 'GET') return send(res, 200, connectors.view());
      if (!parts[1] && m === 'POST') { const c = connectors.save(body || {}); extChanged(); return send(res, 200, c); }
      if (parts[1] && parts[2] === 'test' && m === 'POST') return send(res, 200, await connectors.test(parts[1]));
      if (parts[1] && parts[2] === 'toggle' && m === 'POST') { connectors.setEnabled(parts[1], !!body.enabled); extChanged(); return send(res, 200, { ok: true }); }
      if (parts[1] && !parts[2] && m === 'DELETE') { connectors.remove(parts[1]); extChanged(); return send(res, 200, { ok: true }); }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'plugins') {
    try {
      if (!parts[1] && m === 'GET') return send(res, 200, plugins.all());
      if (parts[1] === 'discover' && m === 'GET') return send(res, 200, plugins.discover());
      if (parts[1] === 'install' && m === 'POST') {
        const r = body.dir ? plugins.installDir(String(body.dir)) : await plugins.installGit(String(body.url || ''), body.pick ? String(body.pick) : null);
        if (!r.marketplace) extChanged();
        return send(res, 200, r);
      }
      if (parts[1] && parts[2] === 'toggle' && m === 'POST') { plugins.setEnabled(parts[1], !!body.enabled); extChanged(); return send(res, 200, { ok: true }); }
      if (parts[1] && !parts[2] && m === 'DELETE') { plugins.remove(parts[1]); extChanged(); return send(res, 200, { ok: true }); }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'queue') {
    try {
      if (!parts[1] && m === 'GET') return send(res, 200, taskQueue.all());
      if (!parts[1] && m === 'POST') return send(res, 200, taskQueue.add(body || {}));
      if (parts[1] === 'clear' && m === 'POST') { taskQueue.clearFinished(); return send(res, 200, { ok: true }); }
      if (parts[1] && m === 'DELETE') { taskQueue.remove(parts[1]); return send(res, 200, { ok: true }); }
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  if (parts[0] === 'projects') {
    if (!parts[1] && m === 'POST') {
      if (!body.path || !fs.existsSync(body.path) || !fs.statSync(body.path).isDirectory()) return send(res, 400, { error: 'پوشه وجود ندارد' });
      const p = store.addProject(body);
      broadcast({ type: 'projects', projects: store.projects() });
      return send(res, 200, p);
    }
    const proj = store.project(parts[1]);
    if (!proj) return send(res, 404, { error: 'پروژه پیدا نشد' });
    if (!parts[2] && m === 'DELETE') {
      store.removeProject(proj.id);
      broadcast({ type: 'projects', projects: store.projects() });
      return send(res, 200, { ok: true });
    }
    if (parts[2] === 'settings') {
      if (m === 'GET') return send(res, 200, { settings: store.settings(proj.id), override: proj.settings || null });
      if (m === 'POST' && body.settings && !validMcp(body.settings.mcpConfig)) return send(res, 400, { error: 'پیکربندی MCP باید JSON معتبر با کلید mcpServers باشد' });
      if (m === 'POST') return send(res, 200, { settings: store.updateProjectSettings(proj.id, body.reset ? null : body.settings || {}), override: proj.settings || null });
    }
    if (parts[2] === 'graph') {
      if (parts[3] === 'view' && m === 'GET') {
        if (!graph.info(proj.path).exists) return send(res, 404, { error: 'گراف هنوز ساخته نشده' });
        return send(res, 200, graph.viewData(proj.path, Math.min(1500, +url.searchParams.get('limit') || 400)));
      }
      if (!parts[3] && m === 'GET') return send(res, 200, { installed: !!graph.graphifyBin(), ...graph.info(proj.path) });
      if (!parts[3] && m === 'POST') {
        if (!graph.graphifyBin()) return send(res, 400, { error: 'graphify نصب نیست' });
        return send(res, 200, await graph.update(proj.path));
      }
    }
    if (parts[2] === 'info') return send(res, 200, { ...(await git.info(proj.path)), exists: fs.existsSync(proj.path), testCommand: require('./lib/testrun').detect(proj.path) });
    if (parts[2] === 'diff') return send(res, 200, { diff: await git.diff(proj.path) });
    if (parts[2] === 'rules' && parts[3] === 'append' && m === 'POST') {
      const items = (Array.isArray(body.items) ? body.items : []).map(x => String(x).replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 20);
      if (!items.length) return send(res, 400, { error: 'چیزی انتخاب نشده' });
      const HEAD = '## آموخته‌های جارویس';
      for (const f of ['CLAUDE.md', 'AGENTS.md']) {
        const p = path.join(proj.path, f);
        let t = ''; try { t = fs.readFileSync(p, 'utf8'); } catch {}
        const add = items.filter(i => !t.includes(i)).map(i => '- ' + i);
        if (!add.length) continue;
        if (!t.includes(HEAD)) t = (t.trimEnd() ? t.trimEnd() + '\n\n' : '') + HEAD + '\n';
        t = t.trimEnd() + '\n' + add.join('\n') + '\n';
        fs.writeFileSync(p, t);
      }
      return send(res, 200, { ok: true, added: items.length });
    }
    if (parts[2] === 'rules') {
      const files = { claude: path.join(proj.path, 'CLAUDE.md'), agents: path.join(proj.path, 'AGENTS.md') };
      if (m === 'GET') {
        const rd = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
        return send(res, 200, { claude: rd(files.claude), agents: rd(files.agents) });
      }
      if (m === 'POST') {
        const f = files[body.which];
        if (!f) return send(res, 400, { error: 'فایل نامعتبر' });
        const text = String(body.text ?? '');
        if (text.length > 200000) return send(res, 400, { error: 'متن خیلی بلند است' });
        fs.writeFileSync(f, text);
        return send(res, 200, { ok: true });
      }
    }
    if (parts[2] === 'preview') {
      if (m === 'GET') return send(res, 200, previewState(proj.id));
      if (m === 'POST') {
        try {
          if (body.action === 'stop') { stopPreview(proj.id); return send(res, 200, { running: false }); }
          return send(res, 200, startPreview(proj));
        } catch (e) { return send(res, 400, { error: e.message }); }
      }
    }
    if (parts[2] === 'changes' && m === 'GET') {
      const file = url.searchParams.get('file');
      if (file) return send(res, 200, await git.fileDiff(proj.path, file));
      return send(res, 200, await git.changedFiles(proj.path));
    }
    if (parts[2] === 'revert-file' && m === 'POST') {
      if ([...orch.running.keys()].some(id => store.chat(id)?.projectId === proj.id)) return send(res, 409, { error: 'یک چت روی این پروژه در حال اجراست' });
      return send(res, 200, await git.revertFile(proj.path, String(body.file || '')));
    }
    if (parts[2] === 'restore' && m === 'POST') {
      if (orch.running.size && [...orch.running.keys()].some(id => store.chat(id)?.projectId === proj.id)) return send(res, 409, { error: 'یک چت روی این پروژه در حال اجراست' });
      return send(res, 200, await git.restore(proj.path, String(body.commit || ''), { deleteNewer: !!body.deleteNewer }));
    }
    if (parts[2] === 'agents-md' && m === 'POST') {
      // Share project instructions between the two agents: CLAUDE.md ⇄ AGENTS.md
      const c = path.join(proj.path, 'CLAUDE.md'), a = path.join(proj.path, 'AGENTS.md');
      const from = body.direction === 'toClaude' ? a : c, to = body.direction === 'toClaude' ? c : a;
      if (!fs.existsSync(from)) return send(res, 404, { error: `${path.basename(from)} وجود ندارد` });
      if (fs.existsSync(to) && !body.overwrite) return send(res, 409, { error: `${path.basename(to)} از قبل وجود دارد`, exists: true });
      fs.copyFileSync(from, to);
      return send(res, 200, { ok: true, wrote: path.basename(to) });
    }
  }

  if (parts[0] === 'chats') {
    if (!parts[1] && m === 'GET') return send(res, 200, store.listChats(url.searchParams.get('projectId')));
    if (parts[1] === 'search' && m === 'GET') return send(res, 200, store.searchChats(url.searchParams.get('q'), url.searchParams.get('projectId')));
    if (!parts[1] && m === 'POST') {
      if (!store.project(body.projectId)) return send(res, 400, { error: 'پروژه نامعتبر' });
      const c = store.newChat(body.projectId, body.title);
      broadcast({ type: 'chat', chat: store.chatSummary(c) });
      return send(res, 200, c);
    }
    const chat = store.chat(parts[1]);
    if (!chat) return send(res, 404, { error: 'چت پیدا نشد' });
    if (!parts[2] && m === 'GET') return send(res, 200, chat);
    if (parts[2] === 'export' && m === 'GET') {
      const md = exportChat(chat, store.project(chat.projectId));
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(md);
    }
    if (!parts[2] && m === 'DELETE') {
      orch.stop(chat.id);
      store.deleteChat(chat.id);
      broadcast({ type: 'chatDeleted', chatId: chat.id });
      return send(res, 200, { ok: true });
    }
    if (parts[2] === 'send' && m === 'POST') {
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'متن خالی است' });
      if (orch.isRunning(chat.id)) {
        // Mid-run message: queue it for Claude's next step.
        const m = orch.enqueue(chat, text);
        return send(res, 200, { ok: true, queued: !!m });
      }
      const proj = store.project(chat.projectId);
      if (!proj) return send(res, 400, { error: 'پروژه‌ی این چت حذف شده' });
      if (chat.messages.length === 0 && chat.title === 'چت جدید') chat.title = text.replace(/\s+/g, ' ').slice(0, 48);
      const mode = ['team', 'smart', 'audit', 'plan', 'claude', 'codex', 'compact', 'memory'].includes(body.mode) ? body.mode : 'team';
      if (body.models) store.setChatModels(chat, body.models);
      // Every mode except "codex only" needs Claude; say so up front instead of failing mid-run.
      if (needsClaudeAccount(chat, mode) && !(await claudeReady())) {
        return send(res, 409, { error: 'Claude هنوز وصل نیست — از «اتصال حساب‌ها» کلید API یا ورود را تنظیم کنید.', needSetup: true });
      }
      const att = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 8).map(f => attachPath(chat.id, String(f))).filter(f => f && fs.existsSync(f));
      orch.run(chat, proj, text, mode, att.length ? { attachments: att } : {}).catch(e => console.error(e));
      return send(res, 200, { ok: true });
    }
    if (parts[2] === 'stop' && m === 'POST') return send(res, 200, { ok: orch.stop(chat.id) });
    if (parts[2] === 'smart-approve' && m === 'POST') return send(res, 200, { ok: orch.approveSmart(chat.id, { models: Array.isArray(body.models) ? body.models.map(String) : null }) });
    if (parts[2] === 'estimate' && m === 'GET') return send(res, 200, estimateRun(chat, url.searchParams.get('mode') || 'team'));
    if (parts[2] === 'attach' && m === 'POST') {
      const ext = IMG_EXT[body.type];
      if (!ext) return send(res, 400, { error: 'فقط تصویر (png، jpg، gif، webp)' });
      const buf = Buffer.from(String(body.data || ''), 'base64');
      if (!buf.length || buf.length > 10 * 1024 * 1024) return send(res, 400, { error: 'تصویر خالی یا بزرگ‌تر از ۱۰ مگابایت است' });
      const file = `${Date.now()}-${require('crypto').randomBytes(3).toString('hex')}.${ext}`;
      fs.mkdirSync(path.join(ATTACH_DIR, chat.id), { recursive: true });
      fs.writeFileSync(path.join(ATTACH_DIR, chat.id, file), buf);
      return send(res, 200, { file });
    }
    if (parts[2] === 'attachment' && m === 'GET') {
      const f = attachPath(chat.id, String(url.searchParams.get('file') || ''));
      if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': ({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[path.extname(f).slice(1)] || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
      return fs.createReadStream(f).pipe(res);
    }
    if (parts[2] === 'retry' && m === 'POST') {
      if (orch.isRunning(chat.id)) return send(res, 409, { error: 'این گفتگو در حال اجراست' });
      const proj = store.project(chat.projectId);
      if (!proj) return send(res, 400, { error: 'پروژه‌ی این چت حذف شده' });
      const last = [...chat.messages].reverse().find(x => x.agent === 'user' && x.kind === 'text' && x.text);
      if (!last) return send(res, 400, { error: 'پیامی برای اجرای دوباره نیست' });
      if (needsClaudeAccount(chat, last.mode) && !(await claudeReady())) return send(res, 409, { error: 'Claude هنوز وصل نیست', needSetup: true });
      const att = (last.attachments || []).map(f => attachPath(chat.id, f)).filter(f => f && fs.existsSync(f));
      orch.run(chat, proj, last.text, last.mode || 'team', att.length ? { attachments: att } : {}).catch(e => console.error(e));
      return send(res, 200, { ok: true });
    }
    if (parts[2] === 'commit' && m === 'POST') {
      const proj = store.project(chat.projectId);
      if (!proj) return send(res, 400, { error: 'پروژه پیدا نشد' });
      if (orch.isRunning(chat.id)) return send(res, 409, { error: 'این گفتگو در حال اجراست' });
      const c = await git.commitAll(proj.path, String(body.message || `jarvis: ${chat.title}`).slice(0, 200));
      orch.post(chat, c.ok ? { agent: 'system', kind: 'status', text: c.nothing ? 'چیزی برای commit نبود.' : `✔ با تأیید شما commit شد: ${c.hash}` } : { agent: 'system', kind: 'error', text: `commit ناموفق بود:\n${c.err}` });
      store.saveChat(chat, true);
      return send(res, c.ok ? 200 : 400, c.ok ? c : { error: c.err });
    }
    if (parts[2] === 'pr' && m === 'POST') {
      const proj = store.project(chat.projectId);
      if (!proj) return send(res, 400, { error: 'پروژه پیدا نشد' });
      if (!agents.which('gh').length) return send(res, 400, { error: 'GitHub CLI (gh) نصب نیست؛ از cli.github.com نصب و با gh auth login وارد شوید.' });
      const branch = chat.branch || await git.currentBranch(proj.path);
      if (!branch || ['main', 'master'].includes(branch)) return send(res, 400, { error: 'روی شاخه‌ی اصلی هستید. «شاخه‌ی جدا برای هر گفتگو» را در تنظیمات گیت روشن کنید و دوباره اجرا کنید.' });
      const p = await git.push(proj.path, branch);
      if (!p.ok) return send(res, 400, { error: 'push ناموفق بود:\n' + p.err });
      const out = await new Promise(resolve => require('child_process').execFile('gh', ['pr', 'create', '--fill', '--head', branch], { cwd: proj.path, windowsHide: true, timeout: 60000 },
        (err, so, se) => resolve({ ok: !err, out: String(so || '').trim(), err: String(se || err || '').trim() })));
      const prUrl = (out.out.match(/https:\/\/\S+/) || [null])[0];
      orch.post(chat, out.ok ? { agent: 'system', kind: 'status', text: `🔀 Pull Request ساخته شد: ${prUrl || out.out}` } : { agent: 'system', kind: 'error', text: `ساخت PR ناموفق بود:\n${out.err}` });
      store.saveChat(chat, true);
      return send(res, out.ok ? 200 : 400, out.ok ? { ok: true, url: prUrl } : { error: out.err });
    }
    if (parts[2] === 'rename' && m === 'POST') {
      chat.title = String(body.title || chat.title).slice(0, 80);
      store.saveChat(chat, true);
      broadcast({ type: 'chat', chat: store.chatSummary(chat) });
      return send(res, 200, { ok: true });
    }
    if (parts[2] === 'models' && m === 'POST') {
      // Takes effect from the next run (a run in progress keeps its models).
      return send(res, 200, { models: store.setChatModels(chat, body.models || {}), running: orch.isRunning(chat.id) });
    }
    if (parts[2] === 'reset' && m === 'POST') {
      chat.claudeSession = chat.reviewerSession = chat.codexThread = null;
      for (const k of Object.keys(chat)) if (k.startsWith('sub_')) delete chat[k]; // sub-agent sessions/threads
      store.saveChat(chat, true);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'not found' });
}

async function handle(req, res) {
  // Block DNS-rebinding and cross-site requests: only our own origin may talk to us.
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, 'forbidden host');
  // /hook/<workflow id>/<key>: start a workflow from another program on this computer (n8n, scripts…)
  const url = new URL(req.url, `http://${host}`);
  { const hm = /^\/hook\/([\w-]{1,24})\/([a-f0-9]{24})$/.exec(url.pathname);
    if (hm && (req.method === 'POST' || req.method === 'GET')) return handleHook(req, res, url, hm[1], hm[2]); }
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.headers['x-jarvis'] !== '1') return send(res, 403, 'missing header');
    if (tokenRequired() && !tokenOk(req.headers['x-jarvis-token'] || url.searchParams.get('token'))) return send(res, 401, { error: 'token required' });
    return api(req, res, url);
  }
  let p;
  try { p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); }
  catch { return send(res, 400, 'bad request'); } // malformed %-escapes used to crash the server
  const file = path.normalize(path.join(PUBLIC, p));
  // Must be inside public/ itself (a plain prefix check would also accept "public2/...").
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// Any unexpected error answers 500 instead of taking the whole server down.
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    try { if (!res.headersSent) send(res, 500, { error: String(e && e.message || e) }); else res.end(); } catch {}
  });
});

let portRetried = false;
server.on('error', e => {
  // Desktop app: if the usual port is taken, fall back to any free port.
  if (DESKTOP && e.code === 'EADDRINUSE' && !portRetried) { portRetried = true; console.error(`port ${PORT} busy, using a free port`); server.listen(0, HOST); return; }
  if (e.code === 'EADDRINUSE') console.error(`\n  پورت ${PORT} اشغال است — احتمالاً جارویس از قبل در حال اجراست: http://localhost:${PORT}\n  (برای پورت دیگر: JARVIS_PORT=4778)\n`);
  else console.error(e);
  if (require.main === module) process.exit(1);
  rejectReady(e);
});
let resolveReady, rejectReady;
const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
server.listen(PORT, HOST, () => {
  PORT = server.address().port;
  resolveReady({ port: PORT, token: TOKEN, dataDir: DATA });
  // The desktop app passes the token to its own window; never write it to logs there.
  const panel = `http://localhost:${PORT}/` + (tokenRequired() && !DESKTOP ? `?token=${TOKEN}` : '');
  console.log(`\n  J.A.R.V.I.S  ·  AI coding team`);
  console.log(`  Panel:  ${panel}`);
  if (store.settings().requireToken) console.log(`  (access token is required — open the link above; token file: ${TOKEN_FILE})`);
  if (process.env.JARVIS_OPEN === '1') {
    if (process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', panel], () => {});
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [panel], () => {});
  }
  console.log(`  Claude: ${agents.CLIS.claude ? agents.CLIS.claude.cmd : 'NOT FOUND'}`);
  console.log(`  Codex:  ${agents.CLIS.codex ? (agents.CLIS.codex.pre[0] || agents.CLIS.codex.cmd) : 'NOT FOUND'}\n`);
});

// Stop all running agents and flush chats to disk.
function stopAll() {
  for (const id of [...orch.running.keys()]) orch.stop(id);
  for (const id of [...previews.keys()]) stopPreview(id);
  speech.stop(); // the resident whisper server
  for (const id of [...talks.running.keys()]) talks.stop(id);
  try { mobile.stop(); } catch {}
  for (const id of [...workflows.live.keys()]) { try { workflows.pause(id); } catch {} }
  bot.stop();
  talks.flush();
  store.flush();
}
if (require.main === module) {
  const shutdown = () => { stopAll(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Used by the desktop app (desktop/main.js): await ready -> { port, token, dataDir }.
module.exports = { ready, stopAll, isBusy: () => orch.running.size > 0, settings: () => store.settings() };
