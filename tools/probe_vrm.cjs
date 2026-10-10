/**
 * Prove the VRM Call page: a user's own .vrm renders, and the live call's output
 * level actually drives its mouth.
 *
 * The call itself is verified by probe_call_failures / probe_call_text / probe_call_voice.
 * This probe covers what is new — three.js + @pixiv/three-vrm loading a user file,
 * the ChatVRM mouth/blink rig, and the fact that the Live Call page is untouched
 * by any of it. It needs no API key and no credit: nothing here starts a call.
 *
 * A live call cannot be started headlessly without a microphone and an agent, so
 * the mouth is driven through `window.__vrmcall.feed(level)` — the exact hook the
 * call's onLevel writes to. That keeps the test on the real pipeline (level →
 * shaping → smoothing → the VRM `aa` expression) without faking the SDK.
 *
 * Usage: node tools/probe_vrm.cjs [path/to/model.vrm]  [CHROME_ARGS=...]
 *        VRM_MODEL=/path/avatar.vrm node tools/probe_vrm.cjs
 *        APP_URL=http://127.0.0.1:8756 node tools/probe_vrm.cjs
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MODEL = process.argv[2] || process.env.VRM_MODEL || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  if (!MODEL) {
    console.error('Give me a model: node tools/probe_vrm.cjs path/to/avatar.vrm');
    process.exit(2);
  }
  if (!fs.existsSync(MODEL)) { console.error('no such model file:', MODEL); process.exit(2); }

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
           '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
           // A headless server or a VM has no GPU; set CHROME_ARGS to force
           // software WebGL, e.g. CHROME_ARGS="--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader".
           ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : [])],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  const load = async view => {
    await page.evaluate(v => document.querySelector(`[data-view="${v}"]`).click(), view);
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(v => document.querySelector('.view.active')?.id === 'view-' + v, view)) return true;
      await sleep(200);
    }
    return false;
  };
  const waitFor = async (fn, ms, arg) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await page.evaluate(fn, arg)) return true; } catch {}
      await sleep(300);
    }
    return false;
  };
  // Anything on this page is timed against frames, never the wall clock, so the
  // probe does not depend on the machine's frame rate.
  const waitFrames = async n => {
    const f0 = await page.evaluate(() => window.__vrmcall().frames);
    await waitFor(a => window.__vrmcall().frames >= a[0] + a[1], 30000, [f0, n]);
  };

  await page.goto(APP + '/', { waitUntil: 'networkidle2' });
  await sleep(1200);

  check('rail has a VRM Call button', !!(await page.$('[data-view="vrmcall"]')));
  check('the page opens', await load('vrmcall'));
  check('prompts for a model when none is loaded', !!(await page.$('#vrmEmpty:not(.hidden)')));
  check('call controls are present', !!(await page.$('#vrmStart')) && !!(await page.$('#vrmAgent')));

  check('three.js boots on open', await waitFor(() => typeof window.__vrmcall === 'function', 40000));

  // --- the user's own model, through the real file picker -------------------
  const input = await page.$('#vrmFile');
  if (!input) { console.error('FAIL  no #vrmFile input'); await browser.close(); process.exit(1); }
  await input.uploadFile(MODEL);
  const loaded = await waitFor(() => window.__vrmcall?.().model?.loaded === true, 120000);
  check('the .vrm loads', loaded, JSON.stringify(await page.evaluate(() => window.__vrmcall?.().model)));
  if (!loaded) {
    console.log('model error:', JSON.stringify(await page.evaluate(() => window.__vrmcall?.().lastModelError)));
    console.log('console:', errors.slice(0, 6));
    await browser.close(); process.exit(1);
  }
  const info = await page.evaluate(() => window.__vrmcall());
  check('it parses as VRM with expressions and bones',
        info.model.expressions > 0 && info.model.bones > 0,
        `VRM${info.model.version}, ${info.model.expressions} expressions, ${info.model.bones} bones`);

  // --- it draws --------------------------------------------------------------
  const f1 = await page.evaluate(() => window.__vrmcall().frames);
  await waitFrames(3);
  const s2 = await page.evaluate(() => window.__vrmcall());
  check('the render loop advances', s2.frames > f1, `frames ${f1} -> ${s2.frames}`);
  check('the model is actually drawn', s2.triangles > 0, s2.triangles + ' triangles');

  // --- the mouth is wired to the call's output level ------------------------
  await page.evaluate(() => window.__vrmcall.feed(0.85));
  await waitFrames(3);
  const open = await page.evaluate(() => window.__vrmcall().mouth);
  check('a voice level opens the mouth', open > 0.25, `mouth=${open}`);

  const reach = await page.evaluate(() => ({ mouth: window.__vrmcall().mouth, aa: window.__vrmcall().aaExpr }));
  check('the value reaches the VRM `aa` expression and not just a variable',
        typeof reach.aa === 'number' && Math.abs(reach.aa - reach.mouth) < 0.05,
        `mouth=${reach.mouth} aa=${reach.aa}`);

  // The release is *time*-based (tau = 0.14 s), not frame-based: from a wide
  // open (0.906) the exponential needs ~0.5 s to reach the 0.004 snap. Waiting a
  // fixed 4 frames measured the ramp, not the result, and read ~0.1 — a flake
  // that said "the mouth never closes" about a mouth that closes in half a
  // second. So wait for the release to finish instead, bounded.
  await page.evaluate(() => window.__vrmcall.feed(0));
  const closed = await waitFor(() => window.__vrmcall().mouth === 0, 5000);
  const shut = await page.evaluate(() => window.__vrmcall().mouth);
  check('silence closes the mouth', closed && shut === 0, `mouth=${shut}`);

  // --- blink -----------------------------------------------------------------
  const b0 = await page.evaluate(() => window.__vrmcall().blinks);
  check('auto-blink fires', await waitFor(n => window.__vrmcall().blinks > n, 45000, b0),
        `blinks ${b0} -> ${await page.evaluate(() => window.__vrmcall().blinks)}`);

  // --- the Live Call page is untouched --------------------------------------
  check('Live Call still opens', await load('live'));
  check('live: agent dropdown present', (await page.$$eval('#liveAgent option', e => e.length)) >= 1);
  const seam = await page.evaluate(() => window.__livecall());
  check('live: snapshot shape intact',
        seam && seam.live === false && typeof seam.status === 'string' && Array.isArray(seam.toasts) &&
        'lastError' in seam && 'textOnly' in seam && 'micAvailable' in seam,
        JSON.stringify({ live: seam?.live, status: seam?.status }));
  check('live: start/end/mute present',
        !!(await page.$('#liveStart')) && !!(await page.$('#liveEnd')) && !!(await page.$('#liveMute')));

  // Agent/model lists legitimately 401 without a key; the Lip Sync art 404s when
  // the game checkout is not present. Neither is this page's fault.
  const expected = /status of (401|404)/;
  const unexpected = errors.filter(e => !expected.test(e));
  check('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (expected.test(errors.join(' ')) && errors.length) {
    console.log('(401/404s above are the missing API key / game art, not this page)');
  }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
