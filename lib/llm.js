// Direct chat with any language model (no coding CLI in between) — for voice, chat,
// Telegram and other quick answers. Streams text as it arrives.
//
// Targets:
//   "p:<connection>:<model>"  a saved connection (Anthropic- or OpenAI-compatible API)
//   "ollama:<model>"          a model running on this computer through Ollama (offline)
//   "claude-…"                Claude: the Anthropic API key when one is saved, otherwise the
//                             Claude Code CLI (works with a Pro/Max login, slower to start)
'use strict';

const { runClaude } = require('./agents');

// Where and how to send a request for this model spec.
function resolveTarget(spec, { providers, anthropicKey, ollamaBase } = {}) {
  const s = String(spec || '').trim();
  const o = /^ollama:(.+)$/.exec(s);
  if (o) return { kind: 'openai', baseUrl: (ollamaBase || 'http://127.0.0.1:11434') + '/v1', key: '', model: o[1], label: 'Ollama · ' + o[1], local: true };
  const m = /^p:([a-z0-9-]+):(.+)$/.exec(s);
  if (m && providers) {
    const p = providers.get(m[1]);
    if (!p) throw new Error(`اتصال «${m[1]}» پیدا نشد`);
    const key = providers.key(p.id);
    if (!key && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(p.baseUrl)) throw new Error(`کلید API اتصال «${p.name}» تنظیم نشده است`);
    return { kind: p.kind, baseUrl: p.baseUrl, key, model: m[2], label: `${p.name} · ${m[2]}` };
  }
  if (/^claude-/.test(s)) {
    return anthropicKey ? { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', key: anthropicKey, model: s, label: s }
      : { kind: 'claude-cli', model: s, label: s };
  }
  throw new Error('این مدل برای گفتگوی مستقیم پشتیبانی نمی‌شود: ' + (s || '(خالی)'));
}

// Read a server-sent-events body; calls onData(json) for each "data:" line.
async function readSSE(res, onData, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    if (signal && signal.aborted) { try { await reader.cancel(); } catch {} throw Object.assign(new Error('stopped'), { aborted: true }); }
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try { onData(JSON.parse(d)); } catch {}
    }
  }
}

async function failText(res) {
  let t = ''; try { t = await res.text(); } catch {}
  let msg = t; try { const j = JSON.parse(t); msg = (j.error && (j.error.message || j.error)) || j.message || t; } catch {}
  if (res.status === 401 || res.status === 403) return 'کلید API پذیرفته نشد (' + res.status + ')';
  if (res.status === 429) return 'سقف درخواست یا اعتبار این سرویس پر شده است (429)';
  return `خطای ${res.status}: ${String(msg).slice(0, 300)}`;
}

/**
 * chat({ target | spec, deps, system, json (ask a local model for a JSON object), messages:[{role:'user'|'assistant', content}], maxTokens, temperature, signal, onDelta })
 * -> { text, usage: { input, output } }
 */
async function chat(opts) {
  const t = opts.target || resolveTarget(opts.spec, opts.deps);
  const messages = (opts.messages || []).filter(x => x && x.content);
  const maxTokens = opts.maxTokens || 1024;
  const onDelta = opts.onDelta || (() => {});
  let text = '';
  const usage = { input: 0, output: 0 };

  if (t.kind === 'claude-cli') {
    // Through Claude Code: no tools, the conversation in one prompt.
    const convo = messages.map(x => `${x.role === 'assistant' ? 'Assistant' : 'User'}: ${x.content}`).join('\n\n');
    const h = runClaude({ cwd: opts.cwd || require('os').tmpdir(), prompt: messages.length > 1 ? `${convo}\n\nAssistant:` : messages[0].content,
      systemPrompt: opts.system, model: t.model, permissionMode: 'default', lean: true, tools: [], partial: true,
      emit: (kind, p) => { if (kind === 'delta' && !p.via) { text += p.text; onDelta(p.text); } } });
    if (opts.signal) opts.signal.addEventListener('abort', () => h.kill(), { once: true });
    const r = await h.promise;
    if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('stopped'), { aborted: true });
    if (!r.ok) throw new Error(r.error || 'خطای Claude');
    if (!text && r.text) { text = r.text; onDelta(r.text); }
    const mu = Object.values(r.modelUsage || {})[0];
    if (mu) { usage.input = mu.inputTokens || 0; usage.output = mu.outputTokens || 0; }
    return { text: r.text || text, usage, costUsd: r.costUsd || 0 };
  }

  if (t.kind === 'anthropic') {
    const res = await fetch(t.baseUrl.replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST', signal: opts.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': t.key, authorization: 'Bearer ' + t.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: t.model, max_tokens: maxTokens, stream: true, ...(opts.system ? { system: opts.system } : {}), ...(opts.temperature != null ? { temperature: opts.temperature } : {}), messages }),
    });
    if (!res.ok) throw new Error(await failText(res));
    await readSSE(res, ev => {
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { text += ev.delta.text; onDelta(ev.delta.text); }
      else if (ev.type === 'message_start' && ev.message && ev.message.usage) usage.input = ev.message.usage.input_tokens || 0;
      else if (ev.type === 'message_delta' && ev.usage) usage.output = ev.usage.output_tokens || 0;
      else if (ev.type === 'error') throw new Error((ev.error && ev.error.message) || 'خطای سرویس');
    }, opts.signal);
    return { text, usage };
  }

  // OpenAI-compatible Chat Completions (OpenAI, Gemini, Grok, OpenRouter, Ollama, NVIDIA, Groq, …)
  const res = await fetch(t.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', signal: opts.signal,
    headers: { 'content-type': 'application/json', ...(t.key ? { authorization: 'Bearer ' + t.key } : {}) },
    body: JSON.stringify({ model: t.model, stream: true, ...(opts.json && t.local ? { response_format: { type: 'json_object' } } : {}), stream_options: { include_usage: true }, max_tokens: maxTokens, ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      messages: [...(opts.system ? [{ role: 'system', content: opts.system }] : []), ...messages] }),
  });
  if (!res.ok) throw new Error(await failText(res));
  await readSSE(res, ev => {
    const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (d && d.content) { text += d.content; onDelta(d.content); }
    if (ev.usage) { usage.input = ev.usage.prompt_tokens || 0; usage.output = ev.usage.completion_tokens || 0; }
  }, opts.signal);
  return { text, usage };
}

module.exports = { chat, resolveTarget, readSSE };
