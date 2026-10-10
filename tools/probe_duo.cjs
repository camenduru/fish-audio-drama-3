/**
 * Deterministic probe for the Lip Sync two-hander playback path.
 *
 * No API calls: two synthetic takes (hand-built WAV + hand-built sidecar) are
 * injected straight into the shared library, then the real DOM path is driven
 * — mode=duo, assign A2/A1 on the take rows, click "play conversation" — while
 * every actor's audio element is sampled frame by frame.
 *
 * Usage: node tools/probe_duo.cjs
 */
const puppeteer = require('puppeteer-core');
const { signIn } = require('./session.cjs');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await signIn(page, APP);
  await page.setViewport({ width: 1500, height: 950 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(APP + '/#lipsync', { waitUntil: 'networkidle2' });
  await sleep(2500);

  // ---------------------------------------------------------- inject 2 takes
  const injected = await page.evaluate(async () => {
    const L = await import('/js/library.js');

    function makeWav(seconds, rate) {
      const n = Math.floor(seconds * rate);
      const data = new Uint8Array(44 + n * 2);
      const dv = new DataView(data.buffer);
      const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      put(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true); put(36, 'data'); dv.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.sin(i * 0.05) * 3000, true);
      return data;
    }
    const mkSidecar = (dur, seq) => {
      const step = dur / seq.length;
      return {
        metadata: { duration: dur },
        mouthCues: seq.map((v, i) => ({
          start: +(i * step).toFixed(3), end: +((i + 1) * step).toFixed(3), value: v,
        })),
      };
    };

    // Oldest first so row 0 in the take list is the newest.
    const t1 = L.addAudio({ bytes: makeWav(2.0, 22050), text: 'Probe A', name: 'Probe A', source: 'probe' });
    L.setSidecar(t1.id, mkSidecar(2.0, ['C', 'A', 'C', 'A', 'C', 'A', 'C', 'A']), { aligner: 'probe' }, null);
    const t2 = L.addAudio({ bytes: makeWav(2.0, 22050), text: 'Probe B', name: 'Probe B', source: 'probe' });
    L.setSidecar(t2.id, mkSidecar(2.0, ['B', 'D', 'B', 'D', 'B', 'D', 'B', 'D']), { aligner: 'probe' }, null);

    return { t1: t1.id, t2: t2.id, count: L.countAudio() };
  });
  console.log('injected', JSON.stringify(injected));

  // ------------------------------------------------------------- duo + assign
  await page.evaluate(() => {
    const m = document.querySelector('#lsMode');
    m.value = 'duo';
    m.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(1200);

  const rows = await page.$$eval('#lsTakes .tk', els => els.map(e => ({
    name: e.querySelector('.tk-name')?.textContent?.trim() || '',
    assign: [...e.querySelectorAll('.tk-assign .btn')].map(b => b.textContent.trim()),
  })));
  console.log('take rows:', JSON.stringify(rows));

  const clickAssign = async (idx, label) => {
    await page.evaluate(({ idx, label }) => {
      const row = document.querySelectorAll('#lsTakes .tk')[idx];
      const b = [...(row?.querySelectorAll('.tk-assign .btn') || [])]
        .find(x => x.textContent.trim() === label);
      if (b) b.click();
    }, { idx, label });
    await sleep(400);
  };
  await page.click('#lsConvoClear');
  await sleep(300);
  await clickAssign(0, 'A2');
  await clickAssign(1, 'A1');

  const queue = await page.$$eval('#lsConvo .cv-turn', els => els.map(e => e.textContent.trim().slice(0, 40)));
  console.log('queue:', JSON.stringify(queue));
  console.log('seam before play:', JSON.stringify(await page.evaluate(() => window.__lipsync?.())));

  // -------------------------------------------------------------------- play
  await page.click('#lsConvoPlay');

  const trace = [];
  let shot = 0;
  for (let i = 0; i < 200; i++) {
    const s = await page.evaluate(() => {
      const info = sel => {
        const a = document.querySelector(sel);
        if (!a) return null;
        return {
          ct: +a.currentTime.toFixed(2), d: +(a.duration || 0).toFixed(2),
          paused: a.paused, ended: a.ended, err: a.error ? a.error.code : 0,
          src: (a.currentSrc || a.src || '').slice(0, 12),
        };
      };
      return {
        a1s: document.querySelector('#lsShape')?.textContent,
        a2s: document.querySelector('#lsShape2')?.textContent,
        a1: info('#lsAudio'), a2: info('#lsAudio2'),
      };
    });
    trace.push(s);
    // Grab a frame where exactly one avatar is talking and the other is shut —
    // the case the idle-mouth bug used to get wrong.
    const one = (s.a1 && !s.a1.paused && s.a1s !== 'X' && s.a2s === 'X') ||
                (s.a2 && !s.a2.paused && s.a2s !== 'X' && s.a1s === 'X');
    if (one && shot < 2) {
      shot++;
      await page.screenshot({ path: `data/probe/shot_duo_${shot}.png` });
    }
    if (i > 8 && !s.a1 && !s.a2) break;
    await sleep(60);
  }
  if (shot) console.log(`saved ${shot} screenshot(s) to data/probe/shot_duo_*.png`);

  // Condense: print only when something changes.
  let prev = '';
  for (const s of trace) {
    const line = `a1[${s.a1s}] ct=${s.a1?.ct} paused=${s.a1?.paused} end=${s.a1?.ended} err=${s.a1?.err}` +
                 ` | a2[${s.a2s}] ct=${s.a2?.ct} paused=${s.a2?.paused} end=${s.a2?.ended} err=${s.a2?.err}`;
    if (line !== prev) { console.log(line); prev = line; }
  }

  const a1 = new Set(trace.map(t => t.a1s).filter(Boolean));
  const a2 = new Set(trace.map(t => t.a2s).filter(Boolean));
  console.log(`\nA1 shapes: ${[...a1].join('')}`);
  console.log(`A2 shapes: ${[...a2].join('')}`);
  console.log('errors:', errors.length ? errors.slice(0, 4) : 'none');

  // ------------------------------------------------------------------ hold
  // DialogueAvatar will not change a mouth shape until it has been on screen
  // for avatar.voice.mouth_min_hold (0.05 s). So a cue shorter than that is
  // DRAWN and held — it is not invisible noise. Record every animation frame
  // in the page and measure how long a deliberately tiny cue actually showed.
  console.log('\n--- min-hold ---');
  // Deterministic single actor, so `#lsAudio` / actors[0] is unambiguous.
  await page.evaluate(() => {
    const m = document.querySelector('#lsMode');
    m.value = 'single';
    m.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(900);

  const held = await page.evaluate(async () => {
    const L = await import('/js/library.js');
    L.clearAudio();

    function makeWav(seconds, rate) {
      const n = Math.floor(seconds * rate);
      const data = new Uint8Array(44 + n * 2);
      const dv = new DataView(data.buffer);
      const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      put(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true); put(36, 'data'); dv.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.sin(i * 0.05) * 3000, true);
      return data;
    }

    // One cue far shorter than the 0.05 s hold, between two long ones.
    const t = L.addAudio({ bytes: makeWav(1.5, 22050), text: 'hold probe', name: 'Hold probe', source: 'probe' });
    L.setSidecar(t.id, {
      metadata: { duration: 1.5 },
      mouthCues: [
        { start: 0.0, end: 0.5, value: 'C' },
        { start: 0.5, end: 0.52, value: 'D' },   // 20 ms — shorter than the hold
        { start: 0.52, end: 1.5, value: 'B' },
      ],
    }, { aligner: 'probe' }, null);

    // Click the row: that is what `applyTake` hangs off, exactly like a human.
    document.querySelector('#lsTakes .tk')?.click();
    await new Promise(r => setTimeout(r, 700));

    // Sample the real per-actor state on every animation frame.
    const frames = [];
    let raf = 0;
    const tick = () => {
      const a = window.__lipsync?.().actors?.[0];
      frames.push([performance.now(), a ? a.shape : null]);
      if (frames.length < 900) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const audio = document.querySelector('#lsAudio');
    if (!audio || !audio.src) return { error: 'no take landed on the stage' };
    audio.currentTime = 0;
    await audio.play();
    await new Promise(r => setTimeout(r, 1700));
    audio.pause();
    cancelAnimationFrame(raf);

    // Collapse the frame log into unbroken runs, one per shape.
    const runs = [];
    for (const [, s] of frames) {
      if (runs.length && runs[runs.length - 1].shape === s) runs[runs.length - 1].n++;
      else runs.push({ shape: s, n: 1 });
    }
    const span = frames.length > 1 ? (frames[frames.length - 1][0] - frames[0][0]) / 1000 : 0;
    const perFrame = frames.length > 1 ? span / (frames.length - 1) : 0;
    const dRun = runs.filter(r => r.shape === 'D').reduce((m, r) => Math.max(m, r.n), 0);
    return {
      frames: frames.length,
      perFrameMs: +(perFrame * 1000).toFixed(2),
      runs: runs.map(r => `${r.shape}×${r.n}`).join(' '),
      dRunMs: +(dRun * perFrame * 1000).toFixed(0),
      sawD: runs.some(r => r.shape === 'D'),
      ordered: runs.map(r => r.shape).join('') .replace(/(.)\1*/g, '$1'),
    };
  });

  if (held.error) {
    console.log(`  ✗ ${held.error}`);
  } else {
    console.log(`  frames=${held.frames} @${held.perFrameMs}ms  runs: ${held.runs}`);
    console.log(`  the 20 ms 'D' cue was on screen for ~${held.dRunMs} ms ` +
                `(${held.sawD ? 'drawn' : 'NEVER DRAWN'})`);
    console.log(`  shape order: ${held.ordered}`);
    console.log(`  ${held.sawD && held.dRunMs >= 40
      ? 'HELD — matches DialogueAvatar mouth_min_hold'
      : 'NOT HELD — a sub-hold cue flickered or vanished'}`);
  }

  await browser.close();
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
