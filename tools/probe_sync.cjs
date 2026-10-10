#!/usr/bin/env node
/**
 * probe_sync.cjs — does the mouth land on the words?
 *
 * Runs the app's real path end to end — stream TTS, assemble the WAV, POST
 * /api/visemes WITH the Fish anchors, exactly as web/js/lipsync.js::bakeInto
 * does — and then measures the one thing the user actually sees:
 *
 *   for every word the TTS told us about, is there a mouth shape under it,
 *   and is the mouth shut (X) while somebody is talking?
 *
 * compare_bakers.py covers the same ground offline, against a tracked fixture
 * and without needing the server. This probe is the live, anchored one.
 *
 * Usage:
 *   node tools/probe_sync.cjs [--text "..."] [--voice <id>] [--endpoint URL]
 *                             [--aligner auto|whisper|...] [--save]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = name => argv.includes(`--${name}`);

const ENDPOINT = opt('endpoint', 'http://127.0.0.1:8756');
const TEXT = opt('text', 'The old lamp still flickers. Nobody has lit it in years.');
const VOICE = opt('voice', '1621cae243064f63989bcccd240004b5'); // Happy Girl
const ALIGNER = opt('aligner', 'auto');
const SAVE = flag('save');

// ------------------------------------------------------------------ helpers
function tag(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** Read the real facts out of a RIFF header instead of trusting a comment. */
function wavFacts(bytes) {
  const b = bytes;
  if (tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WAVE') return { ok: false, why: 'not RIFF/WAVE' };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12, fmt = null, dataLen = 0, dataOff = 0;
  while (off + 8 <= b.length) {
    const cid = tag(b, off);
    const sz = dv.getUint32(off + 4, true);
    if (cid === 'fmt ') {
      fmt = {
        audioFormat: dv.getUint16(off + 8, true),
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        byteRate: dv.getUint32(off + 16, true),
        bitsPerSample: dv.getUint16(off + 22, true),
      };
    } else if (cid === 'data') {
      dataLen = sz; dataOff = off + 8;
      break;
    }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt) return { ok: false, why: 'no fmt chunk' };
  const bytesPerFrame = (fmt.bitsPerSample / 8) * fmt.channels;
  const frames = bytesPerFrame ? Math.floor(dataLen / bytesPerFrame) : 0;
  return {
    ok: true, ...fmt, dataLen, dataOff,
    frames,
    declaredDuration: fmt.sampleRate ? frames / fmt.sampleRate : 0,
    // does the data chunk actually fit inside the file?
    fits: dataOff + dataLen <= b.length,
    trailing: b.length - (dataOff + dataLen),
  };
}

/** The app's own fixWavHeader (web/js/audio.js) — keep byte-identical. */
function fixWavHeader(bytes) {
  const b = bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WAVE') return b;
  let off = 12;
  while (off + 8 <= b.length) {
    const cid = tag(b, off);
    const sz = dv.getUint32(off + 4, true);
    if (cid === 'data') { dv.setUint32(off + 4, b.length - (off + 8), true); break; }
    off += 8 + sz + (sz & 1);
  }
  dv.setUint32(4, b.length - 8, true);
  return b;
}

// ------------------------------------------------------- 1. stream the line
async function streamLine(text, voice) {
  const body = { text, format: 'wav', __model: undefined };
  if (voice) body.reference_id = voice;
  const res = await fetch(`${ENDPOINT}/api/tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`tts/stream ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', alignment = null, rawParts = [], rawBytes = 0, evts = 0;
  const types = {};
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
      evts++;
      types[evt.type || '(none)'] = (types[evt.type || '(none)'] || 0) + 1;
      if (evt.type === 'error') throw new Error(`stream error: ${evt.body}`);
      const b64 = evt.audio_base64 || evt.audio || evt.data;
      if (b64) {
        const part = Uint8Array.from(Buffer.from(b64, 'base64'));
        rawParts.push(part); rawBytes += part.length;
      }
      const al = evt.alignment || (evt.segments ? { segments: evt.segments } : null);
      if (al?.segments?.length) alignment = al;
    }
  }
  // The app concatenates the frames then repairs the header.
  const bytes = new Uint8Array(rawBytes);
  let off = 0;
  for (const p of rawParts) { bytes.set(p, off); off += p.length; }
  const before = wavFacts(bytes);
  fixWavHeader(bytes);
  const after = wavFacts(bytes);
  return { bytes, alignment, rawBytes, parts: rawParts.length, evts, types, before, after };
}

// ------------------------------------------------- 2. bake, exactly like app
async function bake(bytes, text, alignment, aligner) {
  const fd = new FormData();
  fd.append('wav', new Blob([bytes], { type: 'audio/wav' }), 'line.wav');
  fd.append('text', text);
  if (alignment?.segments?.length) fd.append('anchors', JSON.stringify(alignment));
  fd.append('aligner', aligner);
  const res = await fetch(`${ENDPOINT}/api/visemes`, { method: 'POST', body: fd });
  const out = await res.json();
  if (out.error) throw new Error(`bake: ${out.error}`);
  return out;
}

// ------------------------------------------------------------- 3. the verdict
function analyse(sidecar, alignment, facts) {
  const cues = (sidecar.mouthCues || []).slice()
    .sort((a, b) => a.start - b.start);
  const shapeAt = t => {
    for (const c of cues) if (t >= c.start && t < c.end) return c.value;
    return '(gap)';
  };

  // duration the baker believes in, vs the duration the WAV really has
  const meta = sidecar.metadata || {};
  const realDur = facts.ok ? facts.declaredDuration : 0;

  const segs = alignment?.segments || [];
  const words = [];
  for (const s of segs) {
    // whisper-style nests words[]; fish-style is flat
    if (Array.isArray(s.words)) for (const w of s.words) words.push(w);
    else if (s.start != null) words.push(s);
  }

  let voicedShut = 0, shutTime = 0, voicedTime = 0;
  const bad = [];
  for (const w of words) {
    const a = Number(w.start), b = Number(w.end);
    if (!(b > a)) continue;
    voicedTime += b - a;
    // sample the middle 60% of the word so a 1-frame boundary isn't a "fail"
    const pad = (b - a) * 0.2;
    const s0 = a + pad, s1 = b - pad;
    let shut = 0, n = 0;
    for (let t = s0; t < s1; t += 0.01) { n++; if (shapeAt(t) === 'X') shut++; }
    if (n && shut / n > 0.5) {
      voicedShut++; shutTime += (b - a);
      bad.push({ word: w.text || w.word, start: +a.toFixed(2), end: +b.toFixed(2), shutPct: Math.round(100 * shut / n) });
    }
  }

  // X cues that sit inside speech (the "closed in the wrong place" symptom)
  const xInside = cues.filter(c => String(c.value).toUpperCase() === 'X' &&
    words.some(w => c.start >= Number(w.start) + 0.02 && c.end <= Number(w.end) - 0.02));

  const shapes = {};
  for (const c of cues) { const v = String(c.value).toUpperCase(); shapes[v] = (shapes[v] || 0) + 1; }

  return { cues, words, realDur, metaDur: meta.duration, shapes, words: words.length,
           voicedShut, shutTime, voicedTime, bad, xInside, shapeAt };
}

(async () => {
  console.log(`\n=== probe_sync  ${ENDPOINT}`);
  console.log(`text    : ${TEXT}`);
  console.log(`voice   : ${VOICE}`);
  console.log(`aligner : ${ALIGNER}\n`);

  const s = await streamLine(TEXT, VOICE);
  console.log(`stream  : ${s.evts} events ${JSON.stringify(s.types)}, ${s.parts} audio frame(s), ${s.rawBytes} bytes`);
  console.log(`wav hdr : BEFORE repair ${JSON.stringify(s.before)}`);
  console.log(`wav hdr : AFTER  repair ${JSON.stringify(s.after)}`);
  if (!s.after.ok) { console.log('\nFAIL — the streamed bytes are not a WAV the baker can read.'); process.exit(1); }

  if (s.alignment) {
    const segs = s.alignment.segments || [];
    const flat = segs.flatMap(x => Array.isArray(x.words) ? x.words : [x]);
    const last = flat.length ? Math.max(...flat.map(w => Number(w.end))) : 0;
    console.log(`anchors : ${segs.length} segment(s), ${flat.length} word(s), last end ${last.toFixed(3)}s, audio_duration ${s.alignment.audio_duration}`);
    console.log(`DRIFT   : wav says ${s.after.declaredDuration.toFixed(3)}s, anchors say ${last.toFixed(3)}s  →  ${(last - s.after.declaredDuration).toFixed(3)}s`);
  } else {
    console.log('anchors : NONE — the app would bake WITHOUT anchors (aligner-only path)');
  }

  const out = await bake(s.bytes, TEXT, s.alignment, ALIGNER);
  const a = analyse(out.sidecar, s.alignment, s.after);

  console.log(`\nbake    : ${a.cues.length} cues, ${JSON.stringify(a.shapes)}, metadata.duration ${a.metaDur}`);
  console.log(`timeline: ${a.cues.slice(0, 14).map(c => `${c.value}:${c.start}-${c.end}`).join('  ')}${a.cues.length > 14 ? '  …' : ''}`);

  if (a.words) {
    console.log(`\nwords   : ${a.words} word(s), ${a.voicedTime.toFixed(2)}s of speech`);
    console.log(`mismatch: ${a.voicedShut} word(s) have the mouth SHUT through the middle of them (${a.shutTime.toFixed(2)}s)`);
    if (a.bad.length) {
      for (const w of a.bad.slice(0, 12)) console.log(`   ✗ "${w.word}" ${w.start}-${w.end}s shut ${w.shutPct}%`);
      if (a.bad.length > 12) console.log(`   … and ${a.bad.length - 12} more`);
    }
    console.log(`X-in-word: ${a.xInside.length} X cue(s) sit fully inside a word`);
    for (const c of a.xInside.slice(0, 8)) console.log(`   ✗ X ${c.start}-${c.end}s inside speech`);
  }

  if (SAVE) {
    const dir = path.join(ROOT, 'data', 'probe');
    fs.writeFileSync(path.join(dir, 'sync.wav'), Buffer.from(s.bytes));
    fs.writeFileSync(path.join(dir, 'sync.sidecar.json'), JSON.stringify(out.sidecar, null, 2));
    if (s.alignment) fs.writeFileSync(path.join(dir, 'sync.anchors.json'), JSON.stringify(s.alignment, null, 2));
    console.log(`\nsaved   : data/probe/sync.wav + sync.sidecar.json${s.alignment ? ' + sync.anchors.json' : ''}`);
  }

  const bad = a.voicedShut > 0 || a.xInside.length > 0;
  console.log(`\n${bad ? 'FAIL' : 'PASS'} — mouth tracks the words: ${bad ? 'NO' : 'yes'}\n`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('\nERROR', e.message); process.exit(2); });
