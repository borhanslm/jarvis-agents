// Kimi through the official Kimi Code CLI ("kimi") and the user's own Kimi sign-in (`kimi login`),
// like ChatGPT through Codex: no API key in JARVIS. Used for chat, voice and as a model choice.
// Install: irm https://code.kimi.com/kimi-code/install.ps1 | iex   (needs Git for Windows)
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const which = cmd => { try { return execFileSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map(s => s.trim()).filter(Boolean); } catch { return []; } };

// how to launch `kimi` without a shell (a native exe, or the npm package's JS entry with node)
function resolveKimi() {
  const env = process.env.JARVIS_KIMI_BIN;
  if (env) return /\.m?js$/i.test(env) ? { cmd: process.execPath, pre: [env] } : { cmd: env, pre: [] }; // a .js path: run it with node (tests)
  const home = os.homedir();
  const known = IS_WIN
    ? [path.join(home, '.kimi-code', 'bin', 'kimi.exe'), path.join(home, '.local', 'bin', 'kimi.exe'), path.join(process.env.APPDATA || '', 'npm', 'kimi.cmd')]
    : [path.join(home, '.kimi-code', 'bin', 'kimi'), path.join(home, '.local', 'bin', 'kimi'), '/usr/local/bin/kimi', '/opt/homebrew/bin/kimi'];
  const hits = [...which('kimi'), ...known.filter(p => p && fs.existsSync(p))];
  for (const h of hits) {
    const low = h.toLowerCase();
    if (low.endsWith('.exe') || (!IS_WIN && !low.endsWith('.cmd'))) return { cmd: h, pre: [] };
    if (low.endsWith('.cmd') || low.endsWith('.ps1') || !path.extname(low)) {
      // npm shim: run the package's bin with node
      const pkgDir = path.join(path.dirname(h), 'node_modules', '@moonshot-ai', 'kimi-code');
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin.kimi || Object.values(pkg.bin)[0]);
        const node = which('node').find(p => !IS_WIN || p.toLowerCase().endsWith('.exe'));
        if (bin && node) return { cmd: node, pre: [path.join(pkgDir, bin)] };
      } catch {}
    }
  }
  return null;
}
let cached; const kimiCli = (refresh = false) => (refresh || cached === undefined ? (cached = resolveKimi()) : cached);

// one plain answer: the conversation in one prompt, run in an empty folder (nothing to read or edit there)
function chat({ messages, system, model, onDelta = () => {}, signal, timeoutMs = 180000 }) {
  const k = kimiCli();
  if (!k) return Promise.reject(new Error('Kimi Code نصب نیست («هسته‌ی هوش مصنوعی» ← Kimi ← نصب)'));
  const convo = messages.map(x => `${x.role === 'assistant' ? 'Assistant' : 'User'}: ${x.content}`).join('\n\n');
  const prompt = `This is a plain chat inside the JARVIS app. Do not run commands, read or edit files, or use tools — just answer directly.${system ? '\n\nInstructions:\n' + system : ''}\n\n${messages.length > 1 ? 'Conversation so far:\n' + convo + '\n\nReply to the last user message.' : (messages[0] || {}).content || ''}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-kimi-'));
  return new Promise((resolve, reject) => {
    const p = spawn(k.cmd, [...k.pre, '-p', prompt, '--output-format', 'text', ...(model ? ['-m', model] : [])], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
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
      if (/login|log in|unauthori|not authenticated|401/i.test(err)) return reject(new Error('اول وارد حساب Kimi شوید («هسته‌ی هوش مصنوعی» ← Kimi ← ورود)'));
      if (/quota|limit|429|membership|subscription|plan/i.test(err)) return reject(Object.assign(new Error('سهمیه‌ی Kimi پر شده یا اشتراک لازم است'), { busy: true }));
      reject(new Error('خطای Kimi: ' + (err.trim().split('\n').pop() || 'کد ' + code).slice(0, 300)));
    });
  });
}

const INSTALL_WIN = 'irm https://code.kimi.com/kimi-code/install.ps1 | iex';
const INSTALL_UNIX = 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';
module.exports = { kimiCli, chat, INSTALL_WIN, INSTALL_UNIX };
