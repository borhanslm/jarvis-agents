// JARVIS learns from hearing mistakes: it guesses and asks, a "yes" teaches it, and next time the
// wrong word is fixed before the brain sees it (and given to the speech engine as a hint).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Lexicon } = require('../lib/voice/lexicon');
const { Brain } = require('../lib/voice/brain');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lex-'));
const ctx = async () => ({ now: 'x', projects: [{ name: 'فروشگاه' }], running: [], recent: [], tasks: [] });

test('lexicon: learn, fix whole words only, longest phrase first, hint, forget', () => {
  const d = dir(), l = new Lexicon(d);
  l.learn('کرم', 'کروم'); l.learn('گوگل کرم', 'گوگل کروم'); l.learn('جاروس', 'جارویس');
  assert.equal(l.apply('کرم را باز کن').text, 'کروم را باز کن');
  assert.equal(l.apply('گوگل کرم را باز کن').text, 'گوگل کروم را باز کن');
  assert.equal(l.apply('کرمانشاه').text, 'کرمانشاه', 'not inside another word');
  assert.deepEqual(l.apply('هی جاروس').fixed, [{ heard: 'جاروس', meant: 'جارویس' }]);
  assert.equal(l.learn('x', 'x'), null);
  l.learn('کرم', 'کروم'); assert.equal(l.all().find(c => c.heard === 'کرم').count, 2);
  assert.match(l.hint(['فروشگاه']), /کروم/); assert.match(l.hint(['فروشگاه']), /فروشگاه/);
  assert.equal(new Lexicon(d).all().length, 3, 'kept on disk');
  l.remove('کرم'); assert.equal(l.apply('کرم').text, 'کرم');
});

test('brain: unclear word -> asks; "yes" learns it and does the corrected request', async () => {
  const lexicon = new Lexicon(dir()), seen = [];
  const chat = async ({ system, messages }) => {
    const said = messages[messages.length - 1].content; seen.push({ said, system });
    if (said === 'کرم را باز کن') return { text: '{"say":"منظورتان «کروم» بود؟","action":null,"guess":{"heard":"کرم","meant":"کروم"}}' };
    if (said === 'کروم را باز کن') return { text: '{"say":"باشه، کروم را باز می‌کنم.","action":{"type":"open_app","params":{"name":"Google Chrome"}}}' };
    if (/گفتم تلگرام/.test(said)) return { text: '{"say":"باشه، تلگرام را باز می‌کنم.","action":{"type":"open_app","params":{"name":"Telegram"}},"learn":{"heard":"تلگراف","meant":"تلگرام"}}' };
    return { text: '{"say":"باشه.","action":null}' };
  };
  const b = new Brain({ chat, context: ctx, lexicon });
  const q = await b.handle('کرم را باز کن');
  assert.deepEqual(q.guess, { heard: 'کرم', meant: 'کروم' }); assert.equal(q.action, null);
  const r = await b.handle('آره');
  assert.equal(r.action.type, 'open_app'); assert.deepEqual(r.learned, { heard: 'کرم', meant: 'کروم' });
  assert.equal(seen[seen.length - 1].said, 'کروم را باز کن', 'the corrected sentence went to the brain');
  assert.match(seen[seen.length - 1].system, /Learned hearing corrections \(heard → meant\): کرم → کروم/);
  // "no": nothing is learned, it asks again
  await b.handle('کرم را باز کن');
  const n = await b.handle('نه');
  assert.match(n.say, /دوباره بگویید/); assert.equal(lexicon.all().length, 1);
  // a correction in the user's own words is learned too
  const c = await b.handle('نه، گفتم تلگرام');
  assert.deepEqual(c.learned, { heard: 'تلگراف', meant: 'تلگرام' });
  assert.equal(lexicon.apply('تلگراف را باز کن').text, 'تلگرام را باز کن');
});
