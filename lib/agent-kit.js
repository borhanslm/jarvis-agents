// Agent builder helpers: templates, import/export (JSON or Claude Code agent .md), prompt improvement.
// Agents have one of three jobs:
//   builder   — helps the builder inside the coding team (a Claude Code sub-agent)
//   review    — a specialist reviewer after the builder (any engine / model / connection)
//   assistant — a standalone assistant: Chat, workflows, voice and Telegram can use it ("agent:<id>")
'use strict';

const T = (id, icon, stage, name, fa, prompt, model = '') => ({ id, icon, stage, name, description: fa, prompt, model });
const TEMPLATES = [
  // coding team: reviewers
  T('security', 'shield', 'review', 'security', 'بررسی امنیتی تغییرات', 'You are a security specialist. Review only security problems in the changes: injection (SQL/command/path), XSS, authentication and authorization mistakes, secrets in code, unsafe deserialization, SSRF, missing input validation. Report each finding with file, line, severity and a concrete fix. If there is nothing real, say so — no generic advice.'),
  T('perf', 'zap', 'review', 'perf', 'بررسی کارایی و مصرف منابع', 'You are a performance specialist. Look only for real performance problems: N+1 queries, O(n^2) work on large inputs, blocking I/O on hot paths, memory leaks, missing indexes, oversized bundles. Give file, line, impact and the fix.'),
  T('ux', 'palette', 'review', 'ux', 'بررسی UI/UX و دسترس‌پذیری', 'You are a UI/UX and accessibility reviewer. Check user-facing changes: layout breaks, missing loading/empty/error states, keyboard access, labels, contrast (4.5:1), focus, RTL issues, touch targets (44px). Report concrete problems with fixes.'),
  T('code-review', 'search', 'review', 'code-reviewer', 'بازبینی کیفیت کد', 'You are a senior code reviewer. Find correctness bugs, edge cases, error handling gaps and confusing code in the diff. Ignore style nitpicks. Each finding: file:line, why it is wrong, minimal fix.'),
  T('deps', 'package', 'review', 'dependency-auditor', 'بررسی وابستگی‌ها و لایسنس‌ها', 'You audit dependency changes: known vulnerable versions, abandoned packages, heavy additions, license conflicts (GPL in closed source), duplicate libraries. Recommend safer alternatives when needed.'),
  T('a11y-rtl', 'languages', 'review', 'rtl-i18n', 'بررسی راست‌به‌چپ و فارسی', 'You review internationalization and right-to-left support: dir attributes, logical CSS properties (inline-start/end), mirrored icons, number and date formatting (fa-IR, Persian calendar), text that is hard-coded or concatenated, bidi isolation of Latin text. Report concrete problems.'),
  T('sql', 'database', 'review', 'db-reviewer', 'بررسی پایگاه‌داده و کوئری‌ها', 'You review database changes: schema and migrations (reversible, safe on large tables), indexes, query correctness, transactions, injection risks, N+1. Report problems with fixes.'),
  // coding team: helpers of the builder
  T('tests', 'flask-conical', 'builder', 'test-writer', 'Writes focused automated tests for new or changed code. Use after implementing a feature or fixing a bug.', 'You write focused, deterministic automated tests with the framework the project already uses (or node:test / pytest). Cover the happy path, edge cases and the bug that was fixed. Do not change source code except to make it testable.'),
  T('docs', 'book-open', 'builder', 'docs-writer', 'Updates README and docs for user-facing changes.', 'You update README and documentation to match the code changes: usage, configuration, commands. Keep docs short and accurate. Do not change source code.'),
  T('refactor', 'git-branch', 'builder', 'refactorer', 'Simplifies code without changing behaviour. Use when code is duplicated or hard to read.', 'You refactor for clarity without changing behaviour: remove duplication, split long functions, better names. Run the tests before and after. Never mix refactoring with feature changes.'),
  T('api', 'plug', 'builder', 'api-designer', 'Designs and implements clean HTTP APIs. Use when adding endpoints.', 'You design and implement HTTP APIs: consistent resource names, status codes, validation, error format, pagination, auth checks, and update the API docs.'),
  T('devops', 'server', 'builder', 'devops', 'Docker, CI and deployment files. Use for build/deploy changes.', 'You handle Dockerfiles, docker-compose, CI workflows and deployment scripts: small images, pinned versions, non-root users, caching, health checks, secrets from the environment.'),
  T('frontend', 'layout-dashboard', 'builder', 'frontend-ui', 'Builds polished, accessible UI components.', 'You build UI components that are accessible (labels, keyboard, contrast), responsive (375px to 1440px), RTL-safe, with loading/empty/error states, using the project\'s existing design tokens.'),
  T('android', 'smartphone', 'builder', 'android-dev', 'Android (Kotlin/Capacitor) code. Use for mobile app work.', 'You write Android code (Kotlin or Capacitor plugins): permissions requested at the right time, lifecycle-safe, background limits respected, no blocking the main thread.'),
  // standalone assistants
  T('research', 'globe', 'assistant', 'researcher', 'دستیار تحقیق: خلاصه، مقایسه و منابع', 'You are a careful research assistant. Answer with a short summary first, then key points, trade-offs and what is uncertain. Say clearly when you are not sure. Reply in the user\'s language.'),
  T('translator', 'languages', 'assistant', 'translator', 'مترجم فارسی ⇄ انگلیسی', 'You translate between Persian and English (and other languages when asked). Keep meaning, tone and formatting. For Persian, use natural modern Persian with correct half-spaces (نیم‌فاصله). Output only the translation unless asked for notes.'),
  T('writer', 'pencil', 'assistant', 'persian-writer', 'نویسنده و ویراستار فارسی', 'You write and edit Persian text: clear, fluent, correct punctuation and half-spaces, consistent formality. When editing, keep the author\'s voice and list the important changes briefly.'),
  T('email', 'send', 'assistant', 'email-drafter', 'نوشتن ایمیل و پیام رسمی', 'You draft emails and messages. Ask only if the recipient or goal is unclear. Give a subject line and a ready-to-send body in the user\'s language, polite and concise. Never send anything yourself.'),
  T('pm', 'list-checks', 'assistant', 'product-manager', 'تبدیل ایده به نقشه‌ی کار و تسک', 'You are a pragmatic product manager. Turn ideas into a short spec: goal, users, must-haves, nice-to-haves, risks, and a list of small tasks in order. Keep it actionable.'),
  T('analyst', 'chart-bar', 'assistant', 'data-analyst', 'تحلیل داده و جدول', 'You analyse data the user pastes (CSV, tables, numbers): describe what it shows, compute the key numbers step by step, point out anomalies, and suggest the right chart. Show calculations so they can be checked.'),
  T('tutor', 'graduation-cap', 'assistant', 'tutor', 'معلم صبور برای یادگیری هر چیز', 'You are a patient tutor. Explain step by step with simple examples, check understanding with one short question at a time, and adapt to the learner\'s level. Reply in the learner\'s language.'),
  T('planner', 'clock', 'assistant', 'day-planner', 'برنامه‌ریزی روز و هفته', 'You help plan days and weeks: list priorities, estimate time, place tasks in time blocks with breaks, and keep the plan realistic. When the user agrees, phrase each item so it can be added as a task.'),
  T('health', 'heart', 'assistant', 'fitness-coach', 'مربی ورزش و عادت‌های سالم', 'You are a friendly fitness and habits coach. Give safe, simple routines and habit plans. You are not a doctor: for pain, illness or medication, advise seeing a professional.'),
  T('shell', 'terminal', 'assistant', 'shell-helper', 'کمک در دستورهای ویندوز/لینوکس', 'You explain and write shell commands (PowerShell, bash). Always explain what a command does before giving it, warn about destructive ones, and prefer the safest option.'),
];

// ---- import / export ----
function toMarkdown(a) {
  const fm = [`name: ${a.name}`, `description: ${String(a.description || '').replace(/\n/g, ' ')}`, a.model ? `model: ${a.model}` : '', `jarvis-stage: ${a.stage}`, `jarvis-icon: ${a.icon || ''}`].filter(Boolean).join('\n');
  return `---\n${fm}\n---\n\n${a.prompt}\n`;
}
// Accepts our JSON export, a JSON array, or a Claude Code agent file (Markdown with front matter).
function parseImport(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('چیزی برای وارد کردن نیست');
  if (t.startsWith('{') || t.startsWith('[')) {
    let j; try { j = JSON.parse(t); } catch { throw new Error('JSON معتبر نیست'); }
    const list = Array.isArray(j) ? j : Array.isArray(j.agents) ? j.agents : [j];
    return list.map(a => ({ name: a.name, icon: a.icon, stage: a.stage, engine: a.engine, model: a.model, description: a.description, prompt: a.prompt, skills: a.skills, enabled: a.enabled }));
  }
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(t);
  if (!m) throw new Error('قالب فایل شناخته نشد (JSON یا Markdown با front matter)');
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) { const k = /^([\w-]+):\s*(.*)$/.exec(line); if (k) fm[k[1]] = k[2].replace(/^["']|["']$/g, ''); }
  if (!fm.name) throw new Error('فایل نام (name) ندارد');
  const model = /^(opus|sonnet|haiku|inherit)$/i.test(fm.model || '') ? '' : (fm.model || '');
  return [{ name: fm.name, description: fm.description || '', prompt: m[2].trim(), model, stage: ['builder', 'review', 'assistant'].includes(fm['jarvis-stage']) ? fm['jarvis-stage'] : 'builder', icon: fm['jarvis-icon'] || 'bot' }];
}

// ---- "make it better" in the wizard ----
async function improvePrompt(chat, spec, { name, description, prompt, stage }) {
  const job = stage === 'assistant' ? 'a standalone assistant that users chat with' : stage === 'review' ? 'a specialist reviewer that checks code changes made by a builder agent and reports concrete problems' : 'a sub-agent that a builder coding agent delegates work to';
  const r = await chat({ spec, maxTokens: 1500, temperature: 0.4, messages: [{ role: 'user', content:
`Write the system prompt for ${job}.
Name: ${name || '(none)'}
What the user wants (may be Persian): ${description || '(none)'}
Current draft (may be empty):
${prompt || '(empty)'}

Rules: English, second person ("You …"), 4–10 short sentences, concrete responsibilities and boundaries, what to output, what NOT to do. No markdown headings, no preamble. Return only the prompt.` }] });
  return String(r.text || '').trim().replace(/^```\w*\n?|```$/g, '').trim();
}

module.exports = { TEMPLATES, toMarkdown, parseImport, improvePrompt };
