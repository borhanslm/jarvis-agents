// Phone notifications through a Bale or Telegram bot (both speak the same Bot API).
// The bot token is kept encrypted in the secrets store; only the result text is sent.
'use strict';

const BASES = { bale: 'https://tapi.bale.ai', telegram: 'https://api.telegram.org' };
const base = channel => (process.env.JARVIS_NOTIFY_BASE || BASES[channel] || '').replace(/\/+$/, '');
const TOKEN_RE = /^[\w:-]{10,200}$/;

async function call(channel, token, method, body, { timeoutMs = 20000, signal } = {}) {
  if (!BASES[channel]) throw new Error('کانال نامعتبر است');
  if (!TOKEN_RE.test(token || '')) throw new Error('توکن ربات معتبر نیست');
  const form = typeof FormData !== 'undefined' && body instanceof FormData; // file uploads (voice replies)
  const to = AbortSignal.timeout(timeoutMs);
  const r = await fetch(`${base(channel)}/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET', headers: body && !form ? { 'content-type': 'application/json' } : undefined,
    body: body ? (form ? body : JSON.stringify(body)) : undefined, signal: signal ? AbortSignal.any([signal, to]) : to,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok === false) throw new Error((j && (j.description || j.error)) || `HTTP ${r.status}`);
  return j.result;
}

async function send({ channel, token, chatId, text }) {
  if (!chatId) throw new Error('شناسه‌ی گفتگو (chat id) خالی است');
  await call(channel, token, 'sendMessage', { chat_id: chatId, text: String(text).slice(0, 3500) });
  return { ok: true };
}

// After the user sends any message to their bot: find that chat's id.
async function detect({ channel, token }) {
  const updates = await call(channel, token, 'getUpdates');
  const msgs = (updates || []).map(u => u.message || u.edited_message || u.channel_post).filter(Boolean);
  const last = msgs[msgs.length - 1];
  if (!last) throw new Error('پیامی پیدا نشد. اول در خود برنامه (بله/تلگرام) به ربات‌تان یک پیام بفرستید، بعد دوباره امتحان کنید.');
  const c = last.chat || {};
  return { chatId: String(c.id), name: c.first_name || c.title || c.username || '' };
}

const fileUrl = (channel, token, filePath) => `${base(channel)}/file/bot${token}/${String(filePath).replace(/^\/+/, '')}`;

module.exports = { send, detect, call, fileUrl, TOKEN_RE };
