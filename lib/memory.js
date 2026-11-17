// JARVIS's long-term memory about the user: facts («اسم همسرم ساراست»), people, places, routines and
// preferences («جواب‌ها کوتاه باشد»). Kept only on this computer (data/memory.json). For each request
// the brain gets the preferences and the memories that relate to what was said — not the whole list.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['fact', 'person', 'preference', 'routine', 'place', 'work'];
const norm = s => String(s || '').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ').toLowerCase();
// words too common to tell memories apart
const STOP = new Set('و در به از که این آن را با برای من تو او ما شما است هست بود یک هم یا اگر چه چی چرا کجا کی the a an is are am to of in on for and or my me i you it that this with what when where how do does be'.split(' '));
const words = s => norm(s).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !STOP.has(w));

class Memory {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'memory.json');
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.list = Array.isArray(j.items) ? j.items : []; } catch { this.list = []; }
  }
  save() { try { fs.writeFileSync(this.file, JSON.stringify({ items: this.list.slice(-500) }, null, 1)); } catch {} }
  all() { return [...this.list].sort((a, b) => b.at - a.at); }
  // a new memory; a near-duplicate updates the old one instead
  add({ text, kind = 'fact', source = 'user' }) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (t.length < 3) return null;
    const k = KINDS.includes(kind) ? kind : 'fact';
    const w = new Set(words(t));
    const same = this.list.find(m => { const mw = words(m.text); if (!mw.length || !w.size) return false; const common = mw.filter(x => w.has(x)).length; return norm(m.text) === norm(t) || (common / Math.max(mw.length, w.size) >= 0.75); });
    if (same) { same.text = t; same.kind = k; same.at = Date.now(); same.uses = same.uses || 0; this.save(); return { ...same, updated: true }; }
    const m = { id: crypto.randomUUID().slice(0, 8), text: t, kind: k, source, at: Date.now(), uses: 0 };
    this.list.push(m); this.save(); return m;
  }
  update(id, text) { const m = this.list.find(x => x.id === id); if (!m) return null; m.text = String(text || '').trim().slice(0, 300) || m.text; m.at = Date.now(); this.save(); return m; }
  remove(id) { const n = this.list.length; this.list = this.list.filter(m => m.id !== id); if (n !== this.list.length) this.save(); return n !== this.list.length; }
  // forget by words («فراموش کن که قهوه…») -> the removed ones
  forget(query) {
    const q = words(query); if (!q.length) return [];
    const hit = this.list.filter(m => { const mw = new Set(words(m.text)); return q.filter(x => mw.has(x)).length >= Math.max(1, Math.ceil(q.length * 0.6)); });
    if (hit.length) { this.list = this.list.filter(m => !hit.includes(m)); this.save(); }
    return hit;
  }
  // what to remind the brain of: all preferences + the memories sharing words with the request
  recall(said, limit = 12) {
    const q = new Set(words(said));
    const prefs = this.list.filter(m => m.kind === 'preference').slice(-10);
    const scored = this.list.filter(m => m.kind !== 'preference').map(m => ({ m, s: words(m.text).filter(w => q.has(w) || [...q].some(x => x.length > 3 && (w.startsWith(x) || x.startsWith(w)))).length }))
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s || b.m.at - a.m.at).slice(0, limit).map(x => x.m);
    // a few of the newest people / facts as general background, so "who is Sara?" style questions work
    const recent = this.list.filter(m => ['person', 'routine', 'work'].includes(m.kind) && !scored.includes(m)).slice(-4);
    const out = [...prefs, ...scored, ...recent];
    for (const m of scored) m.uses = (m.uses || 0) + 1;
    return out;
  }
}

// Learning mode: after an exchange, a small model picks out what is worth remembering.
const EXTRACT_SYSTEM = 'You pick out long-lasting personal facts from a conversation between a user and their assistant JARVIS. You are strict: most messages contain nothing worth remembering.';
function extractPrompt(user, reply, known) {
  return `From the USER's message below, list facts worth remembering for weeks or months: names and relations of people, the user's preferences (food, how they like answers), routines, home/work places, projects, important dates.
Do NOT include: one-time requests or commands (open X, set a timer, what time is it), questions, things the assistant said, guesses, sensitive data (passwords, card numbers, codes, health details) or anything already known.
Already known:
${known.length ? known.map(k => '- ' + k).join('\n') : '(nothing)'}

USER: ${user}
JARVIS: ${reply}

Answer ONLY a JSON array (usually empty): [{"text": "<one short fact, in the user's language, third person, e.g. «همسر کاربر سارا است»>", "kind": "fact|person|preference|routine|place|work"}]`;
}
function parseExtract(text) {
  const t = String(text || ''); const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s < 0 || e <= s) return [];
  try { const a = JSON.parse(t.slice(s, e + 1)); return Array.isArray(a) ? a.filter(x => x && typeof x.text === 'string' && x.text.trim().length > 2).slice(0, 3).map(x => ({ text: x.text.trim(), kind: KINDS.includes(x.kind) ? x.kind : 'fact' })) : []; } catch { return []; }
}
const SENSITIVE = /(رمز|پسورد|password|کارت|card|cvv|شبا|iban|کد (تایید|تأیید|ورود)|\b\d{12,}\b)/i;

module.exports = { Memory, KINDS, EXTRACT_SYSTEM, extractPrompt, parseExtract, SENSITIVE };
