// Small git helpers. Checkpoints are stored as commits under refs/jarvis/*
// built from a temporary index, so they never touch the user's index,
// branches or stash.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function git(cwd, args, env) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '').trimEnd(), err: (stderr || '').trim() }));
  });
}

async function isRepo(cwd) {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.out === 'true';
}

async function info(cwd) {
  if (!(await isRepo(cwd))) return { git: false };
  const [b, s, l] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['log', '-1', '--format=%h %s (%cr)']),
  ]);
  return { git: true, branch: b.ok ? b.out : '(no commits)', changes: s.out ? s.out.split('\n').length : 0, lastCommit: l.ok ? l.out : '' };
}

async function diffStat(cwd) {
  const [d, u] = await Promise.all([
    git(cwd, ['diff', 'HEAD', '--stat']),
    git(cwd, ['ls-files', '--others', '--exclude-standard']),
  ]);
  let s = d.ok ? d.out : '';
  const untracked = u.out ? u.out.split('\n') : [];
  if (untracked.length) s += `${s ? '\n' : ''}فایل‌های جدید (untracked): ${untracked.length}\n` + untracked.slice(0, 30).map(f => '  + ' + f).join('\n');
  return s.trim();
}

async function diff(cwd) {
  const d = await git(cwd, ['diff', 'HEAD']);
  const u = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  let out = d.out || '';
  if (u.out) out += `\n\n# Untracked files:\n${u.out}`;
  return out.length > 400000 ? out.slice(0, 400000) + '\n… (truncated)' : out;
}

// Snapshot the full working tree (tracked + untracked, respecting .gitignore)
// into a commit object. keepRef stores it under refs/jarvis/* so git gc keeps it.
async function snapshot(cwd, { keepRef = false, message = 'jarvis snapshot' } = {}) {
  const tmpIndex = path.join(os.tmpdir(), `jarvis-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
    if (head.ok) await git(cwd, ['read-tree', 'HEAD'], env);
    const add = await git(cwd, ['add', '-A'], env);
    if (!add.ok) return null;
    const tree = await git(cwd, ['write-tree'], env);
    if (!tree.ok) return null;
    const args = ['commit-tree', tree.out, '-m', `${message} ${new Date().toISOString()}`];
    if (head.ok) args.splice(2, 0, '-p', head.out);
    const c = await git(cwd, args, { ...env, GIT_AUTHOR_NAME: 'jarvis', GIT_AUTHOR_EMAIL: 'jarvis@localhost', GIT_COMMITTER_NAME: 'jarvis', GIT_COMMITTER_EMAIL: 'jarvis@localhost' });
    if (!c.ok) return null;
    if (keepRef) await git(cwd, ['update-ref', `refs/jarvis/cp-${Date.now()}`, c.out]);
    return { commit: c.out, tree: tree.out };
  } finally {
    fs.rm(tmpIndex, { force: true }, () => {});
  }
}

async function checkpoint(cwd) {
  const s = await snapshot(cwd, { keepRef: true, message: 'jarvis checkpoint' });
  return s && s.commit;
}

// Diff between two snapshots/commits: { stat, text, files }. text is cut to maxChars.
async function diffBetween(cwd, from, to, maxChars = 40000) {
  const [st, names, full] = await Promise.all([
    git(cwd, ['diff', '--stat', from, to]),
    git(cwd, ['diff', '--name-only', from, to]),
    maxChars > 0 ? git(cwd, ['diff', '--no-color', from, to]) : Promise.resolve({ out: '' }),
  ]);
  let text = full.out || '';
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n… (diff truncated, ${text.length - maxChars} more chars — run git diff yourself for the rest)`;
  return { stat: st.out || '', text, files: names.out ? names.out.split('\n') : [] };
}

// Everything that changed since a checkpoint, including untracked files.
async function diffSince(cwd, cp, maxChars) {
  const now = await snapshot(cwd);
  if (!now) return null;
  return diffBetween(cwd, cp, now.commit, maxChars);
}

const SAFE_REL = f => f && !path.isAbsolute(f) && !f.split(/[\\/]/).includes('..');

// Restore working-tree files to a checkpoint (the index/staging area is not touched).
// Files created after the checkpoint are listed, and deleted only if deleteNewer.
async function restore(cwd, commit, { deleteNewer = false } = {}) {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { ok: false, err: 'invalid checkpoint' };
  const r = await git(cwd, ['restore', '--source', commit, '--worktree', '--', '.']);
  if (!r.ok) return { ok: false, err: r.err };
  const u = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  const inCp = new Set((await git(cwd, ['ls-tree', '-r', '--name-only', commit])).out.split('\n'));
  const newer = (u.out ? u.out.split('\n') : []).filter(f => !inCp.has(f));
  const deleted = [];
  if (deleteNewer) {
    for (const f of newer) {
      if (!SAFE_REL(f)) continue;
      try { fs.rmSync(path.join(cwd, f), { force: true }); deleted.push(f); } catch {}
    }
  }
  return { ok: true, newerFiles: newer.filter(f => !deleted.includes(f)), deletedFiles: deleted };
}

async function currentBranch(cwd) {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok ? r.out : null;
}

// Switch to (or create) a branch, carrying uncommitted changes along.
async function useBranch(cwd, name) {
  // No leading "-" (would be parsed as a git option), no "..", no odd characters.
  if (!/^[\w./-]+$/.test(name) || name.startsWith('-') || name.includes('..')) return { ok: false, err: 'invalid branch name' };
  if ((await currentBranch(cwd)) === name) return { ok: true, created: false };
  const exists = (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok;
  const r = await git(cwd, exists ? ['switch', name] : ['switch', '-c', name]);
  return r.ok ? { ok: true, created: !exists } : { ok: false, err: r.err };
}

// Commit all changes with the user's own git identity (hooks run normally).
async function commitAll(cwd, message) {
  const st = await git(cwd, ['status', '--porcelain']);
  if (!st.out) return { ok: true, nothing: true };
  const a = await git(cwd, ['add', '-A']);
  if (!a.ok) return { ok: false, err: a.err };
  const c = await git(cwd, ['commit', '-m', message]);
  if (!c.ok) return { ok: false, err: c.err || c.out };
  const h = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, hash: h.out };
}

// Changed files vs HEAD (tracked + untracked) with +/- line counts.
async function changedFiles(cwd) {
  if (!(await isRepo(cwd))) return { git: false, files: [] };
  const [n, u] = await Promise.all([
    git(cwd, ['diff', 'HEAD', '--numstat']),
    git(cwd, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const files = [];
  for (const line of (n.out ? n.out.split('\n') : [])) {
    const [a, d, ...p] = line.split('\t');
    files.push({ path: p.join('\t'), add: a === '-' ? null : +a, del: d === '-' ? null : +d, status: 'modified' });
  }
  for (const f of (u.out ? u.out.split('\n') : [])) files.push({ path: f, add: null, del: 0, status: 'new' });
  return { git: true, files };
}
// One file's diff (new files are shown in full).
async function fileDiff(cwd, file) {
  if (!SAFE_REL(file)) return { ok: false, err: 'invalid path' };
  const tracked = (await git(cwd, ['ls-files', '--error-unmatch', '--', file])).ok;
  if (!tracked) {
    try {
      const txt = fs.readFileSync(path.join(cwd, file), 'utf8');
      return { ok: true, status: 'new', diff: txt.length > 200000 ? txt.slice(0, 200000) + '\n… (truncated)' : txt };
    } catch (e) { return { ok: false, err: String(e.message || e) }; }
  }
  const d = await git(cwd, ['diff', 'HEAD', '--no-color', '-U3', '--', file]);
  return { ok: d.ok, status: 'modified', diff: d.out.length > 400000 ? d.out.slice(0, 400000) + '\n… (truncated)' : d.out };
}
// Undo the changes to one file: back to HEAD, or delete it if it is new.
async function revertFile(cwd, file) {
  if (!SAFE_REL(file)) return { ok: false, err: 'invalid path' };
  const { files } = await changedFiles(cwd);
  const f = files.find(x => x.path === file);
  if (!f) return { ok: false, err: 'این فایل تغییری ندارد' };
  if (f.status === 'new') {
    try { fs.rmSync(path.join(cwd, file), { force: true }); return { ok: true, deleted: true }; } catch (e) { return { ok: false, err: String(e.message || e) }; }
  }
  const r = await git(cwd, ['restore', '--source', 'HEAD', '--worktree', '--', file]);
  return r.ok ? { ok: true } : { ok: false, err: r.err };
}

async function push(cwd, branch) {
  const r = await git(cwd, ['push', '-u', 'origin', branch]);
  return r.ok ? { ok: true } : { ok: false, err: r.err };
}

module.exports = { push, changedFiles, fileDiff, revertFile, isRepo, info, diffStat, diff, snapshot, checkpoint, diffBetween, diffSince, restore, currentBranch, useBranch, commitAll };
