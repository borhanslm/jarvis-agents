// Workflows: small graphs of steps that JARVIS runs on its own.
//   start → ask the AI → ask me → if … → hand to the agent team → approve → wait → send to my phone → end
// Each step's output can be used later with {{last}}, {{input}} or {{n.<step id>}}.
// Runs are saved; a run waits for the user at "ask me" / "approve" (panel or Telegram), and can be
// paused, resumed or stopped. Stored in DATA/workflows.json and DATA/workflow-runs.json.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = {
  start:     { label: 'شروع', outs: ['next'] },
  llm:       { label: 'هوش مصنوعی', outs: ['next'] },      // config: { prompt, model }
  agent:     { label: 'تیم ایجنت‌ها', outs: ['next', 'fail'] }, // { projectId, task, mode }
  ask:       { label: 'سؤال از من', outs: ['next'] },      // { question }
  approve:   { label: 'تأیید من', outs: ['yes', 'no'] },   // { question }
  condition: { label: 'شرط', outs: ['yes', 'no'] },        // { value, op: contains|equals|regex|empty|ai, arg }
  task:      { label: 'افزودن تسک', outs: ['next'] },      // { title, due, category }
  notify:    { label: 'پیام به گوشی', outs: ['next'] },    // { text }
  http:      { label: 'دریافت از وب', outs: ['next', 'fail'] }, // { url }  (GET, https only)
  delay:     { label: 'صبر', outs: ['next'] },             // { minutes }
  end:       { label: 'پایان', outs: [] },
};
const MAX_STEPS = 200;

const uid = () => crypto.randomUUID().slice(0, 8);
const tmpl = (s, ctx) => String(s || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
  if (k === 'last') return ctx.last ?? '';
  if (k === 'input') return ctx.input ?? '';
  if (k === 'date') return new Date().toLocaleDateString('fa-IR', { dateStyle: 'full' });
  const m = /^n\.([\w-]+)$/.exec(k); if (m) return ctx.out[m[1]] ?? '';
  return '';
});

function validate(w) {
  const nodes = Array.isArray(w.nodes) ? w.nodes : [];
  const edges = Array.isArray(w.edges) ? w.edges : [];
  const ids = new Set();
  const clean = nodes.slice(0, 80).map(n => {
    const type = TYPES[n.type] ? n.type : null; if (!type) throw new Error('نوع گره نامعتبر: ' + n.type);
    let id = String(n.id || uid()).replace(/[^\w-]/g, '').slice(0, 24) || uid();
    while (ids.has(id)) id = uid();
    ids.add(id);
    const c = n.config && typeof n.config === 'object' ? n.config : {};
    const config = Object.fromEntries(Object.entries(c).filter(([k]) => /^\w{1,30}$/.test(k)).map(([k, v]) => [k, typeof v === 'number' ? v : String(v ?? '').slice(0, 8000)]));
    return { id, type, x: Math.round(+n.x || 0), y: Math.round(+n.y || 0), title: String(n.title || '').slice(0, 80), config };
  });
  if (clean.filter(n => n.type === 'start').length !== 1) throw new Error('ورک‌فلو باید دقیقاً یک گره «شروع» داشته باشد');
  const cleanEdges = edges.slice(0, 200).filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to).map(e => {
    const from = clean.find(n => n.id === e.from);
    const port = TYPES[from.type].outs.includes(e.port) ? e.port : TYPES[from.type].outs[0];
    return { from: e.from, to: e.to, port };
  }).filter(e => e.port);
  return { nodes: clean, edges: cleanEdges };
}

class Workflows {
  /**
   * deps: chat(opts)->{text}, runTeam({projectId, task, mode, signal})->{ok, status, report, chatId},
   *       addTask(b)->task, notify(text)->Promise, ask(run, node, question, kind)  (tell the user: panel + Telegram)
   *       defaultModel()->spec, onEvent(ev)
   */
  constructor(dir, deps) {
    this.file = path.join(dir, 'workflows.json');
    this.runsFile = path.join(dir, 'workflow-runs.json');
    this.d = deps;
    this.list = this._read(this.file); this.runs = this._read(this.runsFile);
    this.live = new Map(); // runId -> { ctl, wake }
    // runs that were in progress when the app closed can be resumed by hand
    for (const r of this.runs) if (['running', 'waiting'].includes(r.status)) { r.status = 'paused'; r.note = 'برنامه بسته شد؛ با «ادامه» از همان گره ادامه می‌دهد.'; }
  }
  _read(f) { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } }
  _save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.list, null, 1)); fs.renameSync(this.file + '.tmp', this.file); }
  _saveRuns() { if (this.runs.length > 200) this.runs.splice(0, this.runs.length - 200); clearTimeout(this._rt); this._rt = setTimeout(() => { try { fs.writeFileSync(this.runsFile + '.tmp', JSON.stringify(this.runs)); fs.renameSync(this.runsFile + '.tmp', this.runsFile); } catch {} }, 300); }
  _emit(ev) { try { this.d.onEvent && this.d.onEvent(ev); } catch {} }

  all() { return this.list.map(w => ({ ...w, lastRun: this.runs.filter(r => r.workflowId === w.id).slice(-1)[0] || null })); }
  get(id) { return this.list.find(w => w.id === id) || null; }
  save(b) {
    const g = validate(b);
    let w = b.id ? this.get(b.id) : null;
    if (!w) { w = { id: uid(), createdAt: Date.now() }; this.list.push(w); }
    Object.assign(w, { name: String(b.name || 'ورک‌فلوی تازه').slice(0, 80), desc: String(b.desc || '').slice(0, 500), ...g,
      schedule: /^([01]\d|2[0-3]):[0-5]\d$/.test(b.schedule || '') ? b.schedule : '', updatedAt: Date.now() });
    this._save(); return w;
  }
  remove(id) { this.list = this.list.filter(w => w.id !== id); this._save(); }
  runsOf(id) { return this.runs.filter(r => !id || r.workflowId === id).slice(-30).reverse(); }
  run(id) { return this.runs.find(r => r.id === id) || null; }

  start(workflowId, input = '') {
    const w = this.get(workflowId); if (!w) throw new Error('ورک‌فلو پیدا نشد');
    const startNode = w.nodes.find(n => n.type === 'start');
    const r = { id: uid(), workflowId, name: w.name, status: 'running', input: String(input || '').slice(0, 8000), at: startNode.id, ctx: { input: String(input || ''), last: String(input || ''), out: {} }, steps: [], startedAt: Date.now(), count: 0 };
    this.runs.push(r); this._saveRuns();
    this._go(r);
    return r;
  }
  _go(r) {
    const ctl = new AbortController();
    this.live.set(r.id, { ctl });
    this._loop(r, ctl.signal).catch(e => { r.status = 'error'; r.error = e.message; }).finally(() => { this.live.delete(r.id); r.endedAt = r.status === 'paused' || r.status === 'waiting' ? undefined : Date.now(); this._saveRuns(); this._emit({ type: 'wfRun', run: this.view(r) }); });
  }
  view(r) { const { ctx, ...rest } = r; return { ...rest, last: String(ctx.last || '').slice(0, 2000) }; }

  async _loop(r, signal) {
    const w = this.get(r.workflowId); if (!w) throw new Error('ورک‌فلو حذف شده است');
    r.status = 'running'; this._emit({ type: 'wfRun', run: this.view(r) });
    while (r.at && r.status === 'running') {
      if (signal.aborted) return;
      if (++r.count > MAX_STEPS) throw new Error('بیش از ' + MAX_STEPS + ' قدم — احتمالاً حلقه‌ی بی‌پایان');
      const node = w.nodes.find(n => n.id === r.at); if (!node) throw new Error('گره پیدا نشد: ' + r.at);
      const step = { nodeId: node.id, type: node.type, title: node.title || TYPES[node.type].label, status: 'running', startedAt: Date.now() };
      r.steps.push(step); this._emit({ type: 'wfRun', run: this.view(r) });
      let port;
      try { port = await this._exec(node, r, signal); if (r.status !== 'running') { r.steps.pop(); r.count--; return; } } // paused/stopped meanwhile: redo this step on resume
      catch (e) {
        if (signal.aborted) { step.status = 'stopped'; return; }
        step.status = 'error'; step.error = e.message; step.ms = Date.now() - step.startedAt;
        if (TYPES[node.type].outs.includes('fail')) port = 'fail';
        else { r.status = 'error'; r.error = (node.title || TYPES[node.type].label) + ': ' + e.message; return; }
      }
      if (port === 'WAIT') { step.status = 'waiting'; r.status = 'waiting'; this._saveRuns(); this._emit({ type: 'wfRun', run: this.view(r) }); return; }
      if (step.status === 'running') step.status = 'done';
      step.ms = Date.now() - step.startedAt;
      step.output = String(r.ctx.out[node.id] ?? '').slice(0, 1500);
      if (port) step.port = port;
      const next = w.edges.find(e => e.from === node.id && e.port === port);
      r.at = next ? next.to : null;
      this._saveRuns();
    }
    if (r.status === 'running') { r.status = 'done'; r.at = null; }
  }

  async _exec(node, r, signal) {
    const c = node.config || {}, ctx = r.ctx;
    const set = v => { ctx.out[node.id] = v; ctx.last = v; };
    switch (node.type) {
      case 'start': set(ctx.input); return 'next';
      case 'end': r.at = null; return null;
      case 'llm': {
        const res = await this.d.chat({ spec: c.model || this.d.defaultModel(), system: 'You are a step inside an automated workflow. Do exactly what is asked. Reply in the language of the request. No preamble.', messages: [{ role: 'user', content: tmpl(c.prompt, ctx) || ctx.last || '…' }], maxTokens: 2048, signal });
        set(String(res.text || '').trim()); return 'next';
      }
      case 'agent': {
        const res = await this.d.runTeam({ projectId: c.projectId, task: tmpl(c.task, ctx), mode: c.mode || 'team', signal });
        set(res.report || res.status || ''); return res.ok ? 'next' : 'fail';
      }
      case 'ask': case 'approve': {
        if (r.answerFor === node.id) { // resumed with the user's answer
          const a = r.answer; delete r.answerFor; delete r.answer; delete r.pending;
          if (node.type === 'ask') { set(String(a)); return 'next'; }
          set(a ? 'yes' : 'no'); return a ? 'yes' : 'no';
        }
        r.pending = { nodeId: node.id, kind: node.type, question: tmpl(c.question, ctx) || (node.type === 'approve' ? 'ادامه بدهم؟' : 'لطفاً جواب بدهید') };
        try { await this.d.ask(this.view(r), r.pending); } catch {}
        return 'WAIT';
      }
      case 'condition': {
        const v = tmpl(c.value || '{{last}}', ctx), arg = tmpl(c.arg, ctx);
        let ok;
        if (c.op === 'equals') ok = v.trim() === arg.trim();
        else if (c.op === 'regex') { try { ok = new RegExp(arg, 'i').test(v); } catch { throw new Error('الگوی regex نامعتبر است'); } }
        else if (c.op === 'empty') ok = !v.trim();
        else if (c.op === 'ai') {
          const res = await this.d.chat({ spec: c.model || this.d.defaultModel(), messages: [{ role: 'user', content: `Question: ${arg}\n\nText:\n${v.slice(0, 6000)}\n\nAnswer with only YES or NO.` }], maxTokens: 5, signal });
          ok = /^\s*(yes|بله|آره)/i.test(res.text || '');
        } else ok = v.toLowerCase().includes(arg.toLowerCase());
        ctx.out[node.id] = ok ? 'yes' : 'no'; return ok ? 'yes' : 'no';
      }
      case 'task': { const t = this.d.addTask({ title: tmpl(c.title, ctx) || ctx.last.slice(0, 200), due: tmpl(c.due, ctx) || null, category: c.category || 'life' }); set(t.title); return 'next'; }
      case 'notify': { const text = tmpl(c.text || '{{last}}', ctx); await this.d.notify(text); set(text); return 'next'; }
      case 'http': {
        const u = tmpl(c.url, ctx).trim();
        if (!/^https:\/\/[^\s]+$/i.test(u)) throw new Error('فقط آدرس https مجاز است');
        const res = await fetch(u, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), headers: { 'user-agent': 'JARVIS-workflow' } });
        const text = (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        set(text); return 'next';
      }
      case 'delay': {
        const ms = Math.max(0, Math.min(24 * 60, +c.minutes || 0)) * 60000;
        await new Promise((res, rej) => { const t = setTimeout(res, ms); signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('stopped')); }, { once: true }); });
        return 'next';
      }
    }
    throw new Error('نوع ناشناخته');
  }

  // the user's answer to "ask me" / "approve"
  answer(runId, value) {
    const r = this.run(runId); if (!r || r.status !== 'waiting' || !r.pending) throw new Error('این اجرا منتظر جواب نیست');
    r.answerFor = r.pending.nodeId;
    r.answer = r.pending.kind === 'approve' ? !!value && value !== 'no' : String(value ?? '').slice(0, 8000);
    const step = [...r.steps].reverse().find(s => s.nodeId === r.pending.nodeId && s.status === 'waiting'); if (step) { step.status = 'answered'; step.answer = String(r.answer).slice(0, 300); }
    r.at = r.pending.nodeId; r.count--; this._go(r); return this.view(r);
  }
  waiting() { return this.runs.filter(r => r.status === 'waiting' && r.pending); }
  pause(runId) { const r = this.run(runId); if (!r || r.status !== 'running') throw new Error('در حال اجرا نیست'); r.status = 'paused'; const l = this.live.get(runId); if (l) l.ctl.abort(); const s = r.steps[r.steps.length - 1]; if (s && s.status === 'running') { s.status = 'paused'; r.steps.pop(); r.count--; } return this.view(r); }
  resume(runId) { const r = this.run(runId); if (!r || r.status !== 'paused') throw new Error('متوقف موقت نیست'); delete r.note; this._go(r); return this.view(r); }
  stop(runId) { const r = this.run(runId); if (!r) throw new Error('اجرا پیدا نشد'); const l = this.live.get(runId); r.status = 'stopped'; r.endedAt = Date.now(); delete r.pending; if (l) l.ctl.abort(); this._saveRuns(); this._emit({ type: 'wfRun', run: this.view(r) }); return this.view(r); }

  // daily schedules ("HH:MM"): called every minute
  tick(now = new Date()) {
    const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const day = now.toDateString();
    for (const w of this.list) if (w.schedule === hm && w.lastScheduled !== day) { w.lastScheduled = day; this._save(); try { this.start(w.id, ''); } catch {} }
  }
}

// Lay out nodes in columns by distance from start (for workflows made from a description).
function autoLayout(nodes, edges) {
  const start = nodes.find(n => n.type === 'start'); if (!start) return nodes;
  const depth = { [start.id]: 0 }, q = [start.id];
  while (q.length) { const id = q.shift(); for (const e of edges.filter(e => e.from === id)) if (depth[e.to] === undefined) { depth[e.to] = depth[id] + 1; q.push(e.to); } }
  const cols = {};
  for (const n of nodes) { const d = depth[n.id] ?? 0; (cols[d] = cols[d] || []).push(n); }
  for (const [d, list] of Object.entries(cols)) list.forEach((n, i) => { n.x = 40 + d * 240; n.y = 60 + i * 150 + (list.length === 1 ? 60 : 0); });
  return nodes;
}

// Ask a model to turn a description into a workflow graph.
async function fromDescription(chat, spec, text, projects = []) {
  const schema = Object.entries(TYPES).map(([k, t]) => `- ${k} (${t.label}) outs: ${t.outs.join('/') || '-'}`).join('\n');
  const prompt = `Design a workflow for JARVIS from the user's description. Return ONLY JSON:
{"name": "...", "desc": "...", "schedule": "HH:MM or empty", "nodes": [{"id": "s", "type": "start", "title": "...", "config": {}}, ...], "edges": [{"from": "s", "to": "a", "port": "next"}]}
Node types (config keys in parentheses):
${schema}
configs: llm(prompt, model?), agent(projectId, task, mode=team|smart|plan|audit), ask(question), approve(question), condition(value, op=contains|equals|regex|empty|ai, arg), task(title, due, category=life|work), notify(text), http(url), delay(minutes).
Use {{last}} for the previous step's output, {{input}} for the run input, {{n.<id>}} for a given step's output, {{date}} for today.
Exactly one start; end nodes where paths finish. Ask for approval before agent steps that change code. Titles in the user's language (Persian if they wrote Persian).
Projects (use their id for agent.projectId): ${projects.map(p => `${p.id}=${p.name}`).join(', ') || '(none)'}

Description:
${String(text).slice(0, 4000)}`;
  const r = await chat({ spec, messages: [{ role: 'user', content: prompt }], maxTokens: 3000, json: true });
  const t = String(r.text || ''); const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('مدل ورک‌فلو نساخت');
  const j = JSON.parse(t.slice(s, e + 1));
  const g = validate(j);
  autoLayout(g.nodes, g.edges);
  return { name: String(j.name || 'ورک‌فلو').slice(0, 80), desc: String(j.desc || text).slice(0, 500), schedule: j.schedule || '', ...g };
}

const TEMPLATES = [
  { name: 'خلاصه‌ی صبحگاهی', desc: 'هر روز ساعت ۸: تسک‌های امروز را خلاصه کن و به گوشی بفرست.', schedule: '08:00',
    nodes: [{ id: 's', type: 'start', x: 40, y: 120 }, { id: 'a', type: 'llm', title: 'خلاصه‌ی روز', x: 280, y: 120, config: { prompt: 'امروز {{date}} است. یک خلاصه‌ی کوتاه و انرژی‌بخش برای شروع روز بنویس (حداکثر ۵ خط).' } },
      { id: 'b', type: 'notify', title: 'ارسال به گوشی', x: 520, y: 120, config: { text: '☀️ {{last}}' } }, { id: 'e', type: 'end', x: 760, y: 120 }],
    edges: [{ from: 's', to: 'a', port: 'next' }, { from: 'a', to: 'b', port: 'next' }, { from: 'b', to: 'e', port: 'next' }] },
  { name: 'قابلیت تازه با تأیید من', desc: 'از توضیح من نقشه بساز، از من تأیید بگیر، بعد تیم ایجنت‌ها بسازد و خبر بدهد.',
    nodes: [{ id: 's', type: 'start', x: 40, y: 140 }, { id: 'p', type: 'llm', title: 'نقشه‌ی کار', x: 260, y: 140, config: { prompt: 'برای این درخواست یک نقشه‌ی کوتاه و مرحله‌به‌مرحله بنویس:\n{{input}}' } },
      { id: 'ok', type: 'approve', title: 'تأیید نقشه', x: 480, y: 140, config: { question: 'این نقشه را اجرا کنم؟\n\n{{last}}' } },
      { id: 'ag', type: 'agent', title: 'ساخت با تیم', x: 720, y: 60, config: { task: '{{input}}\n\nنقشه:\n{{n.p}}', mode: 'team' } },
      { id: 'n1', type: 'notify', title: 'خبر پایان', x: 960, y: 60, config: { text: '✅ کار تمام شد:\n{{last}}' } },
      { id: 'n2', type: 'notify', title: 'لغو شد', x: 720, y: 240, config: { text: 'نقشه تأیید نشد؛ کاری انجام نشد.' } }, { id: 'e', type: 'end', x: 1180, y: 140 }],
    edges: [{ from: 's', to: 'p', port: 'next' }, { from: 'p', to: 'ok', port: 'next' }, { from: 'ok', to: 'ag', port: 'yes' }, { from: 'ok', to: 'n2', port: 'no' }, { from: 'ag', to: 'n1', port: 'next' }, { from: 'ag', to: 'n1', port: 'fail' }, { from: 'n1', to: 'e', port: 'next' }, { from: 'n2', to: 'e', port: 'next' }] },
  { name: 'تحقیق و تسک', desc: 'موضوع را از من بپرس، درباره‌اش تحقیق کن و کارهای لازم را تسک کن.',
    nodes: [{ id: 's', type: 'start', x: 40, y: 120 }, { id: 'q', type: 'ask', title: 'موضوع؟', x: 260, y: 120, config: { question: 'درباره‌ی چه موضوعی تحقیق کنم؟' } },
      { id: 'r', type: 'llm', title: 'تحقیق', x: 480, y: 120, config: { prompt: 'درباره‌ی «{{last}}» یک خلاصه‌ی دقیق و کاربردی بنویس و در پایان ۳ کار عملی پیشنهاد بده.' } },
      { id: 't', type: 'task', title: 'تسک پیگیری', x: 700, y: 120, config: { title: 'پیگیری: {{n.q}}', category: 'work' } },
      { id: 'n', type: 'notify', title: 'ارسال نتیجه', x: 920, y: 120, config: { text: '{{n.r}}' } }, { id: 'e', type: 'end', x: 1140, y: 120 }],
    edges: [{ from: 's', to: 'q', port: 'next' }, { from: 'q', to: 'r', port: 'next' }, { from: 'r', to: 't', port: 'next' }, { from: 't', to: 'n', port: 'next' }, { from: 'n', to: 'e', port: 'next' }] },
];

module.exports = { Workflows, TYPES, TEMPLATES, validate, autoLayout, fromDescription, tmpl };
