'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { KB, words, pdfBasic } = require('../lib/kb');

test('knowledge base: indexes a folder, finds Persian and English passages, re-reads only changed files', async () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-docs-'));
  fs.writeFileSync(path.join(docs, 'قرارداد اجاره.md'), 'قرارداد اجاره‌ی آپارتمان تهران.\nمهلت پرداخت اجاره‌بها روز پنجم هر ماه است. ودیعه ۲۰۰ میلیون تومان.');
  fs.writeFileSync(path.join(docs, 'manual.txt'), 'Router manual. To reset the router hold the reset button for 10 seconds.');
  fs.mkdirSync(path.join(docs, 'node_modules')); fs.writeFileSync(path.join(docs, 'node_modules', 'x.txt'), 'اجاره اجاره اجاره');
  fs.writeFileSync(path.join(docs, 'image.png'), 'x');
  const kb = new KB(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-kbdata-')));
  assert.throws(() => kb.addFolder(path.join(docs, 'nope')), /وجود ندارد/);
  kb.addFolder(docs);
  let v = await kb.reindex();
  assert.strictEqual(v.files, 2, 'skips node_modules and other file types');
  const h = kb.search('مهلت پرداخت اجاره كي است؟'); // Arabic kaf/yeh normalised
  assert.strictEqual(h[0].name, 'قرارداد اجاره.md'); assert.match(h[0].text, /پنجم/);
  assert.strictEqual(kb.search('how do I reset the router')[0].name, 'manual.txt');
  assert.deepStrictEqual(kb.search('zzzz'), []);
  const before = kb.docs[path.join(docs, 'manual.txt')].at;
  fs.writeFileSync(path.join(docs, 'قرارداد اجاره.md'), 'مهلت پرداخت روز دهم است.');
  await new Promise(r => setTimeout(r, 20)); await kb.reindex();
  assert.strictEqual(kb.docs[path.join(docs, 'manual.txt')].at, before, 'unchanged file not read again');
  assert.match(kb.search('مهلت پرداخت')[0].text, /دهم/);
  const again = new KB(path.dirname(kb.file).replace(/kb$/, '').replace(/[\/]$/, ''));
  assert.strictEqual(again.search('router')[0].name, 'manual.txt', 'index kept on disk');
  kb.removeFolder(docs); assert.strictEqual(kb.view().files, 0);
  assert.ok(words('کتاب‌های من').length >= 1);
});

test('knowledge base: Word documents and simple PDFs', async () => {
  const zlib = require('zlib');
  const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf (Invoice total 450 dollars) Tj ET', 'latin1'));
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Filter /FlateDecode /Length ' + content.length + ' >>\nstream\n', 'latin1'), content, Buffer.from('\nendstream endobj\n%%EOF', 'latin1')]);
  assert.match(pdfBasic(pdf), /Invoice total 450 dollars/);
});
