'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Usage } = require('../lib/usage');
const { Orchestrator } = require('../lib/orchestrator');

test('budgets: month spend per project and agent; a run stops at the project budget; an agent skips when its budget is used', async () => {
  const u = new Usage(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-use-')));
  u.log({ agent: 'claude', costUsd: 3, projectId: 'p1' });
  u.log({ agent: 'codex', costUsd: 2, projectId: 'p1', sub: 'security' });
  u.log({ agent: 'claude', costUsd: 1, projectId: 'p2' });
  u.rows.push({ ts: Date.now() - 40 * 864e5, costUsd: 99, projectId: 'p1' }); // an older month
  assert.strictEqual(u.monthCost({ projectId: 'p1' }), 5);
  assert.strictEqual(u.monthCost({ sub: 'security' }), 2);
  assert.strictEqual(u.monthCost(), 6);
  const o = Object.create(Orchestrator.prototype);
  // the run cap and the month's remainder: the smaller wins
  assert.strictEqual(o.budgetLeft({ s: { maxRunCostUsd: 5 }, runCost: 1, projectLeft: 2 }), 1);
  assert.strictEqual(o.budgetLeft({ s: { maxRunCostUsd: 0 }, runCost: 0 }), Infinity);
  // refusing a run when the month is used up
  const posts = [], said = []; let status = '';
  Object.assign(o, { usage: u, running: new Map(), post: (c, m) => posts.push(m), setStatus: (c, s) => { status = s; }, store: { settings: () => ({ projectBudgetUsd: 5 }), saveChat() {} }, onBudget: b => said.push(b), authMethod: null });
  const chat = { id: 'c1', cost: { codexTokens: 0 }, models: {} };
  await o.run(chat, { id: 'p1', name: 'Shop', path: os.tmpdir() }, 'build it', 'team');
  assert.strictEqual(status, 'budget'); assert.match(posts[1].text, /بودجه‌ی ماهانه/); assert.strictEqual(said[0].name, 'Shop');
  assert.strictEqual(o.running.size, 0);
  // an agent over its own budget does not review
  const r = await o.oneReview(chat, { s: {} }, { prompt: 'x', round: 1, engine: 'codex', sub: { id: 'security', name: 'security', icon: 'shield', budgetMonthUsd: 2 } });
  assert.deepStrictEqual(r, { review: null }); assert.match(posts[posts.length - 1].text, /بودجه‌ی ماهانه‌ی shield security/);
});
