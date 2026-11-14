'use strict';
// Smart mode (task splitting), connectors (MCP), plugins and the task queue.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agents = require('../lib/agents');
const calls = [];
let claudeImpl = () => ({ ok: true, text: 'done', costUsd: 0, editedFiles: [] });
agents.runClaude = opts => { calls.push({ who: 'claude', model: opts.model, prompt: opts.prompt, mcpConfig: opts.mcpConfig, mcp: opts.mcpConfig ? JSON.parse(fs.readFileSync(opts.mcpConfig, 'utf8')) : null, allowedTools: opts.allowedTools }); return { promise: Promise.resolve(claudeImpl(opts)), kill() {} }; };
agents.runCodex = opts => { calls.push({ who: 'codex', model: opts.model, prompt: opts.prompt, configArgs: opts.configArgs }); return { promise: Promise.resolve({ ok: true, text: '{"verdict":"pass","summary":"ok","bugs":[],"tests_run":[]}', threadId: 't', usage: null }), kill() {} }; };
const { Orchestrator } = require('../lib/orchestrator');
const { Store } = require('../lib/store');
const { Connectors } = require('../lib/connectors');
const { Plugins, validGitUrl } = require('../lib/plugins');
const { Skills } = require('../lib/skills');
const { TaskQueue } = require('../lib/queue');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const memSecrets = () => { const d = {}; return { get: k => d[k] || null, set: (k, v) => { if (v == null) delete d[k]; else d[k] = v; } }; };
function setup(settings = {}) {
  const store = new Store(tmp('jarvis-ex-'));
  for (const a of store.subagents()) store.saveSubagent({ ...a, enabled: false });
  const o = new Orchestrator({ store, broadcast() {} });
  const chat = store.newChat('p1', 't');
  const ctx = { s: { ...store.settings(), ...settings }, run: { cancelled: false, kills: new Set(), inbox: [] }, runCost: 0, cwd: tmp('jarvis-ex-proj-'), projectId: 'p1', isGit: false };
  return { o, chat, ctx, store };
}

test('smart mode: the planner splits the task and each part runs on the model for its level', async () => {
  calls.length = 0;
  claudeImpl = opts => /Split the request/.test(opts.prompt)
    ? { ok: true, costUsd: 0, editedFiles: [], text: 'Here:\n{"subtasks":[{"title":"طراحی","level":"hard","prompt":"Design the data model"},{"title":"کد","level":"medium","prompt":"Implement it"},{"title":"تست","level":"easy","prompt":"Write tests"}]}' }
    : { ok: true, text: 'did ' + opts.model, costUsd: 0, editedFiles: [] };
  const { o, chat, ctx } = setup({ routerModel: 'claude-haiku-5-5' });
  assert.equal(await o.smartFlow(chat, ctx, 'build a todo app'), 'done');
  const cl = calls.filter(c => c.who === 'claude').map(c => c.model);
  assert.deepEqual(cl, ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.match(calls[2].prompt, /What the earlier parts did[\s\S]*did claude-opus-5-5/);
  const card = chat.messages.find(m => m.kind === 'smartplan');
  assert.equal(card.plan.length, 3); assert.equal(card.approved, true); assert.ok(card.estUsd < card.topUsd);
  assert.equal(calls.filter(c => c.who === 'codex').length, 1); // one review of the whole thing
  // unreadable plan -> one medium part
  calls.length = 0;
  claudeImpl = opts => /Split the request/.test(opts.prompt) ? { ok: true, text: 'no idea', costUsd: 0, editedFiles: [] } : { ok: true, text: 'x', costUsd: 0, editedFiles: [] };
  const b = setup();
  assert.equal(await b.o.smartFlow(b.chat, b.ctx, 'small fix'), 'done');
  assert.deepEqual(calls.filter(c => c.who === 'claude').map(c => c.model), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
});

test('smart mode: with approval required the run waits and uses the edited models', async () => {
  calls.length = 0;
  claudeImpl = opts => /Split the request/.test(opts.prompt) ? { ok: true, costUsd: 0, editedFiles: [], text: '{"subtasks":[{"title":"a","level":"hard","prompt":"do a"}]}' } : { ok: true, text: 'x', costUsd: 0, editedFiles: [] };
  const { o, chat, ctx } = setup({ smartAutoApprove: false });
  o.running.set(chat.id, ctx.run);
  const p = o.smartFlow(chat, ctx, 'task');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(chat.status, 'waiting');
  assert.equal(o.approveSmart(chat.id, { models: ['claude-haiku-5-5'] }), true);
  assert.equal(await p, 'done');
  assert.equal(calls.filter(c => c.who === 'claude')[1].model, 'claude-haiku-5-5');
  // stop while waiting
  const c = setup({ smartAutoApprove: false });
  c.o.running.set(c.chat.id, c.ctx.run);
  const q = c.o.smartFlow(c.chat, c.ctx, 'task');
  await new Promise(r => setTimeout(r, 30));
  c.o.stop(c.chat.id);
  assert.equal(await q, 'stopped');
  claudeImpl = () => ({ ok: true, text: 'done', costUsd: 0, editedFiles: [] });
});

// A tiny MCP server over stdio.
const FAKE_MCP = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);
if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}}));
if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo_'+(process.env.FAKE_KEY||'none'),inputSchema:{type:'object'}},{name:'ping',inputSchema:{type:'object'}}]}}));}});`;

test('connectors: saved without secrets on disk, handed to the right roles on both engines, and testable', async () => {
  const dir = tmp('jarvis-cn-');
  const sec = memSecrets();
  const cn = new Connectors(dir, sec);
  const script = path.join(dir, 'fake-mcp.js'); fs.writeFileSync(script, FAKE_MCP);
  assert.throws(() => cn.save({ name: 'x', type: 'http', url: 'http://example.com/mcp' }), /https/);
  const a = cn.save({ name: 'Fake', type: 'stdio', command: process.execPath, args: [script], secrets: [{ name: 'FAKE_KEY', label: 'key' }], values: { FAKE_KEY: 's3cret' }, roles: { builder: true } });
  const h = cn.save({ name: 'Docs', type: 'http', url: 'https://mcp.example.com/mcp', secrets: [{ name: 'Authorization', bearer: true }], values: { Authorization: 'tok123' }, roles: { reviewer: true, subs: true } });
  assert.ok(!fs.readFileSync(path.join(dir, 'connectors.json'), 'utf8').includes('s3cret'));
  assert.ok(!JSON.stringify(cn.view()).includes('s3cret'));
  assert.equal(cn.view()[0].secrets[0].set, true);
  assert.deepEqual(cn.forRole('builder').map(r => r.name), [a.id]);
  assert.deepEqual(cn.forRole('reviewer').map(r => r.name), [h.id]);
  const t = await cn.test(a.id);
  assert.deepEqual(t.tools, ['echo_s3cret', 'ping']);
  // missing secret -> not handed out
  const m = cn.save({ name: 'NoKey', type: 'stdio', command: 'npx', args: ['x'], secrets: [{ name: 'K' }], roles: { builder: true } });
  assert.ok(!cn.forRole('builder').some(r => r.name === m.id));
  // orchestrator: builder gets the stdio one (Claude engine), reviewer gets the http one (Codex engine)
  calls.length = 0;
  const { o, chat, ctx } = setup();
  o.connectors = cn;
  await o.claudeStep(chat, ctx, { prompt: 'p', phase: 'x', round: 1 });
  assert.deepEqual(Object.keys(calls[0].mcp.mcpServers), [a.id]);
  assert.equal(calls[0].mcp.mcpServers[a.id].env.FAKE_KEY, 's3cret');
  assert.ok(calls[0].allowedTools.includes('mcp__' + a.id));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(fs.existsSync(calls[0].mcpConfig), false, 'temp config with secrets is deleted');
  await o.codexStep(chat, ctx, { prompt: 'p', phase: 'r', round: 1, schema: true });
  const cx = calls.find(c => c.who === 'codex').configArgs;
  assert.ok(cx.includes(`mcp_servers.${h.id}.url="https://mcp.example.com/mcp"`));
  assert.ok(cx.some(x => x.includes('"Authorization" = "Bearer tok123"')));
  cn.setEnabled(a.id, false);
  assert.equal(cn.forRole('builder').length, 0);
  cn.remove(h.id);
  assert.equal(sec.get(`connector:${h.id}:Authorization`), null);
});

test('plugins: a Claude Code plugin folder becomes sub-agents, skills, commands and connectors', async () => {
  const dir = tmp('jarvis-pl-');
  const store = new Store(dir), skills = new Skills(dir), cn = new Connectors(dir, memSecrets());
  const pl = new Plugins(dir, { store, skills, connectors: cn });
  const src = tmp('jarvis-plsrc-');
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), t); };
  w('.claude-plugin/plugin.json', JSON.stringify({ name: 'Acme Tools', description: 'demo', version: '1.0.0' }));
  w('agents/code-reviewer.md', '---\nname: code-reviewer\ndescription: Reviews code for bugs\n---\nYou review code carefully.');
  w('agents/api-builder.md', '---\nname: api-builder\ndescription: Builds REST endpoints\n---\nYou build APIs.');
  w('skills/style/SKILL.md', '---\nname: style\ndescription: House style\n---\nUse tabs.');
  w('commands/ship.md', '---\ndescription: ship it\n---\nRun the tests then commit. $ARGUMENTS');
  w('.mcp.json', JSON.stringify({ mcpServers: { db: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/srv.js'], env: { DATABASE_URL: '${DB_URL}', MODE: 'ro' } }, free: { command: 'node', args: ['x.js'] },
    api: { url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } } } }));
  const before = store.subagents().length;
  const rec = await pl.installDir(src);
  assert.equal(rec.name, 'acme-tools');
  const subs = store.subagents().filter(a => a.plugin === rec.id);
  assert.deepEqual(subs.map(a => [a.name, a.stage]).sort(), [['api-builder', 'builder'], ['code-reviewer', 'review']]);
  assert.equal(subs[0].skills.length, 1);
  assert.equal(skills.all().length, 1);
  assert.deepEqual(pl.commands(), [{ title: '/ship', text: 'Run the tests then commit.', plugin: 'acme-tools' }]);
  const cs = cn.view().filter(c => c.plugin === rec.id);
  assert.equal(cs.length, 3);
  assert.ok(cs.every(c => !c.enabled), 'plugin programs start switched off');
  const db = cs.find(c => /^db/.test(c.name));
  assert.equal(db.secrets[0].name, 'DB_URL');
  assert.ok(db.args[0].includes(rec.id) && !db.args[0].includes('CLAUDE_PLUGIN_ROOT'));
  // env template: the variable is filled into the key the server expects; fixed values are kept
  cn.save({ ...cn.get(db.id), values: { DB_URL: 'postgres://x' } });
  assert.deepEqual(cn.resolved(cn.get(db.id)).env, { DATABASE_URL: 'postgres://x', MODE: 'ro' });
  const api = cs.find(c => /^api/.test(c.name));
  cn.save({ ...cn.get(api.id), values: { API_KEY: 'k1' } });
  assert.deepEqual(cn.resolved(cn.get(api.id)).headers, { Authorization: 'Bearer k1' });
  pl.setEnabled(rec.id, false);
  assert.ok(store.subagents().filter(a => a.plugin === rec.id).every(a => !a.enabled));
  assert.deepEqual(pl.commands(), []);
  // reinstall replaces, remove cleans everything
  const again = await pl.installDir(src);
  assert.equal(pl.all().length, 1);
  pl.remove(again.id);
  assert.equal(store.subagents().length, before);
  assert.equal(skills.all().length, 0); assert.equal(cn.view().length, 0);
  assert.throws(() => pl.inspect(tmp('jarvis-empty-')), /پلاگین نیست/);
  assert.equal(validGitUrl('anthropics/claude-code'), 'https://github.com/anthropics/claude-code.git');
  assert.equal(validGitUrl('git@github.com:a/b.git'), null);
});

test('task queue: jobs run one after another and the batch is reported once', async () => {
  const ran = []; let batch = null;
  const q = new TaskQueue(tmp('jarvis-q-'), { runJob: async j => { ran.push(j.text); await new Promise(r => setTimeout(r, 20)); if (j.text === 'b') throw new Error('boom'); return { status: 'done', chatId: 'c' + ran.length }; }, onBatchDone: b => { batch = b; } });
  clearInterval(q.timer);
  assert.throws(() => q.add({ projectId: 'p', text: '' }), /خالی/);
  assert.throws(() => q.add({ projectId: 'p', text: 'x', at: '25:00' }), /HH:MM/);
  q.add({ projectId: 'p', text: 'a' }); q.add({ projectId: 'p', text: 'b', mode: 'smart' });
  const later = q.add({ projectId: 'p', text: 'later', at: new Date(Date.now() + 3600000).toTimeString().slice(0, 5) });
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(ran, ['a', 'b']);
  assert.deepEqual(batch.map(j => j.status), ['done', 'error']);
  assert.equal(q.all().find(j => j.id === later.id).status, 'pending');
  q.clearFinished();
  assert.equal(q.all().length, 1);
});
