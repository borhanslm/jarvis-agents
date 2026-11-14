'use strict';
// Claude subscription limit: Codex takes over the builder role, or the run waits.
// The agent CLIs are replaced with fakes before the orchestrator loads them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agents = require('../lib/agents');
const calls = [];
let claudeLimited = true;
agents.runClaude = opts => {
  calls.push({ who: 'claude', prompt: opts.prompt });
  const r = claudeLimited
    ? { ok: false, error: '5-hour limit reached ∙ resets 3pm', limitHit: true, resetAt: Date.now() + 3600000, costUsd: 0, editedFiles: [] }
    : { ok: true, text: 'done by claude', costUsd: 0.01, editedFiles: [] };
  return { promise: Promise.resolve(r), kill() {} };
};
agents.runCodex = opts => {
  calls.push({ who: 'codex', prompt: opts.prompt, sandbox: opts.sandbox });
  return { promise: Promise.resolve({ ok: true, text: 'done by codex', threadId: 't1', usage: null }), kill() {} };
};
const { Orchestrator } = require('../lib/orchestrator');
const { Store } = require('../lib/store');

function setup(settings) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lim-')));
  const o = new Orchestrator({ store, broadcast() {} });
  const chat = store.newChat('p1', 't');
  const ctx = { s: { ...store.settings(), ...settings }, run: { cancelled: false, kills: new Set(), inbox: [] }, runCost: 0, subscription: true, cwd: os.tmpdir(), projectId: 'p1' };
  return { o, chat, ctx };
}

test('limit hit + "codex" setting: Codex builds now, and keeps building until the reset', async () => {
  calls.length = 0; claudeLimited = true;
  const { o, chat, ctx } = setup({ onClaudeLimit: 'codex' });
  const r = await o.claudeStep(chat, ctx, { prompt: 'add a login page', phase: 'نوشتن کد', round: 1 });
  assert.equal(r.ok, true); assert.equal(r.viaCodex, true);
  assert.deepEqual(calls.map(c => c.who), ['claude', 'codex']);
  assert.equal(calls[1].sandbox, 'workspace-write');
  assert.match(calls[1].prompt, /BUILDER[\s\S]*add a login page/);
  assert.ok(chat.messages.some(m => m.kind === 'status' && /Codex جای او/.test(m.text)));
  assert.ok(!chat.messages.some(m => m.kind === 'error'));
  // next builder step in the same window goes straight to Codex
  calls.length = 0;
  await o.claudeStep(chat, ctx, { prompt: 'fix bug', phase: 'رفع', round: 2 });
  assert.deepEqual(calls.map(c => c.who), ['codex']);
  // a reviewer step is never handed to Codex this way
  calls.length = 0; ctx.s.waitOnLimit = false;
  await o.claudeStep(chat, ctx, { prompt: 'review', phase: 'بررسی', role: 'reviewer' });
  assert.deepEqual(calls.map(c => c.who), ['claude']);
});

test('after the reset time Claude builds again', async () => {
  calls.length = 0; claudeLimited = false;
  const { o, chat, ctx } = setup({ onClaudeLimit: 'codex' });
  o.agentState.claude.limitHit = { text: 'x', until: Date.now() - 1000 };
  const r = await o.claudeStep(chat, ctx, { prompt: 'next', phase: 'نوشتن کد', round: 1 });
  assert.equal(r.text, 'done by claude');
  assert.equal(o.agentState.claude.limitHit, null);
  assert.deepEqual(calls.map(c => c.who), ['claude']);
});

test('limit hit with "wait": the run waits (and Stop cancels the wait)', async () => {
  calls.length = 0; claudeLimited = true;
  const { o, chat, ctx } = setup({ onClaudeLimit: 'wait', waitOnLimit: true });
  const p = o.claudeStep(chat, ctx, { prompt: 'x', phase: 'نوشتن کد', round: 1 });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(chat.status, 'waiting');
  assert.ok(chat.messages.some(m => m.kind === 'status' && /خودکار ادامه/.test(m.text)));
  ctx.run.cancelled = true;
  const r = await p;
  assert.equal(r.ok, false);
  assert.deepEqual(calls.map(c => c.who), ['claude']);
});

test('no swap on an API key (not a subscription)', async () => {
  calls.length = 0; claudeLimited = true;
  const { o, chat, ctx } = setup({ onClaudeLimit: 'codex' });
  ctx.subscription = false;
  const r = await o.claudeStep(chat, ctx, { prompt: 'x', phase: 'نوشتن کد', round: 1 });
  assert.equal(r.ok, false);
  assert.deepEqual(calls.map(c => c.who), ['claude']);
});
