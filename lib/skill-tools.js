// Making skills easy: write one with AI from a description, or upload one (SKILL.md or a .zip).
// An upload is unpacked into a waiting area and shown to the user first; nothing is installed until
// they confirm. Files that can run (scripts, programs) are pointed out in the preview.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { parseSkillMd } = require('./skills');

const DRAFT_SYSTEM = 'You write Agent Skills: a SKILL.md with clear, practical instructions that an AI agent follows when the skill applies.';
function draftPrompt(idea) {
  return `Write a skill from this description (it may be Persian):
${idea}

Answer ONLY JSON: {"name": "<short-kebab-case-english>", "description": "<one sentence: what it does AND when to use it, in English>", "body": "<the SKILL.md body in Markdown: ## When to use, ## Steps (numbered, concrete), ## Rules / checks, ## Output. Write it in the language of the description.>"}`;
}
function parseDraft(text) {
  const t = String(text || ''); const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('هوش مصنوعی اسکیل قابل‌استفاده‌ای نساخت؛ دوباره امتحان کنید');
  const j = JSON.parse(t.slice(s, e + 1));
  const name = String(j.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  if (!name || !j.body) throw new Error('اسکیل ناقص ساخته شد؛ دوباره امتحان کنید');
  return { name, description: String(j.description || '').slice(0, 600), body: String(j.body).trim() };
}

const RUNNABLE = /\.(ps1|bat|cmd|exe|dll|sh|bash|js|mjs|cjs|py|vbs|jar|msi|scr|com)$/i;
const pending = new Map(); // token -> { dir, at }
const TMP = () => path.join(os.tmpdir(), 'jarvis-skill-upload');
function cleanup() { for (const [k, v] of pending) if (Date.now() - v.at > 30 * 6e4) { fs.rm(v.dir, { recursive: true, force: true }, () => {}); pending.delete(k); } }
function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out); else out.push(path.relative(base, p).replace(/\\/g, '/'));
    if (out.length > 500) break;
  }
  return out;
}
// the folder that holds SKILL.md (the zip root or one folder down)
function findSkillRoot(dir) {
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) return path.join(dir, e.name);
  return null;
}
const untar = (zip, to) => new Promise((res, rej) => execFile(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', zip, '-C', to], { windowsHide: true }, e => e ? rej(new Error('فایل zip باز نشد: ' + e.message)) : res()));

// -> preview { token, name, description, body (start), files, runnable }
async function stageUpload({ fileName, data }) {
  cleanup();
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw new Error('فایل خالی است');
  if (buf.length > 5e6) throw new Error('فایل بزرگ‌تر از ۵ مگابایت است');
  const token = crypto.randomBytes(9).toString('hex');
  const dir = path.join(TMP(), token);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const nameLow = String(fileName || '').toLowerCase();
    if (nameLow.endsWith('.zip') || (buf[0] === 0x50 && buf[1] === 0x4b)) {
      const zip = path.join(dir, '..', token + '.zip'); fs.writeFileSync(zip, buf);
      try { await untar(zip, dir); } finally { fs.rmSync(zip, { force: true }); }
    } else if (/\.(md|markdown|txt)$/.test(nameLow) || !nameLow) {
      const text = buf.toString('utf8');
      const meta = parseSkillMd(text);
      const name = meta.name || path.basename(nameLow).replace(/\.(md|markdown|txt)$/, '').replace(/^skill$/, '') || 'uploaded-skill';
      fs.writeFileSync(path.join(dir, 'SKILL.md'), meta.name ? text : `---\nname: ${name.replace(/[^a-z0-9-]+/gi, '-')}\ndescription: ${JSON.stringify(meta.description || 'Uploaded skill')}\n---\n\n${meta.body || text}`);
    } else throw new Error('فقط SKILL.md یا فایل zip اسکیل');
    const root = findSkillRoot(dir);
    if (!root) throw new Error('در این فایل SKILL.md پیدا نشد');
    // nothing may point outside the folder
    for (const f of listFiles(root)) if (f.startsWith('..') || path.isAbsolute(f)) throw new Error('فایل zip مسیر نامعتبر دارد');
    const meta = parseSkillMd(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8'));
    const files = listFiles(root);
    pending.set(token, { dir: root, top: dir, at: Date.now() });
    return { token, name: meta.name || path.basename(root), description: meta.description || '', body: String(meta.body || '').slice(0, 4000), files: files.slice(0, 100), fileCount: files.length, runnable: files.filter(f => RUNNABLE.test(f)) };
  } catch (e) { fs.rm(dir, { recursive: true, force: true }, () => {}); throw e; }
}
// a skill downloaded from the internet: [{ path, data }] -> the same preview as an upload
function stageFiles(files, origin) {
  cleanup();
  const token = crypto.randomBytes(9).toString('hex');
  const dir = path.join(TMP(), token);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of files) {
      const rel = String(f.path || '').replace(/\\/g, '/');
      if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) throw new Error('مسیر نامعتبر: ' + rel);
      const to = path.join(dir, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, f.data);
    }
    const root = findSkillRoot(dir); if (!root) throw new Error('SKILL.md پیدا نشد');
    const meta = parseSkillMd(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8'));
    const list = listFiles(root);
    pending.set(token, { dir: root, top: dir, at: Date.now(), source: 'internet', origin: String(origin || '').slice(0, 200) });
    return { token, name: meta.name || path.basename(root), description: meta.description || '', body: String(meta.body || '').slice(0, 4000), files: list.slice(0, 100), fileCount: list.length, runnable: list.filter(f => RUNNABLE.test(f)), origin };
  } catch (e) { fs.rm(dir, { recursive: true, force: true }, () => {}); throw e; }
}
// the user said yes: copy it into the library
function confirmUpload(skills, token) {
  const p = pending.get(String(token || ''));
  if (!p) throw new Error('این آپلود منقضی شده؛ دوباره فایل را انتخاب کنید');
  pending.delete(token);
  try { const s = skills.importDir(p.dir); s.source = p.source || 'uploaded'; if (p.origin) s.origin = p.origin; else delete s.origin; skills._save(); return s; }
  finally { fs.rm(p.top, { recursive: true, force: true }, () => {}); }
}
function cancelUpload(token) { const p = pending.get(String(token || '')); if (p) { pending.delete(token); fs.rm(p.top, { recursive: true, force: true }, () => {}); } }

module.exports = { DRAFT_SYSTEM, draftPrompt, parseDraft, stageUpload, stageFiles, confirmUpload, cancelUpload, RUNNABLE };
