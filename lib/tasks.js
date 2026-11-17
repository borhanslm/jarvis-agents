// Personal and work tasks ("start the CRM project today", "buy bread"). Voice, the panel and
// Telegram add to the same list. Stored in DATA/tasks.json.
// Reminders: a task with a date reminds at (due - remindBefore); "later" snoozes it; repeating
// tasks (daily / weekdays / weekly / monthly) move to their next date when done.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRI = ['low', 'normal', 'high'];
const CAT = ['life', 'work'];
const REPEAT = ['', 'daily', 'weekdays', 'weekly', 'monthly'];

// next date after `from` for a repeating task (keeps the time of day)
function nextDue(due, repeat, now = Date.now()) {
  if (!due || !repeat) return null;
  const d = new Date(due);
  const step = () => {
    if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else if (repeat === 'monthly') { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
    else if (repeat === 'weekdays') { do d.setDate(d.getDate() + 1); while (d.getDay() === 5); } // Friday off (Iran); Sat–Thu are work days
  };
  step();
  while (d.getTime() <= now) step();
  return d.getTime();
}

class Tasks {
  constructor(dataDir, { onChange } = {}) {
    this.file = path.join(dataDir, 'tasks.json');
    this.onChange = onChange || (() => {});
    try { this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.list = []; }
    if (!Array.isArray(this.list)) this.list = [];
  }
  _save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.list, null, 2)); fs.renameSync(this.file + '.tmp', this.file); this.onChange(this.list); }
  all() { return this.list; }
  get(id) { return this.list.find(t => t.id === id) || null; }

  static clean(b, old = {}) {
    const title = String(b.title ?? old.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!title) throw new Error('عنوان تسک خالی است');
    let due = b.due === undefined ? old.due ?? null : b.due;
    if (due != null && due !== '') { const d = typeof due === 'number' ? due : Date.parse(due); due = Number.isFinite(d) ? d : null; } else due = null;
    const rb = b.remindBefore === undefined ? old.remindBefore ?? 0 : Math.max(0, Math.min(10080, Math.round(+b.remindBefore || 0)));
    return {
      title, notes: String(b.notes ?? old.notes ?? '').slice(0, 4000), due,
      priority: PRI.includes(b.priority) ? b.priority : old.priority || 'normal',
      category: CAT.includes(b.category) ? b.category : old.category || 'life',
      repeat: REPEAT.includes(b.repeat) ? b.repeat : old.repeat || '',
      remindBefore: rb,
      done: b.done === undefined ? !!old.done : !!b.done,
      projectId: typeof (b.projectId ?? old.projectId) === 'string' ? (b.projectId ?? old.projectId) : null,
    };
  }
  add(b, source = 'ui') {
    const t = { id: crypto.randomUUID().slice(0, 8), ...Tasks.clean(b), source: String(source).slice(0, 20), createdAt: Date.now() };
    this.list.push(t); this._save(); return t;
  }
  update(id, b) {
    const t = this.get(id); if (!t) throw new Error('تسک پیدا نشد');
    // finishing a repeating task moves it to its next date instead
    if (b.done && !t.done && (b.repeat ?? t.repeat) && (b.due ?? t.due)) return this.complete(id);
    const dueBefore = t.due;
    Object.assign(t, Tasks.clean(b, t), { updatedAt: Date.now() }, b.done && !t.doneAt ? { doneAt: Date.now() } : {});
    if (!t.done) delete t.doneAt;
    if (t.due !== dueBefore) { delete t.remindedFor; delete t.snoozeUntil; } // new date: remind again
    this._save(); return t;
  }
  complete(id, now = Date.now()) {
    const t = this.get(id); if (!t) throw new Error('تسک پیدا نشد');
    const nd = nextDue(t.due, t.repeat, now);
    if (nd) { t.lastDoneAt = now; t.due = nd; delete t.remindedFor; delete t.snoozeUntil; t.done = false; }
    else { t.done = true; t.doneAt = now; }
    t.updatedAt = now; this._save(); return t;
  }
  remove(id) { this.list = this.list.filter(t => t.id !== id); this._save(); }
  // open tasks due today or overdue, plus open tasks without a date
  today(now = Date.now()) {
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    return this.list.filter(t => !t.done && (t.due == null || t.due <= end.getTime()));
  }

  // ---- reminders ----
  remindAt(t) { return t.snoozeUntil || (t.due - (t.remindBefore || 0) * 60000); }
  // tasks whose reminder time has come and that were not reminded for this date / snooze yet
  dueReminders(now = Date.now()) {
    return this.list.filter(t => !t.done && t.due && this.remindAt(t) <= now && t.remindedFor !== this.remindAt(t)
      && now - this.remindAt(t) < 12 * 3600e3); // don't fire very old ones after a long shutdown
  }
  markReminded(id) { const t = this.get(id); if (!t) return null; t.remindedFor = this.remindAt(t); this._save(); return t; }
  snooze(id, minutes = 10, now = Date.now()) {
    const t = this.get(id); if (!t) throw new Error('تسک پیدا نشد');
    t.snoozeUntil = now + Math.max(1, Math.min(10080, +minutes || 10)) * 60000; delete t.remindedFor;
    this._save(); return t;
  }
}

module.exports = { Tasks, nextDue, REPEAT, CAT };
