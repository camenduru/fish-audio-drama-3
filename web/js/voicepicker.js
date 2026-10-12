// voicepicker.js — the single voice-library browser.
//
// Every place in the app that can hold a `reference_id` opens THIS, so the
// browse + preview + search behaviour is identical in the Studio, in Scenes and
// on the Lip Sync page and in an agent's config.
//
// Your own voices come first. The library listing is `GET /model`, which does
// not contain your private models — so a voice you just created was missing from
// every picker in the app. It is fetched separately (`self=true`) and shown in
// its own group above the public list, which is also why the search queries both.
//
// Search is server-side. Filtering only the loaded page looks like it works but
// cannot find anything outside the first 100 by task_count — typing "happy"
// would miss "Happy Girl" entirely.

import { el, toast, modal, close, fish, debounce } from './api.js';
import * as A from './audio.js';
import { attachVoicePreview } from './voicepreview.js';

/**
 * Open the voice library.
 *
 * @param {(id: string, title: string, model: object) => void} [onPick]
 * @param {{title?: string, hint?: string, current?: string}} [opts]
 */
export async function openVoicePicker(onPick, opts = {}) {
  const pick = typeof onPick === 'function' ? onPick : () => {};
  const title = opts.title || 'Voice library';

  const search = el('input.input', {
    placeholder: 'Search the whole library — name, description, language…',
    style: 'max-width:420px;flex:1',
  });
  const count = el('span.hint', {}, '');
  const gridBox = el('div', {}, el('div.hint', {}, 'Loading voice library…'));

  const body = el('div', {}, [
    opts.hint ? el('div.hint.mb', {}, opts.hint) : null,
    el('div.flex.aic.gap.mb', {}, [search, count]),
    gridBox,
  ]);
  modal({ title, body, wide: true });
  search.focus();

  let all = [];             // the voices currently on screen, own ones first
  let mineIds = new Set();  // which of them are this account's own models
  let query = '';           // what the user typed
  let fromServer = false;   // `all` came from a title search, so don't re-filter
  let token = 0;            // guards out-of-order responses

  const groupHead = (label, note, spaced) => el('div.flex.aic.gap', {
    style: `gap:8px;margin:${spaced ? '20px' : '2px'} 0 10px`,
  }, [
    el('b', { style: 'font-size:12.5px;letter-spacing:.02em' }, label),
    note ? el('span.hint', {}, note) : null,
  ]);

  const tileFor = m => {
    const id = m._id || m.id;
    const sample = (m.samples || [])[0];
    const key = 'pick:' + id;
    const play = el('button.btn.sm.icon.play-btn', { title: 'Play sample' }, '▶');
    // A voice of yours has no `samples[]`, so this used to render a dead button
    // tooltipped "No sample" — in the one list that exists to let you pick a
    // voice. The shared helper synthesizes a line instead; see voicepreview.js.
    attachVoicePreview(play, m, key);

    const tile = el('div.tile', {
      onclick: () => {
        A.stopPreview();
        pick(id, m.title || id, m);
        close();
        toast('Voice set: ' + (m.title || id), 'ok');
      },
    }, [
      el('div.flex.aic.gap', {}, [
        el('div.grow', {}, [el('h4.truncate', {}, m.title || id)]),
        play,
      ]),
      el('p', { style: 'margin-top:6px' },
        (m.description || (m.languages || []).join(', ') || 'Fish Audio voice model').slice(0, 90)),
      sample?.text ? el('div.sample-text', {}, '“' + sample.text.slice(0, 90) + '”') : null,
      el('div.badge.mt', { style: 'margin-top:8px' }, id),
    ]);
    if (opts.current && opts.current === id) tile.style.borderColor = 'var(--accent)';
    return tile;
  };

  const gridOf = items => {
    const grid = el('div.grid.c3');
    for (const m of items) grid.append(tileFor(m));
    return grid;
  };

  const paint = () => {
    const needle = query.trim().toLowerCase();
    // While typing we filter what we have for instant feedback; once the server
    // answers, its results ARE the matches and re-filtering would drop them.
    const items = (needle && !fromServer) ? all.filter(m => haystack(m).includes(needle)) : all;
    const mine = items.filter(m => mineIds.has(m._id || m.id));
    const rest = items.filter(m => !mineIds.has(m._id || m.id));

    if (!all.length && !needle) count.textContent = '';
    else if (needle) count.textContent = `${items.length} match${items.length === 1 ? '' : 'es'} for “${query.trim()}”`;
    else count.textContent = `${items.length} voices${mine.length ? ` · ${mine.length} yours` : ''} · ▶ to preview, click to use`;

    if (!items.length) {
      gridBox.replaceChildren(el('div.hint', {}, needle
        ? `Nothing matches “${query.trim()}”.`
        : 'No public voices returned. Use a reference clip instead.'));
      return;
    }

    const out = [];
    // Own voices first — this is the group that used to be missing entirely.
    if (mine.length) out.push(groupHead('🎙 My Voices', `${mine.length} you created`, false), gridOf(mine));
    if (rest.length) {
      out.push(groupHead(mine.length ? '🌐 Voice library' : 'Voice library',
        mine.length ? `${rest.length} public` : '', mine.length > 0), gridOf(rest));
    }
    gridBox.replaceChildren(...out);
  };

  /** Own voices first, and never twice: a voice of yours that is also published
   *  stays under My Voices instead of appearing in both groups. */
  const adopt = (own, pub) => {
    const ownItems = own || [];
    for (const m of ownItems) mineIds.add(m._id || m.id);
    const pubItems = (pub || []).filter(m => !mineIds.has(m._id || m.id));
    return [...ownItems, ...pubItems];
  };

  const runSearch = debounce(async () => {
    const q = query.trim();
    if (q.length < 2) { fromServer = false; return; }
    const my = ++token;
    const note = el('div.hint', {}, `Searching the library for “${q}”…`);
    gridBox.replaceChildren(note);
    try {
      // Both halves: `title=` alone is the public library and would not find a
      // voice you created. A failed own-voices fetch degrades to public only.
      const [own, pub] = await Promise.all([
        fish.get('model', { self: 'true', title: q, page_size: 60 }).catch(() => null),
        fish.get('model', { title: q, page_size: 60 }),
      ]);
      if (my !== token) return;                    // a newer search won
      all = adopt(own?.items || own?.models, pub.items || pub.models || []);
      fromServer = true;
      paint();
    } catch (e) {
      if (my !== token) return;
      gridBox.replaceChildren(el('div.hint', {}, 'Search failed: ' + e.message));
    }
  }, 350);

  search.addEventListener('input', () => {
    query = search.value;
    if (!query.trim()) { fromServer = false; token++; paint(); return; }
    paint();          // instant feedback over what we already have
    runSearch();      // then the authoritative server search
  });

  try {
    const [own, pub] = await Promise.all([
      fish.get('model', { self: 'true', page_size: 100 }).catch(() => null),
      fish.get('model', { page_size: 100, sort_by: 'task_count' }),
    ]);
    all = adopt(own?.items || own?.models, pub.items || pub.models || []);
    fromServer = false;
    paint();
  } catch (e) {
    gridBox.replaceChildren(el('div.hint', {}, 'Could not load voices: ' + e.message));
  }
}

function haystack(m) {
  return [
    m.title, m.description, (m.languages || []).join(' '),
    (m.tags || []).join(' '), m._id || m.id,
  ].filter(Boolean).join(' ').toLowerCase();
}
