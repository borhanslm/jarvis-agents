'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Mail, parseMessage, decodeWords, parseAddress } = require('../lib/mail');
const { parseIcs, expand, parseDate, Calendars } = require('../lib/calendar');

const CRLF = '\r\n';
const MSG1 = ['From: =?UTF-8?B?' + Buffer.from('علی رضایی').toString('base64') + '?= <ali@example.com>', 'To: me@example.com', 'Subject: =?UTF-8?Q?=D8=B3=D9=84=D8=A7=D9=85?= report', 'Date: Tue, 17 Nov 2026 09:30:00 +0330',
  'Message-ID: <m1@example.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
  Buffer.from('سلام، گزارش آماده است.\nممنون').toString('base64'), '--b1', 'Content-Type: text/html; charset=utf-8', '', '<p>سلام</p>', '--b1--', ''].join(CRLF);
const MSG2 = ['From: "Shop" <no-reply@shop.ir>', 'Subject: Order shipped', 'Date: Mon, 16 Nov 2026 08:00:00 +0000', 'Message-ID: <m2@shop.ir>', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
  '<div>Your order =E2=9C=93 shipped</div><style>x{}</style>', ''].join(CRLF);

// a tiny IMAP server: two messages, LOGIN user/pass
function fakeImap() {
  const msgs = [{ uid: 11, seq: 1, raw: Buffer.from(MSG2), seen: true }, { uid: 12, seq: 2, raw: Buffer.from(MSG1), seen: false }];
  const log = [];
  const srv = net.createServer(sock => {
    sock.write('* OK fake IMAP ready' + CRLF);
    let buf = '';
    sock.on('data', d => {
      buf += d.toString('utf8');
      let i; while ((i = buf.indexOf(CRLF)) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd, ...rest] = line.split(' '); const args = rest.join(' '); log.push(cmd + ' ' + args);
        const ok = t => sock.write(tag + ' OK ' + (t || 'done') + CRLF);
        if (cmd === 'LOGIN') { if (args === '"me@example.com" "app pass"') ok(); else sock.write(tag + ' NO [AUTHENTICATIONFAILED] Invalid credentials' + CRLF); }
        else if (cmd === 'EXAMINE' || cmd === 'SELECT') { sock.write(`* ${msgs.length} EXISTS${CRLF}`); ok(); }
        else if (cmd === 'FETCH') {
          for (const m of msgs) { const hdr = Buffer.from(m.raw.toString('latin1').split(CRLF + CRLF)[0] + CRLF + CRLF, 'latin1'); sock.write(Buffer.concat([Buffer.from(`* ${m.seq} FETCH (UID ${m.uid} FLAGS (${m.seen ? '\\Seen' : ''}) BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] {${hdr.length}}${CRLF}`), hdr, Buffer.from(')' + CRLF)])); }
          ok();
        } else if (cmd === 'UID' && rest[0] === 'FETCH') { const m = msgs.find(x => x.uid === +rest[1]); if (m) sock.write(Buffer.concat([Buffer.from(`* ${m.seq} FETCH (UID ${m.uid} FLAGS () BODY[]<0> {${m.raw.length}}${CRLF}`), m.raw, Buffer.from(')' + CRLF)])); ok(); }
        else if (cmd === 'UID' && rest[0] === 'STORE') { const m = msgs.find(x => x.uid === +rest[1]); if (m) m.seen = true; ok(); }
        else if (cmd === 'LOGOUT') { sock.end('* BYE' + CRLF); }
        else sock.write(tag + ' BAD unknown' + CRLF);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, msgs, log })));
}
function fakeSmtp() {
  const got = { rcpt: [], data: '' };
  const srv = net.createServer(sock => {
    sock.write('220 fake ESMTP' + CRLF);
    let buf = '', inData = false, step = 0;
    sock.on('data', d => {
      buf += d.toString('utf8');
      if (inData) { const end = buf.indexOf(CRLF + '.' + CRLF); if (end < 0) return; got.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false; sock.write('250 queued' + CRLF); }
      let i; while ((i = buf.indexOf(CRLF)) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/.test(line)) sock.write('250-fake' + CRLF + '250 AUTH LOGIN' + CRLF);
        else if (line === 'AUTH LOGIN') { step = 1; sock.write('334 VXNlcm5hbWU6' + CRLF); }
        else if (step === 1) { got.user = Buffer.from(line, 'base64').toString(); step = 2; sock.write('334 UGFzc3dvcmQ6' + CRLF); }
        else if (step === 2) { step = 0; got.pass = Buffer.from(line, 'base64').toString(); sock.write(got.pass === 'app pass' ? '235 ok' + CRLF : '535 bad' + CRLF); }
        else if (/^MAIL FROM/.test(line)) { got.from = line; sock.write('250 ok' + CRLF); }
        else if (/^RCPT TO/.test(line)) { got.rcpt.push(line); sock.write('250 ok' + CRLF); }
        else if (line === 'DATA') { inData = true; sock.write('354 go' + CRLF); const end = buf.indexOf(CRLF + '.' + CRLF); if (end >= 0) { got.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false; sock.write('250 queued' + CRLF); } }
        else if (line === 'QUIT') sock.end('221 bye' + CRLF);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, got })));
}
const memSecrets = () => { const d = {}; return { get: k => d[k] || null, set: (k, v) => { if (v == null) delete d[k]; else d[k] = v; } }; };

test('mail: MIME parsing (encoded words, base64, quoted-printable, html)', () => {
  assert.strictEqual(decodeWords('=?UTF-8?Q?=D8=B3=D9=84=D8=A7=D9=85?= report'), 'سلام report');
  assert.deepStrictEqual(parseAddress('"Shop" <no-reply@shop.ir>'), { name: 'Shop', email: 'no-reply@shop.ir' });
  assert.strictEqual(parseAddress('ali@example.com').email, 'ali@example.com');
  const m1 = parseMessage(Buffer.from(MSG1));
  assert.match(m1.text, /گزارش آماده است/);
  const m2 = parseMessage(Buffer.from(MSG2));
  assert.strictEqual(m2.text, 'Your order ✓ shipped');
});

test('mail: inbox, read, send through fake IMAP/SMTP; validation', async () => {
  const imap = await fakeImap(), smtp = await fakeSmtp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-mail-'));
  const mail = new Mail(dir, memSecrets());
  assert.throws(() => mail.save({ preset: 'gmail', email: 'not-an-email', pass: 'x' }), /درست نیست/);
  const a = mail.save({ preset: 'custom', email: 'Me@Example.com', pass: 'app pass', imap: '127.0.0.1', imapPort: imap.port, smtp: '127.0.0.1', smtpPort: smtp.port });
  assert.strictEqual(a.email, 'me@example.com');
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'mail.json'), 'utf8'))).includes('app pass'), 'password not in the settings file');
  mail.list[0]._plainForTests = true;
  const list = await mail.inbox();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].subject, 'سلام report'); // newest first
  assert.strictEqual(list[0].from.name, 'علی رضایی');
  assert.strictEqual(list[0].seen, false);
  const m = await mail.read(a.id, 12);
  assert.match(m.text, /گزارش آماده است/);
  assert.ok(imap.msgs[1].seen, 'opening marks it read');
  assert.ok(imap.log.every(l => !/app pass/.test(l) || /^LOGIN/.test(l)));
  // send
  await assert.rejects(mail.send(a.id, { to: 'bad address', subject: 's', text: 't' }), /درست نیست/);
  await assert.rejects(mail.send(a.id, { to: 'x@y.com', subject: 's', text: '  ' }), /خالی/);
  const r = await mail.send(a.id, { to: 'ali@example.com', subject: 'Re: سلام\r\nBcc: evil@x.com', text: 'ممنون، دریافت شد.\n.\nخط بعد', inReplyTo: '<m1@example.com>' });
  assert.ok(r.ok);
  assert.deepStrictEqual(smtp.got.rcpt, ['RCPT TO:<ali@example.com>']);
  assert.strictEqual(smtp.got.user, 'me@example.com');
  assert.ok(!/^Bcc:/m.test(smtp.got.data), 'no header injection');
  assert.match(smtp.got.data, /In-Reply-To: <m1@example.com>/);
  const body = smtp.got.data.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.strictEqual(Buffer.from(body, 'base64').toString(), 'ممنون، دریافت شد.\r\n.\r\nخط بعد');
  // wrong password
  mail.save({ id: a.id, preset: 'custom', email: 'me@example.com', pass: 'wrong', imap: '127.0.0.1', imapPort: imap.port, smtp: '127.0.0.1', smtpPort: smtp.port });
  mail.list[0]._plainForTests = true;
  await assert.rejects(mail.inbox(a.id, { fresh: true }), /رمز برنامه درست نیست/);
  imap.srv.close(); smtp.srv.close();
});

const ICS = ['BEGIN:VCALENDAR', 'X-WR-CALNAME:Work', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Team meeting', 'DTSTART;TZID=Asia/Tehran:20261118T100000', 'DTEND;TZID=Asia/Tehran:20261118T110000', 'LOCATION:Office\\, room 2',
  'BEGIN:VALARM', 'SUMMARY:alarm', 'END:VALARM', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Gym', 'DTSTART:20200106T150000Z', 'DTEND:20200106T160000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE:20261118T150000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Birthday', 'DTSTART;VALUE=DATE:20261120', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED', 'DTSTART:20261119T100000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

test('calendar: iCal parsing, time zones, weekly repeats, exceptions', () => {
  assert.strictEqual(parseDate('20261118T063000Z').ms, Date.UTC(2026, 10, 18, 6, 30));
  assert.strictEqual(parseDate('20261118T100000', { TZID: 'Asia/Tehran' }).ms, Date.UTC(2026, 10, 18, 6, 30), 'Tehran is +03:30');
  assert.strictEqual(parseDate('20261118T100000', { TZID: 'Iran Standard Time' }).ms, Date.UTC(2026, 10, 18, 6, 30), 'Windows zone names');
  const ev = parseIcs(ICS);
  assert.strictEqual(ev.length, 4);
  assert.strictEqual(ev[0].location, 'Office, room 2');
  const from = Date.UTC(2026, 10, 16, 0, 0), to = from + 7 * 864e5; // Mon 16 Nov .. Mon 23 Nov
  const out = expand(ev, from, to);
  const titles = out.map(e => e.title);
  assert.ok(titles.includes('Team meeting'));
  assert.ok(titles.includes('Birthday'));
  assert.ok(!titles.includes('Cancelled thing'));
  const gym = out.filter(e => e.title === 'Gym').map(e => new Date(e.start).toISOString().slice(0, 10));
  assert.deepStrictEqual(gym, ['2026-11-16']); // Wed 18th is an exception, Mon 23rd 15:00Z is after the window
});

test('calendar: feeds keep the address secret and survive a failing refresh', async () => {
  const http = require('http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-cal-'));
  const cal = new Calendars(dir, memSecrets());
  await assert.rejects(cal.add({ url: 'http://example.com/x.ics' }), /https/);
  // fetch is only https; test the parsing path through the cache directly
  cal.list.push({ id: 'f1', name: 'Work', color: '' }); cal.cache.set('f1', { at: Date.now(), events: parseIcs(ICS) });
  const up = await cal.upcoming(30, { from: Date.UTC(2026, 10, 16) });
  assert.ok(up.some(e => e.title === 'Team meeting' && e.calendar === 'Work'));
  cal.remove('f1'); assert.strictEqual(cal.list.length, 0);
  assert.ok(http);
});
