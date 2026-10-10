// drama3.js — the Drama 3 grammar: tags, highlighting, auto-tag, scene parsing
//
// Grammar (per the official Drama 3 Voice Guide):
//   [natural language direction]        performance direction, may repeat mid-line
//   [pause] [laugh] [sigh] [breath]     sound / timing tags
//   <whisper>…</whisper>                scoped, paired tags (whisper, emphasis,
//   <emphasis> <faster> <slower>        faster, slower, forceful)
//   <forceful>
//   <|phoneme_start|>R EH1 D<|phoneme_end|>   IPA phonemes for one span
//   <|speaker:0|>                       multi-speaker dialogue turns

import { esc } from './api.js';

export const SOUND_TAGS = ['pause', 'laugh', 'sigh', 'breath'];

export const PAIRED_TAGS = [
  { tag: 'whisper',  label: 'whisper',  hint: 'only these words whispered' },
  { tag: 'emphasis', label: 'emphasis', hint: 'extra weight on the span' },
  { tag: 'faster',   label: 'faster',   hint: 'speed up this span' },
  { tag: 'slower',   label: 'slower',   hint: 'slow this span down' },
  { tag: 'forceful', label: 'forceful', hint: 'commanding delivery' },
];

export const DIRECTION_PRESETS = [
  'barely holding it together', 'cheerful, clearly lying',
  'exhausted, whispering to a friend in the dark', 'calm', 'trembling, panicked',
  'bored, monotone', 'suddenly thrilled', 'confident', 'quietly, losing confidence',
  'warm and relaxed, like talking to an old friend', 'defensive, slightly uneasy tone',
  'skeptical, questioning tone', 'suspiciously calm', 'way too fast',
  'excited, leaning in', 'laughing', 'shocked, voice dropping to a whisper',
  'pause before it, deadpan', 'genuinely excited', 'tired but proud, end of a long day',
];

export const PHONEME_LANGS = ['English', 'Chinese', 'Japanese', 'Korean', 'Spanish'];

// ---------------------------------------------------------------------------
// Tokenizer → highlight HTML
// ---------------------------------------------------------------------------
const RE_SPEAKER = /^<\|\s*speaker\s*:\s*(\d+)\s*\|>/i;
const RE_PHONEME = /^<\|\s*(phoneme_start|phoneme_end)\s*\|>/i;
const RE_PAIRED_OPEN = /^<(whisper|emphasis|faster|slower|forceful)>/i;
const RE_PAIRED_CLOSE = /^<\/(whisper|emphasis|faster|slower|forceful)>/i;
const RE_DIRECTION = /^\[([^\]\n]*)\]/;

/** Render the script to highlighted HTML (safe: everything is escaped). */
export function highlight(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const rest = text.slice(i);
    let m;
    if ((m = rest.match(RE_SPEAKER))) {
      out += `<span class="tok-speaker">${esc(m[0])}</span>`; i += m[0].length; continue;
    }
    if ((m = rest.match(RE_PHONEME))) {
      out += `<span class="tok-phoneme">${esc(m[0])}</span>`; i += m[0].length; continue;
    }
    if ((m = rest.match(RE_PAIRED_OPEN)) || (m = rest.match(RE_PAIRED_CLOSE))) {
      out += `<span class="tok-tag">${esc(m[0])}</span>`; i += m[0].length; continue;
    }
    if ((m = rest.match(RE_DIRECTION))) {
      const body = m[1];
      const cls = SOUND_TAGS.includes(body.trim().toLowerCase()) ? 'tok-tag' : 'tok-dir';
      out += `<span class="${cls}">${esc(m[0])}</span>`; i += m[0].length; continue;
    }
    // line-leading "Name:" label
    if (i === 0 || text[i - 1] === '\n') {
      const lm = rest.match(/^([A-Za-z][A-Za-z0-9 _'’-]{0,30}):(?=\s)/);
      if (lm) { out += `<span class="tok-name">${esc(lm[0])}</span>`; i += lm[0].length; continue; }
    }
    out += esc(text[i]); i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
export function analyse(text) {
  const dirs = (text.match(/\[[^\]\n]*\]/g) || []);
  const sounds = dirs.filter(d => SOUND_TAGS.includes(d.slice(1, -1).trim().toLowerCase())).length;
  const paired = (text.match(/<\/?(whisper|emphasis|faster|slower|forceful)>/gi) || []).length;
  const phonemes = (text.match(/<\|\s*phoneme_start\s*\|>/gi) || []).length;
  const speakers = new Set((text.match(/<\|\s*speaker\s*:\s*(\d+)\s*\|>/gi) || [])
    .map(s => s.replace(/\D/g, '')));
  return {
    chars: text.length,
    words: (text.trim().match(/\S+/g) || []).length,
    directions: dirs.length - sounds,
    sounds, paired, phonemes, speakers: speakers.size,
  };
}

/** Quick sanity warnings for the script. */
export function lint(text) {
  const issues = [];
  const open = (text.match(/<whisper>|<emphasis>|<faster>|<slower>|<forceful>/gi) || []);
  const close = (text.match(/<\/whisper>|<\/emphasis>|<\/faster>|<\/slower>|<\/forceful>/gi) || []);
  if (open.length !== close.length) issues.push(`${open.length} opening vs ${close.length} closing paired tags — unbalanced.`);
  const ps = (text.match(/<\|\s*phoneme_start\s*\|>/gi) || []).length;
  const pe = (text.match(/<\|\s*phoneme_end\s*\|>/gi) || []).length;
  if (ps !== pe) issues.push(`${ps} phoneme_start vs ${pe} phoneme_end — unbalanced.`);
  const sq = (text.match(/\[/g) || []).length, eq = (text.match(/\]/g) || []).length;
  if (sq !== eq) issues.push(`${sq} "[" vs ${eq} "]" — unbalanced brackets.`);
  return issues;
}

// ---------------------------------------------------------------------------
// Auto Tag — turn a plain script into a directed one
// ---------------------------------------------------------------------------
const STYLES = {
  drama:     { q: 'skeptical, questioning tone', ex: 'urgent, raised voice', soft: 'quietly, holding back', neut: 'measured, serious' },
  comedy:    { q: 'mock-confused', ex: 'suddenly thrilled', soft: 'under his breath', neut: 'deadpan' },
  podcast:   { q: 'curious, leaning in', ex: 'excited, leaning in', soft: 'lowering her voice', neut: 'warm and conversational' },
  audiobook: { q: 'gently questioning', ex: 'with sudden intensity', soft: 'softly, almost to himself', neut: 'calm narration' },
  ad:        { q: 'intrigued', ex: 'genuinely excited', soft: 'conspiratorial whisper', neut: 'bright and confident' },
};

const KEYWORD_TONE = [
  [/\b(asleep|home|nothing|didn'?t|wasn'?t)\b/i, 'defensive, slightly uneasy tone'],
  [/\b(secret|timing|listen)\b/i, 'conspiratorial, quiet'],
  [/\b(sorry|fine|okay|alright)\b/i, 'trying to stay calm'],
  [/\b(wait|stop|no)\b/i, 'suddenly alarmed'],
  [/\b(dog|cake|pizza|again)\b/i, 'light, teasing'],
];

/** Auto Tag one line of dialogue/ narration. */
function autoTagLine(line, style, opts) {
  const s = STYLES[style] || STYLES.drama;
  const trimmed = line.trim();
  if (!trimmed) return line;
  // leave lines that already carry a direction at the start untouched
  if (/^\s*\[/.test(line)) return line;

  let tone = null;
  for (const [re, t] of KEYWORD_TONE) { if (re.test(trimmed)) { tone = t; break; } }
  if (!tone) {
    if (/\?\s*$/.test(trimmed)) tone = s.q;
    else if (/!\s*$/.test(trimmed)) tone = s.ex;
    else if (trimmed.length < 24) tone = s.soft;
    else tone = s.neut;
  }

  let body = trimmed;
  // a beat before a punchline-ish short trailing clause
  if (opts.pauses) {
    body = body.replace(/\s*(—|--|\.\.\.)\s*/g, ' [pause] ');
    if (!/\[pause\]/.test(body) && /\b(yeah|well|so|okay|right)\b[,.]?\s*$/i.test(body)) {
      body = body.replace(/\s*$/, ' [pause]');
    }
    if (/\b(breath|sigh)\b/i.test(body)) body = body.replace(/\bbreath\b/i, '[breath]');
  }
  // emphasise the punchiest word of a short, punchy line
  const words = body.split(/\s+/);
  if (opts.pauses && words.length <= 8) {
    const strong = words.find(w => /^[A-Z]{2,}/.test(w)) || null;
    if (strong && !strong.includes('<')) body = body.replace(strong, `<emphasis>${strong}</emphasis>`);
  }
  return `[${tone}] ${body}`;
}

export function autoTag(text, style = 'drama', opts = { pauses: true }) {
  const lines = text.split('\n');
  return lines.map(line => {
    const m = line.match(/^(\s*)([A-Za-z][A-Za-z0-9 _'’-]{0,30}):(\s*)(.*)$/);
    if (m) {
      const [, indent, name, , rest] = m;
      return `${indent}${name}: ${autoTagLine(rest, style, opts)}`;
    }
    if (/^\s*<\|speaker/.test(line)) return line;
    return autoTagLine(line, style, opts);
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Scene handling — "Name: line" ⇄ <|speaker:N|>
// ---------------------------------------------------------------------------
export function parseScene(script) {
  const speakers = [];
  const idx = new Map();
  const turns = [];
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9 _'’-]{0,30}):\s*(.*)$/);
    if (!m) {
      if (turns.length) turns[turns.length - 1].text += ' ' + line;
      continue;
    }
    const [, name, text] = m;
    if (!idx.has(name)) { idx.set(name, speakers.length); speakers.push({ name, lines: [] }); }
    speakers[idx.get(name)].lines.push(text);
    turns.push({ name, text });
  }
  return { speakers, turns };
}

export function turnsToTokens(turns, order) {
  const idx = new Map(order.map((s, i) => [s.name, i]));
  return turns.map(t => `<|speaker:${idx.get(t.name) ?? 0}|>${t.text}`).join('');
}

export const SCENE_EXAMPLES = {
  'Comedy skit': `Mom: [suspiciously calm] Who ate the last slice of cake?
Kid: [way too fast] Maybe the dog. Dogs love cake.
Mom: [pause] We don't have a dog.`,
  'Crime drama': `Detective: You were there that night.
Suspect: [defensive, slightly uneasy tone] I was home. [pause] Asleep.
Detective: [skeptical, questioning tone] Then why is your coat still wet?`,
  'Podcast intro': `Host A: [excited, leaning in] Okay, I have to tell you what happened at the airport.
Host B: [laughing] Oh no. Not again.`,
};
