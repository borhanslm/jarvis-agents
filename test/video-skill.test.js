'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vs = require('../lib/video-skill');

test('video skill: frames go to the model in time order, the answer becomes a safe skill', () => {
  const c = vs.content({ frames: [{ t: 3, data: 'AAA' }, { t: 75, data: 'BBB' }], transcript: 'اول دیجی‌کالا را باز کن بعد هدفون را سرچ کن', note: 'خرید از دیجی‌کالا', target: 'computer' });
  assert.match(c[0].text, /دیجی‌کالا/); assert.match(c[0].text, /Windows computer/);
  assert.deepStrictEqual(c.slice(1).map(p => p.type === 'text' ? p.text : p.data), ['Frame 1 at 0:03:', 'AAA', 'Frame 2 at 1:15:', 'BBB']);
  const s = vs.toSkill('```json\n' + JSON.stringify({ name: 'Digikala Buy!', description: 'خرید یک کالا از دیجی‌کالا', when: 'از دیجی‌کالا بخر', target: 'computer', app: 'digikala.com', inputs: ['نام کالا'], steps: ['Open digikala.com in the browser', 'Search the product', 'Add the first matching item to the cart', 'Go to the cart and continue to payment'], stopsForUser: ['The payment page: the user approves and pays'] }) + '\n```', 'computer');
  assert.strictEqual(s.name, 'digikala-buy');
  assert.match(s.body, /## Where\nThis Windows computer \(pc_do\) — digikala\.com/);
  assert.match(s.body, /## Inputs[^\n]*\n- نام کالا/);
  assert.match(s.body, /1\. Open digikala\.com/);
  assert.match(s.body, /STOP before paying/);
  assert.match(s.body, /Never type passwords, card numbers/);
  assert.throws(() => vs.toSkill('nothing'), /قدمی/);
  assert.throws(() => vs.toSkill('{"name":"x","steps":[]}'), /قدمی/);
  assert.match(vs.toSkill('{"steps":["a"],"target":"phone"}').body, /phone_do/);
});
