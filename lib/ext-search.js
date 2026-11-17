// Find MCP servers, skills and plugins on the internet — always installed only after the user
// has seen what it is (the command / address of an MCP server, the files of a skill, the repo of a plugin).
//   MCP:     the official MCP Registry (registry.modelcontextprotocol.io), no key needed
//   skills:  GitHub repositories that contain SKILL.md files
//   plugins: the official Claude Code plugin marketplace + GitHub repositories
'use strict';
const path = require('path');

const HEAD = { 'user-agent': 'JARVIS-assistant', accept: 'application/vnd.github+json' };
const enc = encodeURIComponent;
async function getJson(url, fetchFn = fetch) {
  const r = await fetchFn(url, { headers: HEAD, signal: AbortSignal.timeout(20000) });
  if (r.status === 403 || r.status === 429) throw new Error('سهمیه‌ی جستجوی GitHub موقتاً پر شده؛ یک دقیقه‌ی دیگر دوباره امتحان کنید');
  if (!r.ok) throw new Error(`جستجو جواب نداد (${r.status})`);
  return r.json();
}
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/, BRANCH = /^[\w.\/-]{1,100}$/;

// ---- MCP servers ----
function mcpInstall(v) {
  const pk = (v.packages || []).find(p => (p.registryType || p.registry_name) === 'npm' && (!p.transport || p.transport.type === 'stdio'));
  if (pk) {
    const id = pk.identifier || pk.name, env = pk.environmentVariables || pk.environment_variables || [];
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(id || '')) return null;
    return { type: 'stdio', command: 'npx', args: ['-y', `${id}@${/^[\w.-]+$/.test(pk.version || '') ? pk.version : 'latest'}`],
      secrets: env.filter(e => e.isRequired || e.isSecret || e.is_required || e.is_secret).map(e => ({ name: e.name, label: String(e.description || e.name).slice(0, 120) })).filter(e => /^[A-Za-z_][\w-]*$/.test(e.name)) };
  }
  const rm = (v.remotes || []).find(r => /http/.test(r.type || '') && /^https:\/\//.test(r.url || ''));
  if (rm && !/\{/.test(rm.url)) {
    return { type: 'http', url: rm.url,
      secrets: (rm.headers || []).filter(h => h.isRequired || h.isSecret || /\{/.test(h.value || '')).map(h => ({ name: h.name, label: String(h.description || h.name).slice(0, 120), ...(/^bearer/i.test(h.value || '') ? { bearer: true } : {}) })).filter(h => /^[A-Za-z][\w-]*$/.test(h.name)) };
  }
  return null; // python / docker packages: not offered (JARVIS runs Node servers)
}
async function searchMcp(q, fetchFn) {
  const j = await getJson(`https://registry.modelcontextprotocol.io/v0/servers?search=${enc(q)}&limit=40&version=latest`, fetchFn);
  const seen = new Set(), out = [];
  for (const x of j.servers || []) {
    const v = x.server || x; if (!v || !v.name || seen.has(v.name)) continue; seen.add(v.name);
    const meta = (x._meta || {})['io.modelcontextprotocol.registry/official'] || {};
    if (meta.status && meta.status !== 'active') continue;
    const install = mcpInstall(v); if (!install) continue;
    out.push({ kind: 'mcp', id: v.name, name: v.title || v.name.split('/').pop(), description: String(v.description || '').slice(0, 300), version: v.version || '', source: 'MCP Registry', url: (v.repository && v.repository.url) || '', install });
  }
  return out.slice(0, 20);
}

// ---- skills (GitHub repos with SKILL.md) ----
// Anthropic's own skill collection comes first (cached for an hour)
let official = null;
async function officialSkills(fetchFn) {
  if (official && Date.now() - official.at < 3600e3) return official.list;
  const r = await repoSkills('anthropics/skills', 'main', fetchFn);
  official = { at: Date.now(), list: r.skills };
  return official.list;
}
async function searchSkills(q, fetchFn) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const off = (await officialSkills(fetchFn).catch(() => [])).filter(sk => words.some(w => (sk.dir + ' ' + sk.name).toLowerCase().includes(w)))
    .map(sk => ({ kind: 'skill', id: 'anthropics/skills:' + sk.dir, name: sk.name, description: 'اسکیل رسمی Anthropic — ' + sk.dir, repo: 'anthropics/skills', branch: 'main', dir: sk.dir, source: 'مجموعه‌ی رسمی Anthropic', url: 'https://github.com/anthropics/skills/tree/main/' + sk.dir }));
  const j = await getJson(`https://api.github.com/search/repositories?q=${enc(`${q} skill SKILL.md`)}&sort=stars&order=desc&per_page=15`, fetchFn);
  return [...off, ...(j.items || []).filter(r => !r.archived && !r.fork && r.full_name !== 'anthropics/skills').map(r => ({ kind: 'skill', id: r.full_name, name: r.full_name, description: String(r.description || '').slice(0, 300), stars: r.stargazers_count, repo: r.full_name, branch: r.default_branch, source: 'GitHub', url: r.html_url }))];
}
// the SKILL.md files of a repository
async function repoSkills(repo, branch, fetchFn) {
  if (!REPO.test(repo) || !BRANCH.test(branch)) throw new Error('مخزن نامعتبر');
  const t = await getJson(`https://api.github.com/repos/${repo}/git/trees/${enc(branch)}?recursive=1`, fetchFn);
  const blobs = (t.tree || []).filter(x => x.type === 'blob');
  const skills = blobs.filter(x => /(^|\/)SKILL\.md$/i.test(x.path)).map(x => { const dir = path.posix.dirname(x.path); return { path: x.path, dir: dir === '.' ? '' : dir, name: dir === '.' ? repo.split('/')[1] : path.posix.basename(dir) }; }).slice(0, 300);
  return { skills, blobs };
}
// download one skill folder (max 60 files, 5 MB) -> [{ path (relative to the skill), data: Buffer }]
async function downloadSkill(repo, branch, dir, fetchFn = fetch) {
  if (String(dir).split('/').includes('..')) throw new Error('مسیر نامعتبر');
  const { blobs } = await repoSkills(repo, branch, fetchFn);
  const mine = blobs.filter(b => dir ? b.path.startsWith(dir + '/') : !b.path.includes('/') || /^(scripts|references|assets|templates)\//.test(b.path));
  if (!mine.some(b => /SKILL\.md$/i.test(b.path))) throw new Error('SKILL.md در این پوشه نیست');
  if (mine.length > 60) throw new Error('این اسکیل بیشتر از ۶۰ فایل دارد');
  if (mine.reduce((t, b) => t + (b.size || 0), 0) > 5e6) throw new Error('این اسکیل بزرگ‌تر از ۵ مگابایت است');
  const out = [];
  for (const b of mine) {
    const r = await fetchFn(`https://raw.githubusercontent.com/${repo}/${branch.split('/').map(enc).join('/')}/${b.path.split('/').map(enc).join('/')}`, { headers: { 'user-agent': HEAD['user-agent'] }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('دانلود نشد: ' + b.path);
    out.push({ path: dir ? b.path.slice(dir.length + 1) : b.path, data: Buffer.from(await r.arrayBuffer()) });
  }
  return out;
}

// ---- plugins ----
let market = null;
async function officialMarket(fetchFn = fetch) {
  if (market && Date.now() - market.at < 3600e3) return market.list;
  const r = await fetchFn('https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json', { headers: { 'user-agent': HEAD['user-agent'] }, signal: AbortSignal.timeout(20000) });
  const j = r.ok ? await r.json() : { plugins: [] };
  market = { at: Date.now(), list: (j.plugins || []).map(p => ({ name: p.name, description: p.description || '' })) };
  return market.list;
}
async function searchPlugins(q, fetchFn) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const off = (await officialMarket(fetchFn).catch(() => [])).filter(p => words.every(w => (p.name + ' ' + p.description).toLowerCase().includes(w)))
    .map(p => ({ kind: 'plugin', id: 'official:' + p.name, name: p.name, description: String(p.description).slice(0, 300), source: 'مارکت‌پلیس رسمی Claude', install: { url: 'anthropics/claude-plugins-official', pick: p.name }, url: 'https://github.com/anthropics/claude-plugins-official' }));
  let gh = [];
  try {
    const j = await getJson(`https://api.github.com/search/repositories?q=${enc(`${q} claude code plugin`)}&sort=stars&order=desc&per_page=10`, fetchFn);
    gh = (j.items || []).filter(r => !r.archived).map(r => ({ kind: 'plugin', id: r.full_name, name: r.full_name, description: String(r.description || '').slice(0, 300), stars: r.stargazers_count, source: 'GitHub', install: { url: r.full_name }, url: r.html_url }));
  } catch (e) { if (!off.length) throw e; }
  return [...off.slice(0, 12), ...gh];
}

async function search(q, kind = 'all', fetchFn) {
  q = String(q || '').trim().slice(0, 120); if (q.length < 2) throw new Error('چه چیزی جستجو شود؟');
  const want = k => kind === 'all' || kind === k;
  const jobs = [want('mcp') && searchMcp(q, fetchFn), want('skill') && searchSkills(q, fetchFn), want('plugin') && searchPlugins(q, fetchFn)].filter(Boolean);
  const res = await Promise.allSettled(jobs);
  // official sources first (Anthropic's skills, the official plugin marketplace), then by kind as asked
  const items = res.flatMap(r => r.status === 'fulfilled' ? r.value : []).map((x, i) => ({ x, i, o: /رسمی/.test(x.source) ? 0 : 1 })).sort((a, b) => a.o - b.o || a.i - b.i).map(y => y.x);
  const errors = res.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (!items.length && errors.length) throw new Error(errors[0]);
  return { items, errors };
}

module.exports = { search, searchMcp, searchSkills, searchPlugins, repoSkills, downloadSkill, mcpInstall };
