// Task queue: several jobs (any project) that run one after another — now or from a set
// time (e.g. overnight). When the batch is finished a summary goes to the phone.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODES = ['team', 'smart', 'audit', 'plan', 'claude', 'codex'];

class TaskQueue {
  // runJob(job) -> Promise<{ status, chatId }>; onBatchDone(jobs)
  constructor(dataDir, { runJob, onBatchDone, onChange }) {
    this.file = path.join(dataDir, 'queue.json');
    this.runJob = runJob; this.onBatchDone = onBatchDone; this.onChange = onChange || (() => {});
    try { this.jobs = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.jobs = []; }
    for (const j of this.jobs) if (j.status === 'running') j.status = 'error'; // app restarted mid-job
    this.busy = false;
    this.timer = setInterval(() => this.tick(), 30000);
    if (this.timer.unref) this.timer.unref();
  }
  _save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.jobs, null, 2)); fs.renameSync(this.file + '.tmp', this.file); this.onChange(this.jobs); }
  all() { return this.jobs; }

  // at: '' = as soon as possible, or 'HH:MM' = the next time the clock shows it
  add({ projectId, text, mode, at }) {
    const t = String(text || '').trim();
    if (!t) throw new Error('متن کار خالی است');
    if (!projectId) throw new Error('پروژه را انتخاب کنید');
    let startAt = Date.now();
    if (at) {
      const m = String(at).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (!m) throw new Error('ساعت شروع باید به شکل HH:MM باشد');
      const d = new Date(); d.setHours(+m[1], +m[2], 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      startAt = d.getTime();
    }
    const j = { id: crypto.randomUUID().slice(0, 8), projectId, text: t.slice(0, 20000), mode: MODES.includes(mode) ? mode : 'team', startAt, status: 'pending', createdAt: Date.now() };
    this.jobs.push(j);
    this._save();
    setImmediate(() => this.tick());
    return j;
  }
  remove(id) {
    const j = this.jobs.find(x => x.id === id);
    if (j && j.status === 'running') throw new Error('این کار در حال اجراست؛ از داخل گفتگویش متوقفش کنید');
    this.jobs = this.jobs.filter(x => x.id !== id);
    this._save();
  }
  clearFinished() { this.jobs = this.jobs.filter(j => ['pending', 'running'].includes(j.status)); this._save(); }

  async tick() {
    if (this.busy) return;
    const next = this.jobs.filter(j => j.status === 'pending' && j.startAt <= Date.now()).sort((a, b) => a.startAt - b.startAt)[0];
    if (!next) return;
    this.busy = true;
    const batch = [];
    try {
      for (let j = next; j; j = this.jobs.filter(x => x.status === 'pending' && x.startAt <= Date.now()).sort((a, b) => a.startAt - b.startAt)[0]) {
        j.status = 'running'; j.startedAt = Date.now(); this._save();
        try { const r = await this.runJob(j); j.status = r.status || 'done'; j.chatId = r.chatId; }
        catch (e) { j.status = 'error'; j.error = String(e.message || e).slice(0, 300); }
        j.finishedAt = Date.now();
        batch.push(j);
        this._save();
      }
    } finally { this.busy = false; }
    if (batch.length && this.onBatchDone) { try { await this.onBatchDone(batch); } catch (e) { console.error('queue notify', e); } }
  }
}

module.exports = { TaskQueue };
