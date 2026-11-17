// Offline voice components, downloaded only when the user asks (sizes are shown first).
// Everything is stored in DATA/voice/<id>/ and comes from the projects' official releases.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HF = 'https://huggingface.co';
const ITEMS = {
  'whisper-bin': { label: 'موتور تبدیل گفتار به متن (whisper.cpp)', size: 4e6, zip: true,
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip' },
  // NVIDIA graphics cards: about 20x faster (0.3 s instead of 5 s for a sentence)
  'whisper-cuda': { label: 'موتور گفتار روی کارت گرافیک NVIDIA (CUDA)', size: 684913404, zip: true, gpu: true,
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip' },
  'whisper-turbo': { label: 'مدل گفتار دقیق، فارسی خوب (large-v3-turbo)', size: 574041195,
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`, file: 'model.bin' },
  'whisper-base': { label: 'مدل گفتار سبک و سریع (base، فارسی ضعیف‌تر)', size: 147951465,
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`, file: 'model.bin' },
  'piper-bin': { label: 'موتور تبدیل متن به گفتار (Piper)', size: 22e6, zip: true,
    url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip' },
  'voice-fa-amir': { label: 'صدای فارسی «امیر»', size: 63531379, files: {
    'voice.onnx': `${HF}/rhasspy/piper-voices/resolve/main/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx`,
    'voice.onnx.json': `${HF}/rhasspy/piper-voices/resolve/main/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx.json` } },
  'voice-fa-gyro': { label: 'صدای فارسی «ژیرو»', size: 63122309, files: {
    'voice.onnx': `${HF}/rhasspy/piper-voices/resolve/main/fa/fa_IR/gyro/medium/fa_IR-gyro-medium.onnx`,
    'voice.onnx.json': `${HF}/rhasspy/piper-voices/resolve/main/fa/fa_IR/gyro/medium/fa_IR-gyro-medium.onnx.json` } },
  'voice-en-lessac': { label: 'صدای انگلیسی «Lessac»', size: 63201294, files: {
    'voice.onnx': `${HF}/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx`,
    'voice.onnx.json': `${HF}/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json` } },
  // audio conversion: voice notes from Telegram/Bale, voice replies, and later the video studio
  'ffmpeg': { label: 'FFmpeg — تبدیل صدا و ویدیو (برای پیام صوتی تلگرام)', size: 167645963, zip: true, win: true,
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip' },
  'wakeword': { label: 'تشخیص «هی جارویس» (openWakeWord)', size: 3.6e6, files: {
    'melspectrogram.onnx': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx',
    'embedding_model.onnx': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx',
    'hey_jarvis.onnx': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/hey_jarvis_v0.1.onnx' } },
};

class VoiceAssets {
  constructor(dataDir, { onProgress } = {}) {
    this.dir = path.join(dataDir, 'voice');
    this.onProgress = onProgress || (() => {});
    this.jobs = new Map(); // id -> { got, total, error }
  }
  folder(id) { return path.join(this.dir, id); }
  has(id) { try { return fs.existsSync(path.join(this.folder(id), '.done')); } catch { return false; } }
  status() {
    return Object.fromEntries(Object.entries(ITEMS).map(([id, it]) => {
      const j = this.jobs.get(id);
      return [id, { label: it.label, size: it.size, installed: this.has(id), downloading: !!(j && !j.error && !j.done), got: j ? j.got : 0, total: j ? j.total : it.size, error: j && j.error || null }];
    }));
  }
  // Find a file anywhere inside an installed item (zips have their own folder layout).
  find(id, name) {
    const walk = d => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
      for (const e of ents) { const p = path.join(d, e.name); if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p; }
      for (const e of ents) if (e.isDirectory()) { const r = walk(path.join(d, e.name)); if (r) return r; }
      return null;
    };
    return this.has(id) ? walk(this.folder(id)) : null;
  }

  download(id) {
    const it = ITEMS[id];
    if (!it) throw new Error('مورد ناشناخته');
    if (this.has(id)) return { installed: true };
    if (this.jobs.has(id) && !this.jobs.get(id).error && !this.jobs.get(id).done) return { downloading: true };
    const job = { got: 0, total: it.size, error: null, done: false };
    this.jobs.set(id, job);
    const dest = this.folder(id);
    const tmp = dest + '.part';
    (async () => {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      const files = it.files || { [it.file || (it.zip ? 'download.zip' : 'file.bin')]: it.url };
      for (const [name, url] of Object.entries(files)) await this._fetch(url, path.join(tmp, name), job);
      if (it.zip) {
        await new Promise((res, rej) => execFile(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', path.join(tmp, 'download.zip'), '-C', tmp], { windowsHide: true }, e => e ? rej(new Error('باز کردن فایل فشرده ناموفق بود: ' + e.message)) : res()));
        fs.rmSync(path.join(tmp, 'download.zip'), { force: true });
      }
      fs.writeFileSync(path.join(tmp, '.done'), new Date().toISOString());
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
      job.done = true; job.got = job.total;
      this.onProgress(id, this.status()[id]);
    })().catch(e => { job.error = String(e.message || e); fs.rm(tmp, { recursive: true, force: true }, () => {}); this.onProgress(id, this.status()[id]); });
    return { downloading: true };
  }

  async _fetch(url, file, job) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`دانلود ناموفق بود (${res.status})`);
    const out = fs.createWriteStream(file);
    let last = 0;
    try {
      for await (const chunk of res.body) {
        job.got += chunk.length;
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        if (Date.now() - last > 500) { last = Date.now(); this.onProgress(null, null); }
      }
    } finally { await new Promise(r => out.end(r)); }
  }

  remove(id) { fs.rmSync(this.folder(id), { recursive: true, force: true }); this.jobs.delete(id); }
}

module.exports = { VoiceAssets, ITEMS };
