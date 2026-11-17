// JARVIS's own notification list (the bell): reminders, finished jobs, purchase requests, phone results,
// new SMS / phone notifications. Kept on this computer only (data/notices.json, the last 200).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Notices {
  constructor(dataDir, onChange = () => {}) {
    this.file = path.join(dataDir, 'notices.json');
    this.onChange = onChange;
    try { this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!Array.isArray(this.list)) this.list = []; } catch { this.list = []; }
  }
  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.list.slice(-200))); } catch {} }
  // kind: reminder | job | sale | phone | sms | notification | system ; key: one notice per key (a newer one replaces it)
  add({ kind = 'system', title, body = '', section = '', key = '' }) {
    if (!title) return null;
    if (key) this.list = this.list.filter(n => n.key !== key);
    const n = { id: crypto.randomUUID().slice(0, 10), kind, title: String(title).slice(0, 160), body: String(body || '').slice(0, 400), section, key, at: Date.now(), read: false };
    this.list.push(n); if (this.list.length > 200) this.list.splice(0, this.list.length - 200);
    this.save(); this.onChange({ type: 'notice', notice: n, unread: this.unread() });
    return n;
  }
  unread() { return this.list.filter(n => !n.read).length; }
  recent(limit = 50) { return this.list.slice(-limit).reverse(); }
  read(ids) { // ids: array, or 'all'
    let changed = 0;
    for (const n of this.list) if (!n.read && (ids === 'all' || (Array.isArray(ids) && ids.includes(n.id)))) { n.read = true; changed++; }
    if (changed) { this.save(); this.onChange({ type: 'noticesRead', unread: this.unread() }); }
    return this.unread();
  }
  clear() { this.list = []; this.save(); this.onChange({ type: 'noticesRead', unread: 0 }); }
}

// SMS from the phone, grouped into conversations (newest first); "out" = sent from the phone
const digits = s => String(s || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^\d+a-z]/gi, '');
function threads(sms) {
  const by = new Map();
  for (const m of sms || []) {
    const k = digits(m.from).replace(/^(\+98|0098|98(?=9\d{9}$))/, '0') || String(m.from || '?');
    if (!by.has(k)) by.set(k, { key: k, from: m.from, name: m.name || '', messages: [] });
    if (m.name && !by.get(k).name) by.get(k).name = m.name;
    by.get(k).messages.push({ body: String(m.body || ''), date: +m.date || 0, out: !!m.out });
  }
  const out = [...by.values()];
  for (const t of out) { t.messages.sort((a, b) => a.date - b.date); t.last = t.messages[t.messages.length - 1]; }
  return out.sort((a, b) => b.last.date - a.last.date);
}

module.exports = { Notices, threads };
