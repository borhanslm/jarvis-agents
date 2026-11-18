// The living JARVIS orb, shared by the JARVIS page and the TV / second-monitor stage.
// Its colours come from the current skin: waiting = the skin's main colour, listening = its
// "success" colour, speaking = its accent, thinking = the main colour turned 60° on the wheel.
(function () {
  const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let probe = null;
  // any CSS colour → [r, g, b] (the canvas normalises it for us)
  function rgbOf(css, fallback) {
    if (!css) return fallback;
    probe = probe || document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000'; probe.fillStyle = css.trim();
    const v = probe.fillStyle;
    if (/^#[0-9a-f]{6}$/i.test(v)) return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16));
    const m = v.match(/rgba?\(([^)]+)\)/); return m ? m[1].split(',').slice(0, 3).map(Number) : fallback;
  }
  function turn([r, g, b], deg) { // hue rotate in HSL
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) { s = d / (1 - Math.abs(2 * l - 1)); h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    h = (h + deg + 360) % 360; s = Math.max(s, 0.55);
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const [a, bb, cc] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [a, bb, cc].map(v => Math.round((v + m) * 255));
  }
  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 90;
  // the skin's colours for each state
  function palette() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n);
    const idle = rgbOf(v('--color-primary'), [79, 216, 255]);
    let speak = rgbOf(v('--color-claude'), [255, 183, 71]);
    if (near(speak, idle)) speak = rgbOf(v('--color-grad-b'), [255, 183, 71]);
    if (near(speak, idle)) speak = turn(idle, 150);
    let rec = rgbOf(v('--color-success'), [62, 255, 168]);
    if (near(rec, idle)) rec = turn(idle, -90);
    return { idle, recording: rec, thinking: turn(idle, 60), speaking: speak, off: [110, 130, 150], light: document.documentElement.dataset.theme === 'light' };
  }

  // one orb on one canvas; call draw(now, {state, level}) every frame
  function create(canvas, opts = {}) {
    const o = { canvas, rgb: null, lvl: 0, t0: performance.now(), parts: [], pal: opts.palette || palette(), scale: opts.scale || 0.17, cy: opts.cy || 0.45 };
    o.setPalette = p => { o.pal = p || palette(); };
    o.draw = (now, { state = 'idle', level = 0 } = {}) => {
      const c = canvas; if (!c.width) return;
      const g = c.getContext('2d'), w = c.width, h = c.height, cx = w / 2, cy = h * o.cy, R = Math.min(w, h) * o.scale;
      const t = (now - o.t0) / 1000, slow = reduce(), want = o.pal[state] || o.pal.idle;
      if (!o.rgb) o.rgb = want.slice();
      for (let i = 0; i < 3; i++) o.rgb[i] += (want[i] - o.rgb[i]) * 0.06;
      // while waiting it still breathes with the room sound, so you can see the microphone is alive
      const mic = Math.min(1, level || 0);
      const target = state === 'recording' || state === 'speaking' ? Math.min(1, mic * 1.6) : state === 'thinking' ? 0.35 + 0.25 * Math.sin(t * 5) : state === 'idle' ? 0.1 + 0.05 * Math.sin(t * 1.6) + mic * 0.5 : 0.06;
      o.lvl += (target - o.lvl) * (target > o.lvl ? 0.35 : 0.08);
      const L = slow ? 0.15 : o.lvl, col = a => `rgba(${o.rgb.map(Math.round).join(',')},${a})`;
      g.clearRect(0, 0, w, h);
      const glow = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * (3 + L * 1.5));
      glow.addColorStop(0, col(o.pal.light ? 0.35 : 0.5)); glow.addColorStop(0.3, col(0.16)); glow.addColorStop(1, col(0));
      g.fillStyle = glow; g.fillRect(0, 0, w, h);
      const core = g.createRadialGradient(cx - R * 0.25, cy - R * 0.25, R * 0.05, cx, cy, R * (0.95 + L * 0.25));
      core.addColorStop(0, 'rgba(255,255,255,0.95)'); core.addColorStop(0.25, col(0.9)); core.addColorStop(1, col(0.08));
      g.beginPath(); g.arc(cx, cy, R * (0.92 + L * 0.22), 0, Math.PI * 2); g.fillStyle = core; g.fill();
      g.lineWidth = Math.max(1, w / 700);
      for (let k = 0; k < 5; k++) {
        g.beginPath();
        for (let i = 0; i <= 140; i++) {
          const a = (i / 140) * Math.PI * 2;
          const wob = (slow ? 0 : 1) * (Math.sin(a * (3 + k) + t * (1.2 + k * 0.7)) * 0.5 + Math.sin(a * (5 + k * 2) - t * (2 + k)) * 0.5);
          const r = R * (1.15 + k * 0.17) + wob * R * (0.03 + L * 0.24);
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.closePath(); g.strokeStyle = col(0.55 - k * 0.09); g.stroke();
      }
      g.save(); g.translate(cx, cy);
      for (const [rr, n, sp] of [[2.2, 90, 0.15], [2.6, 36, -0.08]]) {
        g.save(); g.rotate(slow ? 0 : t * (state === 'thinking' ? sp * 6 : sp));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2, r1 = R * rr, r2 = r1 + (i % 6 === 0 ? R * 0.14 : R * 0.05);
          g.beginPath(); g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
          g.strokeStyle = col(i % 6 === 0 ? 0.45 : 0.18); g.stroke();
        }
        g.restore();
      }
      g.restore();
      if (!slow && (state === 'speaking' || state === 'recording') && o.parts.length < 160 && Math.random() < 0.3 + L) {
        o.parts.push({ a: Math.random() * Math.PI * 2, r: R * 1.1, v: R * (0.008 + Math.random() * 0.02) * (1 + L * 3), life: 1 });
      }
      for (const p of o.parts) { p.r += p.v; p.life -= 0.011; g.beginPath(); g.arc(cx + Math.cos(p.a) * p.r, cy + Math.sin(p.a) * p.r, Math.max(1, w / 900) * (1 + p.life), 0, Math.PI * 2); g.fillStyle = col(p.life * 0.8); g.fill(); }
      o.parts = o.parts.filter(p => p.life > 0);
    };
    return o;
  }
  // a canvas sized to its box (sharp on high-DPI screens)
  function fit(canvas) { const r = canvas.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, r.width * r.height > 600000 ? 1 : 1.5); canvas.width = Math.round(r.width * d); canvas.height = Math.round(r.height * d); }
  window.JarvisOrb = { create, palette, fit, rgbOf, turn };
})();
