// The bell and the SMS page: a paired phone sends its SMS, the computer shows conversations, a new SMS
// rings the bell, and an SMS written on the computer goes to the phone (which asks first).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { Notices, threads } = require('../lib/notices');

test('notices: add, one per key, read, clear; SMS grouped into conversations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-notices-'));
  const evs = []; const n = new Notices(dir, e => evs.push(e));
  n.add({ kind: 'sale', title: 'خرید', key: 'sale:1' }); n.add({ kind: 'sale', title: 'خرید', key: 'sale:1' }); n.add({ kind: 'job', title: 'تمام شد' });
  assert.equal(n.recent().length, 2); assert.equal(n.unread(), 2);
  assert.equal(n.read([n.recent()[0].id]), 1); assert.equal(n.read('all'), 0);
  assert.equal(new Notices(dir).recent().length, 2, 'kept on disk');
  n.clear(); assert.equal(n.recent().length, 0);
  const t = threads([{ from: '+989121234567', body: 'سلام', date: 1, out: false }, { from: '09121234567', body: 'خوبی؟', date: 3, out: true }, { from: 'Bank', body: 'کد 4821', date: 2 }]);
  assert.equal(t.length, 2); assert.equal(t[0].messages.length, 2, '+98 and 0 numbers are one conversation');
  assert.equal(t[0].last.body, 'خوبی؟'); assert.equal(t[0].last.out, true);
});

test('phone ↔ computer: SMS copy, new-SMS bell, sending through the phone', { timeout: 30000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sms-'));
  const T = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, JARVIS_PORT: '0', JARVIS_DATA: data, JARVIS_CLUB_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error(out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/localhost:(\d+)\//); if (m) { clearTimeout(t); res(+m[1]); } }); });
    const call = (p, body) => fetch(`http://127.0.0.1:${port}/api${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-jarvis': '1' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
    assert.equal((await call('/voice/phone-data')).paired, false);
    // pair a "phone"
    let st = await call('/mobile/enable', { on: true });
    for (let i = 0; i < 20 && !st.on; i++) { await new Promise(r => setTimeout(r, 200)); st = await call('/mobile/status'); }
    const pair = await call('/mobile/pair', {});
    const g = `http://127.0.0.1:${pair.port}`;
    const { token } = await fetch(g + '/m/pair', { method: 'POST', body: JSON.stringify({ code: pair.code, name: 'Test phone' }) }).then(r => r.json());
    const phone = (p, body) => fetch(g + '/m/api' + p, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
    // the phone opens: it is asked for a copy of SMS and notifications
    const tasks = (await phone('/voice/phone-tasks')).tasks;
    const smsJob = tasks.find(t => t.action.type === 'phone_sync' && t.action.params.what === 'sms');
    const notJob = tasks.find(t => t.action.type === 'phone_sync' && t.action.params.what === 'notifications');
    assert.ok(smsJob && notJob);
    await phone('/voice/phone-result', { id: smsJob.id, ok: true, data: { sms: [{ from: 'Bank', body: 'کد ورود: 4821', date: T - 5000 }, { from: '+989121234567', body: 'سلام', date: T - 9000 }, { from: '09121234567', body: 'سلام، خوبی؟', date: T - 8000, out: true }] } });
    await phone('/voice/phone-result', { id: notJob.id, ok: true, data: { notifications: [{ app: 'Telegram', title: 'Ali', text: 'کجایی؟', time: Date.now() }] } });
    let pd = await call('/voice/phone-data');
    assert.equal(pd.paired, true); assert.equal(pd.threads.length, 2); assert.equal(pd.threads[0].from, 'Bank');
    assert.equal(pd.notifications[0].app, 'Telegram');
    assert.equal((await call('/notices')).notices.filter(n => n.kind === 'sms').length, 0, 'the first copy announces nothing');
    // a new SMS arrives: the next copy rings the bell
    await call('/voice/phone-sync', {});
    const job2 = (await phone('/voice/phone-tasks')).tasks.find(t => t.action.type === 'phone_sync' && t.action.params.what === 'sms');
    await phone('/voice/phone-result', { id: job2.id, ok: true, data: { sms: [{ from: '+989120000000', body: 'سلام', date: T + 1 }, { from: '+989351112233', name: 'مریم', body: 'رسیدی؟', date: T + 2 }, { from: 'Reza', body: 'فردا ساعت ۱۰ جلسه داریم', date: T }, { from: 'Bank', body: 'کد ورود: 4821', date: T - 5000 }] } });
    const nb = await call('/notices');
    const smsN = nb.notices.filter(n => n.kind === 'sms');
    assert.equal(smsN.length, 3, 'only the new SMS');
    const titles = smsN.map(n => n.title.replace(/[⁨⁩]/g, ''));
    assert.ok(titles.includes('پیامک از Reza') && titles.includes('پیامک از مریم') && titles.includes('پیامک تازه دارید'), titles.join(' | '));
    assert.ok(!titles.some(t => /\d{6}/.test(t)), 'numbers are never announced');
    const ct = (await phone('/voice/phone-tasks')).tasks.find(t => t.action.params && t.action.params.what === 'contacts');
    if (ct) await phone('/voice/phone-result', { id: ct.id, ok: true, data: { contacts: [{ name: 'مریم', number: '+98 935 111 2233' }] } });
    const pd2 = await call('/voice/phone-data');
    assert.equal(pd2.threads.find(t => t.from === '+989351112233').name, 'مریم');
    assert.ok(nb.unread >= 1);
    // writing an SMS on the computer: it becomes a job for the phone (the phone asks the user before sending)
    const sent = await call('/voice/phone-sms', { to: 'Reza', text: 'باشه، میام' });
    assert.ok(sent.sentToPhone);
    const job3 = (await phone('/voice/phone-tasks')).tasks.find(t => t.id === sent.id);
    assert.deepEqual(job3.action, { type: 'phone_sms_send', params: { to: 'Reza', text: 'باشه، میام' } });
    await phone('/voice/phone-result', { id: sent.id, ok: true, say: 'فرستاده شد.' });
    assert.ok((await call('/notices')).notices.some(n => n.kind === 'phone' && /Reza/.test(n.title)));
    assert.equal((await call('/notices/read', { ids: 'all' })).unread, 0);
    // the phone cannot read the bell
    assert.match((await phone('/notices')).error || '', /در دسترس نیست/);
  } finally { child.kill(); }
});
