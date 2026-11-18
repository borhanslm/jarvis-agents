// JARVIS Club — the members service (Cloudflare Workers + D1, free tier).
// Everyone who uses JARVIS (desktop or Android, bought or not) has an account here.
// Roles: "user" and "admin". The admin is whoever registers with an address in ADMIN_EMAIL
// (a [vars] value set when the club is deployed); admins can promote others.
// No secrets live in this file: passwords are PBKDF2-hashed, session tokens are stored as SHA-256.

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, phone TEXT, pass TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', created INTEGER NOT NULL, last_seen INTEGER, client TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, client TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS licenses (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code TEXT, key TEXT NOT NULL, device TEXT,
     updates_until INTEGER, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS licenses_user ON licenses(user_id)`,
  `CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'all', created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
     created INTEGER NOT NULL, updated INTEGER NOT NULL, user_seen INTEGER NOT NULL DEFAULT 1, admin_seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user_id)`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, from_admin INTEGER NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS messages_ticket ON messages(ticket_id)`,
  `CREATE TABLE IF NOT EXISTS throttle (k TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)`,
  // buying the Android app: the buyer pays card to card and sends the tracking number; the admin approves in JARVIS
  `CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device TEXT NOT NULL, ref TEXT NOT NULL, card4 TEXT, amount TEXT, note TEXT,
     status TEXT NOT NULL DEFAULT 'pending', reason TEXT, license_id TEXT, created INTEGER NOT NULL, decided INTEGER)`,
  `CREATE INDEX IF NOT EXISTS purchases_status ON purchases(status)`,
  `CREATE TABLE IF NOT EXISTS shop (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  // email codes: sign-up (the account is made only after the code) and the second step of login
  `CREATE TABLE IF NOT EXISTS codes (k TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL)`,
];
export const VERSION = 3;
const DAY = 864e5;
const SESSION_DAYS = 180;
const ITER = 100000; // the Workers PBKDF2 maximum

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (s, m) => { throw new HttpError(s, m); };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'access-control-max-age': '86400' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const newId = () => hex(rand(9));
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const same = (a, b) => { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.min(a.length, b.length); i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export async function hashPass(pw, saltHex, iter = ITER) {
  const salt = saltHex ? unhex(saltHex) : rand(16);
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${hex(salt)}$${hex(bits)}`;
}
async function checkPass(pw, stored) {
  const [kind, iter, salt] = String(stored || '').split('$');
  if (kind !== 'pbkdf2' || !salt) return false;
  return same(await hashPass(pw, salt, +iter), stored);
}

// ---- input checks ----
const normEmail = e => String(e || '').trim().toLowerCase();
const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const faDigits = s => String(s || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const normPhone = p => faDigits(p).replace(/[^\d+]/g, '').slice(0, 16);
const text = (s, max, what) => { s = String(s ?? '').trim(); if (!s) fail(400, what + ' خالی است'); if (s.length > max) fail(400, what + ' خیلی بلند است'); return s; };
const password = p => { p = String(p || ''); if (p.length < 8) fail(400, 'رمز باید دست‌کم ۸ کاراکتر باشد'); if (p.length > 200) fail(400, 'رمز خیلی بلند است'); return p; };
const admins = env => String(env.ADMIN_EMAIL || '').split(/[,\s]+/).map(normEmail).filter(Boolean);

// ---- throttling (login / register) ----
async function throttle(db, k, max, windowMs) {
  const t = Date.now();
  const row = await db.prepare('SELECT n, until FROM throttle WHERE k = ?').bind(k).first();
  if (row && row.until > t && row.n >= max) fail(429, 'تلاش زیاد بود؛ چند دقیقه‌ی دیگر دوباره امتحان کنید');
  if (!row || row.until <= t) await db.prepare('INSERT OR REPLACE INTO throttle (k, n, until) VALUES (?, 1, ?)').bind(k, t + windowMs).run();
  else await db.prepare('UPDATE throttle SET n = n + 1 WHERE k = ?').bind(k).run();
}
const unthrottle = (db, k) => db.prepare('DELETE FROM throttle WHERE k = ?').bind(k).run();

// ---- email codes (Brevo) ----
// The Brevo key comes from a Worker secret (BREVO_API_KEY + MAIL_FROM) or from what the admin saved
// in JARVIS (shop table, never sent back). Until it is set, nobody is locked out: login works with
// the password alone and only the admin address can sign up. With DEV_MAIL=1 (local dev server and
// tests) codes are kept in devOutbox instead of being emailed.
const CODE_MIN = 10, CODE_TRIES = 5, RESEND_S = 60;
export const devOutbox = new Map();
async function mailConf(db, env) {
  if (env.BREVO_API_KEY && env.MAIL_FROM) return { key: env.BREVO_API_KEY, from: env.MAIL_FROM, name: env.MAIL_FROM_NAME || 'JARVIS', source: 'env' };
  const r = await db.prepare("SELECT v FROM shop WHERE k = 'mail'").first();
  if (r) { try { const m = JSON.parse(r.v); if (m.key && m.from) return { ...m, source: 'admin' }; } catch {} }
  return env.DEV_MAIL === '1' ? { dev: true, from: 'dev@localhost', name: 'JARVIS' } : null;
}
const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
const PURPOSE = { reg: 'ثبت‌نام', login: 'ورود', test: 'آزمایش' };
async function deliver(conf, to, code, purpose) {
  if (conf.dev) { devOutbox.set(to, code); return; }
  const what = PURPOSE[purpose] || '';
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.8;color:#1b1f24">
    <p>کد ${what} شما در باشگاه جارویس:</p>
    <p style="font-size:30px;font-weight:bold;letter-spacing:6px;direction:ltr;text-align:center;background:#f2f4f7;border-radius:10px;padding:12px">${code}</p>
    <p>این کد ${CODE_MIN} دقیقه اعتبار دارد. آن را به هیچ‌کس ندهید؛ جارویس هیچ‌وقت کد را از شما نمی‌پرسد.</p>
    <p style="color:#667085;font-size:13px">اگر شما درخواست نکرده‌اید، این ایمیل را نادیده بگیرید.</p></div>`;
  let r;
  try {
    r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': conf.key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: conf.from, name: conf.name || 'JARVIS' }, to: [{ email: to }], subject: `کد ${what} جارویس: ${code}`, htmlContent: html, textContent: `کد ${what} شما در باشگاه جارویس: ${code}\nاین کد ${CODE_MIN} دقیقه اعتبار دارد. آن را به کسی ندهید.` }) });
  } catch { fail(502, 'سرویس ایمیل در دسترس نیست؛ کمی بعد دوباره امتحان کنید'); }
  if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch {} fail(502, 'ایمیل کد فرستاده نشد' + (m ? ': ' + m.slice(0, 160) : '')); }
}
async function sendCode(db, env, conf, email, purpose, data, { resend = false } = {}) {
  const k = purpose + ':' + email, t = Date.now();
  const old = await db.prepare('SELECT sent, expires FROM codes WHERE k = ?').bind(k).first();
  if (old && t - old.sent < RESEND_S * 1000) {
    const wait = Math.ceil((RESEND_S * 1000 - (t - old.sent)) / 1000);
    if (resend) fail(429, `کد همین الان فرستاده شد؛ ${wait.toLocaleString('fa-IR')} ثانیه‌ی دیگر دوباره بخواهید`);
    // the same step again within a minute (e.g. «برگشت» and again): keep the code already sent
    if (data) await db.prepare('UPDATE codes SET data = ? WHERE k = ?').bind(JSON.stringify(data), k).run();
    return { needCode: true, email, purpose, expiresIn: Math.round((old.expires - t) / 1000), resendIn: wait };
  }
  await throttle(db, 'mail:' + email, 6, 36e5);
  const code = newCode();
  await db.prepare('INSERT OR REPLACE INTO codes (k, hash, data, expires, tries, sent) VALUES (?, ?, ?, ?, 0, ?)').bind(k, await sha(k + ':' + code), data ? JSON.stringify(data) : null, t + CODE_MIN * 6e4, t).run();
  try { await deliver(conf, email, code, purpose); } catch (e) { await db.prepare('DELETE FROM codes WHERE k = ?').bind(k).run(); throw e; }
  return { needCode: true, email, purpose, expiresIn: CODE_MIN * 60, resendIn: RESEND_S };
}
async function checkCode(db, email, purpose, code) {
  const k = purpose + ':' + email, row = await db.prepare('SELECT * FROM codes WHERE k = ?').bind(k).first();
  code = faDigits(code).replace(/\D/g, '');
  if (!row || row.expires < Date.now()) { if (row) await db.prepare('DELETE FROM codes WHERE k = ?').bind(k).run(); fail(400, 'کد منقضی شده یا وجود ندارد؛ دوباره کد بخواهید'); }
  if (row.tries >= CODE_TRIES) { await db.prepare('DELETE FROM codes WHERE k = ?').bind(k).run(); fail(429, 'چند بار اشتباه وارد شد؛ کد تازه بخواهید'); }
  if (code.length !== 6 || !same(await sha(k + ':' + code), row.hash)) {
    await db.prepare('UPDATE codes SET tries = tries + 1 WHERE k = ?').bind(k).run();
    const left = CODE_TRIES - row.tries - 1;
    fail(400, left > 0 ? `کد اشتباه است (${left.toLocaleString("fa-IR")} بار دیگر می‌توانید امتحان کنید)` : 'کد اشتباه است؛ کد تازه بخواهید');
  }
  await db.prepare('DELETE FROM codes WHERE k = ?').bind(k).run();
  return row.data ? JSON.parse(row.data) : {};
}

// ---- sessions ----
const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, phone: u.phone || '', role: u.role, status: u.status, created: u.created, lastSeen: u.last_seen || null });
async function startSession(db, user, client) {
  const token = 'jc_' + hex(rand(32));
  const t = Date.now();
  await db.prepare('INSERT INTO sessions (token, user_id, client, created, expires) VALUES (?, ?, ?, ?, ?)').bind(await sha(token), user.id, client, t, t + SESSION_DAYS * DAY).run();
  await db.prepare('UPDATE users SET last_seen = ?, client = ? WHERE id = ?').bind(t, client, user.id).run();
  return { token, user: publicUser(user), expires: t + SESSION_DAYS * DAY };
}
async function auth(db, req, { admin = false } = {}) {
  const m = /^Bearer\s+(jc_[0-9a-f]{64})$/.exec(req.headers.get('authorization') || '');
  if (!m) fail(401, 'وارد حساب نشده‌اید');
  const s = await db.prepare('SELECT user_id, expires FROM sessions WHERE token = ?').bind(await sha(m[1])).first();
  if (!s || s.expires < Date.now()) fail(401, 'نشست منقضی شده؛ دوباره وارد شوید');
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(s.user_id).first();
  if (!u) fail(401, 'حساب پیدا نشد');
  if (u.status === 'blocked') fail(403, 'حساب شما مسدود شده است');
  if (admin && u.role !== 'admin') fail(403, 'فقط مدیر');
  // last seen: at most once an hour (keeps D1 writes low)
  if (!u.last_seen || Date.now() - u.last_seen > 36e5) await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(Date.now(), u.id).run();
  return { user: u, tokenHash: await sha(m[1]) };
}

let ready = null;
async function migrate(db) { await db.batch(SCHEMA.map(s => db.prepare(s))); }

async function body(req) {
  if (!/json/.test(req.headers.get('content-type') || '')) return {};
  const t = await req.text();
  if (t.length > 20000) fail(413, 'پیام خیلی بزرگ است');
  try { return t ? JSON.parse(t) : {}; } catch { fail(400, 'JSON نامعتبر'); }
}

// ---- routes ----
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[\\w-]+)') + '$'), fn });

route('GET', '/api/health', async () => ({ ok: true, name: 'jarvis-club', v: VERSION, codes: true }));

route('POST', '/api/register', async ({ db, b, env, req }) => {
  const email = normEmail(b.email);
  if (!okEmail(email)) fail(400, 'ایمیل درست نیست');
  const name = text(b.name, 60, 'نام');
  const pass = password(b.password);
  const phone = normPhone(b.phone);
  await throttle(db, 'reg:' + (req.headers.get('cf-connecting-ip') || 'x'), 10, 36e5);
  if (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()) fail(409, 'با این ایمیل قبلاً ثبت‌نام شده؛ وارد شوید');
  const data = { name, phone: phone || null, pass: await hashPass(pass), client: client(b.client) };
  const conf = await mailConf(db, env);
  if (!conf) {
    // email not set up yet: only the admin can join (to set it up); everyone else waits
    if (!admins(env).includes(email)) fail(503, 'ثبت‌نام هنوز باز نیست (ارسال کد ایمیلی راه‌اندازی نشده)؛ کمی بعد دوباره امتحان کنید');
    return createUser(db, env, email, data);
  }
  return sendCode(db, env, conf, email, 'reg', data);
});
// the code from the email: only now is the account made
route('POST', '/api/register/verify', async ({ db, b, env }) => {
  const email = normEmail(b.email);
  if (!okEmail(email)) fail(400, 'ایمیل درست نیست');
  await throttle(db, 'verify:' + email, 20, 36e5);
  const data = await checkCode(db, email, 'reg', b.code);
  if (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()) fail(409, 'با این ایمیل قبلاً ثبت‌نام شده؛ وارد شوید');
  return createUser(db, env, email, data);
});
async function createUser(db, env, email, data) {
  const isAdmin = admins(env).includes(email);
  const u = { id: newId(), email, name: data.name, phone: data.phone || null, pass: data.pass, role: isAdmin ? 'admin' : 'user', status: 'active', created: Date.now() };
  await db.prepare('INSERT INTO users (id, email, name, phone, pass, role, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(u.id, u.email, u.name, u.phone, u.pass, u.role, u.status, u.created).run();
  return startSession(db, u, client(data.client));
}
const client = c => ['desktop', 'android', 'web'].includes(c) ? c : 'web';

route('POST', '/api/login', async ({ db, b, env }) => {
  const email = normEmail(b.email);
  if (!okEmail(email)) fail(400, 'ایمیل درست نیست');
  await throttle(db, 'login:' + email, 8, 15 * 6e4);
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u || !(await checkPass(String(b.password || ''), u.pass))) fail(401, 'ایمیل یا رمز اشتباه است');
  if (u.status === 'blocked') fail(403, 'حساب شما مسدود شده است');
  await unthrottle(db, 'login:' + email);
  const conf = await mailConf(db, env);
  if (conf) return sendCode(db, env, conf, email, 'login', { client: client(b.client) }); // step 2: the code from the email
  return finishLogin(db, env, u, client(b.client)); // email not set up yet: the password alone (nobody is locked out)
});
route('POST', '/api/login/verify', async ({ db, b, env }) => {
  const email = normEmail(b.email);
  if (!okEmail(email)) fail(400, 'ایمیل درست نیست');
  await throttle(db, 'verify:' + email, 20, 36e5);
  const data = await checkCode(db, email, 'login', b.code);
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u) fail(401, 'حساب پیدا نشد');
  if (u.status === 'blocked') fail(403, 'حساب شما مسدود شده است');
  return finishLogin(db, env, u, data.client);
});
async function finishLogin(db, env, u, cl) {
  if (admins(env).includes(u.email) && u.role !== 'admin') { await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(u.id).run(); u.role = 'admin'; }
  return startSession(db, u, client(cl));
}
// a new code for the same step (only after the first one: sign-up details / correct password are already in)
route('POST', '/api/code/resend', async ({ db, b, env }) => {
  const email = normEmail(b.email), purpose = b.purpose === 'login' ? 'login' : 'reg';
  const row = await db.prepare('SELECT data FROM codes WHERE k = ?').bind(purpose + ':' + email).first();
  if (!row) fail(400, 'دوباره از اول شروع کنید');
  const conf = await mailConf(db, env); if (!conf) fail(503, 'ارسال ایمیل راه‌اندازی نشده');
  return sendCode(db, env, conf, email, purpose, row.data ? JSON.parse(row.data) : null, { resend: true });
});

route('POST', '/api/logout', async ({ db, req }) => {
  const { tokenHash } = await auth(db, req);
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(tokenHash).run();
  return { ok: true };
});

async function announcementsFor(db, u) {
  const buyer = !!(await db.prepare('SELECT id FROM licenses WHERE user_id = ? AND revoked = 0 LIMIT 1').bind(u.id).first());
  const r = await db.prepare(`SELECT id, title, body, audience, created FROM announcements WHERE audience = 'all' ${buyer ? "OR audience = 'buyers'" : ''} ${u.role === 'admin' ? "OR 1 = 1" : ''} ORDER BY created DESC LIMIT 30`).all();
  return { buyer, list: r.results };
}
route('GET', '/api/me', async ({ db, req }) => {
  const { user } = await auth(db, req);
  const lic = (await db.prepare('SELECT id, code, key, device, updates_until, created, revoked FROM licenses WHERE user_id = ? ORDER BY created DESC').bind(user.id).all()).results
    .map(l => ({ id: l.id, code: l.code, key: l.key, device: l.device, updatesUntil: l.updates_until, created: l.created, revoked: !!l.revoked }));
  const ann = await announcementsFor(db, user);
  const unread = (await db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND user_seen = 0').bind(user.id).first()).n;
  return { user: publicUser(user), licenses: lic, buyer: ann.buyer, announcements: ann.list, unreadTickets: unread };
});

route('PATCH', '/api/me', async ({ db, req, b }) => {
  const { user } = await auth(db, req);
  if (b.name != null) await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(text(b.name, 60, 'نام'), user.id).run();
  if (b.phone != null) await db.prepare('UPDATE users SET phone = ? WHERE id = ?').bind(normPhone(b.phone) || null, user.id).run();
  if (b.newPassword != null) {
    if (!(await checkPass(String(b.password || ''), user.pass))) fail(401, 'رمز فعلی اشتباه است');
    await db.prepare('UPDATE users SET pass = ? WHERE id = ?').bind(await hashPass(password(b.newPassword)), user.id).run();
  }
  return { user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()) };
});

// delete my own account (and everything tied to it)
route('DELETE', '/api/me', async ({ db, req, b }) => {
  const { user } = await auth(db, req);
  if (!(await checkPass(String(b.password || ''), user.pass))) fail(401, 'رمز اشتباه است');
  if (user.role === 'admin' && (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first()).n <= 1) fail(400, 'آخرین مدیر نمی‌تواند حسابش را پاک کند');
  await removeUser(db, user.id);
  return { ok: true };
});
// ---- admin: the email service for the codes (Brevo) ----
route('GET', '/api/admin/mail', async ({ db, req, env }) => {
  await auth(db, req, { admin: true });
  const c = await mailConf(db, env);
  return { configured: !!(c && !c.dev), source: c ? c.source || 'dev' : null, from: c ? c.from : '', fromName: c ? c.name || '' : '', keyHint: c && c.key ? '…' + String(c.key).slice(-4) : '' };
});
route('PUT', '/api/admin/mail', async ({ db, req, env, b }) => {
  await auth(db, req, { admin: true });
  if (env.BREVO_API_KEY && env.MAIL_FROM) fail(400, 'ایمیل از تنظیمات Cloudflare (secret) می‌آید و این‌جا عوض نمی‌شود');
  const old = await db.prepare("SELECT v FROM shop WHERE k = 'mail'").first();
  const prev = old ? JSON.parse(old.v) : {};
  if (b.clear) { await db.prepare("DELETE FROM shop WHERE k = 'mail'").run(); return { ok: true, configured: false }; }
  const from = normEmail(b.from || prev.from);
  if (!okEmail(from)) fail(400, 'ایمیل فرستنده درست نیست');
  const key = String(b.apiKey || '').trim() || prev.key;
  if (!key || !/^xkeysib-[\w-]{20,}$/.test(key)) fail(400, 'کلید API برِوو باید با xkeysib- شروع شود');
  await db.prepare("INSERT OR REPLACE INTO shop (k, v) VALUES ('mail', ?)").bind(JSON.stringify({ key, from, name: text(b.fromName || prev.name || 'JARVIS', 60, 'نام فرستنده') })).run();
  return { ok: true, configured: true, from, keyHint: '…' + key.slice(-4) };
});
route('POST', '/api/admin/mail/test', async ({ db, req, env }) => {
  const { user } = await auth(db, req, { admin: true });
  const c = await mailConf(db, env); if (!c) fail(400, 'اول کلید و ایمیل فرستنده را ذخیره کنید');
  await deliver(c, user.email, newCode(), 'test');
  return { ok: true, to: user.email };
});

async function removeUser(db, id) {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM messages WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id = ?)').bind(id),
    db.prepare('DELETE FROM tickets WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM licenses WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM purchases WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
}

// ---- support tickets ----
const ticketOut = t => ({ id: t.id, subject: t.subject, status: t.status, created: t.created, updated: t.updated, unread: undefined, userId: t.user_id, userName: t.name, userEmail: t.email });
route('GET', '/api/tickets', async ({ db, req }) => {
  const { user } = await auth(db, req);
  const r = await db.prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY updated DESC LIMIT 100').bind(user.id).all();
  return { tickets: r.results.map(t => ({ ...ticketOut(t), unread: !t.user_seen })) };
});
route('POST', '/api/tickets', async ({ db, req, b }) => {
  const { user } = await auth(db, req);
  const subject = text(b.subject, 120, 'موضوع'), msg = text(b.body, 4000, 'متن');
  const open = (await db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND status = 'open'").bind(user.id).first()).n;
  if (open >= 10) fail(429, 'ده درخواست باز دارید؛ صبر کنید تا جواب بگیرند');
  const t = Date.now(), id = newId();
  await db.batch([
    db.prepare('INSERT INTO tickets (id, user_id, subject, status, created, updated, user_seen, admin_seen) VALUES (?, ?, ?, ?, ?, ?, 1, 0)').bind(id, user.id, subject, 'open', t, t),
    db.prepare('INSERT INTO messages (id, ticket_id, from_admin, body, created) VALUES (?, ?, 0, ?, ?)').bind(newId(), id, msg, t),
  ]);
  return { id };
});
async function ticketFor(db, user, id) {
  const t = await db.prepare('SELECT tickets.*, users.name, users.email FROM tickets JOIN users ON users.id = tickets.user_id WHERE tickets.id = ?').bind(id).first();
  if (!t || (t.user_id !== user.id && user.role !== 'admin')) fail(404, 'درخواست پیدا نشد');
  return t;
}
route('GET', '/api/tickets/:id', async ({ db, req, p }) => {
  const { user } = await auth(db, req);
  const t = await ticketFor(db, user, p.id);
  const asAdmin = user.role === 'admin' && t.user_id !== user.id;
  await db.prepare(`UPDATE tickets SET ${asAdmin ? 'admin_seen' : 'user_seen'} = 1 WHERE id = ?`).bind(t.id).run();
  const m = await db.prepare('SELECT id, from_admin, body, created FROM messages WHERE ticket_id = ? ORDER BY created').bind(t.id).all();
  return { ticket: ticketOut(t), messages: m.results.map(x => ({ id: x.id, fromAdmin: !!x.from_admin, body: x.body, created: x.created })) };
});
route('POST', '/api/tickets/:id', async ({ db, req, p, b }) => {
  const { user } = await auth(db, req);
  const t = await ticketFor(db, user, p.id);
  const asAdmin = user.role === 'admin' && t.user_id !== user.id;
  const msg = text(b.body, 4000, 'متن'), now = Date.now();
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE ticket_id = ?').bind(t.id).first()).n;
  if (n >= 200) fail(429, 'این گفتگو خیلی طولانی شده؛ یک درخواست تازه بسازید');
  await db.batch([
    db.prepare('INSERT INTO messages (id, ticket_id, from_admin, body, created) VALUES (?, ?, ?, ?, ?)').bind(newId(), t.id, asAdmin ? 1 : 0, msg, now),
    db.prepare(`UPDATE tickets SET updated = ?, status = 'open', ${asAdmin ? 'user_seen = 0, admin_seen = 1' : 'admin_seen = 0, user_seen = 1'} WHERE id = ?`).bind(now, t.id),
  ]);
  return { ok: true };
});

// ---- buying the Android app ----
const SHOP_KEYS = ['price', 'currency', 'card', 'holder', 'note', 'contact'];
async function shopInfo(db) {
  const r = (await db.prepare('SELECT k, v FROM shop').all()).results;
  const o = Object.fromEntries(SHOP_KEYS.map(k => [k, '']));
  for (const x of r) if (SHOP_KEYS.includes(x.k)) o[x.k] = x.v;
  return o;
}
const purchaseOut = p => ({ id: p.id, device: p.device, ref: p.ref, card4: p.card4 || '', amount: p.amount || '', note: p.note || '', status: p.status, reason: p.reason || '', created: p.created, decided: p.decided || null, userName: p.name, userEmail: p.email });
// price and card number for the buy screen (members only)
route('GET', '/api/shop', async ({ db, req }) => { await auth(db, req); return shopInfo(db); });
route('POST', '/api/purchases', async ({ db, req, b }) => {
  const { user } = await auth(db, req);
  const device = String(b.device || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(device)) fail(400, 'کد دستگاه نامعتبر است');
  const ref = faDigits(b.ref).replace(/[^\dA-Za-z]/g, '').slice(0, 30);
  if (ref.length < 4) fail(400, 'شماره‌ی پیگیری را درست وارد کنید');
  const card4 = faDigits(b.card4).replace(/\D/g, '').slice(-4);
  const pending = (await db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id = ? AND status = 'pending'").bind(user.id).first()).n;
  if (pending >= 3) fail(429, 'سه درخواست در انتظار دارید؛ صبر کنید تا بررسی شوند');
  const id = newId();
  await db.prepare('INSERT INTO purchases (id, user_id, device, ref, card4, amount, note, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, device, ref, card4 || null, String(b.amount || '').slice(0, 30) || null, String(b.note || '').slice(0, 300) || null, 'pending', Date.now()).run();
  return { id, status: 'pending' };
});
route('GET', '/api/purchases', async ({ db, req }) => {
  const { user } = await auth(db, req);
  const r = await db.prepare('SELECT purchases.*, users.name, users.email FROM purchases JOIN users ON users.id = purchases.user_id WHERE purchases.user_id = ? ORDER BY purchases.created DESC LIMIT 20').bind(user.id).all();
  return { purchases: r.results.map(purchaseOut) };
});
route('GET', '/api/admin/purchases', async ({ db, req, url }) => {
  await auth(db, req, { admin: true });
  const st = url.searchParams.get('status');
  const r = await db.prepare(`SELECT purchases.*, users.name, users.email FROM purchases JOIN users ON users.id = purchases.user_id ${['pending', 'approved', 'rejected'].includes(st) ? 'WHERE purchases.status = ?' : 'WHERE ? = ?'} ORDER BY purchases.created DESC LIMIT 200`)
    .bind(...(['pending', 'approved', 'rejected'].includes(st) ? [st] : [1, 1])).all();
  return { purchases: r.results.map(purchaseOut) };
});
route('PATCH', '/api/admin/purchases/:id', async ({ db, req, p, b }) => {
  await auth(db, req, { admin: true });
  if (!['approved', 'rejected'].includes(b.status)) fail(400, 'وضعیت نامعتبر');
  const x = await db.prepare('SELECT id FROM purchases WHERE id = ?').bind(p.id).first();
  if (!x) fail(404, 'درخواست پیدا نشد');
  await db.prepare('UPDATE purchases SET status = ?, reason = ?, license_id = ?, decided = ? WHERE id = ?').bind(b.status, String(b.reason || '').slice(0, 300) || null, b.licenseId ? String(b.licenseId).slice(0, 40) : null, Date.now(), p.id).run();
  return { ok: true };
});
route('POST', '/api/admin/shop', async ({ db, req, b }) => {
  await auth(db, req, { admin: true });
  await db.batch(SHOP_KEYS.filter(k => b[k] != null).map(k => db.prepare('INSERT OR REPLACE INTO shop (k, v) VALUES (?, ?)').bind(k, String(b[k]).slice(0, 300))));
  return shopInfo(db);
});

// ---- admin ----
route('GET', '/api/admin/stats', async ({ db, req }) => {
  await auth(db, req, { admin: true });
  const n = async (sql, ...a) => (await db.prepare(sql).bind(...a).first()).n;
  const t = Date.now();
  return {
    users: await n('SELECT COUNT(*) AS n FROM users'),
    admins: await n("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
    blocked: await n("SELECT COUNT(*) AS n FROM users WHERE status = 'blocked'"),
    active7: await n('SELECT COUNT(*) AS n FROM users WHERE last_seen > ?', t - 7 * DAY),
    new7: await n('SELECT COUNT(*) AS n FROM users WHERE created > ?', t - 7 * DAY),
    buyers: await n('SELECT COUNT(DISTINCT user_id) AS n FROM licenses WHERE revoked = 0'),
    android: await n("SELECT COUNT(*) AS n FROM users WHERE client = 'android'"),
    openTickets: await n("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'"),
    unreadTickets: await n('SELECT COUNT(*) AS n FROM tickets WHERE admin_seen = 0'),
    pendingPurchases: await n("SELECT COUNT(*) AS n FROM purchases WHERE status = 'pending'"),
  };
});
route('GET', '/api/admin/users', async ({ db, req, url }) => {
  await auth(db, req, { admin: true });
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 80);
  const page = Math.max(0, +url.searchParams.get('page') || 0);
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const r = await db.prepare(`SELECT users.*, (SELECT COUNT(*) FROM licenses WHERE licenses.user_id = users.id AND revoked = 0) AS lic
    FROM users WHERE ? = '' OR lower(email) LIKE ? OR lower(name) LIKE ? OR phone LIKE ? ORDER BY created DESC LIMIT 50 OFFSET ?`).bind(q, like, like, like, page * 50).all();
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ? = '' OR lower(email) LIKE ? OR lower(name) LIKE ? OR phone LIKE ?`).bind(q, like, like, like).first()).n;
  return { users: r.results.map(u => ({ ...publicUser(u), client: u.client || '', licenses: u.lic })), total, page };
});
route('PATCH', '/api/admin/users/:id', async ({ db, req, p, b }) => {
  const { user: me } = await auth(db, req, { admin: true });
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(p.id).first();
  if (!u) fail(404, 'کاربر پیدا نشد');
  if (u.id === me.id && (b.role === 'user' || b.status === 'blocked')) fail(400, 'نمی‌توانید نقش یا وضعیت خودتان را بگیرید');
  if (b.role != null) { if (!['user', 'admin'].includes(b.role)) fail(400, 'نقش نامعتبر'); await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role, u.id).run(); }
  if (b.status != null) {
    if (!['active', 'blocked'].includes(b.status)) fail(400, 'وضعیت نامعتبر');
    await db.prepare('UPDATE users SET status = ? WHERE id = ?').bind(b.status, u.id).run();
    if (b.status === 'blocked') await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id).run();
  }
  return { user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first()) };
});
route('DELETE', '/api/admin/users/:id', async ({ db, req, p }) => {
  const { user: me } = await auth(db, req, { admin: true });
  if (p.id === me.id) fail(400, 'حساب خودتان را از اینجا پاک نکنید');
  if (!(await db.prepare('SELECT id FROM users WHERE id = ?').bind(p.id).first())) fail(404, 'کاربر پیدا نشد');
  await removeUser(db, p.id);
  return { ok: true };
});
route('POST', '/api/admin/announcements', async ({ db, req, b }) => {
  await auth(db, req, { admin: true });
  const a = { id: newId(), title: text(b.title, 120, 'عنوان'), body: text(b.body, 4000, 'متن'), audience: ['all', 'buyers'].includes(b.audience) ? b.audience : 'all', created: Date.now() };
  await db.prepare('INSERT INTO announcements (id, title, body, audience, created) VALUES (?, ?, ?, ?, ?)').bind(a.id, a.title, a.body, a.audience, a.created).run();
  return { announcement: a };
});
route('DELETE', '/api/admin/announcements/:id', async ({ db, req, p }) => {
  await auth(db, req, { admin: true });
  await db.prepare('DELETE FROM announcements WHERE id = ?').bind(p.id).run();
  return { ok: true };
});
route('GET', '/api/admin/tickets', async ({ db, req, url }) => {
  await auth(db, req, { admin: true });
  const st = url.searchParams.get('status');
  const r = await db.prepare(`SELECT tickets.*, users.name, users.email FROM tickets JOIN users ON users.id = tickets.user_id ${st === 'open' || st === 'closed' ? 'WHERE tickets.status = ?' : 'WHERE ? = ?'} ORDER BY updated DESC LIMIT 200`)
    .bind(...(st === 'open' || st === 'closed' ? [st] : [1, 1])).all();
  return { tickets: r.results.map(t => ({ ...ticketOut(t), unread: !t.admin_seen })) };
});
route('PATCH', '/api/admin/tickets/:id', async ({ db, req, p, b }) => {
  await auth(db, req, { admin: true });
  if (!['open', 'closed'].includes(b.status)) fail(400, 'وضعیت نامعتبر');
  await db.prepare('UPDATE tickets SET status = ?, updated = ? WHERE id = ?').bind(b.status, Date.now(), p.id).run();
  return { ok: true };
});
// the seller's JARVIS hands a member their Android license (they then see it in the club and the app activates itself)
route('POST', '/api/admin/licenses', async ({ db, req, b }) => {
  await auth(db, req, { admin: true });
  const u = await db.prepare('SELECT id FROM users WHERE email = ?').bind(normEmail(b.email)).first();
  if (!u) fail(404, 'عضوی با این ایمیل در باشگاه نیست');
  const key = text(b.key, 2000, 'کلید');
  if (!/^JRV1\.[\w-]+\.[\w-]+$/.test(key)) fail(400, 'کلید لایسنس نامعتبر');
  const id = String(b.id || newId()).replace(/[^\w-]/g, '').slice(0, 40) || newId();
  await db.prepare('INSERT OR REPLACE INTO licenses (id, user_id, code, key, device, updates_until, created, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
    .bind(id, u.id, b.code ? String(b.code).slice(0, 20) : null, key, b.device ? String(b.device).slice(0, 20) : null, +b.updatesUntil || null, Date.now()).run();
  return { ok: true, id };
});
route('PATCH', '/api/admin/licenses/:id', async ({ db, req, p, b }) => {
  await auth(db, req, { admin: true });
  await db.prepare('UPDATE licenses SET revoked = ? WHERE id = ?').bind(b.revoked ? 1 : 0, p.id).run();
  return { ok: true };
});

export async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const db = env.DB;
  try {
    if (!db) fail(500, 'پایگاه داده (D1) وصل نیست');
    ready ||= migrate(db).catch(e => { ready = null; throw e; });
    await ready;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const b = req.method === 'GET' ? {} : await body(req);
      return json(await r.fn({ req, env, db, url, b, p: m.groups || {} }));
    }
    if (url.pathname === '/' || url.pathname === '') return new Response('JARVIS Club', { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    fail(404, 'مسیر پیدا نشد');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'خطای سرور باشگاه' }, 500);
  }
}
export const _reset = () => { ready = null; };
export default { fetch: handle };
