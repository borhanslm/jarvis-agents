// Plugins in the Claude Code plugin format, installed into JARVIS.
//
// A plugin is a folder with .claude-plugin/plugin.json and any of:
//   agents/*.md        -> JARVIS sub-agents (they join the agent team)
//   skills/*/SKILL.md  -> skill library (attached to the plugin's sub-agents)
//   commands/*.md      -> quick prompts above the message box
//   .mcp.json          -> connectors (MCP servers)
// Sources: a local folder, a git repository (also a marketplace repo with
// .claude-plugin/marketplace.json listing several plugins), or plugins already
// installed in Claude Code (~/.claude/plugins).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_BYTES = 30 * 1024 * 1024, MAX_FILES = 3000;
const slug = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function frontMatter(text) {
  const m = String(text).match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ''); }
  return { meta, body: (m ? m[2] : String(text)).trim() };
}

function copyDir(src, dst) {
  let bytes = 0, files = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules') continue;
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) { walk(sp, dp); continue; }
      if (!e.isFile()) continue;
      bytes += fs.statSync(sp).size; files++;
      if (bytes > MAX_BYTES || files > MAX_FILES) throw new Error('این پلاگین بزرگ‌تر از حد مجاز است (۳۰ مگابایت / ۳۰۰۰ فایل)');
      fs.copyFileSync(sp, dp);
    }
  };
  walk(src, dst);
}

const gitClone = (url, dir, ref) => new Promise((resolve, reject) => {
  const branch = ref && !/^[0-9a-f]{40}$/i.test(ref) && /^[\w./-]{1,100}$/.test(ref) ? ['--branch', ref] : [];
  execFile('git', ['clone', '--depth', '1', '--quiet', ...branch, url, dir], { timeout: 180000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out, se) => err ? reject(new Error('دریافت مخزن ناموفق بود: ' + String(se || err.message).trim().slice(-400))) : resolve());
});

function validGitUrl(u) {
  const s = String(u || '').trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}.git`; // owner/repo
  let x; try { x = new URL(s); } catch { return null; }
  return x.protocol === 'https:' ? x.toString() : null;
}

// Where a review-type agent belongs: reviewing/testing agents run next to the main tester.
const REVIEW_RE = /\b(review|reviewer|audit|auditor|security|test(er|ing)?|qa|lint|check(er)?|analy[sz]e|inspect)\b/i;

class Plugins {
  constructor(dataDir, { store, skills, connectors }) {
    this.dir = path.join(dataDir, 'plugins');
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexFile = path.join(this.dir, 'index.json');
    this.store = store; this.skills = skills; this.connectors = connectors;
    this.list = readJson(this.indexFile) || [];
  }
  _save() { fs.writeFileSync(this.indexFile, JSON.stringify(this.list, null, 2)); }
  all() { return this.list; }
  get(id) { return this.list.find(p => p.id === id) || null; }

  // Quick prompts contributed by enabled plugins: [{ title, text, plugin }]
  commands() {
    return this.list.filter(p => p.enabled).flatMap(p => (p.commands || []).map(c => ({ title: '/' + c.name, text: c.text, plugin: p.name })));
  }

  // Read a plugin folder without installing it.
  inspect(dir) {
    const meta = readJson(path.join(dir, '.claude-plugin', 'plugin.json')) || readJson(path.join(dir, 'plugin.json'));
    const name = slug((meta && meta.name) || path.basename(dir));
    if (!name) throw new Error('نام پلاگین پیدا نشد');
    const agentsDir = path.join(dir, 'agents'), skillsDir = path.join(dir, 'skills'), cmdDir = path.join(dir, 'commands');
    const md = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.md')); } catch { return []; } };
    const agents = md(agentsDir).map(f => ({ file: path.join(agentsDir, f), ...frontMatter(fs.readFileSync(path.join(agentsDir, f), 'utf8')), fname: f.replace(/\.md$/, '') }));
    let skills = []; try { skills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))).map(e => path.join(skillsDir, e.name)); } catch {}
    const commands = md(cmdDir).map(f => { const fm = frontMatter(fs.readFileSync(path.join(cmdDir, f), 'utf8')); return { name: f.replace(/\.md$/, ''), text: fm.body.replace(/\$ARGUMENTS/g, '').trim().slice(0, 4000), description: fm.meta.description || '' }; }).filter(c => c.text);
    const mcp = readJson(path.join(dir, '.mcp.json'));
    const servers = (mcp && (mcp.mcpServers || mcp)) || {};
    if (!meta && !agents.length && !skills.length && !commands.length && !Object.keys(servers).length) throw new Error('این پوشه پلاگین نیست (نه .claude-plugin/plugin.json دارد، نه agents/skills/commands)');
    return { name, description: String((meta && meta.description) || '').slice(0, 400), version: String((meta && meta.version) || ''), agents, skills, commands, servers };
  }

  async _install(srcDir, source) {
    const info = this.inspect(srcDir);
    const existing = this.list.find(p => p.name === info.name);
    if (existing) this.remove(existing.id);
    const id = info.name.slice(0, 30) + '-' + crypto.randomUUID().slice(0, 4);
    const dst = path.join(this.dir, id);
    copyDir(srcDir, dst);
    const local = this.inspect(dst);
    const rec = { id, name: info.name, description: info.description, version: info.version, source, enabled: true, installedAt: Date.now(), subagents: [], skills: [], connectors: [], commands: local.commands, needs: [] };
    try {
      for (const s of local.skills) { const k = this.skills.importDir(s); k.plugin = id; rec.skills.push(k.id); }
      if (rec.skills.length) this.skills._save();
      const taken = new Set(this.store.subagents().map(a => a.name));
      for (const a of local.agents) {
        let n = slug(a.meta.name || a.fname); if (!n || !a.body) continue;
        if (taken.has(n)) n = slug(`${info.name}-${n}`);
        if (taken.has(n)) continue;
        taken.add(n);
        const desc = a.meta.description || '';
        const sa = this.store.saveSubagent({ name: n, icon: '🧩', stage: REVIEW_RE.test(`${n} ${desc}`) ? 'review' : 'builder', enabled: true, model: '',
          description: desc.slice(0, 300), prompt: a.body.slice(0, 8000), skills: rec.skills, plugin: id });
        rec.subagents.push(sa.id);
      }
      for (const [name, def] of Object.entries(local.servers)) {
        if (!def || typeof def !== 'object') continue;
        const vars = new Set();
        const scan = v => String(v || '').replace(/\$\{([A-Za-z_]\w*)\}/g, (m, k) => { vars.add(k); return m; });
        const isHttp = !!def.url;
        if (isHttp) { scan(def.url); for (const v of Object.values(def.headers || {})) scan(v); }
        else { for (const a of def.args || []) scan(a); for (const v of Object.values(def.env || {})) scan(v); }
        // ${CLAUDE_PLUGIN_ROOT} points at the installed plugin folder.
        const root = v => String(v).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, dst.replace(/\\/g, '/'));
        vars.delete('CLAUDE_PLUGIN_ROOT');
        const secrets = [...vars].map(k => ({ name: k, label: k }));
        // http headers with ${VAR}: the header gets the variable's value
        const hdrSecrets = isHttp ? Object.entries(def.headers || {}).map(([h, v]) => ({ h, v: String(v) })) : [];
        const c = this.connectors.save({ key: slug(`${info.name}-${name}`), name: `${name} (${info.name})`, icon: '🧩', desc: `از پلاگین ${info.name}`, plugin: id,
          type: isHttp ? 'http' : 'stdio', command: root(def.command || ''), args: (def.args || []).map(root), url: isHttp ? root(def.url) : undefined,
          secrets: isHttp ? hdrSecrets.filter(x => /\$\{/.test(x.v)).map(x => ({ name: x.h, label: x.v })) : secrets,
          roles: { builder: true, reviewer: true, subs: true }, enabled: !secrets.length && !hdrSecrets.some(x => /\$\{/.test(x.v)) });
        rec.connectors.push(c.id);
        if (!c.enabled) rec.needs.push(c.id);
      }
    } catch (e) { this.list.push(rec); this.remove(id); throw e; }
    this.list.push(rec);
    this._save();
    return rec;
  }

  installDir(dir) {
    const src = path.resolve(String(dir || ''));
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('پوشه پیدا نشد');
    return this._install(src, { type: 'dir', path: src });
  }

  // git repo: a single plugin, or a marketplace -> { marketplace: true, plugins: [...] } unless `pick` names one.
  async installGit(url, pick) {
    const u = validGitUrl(url);
    if (!u) throw new Error('آدرس مخزن باید https باشد یا به شکل owner/repo');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plugin-'));
    try {
      await gitClone(u, path.join(tmp, 'repo'));
      const repo = path.join(tmp, 'repo');
      const mk = readJson(path.join(repo, '.claude-plugin', 'marketplace.json'));
      if (mk && Array.isArray(mk.plugins)) {
        const list = mk.plugins.map(p => ({ name: String(p.name || ''), description: String(p.description || '').slice(0, 300), source: p.source, category: p.category || '' })).filter(p => p.name);
        const installable = s => typeof s === 'string' || (s && ['github', 'url', 'git-subdir'].includes(s.source));
        if (!pick) return { marketplace: true, name: mk.name || '', url: u, plugins: list.filter(p => installable(p.source)).map(({ source, ...r }) => r) };
        const p = list.find(x => x.name === pick);
        if (!p) throw new Error('این پلاگین در مارکت‌پلیس نیست');
        if (typeof p.source === 'string') {
          const sub = path.resolve(repo, mk.metadata && mk.metadata.pluginRoot && !p.source.startsWith('./') ? path.join(mk.metadata.pluginRoot, p.source) : p.source);
          if (!sub.startsWith(repo)) throw new Error('مسیر پلاگین نامعتبر است');
          return await this._install(sub, { type: 'git', url: u, plugin: pick });
        }
        // remote plugin: { source: "github", repo } | { source: "url", url } | { source: "git-subdir", url, path, ref }
        const s = p.source || {};
        const inner = validGitUrl(s.source === 'github' && s.repo ? s.repo : s.url);
        if (!inner) throw new Error('منبع این پلاگین پشتیبانی نمی‌شود');
        const dir2 = path.join(tmp, 'remote');
        await gitClone(inner, dir2, s.ref);
        const sub2 = path.resolve(dir2, String(s.path || '.'));
        if (sub2 !== dir2 && !sub2.startsWith(dir2 + path.sep)) throw new Error('مسیر پلاگین نامعتبر است');
        return await this._install(sub2, { type: 'git', url: inner, path: s.path || '', plugin: pick });
      }
      return await this._install(repo, { type: 'git', url: u });
    } finally { fs.rm(tmp, { recursive: true, force: true }, () => {}); }
  }

  // Plugins already installed in Claude Code.
  discover() {
    const roots = [path.join(os.homedir(), '.claude', 'plugins')];
    const found = [], seen = new Set();
    const walk = (d, depth) => {
      if (depth > 6 || found.length > 200) return;
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      if (ents.some(e => e.name === '.claude-plugin' && e.isDirectory()) && fs.existsSync(path.join(d, '.claude-plugin', 'plugin.json'))) {
        const meta = readJson(path.join(d, '.claude-plugin', 'plugin.json')) || {};
        const key = slug(meta.name || path.basename(d));
        if (!seen.has(key)) { seen.add(key); found.push({ name: key, description: String(meta.description || '').slice(0, 300), dir: d, installed: this.list.some(p => p.name === key) }); }
        return;
      }
      for (const e of ents) if (e.isDirectory() && !['node_modules', '.git'].includes(e.name)) walk(path.join(d, e.name), depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return found;
  }

  setEnabled(id, on) {
    const p = this.get(id);
    if (!p) throw new Error('پلاگین پیدا نشد');
    p.enabled = !!on;
    for (const sid of p.subagents) { const a = this.store.subagent(sid); if (a) this.store.saveSubagent({ ...a, enabled: p.enabled }); }
    for (const cid of p.connectors) { const c = this.connectors.get(cid); if (c && (!on || this.connectors.resolved(c))) this.connectors.setEnabled(cid, p.enabled); }
    this._save();
    return p;
  }

  remove(id) {
    const p = this.get(id);
    if (!p) return;
    for (const sid of p.subagents || []) this.store.deleteSubagent(sid);
    for (const kid of p.skills || []) { try { this.skills.remove(kid); } catch {} }
    this.connectors.removeByPlugin(id);
    fs.rm(path.join(this.dir, id), { recursive: true, force: true }, () => {});
    this.list = this.list.filter(x => x.id !== id);
    this._save();
  }
}

module.exports = { Plugins, frontMatter, validGitUrl };
