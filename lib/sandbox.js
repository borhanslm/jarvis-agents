// Sandbox for running a project's tests (and other commands the team runs to check work):
//   copy   — a throw-away copy of the project in a temp folder, with your API keys and tokens
//            removed from the environment. The tests cannot change or delete the real project.
//            (Not a security boundary: the program still runs as you on this computer.)
//   docker — the copy inside a Docker container: no network (unless allowed), limited memory/CPU,
//            nothing of your computer visible except the copy. Needs Docker Desktop.
//   wsb    — the copy inside Windows Sandbox (a disposable Windows VM, no network). Needs the
//            "Windows Sandbox" Windows feature (Windows Pro/Enterprise).
// Same interface as testrun.run: { handle: { kill }, promise } -> { ok, exitCode, durationMs, output, timedOut, command, sandbox }.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, spawnSync } = require('child_process');

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', '.gradle', 'out', 'coverage']);
const LINK = ['node_modules', '.venv', 'venv']; // big dependency folders: linked, not copied
const SECRET = /key|token|secret|pass|auth|cookie|credential|session|private|^gh_|^github_|^aws_|^azure_|^gcp_|^openai|^anthropic/i;
const KEEP = /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|commonprogramfiles|processor_|number_of_processors|os|lang|lc_|java_home|gopath|goroot|cargo_home|rustup_home|pythonpath|virtual_env|nvm_|node_path|computername|username|systemdrive|homedrive|homepath|public)/i;

function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (KEEP.test(k) || !SECRET.test(k)) out[k] = v;
  for (const k of Object.keys(out)) if (SECRET.test(k) && !/^(path|pathext)$/i.test(k)) delete out[k];
  return { ...out, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', JARVIS_SANDBOX: '1' };
}

let dockerOk, wsbOk;
function hasDocker() {
  if (dockerOk !== undefined) return dockerOk;
  const r = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { windowsHide: true, timeout: 8000, encoding: 'utf8' });
  return (dockerOk = !r.error && r.status === 0 && /linux|windows/.test(r.stdout || ''));
}
const wsbExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
function hasWsb() { if (wsbOk === undefined) wsbOk = process.platform === 'win32' && fs.existsSync(wsbExe()); return wsbOk; }
function status() { return { copy: true, docker: hasDocker(), wsb: hasWsb() }; }
function resetCache() { dockerOk = undefined; wsbOk = undefined; }

// "auto" -> the strongest available
function pick(mode) {
  mode = String(mode || 'off');
  if (mode === 'auto') return hasDocker() ? 'docker' : 'copy';
  if (mode === 'docker' && !hasDocker()) throw new Error('Docker در دسترس نیست — Docker Desktop را نصب و اجرا کنید، یا حالت «کپی جدا» را انتخاب کنید');
  if (mode === 'wsb' && !hasWsb()) throw new Error('Windows Sandbox فعال نیست — در «Turn Windows features on or off» گزینه‌ی Windows Sandbox را روشن کنید (ویندوز Pro/Enterprise)، یا حالت دیگری انتخاب کنید');
  return ['copy', 'docker', 'wsb'].includes(mode) ? mode : 'off';
}

// a throw-away copy of the project; dependency folders are linked (junctions) so tests still find them
function makeCopy(src, { link = true } = {}) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sbx-'));
  const walk = (a, b) => {
    for (const e of fs.readdirSync(a, { withFileTypes: true })) {
      const s = path.join(a, e.name), d = path.join(b, e.name);
      if (e.isDirectory()) { if (SKIP.has(e.name)) continue; fs.mkdirSync(d, { recursive: true }); walk(s, d); }
      else if (e.isFile()) { try { fs.copyFileSync(s, d); } catch {} }
    }
  };
  walk(src, dst);
  if (link) for (const n of LINK) { const s = path.join(src, n); if (fs.existsSync(s)) try { fs.symlinkSync(s, path.join(dst, n), 'junction'); } catch {} }
  return dst;
}
// remove the copy without following the links into the real dependency folders
function removeCopy(dir) {
  if (!dir || !path.basename(dir).startsWith('jarvis-sbx-')) return;
  for (const n of LINK) { const p = path.join(dir, n); try { if (fs.lstatSync(p).isSymbolicLink() || isJunction(p)) fs.unlinkSync(p); } catch {} }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
function isJunction(p) { try { return fs.lstatSync(p).isSymbolicLink() || fs.realpathSync(p) !== path.resolve(p); } catch { return false; } }

function imageFor(cwd) {
  const has = f => fs.existsSync(path.join(cwd, f));
  if (has('package.json')) return 'node:22';
  if (has('pyproject.toml') || has('requirements.txt') || has('pytest.ini') || has('conftest.py')) return 'python:3.12';
  if (has('go.mod')) return 'golang:1.23';
  if (has('Cargo.toml')) return 'rust:1';
  if (has('pom.xml')) return 'maven:3-eclipse-temurin-21';
  return 'node:22';
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}
const tidy = (out, n = 6000) => { const c = String(out).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim(); return c.length > n ? '…\n' + c.slice(-n) : c; };

function run(cwd, command, { timeoutMs = 300000, mode = 'copy', image = '', network = false, setup = '' } = {}) {
  const t0 = Date.now(), kind = pick(mode);
  if (kind === 'off') throw new Error('sandbox is off');
  let out = '', child = null, timedOut = false, killed = false, dir = null, poll = null;
  const add = d => { out += String(d); if (out.length > 200000) out = out.slice(-100000); };
  const kill = () => { killed = true; killTree(child); };
  const promise = new Promise(resolve => {
    let finished = false;
    const done = code => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearInterval(poll); removeCopy(dir);
      resolve({ ok: code === 0 && !timedOut && !killed, exitCode: code, durationMs: Date.now() - t0, timedOut, killed, output: tidy(out), command, sandbox: kind });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); if (kind === 'wsb') done(-1); }, timeoutMs);
    try { dir = makeCopy(cwd, { link: kind !== 'wsb' }); } catch (e) { add('کپی پروژه نشد: ' + e.message); return done(-1); }
    add(`[sandbox: ${kind}]\n`);
    if (kind === 'copy') {
      child = spawn(command, { cwd: dir, shell: true, windowsHide: true, detached: process.platform !== 'win32', env: cleanEnv() });
    } else if (kind === 'docker') {
      const img = image || imageFor(cwd), args = ['run', '--rm', '-i', '--memory', '2g', '--cpus', '2', '--pids-limit', '512', '-v', `${dir}:/work`, '-w', '/work', '-e', 'CI=1'];
      if (!network) args.push('--network', 'none');
      // dependencies from the host do not fit Linux; install inside when there is network, else use what is there
      const nm = path.join(cwd, 'node_modules');
      if (!network && fs.existsSync(nm)) args.push('-v', `${nm}:/work/node_modules:ro`);
      const script = [setup || (network && fs.existsSync(path.join(cwd, 'package.json')) ? 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund' : ''), command].filter(Boolean).join(' && ');
      child = spawn('docker', [...args, img, 'sh', '-lc', script], { windowsHide: true, env: cleanEnv() });
    } else { // Windows Sandbox: a .wsb that maps the copy, runs the command, writes the result, shuts down
      const nodeDir = (() => { const r = spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true }); const f = (r.stdout || '').split(/\r?\n/)[0]; return f ? path.dirname(f) : ''; })();
      fs.writeFileSync(path.join(dir, '.jarvis-run.cmd'), `@echo off\r\ncd /d C:\\work\r\n${nodeDir ? 'set PATH=C:\\tools\\node;%PATH%\r\n' : ''}set CI=1\r\n${setup ? setup + ' >> C:\\work\\.jarvis-out.txt 2>&1\r\n' : ''}call ${command} > C:\\work\\.jarvis-out.txt 2>&1\r\necho %ERRORLEVEL% > C:\\work\\.jarvis-exit.txt\r\nshutdown /s /t 0\r\n`);
      const x = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const wsb = `<Configuration><VGpu>Disable</VGpu><Networking>${network ? 'Default' : 'Disable'}</Networking><ClipboardRedirection>Disable</ClipboardRedirection><PrinterRedirection>Disable</PrinterRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><MemoryInMB>4096</MemoryInMB>
<MappedFolders><MappedFolder><HostFolder>${x(dir)}</HostFolder><SandboxFolder>C:\\work</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>${nodeDir ? `<MappedFolder><HostFolder>${x(nodeDir)}</HostFolder><SandboxFolder>C:\\tools\\node</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>` : ''}</MappedFolders>
<LogonCommand><Command>cmd /c C:\\work\\.jarvis-run.cmd</Command></LogonCommand></Configuration>`;
      const wf = path.join(os.tmpdir(), path.basename(dir) + '.wsb'); fs.writeFileSync(wf, wsb);
      child = spawn(wsbExe(), [wf], { windowsHide: false, detached: true });
      const ef = path.join(dir, '.jarvis-exit.txt');
      poll = setInterval(() => {
        if (!fs.existsSync(ef)) return;
        try { add(fs.readFileSync(path.join(dir, '.jarvis-out.txt'), 'utf8')); } catch {}
        const code = parseInt(fs.readFileSync(ef, 'utf8'), 10); try { fs.unlinkSync(wf); } catch {}
        done(Number.isFinite(code) ? code : -1);
      }, 2000);
      child.on('error', e => { add(String(e.message || e)); done(-1); });
      return;
    }
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', e => { add(String(e.message || e)); done(-1); });
    child.on('close', code => done(code === null ? -1 : code));
  });
  return { handle: { kill: () => { kill(); } }, promise };
}

module.exports = { run, status, pick, cleanEnv, makeCopy, removeCopy, imageFor, resetCache };
