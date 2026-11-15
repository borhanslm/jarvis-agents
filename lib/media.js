// Audio conversion with FFmpeg (downloaded on request as a voice component, or found on PATH).
// Telegram/Bale voice notes are OGG/Opus; whisper wants 16 kHz mono WAV; replies go back as OGG/Opus.
'use strict';

const { spawn, execFileSync } = require('child_process');

class Media {
  constructor(assets) { this.assets = assets; this._sys = undefined; }
  ffmpeg() {
    const own = this.assets && this.assets.find('ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (own) return own;
    if (this._sys === undefined) {
      try { this._sys = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { windowsHide: true, timeout: 5000 }).toString().split(/\r?\n/)[0].trim() || null; } catch { this._sys = null; }
    }
    return this._sys;
  }
  ready() { return !!this.ffmpeg(); }
  // input buffer -> output buffer through ffmpeg pipes
  run(input, args, timeoutMs = 60000) {
    const exe = this.ffmpeg();
    if (!exe) return Promise.reject(new Error('FFmpeg نصب نیست. از «تنظیمات صدا» آن را دانلود کنید.'));
    return new Promise((resolve, reject) => {
      const p = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...args, 'pipe:1'], { windowsHide: true });
      const out = []; let err = '';
      const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('تبدیل صدا بیش از حد طول کشید')); }, timeoutMs);
      p.stdout.on('data', d => out.push(d));
      p.stderr.on('data', d => { err = (err + d).slice(-1500); });
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', code => { clearTimeout(timer); const b = Buffer.concat(out); if (code === 0 && b.length) resolve(b); else reject(new Error('FFmpeg: ' + (err.trim() || 'کد ' + code))); });
      p.stdin.on('error', () => {});
      p.stdin.end(input);
    });
  }
  toWav16k(buf) { return this.run(buf, ['-ac', '1', '-ar', '16000', '-f', 'wav']); }
  toOggOpus(buf) { return this.run(buf, ['-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg']); }
}

module.exports = { Media };
