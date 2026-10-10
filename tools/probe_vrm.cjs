/**
 * Prove the VRM Call page: the bundled avatar renders with its bundled idle clip,
 * a user's own .vrm loads over it, and the live call's output level drives its
 * mouth.
 *
 * The baseline needs no arguments: `web/vrm/AvatarSample_B.vrm` is the default
 * model and `web/vrm/idle_loop.vrma` the default animation, so the probe checks
 * both on a fresh profile with no file picker and no stored model. Pass a .vrm to
 * additionally cover the "my own model over the default" path.
 *
 * The call itself is verified by probe_call_failures / probe_call_text / probe_call_voice.
 * This probe covers what is new — three.js + @pixiv/three-vrm loading a file, the
 * idle clip on a mixer, the ChatVRM mouth/blink rig, and the fact that the Live
 * Call page is untouched by any of it. No API key and no credit: nothing here
 * starts a call.
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
  // A model argument is optional: the page now ships both an avatar and an idle
  // clip, and that baseline is what gets checked first. A path only adds the
  // "user model over the default" case.
  if (MODEL && !fs.existsSync(MODEL)) { console.error('no such model file:', MODEL); process.exit(2); }

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
  // A real OrbitControls drag on the canvas. The gaze target is parented to the
  // camera, so moving the camera is the only way to prove the eyes are still
  // tracking the viewer while the idle clip plays.
  const dragCanvas = async dx => {
    const box = await page.$eval('#vrmCanvas', e => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(cx + (dx / 10) * i, cy); await sleep(16); }
    await page.mouse.up();
    await sleep(600);
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
  check('call controls are present', !!(await page.$('#vrmStart')) && !!(await page.$('#vrmAgent')));

  check('three.js boots on open', await waitFor(() => typeof window.__vrmcall === 'function', 40000));

  // --- the bundled default avatar, with no file picker and nothing stored ----
  // A fresh browser profile has an empty IndexedDB, so this is exactly what a
  // first visit sees.
  const defaulted = await waitFor(() => window.__vrmcall?.().model?.source === 'default', 120000);
  check('the bundled default avatar loads by itself', defaulted,
        JSON.stringify(await page.evaluate(() => window.__vrmcall().model)));
  if (!defaulted) {
    console.log('model error:', JSON.stringify(await page.evaluate(() => window.__vrmcall().lastModelError)));
    console.log('console:', errors.slice(0, 6));
    await browser.close(); process.exit(1);
  }
  check('the empty-state prompt is gone with a model loaded', !(await page.$('#vrmEmpty:not(.hidden)')));

  // --- the bundled idle clip ------------------------------------------------
  const idle = await page.evaluate(() => window.__vrmcall().idleClip);
  check('the bundled idle clip is bound and playing on the mixer',
        idle.loaded !== false && idle.tracks > 0 && idle.playing === true,
        JSON.stringify({ tracks: idle.tracks, duration: idle.duration, playing: idle.playing }));

  const t0 = await page.evaluate(() => window.__vrmcall().idleClip.time);
  const c0 = await page.evaluate(() => window.__vrmcall().chest);
  await sleep(1500);
  const t1 = await page.evaluate(() => window.__vrmcall().idleClip.time);
  const c1 = await page.evaluate(() => window.__vrmcall().chest);
  check('the clip is advancing, not merely bound', t1 > t0, `${t0}s -> ${t1}s`);
  check('the clip poses the body, not just the clock',
        JSON.stringify(c0) !== JSON.stringify(c1), `chest ${JSON.stringify(c0)} -> ${JSON.stringify(c1)}`);

  // The loader leaves the clip's hips translation absolute, in the source rig's
  // frame; the page subtracts this model's rest hips so the body does not walk
  // off the camera's target. A non-zero offset means that correction ran.
  check('the clip\u2019s absolute hip offset was removed',
        Array.isArray(idle.hipsOffset) && Math.abs(idle.hipsOffset[0]) > 0.05, JSON.stringify(idle.hipsOffset));

  // --- the gaze still works with the clip playing ---------------------------
  // The look-at applier writes the eyes and only the eyes, so a clip that turns
  // the head would still leave the eyes on the viewer. Orbit the camera with a
  // real drag and the eyes must follow.
  const eye0 = await page.evaluate(() => window.__vrmcall().eyeRaw);
  await dragCanvas(180);
  const eye1 = await page.evaluate(() => window.__vrmcall().eyeRaw);
  check('the gaze still converges on the camera while the clip plays',
        JSON.stringify(eye0) !== JSON.stringify(eye1), `${JSON.stringify(eye0)} -> ${JSON.stringify(eye1)}`);

  // Recorded because it is surprising and load-bearing: this .vrma animates 28
  // channels but only 22 map to humanoid bones, so the head of this model cannot
  // be moved by it at all. If that ever changes, the number here changes.
  const headName = idle.boneNames?.head;
  check('no track binds the head — this clip never mapped one',
        !!headName && !(idle.trackNames || []).some(n => n.startsWith(headName)), headName);

  // --- a user's own model, through the real file picker ---------------------
  // Deliberately before the Remove check: with the default already loaded,
  // "source === 'default'" is true both before and after a Remove, so asserting it
  // there would pass instantly and let the pending clear clobber a later upload.
  if (MODEL) {
    const input = await page.$('#vrmFile');
    if (!input) { console.error('FAIL  no #vrmFile input'); await browser.close(); process.exit(1); }
    await input.uploadFile(MODEL);
    const mine = path.basename(MODEL);
    // Wait for the *uploaded* model specifically: the default is already loaded, so
    // `model.loaded` alone would pass before the file is even parsed.
    const loaded = await waitFor(n => window.__vrmcall?.().model?.loaded === true
      && window.__vrmcall().model.source === 'file' && window.__vrmcall().model.name === n, 120000, mine);
    check('the user\u2019s own .vrm loads over the default', loaded,
          JSON.stringify(await page.evaluate(() => window.__vrmcall().model)));
    if (!loaded) {
      console.log('model error:', JSON.stringify(await page.evaluate(() => window.__vrmcall().lastModelError)));
      console.log('console:', errors.slice(0, 6));
      await browser.close(); process.exit(1);
    }
    const up = await page.evaluate(() => window.__vrmcall().idleClip);
    check('the idle clip is rebuilt for the uploaded model', up.loaded !== false && up.tracks > 0 && up.playing === true,
          JSON.stringify({ tracks: up.tracks, playing: up.playing }));

    // --- "Remove" must fall back to the bundled avatar, not to a blank stage --
    await page.click('#vrmClear');
    const backToDefault = await waitFor(() => window.__vrmcall?.().model?.source === 'default', 60000);
    check('removing the user\u2019s model restores the bundled default', backToDefault,
          JSON.stringify(await page.evaluate(() => window.__vrmcall().model)));
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
