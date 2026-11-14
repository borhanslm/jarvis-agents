'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseReview, mergeReviews, bashRules, Orchestrator } = require('../lib/orchestrator');

function fakeOrch() {
  const events = [];
  const store = { saveChat() {}, chatSummary: c => ({ id: c.id, status: c.status }), settings: () => ({}), subagent: () => null };
  const o = new Orchestrator({ store, broadcast: e => events.push(e) });
  const chat = { id: 'c1', title: 't', status: 'idle', messages: [], cost: { claudeUsd: 0, codexTokens: 0 }, touchedFiles: [] };
  return { o, chat, events };
}

test('queue: enqueue only while running; drain delivers once', () => {
  const { o, chat } = fakeOrch();
  assert.equal(o.enqueue(chat, 'x'), null); // not running
  const run = { kills: new Set(), cancelled: false, inbox: [] };
  o.running.set(chat.id, run);
  const m1 = o.enqueue(chat, 'add dark mode');
  o.enqueue(chat, 'and a footer');
  assert.ok(m1.queued);
  assert.equal(run.inbox.length, 2);
  assert.equal(o.drainInbox(chat, { run }), 'add dark mode\n\nand a footer');
  assert.equal(run.inbox.length, 0);
  assert.deepEqual(chat.messages.at(-1).ids.length, 2);
  assert.equal(o.drainInbox(chat, { run }), '');
});

test('queue: messages left after the flow start a follow-up round', async () => {
  const { o, chat, events } = fakeOrch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-q-'));
  const calls = [];
  o.dispatch = async (c, ctx, text) => {
    calls.push(text);
    if (calls.length === 1) o.enqueue(c, 'later instruction');
    return 'done';
  };
  await o.run(chat, { path: dir }, 'first task', 'team');
  assert.deepEqual(calls, ['first task', 'later instruction']);
  assert.equal(chat.status, 'done');
  assert.equal(o.isRunning(chat.id), false);
  assert.ok(events.some(e => e.type === 'finished'));
});

test('queue: stop reports undelivered messages instead of dropping silently', async () => {
  const { o, chat } = fakeOrch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-q-'));
  o.dispatch = async c => { o.enqueue(c, 'never runs'); o.stop(c.id); return 'stopped'; };
  await o.run(chat, { path: dir }, 'task', 'team');
  assert.equal(chat.status, 'stopped');
  assert.ok(chat.messages.some(m => /در صف اجرا نشد/.test(m.text || '')));
});
const { Store } = require('../lib/store');

const rv = (verdict, sev) => ({ verdict, summary: verdict, tests_run: [], bugs: sev ? [{ severity: sev, title: 't', file: null, line: null, description: 'd', fix_hint: '' }] : [] });

test('mergeReviews: main fail blocks, specialist minor-only fail does not', () => {
  assert.equal(mergeReviews([{ main: true, by: 'main', review: rv('pass') }, { by: 'security', review: rv('fail', 'minor') }]).verdict, 'pass');
  assert.equal(mergeReviews([{ main: true, by: 'main', review: rv('pass') }, { by: 'security', review: rv('fail', 'major') }]).verdict, 'fail');
  assert.equal(mergeReviews([{ main: true, by: 'main', review: rv('fail') }]).verdict, 'fail');
  const m = mergeReviews([{ main: true, by: 'main', review: rv('fail', 'critical') }, { by: 'perf', review: rv('fail', 'major') }]);
  assert.equal(m.bugs.length, 2);
  assert.equal(m.bugs[0].by, undefined);
  assert.equal(m.bugs[1].by, 'perf');
  assert.equal(mergeReviews([{ main: true, review: null }]), null);
});

test('bashRules builds exact + prefix rules and drops unsafe entries', () => {
  const r = bashRules(['npm test', '  ', 'evil) Edit(']);
  assert.deepEqual(r.filter(x => x.startsWith('Bash')), ['Bash(npm test)', 'Bash(npm test *)']);
  assert.ok(r.every(x => x.includes('npm test')));
  if (process.platform === 'win32') assert.ok(r.includes('PowerShell(npm test *)'));
});

test('store sub-agents: validate, save, look up by name, builder forces claude', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-store-'));
  const s = new Store(dir);
  assert.ok(s.subagents().length >= 3);
  assert.throws(() => s.saveSubagent({ name: '!!!', prompt: 'x' }));
  assert.throws(() => s.saveSubagent({ name: 'x', prompt: '' }));
  const a = s.saveSubagent({ name: 'DB Expert', prompt: 'check db', stage: 'builder', engine: 'codex' });
  assert.equal(a.name, 'db-expert');
  assert.equal(a.engine, 'claude');
  assert.equal(s.subagent('db-expert').id, a.id);
  assert.throws(() => s.saveSubagent({ name: 'db-expert', prompt: 'dup' }));
  s.deleteSubagent(a.id);
  assert.equal(s.subagent('db-expert'), undefined);
  assert.equal(new Store(dir).subagents().length, s.subagents().length); // persisted
});
const git = require('../lib/git');

test('parseReview reads fenced JSON', () => {
  const r = parseReview('blah\n```json\n{"verdict":"fail","summary":"x","tests_run":[],"bugs":[{"severity":"major","title":"t","file":null,"line":null,"description":"d","fix_hint":"h"}]}\n```');
  assert.equal(r.verdict, 'fail');
  assert.equal(r.bugs.length, 1);
});

test('parseReview reads bare JSON and rejects garbage', () => {
  assert.equal(parseReview('{"verdict":"pass","summary":"ok"}').verdict, 'pass');
  assert.equal(parseReview('no json here'), null);
  assert.equal(parseReview(''), null);
});

test('git checkpoint + restore round-trip without touching index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  const cp = await git.checkpoint(dir);
  assert.match(cp, /^[0-9a-f]{40}$/);
  assert.equal(g('status', '--porcelain').trim(), '?? a.txt'); // index untouched
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new');
  const r = await git.restore(dir, cp);
  assert.ok(r.ok, r.err);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1');
  assert.deepEqual(r.newerFiles, ['b.txt']);
  assert.equal((await git.restore(dir, 'not-a-hash; rm -rf')).ok, false);
});

// ---------------- v3: settings, git, budget, lock, guard ----------------
function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-g3-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  g('add', '-A'); g('commit', '-qm', 'init');
  return { dir, g };
}

test('settings: type coercion, per-project override and reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-set-'));
  const s = new Store(dir);
  s.updateSettings({ maxRunCostUsd: '2.5', leanMode: 0, builderModel: 'haiku', bogus: 1, maxRounds: -3 });
  assert.equal(s.settings().maxRunCostUsd, 2.5);
  assert.equal(s.settings().leanMode, false);
  assert.equal(s.settings().builderModel, 'haiku');
  assert.equal(s.settings().bogus, undefined);
  assert.notEqual(s.settings().maxRounds, -3);
  const p = s.addProject({ path: dir });
  s.updateProjectSettings(p.id, { maxRounds: 7, requireToken: true });
  assert.equal(s.settings(p.id).maxRounds, 7);
  assert.equal(s.settings(p.id).builderModel, 'haiku');      // inherited
  assert.equal(s.settings(p.id).requireToken, false);         // server-wide only
  assert.equal(s.settings().maxRounds, 3);                    // global untouched
  s.updateProjectSettings(p.id, null);
  assert.equal(s.settings(p.id).maxRounds, 3);
});

test('settings: v1 claudeModel migrates to builderModel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mig-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ claudeModel: 'opus' }));
  const s = new Store(dir);
  assert.equal(s.settings().builderModel, 'claude-opus-5-5');
  assert.equal(s.settings().claudeModel, undefined);
});

test('git: diffSince shows only this run, not earlier uncommitted work', async () => {
  const { dir } = gitRepo();
  fs.writeFileSync(path.join(dir, 'old.txt'), 'earlier uncommitted work');
  const cp = await git.checkpoint(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'created in run');
  const d = await git.diffSince(dir, cp, 10000);
  assert.deepEqual(d.files.sort(), ['a.txt', 'new.txt']);
  assert.match(d.text, /\+v2/);
  const cut = await git.diffSince(dir, cp, 20);
  assert.match(cut.text, /truncated/);
});

test('git: restore leaves the index alone and can delete newer files', async () => {
  const { dir, g } = gitRepo();
  fs.writeFileSync(path.join(dir, 'staged.txt'), 's');
  g('add', 'staged.txt');
  const cp = await git.checkpoint(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(dir, 'later.txt'), 'x');
  const r = await git.restore(dir, cp, { deleteNewer: true });
  assert.ok(r.ok, r.err);
  assert.deepEqual(r.deletedFiles, ['later.txt']);
  assert.equal(fs.existsSync(path.join(dir, 'later.txt')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1');
  assert.match(g('diff', '--cached', '--name-only'), /staged\.txt/); // still staged
});

test('git: branch per chat + commitAll', async () => {
  const { dir, g } = gitRepo();
  assert.equal((await git.useBranch(dir, 'jarvis/x-1')).created, true);
  assert.equal(await git.currentBranch(dir), 'jarvis/x-1');
  assert.equal((await git.useBranch(dir, 'bad..name')).ok, false);
  assert.equal((await git.useBranch(dir, '-f')).ok, false); // would be parsed as an option
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const c = await git.commitAll(dir, 'jarvis: test');
  assert.ok(c.ok && c.hash, c.err);
  assert.match(g('log', '-1', '--format=%s'), /jarvis: test/);
  assert.equal((await git.commitAll(dir, 'nothing')).nothing, true);
});

test('budget: claudeStep refuses to start once the cap is used up', async () => {
  const { o, chat } = fakeOrch();
  const ctx = { cwd: '.', run: { kills: new Set(), inbox: [] }, s: { maxRunCostUsd: 1 }, runCost: 1 };
  const r = await o.claudeStep(chat, ctx, { prompt: 'x', phase: 'p' });
  assert.equal(r.budgetHit, true);
  assert.equal(ctx.budgetHit, true);
  assert.equal(chat.messages.length, 0); // nothing was started
  assert.equal(o.budgetLeft({ s: { maxRunCostUsd: 0 }, runCost: 99 }), Infinity);
});

test('project lock: two chats on one project run one after the other', async () => {
  const events = [];
  const chats = {};
  const store = { saveChat() {}, chatSummary: c => ({ id: c.id }), settings: () => ({ projectLock: true }), subagent: () => null, chat: id => chats[id] };
  const o = new Orchestrator({ store, broadcast: () => {} });
  const mk = id => (chats[id] = { id, title: id, status: 'idle', messages: [], cost: { claudeUsd: 0, codexTokens: 0 }, touchedFiles: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lock-'));
  o.dispatch = async c => { events.push('start ' + c.id); await new Promise(r => setTimeout(r, 300)); events.push('end ' + c.id); return 'done'; };
  const proj = { id: 'p1', path: dir };
  await Promise.all([o.run(mk('A'), proj, 'a', 'team'), new Promise(r => setTimeout(r, 50)).then(() => o.run(mk('B'), proj, 'b', 'team'))]);
  assert.deepEqual(events, ['start A', 'end A', 'start B', 'end B']);
  assert.ok(chats.B.messages.some(m => /روی همین پروژه در حال اجراست/.test(m.text || '')));
});

test('guard: tester edits are reverted when guardReviewerEdits=revert', async () => {
  const { dir } = gitRepo();
  const { o, chat } = fakeOrch();
  const before = await git.snapshot(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'tester changed this');
  fs.writeFileSync(path.join(dir, 'junk.txt'), 'tester junk');
  await o.guardEdits(chat, { cwd: dir, s: { guardReviewerEdits: 'revert' } }, before);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1');
  assert.equal(fs.existsSync(path.join(dir, 'junk.txt')), false);
  assert.match(chat.messages.at(-1).text, /برگردانده شدند/);
});

// ---------------- usage log + graphify ----------------
const { Usage } = require('../lib/usage');
const graphLib = require('../lib/graph');

test('usage: per-model and per-day aggregation, survives reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-usage-'));
  const u = new Usage(dir);
  u.log({ agent: 'claude', model: 'claude-sonnet-5-5', role: 'builder', projectId: 'p1', input: 10, output: 5, cacheRead: 100, cacheWrite: 20, costUsd: 0.01 });
  u.log({ agent: 'claude', model: 'claude-sonnet-5-5', role: 'reviewer', projectId: 'p2', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.002 });
  u.log({ agent: 'codex', model: 'gpt-6-astra', role: 'reviewer', projectId: 'p1', input: 50, output: 10, cacheRead: 40 });
  const s = u.summary({ days: 7 });
  assert.equal(s.models.length, 2);
  assert.equal(s.models[0].model, 'claude-sonnet-5-5');       // biggest first
  assert.equal(s.models[0].tokens, 137);
  assert.equal(s.days.length, 7);
  assert.equal(Object.keys(s.models[0].days).length, 1);
  assert.ok(Math.abs(s.totals.costUsd - 0.012) < 1e-9);
  assert.equal(u.summary({ days: 7, projectId: 'p2' }).models[0].tokens, 2);
  return new Promise(r => setTimeout(r, 200)).then(() => assert.equal(new Usage(dir).rows.length, 3));
});

test('graphify: builds a local graph and produces the agent prompt block', { skip: !graphLib.graphifyBin() && 'graphify not installed' }, async () => {
  const { dir } = gitRepo();
  fs.writeFileSync(path.join(dir, 'math.js'), 'function add(a,b){return a+b}\nfunction twice(x){return add(x,x)}\nmodule.exports={add,twice}\n');
  const u = await graphLib.update(dir);
  assert.ok(u.ok, u.error);
  assert.ok(u.nodes > 0);
  const block = await graphLib.promptBlock(dir, 900);
  assert.match(block, /graphify query/);
  assert.match(block, /--budget 900/);
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /\/graphify-out\//); // kept out of git status
  const v = graphLib.viewData(dir, 50);
  assert.ok(v.nodes.length > 0 && v.nodes.every(n => n.id && n.label));
});

// ---------------- sub-agent skills ----------------
const { Skills, parseSkillMd, INLINE_MAX } = require('../lib/skills');

test('skills: create, inline vs on-demand delivery, import, delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skills-'));
  const sk = new Skills(dir);
  assert.throws(() => sk.save({ name: '!!', description: 'd', content: 'x' }));
  assert.throws(() => sk.save({ name: 'ok', description: '', content: 'x' }));
  const small = sk.save({ name: 'OWASP Checklist', description: 'Use for web security reviews.', content: '1. Check SQL injection\n2. Check XSS' });
  assert.equal(small.name, 'owasp-checklist');
  assert.equal(parseSkillMd(fs.readFileSync(sk.skillFile(small.id), 'utf8')).name, 'owasp-checklist');
  const big = sk.save({ name: 'big-guide', description: 'Long guide.', content: 'x'.repeat(INLINE_MAX + 500) });
  const out = sk.forAgent([small.id, big.id, 'missing']);
  assert.deepEqual(out.names, ['owasp-checklist', 'big-guide']);
  assert.match(out.block, /Check SQL injection/);                 // small: inlined
  assert.doesNotMatch(out.block, /x{200}/);                         // big: not inlined
  assert.match(out.block, /big-guide[\s\S]*SKILL\.md/);            // big: path given
  assert.equal(out.dirs.length, 2);
  // import an installed-style skill folder (with a helper file, skipping dotfiles)
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-src-skill-'));
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: pdf-tools\ndescription: "Work with PDFs"\n---\nUse scripts/x.py');
  fs.mkdirSync(path.join(src, 'scripts')); fs.writeFileSync(path.join(src, 'scripts', 'x.py'), 'print(1)');
  fs.writeFileSync(path.join(src, '.secret'), 'no');
  const imp = sk.importDir(src);
  assert.equal(imp.name, 'pdf-tools');
  assert.ok(fs.existsSync(path.join(sk.skillDir(imp.id), 'scripts', 'x.py')));
  assert.equal(fs.existsSync(path.join(sk.skillDir(imp.id), '.secret')), false);
  assert.equal(sk.importDir(src).id, imp.id);                      // idempotent
  assert.throws(() => sk.importDir(os.tmpdir()));                   // no SKILL.md
  assert.ok(sk.remove(big.id));
  assert.equal(new Skills(dir).all().length, 2);                    // persisted
});

test('skills reach builder sub-agents (--agents prompt + read access)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skills2-'));
  const sk = new Skills(dir);
  const s1 = sk.save({ name: 'test-style', description: 'House test style.', content: 'Always use node:test and describe blocks.' });
  const subs = [{ id: 't', name: 'test-writer', icon: '🧪', stage: 'builder', enabled: true, description: 'writes tests', prompt: 'You write tests.', skills: [s1.id] }];
  const o = new Orchestrator({ store: { subagents: () => subs }, broadcast: () => {}, skills: sk });
  const ba = o.builderAgentsFile();
  const def = JSON.parse(fs.readFileSync(ba.file, 'utf8'));
  assert.match(def['test-writer'].prompt, /You write tests\.[\s\S]*== Your skills ==[\s\S]*node:test and describe blocks/);
  assert.deepEqual(ba.dirs, [sk.skillDir(s1.id)]);
  fs.rmSync(ba.file, { force: true });
  // store keeps only valid skill ids on a sub-agent
  const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-st-')));
  const a = st.saveSubagent({ name: 'x', prompt: 'p', skills: [s1.id, s1.id, 'bad id!', ''] });
  assert.deepEqual(a.skills, [s1.id]);
});
