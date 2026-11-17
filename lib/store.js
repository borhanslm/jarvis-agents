// JSON-file persistence for projects, chats and settings.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveAlias } = require('./models');

const DEFAULT_SETTINGS = {
  // --- team flow ---
  maxRounds: 3,                    // build → review → fix loops
  reviewer: 'codex',               // codex | claude
  fallbackToClaude: true,          // if Codex fails (e.g. usage limit), Claude reviews in a separate session
  specialistsTiming: 'after-pass', // after-pass (cheaper: specialists only once the main tester passes) | every-round
  reviewDiffChars: 40000,          // put the diff since the checkpoint into the tester prompt (0 = off)
  finalReport: true,               // summary card at the end of each run

  // --- models & cost (Claude) ---
  builderModel: 'claude-sonnet-5-5', builderEffort: 'medium',   // writes / fixes code
  reviewerModel: 'claude-sonnet-5-5', reviewerEffort: 'low',     // Claude acting as tester (reviewer=claude or fallback)
  specialistModel: 'claude-haiku-5-5', specialistEffort: 'low',  // specialist sub-agent reviewers on the Claude engine
  leanMode: true,          // no MCP servers / skills / user hooks, only the tools each role needs
  maxRunCostUsd: 5, budgetOnSubscription: false, waitOnLimit: true, onClaudeLimit: 'wait', commitAsk: false, scheduleAuditAt: '', scheduleAuditPrompt: 'کل پروژه را بازرسی کن: باگ‌ها، تست‌های شکسته و مشکلات امنیتی را پیدا کن و رفع کن. در پایان خلاصه بده چه چیزهایی پیدا و رفع شد.', mcpConfig: '', previewCommand: '', previewUrl: '', savedPrompts: [], desktopTray: true, desktopStartup: false, desktopHotkey: true, desktopAutoUpdate: true, testCommand: '', testGate: true, testTimeoutSec: 300, teamPresets: [], builderFallback: '', reviewerFallback: '', notifyPhone: '', notifyChatId: '', notifyWhen: 'all', routerModel: 'claude-haiku-5-5', routeHard: 'claude-opus-5-5', routeMedium: 'claude-sonnet-5-5', routeEasy: 'claude-haiku-5-5', smartAutoApprove: true, voiceEnabled: true, voiceWake: true, voiceAutoSetup: false, voiceDefaultOn: true, voiceWakeThreshold: 0.5, voiceStt: 'auto', voiceTts: 'auto', voiceSpeak: true, voiceModel: 'claude-haiku-5-5', voiceFaVoice: 'voice-fa-amir', voiceApiVoice: 'alloy', voiceApi: 'auto', voiceGeminiVoice: 'Kore', voiceElevenVoice: 'JBFqnCBsd6RMkjVDRZzb', voiceElevenModel: '', voiceAzureRegion: '', voiceAzureFa: 'fa-IR-DilaraNeural', voiceAzureEn: 'en-US-AndrewMultilingualNeural', voiceGeminiStt: 'gemini-3.8-flash', voiceGeminiTts: 'gemini-3.8-flash-tts', voiceMicId: '', voiceLang: 'auto', voiceMode: 'auto', voiceModelOffline: '', botEnabled: false, botVoiceReply: 'auto', remindPhone: true, remindSpeak: true, voiceAnnounce: true, voiceSayYes: true, voiceDock: 'off', memoryLearn: true, n8nUrl: '', mobileEnabled: false, mobilePort: 47780, sellerMode: false, sellerPublicKey: '', sellRepo: '', sellPrice: '', sellCurrency: 'تومان', sellCard: '', sellHolder: '', sellContact: '', sellNote: '', clubUrl: '', ccPlace: '', ccClocks: ['Asia/Tehran', 'Europe/London', 'America/New_York', 'Asia/Dubai', 'Asia/Tokyo'], codexPriceIn: 0, codexPriceCached: 0, codexPriceOut: 0, limitMaxWaitHours: 6,        // stop a run when Claude spend passes this (0 = no cap)
  liveStreaming: true,     // show Claude's text while it is being written

  // --- graphify code graph (local, no LLM) ---
  useGraphify: true,        // agents query a code graph instead of grepping/reading whole files
  graphifyAutoUpdate: true, // rebuild the graph (incremental) before each run and each review
  graphifyBudget: 1500,     // token budget per graphify query answer
  graphifyPreQuery: false,  // JARVIS queries the graph about the task and hands agents the relevant file:line list
                            // (off by default: in our Flask test it made Claude read MORE files, +44% cost)

  // --- Codex ---
  codexModel: '',
  codexEffort: '',         // '' (Codex default) | minimal | low | medium | high
  codexSandbox: 'workspace-write', // read-only | workspace-write

  // --- safety ---
  claudePermission: 'acceptEdits', // acceptEdits | bypassPermissions | default
  projectLock: true,               // only one run per project at a time; others wait
  guardReviewerEdits: 'warn',      // off | warn | revert — testers must not change files
  requireToken: false,             // API needs the access token (blocks other local programs)

  // --- git ---
  gitBranchPerChat: false, // each chat works on its own branch jarvis/<chat>
  autoCommit: false,       // commit when the tester approves

  // --- notifications ---
  notify: true,
  speak: false,
  // Shell commands Claude (builder) may run without approval in headless mode,
  // so it can run the project's build/tests itself. Each line is a command prefix.
  claudeAllowedBash: [
    'npm test', 'npm run test', 'npm run build', 'npm run lint', 'npm run typecheck',
    'node --test', 'npx tsc', 'npx vitest run', 'npx jest', 'pnpm test', 'yarn test',
    'pytest', 'python -m pytest', 'go test', 'go build', 'cargo test', 'cargo build',
    'dotnet test', 'git status', 'git diff', 'git log',
  ],
};

// Sub-agents (specialists).
//  stage "review":  runs in parallel with the main tester each review round; its bugs are merged into the fix list.
//  stage "builder": given to Claude Code via --agents so the builder can delegate to it (Task tool).
// Any sub-agent can also be called directly in a chat with "@name ...".
const DEFAULT_SUBAGENTS = [
  { id: 'security', name: 'security', icon: 'shield', engine: 'claude', stage: 'review', enabled: true,
    description: 'بررسی امنیتی تغییرات',
    prompt: 'You are a security specialist. Look only for security problems in the changes: injection (SQL/command/path), XSS, auth/authorization mistakes, secrets in code, unsafe deserialization, SSRF, insecure defaults, missing input validation at trust boundaries. Report only real, exploitable or clearly risky issues.' },
  { id: 'perf', name: 'perf', icon: 'zap', engine: 'codex', stage: 'review', enabled: false,
    description: 'بررسی کارایی و مصرف منابع',
    prompt: 'You are a performance specialist. Look only for performance problems: N+1 queries, accidental O(n^2) loops on large inputs, blocking I/O on hot paths, memory leaks, unbounded caches or queues, missing pagination.' },
  { id: 'ux', name: 'ux', icon: 'palette', engine: 'claude', stage: 'review', enabled: false,
    description: 'بررسی UI/UX و دسترس‌پذیری',
    prompt: 'You are a UI/UX and accessibility specialist. Review only user-facing changes: broken layouts, missing loading/error/empty states, accessibility (labels, contrast, keyboard navigation), confusing copy, RTL issues.' },
  { id: 'tests', name: 'test-writer', icon: 'flask-conical', engine: 'claude', stage: 'builder', enabled: true,
    description: 'Writes focused automated tests for new or changed code. Use after implementing a feature or fixing a bug.',
    prompt: 'You write focused, deterministic automated tests using the testing framework the project already uses (or node:test / pytest if none). Cover the happy path, edge cases and the bug being fixed. Run the tests and report results.' },
  { id: 'docs', name: 'docs-writer', icon: 'book-open', engine: 'claude', stage: 'builder', enabled: false,
    description: 'Updates README and docs for user-facing changes. Use when a change affects how the project is used or run.',
    prompt: 'You update README and documentation to match the code changes: usage, configuration, commands. Keep docs short and accurate. Do not change source code.' },
];

const LONG_TEXT = new Set(['mcpConfig', 'scheduleAuditPrompt', 'sellNote', 'sellerPublicKey']);

class Store {
  constructor(dir) {
    this.dir = dir;
    this.chatDir = path.join(dir, 'chats');
    fs.mkdirSync(this.chatDir, { recursive: true });
    this._projects = this._read('projects.json', []);
    const saved = this._read('settings.json', {});
    if (saved.claudeModel && !saved.builderModel) saved.builderModel = saved.claudeModel; // v1 migration
    delete saved.claudeModel;
    this._settings = { ...DEFAULT_SETTINGS, ...saved };
    // 2026-11: the voice assistant is on (listening for "Hey JARVIS") for everyone by default
    if (!saved.voiceDefaultOn) { this._settings.voiceEnabled = true; this._settings.voiceDefaultOn = true; }
    // Older versions stored aliases ("sonnet"); keep exact model IDs instead.
    for (const k of ['builderModel', 'reviewerModel', 'specialistModel']) this._settings[k] = resolveAlias(this._settings[k]);
    this._subagents = this._read('subagents.json', null) || DEFAULT_SUBAGENTS.map(a => ({ ...a }));
    // older agents had emoji icons; the panel now uses its own icon set
    const LEGACY_ICON = { '🛡': 'shield', '🛡️': 'shield', '⚡': 'zap', '🎨': 'palette', '🧪': 'flask-conical', '📝': 'book-open', '🤖': 'bot' };
    for (const x of this._subagents) if (LEGACY_ICON[x.icon]) x.icon = LEGACY_ICON[x.icon];
    // v1.2: review sub-agents follow the main reviewer unless one is chosen
    for (const a of this._subagents) if (a.model === undefined) a.model = '';
    this.chats = new Map();
    for (const f of fs.readdirSync(this.chatDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.chatDir, f), 'utf8'));
        if (c.status === 'running' || c.status === 'waiting') c.status = 'stopped'; // server restarted mid-run
        this.chats.set(c.id, c);
      } catch {}
    }
    this._timers = new Map();
    this._deleted = new Set(); // chat ids deleted in this session (never written again)
  }

  _read(name, def) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return def; }
  }
  _write(name, data) {
    const p = path.join(this.dir, name);
    fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(p + '.tmp', p);
  }

  // settings: global, optionally overridden per project (project.settings)
  settings(projectId) {
    const p = projectId && this.project(projectId);
    return p && p.settings ? { ...this._settings, ...p.settings } : this._settings;
  }
  static cleanSettings(patch) {
    const out = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!(k in patch)) continue;
      const d = DEFAULT_SETTINGS[k], v = patch[k];
      if (typeof d === 'number') { const n = Number(v); if (Number.isFinite(n) && n >= 0) out[k] = n; }
      else if (typeof d === 'boolean') out[k] = !!v;
      else if (Array.isArray(d)) { if (Array.isArray(v)) out[k] = v.map(String).map(s => s.trim()).filter(Boolean).slice(0, 200); }
      else out[k] = String(v ?? '').slice(0, LONG_TEXT.has(k) ? 20000 : 200);
    }
    return out;
  }
  updateSettings(patch) {
    Object.assign(this._settings, Store.cleanSettings(patch));
    this._write('settings.json', this._settings);
    return this._settings;
  }
  // patch = null removes the override so the project follows the global settings again.
  updateProjectSettings(id, patch) {
    const p = this.project(id);
    if (!p) return null;
    if (patch === null) delete p.settings;
    else {
      const clean = Store.cleanSettings(patch);
      delete clean.requireToken; // server-wide only
      p.settings = clean;
    }
    this._write('projects.json', this._projects);
    return this.settings(id);
  }
  defaults() { return DEFAULT_SETTINGS; }

  // sub-agents
  subagents() { return this._subagents; }
  subagent(idOrName) {
    const k = String(idOrName || '').toLowerCase();
    return this._subagents.find(a => a.id === idOrName || a.name.toLowerCase() === k);
  }
  saveSubagent(a) {
    const name = String(a.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('نام ساب‌ایجنت باید حروف انگلیسی/عدد باشد');
    if (!String(a.prompt || '').trim()) throw new Error('دستورالعمل ساب‌ایجنت خالی است');
    const clash = this._subagents.find(x => x.name === name && x.id !== a.id);
    if (clash) throw new Error('این نام قبلاً استفاده شده');
    const clean = {
      // Only ids we issued (or the built-in ones) are kept; anything else gets a fresh id.
      // The id ends up in HTML attributes, so it must never carry markup (stored XSS).
      id: typeof a.id === 'string' && /^[\w-]{1,40}$/.test(a.id) ? a.id : crypto.randomUUID().slice(0, 8), name,
      // an icon name from the panel's icon set, or (older agents) a short emoji
      icon: /^[a-z0-9-]{1,30}$/.test(String(a.icon || '')) ? a.icon : String(a.icon || 'bot').slice(0, 4),
      engine: a.engine === 'codex' ? 'codex' : 'claude',
      // who runs it: '' = same as the main reviewer, 'engine:codex' = Codex account,
      // a Claude model id, or a connection 'p:<id>:<model>'
      model: /^(engine:(claude|codex)|p:[a-z0-9-]{1,40}:[\w.:\-\/[\]@]{1,100}|[\w.:\-[\]]{1,80})?$/.test(String(a.model || '')) ? String(a.model || '') : '',
      stage: ['builder', 'assistant'].includes(a.stage) ? a.stage : 'review',
      enabled: a.enabled !== false,
      description: String(a.description || '').slice(0, 300),
      prompt: String(a.prompt).slice(0, 8000),
      skills: Array.isArray(a.skills) ? [...new Set(a.skills.map(String).filter(x => /^[\w-]{1,40}$/.test(x)))].slice(0, 30) : [],
      ...(typeof a.plugin === 'string' && /^[\w-]{1,60}$/.test(a.plugin) ? { plugin: a.plugin } : {}),
    };
    if (clean.stage === 'builder') { clean.engine = 'claude'; clean.model = ''; } // they run inside the builder's session
    const i = this._subagents.findIndex(x => x.id === clean.id);
    if (i >= 0) {
      // keep the last 10 versions (so a change can be undone)
      const { versions = [], ...prev } = this._subagents[i];
      const changed = ['prompt', 'description', 'model', 'engine', 'stage', 'name', 'icon', 'skills'].some(k => JSON.stringify(prev[k]) !== JSON.stringify(clean[k]));
      clean.versions = changed ? [{ ...prev, savedAt: Date.now() }, ...versions].slice(0, 10) : versions;
      clean.createdAt = prev.createdAt || Date.now();
      this._subagents[i] = clean;
    } else { clean.createdAt = Date.now(); this._subagents.push(clean); }
    clean.updatedAt = Date.now();
    this._write('subagents.json', this._subagents);
    return clean;
  }
  deleteSubagent(id) {
    this._subagents = this._subagents.filter(a => a.id !== id);
    this._write('subagents.json', this._subagents);
  }
  resetSubagents() {
    this._subagents = DEFAULT_SUBAGENTS.map(a => ({ ...a }));
    this._write('subagents.json', this._subagents);
    return this._subagents;
  }

  // Per-chat model choice (chat-level override of builderModel/builderEffort/codexModel/codexEffort).
  // '' means "use the settings value".
  static cleanModels(m) {
    const out = {};
    const id = v => (typeof v === 'string' && /^[\w.:\-[\]/]{0,80}$/.test(v.trim()) ? v.trim() : '');
    const eff = (v, ok) => (ok.includes(v) ? v : '');
    if (m && typeof m === 'object') {
      out.builderModel = resolveAlias(id(m.builderModel));
      out.builderEffort = eff(m.builderEffort, ['', 'low', 'medium', 'high', 'xhigh', 'max']);
      out.codexModel = id(m.codexModel);
      out.codexEffort = eff(m.codexEffort, ['', 'minimal', 'low', 'medium', 'high']);
    }
    return out;
  }
  setChatModels(chat, m) {
    chat.models = Store.cleanModels(m);
    this.saveChat(chat, true);
    return chat.models;
  }

  // projects
  projects() { return this._projects; }
  project(id) { return this._projects.find(p => p.id === id); }
  addProject(p) {
    const resolved = path.resolve(p.path);
    const existing = this._projects.find(x => x.path.toLowerCase() === resolved.toLowerCase());
    if (existing) return existing;
    const proj = { id: crypto.randomUUID().slice(0, 8), name: p.name || path.basename(resolved), path: resolved, addedAt: Date.now() };
    this._projects.push(proj);
    this._write('projects.json', this._projects);
    return proj;
  }
  removeProject(id) {
    this._projects = this._projects.filter(p => p.id !== id);
    this._write('projects.json', this._projects);
  }

  // chats
  newChat(projectId, title) {
    const c = {
      id: crypto.randomUUID(), projectId, title: title || 'چت جدید', createdAt: Date.now(), status: 'idle',
      claudeSession: null, reviewerSession: null, codexThread: null, models: {},
      cost: { claudeUsd: 0, codexTokens: 0 }, touchedFiles: [], messages: [],
    };
    this.chats.set(c.id, c);
    this.saveChat(c, true);
    return c;
  }
  chat(id) { return this.chats.get(id); }
  chatSummary(c) {
    const last = c.messages[c.messages.length - 1];
    return { id: c.id, projectId: c.projectId, title: c.title, status: c.status, createdAt: c.createdAt, updatedAt: last ? last.ts : c.createdAt, cost: c.cost, count: c.messages.length };
  }
  // Search chat titles and message text; returns summaries with a short snippet.
  searchChats(q, projectId) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const c of this.chats.values()) {
      if (projectId && c.projectId !== projectId) continue;
      let snippet = null;
      if (c.title.toLowerCase().includes(q)) snippet = '';
      else for (const m of c.messages) {
        const t = typeof m.text === 'string' ? m.text : '';
        const i = t.toLowerCase().indexOf(q);
        if (i >= 0) { snippet = (i > 30 ? '…' : '') + t.slice(Math.max(0, i - 30), i + q.length + 50).replace(/\s+/g, ' '); break; }
      }
      if (snippet !== null) out.push({ ...this.chatSummary(c), snippet });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  }
  // ---- backup / restore (one JSON file) ----
  backup() {
    const { requireToken, ...settings } = this._settings;
    return { app: 'jarvis', version: 1, exportedAt: Date.now(), settings, projects: this._projects, subagents: this._subagents, chats: [...this.chats.values()] };
  }
  // Merge: existing items (same id / same folder) are kept; only missing ones are added.
  restore(data) {
    if (!data || data.app !== 'jarvis') throw new Error('این فایل پشتیبان جارویس نیست');
    const n = { settings: 0, projects: 0, subagents: 0, chats: 0 };
    if (data.settings && typeof data.settings === 'object') {
      const { requireToken, ...rest } = data.settings;
      Object.assign(this._settings, Store.cleanSettings(rest)); this._write('settings.json', this._settings); n.settings = 1;
    }
    for (const p of Array.isArray(data.projects) ? data.projects : []) {
      if (!p || !p.id || !p.path || this._projects.some(x => x.id === p.id || x.path.toLowerCase() === String(p.path).toLowerCase())) continue;
      this._projects.push({ id: String(p.id).slice(0, 40), name: String(p.name || path.basename(p.path)).slice(0, 120), path: String(p.path), addedAt: +p.addedAt || Date.now(), ...(p.settings ? { settings: Store.cleanSettings(p.settings) } : {}) });
      n.projects++;
    }
    if (n.projects) this._write('projects.json', this._projects);
    for (const a of Array.isArray(data.subagents) ? data.subagents : []) {
      if (!a || !a.id || !/^[\w-]{1,40}$/.test(a.id) || this._subagents.some(x => x.id === a.id)) continue;
      this._subagents.push(a); n.subagents++;
    }
    if (n.subagents) this._write('subagents.json', this._subagents);
    for (const c of Array.isArray(data.chats) ? data.chats : []) {
      if (!c || !c.id || !/^[\w-]{8,64}$/.test(c.id) || this.chats.has(c.id) || !Array.isArray(c.messages)) continue;
      if (c.status === 'running' || c.status === 'waiting') c.status = 'stopped';
      c.cost = c.cost || { claudeUsd: 0, codexTokens: 0 }; c.models = c.models || {}; c.touchedFiles = c.touchedFiles || [];
      this.chats.set(c.id, c); this.saveChat(c, true); n.chats++;
    }
    return n;
  }
  listChats(projectId) {
    return [...this.chats.values()].filter(c => !projectId || c.projectId === projectId)
      .map(c => this.chatSummary(c)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  deleteChat(id) {
    // Cancel a pending debounced write and refuse later writes: a run that is still
    // finishing (or a message saved just before) must not bring the chat back.
    clearTimeout(this._timers.get(id));
    this._timers.delete(id);
    this._deleted.add(id);
    this.chats.delete(id);
    fs.rm(path.join(this.chatDir, id + '.json'), { force: true }, () => {});
  }
  // Debounced write: chats get many small appends while agents stream.
  saveChat(c, now) {
    if (!c || this._deleted.has(c.id)) return;
    const write = () => {
      this._timers.delete(c.id);
      if (this._deleted.has(c.id)) return;
      const p = path.join(this.chatDir, c.id + '.json');
      fs.writeFileSync(p + '.tmp', JSON.stringify(c));
      fs.renameSync(p + '.tmp', p);
    };
    if (now) return write();
    if (!this._timers.has(c.id)) this._timers.set(c.id, setTimeout(write, 400));
  }
  flush() {
    for (const [id, t] of this._timers) { clearTimeout(t); this._timers.delete(id); const c = this.chats.get(id); if (c) this.saveChat(c, true); }
  }
}

module.exports = { Store };
