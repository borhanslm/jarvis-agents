// Calendars for JARVIS: reads the private iCal (.ics) address of Google Calendar, Outlook or Apple
// (read-only, no sign-in needed). The address is a secret, so it is kept encrypted (setup.secrets).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- ICS ----------
function unfold(text) { return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n'); }
function prop(line) {
  const i = line.indexOf(':'); if (i < 0) return null;
  const [name, ...ps] = line.slice(0, i).split(';');
  const params = {}; for (const p of ps) { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}
const unesc = s => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
// offset (ms) of a time zone at a moment
function tzOffset(tz, ms) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  } catch { return null; }
}
const WIN_TZ = { 'iran standard time': 'Asia/Tehran', 'gmt standard time': 'Europe/London', 'w. europe standard time': 'Europe/Berlin', 'eastern standard time': 'America/New_York', 'pacific standard time': 'America/Los_Angeles', 'central standard time': 'America/Chicago', 'arabian standard time': 'Asia/Dubai', 'turkey standard time': 'Europe/Istanbul', 'utc': 'UTC' };
// "20261117T100000Z" / "20261117T100000" (+TZID) / "20261117" (all day) -> { ms, allDay }
function parseDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim()); if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { ms: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  const tz = params.TZID && (WIN_TZ[params.TZID.toLowerCase()] || params.TZID.replace(/^\/[^/]*\//, ''));
  if (tz) {
    const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    const o1 = tzOffset(tz, guess);
    if (o1 != null) { const o2 = tzOffset(tz, guess - o1); return { ms: guess - (o2 != null ? o2 : o1), allDay: false }; }
  }
  return { ms: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };
}
function parseIcs(text) {
  const events = []; let ev = null, depth = 0;
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT$/i.test(line)) { ev = { exdates: [] }; continue; }
    if (/^END:VEVENT$/i.test(line)) { if (ev && ev.start) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    if (/^BEGIN:/i.test(line)) { depth++; continue; } // VALARM etc.
    if (/^END:/i.test(line)) { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    const p = prop(line); if (!p) continue;
    if (p.name === 'SUMMARY') ev.title = unesc(p.value);
    else if (p.name === 'LOCATION') ev.location = unesc(p.value);
    else if (p.name === 'DESCRIPTION') ev.desc = unesc(p.value).slice(0, 500);
    else if (p.name === 'UID') ev.uid = p.value;
    else if (p.name === 'STATUS') ev.cancelled = /CANCELLED/i.test(p.value);
    else if (p.name === 'RRULE') ev.rrule = Object.fromEntries(p.value.split(';').map(x => x.split('=')).filter(x => x.length === 2).map(([k, v]) => [k.toUpperCase(), v]));
    else if (p.name === 'DTSTART') { const d = parseDate(p.value, p.params); if (d) { ev.start = d.ms; ev.allDay = d.allDay || p.params.VALUE === 'DATE'; } }
    else if (p.name === 'DTEND') { const d = parseDate(p.value, p.params); if (d) ev.end = d.ms; }
    else if (p.name === 'EXDATE') for (const v of p.value.split(',')) { const d = parseDate(v, p.params); if (d) ev.exdates.push(d.ms); }
    else if (p.name === 'RECURRENCE-ID') { const d = parseDate(p.value, p.params); if (d) ev.recurrenceId = d.ms; }
  }
  return events;
}
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// occurrences of the events between from and to
function expand(events, from, to) {
  const out = [];
  const moved = new Map(); // uid -> set of original start times replaced by a separate (edited) event
  for (const e of events) if (e.recurrenceId != null && e.uid) { if (!moved.has(e.uid)) moved.set(e.uid, new Set()); moved.get(e.uid).add(e.recurrenceId); }
  for (const e of events) {
    if (e.cancelled) continue;
    const dur = (e.end && e.end > e.start) ? e.end - e.start : e.allDay ? 864e5 : 3600e3;
    const push = s => { if (s + dur > from && s < to) out.push({ title: e.title || '(بدون عنوان)', start: s, end: s + dur, allDay: !!e.allDay, location: e.location || '', uid: e.uid || '' }); };
    if (!e.rrule || e.recurrenceId != null) { push(e.start); continue; }
    const r = e.rrule, freq = r.FREQ, interval = Math.max(1, +r.INTERVAL || 1), count = +r.COUNT || Infinity;
    const until = r.UNTIL ? (parseDate(r.UNTIL) || {}).ms || Infinity : Infinity;
    const skip = new Set([...e.exdates, ...(moved.get(e.uid) || [])]);
    const byday = r.BYDAY ? r.BYDAY.split(',').map(x => DAYS.indexOf(x.replace(/^[+-]?\d+/, ''))).filter(x => x >= 0) : null;
    const base = new Date(e.start); let n = 0;
    const emit = s => { if (s < e.start || s > until || n >= count) return false; n++; if (!skip.has(s)) push(s); return true; };
    // without COUNT, jump close to the window (a daily event from years ago)
    const stepDays = { DAILY: 1, WEEKLY: 7, MONTHLY: 28, YEARLY: 365 }[freq] * interval;
    const i0 = count === Infinity && stepDays ? Math.max(0, Math.floor((from - e.start) / (stepDays * 864e5)) - 2) : 0;
    for (let i = i0; i < i0 + 3000; i++) {
      let cur;
      if (freq === 'DAILY') cur = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i * interval, base.getHours(), base.getMinutes(), base.getSeconds());
      else if (freq === 'WEEKLY') cur = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i * 7 * interval, base.getHours(), base.getMinutes(), base.getSeconds());
      else if (freq === 'MONTHLY') cur = new Date(base.getFullYear(), base.getMonth() + i * interval, base.getDate(), base.getHours(), base.getMinutes(), base.getSeconds());
      else if (freq === 'YEARLY') cur = new Date(base.getFullYear() + i * interval, base.getMonth(), base.getDate(), base.getHours(), base.getMinutes(), base.getSeconds());
      else { push(e.start); break; }
      if (cur.getTime() > until || cur.getTime() > to || n >= count) break;
      if (freq === 'WEEKLY' && byday && byday.length) {
        const weekStart = new Date(cur); weekStart.setDate(cur.getDate() - cur.getDay());
        for (const wd of byday.slice().sort()) { const d = new Date(weekStart); d.setDate(weekStart.getDate() + wd); d.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0); emit(d.getTime()); }
      } else emit(cur.getTime());
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

async function fetchIcs(url) {
  url = String(url).trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\//i.test(url)) throw new Error('آدرس باید با https یا webcal شروع شود');
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow', headers: { 'user-agent': 'JARVIS-Calendar' } });
  if (!r.ok) throw new Error('تقویم باز نشد (' + r.status + ')');
  const t = await r.text();
  if (!/BEGIN:VCALENDAR/i.test(t)) throw new Error('این آدرس یک تقویم iCal نیست');
  if (t.length > 8e6) throw new Error('تقویم خیلی بزرگ است');
  return t;
}

class Calendars {
  constructor(dataDir, secrets) {
    this.file = path.join(dataDir, 'calendars.json'); this.secrets = secrets; this.cache = new Map();
    try { this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')).feeds || []; } catch { this.list = []; }
  }
  _save() { fs.writeFileSync(this.file, JSON.stringify({ feeds: this.list }, null, 2)); }
  view() { return this.list.map(f => ({ ...f, error: (this.cache.get(f.id) || {}).error || '' })); }
  async add({ name, url, color }) {
    const t = await fetchIcs(url);
    const id = crypto.randomUUID().slice(0, 8);
    const f = { id, name: String(name || '').trim().slice(0, 40) || (/X-WR-CALNAME:(.+)/i.exec(t) || [, 'تقویم'])[1].trim().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '' };
    this.secrets.set('cal.' + id, String(url).trim());
    this.list.push(f); this._save();
    this.cache.set(id, { at: Date.now(), events: parseIcs(t) });
    return f;
  }
  remove(id) { this.list = this.list.filter(f => f.id !== id); this.secrets.set('cal.' + id, null); this.cache.delete(id); this._save(); }
  async refresh(force = false) {
    await Promise.all(this.list.map(async f => {
      const c = this.cache.get(f.id);
      if (!force && c && !c.error && Date.now() - c.at < 10 * 6e4) return;
      try { this.cache.set(f.id, { at: Date.now(), events: parseIcs(await fetchIcs(this.secrets.get('cal.' + f.id) || '')) }); }
      catch (e) { this.cache.set(f.id, { at: Date.now(), events: (c && c.events) || [], error: e.message }); }
    }));
  }
  // events between now (minus a little) and `days` ahead, from every calendar
  async upcoming(days = 7, { from = Date.now() - 3600e3 } = {}) {
    await this.refresh();
    const to = from + days * 864e5;
    return this.list.flatMap(f => expand((this.cache.get(f.id) || {}).events || [], from, to).map(e => ({ ...e, calendar: f.name, color: f.color })))
      .sort((a, b) => a.start - b.start).slice(0, 200);
  }
}

module.exports = { Calendars, parseIcs, expand, parseDate };
