// The voice assistant's brain: understands a spoken request (Persian or English), answers in
// a short spoken sentence and, when needed, picks ONE action from a fixed list.
// Actions that change things in a project need a "yes" first.
'use strict';

const ACTIONS = {
  run_team: { confirm: true, desc: 'start the coding agent team on a project. params: {"project": "<project name>", "task": "<what to build/fix, in the user\'s words>", "mode": "team|smart|audit|plan"}' },
  stop: { confirm: false, desc: 'stop running agent work. params: {"chat": "<chat title, or empty for all>"}' },
  add_task: { confirm: false, desc: 'add a personal/work task or reminder. params: {"title": "...", "due": "<ISO 8601 local date-time or empty>", "priority": "low|normal|high", "category": "life|work", "repeat": "|daily|weekdays|weekly|monthly", "remindBefore": <minutes before due to remind, default 0>}' },
  complete_task: { confirm: false, desc: 'mark a task done. params: {"id": "<task id from the list>"}' },
  open: { confirm: false, desc: 'open a part of the JARVIS app itself (NOT other programs). params: {"section": "home|jarvis|ai|chat|tasks|workflows|agents|phone|sms|seller|club|settings|connectors|plugins|queue|ops", "chat": "<chat title when section=chat>"}' },
  mark_read: { confirm: false, desc: 'mark the JARVIS notifications (the bell) as read, after you told the user about them. params: {}' },
  // ---- the computer (Windows) ----
  open_app: { confirm: false, desc: 'open a program on the computer (Chrome, Word, Telegram, Notepad, Calculator, Spotify, VS Code, Settings…). params: {"name": "<program name, in English when you know it, e.g. Google Chrome>"}' },
  open_url: { confirm: false, desc: 'open a website in the browser. params: {"url": "<site name like youtube, or an address like digikala.com>"}' },
  web_search: { confirm: false, desc: 'search the web in the browser. params: {"query": "...", "site": "google|youtube|wikipedia|maps"}' },
  open_folder: { confirm: false, desc: 'open a folder. params: {"folder": "desktop|downloads|documents|pictures|music|videos"}' },
  volume: { confirm: false, desc: 'computer sound volume. params: {"action": "up|down|mute|set", "level": <0-100 when action=set>}' },
  media: { confirm: false, desc: 'music/video playback keys. params: {"action": "play_pause|next|prev"}' },
  screenshot: { confirm: false, desc: 'take a screenshot of the screen (saved in Pictures/JARVIS). params: {}' },
  close_app: { confirm: true, desc: 'close a program window (it may ask to save). params: {"name": "<program name>"}' },
  power: { confirm: p => p && p.action !== 'lock' && p.action !== 'cancel', desc: 'lock the screen, sleep, shut down or restart the computer (shut down/restart wait one minute), or cancel a pending shut down. params: {"action": "lock|sleep|shutdown|restart|cancel"}' },
};
// Only for the admin (the seller): purchase requests of the Android app. Always asked first.
const ADMIN_ACTIONS = {
  approve_purchase: { confirm: true, desc: 'approve a pending purchase request: issues the license and the buyer\'s app activates itself. params: {"id": "<id from Pending purchase requests>"}' },
  reject_purchase: { confirm: true, desc: 'reject a pending purchase request. params: {"id": "<id>", "reason": "<short reason in Persian>"}' },
};
// Done on the phone itself when the request comes from the Android app (the phone asks before sending or calling).
const PHONE_ACTIONS = {
  phone_open_app: { desc: 'open an app on the PHONE (Telegram, Instagram, camera, WhatsApp, Bale…). params: {"name": "<app name>"}' },
  phone_sms: { desc: 'read recent SMS on the phone, or the latest verification code. params: {"from": "<sender or empty>", "code": true|false}' },
  phone_sms_send: { desc: 'send an SMS from the phone (the phone asks the user to confirm). params: {"to": "<contact name or number>", "text": "..."}' },
  phone_call: { desc: 'call someone from the phone (the phone asks the user to confirm). params: {"to": "<contact name or number>"}' },
  phone_contact: { desc: 'find a phone number in the phone contacts. params: {"name": "..."}' },
  phone_missed: { desc: 'recent missed calls and calls on the phone. params: {}' },
  phone_notifications: { desc: 'what notifications arrived on the phone (messages from apps). params: {}' },
  phone_do: { desc: 'do a multi-step task inside another phone app by reading and tapping its screen (e.g. "in Telegram send Ali hello"). params: {"app": "<app name>", "goal": "<what to do, in the user\'s words>"}' },
};
const ALL_ACTIONS = { ...ACTIONS, ...ADMIN_ACTIONS, ...PHONE_ACTIONS };
const needsConfirm = a => { const d = a && (ACTIONS[a.type] || ADMIN_ACTIONS[a.type]); const c = d && d.confirm; return typeof c === 'function' ? !!c(a.params || {}) : !!c; };

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
${Object.entries(ACTIONS).map(([k, a]) => `- ${k}: ${a.desc}`).join('\n')}${ctx.admin ? '\n' + Object.entries(ADMIN_ACTIONS).map(([k, a]) => `- ${k}: ${a.desc}`).join('\n') : ''}${ctx.phone === true ? `
The user is talking to you from their PHONE (Android). These act on the phone itself:
${Object.entries(PHONE_ACTIONS).map(([k, a]) => `- ${k}: ${a.desc}`).join('\n')}
"X را باز کن" from the phone means a PHONE app (phone_open_app) unless they say computer / کامپیوتر. "کد تایید / کد پیامکی" => phone_sms with code true. "به X پیام بده / پیامک بده" => phone_sms_send; in an app like Telegram/WhatsApp => phone_do.` : ctx.phone === 'remote' ? `
The user is at the COMPUTER, and their Android phone is paired. Anything that needs the phone (SMS, verification codes, calls, contacts, phone notifications, phone apps, tasks inside phone apps like Telegram/WhatsApp) is sent to the phone app, which asks them to confirm there:
${Object.entries(PHONE_ACTIONS).map(([k, a]) => `- ${k}: ${a.desc}`).join('\n')}
Programs and websites on the computer still use open_app / open_url. For a phone action say it is being done on the phone (e.g. «روی گوشی‌تان تأیید کنید»).` : ''}
Only use projects, chats and tasks that exist in the context below. If something is ambiguous (e.g. which project), ask a short question instead of guessing.
Never claim an action is done — the app does it after your answer; say what you are going to do.
Rules for actions:
- Use a due date ONLY when the user gave a time or day; otherwise "due" is "".
- Any "remind me", "remember to", "add a task", "یادم بنداز", "یادت باشه", "تسک ... اضافه کن", "باید ... بخرم/انجام بدم" => ALWAYS use add_task (title in the user's language, short). Turn relative times ("tomorrow 10am", "فردا ساعت ده", "یک ساعت دیگه") into a full local ISO date-time using "Now" below.
- "I did / finished X", "X انجام شد" for an open task => complete_task with its id.
- You can see the user's tasks, JARVIS notifications, phone SMS / notifications and purchase requests in the context below when they ask about them. Questions like "tasks for tomorrow / this week", "what's new", "any new messages?", "read my SMS", "who wants to buy?" => answer from the context (summarize: who, what, when; read the important ones). Never invent items that are not in the context. If a list is not in the context, say so and offer to open the related section.
- After you report the unread JARVIS notifications, use mark_read.${ctx.admin ? `
- approve_purchase / reject_purchase only with an id from "Pending purchase requests"; if more than one could match, ask which one (by name, amount or tracking number).` : ''}
- The user's words come from speech recognition, which sometimes mishears (wrong or nonsense words, a name spelled oddly, e.g. «کرم را باز کن» for «کروم را باز کن»). When a word does not fit, do NOT act on it and do NOT ignore it: guess the most likely words from the context (projects, tasks, apps, names, learned corrections) and ask ONE short question, e.g. «منظورتان "کروم" بود؟». Then answer with action null and "guess": {"heard": "<the misheard words exactly as written>", "meant": "<your guess>"}. Only guess when it is really unclear; normal sentences are just answered.
- When the user corrects how you heard them («نه، گفتم X», «منظورم X بود»), add "learn": {"heard": "<what you wrongly heard>", "meant": "X"} and do the corrected request.
- You CAN control this computer with open_app, open_url, web_search, open_folder, volume, media, screenshot, close_app and power. "X را باز کن" for a program => open_app; for a website => open_url. Never say you cannot open programs.
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
User: گوگل کروم را باز کن
{"say": "باشه، کروم را باز می‌کنم.", "action": {"type": "open_app", "params": {"name": "Google Chrome"}}}
User: open notepad
{"say": "Opening Notepad.", "action": {"type": "open_app", "params": {"name": "Notepad"}}}
User: یوتیوب را باز کن
{"say": "باشه، یوتیوب را باز می‌کنم.", "action": {"type": "open_url", "params": {"url": "youtube"}}}
User: تو گوگل هوای تهران را سرچ کن
{"say": "باشه، هوای تهران را در گوگل جستجو می‌کنم.", "action": {"type": "web_search", "params": {"query": "هوای تهران", "site": "google"}}}
User: صدا را کم کن
{"say": "باشه، صدا را کم می‌کنم.", "action": {"type": "volume", "params": {"action": "down"}}}
User: کامپیوتر را خاموش کن
{"say": "کامپیوتر را خاموش کنم؟ بله یا نه؟", "action": {"type": "power", "params": {"action": "shutdown"}}}
User: stop the agents
{"say": "Stopping the running agent work.", "action": {"type": "stop", "params": {"chat": ""}}}
User: کرم را باز کن
{"say": "منظورتان «کروم» بود؟", "action": null, "guess": {"heard": "کرم", "meant": "کروم"}}
Answer with ONLY this JSON object and nothing else:
{"say": "<spoken reply>", "action": null | {"type": "<action>", "params": {...}}, "guess"?: {"heard": "...", "meant": "..."}, "learn"?: {"heard": "...", "meant": "..."}}

== Context (live) ==
Now: ${ctx.now}${ctx.nowIso ? ` (local ISO: ${ctx.nowIso})` : ''}
${ctx.learned && ctx.learned.length ? `Learned hearing corrections (heard → meant): ${ctx.learned.map(c => `${c.heard} → ${c.meant}`).join('; ')}
` : ''}Projects: ${ctx.projects.length ? ctx.projects.map(p => `"${p.name}"`).join(', ') : '(none)'}
Running agent work: ${ctx.running.length ? ctx.running.map(c => `"${c.title}" on ${c.project} (${c.status})`).join('; ') : 'nothing is running'}
Recently finished: ${ctx.recent.length ? ctx.recent.map(c => `"${c.title}" — ${c.status}${c.report ? ' — ' + c.report : ''}`).join('; ') : '(none)'}
Open tasks (today, overdue, undated): ${ctx.tasks.length ? ctx.tasks.map(taskLine).join('; ') : '(none)'}${ctx.upcoming ? `
Upcoming tasks (next 7 days): ${ctx.upcoming.length ? ctx.upcoming.map(taskLine).join('; ') : '(none)'}` : ''}${ctx.notices ? `
Unread JARVIS notifications: ${ctx.notices.length ? ctx.notices.map(n => `[${n.kind}] ${n.title}${n.body ? ' — ' + n.body : ''} (${n.ago})`).join('; ') : '(none)'}` : ''}${ctx.sms ? `
Latest SMS received on the phone${ctx.smsAt ? ' (copied ' + ctx.smsAt + ')' : ''}: ${ctx.sms.length ? ctx.sms.map(m => `from ${m.from} (${m.ago}): ${m.body}`).join(' | ') : '(none)'}` : ctx.phoneLinked === false ? `
Phone: not paired, so SMS and phone notifications are not available.` : ''}${ctx.phoneNotifications ? `
Phone notifications: ${ctx.phoneNotifications.length ? ctx.phoneNotifications.map(n => `${n.app}: ${n.title}${n.text ? ' — ' + n.text : ''}`).join(' | ') : '(none)'}` : ''}${ctx.purchases ? `
Pending purchase requests: ${ctx.purchases.length ? ctx.purchases.map(p => `[${p.id}] ${p.name || p.email || '?'}${p.amount ? ', ' + p.amount : ''}${p.ref ? ', tracking ' + p.ref : ''}${p.card4 ? ', card …' + p.card4 : ''} (${p.ago})`).join('; ') : '(none)'}` : ''}`;
}

const taskLine = t => `[${t.id}] ${t.title}${t.due ? ' (due ' + new Date(t.due).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ')' : ''}${t.priority === 'high' ? ' !' : ''}`;

function parseReply(text, { phone = false } = {}) {
  const t = String(text || '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  const known = phone ? ALL_ACTIONS : { ...ACTIONS, ...ADMIN_ACTIONS };
  if (s >= 0 && e > s) {
    try {
      const j = JSON.parse(t.slice(s, e + 1));
      const say = String(j.say || '').trim();
      let action = j.action && typeof j.action === 'object' && known[j.action.type] ? { type: j.action.type, params: j.action.params && typeof j.action.params === 'object' ? j.action.params : {} } : null;
      const pair = x => x && typeof x === 'object' && String(x.heard || '').trim() && String(x.meant || '').trim() ? { heard: String(x.heard).trim().slice(0, 60), meant: String(x.meant).trim().slice(0, 60) } : null;
      const guess = pair(j.guess), learn = pair(j.learn);
      if (guess) return { say: say || `منظورتان «${guess.meant}» بود؟`, action: null, guess };
      if (say || action) return { say, action, ...(learn ? { learn } : {}) };
    } catch {}
  }
  // model answered in plain text: speak it, no action
  return { say: t.replace(/```[\s\S]*?```/g, '').trim().slice(0, 600), action: null };
}

class Brain {
  // chat(opts) -> { text }  (lib/llm.js); context() -> live context object; history kept per session
  constructor({ chat, context, lexicon = null }) { this.chat = chat; this.context = context; this.lexicon = lexicon; this.history = []; this.pending = null; this.guess = null; }

  // -> { say, action|null, confirm: bool, confirmed?: action, cancelled?: true }
  async handle(text, { spec, signal, phone = false } = {}) {
    const said = String(text || '').trim();
    if (!said) return { say: '', action: null, confirm: false };
    // the answer to «منظورتان X بود؟»: yes -> remember the word and do the corrected request
    if (this.guess) {
      const g = this.guess; this.guess = null;
      if (YES.test(said)) {
        const learned = this.lexicon ? this.lexicon.learn(g.heard, g.meant) : null;
        const fixed = g.text.split(g.heard).join(g.meant);
        this._remember(said, 'باشه.');
        const r = await this.handle(fixed === g.text ? g.meant : fixed, { spec, signal, phone });
        return { ...r, learned: learned ? { heard: learned.heard, meant: learned.meant } : null, corrected: fixed };
      }
      if (NO.test(said)) { this._remember(said, 'ببخشید.'); return { say: /[؀-ۿ]/.test(said) ? 'ببخشید، دوباره بگویید؟' : 'Sorry, could you say it again?', action: null, confirm: false }; }
    }
    // a yes/no answer to a pending confirmation
    if (this.pending) {
      const p = this.pending;
      if (YES.test(said)) { this.pending = null; this._remember(said, 'باشه.'); return { say: p.lang === 'fa' ? 'باشه، انجامش می‌دهم.' : 'Okay, doing it now.', action: p.action, confirm: false, confirmed: true }; }
      if (NO.test(said)) { this.pending = null; this._remember(said, 'لغو شد.'); return { say: p.lang === 'fa' ? 'باشه، لغو شد.' : 'Okay, cancelled.', action: null, confirm: false, cancelled: true }; }
      this.pending = null; // a new request replaces the question
    }
    const ctx = { ...(await this.context(said)), phone, learned: this.lexicon ? this.lexicon.all().slice(0, 25) : [] };
    const r = await this.chat({ spec, system: systemPrompt(ctx), messages: [...this.history.slice(-8), { role: 'user', content: said }], maxTokens: 500, temperature: 0.3, json: true, signal });
    const out = parseReply(r.text, { phone: !!phone });
    this._remember(said, out.say || '(action)');
    if (out.guess) { this.guess = { ...out.guess, text: said }; return { say: out.say, action: null, confirm: false, guess: out.guess }; }
    const learned = out.learn && this.lexicon ? this.lexicon.learn(out.learn.heard, out.learn.meant) : null;
    const needs = needsConfirm(out.action);
    if (needs) this.pending = { action: out.action, lang: /[؀-ۿ]/.test(said) ? 'fa' : 'en' };
    return { say: out.say, action: out.action, confirm: needs, ...(learned ? { learned: { heard: learned.heard, meant: learned.meant } } : {}) };
  }
  confirm(yes) {
    const p = this.pending; this.pending = null;
    return yes && p ? p.action : null;
  }
  _remember(user, assistant) {
    this.history.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
    if (this.history.length > 20) this.history.splice(0, this.history.length - 20);
  }
  reset() { this.history = []; this.pending = null; this.guess = null; }
}

module.exports = { Brain, ACTIONS, ADMIN_ACTIONS, PHONE_ACTIONS, parseReply, systemPrompt, YES, NO };
