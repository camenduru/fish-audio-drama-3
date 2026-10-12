/**
 * The bake endpoint's response contract.
 *
 * `POST /api/visemes` takes a WAV and returns the viseme sidecar. It used to
 * also echo the repaired WAV back as `wav_base64`. Base64 costs 4/3 the bytes,
 * and a hosted deploy caps the RESPONSE at 4.5 MB exactly as it caps the
 * request — so a line that fit the advertised 4.4 MB upload limit produced a
 * ~5.9 MB response, over the cap. The real ceiling was 4.5 / (4/3) ≈ 3.38 MB of
 * audio (~40 s at 44.1 kHz/16-bit mono), and the failure named nothing.
 *
 * The echo is gone (the browser repairs its own header; see
 * tools/verify_wav_repair.cjs for the byte-equality proof). This file asserts
 * the property that makes the fix real: THE RESPONSE DOES NOT GROW WITH THE
 * AUDIO. A contract test on the shape alone would still pass if someone
 * re-added the field under a different name, so the sizes are measured at two
 * very different input lengths and compared.
 *
 * Needs the local baker (numpy + openfacefx) but NO Fish API credit — nothing
 * here calls upstream.
 *
 *     node tools/verify_bake_contract.cjs
 *     APP_URL=http://127.0.0.1:8757 node tools/verify_bake_contract.cjs
 */
const fs = require('fs');
const path = require('path');
const { apiCookie } = require('./session.cjs');
const { serverRepair } = require('./verify_wav_repair.cjs');

const BASE = process.env.APP_URL || 'http://127.0.0.1:8756';
const FIXTURE = path.join(__dirname, 'fixtures', 'speech.wav');

const TEXT = 'The quick brown fox jumps over the lazy dog.';

async function bake(cookie, wav) {
  const fd = new FormData();
  fd.append('wav', new Blob([wav], { type: 'audio/wav' }), 'line.wav');
  fd.append('text', TEXT);
  fd.append('aligner', 'auto');
  const res = await fetch(BASE + '/api/visemes', {
    method: 'POST',
    headers: cookie ? { cookie } : {},
    body: fd,
  });
  const raw = Buffer.from(await res.arrayBuffer());
  let body = null;
  try { body = JSON.parse(raw.toString('utf8')); } catch {}
  return {
    status: res.status,
    bytes: raw.length,
    declared: Number(res.headers.get('content-length') || 0),
    body,
    keys: body ? Object.keys(body) : [],
  };
}

(async () => {
  let pass = 0, fail = 0;
  const check = (n, ok, d) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  — ' + d : ''));
    ok ? pass++ : fail++;
  };

  const cookie = await apiCookie(BASE);
  const full = fs.readFileSync(FIXTURE);

  // A much shorter clip from the same recording. Truncating 16-bit mono mid-file
  // is fine once the header declares the new length — which is the same repair
  // the browser does.
  const shortRaw = full.subarray(0, 128000);
  const short = serverRepair(shortRaw);

  const big = await bake(cookie, full);
  const small = await bake(cookie, short);

  check('the bake succeeded for both lengths',
    big.status === 200 && small.status === 200,
    `${big.status} (${full.length} B in) · ${small.status} (${short.length} B in)`);

  check('the sidecar is present and carries mouth cues',
    !!big.body?.sidecar && (big.body.sidecar.mouthCues || []).length >= 3,
    `${(big.body?.sidecar?.mouthCues || []).length} cues · duration ${big.body?.sidecar?.metadata?.duration}s`);

  check('the response carries no audio back',
    !big.keys.some(k => /wav|audio|base64|pcm|samples/i.test(k)),
    `keys=[${big.keys.sort().join(',')}]`);

  check('the response is sidecar-sized, not audio-sized',
    big.bytes > 0 && big.bytes < 64 * 1024 && big.bytes < full.length / 100,
    `${big.bytes} B out for ${full.length} B in (${(full.length / big.bytes).toFixed(0)}x smaller); ` +
    `a base64 echo alone would be ${Math.ceil(full.length / 3) * 4} B`);

  // The real assertion. If the audio came back in any form, the 380 KB
  // difference between the two inputs would show up as ~506 KB of response.
  const grew = big.bytes - small.bytes;
  check('the response does not grow with the audio (flat in clip length)',
    grew < 8192,
    `${small.bytes} B for ${short.length} B in  vs  ${big.bytes} B for ${full.length} B in  ` +
    `(grew ${grew} B; an echo would have grown ~${Math.round((full.length - short.length) * 4 / 3)} B)`);

  check('content-length matches the body actually sent',
    big.declared === big.bytes && small.declared === small.bytes,
    `declared ${big.declared}/${small.declared}, sent ${big.bytes}/${small.bytes}`);

  console.log(`\nSUMMARY: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
