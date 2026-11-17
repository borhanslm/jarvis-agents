'use strict';
const test = require('node:test');
const assert = require('node:assert');
const xs = require('../lib/ext-search');
const tools = require('../lib/skill-tools');

const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
function fakeNet() {
  const seen = [];
  const f = async url => {
    seen.push(url);
    if (url.includes('registry.modelcontextprotocol.io')) return res({ servers: [
      { server: { name: 'io.github.acme/notion', title: 'Notion', description: 'Notion pages', version: '1.2.0', repository: { url: 'https://github.com/acme/notion' }, packages: [{ registryType: 'npm', identifier: '@acme/notion-mcp', version: '1.2.0', transport: { type: 'stdio' }, environmentVariables: [{ name: 'NOTION_TOKEN', description: 'Notion token', isSecret: true }, { name: 'DEBUG', description: 'x' }] }] } },
      { server: { name: 'io.github.acme/notion', version: '1.1.0', packages: [{ registryType: 'npm', identifier: '@acme/notion-mcp' }] } },
      { server: { name: 'com.x/remote', description: 'remote', remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer {key}', isSecret: true }] }] } },
      { server: { name: 'com.x/python-only', packages: [{ registryType: 'pypi', identifier: 'x' }] } },
      { server: { name: 'com.x/evil', packages: [{ registryType: 'npm', identifier: 'x; rm -rf /' }] } },
      { server: { name: 'com.x/old', packages: [{ registryType: 'npm', identifier: 'old' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } },
    ] });
    if (url.includes('/repos/anthropics/skills/git/trees')) return res({ tree: [{ type: 'blob', path: 'skills/pdf/SKILL.md', size: 100 }, { type: 'blob', path: 'skills/pdf/scripts/a.py', size: 50 }, { type: 'blob', path: 'skills/docx/SKILL.md', size: 90 }] });
    if (url.includes('/search/repositories') && url.includes('plugin')) return res({ items: [{ full_name: 'bob/notion-plugin', description: 'plugin', stargazers_count: 5 }] });
    if (url.includes('/search/repositories')) return res({ items: [{ full_name: 'amy/notion-skill', description: 'skill', stargazers_count: 9, default_branch: 'main' }, { full_name: 'old/arch', archived: true }] });
    if (url.includes('marketplace.json')) return res({ plugins: [{ name: 'notion', description: 'Notion workspace' }, { name: 'other', description: 'x' }] });
    if (url.includes('raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md')) return res('---\nname: pdf\ndescription: PDF things\n---\nDo PDF things.');
    if (url.includes('raw.githubusercontent.com/anthropics/skills/main/skills/pdf/scripts/a.py')) return res('print(1)');
    return res({}, 404);
  };
  return { f, seen };
}

test('internet search: MCP registry entries become reviewable connectors; unsafe or unsupported ones are left out', async () => {
  const n = fakeNet();
  const { items } = await xs.search('notion', 'all', n.f);
  const mcp = items.filter(i => i.kind === 'mcp');
  assert.deepStrictEqual(mcp.map(i => i.id), ['io.github.acme/notion', 'com.x/remote'], 'latest only; no python, deleted or odd package names');
  assert.deepStrictEqual(mcp[0].install, { type: 'stdio', command: 'npx', args: ['-y', '@acme/notion-mcp@1.2.0'], secrets: [{ name: 'NOTION_TOKEN', label: 'Notion token' }] });
  assert.deepStrictEqual(mcp[1].install.secrets, [{ name: 'Authorization', label: 'Authorization', bearer: true }]);
  assert.strictEqual(items[0].source, 'مارکت‌پلیس رسمی Claude', 'official sources first');
  assert.ok(items.some(i => i.kind === 'skill' && i.id === 'amy/notion-skill'));
  assert.ok(!items.some(i => i.id === 'old/arch'));
  assert.ok(items.some(i => i.kind === 'plugin' && i.install.url === 'bob/notion-plugin'));
  assert.ok(n.seen.every(u => !/netninja|spstore/i.test(u)), 'nothing personal in the requests');
  await assert.rejects(xs.search('x', 'all', n.f), /جستجو/);
});

test('internet search: an official skill is downloaded and shown for review before install', async () => {
  const n = fakeNet();
  const { items } = await xs.search('pdf', 'skill', n.f);
  const pdf = items.find(i => i.dir === 'skills/pdf');
  assert.ok(pdf && pdf.source === 'مجموعه‌ی رسمی Anthropic');
  const files = await xs.downloadSkill(pdf.repo, pdf.branch, pdf.dir, n.f);
  assert.deepStrictEqual(files.map(f => f.path).sort(), ['SKILL.md', 'scripts/a.py']);
  const st = tools.stageFiles(files, 'https://github.com/anthropics/skills/tree/main/skills/pdf');
  assert.strictEqual(st.name, 'pdf'); assert.deepStrictEqual(st.runnable, ['scripts/a.py']);
  tools.cancelUpload(st.token);
  assert.throws(() => tools.stageFiles([{ path: '../evil/SKILL.md', data: Buffer.from('x') }], ''), /نامعتبر/);
  await assert.rejects(xs.downloadSkill('a/b', 'main', '../x', n.f), /نامعتبر/);
  await assert.rejects(xs.repoSkills('not a repo', 'main', n.f), /نامعتبر/);
});
