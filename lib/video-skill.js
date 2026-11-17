// Learning from a video: the panel takes frames (at scene changes) and the speech of a screen
// recording or tutorial; a model that can see images turns them into a skill — the steps JARVIS
// repeats later with the computer agent (or the phone agent). Paying / confirming an order is
// never part of what JARVIS does on its own: the skill always stops there and asks the user.
'use strict';

const SYSTEM = `You watch a screen recording / tutorial (given as frames in time order plus the narration) and write a reusable skill that lets an assistant repeat the same job later by itself, on a computer or a phone, by looking at the screen and clicking/typing.
Write steps a careful person could follow on a fresh screen: which app or website, what to search or click (by the button's text or icon, not by pixel position), what to type, and what to check before going on.
Find the parts that change each time (e.g. the product, the address, the amount, the recipient) and make them inputs.
SAFETY (always): the final payment, order confirmation, sending money or anything irreversible is NEVER done by the assistant: the steps stop at that page, show the user the item, total and recipient, and wait for the user to approve or do it. Never write down passwords, card numbers, codes or personal data seen in the video — refer to them as "the user enters …".
Answer with ONLY JSON:
{"name": "<short-kebab-case english>", "description": "<one sentence: what it does and when to use it, in the user's language>", "when": "<the phrase the user would say to start it, user's language>", "target": "computer|phone", "app": "<app or website>", "inputs": ["<thing asked each time>", ...], "steps": ["<step>", ...], "checks": ["<how to know it worked>"], "stopsForUser": ["<the step where the user must approve / pay>"]}`;

const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// the message for the model: narration + every frame with its time
function content({ frames = [], transcript = '', note = '', target = '' }) {
  const intro = `Narration (speech recognition, may contain mistakes): ${transcript.trim() ? transcript.trim().slice(0, 12000) : '(no speech)'}
${note.trim() ? 'What the user says the video teaches: ' + note.trim().slice(0, 2000) + '\n' : ''}${target ? 'It will be repeated on the user\'s ' + (target === 'phone' ? 'Android phone' : 'Windows computer') + '.\n' : ''}Frames in time order (${frames.length}):`;
  return [{ type: 'text', text: intro }, ...frames.flatMap((f, i) => [{ type: 'text', text: `Frame ${i + 1} at ${mmss(+f.t || 0)}:` }, { type: 'image', data: f.data, mime: 'image/jpeg' }])];
}
function toSkill(text, target) {
  const t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('از ویدیو قدمی بیرون نیامد؛ دوباره امتحان کنید یا توضیح کوتاهی بنویسید');
  const j = JSON.parse(t.slice(a, b + 1));
  const steps = (Array.isArray(j.steps) ? j.steps : []).map(x => String(x).trim()).filter(Boolean).slice(0, 40);
  if (!steps.length) throw new Error('از ویدیو قدمی بیرون نیامد');
  const name = String(j.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'video-skill-' + Date.now().toString(36);
  const where = (j.target || target) === 'phone' ? 'phone' : 'computer';
  const list = (arr, f = x => `- ${x}`) => (Array.isArray(arr) ? arr : []).map(x => String(x).trim()).filter(Boolean).map(f).join('\n');
  const stops = list(j.stopsForUser);
  const body = `## When
${String(j.when || j.description || name).trim()}

## Where
${where === 'phone' ? 'The user\'s Android phone (phone_do)' : 'This Windows computer (pc_do)'}${j.app ? ` — ${String(j.app).trim()}` : ''}

${list(j.inputs) ? `## Inputs (ask the user if not given)\n${list(j.inputs)}\n\n` : ''}## Steps
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${list(j.checks) ? `\n## Check\n${list(j.checks)}\n` : ''}
## Safety
- STOP before paying, confirming an order, sending money or anything irreversible: show the user the item, total and recipient, and let them approve or do it themselves.${stops ? '\n' + stops : ''}
- Never type passwords, card numbers or verification codes — the user enters them.
`;
  return { name, description: String(j.description || '').slice(0, 600) || `Learned from a video: ${name}`, body, target: where };
}

module.exports = { SYSTEM, content, toSkill, mmss };
