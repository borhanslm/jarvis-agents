'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Arena } = require('../lib/arena');

const fakeChat = async o => {
  const last = o.messages[o.messages.length - 1].content;
  if (o.spec === 'bad') throw new Error('no key');
  const text = /moderator/.test(o.system) ? `FINAL from ${o.spec}` : /other experts answered/.test(last) ? `${o.spec} improved after reading ${(last.match(/### Expert/g) || []).length} others` : `${o.spec} says hi`;
  o.onDelta && o.onDelta(text); return { text, usage: { input: 1, output: 2 } };
};

test('arena: compare side by side, a failing model does not stop the others, votes build a leaderboard', async () => {
  const ev = [];
  const a = new Arena(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-arena-')), { chat: fakeChat, onEvent: e => ev.push(e) });
  assert.throws(() => a.compare('q', ['one']), /دو مدل/);
  const r = a.compare('سلام؟', ['m1', 'm2', 'bad', 'm1']);
  const h = await r.done;
  assert.deepStrictEqual(h.results.map(x => [x.spec, x.ok]), [['m1', true], ['m2', true], ['bad', false]]);
  assert.ok(ev.some(e => e.delta === 'm2 says hi'));
  let v = a.vote(r.id, 'm2');
  assert.deepStrictEqual(v.board.map(b => [b.spec, b.wins, b.losses]), [['m2', 1, 0], ['m1', 0, 1], ['bad', 0, 1]]);
  assert.throws(() => a.vote(r.id, 'm1'), /قبلاً/);
  const again = new Arena(path.dirname(a.file), { chat: fakeChat });
  assert.strictEqual(again.view().board[0].spec, 'm2', 'kept on disk');
});

test('arena: debate — answers, then each reads the others, then the judge sums up', async () => {
  const a = new Arena(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-arena-')), { chat: fakeChat });
  const h = await a.debate('Next.js یا Laravel؟', ['m1', 'm2', 'm3'], { rounds: 2, judge: 'm3' }).done;
  assert.deepStrictEqual(h.log.map(x => [x.round, x.spec]), [[1, 'm1'], [1, 'm2'], [1, 'm3'], [2, 'm1'], [2, 'm2'], [2, 'm3']]);
  assert.strictEqual(h.log[3].text, 'm1 improved after reading 2 others');
  assert.strictEqual(h.final.text, 'FINAL from m3');
});
