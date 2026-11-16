'use strict';
// Custom connections: a fake Anthropic-compatible API; the real Claude Code CLI runs the
// builder and reviewer roles against it. Skipped when the Claude CLI is not installed (CI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const agents = require('../lib/agents');
const { Providers } = require('../lib/providers');
const { Orchestrator } = require('../lib/orchestrator');
const { Store } = require('../lib/store');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const memSecrets = () => { const d = {}; return { get: k => d[k] || null, set: (k, v) => { if (v == null) delete d[k]; else d[k] = v; } }; };

test('connections: save/validate, never expose the key, resolve to an isolated profile', () => {
  const p = new Providers(tmp('jarvis-pv-'), memSecrets());
  assert.throws(() => p.save({ name: 'x', baseUrl: 'ftp://a', models: 'm' }), /آدرس/);
  assert.throws(() => p.save({ name: 'x', baseUrl: 'http://example.com', models: 'm' }), /https/);
  assert.throws(() => p.save({ name: 'x', baseUrl: 'https://a.b', models: '' }), /مدل/);
  const d = p.save({ name: 'DeepSeek', preset: 'deepseek', kind: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic/', models: 'deepseek-chat, deepseek-reasoner', apiKey: 'sk-secret-1' });
  assert.equal(d.id, 'deepseek'); assert.equal(d.baseUrl, 'https://api.deepseek.com/anthropic'); assert.equal(d.hasKey, true);
  assert.ok(!JSON.stringify(p.view()).includes('sk-secret-1'));
  const r = p.resolve('p:deepseek:deepseek-chat');
  assert.equal(r.engine, 'claude'); assert.equal(r.model, 'deepseek-chat');
  assert.equal(r.env.ANTHROPIC_API_KEY, 'sk-secret-1'); assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, null);
  assert.ok(r.env.CLAUDE_CONFIG_DIR.includes(path.join('providers', 'deepseek')));
  const o = p.save({ name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-x'], apiKey: 'sk-o' });
  const ro = p.resolve(`p:${o.id}:gpt-x`);
  assert.equal(ro.engine, 'codex'); assert.ok(ro.configArgs.includes('model_providers.jarvis.wire_api="responses"'));
  assert.equal(ro.env.JARVIS_PROVIDER_KEY, 'sk-o');
  assert.equal(p.resolve('claude-opus-5-5'), null);
  assert.equal(p.resolve('p:gone:m').missing, true);
  p.remove('deepseek');
  assert.equal(p.get('deepseek'), null);
});

// Minimal Anthropic Messages API (streaming and not).
function fakeAnthropic(seen) {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-api-key'] || '', auth: req.headers.authorization || '' });
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
      let j = {}; try { j = JSON.parse(b); } catch {}
      const all = JSON.stringify(j.messages || []);
      const text = /JSON/.test(all) && /verdict/.test(all)
        ? '```json\n{"verdict":"pass","summary":"looks good","bugs":[],"tests_run":[]}\n```'
        : 'Done: I made the change.';
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
        ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
        ev('message_stop', { type: 'message_stop' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 8 } }));
    });
  });
}

test('builder and reviewer run on a custom Anthropic-compatible API with its own key only', { timeout: 180000, skip: !agents.CLIS.claude && 'Claude CLI not installed' }, async () => {
  const seen = [];
  const srv = fakeAnthropic(seen);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const dir = tmp('jarvis-pv2-');
    const pv = new Providers(dir, memSecrets());
    const p = pv.save({ name: 'Mock', kind: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, models: 'mock-model-1', apiKey: 'sk-mock-key-777' });
    const store = new Store(dir);
    const o = new Orchestrator({ store, broadcast() {} });
    o.resolveProvider = spec => pv.resolve(spec);
    const chat = store.newChat('p1', 't');
    const cwd = tmp('jarvis-pv-proj-');
    const ctx = { s: { ...store.settings(), builderModel: `p:${p.id}:mock-model-1`, codexModel: `p:${p.id}:mock-model-1`, leanMode: true, liveStreaming: false },
      run: { cancelled: false, kills: new Set(), inbox: [] }, runCost: 0, cwd, projectId: 'p1' };
    const r = await o.claudeStep(chat, ctx, { prompt: 'add a hello function', phase: 'نوشتن کد', round: 1 });
    assert.equal(r.ok, true, r.error);
    assert.match(r.text, /Done/);
    assert.equal(r.costUsd, 0);
    assert.ok(chat[`claudeSession__${p.id}`], 'session stored per connection');
    const msgs = seen.filter(x => x.url.startsWith('/v1/messages'));
    assert.ok(msgs.length >= 1);
    assert.ok(msgs.every(x => x.key === 'sk-mock-key-777' && !/sk-ant-/.test(x.auth)), 'only the connection key is sent');
    assert.ok(chat.messages.some(m => m.name === 'Mock · mock-model-1'), 'messages carry the connection name');
    // the reviewer slot on the same connection (Claude engine, JSON review)
    const rv = await o.oneReview(chat, ctx, { prompt: 'Review the change.', round: 1, engine: 'codex' });
    assert.equal(rv.review && rv.review.verdict, 'pass');
  } finally { srv.close(); }
});

test('review sub-agents run on whatever they are set to (main reviewer, Codex, a Claude model, a connection)', () => {
  const o = new Orchestrator({ store: new Store(tmp('jarvis-sr-')), broadcast() {} });
  o.resolveProvider = spec => /^p:ds:/.test(spec) ? { engine: 'claude', model: 'deepseek-chat' } : /^p:oa:/.test(spec) ? { engine: 'codex', model: 'gpt-x' } : null;
  const s = { reviewer: 'codex', reviewerModel: 'claude-sonnet-5-5' };
  assert.deepEqual(o.subRunner({ model: '' }, s), { engine: 'codex', modelOverride: null });
  assert.deepEqual(o.subRunner({ model: '' }, { ...s, reviewer: 'claude' }), { engine: 'claude', modelOverride: 'claude-sonnet-5-5' });
  assert.deepEqual(o.subRunner({ model: 'engine:codex' }, s), { engine: 'codex', modelOverride: '__codex_default' });
  assert.deepEqual(o.subRunner({ model: 'engine:claude' }, s), { engine: 'claude', modelOverride: null });
  assert.deepEqual(o.subRunner({ model: 'claude-opus-5-5' }, s), { engine: 'claude', modelOverride: 'claude-opus-5-5' });
  assert.deepEqual(o.subRunner({ model: 'p:ds:deepseek-chat' }, s), { engine: 'codex', modelOverride: 'p:ds:deepseek-chat' }); // goes through the connection branch
  assert.deepEqual(o.subRunner({ engine: 'codex' }, s), { engine: 'codex', modelOverride: '__codex_default' }); // pre-1.2 data
  const st = new Store(tmp('jarvis-sr2-'));
  assert.equal(st.saveSubagent({ name: 'db', prompt: 'x', stage: 'review', model: 'p:ds:deepseek-chat' }).model, 'p:ds:deepseek-chat');
  assert.equal(st.saveSubagent({ name: 'bad', prompt: 'x', stage: 'review', model: '"><img>' }).model, '');
  assert.equal(st.saveSubagent({ name: 'helper', prompt: 'x', stage: 'builder', model: 'p:ds:deepseek-chat' }).model, '');
});

test('full connection trial runs the real CLI as builder and reviewer', { timeout: 240000, skip: !agents.CLIS.claude && 'Claude CLI not installed' }, async () => {
  const seen = [];
  const srv = fakeAnthropic(seen);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { spawn } = require('child_process');
  const data = tmp('jarvis-trial-srv-');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, JARVIS_PORT: '0', JARVIS_DATA: data, JARVIS_CLUB_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error(out)), 15000); child.stdout.on('data', d => { out += d; const m = out.match(/localhost:(\d+)\//); if (m) { clearTimeout(t); res(+m[1]); } }); });
    const call = (p, body) => fetch(`http://127.0.0.1:${port}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis': '1' }, body: JSON.stringify(body) }).then(r => r.json());
    const pv = await call('/providers', { name: 'Mock', kind: 'anthropic', baseUrl: `http://127.0.0.1:${srv.address().port}`, models: 'mock-1', apiKey: 'sk-trial-1' });
    const r = await call(`/providers/${pv.id}/trial`, { model: 'mock-1' });
    // the fake API only answers in text (no tool calls), so the builder can't create the file; the reviewer answers JSON
    assert.equal(r.builder.ok, false); assert.match(r.builder.error, /فایل/);
    assert.equal(r.reviewer.ok, true);
    assert.ok(seen.filter(x => x.url.startsWith('/v1/messages')).every(x => x.key === 'sk-trial-1'));
  } finally { child.kill(); srv.close(); }
});
