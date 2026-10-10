// voices.js — Voice Design (generate voices from a prompt) + the voice library

import { $, el, toast, modal, close, apiFetch, fish, b64ToBlob, downloadBlob, debounce } from './api.js';
import * as A from './audio.js';
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
    grid.replaceChildren(...libCache.map(voiceTile));
  } catch (e) {
    grid.innerHTML = `<div class="empty">Could not load library: ${e.message}</div>`;
  }
}

/** One voice card, with a real playable sample from the model's `samples[]`. */
function voiceTile(m) {
  const id = m._id || m.id;
  const sample = (m.samples || [])[0];
  const key = 'voice:' + id;
  const btn = el('button.btn.sm.icon.play-btn', { title: 'Play sample' }, '▶');
  if (!sample?.audio) { btn.disabled = true; btn.title = 'No sample for this voice'; }
  btn.addEventListener('click', e => {
    e.stopPropagation();
    A.playPreview(sample.audio, key, playing => { btn.textContent = playing ? '⏸' : '▶'; });
  });

  const langs = (m.languages || []).slice(0, 3);
  return el('div.tile.voice-tile', {
    onclick: () => {
      setVoice(id, m.title);
      $('#libSelected').textContent = `${m.title || id} → ${id}`;
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
    ]),
    el('div.hint.mono', { style: 'margin-top:8px;font-size:10.5px' }, id.slice(0, 26)),
  ]);
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
      close(); loadLibrary();
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

export function initVoices() {
  $('#vdRun').addEventListener('click', runVoiceDesign);
  buildVdExamples();
  $('#libRefresh').addEventListener('click', () => loadLibrary($('#libSearch').value.trim()));
  $('#libSearch').addEventListener('input', debounce(e => loadLibrary(e.target.value.trim()), 450));
  $('#libUpload').addEventListener('click', openUploadVoice);
  loadLibrary();
}
