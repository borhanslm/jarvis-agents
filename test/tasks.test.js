// Tasks: reminders, snooze, repeating tasks.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Tasks, nextDue } = require('../lib/tasks');
const mk = () => new Tasks(fs.mkdtempSync(path.join(os.tmpdir(), 'jv-tasks-')));

test('reminder fires once at (due - remindBefore), not before', () => {
  const t = mk(); const now = Date.parse('2026-11-15T09:00:00');
  const a = t.add({ title: 'جلسه', due: now + 30 * 60000, remindBefore: 15 });
  assert.strictEqual(t.dueReminders(now).length, 0);
  assert.deepStrictEqual(t.dueReminders(now + 15 * 60000).map(x => x.id), [a.id]);
  t.markReminded(a.id);
  assert.strictEqual(t.dueReminders(now + 16 * 60000).length, 0);
});

test('snooze reminds again later; a new date reminds again', () => {
  const t = mk(); const now = Date.parse('2026-11-15T09:00:00');
  const a = t.add({ title: 'نان بخرم', due: now });
  t.markReminded(a.id);
  t.snooze(a.id, 10, now);
  assert.strictEqual(t.dueReminders(now + 5 * 60000).length, 0);
  assert.strictEqual(t.dueReminders(now + 10 * 60000).length, 1);
  t.markReminded(a.id);
  t.update(a.id, { due: now + 3600e3 });
  assert.strictEqual(t.dueReminders(now + 3600e3).length, 1);
});

test('very old reminders (app was off for a day) are not fired', () => {
  const t = mk(); const now = Date.parse('2026-11-15T09:00:00');
  t.add({ title: 'old', due: now - 2 * 864e5 });
  assert.strictEqual(t.dueReminders(now).length, 0);
});

test('repeating tasks move to the next date when done', () => {
  const t = mk(); const now = Date.parse('2026-11-15T09:00:00'); // Sunday
  const d = t.add({ title: 'ورزش', due: Date.parse('2026-11-15T07:00:00'), repeat: 'daily' });
  const r = t.complete(d.id, now);
  assert.strictEqual(r.done, false);
  assert.strictEqual(new Date(r.due).toISOString(), new Date('2026-11-16T07:00:00').toISOString());
  // weekdays skip Friday (Thursday -> Saturday)
  assert.strictEqual(new Date(nextDue(Date.parse('2026-11-19T08:00:00'), 'weekdays', Date.parse('2026-11-19T09:00:00'))).getDay(), 6);
  // monthly keeps the day, clamps at month end (Jan 31 -> Feb 28)
  assert.strictEqual(new Date(nextDue(Date.parse('2027-01-31T08:00:00'), 'monthly', Date.parse('2027-01-31T09:00:00'))).getDate(), 28);
  // one-off tasks are simply done
  const o = t.add({ title: 'one', due: now });
  assert.strictEqual(t.complete(o.id, now).done, true);
});
