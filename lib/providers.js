// Custom connections ("providers"): any Anthropic-compatible API (runs on the Claude Code engine)
// or OpenAI Responses-compatible API (runs on the Codex engine). Each provider gets its own
// isolated CLI profile folder, so the user's own Claude / ChatGPT sign-in is never sent to it.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Presets: base URLs as documented by each service for Claude Code / OpenAI clients.
// Model lists are only suggestions; "دریافت مدل‌ها" reads the live list where the service offers one.
const PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', kind: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', modelsUrl: 'https://api.deepseek.com/models', models: ['deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi', name: 'Kimi (Moonshot)', kind: 'anthropic', baseUrl: 'https://api.moonshot.ai/anthropic', modelsUrl: 'https://api.moonshot.ai/v1/models', models: [], keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'glm', name: 'GLM (Z.ai)', kind: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', models: [], keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { id: 'minimax', name: 'MiniMax', kind: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic', models: [], keyUrl: 'https://www.minimax.io/platform/user-center/basic-information/interface-key' },
  { id: 'anthropic', name: 'Anthropic (کلید جدا)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', modelsUrl: 'https://api.anthropic.com/v1/models', models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', modelsUrl: 'https://api.openai.com/v1/models', models: [], keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'custom', name: 'سفارشی', kind: 'anthropic', baseUrl: '', models: [] },
];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_RE = /^[\w.:\-\/[\]@]{1,100}$/;
const KEY_RE = /^[\x21-\x7e]{0,400}$/;

class Providers {
  constructor(dir, secrets) {
    this.dir = dir; this.secrets = secrets;
    this.file = path.join(dir, 'providers.json');
    try { this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.list = []; }
    if (!Array.isArray(this.list)) this.list = [];
  }
  _save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.list, null, 2)); fs.renameSync(this.file + '.tmp', this.file); }
  get(id) { return this.list.find(p => p.id === id) || null; }
  key(id) { return this.secrets.get('provider:' + id) || ''; }
  // public view: never includes the key
  view() { return this.list.map(p => ({ ...p, hasKey: !!this.key(p.id) })); }
  static clean(b) {
    const name = String(b.name || '').trim().slice(0, 60);
    const kind = b.kind === 'openai' ? 'openai' : 'anthropic';
    const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
    if (!name) throw new Error('نام اتصال را بنویسید');
    if (!/^https?:\/\/[^\s"'`<>]+$/i.test(baseUrl) || baseUrl.length > 300) throw new Error('آدرس API معتبر نیست (باید با https:// یا http:// شروع شود)');
    if (/^http:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl)) throw new Error('برای سرویس‌های اینترنتی فقط https مجاز است (http فقط برای سرورهای محلی)');
    const models = [...new Set((Array.isArray(b.models) ? b.models : String(b.models || '').split(/[,\n،]/)).map(m => String(m).trim()).filter(Boolean))];
    for (const m of models) if (!MODEL_RE.test(m)) throw new Error('نام مدل نامعتبر: ' + m);
    if (!models.length) throw new Error('حداقل یک مدل وارد کنید (یا «دریافت مدل‌ها» را بزنید)');
    return { name, kind, baseUrl, models: models.slice(0, 40), preset: String(b.preset || 'custom').slice(0, 20) };
  }
  save(b) {
    const data = Providers.clean(b);
    let p = b.id ? this.get(b.id) : null;
    if (b.id && !p) throw new Error('اتصال پیدا نشد');
    if (!p) {
      let base = (data.preset && data.preset !== 'custom' ? data.preset : data.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'api';
      let id = base, n = 2;
      while (this.get(id)) id = `${base}-${n++}`;
      if (!ID_RE.test(id)) id = 'api-' + crypto.randomBytes(3).toString('hex');
      p = { id, createdAt: Date.now() };
      this.list.push(p);
    }
    Object.assign(p, data);
    if (typeof b.apiKey === 'string' && b.apiKey.trim()) {
      if (!KEY_RE.test(b.apiKey.trim())) throw new Error('کلید API کاراکتر نامعتبر دارد');
      this.secrets.set('provider:' + p.id, b.apiKey.trim());
    }
    this._save();
    return { ...p, hasKey: !!this.key(p.id) };
  }
  remove(id) {
    this.list = this.list.filter(p => p.id !== id);
    this.secrets.set('provider:' + id, null);
    this._save();
    try { fs.rmSync(path.join(this.dir, 'providers', id), { recursive: true, force: true }); } catch {}
  }

  // "p:<id>:<model>" -> how to run it. null when spec is not a provider.
  resolve(spec) {
    const m = /^p:([a-z0-9-]{1,40}):(.+)$/.exec(String(spec || ''));
    if (!m) return null;
    const p = this.get(m[1]);
    if (!p) return { missing: true, id: m[1], label: m[1] };
    const key = this.key(p.id);
    const home = path.join(this.dir, 'providers', p.id);
    const out = { id: p.id, name: p.name, kind: p.kind, model: m[2], label: `${p.name} · ${m[2]}`, hasKey: !!key };
    if (p.kind === 'anthropic') {
      const cfg = path.join(home, 'claude');
      fs.mkdirSync(cfg, { recursive: true });
      out.engine = 'claude';
      out.env = {
        CLAUDE_CONFIG_DIR: cfg,                      // separate profile: no Claude sign-in, no user settings
        ANTHROPIC_BASE_URL: p.baseUrl,
        ANTHROPIC_API_KEY: key || 'none',
        ANTHROPIC_AUTH_TOKEN: null,
        ANTHROPIC_MODEL: m[2],
        ANTHROPIC_DEFAULT_OPUS_MODEL: m[2], ANTHROPIC_DEFAULT_SONNET_MODEL: m[2], ANTHROPIC_DEFAULT_HAIKU_MODEL: m[2],
        ANTHROPIC_SMALL_FAST_MODEL: m[2],
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      };
    } else {
      const cfg = path.join(home, 'codex');
      fs.mkdirSync(cfg, { recursive: true });
      out.engine = 'codex';
      out.env = { CODEX_HOME: cfg, JARVIS_PROVIDER_KEY: key || 'none', OPENAI_API_KEY: null };
      out.configArgs = [
        'model_provider="jarvis"',
        `model_providers.jarvis.name=${JSON.stringify(p.name)}`,
        `model_providers.jarvis.base_url=${JSON.stringify(p.baseUrl)}`,
        'model_providers.jarvis.env_key="JARVIS_PROVIDER_KEY"',
        'model_providers.jarvis.wire_api="responses"',
      ];
    }
    return out;
  }

  // Live model list (OpenAI-style GET /models), where the service offers one.
  async models({ kind, baseUrl, modelsUrl, apiKey, id }) {
    const key = apiKey || (id ? this.key(id) : '');
    const urls = modelsUrl ? [modelsUrl] : kind === 'openai' ? [baseUrl + '/models'] : [baseUrl + '/v1/models', baseUrl.replace(/\/anthropic$/, '') + '/v1/models', baseUrl.replace(/\/anthropic$/, '') + '/models'];
    let last = '';
    for (const u of [...new Set(urls)]) {
      try {
        const r = await fetch(u, { headers: { authorization: 'Bearer ' + key, 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000) });
        const j = await r.json().catch(() => null);
        if (r.ok && j && Array.isArray(j.data)) return j.data.map(x => x.id).filter(x => typeof x === 'string' && MODEL_RE.test(x)).slice(0, 200);
        last = `${r.status} ${(j && (j.error && (j.error.message || j.error) || j.message)) || ''}`;
      } catch (e) { last = e.message; }
    }
    throw new Error('فهرست مدل‌ها دریافت نشد' + (last ? ': ' + String(last).slice(0, 200) : '') + '. نام مدل را دستی بنویسید.');
  }

  // One tiny request to check the address, key and model.
  async test({ kind, baseUrl, apiKey, id, model }) {
    const key = apiKey || (id ? this.key(id) : '');
    const t0 = Date.now();
    const req = kind === 'openai'
      ? { url: baseUrl + '/responses', body: { model, input: 'Reply with: ok', max_output_tokens: 16 }, headers: { authorization: 'Bearer ' + key } }
      : { url: baseUrl + '/v1/messages', body: { model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] }, headers: { 'x-api-key': key, authorization: 'Bearer ' + key, 'anthropic-version': '2023-06-01' } };
    try {
      const r = await fetch(req.url, { method: 'POST', headers: { 'content-type': 'application/json', ...req.headers }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(30000) });
      const j = await r.json().catch(() => null);
      if (r.ok) return { ok: true, ms: Date.now() - t0 };
      const msg = (j && (j.error && (j.error.message || j.error.type || j.error) || j.message)) || r.statusText;
      const hint = r.status === 401 || r.status === 403 ? 'کلید API درست نیست یا دسترسی ندارد.'
        : r.status === 404 ? (kind === 'openai' ? 'این سرویس از Responses API پشتیبانی نمی‌کند یا آدرس اشتباه است.' : 'آدرس اشتباه است یا سرویس سازگار با Anthropic نیست.')
        : r.status === 402 ? 'اعتبار حساب تمام شده است.' : r.status === 400 ? 'نام مدل یا درخواست را سرویس قبول نکرد.' : '';
      return { ok: false, status: r.status, error: String(msg).slice(0, 300), hint };
    } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'سرویس جواب نداد (بیش از ۳۰ ثانیه)' : e.message }; }
  }
}

module.exports = { Providers, PRESETS };
