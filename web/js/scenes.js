// scenes.js — multi-speaker dialogue: speakers + a "Name: line" script → one scene

import { $, el, toast, modal, close, apiFetch, downloadBlob } from './api.js';
import * as D3 from './drama3.js';
import * as A from './audio.js';
import { openVoicePicker } from './voicepicker.js';

const scene = { speakers: [], lastBlob: null };

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
  const head = el('div.flex.aic.gap.mb', {}, [
    el('div.hint.grow', {}, `${scene.speakers.length} speaker(s). Write the scene below as “Name: line”.`),
  ]);
  box.replaceChildren(head, ...scene.speakers.map(speakerCard));
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
  let { speakers, turns } = D3.parseScene(script);
  if (!scene.speakers.length) { scene.speakers = speakers.map(s => ({ name: s.name, voiceId: '', file: null })); render(); }
  if (!turns.length) { toast('No “Name: line” turns found.', 'err'); return; }

  // order speakers by the definition list, fall back to appearance
  const order = scene.speakers.filter(s => speakers.some(x => x.name === s.name));
  for (const s of speakers) if (!order.some(o => o.name === s.name)) order.push(s);

  const idx = new Map(order.map((s, i) => [s.name, i]));
  const text = turns.map(t => `<|speaker:${idx.get(t.name) ?? 0}|>${t.text}`).join('');
  const reference_id = order.map(s => s.voiceId || `speaker-${idx.get(s.name)}`);
  const model = $('#sceneModel').value;

  const btn = $('#sceneRender');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Rendering…';
  try {
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
      blob = await apiFetch('/api/tts', { method: 'POST', body: { text, reference_id, __model: model, format: 'mp3' } });
    }
    if (blob.type.includes('json')) throw new Error(JSON.parse(await blob.text()).message);
    scene.lastBlob = blob;
    showScenePlayer(blob, turns.length, order.length);
    toast('Scene rendered.', 'ok');
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

  buildExamples();
  render();
}
