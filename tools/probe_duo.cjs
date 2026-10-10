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

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
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
    if (i > 8 && !s.a1 && !s.a2) break;
    await sleep(60);
  }

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

  await browser.close();
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
