// lipsync.js — Fish Audio -> Wicked Roguelike lip sync.
//
// Generates a line with Drama 3, bakes the Rhubarb-format mouth track the
// game's VisemeTrack loads, and previews it on the NPC's real face atlas.
//
// Three things this page exists for:
//
//  1. Fish's streaming endpoint returns the audio AND per-word timings in one
//     call, so the viseme aligner is pinned to exact word boundaries instead of
//     re-deriving them with an ASR. Drama 3's tags fall out for free - a
//     [pause] is a real gap between word end and the next start, which is
//     exactly where the mouth should close.
//
//  2. The preview uses ALL 18 atlas frames: 9 mouth shapes x open/closed eyes.
//     The game pairs them the same way (DialogueChrome::AvatarStateSet -
//     letters[] / lettersEyes[]), and blinks on the tuning in
//     game_settings.json avatar.blink, which is what the blink state machine
//     below reproduces (DialogueAvatar::UpdateBlink).
//
//  3. The stage is an ACTOR model, not a single face. One actor or two; each
//     actor owns its face atlas, its voice (reference_id), its mouth track and
//     its blink machine, so a two-hander plays as two characters taking turns.
//     Avatars come from the game's assets/dialogue/* folders - adding one is
//     dropping in art, not editing this file.

import { $, el, toast, apiFetch, downloadBlob, localStore, localSave } from './api.js';
import { fixWavHeader, ensureWav } from './audio.js';
import * as L from './library.js';
import { openVoicePicker } from './voicepicker.js';
import { parseConversation, makeSpeakerResolver } from './convo.js';

/**
 * The avatar's own voice. A young female with a high-pitched, bright and
 * cheerful tone — the character reads as upbeat, and the pitch sits high
 * enough that the mouth shapes are lively without looking exaggerated.
 */
const AVATAR_VOICE = {
  id: '1621cae243064f63989bcccd240004b5',
  name: 'Happy Girl',
  desc: 'High-pitched, energetic young female · bright and cheerful',
};

const SHAPE_COLORS = {
  X: '#3b4b5e', A: '#4fd1c5', B: '#6ba8ff', C: '#8b8cff',
  D: '#ff7a59', E: '#f0b429', F: '#56d364', G: '#ffa07a', H: '#ff6b6b',
};
const SHAPES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'];

// Mirror of AvatarTuning's blink defaults, overridden by game_settings.json.
const BLINK_DEFAULTS = {
  per_min: 15.0, snap_window: 0.35,
  interval_min: 2.0, interval_max: 6.0,
  hold_min: 0.10, hold_max: 0.20,
};

const state = {
  info: null,
  avatars: [],
  actors: [],
  mode: 'single',
  genFor: 'a1',
  activeKey: 'a1',
  queue: [],           // [{ actorKey, takeId }]
  convoOn: false,
  baseName: '33_33000',
  busy: false,
  blinkOn: true,
};

let tlSig = null;      // what the timeline strip currently shows
let tlHead = null;     // the playhead, moved instead of rebuilt every frame
let lastTs = 0;

// --------------------------------------------------------------------- actors
function makeActor(key, label, avatar) {
  return {
    key,
    label,
    avatarId: avatar?.id || null,
    face: avatar?.face || null,
    sheetUrl: avatar?.sheet_url || null,
    portraitUrl: avatar?.portrait_url || null,
    img: { sheet: null, portrait: null },
    canvas: null,
    audio: null,
    badgeShape: null,
    badgeGame: null,
    stageEl: null,
    sidecar: null,
    takeId: null,
    shape: 'X',
    eyesClosed: false,
    blink: null,
    voiceId: '',
    voiceName: '',
    voiceDesc: '',
    _setVoice: null,
  };
}

/** Rebuild the actor list for the current mode, carrying state across. */
function buildActors() {
  const avatar = state.avatars[0] || null;
  const want = state.mode === 'duo' ? 2 : 1;
  const prev = state.actors;
  const next = [];

  for (let i = 0; i < want; i++) {
    const key = 'a' + (i + 1);
    const old = prev.find(a => a.key === key);
    const act = makeActor(key, `Avatar ${i + 1}`, avatar);
    if (old) {
      act.voiceId = old.voiceId;
      act.voiceName = old.voiceName;
      act.voiceDesc = old.voiceDesc;
      act.sidecar = old.sidecar;
      act.takeId = old.takeId;
      act.img = old.img;
    } else {
      // Saved per-actor choice; otherwise the avatar's own default voice.
      const saved = localStore('lipsync.voice.' + key, null);
      const id = saved === null ? AVATAR_VOICE.id : (saved || '');
      act.voiceId = id;
      act.voiceName = id === AVATAR_VOICE.id ? AVATAR_VOICE.name : '';
      act.voiceDesc = id === AVATAR_VOICE.id ? AVATAR_VOICE.desc
        : (localStore('lipsync.voiceDesc.' + key, '') || '');
    }
    act.blink = makeBlink();
    next.push(act);
  }

  state.actors = next;
  if (!next.some(a => a.key === state.activeKey)) state.activeKey = next[0]?.key || 'a1';
  if (!next.some(a => a.key === state.genFor)) state.genFor = next[0]?.key || 'a1';
  // Any turn whose actor disappeared is no longer playable.
  state.queue = state.queue.filter(t => next.some(a => a.key === t.actorKey));
}

function actorByKey(key) { return state.actors.find(a => a.key === key) || null; }
function activeActor() { return actorByKey(state.activeKey) || state.actors[0] || null; }

function setActive(key) {
  if (!actorByKey(key)) return;
  state.activeKey = key;
  tlSig = null;
  for (const act of state.actors) act.stageEl?.classList.toggle('active', act.key === key);
  renderVoices();
  renderQueue();
  const act = activeActor();
  if (act) drawTimeline(act, act.audio ? act.audio.currentTime : -1);
}

// --------------------------------------------------------------------- init
export async function initLipsync() {
  $('#lsRun').addEventListener('click', run);
  $('#lsPlay').addEventListener('click', togglePlay);
  $('#lsBlink').addEventListener('change', e => {
    state.blinkOn = e.target.checked;
    if (!state.blinkOn) for (const a of state.actors) a.blink?.reset();
  });
  $('#lsBlinkNow').addEventListener('click', () => {
    for (const a of state.actors) a.blink?.now();
  });
  $('#lsMode').addEventListener('change', e => {
    state.mode = e.target.value;
    $('#lsConvoBox').style.display = state.mode === 'duo' ? '' : 'none';
    $('#lsConvoScriptSection').style.display = state.mode === 'duo' ? '' : 'none';
    buildActors();
    renderStages();
    renderVoices();
    renderQueue();
    renderTakes();      // the per-take A1/A2 buttons only exist in duo mode
    toast(state.mode === 'duo' ? 'Two avatars on stage.' : 'Back to one avatar.');
  });
  $('#lsGenFor').addEventListener('change', e => {
    state.genFor = e.target.value;
    setActive(state.genFor);
  });
  $('#lsPullStudio').addEventListener('click', () => {
    const src = $('#editor');
    if (!src || !src.value.trim()) { toast('The studio editor is empty.', 'err'); return; }
    $('#lsScript').value = src.value;
    toast('Pulled the studio script in.', 'ok');
  });
  $('#lsSaveWav').addEventListener('click', () => exportWav());
  $('#lsSaveJson').addEventListener('click', () => exportJson());
  $('#lsSaveBoth').addEventListener('click', () => { exportWav(); exportJson(); });
  $('#lsBakeAll').addEventListener('click', bakeAll);
  $('#lsClearTakes').addEventListener('click', () => {
    if (!L.countAudio()) { toast('Nothing to clear.'); return; }
    L.clearAudio();
    for (const act of state.actors) { act.sidecar = null; act.takeId = null; }
    state.queue = [];
    for (const act of state.actors) { act.audio?.pause(); act.audio?.removeAttribute('src'); }
    for (const act of state.actors) { act.shape = 'X'; act.eyesClosed = false; drawActor(act); }
    renderQueue();
    drawTimeline(activeActor());
    $('#lsStats').replaceChildren(el('div.hint', {}, 'Nothing baked yet.'));
    toast('Library cleared.');
  });

  $('#lsConvoPlay').addEventListener('click', playConversation);
  $('#lsConvoStop').addEventListener('click', () => {
    state.convoOn = false;
    for (const act of state.actors) act.audio?.pause();
  });
  $('#lsConvoClear').addEventListener('click', () => {
    state.queue = [];
    renderQueue();
    toast('Conversation cleared.');
  });

  $('#lsConvoGen').addEventListener('click', () => generateConversation(false));
  $('#lsConvoGenPlay').addEventListener('click', () => generateConversation(true));
  $('#lsConvoExample').addEventListener('click', () => {
    $('#lsConvoScript').value = CONVO_EXAMPLE;
    localSave('lipsync.convoScript', CONVO_EXAMPLE);
    toast('Example conversation loaded.');
  });
  $('#lsConvoScript').value = localStore('lipsync.convoScript', null) || CONVO_EXAMPLE;
  $('#lsConvoScript').addEventListener('change', e => localSave('lipsync.convoScript', e.target.value));

  $('#lsName').addEventListener('input', e => {
    state.baseName = e.target.value.trim() || 'line';
    updatePaths();
  });
  updatePaths();

  // The Studio publishes its takes here; keep the panel in step either way.
  L.onAudioChange(renderTakes);
  renderTakes();

  const savedName = localStore('lipsync.name', null);
  if (savedName) { $('#lsName').value = savedName; state.baseName = savedName; updatePaths(); }
  $('#lsName').addEventListener('change', e => localSave('lipsync.name', e.target.value.trim()));

  // Examples that exercise the things the baker has to get right: a real
  // silence ([pause]), a soft voice the aligner must not read as silence,
  // plosives, sibilants, and a long unbroken run with no gaps at all.
  const ex = [
    ['👋', 'Cheerful hello', 'Hi there! [laughing] Oh, I am so happy you made it!'],
    ['🕯️', 'The lamp', 'The old lamp still flickers. [pause] Nobody has lit it in years.'],
    ['🤫', 'Whisper', '[whispering] Keep your voice down. <slower>They can hear us.</slower>'],
    ['🎉', 'Delighted', '[laughing] You should have seen your face! [pause] Priceless!'],
    ['💥', 'Plosives', 'Big bad bouncy puppies bark, pop, and pounce.'],
    ['🐍', 'Sibilants', 'She sells seashells by the seashore, surely.'],
    ['⚡', 'No pauses', 'I can barely believe it but here we are and it is actually happening right now.'],
    ['😮', 'Gasps', 'Wait — [gasp] you actually did it? [pause] That is amazing!'],
    ['🎵', 'Sing-song', '[singing] Happy little morning, happy little day!'],
    ['😢', 'Tearful', '[crying] I thought you had forgotten. [pause] You did not forget.'],
    ['🛎️', 'Question', 'Are you sure about that? [pause] Really, truly sure?'],
    ['🎭', 'Two-hander', 'You take the left path. [pause] I will take the right.'],
  ];
  $('#lsExamples').replaceChildren(...ex.map(([icon, name, t]) =>
    el('span.tag-chip', {
      title: t,
      onclick: () => { $('#lsScript').value = t; toast(`Loaded: ${name}`); },
    }, `${icon} ${name}`)));

  await loadInfo();
  buildActors();
  renderStages();
  renderVoices();
  renderQueue();
  requestAnimationFrame(loop);

  // Read-only snapshot for the end-to-end harness. The mouth badge only shows
  // cueAt(sidecar, currentTime), so "the badge says closed" cannot distinguish
  // an actor with no mouth track from one resting at t=0. This exposes the real
  // state (does the actor hold a sidecar? is its audio actually rolling?) so
  // tools/verify_lipsync.cjs can assert the thing it means to assert.
  window.__lipsync = () => ({
    mode: state.mode,
    activeKey: state.activeKey,
    genFor: state.genFor,
    busy: state.busy,
    queue: state.queue.map(q => ({ actorKey: q.actorKey, takeId: q.takeId })),
    actors: state.actors.map(a => ({
      key: a.key,
      label: a.label,
      takeId: a.takeId,
      hasSidecar: !!a.sidecar,
      cues: a.sidecar?.mouthCues?.length || 0,
      shape: a.shape,
      eyesClosed: !!a.eyesClosed,
      ct: a.audio ? +a.audio.currentTime.toFixed(2) : -1,
      dur: a.audio ? +(a.audio.duration || 0).toFixed(2) : 0,
      paused: a.audio ? a.audio.paused : true,
    })),
  });
}

function updatePaths() {
  const dir = 'assets/audio/speech/en/33/';
  $('#lsPaths').innerHTML =
    `${dir}${state.baseName}.wav<br>${dir}${state.baseName}.visemes.json`;
}

async function loadInfo() {
  try {
    state.info = await apiFetch('/api/lipsync/info');
  } catch (e) {
    toast('Could not read the avatar: ' + e.message, 'err');
    return;
  }
  const i = state.info;
  renderBakerNotice(i);
  // Keep which avatars the server actually found separate from the fallback:
  // the fallback below is never empty, which is what used to make the "not
  // found" branch below unreachable.
  const found = i.avatars?.length ? i.avatars : [];
  state.avatars = found.length ? found : [{
    id: 'default', npc: '33', name: '33_default',
    face: i.face, sheet_url: i.sheet_url, portrait_url: i.portrait_url,
  }];
  if (!i.avatar_dir_exists && !found.length) {
    // The art is read from the game folder on whichever machine runs the
    // server. A deploy has no such folder, so name the cause instead of
    // pointing at a path the reader cannot open.
    $('#lsStages').replaceChildren(el('div.empty', {}, [
      el('div.big', {}, '🎭'),
      el('div', {}, i.hosted
        ? 'No game folder here, so there is no avatar art to preview.'
        : 'Avatar art not found at ' + i.avatar_dir),
      el('div.hint', {}, i.hosted
        ? 'Baking still works — the exported .wav + .visemes.json pair is what the game loads.'
        : 'Set ROGUELIKE_ROOT (or ROGUELIKE_DIALOGUE_DIR) to your game folder and reload.'),
    ]));
    return;
  }
  renderLegend();
}

// ------------------------------------------------------------------- blink
// Seeded so the preview is reproducible (and so the test harness can rely on
// it) - the same reason the game's dice are seeded.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Port of DialogueAvatar::UpdateBlink. */
function makeBlink() {
  const tune = { ...BLINK_DEFAULTS, ...(state.info?.blink || {}) };
  const rnd = mulberry32(0x5eed);
  let closed = false, nextIn = 0, reopenIn = 0;

  const schedule = () => (tune.per_min > 0
    ? -Math.log(1 - rnd() * 0.999) * (60 / tune.per_min)
    : tune.interval_min + rnd() * (tune.interval_max - tune.interval_min));

  const api = {
    tune,
    get closed() { return closed; },
    reset() { closed = false; nextIn = schedule(); reopenIn = 0; },
    /** `pause` = the mouth is idle, which is where blinks get snapped to. */
    update(dt, pause) {
      if (closed) {
        reopenIn -= dt;
        if (reopenIn <= 0) { closed = false; nextIn = schedule(); }
        return;
      }
      if (pause && nextIn > 0 && nextIn <= tune.snap_window) nextIn = 0;
      nextIn -= dt;
      if (nextIn <= 0) {
        closed = true;
        reopenIn = tune.hold_min + rnd() * (tune.hold_max - tune.hold_min);
      }
    },
    now() {
      closed = true;
      reopenIn = tune.hold_min + rnd() * (tune.hold_max - tune.hold_min);
    },
  };
  api.reset();
  return api;
}

// ------------------------------------------------------------------ stages
function renderStages() {
  const box = $('#lsStages');
  const duo = state.actors.length > 1;

  box.replaceChildren(...state.actors.map((act, i) => {
    const canvas = el('canvas', {
      width: 432, height: 768,
      id: i === 0 ? 'lsCanvas' : `lsCanvas${i + 1}`,
    });
    act.canvas = canvas;

    const badgeShape = el('span.mono', { id: i === 0 ? 'lsShape' : `lsShape${i + 1}` }, 'X');
    const badgeGame = el('span.hint', { id: i === 0 ? 'lsGame' : `lsGame${i + 1}` }, '');
    act.badgeShape = badgeShape;
    act.badgeGame = badgeGame;

    const audio = el('audio', { id: i === 0 ? 'lsAudio' : `lsAudio${i + 1}`, style: 'display:none' });
    act.audio = audio;

    const stage = el('div.ls-stage' + (duo ? '.duo' : '') + (act.key === state.activeKey ? '.active' : ''), {
      title: 'Click to make this the active avatar',
    }, [
      canvas,
      el('div.ls-badge', {}, [badgeShape, badgeGame]),
      el('div.ls-name', {}, act.label),
      audio,
    ]);
    stage.addEventListener('click', () => setActive(act.key));
    act.stageEl = stage;
    return stage;
  }));

  // Portraits + sheets load once per avatar, then get reused by every actor.
  (async () => {
    for (const act of state.actors) {
      if (!act.img.sheet && act.sheetUrl) {
        act.img.sheet = await loadImage(act.sheetUrl);
      }
      if (!act.img.portrait && act.portraitUrl) {
        act.img.portrait = await loadImage(act.portraitUrl);
      }
      drawActor(act);
    }
  })();
}

function loadImage(src) {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}

// ----------------------------------------------------------------- preview
function shapeToGame(shape) {
  const st = state.info?.viseme_states?.states;
  if (!st) return null;
  for (const [k, letters] of Object.entries(st)) if (letters.includes(shape)) return k;
  return 'closed';
}

/**
 * The atlas key for a shape + eye state.
 * `A`..`H`/`X` are the open-eye cells; `<shape>_eyes` are their closed-eye
 * twins - the same pairing as the game's letters[] / lettersEyes[].
 */
function frameFor(act, shape, eyesClosed) {
  const frames = act.face?.frames || {};
  if (eyesClosed) return frames[shape + '_eyes'] || frames[shape] || frames.X;
  return frames[shape] || frames.X;
}

function drawActor(act) {
  const cv = act.canvas;
  if (!cv || !act.face) return;
  const ctx = cv.getContext('2d');
  const face = act.face;
  ctx.clearRect(0, 0, cv.width, cv.height);

  if (act.img.portrait) ctx.drawImage(act.img.portrait, 0, 0, cv.width, cv.height);

  // `canvas` in the face json is the PORTRAIT space; `dest` is where the
  // 218x166 face cell is pasted into it. Same numbers the game uses.
  const space = face.canvas || { w: 576, h: 1024 };
  const sx = cv.width / space.w;
  const sy = cv.height / space.h;
  const d = face.dest || { x: 0, y: 0, w: face.cell?.w, h: face.cell?.h };

  const frame = frameFor(act, act.shape, act.eyesClosed);
  if (act.img.sheet && frame && face.cell) {
    ctx.drawImage(act.img.sheet, frame.x, frame.y, face.cell.w, face.cell.h,
      d.x * sx, d.y * sy, d.w * sx, d.h * sy);
  }

  if (act.badgeShape) {
    act.badgeShape.textContent = act.shape;
    act.badgeShape.style.color = SHAPE_COLORS[act.shape] || 'var(--text)';
  }
  if (act.badgeGame) {
    const game = shapeToGame(act.shape);
    act.badgeGame.textContent = `${game || '?'}${act.eyesClosed ? ' · eyes shut' : ''}`;
  }
}

function cueAt(sidecar, t) {
  const cues = sidecar?.mouthCues || [];
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return c.value;
  }
  return 'X';
}

function loop(ts) {
  requestAnimationFrame(loop);
  const view = document.getElementById('view-lipsync');
  if (!view || !view.classList.contains('active')) { lastTs = 0; return; }

  const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
  lastTs = ts;

  // The game's own mouth timing, so the preview cannot disagree with it.
  const minHold = Number(state.info?.voice?.mouth_min_hold) || 0.05;
  const latency = Number(state.info?.viseme_states?.latency_seconds) || 0;

  for (const act of state.actors) {
    const a = act.audio;
    const speaking = !!a && !a.paused && !a.ended;

    // This mirrors DialogueAvatar::UpdateMouth.
    //
    //  * Only the avatar whose audio is actually rolling gets to move its
    //    mouth. cueAt(sidecar, 0) returns whatever viseme the clip *starts* on,
    //    so an idle actor left holding a take would freeze with its mouth open
    //    on the first shape of a line it is not saying — in a two-hander that
    //    reads as both avatars talking at once, one of them silently stuck.
    //  * The clock is shifted back by avatar.visemes.latency_seconds, so the
    //    mouth never leads the voice (AudioSystem::CurrentVoiceSeconds).
    //  * A shape must have been on screen for avatar.voice.mouth_min_hold
    //    before it may change. The game holds it; without the hold the preview
    //    flickers on a 20 ms cue the game draws for a full 50 ms.
    act.mouthHold = (act.mouthHold ?? 0) - dt;

    const prev = act.shape || 'X';
    let shape = prev;
    if (!speaking) {
      act.mouthHold = 0;
      shape = 'X';
    } else {
      const raw = act.sidecar ? cueAt(act.sidecar, Math.max(0, a.currentTime - latency)) : 'X';
      if (raw !== prev && act.mouthHold <= 0) {
        shape = raw;
        act.mouthHold = minHold;
      }
    }

    if (act.blink) {
      if (state.blinkOn) act.blink.update(dt, shape === 'X');
      else if (act.blink.closed) act.blink.reset();
    }
    const eyesClosed = state.blinkOn && act.blink ? act.blink.closed : false;

    if (shape !== act.shape || eyesClosed !== act.eyesClosed) {
      act.shape = shape;
      act.eyesClosed = eyesClosed;
      drawActor(act);
    }
  }

  const act = activeActor();
  if (act?.audio) {
    const a = act.audio;
    $('#lsTime').textContent = `${a.currentTime.toFixed(2)}s / ${(a.duration || 0).toFixed(2)}s`;
    drawTimeline(act, a.currentTime);
    $('#lsPlay').textContent = a.paused ? '▶ Play' : '⏸ Pause';
  }
}

function togglePlay() {
  const act = activeActor();
  const a = act?.audio;
  if (!a || !act.sidecar) { toast('Pick a baked take first.', 'err'); return; }
  if (a.paused) {
    for (const other of state.actors) if (other !== act) other.audio?.pause();
    a.play().catch(() => {});
  } else {
    a.pause();
  }
}

// ----------------------------------------------------------------- timeline
// The strip is rebuilt only when the sidecar changes; the playhead just moves.
function drawTimeline(act = null, playhead = -1) {
  const box = $('#lsTimeline');
  const cues = act?.sidecar?.mouthCues || [];
  const dur = act?.sidecar?.metadata?.duration || 1;
  const sig = `${act?.key || '-'}:${act?.takeId || '-'}:${cues.length}`;

  if (!cues.length) {
    tlSig = null; tlHead = null;
    box.replaceChildren(el('div.hint', {}, 'No cues yet.'));
    return;
  }

  if (sig !== tlSig) {
    tlSig = sig;
    const strip = el('div.tl-strip');
    for (const c of cues) {
      const w = ((c.end - c.start) / dur) * 100;
      const b = el('div.tl-cue', {
        title: `${c.value}  ${c.start.toFixed(2)}s – ${c.end.toFixed(2)}s`,
        style: `left:${(c.start / dur) * 100}%;width:${w}%;background:${SHAPE_COLORS[c.value] || '#556'}`,
        onclick: () => { const a = act?.audio; if (a) a.currentTime = c.start; },
      });
      if (w > 2.2) b.textContent = c.value;
      strip.append(b);
    }
    tlHead = el('div.tl-head', { style: 'left:0%' });
    strip.append(tlHead);
    box.replaceChildren(strip);
  }

  if (tlHead) tlHead.style.left = `${Math.max(0, Math.min(100, (playhead / dur) * 100))}%`;
}

/**
 * Say up front when a bake cannot work here.
 *
 * `/api/lipsync/info` has always carried `baker: { script_exists, python_exists,
 * openfacefx, … }`, and nothing read it. So a deploy missing the baker — the
 * script is a separate file that has to be bundled into the function — looked
 * completely normal until you pressed Bake and got a 502 naming a path you
 * cannot see. This turns that into a message before the work is attempted.
 *
 * Only a definite `false` warns: `openfacefx` is `null` when the baker runs on a
 * *different* interpreter than the server, which is the normal local setup and
 * is not a problem.
 */
function renderBakerNotice(info) {
  const box = $('#lsNotice');
  if (!box) return;
  const b = info?.baker || {};
  const problems = [];
  if (b.script_exists === false) {
    problems.push(['the viseme baker is not in this deployment',
      'tools/visemes.py has to be bundled into the function — check includeFiles in vercel.json.']);
  }
  if (b.python_exists === false) {
    problems.push(['the baker’s interpreter is missing',
      `it resolved to ${b.python || '(none)'}, which does not exist here.`]);
  }
  if (b.openfacefx === false) {
    problems.push(['openfacefx is not installed for the baker',
      'it is declared in requirements.txt, so a deploy that is missing it built from the wrong manifest.']);
  }
  if (!problems.length) {
    box.replaceChildren();
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.classList.add('bad');
  box.replaceChildren(el('span.ico', {}, '⚠'),
    el('div', {}, problems.map(([title, why]) => el('div', {}, [
      el('b', {}, title), el('div.hint', {}, why),
    ]))));
}

function renderLegend() {
  const face = state.avatars[0]?.face || state.info?.face || {};
  const frames = face.frames || {};
  const hasEyes = SHAPES.every(s => frames[s + '_eyes']);
  $('#lsLegend').replaceChildren(
    ...SHAPES.map(s => {
      const g = shapeToGame(s);
      return el('span.ls-legend', { title: `${s} (open eyes)${g ? ' · game: ' + g : ''}` }, [
        el('i', { style: `background:${SHAPE_COLORS[s] || '#556'}` }),
        el('span', {}, s),
        g ? el('em', {}, g) : null,
      ]);
    }),
    el('span.ls-legend.eyes', { title: 'closed-eye twins, used for blinking' }, [
      el('i', { style: 'background:#243040' }), el('span', {}, hasEyes ? '+9 closed-eye' : 'no eye twins'),
    ]),
  );
  const b = { ...BLINK_DEFAULTS, ...(state.info?.blink || {}) };
  $('#lsBlinkRate').textContent = b.per_min > 0
    ? `(${b.per_min}/min)`
    : `(${b.interval_min}–${b.interval_max}s)`;
}

// ------------------------------------------------------------ avatar voices
function setActorVoice(act, id, name, desc) {
  act.voiceId = id || '';
  act.voiceName = name || '';
  act.voiceDesc = desc || '';
  localSave('lipsync.voice.' + act.key, act.voiceId);
  localSave('lipsync.voiceDesc.' + act.key, act.voiceDesc);
  if (act._setVoice) act._setVoice(act.voiceId, act.voiceName);
  renderVoiceHint();
}

function renderVoices() {
  const box = $('#lsVoices');
  if (!box) return;

  box.replaceChildren(...state.actors.map((act, i) => {
    const first = i === 0;
    const nameEl = el('span.hint.vc-name', { id: first ? 'lsVoiceName' : `lsVoiceName${i + 1}` },
      act.voiceName || '');

    const input = el('input.input.mono', {
      id: first ? 'lsVoiceId' : `lsVoiceId${i + 1}`,
      value: act.voiceId,
      placeholder: 'voice model id',
      style: 'font-size:11px',
      oninput: e => {
        act.voiceId = e.target.value.trim();
        act.voiceName = '';
        act.voiceDesc = act.voiceId === AVATAR_VOICE.id ? AVATAR_VOICE.desc : '';
        nameEl.textContent = '';
        localSave('lipsync.voice.' + act.key, act.voiceId);
        renderVoiceHint();
      },
    });
    act._setVoice = (id, name) => { input.value = id; nameEl.textContent = name || ''; };

    return el('div.vc-row' + (act.key === state.activeKey ? '.active' : ''), {}, [
      el('div.vc-head', {}, [el('span.vc-tag', {}, act.label), nameEl]),
      el('div.flex.aic.gap.mb', {}, [
        input,
        el('button.btn.sm.icon', {
          id: first ? 'lsPickVoice' : `lsPickVoice${i + 1}`,
          title: 'Browse the voice library',
          onclick: () => openVoicePicker((id, name, m) => {
            setActorVoice(act, id, name, (m?.description || '').slice(0, 140));
            toast(`${act.label} → ${name}`, 'ok');
          }, { current: act.voiceId, title: 'Voice for ' + act.label }),
        }, '🔍'),
      ]),
      el('div.flex.gap', { style: 'flex-wrap:wrap' }, [
        el('button.btn.sm.ghost', {
          id: first ? 'lsVoiceDefault' : `lsVoiceDefault${i + 1}`,
          onclick: () => {
            setActorVoice(act, AVATAR_VOICE.id, AVATAR_VOICE.name, AVATAR_VOICE.desc);
            toast('Avatar default voice restored.', 'ok');
          },
        }, '↺ default'),
        el('button.btn.sm.ghost', {
          id: first ? 'lsVoiceClear' : `lsVoiceClear${i + 1}`,
          onclick: () => { setActorVoice(act, '', '', ''); toast('No reference voice — the model picks.'); },
        }, '✕ none'),
      ]),
    ]);
  }));

  const sel = $('#lsGenFor');
  if (sel) {
    sel.replaceChildren(...state.actors.map(a =>
      el('option', { value: a.key, selected: a.key === state.genFor }, a.label)));
  }
  $('#lsGenForWrap').style.display = state.mode === 'duo' ? '' : 'none';
  renderVoiceHint();
}

function renderVoiceHint() {
  const hint = $('#lsVoiceHint');
  if (!hint) return;
  const act = activeActor();
  if (!act) { hint.textContent = ''; return; }
  const who = state.mode === 'duo' ? `${act.label}: ` : '';
  if (!act.voiceId) {
    hint.textContent = `${who}no reference voice — the model chooses. Directions in the script still steer the tone.`;
  } else {
    hint.textContent = who + (act.voiceDesc
      || (act.voiceId === AVATAR_VOICE.id ? AVATAR_VOICE.desc : act.voiceId));
  }
}

// -------------------------------------------------------------------- takes
// The right-panel list. Every line the app has generated lives in the shared
// library; picking one bakes its mouth track if it hasn't been baked already,
// which is the "select audio -> visemes generate themselves" flow.
function renderTakes() {
  const box = $('#lsTakes');
  if (!box) return;
  const list = L.listAudio();
  $('#lsTakeCount').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) {
    box.replaceChildren(el('div.hint', {}, 'No audio yet — generate one here, or in the Studio.'));
    return;
  }
  box.replaceChildren(...list.map(takeRow));
}

function takeRow(t) {
  const baked = !!t.sidecar;
  const act = activeActor();
  const active = act && act.takeId === t.id;
  const stop = e => e.stopPropagation();

  const acts = el('div.tk-acts', {}, [
    el('button.btn.sm.ghost', {
      title: 'Audition just the audio',
      onclick: e => { stop(e); audition(t); },
    }, '▶'),
    el('button.btn.sm.ghost', {
      title: baked ? 'Download .wav + .visemes.json' : 'Bake first',
      onclick: async e => {
        stop(e);
        if (!baked) { toast('Bake it first — click the row.', 'err'); return; }
        await exportTake(t);
      },
    }, '⬇'),
    el('button.btn.sm.ghost', {
      title: 'Remove from the session library',
      onclick: e => {
        stop(e);
        for (const a of state.actors) if (a.takeId === t.id) a.takeId = null;
        state.queue = state.queue.filter(x => x.takeId !== t.id);
        renderQueue();
        L.removeAudio(t.id);
      },
    }, '✕'),
  ]);

  const assign = state.mode === 'duo'
    ? el('div.tk-assign', {}, state.actors.map(a =>
        el('button.btn.sm', {
          title: `Have ${a.label} speak this line`,
          onclick: e => { stop(e); assignToActor(t, a.key); },
        }, a.key.toUpperCase())))
    : null;

  return el('div.tk' + (active ? '.active' : ''), {
    onclick: () => selectTake(t),
    title: t.text,
  }, [
    el('div.tk-top', {}, [
      el('span.tk-dot' + (baked ? '.on' : (t.bakeError ? '.bad' : '')), {
        title: baked ? 'mouth track baked'
          : t.bakeError ? 'bake failed: ' + t.bakeError
          : 'not baked yet',
      }),
      el('div.grow', {}, [
        el('div.t', {}, t.name),
        el('div.d.truncate', {}, t.text.slice(0, 54) || '—'),
      ]),
    ]),
    el('div.tk-meta', {}, [
      el('span', {}, t.model || '—'),
      t.meta?.voiceName ? el('span', {}, '🎙 ' + t.meta.voiceName) : null,
      el('span', {}, baked
        ? `${t.sidecar.mouthCues.length} cues`
        : (t.bakeError ? 'bake failed' : 'auto-bakes on pick')),
      t.source === 'studio' ? el('span.tk-src', {}, 'studio') : null,
      acts,
    ]),
    assign,
  ]);
}

/** Play a take's audio without touching the face. */
function audition(t) {
  const act = activeActor();
  if (!act?.audio) return;
  for (const other of state.actors) if (other !== act) other.audio?.pause();
  act.audio.pause();
  act.audio.src = t.url;
  act.sidecar = t.sidecar || act.sidecar;
  act.takeId = t.id;
  renderTakes();
  act.audio.play().catch(() => toast('Could not play that take.', 'err'));
}

/**
 * Bake the viseme sidecar for a take that doesn't have one.
 *
 * Fish's word timings travel with the take (the streaming call returned them),
 * so the baker is pinned to real word boundaries instead of re-deriving them.
 */
async function bakeInto(take) {
  const t0 = performance.now();
  const raw = await L.audioBytes(take);
  // Studio takes default to mp3; the baker needs PCM WAV. Decode + re-encode.
  let bytes;
  try {
    bytes = await ensureWav(raw);
  } catch (e) {
    throw new Error(`could not decode the take's audio (${take.blob.type || 'unknown type'}) — ${e.message}`);
  }
  // A hosted deploy caps the request body (Vercel: 4.5 MB) and rejects it with
  // a bare 413 before the baker runs. Check first so the message names the
  // cause and the fix.
  const limit = state.info?.max_upload_bytes || 0;
  if (limit && bytes.length > limit) {
    const mb = n => (n / 1048576).toFixed(1);
    throw new Error(
      `this line's WAV is ${mb(bytes.length)} MB, past the ${mb(limit)} MB this ` +
      `host accepts in one request — bake it locally, or shorten the line`
    );
  }

  const fd = new FormData();
  fd.append('wav', new Blob([bytes], { type: 'audio/wav' }), 'line.wav');
  fd.append('text', take.text);
  const al = take.meta?.alignment;
  if (al?.segments?.length) fd.append('anchors', JSON.stringify(al));
  fd.append('aligner', $('#lsAligner').value);
  const style = $('#lsStyle').value;
  if (style) fd.append('style', style);

  // A sidecar that never opens the mouth is worse than no sidecar at all: it
  // exports cleanly and then ships an avatar that stands there mute. The baker
  // occasionally returns one of these — a single all-X cue — when the aligner
  // reads the clip as silence. That is almost always a transient rather than
  // real silence, so try once more before giving up.
  let out = null, lastWhy = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    out = await apiFetch('/api/visemes', { method: 'POST', body: fd });
    if (out.error) throw new Error(out.error);
    const cues = out.sidecar?.mouthCues || [];
    const moved = cues.some(c => String(c.value).toUpperCase() !== 'X');
    if (cues.length && moved) break;
    lastWhy = `${cues.length} cue${cues.length === 1 ? '' : 's'}, none opening the mouth`;
    out = null;
  }
  if (!out) {
    throw new Error(
      `the aligner read the whole clip as silence (${lastWhy}) — the audio may be ` +
      `silent, or the aligner misread it; try again or switch aligner`
    );
  }
  // Keep the repaired WAV — that is what the game should load. Repaired here
  // rather than echoed back by the server: it is the same two-field fix the
  // baker applies (verified byte-for-byte in verify_lipsync.cjs), and returning
  // it as base64 added 33% to the response, which on a hosted deploy is capped
  // just like the request — so a long line could be accepted and then die on the
  // way back with nothing naming the cause. `bytes` is the array already sent;
  // the Blob above copied it, so repairing it in place is safe.
  take.wavBytes = fixWavHeader(bytes);
  out.stats.roundTripMs = Math.round(performance.now() - t0);
  L.setSidecar(take.id, out.sidecar, out.stats);
  return out;
}

/** Put a take on an actor. Assumes its mouth track already exists. */
function applyTake(take, act = activeActor()) {
  if (!act) return;
  act.takeId = take.id;
  act.sidecar = take.sidecar;
  act.shape = 'X';
  act.eyesClosed = false;
  if (act.blink) act.blink.reset();

  const a = act.audio;
  if (a) {
    a.pause();
    a.src = take.url;             // the library URL is always the take's own bytes
    a.currentTime = 0;
  }
  drawActor(act);
  if (act.key === state.activeKey) drawTimeline(act, 0);
  renderTakes();
  if (take.bakeStats) renderStats(take.bakeStats, take.bakeStats.roundTripMs || 0);
}

async function selectTake(take) {
  if (state.busy) { toast('Still working on the last one.', 'err'); return; }
  const act = activeActor();
  if (!act) return;
  setActive(act.key);
  if (take.sidecar) { applyTake(take, act); toast(`${take.name} → ${act.label}`, 'ok'); return; }

  state.busy = true;
  busy(true, 'Baking visemes…');
  try {
    const out = await bakeInto(take);
    applyTake(take, act);
    renderStats(out.stats, out.stats.roundTripMs);
    toast(`Baked ${out.stats.cues} cues · ${out.stats.aligner}`, 'ok');
  } catch (e) {
    L.setSidecar(take.id, null, null, e.message);
    toast('Bake failed: ' + e.message, 'err');
  } finally {
    state.busy = false;
    busy(false);
  }
}

/** Give a take to a specific avatar and queue it as a conversation turn. */
async function assignToActor(take, key) {
  if (state.busy) { toast('Still working on the last one.', 'err'); return; }
  const act = actorByKey(key);
  if (!act) return;
  state.busy = true;
  try {
    if (!take.sidecar) {
      busy(true, `Baking for ${act.label}…`);
      await bakeInto(take);
    }
    applyTake(take, act);
    if (!state.queue.some(q => q.actorKey === key && q.takeId === take.id)) {
      state.queue.push({ actorKey: key, takeId: take.id });
    }
    renderQueue();
    toast(`${act.label} will say: “${take.text.slice(0, 34)}…”`, 'ok');
  } catch (e) {
    L.setSidecar(take.id, null, null, e.message);
    toast('Bake failed: ' + e.message, 'err');
  } finally {
    state.busy = false;
    busy(false);
  }
}

async function bakeAll() {
  if (state.busy) { toast('Still working on the last one.', 'err'); return; }
  const todo = L.listAudio().filter(t => !t.sidecar);
  if (!todo.length) { toast('Every take already has a mouth track.', 'ok'); return; }
  state.busy = true;
  let done = 0;
  for (let i = 0; i < todo.length; i++) {
    busy(true, `Baking ${i + 1}/${todo.length}…`);
    try { await bakeInto(todo[i]); done++; }
    catch (e) { L.setSidecar(todo[i].id, null, null, e.message); }
  }
  state.busy = false;
  busy(false);
  renderTakes();
  toast(`Baked ${done} of ${todo.length}.`, done ? 'ok' : 'err');
}

function busy(on, label) {
  const btn = $('#lsRun');
  if (!btn) return;
  btn.disabled = on;
  btn.innerHTML = on ? `<span class="spinner"></span> ${label || 'Working…'}` : '🎬 Generate + bake';
}

// ------------------------------------------------------------- conversation
// The built-in two-hander. Chosen because it leans on the three things that
// make a conversation read as acting rather than narration: a delivery tag per
// line, a clipped interjection, and a bare [pause] used as a comic beat.
const CONVO_EXAMPLE = [
  'Avatar1: [suspiciously calm] Who ate the last slice of cake?',
  'Avatar2: [way too fast] Maybe the dog. Dogs love cake.',
  'Avatar1: [pause] We don\'t have a dog.',
].join('\n');

async function generateConversation(autoPlay = false) {
  if (state.busy) { toast('Still working on the last one.', 'err'); return; }
  const turns = parseConversation($('#lsConvoScript').value);
  if (!turns.length) { toast('Write some lines first.', 'err'); return; }

  if (state.mode !== 'duo') {
    state.mode = 'duo';
    $('#lsMode').value = 'duo';
    $('#lsConvoBox').style.display = '';
    $('#lsConvoScriptSection').style.display = '';
    buildActors();
    renderStages();
    renderVoices();
    renderTakes();
  }

  const model = $('#lsModel').value;
  const resolve = makeSpeakerResolver(state.actors);
  state.convoOn = false;
  for (const act of state.actors) act.audio?.pause();

  state.busy = true;
  state.queue = [];
  renderQueue();

  const t0 = performance.now();
  let done = 0, failed = 0;
  try {
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const act = resolve(turn.speaker) || state.actors[0];
      const who = act ? act.label : 'Avatar';
      busy(true, `Line ${i + 1}/${turns.length}…`);
      $('#lsConvoProgress').textContent =
        `${i + 1}/${turns.length} — ${who}: ${turn.text.slice(0, 46)}…`;
      try {
        const { bytes, alignment } = await streamLine(turn.text, model, act?.voiceId);
        const take = L.addAudio({
          bytes, text: turn.text, model, source: 'lipsync',
          name: `${who} · line ${i + 1}`,
          meta: { alignment, voiceId: act?.voiceId || '', voiceName: act?.voiceName || '' },
        });
        await bakeInto(take);
        applyTake(take, act);
        state.queue.push({ actorKey: act.key, takeId: take.id });
        renderQueue();
        done++;
      } catch (e) {
        failed++;
        toast(`Line ${i + 1} failed: ${e.message}`, 'err');
      }
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('#lsConvoProgress').textContent =
      `${done}/${turns.length} turns baked in ${secs}s${failed ? ` · ${failed} failed` : ''}`;
    toast(`Conversation ready — ${done} turn(s).`, done ? 'ok' : 'err');
  } finally {
    state.busy = false;
    busy(false);
  }

  if (autoPlay && state.queue.length) await playConversation();
}

function renderQueue() {
  const box = $('#lsConvo');
  if (!box) return;
  $('#lsConvoCount').textContent = state.queue.length ? `${state.queue.length} turn(s)` : '';
  if (!state.actors.length) { box.replaceChildren(el('div.hint', {}, 'No avatars on stage.')); return; }
  if (!state.queue.length) {
    box.replaceChildren(el('div.hint', {}, 'No turns yet — use A1 / A2 on a take.'));
    return;
  }
  box.replaceChildren(...state.queue.map((turn, i) => {
    const act = actorByKey(turn.actorKey);
    const take = L.getAudio(turn.takeId);
    const current = act && act.takeId === turn.takeId;
    return el('div.cv-turn' + (current ? '.active' : ''), {
      title: take?.text || '(missing take)',
      onclick: () => playTurn(i),
    }, [
      el('span.cv-who', {}, act?.label || '?'),
      el('span.cv-text.truncate', {}, take ? take.text : '(missing take)'),
      el('button.btn.sm.ghost', {
        onclick: e => { e.stopPropagation(); state.queue.splice(i, 1); renderQueue(); },
      }, '✕'),
    ]);
  }));
}

/** Play one turn, resolving when its audio ends. */
function playTurn(i) {
  const turn = state.queue[i];
  if (!turn) return Promise.resolve();
  const act = actorByKey(turn.actorKey);
  const take = L.getAudio(turn.takeId);
  if (!act || !take || !act.audio) return Promise.resolve();

  for (const other of state.actors) if (other !== act) other.audio?.pause();
  act.sidecar = take.sidecar || act.sidecar;
  act.takeId = take.id;
  act.shape = 'X';
  if (act.blink) act.blink.reset();

  act.audio.src = take.url;
  act.audio.currentTime = 0;
  setActive(act.key);
  renderQueue();
  return act.audio.play().then(() => new Promise(res => {
    const done = () => {
      act.audio.removeEventListener('ended', done);
      act.audio.removeEventListener('error', done);
      res();
    };
    act.audio.addEventListener('ended', done);
    act.audio.addEventListener('error', done);
  })).catch(() => {});
}

async function playConversation() {
  if (!state.queue.length) { toast('Add some turns first — use A1 / A2 on a take.', 'err'); return; }
  state.convoOn = true;
  for (let i = 0; i < state.queue.length && state.convoOn; i++) {
    await playTurn(i);
  }
  state.convoOn = false;
}

// ----------------------------------------------------------------- generate
async function run() {
  const text = $('#lsScript').value.trim();
  if (!text) { toast('Write a line first.', 'err'); return; }
  if (state.busy) { toast('Still working on the last one.', 'err'); return; }

  const act = actorByKey(state.mode === 'duo' ? state.genFor : state.activeKey) || activeActor();
  state.busy = true;
  busy(true, 'Generating…');
  const t0 = performance.now();
  try {
    const model = $('#lsModel').value;
    const { bytes, alignment } = await streamLine(text, model, act?.voiceId);

    const take = L.addAudio({
      bytes, text, model, source: 'lipsync',
      name: $('#lsName').value.trim() || `Line ${L.countAudio()}`,
      meta: { alignment, voiceId: act?.voiceId || '', voiceName: act?.voiceName || '' },
    });
    if (act) act.takeId = take.id;

    busy(true, 'Baking visemes…');
    const out = await bakeInto(take);
    const ms = Math.round(performance.now() - t0);
    if (act) applyTake(take, act);
    // In duo mode a generated line is a conversation turn — that is the whole
    // point of the mode, and it makes each line one click instead of two.
    if (state.mode === 'duo' && act) {
      if (!state.queue.some(q => q.actorKey === act.key && q.takeId === take.id)) {
        state.queue.push({ actorKey: act.key, takeId: take.id });
      }
      renderQueue();
    }
    renderStats({ ...out.stats, roundTripMs: ms }, ms);
    toast(`Baked ${out.stats.cues} cues · ${out.stats.aligner}` +
      (state.mode === 'duo' ? ` · ${act.label} turn added` : ''), 'ok');
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  } finally {
    state.busy = false;
    busy(false);
  }
}

function renderStats(s, ms) {
  const act = activeActor();
  const dur = act?.sidecar?.metadata?.duration || 0;
  const rows = [
    ['cues', s.cues],
    ['duration', dur.toFixed(2) + 's'],
    ['aligner', s.aligner],
    ['anchor words', s.anchorWords || 0],
    ['wav header repaired', s.headerRepaired ? 'yes' : 'not needed'],
    ['round trip', ms + ' ms'],
  ];
  $('#lsStats').replaceChildren(...rows.map(([k, v]) =>
    el('div.kv', {}, [el('span.k', {}, k), el('span.v.mono', {}, String(v))])));
}

// --------------------------------------------------------------------- fetch
async function streamLine(text, model, voiceId) {
  const body = { text, format: 'wav', __model: model };
  if (voiceId) body.reference_id = voiceId;
  const res = await apiFetch('/api/tts/stream', {
    method: 'POST', raw: true,
    body,
  });
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
      const body2 = t.startsWith('data:') ? t.slice(5).trim() : t;
      if (!body2 || body2 === '[DONE]') continue;
      let evt; try { evt = JSON.parse(body2); } catch { continue; }
      if (evt.type === 'error') throw new Error(evt.body || 'stream error');
      const b64 = evt.audio_base64 || evt.audio || evt.data;
      // Each frame is an independently padded base64 blob — decode separately.
      if (b64) parts.push(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      const al = evt.alignment || (evt.segments ? { segments: evt.segments } : null);
      if (al?.segments?.length) alignment = al;
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (!total) throw new Error('stream returned no audio');
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  fixWavHeader(bytes);
  return { bytes, alignment };
}

// ------------------------------------------------------------------- export
async function exportWav() {
  const t = L.getAudio(activeActor()?.takeId);
  if (!t) { toast('Pick a take from the list first.', 'err'); return; }
  const bytes = t.wavBytes || await L.audioBytes(t);
  downloadBlob(new Blob([bytes], { type: 'audio/wav' }), `${state.baseName}.wav`);
  toast(`Saved ${state.baseName}.wav`, 'ok');
}

function exportJson() {
  const t = L.getAudio(activeActor()?.takeId);
  const sc = t?.sidecar;
  if (!sc) { toast('Nothing baked yet.', 'err'); return; }
  const blob = new Blob([JSON.stringify(sc, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${state.baseName}.visemes.json`);
  toast(`Saved ${state.baseName}.visemes.json`, 'ok');
}

/** Download a specific take's matched pair, named after the take. */
async function exportTake(t) {
  if (!t.sidecar) { toast('No mouth track for that take.', 'err'); return; }
  const safe = (t.name || 'line').replace(/[^\w.-]+/g, '_');
  const bytes = t.wavBytes || await L.audioBytes(t);
  downloadBlob(new Blob([bytes], { type: 'audio/wav' }), `${safe}.wav`);
  downloadBlob(new Blob([JSON.stringify(t.sidecar, null, 2)], { type: 'application/json' }),
    `${safe}.visemes.json`);
  toast(`Saved ${safe}.wav + .visemes.json`, 'ok');
}
