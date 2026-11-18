// The club service (club/worker.js) against a real SQLite database shaped like Cloudflare D1.
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

// minimal D1 over node:sqlite: prepare().bind().first()/all()/run(), batch()
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a.map(v => v === undefined ? null : v)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: sql => stmt(sql), batch: async list => { db.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } }, raw: db };
}

let W;
test('club service', async t => {
  W = await import('../club/worker.js');
  W._reset();
  const env = { DB: d1(), ADMIN_EMAIL: 'boss@example.com', DEV_MAIL: '1' };
  const raw = async (method, path, b, token, headers = {}) => {
    const r = await W.handle(new Request('https://club.test' + path, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: b ? JSON.stringify(b) : undefined }), env);
    return { status: r.status, d: await r.json(), cors: r.headers.get('access-control-allow-origin') };
  };
  // sign-up and login now end with an email code: take it from the dev outbox and confirm it
  const call = async (method, path, b, token, headers) => {
    const r = await raw(method, path, b, token, headers);
    if (r.status === 200 && r.d.needCode) { env.DB.raw.exec('DELETE FROM throttle'); return raw('POST', path + '/verify', { email: r.d.email, code: W.devOutbox.get(r.d.email) }); }
    return r;
  };

  await t.test('health + CORS', async () => {
    const r = await call('GET', '/api/health');
    assert.equal(r.status, 200); assert.equal(r.d.name, 'jarvis-club'); assert.equal(r.cors, '*');
  });

  let user, admin;
  await t.test('register: checks, admin by email, password is hashed', async () => {
    assert.equal((await call('POST', '/api/register', { email: 'bad', name: 'x', password: '12345678' })).status, 400);
    assert.equal((await call('POST', '/api/register', { email: 'a@b.co', name: 'x', password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/register', { email: 'a@b.co', name: '', password: '12345678' })).status, 400);
    const r = await call('POST', '/api/register', { email: ' Ali@Example.com ', name: 'علی', password: 'secret-pass', phone: '۰۹۱۲ ۳۴۵ ۶۷۸۹', client: 'android' });
    assert.equal(r.status, 200); assert.match(r.d.token, /^jc_[0-9a-f]{64}$/);
    assert.equal(r.d.user.email, 'ali@example.com'); assert.equal(r.d.user.role, 'user'); assert.equal(r.d.user.phone, '09123456789');
    user = r.d;
    const row = env.DB.raw.prepare('SELECT pass FROM users WHERE email = ?').get('ali@example.com');
    assert.match(row.pass, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(env.DB.raw.prepare('SELECT * FROM sessions').all()).includes(user.token), 'tokens are stored hashed');
    assert.equal((await call('POST', '/api/register', { email: 'ali@example.com', name: 'x', password: '12345678' })).status, 409);
    admin = (await call('POST', '/api/register', { email: 'boss@example.com', name: 'مدیر', password: 'boss-pass-1' })).d;
    assert.equal(admin.user.role, 'admin');
  });

  await t.test('login, wrong password, lockout after many tries', async () => {
    assert.equal((await call('POST', '/api/login', { email: 'ali@example.com', password: 'nope-nope' })).status, 401);
    const ok = await call('POST', '/api/login', { email: 'ALI@example.com', password: 'secret-pass', client: 'desktop' });
    assert.equal(ok.status, 200); assert.notEqual(ok.d.token, user.token);
    for (let i = 0; i < 8; i++) await call('POST', '/api/login', { email: 'x@example.com', password: 'wrongwrong' });
    assert.equal((await call('POST', '/api/login', { email: 'x@example.com', password: 'wrongwrong' })).status, 429);
  });

  await t.test('me: needs a token; profile update; password change', async () => {
    assert.equal((await call('GET', '/api/me')).status, 401);
    assert.equal((await call('GET', '/api/me', null, 'jc_' + '0'.repeat(64))).status, 401);
    const me = await call('GET', '/api/me', null, user.token);
    assert.equal(me.status, 200); assert.equal(me.d.user.name, 'علی'); assert.deepEqual(me.d.licenses, []); assert.equal(me.d.buyer, false);
    assert.equal((await call('PATCH', '/api/me', { name: 'علی رضایی' }, user.token)).d.user.name, 'علی رضایی');
    assert.equal((await call('PATCH', '/api/me', { password: 'wrong-old', newPassword: 'newpass-123' }, user.token)).status, 401);
    assert.equal((await call('PATCH', '/api/me', { password: 'secret-pass', newPassword: 'newpass-123' }, user.token)).status, 200);
    assert.equal((await call('POST', '/api/login', { email: 'ali@example.com', password: 'newpass-123' })).status, 200);
  });

  await t.test('users cannot reach admin routes', async () => {
    for (const [m, p] of [['GET', '/api/admin/stats'], ['GET', '/api/admin/users'], ['POST', '/api/admin/announcements'], ['GET', '/api/admin/tickets']])
      assert.equal((await call(m, p, m === 'POST' ? { title: 'x', body: 'y' } : null, user.token)).status, 403, p);
  });

  await t.test('announcements: all vs buyers', async () => {
    await call('POST', '/api/admin/announcements', { title: 'نسخه‌ی تازه', body: 'برای همه', audience: 'all' }, admin.token);
    const b = await call('POST', '/api/admin/announcements', { title: 'فقط خریداران', body: 'آپدیت اندروید', audience: 'buyers' }, admin.token);
    let me = await call('GET', '/api/me', null, user.token);
    assert.deepEqual(me.d.announcements.map(a => a.title), ['نسخه‌ی تازه']);
    // the seller hands Ali a license → he becomes a buyer and sees it
    const key = 'JRV1.eyJkIjoiQUJDRCJ9.c2ln';
    assert.equal((await call('POST', '/api/admin/licenses', { email: 'nobody@example.com', key }, admin.token)).status, 404);
    assert.equal((await call('POST', '/api/admin/licenses', { email: 'ali@example.com', key: 'junk' }, admin.token)).status, 400);
    assert.equal((await call('POST', '/api/admin/licenses', { id: 'sale1', email: 'ali@example.com', key, code: 'JRV-AAAA-BBBB', device: 'ABCD-EFGH-IJKL', updatesUntil: 99999 }, admin.token)).status, 200);
    me = await call('GET', '/api/me', null, user.token);
    assert.equal(me.d.buyer, true); assert.equal(me.d.licenses[0].code, 'JRV-AAAA-BBBB'); assert.equal(me.d.licenses[0].key, key);
    assert.equal(me.d.announcements.length, 2);
    await call('PATCH', '/api/admin/licenses/sale1', { revoked: true }, admin.token);
    me = await call('GET', '/api/me', null, user.token);
    assert.equal(me.d.licenses[0].revoked, true); assert.equal(me.d.buyer, false);
    await call('DELETE', '/api/admin/announcements/' + b.d.announcement.id, null, admin.token);
  });

  await t.test('tickets: user ↔ admin, unread flags, privacy between users', async () => {
    const other = (await call('POST', '/api/register', { email: 'sara@example.com', name: 'سارا', password: 'sara-pass-1' })).d;
    const c = await call('POST', '/api/tickets', { subject: 'فعال‌سازی', body: 'کد کار نمی‌کند' }, user.token);
    assert.equal(c.status, 200);
    assert.equal((await call('GET', '/api/tickets/' + c.d.id, null, other.token)).status, 404, 'another user cannot read it');
    let at = await call('GET', '/api/admin/tickets?status=open', null, admin.token);
    assert.equal(at.d.tickets.length, 1); assert.equal(at.d.tickets[0].unread, true); assert.equal(at.d.tickets[0].userEmail, 'ali@example.com');
    assert.equal((await call('POST', '/api/tickets/' + c.d.id, { body: 'کد را دوباره بفرستید' }, admin.token)).status, 200);
    assert.equal((await call('GET', '/api/me', null, user.token)).d.unreadTickets, 1);
    const view = await call('GET', '/api/tickets/' + c.d.id, null, user.token);
    assert.deepEqual(view.d.messages.map(m => m.fromAdmin), [false, true]);
    assert.equal((await call('GET', '/api/me', null, user.token)).d.unreadTickets, 0);
    await call('PATCH', '/api/admin/tickets/' + c.d.id, { status: 'closed' }, admin.token);
    assert.equal((await call('GET', '/api/admin/tickets?status=open', null, admin.token)).d.tickets.length, 0);
  });

  await t.test('buying: shop info, purchase request, admin approves or rejects', async () => {
    assert.equal((await call('POST', '/api/admin/shop', { price: '490000', card: '6037991122334455', holder: 'فروشنده' }, user.token)).status, 403, 'only the admin sets the shop');
    await call('POST', '/api/admin/shop', { price: '490000', currency: 'تومان', card: '6037991122334455', holder: 'فروشنده' }, admin.token);
    const shop = await call('GET', '/api/shop', null, user.token);
    assert.equal(shop.d.price, '490000'); assert.equal(shop.d.holder, 'فروشنده');
    assert.equal((await call('GET', '/api/shop')).status, 401, 'members only');
    assert.equal((await call('POST', '/api/purchases', { device: 'bad', ref: '123456' }, user.token)).status, 400);
    assert.equal((await call('POST', '/api/purchases', { device: 'ABCD-EFGH-JKLM', ref: '۱۲' }, user.token)).status, 400, 'tracking number too short');
    const pr = await call('POST', '/api/purchases', { device: 'abcd-efgh-jkLm', ref: '۱۲۳۴۵۶۷۸', card4: '9876' }, user.token);
    assert.equal(pr.status, 200);
    let mine = (await call('GET', '/api/purchases', null, user.token)).d.purchases;
    assert.equal(mine[0].status, 'pending'); assert.equal(mine[0].ref, '12345678'); assert.equal(mine[0].device, 'ABCD-EFGH-JKLM');
    const pend = (await call('GET', '/api/admin/purchases?status=pending', null, admin.token)).d.purchases;
    assert.equal(pend.length, 1); assert.equal(pend[0].userEmail, 'ali@example.com');
    assert.equal((await call('GET', '/api/admin/stats', null, admin.token)).d.pendingPurchases, 1);
    assert.equal((await call('PATCH', '/api/admin/purchases/' + pend[0].id, { status: 'approved' }, user.token)).status, 403);
    await call('PATCH', '/api/admin/purchases/' + pend[0].id, { status: 'rejected', reason: 'پیدا نشد' }, admin.token);
    mine = (await call('GET', '/api/purchases', null, user.token)).d.purchases;
    assert.equal(mine[0].status, 'rejected'); assert.equal(mine[0].reason, 'پیدا نشد');
    for (let i = 0; i < 3; i++) await call('POST', '/api/purchases', { device: 'ABCD-EFGH-JKLM', ref: '99999' + i }, user.token);
    assert.equal((await call('POST', '/api/purchases', { device: 'ABCD-EFGH-JKLM', ref: '777777' }, user.token)).status, 429, 'at most three waiting');
  });

  await t.test('admin: stats, search, promote, block (ends sessions), delete', async () => {
    const st = await call('GET', '/api/admin/stats', null, admin.token);
    assert.equal(st.d.users, 3); assert.equal(st.d.admins, 1); assert.equal(st.d.active7, 3); assert.equal(st.d.android, 0, 'Ali last used the desktop');
    const s = await call('GET', '/api/admin/users?q=' + encodeURIComponent('سارا'), null, admin.token);
    assert.equal(s.d.total, 1); assert.equal(s.d.users[0].email, 'sara@example.com');
    const sara = s.d.users[0];
    assert.equal((await call('PATCH', '/api/admin/users/' + admin.user.id, { role: 'user' }, admin.token)).status, 400, 'cannot demote yourself');
    assert.equal((await call('PATCH', '/api/admin/users/' + sara.id, { role: 'admin' }, admin.token)).d.user.role, 'admin');
    assert.equal((await call('PATCH', '/api/admin/users/' + sara.id, { role: 'user' }, admin.token)).d.user.role, 'user');
    const ali = (await call('GET', '/api/admin/users?q=ali', null, admin.token)).d.users[0];
    assert.equal(ali.licenses, 0);
    await call('PATCH', '/api/admin/users/' + ali.id, { status: 'blocked' }, admin.token);
    assert.equal((await call('GET', '/api/me', null, user.token)).status, 401, 'sessions ended');
    assert.equal((await call('POST', '/api/login', { email: 'ali@example.com', password: 'newpass-123' })).status, 403);
    await call('PATCH', '/api/admin/users/' + ali.id, { status: 'active' }, admin.token);
    assert.equal((await call('DELETE', '/api/admin/users/' + sara.id, null, admin.token)).status, 200);
    assert.equal((await call('GET', '/api/admin/stats', null, admin.token)).d.users, 2);
  });

  await t.test('delete own account needs the password; the last admin cannot', async () => {
    const r = (await call('POST', '/api/login', { email: 'ali@example.com', password: 'newpass-123' })).d;
    assert.equal((await call('DELETE', '/api/me', { password: 'wrong' }, r.token)).status, 401);
    assert.equal((await call('DELETE', '/api/me', { password: 'newpass-123' }, r.token)).status, 200);
    assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM licenses").get().n, 0);
    assert.equal((await call('DELETE', '/api/me', { password: 'boss-pass-1' }, admin.token)).status, 400);
  });

  await t.test('logout ends the session; unknown routes 404', async () => {
    assert.equal((await call('POST', '/api/logout', null, admin.token)).status, 200);
    assert.equal((await call('GET', '/api/me', null, admin.token)).status, 401);
    assert.equal((await call('GET', '/api/nope')).status, 404);
  });
});
