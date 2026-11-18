// Email codes in the club: sign-up is confirmed by a code, login is password + code, and until
// the email service (Brevo) is set up nobody is locked out.
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map(v => v === undefined ? null : v)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: sql => stmt(sql), batch: async list => { db.exec('BEGIN'); try { const o = []; for (const s of list) o.push(await s.run()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } }, raw: db };
}

test('club email codes', async t => {
  const W = await import('../club/worker.js');
  const mk = extra => { W._reset(); const env = { DB: d1(), ADMIN_EMAIL: 'boss@example.com', ...extra };
    return { env, call: async (method, path, b, token) => { const r = await W.handle(new Request('https://club.test' + path, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: b ? JSON.stringify(b) : undefined }), env); return { status: r.status, d: await r.json() }; } }; };

  await t.test('sign-up: no account until the code; wrong code counts down; right code makes it', async () => {
    const { env, call } = mk({ DEV_MAIL: '1' });
    const r = await call('POST', '/api/register', { email: 'Ali@Example.com', name: 'علی', password: 'secret-pass' });
    assert.equal(r.status, 200); assert.equal(r.d.needCode, true); assert.equal(r.d.email, 'ali@example.com'); assert.ok(!r.d.token);
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'no account before the code');
    const code = W.devOutbox.get('ali@example.com'); assert.match(code, /^\d{6}$/);
    assert.ok(!JSON.stringify(env.DB.raw.prepare('SELECT * FROM codes').all()).includes(code), 'the code is stored hashed');
    const wrong = code === '000000' ? '111111' : '000000';
    const w = await call('POST', '/api/register/verify', { email: 'ali@example.com', code: wrong });
    assert.equal(w.status, 400); assert.match(w.d.error, /۴/);
    const ok = await call('POST', '/api/register/verify', { email: 'ali@example.com', code: code.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]) }); // Persian digits work
    assert.equal(ok.status, 200); assert.match(ok.d.token, /^jc_/); assert.equal(ok.d.user.name, 'علی');
    assert.equal((await call('POST', '/api/register/verify', { email: 'ali@example.com', code })).status, 400, 'a code works once');
  });

  await t.test('login: with the password alone, or without it by an email code; 5 wrong codes burn it', async () => {
    const { call } = mk({ DEV_MAIL: '1' });
    await call('POST', '/api/register', { email: 'sara@example.com', name: 'سارا', password: 'sara-pass-1' });
    await call('POST', '/api/register/verify', { email: 'sara@example.com', code: W.devOutbox.get('sara@example.com') });
    assert.equal((await call('POST', '/api/login', { email: 'sara@example.com', password: 'wrong-pass' })).status, 401);
    const pw = await call('POST', '/api/login', { email: 'sara@example.com', password: 'sara-pass-1' });
    assert.equal(pw.status, 200); assert.match(pw.d.token, /^jc_/, 'the password alone signs in');
    assert.equal((await call('POST', '/api/login/code', { email: 'nobody@example.com' })).status, 404);
    const s1 = await call('POST', '/api/login/code', { email: 'Sara@Example.com' });
    assert.equal(s1.status, 200); assert.equal(s1.d.needCode, true); assert.equal(s1.d.purpose, 'login'); assert.ok(!s1.d.token);
    const code = W.devOutbox.get('sara@example.com'), bad = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/login/verify', { email: 'sara@example.com', code: bad })).status, 400);
    assert.equal((await call('POST', '/api/login/verify', { email: 'sara@example.com', code })).status, 429, 'burnt after 5 wrong tries');
    assert.equal((await call('POST', '/api/login/verify', { email: 'sara@example.com', code })).status, 400);
  });

  await t.test('resend: only after a first code, and not within 60 s', async () => {
    const { env, call } = mk({ DEV_MAIL: '1' });
    assert.equal((await call('POST', '/api/code/resend', { email: 'new@example.com', purpose: 'reg' })).status, 400);
    await call('POST', '/api/register', { email: 'new@example.com', name: 'نو', password: 'new-pass-1' });
    const again = await call('POST', '/api/code/resend', { email: 'new@example.com', purpose: 'reg' });
    assert.equal(again.status, 429); assert.match(again.d.error, /ثانیه/);
    // the same sign-up again within a minute: back to the code step, the code already sent still works
    const same = W.devOutbox.get('new@example.com');
    const re = await call('POST', '/api/register', { email: 'new@example.com', name: 'نو', password: 'new-pass-1' });
    assert.equal(re.status, 200); assert.equal(re.d.needCode, true); assert.ok(re.d.resendIn > 0); assert.equal(W.devOutbox.get('new@example.com'), same);
    env.DB.raw.exec("UPDATE codes SET sent = sent - 61000");
    const first = W.devOutbox.get('new@example.com');
    const r = await call('POST', '/api/code/resend', { email: 'new@example.com', purpose: 'reg' });
    assert.equal(r.status, 200); assert.equal(r.d.needCode, true);
    const second = W.devOutbox.get('new@example.com');
    if (first !== second) assert.equal((await call('POST', '/api/register/verify', { email: 'new@example.com', code: first })).status, 400, 'the old code no longer works');
    assert.equal((await call('POST', '/api/register/verify', { email: 'new@example.com', code: second })).status, 200);
  });

  await t.test('expired code', async () => {
    const { env, call } = mk({ DEV_MAIL: '1' });
    await call('POST', '/api/register', { email: 'old@example.com', name: 'x', password: 'old-pass-1' });
    env.DB.raw.exec('UPDATE codes SET expires = 1');
    const r = await call('POST', '/api/register/verify', { email: 'old@example.com', code: W.devOutbox.get('old@example.com') });
    assert.equal(r.status, 400); assert.match(r.d.error, /منقضی/);
  });

  await t.test('before email is set up: admin can join, others wait, login keeps working with the password', async () => {
    const { call, env } = mk({});
    const u = await call('POST', '/api/register', { email: 'someone@example.com', name: 'x', password: 'some-pass-1' });
    assert.equal(u.status, 503);
    const a = await call('POST', '/api/register', { email: 'boss@example.com', name: 'مدیر', password: 'boss-pass-1' });
    assert.equal(a.status, 200); assert.equal(a.d.user.role, 'admin');
    const l = await call('POST', '/api/login', { email: 'boss@example.com', password: 'boss-pass-1' });
    assert.equal(l.status, 200); assert.ok(l.d.token, 'the password signs in');
    assert.equal((await call('POST', '/api/login/code', { email: 'boss@example.com' })).status, 503, 'no code login before email is set up');
    // admin settings: the key is checked, stored, never sent back
    assert.equal((await call('GET', '/api/admin/mail', null, a.d.token)).d.configured, false);
    assert.equal((await call('PUT', '/api/admin/mail', { apiKey: 'bad', from: 'me@example.com' }, a.d.token)).status, 400);
    const key = 'xkeysib-' + 'a'.repeat(40) + '-ZZZZ';
    const p = await call('PUT', '/api/admin/mail', { apiKey: key, from: 'Me@Example.com', fromName: 'JARVIS' }, a.d.token);
    assert.equal(p.status, 200); assert.equal(p.d.keyHint, '…ZZZZ');
    const g = await call('GET', '/api/admin/mail', null, a.d.token);
    assert.equal(g.d.configured, true); assert.equal(g.d.from, 'me@example.com'); assert.ok(!JSON.stringify(g.d).includes(key), 'the key is never sent back');
    assert.equal((await call('GET', '/api/admin/mail', null, l.d.token)).status, 200);
    // with email set up, login now sends a code (the real Brevo call fails offline here -> 502, nothing kept)
    const realFetch = globalThis.fetch; let sent = null;
    globalThis.fetch = async (url, o) => { sent = { url, body: JSON.parse(o.body), key: o.headers['api-key'] }; return new Response('{}', { status: 201 }); };
    try {
      const l2 = await call('POST', '/api/login/code', { email: 'boss@example.com' });
      assert.equal(l2.status, 200); assert.equal(l2.d.needCode, true);
      assert.equal(sent.url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(sent.key, key);
      assert.equal(sent.body.to[0].email, 'boss@example.com'); assert.equal(sent.body.sender.email, 'me@example.com');
      const code = /(\d{6})/.exec(sent.body.subject)[1];
      assert.equal((await call('POST', '/api/login/verify', { email: 'boss@example.com', code })).status, 200);
      globalThis.fetch = async () => new Response('{"message":"bad key"}', { status: 401 });
      env.DB.raw.exec('DELETE FROM throttle');
      const f = await call('POST', '/api/register', { email: 'other@example.com', name: 'y', password: 'other-pass-1' });
      assert.equal(f.status, 502); assert.match(f.d.error, /bad key/);
      assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM codes').get().n, 0, 'a code that was not sent is not kept');
    } finally { globalThis.fetch = realFetch; }
  });
});
