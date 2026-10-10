/**
 * Drives the REAL UI against the echo upstream and records the `model` header
 * that actually leaves the server for each generation path.
 */
const puppeteer = require('puppeteer-core');
const { signIn } = require('./session.cjs');
const fs = require('fs');

const APP = 'http://127.0.0.1:8757';
const LOG = 'C:/Users/PC/Documents/fish.audio/data/echo_log.jsonl';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function since(mark) {
  const all = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return all.slice(mark);
}
function mark() {
  return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).length;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  });
  const page = await browser.newPage();
  await signIn(page, APP);
  await page.setViewport({ width: 1500, height: 950 });
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await sleep(600);

  const report = [];

  const setEditor = async text => {
    await page.$eval('#editor', (e, t) => {
      e.value = t; e.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
  };

  // --- 1. Studio, default model ---
  const m1 = mark();
  await setEditor('[calm] Wire probe. [pause] Second line.');
  await page.$eval("#genBtn", e => e.click());
  await sleep(1400);
  report.push({ case: 'studio · default dropdown', reqs: since(m1) });

  // --- 2. Studio, dropdown switched to s2-pro ---
  const m2 = mark();
  await page.select('#ttsModel', 's2-pro');
  await page.$eval("#genBtn", e => e.click());
  await sleep(1400);
  report.push({ case: 'studio · dropdown = s2-pro', reqs: since(m2) });

  // --- 3. Studio streaming ---
  const m3 = mark();
  await page.select('#ttsModel', 'drama-3-preview');
  await page.$eval('#streamTimestamps', e => { if (!e.checked) e.click(); });
  await page.$eval('#genBtn', e => e.click());
  await sleep(1600);
  report.push({ case: 'studio · streaming on', reqs: since(m3) });

  // --- 4. Scenes ---
  const m4 = mark();
  await page.click('[data-view="scenes"]');
  await sleep(500);
  await page.$eval('#sceneScript', e => {
    e.value = 'Detective: You were there that night.\nSuspect: I was home. Asleep.';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  const renderBtn = await page.$('#sceneRender');
  if (renderBtn) { await page.$eval("#sceneRender", e => e.click()); await sleep(1600); }
  report.push({ case: 'scenes · render', reqs: since(m4) });

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
