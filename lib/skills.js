// Skill library for sub-agents.
//
// A skill is a folder with a SKILL.md (YAML front-matter `name` + `description`,
// then instructions), the same format Claude Code uses. Skills live in
// data/skills/<id>/ — created here, or copied from an installed skill folder.
//
// Delivery (works for Claude and Codex alike):
//   small skill  -> its instructions are put straight into the sub-agent's prompt
//   large skill  -> only name + description + the SKILL.md path; the sub-agent reads
//                   the file when the task needs it (progressive disclosure, saves tokens)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const INLINE_MAX = 2500;           // chars of SKILL.md inlined directly
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 300;

function parseSkillMd(text) {
  const m = String(text).match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { name: meta.name || '', description: meta.description || '', body: m ? m[2] : String(text) };
}

const slug = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const yamlStr = s => JSON.stringify(String(s || '').replace(/\r?\n/g, ' '));

// Copy a skill folder (no symlinks, size/file caps) into the library.
function copyDir(src, dst) {
  let bytes = 0, files = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', '__pycache__', 'graphify-out'].includes(e.name)) walk(sp, dp); continue; }
      if (!e.isFile()) continue;
      const size = fs.statSync(sp).size;
      bytes += size; files++;
      if (bytes > MAX_SKILL_BYTES || files > MAX_FILES) throw new Error('این اسکیل بزرگ‌تر از حد مجاز است (۵ مگابایت / ۳۰۰ فایل)');
      fs.copyFileSync(sp, dp);
    }
  };
  walk(src, dst);
}

class Skills {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'skills');
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexFile = path.join(this.dir, 'index.json');
    try { this.list = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { this.list = []; }
  }
  _save() { fs.writeFileSync(this.indexFile, JSON.stringify(this.list, null, 2)); }
  skillDir(id) { return path.join(this.dir, id); }
  skillFile(id) { return path.join(this.skillDir(id), 'SKILL.md'); }

  all() {
    return this.list.map(s => {
      let size = 0;
      try { size = fs.statSync(this.skillFile(s.id)).size; } catch {}
      return { ...s, size, inline: size <= INLINE_MAX };
    });
  }
  get(id) {
    const s = this.list.find(x => x.id === id);
    if (!s) return null;
    let content = '';
    try { content = fs.readFileSync(this.skillFile(id), 'utf8'); } catch {}
    return { ...s, content, ...parseSkillMd(content), name: s.name, description: s.description };
  }

  // Create or edit a skill written in the panel.
  save({ id, name, description, content }) {
    const n = slug(name);
    if (!n) throw new Error('نام اسکیل باید حروف انگلیسی/عدد باشد');
    if (!String(description || '').trim()) throw new Error('توضیح اسکیل لازم است — ایجنت از روی آن تصمیم می‌گیرد کی از آن استفاده کند');
    const body = String(content || '').trim();
    if (!body) throw new Error('متن اسکیل خالی است');
    if (body.length > 200000) throw new Error('متن اسکیل خیلی طولانی است');
    if (this.list.some(x => x.name === n && x.id !== id)) throw new Error('اسکیلی با این نام وجود دارد');
    let s = id && this.list.find(x => x.id === id);
    if (!s) { s = { id: crypto.randomUUID().slice(0, 8), source: 'custom', createdAt: Date.now() }; this.list.push(s); }
    Object.assign(s, { name: n, description: String(description).trim().slice(0, 600), updatedAt: Date.now() });
    fs.mkdirSync(this.skillDir(s.id), { recursive: true });
    // Front-matter is regenerated from the fields; the body is what the user wrote.
    const parsed = parseSkillMd(body);
    fs.writeFileSync(this.skillFile(s.id), `---\nname: ${n}\ndescription: ${yamlStr(s.description)}\n---\n\n${parsed.body.trim()}\n`);
    this._save();
    return s;
  }

  // Copy an existing skill folder (e.g. from ~/.claude/skills) into the library.
  importDir(dir) {
    const src = path.resolve(String(dir || ''));
    const md = path.join(src, 'SKILL.md');
    if (!fs.existsSync(md)) throw new Error('در این پوشه SKILL.md پیدا نشد');
    const meta = parseSkillMd(fs.readFileSync(md, 'utf8'));
    let n = slug(meta.name || path.basename(src));
    if (!n) throw new Error('نام اسکیل نامعتبر است');
    const existing = this.list.find(x => x.origin && path.resolve(x.origin).toLowerCase() === src.toLowerCase());
    if (existing) return existing;
    if (this.list.some(x => x.name === n)) n = `${n}-${crypto.randomUUID().slice(0, 4)}`;
    const s = { id: crypto.randomUUID().slice(0, 8), name: n, description: (meta.description || '').slice(0, 600), source: 'imported', origin: src, createdAt: Date.now() };
    try { copyDir(src, this.skillDir(s.id)); }
    catch (e) { fs.rmSync(this.skillDir(s.id), { recursive: true, force: true }); throw e; }
    this.list.push(s);
    this._save();
    return s;
  }

  remove(id) {
    const s = this.list.find(x => x.id === id);
    if (!s) return false;
    this.list = this.list.filter(x => x.id !== id);
    this._save();
    const d = this.skillDir(id);
    if (path.dirname(d) === this.dir) fs.rmSync(d, { recursive: true, force: true });
    return true;
  }

  // Installed skills on this machine (Claude Code / Codex / shared, + project skills).
  discover(projectPaths = []) {
    const home = os.homedir();
    const roots = [
      [path.join(home, '.claude', 'skills'), 'Claude Code'],
      [path.join(home, '.codex', 'skills'), 'Codex'],
      [path.join(home, '.agents', 'skills'), 'agents'],
      ...projectPaths.flatMap(p => [[path.join(p, '.claude', 'skills'), path.basename(p)], [path.join(p, '.agents', 'skills'), path.basename(p)]]),
    ];
    const found = new Map();
    const imported = new Set(this.list.filter(x => x.origin).map(x => path.resolve(x.origin).toLowerCase()));
    const walk = (dir, from, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
        const key = path.resolve(dir).toLowerCase();
        if (found.has(key)) return;
        try {
          const md = path.join(dir, 'SKILL.md');
          const meta = parseSkillMd(fs.readFileSync(md, 'utf8').slice(0, 8000));
          found.set(key, { name: meta.name || path.basename(dir), description: meta.description || '', dir, from, size: fs.statSync(md).size, imported: imported.has(key) });
        } catch {}
        return;
      }
      if (depth <= 0) return;
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), from, depth - 1);
    };
    for (const [r, from] of roots) walk(r, from, 3);
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Prompt text + folders the agent needs read access to, for a list of skill ids.
  forAgent(ids = []) {
    const parts = [], dirs = [], used = [];
    for (const id of ids) {
      const s = this.get(id);
      if (!s || !s.content) continue;
      const file = this.skillFile(id).replace(/\\/g, '/');
      used.push(s.name);
      dirs.push(this.skillDir(id));
      if (s.content.length <= INLINE_MAX) {
        parts.push(`### Skill: ${s.name}\n${s.description}\n\n${s.body.trim()}`);
      } else {
        parts.push(`### Skill: ${s.name}\n${s.description}\nFull instructions: ${file} — read this file (and any files it references in the same folder) BEFORE doing work this skill covers. Skip it if the task doesn't need it.`);
      }
    }
    if (!parts.length) return { block: '', dirs: [], names: [] };
    return {
      block: `\n\n== Your skills ==\nYou have these skills. Use one when the task matches its description.\n\n${parts.join('\n\n')}`,
      dirs, names: used,
    };
  }
}

module.exports = { Skills, parseSkillMd, INLINE_MAX };
