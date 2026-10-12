// probe_preview_audio.cjs — does the ▶ preview actually use the voice?
//
// The complaint this answers: "the sample for my voice doesn't sound like my
// voice — did you use generic audio?". That is a testable claim, and it is not
// answered by looking at the code, because the code sends the right field and
// the *server* could still ignore it.
//
// So: synthesize the same line three ways and compare the bytes.
//
//   A  reference_id = one of your own voices        (what ▶ sends)
//   B  no reference_id at all                       (the studio's default voice)
//   C  reference_id = a different public voice      (a control)
//
// If A is byte-identical to B, the reference is being dropped somewhere and the
// preview really is generic audio. If A and C differ from each other and from B,
// the pipeline is carrying the voice and the preview is faithful.
//
// This spends a little API credit (three short lines). Nothing is written to the
// account: TTS is read-only apart from the credit.
//
// Usage: node tools/probe_preview_audio.cjs [base]
const { apiCookie, studioPassword } = require('./session.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:8756';
const TEXT = 'The quick brown fox jumps over the lazy dog.';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const sha = async buf => {
  const { createHash } = require('crypto');
  return createHash('sha256').update(Buffer.from(buf)).digest('hex').slice(0, 16);
};

async function main() {
  const cookie = await apiCookie(BASE);
  if (studioPassword() && !cookie) { console.error('could not sign in'); process.exit(2); }
  const h = { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) };

  const speak = async referenceId => {
    const body = { text: TEXT, format: 'mp3' };
    if (referenceId) body.reference_id = referenceId;
    const res = await fetch(BASE + '/api/tts', { method: 'POST', headers: h, body: JSON.stringify(body) });
    const buf = await res.arrayBuffer();
    return { status: res.status, bytes: buf.byteLength, hash: await sha(buf),
             type: res.headers.get('content-type') };
  };

  const own = await (await fetch(BASE + '/api/fish/model?self=true&page_size=5', { headers: h })).json();
  const mine = (own.items || own.models || [])[0];
  const pub = await (await fetch(BASE + '/api/fish/model?page_size=5&sort_by=task_count', { headers: h })).json();
  const other = (pub.items || pub.models || []).find(m => (m._id || m.id) !== (mine?._id || mine?.id));

  if (!mine) {
    console.log('this account has no voices of its own — nothing to compare.');
    console.log('\n0 passed, 0 failed (skipped)');
    return;
  }
  const mineId = mine._id || mine.id;
  console.log(`own voice : ${mine.title || '(untitled)'}  ${mineId}`);
  if (other) console.log(`control   : ${other.title}  ${other._id || other.id}`);
  console.log(`text      : "${TEXT}"\n`);

  const A = await speak(mineId);
  const B = await speak(null);
  const C = other ? await speak(other._id || other.id) : null;

  console.log(`A  with your voice : ${A.status} ${A.bytes}B ${A.type} ${A.hash}`);
  console.log(`B  no reference    : ${B.status} ${B.bytes}B ${B.type} ${B.hash}`);
  if (C) console.log(`C  a public voice  : ${C.status} ${C.bytes}B ${C.type} ${C.hash}`);
  console.log('');

  check('A — the preview request succeeds', A.status === 200, `status=${A.status}`);
  check('B — the no-reference control succeeds', B.status === 200, `status=${B.status}`);

  // The whole point. Identical bytes mean the reference never reached the voice.
  check('the preview audio is NOT the generic default voice',
        A.hash !== B.hash, A.hash === B.hash ? 'A and B are byte-identical — the reference is being ignored' : 'differs from the default');

  if (C) {
    check('a different voice produces different audio (the control is real)',
          C.hash !== A.hash && C.hash !== B.hash, `A=${A.hash} B=${B.hash} C=${C.hash}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
