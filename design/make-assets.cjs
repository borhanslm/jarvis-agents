// Render brand assets with Electron (run: npx electron design/make-assets.cjs)
//   public/logo.svg            -> build/icon.ico (16..256) + build/icon.png (512)
//   design/assets/*.html       -> exact-size PNG (banners) / 24-bit BMP (NSIS installer images)
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
// Chromium can't load file:// pages from very long Windows paths, so the asset pages
// (plus the tokens and fonts they reference) are staged into a short temp folder.
const os = require('os');
const STAGE = path.join(os.tmpdir(), 'jv-assets');
function stage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
  copy(path.join(__dirname, 'assets'), path.join(STAGE, 'design', 'assets'));
  copy(path.join(ROOT, 'public', 'tokens.css'), path.join(STAGE, 'public', 'tokens.css'));
  copy(path.join(ROOT, 'public', 'fonts'), path.join(STAGE, 'public', 'fonts'));
}
const A = f => path.join(STAGE, 'design', 'assets', f);
const JOBS = [
  { html: A('banner-neon.html'),       w: 1280, h: 640, out: 'docs/banners/neon-1280x640.png' },
  { html: A('banner-glass.html'),      w: 1280, h: 640, out: 'docs/banners/glass-1280x640.png' },
  { html: A('banner-geometric.html'),  w: 1280, h: 640, out: 'docs/banners/geometric-1280x640.png' },
  { html: A('installer-sidebar.html'), w: 164,  h: 314, out: 'build/installerSidebar.bmp' },
  { html: A('installer-header.html'),  w: 150,  h: 57,  out: 'build/installerHeader.bmp' },
];

// One reusable offscreen window per kind (destroying a window and opening a new one
// right away made the next load abort with ERR_FAILED on Windows).
const wins = {};
function windowFor(transparent) {
  const k = transparent ? 't' : 'o';
  if (!wins[k]) wins[k] = new BrowserWindow({ width: 800, height: 600, show: false, useContentSize: true, frame: false, transparent,
    backgroundColor: transparent ? '#00000000' : '#FFFFFF', webPreferences: { offscreen: true } });
  return wins[k];
}
async function render(file, w, h, transparent = false) {
  const win = windowFor(transparent);
  win.setContentSize(w, h);
  await win.loadFile(file);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(r => setTimeout(r, 300)))');
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  const s = img.getSize();
  return s.width === w && s.height === h ? img : img.resize({ width: w, height: h, quality: 'best' });
}

// 24-bit bottom-up BMP from a nativeImage (toBitmap() is BGRA, top-down).
function toBmp24(img) {
  const { width: w, height: h } = img.getSize();
  const bgra = img.toBitmap();
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * h, 34); b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const dst = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      b[dst + x * 3] = bgra[s]; b[dst + x * 3 + 1] = bgra[s + 1]; b[dst + x * 3 + 2] = bgra[s + 2];
    }
  }
  return b;
}

// ICO with PNG-compressed entries (Windows Vista+).
function toIco(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map(p => p.data)]);
}

app.whenReady().then(async () => {
  try {
    stage();
    fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    fs.mkdirSync(path.join(ROOT, 'docs', 'banners'), { recursive: true });
    // App icon from the logo (rendered once at 512, then downscaled per size).
    const tmp = path.join(app.getPath('temp'), 'jarvis-logo-render.html');
    fs.writeFileSync(tmp, `<!doctype html><html style="overflow:hidden;background:transparent"><body style="margin:0;overflow:hidden;background:transparent">${fs.readFileSync(path.join(ROOT, 'public', 'logo.svg'), 'utf8').replace('<svg ', '<svg width="512" height="512" style="display:block" ')}</body></html>`);
    const big = await render(tmp, 512, 512, true);
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), big.toPNG());
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const ico = toIco(sizes.map(size => ({ size, data: big.resize({ width: size, height: size, quality: 'best' }).toPNG() })));
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
    fs.writeFileSync(path.join(ROOT, 'desktop', 'icon.ico'), ico); // window icon at runtime
    console.log('icon: build/icon.ico (' + sizes.join(', ') + ') + build/icon.png');
    for (const j of JOBS) {
      const img = await render(j.html, j.w, j.h);
      const out = path.join(ROOT, j.out);
      fs.writeFileSync(out, out.endsWith('.bmp') ? toBmp24(img) : img.toPNG());
      const sz = img.getSize();
      console.log(`${j.out}: ${sz.width}x${sz.height}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
    }
  } catch (e) { console.error(e); process.exitCode = 1; }
  app.quit();
});
