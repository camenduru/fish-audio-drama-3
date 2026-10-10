// vrmcall.js — a VRM avatar you can call.
//
// The Live Call page talks to a Fish agent; this page gives that agent a body.
// The viewer is ChatVRM's, rebuilt here on three.js + @pixiv/three-vrm, and the
// mouth is driven by *this studio's own live call* — the agent's real output
// level from the SDK's analyser — instead of a pre-rendered dialogue clip.
//
// What is borrowed from ChatVRM
//   • lip sync reads a level and drives only the `aa` expression, with a shaping
//     curve (ChatVRM peaks the time-domain samples and pushes them through a
//     sigmoid; here the SDK already hands us a 0–1 level, so the curve is a
//     gamma instead — see shapeMouth)
//   • auto-blink on the `blink` expression, close ~0.12 s, reopen after a few
//     seconds (ChatVRM's BLINK_CLOSE_MAX / BLINK_OPEN_MAX)
//   • the gaze target is an Object3D parented to the camera, so the eyes converge
//     on the viewer and keep following when the camera moves
//   • VRM0 loaded through GLTFLoader + VRMLoaderPlugin, rotateVRM0, then
//     vrm.update(delta) every frame
//
// The idle motion is a real .vrma clip (`web/vrm/idle_loop.vrma`, bundled) played
// on a THREE.AnimationMixer, so the body sways as authored.
//
// Two things measured against this asset and against three-vrm, because both
// obvious assumptions turn out to be wrong:
//
//   • The clip and the gaze do not compete. `VRMLookAtBoneApplier.applyYawPitch`
//     rotates leftEye/rightEye and nothing else — true in 1.0.9 (what ChatVRM
//     pins) and in 3.5.5 (ours). Dropping the clip's head and neck tracks to
//     "protect" the gaze, as this file first did, solved a problem that does not
//     exist and threw away real neck motion.
//   • This clip cannot turn the head anyway. Its `head` channel targets a VRoid
//     node that is not in the file's own humanoid map, and a VRMA only carries
//     humanoid bones — so the loader correctly binds nothing for the head. 22 of
//     the 28 channels survive as tracks (neck, spine, chest, arms, legs, hips);
//     the other 6 target nodes the spec has no way to reach.
//
// What the clip does need is one correction: the loader scales its hips
// translation to this model's hip height but leaves it absolute, so playing it
// as-is slides the body ~15 cm sideways off the origin the camera was framed on —
// the "animation origin is offset" ChatVRM works around by re-framing the camera
// after play. Shifting the track onto this model's rest hips keeps the sway
// (~2.7 cm) and drops the offset.
//
// If the clip is missing the rig falls back to the procedural chest sway it used
// before, so the page never sits stone still. The bundled avatar
// (`web/vrm/AvatarSample_B.vrm`) is the default model — a first visit needs no
// file picker — and both files are served by the studio's own origin.

import { $, el, toast } from './api.js';
import { createAgentCall } from './agentcall.js';
// The expression side — lip sync, emotions, blinking — ported from ChatVRM's
// src/features as one unit. See emote.js for what each piece corresponds to.
import { EmoteController, attachLookAt } from './emote.js';

// ---------------------------------------------------------------------------
// Import specifiers. index.html carries an import map pinning these; keeping the
// bare specifiers means GLTFLoader, three-vrm and the renderer all resolve to the
// SAME three.js module instance (a second copy fails instanceof checks deep inside
// three-vrm, so this is not cosmetic).
// ---------------------------------------------------------------------------
const SPEC = {
  three: 'three',
  gltf: 'three/addons/loaders/GLTFLoader.js',
  orbit: 'three/addons/controls/OrbitControls.js',
  vrm: '@pixiv/three-vrm',
  // The .vrma loader is no longer in three-vrm's core — the plugin that reads the
  // `VRMC_vrm_animation` extension lives in this separate package, which is why
  // the import map carries it too.
  vrmAnim: '@pixiv/three-vrm-animation',
};

// The avatar and its idle clip that ship with the studio.
const DEFAULT_MODEL_URL = '/vrm/AvatarSample_B.vrm';
const DEFAULT_MODEL_NAME = 'AvatarSample_B.vrm';
const DEFAULT_IDLE_URL = '/vrm/idle_loop.vrma';


const DB_NAME = 'fd3.vrm';
const DB_STORE = 'models';
const MODEL_KEY = 'model';
const META_KEY = 'meta';

// ---------------------------------------------------------------------------
// Pure helpers — no DOM, no three. Exported so the headless harness can assert
// the level → mouth mapping directly.
// ---------------------------------------------------------------------------

/**
 * Raw output level (0–1) → mouth openness (0–1).
 *
 * A gamma below 1 lifts quiet speech so a soft consonant still moves the lips,
 * and a floor at 0.03 keeps the mouth fully shut in silence instead of resting
 * slightly parted. `gain` is the per-model fader: VRM mouth shapes differ a lot
 * in how wide `aa` opens, so one global value would be too much for some
 * avatars and too little for others.
 */
export function shapeMouth(level, gain = 1) {
  const lin = Math.min(1, Math.max(0, level) * gain);
  const shaped = Math.pow(lin, 0.6);
  return shaped < 0.03 ? 0 : shaped;
}

/**
 * One smoothing step. Attack is fast and release is slower, so the mouth snaps
 * open on a word onset and closes over a syllable rather than chattering on
 * every frame of the analyser.
 */
export function stepMouth(current, target, dt, { attack = 0.045, release = 0.14 } = {}) {
  const tau = target > current ? attack : release;
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  return current + (target - current) * k;
}

// ---------------------------------------------------------------------------
// IndexedDB: the last model the user added, so a 10 MB VRM does not have to be
// re-picked on every reload. Disposable state, wrapped so a browser with IDB
// disabled still works (it just forgets).
// ---------------------------------------------------------------------------
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key, value) {
  const db = await idb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
async function idbGet(key) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
async function idbClear() {
  const db = await idb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let libs = null;            // { THREE, GLTFLoader, OrbitControls, VRMLoaderPlugin, VRMUtils }
let view = null;
let canvas = null;
let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let vrm = null;
let lookTarget = null;
let raf = null;
let clock = null;
let started = false;
let starting = null;        // promise, so ensureStarted() is idempotent
let loading = false;

let call = null;
let mouthInput = 0;         // 0–1, fed by the call's onLevel
let mouth = 0;              // smoothed mouth value, handed to the emote controller
let emote = null;           // EmoteController for the current model (mouth, blink, emotion)
let frames = 0;
let lastError = null;
let modelMeta = null;       // { name, size, version, expressions, bones, source }
let squaredBy = null;       // largest yaw correction applied to this model, in degrees
let framedTarget = null;    // where the camera looked when the model was framed
let panTmp = null;          // one reusable vector for the pan clamp

// How far a right-drag pan may walk the orbit target from where framing put it. A
// pan has no natural limit, and an avatar dragged out of the scene looks exactly
// like a broken one — with no way back except the Reset camera button.
const PAN_LIMIT = 1.5;

// --- idle clip (web/vrm/idle_loop.vrma) -------------------------------------
let vrmaSource = null;      // the parsed VRMAnimation, fetched once
let mixer = null;           // THREE.AnimationMixer for the current model
let idleAction = null;      // the clip's action on that mixer
let idleMeta = null;        // { name, duration, tracks, hipsOffset, time, playing }
let idleError = null;       // why the clip is not playing, if it is not

const settings = { gain: 1, blink: true, idle: true };

const clamp01 = v => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------------------
// Lazily load three.js + three-vrm (about 900 KB of CDN modules) the first time
// the VRM Call page is actually opened.
// ---------------------------------------------------------------------------
async function loadLibs() {
  if (libs) return libs;
  const [THREE, gltf, orbit, vrmMod, vrmAnimMod] = await Promise.all([
    import(/* @vite-ignore */ SPEC.three),
    import(/* @vite-ignore */ SPEC.gltf),
    import(/* @vite-ignore */ SPEC.orbit),
    import(/* @vite-ignore */ SPEC.vrm),
    import(/* @vite-ignore */ SPEC.vrmAnim),
  ]);
  libs = {
    THREE,
    GLTFLoader: gltf.GLTFLoader,
    OrbitControls: orbit.OrbitControls,
    VRMLoaderPlugin: vrmMod.VRMLoaderPlugin,
    VRMUtils: vrmMod.VRMUtils,
    VRMAnimationLoaderPlugin: vrmAnimMod.VRMAnimationLoaderPlugin,
    createVRMAnimationClip: vrmAnimMod.createVRMAnimationClip,
  };
  return libs;
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------
function makeRenderer() {
  const { THREE } = libs;
  renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 1.2, 1.8);
  scene.add(camera);          // so the gaze target below has a world position

  // The target ChatVRM uses: a node at the camera's own origin.
  lookTarget = new THREE.Object3D();
  camera.add(lookTarget);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x2b3038, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.25);
  key.position.set(1.4, 2.4, 2.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fb4ff, 0.55);
  rim.position.set(-1.6, 1.2, -1.5);
  scene.add(rim);
  const bounce = new THREE.DirectionalLight(0xffd9c4, 0.25);
  bounce.position.set(0, -1, 1.5);
  scene.add(bounce);

  controls = new libs.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Left drag orbits, the wheel zooms, and a right-held drag *moves the avatar*:
  // for an orbit camera, panning is what moving the body in the frame means. It is
  // screen-space, so dragging right slides the avatar right rather than pushing it
  // away from the viewer.
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.minPolarAngle = Math.PI * 0.22;
  controls.maxPolarAngle = Math.PI * 0.62;
  controls.target.set(0, 1.05, 0);
  controls.update();

  clock = new THREE.Clock();
  resize();
  new ResizeObserver(resize).observe(canvas.parentElement || canvas);
}

function resize() {
  if (!renderer || !canvas) return;
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 1;
  const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 1;
  if (w < 2 || h < 2) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function frameCamera() {
  const { THREE } = libs;
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = box.getSize(new THREE.Vector3());
  const h = size.y > 0.2 ? size.y : 1.6;
  const baseY = box.min.y;
  // ChatVRM's framing: fov 30, from the chest up — close enough to read a face,
  // far enough that a talking avatar is not cropped when the head turns.
  //
  // Framed at head level, not full body: this is a talking head shot, and legs cost
  // you half the pixels that should be going to a face.
  //
  // The bounds are *solved*, not guessed, and solved off the rig rather than off
  // fractions of the model's height. The top is the model's real top (which is hair,
  // above the head bone — framing off the bone shaves it) plus a little air; the
  // bottom is just under the neck, so a little shoulder shows. The distance then
  // follows from what a 30° fov can hold (2·d·tan(15°) ≈ 0.536·d).
  const neck = vrm.humanoid?.getRawBoneNode?.('neck');
  const neckY = neck
    ? neck.getWorldPosition(new THREE.Vector3()).y
    : baseY + h * 0.72;                      // no neck bone: fall back to a fraction
  const top = box.max.y + h * 0.02;
  const bottom = Math.min(neckY - h * 0.07, top - h * 0.2);
  const span = top - bottom;
  const targetY = (top + bottom) / 2;
  camera.fov = 30;
  // A narrow panel crops the sides, and shoulders are wider than a head; back off
  // instead of cutting them off. (Aspect is only known once the canvas is laid out,
  // so this is re-applied by Reset camera after a resize.)
  const narrow = camera.aspect < 1.25 ? Math.min(1.35, 1.25 / Math.max(camera.aspect, 0.85)) : 1;
  const dist = (span / (2 * Math.tan((camera.fov * Math.PI / 180) / 2))) * narrow;
  camera.position.set(0, targetY, dist);
  camera.lookAt(0, targetY, 0);
  camera.updateProjectionMatrix();
  controls.target.set(0, targetY, 0);
  // Close enough to read the face, far enough out to pull back to the whole body.
  controls.minDistance = h * 0.35;
  controls.maxDistance = h * 1.6;
  controls.update();
  // Remember where framing put the orbit target: the pan clamp measures from here,
  // and Reset camera puts it back.
  framedTarget = controls.target.clone();
  if (!panTmp) panTmp = new libs.THREE.Vector3();
}

function stopIdle() {
  if (idleAction) { try { idleAction.stop(); } catch {} idleAction = null; }
  if (mixer) {
    try { mixer.stopAllAction(); } catch {}
    try { if (vrm?.scene) mixer.uncacheRoot(vrm.scene); } catch {}
    mixer = null;
  }
  idleMeta = null;
}

/**
 * Fetch and parse the bundled .vrma once. It is a glTF carrying the
 * `VRMC_vrm_animation` extension, which only VRMAnimationLoaderPlugin
 * understands — a plain GLTFLoader parses the file into an empty scene with no
 * animation, which is exactly what "idle_loop.vrma is not playing" looks like.
 */
async function loadIdleSource() {
  if (vrmaSource) return vrmaSource;
  const { GLTFLoader, VRMAnimationLoaderPlugin } = libs;
  const loader = new GLTFLoader();
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.loadAsync(DEFAULT_IDLE_URL);
  const anim = gltf.userData?.vrmAnimations?.[0];
  if (!anim) throw new Error('no VRMC_vrm_animation in the file');
  vrmaSource = anim;
  return anim;
}

/**
 * Build the clip for *this* VRM and start it. A clip is bound to bone nodes, so
 * it is rebuilt on every model load rather than reused.
 */
function applyIdleClip() {
  stopIdle();
  if (!vrmaSource || !vrm?.scene) return;
  const { THREE, createVRMAnimationClip } = libs;
  const clip = createVRMAnimationClip(vrmaSource, vrm);

  // The loader scales the clip's hips translation to this model's hip height but
  // leaves it absolute, so its first key is the source rig's hips position, not
  // this model's. Subtracting that difference (the model's rest hips) leaves the
  // sway — a couple of centimetres — and removes a static sideways offset large
  // enough to walk the avatar out from under the camera's target.
  const hipsName = vrm.humanoid?.getNormalizedBoneNode?.('hips')?.name;
  const rest = vrm.humanoid?.normalizedRestPose?.hips?.position;
  const pos = hipsName ? clip.tracks.find(t => t.name === `${hipsName}.position`) : null;
  let hipsOffset = null;
  if (pos && rest && pos.values.length >= 3) {
    const d = [rest[0] - pos.values[0], rest[1] - pos.values[1], rest[2] - pos.values[2]];
    for (let i = 0; i < pos.values.length; i += 3) {
      pos.values[i] += d[0];
      pos.values[i + 1] += d[1];
      pos.values[i + 2] += d[2];
    }
    hipsOffset = d.map(v => +v.toFixed(4));
  }

  mixer = new THREE.AnimationMixer(vrm.scene);
  idleAction = mixer.clipAction(clip);
  idleAction.play();
  idleAction.paused = !settings.idle;
  idleMeta = {
    name: DEFAULT_IDLE_URL.split('/').pop(),
    duration: +clip.duration.toFixed(3),
    tracks: clip.tracks.length,
    hipsOffset,
    // Names travel with the snapshot so a harness can check which bones the clip
    // can actually reach. Track names are the *normalized* node names, which for a
    // VRoid-modeled VRM are things like `Normalized_J_Bip_C_Neck` — nothing a
    // caller could guess.
    trackNames: clip.tracks.map(t => t.name),
    boneNames: Object.fromEntries(['hips', 'chest', 'head', 'neck', 'leftEye']
      .map(b => [b, vrm.humanoid?.getNormalizedBoneNode?.(b)?.name ?? null])),
  };
  idleError = null;
}

function disposeModel() {
  stopIdle();
  if (vrm) {
    // Detach first: deepDispose frees geometries and materials but leaves the
    // object in the graph, so a second load would render the old avatar under
    // the new one (and double the triangle count).
    try { vrm.scene?.parent?.remove(vrm.scene); } catch {}
    try { libs?.VRMUtils?.deepDispose?.(vrm.scene); } catch {}
  }
  vrm = null;
  modelMeta = null;
  mouth = 0; mouthInput = 0;
  // The controller holds expression weights on the *old* model's manager, so it is
  // dropped with the model rather than left pointing at a disposed one.
  emote = null;
}

async function loadModel(arrayBuffer, meta = {}) {
  if (!libs || !scene) throw new Error('the viewer is not ready yet');
  loading = true;
  try {
    const { GLTFLoader, VRMLoaderPlugin, VRMUtils } = libs;
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(arrayBuffer, '');
    const next = gltf.userData.vrm;
    if (!next) throw new Error('that file has no VRM data (is it a plain glTF or GLB?)');

    // A VRM0 model faces the opposite way to VRM1; this orients it to the camera.
    VRMUtils.rotateVRM0?.(next);
    try { VRMUtils.removeUnnecessaryVertices?.(next.scene); } catch {}
    if (next.scene) {
      next.scene.name = 'VRMRoot';
      // Skinned meshes can be culled by a bounding box that predates skinning,
      // which makes a correctly-loaded avatar vanish at some camera angles.
      next.scene.traverse(o => { o.frustumCulled = false; });
    }

    disposeModel();
    scene.add(next.scene);
    vrm = next;
    // autoLookAt.ts, in effect: the eyes converge on a node parented to the camera.
    attachLookAt(vrm, lookTarget);
    // Expressions are per-model: the controller owns this model's expression
    // manager, picks its mouth preset, and carries the blink toggle's setting.
    emote = new EmoteController(vrm);
    emote.expressionController.autoBlink?.setEnable(settings.blink);

    // The clip drives *this* model's bones, so it is bound here rather than at
    // boot. An idle clip that will not load must not cost the user their avatar:
    // the failure is recorded and the rig keeps its procedural sway.
    try { await loadIdleSource(); applyIdleClip(); }
    catch (e) {
      idleError = e?.message || String(e);
      idleMeta = null;
      console.error('[vrmcall] idle clip failed', e);
    }

    frameCamera();
    squaredBy = 0;             // fresh high-water mark for this model

    const ex = vrm.expressionManager?.expressions?.length ?? 0;
    const bones = Object.keys(vrm.humanoid?.humanBones || {}).length;
    modelMeta = {
      name: meta.name || 'model.vrm',
      size: meta.size || arrayBuffer.byteLength || 0,
      version: String(vrm.meta?.metaVersion ?? vrm.meta?.version ?? '?'),
      expressions: ex,
      bones,
      hasMouth: !!vrm.expressionManager?.getExpression?.('aa'),
      source: meta.source || 'file',
    };
    lastError = null;
    return modelMeta;
  } finally {
    loading = false;
  }
}

// ---------------------------------------------------------------------------
// Rig: what runs each frame on a loaded model.
// ---------------------------------------------------------------------------
function boneNode(name) {
  try { return vrm?.humanoid?.getNormalizedBoneNode?.(name) || null; } catch { return null; }
}

/**
 * Hold the avatar's face square to the front.
 *
 * This pair stands turned: the head's own yaw is ~9.4° off, and the idle clip adds a
 * little more on top. That reads as the avatar not quite looking at you, because it
 * isn't — and the gaze does not save it, since the look-at applier only moves the
 * eyes inside a head that is already facing past your shoulder.
 *
 * Measured every frame on the world and cancelled on the model *root*, so the body
 * keeps its sway, lean and breathing while the facing stays locked. A one-shot fix
 * at load cannot work: three-vrm has not applied any pose yet at that point, so the
 * measurement comes back as a flat 0 and the correction silently does nothing.
 *
 * Squaring the neck alone would be wrong too — the shoulders would stay turned and
 * the head would be twisted on them. The correction is capped so a model that
 * genuinely faces backwards (a VRM0/VRM1 mix-up, which `rotateVRM0` handles) is left
 * alone rather than spun around.
 */
function keepSquareToFront() {
  const T = libs?.THREE;
  const head = vrm?.humanoid?.getRawBoneNode?.('head');
  if (!T || !head || !vrm?.scene) return;
  const fwd = new T.Vector3(0, 0, 1)
    .applyQuaternion(head.getWorldQuaternion(new T.Quaternion()));
  const yawDeg = T.MathUtils.RAD2DEG * Math.atan2(fwd.x, fwd.z);
  if (Math.abs(yawDeg) > 60) return;          // facing away by design, not a pose
  // The world yaw contains the root's own rotation, so subtracting it lands on 0 in
  // one step and cannot stack across frames or model loads.
  vrm.scene.rotation.y -= T.MathUtils.DEG2RAD * yawDeg;
  // High-water mark, not the current value: once the lock has settled the per-frame
  // correction is a hundredth of a degree, which says nothing about whether the
  // model needed squaring in the first place.
  squaredBy = Math.max(squaredBy || 0, Math.abs(+yawDeg.toFixed(2)));
}

/**
 * How far the avatar's face is turned away from the camera, in degrees: 0 is square
 * on. Measured on the ground plane between the head's world forward and the line
 * from the head to the camera, so leaning, nod and the clip's sway do not register
 * as a turn — only yaw does.
 */
function faceGeometry() {
  const T = libs?.THREE;
  const head = vrm?.humanoid?.getRawBoneNode?.('head');
  if (!T || !head || !camera) return null;
  const p = head.getWorldPosition(new T.Vector3());
  const fwd = new T.Vector3(0, 0, 1)
    .applyQuaternion(head.getWorldQuaternion(new T.Quaternion()));
  const toCam = new T.Vector3().subVectors(camera.position, p);
  const flat = (v) => { v.y = 0; return v; };
  if (flat(fwd).lengthSq() < 1e-6 || flat(toCam).lengthSq() < 1e-6) return null;
  const deg = (r) => +(T.MathUtils.RAD2DEG * r).toFixed(2);
  return {
    // 0 = the face is aimed at the camera.
    yaw: deg(fwd.angleTo(toCam)),
    // The face's own yaw in the world, independent of where the camera is: this is
    // the model's rest orientation, and 0 means it faces the front of the scene.
    headYaw: deg(Math.atan2(fwd.x, fwd.z)),
    // Where the head and the camera actually are on the ground plane. A head that
    // is not on the camera's axis reads as a turn even when nothing is turned.
    headX: +p.x.toFixed(3), headZ: +p.z.toFixed(3),
    camX: +camera.position.x.toFixed(3), camZ: +camera.position.z.toFixed(3),
  };
}

function faceYawDeg() {
  return faceGeometry()?.yaw ?? null;
}

/** A normalized bone's local rotation, for the harness snapshot. */
function quatOf(name) {
  const q = boneNode(name)?.quaternion;
  if (!q) return null;
  return { x: +q.x.toFixed(4), y: +q.y.toFixed(4), z: +q.z.toFixed(4), w: +q.w.toFixed(4) };
}

function updateRig(dt, t) {
  const em = vrm?.expressionManager;
  if (!em) return;

  // --- lip sync: level -> shaping -> asymmetric smoothing -> `aa` ------------
  // --- mouth: level → shaping → smoothing → the expression controller ---------
  // `mouth` is the raw 0–1 value; the controller decides the weight it is drawn
  // at (0.5 while neutral, 0.25 under an emotion — ChatVRM's own rule) and picks
  // the preset (`JawOpen` for a perfect-sync model, else `aa`).
  const target = shapeMouth(mouthInput, settings.gain);
  mouth = stepMouth(mouth, target, dt);
  if (mouth < 0.004) mouth = 0;

  // --- blink + expressions, in the controller's own order ---------------------
  // update() runs the blink timer first and applies the mouth weight after, which
  // is the order ChatVRM's ExpressionController::update uses.
  if (emote) {
    emote.lipSync(emote.mouthPreset, mouth);
    emote.update(dt);
  } else {
    try { em.setValue('aa', mouth); } catch {}
  }

  // --- idle: the bundled clip, or the procedural sway if it is unavailable ---
  // The head is left to VRMLookAt, which writes it during vrm.update(); moving it
  // here as well would fight the gaze. Easing toward the target rather than
  // assigning it means switching Idle off settles the pose instead of freezing it
  // mid-lean. With a clip playing this whole block stays out of the way — the
  // mixer poses the body and the two would add up.
  if (!idleAction) {
    const k = 1 - Math.exp(-dt / 0.25);
    const sway = (node, x, z) => {
      if (!node) return;
      node.rotation.x += ((settings.idle ? x : 0) - node.rotation.x) * k;
      node.rotation.z += ((settings.idle ? z : 0) - node.rotation.z) * k;
    };
    sway(boneNode('chest'), Math.sin(t * 1.15 + 0.6) * 0.012, Math.sin(t * 0.9) * 0.014);
    sway(boneNode('spine'), Math.sin(t * 1.15) * 0.008, 0);
    sway(boneNode('hips'), 0, Math.sin(t * 0.7) * 0.008);
  }
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (!renderer) return;
  // Drain the clock on every frame, including skipped ones, so switching back to
  // this page never hands the rig a ten-second delta. The cap is only there to
  // stop a stalled frame from teleporting the animation.
  const dt = Math.min(clock.getDelta(), 0.25);
  const active = view?.classList.contains('active') && !document.hidden;
  if (!active) return;
  if (vrm) {
    updateRig(dt, clock.elapsedTime);
    mixer?.update(dt);         // the idle clip poses the body ...
    vrm.update(dt);            // ... expressions, humanoid, lookAt, spring bones
    // After vrm.update: the raw bones hold this frame's pose, and the scene matrix
    // is rebuilt by the render below, so the correction lands in the same frame.
    keepSquareToFront();
  }
  controls?.update();
  if (controls && framedTarget && panTmp
      && panTmp.copy(controls.target).sub(framedTarget).length() > PAN_LIMIT) {
    controls.target.copy(framedTarget).add(panTmp.setLength(PAN_LIMIT));
  }
  // Drawn even with no model, so removing one actually clears the canvas instead
  // of leaving the last frame frozen on screen.
  renderer.render(scene, camera);
  frames++;
}

// ---------------------------------------------------------------------------
// Model intake: file picker, drag & drop, URL, and remembering the last one.
// ---------------------------------------------------------------------------
function setEmpty(show) {
  const empty = $('#vrmEmpty');
  if (empty) empty.classList.toggle('hidden', !show);
}

function reportModel() {
  const badge = $('#vrmModelBadge');
  if (badge) {
    badge.textContent = modelMeta
      ? `${modelMeta.name} · VRM${modelMeta.version}`
      : 'no model';
    badge.className = 'badge ' + (modelMeta ? 'green' : '');
  }
  const info = $('#vrmModelInfo');
  if (info) {
    info.replaceChildren(
      el('div.kv', {}, [el('span.k', {}, 'File'), el('span.v.mono', { style: 'font-size:11.5px' }, modelMeta?.name || '—')]),
      el('div.kv', {}, [el('span.k', {}, 'Size'), el('span.v', {}, modelMeta ? bytesLabel(modelMeta.size) : '—')]),
      el('div.kv', {}, [el('span.k', {}, 'VRM version'), el('span.v', {}, modelMeta ? modelMeta.version : '—')]),
      el('div.kv', {}, [el('span.k', {}, 'Expressions'), el('span.v', {}, modelMeta ? String(modelMeta.expressions) : '—')]),
      el('div.kv', {}, [el('span.k', {}, 'Human bones'), el('span.v', {}, modelMeta ? String(modelMeta.bones) : '—')]),
      el('div.kv', {}, [el('span.k', {}, 'Mouth shape'), el('span.v', {}, modelMeta ? (modelMeta.hasMouth ? 'aa ✓' : 'aa missing') : '—')]),
      el('div.kv', {}, [el('span.k', {}, 'Idle clip'), el('span.v', { style: 'font-size:11.5px' }, idleMeta
        ? `${idleMeta.name} · ${idleMeta.duration}s · ${idleMeta.tracks} tracks`
        : (idleError ? 'unavailable — procedural sway' : '—'))]),
      el('div.kv', {}, [el('span.k', {}, 'Source'), el('span.v', {}, modelMeta?.source === 'default' ? 'bundled' : (modelMeta?.source || '—'))]),
    );
  }
  setEmpty(!modelMeta);
}

function bytesLabel(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}

async function acceptModel(arrayBuffer, meta, { persist = true } = {}) {
  try {
    await loadModel(arrayBuffer, meta);
    reportModel();
    if (persist) {
      try { await idbPut(MODEL_KEY, arrayBuffer); await idbPut(META_KEY, { ...modelMeta }); }
      catch { /* private mode / quota — the model still works this session */ }
    }
    toast(`Loaded ${modelMeta.name}.`, 'ok');
  } catch (e) {
    lastError = { stage: 'load', message: e?.message || String(e) };
    console.error('[vrmcall] model load failed', e);
    toast('Could not load that model: ' + (e?.message || e), 'err');
    reportModel();
  }
}

async function loadFromBlob(blob, name, opts) {
  const buf = await blob.arrayBuffer();
  // A file can be dropped the instant the page opens; make sure three.js is up.
  await ensureStarted();
  await acceptModel(buf, { name, size: blob.size, source: 'file' }, opts);
}

/**
 * The avatar that ships with the studio: a first visit has a body without a file
 * picker. It is never written to IndexedDB — the file is already on disk, so a
 * 6.5 MB copy in the browser's quota buys nothing.
 */
async function loadDefaultModel() {
  try {
    const res = await fetch(DEFAULT_MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    await acceptModel(buf, { name: DEFAULT_MODEL_NAME, size: buf.byteLength, source: 'default' }, { persist: false });
  } catch (e) {
    lastError = { stage: 'default', message: e?.message || String(e) };
    console.error('[vrmcall] default model failed', e);
    // Nothing to show: fall back to the "add a model" empty state, which is the
    // only honest thing left.
    reportModel();
  }
}

async function loadFromUrl(url) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const name = decodeURIComponent((url.split('/').pop() || 'model.vrm').split('?')[0]);
    // A URL is a reference, not an upload: fetch it every time rather than
    // silently keeping a copy of someone else's model.
    await loadFromBlob(blob, name, { persist: false });
  } catch (e) {
    toast('Could not fetch that URL (CORS or 404): ' + (e?.message || e), 'err');
  }
}

// ---------------------------------------------------------------------------
// Boot the viewer + the call when the page is first opened.
// ---------------------------------------------------------------------------
async function ensureStarted() {
  if (started) return;
  if (starting) return starting;
  starting = (async () => {
    view = $('#view-vrmcall');
    canvas = $('#vrmCanvas');
    if (!view || !canvas) return;
    try {
      await loadLibs();
      makeRenderer();
      started = true;
      loop();
      // The bundled avatar is the default, so a first visit needs no file
      // picker and the stage is never empty. A model the user picked last
      // session still wins — their avatar is not silently replaced by ours.
      try {
        const buf = await idbGet(MODEL_KEY);
        const meta = await idbGet(META_KEY);
        if (buf) await acceptModel(buf, { ...(meta || {}), source: 'restore' }, { persist: false });
        else await loadDefaultModel();
      } catch { await loadDefaultModel(); }
    } catch (e) {
      lastError = { stage: 'init', message: e?.message || String(e) };
      console.error('[vrmcall] viewer failed to start', e);
      const empty = $('#vrmEmpty');
      if (empty) empty.replaceChildren(el('div.big', {}, '⚠'), el('div', {}, 'Could not start the 3D viewer'), el('div.hint', {}, e?.message || String(e)));
      // A CDN hiccup must not poison the page for the rest of the session —
      // reopening the view (or loading a file) retries the boot.
      starting = null;
    }
  })();
  return starting;
}

function openIfActive() {
  if (!$('#view-vrmcall')?.classList.contains('active')) return;
  ensureStarted();
  // The agent dropdown is filled at init like the Call page's, but a page opened
  // after a failed first fetch (or before the server had a key) would otherwise sit
  // empty until the user happened to focus the select. Opening the page retries.
  if (!call?.hasAgents()) call?.loadAgents();
}

// ---------------------------------------------------------------------------
export function initVrmCall() {
  // The call is the same object the Live Call page uses, bound to `vrm*` ids.
  call = createAgentCall({
    id: 'vrm',
    storeKey: 'lastAgentVrm',
    tagLabel: 'the message box',
    onLevel: level => { mouthInput = clamp01(level); },
    onMode: mode => { $('#vrmStage')?.classList.toggle('speaking', mode === 'speaking'); },
    onEnd: () => { mouthInput = 0; $('#vrmStage')?.classList.remove('speaking'); },
    snapshotExtra: () => ({
      model: modelMeta
        ? { loaded: true, name: modelMeta.name, version: modelMeta.version, expressions: modelMeta.expressions, bones: modelMeta.bones, source: modelMeta.source }
        : { loaded: false },
      mouth: +mouth.toFixed(3),
      mouthInput: +mouthInput.toFixed(3),
      // What the VRM itself is holding, so a probe can tell an internal number
      // from the value that actually reaches the avatar. `mouthExpr` is the weight
      // the controller actually wrote, which is `mouth` scaled by the emotion —
      // reading the preset back proves the scaling happened, not just the maths.
      aaExpr: emote?.mouthWeight ?? null,
      mouthExpr: emote?.mouthWeight ?? null,
      mouthPreset: emote?.mouthPreset ?? null,
      emotion: emote?.emotion ?? null,
      blinkExpr: emote?.blinkWeight ?? null,
      blinks: emote?.blinkCount ?? 0,
      frames,
      loadingModel: loading,
      triangles: renderer?.info?.render?.triangles ?? 0,
      gain: settings.gain,
      blink: settings.blink,
      idle: settings.idle,
      // The idle clip on the wire: a probe can tell "the animation is playing"
      // from "the mixer exists" by reading `time` twice.
      idleClip: idleAction
        ? { ...idleMeta, time: +idleAction.time.toFixed(3), playing: !idleAction.paused,
            weight: idleAction.getEffectiveWeight ? idleAction.getEffectiveWeight() : 1 }
        : { loaded: false, error: idleError },
      // Bones the harness can watch: `chest` and `head` move only if the idle clip
      // is actually posing the body, and `eye` moves only if the gaze is still
      // converging — the applier writes the eyes and nothing else.
      head: quatOf('head'),
      chest: quatOf('chest'),
      // 0° means the face is square to the camera — the number to watch when a
      // model (or its idle clip) leaves the avatar standing slightly turned.
      faceYaw: faceYawDeg(),
      face: faceGeometry(),
      squaredBy: squaredBy,
      eye: quatOf('leftEye'),
      eyeRaw: (() => {
        const q = vrm?.humanoid?.getRawBoneNode?.('leftEye')?.quaternion;
        return q ? { x: +q.x.toFixed(4), y: +q.y.toFixed(4), z: +q.z.toFixed(4), w: +q.w.toFixed(4) } : null;
      })(),
      lastModelError: lastError,
    }),
  });
  call.init();
  window.__vrmcall = () => call.snapshot();

  // Harness seam. A real call needs an API key and a microphone, so the UI probes
  // cannot make the agent speak on their own. `feed` injects an output level on
  // the exact wire the call uses, so the mouth path can be verified end to end
  // (and it is the only way to see the mouth move without a live call).
  window.__vrmcall.feed = level => { mouthInput = clamp01(Number(level) || 0); return +mouth.toFixed(3); };

  // The same seam for the expression side. The agent transport carries no emotion
  // — ChatVRM reads one out of an LLM screenplay field, and the Fish agent runtime
  // exposes no equivalent — so an emotion can only be set from here or from code
  // that already knows the mood. It is not decoration: the mouth weight depends on
  // it, which is what makes it worth being able to drive.
  window.__vrmcall.emote = preset => {
    emote?.playEmotion(preset || 'neutral');
    return emote?.emotion ?? null;
  };

  // And the transcript, for the same reason: the order it lays turns out in is a
  // contract (newest on top), and no probe can start a call to observe it.
  window.__vrmcall.bubble = (role, text, id) => call?.bubble?.(role, text, id) ?? null;

  // ---- model intake --------------------------------------------------------
  for (const id of ['vrmPick', 'vrmPick2']) {
    $('#' + id)?.addEventListener('click', e => { e.stopPropagation(); $('#vrmFile')?.click(); });
  }
  $('#vrmFile')?.addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) loadFromBlob(f, f.name);
    e.target.value = '';
  });
  $('#vrmLoadUrl')?.addEventListener('click', () => {
    const url = $('#vrmUrl')?.value.trim();
    if (!url) { toast('Paste a VRM URL first.', 'err'); return; }
    loadFromUrl(url);
  });

  const stage = $('#vrmStage');
  if (stage) {
    // With no model loaded the stage is a big "click to add one" target; with a
    // model loaded the click belongs to OrbitControls.
    stage.addEventListener('click', e => {
      if (!modelMeta && !e.target.closest('button')) $('#vrmFile')?.click();
    });
    stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('drag'); });
    stage.addEventListener('dragleave', e => { if (e.target === stage) stage.classList.remove('drag'); });
    stage.addEventListener('drop', e => {
      e.preventDefault();
      stage.classList.remove('drag');
      const f = e.dataTransfer?.files?.[0];
      if (f) loadFromBlob(f, f.name);
    });
  }

  $('#vrmClear')?.addEventListener('click', async () => {
    // "Remove" means "remove *my* model", not "leave the page blank": the
    // bundled avatar comes back, so the stage is never left without a body.
    try { await idbClear(); } catch {}
    await loadDefaultModel();
    toast('Model removed — back to the bundled avatar.', '');
  });

  // ---- viewer controls -----------------------------------------------------
  const gain = $('#vrmGain');
  gain?.addEventListener('input', () => {
    settings.gain = Number(gain.value);
    const lbl = $('#vrmGainVal'); if (lbl) lbl.textContent = settings.gain.toFixed(2) + '×';
  });
  const blink = $('#vrmBlink');
  blink?.addEventListener('change', () => {
    settings.blink = blink.checked;
    // ChatVRM's setEnable: turning auto-blink off leaves the eyes open (and lets a
    // closed lid finish its 0.12 s first).
    emote?.expressionController.autoBlink?.setEnable(settings.blink);
  });
  const idle = $('#vrmIdle');
  idle?.addEventListener('change', () => {
    settings.idle = idle.checked;
    if (idleAction) idleAction.paused = !settings.idle;
  });
  $('#vrmResetCam')?.addEventListener('click', () => { if (vrm) frameCamera(); });
  $('#vrmBlinkNow')?.addEventListener('click', () => emote?.blinkNow());

  // Opening the page is what pulls in three.js and the last model.
  const viewEl = $('#view-vrmcall');
  if (viewEl) new MutationObserver(openIfActive).observe(viewEl, { attributes: true, attributeFilter: ['class'] });
  openIfActive();
}

export { ensureStarted };
