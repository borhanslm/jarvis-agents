// Two-way assistant on Telegram or Bale (same Bot API). Long polling: nothing on this computer is
// opened to the internet. Only the owner's chat (the chat id saved for notifications) is answered.
//   text  -> the assistant (same brain and actions as the voice assistant)
//   voice -> FFmpeg -> speech to text -> the assistant -> (voice reply when you spoke)
//   actions that change things ask first, with "yes / no" buttons
'use strict';

const HELP = `من جارویس هستم. هر چه می‌خواهید بنویسید یا پیام صوتی بفرستید (فارسی یا انگلیسی).
مثلاً:
• فردا ساعت ده یادم بنداز نان بخرم
• روی پروژه‌ی shop صفحه‌ی ورود را درست کن
• ایجنت‌ها چه کار می‌کنند؟

دستورها:
/status — وضعیت ایجنت‌ها و صف
/tasks — تسک‌های امروز
/stop — توقف همه‌ی کارهای در حال اجرا
/new — شروع گفتگوی تازه
/help — همین راهنما`;

class Bot {
  /**
   * deps: {
   *   config(): { enabled, channel, token, chatId, voiceReply: 'auto'|'always'|'never' }
   *   call(channel, token, method, body, { timeoutMs }) -> result     (Bot API)
   *   fileUrl(channel, token, filePath) -> url
   *   ask(text) -> { say, action, confirm, result }       confirm(yes) -> { action, result }
   *   reset(), status() -> text, tasks() -> text, stopAll() -> number
   *   transcribe(wav) -> { text }, speak(text) -> { wav }, media: Media
   *   onLog(entry)
   * }
   */
  constructor(deps) {
    this.d = deps;
    this.running = false;
    this.offset = 0;
    this.state = { connected: false, lastError: null, lastAt: 0, botName: '' };
    this._ctl = null;
  }
  start() {
    if (this.running) return;
    this.running = true;
    this._loop().catch(e => { this.state.lastError = e.message; this.running = false; });
  }
  stop() { this.running = false; if (this._ctl) this._ctl.abort(); this.state.connected = false; }
  restart() { this.stop(); setTimeout(() => this.start(), 300); }
  status() { return { running: this.running, ...this.state }; }

  async _loop() {
    let wait = 2000;
    let cfg = this.d.config();
    // skip messages sent while the bot was off (no surprise actions from old messages)
    try { const old = await this.d.call(cfg.channel, cfg.token, 'getUpdates', { offset: -1, timeout: 0 }); if (old && old.length) this.offset = old[old.length - 1].update_id + 1; } catch {}
    try { const me = await this.d.call(cfg.channel, cfg.token, 'getMe'); this.state.botName = me && (me.username || me.first_name) || ''; } catch {}
    while (this.running) {
      cfg = this.d.config();
      if (!cfg.enabled || !cfg.token || !cfg.chatId) { this.running = false; this.state.connected = false; break; }
      try {
        this._ctl = new AbortController();
        const ups = await this.d.call(cfg.channel, cfg.token, 'getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: 40000, signal: this._ctl.signal });
        this.state.connected = true; this.state.lastError = null; wait = 2000;
        for (const u of ups || []) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          this.handle(u, cfg).catch(e => this._log({ error: e.message }));
        }
      } catch (e) {
        if (!this.running) break;
        this.state.connected = false; this.state.lastError = e.message;
        await new Promise(r => setTimeout(r, wait)); wait = Math.min(60000, wait * 2);
      }
    }
  }
  _log(x) { try { this.d.onLog && this.d.onLog({ ts: Date.now(), ...x }); } catch {} }
  _send(cfg, method, body) { return this.d.call(cfg.channel, cfg.token, method, body); }
  text(cfg, text, extra = {}) { return this._send(cfg, 'sendMessage', { chat_id: cfg.chatId, text: String(text || '…').slice(0, 4000), ...extra }); }

  async handle(u, cfg) {
    if (u.callback_query) return this._callback(u.callback_query, cfg);
    const m = u.message;
    if (!m || !m.chat) return;
    // only the owner, only a private chat
    if (String(m.chat.id) !== String(cfg.chatId) || (m.chat.type && m.chat.type !== 'private')) { this._log({ ignored: String(m.chat.id) }); return; }
    this.state.lastAt = Date.now();
    const voiceIn = m.voice || m.audio;
    let said = String(m.text || m.caption || '').trim();
    if (said.startsWith('/')) return this._command(said, cfg);
    // a reply to a workflow question ("ask me" step) is that step's answer
    if (m.reply_to_message && said && this.d.onReply) { const t = await this.d.onReply(m.reply_to_message.message_id, said); if (t) return this.text(cfg, t); }
    if (voiceIn) {
      this._send(cfg, 'sendChatAction', { chat_id: cfg.chatId, action: 'typing' }).catch(() => {});
      try { said = await this._hear(voiceIn, cfg); }
      catch (e) { return this.text(cfg, '⚠️ پیام صوتی را نتوانستم بشنوم: ' + e.message); }
      if (!said) return this.text(cfg, 'چیزی در پیام صوتی شنیده نشد.');
      await this.text(cfg, '🎙 «' + said + '»').catch(() => {});
    }
    if (!said) return this.text(cfg, 'فعلاً متن و پیام صوتی را می‌فهمم.');
    this._send(cfg, 'sendChatAction', { chat_id: cfg.chatId, action: 'typing' }).catch(() => {});
    let r;
    try { r = await this.d.ask(said); }
    catch (e) { this._log({ user: said, error: e.message }); return this.text(cfg, '⚠️ ' + e.message); }
    this._log({ user: said, say: r.say, action: r.action, result: r.result, confirm: r.confirm });
    let reply = r.say || '';
    const done = this.describe(r.action, r.result);
    if (done) reply += (reply ? '\n\n' : '') + done;
    const markup = r.confirm ? { reply_markup: { inline_keyboard: [[{ text: '✅ بله، انجام بده', callback_data: 'yes' }, { text: '❌ نه', callback_data: 'no' }]] } } : {};
    const wantVoice = cfg.voiceReply === 'always' || (cfg.voiceReply !== 'never' && !!voiceIn);
    if (wantVoice && r.say) {
      try { await this._speak(cfg, r.say, markup); if (done || r.confirm) await this.text(cfg, done || 'تأیید می‌کنید؟', markup); return; }
      catch (e) { this._log({ error: 'voice reply: ' + e.message }); }
    }
    return this.text(cfg, reply || 'باشه.', markup);
  }

  // What an action did, as a short line for the chat.
  describe(a, res) {
    if (!a || !res) return '';
    if (res.ok === false) return '⚠️ ' + (res.error || 'انجام نشد');
    if (a.type === 'add_task' && res.task) return '✅ تسک اضافه شد: ' + res.task.title + (res.task.due ? ' — ' + new Date(res.task.due).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }) : '');
    if (a.type === 'complete_task' && res.task) return '✅ انجام شد: ' + res.task.title;
    if (a.type === 'run_team') return '🚀 کار شروع شد. وقتی تمام شود همین‌جا خبر می‌دهم.';
    if (a.type === 'stop') return '⏹ ' + (res.stopped || 0) + ' کار متوقف شد.';
    if (a.type === 'open') return 'این را باید در خود برنامه‌ی جارویس باز کنید.';
    return '';
  }

  async _callback(q, cfg) {
    const from = q.message && q.message.chat ? q.message.chat.id : q.from && q.from.id;
    this._send(cfg, 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (String(from) !== String(cfg.chatId)) return;
    if (this.d.onCallback) { const t = await this.d.onCallback(String(q.data || '')); if (t) { if (q.message) this._send(cfg, 'editMessageReplyMarkup', { chat_id: cfg.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {}); return this.text(cfg, t); } }
    const tm = /^(done|snz):([\w-]{1,40})(?::(\d{1,5}))?$/.exec(q.data || '');
    if (tm && this.d.taskAction) {
      if (q.message) this._send(cfg, 'editMessageReplyMarkup', { chat_id: cfg.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return this.text(cfg, this.d.taskAction(tm[1], tm[2], tm[3]));
    }
    const yes = q.data === 'yes';
    // remove the buttons so the same question can't be answered twice
    if (q.message) this._send(cfg, 'editMessageReplyMarkup', { chat_id: cfg.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    const r = await this.d.confirm(yes);
    this._log({ user: yes ? '(تأیید)' : '(لغو)', action: r.action, result: r.result });
    if (!r.action) return this.text(cfg, yes ? 'سؤالی در انتظار تأیید نبود (شاید قبلاً جواب داده شده).' : 'باشه، لغو شد.');
    return this.text(cfg, this.describe(r.action, r.result) || 'انجام شد.');
  }

  async _command(cmd, cfg) {
    const c = cmd.split(/[\s@]/)[0].toLowerCase();
    if (c === '/start' || c === '/help') return this.text(cfg, HELP);
    if (c === '/status') return this.text(cfg, await this.d.status());
    if (c === '/tasks') return this.text(cfg, await this.d.tasks());
    if (c === '/stop') { const n = await this.d.stopAll(); return this.text(cfg, n ? `⏹ ${n} کار متوقف شد.` : 'کاری در حال اجرا نبود.'); }
    if (c === '/new') { this.d.reset(); return this.text(cfg, 'گفتگوی تازه شروع شد.'); }
    return this.text(cfg, 'این دستور را نمی‌شناسم. /help را بزنید.');
  }

  async _hear(v, cfg) {
    if (v.file_size && v.file_size > 20e6) throw new Error('فایل صوتی خیلی بزرگ است');
    const f = await this._send(cfg, 'getFile', { file_id: v.file_id });
    if (!f || !f.file_path) throw new Error('فایل دریافت نشد');
    const r = await fetch(this.d.fileUrl(cfg.channel, cfg.token, f.file_path), { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('دانلود پیام صوتی نشد (' + r.status + ')');
    const raw = Buffer.from(await r.arrayBuffer());
    const wav = await this.d.media.toWav16k(raw);
    const t = await this.d.transcribe(wav);
    return String(t.text || '').trim();
  }
  async _speak(cfg, text, markup) {
    this._send(cfg, 'sendChatAction', { chat_id: cfg.chatId, action: 'record_voice' }).catch(() => {});
    const s = await this.d.speak(text);
    const ogg = await this.d.media.toOggOpus(s.wav);
    const fd = new FormData();
    fd.append('chat_id', String(cfg.chatId));
    fd.append('voice', new Blob([ogg], { type: 'audio/ogg' }), 'jarvis.ogg');
    fd.append('caption', String(text).slice(0, 1000));
    return this.d.call(cfg.channel, cfg.token, 'sendVoice', fd);
  }
}

module.exports = { Bot, HELP };
