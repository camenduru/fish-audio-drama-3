/**
 * Do the complex examples survive the real API?
 *
 * A script can be perfectly tag-balanced and still be rejected, or come back as
 * silence. This loads the feature-densest lines from the Examples library into
 * the Lip Sync page (which synthesizes *and* bakes in one shot) and reports what
 * came back.
 *
 * Costs one TTS call per line.  Usage: node tools/probe_examples.cjs
 */
const puppeteer = require('puppeteer-core');
const { signIn } = require('./session.cjs');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// (block n, index) into FEATURES — the lines that stack the most features.
const PICKS = [
  ['10', 4, 'two directions + forceful + breath + whisper'],
  ['10', 3, 'phoneme + pause + whisper'],
  ['12', 1, 'long narration with a mid-paragraph turn'],
];

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

  for (const [n, idx, label] of PICKS) {
    const script = await page.evaluate(async ({ n, idx }) => {
      const E = await import('/js/examples.js');
      const f = E.FEATURES.find(x => x.n === n);
      return f ? f.items[idx].script : null;
    }, { n, idx });

    if (!script) { console.log(`block ${n}[${idx}]: MISSING`); continue; }

    // The stats panel keeps the previous run's numbers, so wait for it to
    // actually change rather than matching on stale text.
    const before = await page.evaluate(() => document.querySelector('#lsStats')?.textContent || '');

    await page.evaluate(s => {
      const ta = document.querySelector('#lsScript');
      ta.value = s;
      ta.dispatchEvent(new Event('input'));
    }, script);

    await page.click('#lsRun');

    const done = await (async () => {
      for (let i = 0; i < 180; i++) {
        const t = await page.evaluate(() => document.querySelector('#lsStats')?.textContent || '');
        if (t !== before && /duration/i.test(t)) return t;
        await sleep(1000);
      }
      return null;
    })();

    const info = await page.evaluate(() => {
      const a = window.__lipsync?.()?.actors?.[0];
      return { cues: a?.cues };
    });

    console.log(`\nblock ${n}[${idx}] — ${label}`);
    console.log(`  script: ${script.slice(0, 78)}${script.length > 78 ? '…' : ''}`);
    console.log(`  ${done ? done.replace(/\s+/g, ' ').slice(0, 150) : 'TIMED OUT'}`);
    console.log(`  ${info.cues} cues on the face`);

    await page.click('#lsClearTakes').catch(() => {});
    await sleep(400);
  }

  console.log('\nconsole errors:', errors.length ? errors.slice(0, 4) : 'none');
  await browser.close();
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
