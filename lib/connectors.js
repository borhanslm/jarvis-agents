// Connectors: MCP servers that JARVIS gives to its agents (like connectors in Claude Code).
//
// Each connector is a local program (stdio) or a remote URL (streamable HTTP). It can be
// handed to the builder, the main tester and/or the review sub-agents — on any engine:
//   Claude Code engine -> a temporary --mcp-config JSON file
//   Codex engine       -> -c mcp_servers.<name>.* overrides
// Secret values (API keys, tokens) live in the encrypted secret store, never in connectors.json.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

// Ready-made connectors. secrets: env vars (stdio) or headers (http) the user must fill in.
const CATALOG = [
  { key: 'playwright', name: 'Playwright', icon: '🌐', desc: 'مرورگر واقعی: باز کردن صفحه، کلیک، اسکرین‌شات — عالی برای تستر وب', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'], roles: { builder: false, reviewer: true, subs: true } },
  { key: 'context7', name: 'Context7', icon: '📚', desc: 'مستندات به‌روز کتابخانه‌ها و فریم‌ورک‌ها برای نوشتن کد درست', type: 'http', url: 'https://mcp.context7.com/mcp', roles: { builder: true, reviewer: false, subs: false } },
  { key: 'github', name: 'GitHub', icon: '🐙', desc: 'Issueها، Pull Requestها و کد مخزن‌های GitHub', type: 'http', url: 'https://api.githubcopilot.com/mcp/', secrets: [{ name: 'Authorization', label: 'توکن GitHub (با Bearer یا بدون آن)', bearer: true }], link: 'https://github.com/settings/tokens', roles: { builder: true, reviewer: true, subs: false } },
  { key: 'memory', name: 'Memory', icon: '🧠', desc: 'حافظه‌ی گرافی ماندگار بین اجراها', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], roles: { builder: true, reviewer: false, subs: false } },
  { key: 'thinking', name: 'Sequential Thinking', icon: '🧩', desc: 'فکر کردن مرحله‌به‌مرحله برای مسئله‌های سخت', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], roles: { builder: true, reviewer: false, subs: false } },
  { key: 'postgres', name: 'PostgreSQL', icon: '🐘', desc: 'خواندن ساختار و داده‌ی پایگاه‌داده (فقط خواندنی)', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '${DATABASE_URL}'], secrets: [{ name: 'DATABASE_URL', label: 'آدرس اتصال (postgresql://…)' }], roles: { builder: true, reviewer: true, subs: true } },
  { key: 'brave', name: 'Brave Search', icon: '🔎', desc: 'جستجوی وب', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], secrets: [{ name: 'BRAVE_API_KEY', label: 'کلید Brave Search API' }], link: 'https://brave.com/search/api/', roles: { builder: true, reviewer: false, subs: false } },
];

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// How to start a connector's program without a shell. On Windows npx/npm are .cmd shims;
// running them through "cmd /c" lets & | < > in arguments act as commands, so npx/npm run
// their JS entry with node instead, and other commands are looked up as real .exe files.
const launchCache = new Map();
function which(cmd) {
  try { return require('child_process').execFileSync('where', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split(/\r?\n/).map(s => s.trim()).filter(Boolean); } catch { return []; }
}
function launch(command, args) {
  if (!IS_WIN || /[\\/]/.test(command) || path.extname(command)) return { command, args };
  const key = command.toLowerCase();
  if (!launchCache.has(key)) {
    let r = null;
    const hits = which(command);
    const exe = hits.find(h => h.toLowerCase().endsWith('.exe'));
    if (exe) r = { command: exe, pre: [] };
    else if (key === 'npx' || key === 'npm') {
      const node = which('node').find(h => h.toLowerCase().endsWith('.exe'));
      const cli = node && [path.join(path.dirname(node), 'node_modules', 'npm', 'bin', key + '-cli.js'), ...hits.map(h => path.join(path.dirname(h), 'node_modules', 'npm', 'bin', key + '-cli.js'))].find(f => fs.existsSync(f));
      if (node && cli) r = { command: node, pre: [cli] };
    }
    launchCache.set(key, r);
  }
  const r = launchCache.get(key);
  if (r) return { command: r.command, args: [...r.pre, ...args] };
  // last resort: cmd /c with every cmd metacharacter escaped
  const safe = a => /[\s"]/.test(a) ? a : a.replace(/([&|<>^()%!])/g, '^$1');
  return { command: 'cmd', args: ['/c', command, ...args.map(safe)] };
}
const slug = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const toml = v => JSON.stringify(v); // JSON strings/arrays of strings are valid TOML values

class Connectors {
  constructor(dataDir, secrets) {
    this.file = path.join(dataDir, 'connectors.json');
    this.tmpDir = path.join(dataDir, 'tmp');
    this.secrets = secrets;
    try { this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.list = []; }
    // temp MCP configs left by a crash may hold secrets
    try { for (const f of fs.readdirSync(this.tmpDir)) if (/^mcp-.*\.json$/.test(f)) fs.rmSync(path.join(this.tmpDir, f), { force: true }); } catch {}
  }
  _save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.list, null, 2)); fs.renameSync(this.file + '.tmp', this.file); }
  get(id) { return this.list.find(c => c.id === id) || null; }
  _secret(id, name) { return this.secrets.get(`connector:${id}:${name}`); }

  view() {
    return this.list.map(c => ({ ...c, secrets: (c.secrets || []).map(s => ({ ...s, set: !!this._secret(c.id, s.name) })) }));
  }

  // body: { id?, name, type, command, args, url, secrets:[{name,label,bearer}], values:{NAME: value}, roles, enabled, catalog?, plugin? }
  save(b) {
    const old = b.id ? this.get(b.id) : null;
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw new Error('نام اتصال‌دهنده لازم است');
    const type = b.type === 'http' ? 'http' : 'stdio';
    const c = { id: old ? old.id : (slug(b.key || name) || 'mcp'), name, icon: String(b.icon || '🔌').slice(0, 4), desc: String(b.desc || '').slice(0, 300), type, enabled: b.enabled !== false,
      roles: { builder: !!(b.roles || {}).builder, reviewer: !!(b.roles || {}).reviewer, subs: !!(b.roles || {}).subs }, catalog: b.catalog || (old && old.catalog) || null, plugin: b.plugin || (old && old.plugin) || null, link: /^https:\/\//.test(b.link || '') ? b.link : undefined };
    if (!old) { let base = c.id, i = 2; while (this.get(c.id)) c.id = `${base}-${i++}`; }
    if (!NAME_RE.test(c.id)) throw new Error('شناسه‌ی اتصال‌دهنده نامعتبر است');
    if (type === 'stdio') {
      c.command = String(b.command || '').trim();
      if (!c.command || /[\r\n]/.test(c.command) || c.command.length > 300) throw new Error('فرمان اجرای اتصال‌دهنده لازم است (مثلاً npx)');
      const args = Array.isArray(b.args) ? b.args : String(b.args || '').split(/\r?\n/);
      c.args = args.map(a => String(a).trim()).filter(Boolean).slice(0, 40).map(a => a.slice(0, 500));
    } else {
      let u; try { u = new URL(String(b.url || '').trim()); } catch { throw new Error('آدرس اتصال‌دهنده معتبر نیست'); }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('آدرس باید https باشد (http فقط برای localhost)');
      c.url = u.toString();
    }
    const tplMap = o => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k]) => /^[A-Za-z_][\w-]{0,79}$/.test(k)).slice(0, 30).map(([k, v]) => [k, String(v ?? '').slice(0, 2000)]));
    const tp = tplMap(type === 'http' ? b.headers : b.env);
    if (Object.keys(tp).length) c[type === 'http' ? 'headers' : 'env'] = tp;
    else if (old && old[type === 'http' ? 'headers' : 'env'] && b[type === 'http' ? 'headers' : 'env'] === undefined) c[type === 'http' ? 'headers' : 'env'] = old[type === 'http' ? 'headers' : 'env'];
    c.secrets = (Array.isArray(b.secrets) ? b.secrets : []).slice(0, 10).map(s => ({ name: String(s.name || '').trim().slice(0, 80), label: String(s.label || s.name || '').slice(0, 120), bearer: !!s.bearer }))
      .filter(s => /^[A-Za-z_][\w-]{0,79}$/.test(s.name));
    for (const [k, v] of Object.entries(b.values || {})) {
      if (!c.secrets.some(s => s.name === k)) continue;
      if (typeof v === 'string' && v.trim()) this.secrets.set(`connector:${c.id}:${k}`, v.trim());
    }
    if (old) Object.keys(old).forEach(k => { if (!(k in c)) delete old[k]; });
    if (old) Object.assign(old, c); else this.list.push(c);
    this._save();
    return this.view().find(x => x.id === c.id);
  }

  setEnabled(id, on) { const c = this.get(id); if (c) { c.enabled = !!on; this._save(); } return c; }
  remove(id) {
    const c = this.get(id);
    if (!c) return;
    for (const s of c.secrets || []) this.secrets.set(`connector:${id}:${s.name}`, null);
    this.list = this.list.filter(x => x.id !== id);
    this._save();
  }
  removeByPlugin(pluginId) { for (const c of this.list.filter(x => x.plugin === pluginId)) this.remove(c.id); }

  // The runnable definition, with secrets filled in. Missing secrets -> null (skipped).
  resolved(c) {
    const vals = {};
    for (const s of c.secrets || []) {
      const v = this._secret(c.id, s.name);
      if (!v) return null;
      vals[s.name] = s.bearer && !/^bearer\s/i.test(v) ? `Bearer ${v}` : v;
    }
    const sub = x => String(x).replace(/\$\{([A-Za-z_]\w*)\}/g, (m, k) => vals[k] != null ? vals[k] : m);
    // A secret that no template mentions is passed under its own name (env var / header).
    const tpl = c.type === 'http' ? (c.headers || {}) : (c.env || {});
    const used = new Set(); const scan = v => String(v).replace(/\$\{([A-Za-z_]\w*)\}/g, (m, k) => { used.add(k); return m; });
    [c.url, ...(c.args || []), ...Object.values(tpl)].forEach(v => v != null && scan(v));
    const filled = {};
    for (const [k, v] of Object.entries(tpl)) filled[k] = sub(v);
    for (const s of c.secrets || []) if (!used.has(s.name) && !(s.name in filled)) filled[s.name] = vals[s.name];
    if (c.type === 'http') return { name: c.id, label: c.name, type: 'http', url: sub(c.url), headers: filled };
    const run = launch(c.command, (c.args || []).map(sub));
    return { name: c.id, label: c.name, type: 'stdio', command: run.command, args: run.args, env: filled };
  }

  // role: builder | reviewer | subs
  forRole(role) {
    return this.list.filter(c => c.enabled && c.roles && c.roles[role]).map(c => this.resolved(c)).filter(Boolean);
  }

  // A raw {"mcpServers": {...}} config (project settings) in the resolved form, for Codex.
  fromConfig(cfg) {
    return Object.entries((cfg && cfg.mcpServers) || {}).filter(([n, d]) => /^[\w-]{1,40}$/.test(n) && d && typeof d === 'object').map(([n, d]) => d.url
      ? { name: n, type: 'http', url: String(d.url), headers: { ...(d.headers || {}) } }
      : { name: n, type: 'stdio', command: String(d.command || ''), args: (d.args || []).map(String), env: { ...(d.env || {}) } }).filter(r => r.url || r.command);
  }

  // Claude Code: {"mcpServers": {...}} (merged with an optional project config)
  claudeConfig(list, extra) {
    const servers = { ...((extra && extra.mcpServers) || {}) };
    for (const r of list) {
      servers[r.name] = r.type === 'http' ? { type: 'http', url: r.url, ...(Object.keys(r.headers).length ? { headers: r.headers } : {}) }
        : { command: r.command, args: r.args, ...(Object.keys(r.env).length ? { env: r.env } : {}) };
    }
    return Object.keys(servers).length ? { mcpServers: servers } : null;
  }
  // Write a private temp config file; the caller deletes it after the run.
  writeClaudeConfig(cfg) {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const f = path.join(this.tmpDir, `mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(f, JSON.stringify(cfg), { mode: 0o600 });
    return f;
  }

  // Codex: -c overrides (TOML values)
  codexArgs(list) {
    const out = [];
    for (const r of list) {
      const k = `mcp_servers.${r.name}`;
      if (r.type === 'http') {
        out.push(`${k}.url=${toml(r.url)}`);
        if (Object.keys(r.headers).length) out.push(`${k}.http_headers={ ${Object.entries(r.headers).map(([h, v]) => `${toml(h)} = ${toml(v)}`).join(', ')} }`);
      } else {
        out.push(`${k}.command=${toml(r.command)}`, `${k}.args=${toml(r.args)}`);
        if (Object.keys(r.env).length) out.push(`${k}.env={ ${Object.entries(r.env).map(([h, v]) => `${toml(h)} = ${toml(v)}`).join(', ')} }`);
      }
    }
    return out;
  }

  // Start the server, do the MCP handshake and list its tools.
  async test(id, { timeoutMs = 60000 } = {}) {
    const c = this.get(id);
    if (!c) throw new Error('اتصال‌دهنده پیدا نشد');
    const r = this.resolved(c);
    if (!r) throw new Error('اول مقدارهای لازم (کلید/توکن) را وارد کنید');
    const t0 = Date.now();
    const tools = r.type === 'http' ? await httpTools(r, timeoutMs) : await stdioTools(r, timeoutMs);
    return { ok: true, tools, ms: Date.now() - t0 };
  }
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jarvis', version: '1' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

function stdioTools(r, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(r.command, r.args, { env: { ...process.env, ...r.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '', done = false;
    const finish = (e, v) => {
      if (done) return; done = true; clearTimeout(timer);
      try { if (IS_WIN) require('child_process').execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); else child.kill(); } catch {}
      e ? reject(e) : resolve(v);
    };
    const timer = setTimeout(() => finish(new Error('اتصال‌دهنده در زمان مقرر جواب نداد' + (err ? ':\n' + err.slice(-600) : ''))), timeoutMs);
    const write = m => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch {} };
    child.on('error', e => finish(new Error('اجرا نشد: ' + e.message)));
    child.on('close', code => finish(new Error(`اتصال‌دهنده بسته شد (کد ${code})` + (err ? ':\n' + err.slice(-600) : ''))));
    child.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish(new Error(m.error.message || 'initialize failed'));
          write({ jsonrpc: '2.0', method: 'notifications/initialized' }); write(LIST);
        } else if (m.id === 2) {
          if (m.error) return finish(new Error(m.error.message || 'tools/list failed'));
          finish(null, ((m.result && m.result.tools) || []).map(t => t.name));
        }
      }
    });
    write(INIT);
  });
}

async function httpTools(r, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const call = async (msg, sid) => {
    const res = await fetch(r.url, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...r.headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(msg) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    let body = null;
    if (/event-stream/.test(res.headers.get('content-type') || '')) {
      for (const l of text.split(/\r?\n/)) if (l.startsWith('data:')) { try { const j = JSON.parse(l.slice(5)); if (j.id === msg.id) body = j; } catch {} }
    } else if (text.trim()) body = JSON.parse(text);
    return { body, sid: res.headers.get('mcp-session-id') || sid };
  };
  try {
    const a = await call(INIT);
    if (a.body && a.body.error) throw new Error(a.body.error.message);
    await fetch(r.url, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...r.headers, ...(a.sid ? { 'mcp-session-id': a.sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).then(x => x.text()).catch(() => {});
    const b = await call(LIST, a.sid);
    if (!b.body || b.body.error) throw new Error((b.body && b.body.error && b.body.error.message) || 'جواب tools/list خالی بود');
    return (b.body.result.tools || []).map(t => t.name);
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'اتصال‌دهنده در زمان مقرر جواب نداد' : e.message);
  } finally { clearTimeout(timer); }
}

module.exports = { Connectors, CATALOG };
