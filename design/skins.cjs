// 12 looks ("skins") for every taste. Each skin has a dark and a light palette plus its own
// corner radius, surface style (frosted glass or solid) and background (aurora, grid, dots, plain).
// Generates public/skins.css (token overrides) and public/skins.js (gallery data), and checks
// text contrast (WCAG AA 4.5:1) for every skin in both modes. Run: node design/skins.cjs
'use strict';
const fs = require('fs');
const path = require('path');

// status colours are shared (tuned for dark and light separately)
const STATUS = {
  dark: { success: '#4ADE80', warning: '#FACC15', danger: '#F87171', info: '#60A5FA' },
  light: { success: '#15803D', warning: '#A16207', danger: '#B91C1C', info: '#1D4ED8' },
};

// p = palette: bg, s1, s2, s3, inset, fg, strong, muted, primary, on, ga, gb, claude, codex, au (aurora rgb triplets)
const SKINS = [
  { id: 'holo', name: 'هولوگرام', en: 'Holo', desc: 'شیشه‌ی مات روی شفق آبی-بنفش', radius: 18, glass: true, bg: 'aurora', base: true,
    dark: { bg: '#070A1C', s1: '#0C1129', s2: '#121838', s3: '#1D2552', inset: '#04050F', fg: '#E6E9FF', strong: '#FFFFFF', muted: '#A3ABD6', primary: '#93A8FF', on: '#0A0D26', ga: '#93A8FF', gb: '#C4A5FF', claude: '#FFB98A', codex: '#5EEAD4', au: ['79 107 255', '139 92 246', '34 211 238'] },
    light: { bg: '#EEF0FB', s1: '#FFFFFF', s2: '#F7F8FE', s3: '#E3E6F6', inset: '#F1F3FC', fg: '#1E2140', strong: '#0B0D24', muted: '#565B85', primary: '#4338CA', on: '#FFFFFF', ga: '#4338CA', gb: '#6D28D9', claude: '#B4470F', codex: '#0F766E', au: ['99 102 241', '168 85 247', '34 211 238'] } },
  { id: 'jarvis', name: 'جارویس', en: 'JARVIS', desc: 'آبی یخیِ هولوگرافیک با کهربایی؛ حلقه‌ها و قاب‌های HUD', radius: 2, glass: false, bg: 'grid',
    dark: { bg: '#020A12', s1: '#06131F', s2: '#0A1B2A', s3: '#123047', inset: '#01060C', fg: '#DDF6FF', strong: '#FFFFFF', muted: '#86B6C9', primary: '#4FD8FF', on: '#001620', ga: '#4FD8FF', gb: '#FFB347', claude: '#FFB347', codex: '#9FE8FF' },
    light: { bg: '#EEF6FA', s1: '#FFFFFF', s2: '#F5FAFC', s3: '#DCEBF2', inset: '#E7F1F6', fg: '#08202C', strong: '#00121A', muted: '#45677A', primary: '#0B6F94', on: '#FFFFFF', ga: '#0B6F94', gb: '#B45309', claude: '#B45309', codex: '#0E7490' } },
  { id: 'midnight', name: 'نیمه‌شب', en: 'Midnight', desc: 'سیاه مطلق و ساده؛ مناسب صفحه‌های OLED', radius: 10, glass: false, bg: 'plain',
    dark: { bg: '#000000', s1: '#0A0A0B', s2: '#121214', s3: '#1E1E22', inset: '#050506', fg: '#E7E7EA', strong: '#FFFFFF', muted: '#9C9CA6', primary: '#A5B4FC', on: '#0B0B14', ga: '#A5B4FC', gb: '#C4B5FD', claude: '#FDBA74', codex: '#5EEAD4' },
    light: { bg: '#F6F6F7', s1: '#FFFFFF', s2: '#FAFAFB', s3: '#E7E7EA', inset: '#F1F1F3', fg: '#18181B', strong: '#000000', muted: '#5B5B66', primary: '#4F46E5', on: '#FFFFFF', ga: '#4F46E5', gb: '#6D28D9', claude: '#C2410C', codex: '#0F766E' } },
  { id: 'armor', name: 'زره', en: 'Armor', desc: 'گرافیتی با طلایی و قرمز؛ الهام از زره مرد آهنی', radius: 8, glass: true, bg: 'aurora',
    dark: { bg: '#0D0B0A', s1: '#16120F', s2: '#1E1814', s3: '#2E241D', inset: '#090706', fg: '#F3E9DC', strong: '#FFF8EE', muted: '#B5A28C', primary: '#F5B942', on: '#1A0F00', ga: '#F5B942', gb: '#EF5A4C', claude: '#FF8A65', codex: '#7DD3FC', au: ['245 185 66', '226 72 61', '125 211 252'] },
    light: { bg: '#FBF6EE', s1: '#FFFFFF', s2: '#FDFAF4', s3: '#EFE4D2', inset: '#F6EEE1', fg: '#2A1F14', strong: '#140C04', muted: '#6F5B44', primary: '#9A3412', on: '#FFFFFF', ga: '#B45309', gb: '#B91C1C', claude: '#C2410C', codex: '#0369A1', au: ['245 185 66', '239 68 68', '56 189 248'] } },
  { id: 'arc', name: 'راکتور', en: 'Arc HUD', desc: 'فیروزه‌ای نئونی، گوشه‌های تیز و شبکه؛ حس HUD', radius: 3, glass: false, bg: 'grid',
    dark: { bg: '#02060E', s1: '#050D18', s2: '#081424', s3: '#0F2238', inset: '#01040A', fg: '#D6F6FF', strong: '#F2FEFF', muted: '#7FA9BF', primary: '#00E5FF', on: '#001018', ga: '#00E5FF', gb: '#3B82F6', claude: '#FFA94D', codex: '#A78BFA' },
    light: { bg: '#EEF7FA', s1: '#FFFFFF', s2: '#F6FBFD', s3: '#DCEDF3', inset: '#E8F3F7', fg: '#0B2530', strong: '#02121A', muted: '#4A6B78', primary: '#0E7490', on: '#FFFFFF', ga: '#0E7490', gb: '#1D4ED8', claude: '#C2410C', codex: '#6D28D9' } },
  { id: 'forest', name: 'جنگل', en: 'Forest', desc: 'سبز عمیق و آرام با نور زمردی', radius: 16, glass: true, bg: 'aurora',
    dark: { bg: '#07120D', s1: '#0C1A13', s2: '#11231A', s3: '#1C3528', inset: '#050D09', fg: '#E2F1E8', strong: '#F7FFFA', muted: '#9AB7A7', primary: '#6EE7B7', on: '#032015', ga: '#6EE7B7', gb: '#A3E635', claude: '#FDBA74', codex: '#93C5FD', au: ['16 185 129', '132 204 22', '20 184 166'] },
    light: { bg: '#F1F7F2', s1: '#FFFFFF', s2: '#F7FBF8', s3: '#DCEBE0', inset: '#EAF3EC', fg: '#13281C', strong: '#06150D', muted: '#4E6B5A', primary: '#047857', on: '#FFFFFF', ga: '#047857', gb: '#4D7C0F', claude: '#C2410C', codex: '#1D4ED8', au: ['16 185 129', '132 204 22', '20 184 166'] } },
  { id: 'ocean', name: 'اقیانوس', en: 'Ocean', desc: 'آبی دریایی و فیروزه‌ای، روشن و باز', radius: 14, glass: true, bg: 'aurora',
    dark: { bg: '#04101C', s1: '#071827', s2: '#0B2235', s3: '#14324B', inset: '#020A13', fg: '#DDEEFB', strong: '#F5FBFF', muted: '#91B0C8', primary: '#38BDF8', on: '#021624', ga: '#38BDF8', gb: '#2DD4BF', claude: '#FDBA74', codex: '#C4B5FD', au: ['14 165 233', '45 212 191', '59 130 246'] },
    light: { bg: '#EEF6FB', s1: '#FFFFFF', s2: '#F6FAFD', s3: '#D9E9F4', inset: '#E8F2F9', fg: '#0C2233', strong: '#031321', muted: '#48657C', primary: '#0369A1', on: '#FFFFFF', ga: '#0369A1', gb: '#0F766E', claude: '#C2410C', codex: '#6D28D9', au: ['14 165 233', '45 212 191', '59 130 246'] } },
  { id: 'sunset', name: 'غروب', en: 'Sunset', desc: 'آلبالویی گرم با نارنجی و صورتی غروب', radius: 18, glass: true, bg: 'aurora',
    dark: { bg: '#140A12', s1: '#1E0F1B', s2: '#281423', s3: '#3B1F34', inset: '#0D060C', fg: '#F8E6EE', strong: '#FFF7FB', muted: '#C49CB0', primary: '#FB923C', on: '#2A0D00', ga: '#FB923C', gb: '#EC4899', claude: '#FCD34D', codex: '#A5B4FC', au: ['249 115 22', '236 72 153', '168 85 247'] },
    light: { bg: '#FDF3F0', s1: '#FFFFFF', s2: '#FEF8F6', s3: '#F5DFD8', inset: '#FAEDE8', fg: '#2E1420', strong: '#1A0610', muted: '#7A5162', primary: '#C2410C', on: '#FFFFFF', ga: '#C2410C', gb: '#BE185D', claude: '#A16207', codex: '#4338CA', au: ['249 115 22', '236 72 153', '168 85 247'] } },
  { id: 'rose', name: 'گل‌سرخ', en: 'Rose', desc: 'صورتی ملایم و گرد؛ نرم و صمیمی', radius: 22, glass: true, bg: 'aurora',
    dark: { bg: '#120A0E', s1: '#1B1016', s2: '#24161E', s3: '#36212C', inset: '#0C0609', fg: '#F7E4EC', strong: '#FFF5F9', muted: '#C49CAD', primary: '#F9A8D4', on: '#2A0716', ga: '#F9A8D4', gb: '#C4B5FD', claude: '#FDBA74', codex: '#5EEAD4', au: ['244 114 182', '192 132 252', '251 146 60'] },
    light: { bg: '#FDF2F6', s1: '#FFFFFF', s2: '#FEF7FA', s3: '#F5DCE6', inset: '#FBEBF1', fg: '#2D1420', strong: '#1A0711', muted: '#7A5163', primary: '#BE185D', on: '#FFFFFF', ga: '#BE185D', gb: '#7C3AED', claude: '#C2410C', codex: '#0F766E', au: ['244 114 182', '192 132 252', '251 146 60'] } },
  { id: 'paper', name: 'کاغذ', en: 'Paper', desc: 'کرم و قهوه‌ای مثل کاغذ؛ آرام برای چشم', radius: 6, glass: false, bg: 'dots',
    dark: { bg: '#1A1612', s1: '#221D18', s2: '#2A241E', s3: '#3B332A', inset: '#14110D', fg: '#EDE3D3', strong: '#FBF5EA', muted: '#B5A690', primary: '#E0B070', on: '#20160A', ga: '#E0B070', gb: '#D49A6A', claude: '#F4A261', codex: '#8ECAE6' },
    light: { bg: '#F5EFE3', s1: '#FFFCF5', s2: '#FAF5EA', s3: '#E8DEC9', inset: '#F0E8D8', fg: '#2E261B', strong: '#1A140C', muted: '#6B5D49', primary: '#8A5A24', on: '#FFFFFF', ga: '#8A5A24', gb: '#6B4E2E', claude: '#B4470F', codex: '#1D6A8A' } },
  { id: 'nord', name: 'شمال', en: 'Nord', desc: 'آبی-خاکستری قطبی، کم‌کنتراست و آرام', radius: 10, glass: false, bg: 'plain',
    dark: { bg: '#242933', s1: '#2E3440', s2: '#3B4252', s3: '#434C5E', inset: '#20242C', fg: '#ECEFF4', strong: '#FFFFFF', muted: '#B9C0CE', primary: '#88C0D0', on: '#1B2129', ga: '#88C0D0', gb: '#81A1C1', claude: '#E5A288', codex: '#A3BE8C', status: { danger: '#FF9E9E', info: '#93C5FD' } },
    light: { bg: '#ECEFF4', s1: '#FFFFFF', s2: '#F5F7FA', s3: '#D8DEE9', inset: '#E5E9F0', fg: '#2E3440', strong: '#1B1F27', muted: '#4C566A', primary: '#3B6E8F', on: '#FFFFFF', ga: '#3B6E8F', gb: '#4A6D96', claude: '#A0522D', codex: '#4F7A3A' } },
  { id: 'cyber', name: 'سایبرپانک', en: 'Cyberpunk', desc: 'بنفش تیره با زرد و صورتی نئونی', radius: 2, glass: false, bg: 'grid',
    dark: { bg: '#0B0716', s1: '#130C24', s2: '#1A1030', s3: '#281A49', inset: '#07040F', fg: '#F1E9FF', strong: '#FFFFFF', muted: '#B6A6D8', primary: '#FDE047', on: '#1A1500', ga: '#FDE047', gb: '#F472B6', claude: '#FB923C', codex: '#22D3EE' },
    light: { bg: '#F7F2FF', s1: '#FFFFFF', s2: '#FBF8FF', s3: '#E9DDFB', inset: '#F2EAFD', fg: '#1E1033', strong: '#0D0420', muted: '#5E4C7E', primary: '#A21CAF', on: '#FFFFFF', ga: '#A21CAF', gb: '#DB2777', claude: '#C2410C', codex: '#0E7490' } },
  { id: 'mono', name: 'تک‌رنگ', en: 'Mono', desc: 'سیاه و سفید، بی‌حاشیه و کاملاً مینیمال', radius: 4, glass: false, bg: 'plain',
    dark: { bg: '#0A0A0A', s1: '#141414', s2: '#1C1C1C', s3: '#2A2A2A', inset: '#050505', fg: '#EDEDED', strong: '#FFFFFF', muted: '#A3A3A3', primary: '#FFFFFF', on: '#000000', ga: '#FFFFFF', gb: '#D4D4D4', claude: '#FDBA74', codex: '#7DD3FC' },
    light: { bg: '#FAFAFA', s1: '#FFFFFF', s2: '#F5F5F5', s3: '#E5E5E5', inset: '#F0F0F0', fg: '#171717', strong: '#000000', muted: '#525252', primary: '#171717', on: '#FFFFFF', ga: '#171717', gb: '#404040', claude: '#C2410C', codex: '#0369A1' } },
];

const rgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const a = (h, al) => `rgb(${rgb(h).join(' ')} / ${al})`;

function vars(s, mode) {
  const p = s[mode], dark = mode === 'dark', st = { ...STATUS[mode], ...(p.status || {}) };
  const au = p.au || null;
  const v = {
    '--color-bg': p.bg, '--color-surface-1': p.s1, '--color-surface-2': p.s2, '--color-surface-3': p.s3, '--color-surface-inset': p.inset,
    '--color-border-subtle': a(p.fg, dark ? .08 : .09), '--color-border': a(p.fg, dark ? .15 : .16), '--color-border-strong': a(p.fg, dark ? .3 : .3),
    '--color-fg': p.fg, '--color-fg-strong': p.strong, '--color-fg-muted': p.muted,
    '--color-primary': p.primary, '--color-primary-hover': p.primary, '--color-on-primary': p.on,
    '--color-primary-soft': a(p.primary, dark ? .13 : .09), '--color-primary-line': a(p.primary, dark ? .4 : .32),
    '--color-claude': p.claude, '--color-claude-soft': a(p.claude, .12), '--color-codex': p.codex, '--color-codex-soft': a(p.codex, .12),
    '--color-focus': p.primary, '--color-glow': a(p.primary, dark ? .5 : .22),
    '--color-hover': a(p.fg, dark ? .06 : .05), '--color-selected': a(p.primary, dark ? .14 : .09), '--color-backdrop': dark ? 'rgb(0 0 0 / .6)' : a(p.fg, .3),
    '--color-grid': a(p.primary, dark ? .05 : .06),
    '--color-grad-a': p.ga, '--color-grad-b': p.gb,
    '--color-glass': s.glass ? a(p.s1, dark ? .55 : .66) : p.s1,
    '--color-glass-strong': s.glass ? a(p.s1, dark ? .82 : .88) : p.s1,
    '--color-glass-edge': s.glass ? (dark ? 'rgb(255 255 255 / .09)' : 'rgb(255 255 255 / .9)') : a(p.fg, dark ? .1 : .12),
    '--color-glass-hi': s.glass ? (dark ? 'rgb(255 255 255 / .06)' : 'rgb(255 255 255 / .7)') : 'transparent',
    '--color-aurora-1': au ? `rgb(${au[0]} / ${dark ? .45 : .25})` : 'transparent',
    '--color-aurora-2': au ? `rgb(${au[1]} / ${dark ? .38 : .2})` : 'transparent',
    '--color-aurora-3': au ? `rgb(${au[2]} / ${dark ? .25 : .18})` : 'transparent',
    '--shadow-glow': s.glass || s.bg === 'grid' ? `0 0 24px ${a(p.primary, dark ? .35 : .2)}` : 'none',
    '--color-success': st.success, '--color-warning': st.warning, '--color-danger': st.danger, '--color-info': st.info,
  };
  return v;
}
function structure(s) {
  const r = s.radius;
  return {
    '--holo-radius': `${r}px`, '--holo-radius-sm': `${Math.round(r * 0.66)}px`, '--card-radius': `${Math.round(r * 0.66)}px`,
    '--control-radius': `${Math.min(10, Math.round(r * 0.5))}px`, '--dialog-radius': `${r}px`, '--holo-blur': s.glass ? '22px' : '0px',
  };
}
const block = o => Object.entries(o).map(([k, v]) => `  ${k}: ${v};`).join('\n');

let css = `/* GENERATED by design/skins.cjs — do not edit. 12 skins x (dark + light). */\n`;
for (const s of SKINS) {
  if (s.base) continue; // "holo" is the default look in tokens.css
  const sel = `html[data-skin="${s.id}"]`;
  css += `\n/* ${s.en} — ${s.desc} */\n${sel} {\n${block(structure(s))}\n}\n`;
  css += `${sel}:not([data-theme="light"]) {\n${block(vars(s, 'dark'))}\n}\n`;
  css += `${sel}[data-theme="light"] {\n${block(vars(s, 'light'))}\n}\n`;
  if (s.bg === 'grid') css += `${sel} body { background-image: linear-gradient(var(--color-grid) 1px, transparent 1px), linear-gradient(90deg, var(--color-grid) 1px, transparent 1px); background-size: 36px 36px; }\n`;
  if (s.bg === 'dots') css += `${sel} body { background-image: radial-gradient(var(--color-border) 1px, transparent 1.2px); background-size: 22px 22px; }\n`;
  if (s.bg !== 'aurora') css += `${sel} body::before { display: none; }\n`;
  if (!s.glass) css += `${sel} :is(.sidebar, .main, .composer-card, .tile, .chart, .agent-orb, .command, .review, .report, .wz-item, .agent-card, dialog, .toast) { backdrop-filter: none; -webkit-backdrop-filter: none; }\n`;
}
fs.writeFileSync(path.join(__dirname, '..', 'public', 'skins.css'), css);

// gallery data for the panel
const gallery = SKINS.map(s => ({ id: s.id, name: s.name, en: s.en, desc: s.desc, radius: s.radius, glass: s.glass, bg: s.bg,
  dark: { bg: s.dark.bg, s1: s.dark.s1, s3: s.dark.s3, fg: s.dark.fg, muted: s.dark.muted, ga: s.dark.ga, gb: s.dark.gb, on: s.dark.on, claude: s.dark.claude, codex: s.dark.codex },
  light: { bg: s.light.bg, s1: s.light.s1, s3: s.light.s3, fg: s.light.fg, muted: s.light.muted, ga: s.light.ga, gb: s.light.gb, on: s.light.on, claude: s.light.claude, codex: s.light.codex } }));
fs.writeFileSync(path.join(__dirname, '..', 'public', 'skins.js'), `// GENERATED by design/skins.cjs\nwindow.JARVIS_SKINS = ${JSON.stringify(gallery)};\n`);

// contrast check (WCAG AA 4.5:1)
const lum = h => { const [r, g, b] = rgb(h).map(c => c / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (x, y) => { const [m, n] = [lum(x), lum(y)].sort((p, q) => q - p); return (m + 0.05) / (n + 0.05); };
const PAIRS = [['fg', 'bg'], ['fg', 's1'], ['fg', 's2'], ['fg', 's3'], ['muted', 'bg'], ['muted', 's1'], ['muted', 's2'], ['primary', 's1'], ['primary', 's2'],
  ['on', 'primary'], ['on', 'ga'], ['on', 'gb'], ['claude', 's2'], ['codex', 's2']];
let fails = 0, checked = 0;
for (const s of SKINS) for (const mode of ['dark', 'light']) {
  const p = s[mode];
  for (const [f, b] of PAIRS) {
    checked++;
    const r = ratio(p[f], p[b]);
    if (r < 4.5) { fails++; console.log(`  FAIL ${s.id}/${mode}: ${f} on ${b} = ${r.toFixed(2)}:1`); }
  }
  for (const k of ['success', 'warning', 'danger', 'info']) { checked++; const r = ratio({ ...STATUS[mode], ...(p.status || {}) }[k], p.s2); if (r < 4.5) { fails++; console.log(`  FAIL ${s.id}/${mode}: ${k} on s2 = ${r.toFixed(2)}:1`); } }
}
console.log(`skins: ${SKINS.length} -> public/skins.css, public/skins.js`);
console.log(fails ? `skins contrast: ${fails} of ${checked} pairs below 4.5:1` : `skins contrast: all ${checked} pairs >= 4.5:1`);
process.exitCode = fails ? 1 : 0;
