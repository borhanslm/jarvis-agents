// Computer control for the voice assistant (Windows): open programs, websites, searches and
// folders; volume and music keys; lock the screen; screenshots; close a program; shut down.
// Used by every brain (API or local Ollama). Risky actions (close, shut down) are confirmed by
// the brain first. Programs are found from the Start menu (Get-StartApps: normal and Store apps).
'use strict';
const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const ps = (script, timeout = 20000) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout, maxBuffer: 8e6 }, (err, out, errOut) => err ? reject(new Error(String(errOut || err.message).trim().slice(0, 300))) : resolve(String(out)));
});
// start something detached (the app keeps running after JARVIS)
const launch = (file, args = []) => { const p = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false }); p.on('error', () => {}); p.unref(); };

// ---- finding programs ----
// spoken names (Persian and casual English) -> words that appear in the Start menu name
const ALIASES = {
  'کروم': 'chrome', 'گوگل کروم': 'google chrome', 'مرورگر': 'chrome', 'فایرفاکس': 'firefox', 'اج': 'edge', 'اِج': 'edge',
  'نوت پد': 'notepad', 'نوت‌پد': 'notepad', 'دفترچه': 'notepad', 'ماشین حساب': 'calculator', 'حسابگر': 'calculator',
  'ورد': 'word', 'اکسل': 'excel', 'پاورپوینت': 'powerpoint', 'اوت لوک': 'outlook', 'تلگرام': 'telegram', 'واتساپ': 'whatsapp',
  'اسپاتیفای': 'spotify', 'وی اس کد': 'visual studio code', 'ویژوال استودیو کد': 'visual studio code', 'vscode': 'visual studio code', 'vs code': 'visual studio code',
  'فتوشاپ': 'photoshop', 'پینت': 'paint', 'فایل اکسپلورر': 'file explorer', 'اکسپلورر': 'file explorer', 'تنظیمات ویندوز': 'settings', 'تنظیمات': 'settings',
  'ترمینال': 'terminal', 'پاورشل': 'powershell', 'دیسکورد': 'discord', 'استیم': 'steam', 'زوم': 'zoom', 'اسکایپ': 'skype', 'وی ال سی': 'vlc', 'کلاد': 'claude',
  'تسک منیجر': 'task manager', 'مدیر وظایف': 'task manager', 'کنترل پنل': 'control panel', 'دوربین': 'camera', 'تقویم': 'calendar', 'ساعت': 'clock',
};
// a few built-in Windows tools that are not always in the Start list
const BUILTIN = { 'file explorer': ['explorer.exe'], 'task manager': ['taskmgr.exe'], 'control panel': ['control.exe'], 'settings': ['explorer.exe', 'ms-settings:'], 'notepad': ['notepad.exe'], 'calculator': ['calc.exe'], 'paint': ['mspaint.exe'], 'command prompt': ['cmd.exe'] };
const norm = s => String(s || '').toLowerCase().replace(/[‌\-_.]/g, ' ').replace(/\s+/g, ' ').trim();

let appsCache = null, appsAt = 0;
async function startApps() {
  if (appsCache && Date.now() - appsAt < 10 * 6e4) return appsCache;
  const out = await ps('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress');
  let list = []; try { list = JSON.parse(out); if (!Array.isArray(list)) list = [list]; } catch {}
  appsCache = list.filter(a => a && a.Name && a.AppID); appsAt = Date.now();
  return appsCache;
}
// best Start-menu match for a spoken name (null when nothing is close)
function matchApp(apps, spoken) {
  let q = norm(spoken).replace(/^(برنامه|اپ|نرم افزار|the|app)\s+/, '').replace(/\s+(را|رو|app|application)$/, '');
  q = norm(ALIASES[q] || ALIASES[q.replace(/ /g, '')] || q);
  if (!q) return null;
  const words = q.split(' ');
  let best = null, bestScore = 0;
  for (const a of apps) {
    const n = norm(a.Name);
    if (/uninstall|حذف|readme|help|documentation|website|release notes/.test(n)) continue;
    let s = 0;
    if (n === q) s = 100;
    else if (n.startsWith(q)) s = 80;
    else if (n.split(' ').includes(q)) s = 70;
    else if (n.includes(q)) s = 55;
    else { const hit = words.filter(w => w.length > 1 && n.includes(w)).length; if (hit) s = 30 * hit / words.length; }
    s -= n.length / 100; // shorter names win ties ("Google Chrome" over "Google Chrome Canary")
    if (s > bestScore) { best = a; bestScore = s; }
  }
  return bestScore >= 25 ? best : null;
}

async function openApp(name) {
  if (!IS_WIN) throw new Error('باز کردن برنامه فقط در ویندوز');
  const q = norm(ALIASES[norm(name)] || name);
  const app = matchApp(await startApps(), name);
  if (app) { launch('explorer.exe', ['shell:AppsFolder\\' + app.AppID]); return { opened: app.Name }; }
  if (BUILTIN[q]) { const [f, ...a] = BUILTIN[q]; launch(f, a); return { opened: name }; }
  // "open YouTube": a website, not a program
  if (SITES[norm(name)]) return openUrl(SITES[norm(name)]);
  throw new Error(`برنامه‌ای به اسم «${name}» در منوی استارت پیدا نشد`);
}

// ---- websites and searches (https only) ----
const SITES = { youtube: 'https://www.youtube.com', 'یوتیوب': 'https://www.youtube.com', google: 'https://www.google.com', 'گوگل': 'https://www.google.com', gmail: 'https://mail.google.com', 'جیمیل': 'https://mail.google.com',
  github: 'https://github.com', 'گیت هاب': 'https://github.com', instagram: 'https://www.instagram.com', 'اینستاگرام': 'https://www.instagram.com', wikipedia: 'https://www.wikipedia.org', 'ویکی پدیا': 'https://fa.wikipedia.org',
  chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai', x: 'https://x.com', twitter: 'https://x.com', 'توییتر': 'https://x.com', 'دیجی کالا': 'https://www.digikala.com', digikala: 'https://www.digikala.com', aparat: 'https://www.aparat.com', 'آپارات': 'https://www.aparat.com' };
function siteUrl(u) {
  const k = norm(u);
  if (SITES[k]) return SITES[k];
  let url = String(u || '').trim();
  if (!/^https?:\/\//i.test(url)) { if (!/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(url)) throw new Error('آدرس سایت معلوم نیست'); url = 'https://' + url; }
  if (!/^https:\/\//i.test(url)) url = url.replace(/^http:/i, 'https:');
  try { const x = new URL(url); if (x.protocol !== 'https:') throw 0; return x.href; } catch { throw new Error('آدرس سایت نامعتبر است'); }
}
const SEARCH = { google: 'https://www.google.com/search?q=', youtube: 'https://www.youtube.com/results?search_query=', wikipedia: 'https://fa.wikipedia.org/w/index.php?search=', maps: 'https://www.google.com/maps/search/' };
const openUrl = url => { if (IS_WIN) launch('rundll32.exe', ['url.dll,FileProtocolHandler', url]); else launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]); return { opened: url }; };

// ---- folders ----
const FOLDERS = { desktop: 'Desktop', 'دسکتاپ': 'Desktop', downloads: 'Downloads', 'دانلود': 'Downloads', 'دانلودها': 'Downloads', documents: 'Documents', 'اسناد': 'Documents', 'داکیومنت': 'Documents',
  pictures: 'Pictures', 'عکس': 'Pictures', 'عکس‌ها': 'Pictures', 'تصاویر': 'Pictures', music: 'Music', 'موزیک': 'Music', 'آهنگ': 'Music', videos: 'Videos', 'فیلم': 'Videos', 'ویدیو': 'Videos', home: '' };
function folderPath(f) {
  const k = norm(f).replace(/^پوشه /, '');
  const known = Object.entries(FOLDERS).find(([n]) => norm(n) === k);
  const p = known ? path.join(os.homedir(), known[1]) : String(f || '');
  if (!path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('پوشه پیدا نشد: ' + f);
  return p;
}

// ---- keys: volume and music (virtual key codes through WScript.Shell) ----
const KEY = { mute: 173, down: 174, up: 175, next: 176, prev: 177, play_pause: 179 };
const pressKey = (code, times = 1) => ps(`$w = New-Object -ComObject WScript.Shell; for ($i = 0; $i -lt ${Math.max(1, Math.min(50, times | 0))}; $i++) { $w.SendKeys([char]${code}) }`);
async function volume(action, level) {
  if (action === 'mute') return pressKey(KEY.mute).then(() => ({ volume: 'mute' }));
  if (action === 'set' && Number.isFinite(+level)) { await pressKey(KEY.down, 50); await pressKey(KEY.up, Math.round(Math.max(0, Math.min(100, +level)) / 2)); return { volume: Math.round(+level) }; }
  await pressKey(action === 'down' ? KEY.down : KEY.up, 5); // one press = 2%
  return { volume: action === 'down' ? 'down' : 'up' };
}

// ---- screenshot of all screens -> Pictures\JARVIS ----
async function screenshot() {
  const dir = path.join(os.homedir(), 'Pictures', 'JARVIS'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'screenshot-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png');
  await ps(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()`);
  return { file };
}

// ---- closing a program: by its window title or process name, politely (no force) ----
async function closeApp(name) {
  const q = norm(ALIASES[norm(name)] || name);
  const out = await ps('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress');
  let list = []; try { list = JSON.parse(out); if (!Array.isArray(list)) list = [list]; } catch {}
  const hit = list.filter(p => norm(p.ProcessName).includes(q.replace(/^google /, '')) || norm(p.MainWindowTitle).includes(q));
  if (!hit.length) throw new Error(`پنجره‌ای از «${name}» باز نیست`);
  if (hit.some(p => /^(jarvis|electron)$/i.test(p.ProcessName))) throw new Error('جارویس خودش را نمی‌بندد');
  await ps(`${hit.map(p => `(Get-Process -Id ${+p.Id} -ErrorAction SilentlyContinue).CloseMainWindow() | Out-Null`).join('; ')}`);
  return { closed: hit.length };
}

async function power(action) {
  if (!IS_WIN) throw new Error('فقط در ویندوز');
  if (action === 'lock') { launch('rundll32.exe', ['user32.dll,LockWorkStation']); return { power: 'lock' }; }
  if (action === 'sleep') { await ps('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false) | Out-Null'); return { power: 'sleep' }; }
  // a one-minute warning: "shutdown /a" cancels
  if (action === 'shutdown') { launch('shutdown.exe', ['/s', '/t', '60', '/c', 'JARVIS: shutting down in one minute (shutdown /a to cancel)']); return { power: 'shutdown', inSeconds: 60 }; }
  if (action === 'restart') { launch('shutdown.exe', ['/r', '/t', '60', '/c', 'JARVIS: restarting in one minute (shutdown /a to cancel)']); return { power: 'restart', inSeconds: 60 }; }
  if (action === 'cancel') { launch('shutdown.exe', ['/a']); return { power: 'cancel' }; }
  throw new Error('کار نامعتبر');
}

// one entry point for the brain's actions
async function run(type, p = {}) {
  if (type === 'open_app') return openApp(p.name);
  if (type === 'open_url') return openUrl(siteUrl(p.url));
  if (type === 'web_search') { const where = SEARCH[p.site] ? p.site : 'google'; const q = String(p.query || '').trim(); if (!q) throw new Error('چه چیزی جستجو شود؟'); return openUrl(SEARCH[where] + encodeURIComponent(q)); }
  if (type === 'open_folder') { const f = folderPath(p.folder); launch('explorer.exe', [f]); return { opened: f }; }
  if (type === 'volume') return volume(p.action, p.level);
  if (type === 'media') { if (!KEY[p.action]) throw new Error('کار نامعتبر'); await pressKey(KEY[p.action]); return { media: p.action }; }
  if (type === 'screenshot') return screenshot();
  if (type === 'close_app') return closeApp(p.name);
  if (type === 'power') return power(p.action);
  throw new Error('کار نامعتبر');
}

module.exports = { run, matchApp, siteUrl, folderPath, startApps, ALIASES, SEARCH };
