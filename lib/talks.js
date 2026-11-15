// Plain chat ("Chat" section): conversations with any model, no project, no coding agents.
// Stored in DATA/talks.json. Answers stream to the panel; one answer at a time per conversation.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TALKS = 500, MAX_MSGS = 400, MAX_TEXT = 100000;
const SYSTEM = `You are JARVIS, a helpful, precise personal assistant. Reply in the language the user writes in (Persian/Farsi or English or other).
Use Markdown when it helps (lists, tables, code blocks with a language). Be direct; no filler. Today is {DATE}.`;

class Talks {
  constructor(dir, { chat, onEvent } = {}) {
    this.file = path.join(dir, 'talks.json');
    this.chat = chat;                 // (opts) -> { text, usage }   (lib/llm.js, with deps)
    this.emit = onEvent || (() => {});
    this.running = new Map();         // talkId -> AbortController
    try { this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.list = []; }
    if (!Array.isArray(this.list)) this.list = [];
    this._t = null;
  }
  _save(now) {
    clearTimeout(this._t);
    const write = () => { try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.list)); fs.renameSync(this.file + '.tmp', this.file); } catch (e) { console.error('talks save', e.message); } };
    if (now) write(); else this._t = setTimeout(write, 400);
  }
  flush() { clearTimeout(this._t); this._save(true); }
  summary(t) { const last = t.messages[t.messages.length - 1]; return { id: t.id, title: t.title, model: t.model, updatedAt: t.updatedAt, count: t.messages.length, running: this.running.has(t.id), preview: last ? String(last.content).slice(0, 90) : '' }; }
  all() { return this.list.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(t => this.summary(t)); }
  get(id) { return this.list.find(t => t.id === id) || null; }
  create({ model, title } = {}) {
    const t = { id: crypto.randomUUID().slice(0, 12), title: String(title || 'گفتگوی تازه').slice(0, 80), model: String(model || ''), messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.list.push(t);
    if (this.list.length > MAX_TALKS) { this.list.sort((a, b) => a.updatedAt - b.updatedAt); this.list.splice(0, this.list.length - MAX_TALKS); }
    this._save(); return t;
  }
  update(id, patch) {
    const t = this.get(id); if (!t) throw new Error('گفتگو پیدا نشد');
    if (typeof patch.title === 'string' && patch.title.trim()) t.title = patch.title.trim().slice(0, 80);
    if (typeof patch.model === 'string') t.model = patch.model.slice(0, 160);
    this._save(); return t;
  }
  remove(id) { this.stop(id); this.list = this.list.filter(t => t.id !== id); this._save(); }
  stop(id) { const c = this.running.get(id); if (c) c.abort(); }
  search(q) {
    const s = String(q || '').trim().toLowerCase(); if (!s) return [];
    const out = [];
    for (const t of this.list) {
      const hit = t.title.toLowerCase().includes(s) ? t.title : (t.messages.find(m => String(m.content).toLowerCase().includes(s)) || {}).content;
      if (hit) out.push({ ...this.summary(t), hit: String(hit).slice(0, 140) });
    }
    return out.slice(0, 50);
  }
  markdown(id) {
    const t = this.get(id); if (!t) throw new Error('گفتگو پیدا نشد');
    return `# ${t.title}\n\n` + t.messages.map(m => `**${m.role === 'user' ? 'شما' : 'جارویس' + (m.model ? ' (' + m.model + ')' : '')}** — ${new Date(m.ts).toLocaleString('fa-IR')}\n\n${m.content}\n`).join('\n---\n\n');
  }

  // Send a user message (or regenerate the last answer) and stream the reply.
  async send(id, { text, model, regenerate = false, resolveSpec }) {
    const t = this.get(id); if (!t) throw new Error('گفتگو پیدا نشد');
    if (this.running.has(id)) throw new Error('هنوز در حال جواب دادن است');
    if (model) t.model = String(model).slice(0, 160);
    if (!t.model) throw new Error('یک مدل انتخاب کنید');
    if (regenerate) {
      while (t.messages.length && t.messages[t.messages.length - 1].role === 'assistant') t.messages.pop();
      if (!t.messages.length) throw new Error('پیامی برای تکرار نیست');
    } else {
      const s = String(text || '').trim();
      if (!s) throw new Error('پیام خالی است');
      t.messages.push({ role: 'user', content: s.slice(0, MAX_TEXT), ts: Date.now() });
      if (t.messages.length === 1 && t.title === 'گفتگوی تازه') t.title = s.replace(/\s+/g, ' ').slice(0, 48);
    }
    const msg = { role: 'assistant', content: '', ts: Date.now(), model: t.model, pending: true };
    t.messages.push(msg);
    if (t.messages.length > MAX_MSGS) t.messages.splice(0, t.messages.length - MAX_MSGS);
    t.updatedAt = Date.now();
    const ctl = new AbortController();
    this.running.set(id, ctl);
    this.emit({ type: 'talk', talk: this.summary(t) });
    this.emit({ type: 'talkStart', id, model: t.model });
    const spec = resolveSpec ? await resolveSpec(t.model) : t.model;
    let lastEmit = 0, buf = '';
    try {
      // history: the last ~30 messages (the model's own context limit is the real bound)
      const history = t.messages.slice(0, -1).filter(m => m.content && !m.error).slice(-30).map(m => ({ role: m.role, content: m.content }));
      const r = await this.chat({ spec, system: SYSTEM.replace('{DATE}', new Date().toDateString()), messages: history, maxTokens: 4096, signal: ctl.signal,
        onDelta: d => { msg.content += d; buf += d; if (Date.now() - lastEmit > 60) { this.emit({ type: 'talkDelta', id, text: buf }); buf = ''; lastEmit = Date.now(); } } });
      if (buf) this.emit({ type: 'talkDelta', id, text: buf });
      if (!msg.content && r.text) msg.content = r.text;
      msg.usage = r.usage;
    } catch (e) {
      if (e.aborted || ctl.signal.aborted) msg.stopped = true;
      else { msg.error = e.message || String(e); }
    } finally {
      delete msg.pending;
      msg.ms = Date.now() - msg.ts;
      if (spec !== t.model) msg.via = spec;
      this.running.delete(id);
      t.updatedAt = Date.now();
      this._save();
      this.emit({ type: 'talkDone', id, message: msg });
      this.emit({ type: 'talk', talk: this.summary(t) });
    }
    return msg;
  }
}

module.exports = { Talks, SYSTEM };
