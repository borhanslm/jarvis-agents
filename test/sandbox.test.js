'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const sbx = require('../lib/sandbox');

test('sandbox: secrets are removed from the environment', () => {
  const e = sbx.cleanEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'a', GITHUB_TOKEN: 'b', MY_SECRET: 'c', DB_PASSWORD: 'd', HOME: 'h', FOO: 'f' });
  assert.deepStrictEqual([e.PATH, e.HOME, e.FOO, e.CI], ['x', 'h', 'f', '1']);
  for (const k of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'MY_SECRET', 'DB_PASSWORD']) assert.ok(!(k in e), k);
});
test('sandbox: copy mode runs on a copy, cannot touch the project, keeps node_modules', async () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-sbx-proj-'));
  fs.writeFileSync(path.join(p, 'a.txt'), 'orig');
  fs.mkdirSync(path.join(p, 'node_modules', 'dep'), { recursive: true }); fs.writeFileSync(path.join(p, 'node_modules', 'dep', 'i.js'), 'x');
  fs.mkdirSync(path.join(p, '.git')); fs.writeFileSync(path.join(p, '.git', 'HEAD'), 'ref');
  const cmd = `node -e "const fs=require('fs');fs.writeFileSync('a.txt','changed');fs.unlinkSync('a.txt');console.log(fs.existsSync('node_modules/dep/i.js'), fs.existsSync('.git'), process.env.SBX_TEST_TOKEN||'none')"`;
  process.env.SBX_TEST_TOKEN = 'leak';
  const r = await sbx.run(p, cmd, { mode: 'copy', timeoutMs: 30000 }).promise;
  delete process.env.SBX_TEST_TOKEN;
  assert.ok(r.ok, r.output); assert.strictEqual(r.sandbox, 'copy');
  assert.match(r.output, /true false none/);
  assert.strictEqual(fs.readFileSync(path.join(p, 'a.txt'), 'utf8'), 'orig');
  assert.ok(fs.existsSync(path.join(p, 'node_modules', 'dep', 'i.js')), 'real node_modules must survive cleanup');
  fs.rmSync(p, { recursive: true, force: true });
});
test('sandbox: failing command is reported; unavailable modes explain themselves', async () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-sbx-proj-'));
  const r = await sbx.run(p, 'node -e "process.exit(3)"', { mode: 'copy' }).promise;
  assert.strictEqual(r.ok, false); assert.strictEqual(r.exitCode, 3);
  assert.strictEqual(sbx.pick('off'), 'off'); assert.ok(['docker', 'copy'].includes(sbx.pick('auto')));
  if (!sbx.status().wsb) assert.throws(() => sbx.pick('wsb'), /Windows Sandbox/);
  fs.rmSync(p, { recursive: true, force: true });
});
