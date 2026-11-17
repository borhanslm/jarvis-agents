// Arena: the same question to several models side by side (speed, length, your vote → a leaderboard),
// and a debate: models answer, read each other's answers and improve them, then one model writes the
// final answer with where they agreed and disagreed. Kept on this computer (data/arena.json).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ANSWER_SYS = 'You are taking part in a side-by-side comparison of AI models. Answer the user\'s question as well as you can, in the language of the question. Use Markdown when it helps.';
const DEBATE_SYS = 'You are one of several AI experts debating a question to reach the best answer. Be precise, cite reasons, admit mistakes. Answer in the language of the question. Markdown is fine.';

class Arena {
  constructor(dataDir, { chat, onEvent } = {}) {
    this.file = path.join(dataDir, 'arena.json');
    this.chat = chat; this.emit = onEvent || (() => {});
    this.runs = new Map(); // id -> AbortController
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
    this.data.board = this.data.board || {}; this.data.history = this.data.history || [];
  }
  _save() { try { fs.writeFileSync(this.file, JSON.stringify({ board: this.data.board, history: this.data.history.slice(-100) })); } catch {} }
  view() { return { board: Object.entries(this.data.board).map(([spec, b]) => ({ spec, ...b })).sort((a, b) => b.wins - a.wins || a.losses - b.losses), history: this.data.history.slice(-30).reverse() }; }
  stop(id) { const c = this.runs.get(id); if (c) c.abort(); }

  async _one(id, spec, opts, ctl) {
    const t0 = Date.now(); let text = '', last = 0, buf = '';
    try {
      const r = await this.chat({ spec, signal: ctl.signal, maxTokens: 3000, ...opts,
        onDelta: d => { text += d; buf += d; if (Date.now() - last > 80) { this.emit({ type: 'arena', id, spec, delta: buf }); buf = ''; last = Date.now(); } } });
      if (buf) this.emit({ type: 'arena', id, spec, delta: buf });
      if (!text && r.text) text = r.text;
      return { spec, ok: true, text, ms: Date.now() - t0, usage: r.usage || null };
    } catch (e) { return { spec, ok: false, error: ctl.signal.aborted ? 'متوقف شد' : String(e.message || e).slice(0, 300), text, ms: Date.now() - t0 }; }
  }

  // every model answers the same prompt at the same time
  compare(prompt, specs) {
    prompt = String(prompt || '').trim(); specs = [...new Set((specs || []).map(String).filter(Boolean))].slice(0, 6);
    if (!prompt) throw new Error('سؤال خالی است'); if (specs.length < 2) throw new Error('حداقل دو مدل انتخاب کنید');
    const id = crypto.randomUUID().slice(0, 10), ctl = new AbortController(); this.runs.set(id, ctl);
    this.emit({ type: 'arena', id, state: 'start', mode: 'compare', specs });
    const done = Promise.all(specs.map(s => this._one(id, s, { system: ANSWER_SYS, messages: [{ role: 'user', content: prompt }] }, ctl))).then(results => {
      this.runs.delete(id);
      const h = { id, mode: 'compare', prompt: prompt.slice(0, 2000), at: Date.now(), results: results.map(r => ({ spec: r.spec, ok: r.ok, ms: r.ms, chars: r.text.length, text: r.text.slice(0, 20000), error: r.error })) };
      for (const r of results) if (r.ok) { const b = this.data.board[r.spec] = this.data.board[r.spec] || { wins: 0, losses: 0, ties: 0, msTotal: 0, runs: 0 }; b.runs++; b.msTotal += r.ms; }
      this.data.history.push(h); this._save();
      this.emit({ type: 'arena', id, state: 'done', run: h });
      return h;
    });
    return { id, done };
  }
  // the user's vote: the chosen model wins against the others of that run
  vote(id, spec) {
    const h = this.data.history.find(x => x.id === id); if (!h) throw new Error('این مقایسه پیدا نشد');
    if (h.vote) throw new Error('برای این مقایسه قبلاً رأی داده‌اید');
    if (!h.results.some(r => r.spec === spec)) throw new Error('این مدل در مقایسه نبود');
    h.vote = spec;
    for (const r of h.results) { const b = this.data.board[r.spec] = this.data.board[r.spec] || { wins: 0, losses: 0, ties: 0, msTotal: 0, runs: 0 }; if (r.spec === spec) b.wins++; else b.losses++; }
    this._save(); return this.view();
  }

  // debate: round 1 answers, then each model sees the others' latest answers and improves its own, then a judge writes the result
  debate(question, specs, { rounds = 2, judge } = {}) {
    question = String(question || '').trim(); specs = [...new Set((specs || []).map(String).filter(Boolean))].slice(0, 4);
    if (!question) throw new Error('سؤال خالی است'); if (specs.length < 2) throw new Error('حداقل دو مدل انتخاب کنید');
    rounds = Math.max(1, Math.min(3, +rounds || 2)); judge = judge && specs.includes(judge) ? judge : specs[0];
    const id = crypto.randomUUID().slice(0, 10), ctl = new AbortController(); this.runs.set(id, ctl);
    this.emit({ type: 'arena', id, state: 'start', mode: 'debate', specs, rounds });
    const label = s => `Expert ${specs.indexOf(s) + 1}`;
    const done = (async () => {
      const log = []; let latest = {};
      for (let r = 1; r <= rounds && !ctl.signal.aborted; r++) {
        this.emit({ type: 'arena', id, state: 'round', round: r });
        const res = await Promise.all(specs.map(s => {
          const others = specs.filter(o => o !== s && latest[o]).map(o => `### ${label(o)}\n${latest[o]}`).join('\n\n');
          const content = r === 1 ? question : `Question: ${question}\n\nYour previous answer (${label(s)}):\n${latest[s] || '(none)'}\n\nThe other experts answered:\n${others}\n\nRead them critically. Point out errors (yours or theirs) briefly, then give your improved, complete answer.`;
          return this._one(id, s, { system: DEBATE_SYS, messages: [{ role: 'user', content }] }, ctl).then(x => ({ ...x, round: r }));
        }));
        for (const x of res) { if (x.ok) latest[x.spec] = x.text.slice(0, 12000); log.push({ round: r, spec: x.spec, ok: x.ok, text: x.text.slice(0, 12000), error: x.error, ms: x.ms }); this.emit({ type: 'arena', id, state: 'answer', round: r, spec: x.spec, ok: x.ok, error: x.error }); }
        if (!Object.keys(latest).length) break;
      }
      let final = null;
      if (!ctl.signal.aborted && Object.keys(latest).length) {
        this.emit({ type: 'arena', id, state: 'judge', spec: judge });
        const all = specs.filter(s => latest[s]).map(s => `### ${label(s)}\n${latest[s]}`).join('\n\n');
        final = await this._one(id, judge, { system: 'You are the impartial moderator of an expert debate. Answer in the language of the question.', messages: [{ role: 'user', content: `Question: ${question}\n\nThe experts' final answers:\n${all}\n\nWrite the best final answer. Then a short section «نقاط توافق / Agreement» and «اختلاف‌ها / Disagreements» (which expert said what, and who is more likely right and why).` }] }, ctl);
      }
      this.runs.delete(id);
      const h = { id, mode: 'debate', prompt: question.slice(0, 2000), at: Date.now(), specs, judge, rounds, log, final: final && { ok: final.ok, text: final.text.slice(0, 20000), error: final.error } };
      this.data.history.push(h); this._save();
      this.emit({ type: 'arena', id, state: 'done', run: h });
      return h;
    })();
    return { id, done };
  }
}

module.exports = { Arena };
