'use strict';
// Regression tests for bugs found in the bug hunt (each was reproduced before fixing).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Store } = require('../lib/store');
const { Usage } = require('../lib/usage');
const { Orchestrator } = require('../lib/orchestrator');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- server: start a real instance on a free port with its own data dir ----
function startServer() {
  return new Promise((resolve, reject) => {
    const data = tmp('jarvis-srv-');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, JARVIS_PORT: '0', JARVIS_DATA: data, JARVIS_CLUB_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
    child.stdout.on('data', d => {
      out += d;
      const m = out.match(/Panel:\s+http:\/\/localhost:(\d+)\//);
      if (m) { clearTimeout(t); resolve({ child, port: +m[1], data }); }
    });
    child.stderr.on('data', d => { out += d; });
  });
}
function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', () => resolve(0));
    r.end();
  });
}
function post(port, p, body, headers = {}) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Jarvis': '1', 'Content-Length': data.length, ...headers } }, res => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    r.on('error', () => resolve({ status: 0 }));
    r.end(data);
  });
}

test('server survives malformed URLs, unicode tokens and blocks path tricks', { timeout: 30000 }, async () => {
  const { child, port, data } = await startServer();
  try {
    assert.equal(await get(port, '/%E0'), 400);                       // used to crash the process
    assert.equal(await get(port, '/'), 200);                           // still alive
    assert.equal(await get(port, '/..%2Fserver.js'), 403);
    assert.equal(await get(port, '/..%2Fpublic2%2Fx'), 403);           // "public" prefix sibling
    const on = await post(port, '/api/settings', { requireToken: true });
    assert.equal(on.status, 200);
    const token = JSON.parse(on.body).token;
    assert.equal(token.length, 48);
    assert.equal(await get(port, '/api/state', { 'X-Jarvis-Token': encodeURIComponent('é'.repeat(48)) }), 401);
    assert.equal(await get(port, '/api/state?token=' + encodeURIComponent('é'.repeat(48))), 401); // used to crash
    assert.equal(await get(port, '/api/state', { 'X-Jarvis-Token': token }), 200); // still alive, real token works
    // stored XSS: a sub-agent id with markup is replaced by a server-made id
    const r = await post(port, '/api/subagents', { id: '"><img src=x onerror=alert(1)>', name: 'evil', prompt: 'x' }, { 'X-Jarvis-Token': token });
    assert.match(JSON.parse(r.body).id, /^[\w-]{1,40}$/);
    assert.ok(fs.existsSync(data));
  } finally { child.kill(); }
});

test('deleted chat is never written back (pending save, late save, flush)', async () => {
  const dir = tmp('jarvis-del-');
  const s = new Store(dir);
  const c = s.newChat('p1', 'x');
  c.messages.push({ t: 1 });
  s.saveChat(c);          // debounced write pending
  s.deleteChat(c.id);
  s.saveChat(c, true);    // a run still finishing posts another message
  s.flush();              // used to throw on the removed chat
  await sleep(600);
  assert.equal(fs.existsSync(path.join(dir, 'chats', c.id + '.json')), false);
  assert.equal(new Store(dir).listChats().length, 0);
});

test('usage days use the local calendar day', () => {
  const u = new Usage(tmp('jarvis-u-'));
  const t = new Date(); t.setHours(0, 30, 0, 0);
  u.rows.push({ ts: +t, model: 'm', agent: 'claude', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
  const s = u.summary({ days: 2 });
  assert.equal(Object.keys(s.models[0].days)[0], s.days[1]); // today, not yesterday (UTC)
});

function fakeOrch(extra = {}) {
  const chats = {};
  const store = { saveChat() {}, chatSummary: c => ({ id: c.id, status: c.status }), settings: () => ({}), subagent: () => null, chat: id => chats[id], ...extra };
  const o = new Orchestrator({ store, broadcast: () => {} });
  const chat = chats.c1 = { id: 'c1', title: 't', status: 'idle', messages: [], cost: { claudeUsd: 0, codexTokens: 0 }, touchedFiles: [] };
  return { o, chat };
}

test('stop during preparation: no agent is launched afterwards', async () => {
  const { o, chat } = fakeOrch();
  const ctx = { cwd: '.', s: {}, runCost: 0, run: { kills: new Set(), cancelled: true, inbox: [] } };
  const r1 = await o.claudeStep(chat, ctx, { prompt: 'x', phase: 'p' });
  const r2 = await o.codexStep(chat, ctx, { prompt: 'x', phase: 'p' });
  assert.equal(r1.cancelled, true);
  assert.equal(r2.cancelled, true);
  assert.equal(chat.messages.length, 0); // nothing started, no phase posted
});

test('a message queued during finalization is run, not silently dropped', async () => {
  const { o, chat } = fakeOrch();
  const dir = tmp('jarvis-fin-');
  const calls = [];
  o.dispatch = async (c, ctx, text) => { calls.push(text); return 'done'; };
  // Simulate a message arriving while the run is finalizing (after the inbox loop).
  const realPost = o.post.bind(o);
  let injected = false;
  o.post = (c, m) => {
    const r = realPost(c, m);
    if (!injected && m.kind === 'report') { injected = true; o.enqueue(c, 'late instruction'); }
    return r;
  };
  o.store.settings = () => ({ finalReport: true });
  await o.run(chat, { id: 'p', path: dir }, 'first', 'claude');
  await sleep(100); // follow-up starts on the next tick
  for (let i = 0; i < 20 && o.isRunning(chat.id); i++) await sleep(50);
  assert.deepEqual(calls, ['first', 'late instruction']);
  assert.ok(chat.messages.some(m => m.kind === 'delivered' && /پایان اجرای قبلی/.test(m.text)));
});

test('per-chat models: validated, and they override settings for the run', async () => {
  const { Store: S2 } = require('../lib/store');
  assert.deepEqual(S2.cleanModels({ builderModel: 'opus', builderEffort: 'high', codexModel: 'gpt-6-astra', codexEffort: 'bogus' }),
    { builderModel: 'claude-opus-5-5', builderEffort: 'high', codexModel: 'gpt-6-astra', codexEffort: '' });
  assert.equal(S2.cleanModels({ builderModel: '"><img src=x onerror=alert(1)>' }).builderModel, ''); // never reaches HTML/CLI
  const chats = {};
  const store = { saveChat() {}, chatSummary: c => ({ id: c.id }), settings: () => ({ builderModel: 'sonnet', builderEffort: 'medium', codexModel: '' }), subagent: () => null, chat: id => chats[id] };
  const o = new Orchestrator({ store, broadcast: () => {} });
  const chat = chats.m1 = { id: 'm1', title: 't', status: 'idle', messages: [], cost: { claudeUsd: 0, codexTokens: 0 }, touchedFiles: [], models: { builderModel: 'haiku', builderEffort: '', codexModel: 'gpt-x' } };
  let seen;
  o.dispatch = async (c, ctx) => { seen = ctx.s; return 'done'; };
  await o.run(chat, { id: 'p', path: tmp('jarvis-models-') }, 'x', 'claude');
  assert.equal(seen.builderModel, 'haiku');   // chat choice wins
  assert.equal(seen.builderEffort, 'medium'); // '' = keep the settings value
  assert.equal(seen.codexModel, 'gpt-x');
});

// ---- Pro subscription support, search, per-file changes ----
test('Claude usage-limit messages are recognised and the reset time parsed', () => {
  const { isLimitText, parseReset } = require('../lib/agents');
  const now = new Date(2026, 10, 14, 10, 0).getTime();
  assert.ok(isLimitText('Claude AI usage limit reached|1763120000'));
  assert.equal(parseReset('Claude AI usage limit reached|1763120000', now), 1763120000 * 1000);
  const r3 = new Date(parseReset('5-hour limit reached ∙ resets 3pm', now));
  assert.deepEqual([r3.getDate(), r3.getHours()], [14, 15]);
  const r5 = new Date(parseReset("You've hit your limit · resets 5:30am (Asia/Tehran)", now));
  assert.deepEqual([r5.getDate(), r5.getHours(), r5.getMinutes()], [15, 5, 30]); // already past today -> tomorrow
  assert.equal(isLimitText('TypeError: x is undefined'), false);
});

test('dollar cap is off on a subscription unless asked', () => {
  const o = new Orchestrator({ store: new Store(tmp('jarvis-b-')), broadcast() {} });
  const ctx = { s: { maxRunCostUsd: 5, budgetOnSubscription: false }, runCost: 9, subscription: true };
  assert.equal(o.budgetLeft(ctx), Infinity);
  ctx.s.budgetOnSubscription = true;
  assert.ok(o.budgetLeft(ctx) < 0);
  assert.ok(new Orchestrator({ store: new Store(tmp('jarvis-b-')), broadcast() {} }).budgetLeft({ s: { maxRunCostUsd: 5 }, runCost: 9, subscription: false }) < 0);
});

test('chat search finds titles and message text, scoped to a project', () => {
  const s = new Store(tmp('jarvis-q-'));
  const a = s.newChat('p1', 'Login page'); a.messages.push({ agent: 'user', kind: 'text', text: 'fix the password reset email', ts: 1 });
  const b = s.newChat('p2', 'Other'); b.messages.push({ agent: 'user', kind: 'text', text: 'password field', ts: 2 });
  assert.deepEqual(s.searchChats('login').map(c => c.id), [a.id]);
  assert.equal(s.searchChats('PASSWORD').length, 2);
  const r = s.searchChats('password', 'p1');
  assert.equal(r.length, 1); assert.match(r[0].snippet, /password reset/);
  assert.equal(s.searchChats('  ').length, 0);
});

test('per-file changes: list, one-file diff, revert, and no path tricks', { timeout: 30000 }, async () => {
  const git = require('../lib/git');
  const { execFileSync } = require('child_process');
  const dir = tmp('jarvis-g-');
  const run = (...a) => execFileSync('git', a, { cwd: dir });
  run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n'); run('add', '.'); run('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'hello\n');
  const { files } = await git.changedFiles(dir);
  assert.deepEqual(files.map(f => [f.path, f.status]).sort(), [['a.txt', 'modified'], ['new.txt', 'new']]);
  assert.match((await git.fileDiff(dir, 'a.txt')).diff, /\+TWO/);
  assert.equal((await git.fileDiff(dir, '../x')).ok, false);
  assert.equal((await git.revertFile(dir, '../a.txt')).ok, false);
  assert.ok((await git.revertFile(dir, 'a.txt')).ok);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').replace(/\r/g, ''), 'one\ntwo\n');
  assert.ok((await git.revertFile(dir, 'new.txt')).deleted);
  assert.equal((await git.changedFiles(dir)).files.length, 0);
});

test('new routes: attach + retry guard, rules, MCP validation, backup round-trip, diagnostics', { timeout: 40000 }, async () => {
  const { child, port } = await startServer();
  const req = (method, p, body) => new Promise(resolve => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Jarvis': '1', ...(data ? { 'Content-Length': data.length } : {}) } }, res => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, body: j, raw: s }); });
    });
    r.on('error', () => resolve({ status: 0 }));
    r.end(data || undefined);
  });
  try {
    const dir = tmp('jarvis-proj-');
    const proj = (await req('POST', '/api/projects', { path: dir, name: 'p' })).body;
    const chat = (await req('POST', '/api/chats', { projectId: proj.id })).body;
    // attachments: images only, stored, served back
    assert.equal((await req('POST', `/api/chats/${chat.id}/attach`, { type: 'text/html', data: 'PGI+' })).status, 400);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex').toString('base64');
    const at = await req('POST', `/api/chats/${chat.id}/attach`, { type: 'image/png', data: png });
    assert.equal(at.status, 200); assert.match(at.body.file, /^\d+-[0-9a-f]{6}\.png$/);
    assert.equal((await req('GET', `/api/chats/${chat.id}/attachment?file=${at.body.file}`)).status, 200);
    assert.equal((await req('GET', `/api/chats/${chat.id}/attachment?file=..%2F..%2Fsettings.json`)).status, 404);
    // retry with nothing to retry
    assert.equal((await req('POST', `/api/chats/${chat.id}/retry`, {})).status, 400);
    // rules editor
    assert.deepEqual((await req('GET', `/api/projects/${proj.id}/rules`)).body, { claude: null, agents: null });
    assert.equal((await req('POST', `/api/projects/${proj.id}/rules`, { which: 'agents', text: '# rules' })).status, 200);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# rules');
    assert.equal((await req('POST', `/api/projects/${proj.id}/rules`, { which: '../x', text: 'x' })).status, 400);
    // MCP config must be valid JSON with mcpServers
    assert.equal((await req('POST', '/api/settings', { mcpConfig: '{bad' })).status, 400);
    assert.equal((await req('POST', `/api/projects/${proj.id}/settings`, { settings: { mcpConfig: '{"x":1}' } })).status, 400);
    assert.equal((await req('POST', `/api/projects/${proj.id}/settings`, { settings: { mcpConfig: '{"mcpServers":{}}', scheduleAuditAt: '02:00' } })).status, 200);
    // backup round-trip into a fresh server
    const bk = (await req('GET', '/api/backup')).body;
    assert.equal(bk.app, 'jarvis'); assert.equal(bk.chats.length, 1); assert.equal(bk.settings.requireToken, undefined);
    assert.equal((await req('POST', '/api/backup/restore', { data: { app: 'other' } })).status, 400);
    const again = (await req('POST', '/api/backup/restore', { data: bk })).body;
    assert.deepEqual([again.projects, again.chats], [0, 0]); // nothing duplicated
    const diag = (await req('GET', '/api/diagnostics')).body;
    assert.ok(diag.dataDir && 'claude' in diag.clis);
  } finally { child.kill(); }
  // restore into an empty data dir
  const s2 = await startServer();
  try {
    const r = await new Promise(resolve => {
      const data = Buffer.from(JSON.stringify({ data: { app: 'jarvis', projects: [{ id: 'abc12345', name: 'x', path: os.tmpdir() }], chats: [{ id: 'chat-restore-1', projectId: 'abc12345', title: 't', messages: [] }] } }));
      const q = http.request({ host: '127.0.0.1', port: s2.port, path: '/api/backup/restore', method: 'POST', headers: { Host: `127.0.0.1:${s2.port}`, 'Content-Type': 'application/json', 'X-Jarvis': '1', 'Content-Length': data.length } }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => resolve(JSON.parse(s))); });
      q.end(data);
    });
    assert.deepEqual([r.projects, r.chats], [1, 1]);
  } finally { s2.child.kill(); }
});
