// Ollama: language models that run on this computer, with no internet.
// Used as the offline brain (voice now; chat and Telegram later).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const NAME_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)?(:[a-z0-9._-]+)?$/i;
// Suggested models for Persian + English on a normal PC (sizes from the Ollama library)
const SUGGESTED = [
  { name: 'gemma3:4b', size: 3.3e9, note: 'پیشنهادی — فارسی خوب، سریع روی کارت ۸ گیگ' },
  { name: 'qwen2.5:7b', size: 4.7e9, note: 'دقیق‌تر، کمی کندتر' },
  { name: 'qwen2.5:1.5b', size: 1.0e9, note: 'خیلی سبک، برای کامپیوتر ضعیف (فارسی ضعیف‌تر)' },
];

class Ollama {
  constructor({ base = process.env.OLLAMA_HOST_URL || 'http://127.0.0.1:11434', onProgress } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.onProgress = onProgress || (() => {});
    this.pulls = {}; // name -> { total, completed, status, error, done }
    this._exe = undefined;
  }
  exe() {
    if (this._exe !== undefined) return this._exe;
    const cands = [];
    if (process.platform === 'win32') cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'));
    else cands.push('/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama');
    let found = cands.find(f => f && fs.existsSync(f)) || null;
    if (!found) { try { found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { windowsHide: true, timeout: 5000 }).toString().split(/\r?\n/)[0].trim() || null; } catch {} }
    return (this._exe = found);
  }
  async _get(p, ms = 1500) { const r = await fetch(this.base + p, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error('Ollama ' + r.status); return r.json(); }
  async running() { try { await this._get('/api/version'); return true; } catch { return false; } }
  async models() { try { const j = await this._get('/api/tags', 3000); return (j.models || []).map(m => ({ name: m.name, size: m.size || 0 })); } catch { return []; } }
  async status() {
    const running = await this.running();
    return { installed: !!this.exe() || running, running, models: running ? await this.models() : [], pulls: this.pulls, suggested: SUGGESTED, downloadUrl: 'https://ollama.com/download' };
  }
  // Start "ollama serve" in the background when it is installed but not running.
  async ensureRunning(waitMs = 20000) {
    if (await this.running()) return true;
    const exe = this.exe();
    if (!exe) throw new Error('Ollama نصب نیست. برای مغز آفلاین آن را از ollama.com/download نصب کنید.');
    try { const p = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }); p.on('error', () => {}); p.unref(); } catch (e) { throw new Error('اجرای Ollama نشد: ' + e.message); }
    const until = Date.now() + waitMs;
    while (Date.now() < until) { await new Promise(r => setTimeout(r, 500)); if (await this.running()) return true; }
    throw new Error('Ollama در زمان مقرر بالا نیامد');
  }
  // Download a model from the Ollama library (only when the user asks). Progress through onProgress.
  pull(name) {
    name = String(name || '').trim();
    if (!NAME_RE.test(name) || name.length > 80) throw new Error('نام مدل معتبر نیست');
    if (this.pulls[name] && !this.pulls[name].done && !this.pulls[name].error) return this.pulls[name];
    const st = this.pulls[name] = { status: 'شروع', total: 0, completed: 0, done: false, error: null };
    (async () => {
      await this.ensureRunning();
      const r = await fetch(this.base + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name, stream: true }) });
      if (!r.ok) throw new Error('Ollama: ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let lastEmit = 0;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.error) throw new Error(j.error);
          st.status = j.status || st.status;
          if (j.total) { st.total = j.total; st.completed = j.completed || 0; }
          if (Date.now() - lastEmit > 700) { lastEmit = Date.now(); this.onProgress(name, st); }
        }
      }
      if (!/success/i.test(st.status)) throw new Error('دانلود کامل نشد: ' + st.status);
      st.done = true; this.onProgress(name, st);
    })().catch(e => { st.error = e.message; this.onProgress(name, st); });
    return st;
  }
  // Load a model into memory ahead of time and keep it there for 30 minutes.
  async warm(model) {
    await this.ensureRunning();
    const r = await fetch(this.base + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt: '', keep_alive: '30m' }) });
    if (!r.ok) throw new Error('Ollama ' + r.status);
    await r.text();
    return true;
  }
  target(model) { return { kind: 'openai', baseUrl: this.base + '/v1', key: '', model, label: 'Ollama · ' + model, local: true }; }
}

module.exports = { Ollama, SUGGESTED, NAME_RE };
