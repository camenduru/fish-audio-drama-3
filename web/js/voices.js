// voices.js — Voice Design (generate voices from a prompt) + the voice library

import { $, el, esc, toast, modal, close, apiFetch, fish, b64ToBlob, downloadBlob, debounce, fmtTime } from './api.js';
import { attachVoicePreview, previewLine, setPreviewLine } from './voicepreview.js';
import { setVoice } from './studio.js';

const VD_EXAMPLES = [
  'Warm, confident studio narrator with a natural tone, mid-thirties, calm pace.',
  'Tired night-shift nurse, dry humor, speaks a little too fast.',
  'Anxious young visitor, breathy, hesitant, lots of small pauses.',
  'Cinematic trailer voice — deep, slow, every word placed like a drumbeat.',
  'Bright kids-cartoon squirrel, high energy, cartoonishly cheerful.',
];

// ---------------------------------------------------------------------------
// Voice Design
// ---------------------------------------------------------------------------
async function runVoiceDesign() {
  const instruction = $('#vdInstruction').value.trim();
  if (!instruction) { toast('Describe the voice first.', 'err'); return; }
  const btn = $('#vdRun');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Designing…';
  const body = {
    instruction,
    reference_text: $('#vdRefText').value || undefined,
    language: $('#vdLang').value || undefined,
    n: +$('#vdN').value,
    guidance_scale: +$('#vdGuidance').value,
    num_step: +$('#vdSteps').value,
  };
  const seed = $('#vdSeed').value;
  if (seed) body.seed = +seed;
  try {
    const data = await apiFetch('/api/voice-design', { method: 'POST', body });
    renderCandidates(data.candidates || [], instruction);
    toast(`${(data.candidates || []).length} candidate(s) generated.`, 'ok');
  } catch (e) {
    toast('Voice design failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '✨ Generate voices';
  }
}

function renderCandidates(cands, instruction) {
  const box = $('#vdResults');
  if (!cands.length) { box.innerHTML = '<div class="empty">No candidates returned.</div>'; return; }
  box.replaceChildren(...cands.map(c => {
    const blob = b64ToBlob(c.audio_base64, 'audio/wav');
    const url = URL.createObjectURL(blob);
    return el('div.tile', {}, [
      el('h4', {}, `Candidate ${c.index + 1}`),
      el('p', {}, `${c.language || '—'} · ${(c.duration_ms / 1000).toFixed(2)}s · ${c.sample_rate} Hz`),
      el('audio', { controls: true, src: url, style: 'width:100%;margin-top:10px;height:34px' }),
      el('div.flex.gap', { style: 'margin-top:10px;flex-wrap:wrap' }, [
        el('button.btn.sm', { onclick: () => downloadBlob(blob, `voice-${c.id}.wav`) }, '⬇'),
        el('button.btn.sm', { onclick: () => useAsReference(blob, c, instruction) }, '→ Use in studio'),
        el('button.btn.sm', { onclick: () => openSaveVoice(blob, c, instruction) }, '＋ Save'),
      ]),
    ]);
  }));
}

function useAsReference(blob, cand, instruction) {
  const dt = new DataTransfer();
  dt.items.add(new File([blob], `designed-${cand.id}.wav`, { type: 'audio/wav' }));
  const input = $('#refClip');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  $('#refClipText').value = cand.text || $('#vdRefText').value || '';
  $('#refClipText').dispatchEvent(new Event('input'));
  document.querySelector('[data-view="studio"]').click();
  toast('Loaded as reference clip in the studio.', 'ok');
}

function openSaveVoice(blob, cand, instruction) {
  const title = el('input.input', { value: 'Designed voice ' + (cand.index + 1) });
  const desc = el('input.input', { value: instruction.slice(0, 120) });
  const vis = el('select.select', {}, [el('option', { value: 'private' }, 'private'), el('option', { value: 'unlist' }, 'unlist')]);
  const text = el('input.input', { value: cand.text || $('#vdRefText').value || '' });
  const save = el('button.btn.primary', { onclick: async () => {
    save.disabled = true; save.innerHTML = '<span class="spinner"></span>';
    try {
      const fd = new FormData();
      fd.append('visibility', vis.value);
      fd.append('type', 'tts');
      fd.append('title', title.value);
      fd.append('train_mode', 'fast');
      fd.append('description', desc.value);
      fd.append('voices', new File([blob], 'voice.wav', { type: 'audio/wav' }));
      if (text.value) fd.append('texts', text.value);
      const model = await fish.post('model', fd);
      toast('Saved. Model id: ' + (model._id || model.id), 'ok');
      close();
      // A saved design is a new private /model entry: it belongs on My Voices
      // the moment it exists, not after the next reload.
      loadMyVoices();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
    finally { save.disabled = false; save.textContent = 'Save voice'; }
  } }, 'Save voice');
  modal({
    title: 'Save designed voice',
    body: el('div', {}, [
      el('label.field', {}, [el('span', {}, 'Title'), title]),
      el('label.field', {}, [el('span', {}, 'Description'), desc]),
      el('label.field', {}, [el('span', {}, 'Transcript of the clip'), text]),
      el('label.field', {}, [el('span', {}, 'Visibility'), vis]),
    ]),
    footer: [el('button.btn', { onclick: close }, 'Cancel'), save],
  });
}

function buildVdExamples() {
  const box = $('#vdExamples');
  box.replaceChildren(...VD_EXAMPLES.map(t => el('div.list-item', { onclick: () => { $('#vdInstruction').value = t; } }, [
    el('div.grow', {}, [el('div.d', {}, t)]),
  ])));
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
let libCache = [];

async function loadLibrary(search = '') {
  const grid = $('#libGrid');
  grid.replaceChildren(el('div.hint', {}, 'Loading…'));
  try {
    const q = { page_size: 60, page_number: 1 };
    if (search) q.title = search;
    const data = await fish.get('model', q);
    libCache = data.items || data.models || [];
    if (!libCache.length) { grid.innerHTML = '<div class="empty"><div class="big">🎙</div>No voices found. Upload a reference clip to create one.</div>'; return; }
    grid.replaceChildren(...libCache.map(m => voiceTile(m)));
  } catch (e) {
    grid.innerHTML = `<div class="empty">Could not load library: ${e.message}</div>`;
  }
}

/**
 * One voice card, with a real playable sample from the model's `samples[]`.
 *
 * `opts.mine` marks a card on the My Voices page — it controls the badges, the
 * ⧉ Copy id button and which box the selection is echoed into. It is NOT what
 * decides whether ▶ works: Fish only generates `samples[]` for published
 * voices, so an uploaded one has none, and `attachVoicePreview` synthesizes a
 * line for any voice in that state. That helper is shared with the Voice
 * library and every picker, so a voice you made is auditionable in all of them
 * rather than only here.
 */
function voiceTile(m, opts = {}) {
  const id = m._id || m.id;
  const mine = !!opts.mine;
  const sample = (m.samples || [])[0];
  const key = (mine ? 'myvoice:' : 'voice:') + id;
  const btn = el('button.btn.sm.icon.play-btn', { title: 'Play sample' }, '▶');
  // Shared with the Voice library and every picker, so a voice you uploaded is
  // auditionable everywhere rather than only on this page — see voicepreview.js.
  attachVoicePreview(btn, m, key);

  const langs = (m.languages || []).slice(0, 3);
  return el('div.tile.voice-tile', {
    onclick: () => {
      setVoice(id, m.title);
      const box = $(opts.selected || (mine ? '#mySelected' : '#libSelected'));
      if (box) box.textContent = `${m.title || id} → ${id}`;
      toast('Loaded into studio: ' + (m.title || id), 'ok');
    },
  }, [
    el('div.flex.aic.gap.mb', {}, [
      el('span.avatar', {}, '🎙'),
      el('div.grow', {}, [el('h4.truncate', {}, m.title || id)]),
      btn,
    ]),
    el('p', {}, m.description || langs.join(', ') || 'Fish Audio voice model'),
    sample?.text ? el('div.sample-text', {}, '“' + sample.text.slice(0, 120) + '”') : null,
    el('div.flex.gap', { style: 'margin-top:10px;flex-wrap:wrap;align-items:center' }, [
      ...langs.map(l => el('span.badge', {}, l)),
      m.visibility ? el('span.badge.violet', {}, m.visibility) : null,
      m.task_count ? el('span.badge', {}, (m.task_count / 1000).toFixed(0) + 'k uses') : null,
      mine ? stateBadge(m) : null,
      mine && m.created_at ? el('span.badge', {}, fmtTime(m.created_at)) : null,
    ]),
    mine ? el('div.flex.gap', { style: 'margin-top:8px;flex-wrap:wrap' }, [
      el('button.btn.sm', { title: 'Copy this reference_id', onclick: e => { e.stopPropagation(); copyId(id); } }, '⧉ Copy id'),
    ]) : null,
    el('div.hint.mono', { style: 'margin-top:8px;font-size:10.5px' }, id.slice(0, 26)),
  ]);
}

/** `state` is Fish's own word for a model: trained / training / failed. */
function stateBadge(m) {
  const s = String(m.state || '').toLowerCase();
  if (!s) return null;
  const cls = s === 'trained' ? 'green' : (s === 'failed' ? 'red' : 'amber');
  return el(`span.badge.${cls}`, {}, s);
}

function copyId(id) {
  const done = () => toast('reference_id copied: ' + id, 'ok');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(id).then(done, () => toast('Copy failed — id is ' + id, 'err'));
  } else { toast('reference_id: ' + id, ''); }
}

function openUploadVoice() {
  const title = el('input.input', { placeholder: 'My narrator' });
  const text = el('input.input', { placeholder: 'exact transcript of the clip' });
  const file = el('input.input', { type: 'file', accept: 'audio/*' });
  const desc = el('input.input', { placeholder: 'optional' });
  const vis = el('select.select', {}, [el('option', { value: 'private' }, 'private'), el('option', { value: 'unlist' }, 'unlist')]);
  const up = el('button.btn.primary', { onclick: async () => {
    if (!file.files[0]) { toast('Pick an audio file.', 'err'); return; }
    up.disabled = true; up.innerHTML = '<span class="spinner"></span> Uploading…';
    try {
      const fd = new FormData();
      fd.append('visibility', vis.value); fd.append('type', 'tts');
      fd.append('title', title.value || 'Untitled voice');
      fd.append('train_mode', 'fast'); fd.append('description', desc.value);
      fd.append('voices', file.files[0]);
      if (text.value) fd.append('texts', text.value);
      const m = await fish.post('model', fd);
      toast('Voice created: ' + (m._id || m.id), 'ok');
      close(); loadLibrary(); loadMyVoices();
    } catch (e) { toast('Upload failed: ' + e.message, 'err'); }
    finally { up.disabled = false; up.textContent = 'Create voice'; }
  } }, 'Create voice');
  modal({
    title: '⬆ Upload reference clip',
    body: el('div', {}, [
      el('div.hint.mb', {}, '10–30 seconds of clear speech, minimal background noise. The transcript should match the audio exactly.'),
      el('label.field', {}, [el('span', {}, 'Title'), title]),
      el('label.field', {}, [el('span', {}, 'Audio file'), file]),
      el('label.field', {}, [el('span', {}, 'Transcript'), text]),
      el('label.field', {}, [el('span', {}, 'Description'), desc]),
      el('label.field', {}, [el('span', {}, 'Visibility'), vis]),
    ]),
    footer: [el('button.btn', { onclick: close }, 'Cancel'), up],
  });
}

// ---------------------------------------------------------------------------
// My Voices — the account's own /model entries
//
// `self=true` is the only filter that returns your own models. `author_id=<you>`
// returns nothing, and the unfiltered listing is the public library, which does
// not contain your private uploads at all — so an uploaded voice used to be
// created and then visible nowhere in the app.
// ---------------------------------------------------------------------------
let myCache = [];

/**
 * The empty state — with example voices, because "you have no voices yet" on its
 * own teaches nothing about what a voice is for.
 *
 * The examples come from the public library and keep their real `samples[]`, so
 * ▶ plays a real recording of the voice rather than spending credit. They are
 * rendered outside `#myVoiceGrid` on purpose: that grid means "voices you made".
 * They disappear the moment the account has a voice of its own, and a search that
 * matched nothing gets the message only — a failed search is not an invitation to
 * go browsing.
 */
async function renderMyVoiceExamples(search) {
  const box = $('#myVoiceEmpty');
  box.classList.remove('hidden');
  box.replaceChildren(el('div.empty', {}, [
    el('div.big', {}, '🎙'),
    el('div', {}, search
      ? `Nothing of yours matches “${esc(search)}”.`
      : 'No voices yet. Use ⬆ Upload reference clip to clone one from 10–30s of speech, or save a candidate from the Voice Design page.'),
  ]));
  if (search) return;
  try {
    const data = await fish.get('model', { page_size: 6, sort_by: 'task_count' });
    const items = (data.items || data.models || []).slice(0, 6);
    if (!items.length) return;
    const grid = el('div.grid.c3');
    for (const m of items) grid.append(voiceTile(m, { selected: '#mySelected' }));
    box.append(
      el('div.flex.aic.gap', { style: 'gap:8px;margin:24px 0 10px;justify-content:center;flex-wrap:wrap' }, [
        el('b', { style: 'font-size:12.5px;letter-spacing:.02em' }, '🎧 Example voices'),
        el('span.hint', {}, 'from the public library — ▶ to hear one, click to load it into the studio'),
      ]),
      grid,
    );
  } catch { /* the examples are a nicety; the empty state stands without them */ }
}

async function loadMyVoices(search = '') {
  const grid = $('#myVoiceGrid');
  const empty = $('#myVoiceEmpty');
  // Cleared up front, so a reload cannot show the previous answer's examples
  // underneath a "Loading…" line.
  empty.classList.add('hidden');
  grid.replaceChildren(el('div.hint', {}, 'Loading…'));
  try {
    const q = { self: 'true', page_size: 100 };
    if (search) q.title = search;
    const data = await fish.get('model', q);
    // Newest first: the voice you just created is the one you are looking for,
    // and the API's own ordering is not guaranteed to be by date.
    myCache = (data.items || data.models || []).slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    $('#myCount').textContent = myCache.length ? `${myCache.length} voice${myCache.length === 1 ? '' : 's'}` : 'none yet';
    if (!myCache.length) {
      grid.replaceChildren();
      await renderMyVoiceExamples(search);
      return;
    }
    // Cleared as well as hidden: stale example tiles left in the DOM are how a
    // probe ends up asserting on cards that are not on screen.
    empty.replaceChildren();
    empty.classList.add('hidden');
    grid.replaceChildren(...myCache.map(m => voiceTile(m, { mine: true })));
  } catch (e) {
    $('#myCount').textContent = '';
    empty.classList.add('hidden');
    grid.innerHTML = `<div class="empty">Could not load your voices: ${esc(e.message)}</div>`;
  }
}

export function initMyVoices() {
  $('#myRefresh').addEventListener('click', () => loadMyVoices($('#mySearch').value.trim()));
  $('#mySearch').addEventListener('input', debounce(e => loadMyVoices(e.target.value.trim()), 450));
  $('#myUpload').addEventListener('click', openUploadVoice);

  // The sentence ▶ synthesizes. One setting for the whole app, so it lives here
  // (the page that is about your own voices) and applies to every picker too.
  const line = $('#myPreviewLine');
  if (line) {
    line.value = previewLine();
    line.addEventListener('change', () => {
      const saved = setPreviewLine(line.value);
      line.value = saved;                      // echoes the default back when cleared
      toast('Preview line saved — ▶ will say that.', 'ok');
    });
  }

  loadMyVoices();
}

export function initVoices() {
  $('#vdRun').addEventListener('click', runVoiceDesign);
  buildVdExamples();
  $('#libRefresh').addEventListener('click', () => loadLibrary($('#libSearch').value.trim()));
  $('#libSearch').addEventListener('input', debounce(e => loadLibrary(e.target.value.trim()), 450));
  $('#libUpload').addEventListener('click', openUploadVoice);
  loadLibrary();
}
