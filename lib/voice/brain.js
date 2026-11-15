// The voice assistant's brain: understands a spoken request (Persian or English), answers in
// a short spoken sentence and, when needed, picks ONE action from a fixed list.
// Actions that change things in a project need a "yes" first.
'use strict';

const ACTIONS = {
  run_team: { confirm: true, desc: 'start the coding agent team on a project. params: {"project": "<project name>", "task": "<what to build/fix, in the user\'s words>", "mode": "team|smart|audit|plan"}' },
  stop: { confirm: false, desc: 'stop running agent work. params: {"chat": "<chat title, or empty for all>"}' },
  add_task: { confirm: false, desc: 'add a personal/work task or reminder. params: {"title": "...", "due": "<ISO 8601 local date-time or empty>", "priority": "low|normal|high"}' },
  complete_task: { confirm: false, desc: 'mark a task done. params: {"id": "<task id from the list>"}' },
  open: { confirm: false, desc: 'open a part of the app. params: {"section": "home|settings|connectors|plugins|queue|ops|voice|chat", "chat": "<chat title when section=chat>"}' },
};

const YES = /^(بله|آره|اره|باشه|حتما|حتماً|انجام بده|بزن بریم|اوکی|اوکِی|تایید|تأیید|yes|yeah|yep|sure|ok|okay|do it|go ahead|confirm)(?=$|[\s.,!?؟،])/i;
const NO = /^(نه|نخیر|خیر|لغو|ولش کن|بیخیال|نمی‌خوام|نمیخوام|no|nope|cancel|stop|never ?mind)(?=$|[\s.,!?؟،])/i;
// (\b does not work after Persian letters, so the word end is matched explicitly)

// Real dates for the examples (small local models copy placeholders literally).
function exampleDates(nowIso) {
  const base = nowIso ? new Date(nowIso.slice(0, 19)) : new Date();
  const pad = n => String(n).padStart(2, '0');
  const day = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const t = new Date(base); t.setDate(t.getDate() + 1);
  const h = new Date(base.getTime() + 3600e3);
  return { tomorrow10: day(t) + 'T10:00:00', inHour: day(h) + 'T' + pad(h.getHours()) + ':' + pad(h.getMinutes()) + ':00' };
}

function systemPrompt(ctx) {
  const ex = exampleDates(ctx.nowIso);
  return `You are JARVIS, the user's personal AI assistant on their Windows computer. You speak like a capable, calm, friendly assistant.
Reply in the SAME language the user spoke (Persian/Farsi or English). ${ctx.channel === 'telegram'
    ? 'Your reply is a Telegram message (it may also be sent as a voice note): be concise — usually 1–4 sentences; when the user asks for details, up to ~12 short lines. Plain text only, no markdown symbols.'
    : 'Your reply is read aloud: keep it short (1–3 sentences), natural, no markdown, no lists, no emojis.'}
You can do ONE of these actions when the request needs it (otherwise action is null):
${Object.entries(ACTIONS).map(([k, a]) => `- ${k}: ${a.desc}`).join('\n')}
Only use projects, chats and tasks that exist in the context below. If something is ambiguous (e.g. which project), ask a short question instead of guessing.
Never claim an action is done — the app does it after your answer; say what you are going to do.
Rules for actions:
- Use a due date ONLY when the user gave a time or day; otherwise "due" is "".
- Any "remind me", "remember to", "add a task", "یادم بنداز", "یادت باشه", "تسک ... اضافه کن", "باید ... بخرم/انجام بدم" => ALWAYS use add_task (title in the user's language, short). Turn relative times ("tomorrow 10am", "فردا ساعت ده", "یک ساعت دیگه") into a full local ISO date-time using "Now" below.
- "I did / finished X", "X انجام شد" for an open task => complete_task with its id.
Examples (the JSON is the whole answer):
User: فردا ساعت ده صبح یادم بنداز نان بخرم
{"say": "باشه، برای فردا ساعت ده صبح یادآوری «نان بخرم» را می‌گذارم.", "action": {"type": "add_task", "params": {"title": "نان بخرم", "due": "${ex.tomorrow10}", "priority": "normal"}}}
User: خرید شیر را به تسک‌هایم اضافه کن
{"say": "باشه، «خرید شیر» را به تسک‌ها اضافه می‌کنم.", "action": {"type": "add_task", "params": {"title": "خرید شیر", "due": "", "priority": "normal"}}}
User: remind me in one hour to call mom
{"say": "Sure, I'll remind you in an hour to call mom.", "action": {"type": "add_task", "params": {"title": "Call mom", "due": "${ex.inHour}", "priority": "normal"}}}
User: what time is it?
{"say": "It's <the time from Now below>.", "action": null}
User: سلام، حالت چطوره؟
{"say": "سلام! خوبم، ممنون. چه کاری برایتان انجام بدهم؟", "action": null}
User: stop the agents
{"say": "Stopping the running agent work.", "action": {"type": "stop", "params": {"chat": ""}}}
Answer with ONLY this JSON object and nothing else:
{"say": "<spoken reply>", "action": null | {"type": "<action>", "params": {...}}}

== Context (live) ==
Now: ${ctx.now}${ctx.nowIso ? ` (local ISO: ${ctx.nowIso})` : ''}
Projects: ${ctx.projects.length ? ctx.projects.map(p => `"${p.name}"`).join(', ') : '(none)'}
Running agent work: ${ctx.running.length ? ctx.running.map(c => `"${c.title}" on ${c.project} (${c.status})`).join('; ') : 'nothing is running'}
Recently finished: ${ctx.recent.length ? ctx.recent.map(c => `"${c.title}" — ${c.status}${c.report ? ' — ' + c.report : ''}`).join('; ') : '(none)'}
Open tasks: ${ctx.tasks.length ? ctx.tasks.map(t => `[${t.id}] ${t.title}${t.due ? ' (due ' + new Date(t.due).toLocaleString('en-GB') + ')' : ''}${t.priority === 'high' ? ' !' : ''}`).join('; ') : '(none)'}`;
}

function parseReply(text) {
  const t = String(text || '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try {
      const j = JSON.parse(t.slice(s, e + 1));
      const say = String(j.say || '').trim();
      let action = j.action && typeof j.action === 'object' && ACTIONS[j.action.type] ? { type: j.action.type, params: j.action.params && typeof j.action.params === 'object' ? j.action.params : {} } : null;
      if (say || action) return { say, action };
    } catch {}
  }
  // model answered in plain text: speak it, no action
  return { say: t.replace(/```[\s\S]*?```/g, '').trim().slice(0, 600), action: null };
}

class Brain {
  // chat(opts) -> { text }  (lib/llm.js); context() -> live context object; history kept per session
  constructor({ chat, context }) { this.chat = chat; this.context = context; this.history = []; this.pending = null; }

  // -> { say, action|null, confirm: bool, confirmed?: action, cancelled?: true }
  async handle(text, { spec, signal } = {}) {
    const said = String(text || '').trim();
    if (!said) return { say: '', action: null, confirm: false };
    // a yes/no answer to a pending confirmation
    if (this.pending) {
      const p = this.pending;
      if (YES.test(said)) { this.pending = null; this._remember(said, 'باشه.'); return { say: p.lang === 'fa' ? 'باشه، انجامش می‌دهم.' : 'Okay, doing it now.', action: p.action, confirm: false, confirmed: true }; }
      if (NO.test(said)) { this.pending = null; this._remember(said, 'لغو شد.'); return { say: p.lang === 'fa' ? 'باشه، لغو شد.' : 'Okay, cancelled.', action: null, confirm: false, cancelled: true }; }
      this.pending = null; // a new request replaces the question
    }
    const ctx = this.context();
    const r = await this.chat({ spec, system: systemPrompt(ctx), messages: [...this.history.slice(-8), { role: 'user', content: said }], maxTokens: 500, temperature: 0.3, json: true, signal });
    const out = parseReply(r.text);
    this._remember(said, out.say || '(action)');
    const needs = !!(out.action && ACTIONS[out.action.type].confirm);
    if (needs) this.pending = { action: out.action, lang: /[؀-ۿ]/.test(said) ? 'fa' : 'en' };
    return { say: out.say, action: out.action, confirm: needs };
  }
  confirm(yes) {
    const p = this.pending; this.pending = null;
    return yes && p ? p.action : null;
  }
  _remember(user, assistant) {
    this.history.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
    if (this.history.length > 20) this.history.splice(0, this.history.length - 20);
  }
  reset() { this.history = []; this.pending = null; }
}

module.exports = { Brain, ACTIONS, parseReply, systemPrompt, YES, NO };
