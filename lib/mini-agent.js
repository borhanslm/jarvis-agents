// JARVIS's own small coding agent, so ANY model can be the builder or a tester in the team —
// models that only chat (Gemini, Grok, Qwen / OpenRouter, Groq, NVIDIA, Kimi, Ollama…) included.
// The model works with a few tools through plain JSON (no native function calling needed):
// list, read, search, write, edit, run. It stays inside the project folder; testers cannot write;
// commands are limited to the allowed list (tests, builds, git status/diff/log).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', 'coverage', '.jarvis', 'out']);
const MAX_RESULT = 8000;

function protocol(canWrite) {
  return `
== How you work ==
You act through tools. Every answer is ONLY one JSON object (no text around it):
{"thought": "<short>", "tool": "<name>", ...arguments}
Tools:
- {"tool": "list", "path": "<dir, default .>"}                       files and folders
- {"tool": "read", "path": "<file>", "from": <line, optional>, "to": <line, optional>}
- {"tool": "search", "query": "<text or regex>", "path": "<dir, optional>"}   finds lines in files
${canWrite ? `- {"tool": "write", "path": "<file>", "content": "<whole new file content>"}   creates or replaces a file
- {"tool": "edit", "path": "<file>", "old": "<exact text in the file>", "new": "<replacement>"}   one exact replacement (old must appear once)
` : ''}- {"tool": "run", "command": "<command>"}   only test/build/lint commands and git status/diff/log are allowed
- {"tool": "done", "text": "<your final answer / report, as asked in the task>"}
Paths are relative to the project folder. Read a file before editing it. Keep going until the task is complete, then use "done".`;
}

function inside(root, p) {
  const full = path.resolve(root, String(p || '.'));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path is outside the project');
  if (/(^|[\\/])\.git([\\/]|$)/.test(rel)) throw new Error('.git is off limits');
  return full;
}
const cut = s => { s = String(s); return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + `\n… (${s.length - MAX_RESULT} more characters; read a smaller range)` : s; };

function walk(dir, root, out, limit) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (out.length >= limit) return;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), root, out, limit); }
    else out.push(path.join(dir, e.name));
  }
}

const tools = {
  list(root, a) {
    const d = inside(root, a.path);
    const ents = fs.readdirSync(d, { withFileTypes: true }).filter(e => !SKIP_DIRS.has(e.name)).slice(0, 300);
    return ents.map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n') || '(empty)';
  },
  read(root, a) {
    const f = inside(root, a.path), st = fs.statSync(f);
    if (st.size > 3e6) return 'file is too big to read';
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    const from = Math.max(1, +a.from || 1), to = Math.min(lines.length, +a.to || from + 399);
    return `${path.relative(root, f)} (lines ${from}-${to} of ${lines.length})\n` + lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n');
  },
  search(root, a) {
    const q = String(a.query || ''); if (!q) return 'empty query';
    let re; try { re = new RegExp(q, 'i'); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const files = []; walk(inside(root, a.path), root, files, 4000);
    const hits = [];
    for (const f of files) {
      if (hits.length >= 80) break;
      let t; try { if (fs.statSync(f).size > 1e6) continue; t = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (t.includes('\u0000')) continue;
      t.split(/\r?\n/).forEach((l, i) => { if (hits.length < 80 && re.test(l)) hits.push(`${path.relative(root, f)}:${i + 1}: ${l.trim().slice(0, 200)}`); });
    }
    return hits.join('\n') || 'no matches';
  },
  write(root, a, st) {
    const f = inside(root, a.path);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(a.content ?? ''));
    st.edited.add(path.relative(root, f));
    return `wrote ${path.relative(root, f)} (${String(a.content ?? '').split('\n').length} lines)`;
  },
  edit(root, a, st) {
    const f = inside(root, a.path);
    const t = fs.readFileSync(f, 'utf8'), old = String(a.old ?? '');
    if (!old) return 'old is empty';
    const n = t.split(old).length - 1;
    if (n === 0) {
      // the model often gets line endings wrong
      const crlf = old.replace(/\r?\n/g, '\r\n');
      if (t.includes(crlf) && crlf !== old) { fs.writeFileSync(f, t.replace(crlf, String(a.new ?? '').replace(/\r?\n/g, '\r\n'))); st.edited.add(path.relative(root, f)); return 'edited (CRLF file)'; }
      return 'old text not found — read the file again and copy the exact text';
    }
    if (n > 1) return `old text appears ${n} times — include more surrounding lines`;
    fs.writeFileSync(f, t.replace(old, () => String(a.new ?? '')));
    st.edited.add(path.relative(root, f));
    return `edited ${path.relative(root, f)}`;
  },
  run(root, a, st, opts) {
    const cmd = String(a.command || '').trim();
    if (!cmd) return Promise.resolve('empty command');
    if (/[;&|><`$]/.test(cmd) || !(opts.allowed || []).some(p => cmd === p || cmd.startsWith(p + ' '))) return Promise.resolve(`not allowed. Allowed commands start with: ${(opts.allowed || []).join(', ')}`);
    return new Promise(res => {
      const shell = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', cmd]] : ['/bin/sh', ['-c', cmd]];
      execFile(shell[0], shell[1], { cwd: root, timeout: (opts.runTimeoutSec || 300) * 1000, maxBuffer: 4e6, windowsHide: true }, (err, out, errOut) => {
        res(cut(`exit code ${err ? (err.code ?? 'error') : 0}${err && err.killed ? ' (timed out)' : ''}\n${String(out || '')}${errOut ? '\n[stderr]\n' + errOut : ''}`));
      });
    });
  },
};

function parse(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try { const o = JSON.parse(s.slice(i, j + 1)); return o && typeof o.tool === 'string' ? o : null; } catch { return null; }
}

// llm(opts) -> { text, usage }; role: 'builder' (can write) or 'reviewer' (read-only)
async function runCoder({ llm, cwd, system, prompt, role = 'builder', allowed = [], onEvent = () => {}, signal, maxSteps = 60, runTimeoutSec }) {
  const canWrite = role === 'builder';
  const st = { edited: new Set() };
  const msgs = [{ role: 'user', content: prompt }];
  const usage = { input: 0, output: 0 };
  let bad = 0;
  for (let n = 1; n <= maxSteps; n++) {
    if (signal && signal.aborted) return { ok: false, cancelled: true, error: 'stopped', text: '', editedFiles: [...st.edited], usage };
    // keep the context small: old tool results are shortened
    const view = msgs.map((m, i) => (i < msgs.length - 16 && m.role === 'user' && i > 0 && m.content.length > 600) ? { ...m, content: m.content.slice(0, 300) + '\n… (older result shortened)' } : m);
    let r;
    try { r = await llm({ system: (system || '') + protocol(canWrite), messages: view, maxTokens: 8000, temperature: 0.2, signal }); }
    catch (e) { if (signal && signal.aborted) return { ok: false, cancelled: true, error: 'stopped', editedFiles: [...st.edited], usage }; return { ok: false, error: e.message, text: '', editedFiles: [...st.edited], usage }; }
    if (r.usage) { usage.input += r.usage.input || 0; usage.output += r.usage.output || 0; }
    const a = parse(r.text);
    msgs.push({ role: 'assistant', content: String(r.text || '').slice(0, 60000) });
    if (!a) {
      // a plain answer with no JSON: take it as the final answer when it looks like one
      if (++bad >= 3 || (n > 1 && /```json|"verdict"|"bugs"/.test(r.text || ''))) return { ok: true, text: r.text, editedFiles: [...st.edited], usage, steps: n };
      msgs.push({ role: 'user', content: 'Answer with ONLY one JSON object, e.g. {"thought": "...", "tool": "read", "path": "README.md"}.' });
      continue;
    }
    bad = 0;
    if (a.tool === 'done') return { ok: true, text: typeof a.text === 'string' ? a.text : JSON.stringify(a.text ?? ''), editedFiles: [...st.edited], usage, steps: n };
    onEvent({ n, tool: a.tool, thought: a.thought || '', path: a.path || a.command || a.query || '' });
    let out;
    try {
      if (!tools[a.tool]) out = 'unknown tool';
      else if ((a.tool === 'write' || a.tool === 'edit') && !canWrite) out = 'you are a reviewer: you must not change files';
      else out = await tools[a.tool](cwd, a, st, { allowed, runTimeoutSec });
    } catch (e) { out = 'error: ' + e.message; }
    msgs.push({ role: 'user', content: `Result of ${a.tool}${a.path ? ' ' + a.path : ''}:\n${cut(out)}` });
  }
  return { ok: false, error: 'too many steps', text: '', editedFiles: [...st.edited], usage };
}

module.exports = { runCoder, parse, inside, tools };
