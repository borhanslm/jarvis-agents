// graphify integration (https://github.com/Graphify-Labs/graphify).
// Builds a code knowledge graph of each project locally (tree-sitter, no LLM,
// no API key) and teaches Claude/Codex to query it instead of grepping and
// reading whole files — fewer tokens per question.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { which } = require('./agents');

const OUT = 'graphify-out';
let bin;
function graphifyBin() {
  if (bin !== undefined) return bin;
  const hits = which('graphify');
  bin = hits.find(h => /\.exe$/i.test(h)) || hits[0] || null;
  return bin;
}
function refresh() { bin = undefined; return graphifyBin(); }

function run(args, { cwd, timeout = 300000 } = {}) {
  return new Promise(resolve => {
    const b = graphifyBin();
    if (!b) return resolve({ ok: false, out: '', err: 'graphify not installed' });
    // GRAPHIFY_BACKEND=none: code-only, never call an LLM (fully local).
    execFile(b, args, { cwd, timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GRAPHIFY_BACKEND: 'none', PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}

const graphFile = projectPath => path.join(projectPath, OUT, 'graph.json');

// Keep graphify-out/ out of the user's git status without touching tracked files
// (.git/info/exclude is local to this clone and never committed).
function excludeFromGit(projectPath) {
  try {
    const ex = path.join(projectPath, '.git', 'info', 'exclude');
    if (!fs.existsSync(path.dirname(ex))) return;
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    if (!/^\/?graphify-out\/?\s*$/m.test(cur)) fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}# added by JARVIS (local code graph)\n/graphify-out/\n`);
  } catch {}
}

function info(projectPath) {
  const f = graphFile(projectPath);
  try {
    const st = fs.statSync(f);
    const g = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { exists: true, builtAt: st.mtimeMs, nodes: g.nodes.length, edges: (g.links || g.edges || []).length, file: f };
  } catch { return { exists: false, file: f }; }
}

// Build or incrementally update the graph (code only).
// One graphify build per project at a time: a run starting while the dashboard's
// "build" button is busy (or two reviews) shares the build in flight.
const inFlight = new Map();
function update(projectPath) {
  const key = path.resolve(projectPath).toLowerCase();
  if (inFlight.has(key)) return inFlight.get(key);
  const p = doUpdate(projectPath).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
async function doUpdate(projectPath) {
  const t0 = Date.now();
  excludeFromGit(projectPath);
  const r = await run(['update', '.'], { cwd: projectPath });
  const m = (r.out + r.err).match(/Rebuilt:\s*(\d+)\s*nodes,\s*(\d+)\s*edges/);
  const i = info(projectPath);
  return { ok: i.exists, ms: Date.now() - t0, nodes: m ? +m[1] : i.nodes, edges: m ? +m[2] : i.edges, error: i.exists ? null : (r.err || r.out).slice(-600) };
}

async function godNodes(projectPath, top = 10) {
  const r = await run(['god-nodes', '--top', String(top), '--graph', graphFile(projectPath)], { cwd: projectPath, timeout: 30000 });
  return r.ok ? r.out.replace(/^God nodes.*\n/i, '').trim() : '';
}

// Instructions appended to every agent's system prompt (stable text => prompt-cached).
async function promptBlock(projectPath, budget = 1500) {
  const i = info(projectPath);
  if (!i.exists) return '';
  const g = graphFile(projectPath).replace(/\\/g, '/');
  const hubs = await godNodes(projectPath, 10);
  return `

== Code knowledge graph (graphify, local) ==
This project has a prebuilt code graph (${i.nodes} nodes, ${i.edges} edges). Use it BEFORE grepping or reading files — it tells you where code lives (file + line) and how it connects, for far fewer tokens than reading files:
- graphify query "<a few keywords>" --budget ${budget} --graph "${g}"   → relevant symbols with file:line
- graphify explain "<symbol>" --graph "${g}"                            → a node and its neighbours
- graphify path "<A>" "<B>" --graph "${g}"                              → how two things connect
- graphify affected "<symbol>" --graph "${g}"                           → what depends on it (check before changing it)
Then read only the specific files / line ranges it points to; don't read whole folders. If a query finds nothing, fall back to normal search.
${hubs ? `Most connected parts of this project:\n${hubs}` : ''}`;
}

// Pre-query: JARVIS asks the graph about the task itself and hands the agent a list
// of likely-relevant symbols with file:line, so it starts with a map instead of
// grepping around (agents often skip the graph on their own).
async function preQuery(projectPath, task, budget = 1200) {
  if (!info(projectPath).exists) return '';
  const q = String(task || '').replace(/\s+/g, ' ').slice(0, 400);
  if (!q.trim()) return '';
  const r = await run(['query', q, '--budget', String(budget), '--graph', graphFile(projectPath)], { cwd: projectPath, timeout: 30000 });
  if (!r.ok) return '';
  const lines = r.out.split(/\r?\n/).filter(l => /^NODE /.test(l))
    // compact: "NODE label [src=f loc=L12 community=x]" -> "- label — f:12"
    .map(l => {
      const m = l.match(/^NODE (.*?) \[src=(\S+) loc=L?(\d+)?/);
      return m ? `- ${m[1].slice(0, 90)} — ${m[2]}${m[3] ? ':' + m[3] : ''}` : null;
    }).filter(Boolean);
  return lines.length ? lines.join('\n') : '';
}

// Allow-list rules so the builder may run read-only graphify commands without a prompt.
const ALLOWED = ['graphify query', 'graphify explain', 'graphify path', 'graphify affected', 'graphify god-nodes'];

// Graph for the 3D view: the most connected nodes and the links between them.
function viewData(projectPath, limit = 400) {
  const f = graphFile(projectPath);
  const g = JSON.parse(fs.readFileSync(f, 'utf8'));
  const links = g.links || g.edges || [];
  const deg = {};
  for (const l of links) { deg[l.source] = (deg[l.source] || 0) + 1; deg[l.target] = (deg[l.target] || 0) + 1; }
  const nodes = g.nodes.map(n => ({ id: n.id, label: n.label, community: n.community, group: n.community_name || `#${n.community}`, file: n.source_file, loc: n.source_location, deg: deg[n.id] || 0 }))
    .sort((a, b) => b.deg - a.deg).slice(0, limit);
  const keep = new Set(nodes.map(n => n.id));
  return {
    nodes, total: g.nodes.length,
    links: links.filter(l => keep.has(l.source) && keep.has(l.target)).map(l => ({ s: l.source, t: l.target, r: l.relation })),
  };
}

module.exports = { graphifyBin, refresh, update, info, promptBlock, preQuery, viewData, ALLOWED, graphFile };
