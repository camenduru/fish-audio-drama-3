// convo.js — conversation-script parsing for the Lip Sync two-hander.
//
// Kept free of DOM and app state so it can be unit-tested directly:
//
//   await page.evaluate(async () => (await import('/js/convo.js'))
//     .parseConversation('Avatar1: hi'))
//
// The format is deliberately the same `Speaker: line` shape the Scenes tab
// uses, so a scene script can be pasted straight in.

/**
 * One turn per line, `Speaker: text`.
 *
 * The speaker must start with a letter, so a leading Drama 3 tag such as
 * `[pause:1s]` is never mistaken for a name. Blank lines and `//` / `#`
 * comments are skipped. A line with no speaker prefix is kept as a turn with
 * `speaker: null`.
 *
 * @returns {{speaker: string|null, text: string}[]}
 */
export function parseConversation(text) {
  const turns = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z][\w .'-]{0,23}):\s*(.+)$/);
    if (m) turns.push({ speaker: m[1].trim(), text: m[2].trim() });
    else turns.push({ speaker: null, text: line });
  }
  return turns;
}

/**
 * Map a speaker name onto one of `actors` ([{ key, label }]).
 *
 * `Avatar1` / `A1` / `1` always mean the first actor (and `2` the second), so
 * the default two-hander needs no configuration. Any other name — `Mom`,
 * `Kid`, `Guard` — is assigned in order of first appearance, the way the
 * Scenes tab does it. An unnamed turn goes to whichever actor is next.
 *
 * @param {{key: string, label?: string}[]} actors
 * @returns {(name: string|null) => object|null}
 */
export function makeSpeakerResolver(actors) {
  const list = Array.isArray(actors) ? actors : [];
  const named = new Map();
  let next = 0;
  const byKey = k => list.find(a => a.key === k);

  return (name) => {
    if (!list.length) return null;
    if (!name) return list[Math.min(next, list.length - 1)];

    const key = String(name).toLowerCase().replace(/[\s_-]+/g, '');
    // `1`, `A1`, `Avatar1` — and the same for 2 — always mean that actor.
    const explicit = key.match(/^(?:avatar|a)?([12])$/);
    if (explicit) return byKey('a' + explicit[1]) || list[0];

    if (!named.has(key)) {
      named.set(key, list[next % list.length]);
      next++;
    }
    return named.get(key);
  };
}
