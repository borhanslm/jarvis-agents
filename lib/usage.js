// Local usage log: one JSON line per agent step, per model.
// Feeds the home-screen charts. Nothing leaves this computer.
'use strict';
const fs = require('fs');
const path = require('path');

const DAY = 86400000;
// Local calendar day (not UTC): work after local midnight belongs to the new day.
const dayKey = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

class Usage {
  constructor(dir) {
    this.file = path.join(dir, 'usage.jsonl');
    this.rows = [];
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.rows.push(JSON.parse(line)); } catch {}
      }
    } catch {}
  }

  // row: { agent, model, role, chatId, projectId, input, output, cacheRead, cacheWrite, costUsd, mapChars }
  log(row) {
    const r = {
      ts: Date.now(), agent: row.agent, model: row.model || row.agent, role: row.role || null,
      chatId: row.chatId || null, projectId: row.projectId || null,
      input: +row.input || 0, output: +row.output || 0, cacheRead: +row.cacheRead || 0, cacheWrite: +row.cacheWrite || 0,
      costUsd: +row.costUsd || 0, mapChars: +row.mapChars || 0,
    };
    this.rows.push(r);
    fs.appendFile(this.file, JSON.stringify(r) + '\n', () => {});
    return r;
  }

  // Aggregates for the dashboard. projectId optional.
  summary({ days = 14, projectId = null } = {}) {
    const since = Date.now() - days * DAY;
    const rows = this.rows.filter(r => r.ts >= since && (!projectId || r.projectId === projectId));
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) dayList.push(dayKey(Date.now() - i * DAY));
    const byModel = {};
    for (const r of rows) {
      const m = byModel[r.model] || (byModel[r.model] = { model: r.model, agent: r.agent, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, costUsd: 0, steps: 0, days: {} });
      const tok = r.input + r.output + r.cacheRead + r.cacheWrite;
      m.input += r.input; m.output += r.output; m.cacheRead += r.cacheRead; m.cacheWrite += r.cacheWrite;
      m.tokens += tok; m.costUsd += r.costUsd; m.steps++;
      const d = m.days[dayKey(r.ts)] || (m.days[dayKey(r.ts)] = { tokens: 0, costUsd: 0 });
      d.tokens += tok; d.costUsd += r.costUsd;
    }
    const models = Object.values(byModel).sort((a, b) => b.tokens - a.tokens);
    const totals = models.reduce((t, m) => ({
      tokens: t.tokens + m.tokens, costUsd: t.costUsd + m.costUsd, steps: t.steps + m.steps,
      cacheRead: t.cacheRead + m.cacheRead, input: t.input + m.input + m.cacheWrite,
    }), { tokens: 0, costUsd: 0, steps: 0, cacheRead: 0, input: 0 });
    totals.cacheShare = totals.cacheRead + totals.input ? totals.cacheRead / (totals.cacheRead + totals.input) : 0;
    const roles = {};
    for (const r of rows) { const k = r.role || r.agent; roles[k] = (roles[k] || 0) + r.input + r.output + r.cacheRead + r.cacheWrite; }
    const win = (ms, agent) => {
      const since = Date.now() - ms;
      const w = this.rows.filter(r => r.ts >= since && (!agent || r.agent === agent) && (!projectId || r.projectId === projectId));
      return { tokens: w.reduce((t, r) => t + r.input + r.output + r.cacheRead + r.cacheWrite, 0), output: w.reduce((t, r) => t + r.output, 0), steps: w.length };
    };
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const recent = { today: win(Date.now() - startOfDay.getTime(), 'claude'), last5h: win(5 * 3600000, 'claude') };
    return { days: dayList, models, totals, roles, rows: rows.length, recent };
  }
}

module.exports = { Usage };
