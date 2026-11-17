// Mobile gateway: lets the paired Android app reach JARVIS over the home network.
//  - off by default; listens on its own port (the panel's port stays on 127.0.0.1 only)
//  - pairing: the panel shows a QR code with a one-time 8-digit code (5 minutes); the phone trades
//    it for its own long device token (only a hash is stored); each phone can be revoked
//  - only an allow-list of API sections is reachable from a phone (no settings, keys, sales, backup)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ALLOWED = new Set(['state', 'cc', 'tasks', 'talks', 'llms', 'voice', 'workflows', 'events', 'chats', 'projects', 'subagents', 'queue', 'mobile']);
// from Sales, only the purchase requests (list / approve / reject) — never the keys, backup or sales log;
// the server still checks that the computer is signed in as the club admin
const SELLER_FROM_PHONE = /^\/m\/api\/seller\/(purchases|approve\/[\w-]+|reject\/[\w-]+)$/;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

class Mobile {
  /** deps: { dataDir, handleApi(req, res, url), getPort() -> number, onChange() } */
  constructor(deps) {
    this.d = deps;
    this.file = path.join(deps.dataDir, 'devices.json');
    try { this.devices = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.devices = []; }
    if (!Array.isArray(this.devices)) this.devices = [];
    this.pairing = null;   // { code, expires, tries }
    this.server = null;
    this.port = 0;
  }
  _save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.devices, null, 1)); fs.renameSync(this.file + '.tmp', this.file); try { this.d.onChange && this.d.onChange(); } catch {} }
  list() { return this.devices.map(({ tokenHash, ...d }) => d); }
  revoke(id) { this.devices = this.devices.filter(d => d.id !== id); this._save(); }
  lanAddresses() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address) && !/vEthernet|VMware|VirtualBox|WSL|Hyper-V/i.test(name)) out.push(a.address);
    }
    return out;
  }
  startPairing() {
    if (!this.server) throw new Error('اول «اتصال گوشی» را روشن کنید');
    this.pairing = { code: String(crypto.randomInt(10000000, 99999999)), expires: Date.now() + 5 * 60000, tries: 0 };
    return { code: this.pairing.code, expires: this.pairing.expires, hosts: this.lanAddresses(), port: this.port, qr: JSON.stringify({ jarvis: 1, h: this.lanAddresses(), p: this.port, c: this.pairing.code }) };
  }
  // phone -> { token, id }
  pair({ code, name, deviceCode }) {
    const p = this.pairing;
    if (!p || Date.now() > p.expires) throw Object.assign(new Error('کد جفت‌سازی منقضی شده؛ در جارویس دوباره «جفت کردن گوشی» را بزنید'), { status: 410 });
    if (++p.tries > 5) { this.pairing = null; throw Object.assign(new Error('تلاش‌های زیاد؛ دوباره شروع کنید'), { status: 429 }); }
    if (!/^\d{8}$/.test(String(code)) || !crypto.timingSafeEqual(Buffer.from(String(code)), Buffer.from(p.code))) throw Object.assign(new Error('کد اشتباه است'), { status: 403 });
    this.pairing = null;
    const token = crypto.randomBytes(32).toString('base64url');
    const dev = { id: crypto.randomUUID().slice(0, 8), name: String(name || 'Android').slice(0, 60), deviceCode: String(deviceCode || '').slice(0, 20), tokenHash: sha(token), createdAt: Date.now(), lastSeen: Date.now() };
    this.devices.push(dev); this._save();
    return { token, id: dev.id };
  }
  auth(token) {
    if (!token) return null;
    const h = sha(token);
    const d = this.devices.find(x => x.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(h)));
    if (d && Date.now() - (d.lastSeen || 0) > 60000) { d.lastSeen = Date.now(); this._save(); }
    return d || null;
  }

  async handle(req, res) {
    // the app runs from http://localhost inside the phone's WebView
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://phone');
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/m/hello') return json(200, { jarvis: true, v: 1 });
    if (url.pathname === '/m/pair' && req.method === 'POST') {
      let b = ''; for await (const c of req) { b += c; if (b.length > 4096) return json(413, { error: 'too large' }); }
      try { const j = JSON.parse(b || '{}'); return json(200, this.pair(j)); } catch (e) { return json(e.status || 400, { error: e.message }); }
    }
    const m = /^\/m\/api\/([\w-]+)/.exec(url.pathname);
    if (!m) return json(404, { error: 'not found' });
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('dt');
    const dev = this.auth(tok);
    if (!dev) return json(401, { error: 'این گوشی جفت نشده یا دسترسی‌اش لغو شده است' });
    if (!ALLOWED.has(m[1]) && !SELLER_FROM_PHONE.test(url.pathname)) return json(403, { error: 'این بخش از گوشی در دسترس نیست' });
    if (m[1] === 'mobile') return json(200, { device: { id: dev.id, name: dev.name } });
    // hand over to the normal API, as if it came from the panel
    url.pathname = url.pathname.replace(/^\/m\/api\//, '/api/');
    url.searchParams.delete('dt');
    req.url = url.pathname + url.search;
    return this.d.handleApi(req, res, url);
  }
  start(port) {
    if (this.server) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => this.handle(req, res).catch(e => { try { res.writeHead(500); res.end(String(e.message)); } catch {} }));
      s.on('error', reject);
      s.listen(port, '0.0.0.0', () => { this.server = s; this.port = s.address().port; resolve(this.port); });
    });
  }
  stop() { if (this.server) { this.server.close(); this.server = null; this.port = 0; } this.pairing = null; }
  status() { return { on: !!this.server, port: this.port, hosts: this.lanAddresses(), devices: this.list(), pairing: this.pairing ? { expires: this.pairing.expires } : null }; }
}

module.exports = { Mobile, ALLOWED };
