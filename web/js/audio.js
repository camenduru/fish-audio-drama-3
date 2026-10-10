// audio.js — decode, stitch, slice and encode audio in the browser (WebAudio)

let ctx = null;
export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

export async function decode(blob) {
  const buf = await blob.arrayBuffer();
  return audioCtx().decodeAudioData(buf.slice(0));
}

/** Concatenate AudioBuffers into one, with an optional gap of silence (s). */
export function concat(buffers, gapSeconds = 0.12) {
  const rate = buffers[0].sampleRate;
  const gap = Math.round(gapSeconds * rate);
  const channels = Math.max(...buffers.map(b => b.numberOfChannels));
  const total = buffers.reduce((n, b) => n + b.length, 0) + gap * Math.max(0, buffers.length - 1);
  const out = audioCtx().createBuffer(channels, total, rate);
  let off = 0;
  buffers.forEach((b, i) => {
    for (let c = 0; c < channels; c++) {
      const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      out.getChannelData(c).set(src, off);
    }
    off += b.length;
    if (i < buffers.length - 1) off += gap;
  });
  return out;
}

/** Cut [start,end] seconds out of a buffer. */
export function slice(buffer, startSec, endSec) {
  const rate = buffer.sampleRate;
  const a = Math.max(0, Math.round(startSec * rate));
  const b = Math.min(buffer.length, Math.round(endSec * rate));
  const out = audioCtx().createBuffer(buffer.numberOfChannels, Math.max(1, b - a), rate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.getChannelData(c).set(buffer.getChannelData(c).subarray(a, b));
  }
  return out;
}

/** Splice `patch` into `base` over [start,end]. */
export function splice(base, patch, startSec, endSec) {
  const before = slice(base, 0, startSec);
  const after = slice(base, endSec, base.duration);
  return concat([before, patch, after], 0);
}

export function toWav(buffer) {
  const ch = buffer.numberOfChannels, rate = buffer.sampleRate, len = buffer.length;
  const bytes = 44 + len * ch * 2;
  const ab = new ArrayBuffer(bytes);
  const view = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4, bytes - 8, true); ws(8, 'WAVE');
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, ch, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, len * ch * 2, true);
  let o = 44;
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
    let s = Math.max(-1, Math.min(1, chans[c][i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** Peak array for a waveform strip. */
export function peaks(buffer, n = 160) {
  const data = buffer.getChannelData(0);
  const step = Math.floor(data.length / n) || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    let max = 0;
    for (let j = i * step; j < (i + 1) * step && j < data.length; j++) max = Math.max(max, Math.abs(data[j]));
    out.push(max);
  }
  const top = Math.max(...out, 0.001);
  return out.map(v => v / top);
}

/** Render a peaks array into a .wave container. */
export function drawWave(container, pk, progress = -1) {
  container.replaceChildren(...pk.map((v, i) => {
    const bar = document.createElement('i');
    bar.style.height = Math.max(4, v * 100) + '%';
    if (progress >= 0) bar.style.opacity = (i / pk.length) <= progress ? '1' : '.32';
    return bar;
  }));
}

// ---------------------------------------------------------------------------
// Single shared preview player — one sample at a time across the whole app.
// ---------------------------------------------------------------------------
let previewEl = null;
let previewKey = null;
let previewCb = null;

/** Toggle a preview. Returns true if it started, false if it stopped. */
export function playPreview(url, key, onState) {
  if (!previewEl) previewEl = new Audio();
  const el0 = previewEl;
  if (key && previewKey === key && !el0.paused) { el0.pause(); previewKey = null; previewCb?.(false); return false; }
  el0.pause();
  previewKey = key || url;
  previewCb = onState;
  el0.src = url;
  el0.onended = () => { previewKey = null; previewCb?.(false); };
  el0.onerror = () => { previewKey = null; previewCb?.(false); };
  el0.play().then(() => previewCb?.(true)).catch(() => { previewKey = null; previewCb?.(false); });
  return true;
}

export function stopPreview() {
  if (previewEl) previewEl.pause();
  previewKey = null; previewCb?.(false);
}

export function isPlaying(key) { return previewKey === key && previewEl && !previewEl.paused; }

/**
 * Rewrite a WAV's RIFF/data size fields in place.
 *
 * Fish's streaming endpoint writes a placeholder data size (0xFFFFFC00) into
 * the first frame, because the total is unknown when that frame is emitted - so
 * a streamed WAV declares ~48695s. Players tolerate it; anything that trusts the
 * header (openfacefx, DAWs, the viseme baker) does not.
 */
export function fixWavHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return b;
  let off = 12;
  while (off + 8 <= b.length) {
    const cid = tag(off);
    const sz = dv.getUint32(off + 4, true);
    if (cid === 'data') {
      dv.setUint32(off + 4, b.length - (off + 8), true);
      break;
    }
    off += 8 + sz + (sz & 1);
  }
  dv.setUint32(4, b.length - 8, true);
  return b;
}

/**
 * Guarantee PCM WAV bytes.
 *
 * The viseme baker reads the RIFF header and the raw sample frames, so a take
 * the Studio rendered as mp3/opus has to be decoded and re-encoded first.
 * Anything already RIFF/WAVE passes straight through untouched.
 */
export async function ensureWav(bytesOrBlob) {
  const blob = bytesOrBlob instanceof Blob
    ? bytesOrBlob
    : new Blob([bytesOrBlob], { type: 'audio/wav' });
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const isRiff = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
  if (isRiff) {
    const b = new Uint8Array(await blob.arrayBuffer());
    return fixWavHeader(b);
  }
  const decoded = await decode(blob);            // WebAudio handles mp3/opus/aac
  const wav = await toWav(decoded).arrayBuffer();
  return new Uint8Array(wav);
}
