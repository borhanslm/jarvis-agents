// Audit log: every action JARVIS takes — by voice, Telegram, chat, the phone, the computer agent or
// the panel — with who asked, what, and whether it worked. One JSON line per action in
// data/audit/YYYY-MM.jsonl (kept on this computer). Secrets are never written.
'use strict';
const fs = require('fs');
const path = require('path');

const SECRET_KEY = /pass|secret|token|api_?key|^key$|auth|cookie|card|cvv|otp|^values$/i;
// a short, safe description of an action's parameters
function summarize(params) {
  if (params == null) return '';
  if (typeof params !== 'object') return String(params).slice(0, 200);
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_KEY.test(k)) { out.push(`${k}=***`); continue; }
    if (v == null || v === '') continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    out.push(`${k}=${s.replace(/\s+/g, ' ').slice(0, k === 'text' || k === 'task' ? 160 : 100)}`);
  }
  return out.join(' · ').slice(0, 500);
}

class Audit {
  constructor(dataDir) { this.dir = path.join(dataDir, 'audit'); fs.mkdirSync(this.dir, { recursive: true }); this.mem = []; }
  file(d = new Date()) { return path.join(this.dir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`); }
  // who: voice | telegram | chat | phone | agent | panel | system
  log(who, action, detail = '', { ok = true, error = '' } = {}) {
    const e = { at: Date.now(), who: String(who || 'system').slice(0, 20), action: String(action || '').slice(0, 60), detail: typeof detail === 'string' ? detail.slice(0, 600) : summarize(detail), ok: !!ok, ...(error ? { error: String(error).slice(0, 300) } : {}) };
    try { fs.appendFileSync(this.file(), JSON.stringify(e) + '\n'); } catch {}
    this.mem.push(e); if (this.mem.length > 300) this.mem.shift();
    return e;
  }
  // newest first; filters: who, q (text), failed only, month (YYYY-MM)
  list({ who = '', q = '', failed = false, month = '', limit = 300 } = {}) {
    const files = fs.readdirSync(this.dir).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse();
    const pick = month ? files.filter(f => f.startsWith(month)) : files.slice(0, 3);
    const out = [], ql = String(q).toLowerCase();
    for (const f of pick) {
      const lines = fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n').filter(Boolean).reverse();
      for (const l of lines) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        if (who && e.who !== who) continue;
        if (failed && e.ok) continue;
        if (ql && !(e.action + ' ' + e.detail + ' ' + (e.error || '')).toLowerCase().includes(ql)) continue;
        out.push(e); if (out.length >= limit) return out;
      }
    }
    return out;
  }
  months() { return fs.readdirSync(this.dir).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).map(f => f.slice(0, 7)).sort().reverse(); }
  csv(opts) {
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    return '﻿' + ['time,who,action,detail,ok,error', ...this.list({ ...opts, limit: 100000 }).map(e => [new Date(e.at).toISOString(), e.who, e.action, e.detail, e.ok ? 'yes' : 'no', e.error || ''].map(q).join(','))].join('\r\n');
  }
}

// which permission switch each action needs (all on by default; turned off in «مجوزها»)
const PERM_OF = {
  run_team: 'permTeam', stop: 'permTeam',
  send_email: 'permMail',
  open_app: 'permApps', open_url: 'permApps', web_search: 'permApps', open_folder: 'permApps', volume: 'permApps', media: 'permApps', screenshot: 'permApps',
  close_app: 'permPower', power: 'permPower',
  pc_do: 'pcControl', pc_continue: 'pcControl',
  approve_purchase: 'permSales', reject_purchase: 'permSales',
  remember: 'permMemory', forget: 'permMemory', teach_skill: 'permMemory',
};
const permFor = type => PERM_OF[type] || (/^phone_/.test(type || '') ? 'permPhone' : null);
function allowed(settings, type) { const k = permFor(type); return !k || settings[k] !== false; }

module.exports = { Audit, summarize, permFor, allowed, PERM_OF };
