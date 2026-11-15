// JARVIS Club client (desktop side). Membership is required whenever a club address is set
// (package.json → jarvis.clubUrl for public builds, or the clubUrl setting). The session token
// is kept with the other encrypted secrets; the member's profile is cached so JARVIS keeps
// working offline for a while (OFFLINE_DAYS) after the last successful check.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OFFLINE_DAYS = 30;
const DAY = 864e5;

class Club {
  constructor({ dataDir, secrets, settings, defaultUrl = '', fetchImpl = globalThis.fetch }) {
    this.file = path.join(dataDir, 'club.json');
    this.secrets = secrets; this.settings = settings; this.defaultUrl = defaultUrl; this.fetch = fetchImpl;
    try { this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.cache = {}; }
  }
  url() { return String(this.settings().clubUrl || this.defaultUrl || '').trim().replace(/\/+$/, ''); }
  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 1)); } catch {} }
  token() { return this.secrets.get('clubToken') || ''; }

  state() {
    const url = this.url(), c = this.cache, has = !!this.token() && !!c.user;
    const fresh = has && c.verifiedAt && Date.now() - c.verifiedAt < OFFLINE_DAYS * DAY;
    return {
      required: !!url, url,
      loggedIn: !url || (has && fresh),
      user: has ? c.user : null, me: has ? c.me || null : null,
      offline: !!c.offline, verifiedAt: c.verifiedAt || null,
      expired: has && !fresh, // logged in once, but offline too long
    };
  }

  async call(method, p, body, { auth = true, timeout = 12000 } = {}) {
    const url = this.url();
    if (!url) throw Object.assign(new Error('باشگاه هنوز راه‌اندازی نشده'), { status: 400 });
    let r;
    try {
      r = await this.fetch(url + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth && this.token() ? { authorization: 'Bearer ' + this.token() } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw Object.assign(new Error('به باشگاه وصل نشد (اینترنت یا سرور در دسترس نیست)'), { status: 503, offline: true });
    }
    let d = {}; try { d = await r.json(); } catch {}
    if (r.status === 401 && auth) this.forget();
    if (!r.ok) throw Object.assign(new Error(d.error || ('خطای باشگاه ' + r.status)), { status: r.status });
    return d;
  }

  remember(d) {
    this.secrets.set('clubToken', d.token);
    this.cache = { user: d.user, verifiedAt: Date.now(), offline: false };
    this.save();
  }
  forget() { this.secrets.set('clubToken', ''); this.cache = {}; this.save(); }

  async register(b) { const d = await this.call('POST', '/api/register', { email: b.email, name: b.name, password: b.password, phone: b.phone, client: 'desktop' }, { auth: false }); this.remember(d); return this.refresh(); }
  async login(b) { const d = await this.call('POST', '/api/login', { email: b.email, password: b.password, client: 'desktop' }, { auth: false }); this.remember(d); return this.refresh(); }
  async logout() { try { await this.call('POST', '/api/logout'); } catch {} this.forget(); return this.state(); }

  // check the account (on start and every few hours); offline keeps the cached profile
  async refresh() {
    if (!this.url() || !this.token()) return this.state();
    try {
      const me = await this.call('GET', '/api/me');
      this.cache = { user: me.user, me, verifiedAt: Date.now(), offline: false };
      this.save();
    } catch (e) {
      if (e.offline) { this.cache.offline = true; this.save(); }
      else if (e.status === 403) this.forget(); // blocked
    }
    return this.state();
  }
}

// ---- one-click deploy to Cloudflare (Workers + D1) with wrangler -------------------------
const WRANGLER = 'wrangler@4';
function run(args, { cwd, timeout = 300000, onLine } = {}) {
  return new Promise(resolve => {
    const p = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', WRANGLER, ...args], { cwd, shell: process.platform === 'win32', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: args[0] === 'login' ? '' : '1' }, windowsHide: true });
    let out = '', part = '';
    // whole lines only (a long link can arrive in two chunks)
    const take = d => { const s = d.toString(); out += s; if (!onLine) return; const lines = (part + s).split(/\r?\n/); part = lines.pop(); lines.map(clean).filter(Boolean).forEach(onLine); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeout);
    const done = (ok, extra = '') => { clearTimeout(t); if (onLine && part) onLine(clean(part)); out = clean(out + extra); resolve({ ok, out, noNode: /npx.*(not recognized|ENOENT|not found)|ENOENT/i.test(out) }); };
    p.on('error', e => done(false, '\n' + e.message));
    p.on('close', code => done(code === 0));
  });
}
const clean = s => String(s).replace(/\x1b\[[0-9;]*m/g, '').trim(); // drop terminal colours
const NO_NODE = 'برای ساخت باشگاه، Node.js لازم است. آن را از nodejs.org نصب کنید و جارویس را دوباره باز کنید.';
const lastError = out => (out.split('\n').reverse().find(l => /error|✘|X \[/i.test(l)) || out.split('\n').filter(Boolean).pop() || '').replace(/^.*\[ERROR\]\s*/i, '').slice(0, 300);
// pull the pieces we need out of wrangler's output
const parse = {
  loggedIn: out => !/not authenticated|You are not logged in/i.test(out) && /logged in|associated with the email|Account Name|Account ID/i.test(out),
  dbId: (out, name) => {
    try { const list = JSON.parse(out.slice(out.indexOf('['))); const x = list.find(d => d.name === name); if (x) return x.uuid; } catch {}
    const m = /database_id\s*=\s*"([0-9a-f-]{36})"/i.exec(out) || /"database_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(out); return m ? m[1] : '';
  },
  url: out => { const m = /https:\/\/[\w.-]+\.workers\.dev\b/.exec(out); return m ? m[0] : ''; },
};
function wranglerToml({ name, dbId, adminEmail }) {
  return `# generated by JARVIS — the members club
name = "${name}"
main = "worker.js"
compatibility_date = "2025-09-01"
workers_dev = true

[vars]
ADMIN_EMAIL = ${JSON.stringify(adminEmail)}

[[d1_databases]]
binding = "DB"
database_name = "${name}"
database_id = "${dbId}"
`;
}

async function deploy({ dataDir, adminEmail, name = 'jarvis-club', log = () => {} }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail || '')) throw new Error('ایمیل مدیر را درست وارد کنید');
  const dir = path.join(dataDir, 'club-deploy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'worker.js'), fs.readFileSync(path.join(__dirname, '..', 'club', 'worker.js'))); // works from inside the app archive too
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module","private":true}\n');
  log('بررسی ورود به Cloudflare…');
  const who = await run(['whoami'], { cwd: dir, timeout: 180000 });
  if (who.noNode) throw new Error(NO_NODE);
  if (!parse.loggedIn(who.out)) throw Object.assign(new Error('اول با دکمه‌ی «ورود به Cloudflare» وارد حسابتان شوید'), { needLogin: true });
  log('پایگاه داده‌ی D1…');
  let dbId = parse.dbId((await run(['d1', 'list', '--json'], { cwd: dir })).out, name);
  if (!dbId) {
    const c = await run(['d1', 'create', name], { cwd: dir });
    dbId = parse.dbId(c.out, name);
    if (!dbId) throw new Error('ساخت پایگاه داده نشد: ' + c.out.slice(-300));
  }
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), wranglerToml({ name, dbId, adminEmail: adminEmail.trim().toLowerCase() }));
  log('انتشار سرویس…');
  const d = await run(['deploy'], { cwd: dir });
  const url = parse.url(d.out);
  if (!d.ok || !url) throw new Error('انتشار نشد: ' + d.out.slice(-400));
  return { url, dbId };
}
// Sign in to Cloudflare. wrangler cannot open a browser from inside the app, so it only
// prints the link (--browser=false); onUrl hands it to JARVIS, which opens it. wrangler then
// waits (about two minutes) for the «Allow» click to come back on localhost:8976.
const LOGIN_URL = /https:\/\/dash\.cloudflare\.com\/oauth2\/auth\?\S+/;
async function login({ onUrl } = {}) {
  let url = '';
  const r = await run(['login', '--browser=false'], { timeout: 300000, onLine: l => { const m = LOGIN_URL.exec(l); if (m && !url) { url = m[0]; if (onUrl) onUrl(url); } } });
  if (r.noNode) return { ok: false, url, error: NO_NODE };
  const ok = r.ok && /successfully logged in/i.test(r.out);
  return { ok, url, error: ok ? '' : /timed out/i.test(r.out) ? 'وقت تمام شد: در مرورگر «Allow» زده نشد. دوباره «ورود به Cloudflare» را بزنید.' : lastError(r.out) || 'ورود انجام نشد' };
}

module.exports = { Club, deploy, login, parse, wranglerToml, OFFLINE_DAYS, LOGIN_URL };
