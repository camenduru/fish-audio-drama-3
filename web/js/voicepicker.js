// voicepicker.js — the single voice-library browser.
//
// Every place in the app that can hold a `reference_id` opens THIS, so the
// browse + preview + search behaviour is identical in the Studio, in Scenes and
// on the Lip Sync page. Pass a callback to receive the pick; with no callback
// it falls back to the Studio's own voice slot.
//
// Search is server-side. Filtering only the loaded page looks like it works but
// cannot find anything outside the first 100 by task_count — typing "happy"
// would miss "Happy Girl" entirely.

import { el, toast, modal, close, fish, debounce } from './api.js';
import * as A from './audio.js';

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

  let all = [];             // the voices currently on screen
  let query = '';           // what the user typed
  let fromServer = false;   // `all` came from a title search, so don't re-filter
  let token = 0;            // guards out-of-order responses

  const paint = () => {
    const needle = query.trim().toLowerCase();
    // While typing we filter what we have for instant feedback; once the server
    // answers, its results ARE the matches and re-filtering would drop them.
    const items = (needle && !fromServer) ? all.filter(m => haystack(m).includes(needle)) : all;

    if (!all.length && !needle) count.textContent = '';
    else if (needle) count.textContent = `${items.length} match${items.length === 1 ? '' : 'es'} for “${query.trim()}”`;
    else count.textContent = `${items.length} voices · ▶ to preview, click to use`;

    if (!items.length) {
      gridBox.replaceChildren(el('div.hint', {}, needle
        ? `Nothing matches “${query.trim()}”.`
        : 'No public voices returned. Use a reference clip instead.'));
      return;
    }

    const grid = el('div.grid.c3');
    for (const m of items) {
      const id = m._id || m.id;
      const sample = (m.samples || [])[0];
      const key = 'pick:' + id;
      const play = el('button.btn.sm.icon.play-btn', { title: 'Play sample' }, '▶');
      if (!sample?.audio) { play.disabled = true; play.title = 'No sample'; }
      play.addEventListener('click', e => {
        e.stopPropagation();
        A.playPreview(sample.audio, key, p => { play.textContent = p ? '⏸' : '▶'; });
      });

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
      grid.append(tile);
    }
    gridBox.replaceChildren(grid);
  };

  const runSearch = debounce(async () => {
    const q = query.trim();
    if (q.length < 2) { fromServer = false; return; }
    const my = ++token;
    const note = el('div.hint', {}, `Searching the library for “${q}”…`);
    gridBox.replaceChildren(note);
    try {
      const data = await fish.get('model', { title: q, page_size: 60 });
      if (my !== token) return;                    // a newer search won
      all = data.items || data.models || [];
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
    const data = await fish.get('model', { page_size: 100, sort_by: 'task_count' });
    all = data.items || data.models || [];
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
