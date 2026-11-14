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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function send(res, code, body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 2e6) { reject(new Error('body too large')); req.destroy(); } });
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
  const body = m === 'POST' || m === 'PUT' ? await readBody(req) : null;

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
      providers: providers.view(), providerPresets: PRESETS,
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
      if (parts[1] && !parts[2] && m === 'DELETE') { providers.remove(parts[1]); return done({ ok: true }); }
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
    if (parts[1] && m === 'DELETE') { store.deleteSubagent(parts[1]); done(); return send(res, 200, { ok: true }); }
  }
  if (parts[0] === 'discover' && m === 'GET') return send(res, 200, discover());

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
    if (parts[2] === 'info') return send(res, 200, { ...(await git.info(proj.path)), exists: fs.existsSync(proj.path) });
    if (parts[2] === 'diff') return send(res, 200, { diff: await git.diff(proj.path) });
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
      const mode = ['team', 'audit', 'plan', 'claude', 'codex'].includes(body.mode) ? body.mode : 'team';
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
  const url = new URL(req.url, `http://${host}`);
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
  store.flush();
}
if (require.main === module) {
  const shutdown = () => { stopAll(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Used by the desktop app (desktop/main.js): await ready -> { port, token, dataDir }.
module.exports = { ready, stopAll, isBusy: () => orch.running.size > 0, settings: () => store.settings() };
