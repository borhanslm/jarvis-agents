// The JARVIS core: a holographic HUD drawn on a 2D canvas — concentric rings with degree ticks,
// segmented arcs turning at different speeds and directions, a scanning sweep, orbiting markers
// and a glowing core that reacts to activity (agents working) and to the voice (listening/speaking).
// Colours come from the active look (--color-primary, accent --color-grad-b).

export function makeHud(host, { label = 'JARVIS' } = {}) {
  const cv = document.createElement('canvas');
  host.appendChild(cv);
  const ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, raf = 0, running = true, busy = false, online = true, level = 0, mode = 'idle', t0 = performance.now();
  let C = {};
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function colors() {
    C = { p: css('--color-primary') || '#4fd8ff', a: css('--color-grad-b') || '#ffb347', fg: css('--color-fg-strong') || '#fff', bg: css('--color-bg') || '#020a12' };
  }
  const rgba = (hex, al) => {
    let h = String(hex).trim();
    if (h.startsWith('rgb')) return h.replace(/rgba?\(([^)]+)\)/, (_, v) => `rgba(${v.split(',').slice(0, 3).join(',')},${al})`);
    h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(x => x + x).join('');
    const n = parseInt(h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${al})`;
  };
  function size() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = host.clientWidth || 360; H = host.clientHeight || 360;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  colors(); size();
  new ResizeObserver(size).observe(host);
  new MutationObserver(colors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin'] });

  const arc = (r, a0, a1, w, col, glow) => {
    ctx.beginPath(); ctx.arc(0, 0, r, a0, a1); ctx.lineWidth = w; ctx.strokeStyle = col;
    if (glow) { ctx.shadowColor = col; ctx.shadowBlur = glow; } ctx.stroke(); ctx.shadowBlur = 0;
  };
  const ticks = (r, n, len, w, col, every = 0, bigLen = 0) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, L = every && i % every === 0 ? bigLen : len;
      ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); ctx.lineTo(Math.cos(a) * (r - L), Math.sin(a) * (r - L));
    }
    ctx.stroke();
  };
  const segments = (r, n, gapFrac, w, col, rot, skip = []) => {
    const step = Math.PI * 2 / n;
    for (let i = 0; i < n; i++) { if (skip.includes(i)) continue; arc(r, rot + i * step, rot + (i + 1 - gapFrac) * step, w, col); }
  };

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !W) return;
    const t = reduce ? 0 : (now - t0) / 1000;
    const sp = busy ? 2.2 : mode === 'speaking' || mode === 'recording' ? 1.6 : 1;
    level += ((mode === 'speaking' || mode === 'recording' ? 0.6 + 0.4 * Math.abs(Math.sin(t * 7)) : busy ? 0.45 : 0.15) - level) * 0.08;
    ctx.clearRect(0, 0, W, H);
    const R = Math.min(W, H) / 2 - 6;
    ctx.save(); ctx.translate(W / 2, H / 2);

    // soft glow behind everything
    const g = ctx.createRadialGradient(0, 0, R * 0.05, 0, 0, R * 0.75);
    g.addColorStop(0, rgba(C.p, 0.28 + level * 0.25)); g.addColorStop(0.45, rgba(C.p, 0.07)); g.addColorStop(1, rgba(C.p, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();

    // 1) outer degree scale (slow)
    ctx.save(); ctx.rotate(t * 0.03 * sp);
    arc(R, 0, Math.PI * 2, 1, rgba(C.p, 0.35));
    ticks(R - 2, 180, 4, 1, rgba(C.p, 0.45), 15, 11);
    ctx.restore();

    // 2) segmented ring (counter-rotating), with an amber marker block
    ctx.save(); ctx.rotate(-t * 0.12 * sp);
    segments(R * 0.88, 24, 0.22, 3, rgba(C.p, 0.55), 0, [3, 4, 15]);
    arc(R * 0.88, (3 / 24) * Math.PI * 2, (5 / 24) * Math.PI * 2 - 0.04, 5, rgba(C.a, 0.85), 8);
    ctx.restore();

    // 3) thin full ring + long arcs (fast)
    ctx.save(); ctx.rotate(t * 0.35 * sp);
    arc(R * 0.78, 0, Math.PI * 2, 0.8, rgba(C.p, 0.3));
    arc(R * 0.78, 0.2, 1.6, 2.5, rgba(C.p, 0.9), 10);
    arc(R * 0.78, Math.PI + 0.2, Math.PI + 0.9, 2.5, rgba(C.p, 0.9), 10);
    ctx.restore();

    // 4) dashed inner scale
    ctx.save(); ctx.rotate(-t * 0.06 * sp);
    ticks(R * 0.68, 72, 6, 1.2, rgba(C.p, 0.5), 6, 10);
    ctx.restore();

    // 5) scanning sweep
    if (!reduce) {
      ctx.save(); ctx.rotate(t * 1.1 * sp);
      const sw = ctx.createLinearGradient(0, 0, R * 0.66, 0);
      sw.addColorStop(0, rgba(C.p, 0)); sw.addColorStop(1, rgba(C.p, 0.22));
      ctx.fillStyle = sw; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R * 0.66, -0.35, 0); ctx.closePath(); ctx.fill();
      arc(R * 0.66, -0.02, 0, 2, rgba(C.p, 0.9));
      ctx.restore();
    }

    // 6) chunky inner segments (reacts to level)
    ctx.save(); ctx.rotate(t * 0.22 * sp);
    const r6 = R * (0.52 + level * 0.04);
    segments(r6, 6, 0.32, 7, rgba(C.p, 0.35 + level * 0.5), 0);
    ctx.restore();

    // 7) hexagon frame
    ctx.save(); ctx.rotate(-t * 0.08);
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) { const a = i / 6 * Math.PI * 2 + Math.PI / 6, rr = R * 0.42; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr); }
    ctx.lineWidth = 1.2; ctx.strokeStyle = rgba(C.p, 0.55); ctx.stroke();
    ctx.restore();

    // 8) orbiting markers
    for (let k = 0; k < 3; k++) {
      const a = t * (0.5 + k * 0.23) * sp + k * 2.1, rr = R * (0.6 + k * 0.1);
      ctx.beginPath(); ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, k === 1 ? 3.2 : 2.2, 0, Math.PI * 2);
      ctx.fillStyle = k === 1 ? rgba(C.a, 0.95) : rgba(C.p, 0.95); ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;
    }

    // 9) the core
    const cr = R * (0.2 + level * 0.035);
    const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, cr * 1.6);
    cg.addColorStop(0, rgba(C.fg, 0.95)); cg.addColorStop(0.25, rgba(C.p, 0.85)); cg.addColorStop(0.7, rgba(C.p, 0.18)); cg.addColorStop(1, rgba(C.p, 0));
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, 0, cr * 1.6, 0, Math.PI * 2); ctx.fill();
    arc(cr * 1.05, 0, Math.PI * 2, 1.5, rgba(C.p, 0.9), 12);
    // core spokes
    ctx.save(); ctx.rotate(t * 0.6 * sp);
    ctx.strokeStyle = rgba(C.p, 0.6); ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; ctx.moveTo(Math.cos(a) * cr * 1.15, Math.sin(a) * cr * 1.15); ctx.lineTo(Math.cos(a) * cr * 1.4, Math.sin(a) * cr * 1.4); }
    ctx.stroke(); ctx.restore();

    // 10) small readouts around the ring (real time, not decoration numbers)
    ctx.font = `600 ${Math.max(9, R * 0.045)}px "JetBrains Mono", monospace`;
    ctx.fillStyle = rgba(C.p, 0.75); ctx.textAlign = 'center';
    const d = new Date();
    ctx.fillText(d.toLocaleTimeString('en-GB'), 0, -R * 0.94 + 2);
    ctx.fillStyle = rgba(C.a, 0.85);
    ctx.fillText(mode === 'recording' ? 'LISTENING' : mode === 'speaking' ? 'SPEAKING' : mode === 'thinking' ? 'PROCESSING' : busy ? 'AGENTS ACTIVE' : online ? 'ONLINE' : 'OFFLINE MODE', 0, R * 0.94);
    ctx.restore();
  }
  raf = requestAnimationFrame(frame);
  return {
    setBusy(b) { busy = !!b; },
    setMode(m) { mode = m || 'idle'; },
    setNet(on) { online = on; },
    pause() { if (running) { cancelAnimationFrame(raf); running = false; } },
    resume() { if (!running) { running = true; t0 = performance.now() - 0; raf = requestAnimationFrame(frame); } },
  };
}
