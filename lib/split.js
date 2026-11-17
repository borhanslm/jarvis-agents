// "Split between AIs": one big job is cut into parts, each part goes to the AI that suits it
// (Claude Code, Codex, or a connected model) and the parts run AT THE SAME TIME, each in its own
// copy of the project (a git worktree), so they never step on each other. Their changes are then
// brought back into the project one by one; a part whose changes clash is redone in the main folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const git = (cwd, args) => new Promise(res => execFile('git', args, { cwd, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (e, out, err) => res({ ok: !e, out: String(out || '').trimEnd(), err: String(err || '').trim() })));

const SPLIT_SYSTEM = 'You are the planner of a team of different AI coding agents. You never write code or change files; you only split work and pick who does each part.';
function splitPrompt(task, engines) {
  return `Split the request below into 2 to 5 parts that different AI coding agents can do AT THE SAME TIME, each in its own copy of the project.
Rules:
- Parts must be as independent as possible: give each part its own files. Two parts must NOT edit the same file. If the job cannot be split that way, return a single part.
- Each part's prompt must be complete on its own (the agent does not see the other parts), and say which files to create or change.
- Pick the best agent for each part from this list (use the "id" exactly):
${engines.map(e => `  - "${e.id}": ${e.label}${e.note ? ' — ' + e.note : ''}`).join('\n')}
  Spread the work: use different agents when it makes sense (e.g. one builds the backend, another the UI, another the tests).
Look at the project (read-only) first if you need to.
Answer with ONLY a JSON array, no other text:
[{"title": "<short title, same language as the request>", "engine": "<id>", "files": ["<path>", ...], "prompt": "<full instructions for this part, English>"}]

== Request ==
${task}`;
}

function parseSplit(text, engines) {
  const t = String(text || ''); const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s < 0 || e <= s) return null;
  let arr; try { arr = JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  const ids = engines.map(x => x.id);
  const parts = arr.slice(0, 5).map(p => ({
    title: String(p.title || '').trim().slice(0, 80) || 'بخش',
    engine: ids.includes(p.engine) ? p.engine : ids[0],
    files: Array.isArray(p.files) ? p.files.map(String).filter(Boolean).slice(0, 30) : [],
    prompt: String(p.prompt || '').trim().slice(0, 6000),
  })).filter(p => p.prompt);
  return parts.length ? parts : null;
}

// two parts that name the same file cannot run side by side
function overlaps(parts) {
  const seen = new Map(), clash = new Set();
  parts.forEach((p, i) => p.files.forEach(f => { const k = f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(); if (seen.has(k) && seen.get(k) !== i) { clash.add(i); clash.add(seen.get(k)); } else seen.set(k, i); }));
  return clash;
}

// a separate copy of the project at the starting point (the run's checkpoint: committed + uncommitted work)
async function addWorktree(cwd, base, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-split-${tag}-`));
  fs.rmSync(dir, { recursive: true, force: true });
  const r = await git(cwd, ['worktree', 'add', '--detach', dir, base]);
  if (!r.ok) throw new Error('git worktree: ' + r.err);
  return dir;
}
// everything the part changed, as a patch against the starting point
async function partPatch(dir, base) {
  await git(dir, ['add', '-A']);
  const d = await git(dir, ['diff', '--cached', '--binary', base]);
  return d.ok ? d.out + (d.out ? '\n' : '') : '';
}
async function applyPatch(cwd, patch) {
  if (!patch.trim()) return { ok: true, empty: true };
  const f = path.join(os.tmpdir(), `jarvis-split-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  fs.writeFileSync(f, patch);
  try {
    const chk = await git(cwd, ['apply', '--check', '--whitespace=nowarn', f]);
    if (!chk.ok) return { ok: false, err: chk.err };
    const r = await git(cwd, ['apply', '--whitespace=nowarn', f]);
    return r.ok ? { ok: true, files: (patch.match(/^diff --git a\/(\S+)/gm) || []).map(l => l.replace(/^diff --git a\//, '')) } : { ok: false, err: r.err };
  } finally { fs.rm(f, { force: true }, () => {}); }
}
async function removeWorktree(cwd, dir) {
  await git(cwd, ['worktree', 'remove', '--force', dir]);
  fs.rm(dir, { recursive: true, force: true }, () => {});
  await git(cwd, ['worktree', 'prune']);
}

module.exports = { SPLIT_SYSTEM, splitPrompt, parseSplit, overlaps, addWorktree, partPatch, applyPatch, removeWorktree };
