// "Ops room": a live 3D view of every agent at work (three.js, bundled locally).
// Each active agent (builder, tester, sub-agents, connections) is a glowing node around the
// central reactor. Its label says what it is doing right now; a beam travels between agents
// when work is handed over, and a spark flies when a file is edited. Click a node for its live log.
// The scene is built only when the room is opened and stops rendering when it is closed.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from './vendor/CSS2DRenderer.js';

const S = window.JARVIS_STATE;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = (v, fb) => (getComputedStyle(document.documentElement).getPropertyValue(v) || '').trim() || fb;
const ROLE_FA = { builder: 'سازنده', reviewer: 'تستر', sub: 'ساب‌ایجنت', system: 'جارویس' };
const BUSY_MS = 120000;

// ---------- live model of who is doing what (fed by the app's server events) ----------
const agents = new Map(); // key -> { key, chatId, label, role, activity, ts, busy, log[], edits }
const chatLast = new Map(); // chatId -> key of the last active agent (for hand-off beams)
const stepName = new Map(); // chatId|engine -> display name of the step running on it (connections)
const listeners = new Set();
const emit = (type, a, extra) => listeners.forEach(f => f(type, a, extra));

function toolText(name, input) {
  let o = null; try { o = typeof input === 'string' ? JSON.parse(input) : input; } catch {}
  const target = (o && (o.file_path || o.notebook_path || o.command || o.pattern || o.url || o.query || o.description)) || (typeof input === 'string' ? input.split('\n')[0] : '');
  const short = String(target).replace(/^.*[\\/](?=[^\\/]+$)/, m => (String(target).length > 48 ? '…/' : m)).slice(0, 80);
  if (/^(Edit|Write|MultiEdit|NotebookEdit|file_change)$/.test(name)) return { text: `در حال نوشتن ${short}`, edit: true };
  if (/^(Read)$/.test(name)) return { text: `خواندن ${short}` };
  if (/^(Grep|Glob)$/.test(name)) return { text: `جستجو: ${short}` };
  if (/^(Bash|PowerShell|shell)$/.test(name)) return { text: `اجرای ${short}` };
  if (/^(Task|Agent)$/.test(name)) return { text: `سپردن کار به ساب‌ایجنت` };
  if (/^mcp__/.test(name)) return { text: `ابزار ${name.replace(/^mcp__/, '').replace(/__/, ' · ')}` };
  if (/^(WebSearch|WebFetch)$/.test(name)) return { text: `جستجوی وب: ${short}` };
  return { text: `${name} ${short}`.trim() };
}

function feed(chatId, m, chatTitle, live) {
  if (!m || m.agent === 'user') return;
  if (m.agent === 'system') {
    if (m.kind === 'phase' && /تست‌های پروژه/.test(m.text || '')) touch(chatId, 'system:tests', 'تست‌های پروژه', 'system', 'اجرای تست‌های پروژه', m, chatTitle, live);
    if (m.kind === 'tests') touch(chatId, 'system:tests', 'تست‌های پروژه', 'system', m.tests && m.tests.ok ? 'تست‌ها پاس شدند ✓' : 'تست‌ها شکست خوردند ✗', m, chatTitle, live, true);
    if (m.kind === 'smartplan') touch(chatId, 'system:planner', 'برنامه‌ریز', 'system', `کار به ${(m.plan || []).length} بخش تقسیم شد`, m, chatTitle, live, true);
    return;
  }
  // tool events use "name" for the tool; the agent's own name comes from its last phase message
  const isTool = m.kind === 'tool' || m.kind === 'tool_result';
  const lk = `${chatId}|${m.agent}`;
  if (!isTool && !m.sub && !m.via && m.kind === 'phase') stepName.set(lk, m.name || null);
  const agentName = isTool ? stepName.get(lk) : (m.name || stepName.get(lk));
  const label = m.via ? `↳ ${m.via}` : m.sub || agentName || (m.agent === 'claude' ? 'Claude' : 'Codex');
  const key = `${chatId}|${m.via ? 'via:' + m.via : m.sub ? 'sub:' + m.sub : agentName ? 'n:' + agentName : m.agent}`;
  const prev = agents.get(key);
  let role = prev ? prev.role : (m.sub || m.via ? 'sub' : m.agent === 'codex' ? 'reviewer' : 'builder');
  let act = null, edit = false;
  switch (m.kind) {
    case 'phase':
      act = m.text;
      if (!m.sub && !m.via) role = /بررسی|تست|نقد|تستر/.test(m.text || '') ? 'reviewer' : 'builder';
      break;
    case 'tool': { const t = toolText(m.name || '', m.input); act = t.text; edit = t.edit; break; }
    case 'text': act = 'پیام نوشت'; break;
    case 'thinking': act = 'در حال فکر کردن'; break;
    case 'review': act = m.review && m.review.verdict === 'pass' ? 'تأیید کرد ✓' : `${(m.review && m.review.bugs || []).length} مشکل گزارش داد`; break;
    case 'error': act = 'خطا: ' + String(m.text || '').slice(0, 60); break;
    case 'status': if (/^مدل:/.test(m.text || '')) act = m.text.split('·')[0].trim(); break;
    default: return;
  }
  if (act == null) return;
  touch(chatId, key, label, role, act, m, chatTitle, live, m.kind === 'review', edit);
}

function touch(chatId, key, label, role, activity, m, chatTitle, live, done = false, edit = false) {
  let a = agents.get(key);
  const isNew = !a;
  if (!a) { a = { key, chatId, label, role, activity: '', ts: 0, busy: false, log: [], edits: 0, steps: 0 }; agents.set(key, a); }
  a.label = label; a.role = role; a.activity = activity; a.ts = m.ts || Date.now(); a.chatTitle = chatTitle || a.chatTitle;
  a.busy = !done; a.steps++;
  if (edit) a.edits++;
  a.log.push({ ts: a.ts, text: activity }); if (a.log.length > 80) a.log.shift();
  const last = chatLast.get(chatId);
  if (live && last && last !== key && agents.has(last)) emit('beam', agents.get(last), a);
  chatLast.set(chatId, key);
  emit(isNew ? 'add' : 'update', a, live && edit ? 'spark' : null);
}

function chatTitleOf(id) { const c = (S.chats || []).find(x => x.id === id); return c ? c.title : ''; }

window.addEventListener('jarvis:ev', e => {
  const ev = e.detail;
  if (ev.type === 'message') feed(ev.chatId, ev.message, chatTitleOf(ev.chatId), true);
  else if (ev.type === 'finished') {
    for (const a of agents.values()) if (a.chatId === ev.chatId) { a.busy = false; a.done = Date.now(); emit('update', a); }
    chatLast.delete(ev.chatId);
  }
});

// Running chats when the room is opened: replay their recent messages.
async function loadRunning() {
  const running = (S.chats || []).filter(c => c.status === 'running' || c.status === 'waiting');
  for (const c of running.slice(0, 6)) {
    if ([...agents.values()].some(a => a.chatId === c.id)) continue;
    try {
      const full = await window.api('/chats/' + c.id);
      const startIdx = full.messages.map(m => m.agent === 'user' && m.kind === 'text').lastIndexOf(true);
      for (const m of full.messages.slice(Math.max(0, startIdx)).slice(-150)) feed(c.id, m, c.title, false);
    } catch {}
  }
}

// ---------- the scene ----------
let room = null;
class Room {
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    this.camera.position.set(0, 9, 17);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none', direction: 'ltr' });
    this.labels.domElement.className = 'ops-labels';
    host.appendChild(this.labels.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 8; this.controls.maxDistance = 40;
    this.controls.autoRotate = !reduced(); this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const pl = new THREE.PointLight(0xffffff, 60, 40); pl.position.set(0, 3, 0); this.scene.add(pl);
    const dl = new THREE.DirectionalLight(0xffffff, 0.6); dl.position.set(5, 10, 7); this.scene.add(dl);
    this.colors = {
      builder: new THREE.Color(css('--color-claude', '#ffb98a')), reviewer: new THREE.Color(css('--color-codex', '#5eead4')),
      sub: new THREE.Color(css('--color-success', '#86efac')), system: new THREE.Color(css('--color-primary', '#7dd3fc')),
    };
    this.buildReactor();
    this.nodes = new Map(); // agent key -> { group, core, ring, label, line, a }
    this.fx = []; // beams and sparks
    this.clock = new THREE.Clock();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.resize();
    this.onEvent = (type, a, extra) => {
      if (type === 'add') { this.addNode(a); this.layout(); }
      else if (type === 'update') { if (!this.nodes.has(a.key)) { this.addNode(a); this.layout(); } this.updateNode(a); if (extra === 'spark') this.spark(a); }
      else if (type === 'beam') this.beam(a, extra);
      if (this.paused) this.renderOnce();
    };
    listeners.add(this.onEvent);
    for (const a of agents.values()) this.addNode(a);
    this.layout();
  }
  buildReactor() {
    const c = this.colors.system;
    const g = this.reactor = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.9, 32, 32), new THREE.MeshBasicMaterial({ color: c }));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(1.5, 32, 32), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.12 }));
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(2.1, 1), new THREE.MeshBasicMaterial({ color: c, wireframe: true, transparent: true, opacity: 0.35 }));
    const ringMat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    this.rings = [0, 1, 2].map(i => { const r = new THREE.Mesh(new THREE.TorusGeometry(2.8 + i * 0.45, 0.025, 8, 96), ringMat); r.rotation.x = Math.PI / 2 + i * 0.35; r.rotation.y = i * 0.6; g.add(r); return r; });
    const floor = new THREE.Mesh(new THREE.RingGeometry(6.6, 6.65, 128), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01;
    const grid = new THREE.PolarGridHelper(12, 16, 8, 64, c, c); grid.material.transparent = true; grid.material.opacity = 0.08; grid.position.y = -1.2;
    g.add(core, glow, shell); this.shell = shell; this.glow = glow;
    this.scene.add(g, floor, grid);
    const lab = document.createElement('div'); lab.className = 'ops-label'; lab.innerHTML = '<b>JARVIS</b>';
    const lo = new CSS2DObject(lab); lo.position.set(0, -2.6, 0); g.add(lo);
  }
  addNode(a) {
    if (this.nodes.has(a.key)) return;
    const col = this.colors[a.role] || this.colors.system;
    const group = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 24), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.8, roughness: 0.3 }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.75, 24, 24), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.15 }));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.03, 8, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7 }));
    group.add(core, halo, ring);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.25 }));
    const el = document.createElement('div'); el.className = 'ops-label';
    el.addEventListener('click', () => openLog(a.key));
    const label = new CSS2DObject(el); label.position.set(0, 1.35, 0); group.add(label);
    this.scene.add(group, line);
    const n = { group, core, halo, ring, line, el, a, target: new THREE.Vector3(), seed: Math.random() * 10 };
    this.nodes.set(a.key, n);
    this.updateNode(a);
  }
  updateNode(a) {
    const n = this.nodes.get(a.key); if (!n) return;
    const col = this.colors[a.role] || this.colors.system;
    n.core.material.color.copy(col); n.core.material.emissive.copy(col); n.halo.material.color.copy(col); n.ring.material.color.copy(col); n.line.material.color.copy(col);
    n.el.className = 'ops-label ' + (a.busy ? 'busy' : 'idle');
    const ago = Math.round((Date.now() - a.ts) / 1000);
    n.el.innerHTML = `<b dir="auto">${esc(a.label)}</b><span dir="auto">${esc(a.activity)}</span><span>${ROLE_FA[a.role] || ''} · ${esc((a.chatTitle || '').slice(0, 26))}</span>`
      + `<span class="meta">${a.steps} steps${a.edits ? ` · ${a.edits} edits` : ''}${a.busy ? '' : ago < 3600 ? ` · ${ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm'} ago` : ''}</span>`;
  }
  // Agents of the same chat sit next to each other on the ring; each chat gets an arc.
  layout() {
    const list = [...this.nodes.values()];
    const chats = [...new Set(list.map(n => n.a.chatId))];
    const total = list.length + chats.length * 0.6;
    let i = 0;
    for (const cid of chats) {
      for (const n of list.filter(x => x.a.chatId === cid)) {
        const ang = (i / total) * Math.PI * 2;
        const r = n.a.role === 'sub' ? 8.2 : 6.6;
        n.target.set(Math.sin(ang) * r, n.a.role === 'sub' ? 1.2 : 0, Math.cos(ang) * r);
        if (n.group.position.lengthSq() === 0) n.group.position.copy(n.target);
        i++;
      }
      i += 0.6;
    }
  }
  beam(from, to) {
    const A = this.nodes.get(from.key), B = this.nodes.get(to.key);
    if (!A || !B || reduced()) return;
    const col = this.colors[to.role] || this.colors.system;
    const p0 = A.group.position.clone(), p2 = B.group.position.clone();
    const curve = new THREE.QuadraticBezierCurve3(p0, new THREE.Vector3(0, 3.5, 0), p2);
    const geo = new THREE.TubeGeometry(curve, 48, 0.05, 6, false);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8 }));
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), new THREE.MeshBasicMaterial({ color: col }));
    this.scene.add(mesh, ball);
    this.fx.push({ t: 0, dur: 1.4, update: (k) => { ball.position.copy(curve.getPoint(Math.min(1, k))); mesh.material.opacity = 0.8 * (1 - k); }, dispose: () => { this.scene.remove(mesh, ball); geo.dispose(); mesh.material.dispose(); ball.geometry.dispose(); ball.material.dispose(); } });
  }
  spark(a) {
    const n = this.nodes.get(a.key); if (!n || reduced()) return;
    const col = this.colors[a.role] || this.colors.system;
    const count = 18, pos = new Float32Array(count * 3), vel = [];
    for (let i = 0; i < count; i++) { vel.push(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).multiplyScalar(2.2)); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: col, size: 0.14, transparent: true, opacity: 1 }));
    pts.position.copy(n.group.position); this.scene.add(pts);
    this.fx.push({ t: 0, dur: 0.9, update: k => { for (let i = 0; i < count; i++) { pos[i * 3] = vel[i].x * k; pos[i * 3 + 1] = vel[i].y * k - 1.5 * k * k; pos[i * 3 + 2] = vel[i].z * k; } geo.attributes.position.needsUpdate = true; pts.material.opacity = 1 - k; }, dispose: () => { this.scene.remove(pts); geo.dispose(); pts.material.dispose(); } });
  }
  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false); this.renderer.domElement.style.width = w + 'px'; this.renderer.domElement.style.height = h + 'px';
    this.labels.setSize(w, h);
    if (this.paused) this.renderOnce();
  }
  renderOnce() { this.renderer.render(this.scene, this.camera); this.labels.render(this.scene, this.camera); }
  tick() {
    if (this.paused) return;
    this.raf = requestAnimationFrame(() => this.tick());
    const dt = Math.min(0.05, this.clock.getDelta()), t = this.clock.elapsedTime;
    const still = reduced();
    if (!still) {
      this.shell.rotation.y += dt * 0.25; this.shell.rotation.x += dt * 0.1;
      this.rings.forEach((r, i) => { r.rotation.z += dt * (0.3 + i * 0.15) * (i % 2 ? -1 : 1); });
      const anyBusy = [...this.nodes.values()].some(n => n.a.busy);
      this.glow.scale.setScalar(1 + (anyBusy ? 0.12 : 0.04) * Math.sin(t * (anyBusy ? 4 : 1.5)));
    }
    const now = Date.now();
    for (const n of this.nodes.values()) {
      if (n.a.busy && now - n.a.ts > BUSY_MS) { n.a.busy = false; this.updateNode(n.a); }
      n.group.position.lerp(n.target, Math.min(1, dt * 3));
      const busy = n.a.busy;
      if (!still) {
        n.ring.rotation.x += dt * (busy ? 2.4 : 0.3); n.ring.rotation.y += dt * (busy ? 1.6 : 0.2);
        n.halo.scale.setScalar(busy ? 1 + 0.25 * Math.sin(t * 5 + n.seed) : 1);
        n.group.position.y = n.target.y + 0.15 * Math.sin(t * 1.2 + n.seed);
      }
      n.core.material.emissiveIntensity = busy ? 1.1 : 0.25;
      n.halo.material.opacity = busy ? 0.22 : 0.06;
      n.line.material.opacity = busy ? 0.45 : 0.1;
      const p = n.line.geometry.attributes.position; p.setXYZ(1, n.group.position.x, n.group.position.y, n.group.position.z); p.needsUpdate = true;
    }
    if (Math.floor(t) !== this.lastSec) { this.lastSec = Math.floor(t); for (const n of this.nodes.values()) if (!n.a.busy) this.updateNode(n.a); }
    this.fx = this.fx.filter(f => { f.t += dt; const k = f.t / f.dur; if (k >= 1) { f.dispose(); return false; } f.update(k); return true; });
    this.controls.update();
    this.renderOnce();
  }
  start() { this.paused = false; this.clock.getDelta(); this.tick(); }
  stop() { this.paused = true; cancelAnimationFrame(this.raf); }
  // drop agents of chats that finished long ago
  prune() {
    const old = Date.now() - 20 * 60000;
    for (const [k, a] of agents) if (!a.busy && a.ts < old) { agents.delete(k); const n = this.nodes.get(k); if (n) { this.scene.remove(n.group, n.line); n.el.remove(); this.nodes.delete(k); } }
    this.layout();
  }
}

// ---------- the overlay ----------
let overlay = null, logKey = null;
function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('section');
  overlay.className = 'ops'; overlay.hidden = true;
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'اتاق عملیات');
  overlay.innerHTML = `<div class="ops-canvas" id="opsCanvas"></div>
    <div class="ops-top"><h2>${ic('radar')}اتاق عملیات</h2><span class="help" id="opsInfo"></span>
      <button type="button" class="btn small ghost" id="opsClose">${ic('x', 'sm')}بستن (Esc)</button></div>
    <div class="ops-empty" id="opsEmpty">الان هیچ ایجنتی کار نمی‌کند. وقتی کاری شروع شود، ایجنت‌ها اینجا زنده ظاهر می‌شوند.</div>
    <div class="ops-legend"><span><i style="background:var(--color-claude)"></i>سازنده</span><span><i style="background:var(--color-codex)"></i>تستر</span><span><i style="background:var(--color-success)"></i>ساب‌ایجنت</span><span><i style="background:var(--color-primary)"></i>جارویس</span><span>کشیدن = چرخاندن · چرخ موس = زوم · کلیک روی هر ایجنت = گزارش زنده</span></div>
    <aside class="ops-side" id="opsSide" hidden><header><b id="opsSideTitle"></b><button type="button" class="icon-btn" id="opsSideClose" aria-label="بستن">${ic('x', 'sm')}</button></header><div class="ops-log" id="opsLog"></div></aside>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#opsClose').onclick = closeOps;
  overlay.querySelector('#opsSideClose').onclick = () => { logKey = null; overlay.querySelector('#opsSide').hidden = true; };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay && !overlay.hidden && !document.querySelector('#dlg[open]')) closeOps(); });
  listeners.add(() => { refreshInfo(); if (logKey) renderLog(); });
  return overlay;
}
function refreshInfo() {
  if (!overlay) return;
  const list = [...agents.values()];
  const busy = list.filter(a => a.busy).length;
  const chats = new Set(list.filter(a => a.busy).map(a => a.chatId)).size;
  overlay.querySelector('#opsInfo').textContent = busy ? `${busy.toLocaleString('fa-IR')} ایجنت در حال کار در ${chats.toLocaleString('fa-IR')} گفتگو` : 'همه بیکارند';
  overlay.querySelector('#opsEmpty').hidden = list.length > 0;
}
function openLog(key) {
  logKey = key;
  overlay.querySelector('#opsSide').hidden = false;
  renderLog();
}
function renderLog() {
  const a = agents.get(logKey); if (!a) return;
  overlay.querySelector('#opsSideTitle').textContent = `${a.label} — ${ROLE_FA[a.role] || ''}`;
  const box = overlay.querySelector('#opsLog');
  box.innerHTML = a.log.slice().reverse().map(l => `<div><time>${new Date(l.ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span dir="auto">${esc(l.text)}</span></div>`).join('');
}
let pruneTimer = null;
async function openOps() {
  ensureOverlay();
  overlay.hidden = false;
  // colours come from the current look/theme: rebuild the scene if it changed since last time
  const look = [document.documentElement.dataset.skin, document.documentElement.dataset.theme, css('--color-primary', '')].join('|');
  if (room && room.look !== look) { room.stop(); room.ro.disconnect(); listeners.delete(room.onEvent); room.renderer.dispose(); overlay.querySelector('#opsCanvas').innerHTML = ''; room = null; }
  if (!room) { room = new Room(overlay.querySelector('#opsCanvas')); room.look = look; }
  await loadRunning();
  room.prune(); refreshInfo();
  room.start();
  clearInterval(pruneTimer); pruneTimer = setInterval(() => room.prune(), 60000);
  overlay.querySelector('#opsClose').focus();
}
function closeOps() {
  if (!overlay) return;
  overlay.hidden = true;
  if (room) room.stop();
  clearInterval(pruneTimer);
  document.getElementById('btnOps')?.focus();
}
window.openOps = openOps;
document.getElementById('btnOps').onclick = openOps;
