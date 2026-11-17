// "Split between AIs": the planner cuts the job, parts run at the same time on different agents in
// their own copies of the project, the changes come back together, clashes are redone in the main folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { Orchestrator } = require('../lib/orchestrator');
const { parseSplit, overlaps } = require('../lib/split');
const git = require('../lib/git');

const ENGINES = [{ id: 'claude-opus-5-5', label: 'Claude Code · Opus' }, { id: 'codex', label: 'Codex' }];

test('split plan: parsed, unknown agents replaced, shared files detected', () => {
  const parts = parseSplit('here: [{"title":"API","engine":"codex","files":["api.js"],"prompt":"x"},{"title":"UI","engine":"gpt-9","files":["./ui.js","api.js"],"prompt":"y"},{"title":"bad"}]', ENGINES);
  assert.equal(parts.length, 2); assert.equal(parts[1].engine, 'claude-opus-5-5');
  assert.deepEqual([...overlaps(parts)].sort(), [0, 1]);
  assert.equal(parseSplit('no json', ENGINES), null);
});

test('split run: parts at the same time in separate copies, changes merged, a clash redone in the main folder', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-splitp-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'line\n'); g('add', '-A'); g('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'wip.txt'), 'uncommitted work\n'); // the copies must include it too

  const events = [];
  const store = { saveChat() {}, chatSummary: c => c, settings: () => ({ smartAutoApprove: true }), subagent: () => null };
  const o = new Orchestrator({ store, broadcast: e => events.push(e) });
  o.splitEngines = () => ENGINES;
  const chat = { id: 'sp1abc', title: 't', status: 'idle', messages: [], cost: { claudeUsd: 0, codexTokens: 0 }, touchedFiles: [] };
  o.claudeStep = async (c, ctx, a) => ({ ok: true, text: JSON.stringify([
    { title: 'سرور', engine: 'codex', files: ['server.js'], prompt: 'write server' },
    { title: 'ظاهر', engine: 'claude-opus-5-5', files: ['ui.js'], prompt: 'write ui' },
    { title: 'نسخه', engine: 'codex', files: ['shared.txt'], prompt: 'edit shared A' },
    { title: 'نسخه ۲', engine: 'claude-opus-5-5', files: ['shared.txt'], prompt: 'edit shared B' },
  ]) });
  let live = 0, maxLive = 0; const ran = [];
  o.builderStep = async (c, ctx, a) => {
    live++; maxLive = Math.max(maxLive, live);
    ran.push({ engine: a.modelOverride, cwd: ctx.cwd, prompt: a.prompt, session: a.sessionKey });
    assert.ok(fs.existsSync(path.join(ctx.cwd, 'wip.txt')), 'the copy has the uncommitted work');
    await new Promise(r => setTimeout(r, 150));
    if (/write server/.test(a.prompt)) fs.writeFileSync(path.join(ctx.cwd, 'server.js'), 'server\n');
    if (/write ui/.test(a.prompt)) fs.writeFileSync(path.join(ctx.cwd, 'ui.js'), 'ui\n');
    if (/edit shared A/.test(a.prompt)) fs.appendFileSync(path.join(ctx.cwd, 'shared.txt'), 'A\n');
    if (/edit shared B/.test(a.prompt)) fs.appendFileSync(path.join(ctx.cwd, 'shared.txt'), 'B\n');
    ctx.runCost += 0.1;
    live--; return { ok: true, text: 'done' };
  };
  let reviewed = false; o.teamFlow = async (c, ctx, task, audit, opts) => { reviewed = opts.prebuilt; return 'done'; };
  const ctx = { s: { smartAutoApprove: true }, cwd: dir, isGit: true, checkpoint: await git.checkpoint(dir), run: { cancelled: false, kills: new Set(), inbox: [] }, runCost: 0, rounds: 0 };
  const out = await o.splitFlow(chat, ctx, 'build an app');
  assert.equal(out, 'done'); assert.equal(reviewed, true, 'the tester checks the whole thing');
  assert.equal(maxLive, 2, 'the two independent parts ran at the same time');
  const together = ran.filter(r => /write (server|ui)/.test(r.prompt));
  assert.ok(together.every(r => r.cwd !== dir), 'in their own copies'); assert.notEqual(together[0].cwd, together[1].cwd);
  assert.deepEqual(new Set(together.map(r => r.engine)), new Set(['codex', 'claude-opus-5-5']));
  assert.ok(ran.filter(r => /edit shared/.test(r.prompt)).every(r => r.cwd === dir), 'the parts sharing a file ran in the main folder, one after another');
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'); // Windows git may write CRLF
  assert.equal(read('server.js'), 'server\n');
  assert.equal(read('ui.js'), 'ui\n');
  assert.equal(read('shared.txt'), 'line\nA\nB\n');
  assert.ok(Math.abs(ctx.runCost - 0.4) < 1e-9, 'every part\'s cost counts for the run');
  assert.equal(g('worktree', 'list').trim().split('\n').length, 1, 'the copies were removed');
  const card = chat.messages.find(m => m.kind === 'smartplan');
  assert.ok(card.split); assert.equal(card.plan[0].levelFa, 'هم‌زمان'); assert.match(card.plan[2].levelFa, /بعد از بقیه/);
});
