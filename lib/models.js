// Model catalog: exact IDs and the names shown everywhere in the UI.
// IDs verified with the Claude CLI (each one answered a test prompt).
'use strict';

const CLAUDE = [
  { id: 'claude-fable-5-2',  name: 'Claude Fable 5.2',  alias: 'fable',  note: 'قوی‌ترین · گران‌ترین' },
  { id: 'claude-opus-5-5',   name: 'Claude Opus 5.5',   alias: 'opus',   note: 'خیلی قوی' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', alias: 'sonnet', note: 'متعادل' },
  { id: 'claude-haiku-5-5',  name: 'Claude Haiku 5.5',  alias: 'haiku',  note: 'سریع · ارزان' },
];
const ALIAS = Object.fromEntries(CLAUDE.map(m => [m.alias, m.id]));

// Exact display name for any model id or alias:
//   claude-opus-5-5 -> "Claude Opus 5.5", opus -> "Claude Opus 5.5",
//   claude-sonnet-5-5[1m] -> "Claude Sonnet 5.5 (1M)", gpt-6-astra -> "GPT-6 Astra"
function prettyModel(id) {
  if (!id) return '';
  const raw = String(id).trim();
  const known = CLAUDE.find(m => m.id === raw || m.alias === raw.toLowerCase());
  if (known) return known.name;
  const c = raw.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(\[1m\])?$/i);
  if (c) return `Claude ${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}.${c[3]}${c[4] ? ' (1M)' : ''}`;
  const g = raw.match(/^gpt-([\d.]+)(?:-(.+))?$/i);
  if (g) return `GPT-${g[1]}${g[2] ? ' ' + g[2].split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') : ''}`;
  return raw;
}
// Settings used to store aliases ("sonnet"); store exact IDs instead.
const resolveAlias = v => ALIAS[String(v || '').toLowerCase()] || v;

module.exports = { CLAUDE, prettyModel, resolveAlias };
