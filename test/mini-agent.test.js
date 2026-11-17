'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCoder, inside } = require('../lib/mini-agent');

const proj = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-mini-')); fs.writeFileSync(path.join(d, 'math.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n'); fs.mkdirSync(path.join(d, 'node_modules')); return d; };
const scripted = moves => { let i = 0; const seen = []; return { seen, llm: async o => { seen.push(o); return { text: typeof moves[i] === 'string' ? moves[i++] : JSON.stringify(moves[i++] || { tool: 'done', text: 'end' }), usage: { input: 10, output: 5 } }; } }; };

test('mini agent: a chat-only model fixes a bug through the tools', async () => {
  const d = proj();
  const s = scripted([
    { thought: 'look', tool: 'list' },
    { tool: 'search', query: 'a - b' },
    { tool: 'read', path: 'math.js' },
    { tool: 'edit', path: 'math.js', old: 'return a - b;', new: 'return a + b;' },
    { tool: 'write', path: 'test/math.test.js', content: "const { add } = require('../math');\nrequire('assert').strictEqual(add(2, 3), 5);\n" },
    { tool: 'run', command: 'node --test test/math.test.js' },
    { tool: 'run', command: 'del math.js' },
    { tool: 'done', text: 'Fixed add() and added a test.' },
  ]);
  const r = await runCoder({ llm: s.llm, cwd: d, prompt: 'fix add', allowed: ['node --test', 'npm test'] });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.text, 'Fixed add() and added a test.');
  assert.match(fs.readFileSync(path.join(d, 'math.js'), 'utf8'), /a \+ b/);
  assert.deepStrictEqual(r.editedFiles.sort(), ['math.js', path.join('test', 'math.test.js')].sort());
  const results = s.seen[s.seen.length - 1].messages.filter(m => m.role === 'user').map(m => m.content);
  assert.ok(!results[1].includes('node_modules'), 'skips node_modules');
  assert.match(results[2], /math\.js:2: return a - b;/);
  assert.match(results[6], /exit code 0/, 'allowed command ran');
  assert.match(results[7], /not allowed/, 'other commands refused');
  assert.ok(fs.existsSync(path.join(d, 'math.js')));
  assert.strictEqual(r.usage.input, 80);
});

test('mini agent: stays in the project, testers cannot write, plain JSON verdicts are accepted', async () => {
  const d = proj();
  assert.throws(() => inside(d, '../x'), /outside/);
  assert.throws(() => inside(d, '.git/config'), /off limits/);
  let s = scripted([{ tool: 'write', path: 'math.js', content: 'x' }, { tool: 'read', path: '../../etc/passwd' }, { tool: 'run', command: 'npm test && del /q *' }, '```json\n{"verdict":"fail","summary":"add subtracts","bugs":[]}\n```']);
  const r = await runCoder({ llm: s.llm, cwd: d, prompt: 'review', role: 'reviewer', allowed: ['npm test'] });
  assert.match(fs.readFileSync(path.join(d, 'math.js'), 'utf8'), /a - b/, 'reviewer did not write');
  const res = s.seen[s.seen.length - 1].messages.filter(m => m.role === 'user').map(m => m.content);
  assert.match(res[1], /must not change files/); assert.match(res[2], /outside the project/); assert.match(res[3], /not allowed/);
  assert.ok(r.ok); assert.match(r.text, /"verdict":"fail"/);
  assert.ok(!/"tool": "write"/.test(s.seen[0].system), 'reviewers are not offered write/edit');
});

test('team: chat-only models go through the coding agent; ChatGPT through Codex', async () => {
  const { Orchestrator } = require('../lib/orchestrator');
  const o = Object.create(Orchestrator.prototype);
  o.chatLLM = async () => ({ text: '{"tool":"done","text":"ok"}' });
  o.resolveProvider = spec => spec === 'p:gemini:gemini-pro' ? { id: 'gemini', name: 'Gemini', label: 'Gemini · gemini-pro', chatOnly: true, hasKey: true, prices: {} } : spec === 'p:ds:x' ? { engine: 'claude' } : null;
  assert.strictEqual(o.llmOnly('p:gemini:gemini-pro'), true);
  assert.strictEqual(o.llmOnly('ollama:qwen3'), true);
  assert.strictEqual(o.llmOnly('kimi'), true);
  assert.strictEqual(o.llmOnly('p:ds:x'), false);
  assert.strictEqual(o.llmOnly('claude-sonnet-5-5'), false);
  // builder step on Gemini
  const posts = []; const chat = { id: 'c', title: 't', cost: { claudeUsd: 0 }, touchedFiles: [], messages: [] };
  Object.assign(o, { agentState: { claude: {} }, post: (c, m) => posts.push(m), drainInbox: () => '', withHints: (c, k, p) => p, agentBusy() {}, broadcast() {}, store: { saveChat() {}, chatSummary: () => ({}) }, usage: null });
  const ctx = { s: { builderModel: 'p:gemini:gemini-pro', claudeAllowedBash: [] }, cwd: proj(), run: { kills: new Set(), cancelled: false }, runCost: 0 };
  const r = await o.claudeStep(chat, ctx, { prompt: 'build', phase: 'ساخت', round: 1, role: 'builder' });
  assert.ok(r.ok); assert.strictEqual(r.text, 'ok');
  assert.ok(posts.some(p => /Gemini · gemini-pro/.test(p.text || '')));
});
