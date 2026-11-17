// JARVIS learns from its hearing mistakes. When speech recognition gets a word wrong and the user
// confirms the right one («منظورتان کروم بود؟» — «آره»), the pair is kept here (data/voice-lexicon.json).
// Next time: the wrong words are fixed before the brain sees them, and the right words are given to the
// speech engine as a hint (names, apps, projects), so it hears them correctly in the first place.
'use strict';
const fs = require('fs');
const path = require('path');

const norm = s => String(s || '').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class Lexicon {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'voice-lexicon.json');
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.list = Array.isArray(j.corrections) ? j.corrections : []; } catch { this.list = []; }
  }
  save() { try { fs.writeFileSync(this.file, JSON.stringify({ corrections: this.list.slice(-300) }, null, 1)); } catch {} }
  // heard (what the engine wrote) -> meant (what the user said)
  learn(heard, meant) {
    const h = norm(heard), m = String(meant || '').replace(/\s+/g, ' ').trim();
    if (!h || !m || h === norm(m) || h.length > 60 || m.length > 60) return null;
    let c = this.list.find(x => x.heard === h);
    if (c) { c.meant = m; c.count = (c.count || 1) + 1; c.at = Date.now(); }
    else { c = { heard: h, meant: m, count: 1, at: Date.now() }; this.list.push(c); }
    this.save(); return c;
  }
  remove(heard) { const h = norm(heard); const n = this.list.length; this.list = this.list.filter(x => x.heard !== h); if (this.list.length !== n) this.save(); }
  all() { return [...this.list].sort((a, b) => b.at - a.at); }
  // fix learned mistakes in a transcript (whole words only) -> { text, fixed: [{heard, meant}] }
  apply(text) {
    let out = String(text || ''); const fixed = [];
    // longest phrases first, so "گوگل کرم" wins over "کرم"
    for (const c of [...this.list].sort((a, b) => b.heard.length - a.heard.length)) {
      const words = c.heard.split(' ').map(escRe).join('[\\s\\u200c]+');
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${words})(?=$|[^\\p{L}\\p{N}])`, 'giu');
      const before = out;
      out = out.replace(re, (_, pre) => pre + c.meant);
      if (out !== before) fixed.push({ heard: c.heard, meant: c.meant });
    }
    return { text: out, fixed };
  }
  // words worth telling the speech engine about (most used first), plus the given names
  hint(extra = []) {
    const words = [...new Set([...this.all().sort((a, b) => (b.count || 1) - (a.count || 1)).map(c => c.meant), ...extra.filter(Boolean).map(String)])];
    let s = '';
    for (const w of words) { if ((s + ', ' + w).length > 400) break; s = s ? s + ', ' + w : w; }
    return s;
  }
}

module.exports = { Lexicon, norm };
