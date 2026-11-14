// Low-level runners for the Claude Code and Codex CLIs.
// Both are run headless with JSON event streams; prompts go through stdin
// so no prompt text is ever placed on a command line.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const { prettyModel } = require('./models');

function which(cmd) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

// Node binary used to run JS entry points (codex.js). Inside the desktop app
// process.execPath is Electron, so prefer a real node.exe; otherwise run Electron
// in node mode (ELECTRON_RUN_AS_NODE) for that child only.
const IN_ELECTRON = !!process.versions.electron;
function nodeBin() {
  if (!IN_ELECTRON) return { cmd: process.execPath, env: {} };
  const n = which('node').find(p => !IS_WIN || p.toLowerCase().endsWith('.exe'));
  return n ? { cmd: n, env: {} } : { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// Places the official installers use, in case PATH wasn't refreshed yet
// (e.g. the CLI was installed while the app was open).
function knownLocations(name) {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (!IS_WIN) return [path.join(home, '.local', 'bin', name), path.join('/usr/local/bin', name), path.join('/opt/homebrew/bin', name)];
  return name === 'claude'
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(appdata, 'npm', 'claude.cmd')]
    : [path.join(appdata, 'npm', 'codex.cmd')];
}

// Resolve how to launch a CLI without going through a shell.
// On Windows, npm installs `.cmd` shims that can't be spawned directly,
// so we run their JS entry point with node instead.
function resolveCli(name) {
  const envOverride = process.env[`JARVIS_${name.toUpperCase()}_BIN`];
  if (envOverride) return { cmd: envOverride, pre: [], env: {} };
  const hits = [...which(name), ...knownLocations(name).filter(p => fs.existsSync(p))];
  for (const h of hits) {
    const lower = h.toLowerCase();
    if (lower.endsWith('.exe') || (!IS_WIN && fs.existsSync(h))) return { cmd: h, pre: [], env: {} };
    if (lower.endsWith('.cmd') || lower.endsWith('.ps1') || !path.extname(lower)) {
      const dir = path.dirname(h);
      const candidates = name === 'codex'
        ? [path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]
        : [path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')];
      for (const c of candidates) if (fs.existsSync(c)) { const n = nodeBin(); return { cmd: n.cmd, pre: [c], env: n.env }; }
    }
  }
  return null;
}

const CLIS = { claude: resolveCli('claude'), codex: resolveCli('codex') };
// Re-detect after the user installs a CLI from the setup screen.
function refreshClis() { CLIS.claude = resolveCli('claude'); CLIS.codex = resolveCli('codex'); return CLIS; }

// Per-agent auth environment (e.g. ANTHROPIC_API_KEY when the user connected
// Claude with an API key). Set by lib/setup.js; never written to disk here.
const authEnv = { claude: {}, codex: {} };
function setAuthEnv(name, env) { authEnv[name] = { ...(env || {}) }; }

// The model Codex uses when none is given (top-level `model = "..."` in ~/.codex/config.toml).
let _codexModel;
function codexConfigModel() {
  if (_codexModel !== undefined) return _codexModel;
  try {
    const toml = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
    const top = toml.split(/^\s*\[/m)[0]; // only top-level keys, not [profiles.*]
    const m = top.match(/^\s*model\s*=\s*"([^"]+)"/m);
    _codexModel = m ? m[1] : 'codex';
  } catch { _codexModel = 'codex'; }
  return _codexModel;
}

function version(name) {
  const c = CLIS[name];
  if (!c) return null;
  try {
    return execFileSync(c.cmd, [...c.pre, '--version'], { encoding: 'utf8', timeout: 20000, env: childEnv(name), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { return null; }
}

// Environment for child agents: strip variables that make Claude Code think
// it is nested inside another Claude Code session, then add this agent's auth.
function childEnv(name) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  }
  if (name && CLIS[name]) Object.assign(env, CLIS[name].env || {});
  if (name && authEnv[name]) Object.assign(env, authEnv[name]);
  return env;
}

// Run a CLI once and collect its output (used by the setup screen).
function runOnce(name, args, { input = '', timeout = 30000 } = {}) {
  const c = CLIS[name];
  if (!c) return Promise.resolve({ code: -1, out: '', err: 'not installed' });
  return new Promise(resolve => {
    const child = spawn(c.cmd, [...c.pre, ...args], { env: childEnv(name), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', code => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
}

// Generic JSONL process runner. Returns a handle { promise, kill }.
// extraEnv: added on top of the agent's environment; a null value removes that variable.
function mergeEnv(base, extra) {
  const env = { ...base };
  for (const [k, v] of Object.entries(extra || {})) { if (v === null || v === undefined) delete env[k]; else env[k] = String(v); }
  return env;
}
function runJsonl({ name, cmd, args, cwd, input, onEvent, onStderr, extraEnv }) {
  const child = spawn(cmd, args, { cwd, env: mergeEnv(childEnv(name), extraEnv), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { ev = { type: 'raw', text: line }; }
      try { onEvent(ev); } catch (e) { console.error('onEvent error', e); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); onStderr && onStderr(d); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const promise = new Promise(resolve => {
    child.on('error', err => resolve({ code: -1, stderr: String(err) }));
    child.on('close', code => {
      if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { onEvent({ type: 'raw', text: buf.trim() }); } }
      resolve({ code, stderr });
    });
  });
  return {
    promise,
    kill() {
      if (child.exitCode !== null) return;
      if (IS_WIN) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
      else child.kill('SIGTERM');
    },
  };
}

function shorten(s, n = 4000) {
  s = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
  return s && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s;
}

/**
 * Run Claude Code headless.
 * opts: { cwd, prompt, sessionId, systemPrompt, permissionMode, model, emit }
 * emit(kind, payload) receives normalized events.
 * Resolves to { ok, text, sessionId, costUsd, editedFiles, error }.
 */
// Claude subscription (Pro/Max) usage limit messages, e.g.
//   "Claude AI usage limit reached|1736460000"
//   "5-hour limit reached ∙ resets 3pm"   "You've hit your limit · resets 5:30am (Asia/Tehran)"
const isLimitText = t => /usage limit|limit reached|hit your limit|rate.?limit|resets? (at )?\d/i.test(String(t || ''));
// Returns the reset time (ms) or null when the message does not say.
function parseReset(text, now = Date.now()) {
  const t = String(text || '');
  const epoch = t.match(/\|\s*(\d{10,13})\b/);
  if (epoch) { const n = +epoch[1]; return n < 1e12 ? n * 1000 : n; }
  const m = t.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = +m[1]; const min = +(m[2] || 0); const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date(now); d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function runClaude(opts) {
  const c = CLIS.claude;
  if (!c) return { promise: Promise.resolve({ ok: false, error: 'Claude Code CLI پیدا نشد' }), kill() {} };
  const args = [...c.pre, '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', opts.permissionMode || 'acceptEdits'];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.maxBudgetUsd > 0) args.push('--max-budget-usd', opts.maxBudgetUsd.toFixed(2));
  if (opts.allowedTools && opts.allowedTools.length) args.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.agentsFile) args.push('--agents', opts.agentsFile); // with -p, a path to a JSON file of sub-agents
  // Read access to folders outside the project (e.g. sub-agent skill folders).
  for (const d of opts.addDirs || []) args.push('--add-dir', d);
  // Lean mode: a much smaller system prompt (no MCP servers, skills or user-level
  // hooks/plugins; only the tools this role needs) => cheaper and faster calls.
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig); // per-project MCP servers (JSON file)
  if (opts.lean) {
    args.push('--strict-mcp-config', '--setting-sources', 'project,local', '--disable-slash-commands');
    if (opts.tools && opts.tools.length) args.push('--tools', opts.tools.join(','));
  }
  if (opts.partial) args.push('--include-partial-messages');

  const result = { ok: false, text: '', sessionId: opts.sessionId || null, costUsd: 0, editedFiles: new Set(), error: null, budgetHit: false };
  const toolNames = {};
  const delegated = {}; // tool_use id of a Task/Agent call -> sub-agent name
  const h = runJsonl({
    name: CLIS.claude === c ? 'claude' : 'codex', cmd: c.cmd, args, cwd: opts.cwd, input: opts.prompt, extraEnv: opts.extraEnv,
    onEvent(ev) {
      // Events produced inside a delegated sub-agent carry parent_tool_use_id.
      const via = ev.parent_tool_use_id ? (delegated[ev.parent_tool_use_id] || 'sub-agent') : undefined;
      if (ev.type === 'system' && ev.subtype === 'init') {
        result.sessionId = ev.session_id || result.sessionId;
        opts.emit('status', { text: `مدل: ${prettyModel(ev.model) || '?'}${opts.effort ? ' · فکر: ' + opts.effort : ''} · ابزارها: ${(ev.tools || []).length} · مجوز: ${ev.permissionMode || '?'}`, model: ev.model });
      } else if (ev.type === 'stream_event' && ev.event) {
        // Live text (--include-partial-messages); the full text still arrives in the assistant event.
        const e = ev.event;
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') opts.emit('delta', { text: e.delta.text, via });
        else if (e.type === 'message_start' || (e.type === 'content_block_start' && e.content_block && e.content_block.type !== 'text')) opts.emit('delta_reset', { via });
      } else if (ev.type === 'assistant' && ev.message) {
        for (const b of ev.message.content || []) {
          if (b.type === 'text' && b.text.trim()) opts.emit('text', { text: b.text, via });
          else if (b.type === 'tool_use') {
            toolNames[b.id] = b.name;
            if ((b.name === 'Task' || b.name === 'Agent') && b.input) delegated[b.id] = b.input.subagent_type || b.input.description || 'sub-agent';
            const fp = b.input && (b.input.file_path || b.input.notebook_path);
            if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) result.editedFiles.add(fp);
            opts.emit('tool', { id: b.id, name: b.name, input: shorten(b.input, 3000), via, delegate: delegated[b.id] });
          }
        }
      } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'tool_result') {
            const content = Array.isArray(b.content) ? b.content.map(x => x.text || '').join('\n') : b.content;
            opts.emit('tool_result', { id: b.tool_use_id, name: toolNames[b.tool_use_id], isError: !!b.is_error, output: shorten(content || '', 3000), via });
          }
        }
      } else if (ev.type === 'result') {
        result.sessionId = ev.session_id || result.sessionId;
        result.costUsd = ev.total_cost_usd || 0;
        result.modelUsage = ev.modelUsage || null;
        result.text = ev.result || '';
        result.ok = !ev.is_error && !/^error/.test(ev.subtype || '');
        if (/budget/i.test(ev.subtype || '')) { result.budgetHit = true; result.ok = false; result.error = 'سقف هزینه‌ی این اجرا پر شد'; }
        else if (!result.ok) result.error = ev.result || ev.subtype || 'خطای ناشناخته';
      }
    },
  });
  const promise = h.promise.then(({ code, stderr }) => {
    if (!result.ok && !result.error) result.error = (stderr || `exit code ${code}`).trim().slice(-1500);
    result.editedFiles = [...result.editedFiles];
    if (!result.ok && isLimitText(result.error)) { result.limitHit = true; result.resetAt = parseReset(result.error); }
    return result;
  });
  return { promise, kill: h.kill };
}

/**
 * Run Codex headless (`codex exec`), optionally resuming a thread and
 * constraining the final message with a JSON schema.
 * opts: { cwd, prompt, threadId, sandbox, schemaFile, model, emit }
 * Resolves to { ok, text, threadId, usage, error, limitHit }.
 */
function runCodex(opts) {
  const c = CLIS.codex;
  if (!c) return { promise: Promise.resolve({ ok: false, error: 'Codex CLI پیدا نشد' }), kill() {} };
  const lastFile = path.join(os.tmpdir(), `jarvis-codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const args = [...c.pre, 'exec'];
  if (opts.threadId) args.push('resume', opts.threadId);
  args.push('--json', '--skip-git-repo-check',
    '-c', `sandbox_mode="${opts.sandbox || 'workspace-write'}"`,
    '-c', 'approval_policy="never"',
    '-o', lastFile);
  if (opts.schemaFile) args.push('--output-schema', opts.schemaFile);
  for (const c of opts.configArgs || []) args.push('-c', c); // e.g. a custom model provider
  if (opts.model) args.push('-m', opts.model);
  if (/^(minimal|low|medium|high)$/.test(opts.effort || '')) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  args.push('-');

  const result = { ok: false, text: '', threadId: opts.threadId || null, usage: null, error: null, limitHit: false, model: opts.model || codexConfigModel() };
  const warned = new Set();
  const h = runJsonl({
    name: CLIS.claude === c ? 'claude' : 'codex', cmd: c.cmd, args, cwd: opts.cwd, input: opts.prompt, extraEnv: opts.extraEnv,
    onEvent(ev) {
      const t = ev.type || '';
      if (t === 'thread.started') {
        result.threadId = ev.thread_id;
        opts.emit('status', { text: `مدل: ${prettyModel(result.model) || 'پیش‌فرض Codex'}${opts.effort ? ' · فکر: ' + opts.effort : ''} · سندباکس: ${opts.sandbox || 'workspace-write'}`, model: result.model });
      }
      else if (t === 'item.started' || t === 'item.completed' || t === 'item.updated') {
        const it = ev.item || {};
        const done = t === 'item.completed';
        switch (it.type) {
          case 'agent_message': if (done && it.text) opts.emit('text', { text: it.text }); break;
          case 'reasoning': if (done && it.text) opts.emit('thinking', { text: shorten(it.text, 1500) }); break;
          case 'command_execution':
            if (t === 'item.started') opts.emit('tool', { id: it.id, name: 'shell', input: it.command });
            else if (done) opts.emit('tool_result', { id: it.id, name: 'shell', isError: it.exit_code ? it.exit_code !== 0 : it.status === 'failed', output: shorten(it.aggregated_output || '', 3000), exitCode: it.exit_code });
            break;
          case 'file_change': if (done) opts.emit('tool', { id: it.id, name: 'file_change', input: shorten(it.changes || it, 1500) }); break;
          case 'todo_list': if (done || t === 'item.updated') opts.emit('status', { text: (it.items || []).map(x => `${x.completed ? '✔' : '○'} ${x.text}`).join('\n') }); break;
          case 'error': {
            // Config/deprecation notices arrive as "error" items but don't stop the turn.
            const msg = it.message || JSON.stringify(it);
            if (/unrecognized configuration|deprecated|is ignoring/i.test(msg)) { if (!warned.has(msg)) { warned.add(msg); opts.emit('status', { text: '⚠️ Codex: ' + msg }); } }
            else opts.emit('error', { text: msg });
            break;
          }
          default: if (done && it.type) opts.emit('tool', { id: it.id, name: it.type, input: shorten(it, 1200) });
        }
      } else if (t === 'turn.completed') { result.usage = ev.usage || null; result.ok = true; }
      else if (t === 'turn.failed' || t === 'error') {
        const msg = (ev.error && ev.error.message) || ev.message || 'خطای Codex';
        result.error = msg;
        if (/usage limit|rate limit|quota|credits/i.test(msg)) result.limitHit = true;
      }
    },
  });
  const promise = h.promise.then(({ code, stderr }) => {
    try { result.text = fs.readFileSync(lastFile, 'utf8').trim(); fs.unlinkSync(lastFile); } catch {}
    if (result.error) result.ok = false;
    if (!result.ok && !result.error) result.error = (stderr || `exit code ${code}`).trim().slice(-1500);
    if (result.error && /usage limit|rate limit|quota|credits/i.test(result.error)) result.limitHit = true;
    return result;
  });
  return { promise, kill: h.kill };
}

module.exports = { mergeEnv, isLimitText, parseReset, CLIS, refreshClis, setAuthEnv, version, runOnce, runClaude, runCodex, which, codexConfigModel };
