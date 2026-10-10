/**
 * Streaming regression test — needs real API credit.
 *
 * Guards the bug where upstream sends SSE (`data: {...}`) but the parser only
 * tried JSON.parse on the raw line, so every frame was dropped and streaming
 * silently produced a 0-byte take.
 */
const puppeteer = require('puppeteer-core');
const { signIn } = require('./session.cjs');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  ok ? pass++ : fail++;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await signIn(page, APP);
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(APP, { waitUntil: 'networkidle2' });
  await sleep(700);

  // Capture toasts so a failed generation is visible rather than silent.
  await page.evaluate(() => {
    window.__toasts = [];
    new MutationObserver(() => {
      document.querySelectorAll('.toast').forEach(t => {
        const txt = t.innerText.trim();
        if (txt && !window.__toasts.includes(txt)) window.__toasts.push(txt);
      });
    }).observe(document.body, { childList: true, subtree: true });
  });

  await page.$eval('#editor', e => {
    e.value = '[calm] Streaming probe. [pause] Does it arrive?';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.$eval('#streamTimestamps', e => { if (!e.checked) e.click(); });
  check('streaming checkbox engaged',
    await page.$eval('#streamTimestamps', e => e.checked) === true);

  await page.$eval('#genBtn', e => e.click());

  // Poll — generation time varies with API load.
  let takes = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    takes = await page.$$eval('#takeList .list-item', e => e.length);
    if (takes > 0) break;
  }
  const toasts = await page.evaluate(() => window.__toasts);

  check('a take was produced', takes > 0, takes + ' take(s)');
  check('generation reported no error',
    !toasts.some(t => /fail|error/i.test(t)),
    toasts.join(' | ') || 'no toasts');

  // The player row carries the real byte size.
  const info = await page.$eval('#player', e => e.innerText);
  const kb = parseFloat((info.match(/([\d.]+)\s*KB/) || [])[1] || '0');
  check('take is not empty (the bug produced 0 KB)', kb > 1, kb + ' KB');

  // Decode the blob and measure true duration.
  const measured = await page.evaluate(async () => {
    const audio = document.querySelector('#player audio');
    if (!audio || !audio.src) return null;
    const a = new Audio(audio.src);
    await new Promise(res => {
      a.addEventListener('loadedmetadata', res, { once: true });
      a.addEventListener('error', res, { once: true });
      setTimeout(res, 5000);
    });
    return { duration: a.duration };
  });
  check('take decodes as real audio',
    !!measured && isFinite(measured.duration) && measured.duration > 0.3,
    measured ? 'duration=' + measured.duration.toFixed(2) + 's' : 'no audio element');

  // Cumulative alignment should now be rendered as clickable word chips.
  const words = await page.$$eval('.ts-word', els => els.map(e => e.textContent));
  check('word timestamps rendered', words.length > 0,
    words.length ? words.length + ' words: ' + words.join(' ') : 'no .ts-word elements');

  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' / '));

  console.log(`\nSUMMARY: ${pass}/${pass + fail} passed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
