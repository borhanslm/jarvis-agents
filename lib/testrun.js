// Runs the project's own test command (npm test, pytest, …) so a round is judged by real
// test results, not only by the reviewer's opinion.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const exists = (cwd, f) => fs.existsSync(path.join(cwd, f));

// Best guess at the test command; null when the project has no obvious one.
function detect(cwd) {
  try {
    if (exists(cwd, 'package.json')) {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const t = pkg.scripts && pkg.scripts.test;
      if (t && !/no test specified/i.test(t)) return 'npm test --silent';
    }
    if (exists(cwd, 'pytest.ini') || exists(cwd, 'tox.ini') || exists(cwd, 'conftest.py')) return 'python -m pytest -q';
    if (exists(cwd, 'pyproject.toml') && /\[tool\.pytest/.test(fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8'))) return 'python -m pytest -q';
    if (exists(cwd, 'tests') && fs.readdirSync(path.join(cwd, 'tests')).some(f => /^test_.*\.py$/.test(f))) return 'python -m pytest -q';
    if (exists(cwd, 'go.mod')) return 'go test ./...';
    if (exists(cwd, 'Cargo.toml')) return 'cargo test';
    if (exists(cwd, 'pom.xml')) return 'mvn -q test';
    if (exists(cwd, 'gradlew') || exists(cwd, 'gradlew.bat')) return process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test';
    if (fs.readdirSync(cwd).some(f => /\.(sln|csproj)$/.test(f))) return 'dotnet test';
  } catch {}
  return null;
}

// "auto" -> detected command; "" -> off.
function resolve(cwd, setting) {
  const v = String(setting || '').trim();
  if (!v) return null;
  if (v === 'auto') return detect(cwd);
  return v;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

// Returns { handle: { kill }, promise } -> { ok, exitCode, durationMs, output, timedOut, command }
function run(cwd, command, { timeoutMs = 300000 } = {}) {
  const t0 = Date.now();
  let out = '';
  const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
  const add = d => { out += String(d); if (out.length > 200000) out = out.slice(-100000); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  let timedOut = false, killed = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
  const promise = new Promise(resolve => {
    const done = code => {
      clearTimeout(timer);
      const clean = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      resolve({ ok: code === 0 && !timedOut && !killed, exitCode: code, durationMs: Date.now() - t0, timedOut, killed,
        output: clean.length > 6000 ? '…\n' + clean.slice(-6000) : clean, command });
    };
    child.on('error', e => { add(String(e.message || e)); done(-1); });
    child.on('close', code => done(code === null ? -1 : code));
  });
  return { handle: { kill: () => { killed = true; killTree(child); } }, promise };
}

module.exports = { detect, resolve, run };
