'use strict';
// Project tests gate, fallbacks, connection costs, summary & memory modes, phone notify.
// Agent CLIs are replaced with fakes before the orchestrator loads them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const agents = require('../lib/agents');
const calls = [];
let claudeImpl = () => ({ ok: true, text: 'done', costUsd: 0, editedFiles: [] });
let codexImpl = () => ({ ok: true, text: '{"verdict":"pass","summary":"ok","bugs":[],"tests_run":[]}', threadId: 't', usage: null });
agents.runClaude = opts => { calls.push({ who: 'claude', model: opts.model, prompt: opts.prompt, session: opts.sessionId }); return { promise: Promise.resolve(claudeImpl(opts)), kill() {} }; };
agents.runCodex = opts => { calls.push({ who: 'codex', model: opts.model, prompt: opts.prompt }); return { promise: Promise.resolve(codexImpl(opts)), kill() {} }; };
const { Orchestrator } = require('../lib/orchestrator');
const { Store } = require('../lib/store');
const testrun = require('../lib/testrun');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
function setup(settings = {}) {
  const store = new Store(tmp('jarvis-ft-'));
  const o = new Orchestrator({ store, broadcast() {} });
  const chat = store.newChat('p1', 't');
  const cwd = tmp('jarvis-ft-proj-');
  const ctx = { s: { ...store.settings(), ...settings }, run: { cancelled: false, kills: new Set(), inbox: [] }, runCost: 0, cwd, projectId: 'p1', isGit: false };
  return { o, chat, ctx, cwd, store };
}

test('test command: detection and running', async () => {
  const d = tmp('jarvis-tr-');
  assert.equal(testrun.detect(d), null);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(testrun.detect(d), null);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
  assert.equal(testrun.detect(d), 'npm test --silent');
  assert.equal(testrun.resolve(d, ''), null);
  assert.equal(testrun.resolve(d, 'auto'), 'npm test --silent');
  const ok = await testrun.run(d, 'node -e "console.log(42)"').promise;
  assert.equal(ok.ok, true); assert.match(ok.output, /42/);
  const bad = await testrun.run(d, 'node -e "console.error(\'boom\'); process.exit(3)"').promise;
  assert.equal(bad.ok, false); assert.equal(bad.exitCode, 3); assert.match(bad.output, /boom/);
  const slow = await testrun.run(d, 'node -e "setTimeout(()=>{}, 20000)"', { timeoutMs: 800 }).promise;
  assert.equal(slow.ok, false); assert.equal(slow.timedOut, true);
});

test('failing project tests block approval even when the reviewer passes', async () => {
  calls.length = 0;
  const { o, chat, ctx } = setup({ testCommand: 'node -e "console.error(\'2 tests failed\'); process.exit(1)"', testGate: true, reviewer: 'codex' });
  const r = await o.review(chat, ctx, { task: 'x', round: 1 });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.bugs[0].by, 'tests'); assert.match(r.bugs[0].description, /2 tests failed/);
  assert.match(calls.find(c => c.who === 'codex').prompt, /Project tests[\s\S]*FAILED/);
  assert.ok(chat.messages.some(m => m.kind === 'tests' && m.tests.ok === false));
  // passing tests + passing reviewer = approved
  const g = setup({ testCommand: 'node -e "process.exit(0)"', testGate: true });
  assert.equal((await g.o.review(g.chat, g.ctx, { task: 'x', round: 1 })).verdict, 'pass');
  // gate off: failing tests are reported but don't block
  const n = setup({ testCommand: 'node -e "process.exit(1)"', testGate: false });
  assert.equal((await n.o.review(n.chat, n.ctx, { task: 'x', round: 1 })).verdict, 'pass');
});

test('builder fallback: a failed step is retried once on the fallback model', async () => {
  calls.length = 0;
  claudeImpl = opts => opts.model === 'claude-opus-5-5' ? { ok: false, error: 'overloaded', costUsd: 0, editedFiles: [] } : { ok: true, text: 'done by ' + opts.model, costUsd: 0, editedFiles: [] };
  const { o, chat, ctx } = setup({ builderModel: 'claude-opus-5-5', builderFallback: 'claude-sonnet-5-5' });
  const r = await o.builderStep(chat, ctx, { prompt: 'p', phase: 'x', round: 1 });
  assert.equal(r.ok, true); assert.match(r.text, /sonnet/);
  assert.deepEqual(calls.map(c => c.model), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.ok(chat.messages.some(m => m.kind === 'status' && /دوباره انجام می‌شود/.test(m.text)));
  // no fallback configured: just the failure
  calls.length = 0;
  const n = setup({ builderModel: 'claude-opus-5-5', builderFallback: '' });
  assert.equal((await n.o.builderStep(n.chat, n.ctx, { prompt: 'p', phase: 'x', round: 1 })).ok, false);
  assert.equal(calls.length, 1);
  claudeImpl = () => ({ ok: true, text: 'done', costUsd: 0, editedFiles: [] });
});

test('a Claude model in the reviewer slot runs on the Claude engine', async () => {
  calls.length = 0;
  claudeImpl = () => ({ ok: true, text: '{"verdict":"pass","summary":"fine","bugs":[],"tests_run":[]}', costUsd: 0, editedFiles: [] });
  const { o, chat, ctx } = setup({ reviewer: 'codex', codexModel: 'claude-opus-5-5' });
  const r = await o.review(chat, ctx, { task: 'x', round: 1 });
  assert.equal(r.verdict, 'pass');
  assert.ok(calls.length >= 1 && calls.every(c => c.who === 'claude' && c.model === 'claude-opus-5-5')); // main reviewer (+ sub-agents that follow it)
  claudeImpl = () => ({ ok: true, text: 'done', costUsd: 0, editedFiles: [] });
});

test('connection cost is computed from its prices and kept apart from Claude', async () => {
  claudeImpl = () => ({ ok: true, text: 'ok', costUsd: 9, editedFiles: [], modelUsage: { m: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 0 } } });
  const { o, chat, ctx } = setup({ builderModel: 'p:ds:deepseek-chat' });
  o.resolveProvider = spec => /^p:ds:/.test(spec) ? { id: 'ds', name: 'DS', label: 'DS · deepseek-chat', engine: 'claude', model: 'deepseek-chat', hasKey: true, env: {}, prices: { in: 0.5, cached: 0.1, out: 2 } } : null;
  const r = await o.claudeStep(chat, ctx, { prompt: 'p', phase: 'x', round: 1 });
  assert.ok(Math.abs(r.costUsd - (0.5 + 1 + 0.2)) < 1e-9, String(r.costUsd));
  assert.equal(chat.cost.claudeUsd, 0);
  assert.ok(Math.abs(chat.cost.otherUsd - 1.7) < 1e-9);
  claudeImpl = () => ({ ok: true, text: 'done', costUsd: 0, editedFiles: [] });
});

test('summary mode: sessions restart from the summary', async () => {
  calls.length = 0;
  claudeImpl = () => ({ ok: true, text: '- goal: login page\n- done: form', sessionId: 'sess-new', costUsd: 0, editedFiles: [] });
  const { o, chat, ctx } = setup();
  chat.claudeSession = 'old-session'; chat.codexThread = 'old-thread'; chat.reviewerSession = 'r';
  assert.equal(await o.compactFlow(chat, ctx), 'done');
  assert.match(chat.carryOver, /login page/);
  assert.equal(chat.codexThread, null); assert.equal(chat.reviewerSession, null);
  assert.ok(chat.messages.some(m => m.kind === 'summary'));
  // next builder step starts a fresh session with the summary in front
  chat.claudeSession = null; calls.length = 0;
  await o.claudeStep(chat, ctx, { prompt: 'continue', phase: 'x', round: 1 });
  assert.match(calls[0].prompt, /Summary of the earlier conversation[\s\S]*login page[\s\S]*continue/);
  assert.equal(calls[0].session, null);
  claudeImpl = () => ({ ok: true, text: 'done', costUsd: 0, editedFiles: [] });
});

test('memory mode: rule suggestions come back as a checklist', async () => {
  claudeImpl = () => ({ ok: true, text: 'Here:\n- Run npm test before committing\n- API keys live in .env\nnot a rule', costUsd: 0, editedFiles: [] });
  const { o, chat, ctx } = setup();
  assert.equal(await o.memoryFlow(chat, ctx), 'done');
  const m = chat.messages.find(x => x.kind === 'memory');
  assert.deepEqual(m.items, ['Run npm test before committing', 'API keys live in .env']);
  claudeImpl = () => ({ ok: true, text: 'done', costUsd: 0, editedFiles: [] });
});

test('phone notify: sends to the bot API and finds the chat id', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => {
      seen.push({ url: req.url, body: b });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.endsWith('/getUpdates')) return res.end(JSON.stringify({ ok: true, result: [{ message: { chat: { id: 777, first_name: 'Borhan' } } }] }));
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.JARVIS_NOTIFY_BASE = `http://127.0.0.1:${srv.address().port}`;
  try {
    const notify = require('../lib/notify');
    await assert.rejects(notify.send({ channel: 'bale', token: 'bad token!', chatId: '1', text: 'x' }), /توکن/);
    assert.deepEqual(await notify.detect({ channel: 'bale', token: '123456:ABC-def_ghi' }), { chatId: '777', name: 'Borhan' });
    await notify.send({ channel: 'telegram', token: '123456:ABC-def_ghi', chatId: '777', text: 'done' });
    const last = seen[seen.length - 1];
    assert.equal(last.url, '/bot123456:ABC-def_ghi/sendMessage');
    assert.deepEqual(JSON.parse(last.body), { chat_id: '777', text: 'done' });
  } finally { delete process.env.JARVIS_NOTIFY_BASE; srv.close(); }
});
