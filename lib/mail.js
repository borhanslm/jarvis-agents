// Email for JARVIS: read the inbox over IMAP and send over SMTP, with an "app password"
// (Gmail, Yahoo, iCloud, Zoho, or any server). No dependencies.
// Sending is never automatic: the panel shows the email and the user presses "send", or says "yes" by voice.
// Email text is other people's words — it is shown and summarized, never followed as instructions.
'use strict';
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRESETS = {
  gmail: { name: 'Gmail', imap: 'imap.gmail.com', imapPort: 993, smtp: 'smtp.gmail.com', smtpPort: 465, help: 'https://myaccount.google.com/apppasswords', note: 'در حساب گوگل «تأیید دومرحله‌ای» را روشن کنید، بعد از لینک یک «App password» بسازید و این‌جا بگذارید (رمز اصلی جیمیل کار نمی‌کند).' },
  yahoo: { name: 'Yahoo', imap: 'imap.mail.yahoo.com', imapPort: 993, smtp: 'smtp.mail.yahoo.com', smtpPort: 465, help: 'https://login.yahoo.com/account/security', note: 'از «Account security» یک App password بسازید.' },
  icloud: { name: 'iCloud', imap: 'imap.mail.me.com', imapPort: 993, smtp: 'smtp.mail.me.com', smtpPort: 587, help: 'https://account.apple.com', note: 'در حساب اپل یک «App-Specific Password» بسازید.' },
  zoho: { name: 'Zoho', imap: 'imap.zoho.com', imapPort: 993, smtp: 'smtp.zoho.com', smtpPort: 465, help: 'https://accounts.zoho.com', note: 'IMAP را در تنظیمات Zoho Mail روشن کنید و یک App password بسازید.' },
  outlook: { name: 'Outlook / Hotmail', imap: 'outlook.office365.com', imapPort: 993, smtp: 'smtp.office365.com', smtpPort: 587, help: 'https://account.microsoft.com/security', note: 'مایکروسافت برای حساب‌های شخصی ورود با رمز را بسته؛ ممکن است وصل نشود.' },
  custom: { name: 'سرور دیگر', imap: '', imapPort: 993, smtp: '', smtpPort: 465, note: 'آدرس سرورهای IMAP و SMTP را از سرویس ایمیل‌تان بگیرید.' },
};
const EMAIL_RE = /^[^\s@<>,;"()\[\]\\]+@[^\s@<>,;"()\[\]\\]+\.[^\s@<>,;"()\[\]\\]{2,}$/;

// ---------- MIME ----------
function decodeCharset(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(cs === 'utf8' ? 'utf-8' : cs).decode(buf); } catch { return buf.toString('utf8'); }
}
function qp(str, underscores) {
  if (underscores) str = str.replace(/_/g, ' ');
  str = str.replace(/=\r?\n/g, '');
  const out = []; for (let i = 0; i < str.length; i++) {
    if (str[i] === '=' && /^[0-9A-F]{2}$/i.test(str.substr(i + 1, 2))) { out.push(parseInt(str.substr(i + 1, 2), 16)); i += 2; }
    else { const c = str.charCodeAt(i); if (c < 256) out.push(c); else out.push(...Buffer.from(str[i])); }
  }
  return Buffer.from(out);
}
// =?utf-8?B?...?= words in headers
function decodeWords(s) {
  return String(s || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, txt) => {
    try { return decodeCharset(enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qp(txt, true), cs.replace(/\*.*$/, '')); } catch { return txt; }
  });
}
function parseHeaders(raw) {
  const h = {};
  for (const line of String(raw).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':'); if (i < 1) continue;
    const k = line.slice(0, i).trim().toLowerCase(); if (!(k in h)) h[k] = line.slice(i + 1).trim();
  }
  return h;
}
const param = (v, name) => { const m = new RegExp('(?:^|;)\\s*' + name + '\\s*=\\s*("([^"]*)"|[^;\\s]+)', 'i').exec(v || ''); return m ? (m[2] !== undefined ? m[2] : m[1]) : ''; };
function parseAddress(v) {
  const s = decodeWords(v || '');
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(s);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  const e = (/[^\s<>,;]+@[^\s<>,;]+/.exec(s) || [''])[0];
  return { name: '', email: e };
}
function htmlToText(h) {
  return String(h).replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&zwnj;/g, '‌')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// a whole message (Buffer) -> { headers, text, attachments }
function parseMessage(buf) {
  const out = { text: '', html: '', attachments: [] };
  function walk(b, depth) {
    const s = b.toString('latin1');
    const sep = s.search(/\r?\n\r?\n/);
    const head = sep < 0 ? s : s.slice(0, sep), bodyStart = sep < 0 ? s.length : sep + (s.slice(sep, sep + 4) === '\r\n\r\n' ? 4 : 2);
    const h = parseHeaders(head), body = b.slice(bodyStart);
    if (depth === 0) out.headers = h;
    const ct = h['content-type'] || 'text/plain', type = ct.split(';')[0].trim().toLowerCase();
    if (type.startsWith('multipart/') && depth < 6) {
      const bd = param(ct, 'boundary'); if (!bd) return;
      const parts = body.toString('latin1').split('--' + bd);
      for (const p of parts.slice(1)) { if (p.startsWith('--')) break; walk(Buffer.from(p.replace(/^\r?\n/, ''), 'latin1'), depth + 1); }
      return;
    }
    const enc = (h['content-transfer-encoding'] || '').toLowerCase().trim();
    const data = enc === 'base64' ? Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? qp(body.toString('latin1')) : body;
    const disp = h['content-disposition'] || '', fname = decodeWords(param(disp, 'filename') || param(ct, 'name'));
    if (/attachment/i.test(disp) || (fname && !type.startsWith('text/'))) { out.attachments.push({ name: fname || 'file', type, size: data.length }); return; }
    if (type === 'text/plain' && !out.text) out.text = decodeCharset(data, param(ct, 'charset'));
    else if (type === 'text/html' && !out.html) out.html = decodeCharset(data, param(ct, 'charset'));
    else if (type === 'message/rfc822' && depth < 6) walk(data, depth + 1);
  }
  walk(buf, 0);
  if (!out.text && out.html) out.text = htmlToText(out.html);
  out.text = out.text.replace(/\r\n/g, '\n').trim();
  return out;
}

// ---------- IMAP (just what JARVIS needs) ----------
const q = s => '"' + String(s).replace(/[\\"]/g, m => '\\' + m) + '"';
class Imap {
  constructor({ host, port = 993, user, pass, timeout = 25000, plain = false }) { Object.assign(this, { host, port, user, pass, timeout, plain }); this.n = 0; this.buf = Buffer.alloc(0); this.cur = []; this.lit = 0; this.unit = []; this.wait = null; }
  open() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('سرور ایمیل جواب نداد')); this.close(); }, this.timeout);
      this.sock = this.plain ? net.connect({ host: this.host, port: this.port }) : tls.connect({ host: this.host, port: this.port, servername: this.host });
      this.sock.on('data', d => this.onData(d));
      this.sock.on('error', e => { clearTimeout(timer); if (this.wait) { this.wait.reject(e); this.wait = null; } else reject(e); });
      this.sock.on('close', () => { if (this.wait) { this.wait.reject(new Error('ارتباط با سرور ایمیل قطع شد')); this.wait = null; } });
      this.greet = line => { clearTimeout(timer); /^\* (OK|PREAUTH)/i.test(line) ? resolve() : reject(new Error('سرور ایمیل را نپذیرفت')); };
    });
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.lit > 0) { if (this.buf.length < this.lit) return; this.cur.push(this.buf.slice(0, this.lit)); this.buf = this.buf.slice(this.lit); this.lit = 0; continue; }
      const i = this.buf.indexOf('\r\n'); if (i < 0) return;
      const line = this.buf.slice(0, i + 2); this.buf = this.buf.slice(i + 2); this.cur.push(line);
      const m = /\{(\d+)\}\r\n$/.exec(line.toString('latin1')); if (m) { this.lit = +m[1]; continue; }
      const unit = Buffer.concat(this.cur); this.cur = [];
      this.onUnit(unit);
    }
  }
  onUnit(unit) {
    const s = unit.toString('latin1');
    if (this.greet) { const g = this.greet; this.greet = null; return g(s); }
    if (this.wait && s.startsWith(this.wait.tag + ' ')) {
      const w = this.wait; this.wait = null; clearTimeout(w.timer);
      const ok = /^\S+ OK/i.test(s);
      return ok ? w.resolve(w.units) : w.reject(new Error(s.replace(/^\S+ (NO|BAD)\s*/i, '').replace(/\[[^\]]*\]\s*/, '').trim() || 'خطای سرور ایمیل'));
    }
    if (this.wait) this.wait.units.push(unit);
  }
  cmd(text) {
    return new Promise((resolve, reject) => {
      const tag = 'J' + (++this.n);
      const timer = setTimeout(() => { if (this.wait && this.wait.tag === tag) { this.wait = null; reject(new Error('سرور ایمیل جواب نداد')); this.close(); } }, this.timeout);
      this.wait = { tag, units: [], resolve, reject, timer };
      this.sock.write(tag + ' ' + text + '\r\n');
    });
  }
  async login() {
    try { await this.cmd('LOGIN ' + q(this.user) + ' ' + q(this.pass)); }
    catch (e) { throw new Error(/auth|credential|password|login|invalid/i.test(e.message) ? 'نام کاربری یا رمز برنامه درست نیست (برای جیمیل باید «App password» بسازید)' : e.message); }
  }
  close() { try { this.sock && this.sock.end('J0 LOGOUT\r\n'); } catch {} try { this.sock && this.sock.destroy(); } catch {} }
}
// one "* n FETCH (...)" unit -> { uid, flags, literal }
function fetchUnit(u) {
  const s = u.toString('latin1');
  const uid = +((/UID (\d+)/.exec(s) || [])[1] || 0);
  const flags = (/FLAGS \(([^)]*)\)/.exec(s) || [, ''])[1];
  const lm = /\{(\d+)\}\r\n/.exec(s);
  const literal = lm ? u.slice(lm.index + lm[0].length, lm.index + lm[0].length + +lm[1]) : null;
  return { uid, seen: /\\Seen/i.test(flags), literal };
}
async function withImap(acc, fn) {
  const c = new Imap({ host: acc.imap, port: acc.imapPort, user: acc.user || acc.email, pass: acc.pass, plain: !!acc._plainForTests });
  await c.open();
  try { await c.login(); return await fn(c); } finally { c.close(); }
}
async function listInbox(acc, limit = 25) {
  return withImap(acc, async c => {
    const sel = await c.cmd('EXAMINE INBOX');
    const exists = +((/\* (\d+) EXISTS/i.exec(sel.map(x => x.toString('latin1')).join('')) || [])[1] || 0);
    if (!exists) return [];
    const units = await c.cmd(`FETCH ${Math.max(1, exists - limit + 1)}:${exists} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])`);
    return units.map(fetchUnit).filter(x => x.uid && x.literal).map(x => {
      const h = parseHeaders(x.literal.toString('latin1'));
      const d = Date.parse(h.date);
      return { uid: x.uid, seen: x.seen, from: parseAddress(h.from), subject: decodeWords(h.subject || '').slice(0, 300), date: Number.isFinite(d) ? d : 0, messageId: h['message-id'] || '' };
    }).sort((a, b) => b.date - a.date);
  });
}
async function readMessage(acc, uid, markSeen = true) {
  uid = parseInt(uid, 10); if (!(uid > 0)) throw new Error('ایمیل پیدا نشد');
  return withImap(acc, async c => {
    await c.cmd(markSeen ? 'SELECT INBOX' : 'EXAMINE INBOX');
    const units = await c.cmd(`UID FETCH ${uid} (UID FLAGS BODY.PEEK[]<0.400000>)`);
    const x = units.map(fetchUnit).find(y => y.uid === uid && y.literal);
    if (!x) throw new Error('ایمیل پیدا نشد');
    if (markSeen && !x.seen) await c.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`).catch(() => {});
    const m = parseMessage(x.literal), h = m.headers || {};
    const d = Date.parse(h.date);
    return { uid, from: parseAddress(h.from), to: decodeWords(h.to || ''), cc: decodeWords(h.cc || ''), subject: decodeWords(h.subject || ''), date: Number.isFinite(d) ? d : 0,
      messageId: h['message-id'] || '', references: h.references || '', text: m.text.slice(0, 60000), attachments: m.attachments };
  });
}
// the start of a few messages as plain text (for the voice summary), in one connection
async function previews(acc, uids) {
  uids = uids.map(u => parseInt(u, 10)).filter(u => u > 0).slice(0, 8); if (!uids.length) return {};
  return withImap(acc, async c => {
    await c.cmd('EXAMINE INBOX');
    const units = await c.cmd(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[]<0.60000>)`);
    const out = {};
    for (const x of units.map(fetchUnit)) if (x.uid && x.literal) { try { out[x.uid] = parseMessage(x.literal).text.replace(/\s+/g, ' ').slice(0, 700); } catch {} }
    return out;
  });
}

// ---------- SMTP ----------
function smtpTalk(sock) {
  let buf = '', waiter = null;
  sock.on('data', d => { buf += d.toString('utf8'); check(); });
  function check() {
    if (!waiter) return;
    const lines = buf.split('\r\n'); const done = lines.findIndex(l => /^\d{3} /.test(l));
    if (done < 0) return;
    const text = lines.slice(0, done + 1).join('\n'); buf = lines.slice(done + 1).join('\r\n');
    const w = waiter; waiter = null; w(text);
  }
  return (line, okCodes) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiter = null; reject(new Error('سرور ارسال ایمیل جواب نداد')); }, 30000);
    waiter = text => { clearTimeout(t); const last = text.split('\n').pop(), code = +last.slice(0, 3); okCodes.includes(code) ? resolve(text) : reject(new Error(last.slice(4).trim() || 'ارسال ناموفق')); };
    if (line != null) sock.write(line + '\r\n');
    check();
  });
}
const b64h = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=';
function buildMessage({ from, fromName, to, subject, text, inReplyTo, references }) {
  const id = `<${crypto.randomUUID()}@jarvis.local>`;
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  const head = [
    `From: ${fromName ? b64h(fromName.replace(/["\r\n]/g, '')) + ' ' : ''}<${from}>`, `To: ${to.join(', ')}`, `Subject: ${b64h(subject)}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', 'X-Mailer: JARVIS',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${(references ? references + ' ' : '') + inReplyTo}`] : []),
  ];
  return { id, data: head.join('\r\n') + '\r\n\r\n' + body };
}
async function sendMail(acc, msg) {
  const to = [].concat(msg.to || []).flatMap(x => String(x).split(/[,;،\s]+/)).map(x => x.trim()).filter(Boolean);
  if (!to.length) throw new Error('گیرنده مشخص نیست');
  const bad = to.find(x => !EMAIL_RE.test(x)); if (bad) throw new Error('آدرس ایمیل درست نیست: ' + bad);
  if (to.length > 20) throw new Error('حداکثر ۲۰ گیرنده');
  const subject = String(msg.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 250);
  const text = String(msg.text || ''); if (!text.trim()) throw new Error('متن ایمیل خالی است');
  const clean = v => String(v || '').replace(/[\r\n]+/g, ' ').slice(0, 2000);
  const m = buildMessage({ from: acc.email, fromName: acc.fromName || '', to, subject, text, inReplyTo: clean(msg.inReplyTo), references: clean(msg.references) });
  const direct = +acc.smtpPort === 465 && !acc._plainForTests, plain = !!acc._plainForTests;
  let sock = direct ? tls.connect({ host: acc.smtp, port: +acc.smtpPort, servername: acc.smtp }) : net.connect({ host: acc.smtp, port: +acc.smtpPort || 587 });
  await new Promise((res, rej) => { sock.once(direct ? 'secureConnect' : 'connect', res); sock.once('error', rej); setTimeout(() => rej(new Error('به سرور ارسال وصل نشد')), 20000).unref(); });
  let say = smtpTalk(sock);
  try {
    await say(null, [220]);
    await say('EHLO jarvis.local', [250]);
    if (!direct && !plain) {
      await say('STARTTLS', [220]);
      sock.removeAllListeners('data');
      sock = tls.connect({ socket: sock, servername: acc.smtp });
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      say = smtpTalk(sock);
      await say('EHLO jarvis.local', [250]);
    }
    await say('AUTH LOGIN', [334]);
    await say(Buffer.from(acc.user || acc.email).toString('base64'), [334]);
    try { await say(Buffer.from(acc.pass).toString('base64'), [235]); } catch { throw new Error('ورود به سرور ارسال نشد — رمز برنامه را بررسی کنید'); }
    await say(`MAIL FROM:<${acc.email}>`, [250]);
    for (const r of to) await say(`RCPT TO:<${r}>`, [250, 251]);
    await say('DATA', [354]);
    await say(m.data.replace(/\r\n\./g, '\r\n..') + '\r\n.', [250]);
    say('QUIT', [221]).catch(() => {});
    return { ok: true, to, subject, messageId: m.id };
  } finally { setTimeout(() => { try { sock.destroy(); } catch {} }, 500); }
}

// ---------- accounts (settings in data/mail.json, the app password encrypted in setup.secrets) ----------
class Mail {
  constructor(dataDir, secrets) {
    this.file = path.join(dataDir, 'mail.json'); this.secrets = secrets; this.cache = new Map();
    try { this.list = (JSON.parse(fs.readFileSync(this.file, 'utf8')).accounts || []).map(({ _plainForTests, ...a }) => a); } catch { this.list = []; } // never plain text from the file
  }
  _save() { fs.writeFileSync(this.file, JSON.stringify({ accounts: this.list }, null, 2)); }
  view() { return this.list.map(a => ({ ...a, hasPass: !!this.secrets.get('mail.' + a.id) })); }
  get(id) { const a = (id && this.list.find(x => x.id === id)) || this.list[0]; if (!a) throw new Error('هنوز حساب ایمیلی اضافه نشده'); const pass = this.secrets.get('mail.' + a.id); if (!pass) throw new Error('رمز برنامه‌ی این حساب ذخیره نشده'); return { ...a, pass }; }
  save(b) {
    const preset = PRESETS[b.preset] ? b.preset : 'custom', P = PRESETS[preset];
    const email = String(b.email || '').trim().toLowerCase(); if (!EMAIL_RE.test(email)) throw new Error('آدرس ایمیل درست نیست');
    const host = v => String(v || '').trim().toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const a = { id: b.id || crypto.randomUUID().slice(0, 8), preset, email, fromName: String(b.fromName || '').slice(0, 80), user: String(b.user || '').trim() || '',
      imap: host(b.imap) || P.imap, imapPort: +b.imapPort || P.imapPort, smtp: host(b.smtp) || P.smtp, smtpPort: +b.smtpPort || P.smtpPort };
    if (!a.imap || !a.smtp) throw new Error('آدرس سرورهای IMAP و SMTP را وارد کنید');
    const i = this.list.findIndex(x => x.id === a.id);
    if (i < 0 && !b.pass) throw new Error('رمز برنامه (App password) را وارد کنید');
    if (b.pass) this.secrets.set('mail.' + a.id, String(b.pass).replace(/\s+/g, preset === 'gmail' ? '' : ' ').trim());
    if (i < 0) this.list.push(a); else this.list[i] = a;
    this._save(); this.cache.delete(a.id); return a;
  }
  remove(id) { this.list = this.list.filter(a => a.id !== id); this.secrets.set('mail.' + id, null); this.cache.delete(id); this._save(); }
  async inbox(id, { fresh = false, limit = 25 } = {}) {
    const acc = this.get(id), c = this.cache.get(acc.id);
    if (!fresh && c && Date.now() - c.at < 120000) return c.list;
    const list = await listInbox(acc, limit);
    this.cache.set(acc.id, { at: Date.now(), list }); return list;
  }
  cached(id) { const a = (id && this.list.find(x => x.id === id)) || this.list[0]; const c = a && this.cache.get(a.id); return c ? c.list : null; }
  async read(id, uid) { const acc = this.get(id); const m = await readMessage(acc, uid, true); const c = this.cache.get(acc.id); if (c) { const x = c.list.find(y => y.uid === m.uid); if (x) x.seen = true; } return m; }
  async previews(id, uids) {
    const acc = this.get(id); this.prev = this.prev || new Map();
    const need = uids.filter(u => !this.prev.has(acc.id + ':' + u));
    if (need.length) { const got = await previews(acc, need); for (const [u, t] of Object.entries(got)) this.prev.set(acc.id + ':' + u, t); if (this.prev.size > 300) this.prev.delete(this.prev.keys().next().value); }
    return Object.fromEntries(uids.map(u => [u, this.prev.get(acc.id + ':' + u) || '']));
  }
  async send(id, msg) { return sendMail(this.get(id), msg); }
  async test(id) { const acc = this.get(id); const list = await listInbox(acc, 5); this.cache.delete(acc.id); return { ok: true, count: list.length }; }
}

module.exports = { Mail, PRESETS, EMAIL_RE, parseMessage, decodeWords, parseAddress, htmlToText, buildMessage, Imap };
