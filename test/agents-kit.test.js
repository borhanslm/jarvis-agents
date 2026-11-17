// Agent builder: templates, import/export, versions, the assistant stage.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const kit = require('../lib/agent-kit');
const { Store } = require('../lib/store');

test('20+ templates across the three kinds, icon names only (no emoji)', () => {
  assert.ok(kit.TEMPLATES.length >= 20);
  for (const s of ['assistant', 'builder', 'review']) assert.ok(kit.TEMPLATES.some(t => t.stage === s));
  for (const t of kit.TEMPLATES) { assert.match(t.icon, /^[a-z0-9-]+$/); assert.match(t.name, /^[a-z0-9-]+$/); assert.ok(t.prompt.length > 40); }
});

test('import: Claude Code agent .md and our JSON; export round-trips', () => {
  const md = kit.parseImport('---\nname: sql-helper\ndescription: helps with SQL\nmodel: sonnet\n---\nYou write SQL.\n');
  assert.deepStrictEqual([md[0].name, md[0].prompt, md[0].model, md[0].stage], ['sql-helper', 'You write SQL.', '', 'builder']);
  const back = kit.parseImport(kit.toMarkdown({ name: 'x', description: 'd', prompt: 'You do x.', stage: 'assistant', icon: 'globe', model: 'p:deepseek:deepseek-chat' }))[0];
  assert.deepStrictEqual([back.stage, back.icon, back.model], ['assistant', 'globe', 'p:deepseek:deepseek-chat']);
  assert.strictEqual(kit.parseImport('[{"name":"a","prompt":"You a."},{"name":"b","prompt":"You b."}]').length, 2);
  assert.throws(() => kit.parseImport('hello'), /قالب/);
});

test('store: assistant stage, icon names, versions on change, legacy emoji migrated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-ag-'));
  fs.writeFileSync(path.join(dir, 'subagents.json'), JSON.stringify([{ id: 'old', name: 'old', icon: '🛡', engine: 'claude', stage: 'review', enabled: true, description: '', prompt: 'You review.' }]));
  const s = new Store(dir);
  assert.strictEqual(s.subagents()[0].icon, 'shield');
  const a = s.saveSubagent({ name: 'translator', icon: 'languages', stage: 'assistant', prompt: 'You translate.' });
  assert.strictEqual(a.stage, 'assistant'); assert.strictEqual(a.icon, 'languages');
  s.saveSubagent({ ...a, prompt: 'You translate carefully.' });
  s.saveSubagent({ ...s.subagent('translator'), enabled: false }); // no content change: no new version
  const v = s.subagent('translator');
  assert.strictEqual(v.versions.length, 1);
  assert.strictEqual(v.versions[0].prompt, 'You translate.');
  assert.ok(!('versions' in v.versions[0]));
});
