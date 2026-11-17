// Real numbers for the Command Center: CPU, memory, disk, network latency, weather.
// Nothing here is made up: when a value can't be read it is null and the panel says so.
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

let prevCpu = null;
function cpuTimes() { return os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 }); }
// CPU busy % since the previous call (first call: since boot)
function cpuPercent() {
  const now = cpuTimes();
  const base = prevCpu || { idle: 0, total: 0 };
  prevCpu = now;
  const dt = now.total - base.total;
  return dt > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - (now.idle - base.idle) / dt)))) : null;
}
cpuPercent();

function disk(dir) {
  try {
    const root = path.parse(path.resolve(dir || os.homedir())).root;
    const s = fs.statfsSync(root);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { root, total, used: total - free, free };
  } catch { return null; }
}

function snapshot() {
  const total = os.totalmem(), free = os.freemem();
  const cpus = os.cpus();
  return {
    cpu: { percent: cpuPercent(), cores: cpus.length, model: (cpus[0] && cpus[0].model || '').replace(/\s+/g, ' ').trim() },
    mem: { total, used: total - free },
    disk: disk(),
    uptimeSec: Math.round(os.uptime()),
    platform: process.platform,
  };
}

// How long a small request to the internet takes (ms), or null when offline.
async function latency(url = 'https://www.gstatic.com/generate_204') {
  const t0 = Date.now();
  try { const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) }); if (r.status >= 500) return null; return Date.now() - t0; } catch { return null; }
}

// ---- weather (Open-Meteo: free, no key). Only the city the user chose is sent. ----
const WMO_FA = { 0: 'صاف', 1: 'کمی ابری', 2: 'نیمه‌ابری', 3: 'ابری', 45: 'مه', 48: 'مه یخ‌زده', 51: 'نم‌نم باران', 53: 'نم‌نم باران', 55: 'نم‌نم باران', 61: 'باران سبک', 63: 'باران', 65: 'باران شدید', 66: 'باران یخ‌زده', 67: 'باران یخ‌زده', 71: 'برف سبک', 73: 'برف', 75: 'برف شدید', 77: 'دانه‌ی برف', 80: 'رگبار', 81: 'رگبار', 82: 'رگبار شدید', 85: 'بارش برف', 86: 'بارش برف شدید', 95: 'رعد و برق', 96: 'رعد و برق و تگرگ', 99: 'رعد و برق و تگرگ' };
const weatherCache = new Map(); // key -> { at, data }

async function geocode(name, lang = 'fa') {
  const q = String(name || '').trim().slice(0, 80);
  if (!q) return [];
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&language=${lang}&name=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('جستجوی شهر نشد (' + r.status + ')');
  const j = await r.json();
  return (j.results || []).map(x => ({ name: x.name, country: x.country || '', admin: x.admin1 || '', lat: x.latitude, lon: x.longitude, tz: x.timezone || '' }));
}

async function weather(place) {
  if (!place || typeof place.lat !== 'number' || typeof place.lon !== 'number') return null;
  const key = place.lat.toFixed(2) + ',' + place.lon.toFixed(2);
  const c = weatherCache.get(key);
  if (c && Date.now() - c.at < 15 * 60000) return c.data;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4`;
    const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const cur = j.current || {};
    const data = {
      place: place.name, at: Date.now(), stale: false,
      now: { temp: cur.temperature_2m, feels: cur.apparent_temperature, humidity: cur.relative_humidity_2m, wind: cur.wind_speed_10m, code: cur.weather_code, text: WMO_FA[cur.weather_code] || '', day: cur.is_day === 1 },
      days: (j.daily && j.daily.time || []).map((d, i) => ({ date: d, max: j.daily.temperature_2m_max[i], min: j.daily.temperature_2m_min[i], code: j.daily.weather_code[i], text: WMO_FA[j.daily.weather_code[i]] || '' })),
    };
    weatherCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (c) return { ...c.data, stale: true }; // last known, marked as old
    return { place: place.name, error: 'آب‌وهوا در دسترس نیست (' + (e.name === 'TimeoutError' ? 'اینترنت' : e.message) + ')' };
  }
}

module.exports = { snapshot, latency, geocode, weather, cpuPercent, WMO_FA };
