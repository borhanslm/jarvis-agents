// Start-up sequence: rings draw in, the core lights up and short status lines appear, then the
// app shows. Once per app start (not on every reload), ~2 s, click or any key skips it, and it is
// skipped entirely with "reduce motion". Purely visual: the app loads underneath meanwhile.
(function () {
  'use strict';
  let seen = false;
  try { seen = sessionStorage.getItem('jarvis.booted') === '1'; sessionStorage.setItem('jarvis.booted', '1'); } catch {}
  if (seen || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rings = [[190, 1.5, ''], [168, 1, '6 10'], [146, 3, ''], [120, 1, '2 6'], [96, 6, '']];
  const el = document.createElement('div');
  el.className = 'boot'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="boot-core"><svg viewBox="0 0 400 400">
      ${rings.map(([r, w, dash], i) => `<circle class="${dash ? 'boot-fade' : 'boot-ring'} ${i === 2 ? 'boot-amber' : ''}" cx="200" cy="200" r="${r}" stroke-width="${w}" style="--len:${Math.ceil(2 * Math.PI * r)};animation-delay:${i * 0.12}s"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`).join('')}
      <g class="boot-spin"><path d="M200 22 A178 178 0 0 1 378 200" stroke-width="3"/><path d="M200 378 A178 178 0 0 1 22 200" stroke-width="3"/></g>
      <circle class="boot-dot" cx="200" cy="200" r="34"/></svg>
    <div class="boot-text"><div class="boot-title">JARVIS</div><div class="boot-log" id="bootLog"></div><div class="boot-hi">سلام، جارویس آماده است.</div></div></div>
    <div class="boot-skip">برای رد شدن کلیک کنید</div>`;
  const lines = ['INITIALIZING CORE', 'VOICE SYSTEMS ONLINE', 'AGENT NETWORK READY', 'ALL SYSTEMS NOMINAL'];
  let i = 0, done = false;
  const log = () => { const l = el.querySelector('#bootLog'); if (l && i < lines.length) { l.textContent = '> ' + lines[i++]; setTimeout(log, 380); } };
  const finish = () => { if (done) return; done = true; el.classList.add('out'); setTimeout(() => el.remove(), 600); document.removeEventListener('keydown', finish, true); };
  const mount = () => { document.body.appendChild(el); setTimeout(log, 250); setTimeout(finish, 2100); el.addEventListener('click', finish); document.addEventListener('keydown', finish, true); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
