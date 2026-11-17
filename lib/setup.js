// First-run setup: detect the CLIs, connect accounts, store keys.
//
// Everything stays on this computer. Keys are encrypted with Windows DPAPI via
// Electron's safeStorage when running as the desktop app, and handed only to the
// matching CLI process as an environment variable.
//
// Claude: Anthropic's docs say third-party products may not offer claude.ai
// (Pro/Max subscription) login unless Anthropic approved it, so the desktop build
// connects Claude with an API key by default. ALLOW_CLAUDE_AI_LOGIN turns the
// subscription-login option on (package.json "jarvis.allowClaudeAiLogin", or
// JARVIS_ALLOW_CLAUDE_LOGIN=1). Running plain `node server.js` for yourself keeps it on.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const agents = require('./agents');

const IS_WIN = process.platform === 'win32';
const pkg = (() => { try { return require('../package.json'); } catch { return {}; } })();
const DESKTOP = process.env.JARVIS_DESKTOP === '1';
const ALLOW_CLAUDE_AI_LOGIN = process.env.JARVIS_ALLOW_CLAUDE_LOGIN !== undefined
  ? process.env.JARVIS_ALLOW_CLAUDE_LOGIN === '1'
  : DESKTOP ? !!(pkg.jarvis && pkg.jarvis.allowClaudeAiLogin) : true;

let electron = null;
try { if (process.versions.electron) electron = require('electron'); } catch {}

// ---- encrypted secrets ----------------------------------------------------
class Secrets {
  constructor(dir) { this.file = path.join(dir, 'secrets.json'); this.data = {}; try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {} }
  get encrypted() { return !!(electron && electron.safeStorage && electron.safeStorage.isEncryptionAvailable()); }
  get(name) {
    const v = this.data[name];
    if (!v) return null;
    try {
      if (v.enc) return this.encrypted ? electron.safeStorage.decryptString(Buffer.from(v.enc, 'base64')) : null;
      return Buffer.from(v.plain, 'base64').toString('utf8');
    } catch { return null; }
  }
  set(name, value) {
    if (value == null || value === '') delete this.data[name];
    else this.data[name] = this.encrypted
      ? { enc: electron.safeStorage.encryptString(value).toString('base64') }
      : { plain: Buffer.from(value, 'utf8').toString('base64') }; // dev mode only (no safeStorage)
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }
}

// ---- helpers --------------------------------------------------------------
function openExternal(url) {
  if (!/^https:\/\//.test(url)) return;
  if (electron && electron.shell) return electron.shell.openExternal(url);
  if (IS_WIN) execFile('rundll32', ['url.dll,FileProtocolHandler', url], () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
}

// Open a visible terminal window running a command (installers need to show progress).
// A detached spawn from the GUI app gets no console at all (libuv's DETACHED_PROCESS), so the
// window never appeared. Start-Process asks Windows for a real new console window instead; the
// command travels base64-encoded so no quoting can break it.
const psQuote = s => "'" + String(s).replace(/'/g, "''") + "'";
function terminalLauncher(command, shell = 'powershell') {
  if (shell === 'cmd') return `Start-Process cmd.exe -ArgumentList ${psQuote('/k ' + command)}`;
  const enc = Buffer.from(command, 'utf16le').toString('base64');
  return `Start-Process powershell.exe -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${enc}'`;
}
function openTerminal(command, shell = 'powershell') {
  if (!IS_WIN) return false;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', terminalLauncher(command, shell)], { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  return true;
}

class Setup {
  constructor(dataDir) {
    this.secrets = new Secrets(dataDir);
    this.logins = {}; // name -> { started, done, ok, out }
    this.applyAuth();
  }

  // Give the CLIs their credentials (env only, per process).
  applyAuth() {
    const key = this.secrets.get('anthropicApiKey');
    agents.setAuthEnv('claude', key ? { ANTHROPIC_API_KEY: key } : {});
  }

  async status() {
    agents.refreshClis();
    const [cv, xv, ca, xa] = await Promise.all([
      agents.CLIS.claude ? agents.runOnce('claude', ['--version'], { timeout: 20000 }) : null,
      agents.CLIS.codex ? agents.runOnce('codex', ['--version'], { timeout: 20000 }) : null,
      agents.CLIS.claude ? agents.runOnce('claude', ['auth', 'status'], { timeout: 20000 }) : null,
      agents.CLIS.codex ? agents.runOnce('codex', ['login', 'status'], { timeout: 20000 }) : null,
    ]);
    let claudeAuth = null;
    try { claudeAuth = ca && JSON.parse(ca.out); } catch {}
    const hasKey = !!this.secrets.get('anthropicApiKey');
    const subscription = !!(claudeAuth && claudeAuth.loggedIn && claudeAuth.authMethod === 'claude.ai');
    const claudeConnected = hasKey || (claudeAuth && claudeAuth.loggedIn && (claudeAuth.authMethod !== 'claude.ai' || ALLOW_CLAUDE_AI_LOGIN));
    const codexText = xa ? (xa.out || xa.err) : '';
    return {
      local: true,
      encryptedSecrets: this.secrets.encrypted,
      allowClaudeAiLogin: ALLOW_CLAUDE_AI_LOGIN,
      claude: {
        installed: !!agents.CLIS.claude,
        version: cv && cv.code === 0 ? cv.out : null,
        apiKey: hasKey,
        cliLogin: claudeAuth ? { loggedIn: !!claudeAuth.loggedIn, method: claudeAuth.authMethod || null } : null,
        subscriptionBlocked: subscription && !ALLOW_CLAUDE_AI_LOGIN && !hasKey,
        connected: !!claudeConnected,
        via: hasKey ? 'apiKey' : claudeConnected ? (claudeAuth.authMethod || 'cli') : null,
        login: this.logins.claude || null,
      },
      codex: {
        installed: !!agents.CLIS.codex,
        version: xv && xv.code === 0 ? xv.out : null,
        connected: !!(xa && xa.code === 0 && /logged in/i.test(codexText)),
        via: /api key/i.test(codexText) ? 'apiKey' : /chatgpt/i.test(codexText) ? 'chatgpt' : null,
        login: this.logins.codex || null,
      },
      git: { installed: agents.which('git').length > 0 },
      node: { installed: agents.which('node').length > 0, npm: agents.which('npm').length > 0 },
    };
  }

  // Claude is usable for a run? (API key, or a CLI login that this build allows)
  async claudeReady() {
    if (this.secrets.get('anthropicApiKey')) return true;
    if (!agents.CLIS.claude) return false;
    const r = await agents.runOnce('claude', ['auth', 'status'], { timeout: 20000 });
    try {
      const j = JSON.parse(r.out);
      return !!j.loggedIn && (j.authMethod !== 'claude.ai' || ALLOW_CLAUDE_AI_LOGIN);
    } catch { return false; }
  }

  setClaudeKey(key) {
    key = String(key || '').trim();
    if (key && !/^sk-ant-[\w-]{20,}$/.test(key)) throw new Error('کلید Anthropic باید با sk-ant- شروع شود');
    this.secrets.set('anthropicApiKey', key || null);
    this.applyAuth();
    return { ok: true };
  }

  async setCodexKey(key) {
    key = String(key || '').trim();
    if (!/^sk-[\w-]{20,}$/.test(key)) throw new Error('کلید OpenAI باید با sk- شروع شود');
    if (!agents.CLIS.codex) throw new Error('اول Codex را نصب کنید');
    // Codex stores it in its own auth file (~/.codex); we don't keep a copy.
    const r = await agents.runOnce('codex', ['login', '--with-api-key'], { input: key + '\n', timeout: 30000 });
    if (r.code !== 0) throw new Error((r.err || r.out || 'codex login failed').slice(0, 400));
    return { ok: true };
  }

  // Browser-based sign-in, handled entirely by the official CLI.
  login(name) {
    if (name === 'claude' && !ALLOW_CLAUDE_AI_LOGIN) throw new Error('ورود با اشتراک Claude در این نسخه فعال نیست؛ از کلید API استفاده کنید.');
    if (!agents.CLIS[name]) throw new Error('اول این CLI را نصب کنید');
    const c = agents.CLIS[name];
    const args = name === 'claude' ? ['auth', 'login'] : ['login'];
    const st = { started: Date.now(), done: false, ok: false, out: '' };
    this.logins[name] = st;
    const child = spawn(c.cmd, [...c.pre, ...args], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const grab = d => {
      st.out = (st.out + d).slice(-4000);
      // Some CLIs print the sign-in URL instead of opening it.
      const m = String(d).match(/https:\/\/[^\s"'<>]+/);
      if (m && !st.url) { st.url = m[0]; openExternal(st.url); }
    };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.on('close', code => { st.done = true; st.ok = code === 0; });
    child.on('error', e => { st.done = true; st.ok = false; st.out += String(e); });
    setTimeout(() => { if (!st.done) { try { child.kill(); } catch {} } }, 10 * 60 * 1000);
    return { ok: true };
  }

  async logout(name) {
    if (name === 'claude') { this.setClaudeKey(''); return { ok: true }; }
    const r = await agents.runOnce('codex', ['logout'], { timeout: 20000 });
    return { ok: r.code === 0 };
  }

  // Official installers, shown in a visible window so the user sees what runs.
  // Update a CLI in a visible terminal (official updater / npm).
  update(name) {
    if (name === 'claude') { if (!IS_WIN) return { ok: false, err: 'claude update' }; openTerminal('Write-Host "Updating Claude Code..."; claude update; Write-Host ""; Write-Host "Done. Close this window."'); return { ok: true }; }
    if (name === 'codex') { if (!IS_WIN) return { ok: false, err: 'npm install -g @openai/codex@latest' }; openTerminal('echo Updating Codex CLI... && npm install -g @openai/codex@latest && echo. && echo Done. Close this window.', 'cmd'); return { ok: true }; }
    throw new Error('unknown CLI');
  }
  install(name) {
    if (name === 'claude') {
      if (!IS_WIN) { openExternal('https://code.claude.com/docs/en/setup'); return { ok: true, opened: 'docs' }; }
      openTerminal('Write-Host "Installing Claude Code (official installer)..."; irm https://claude.ai/install.ps1 | iex; Write-Host ""; Write-Host "Done. Close this window and press Check again in JARVIS."');
      return { ok: true };
    }
    if (name === 'codex') {
      if (!agents.which('npm').length) { openExternal('https://nodejs.org/en/download'); return { ok: false, needNode: true }; }
      if (!IS_WIN) return { ok: false, err: 'npm install -g @openai/codex' };
      openTerminal('echo Installing Codex CLI... && npm install -g @openai/codex && echo. && echo Done. Close this window and press Check again in JARVIS.', 'cmd');
      return { ok: true };
    }
    if (name === 'git') { openExternal('https://git-scm.com/downloads'); return { ok: true, opened: 'download page' }; }
    if (name === 'node') { openExternal('https://nodejs.org/en/download'); return { ok: true, opened: 'download page' }; }
    if (name === 'anthropic-keys') { openExternal('https://console.anthropic.com/settings/keys'); return { ok: true }; }
    if (name === 'openai-keys') { openExternal('https://platform.openai.com/api-keys'); return { ok: true }; }
    throw new Error('unknown');
  }
}

module.exports = { Setup, ALLOW_CLAUDE_AI_LOGIN, openExternal, openTerminal, terminalLauncher };
