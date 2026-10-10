// scenes.js — multi-speaker dialogue: speakers + a "Name: line" script → one scene

import { $, el, toast, modal, close, apiFetch, downloadBlob, fish } from './api.js';
import * as D3 from './drama3.js';
import * as A from './audio.js';
import { openVoicePicker } from './voicepicker.js';
import { openTagPicker, insertIntoField } from './tags.js';

const scene = { speakers: [], lastBlob: null };
let assigning = false;   // guards the voice-library fetch against double-clicks

function speakerCard(sp, i) {
  const voiceInput = el('input.input.mono', {
    value: sp.voiceId || '',
    placeholder: 'voice model id — or browse the library',
    style: 'font-size:11.5px',
    oninput: e => { sp.voiceId = e.target.value; sp.voiceName = ''; },
  });

  return el('div.card.mb', {}, [
    el('div.card-h', {}, [
      el('span.avatar', { style: 'width:26px;height:26px;flex:0 0 26px;font-size:12px' }, String(i + 1)),
      el('input.input', { value: sp.name, placeholder: `Speaker ${i + 1}`, style: 'max-width:180px', oninput: e => { sp.name = e.target.value; } }),
      el('div.grow'),
      el('button.btn.sm.ghost.danger', { onclick: () => { scene.speakers.splice(i, 1); render(); } }, '✕ Remove'),
    ]),
    el('div.card-b', {}, [
      el('label.field', { style: 'margin:0 0 8px' }, [
        el('span', {}, 'Voice (reference_id)'),
        el('div.flex.aic.gap', {}, [
          voiceInput,
          el('button.btn.sm.icon', {
            title: 'Browse the voice library',
            onclick: () => openVoicePicker((id, title) => {
              sp.voiceId = id; sp.voiceName = title;
              render();
              toast(`Speaker ${i + 1} → ${title}`, 'ok');
            }, { current: sp.voiceId }),
          }, '🔍'),
        ]),
        sp.voiceName ? el('div.hint', { style: 'margin-top:4px' }, '🎙 ' + sp.voiceName) : null,
      ]),
      el('label.field', { style: 'margin:0' }, [
        el('span', {}, 'Reference clip (optional, overrides id)'),
        el('input.input', { type: 'file', accept: 'audio/*', style: 'padding:5px;font-size:12px', onchange: e => { sp.file = e.target.files[0] || null; } }),
      ]),
    ]),
  ]);
}

function render() {
  const box = $('#sceneSpeakers');
  const missing = scene.speakers.some(s => !s.voiceId);
  const head = el('div.flex.aic.gap.mb', {}, [
    el('div.hint.grow', {}, `${scene.speakers.length} speaker(s). Write the scene below as “Name: line”.`),
    missing ? el('button.btn.sm.ghost', { onclick: assignVoices }, '🎲 Assign voices') : null,
  ]);
  box.replaceChildren(head, ...scene.speakers.map(speakerCard));
}

/** The “Assign voices” button: fill the empty cards, then show what it picked. */
async function assignVoices() {
  if (assigning) return;
  if (!scene.speakers.some(s => !s.voiceId)) { toast('Every speaker already has a voice.', ''); return; }
  assigning = true;
  try {
    const n = await autoAssignVoices(scene.speakers);
    render();
    toast(n ? `Picked ${n} voice(s).` : 'Could not reach the voice library.', n ? 'ok' : 'err');
  } finally { assigning = false; }
}

/**
 * Give every speaker that has no voice a distinct one from the library.
 *
 * A scene cannot be sent with a hole in its cast: the `<|speaker:n|>` markers
 * index into `reference_id`, so a missing entry is not something Fish can work
 * around — it 400s ("Reference not found"). That is why loading an example and
 * hitting Render used to fail outright, and why falling back to one default
 * voice is the floor rather than the goal.
 *
 * The pick is about DISTINCTNESS, not casting. It draws from the most-used
 * English TTS models and alternates between the female- and male-tagged groups,
 * so consecutive speakers never sound alike. Whatever it picks is written onto
 * the speaker cards, so it is visible and one click from being changed.
 *
 * @param {Array<{voiceId?: string, voiceName?: string}>} speakers
 * @returns {Promise<number>} how many speakers were filled in
 */
async function autoAssignVoices(speakers) {
  const need = speakers.filter(s => !s.voiceId);
  if (!need.length) return 0;

  let items = [];
  try {
    // Same call the voice picker opens with, so the pool is the same one.
    const data = await fish.get('model', { page_size: 100, sort_by: 'task_count' });
    items = data.items || [];
  } catch { return 0; }          // offline / no key — caller falls back

  const pool = items.filter(m =>
    m && m._id && m.type === 'tts' && m.state === 'trained' &&
    (m.languages || []).includes('en'));
  if (!pool.length) return 0;

  const used = new Set(speakers.map(s => s.voiceId).filter(Boolean));
  const take = tag => pool.find(m => (m.tags || []).includes(tag) && !used.has(m._id));

  let filled = 0;
  for (const [i, sp] of need.entries()) {
    const pick = take(i % 2 ? 'male' : 'female') || pool.find(m => !used.has(m._id));
    if (!pick) break;
    used.add(pick._id);
    sp.voiceId = pick._id;
    sp.voiceName = pick.title || pick._id;
    filled++;
  }
  return filled;
}

function detectSpeakers() {
  const { speakers } = D3.parseScene($('#sceneScript').value);
  const known = new Set(scene.speakers.map(s => s.name));
  let added = 0;
  for (const s of speakers) {
    if (!known.has(s.name)) { scene.speakers.push({ name: s.name, voiceId: '', file: null }); added++; }
  }
  render();
  toast(added ? `Detected ${added} new speaker(s).` : 'No new speakers found.', added ? 'ok' : '');
}

async function renderScene() {
  const script = $('#sceneScript').value.trim();
  if (!script) { toast('Write a scene first.', 'err'); return; }
  const { speakers, turns } = D3.parseScene(script);
  if (!scene.speakers.length) { scene.speakers = speakers.map(s => ({ name: s.name, voiceId: '', file: null })); render(); }
  if (!turns.length) { toast('No “Name: line” turns found.', 'err'); return; }

  // Every speaker in the script needs a card before anything else: the voice
  // auto-assign below writes onto the cards, and a card is how the pick stays
  // visible and one click from being changed.
  for (const s of speakers) {
    if (!scene.speakers.some(x => x.name === s.name)) scene.speakers.push({ name: s.name, voiceId: '', file: null });
  }

  // order speakers by the definition list, fall back to appearance
  const order = scene.speakers.filter(s => speakers.some(x => x.name === s.name));
  const idx = new Map(order.map((s, i) => [s.name, i]));
  const text = turns.map(t => `<|speaker:${idx.get(t.name) ?? 0}|>${t.text}`).join('');

  const btn = $('#sceneRender');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Rendering…';
  try {
    // A speaker with no voice must NOT be sent as `speaker-<n>`. That string is
    // not a voice model id, and Fish answers the whole request with
    // 400 "Reference not found" — which is what made every example scene fail
    // until a voice was typed into every card. (`speaker-<n>` only means
    // anything alongside uploaded `references`, i.e. the with-references branch
    // below.)
    //
    // The `<|speaker:n|>` markers index the reference_id list, so a partial list
    // is not an option either: either every speaker has a real voice, or we
    // send no reference_id at all and Fish speaks the scene in its default
    // voice. Filling the gaps from the library is what makes the first case the
    // common one.
    if (order.some(s => !s.voiceId)) {
      const filled = await autoAssignVoices(order);
      if (filled) render();
    }

    const voiceIds = order.map(s => s.voiceId);
    const noVoice = order.filter(s => !s.voiceId).map(s => s.name);
    const model = $('#sceneModel').value;

    const anyFile = order.some(s => s.file);
    let blob;
    if (anyFile) {
      const fd = new FormData();
      fd.append('payload', JSON.stringify({ text, __model: model, format: 'mp3' }));
      const texts = [], spk = [];
      order.forEach((s, i) => { if (s.file) { fd.append('ref_files', s.file); texts.push(''); spk.push(i); } });
      fd.append('ref_texts', JSON.stringify(texts));
      fd.append('speakers', JSON.stringify(spk));
      blob = await apiFetch('/api/tts/with-references', { method: 'POST', body: fd });
    } else {
      const body = { text, __model: model, format: 'mp3' };
      if (!noVoice.length) body.reference_id = voiceIds;
      blob = await apiFetch('/api/tts', { method: 'POST', body });
    }
    if (blob.type.includes('json')) throw new Error(JSON.parse(await blob.text()).message);
    scene.lastBlob = blob;
    showScenePlayer(blob, turns.length, order.length);
    toast(noVoice.length
      ? `Scene rendered in the default voice — no voice set for ${noVoice.join(', ')}.`
      : 'Scene rendered.', noVoice.length ? '' : 'ok');
  } catch (e) {
    toast('Scene render failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '▶ Render scene';
  }
}

function showScenePlayer(blob, turns, speakers) {
  const url = URL.createObjectURL(blob);
  const wave = el('div.wave');
  const audio = el('audio', { controls: true, src: url });
  const info = el('div.hint', { style: 'margin-top:8px' }, `${turns} turns · ${speakers} speakers · ${(blob.size / 1024).toFixed(1)} KB`);
  const dl = el('button.btn.sm.mt', { onclick: () => downloadBlob(blob, 'scene.mp3') }, '⬇ Download scene');
  $('#scenePlayer').replaceChildren(audio, wave, info, dl);
  A.decode(blob).then(buf => {
    const pk = A.peaks(buf, 140);
    A.drawWave(wave, pk, 0);
    audio.addEventListener('timeupdate', () => { if (audio.duration) A.drawWave(wave, pk, audio.currentTime / audio.duration); });
  }).catch(() => {});
}

function loadExample(name) {
  $('#sceneScript').value = D3.SCENE_EXAMPLES[name];
  scene.speakers = [];
  detectSpeakers();
}

/**
 * Load a whole scene from elsewhere in the app (the Examples page).
 *
 * Replaces the cast rather than adding to it: a different scene means different
 * characters, and leaving the previous scene's speakers in place meant the cards
 * piled up — load four examples and you had eight speakers, only four of which
 * appear in the script you are about to render.
 */
export function loadSceneScript(text) {
  const ta = $('#sceneScript');
  if (!ta) return;
  ta.value = text;
  scene.speakers = [];
  detectSpeakers();
}

function buildExamples() {
  const box = $('#sceneExamples');
  box.replaceChildren(...Object.keys(D3.SCENE_EXAMPLES).map(name =>
    el('div.list-item', { onclick: () => loadExample(name) }, [
      el('div.avatar', {}, '📖'),
      el('div.grow', {}, [el('div.t', {}, name)]),
      el('span.hint', {}, 'load'),
    ])));
}

export function initScenes() {
  // inject the script editor + tokens preview if not present
  const main = $('#sceneSpeakers').parentElement;
  const scriptBox = el('div.card.mb', {}, [
    el('div.card-h', {}, [el('span', {}, '🎬 Scene script'), el('div.grow'),
      el('button.btn.sm.ghost', { id: 'sceneTags', title: 'Browse ready-made complex tags — including whole multi-speaker scenes', onclick: () => {
        const ta = $('#sceneScript');
        openTagPicker({ target: ta, onInsert: (text, wrap) => insertIntoField(ta, text, wrap) });
      } }, '🏷 Complex tags'),
      el('button.btn.sm.ghost', { onclick: detectSpeakers }, 'Detect speakers')]),
    el('div.card-b', {}, [
      el('textarea.textarea.mono', { id: 'sceneScript', rows: 12, placeholder: 'Mom: [suspiciously calm] Who ate the last slice of cake?\nKid: [way too fast] Maybe the dog. Dogs love cake.\nMom: [pause] We don\'t have a dog.' }),
      el('div.hint.mt', {}, 'Each “Name: line” becomes a speaker turn. Directions, sound tags and paired tags all work inside a line.'),
    ]),
  ]);
  main.insertBefore(scriptBox, $('#sceneSpeakers'));

  $('#sceneAddSpeaker').addEventListener('click', () => { scene.speakers.push({ name: '', voiceId: '', file: null }); render(); });
  $('#sceneRender').addEventListener('click', renderScene);
  $('#sceneParse').addEventListener('click', detectSpeakers);

  // Keep the speaker cards in step with the script as it is typed — and, more
  // importantly, when a scene is loaded from the Examples page, which sets the
  // textarea programmatically and fires `input`. Without this the cards kept
  // showing the previous scene's cast, so a four-hander would render with two
  // voices. detectSpeakers() only adds unknown names, so editing a line never
  // throws away a voice already assigned to a speaker.
  const scriptEl = $('#sceneScript');
  if (scriptEl) {
    scriptEl.dataset.tagLabel = 'the scene script';   // named in the tag picker
    let pending = null;
    scriptEl.addEventListener('input', () => {
      clearTimeout(pending);
      pending = setTimeout(detectSpeakers, 250);
    });
  }

  buildExamples();
  render();
}
