// library.js — the session's audio library, shared by every view.
//
// The Studio pushes each take it renders here; the Lip Sync page reads it so
// any line the app has already generated can be picked and auto-baked into a
// viseme track instead of being re-typed and re-synthesised.
//
// Deliberately session-scoped and in-memory. Blobs cannot round-trip through
// localStorage, and a take whose bytes are gone is worse than no take at all —
// so the list resets with the page, exactly like the Studio's own take list.
//
// A take grows in two stages:
//   1. addAudio()   — bytes exist, playable, no mouth track yet
//   2. setSidecar() — the viseme bake landed; the face can drive it
// `sidecar` being null is the signal for the Lip Sync page to auto-bake.

const takes = [];
let seq = 0;
const subs = new Set();

function notify() {
  for (const fn of subs) {
    try { fn(takes); } catch (e) { console.error('library subscriber failed', e); }
  }
}

/** Register a freshly generated line. Returns the stored record. */
export function addAudio({ bytes, blob, text, model, ms, meta, source, name }) {
  let b = blob;
  if (!b) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    b = new Blob([arr], { type: 'audio/wav' });
  }
  seq += 1;
  const take = {
    id: 'a' + seq,
    name: name || `Line ${seq}`,
    blob: b,
    url: URL.createObjectURL(b),
    text: text || '',
    model: model || '',
    ms: ms || 0,
    meta: meta || {},
    source: source || 'studio',
    sidecar: null,
    bakeStats: null,
    created: Date.now(),
  };
  takes.unshift(take);
  notify();
  return take;
}

/** Attach the baked mouth track (or an error) to a take. */
export function setSidecar(id, sidecar, stats, error) {
  const t = takes.find(x => x.id === id);
  if (!t) return null;
  if (sidecar) t.sidecar = sidecar;
  if (stats) t.bakeStats = stats;
  if (error) t.bakeError = error;
  notify();
  return t;
}

export function listAudio() { return takes.slice(); }
export function getAudio(id) { return takes.find(t => t.id === id) || null; }
export function countAudio() { return takes.length; }

/** Drop one take (and release its blob URL). */
export function removeAudio(id) {
  const i = takes.findIndex(t => t.id === id);
  if (i < 0) return false;
  const [t] = takes.splice(i, 1);
  try { URL.revokeObjectURL(t.url); } catch {}
  notify();
  return true;
}

export function clearAudio() {
  for (const t of takes) { try { URL.revokeObjectURL(t.url); } catch {} }
  takes.length = 0;
  notify();
}

/** Subscribe to add/update events. Returns an unsubscribe function. */
export function onAudioChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** Raw WAV bytes for a take — the Studio's takes never had them extracted. */
export async function audioBytes(take) {
  if (take.bytes) return take.bytes;
  take.bytes = new Uint8Array(await take.blob.arrayBuffer());
  return take.bytes;
}
