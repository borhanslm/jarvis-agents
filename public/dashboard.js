// Home dashboard: real 3D charts (three.js, bundled locally — no network).
//  1) daily usage per model  — 3D bars (day × model)
//  2) share per model        — extruded 3D donut
//  3) project code graph     — 3D force graph of the graphify knowledge graph
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from './vendor/CSS2DRenderer.js';

// Categorical slots (dark steps, validated on the panel surface #0e1c30).
// Colour follows the model family, never its rank, so filters never repaint a model.
// Chart colours come from the design tokens (--chart-1..8, validated per theme), so the
// charts follow the dark/light theme. Re-read whenever the theme changes.
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let SLOTS = [], OTHER = '', INK = {};
function readPalette() {
  SLOTS = [1, 2, 3, 4, 5, 6, 7, 8].map(i => css(`--chart-${i}`));
  OTHER = css('--chart-other');
  INK = { grid: css('--chart-grid'), floor: css('--chart-floor'), link: css('--chart-link'), hover: css('--color-fg-strong') };
  for (const k of Object.keys(colorCache)) delete colorCache[k];
}
const FAMILY = [[/sonnet/i, 0], [/haiku/i, 1], [/opus/i, 2], [/fable|mythos/i, 3], [/gpt|codex|^o\d/i, 4]];
const colorCache = {};
function modelColor(model, allModels) {
  if (colorCache[model]) return colorCache[model];
  const f = FAMILY.find(([re]) => re.test(model));
  if (f) return (colorCache[model] = SLOTS[f[1]]);
  // unknown family: next free slot by stable (sorted) order
  const unknown = allModels.filter(m => !FAMILY.some(([re]) => re.test(m))).sort();
  const i = unknown.indexOf(model);
  return (colorCache[model] = SLOTS[5 + i] || OTHER);
}

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fa = n => Number(n || 0).toLocaleString('fa-IR');
const fmtTok = n => n >= 1e6 ? (n / 1e6).toLocaleString('fa-IR', { maximumFractionDigits: 1 }) + 'M' : n >= 1e3 ? (n / 1e3).toLocaleString('fa-IR', { maximumFractionDigits: 1 }) + 'K' : fa(n);
const fmtUsd = n => '$' + (n || 0).toFixed(n >= 1 ? 2 : 3);
const fmtDay = d => new Date(d + 'T12:00:00').toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' });
const shortModel = m => (globalThis.prettyModel ? globalThis.prettyModel(m) : m);


// ---------- shared scene helper ----------
class Stage {
  constructor(host, { camPos = [9, 8, 12], target = [0, 1.5, 0], autoRotate = true } = {}) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.camera.position.set(...camPos);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels3d';
    host.appendChild(this.labels.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(...target);
    this.controls.enableDamping = true;
    this.controls.enableZoom = false; // the wheel scrolls the page; drag rotates, right-drag pans
    this.controls.enablePan = true;
    this.controls.autoRotate = autoRotate;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const d = new THREE.DirectionalLight(0xffffff, 1.1); d.position.set(6, 12, 8); this.scene.add(d);
    const d2 = new THREE.DirectionalLight(0x88bbff, 0.35); d2.position.set(-8, 4, -6); this.scene.add(d2);
    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-9, -9);
    this.hoverables = [];
    this.tip = document.createElement('div');
    this.tip.className = 'tip3d';
    this.tip.hidden = true;
    host.appendChild(this.tip);
    this.renderer.domElement.addEventListener('pointermove', e => {
      const r = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    this.renderer.domElement.addEventListener('pointerleave', () => { this.pointer.set(-9, -9); });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.alive = true;
    const loop = () => {
      if (!this.alive) return;
      this.raf = requestAnimationFrame(loop);
      if (document.hidden || !this.host.isConnected || this.host.offsetParent === null) return;
      this.onFrame && this.onFrame();
      this.controls.update();
      this.hover();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    };
    loop();
  }
  resize() {
    const w = this.host.clientWidth || 300, h = this.host.clientHeight || 300;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h); this.labels.setSize(w, h);
  }
  label(text, pos, cls = 'lbl3d') {
    const el = document.createElement('div'); el.className = cls; el.textContent = text;
    const o = new CSS2DObject(el); o.position.set(...pos); this.scene.add(o); return o;
  }
  hover() {
    if (!this.hoverables.length || this.pointer.x < -2) { this.setHover(null); return; }
    this.ray.setFromCamera(this.pointer, this.camera);
    const hit = this.ray.intersectObjects(this.hoverables, false)[0];
    this.setHover(hit || null);
  }
  setHover(hit) {
    const key = hit ? (hit.object.uuid + ':' + (hit.instanceId ?? '')) : null;
    if (key !== this.hoverKey) {
      if (this.onHover) this.onHover(this.hoverKey && this.lastHit, false);
      this.hoverKey = key; this.lastHit = hit;
      if (this.onHover && hit) this.onHover(hit, true);
    }
    if (hit && this.tipFor) {
      this.tip.innerHTML = this.tipFor(hit);
      this.tip.hidden = false;
      const w = this.host.clientWidth;
      const x = Math.min(w - 230, this.mouse.x + 14);
      this.tip.style.left = Math.max(4, x) + 'px';
      this.tip.style.top = Math.max(4, this.mouse.y - 10) + 'px';
    } else this.tip.hidden = true;
  }
  dispose() {
    this.alive = false; cancelAnimationFrame(this.raf); this.ro.disconnect();
    this.controls.dispose();
    this.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); });
    this.renderer.dispose();
    this.host.innerHTML = '';
  }
}

// ---------- 1) 3D bars: day × model ----------
function barsChart(host, data, metric) {
  const models = data.models.map(m => m.model);
  const days = data.days;
  const val = (m, d) => { const x = m.days[d]; return x ? (metric === 'cost' ? x.costUsd : x.tokens) : 0; };
  let max = 0;
  for (const m of data.models) for (const d of days) max = Math.max(max, val(m, d));
  const H = 5, sx = 1, sz = 1.35;
  const W = days.length * sx, D = models.length * sz;
  const st = new Stage(host, { camPos: [W * 0.55, H * 1.5, D + 9], target: [0, H * 0.3, 0] });
  const ox = -W / 2 + sx / 2, oz = -D / 2 + sz / 2;

  // floor + recessive grid
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W + 1, D + 1), new THREE.MeshStandardMaterial({ color: INK.floor, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01; st.scene.add(floor);
  const gl = [];
  for (let i = 0; i <= days.length; i++) { const x = -W / 2 + i * sx; gl.push(x, 0, -D / 2, x, 0, D / 2); }
  for (let j = 0; j <= models.length; j++) { const z = -D / 2 + j * sz; gl.push(-W / 2, 0, z, W / 2, 0, z); }
  // y ticks on the back wall
  const ticks = [0.5, 1];
  for (const t of ticks) gl.push(-W / 2, t * H, -D / 2, W / 2, t * H, -D / 2);
  const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(gl, 3));
  st.scene.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: INK.grid })));
  for (const t of ticks) st.label(metric === 'cost' ? fmtUsd(max * t) : fmtTok(max * t), [-W / 2 - 0.6, t * H, -D / 2], 'lbl3d tick');

  const geo = new THREE.BoxGeometry(sx * 0.62, 1, sz * 0.62);
  geo.translate(0, 0.5, 0); // anchored to the baseline
  data.models.forEach((m, j) => {
    const color = modelColor(m.model, models);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1, emissive: color, emissiveIntensity: 0.08 });
    days.forEach((d, i) => {
      const v = val(m, d);
      if (!v) return;
      const bar = new THREE.Mesh(geo, mat.clone());
      bar.scale.y = Math.max(0.04, (v / max) * H);
      bar.position.set(ox + i * sx, 0, oz + j * sz);
      bar.userData = { model: m.model, day: d, tokens: m.days[d].tokens, cost: m.days[d].costUsd };
      st.scene.add(bar); st.hoverables.push(bar);
    });
    // direct label at the row end (identity is never colour-alone)
    st.label(shortModel(m.model), [W / 2 + 0.4, 0.2, oz + j * sz], 'lbl3d row');
  });
  const step = Math.ceil(days.length / 7);
  days.forEach((d, i) => { if (i % step === 0 || i === days.length - 1) st.label(fmtDay(d), [ox + i * sx, 0, D / 2 + 0.6], 'lbl3d tick'); });

  st.onHover = (hit, on) => { if (hit) hit.object.material.emissiveIntensity = on ? 0.55 : 0.08; };
  st.tipFor = hit => {
    const u = hit.object.userData;
    return `<b dir="ltr">${esc(shortModel(u.model))}</b><div>${fmtDay(u.day)}</div><div>توکن: <b>${fa(u.tokens)}</b></div><div>هزینه: <b dir="ltr">${fmtUsd(u.cost)}</b></div>`;
  };
  return st;
}

// ---------- 2) extruded 3D donut: share per model ----------
function donutChart(host, data, metric, colorOf) {
  const models = data.models.map(m => m.model);
  const v = m => metric === 'cost' ? m.costUsd : m.tokens;
  const total = data.models.reduce((s, m) => s + v(m), 0) || 1;
  const st = new Stage(host, { camPos: [0, 6.5, 7.5], target: [0, 0, 0] });
  const R = 3, r = 1.75, gap = 0.035;
  let a0 = Math.PI / 2;
  for (const m of data.models) {
    const share = v(m) / total;
    if (share <= 0) continue;
    const a1 = a0 - share * Math.PI * 2;
    const s = new THREE.Shape();
    const from = a0 - gap / 2, to = Math.min(from - 0.005, a1 + gap / 2);
    s.absarc(0, 0, R, from, to, true);
    s.absarc(0, 0, r, to, from, false);
    s.closePath();
    const depth = 0.5 + share * 0.9; // taller = bigger share (redundant with angle)
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 2, curveSegments: 48 });
    const color = colorOf ? colorOf(m.model) : modelColor(m.model, models);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1, emissive: color, emissiveIntensity: 0.08 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData = { model: m.model, label: m.label, share, tokens: m.tokens, cost: m.costUsd, mid: (a0 + a1) / 2 };
    st.scene.add(mesh); st.hoverables.push(mesh);
    a0 = a1;
  }
  st.label(metric === 'cost' ? fmtUsd(total === 1 && !data.models.length ? 0 : total) : fmtTok(total), [0, 0.6, 0], 'lbl3d center');
  st.onHover = (hit, on) => {
    if (!hit) return;
    const o = hit.object; o.material.emissiveIntensity = on ? 0.5 : 0.08;
    const lift = on ? 0.25 : 0;
    o.position.set(Math.cos(o.userData.mid) * lift, 0, -Math.sin(o.userData.mid) * lift);
  };
  st.tipFor = hit => {
    const u = hit.object.userData;
    return `<b dir="ltr">${esc(u.label || u.model)}</b><div>سهم: <b>${(u.share * 100).toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪</b></div><div>توکن: <b>${fa(u.tokens)}</b></div><div>هزینه: <b dir="ltr">${fmtUsd(u.cost)}</b></div>`;
  };
  return st;
}

// ---------- 3) 3D force graph of the graphify code graph ----------
// Claude vs ChatGPT (Codex). Codex reports tokens only; its cost is an estimate from the
// prices entered in the settings (0 = unknown, then the chart falls back to tokens).
function providerData(data, S) {
  const st = (S && S.settings) || {};
  const pIn = +st.codexPriceIn || 0, pC = +st.codexPriceCached || 0, pOut = +st.codexPriceOut || 0;
  const priced = pIn > 0 || pOut > 0;
  const sum = agent => data.models.filter(m => (m.agent || (/gpt|codex|^o\d/i.test(m.model) ? 'codex' : 'claude')) === agent);
  const cl = sum('claude'), cx = sum('codex');
  const claude = { model: 'claude', label: 'Claude', tokens: cl.reduce((t, m) => t + m.tokens, 0), costUsd: cl.reduce((t, m) => t + m.costUsd, 0), steps: cl.reduce((t, m) => t + m.steps, 0) };
  const codex = { model: 'codex', label: 'ChatGPT · Codex', tokens: cx.reduce((t, m) => t + m.tokens, 0),
    costUsd: cx.reduce((t, m) => t + (m.input * pIn + m.cacheRead * pC + m.output * pOut) / 1e6, 0), steps: cx.reduce((t, m) => t + m.steps, 0) };
  const metric = D.metric === 'cost' && priced ? 'cost' : 'tokens';
  return { rows: [claude, codex], metric, priced, total: { tokens: claude.tokens + codex.tokens, cost: claude.costUsd + codex.costUsd } };
}
function vsSection(data, S) {
  const vs = providerData(data, S);
  if (!vs.total.tokens) return '';
  const pro = S && S.claudeAuth === 'claude.ai';
  const val = r => vs.metric === 'cost' ? r.costUsd : r.tokens;
  const tot = val(vs.rows[0]) + val(vs.rows[1]) || 1;
  const note = D.metric === 'cost' && !vs.priced
    ? 'قیمت Codex در تنظیمات وارد نشده، پس این نمودار بر اساس توکن است. برای هزینه‌ی تخمینی ChatGPT، در «تنظیمات ← سرعت و هزینه» قیمت هر ۱ میلیون توکن را وارد کنید.'
    : vs.metric === 'cost' ? `هزینه‌ی ChatGPT از روی قیمت‌هایی که وارد کرده‌اید تخمین زده شده${pro ? '؛ هزینه‌ی Claude هم معادل API است (روی Pro پرداخت نمی‌شود)' : ''}.` : 'مقایسه بر اساس تعداد توکن.';
  return `<div class="charts vs">
    <section class="chart"><header><h3>Claude در برابر ChatGPT (Codex)</h3><small>${vs.metric === 'cost' ? 'هزینه' : 'توکن'}</small></header><div class="stage3d" id="cVs"></div></section>
    <section class="chart"><header><h3>خلاصه</h3></header>
      <ul class="legend vs-legend">${vs.rows.map(r => `<li><i style="background:${r.model === 'claude' ? css('--color-claude') : css('--color-codex')}"></i><span>${r.label}</span>
        <b dir="ltr">${vs.metric === 'cost' ? (r.model === 'codex' || pro ? '≈' : '') + fmtUsd(r.costUsd) : fmtTok(r.tokens)}</b><em>${(val(r) / tot * 100).toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪</em></li>
        <li class="muted sub"><span>${fmtTok(r.tokens)} توکن · ${fa(r.steps)} مرحله${vs.metric !== 'cost' && r.costUsd ? ` · ≈${fmtUsd(r.costUsd)}` : ''}</span></li>`).join('')}</ul>
      <p class="help">${note}</p></section>
  </div>`;
}

function graphChart(host, g) {
  const st = new Stage(host, { camPos: [0, 0, 70], target: [0, 0, 0] });
  st.controls.autoRotateSpeed = 0.35;
  const n = g.nodes.length;
  const idx = new Map(g.nodes.map((x, i) => [x.id, i]));
  const links = g.links.map(l => [idx.get(l.s), idx.get(l.t)]).filter(([a, b]) => a !== undefined && b !== undefined && a !== b);
  // community colours: biggest 6 groups get slots, the rest are "other"
  const counts = {};
  for (const x of g.nodes) counts[x.group] = (counts[x.group] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);
  const gColor = grp => { const i = top.indexOf(grp); return i >= 0 ? SLOTS[i] : OTHER; };

  const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 40; pos[i * 3 + 1] = (Math.random() - 0.5) * 40; pos[i * 3 + 2] = (Math.random() - 0.5) * 40; }

  const sphere = new THREE.SphereGeometry(1, 14, 10);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1 });
  const mesh = new THREE.InstancedMesh(sphere, mat, n);
  const col = new THREE.Color(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const size = g.nodes.map(x => 0.45 + Math.sqrt(x.deg) * 0.28);
  g.nodes.forEach((x, i) => mesh.setColorAt(i, col.set(gColor(x.group))));
  st.scene.add(mesh); st.hoverables.push(mesh);

  const lpos = new Float32Array(links.length * 6);
  const lgeo = new THREE.BufferGeometry(); lgeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
  st.scene.add(new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ color: INK.link, transparent: true, opacity: 0.55 })));

  // a few labels on the hubs
  const hubs = g.nodes.map((x, i) => [x.deg, i]).sort((a, b) => b[0] - a[0]).slice(0, 8).map(e => e[1]);
  const hubLabels = hubs.map(i => st.label(g.nodes[i].label, [0, 0, 0], 'lbl3d hub'));

  let iter = 0;
  const place = () => {
    for (let i = 0; i < n; i++) {
      p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); sc.setScalar(size[i]);
      mesh.setMatrixAt(i, m4.compose(p, q, sc));
    }
    mesh.instanceMatrix.needsUpdate = true;
    links.forEach(([a, b], k) => { lpos.set([pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]], k * 6); });
    lgeo.attributes.position.needsUpdate = true; lgeo.computeBoundingSphere();
    hubs.forEach((i, k) => hubLabels[k].position.set(pos[i * 3], pos[i * 3 + 1] + size[i] + 0.8, pos[i * 3 + 2]));
    mesh.computeBoundingSphere();
  };
  // simple force layout, a few steps per frame so it visibly settles
  st.onFrame = () => {
    if (iter > 260) return;
    for (let s = 0; s < 3 && iter <= 260; s++, iter++) {
      const alpha = 1 - iter / 280;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1], dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz + 0.01; if (d2 > 900) continue;
        const f = 30 / d2 * alpha;
        vel[i * 3] += dx * f; vel[i * 3 + 1] += dy * f; vel[i * 3 + 2] += dz * f;
        vel[j * 3] -= dx * f; vel[j * 3 + 1] -= dy * f; vel[j * 3 + 2] -= dz * f;
      }
      for (const [a, b] of links) {
        const dx = pos[b * 3] - pos[a * 3], dy = pos[b * 3 + 1] - pos[a * 3 + 1], dz = pos[b * 3 + 2] - pos[a * 3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01, f = (d - 4) * 0.03 * alpha / d;
        vel[a * 3] += dx * f; vel[a * 3 + 1] += dy * f; vel[a * 3 + 2] += dz * f;
        vel[b * 3] -= dx * f; vel[b * 3 + 1] -= dy * f; vel[b * 3 + 2] -= dz * f;
      }
      for (let i = 0; i < n * 3; i++) { vel[i] -= pos[i] * 0.004 * alpha; vel[i] *= 0.6; pos[i] += vel[i]; }
    }
    place();
    // keep the whole graph in frame (wheel zoom is off): distance from the 90th-percentile radius
    if (iter % 15 === 0 || iter > 260) {
      const rs = [];
      for (let i = 0; i < n; i++) rs.push(Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
      rs.sort((a, b) => a - b);
      const r = (rs[Math.floor(rs.length * 0.9)] || 10) + 2;
      const fov = st.camera.fov * Math.PI / 180;
      const want = r / Math.sin(fov / 2) * (st.camera.aspect < 1 ? 1.0 / st.camera.aspect : 0.72);
      st.camera.position.setLength(st.camera.position.length() * 0.8 + want * 0.2);
    }
  };
  place();
  let lastId = null;
  st.onHover = (hit, on) => {
    if (!hit || hit.instanceId === undefined) return;
    mesh.setColorAt(hit.instanceId, col.set(on ? INK.hover : gColor(g.nodes[hit.instanceId].group)));
    mesh.instanceColor.needsUpdate = true; lastId = on ? hit.instanceId : null;
  };
  st.tipFor = hit => {
    const x = g.nodes[hit.instanceId];
    return `<b dir="ltr">${esc(x.label)}</b><div dir="ltr" class="mono">${esc(x.file || '')}${x.loc ? ':' + esc(x.loc) : ''}</div><div>گروه: ${esc(x.group)}</div><div>اتصال‌ها: <b>${fa(x.deg)}</b></div>`;
  };
  st.legend = top.map(t => ({ name: t, color: gColor(t) })).concat(Object.keys(counts).length > top.length ? [{ name: 'سایر', color: OTHER }] : []);
  return st;
}

// ---------- dashboard shell ----------
const D = { gen: 0, stages: [], days: +(localStorage.getItem('jarvis.dash.days') || 14), metric: localStorage.getItem('jarvis.dash.metric') || 'tokens', scope: localStorage.getItem('jarvis.dash.scope') || 'all', timer: null };

function clear() { D.stages.forEach(s => s.dispose()); D.stages = []; }

async function render() {
  const root = $('#dashboard');
  if (!root) return;
  // A newer render (filter click, usage update, hide) supersedes this one: anything
  // this render builds after an await must check it is still current.
  const gen = ++D.gen;
  const S = window.JARVIS_STATE;
  const pid = D.scope === 'project' && S && S.projectId ? S.projectId : null;
  let data;
  try { data = await window.api(`/usage?days=${D.days}${pid ? '&projectId=' + pid : ''}`); }
  catch (e) { if (gen === D.gen) root.innerHTML = `<div class="dash-empty">داده‌ی مصرف در دسترس نیست: ${esc(e.message)}</div>`; return; }
  if (gen !== D.gen) return;
  clear();
  const proj = S && S.projects.find(p => p.id === S.projectId);
  const t = data.totals;
  root.innerHTML = `
    <div class="dash-filters">
      <h2><svg class="ic" aria-hidden="true"><use href="icons.svg#i-chart-column"/></svg>مصرف مدل‌ها</h2>
      <div class="seg" data-f="days">${[7, 14, 30].map(d => `<button class="${D.days === d ? 'on' : ''}" data-v="${d}">${fa(d)} روز</button>`).join('')}</div>
      <div class="seg" data-f="metric"><button class="${D.metric === 'tokens' ? 'on' : ''}" data-v="tokens">توکن</button><button class="${D.metric === 'cost' ? 'on' : ''}" data-v="cost">هزینه</button></div>
      <div class="seg" data-f="scope"><button class="${D.scope === 'all' ? 'on' : ''}" data-v="all">همه‌ی پروژه‌ها</button>${proj ? `<button class="${D.scope === 'project' ? 'on' : ''}" data-v="project">${esc(proj.name)}</button>` : ''}</div>
    </div>
    <div class="tiles">
      <div class="tile"><span>کل توکن</span><b>${fmtTok(t.tokens)}</b></div>
      ${S && S.claudeAuth === 'claude.ai'
        ? `<div class="tile"><span>هزینه‌ی Claude (معادل API)</span><b dir="ltr">≈${fmtUsd(t.costUsd)}</b><small>با اشتراک Pro پرداخت نمی‌شود</small></div>`
        : `<div class="tile"><span>هزینه‌ی Claude</span><b dir="ltr">${fmtUsd(t.costUsd)}</b></div>`}
      ${data.recent ? `<div class="tile"><span>Claude در ۵ ساعت اخیر</span><b>${fmtTok(data.recent.last5h.tokens)}</b><small>${fa(data.recent.last5h.steps)} مرحله · امروز ${fmtTok(data.recent.today.tokens)} توکن</small></div>` : ''}
      <div class="tile"><span>سهم کش ورودی</span><b>${Math.round(t.cacheShare * 100).toLocaleString('fa-IR')}٪</b><small>هرچه بیشتر، ارزان‌تر</small></div>
      <div class="tile"><span>مراحل اجرا</span><b>${fa(t.steps)}</b></div>
    </div>
    ${data.models.length ? `
    <div class="charts">
      <section class="chart wide"><header><h3>مصرف روزانه به تفکیک مدل</h3><small>بکشید تا بچرخد · روی ستون‌ها بروید</small></header><div class="stage3d" id="cBars"></div></section>
      <section class="chart"><header><h3>سهم هر مدل</h3></header><div class="stage3d" id="cDonut"></div>
        <ul class="legend">${data.models.map(m => {
          const tot = data.models.reduce((s, x) => s + (D.metric === 'cost' ? x.costUsd : x.tokens), 0) || 1;
          const v = D.metric === 'cost' ? m.costUsd : m.tokens;
          return `<li><i style="background:${modelColor(m.model, data.models.map(x => x.model))}"></i><span dir="ltr">${esc(shortModel(m.model))}</span><b>${D.metric === 'cost' ? fmtUsd(v) : fmtTok(v)}</b><em>${(v / tot * 100).toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪</em></li>`;
        }).join('')}</ul>
        <details class="tablev"><summary>نمایش جدول</summary><table><thead><tr><th>مدل</th><th>ورودی</th><th>خروجی</th><th>کش</th><th>هزینه</th><th>مراحل</th></tr></thead><tbody>
          ${data.models.map(m => `<tr><td dir="ltr">${esc(m.model)}</td><td>${fa(m.input)}</td><td>${fa(m.output)}</td><td>${fa(m.cacheRead)}</td><td dir="ltr">${fmtUsd(m.costUsd)}</td><td>${fa(m.steps)}</td></tr>`).join('')}
        </tbody></table></details>
      </section>
    </div>
    ${vsSection(data, S)}` : `<div class="dash-empty">در این بازه هنوز مصرفی ثبت نشده. بعد از اولین اجرا، نمودارها اینجا ساخته می‌شوند.</div>`}
    <section class="chart graph-card"><header><h3><svg class="ic" aria-hidden="true"><use href="icons.svg#i-network"/></svg>گراف کد پروژه (graphify)</h3><small id="gMeta"></small>
      ${proj ? `<button class="btn small" id="gBuild">ساخت / به‌روزرسانی گراف</button>` : ''}</header>
      <div class="stage3d tall" id="cGraph"><div class="dash-empty">${proj ? 'در حال خواندن گراف…' : 'یک پروژه انتخاب کنید.'}</div></div>
      <ul class="legend inline" id="gLegend"></ul>
    </section>`;

  root.querySelectorAll('.seg').forEach(seg => seg.onclick = e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    const f = seg.dataset.f, v = b.dataset.v;
    if (f === 'days') D.days = +v; else if (f === 'metric') D.metric = v; else D.scope = v;
    try { localStorage.setItem('jarvis.dash.' + f, v); } catch {}
    render();
  });
  if (data.models.length) {
    D.stages.push(barsChart($('#cBars'), data, D.metric));
    D.stages.push(donutChart($('#cDonut'), data, D.metric));
    const vs = providerData(data, S);
    if (vs.total.tokens) D.stages.push(donutChart($('#cVs'), { models: vs.rows }, vs.metric, m => m === 'claude' ? css('--color-claude') : css('--color-codex')));
  }
  if (proj) loadGraph(proj, gen);
}

async function loadGraph(proj, gen) {
  const host = $('#cGraph'), meta = $('#gMeta'), btn = $('#gBuild');
  if (btn) btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'در حال ساخت…';
    try { const r = await window.api(`/projects/${proj.id}/graph`, { body: {} }); if (!r.ok) throw new Error(r.error || 'failed'); }
    catch (e) { host.innerHTML = `<div class="dash-empty">ساخت گراف ناموفق: ${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = 'ساخت / به‌روزرسانی گراف'; return; }
    render();
  };
  let st;
  try { st = await window.api(`/projects/${proj.id}/graph`); } catch { st = {}; }
  if (gen !== D.gen) return;
  if (!st.installed) { host.innerHTML = '<div class="dash-empty">graphify نصب نیست. نصب: <code dir="ltr">uv tool install graphifyy</code></div>'; if (btn) btn.hidden = true; return; }
  if (!st.exists) { host.innerHTML = '<div class="dash-empty">برای این پروژه هنوز گرافی ساخته نشده — اولین اجرا آن را می‌سازد، یا دکمه‌ی بالا را بزنید.</div>'; return; }
  meta.textContent = `${fa(st.nodes)} گره · ${fa(st.edges)} یال · ${new Date(st.builtAt).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })}`;
  let g;
  try { g = await window.api(`/projects/${proj.id}/graph/view?limit=350`); }
  catch (e) { if (gen === D.gen) host.innerHTML = `<div class="dash-empty">خواندن گراف ناموفق: ${esc(e.message)}</div>`; return; }
  if (gen !== D.gen || !host.isConnected) return; // a newer render replaced this one: don't leak a 3D scene
  host.innerHTML = '';
  const stage = graphChart(host, g);
  D.stages.push(stage);
  $('#gLegend').innerHTML = stage.legend.map(l => `<li><i style="background:${l.color}"></i><span dir="auto">${esc(l.name)}</span></li>`).join('')
    + (g.total > g.nodes.length ? `<li class="muted">${fa(g.nodes.length)} گره‌ی پراتصال از ${fa(g.total)}</li>` : '');
}

window.JarvisDash = {
  show() { clearTimeout(D.timer); D.timer = setTimeout(render, 30); },
  hide() { clearTimeout(D.timer); D.gen++; clear(); }, // gen++ cancels renders still loading
  refresh() { if ($('#dashboard') && $('#dashboard').isConnected) { clearTimeout(D.timer); D.timer = setTimeout(render, 1500); } },
};
readPalette();
// Theme switch: new colours, redraw.
window.addEventListener('jarvis-theme', () => { readPalette(); if ($('#dashboard') && $('#dashboard').isConnected && $('#dashboard').offsetParent !== null) render(); });
window.dispatchEvent(new Event('jarvis-dash-ready'));
