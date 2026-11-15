// Personal and work tasks ("start the CRM project today", "buy bread"). Voice, the panel and
// later Telegram add to the same list. Stored in DATA/tasks.json.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRI = ['low', 'normal', 'high'];

class Tasks {
  constructor(dataDir, { onChange } = {}) {
    this.file = path.join(dataDir, 'tasks.json');
    this.onChange = onChange || (() => {});
    try { this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.list = []; }
  }
  _save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.list, null, 2)); fs.renameSync(this.file + '.tmp', this.file); this.onChange(this.list); }
  all() { return this.list; }
  get(id) { return this.list.find(t => t.id === id) || null; }

  static clean(b, old = {}) {
    const title = String(b.title ?? old.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!title) throw new Error('عنوان تسک خالی است');
    let due = b.due === undefined ? old.due ?? null : b.due;
    if (due != null && due !== '') { const d = typeof due === 'number' ? due : Date.parse(due); due = Number.isFinite(d) ? d : null; } else due = null;
    return {
      title, notes: String(b.notes ?? old.notes ?? '').slice(0, 4000), due,
      priority: PRI.includes(b.priority) ? b.priority : old.priority || 'normal',
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
    Object.assign(t, Tasks.clean(b, t), { updatedAt: Date.now() }, b.done && !t.doneAt ? { doneAt: Date.now() } : {});
    this._save(); return t;
  }
  remove(id) { this.list = this.list.filter(t => t.id !== id); this._save(); }
  // open tasks due today or overdue, plus open tasks without a date
  today(now = Date.now()) {
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    return this.list.filter(t => !t.done && (t.due == null || t.due <= end.getTime()));
  }
}

module.exports = { Tasks };
