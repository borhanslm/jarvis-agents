// Team workflows: Claude Code = builder, Codex = analyst/tester,
// plus optional specialist sub-agents (parallel reviewers and delegated builders).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runClaude, runCodex } = require('./agents');
const git = require('./git');
const graph = require('./graph');
const { prettyModel } = require('./models');

// Codex (a separate process) must be able to read this file; inside the packaged
// desktop app it lives in app.asar.unpacked, not in the app.asar archive.
const SCHEMA_FILE = (() => {
  const p = path.join(__dirname, '..', 'review-schema.json');
  const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return unpacked !== p && fs.existsSync(unpacked) ? unpacked : p;
})();

const BUILDER_SYSTEM = `You are the BUILDER in the JARVIS agent team.
- You write and fix all of the code.
- Your teammate, the tester, is a separate AI agent: after you finish it will review your changes, run builds/tests, and report bugs back to you.
- Make complete, working changes. Add or update tests when it makes sense, and run them if you can.
- When you finish, end with a short summary: what you changed (files), how to run/test it, and anything the tester should pay attention to.`;

const REVIEW_RULES = `You are the ANALYST & TESTER in the JARVIS agent team. Another AI agent (the builder) wrote the code; you review and test its work.
Rules:
- Do NOT edit or create project source files. Only read, analyse and run commands (build, lint, type-check, tests, quick scripts). Throwaway files go in the OS temp folder only.
- Inspect the actual changes (use \`git diff\` / \`git status\` if this is a git repo, otherwise read the listed files).
- Run whatever build/test/lint commands the project has. Try important edge cases.
- Report only real, concrete problems: bugs, crashes, broken tests, security issues, missing requirements. Not style nitpicks (put minor ones as severity "minor").
- verdict = "pass" only if there is no critical or major issue and the task's requirements are met.
- Answer in the JSON shape required by the output schema. Write summary/titles/descriptions in Persian (Farsi); keep code, paths and commands as-is.`;

const JSON_TAIL = `\n\nEnd your answer with ONLY a JSON object (in a \`\`\`json block) of shape:
{"verdict":"pass|fail","summary":"...","tests_run":[{"command":"...","result":"..."}],"bugs":[{"severity":"critical|major|minor","title":"...","file":"...|null","line":0,"description":"...","fix_hint":"..."}]}`;

const REVIEWER_SYSTEM = 'You are an independent code reviewer and tester. You did not write this code. Never edit project files.';

function fmtBugs(bugs) {
  return bugs.map((b, i) =>
    `${i + 1}. [${b.severity}]${b.by ? ` (${b.by})` : ''} ${b.title}${b.file ? ` — ${b.file}${b.line ? ':' + b.line : ''}` : ''}\n   ${b.description}${b.fix_hint ? `\n   Fix hint: ${b.fix_hint}` : ''}`
  ).join('\n');
}

function parseReview(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fence) t = fence[fence.length - 1].replace(/```(?:json)?/g, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try {
    const r = JSON.parse(t.slice(s, e + 1));
    if (!r.verdict) return null;
    r.bugs = Array.isArray(r.bugs) ? r.bugs : [];
    r.tests_run = Array.isArray(r.tests_run) ? r.tests_run : [];
    return r;
  } catch { return null; }
}

// Combine the main tester's review with specialist reviews into one fix list.
function mergeReviews(parts) {
  const ok = parts.filter(p => p.review);
  if (!ok.length) return null;
  const blocking = b => b.severity === 'critical' || b.severity === 'major';
  return {
    verdict: ok.some(p => p.review.verdict === 'fail' && (p.main || p.review.bugs.some(blocking))) ? 'fail' : 'pass',
    summary: ok.map(p => (p.main ? '' : `[${p.by}] `) + (p.review.summary || '')).join('\n'),
    tests_run: ok.flatMap(p => p.review.tests_run),
    bugs: ok.flatMap(p => p.review.bugs.map(b => ({ ...b, by: p.main ? undefined : p.by }))),
  };
}

// Shell commands the builder may run without a prompt: "npm test" -> Bash(npm test) + Bash(npm test *)
// (and the same for the PowerShell tool, which Claude Code uses on Windows).
function bashRules(list) {
  const tools = process.platform === 'win32' ? ['Bash', 'PowerShell'] : ['Bash'];
  return (list || []).map(c => String(c).trim()).filter(c => c && !/[()]/.test(c))
    .flatMap(c => tools.flatMap(t => [`${t}(${c})`, `${t}(${c} *)`]));
}

// Tools each Claude role gets in lean mode (smaller system prompt = cheaper, faster).
const ROLE_TOOLS = {
  builder: ['Task', 'Bash', 'PowerShell', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'WebSearch', 'TodoWrite'],
  plan: ['Read', 'Glob', 'Grep', 'WebSearch', 'ExitPlanMode'],
  reviewer: ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell'],
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Prefix for Codex when it stands in for Claude as the builder.
const CODEX_BUILDER = 'You are the BUILDER on this team right now (the usual builder is temporarily unavailable). ' +
  'Make the code changes yourself directly in the workspace — implement or fix as asked, keep changes focused, ' +
  'run the relevant tests if the project has them, then summarise what you changed and anything left to do.\n\n';

const testrun = require('./testrun');

const SUMMARY_PROMPT = 'Summarize our whole conversation so far so that a fresh session can continue the work: the goal, the decisions made, the files created or changed, the current state, open problems and the next steps. Be concise (at most about 400 words), use bullet points, and write in the same language the user used. Do not change any files.';
const MEMORY_PROMPT = 'Based on this conversation and what you learned about this project, list up to 6 short, durable rules or facts that would help a future developer or AI agent work on THIS project without repeating mistakes: conventions, commands to run, gotchas, decisions taken. One per line, each line starting with "- ". Write them in the same language the user used. Output nothing else. Do not change any files.';

// Smart mode: a cheap planner splits the request; each part runs on the model its difficulty needs.
const ROUTER_SYSTEM = 'You are the planner of an AI coding team. You never write code or change files; you only split work.';
const ROUTER_PROMPT = `Split the request below into 1 to 6 sequential subtasks for coding agents.
For each subtask give:
- "title": a short title in the same language as the request
- "level": "hard" (architecture, tricky algorithms, security-critical code, cross-cutting refactors), "medium" (normal feature code and bug fixes) or "easy" (tests, docs, config, renames, styling, boilerplate)
- "prompt": a complete, self-contained English instruction for the agent doing that part
Rules: a small or simple request is exactly ONE subtask. Do not split work that must be designed together. Order subtasks so each builds on the previous ones. You may look at the project's files briefly, but do not change anything.
Reply with ONLY this JSON and nothing else:
{"subtasks":[{"title":"...","level":"hard|medium|easy","prompt":"..."}]}

== Request ==
`;
// Rough cost of one build step per model when there is no usage history yet ($, API prices).
const STEP_COST_GUESS = { 'claude-fable-5-2': 1.2, 'claude-opus-5-5': 0.6, 'claude-sonnet-5-5': 0.3, 'claude-haiku-5-5': 0.08 };
const LEVEL_FA = { hard: 'سخت', medium: 'متوسط', easy: 'ساده' };

function parseRoute(text) {
  const t = String(text || '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < s) return null;
  try {
    const j = JSON.parse(t.slice(s, e + 1));
    const list = (Array.isArray(j.subtasks) ? j.subtasks : []).slice(0, 6).map(x => ({
      title: String(x.title || '').trim().slice(0, 120) || 'بخش',
      level: ['hard', 'medium', 'easy'].includes(x.level) ? x.level : 'medium',
      prompt: String(x.prompt || '').trim().slice(0, 6000),
    })).filter(x => x.prompt);
    return list.length ? list : null;
  } catch { return null; }
}

// Dollar cost of a connection step from its token counts and the prices entered for it ($ per 1M tokens).
function providerCost(prov, tokens) {
  const p = (prov && prov.prices) || {};
  const pin = +p.in || 0, pout = +p.out || 0, pc = +p.cached > 0 ? +p.cached : pin;
  return ((tokens.input || 0) * pin + (tokens.cacheWrite || 0) * pin + (tokens.cacheRead || 0) * pc + (tokens.output || 0) * pout) / 1e6;
}

class Orchestrator {
  constructor({ store, broadcast, usage = null, skills = null }) {
    this.store = store;
    this.skills = skills; // lib/skills.js (optional)
    this.usage = usage; // lib/usage.js (optional)
    this.broadcast = broadcast;
    this.running = new Map();     // chatId -> { kills:Set, cancelled, inbox:[] }
    this.projectRuns = new Map(); // projectId -> chatId holding the project lock
    this.agentState = { claude: { busy: 0, last: null }, codex: { busy: 0, last: null, limitHit: null } };
  }

  isRunning(chatId) { return this.running.has(chatId); }

  stop(chatId) {
    const r = this.running.get(chatId);
    if (!r) return false;
    r.cancelled = true;
    for (const k of r.kills) k();
    if (r.approve) r.approve(null); // a smart-mode plan waiting for approval
    return true;
  }

  // ---- message queue: user messages sent while a run is in progress --------
  // They are delivered to Claude at its next builder step; anything left when the
  // flow ends starts a follow-up round in the same mode.
  enqueue(chat, text) {
    const r = this.running.get(chat.id);
    if (!r) return null;
    const m = this.post(chat, { agent: 'user', kind: 'text', text, queued: true });
    r.inbox.push({ id: m.id, text });
    this.broadcast({ type: 'queue', chatId: chat.id, pending: r.inbox.length });
    return m;
  }

  drainInbox(chat, ctx) {
    const items = ctx.run.inbox.splice(0);
    if (!items.length) return '';
    this.post(chat, { agent: 'system', kind: 'delivered', ids: items.map(i => i.id),
      text: `📨 ${items.length} پیام شما به سازنده تحویل شد` });
    this.broadcast({ type: 'queue', chatId: chat.id, pending: 0 });
    return items.map(i => i.text).join('\n\n');
  }

  // Append a message to the chat and push it to all browsers.
  post(chat, msg) {
    const m = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), ...msg };
    chat.messages.push(m);
    this.store.saveChat(chat);
    this.broadcast({ type: 'message', chatId: chat.id, message: m });
    return m;
  }

  setStatus(chat, status) {
    chat.status = status;
    this.store.saveChat(chat);
    this.broadcast({ type: 'chat', chat: this.store.chatSummary(chat) });
  }

  agentBusy(name, delta, info) {
    const a = this.agentState[name];
    a.busy = Math.max(0, a.busy + delta);
    if (info) a.last = info;
    this.broadcast({ type: 'agents', agents: this.agentState });
  }

  // Sub-agents Claude Code can delegate to while building (passed with --agents).
  builderAgentsFile() {
    const subs = this.store.subagents().filter(a => a.enabled && a.stage === 'builder');
    if (!subs.length) return null;
    const def = {}, dirs = [];
    for (const a of subs) {
      const sk = this.skillsFor(a);
      def[a.name] = { description: a.description || a.name, prompt: a.prompt + sk.block };
      dirs.push(...sk.dirs);
    }
    const f = path.join(os.tmpdir(), `jarvis-agents-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(f, JSON.stringify(def));
    return { file: f, names: subs.map(a => a.name), dirs };
  }

  // A sub-agent's skills: prompt block + folders it must be able to read.
  skillsFor(sub) {
    if (!this.skills || !sub || !sub.skills || !sub.skills.length) return { block: '', dirs: [], names: [] };
    return this.skills.forAgent(sub.skills);
  }
  noteSkills(chat, ctx, sub, sk) {
    if (!sk.names.length) return;
    ctx.skillNoted = ctx.skillNoted || new Set();
    if (ctx.skillNoted.has(sub.id)) return;
    ctx.skillNoted.add(sub.id);
    this.post(chat, { agent: 'system', kind: 'status', sub: `${sub.icon} ${sub.name}`, text: `🧩 اسکیل‌های این ساب‌ایجنت: ${sk.names.join('، ')}` });
  }

  // MCP servers for a role: connectors given to that role + the project's own mcpConfig JSON.
  // role: builder | reviewer | subs
  mcpFor(s, role) {
    let proj = null;
    if (s.mcpConfig && String(s.mcpConfig).trim()) { try { proj = JSON.parse(s.mcpConfig); } catch {} }
    const list = this.connectors ? this.connectors.forRole(role) : [];
    const cfg = this.connectors ? this.connectors.claudeConfig(list, proj) : (proj && proj.mcpServers && Object.keys(proj.mcpServers).length ? { mcpServers: proj.mcpServers } : null);
    const all = this.connectors ? [...list, ...this.connectors.fromConfig(proj)] : [];
    return { cfg, names: list.map(r => r.label || r.name), codexArgs: this.connectors ? this.connectors.codexArgs(all) : [] };
  }
  noteConnectors(chat, ctx, step, names) {
    ctx.mcpNoted = ctx.mcpNoted || new Set();
    const key = (step.sub || step.agent) + names.join(',');
    if (ctx.mcpNoted.has(key)) return;
    ctx.mcpNoted.add(key);
    this.post(chat, { agent: 'system', kind: 'status', text: `🔌 اتصال‌دهنده‌ها${step.sub ? ' برای ' + step.sub : ''}: ${names.join('، ')}` });
  }

  // "p:<connection>:<model>" -> how to run it (set by the server), or null.
  provider(spec) { return spec && this.resolveProvider ? this.resolveProvider(spec) : null; }
  // models no coding CLI can run (chat-only connections like Gemini/Grok/OpenRouter-Qwen/Groq/NVIDIA,
  // Ollama, Kimi and free Gemini sign-ins): they work through JARVIS's own small coding agent
  llmOnly(spec) {
    if (!spec || !this.chatLLM) return false;
    if (/^(ollama:|kimi(:|$)|agy(:|$))/.test(spec)) return true;
    const pv = this.provider(spec); return !!(pv && pv.chatOnly);
  }
  async llmStep(chat, ctx, { prompt, system, phase, round, role, spec, sub = null }) {
    const s = ctx.s, writer = role === 'builder';
    const pv = this.provider(spec), label = pv ? pv.label : spec;
    const step = { agent: 'claude', phase, round, sub: sub ? `${sub.icon} ${sub.name}` : label };
    // a missing key or a wrong model is reported by chatLLM itself
    if (writer) { const extra = this.drainInbox(chat, ctx); if (extra) prompt += `\n\n== New instructions from the user ==\n${extra}`; }
    this.post(chat, { ...step, kind: 'phase', text: `${phase} — ${label}` });
    this.agentBusy('claude', +1, `${chat.title} · ${phase}`);
    const ac = new AbortController(); const kill = () => ac.abort(); ctx.run.kills.add(kill);
    let res;
    try {
      res = await require('./mini-agent').runCoder({
        llm: o => this.chatLLM({ spec, ...o }), cwd: ctx.cwd, role: writer ? 'builder' : 'reviewer', signal: ac.signal,
        system: (system || (writer ? BUILDER_SYSTEM : REVIEWER_SYSTEM)) + (ctx.graphBlock || ''), prompt: this.withHints(ctx, 'llm_' + (sub ? sub.id : role), prompt),
        allowed: [...(s.claudeAllowedBash || []), ...(s.testCommand ? [s.testCommand] : [])], runTimeoutSec: +s.testTimeoutSec || 300,
        onEvent: ev => this.post(chat, { ...step, kind: 'tool', text: `${ev.tool} ${ev.path}`.trim().slice(0, 200) }),
      });
    } finally { ctx.run.kills.delete(kill); this.agentBusy('claude', -1); }
    const cost = pv && pv.prices ? providerCost(pv, { input: res.usage && res.usage.input, output: res.usage && res.usage.output }) : 0;
    res.costUsd = cost; ctx.runCost += cost; chat.cost.otherUsd = +((chat.cost.otherUsd || 0) + cost).toFixed(4);
    if (this.usage && res.usage) { this.usage.log({ agent: 'custom', model: label, costUsd: cost, input: res.usage.input, output: res.usage.output }); this.broadcast({ type: 'usage' }); }
    for (const f of res.editedFiles || []) if (!chat.touchedFiles.includes(f)) chat.touchedFiles.push(f);
    if (res.ok && writer && res.text) this.post(chat, { ...step, kind: 'text', text: res.text });
    if (!res.ok && !ctx.run.cancelled) this.post(chat, { ...step, kind: 'error', text: res.error || 'خطا' });
    this.store.saveChat(chat);
    this.broadcast({ type: 'chat', chat: this.store.chatSummary(chat) });
    return res;
  }

  // Remaining Claude budget for this run (Infinity when there is no cap).
  budgetLeft(ctx) {
    // On a Pro/Max subscription the dollar figure is only an API-equivalent estimate: no cap unless asked.
    if (ctx.subscription && !ctx.s.budgetOnSubscription) return Infinity;
    const cap = +ctx.s.maxRunCostUsd || 0;
    return cap > 0 ? cap - ctx.runCost : Infinity;
  }

  // ---- single agent steps --------------------------------------------------

  // role: builder | plan | reviewer | specialist — picks model, effort and tools.
  async claudeStep(chat, ctx, { prompt, phase, round, role = 'builder', system, permissionMode, sessionKey = 'claudeSession',
    allowedTools, hideText = false, sub = null, addDirs = [], modelOverride = null }) {
    const s = ctx.s;
    const step = { agent: 'claude', phase, round, sub: sub ? `${sub.icon} ${sub.name}` : undefined };
    // Stop pressed while preparing (lock wait, checkpoint, graph build): never launch.
    if (ctx.run.cancelled) return { ok: false, cancelled: true, error: 'stopped' };
    const left = this.budgetLeft(ctx);
    if (left <= 0.005) {
      ctx.budgetHit = true;
      return { ok: false, budgetHit: true, error: 'budget' };
    }
    const lim = this.agentState.claude.limitHit;
    if (lim && lim.until && lim.until < Date.now()) { this.agentState.claude.limitHit = null; this.broadcast({ type: 'agents', agents: this.agentState }); }
    const canSwap = () => role === 'builder' && !sub && ctx.subscription && s.onClaudeLimit === 'codex' && !ctx.codexLimited;
    if (canSwap() && Math.max(ctx.claudeLimitedUntil || 0, (this.agentState.claude.limitHit || {}).until || 0) > Date.now()) return this.codexAsBuilder(chat, ctx, { prompt, phase, round });
    {
      let want = modelOverride || { builder: s.builderModel, plan: s.builderModel, reviewer: s.reviewerModel, specialist: s.specialistModel }[role];
      if (/^chatgpt(:|$)/.test(String(want || ''))) want = 'codex' + String(want).slice(7); // ChatGPT sign-in = Codex
      if (this.llmOnly(want)) return this.llmStep(chat, ctx, { prompt, system, phase, round, role: role === 'plan' ? 'reviewer' : role, spec: want, sub });
      if (role === 'builder' && /^codex(:|$)/.test(String(want || ''))) return this.codexAsBuilder(chat, ctx, { prompt, phase, round, modelOverride: String(want).slice(6) || '__codex_default', label: 'Codex', threadKey: `${sessionKey}_cxb` });
      const pv = this.provider(want);
      if (pv && pv.engine === 'codex') {
        if (role === 'builder') return this.codexAsBuilder(chat, ctx, { prompt, phase, round, modelOverride: want, label: pv.label });
        return this.codexStep(chat, ctx, { prompt: (system ? system + '\n\n' : '') + prompt, phase, round, sandbox: 'read-only', threadKey: `${sessionKey}_cx`, sub, modelOverride: want });
      }
    }
    this.post(chat, { ...step, kind: 'phase', text: phase });
    this.agentBusy('claude', +1, `${chat.title} · ${phase}`);

    const builder = role === 'builder';
    let model = modelOverride || { builder: s.builderModel, plan: s.builderModel, reviewer: s.reviewerModel, specialist: s.specialistModel }[role] || undefined;
    const prov = this.provider(model);
    if (prov) {
      if (prov.missing || !prov.hasKey) { this.agentBusy('claude', -1); const err = prov.missing ? `اتصال «${prov.id}» حذف شده است؛ در تنظیمات مدل دیگری انتخاب کنید.` : `کلید API اتصال «${prov.name}» تنظیم نشده است.`; this.post(chat, { ...step, kind: 'error', text: err }); return { ok: false, error: err }; }
      model = prov.model; sessionKey = `${sessionKey}__${prov.id}`; step.name = prov.label;
    }
    const effort = /haiku/i.test(model || '') ? undefined : ({ builder: s.builderEffort, plan: s.builderEffort, reviewer: s.reviewerEffort, specialist: s.specialistEffort }[role] || undefined);
    const tools = ROLE_TOOLS[role === 'specialist' ? 'reviewer' : role];
    system = (system || BUILDER_SYSTEM) + (ctx.graphBlock || '');

    let agentsFile = null;
    if (builder) {
      const extra = this.drainInbox(chat, ctx);
      if (extra) prompt += `\n\n== New instructions from the user (sent while the team was working — take them into account) ==\n${extra}`;
      allowedTools = [...(allowedTools || []), ...bashRules(s.claudeAllowedBash), ...(ctx.graphBlock ? bashRules(graph.ALLOWED) : [])];
      // Skills from plugins that bring no agents of their own go to the builder itself.
      const ps = this.pluginSkills && this.skills ? this.pluginSkills() : [];
      if (ps.length) {
        const sk = this.skills.forAgent(ps);
        if (sk.block) { system += sk.block; addDirs = [...(addDirs || []), ...sk.dirs]; }
      }
      const ba = this.builderAgentsFile();
      if (ba) {
        agentsFile = ba.file;
        addDirs = [...(addDirs || []), ...ba.dirs];
        allowedTools.push('Task', 'Agent');
        system += `\n- You have specialist sub-agents you can delegate to with the Task/Agent tool: ${ba.names.join(', ')}. Use them when their description fits.`;
      }
    }
    const live = s.liveStreaming && !hideText;
    if (chat.carryOver && !chat[sessionKey]) prompt = `== Summary of the earlier conversation (for context) ==\n${chat.carryOver}\n\n== Current request ==\n${prompt}`;
    prompt = this.withHints(ctx, sessionKey, prompt);
    // Connectors (MCP servers) for this role, plus the project's own MCP config.
    let mcpConfig = null;
    const mcp = this.mcpFor(s, sub ? 'subs' : (builder || role === 'plan') ? 'builder' : 'reviewer');
    if (mcp.cfg) {
      try {
        mcpConfig = this.connectors ? this.connectors.writeClaudeConfig(mcp.cfg) : path.join(os.tmpdir(), `jarvis-mcp-${chat.id}-${Date.now()}.json`);
        if (!this.connectors) fs.writeFileSync(mcpConfig, JSON.stringify(mcp.cfg));
        allowedTools = [...(allowedTools || []), ...Object.keys(mcp.cfg.mcpServers).map(n => 'mcp__' + n)];
        if (mcp.names.length) this.noteConnectors(chat, ctx, step, mcp.names);
      } catch { mcpConfig = null; }
    }
    let res, waits = 0, swapped = false;
    for (;;) {
    const h = runClaude({
      cwd: ctx.cwd, prompt, sessionId: chat[sessionKey], systemPrompt: system,
      permissionMode: permissionMode || (role === 'plan' ? 'plan' : builder ? s.claudePermission : 'default'),
      model, effort, allowedTools, agentsFile, addDirs: [...(addDirs || []), ...(ctx.extraDirs || [])], mcpConfig, extraEnv: prov ? prov.env : undefined,
      lean: s.leanMode, tools, partial: live,
      maxBudgetUsd: Number.isFinite(left) ? left : 0,
      emit: (kind, p) => {
        if (kind === 'delta' || kind === 'delta_reset') {
          if (live || p.via) this.broadcast({ type: kind, chatId: chat.id, agent: 'claude', sub: step.sub, via: p.via, text: p.text });
          return;
        }
        if (!(hideText && kind === 'text' && !p.via)) this.post(chat, { ...step, kind, ...p });
      },
    });
    ctx.run.kills.add(h.kill);
    res = await h.promise;
    ctx.run.kills.delete(h.kill);
    if (prov) res.costUsd = Object.values(res.modelUsage || {}).reduce((c, u) => c + providerCost(prov, { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens }), 0);
    if (prov || !res.limitHit || !ctx.subscription || ctx.run.cancelled || (!s.waitOnLimit && !canSwap()) || waits >= 3) break;
    // Subscription limit: wait until it resets, then continue the same session.
    const maxWait = (+s.limitMaxWaitHours || 6) * 3600000;
    const until = Math.min(Date.now() + maxWait, res.resetAt && res.resetAt > Date.now() ? res.resetAt + 60000 : Date.now() + 30 * 60000);
    waits++;
    if (res.sessionId) chat[sessionKey] = res.sessionId;
    ctx.runCost += res.costUsd || 0;
    chat.cost.claudeUsd = +(chat.cost.claudeUsd + (res.costUsd || 0)).toFixed(4); // the interrupted attempt cost money too
    const at = new Date(until).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    this.agentState.claude.limitHit = { text: res.error, until };
    this.broadcast({ type: 'agents', agents: this.agentState });
    if (canSwap()) { ctx.claudeLimitedUntil = until; swapped = at; res.costUsd = 0; break; }
    this.setStatus(chat, 'waiting');
    this.post(chat, { ...step, kind: 'status', text: `⏳ سهمیه‌ی Claude پر شد. ساعت ${at} خودکار ادامه می‌دهم. (برای لغو، «توقف» را بزنید)` });
    while (Date.now() < until && !ctx.run.cancelled) await new Promise(r => setTimeout(r, Math.min(15000, until - Date.now())));
    this.agentState.claude.limitHit = null;
    this.broadcast({ type: 'agents', agents: this.agentState });
    if (ctx.run.cancelled) break;
    this.setStatus(chat, 'running');
    this.post(chat, { ...step, kind: 'status', text: '▶️ سهمیه تمدید شد؛ ادامه‌ی کار' });
    prompt = 'Continue the task from where you stopped (you were interrupted by a usage limit). Do not repeat finished work.';
    }
    if (agentsFile) fs.rm(agentsFile, { force: true }, () => {});
    if (mcpConfig) fs.rm(mcpConfig, { force: true }, () => {}); // may hold connector secrets
    this.agentBusy('claude', -1);
    if (res.sessionId) chat[sessionKey] = res.sessionId;
    ctx.runCost += res.costUsd || 0;
    if (this.usage && res.modelUsage) {
      for (const [model, u] of Object.entries(res.modelUsage)) {
        this.usage.log({ agent: prov ? 'custom' : 'claude', model: prov ? `${prov.name}/${model}` : model, costUsd: prov ? providerCost(prov, { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens }) : u.costUSD, role: sub ? 'specialist' : role, chatId: chat.id, projectId: ctx.projectId,
          input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens,
          graph: !!ctx.graphBlock });
      }
      this.broadcast({ type: 'usage' });
    }
    if (prov) chat.cost.otherUsd = +((chat.cost.otherUsd || 0) + (res.costUsd || 0)).toFixed(4);
    else chat.cost.claudeUsd = +(chat.cost.claudeUsd + (res.costUsd || 0)).toFixed(4);
    for (const f of res.editedFiles || []) if (!chat.touchedFiles.includes(f)) chat.touchedFiles.push(f);
    if (res.budgetHit) ctx.budgetHit = true;
    if (!res.ok && !ctx.run.cancelled && !res.budgetHit && !swapped) this.post(chat, { ...step, kind: 'error', text: res.error });
    this.broadcast({ type: 'delta_reset', chatId: chat.id });
    this.store.saveChat(chat);
    this.broadcast({ type: 'chat', chat: this.store.chatSummary(chat) }); // live cost update
    if (swapped) {
      this.post(chat, { ...step, kind: 'status', text: `🔁 سهمیه‌ی Claude پر شد. تا ساعت ${swapped}، Codex جای او کد می‌نویسد؛ بعد از تمدید، Claude برمی‌گردد.` });
      return this.codexAsBuilder(chat, ctx, { prompt, phase, round });
    }
    return res;
  }

  // Codex in the builder role (used while Claude's subscription limit is in effect).
  async codexAsBuilder(chat, ctx, { prompt, phase, round, modelOverride = null, label = null, threadKey = 'codexBuilderThread' }) {
    const extra = this.drainInbox(chat, ctx);
    if (extra) prompt += `\n\n== New instructions from the user (sent while the team was working — take them into account) ==\n${extra}`;
    const res = await this.codexStep(chat, ctx, {
      prompt: CODEX_BUILDER + prompt, phase: label ? phase : `${phase} · Codex به‌جای Claude`, round,
      sandbox: 'workspace-write', threadKey, modelOverride,
    });
    return { ...res, viaCodex: true, editedFiles: [] };
  }

  async codexStep(chat, ctx, { prompt, phase, round, schema = false, sandbox, threadKey = 'codexThread', sub = null, modelOverride = null }) {
    const s = ctx.s;
    const step = { agent: 'codex', phase, round, sub: sub ? `${sub.icon} ${sub.name}` : undefined };
    let cmodel = modelOverride === '__codex_default' ? undefined : (modelOverride || s.codexModel || undefined);
    const prov = this.provider(cmodel);
    if (!prov && /^claude-/.test(cmodel || '')) {
      // a Claude model chosen for this slot: run it on the Claude engine
      const ro = !sandbox || sandbox === 'read-only';
      return this.claudeStep(chat, ctx, { prompt: prompt + (schema ? JSON_TAIL : ''), phase, round, sub, role: ro ? 'reviewer' : 'builder', modelOverride: cmodel,
        system: ro ? REVIEWER_SYSTEM : undefined, sessionKey: `${threadKey}_cl`, hideText: !!schema,
        ...(ro ? { allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell'] } : {}) });
    }
    if (prov) {
      if (prov.missing || !prov.hasKey) { const err = prov.missing ? `اتصال «${prov.id}» حذف شده است.` : `کلید API اتصال «${prov.name}» تنظیم نشده است.`; this.post(chat, { ...step, kind: 'error', text: err }); return { ok: false, error: err }; }
      if (prov.engine === 'claude') {
        const ro = !sandbox || sandbox === 'read-only';
        return this.claudeStep(chat, ctx, { prompt: prompt + (schema ? JSON_TAIL : ''), phase, round, sub, role: ro ? 'reviewer' : 'builder', modelOverride: modelOverride || s.codexModel,
          system: ro ? REVIEWER_SYSTEM : undefined, sessionKey: `${threadKey}_cl`, hideText: !!schema,
          ...(ro ? { allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell'] } : {}) });
      }
      cmodel = prov.model; threadKey = `${threadKey}__${prov.id}`; step.name = prov.label;
    }
    if (ctx.run.cancelled) return { ok: false, cancelled: true, error: 'stopped' };
    this.post(chat, { ...step, kind: 'phase', text: phase });
    this.agentBusy('codex', +1, `${chat.title} · ${phase}`);
    if (chat.carryOver && !chat[threadKey]) prompt = `== Summary of the earlier conversation (for context) ==\n${chat.carryOver}\n\n== Current request ==\n${prompt}`;
    prompt = this.withHints(ctx, threadKey, prompt);
    if (ctx.graphBlock) prompt = ctx.graphBlock.trim() + '\n\n' + prompt;
    const mcp = this.mcpFor(s, sub ? 'subs' : (schema || sandbox === 'read-only') ? 'reviewer' : 'builder');
    if (mcp.names.length) this.noteConnectors(chat, ctx, step, mcp.names);
    const h = runCodex({
      cwd: ctx.cwd, prompt, threadId: chat[threadKey],
      sandbox: sandbox || s.codexSandbox, schemaFile: schema ? SCHEMA_FILE : null,
      model: cmodel, effort: s.codexEffort || undefined, extraEnv: prov ? prov.env : undefined, configArgs: [...(prov ? prov.configArgs : []), ...mcp.codexArgs],
      emit: (kind, p) => { if (!(schema && kind === 'text')) this.post(chat, { ...step, kind, ...p }); },
    });
    ctx.run.kills.add(h.kill);
    const res = await h.promise;
    ctx.run.kills.delete(h.kill);
    this.agentBusy('codex', -1);
    if (res.threadId) chat[threadKey] = res.threadId;
    if (res.usage) chat.cost.codexTokens += (res.usage.input_tokens || 0) + (res.usage.output_tokens || 0);
    let pcost = 0;
    if (prov && res.usage) {
      const cached0 = res.usage.cached_input_tokens || 0;
      pcost = providerCost(prov, { input: Math.max(0, (res.usage.input_tokens || 0) - cached0), cacheRead: cached0, output: res.usage.output_tokens || 0 });
      ctx.runCost += pcost;
      chat.cost.otherUsd = +((chat.cost.otherUsd || 0) + pcost).toFixed(4);
    }
    if (this.usage && res.usage) {
      const cached = res.usage.cached_input_tokens || 0;
      this.usage.log({ agent: prov ? 'custom' : 'codex', model: prov ? `${prov.name}/${prov.model}` : res.model, role: sub ? 'specialist' : schema ? 'reviewer' : 'codex', chatId: chat.id, projectId: ctx.projectId,
        input: Math.max(0, (res.usage.input_tokens || 0) - cached), cacheRead: cached, output: res.usage.output_tokens || 0, costUsd: pcost, graph: !!ctx.graphBlock });
      this.broadcast({ type: 'usage' });
    }
    if (res.limitHit) { ctx.codexLimited = true; this.agentState.codex.limitHit = res.error; this.broadcast({ type: 'agents', agents: this.agentState }); }
    else if (res.ok && this.agentState.codex.limitHit) { this.agentState.codex.limitHit = null; this.broadcast({ type: 'agents', agents: this.agentState }); }
    if (!res.ok && !ctx.run.cancelled) this.post(chat, { ...step, kind: 'error', text: res.error });
    this.store.saveChat(chat);
    this.broadcast({ type: 'chat', chat: this.store.chatSummary(chat) });
    return res;
  }

  // One reviewer (main tester or a specialist). Uses Codex with the JSON schema when
  // engine is codex and it's available; otherwise a separate read-only Claude session.
  // Which engine/model a review sub-agent runs on.
  subRunner(a, s) {
    const spec = a.model === undefined ? (a.engine === 'codex' ? 'engine:codex' : 'engine:claude') : a.model;
    if (!spec) return { engine: s.reviewer === 'claude' ? 'claude' : 'codex', modelOverride: s.reviewer === 'claude' ? s.reviewerModel || null : null };
    if (spec === 'engine:codex') return { engine: 'codex', modelOverride: '__codex_default' };
    if (spec === 'engine:claude') return { engine: 'claude', modelOverride: null };
    const pv = this.provider(spec);
    return { engine: pv && pv.engine === 'codex' ? 'codex' : pv ? 'codex' : 'claude', modelOverride: spec };
  }

  async oneReview(chat, ctx, { prompt, round, engine, sub = null, modelOverride = null }) {
    const s = ctx.s;
    const label = sub ? `${sub.icon} ${sub.name}` : 'تستر اصلی';
    const tag = sub ? `sub_${sub.id}` : null;
    const sk = this.skillsFor(sub);
    if (sub) this.noteSkills(chat, ctx, sub, sk);
    let cxSpec = modelOverride === '__codex_default' ? null : (modelOverride || s.codexModel);
    if (/^chatgpt(:|$)/.test(cxSpec || '')) { cxSpec = cxSpec.slice(8) || null; modelOverride = cxSpec || '__codex_default'; } // ChatGPT sign-in = Codex
    const rp = engine === 'codex' ? (this.llmOnly(cxSpec) ? { engine: 'claude' } : this.provider(cxSpec) || (/^claude-/.test(cxSpec || '') ? { engine: 'claude' } : null)) : null;
    if (rp && rp.engine === 'claude') {
      const res = await this.claudeStep(chat, ctx, {
        prompt: prompt + JSON_TAIL + sk.block, round, sub, role: sub ? 'specialist' : 'reviewer', modelOverride: cxSpec,
        phase: sub ? `${label} — بررسی (دور ${round})` : `بررسی و تست (دور ${round})`,
        system: REVIEWER_SYSTEM + (sub ? `\n${sub.prompt}` : ''), sessionKey: tag ? `${tag}_session` : 'reviewerSession',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell'], hideText: true, addDirs: sk.dirs,
      });
      if (!res.ok) return { review: null };
      const r = parseReview(res.text);
      if (r) return { review: r, engine: 'claude' };
      this.post(chat, { agent: 'claude', round, kind: 'error', text: 'خروجی تستر قابل‌خواندن نبود:\n' + (res.text || '').slice(0, 1500) });
      return { review: null };
    }
    if (engine === 'codex' && !(ctx.codexLimited && s.fallbackToClaude)) {
      const res = await this.codexStep(chat, ctx, {
        prompt: prompt + sk.block, round, schema: true, sub,
        phase: sub ? `${label} — بررسی (دور ${round})` : `بررسی و تست (دور ${round})`,
        threadKey: tag ? `${tag}_thread` : 'codexThread', modelOverride: modelOverride === '__codex_default' ? '__codex_default' : cxSpec,
      });
      if (ctx.run.cancelled) return { review: null };
      if (res.ok) {
        const r = parseReview(res.text);
        if (r) return { review: r, engine: 'codex' };
        this.post(chat, { agent: 'codex', round, kind: 'error', text: 'خروجی Codex قابل‌خواندن نبود:\n' + (res.text || '').slice(0, 1500) });
      }
      if (!s.fallbackToClaude) return { review: null };
      this.post(chat, { agent: 'system', kind: 'status', text: `Codex در دسترس نیست — ${label} با یک نشست جداگانه‌ی Claude انجام می‌شود.` });
    } else if (engine === 'codex') {
      this.post(chat, { agent: 'system', kind: 'status', text: `Codex به سقف مصرف رسیده — ${label} با Claude انجام می‌شود.` });
    }
    const res = await this.claudeStep(chat, ctx, {
      prompt: prompt + JSON_TAIL, round, sub, role: sub ? 'specialist' : 'reviewer',
      phase: sub ? `${label} — بررسی (دور ${round})` : `بررسی و تست (دور ${round}) — Claude به‌جای Codex`, modelOverride: engine === 'claude' && modelOverride && modelOverride !== '__codex_default' ? modelOverride : null,
      system: REVIEWER_SYSTEM + (sub ? `\n${sub.prompt}` : '') + sk.block,
      sessionKey: tag ? `${tag}_session` : 'reviewerSession',
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell'], hideText: true, addDirs: sk.dirs,
    });
    if (!res.ok) return { review: null };
    const r = parseReview(res.text);
    if (!r) this.post(chat, { agent: 'claude', round, kind: 'error', text: `خروجی ${label} قابل‌خواندن نبود.` });
    return { review: r, engine: 'claude' };
  }

  // Testers must not change project files. Compare snapshots taken around the review.
  async guardEdits(chat, ctx, before) {
    const mode = ctx.s.guardReviewerEdits;
    if (!before || mode === 'off') return;
    const after = await git.snapshot(ctx.cwd);
    if (!after || after.tree === before.tree) return;
    const d = await git.diffBetween(ctx.cwd, before.commit, after.commit, 0);
    if (mode === 'revert') {
      const r = await git.restore(ctx.cwd, before.commit, { deleteNewer: true });
      this.post(chat, { agent: 'system', kind: 'error', text: `⚠️ تستر این فایل‌ها را تغییر داده بود و برگردانده شدند:\n${d.files.join('\n')}${r.ok ? '' : '\n(بازگردانی ناموفق: ' + r.err + ')'}` });
    } else {
      this.post(chat, { agent: 'system', kind: 'error', text: `⚠️ تستر این فایل‌ها را تغییر داد (که نباید):\n${d.files.join('\n')}\nدر تنظیمات می‌توانید «برگرداندن خودکار» را فعال کنید.` });
    }
  }

  // Review round: main tester, plus enabled specialist reviewers (in parallel with the
  // tester, or only after it passes — specialistsTiming). Posts each report as a card
  // and returns the merged review for the fix step.
  async review(chat, ctx, { task, round, extra = '', only = null }) {
    const s = ctx.s;
    const files = chat.touchedFiles.length ? `\nFiles the builder touched:\n${chat.touchedFiles.map(f => '- ' + f).join('\n')}` : '';
    let changes = '';
    if (ctx.isGit && ctx.checkpoint) {
      const d = await git.diffSince(ctx.cwd, ctx.checkpoint, +s.reviewDiffChars || 0);
      if (d) {
        ctx.lastDiff = d;
        changes = `\n== Changes made in this run (diff against the checkpoint taken before the run; earlier uncommitted work is NOT part of it) ==\n${d.stat || '(no changes)'}`
          + (d.text ? `\n\n${d.text}\nReview THIS diff. You don't need to rediscover the changes; spend your effort on running tests and checking behaviour.` : '');
      }
    } else if (ctx.isGit) {
      const st = await git.diffStat(ctx.cwd);
      if (st) changes = `\n== git diff --stat ==\n${st}`;
    }
    const tcmd = only ? null : testrun.resolve(ctx.cwd, s.testCommand);
    let testRes = null;
    if (tcmd) { testRes = await this.runTests(chat, ctx, tcmd, round); if (ctx.run.cancelled) return null; }
    const testBlock = testRes ? `\n== Project tests (run by JARVIS just now: \`${tcmd}\`) ==\n${testRes.ok ? 'PASSED' : testRes.timedOut ? 'TIMED OUT' : 'FAILED (exit code ' + testRes.exitCode + ')'}\n${testRes.output.slice(-3000)}\nUse these results; re-run tests only if you need more detail.` : '';
    const base = `${REVIEW_RULES}

== Task given to the builder ==
${task}
${files}
${changes}${testBlock}
${extra}
Review round ${round}. Analyse and test now.`;

    const subs = only ? [only] : this.store.subagents().filter(a => a.enabled && a.stage === 'review');
    const subJob = a => this.oneReview(chat, ctx, {
      prompt: `${base}\n\n== Your specialty (${a.name}) ==\n${a.prompt}\nFocus ONLY on your specialty; other reviewers cover the rest. If you find nothing in your area, return verdict "pass" with no bugs.`,
      round, sub: a, ...this.subRunner(a, s),
    }).then(r => ({ ...r, by: a.name, sub: a }));
    const mainJob = () => this.oneReview(chat, ctx, { prompt: base, round, engine: s.reviewer === 'claude' ? 'claude' : 'codex' })
      .then(async r => {
        if (r.review || ctx.run.cancelled || ctx.budgetHit || !s.reviewerFallback) return { ...r, main: true, by: 'main' };
        this.post(chat, { agent: 'system', kind: 'status', text: `🔁 تستر اصلی جوابی نداد؛ بررسی با ${this.labelOf(s.reviewerFallback)} دوباره انجام می‌شود.` });
        const fr = await this.oneReview(chat, ctx, { prompt: base, round, ...this.subRunner({ model: s.reviewerFallback }, s) });
        return { ...fr, main: true, by: 'main' };
      });

    // Testers query the graph too: refresh it so the builder's new code is in it.
    if (ctx.graphBlock && s.graphifyAutoUpdate) await graph.update(ctx.cwd);
    const before = ctx.isGit && s.guardReviewerEdits !== 'off' ? await git.snapshot(ctx.cwd) : null;
    let parts;
    if (only) parts = await Promise.all(subs.map(subJob));
    else if (s.specialistsTiming === 'every-round' || !subs.length) parts = await Promise.all([mainJob(), ...subs.map(subJob)]);
    else {
      // Cheaper: specialists only look at work the main tester already approved.
      const main = await mainJob();
      parts = [main];
      if (!ctx.run.cancelled && main.review && main.review.verdict === 'pass' && !ctx.budgetHit) {
        this.post(chat, { agent: 'system', kind: 'status', text: `تستر اصلی تأیید کرد — نوبت ساب‌ایجنت‌ها: ${subs.map(a => a.icon + ' ' + a.name).join('، ')}` });
        parts.push(...await Promise.all(subs.map(subJob)));
      }
    }
    await this.guardEdits(chat, ctx, before);
    if (ctx.run.cancelled) return null;
    for (const p of parts) {
      if (p.review) this.post(chat, { agent: p.engine || 'claude',
        sub: p.sub ? `${p.sub.icon} ${p.sub.name}` : undefined, round, kind: 'review', review: p.review });
    }
    if (!only && !parts[0].review) {
      // Main tester failed: don't let specialists alone approve the work.
      const m = mergeReviews(parts);
      return m ? { ...m, verdict: 'fail', mainMissing: true } : null;
    }
    const merged = mergeReviews(parts);
    if (merged && testRes) {
      merged.tests_run = [{ command: tcmd, result: testRes.ok ? 'passed' : testRes.timedOut ? 'timed out' : `failed (exit ${testRes.exitCode})` }, ...merged.tests_run];
      if (!testRes.ok && s.testGate !== false) {
        merged.verdict = 'fail';
        merged.bugs = [{ severity: 'critical', title: 'تست‌های پروژه پاس نشدند', file: null, line: null, by: 'tests',
          description: `\`${tcmd}\` ${testRes.timedOut ? 'timed out' : 'exited with code ' + testRes.exitCode}:\n${testRes.output.slice(-1500)}`,
          fix_hint: `Run \`${tcmd}\` and make every test pass.` }, ...merged.bugs];
      }
    }
    ctx.lastReview = merged;
    return merged;
  }

  // The project's own tests (npm test, pytest, …): a fact, not an opinion.
  async runTests(chat, ctx, cmd, round) {
    this.post(chat, { agent: 'system', kind: 'phase', round, text: `تست‌های پروژه (دور ${round})` });
    const h = testrun.run(ctx.cwd, cmd, { timeoutMs: Math.max(10, +ctx.s.testTimeoutSec || 300) * 1000 });
    ctx.run.kills.add(h.handle.kill);
    const r = await h.promise;
    ctx.run.kills.delete(h.handle.kill);
    if (!ctx.run.cancelled) this.post(chat, { agent: 'system', kind: 'tests', round, tests: { ok: r.ok, command: cmd, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, output: r.output.slice(-4000) } });
    return r;
  }

  labelOf(spec) { const p = this.provider(spec); return p && !p.missing ? p.label : (spec ? prettyModel(spec) : 'مدل پیش‌فرض'); }

  // Builder step with one automatic retry on the fallback model when it fails.
  async builderStep(chat, ctx, args) {
    const r = await this.claudeStep(chat, ctx, args);
    const fb = ctx.s.builderFallback;
    if (r.ok || ctx.run.cancelled || ctx.budgetHit || !fb || args.fallbackDone || (args.modelOverride || ctx.s.builderModel) === fb) return r;
    this.post(chat, { agent: 'system', kind: 'status', text: `🔁 ${this.labelOf(args.modelOverride || ctx.s.builderModel)} خطا داد؛ این مرحله با ${this.labelOf(fb)} دوباره انجام می‌شود.` });
    return this.claudeStep(chat, ctx, { ...args, modelOverride: fb, fallbackDone: true });
  }

  // Summarize the conversation, then continue in fresh sessions that start from the summary.
  async compactFlow(chat, ctx) {
    const r = await this.claudeStep(chat, ctx, { prompt: SUMMARY_PROMPT, phase: 'خلاصه‌سازی گفتگو', role: 'plan', hideText: true });
    if (ctx.run.cancelled) return 'stopped';
    if (!r.ok || !String(r.text || '').trim()) return 'error';
    chat.carryOver = String(r.text).trim().slice(0, 12000);
    for (const k of Object.keys(chat)) if (/session|thread/i.test(k)) chat[k] = null;
    this.post(chat, { agent: 'system', kind: 'summary', text: chat.carryOver });
    return 'done';
  }

  // Suggest durable project rules; the user picks which ones go into CLAUDE.md / AGENTS.md.
  async memoryFlow(chat, ctx) {
    const r = await this.claudeStep(chat, ctx, { prompt: MEMORY_PROMPT, phase: 'پیشنهاد برای حافظه‌ی پروژه', role: 'plan', hideText: true });
    if (ctx.run.cancelled) return 'stopped';
    if (!r.ok) return 'error';
    const items = String(r.text || '').split('\n').map(l => l.trim()).filter(l => /^[-*•]\s+/.test(l)).map(l => l.replace(/^[-*•]\s+/, '').slice(0, 300)).filter(Boolean).slice(0, 8);
    this.post(chat, { agent: 'system', kind: 'memory', items, projectId: ctx.projectId });
    return items.length ? 'done' : 'error';
  }

  // ---- workflows ----------------------------------------------------------

  // graphify: build/update the project's code graph and prepare the prompt block.
  async prepareGraph(chat, ctx) {
    if (ctx.run.cancelled || !ctx.s.useGraphify || !graph.graphifyBin()) return;
    const before = graph.info(ctx.cwd);
    if (ctx.s.graphifyAutoUpdate || !before.exists) {
      const u = await graph.update(ctx.cwd);
      if (!u.ok) { this.post(chat, { agent: 'system', kind: 'error', text: 'ساخت گراف graphify ناموفق بود؛ بدون گراف ادامه می‌دهم.\n' + (u.error || '') }); return; }
      this.post(chat, { agent: 'system', kind: 'status', text: `🕸 گراف کد (graphify) ${before.exists ? 'به‌روز شد' : 'ساخته شد'}: ${u.nodes} گره، ${u.edges} یال — ${(u.ms / 1000).toFixed(1)} ثانیه` });
    }
    ctx.graphBlock = await graph.promptBlock(ctx.cwd, +ctx.s.graphifyBudget || 1500);
    if (ctx.s.graphifyPreQuery !== false && ctx.task) {
      ctx.graphHints = await graph.preQuery(ctx.cwd, ctx.task, 1200);
      if (ctx.graphHints) this.post(chat, { agent: 'system', kind: 'status', text: `🧭 ${ctx.graphHints.split('\n').length} مکان مرتبط با این کار از گراف پیدا شد و به ایجنت‌ها داده می‌شود.` });
    }
  }

  // Give each agent session the task's likely-relevant code locations once per run.
  withHints(ctx, key, prompt) {
    if (!ctx.graphHints) return prompt;
    ctx.hinted = ctx.hinted || new Set();
    if (ctx.hinted.has(key)) return prompt;
    ctx.hinted.add(key);
    return `== Likely relevant code for this task (from the project's code graph — start reading here; verify before relying on it) ==\n${ctx.graphHints}\n\n${prompt}`;
  }

  // Wait until no other chat is running on this project (projectLock).
  async acquireProject(chat, ctx, projectId) {
    if (!ctx.s.projectLock) return true;
    let told = false;
    for (;;) {
      const holder = this.projectRuns.get(projectId);
      if (!holder || holder === chat.id || !this.running.has(holder)) break;
      if (!told) {
        const other = this.store.chat(holder);
        this.post(chat, { agent: 'system', kind: 'status', text: `⏳ چت «${other ? other.title : holder}» روی همین پروژه در حال اجراست؛ بعد از تمام شدنش شروع می‌کنم…` });
        told = true;
      }
      if (ctx.run.cancelled) return false;
      await sleep(1000);
    }
    this.projectRuns.set(projectId, chat.id);
    return true;
  }

  // opts.queuedIds: this run continues messages that were queued at the end of the
  // previous run (they are already in the chat, so they're marked delivered instead).
  async run(chat, project, text, mode, opts = {}) {
    if (this.running.has(chat.id)) throw new Error('این چت در حال اجراست');
    const run = { kills: new Set(), cancelled: false, inbox: [] };
    this.running.set(chat.id, run);
    let subscription = false;
    try { subscription = this.authMethod ? (await this.authMethod()) === 'claude.ai' : false; } catch {}
    const ctx = { autoApprove: !!opts.autoApprove, subscription, cwd: project.path, projectId: project.id, run, isGit: false, s: { ...this.store.settings(project.id), ...Object.fromEntries(Object.entries(chat.models || {}).filter(([, v]) => v)) }, runCost: 0, rounds: 0, startedAt: Date.now() };
    const startTokens = chat.cost.codexTokens;
    chat.touchedFiles = [];
    if (opts.queuedIds) {
      this.post(chat, { agent: 'system', kind: 'delivered', ids: opts.queuedIds, text: `📨 ادامه با ${opts.queuedIds.length} پیامی که در پایان اجرای قبلی رسید` });
    } else this.post(chat, { agent: 'user', kind: 'text', text, mode, ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments.map(p => path.basename(p)) } : {}) });
    this.setStatus(chat, 'running');
    let final = 'done';
    let locked = false;
    try {
      locked = await this.acquireProject(chat, ctx, project.id);
      if (!locked) throw Object.assign(new Error('cancelled'), { quiet: true });
      ctx.isGit = await git.isRepo(project.path);
      if (ctx.isGit && ctx.s.gitBranchPerChat) {
        const slug = (chat.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
        chat.branch = chat.branch || `jarvis/${slug ? slug + '-' : ''}${chat.id.slice(0, 6)}`;
        const b = await git.useBranch(ctx.cwd, chat.branch);
        this.post(chat, b.ok
          ? { agent: 'system', kind: 'status', text: `🌿 روی شاخه‌ی ${chat.branch}${b.created ? ' (تازه ساخته شد)' : ''}` }
          : { agent: 'system', kind: 'error', text: `تعویض شاخه ناموفق بود؛ روی شاخه‌ی فعلی ادامه می‌دهم.\n${b.err}` });
      }
      if (ctx.isGit) {
        ctx.checkpoint = await git.checkpoint(ctx.cwd);
        if (ctx.checkpoint) this.post(chat, { agent: 'system', kind: 'checkpoint', text: `نقطه‌ی بازگشت ساخته شد (${ctx.checkpoint.slice(0, 8)})`, checkpoint: ctx.checkpoint });
      }
      if (opts.attachments && opts.attachments.length) {
        ctx.extraDirs = [path.dirname(opts.attachments[0])];
        text += `\n\n[The user attached ${opts.attachments.length} image(s). Open each one with the Read tool and look at it before you answer:\n${opts.attachments.join('\n')}]`;
      }
      ctx.task = text;
      await this.prepareGraph(chat, ctx);
      final = await this.dispatch(chat, ctx, text, mode);
      // Messages that arrived after Claude's last step: run a follow-up round with them.
      while (!run.cancelled && !ctx.budgetHit && final !== 'error' && run.inbox.length) {
        this.post(chat, { agent: 'system', kind: 'status', text: 'ادامه با پیام‌هایی که حین کار فرستادید…' });
        const followUp = this.drainInbox(chat, ctx);
        final = await this.dispatch(chat, ctx, followUp, ['audit', 'compact', 'memory'].includes(mode) ? 'team' : mode);
      }
    } catch (e) {
      final = 'error';
      if (!e.quiet) this.post(chat, { agent: 'system', kind: 'error', text: String(e && e.stack || e) });
    } finally {
      if (run.cancelled) { final = 'stopped'; this.post(chat, { agent: 'system', kind: 'status', text: 'متوقف شد.' }); }
      else if (ctx.budgetHit) {
        final = 'budget';
        this.post(chat, { agent: 'system', kind: 'error', text: `💰 سقف هزینه‌ی این اجرا ($${(+ctx.s.maxRunCostUsd).toFixed(2)}) پر شد و کار متوقف شد. در تنظیمات می‌توانید سقف را بیشتر کنید یا مدل ارزان‌تری انتخاب کنید.` });
      }
      let commit = null;
      try {
        const askCommit = ctx.isGit && final === 'done' && ctx.s.autoCommit && ctx.s.commitAsk;
        if (ctx.isGit && final === 'done' && ctx.s.autoCommit && !ctx.s.commitAsk) {
          const c = await git.commitAll(ctx.cwd, `jarvis: ${chat.title}`);
          if (c.ok && !c.nothing) { commit = c.hash; this.post(chat, { agent: 'system', kind: 'status', text: `✔ commit شد: ${c.hash}` }); }
          else if (!c.ok) this.post(chat, { agent: 'system', kind: 'error', text: `commit ناموفق بود:\n${c.err}` });
        }
        const d = ctx.isGit && ctx.checkpoint ? await git.diffSince(ctx.cwd, ctx.checkpoint, 0) : null;
        if (ctx.s.finalReport && !['compact', 'memory'].includes(mode)) {
          const rv = ctx.lastReview;
          this.post(chat, { agent: 'system', kind: 'report', report: {
            status: final, mode, durationMs: Date.now() - ctx.startedAt, rounds: ctx.rounds,
            claudeUsd: +ctx.runCost.toFixed(4), codexTokens: chat.cost.codexTokens - startTokens,
            stat: d ? d.stat : '', files: d ? d.files : chat.touchedFiles,
            tests: rv ? rv.tests_run.slice(0, 12) : [],
            openBugs: rv && rv.verdict !== 'pass' ? rv.bugs.length : 0,
            branch: chat.branch || null, commit, pendingCommit: !!askCommit,
          } });
        } else if (d && d.stat) this.post(chat, { agent: 'system', kind: 'diffstat', text: d.stat });
      } catch (e) { console.error('finalize', e); }
      // Take whatever is still queued AFTER the last await (messages can arrive while the
      // commit / final diff is running), then mark the run finished — all synchronously,
      // so no message can slip in between and be lost.
      const leftover = run.inbox.splice(0);
      if (locked && this.projectRuns.get(project.id) === chat.id) this.projectRuns.delete(project.id);
      this.running.delete(chat.id);
      if (leftover.length && (run.cancelled || ctx.budgetHit)) {
        this.post(chat, { agent: 'system', kind: 'status', text: `${leftover.length} پیام در صف اجرا نشد (${run.cancelled ? 'به‌خاطر توقف' : 'سقف هزینه'}). می‌توانید دوباره بفرستید.` });
      }
      this.setStatus(chat, final);
      try { if (this.onFinish && !['compact', 'memory'].includes(mode)) this.onFinish(chat, final, { mode, durationMs: Date.now() - ctx.startedAt, rounds: ctx.rounds, project }); } catch (e) { console.error('onFinish', e); }
      if (leftover.length && !run.cancelled && !ctx.budgetHit && (!this.store.chat || this.store.chat(chat.id))) {
        // Continue with them right away, as a follow-up run in the same mode.
        const ids = leftover.map(i => i.id);
        setImmediate(() => this.run(chat, project, leftover.map(i => i.text).join('\n\n'), ['audit', 'compact', 'memory'].includes(mode) ? 'team' : mode, { queuedIds: ids })
          .catch(e => console.error('follow-up run', e)));
      }
      this.broadcast({ type: 'queue', chatId: chat.id, pending: 0 });
      this.broadcast({ type: 'finished', chatId: chat.id, status: final, title: chat.title });
    }
  }

  async dispatch(chat, ctx, text, mode) {
    // "@name do something" talks to one sub-agent directly.
    const mention = text.match(/^@([\w-]+)\s+([\s\S]+)$/);
    const sub = mention && this.store.subagent(mention[1]);
    if (mention && !sub) this.post(chat, { agent: 'system', kind: 'status', text: `ساب‌ایجنتی به نام «${mention[1]}» پیدا نشد؛ پیام به حالت انتخاب‌شده فرستاده شد.` });
    const end = r => ctx.run.cancelled ? 'stopped' : ctx.budgetHit ? 'budget' : r.ok ? 'done' : 'error';
    if (sub) return this.subagentFlow(chat, ctx, sub, mention[2]);
    if (mode === 'compact') return this.compactFlow(chat, ctx);
    if (mode === 'memory') return this.memoryFlow(chat, ctx);
    if (mode === 'claude') return end(await this.builderStep(chat, ctx, { prompt: text, phase: 'سازنده' }));
    if (mode === 'codex') return end(await this.codexStep(chat, ctx, { prompt: text, phase: 'تستر', sandbox: 'read-only' }));
    if (mode === 'plan') return this.planFlow(chat, ctx, text);
    if (mode === 'smart') return this.smartFlow(chat, ctx, text);
    if (mode === 'split') return this.splitFlow(chat, ctx, text);
    if (mode === 'audit') return this.teamFlow(chat, ctx, text, true);
    return this.teamFlow(chat, ctx, text, false);
  }

  async subagentFlow(chat, ctx, sub, text) {
    if (sub.stage === 'review') {
      const r = await this.review(chat, ctx, { task: text, round: 1, only: sub, extra: '\nThe user asked you directly. Review the current state of the project for this request.' });
      return ctx.run.cancelled ? 'stopped' : ctx.budgetHit ? 'budget' : r ? 'done' : 'error';
    }
    const sk = this.skillsFor(sub);
    this.noteSkills(chat, ctx, sub, sk);
    const r = await this.claudeStep(chat, ctx, {
      prompt: text, phase: `${sub.icon} ${sub.name}`, sub,
      system: `${BUILDER_SYSTEM}\n\nFor this request you act as the "${sub.name}" specialist:\n${sub.prompt}${sk.block}`,
      sessionKey: `sub_${sub.id}_session`, addDirs: sk.dirs,
    });
    return ctx.run.cancelled ? 'stopped' : ctx.budgetHit ? 'budget' : r.ok ? 'done' : 'error';
  }

  // ---- smart mode: split the request, run each part on the model it needs, then test ----
  routeModel(s, level) {
    return { hard: s.routeHard || 'claude-opus-5-5', medium: s.routeMedium || 'claude-sonnet-5-5', easy: s.routeEasy || 'claude-haiku-5-5' }[level] || s.builderModel;
  }
  stepCost(spec) {
    const avg = this.usage && this.usage.avgStepCost ? this.usage.avgStepCost(spec) : null;
    if (avg != null) return avg;
    const pv = this.provider(spec);
    if (pv && !pv.missing) return pv.prices && (pv.prices.in || pv.prices.out) ? (60000 * (pv.prices.cached || pv.prices.in) + 20000 * pv.prices.in + 5000 * pv.prices.out) / 1e6 : 0;
    return STEP_COST_GUESS[spec] != null ? STEP_COST_GUESS[spec] : 0.3;
  }

  async smartFlow(chat, ctx, task) {
    const s = ctx.s;
    const halt = () => ctx.run.cancelled ? 'stopped' : ctx.budgetHit ? 'budget' : null;
    chat.routerSession = null;
    const r = await this.claudeStep(chat, ctx, { prompt: ROUTER_PROMPT + task, phase: 'تقسیم کار بین مدل‌ها', role: 'reviewer', modelOverride: s.routerModel || 'claude-haiku-5-5',
      system: ROUTER_SYSTEM, sessionKey: 'routerSession', hideText: true, allowedTools: ['Read', 'Glob', 'Grep'] });
    if (halt()) return halt();
    chat.routerSession = null;
    let parts = r.ok ? parseRoute(r.text) : null;
    if (!parts) {
      this.post(chat, { agent: 'system', kind: 'status', text: 'برنامه‌ریز تقسیم‌بندی قابل‌استفاده‌ای نداد؛ کل کار با مدل «متوسط» انجام می‌شود.' });
      parts = [{ title: 'کل کار', level: 'medium', prompt: task }];
    }
    const top = this.routeModel(s, 'hard');
    const plan = parts.map(p => { const model = this.routeModel(s, p.level); return { ...p, levelFa: LEVEL_FA[p.level], model, label: this.labelOf(model), estUsd: +this.stepCost(model).toFixed(3) }; });
    const reviewEst = 0; // the tester's cost is the same in every mode
    const card = this.post(chat, { agent: 'system', kind: 'smartplan', plan, estUsd: +(plan.reduce((t, p) => t + p.estUsd, 0) + reviewEst).toFixed(3),
      topUsd: +(plan.length * this.stepCost(top)).toFixed(3), topLabel: this.labelOf(top), approved: !!s.smartAutoApprove || s.smartAutoApprove === undefined || !!ctx.autoApprove });
    if (!card.approved) {
      this.setStatus(chat, 'waiting');
      const answer = await new Promise(res => { ctx.run.approve = res; });
      ctx.run.approve = null;
      if (halt() || !answer) return halt() || 'stopped';
      if (Array.isArray(answer.models)) answer.models.forEach((m, i) => { if (plan[i] && typeof m === 'string' && /^[\w.:\-[\]/]{1,100}$/.test(m)) { plan[i].model = m; plan[i].label = this.labelOf(m); } });
      card.approved = true; card.plan = plan;
      this.store.saveChat(chat);
      this.broadcast({ type: 'msgUpdate', chatId: chat.id, message: card });
      this.setStatus(chat, 'running');
    }
    const done = [];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const prompt = `== Overall request from the user ==\n${task}\n\n== The plan (${plan.length} parts) ==\n${plan.map((x, j) => `${j + 1}. ${x.title}${j < i ? ' — DONE' : j === i ? ' — YOUR PART NOW' : ''}`).join('\n')}\n`
        + (done.length ? `\n== What the earlier parts did ==\n${done.join('\n\n')}\n` : '')
        + `\n== Your part (${i + 1}/${plan.length}): ${p.title} ==\n${p.prompt}\n\nDo only this part; the other parts are handled separately. End with a 2-3 line summary of what you changed.`;
      const res = await this.builderStep(chat, ctx, { prompt, phase: `بخش ${i + 1} از ${plan.length}: ${p.title} · ${p.label}`, round: 1, modelOverride: p.model });
      if (halt()) return halt();
      if (!res.ok) return 'error';
      done.push(`Part ${i + 1} (${p.title}): ${String(res.text || '').trim().slice(-800)}`);
    }
    return this.teamFlow(chat, ctx, task, false, { prebuilt: true, fixModel: this.routeModel(s, 'medium') });
  }
  // ---- split between AIs: parts run at the same time on different agents, then come together ----
  async splitFlow(chat, ctx, task) {
    const S = require('./split');
    const s = ctx.s;
    const halt = () => ctx.run.cancelled ? 'stopped' : ctx.budgetHit ? 'budget' : null;
    const engines = (this.splitEngines ? this.splitEngines() : []).filter(Boolean);
    if (!engines.length) engines.push({ id: s.builderModel || 'claude-sonnet-5-5', label: this.labelOf(s.builderModel) });
    chat.routerSession = null;
    const r = await this.claudeStep(chat, ctx, { prompt: S.splitPrompt(task, engines), phase: 'تقسیم کار بین هوش‌ها', role: 'reviewer', modelOverride: s.routerModel || 'claude-haiku-5-5',
      system: S.SPLIT_SYSTEM, sessionKey: 'routerSession', hideText: true, allowedTools: ['Read', 'Glob', 'Grep'] });
    if (halt()) return halt();
    chat.routerSession = null;
    let parts = r.ok ? S.parseSplit(r.text, engines) : null;
    if (!parts) { this.post(chat, { agent: 'system', kind: 'status', text: 'برنامه‌ریز تقسیم قابل‌استفاده‌ای نداد؛ کل کار با تیم معمولی انجام می‌شود.' }); return this.teamFlow(chat, ctx, task, false); }
    const clash = S.overlaps(parts);
    const parallel = ctx.isGit && ctx.checkpoint && parts.length > 1;
    const label = id => (engines.find(e => e.id === id) || {}).label || this.labelOf(id);
    const plan = parts.map((p, i) => ({ title: p.title, levelFa: !parallel ? 'پشت سر هم' : clash.has(i) ? 'بعد از بقیه (فایل مشترک)' : 'هم‌زمان', model: p.engine, label: label(p.engine), estUsd: +this.stepCost(p.engine).toFixed(3) }));
    const card = this.post(chat, { agent: 'system', kind: 'smartplan', split: true, plan, estUsd: +plan.reduce((t, p) => t + p.estUsd, 0).toFixed(3), approved: !!s.smartAutoApprove || s.smartAutoApprove === undefined || !!ctx.autoApprove });
    if (!card.approved) {
      this.setStatus(chat, 'waiting');
      const answer = await new Promise(res => { ctx.run.approve = res; });
      ctx.run.approve = null;
      if (halt() || !answer) return halt() || 'stopped';
      if (Array.isArray(answer.models)) answer.models.forEach((m, i) => { if (parts[i] && typeof m === 'string' && /^[\w.:\-[\]/]{1,100}$/.test(m)) { parts[i].engine = m; plan[i].model = m; plan[i].label = label(m); } });
      card.approved = true; card.plan = plan; this.store.saveChat(chat);
      this.broadcast({ type: 'msgUpdate', chatId: chat.id, message: card });
      this.setStatus(chat, 'running');
    }
    const partPrompt = (p, i, note = '') => `== Overall request from the user ==\n${task}\n\n== The job was split between ${parts.length} AI agents working at the same time ==\n${parts.map((x, j) => `${j + 1}. ${x.title}${x.files.length ? ' (files: ' + x.files.slice(0, 8).join(', ') + ')' : ''}${j === i ? ' — YOURS' : ''}`).join('\n')}\n${note}\n== Your part (${i + 1}/${parts.length}): ${p.title} ==\n${p.prompt}\n\nDo ONLY your part and do not touch files that belong to the other parts. End with a 2-3 line summary of what you changed.`;
    // a step on its own copy of the project; cost and stop are shared with the whole run
    const child = (cwd, i) => { const c = Object.create(ctx); c.cwd = cwd; c.checkpoint = null; for (const k of ['runCost', 'budgetHit', 'rounds', 'codexLimited', 'claudeLimitedUntil']) Object.defineProperty(c, k, { get: () => ctx[k], set: v => { ctx[k] = v; }, enumerable: true }); return c; };
    const runPart = (p, i, c, note) => this.builderStep(chat, c, { prompt: partPrompt(p, i, note), phase: `بخش ${i + 1} از ${parts.length}: ${p.title} · ${label(p.engine)}`, round: 1, modelOverride: p.engine, sessionKey: `split${i}Session` });
    const later = [];
    if (parallel) {
      const together = parts.map((p, i) => i).filter(i => !clash.has(i));
      clash.forEach(i => later.push(i));
      this.post(chat, { agent: 'system', kind: 'status', text: `⚡ ${together.length} بخش هم‌زمان، هر کدام در یک نسخه‌ی جدا از پروژه، شروع شد.` });
      // make every copy first (one at a time: git locks its worktree list), then start all parts together
      const dirs = {};
      for (const i of together) { try { dirs[i] = await S.addWorktree(ctx.cwd, ctx.checkpoint, chat.id.slice(0, 6) + '-' + i); } catch (e) { dirs[i] = e; } }
      const results = await Promise.all(together.map(async i => {
        const dir = dirs[i];
        if (dir instanceof Error) return { i, res: { ok: false, error: dir.message }, patch: '' };
        try {
          const res = await runPart(parts[i], i, child(dir, i));
          return { i, res, patch: res.ok ? await S.partPatch(dir, ctx.checkpoint) : '' };
        } catch (e) { return { i, res: { ok: false, error: e.message }, patch: '' }; }
      }));
      for (const i of together) if (!(dirs[i] instanceof Error)) await S.removeWorktree(ctx.cwd, dirs[i]);
      if (halt()) return halt();
      // bring the changes back, one part at a time
      for (const x of results.sort((a, b) => a.i - b.i)) {
        const p = parts[x.i];
        if (!x.res.ok) { this.post(chat, { agent: 'system', kind: 'error', text: `بخش ${x.i + 1} («${p.title}») با ${label(p.engine)} انجام نشد: ${String(x.res.error || '').slice(0, 300)} — در پوشه‌ی اصلی دوباره انجام می‌شود.` }); later.push(x.i); continue; }
        const a = await S.applyPatch(ctx.cwd, x.patch);
        if (a.ok) { if (a.files) chat.touchedFiles.push(...a.files); this.post(chat, { agent: 'system', kind: 'status', text: a.empty ? `بخش ${x.i + 1} («${p.title}») تغییری نداد.` : `✔ تغییرات بخش ${x.i + 1} («${p.title}»، ${label(p.engine)}) به پروژه اضافه شد: ${a.files.length} فایل.` }); }
        else { this.post(chat, { agent: 'system', kind: 'status', text: `تغییرات بخش ${x.i + 1} با بخش‌های دیگر تداخل داشت؛ همین بخش در پوشه‌ی اصلی دوباره انجام می‌شود.` }); later.push(x.i); }
      }
    } else {
      if (parts.length > 1) this.post(chat, { agent: 'system', kind: 'status', text: ctx.isGit ? 'بخش‌ها پشت سر هم انجام می‌شوند.' : 'پروژه git ندارد؛ بخش‌ها پشت سر هم در همین پوشه انجام می‌شوند (برای کار هم‌زمان، پروژه باید git داشته باشد).' });
      parts.forEach((p, i) => later.push(i));
    }
    // the rest, one after another in the main folder (they see what the others already did)
    for (const i of later.sort((a, b) => a - b)) {
      const res = await runPart(parts[i], i, ctx, '\n(The other parts are already in the project — build on them, do not undo them.)\n');
      if (halt()) return halt();
      if (!res.ok) return 'error';
    }
    // finally the usual tester checks everything together and the builder fixes what it finds
    return this.teamFlow(chat, ctx, task, false, { prebuilt: true });
  }

  approveSmart(chatId, answer) {
    const r = this.running.get(chatId);
    if (!r || !r.approve) return false;
    r.approve(answer || { models: null });
    return true;
  }

  async teamFlow(chat, ctx, task, auditFirst, opts = {}) {
    const max = Math.max(1, +ctx.s.maxRounds || 3);
    const halt = () => ctx.run.cancelled ? 'stopped' : ctx.budgetHit ? 'budget' : null;
    let review = null;
    if (opts.prebuilt) {
      // smart mode already built it
    } else if (auditFirst) {
      review = await this.review(chat, ctx, { task, round: 0, extra: '\nThis is an AUDIT: the builder has not changed anything yet. Analyse the existing project (or the part the task mentions), run its tests, and list the bugs and risks you find.' });
      if (halt()) return halt();
      if (!review) return 'error';
      if (review.verdict === 'pass' && !review.bugs.some(b => b.severity !== 'minor')) {
        this.post(chat, { agent: 'system', kind: 'status', text: 'مشکل مهمی پیدا نشد ✅' });
        return 'done';
      }
    } else {
      const r = await this.builderStep(chat, ctx, { prompt: task, phase: 'نوشتن کد', round: 1 });
      if (halt()) return halt();
      if (!r.ok) return 'error';
    }
    for (let round = 1; round <= max; round++) {
      ctx.rounds = round;
      if (review) {
        const fixPrompt = `The tester${review.bugs.some(b => b.by) ? ' and specialist reviewers' : ''} reported these problems${auditFirst && round === 1 ? ' in the project' : ' in your changes'}:

Summary: ${review.summary}

${fmtBugs(review.bugs)}

Tests that were run:
${review.tests_run.map(t => `- ${t.command}: ${t.result}`).join('\n') || '- (none)'}

Fix all critical and major issues (and minor ones if cheap). Original task: ${task}`;
        const r = await this.builderStep(chat, ctx, { prompt: fixPrompt, phase: `رفع باگ‌ها (دور ${round})${opts.fixModel ? ' · ' + this.labelOf(opts.fixModel) : ''}`, round, ...(opts.fixModel ? { modelOverride: opts.fixModel } : {}) });
        if (halt()) return halt();
        if (!r.ok) return 'error';
      }
      review = await this.review(chat, ctx, { task, round });
      if (halt()) return halt();
      if (!review) { this.post(chat, { agent: 'system', kind: 'status', text: 'بررسی انجام نشد؛ کار سازنده بدون تست باقی ماند.' }); return 'unverified'; }
      if (review.mainMissing) { this.post(chat, { agent: 'system', kind: 'status', text: 'تستر اصلی گزارشی نداد؛ فقط نظر ساب‌ایجنت‌ها موجود است.' }); return 'unverified'; }
      if (review.verdict === 'pass') {
        this.post(chat, { agent: 'system', kind: 'status', text: `✅ تأیید شد در دور ${round}.` });
        return 'done';
      }
    }
    this.post(chat, { agent: 'system', kind: 'status', text: `⚠️ بعد از ${max} دور هنوز مشکل باقی است. می‌توانید ادامه دهید یا تعداد دورها را در تنظیمات بیشتر کنید.` });
    return 'needs-attention';
  }

  // Claude drafts a plan, Codex critiques it, Claude finalises. No code is written.
  async planFlow(chat, ctx, task) {
    const halt = () => ctx.run.cancelled ? 'stopped' : ctx.budgetHit ? 'budget' : null;
    const draft = await this.claudeStep(chat, ctx, { prompt: `Draft an implementation plan (no code changes yet) for:\n${task}\nInclude files to touch, steps, risks and how it will be tested.`, phase: 'پیش‌نویس طرح', role: 'plan' });
    if (halt()) return halt();
    if (!draft.ok) return 'error';
    const critPrompt = `You are the analyst in an AI agent team. The builder agent drafted this plan for the task "${task}". Inspect the project and critique the plan: missing steps, wrong assumptions about the code, risks, better test strategy. Be concise. Answer in Persian.\n\n== PLAN ==\n${draft.text}`;
    let crit = ctx.codexLimited ? { ok: false, limitHit: true } : await this.codexStep(chat, ctx, { prompt: critPrompt, phase: 'نقد طرح', sandbox: 'read-only' });
    if (halt()) return halt();
    if (!crit.ok && ctx.s.fallbackToClaude) {
      crit = await this.claudeStep(chat, ctx, { prompt: critPrompt, phase: 'نقد طرح — Claude به‌جای Codex', role: 'reviewer', system: REVIEWER_SYSTEM, permissionMode: 'plan', sessionKey: 'reviewerSession' });
      if (halt()) return halt();
    }
    if (!crit.ok) return 'unverified';
    const fin = await this.claudeStep(chat, ctx, { prompt: `The reviewer critiqued your plan:\n${crit.text}\n\nProduce the final plan, taking valid points into account. No code changes yet.`, phase: 'طرح نهایی', role: 'plan' });
    return halt() || (fin.ok ? 'done' : 'error');
  }
}

module.exports = { Orchestrator, parseReview, mergeReviews, bashRules };
