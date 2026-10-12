/**
 * The WAV header repair exists TWICE and must stay byte-identical.
 *
 *   browser : web/js/audio.js        -> fixWavHeader(bytes)
 *   baker   : tools/visemes.py       -> repair_wav(path)
 *
 * Fish's streaming endpoint emits a placeholder size in the `data` chunk
 * (0xFFFFFC00). Anything that trusts the header — openfacefx included — then
 * reads a duration of ~48695 s. Both copies rewrite the same two fields:
 *
 *     data size  = len(raw) - (data_offset + 8)
 *     RIFF size  = len(raw) - 8
 *
 * WHY THIS IS A HARD REQUIREMENT, NOT A NICETY
 * --------------------------------------------
 * The bake endpoint used to echo the repaired WAV back as `wav_base64`. It no
 * longer does: base64 inflates by 4/3, and a hosted deploy caps the RESPONSE
 * at 4.5 MB exactly as it caps the request, so the echo silently cut the usable
 * line length from ~4.4 MB to ~3.4 MB — a bake that failed with no message
 * naming the cause. Dropping it is only safe while the browser's own repair
 * produces the identical bytes, which is what this file proves.
 *
 * The browser copy is imported from its SHIPPED SOURCE (a data: URL over the
 * exact bytes of web/js/audio.js) — not re-implemented here, so this cannot
 * drift away from what actually ships.
 *
 * No API credit needed. Run standalone:
 *
 *     node tools/verify_wav_repair.cjs
 *
 * verify_lipsync.cjs calls runChecks() as its first block, which is what the
 * comment in server/main.py points at.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VISEMES = path.join(__dirname, 'visemes.py');
const FIXTURE = path.join(__dirname, 'fixtures', 'speech.wav');

const sha256 = b => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');

/** The placeholder Fish writes when it does not yet know the total length. */
const PLACEHOLDER = 0xFFFFFC00;

function python() {
  const win = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(win)) return win;
  const nix = path.join(ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(nix)) return nix;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Load the browser's shipped fixWavHeader.
 *
 * audio.js is a leaf module (zero imports), so the exact source bytes can be
 * imported straight into Node. There is no package.json `type: module` here,
 * hence the data: URL rather than a bare import().
 */
async function loadBrowserFix() {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'audio.js'), 'utf8');
  const url = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
  const mod = await import(url);
  if (typeof mod.fixWavHeader !== 'function') throw new Error('audio.js exports no fixWavHeader');
  return mod.fixWavHeader;
}

/** Run the baker's repair_wav over a copy and return the resulting bytes. */
function serverRepair(buf) {
  const tmp = path.join(os.tmpdir(),
    `wavrep_${process.pid}_${Math.random().toString(16).slice(2)}.wav`);
  fs.writeFileSync(tmp, buf);
  try {
    const script = [
      'import importlib.util, sys',
      `spec = importlib.util.spec_from_file_location("visemes", r"${VISEMES}")`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'm.repair_wav(sys.argv[1])',
    ].join('\n');
    execFileSync(python(), ['-c', script, tmp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return fs.readFileSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// --------------------------------------------------------------------- inputs

/** Byte offset of the `data` chunk, walking the chunk list like both repairs do. */
function dataOffset(buf) {
  let off = 12;
  while (off + 8 <= buf.length) {
    const cid = buf.toString('latin1', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (cid === 'data') return off;
    off += 8 + sz + (sz & 1);
  }
  return -1;
}

function withBrokenData(buf) {
  const b = Buffer.from(buf);
  const off = dataOffset(b);
  if (off < 0) throw new Error('fixture has no data chunk');
  b.writeUInt32LE(PLACEHOLDER, off + 4);
  return b;
}

function withBrokenBoth(buf) {
  const b = withBrokenData(buf);
  b.writeUInt32LE(PLACEHOLDER, 4);
  return b;
}

/**
 * A hand-built WAV with an ODD-sized chunk between fmt and data.
 *
 * The real fixture is `fmt ` + `data` only, so it never reaches the
 * `off += 8 + sz + (sz & 1)` pad step. A LIST chunk of 5 bytes does, and a
 * disagreement in that one byte of padding would desync the walk and make the
 * two repairs edit different offsets — the exact class of bug that is
 * invisible until it corrupts audio.
 */
function wavWithOddChunk() {
  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);       // PCM
  fmt.writeUInt16LE(1, 10);      // mono
  fmt.writeUInt32LE(16000, 12);  // 16 kHz
  fmt.writeUInt32LE(32000, 16);  // byte rate
  fmt.writeUInt16LE(2, 20);      // block align
  fmt.writeUInt16LE(16, 22);     // 16-bit

  const list = Buffer.alloc(8 + 5 + 1);   // 5-byte payload + 1 pad byte
  list.write('LIST', 0, 'latin1');
  list.writeUInt32LE(5, 4);

  const payload = Buffer.alloc(400);      // 25 ms of silence
  const data = Buffer.alloc(8 + payload.length);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(payload.length, 4);

  const body = Buffer.concat([fmt, list, data]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  head.write('WAVE', 8, 'latin1');

  const wav = Buffer.concat([head, body]);
  // Break it, so the walk is actually exercised rather than short-circuited.
  return withBrokenBoth(wav);
}

// --------------------------------------------------------------------- checks

async function runChecks(check) {
  const fixWavHeader = await loadBrowserFix();
  const pristine = fs.readFileSync(FIXTURE);

  const cases = [
    {
      name: 'data-size placeholder (what Fish streams)',
      input: withBrokenData(pristine),
      // The repair must land exactly on the pristine fixture.
      expect: pristine,
    },
    {
      name: 'both size fields placeholder',
      input: withBrokenBoth(pristine),
      expect: pristine,
    },
    {
      name: 'already-correct header is left untouched',
      input: pristine,
      expect: pristine,
    },
    {
      name: 'odd-sized chunk before data (the &1 pad step)',
      input: wavWithOddChunk(),
      // Nothing to compare against but the two implementations themselves; the
      // walk has to land on the same data offset for both.
      expect: null,
    },
    {
      name: 'not a RIFF file',
      input: Buffer.alloc(64, 0xAB),
      expect: null,
    },
  ];

  let agree = 0;
  const details = [];
  for (const c of cases) {
    const server = serverRepair(c.input);
    const browser = Buffer.from(fixWavHeader(Uint8Array.from(c.input)));

    const same = sha256(server) === sha256(browser);
    const matchesExpect = c.expect ? sha256(server) === sha256(c.expect) : true;
    const ok = same && matchesExpect;
    if (ok) agree++;

    details.push(`${c.name}: ${same ? 'identical' : 'DIFFER'}${c.expect ? (matchesExpect ? ' · reaches pristine' : ' · WRONG RESULT') : ''}`);

    if (!ok) {
      // Surface the first differing byte — far more useful than two hashes.
      let at = -1;
      const n = Math.min(server.length, browser.length);
      for (let i = 0; i < n; i++) if (server[i] !== browser[i]) { at = i; break; }
      check(`wav repair agrees byte-for-byte — ${c.name}`, false,
        at >= 0
          ? `first difference at byte ${at}: server=${server[at]} browser=${browser[at]}`
          : `length ${server.length} vs ${browser.length}`);
      return;
    }
  }

  check('browser fixWavHeader and baker repair_wav agree byte-for-byte',
    agree === cases.length,
    details.join(' | '));

  // The repaired fixture must also be what a header-trusting reader expects.
  const repaired = serverRepair(withBrokenData(pristine));
  const dOff = dataOffset(repaired);
  const declared = repaired.readUInt32LE(dOff + 4);
  const real = repaired.length - (dOff + 8);
  check('the repaired header declares the true byte count',
    declared === real && repaired.readUInt32LE(4) === repaired.length - 8,
    `data declares ${declared}, really ${real}; RIFF ${repaired.readUInt32LE(4)}`);

  // 48695 s is the bug this whole file exists to prevent.
  const seconds = real / 32000;
  check('repaired duration is plausible, not the 48695s header bug',
    seconds > 0.5 && seconds < 60, `${seconds.toFixed(2)}s`);
}

module.exports = { runChecks, serverRepair, loadBrowserFix, sha256 };

// ------------------------------------------------------------------- CLI mode
if (require.main === module) {
  let pass = 0, fail = 0;
  const check = (n, ok, d) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  — ' + d : ''));
    ok ? pass++ : fail++;
  };
  runChecks(check)
    .then(() => {
      console.log(`\nSUMMARY: ${pass}/${pass + fail} passed`);
      process.exit(fail ? 1 : 0);
    })
    .catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
}
