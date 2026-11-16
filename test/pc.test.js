// Computer control for the voice assistant (lib/pc.js) and the brain's new actions — nothing is launched here.
const test = require('node:test');
const assert = require('node:assert');
const pc = require('../lib/pc');
const { parseReply, ACTIONS } = require('../lib/voice/brain');

const APPS = [
  { Name: 'Google Chrome', AppID: 'Chrome' }, { Name: 'Google Chrome Canary', AppID: 'ChromeCanary' }, { Name: 'Uninstall Google Chrome', AppID: 'x' },
  { Name: 'Notepad', AppID: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }, { Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  { Name: 'Word', AppID: 'Microsoft.Office.WINWORD.EXE.15' }, { Name: 'Visual Studio Code', AppID: 'Microsoft.VisualStudioCode' }, { Name: 'Telegram Desktop', AppID: 'Telegram' },
];

test('programs: Persian and English names find the Start menu entry', () => {
  const m = n => (pc.matchApp(APPS, n) || {}).Name || null;
  assert.equal(m('Google Chrome'), 'Google Chrome');
  assert.equal(m('کروم'), 'Google Chrome', 'shortest name wins over Canary; never the uninstaller');
  assert.equal(m('نوت پد'), 'Notepad');
  assert.equal(m('ماشین حساب'), 'Calculator');
  assert.equal(m('ورد'), 'Word');
  assert.equal(m('vs code'), 'Visual Studio Code');
  assert.equal(m('تلگرام'), 'Telegram Desktop');
  assert.equal(m('برنامه کروم را'), 'Google Chrome');
  assert.equal(m('xyzzy'), null);
});

test('websites: names and addresses become https links; other schemes are refused', () => {
  assert.equal(pc.siteUrl('یوتیوب'), 'https://www.youtube.com');
  assert.equal(pc.siteUrl('digikala.com'), 'https://digikala.com/');
  assert.equal(pc.siteUrl('http://example.com/a'), 'https://example.com/a');
  assert.throws(() => pc.siteUrl('javascript:alert(1)'));
  assert.throws(() => pc.siteUrl('file:///C:/Windows'));
});

test('folders: only known folders or existing absolute paths', () => {
  assert.throws(() => pc.folderPath('../../etc'));
  assert.throws(() => pc.folderPath('C:\\no\\such\\folder'));
});

test('brain: phone actions only for requests from the phone', () => {
  const reply = '{"say":"باشه","action":{"type":"phone_sms","params":{"code":true}}}';
  assert.equal(parseReply(reply).action, null, 'from the computer: no phone actions');
  assert.equal(parseReply(reply, { phone: true }).action.type, 'phone_sms');
  const { PHONE_ACTIONS } = require('../lib/voice/brain');
  assert.ok(PHONE_ACTIONS.phone_do && PHONE_ACTIONS.phone_sms_send && PHONE_ACTIONS.phone_call);
});

test('brain: computer actions are understood; shut down needs a yes, lock does not', () => {
  const r = parseReply('{"say":"باشه","action":{"type":"open_app","params":{"name":"Google Chrome"}}}');
  assert.equal(r.action.type, 'open_app');
  const c = ACTIONS.power.confirm;
  assert.equal(c({ action: 'shutdown' }), true); assert.equal(c({ action: 'restart' }), true); assert.equal(c({ action: 'sleep' }), true);
  assert.equal(c({ action: 'lock' }), false); assert.equal(c({ action: 'cancel' }), false);
  assert.equal(ACTIONS.close_app.confirm, true); assert.equal(ACTIONS.open_app.confirm, false);
});
