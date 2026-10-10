// studio.js — the Drama 3 studio: editor, tags, generation, player, takes, inpainting

import { $, el, toast, modal, close, apiFetch, fish, downloadBlob, esc, debounce } from './api.js';
import * as D3 from './drama3.js';
import * as A from './audio.js';
import * as L from './library.js';
import { openVoicePicker as openVoicePickerShared } from './voicepicker.js';
import { openTagPicker, attachTagButton } from './tags.js';

export const state = {
  model: 'drama-3-preview',
  voiceId: '',
  voiceName: '',
  refFile: null,
  refText: '',
  takes: [],
  current: null,
  streaming: false,
  timestamps: null,
  pron: [],
};

let editor, hl, playerEl;

// ---------------------------------------------------------------------------
// Editor plumbing
// ---------------------------------------------------------------------------
function syncHighlight() {
  hl.innerHTML = D3.highlight(editor.value) + '\n';
  hl.scrollTop = editor.scrollTop;
  hl.scrollLeft = editor.scrollLeft;
  const a = D3.analyse(editor.value);
  $('#statChars').textContent = `${a.chars} chars`;
  $('#statWords').textContent = `${a.words} words`;
  $('#statDir').textContent = `${a.directions} directions`;
  $('#statTag').textContent = `${a.sounds + a.paired} tags`;
}

function insert(text, { wrap = false } = {}) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  if (wrap) {
    const sel = editor.value.slice(s, e) || 'text';
    editor.setRangeText(text.open + sel + text.close, s, e, 'end');
    editor.setSelectionRange(s + text.open.length, s + text.open.length + sel.length);
  } else {
    const pre = s > 0 && editor.value[s - 1] !== ' ' && editor.value[s - 1] !== '\n' ? ' ' : '';
    editor.setRangeText(pre + text + ' ', s, e, 'end');
  }
  editor.focus();
  syncHighlight();
}

export function getScript() { return editor.value; }
export function setScript(v) { editor.value = v; syncHighlight(); }
export function setVoice(id, name) {
  state.voiceId = id || '';
  $('#voiceId').value = state.voiceId;
  state.voiceName = name || '';
  $('#voicePreview').textContent = name ? `Using “${name}”` : (id ? 'Custom reference id' : 'No voice — pick one in Voices.');
}

// ---------------------------------------------------------------------------
// Tag bar
// ---------------------------------------------------------------------------
function buildTagbar() {
  const bar = $('#tagbar');
  const frag = [];
  frag.push(el('button.btn.primary.sm', { id: 'genBtn', onclick: generate }, ['▶ Generate']));
  frag.push(el('button.btn.sm', { id: 'fixBtn', onclick: openInpaint, title: 'Select a span in the script, then fix just that moment' }, ['✂ Fix a moment']));
  frag.push(el('button.btn.sm', { id: 'autoBtn', onclick: runAutotag }, ['✨ Auto Tag']));
  // The library button goes first among the tag chips: the chips below are the
  // bare primitives, this is the shelf of ready-made combinations built from
  // them. It inserts through the editor's own insert(), so the caret, the
  // spacing and the highlight all behave exactly as the chips do.
  frag.push(el('button.btn.sm', {
    id: 'tagLibBtn',
    title: 'Browse ready-made complex tags — directions, sound tags and scoped spans in one line',
    onclick: () => openTagPicker({
      target: editor,
      onInsert: (text, wrap) => (wrap
        ? insert({ open: wrap.open, close: wrap.close }, { wrap: true })
        : insert(text)),
    }),
  }, ['🏷 Complex tags']));
  frag.push(el('span.sep'));

  for (const d of ['calm', 'excited', 'sad', 'angry', 'whisper-like', 'nervous']) {
    frag.push(el('span.tag-chip.d', { title: 'Direction — describe the performance', onclick: () => insert(`[${d}]`) }, `[${d}]`));
  }
  frag.push(el('span.sep'));
  for (const s of D3.SOUND_TAGS) {
    frag.push(el('span.tag-chip', { title: 'Sound / timing tag', onclick: () => insert(`[${s}]`) }, `[${s}]`));
  }
  frag.push(el('span.sep'));
  for (const p of D3.PAIRED_TAGS) {
    frag.push(el('span.tag-chip.p', { title: p.hint + ' (wraps the selection)', onclick: () => insert({ open: `<${p.tag}>`, close: `</${p.tag}>` }, { wrap: true }) }, `<${p.tag}>`));
  }
  frag.push(el('span.sep'));
  frag.push(el('span.tag-chip', { title: 'Wrap selection as IPA phonemes', onclick: () => insert({ open: '<|phoneme_start|>', close: '<|phoneme_end|>' }, { wrap: true }) }, '<|phoneme|>'));
  frag.push(el('span.tag-chip', { title: 'Next speaker turn', onclick: () => insert('<|speaker:0|>') }, '<|speaker:N|>'));
  bar.replaceChildren(...frag);
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------
function buildPayload(text, over = {}) {
  const p = {
    text,
    temperature: +$('#temperature').value,
    top_p: +$('#topP').value,
    repetition_penalty: +$('#repetition').value,
    chunk_length: +$('#chunkLength').value,
    max_new_tokens: +$('#maxTokens').value,
    normalize: $('#normalizeText').checked,
    format: $('#format').value,
    latency: $('#latency').value,
    condition_on_previous_chunks: $('#condPrev').checked,
    prosody: {
      speed: +$('#speed').value,
      volume: +$('#volume').value,
      normalize_loudness: $('#normalizeLoud').checked,
    },
  };
  if ($('#sampleRate').value) p.sample_rate = +$('#sampleRate').value;
  if (p.format === 'mp3') p.mp3_bitrate = +$('#mp3Bitrate').value;
  if ($('#qualityGuard').checked) p.features = ['quality-guard'];
  const dict = state.pron.filter(x => x.key && x.value);
  if (dict.length) p.pronunciation_dictionary = [{ items: dict.map(x => ({ key: x.key, value: x.value, case_sensitive: !!x.cs })) }];
  if (state.voiceId && !over.references) p.reference_id = over.multiRef || state.voiceId;
  return { ...p, ...over };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
async function generate() {
  const text = editor.value.trim();
  if (!text) { toast('Write a line first.', 'err'); return; }
  const issues = D3.lint(text);
  if (issues.length) toast(issues[0], 'err');

  const btn = $('#genBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating…';
  const t0 = performance.now();
  try {
    let blob, meta = {};
    const model = $('#ttsModel').value;
    state.model = model;
    if ($('#streamTimestamps').checked) {
      ({ blob, meta } = await streamGenerate(text, model));
    } else if (state.refFile) {
      const fd = new FormData();
      const payload = buildPayload(text, { __model: model });
      delete payload.reference_id;
      fd.append('payload', JSON.stringify(payload));
      fd.append('ref_files', state.refFile);
      fd.append('ref_texts', JSON.stringify([state.refText || '']));
      fd.append('speakers', JSON.stringify([0]));
      blob = await apiFetch('/api/tts/with-references', { method: 'POST', body: fd });
    } else {
      const payload = buildPayload(text, { __model: model });
      blob = await apiFetch('/api/tts', { method: 'POST', body: payload });
    }
    if (blob.type && blob.type.includes('json')) {
      const err = JSON.parse(await blob.text());
      throw new Error(err.message || 'TTS failed');
    }
    const ms = Math.round(performance.now() - t0);
    addTake(blob, text, model, ms, meta);
    toast(`Take ready · ${ms} ms`, 'ok');
  } catch (err) {
    toast('Generate failed: ' + err.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '▶ Generate';
  }
}

async function streamGenerate(text, model) {
  const payload = buildPayload(text, { __model: model });
  const res = await apiFetch('/api/tts/stream', { method: 'POST', body: payload, raw: true });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const parts = [];
  let alignment = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith(':') || t.startsWith('event:')) continue;
      // Upstream frames are SSE (`data: {...}`); our own error frames are bare JSON.
      const body = t.startsWith('data:') ? t.slice(5).trim() : t;
      if (!body || body === '[DONE]') continue;
      let evt; try { evt = JSON.parse(body); } catch { continue; }
      if (evt.type === 'error') throw new Error(evt.body || 'stream error');
      const b64 = evt.audio_base64 || evt.audio || evt.data;
      // Each frame is an INDEPENDENTLY PADDED base64 blob — joining the strings
      // and decoding once throws "excess data after padding" whenever a frame's
      // byte length is not a multiple of 3. Decode per frame, concat the bytes.
      if (b64) parts.push(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      // alignment is CUMULATIVE — each frame repeats the whole growing list.
      const al = evt.alignment || (evt.segments ? { segments: evt.segments } : null);
      if (al?.segments?.length) alignment = al;
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (!total) throw new Error('stream returned no audio');
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  // The first streamed frame carries a placeholder data size, so a streamed WAV
  // claims ~48695s. Browsers cope; anything that reads the header does not.
  A.fixWavHeader(bytes);
  state.timestamps = alignment;
  const fmt = $('#format').value;
  return {
    blob: new Blob([bytes], { type: `audio/${fmt === 'mp3' ? 'mpeg' : fmt}` }),
    meta: { alignment, streamed: true },
  };
}

// ---------------------------------------------------------------------------
// Player + takes
// ---------------------------------------------------------------------------
function addTake(blob, text, model, ms, meta) {
  const take = {
    id: 'take_' + Date.now(),
    name: `Take ${state.takes.length + 1}`,
    blob, url: URL.createObjectURL(blob), text, model, ms,
    meta, created: new Date().toISOString(),
  };
  state.takes.unshift(take);
  // Publish to the session library so the Lip Sync page can bake this line
  // without the user re-typing it.
  take.libId = L.addAudio({
    blob, text, model, ms, meta, source: 'studio', name: take.name,
  }).id;
  renderTakeList();
  playTake(take);
}

export function playTake(take) {
  state.current = take;
  renderPlayer(take);
  renderTakeList();
}

function renderPlayer(take) {
  const fmt = take.blob.type.includes('mpeg') ? 'mp3' : (take.blob.type.split('/')[1] || 'audio');
  const audio = el('audio', { controls: true, src: take.url });
  const wave = el('div.wave');
  const info = el('div.hint', { style: 'margin-top:8px' },
    `${take.model} · ${(take.blob.size / 1024).toFixed(1)} KB · ${take.ms} ms · ${take.text.length} chars`);

  const btns = el('div.flex.gap', {}, [
    el('button.btn.sm', { onclick: () => downloadBlob(take.blob, `drama3-${take.id}.${fmt === 'mpeg' ? 'mp3' : fmt}`) }, '⬇ Download'),
    el('button.btn.sm', { onclick: () => { navigator.clipboard?.writeText(take.text); toast('Script copied'); } }, '⧉ Copy script'),
    el('button.btn.sm', { onclick: () => { setScript(take.text); toast('Loaded into editor'); } }, '↺ Reuse'),
  ]);

  // Word timestamps, when the take came from the streaming path.
  const align = take.meta?.alignment;
  const segs = align?.segments;
  const tsStrip = segs?.length ? el('div.ts-strip', {}, [
    el('div.ts-head', {}, [
      el('span', {}, `⏱ ${segs.length} word timestamps`),
      align.audio_duration ? el('span.hint', {}, `· ${align.audio_duration.toFixed(2)}s audio`) : null,
      el('span.hint', {}, '· click a word to seek'),
    ]),
    el('div.ts-words', {}, segs.map(s => el('span.ts-word', {
      title: `${Number(s.start).toFixed(2)}s – ${Number(s.end).toFixed(2)}s`,
      onclick: () => { audio.currentTime = Number(s.start) || 0; audio.play(); },
    }, s.text))),
  ]) : null;

  playerEl.replaceChildren(
    el('div.player-top', {}, [el('div.grow', {}, [audio]), btns]),
    wave, info, tsStrip,
  );

  // waveform
  A.decode(take.blob).then(buf => {
    const pk = A.peaks(buf, 180);
    A.drawWave(wave, pk, 0);
    audio.addEventListener('timeupdate', () => {
      if (audio.duration) A.drawWave(wave, pk, audio.currentTime / audio.duration);
    });
    take._buffer = buf;
  }).catch(() => { wave.style.display = 'none'; });
}

function renderTakeList() {
  const box = $('#takeList');
  if (!state.takes.length) { box.innerHTML = '<div class="hint">No takes yet.</div>'; return; }
  box.replaceChildren(...state.takes.map(t => el('div.list-item' + (state.current === t ? '.active' : ''), {
    onclick: () => playTake(t),
  }, [
    el('div.avatar', {}, '🎧'),
    el('div.grow', {}, [
      el('div.t', {}, t.name),
      el('div.d.truncate', {}, t.text.slice(0, 46) || '—'),
    ]),
  ])));
}

// ---------------------------------------------------------------------------
// Pronunciation dictionary UI
// ---------------------------------------------------------------------------
function renderPron() {
  const box = $('#pronList');
  if (!state.pron.length) { box.innerHTML = '<div class="hint">No entries.</div>'; return; }
  box.replaceChildren(...state.pron.map((row, i) => el('div.row', { style: 'margin-bottom:6px' }, [
    el('input.input.mono', { value: row.key, placeholder: 'word', style: 'font-size:11.5px', oninput: e => { row.key = e.target.value; } }),
    el('input.input.mono', { value: row.value, placeholder: 'R EH1 D', style: 'font-size:11.5px;max-width:110px', oninput: e => { row.value = e.target.value; } }),
    el('button.btn.sm.ghost', { onclick: () => { state.pron.splice(i, 1); renderPron(); } }, '✕'),
  ])));
}

// ---------------------------------------------------------------------------
// Auto Tag
// ---------------------------------------------------------------------------
function runAutotag() {
  const src = editor.value.trim();
  if (!src) { toast('Nothing to tag.', 'err'); return; }
  const out = D3.autoTag(src, $('#autotagStyle').value, { pauses: $('#autotagPauses').checked });
  setScript(out);
  toast('Auto Tag applied — edit anything that doesn\'t land.', 'ok');
}

// ---------------------------------------------------------------------------
// Voice picker — the shared browser; no callback means "set the Studio voice".
// ---------------------------------------------------------------------------
export function openVoicePicker(onPick) {
  return openVoicePickerShared(
    onPick || ((id, name) => setVoice(id, name)),
    { current: state.voiceId },
  );
}

// ---------------------------------------------------------------------------
// Inpainting — "fix one moment"
// ---------------------------------------------------------------------------
function openInpaint() {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const sel = editor.value.slice(s, e).trim();
  const body = el('div');
  if (!sel) {
    body.append(el('div.hint', {}, 'Select the moment you want to fix in the script, then reopen this. The rest of the take is kept.'));
    modal({ title: '✂ Fix a moment', body, footer: [el('button.btn', { onclick: close }, 'Close')] });
    return;
  }
  const dir = el('input.input', { placeholder: 'shocked, voice dropping to a whisper' });
  const list = el('datalist', { id: 'dirList' }, D3.DIRECTION_PRESETS.map(d => el('option', { value: d })));
  dir.setAttribute('list', 'dirList');
  const hasBase = !!state.current?._buffer;
  body.append(
    el('div.hint.mb', {}, hasBase
      ? 'The selected span is re-rendered with the new direction and spliced back into the current take.'
      : 'No base take loaded — the span is rendered on its own. Generate a full take first to splice.'),
    el('label.field', {}, [el('span', {}, 'Span to fix'), el('div.mono.hint', { style: 'background:var(--bg);padding:9px;border-radius:7px' }, sel)]),
    el('label.field', {}, [el('span', {}, 'New direction'), el('div.flex.aic.gap', {}, [
      dir, attachTagButton(dir, { label: 'the new direction' }),
    ])]),
    list,
    el('div.flex.gap', { style: 'flex-wrap:wrap' },
      ['shocked, voice dropping to a whisper', 'pause before it, deadpan', 'genuinely excited', 'slower, drawing it out'].map(d =>
        el('span.tag-chip.d', { onclick: () => { dir.value = d; } }, d))),
  );
  const run = el('button.btn.primary', { onclick: async () => {
    run.disabled = true; run.innerHTML = '<span class="spinner"></span> Fixing…';
    try { await inpaint(sel, dir.value, s, e); close(); }
    catch (err) { toast('Inpaint failed: ' + err.message, 'err'); }
    finally { run.disabled = false; run.textContent = '✂ Regenerate this span'; }
  } }, '✂ Regenerate this span');
  modal({ title: '✂ Fix a moment', body, footer: [el('button.btn', { onclick: close }, 'Cancel'), run] });
}

async function inpaint(sel, direction, selStart, selEnd) {
  const text = `[${direction}] ${sel}`;
  const payload = buildPayload(text, { __model: $('#ttsModel').value });
  const patchBlob = await apiFetch('/api/tts', { method: 'POST', body: payload });
  if (patchBlob.type.includes('json')) throw new Error((JSON.parse(await patchBlob.text())).message);

  if (state.current?._buffer) {
    const patch = await A.decode(patchBlob);
    // approximate placement: proportional by character offset in the script
    const full = editor.value;
    const startSec = state.current._buffer.duration * (selStart / Math.max(1, full.length));
    const endSec = state.current._buffer.duration * (selEnd / Math.max(1, full.length));
    const merged = A.splice(state.current._buffer, patch, startSec, endSec);
    const wav = A.toWav(merged);
    addTake(wav, `${full.slice(0, selStart)}${text}${full.slice(selEnd)}`, $('#ttsModel').value, 0, { inpainted: true });
    toast('Span re-rendered and spliced.', 'ok');
  } else {
    addTake(patchBlob, text, $('#ttsModel').value, 0, { inpainted: true });
    toast('Span rendered (no base take to splice).', 'ok');
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
export function initStudio() {
  editor = $('#editor');
  hl = $('#editorHL');
  playerEl = $('#player');
  // So the tag picker can name its target instead of quoting the placeholder.
  editor.dataset.tagLabel = 'the script editor';

  buildTagbar();
  editor.addEventListener('input', syncHighlight);
  editor.addEventListener('scroll', () => { hl.scrollTop = editor.scrollTop; hl.scrollLeft = editor.scrollLeft; });
  editor.addEventListener('select', () => {
    const n = editor.selectionEnd - editor.selectionStart;
    $('#statSel').textContent = n ? `${n} selected` : '';
  });
  editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); insert('    '); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
  });

  $('#pickVoice').addEventListener('click', () => openVoicePicker());
  $('#runAutotag').addEventListener('click', runAutotag);
  $('#addPron').addEventListener('click', () => { state.pron.push({ key: '', value: '', cs: false }); renderPron(); });
  $('#insertPhoneme').addEventListener('click', () => {
    const v = $('#phonemeIn').value.trim() || 'R EH1 D';
    insert({ open: '<|phoneme_start|>', close: '<|phoneme_end|>' }, { wrap: true });
  });
  $('#refClip').addEventListener('change', e => {
    state.refFile = e.target.files[0] || null;
    $('#voicePreview').textContent = state.refFile ? `Reference clip: ${state.refFile.name}` : '';
  });
  $('#refClipText').addEventListener('input', e => { state.refText = e.target.value; });

  for (const [id, out] of [['speed', 'speedVal'], ['volume', 'volumeVal'], ['temperature', 'tempVal'], ['topP', 'topPVal'], ['repetition', 'repVal']]) {
    const el0 = $('#' + id), out0 = $('#' + out);
    const fmt = id === 'speed' || id === 'temperature' || id === 'topP' || id === 'repetition' ? (v => (+v).toFixed(2)) : (v => v);
    el0.addEventListener('input', () => { out0.textContent = fmt(el0.value); });
    out0.textContent = fmt(el0.value);
  }

  syncHighlight();
  renderPron();
  renderTakeList();
  playerEl.innerHTML = '<div class="hint">Generated takes appear here with a waveform, download and reuse.</div>';
}

export { generate };
