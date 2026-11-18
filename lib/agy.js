// Gemini for free with a personal Google account, through Google's official Antigravity CLI ("agy").
// Google moved free individual Gemini access from Gemini CLI to Antigravity CLI (June 2026); the
// "For Individuals" plan is $0 with a weekly quota. No API key in JARVIS: the sign-in stays in
// Windows Credential Manager. Headless runs never approve tools, so answers are plain text.
// Install: irm https://antigravity.google/cli/install.ps1 | iex
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const which = cmd => { try { return execFileSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split(/\r?\n/).map(s => s.trim()).filter(Boolean); } catch { return []; } };

function resolveAgy() {
  const env = process.env.JARVIS_AGY_BIN;
  if (env) return /\.m?js$/i.test(env) ? { cmd: process.execPath, pre: [env] } : { cmd: env, pre: [] }; // a .js path: run with node (tests)
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const known = IS_WIN ? [path.join(local, 'agy', 'bin', 'agy.exe')] : [path.join(os.homedir(), '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy'];
  const hit = [...which('agy'), ...known].find(p => p && fs.existsSync(p) && (!IS_WIN || /\.exe$/i.test(p)));
  return hit ? { cmd: hit, pre: [] } : null;
}
let cached; const agyCli = (refresh = false) => (refresh || cached === undefined ? (cached = resolveAgy()) : cached);

// Antigravity's own error, explained in Persian (the original kept in .raw)
function explain(err, code) {
  const text = String(err || '');
  const line = (text.split('\n').find(l => /error|required|denied|quota|limit/i.test(l)) || text.trim().split('\n').pop() || 'code ' + code).replace(/^error:\s*/i, '').trim();
  if (/authentication required|not authenticated|sign.?in|login/i.test(line)) return Object.assign(new Error('اول با حساب Google وارد شوید («هسته‌ی هوش مصنوعی» ← Gemini رایگان ← ورود)'), { needLogin: true, raw: line });
  if (/quota|rate.?limit|429|exhausted|credits/i.test(line)) return Object.assign(new Error('سهمیه‌ی رایگان Gemini (هفتگی) پر شده؛ بعداً امتحان کنید یا از مدل دیگری استفاده کنید'), { busy: true, raw: line });
  if (/not (available|supported) in your (country|region)|location|region/i.test(line)) return Object.assign(new Error('Google این سرویس را در منطقه‌ی شما نمی‌دهد؛ با VPN امتحان کنید'), { raw: line });
  if (/unknown model|model .*not found/i.test(line)) return Object.assign(new Error('این مدل در Antigravity نیست؛ بدون انتخاب مدل امتحان کنید'), { raw: line });
  return Object.assign(new Error('خطای Gemini (Antigravity): ' + line.slice(0, 300)), { raw: line });
}

// one plain answer: the conversation in one prompt, run in an empty folder
function chat({ messages, system, model, onDelta = () => {}, signal, timeoutMs = 180000 }) {
  const a = agyCli();
  if (!a) return Promise.reject(new Error('Antigravity CLI نصب نیست («هسته‌ی هوش مصنوعی» ← Gemini رایگان ← نصب)'));
  const convo = messages.map(x => `${x.role === 'assistant' ? 'Assistant' : 'User'}: ${x.content}`).join('\n\n');
  const prompt = `This is a plain chat inside the JARVIS app. Do not run commands, read or edit files, or use tools — just answer directly.${system ? '\n\nInstructions:\n' + system : ''}\n\n${messages.length > 1 ? 'Conversation so far:\n' + convo + '\n\nReply to the last user message.' : (messages[0] || {}).content || ''}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agy-'));
  return new Promise((resolve, reject) => {
    const p = spawn(a.cmd, [...a.pre, '-p', prompt, '--output-format', 'text', ...(model ? ['--model', model] : [])], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let out = '', err = '';
    const done = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} };
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => { try { p.kill(); } catch {} }, { once: true });
    p.stdout.on('data', d => { const s = d.toString(); out += s; onDelta(s); });
    p.stderr.on('data', d => { err = (err + d).slice(-3000); });
    p.on('error', e => { clearTimeout(t); done(); reject(e); });
    p.on('close', code => {
      clearTimeout(t); done();
      if (signal && signal.aborted) return reject(Object.assign(new Error('stopped'), { aborted: true }));
      if (code === 0 && out.trim()) return resolve({ text: out.trim() });
      reject(explain(err || out, code));
    });
  });
}

const INSTALL_WIN = 'irm https://antigravity.google/cli/install.ps1 | iex';
const INSTALL_UNIX = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
module.exports = { agyCli, chat, explain, INSTALL_WIN, INSTALL_UNIX };
