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

  // --- the face is square to the camera, and stays that way ------------------
  // (Before any drag: facing is measured against the front of the scene, and an
  // orbited camera is *supposed* to see the avatar's profile.)
  // This model stands ~9.4° turned in its rest pose and the idle clip adds a little
  // more, which reads as an avatar looking past your shoulder. The correction is
  // measured on the world every frame, so this samples over time — a one-shot fix
  // at load cannot work, because three-vrm has applied no pose yet at that point.
  const yaws = [];
  for (let i = 0; i < 8; i++) {
    yaws.push((await page.evaluate(() => window.__vrmcall().face)).yaw);
    await sleep(400);
  }
  const worstYaw = Math.max(...yaws.map(Math.abs));
  check('the face points at the camera, within 2° over several seconds', worstYaw < 2,
        `yaw samples ${yaws.join(', ')}`);
  const squared = await page.evaluate(() => window.__vrmcall().squaredBy);
  check('and the model genuinely needed squaring (this one ~9.4°)', squared > 5,
        `largest correction ${squared}°, head yaw now ${(await page.evaluate(() => window.__vrmcall().face)).headYaw}°`);

  // --- the agent list loads on this page too ---------------------------------
  // It used to be created with loadOnInit:false and never filled, so this page had
  // an empty dropdown until you happened to focus it — the Call page did not.
  const vrmAgents = await page.$$eval('#vrmAgent option', o => o.filter(x => x.value).length);
  check('the agent dropdown is populated on this page', vrmAgents > 0, vrmAgents + ' agents');
  check('live and VRM offer the same agents',
        vrmAgents === (await page.$$eval('#liveAgent option', o => o.filter(x => x.value).length)),
        `${vrmAgents} here`);

  // --- the transcript: its own scrollbar, newest turn on top ------------------
  const chatCss = await page.evaluate(() => {
    const el = document.querySelector('#vrmChat');
    const cs = getComputedStyle(el);
    return { overflowY: cs.overflowY, height: Math.round(el.getBoundingClientRect().height) };
  });
  check('the avatar transcript scrolls on its own',
        chatCss.overflowY === 'auto' && chatCss.height > 40, JSON.stringify(chatCss));

  const chat = await page.evaluate(() => {
    const el = document.querySelector('#vrmChat');
    el.replaceChildren();
    window.__vrmcall.bubble('user', 'first');
    window.__vrmcall.bubble('agent', 'second');
    window.__vrmcall.bubble('agent', 'third');
    return {
      order: [...el.children].map(b => b.textContent),
      scrollTop: el.scrollTop,
    };
  });
  check('the newest turn sits at the top of the transcript',
        chat.order[0] === 'third', JSON.stringify(chat.order));
  check('a new turn does not leave you scrolled into history', chat.scrollTop === 0, 'scrollTop=' + chat.scrollTop);

  // The point of the split: a long conversation scrolls *inside* the transcript,
  // and the avatar stays where it is. Sharing one scroller used to carry the stage
  // off the top of the page the moment the transcript grew.
  await page.evaluate(() => {
    const el = document.querySelector('#vrmChat');
    el.replaceChildren();
    for (let i = 0; i < 40; i++) window.__vrmcall.bubble('user', 'line ' + i);
  });
  const logScroll = await page.evaluate(() => {
    const log = document.querySelector('#vrmChat');
    log.scrollTop = log.scrollHeight;
    const stage = document.querySelector('#vrmStage').getBoundingClientRect();
    return {
      scrollable: log.scrollHeight > log.clientHeight,
      scrolled: log.scrollTop > 0,
      stageTop: Math.round(stage.top), stageBottom: Math.round(stage.bottom),
      viewport: window.innerHeight,
    };
  });
  check('a long transcript scrolls inside its own box',
        logScroll.scrollable && logScroll.scrolled, JSON.stringify(logScroll));
  check('and the avatar is still on screen at the bottom of the transcript',
        logScroll.stageTop >= 0 && logScroll.stageBottom <= logScroll.viewport,
        `stage ${logScroll.stageTop}..${logScroll.stageBottom} of ${logScroll.viewport}`);

  // --- a right-held drag moves the avatar ------------------------------------
  // Measured off the canvas pixels rather than off a variable, because "the camera
  // panned" and "the avatar moved on screen" are not the same claim.
  const centreOfMass = () => page.evaluate(() => {
    const src = document.querySelector('#vrmCanvas');
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0, n = 0;
    for (let y = 0; y < c.height; y += 4) {
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        // the avatar is far brighter than the dark stage
        if (data[i] + data[i + 1] + data[i + 2] > 300) { sum += x; n++; }
      }
    }
    return n ? Math.round(sum / n) : null;
  });
  const beforeX = await centreOfMass();
  const box = await page.$eval('#vrmCanvas', e => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.w * 0.28, box.y + box.h / 2, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await sleep(900);   // damping settles
  const afterX = await centreOfMass();
  check('a right-held drag moves the avatar in the frame',
        beforeX !== null && afterX !== null && Math.abs(afterX - beforeX) > 30,
        `silhouette centre x ${beforeX} → ${afterX}`);

  // --- the opening shot is a torso shot *with the whole head* ----------------
  // Framing off a fraction of the model's height shaves the top of the hair: the
  // head bone sits below the highest vertex. Measured off the canvas, so the claim
  // is "nothing is touching the top edge", not "the number looks right".
  const framing = await page.evaluate(() => {
    const src = document.querySelector('#vrmCanvas');
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const x0 = Math.floor(c.width * 0.2), x1 = Math.floor(c.width * 0.8);
    let top = null, bottom = null;
    for (let y = 0; y < c.height; y++) {
      let n = 0;
      for (let x = x0; x < x1; x += 2) {
        const i = (y * c.width + x) * 4;
        if (data[i] + data[i + 1] + data[i + 2] > 300) n++;
      }
      if (n > 2) { if (top === null) top = y; bottom = y; }
    }
    return { top, bottom, height: c.height, width: c.width };
  });
  check('the whole head is in frame — the silhouette clears the top edge',
        framing.top !== null && framing.top >= 2,
        `first avatar row ${framing.top} of ${framing.height}`);
  // Head level means the body is *cropped* below the shoulders: the silhouette runs
  // off the bottom edge. A shot that ends inside the frame is a torso or full-body
  // shot, however tight it looks at the top.
  check('and it is a head shot — the body is cropped at the bottom edge',
        framing.bottom !== null && framing.bottom >= framing.height - 3,
        `last avatar row ${framing.bottom} of ${framing.height}`);

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

  // The emote controller owns the expression, so the number that reaches the VRM
  // is not the raw mouth value: ChatVRM draws it at half while the emotion is
  // neutral, and at a quarter under an emotion. Reading it back off the VRM is what
  // proves the scaling actually landed, rather than that the arithmetic in the
  // controller is right.
  const reach = await page.evaluate(() => window.__vrmcall());
  check('the mouth reaches the VRM expression at the neutral weight (mouth × 0.5)',
        typeof reach.mouthExpr === 'number' && Math.abs(reach.mouthExpr - reach.mouth * 0.5) < 0.02,
        `mouth=${reach.mouth} → ${reach.mouthPreset}=${reach.mouthExpr}`);
  check('the mouth preset is the model\u2019s own — JawOpen if it has one, else aa',
        reach.mouthPreset === 'aa' || reach.mouthPreset === 'JawOpen', String(reach.mouthPreset));

  // An emotion quarters the weight, and an emotion waits for the eyes to reopen
  // before it applies — so this asserts both the weight and the state machine.
  const set = await page.evaluate(() => window.__vrmcall.emote('happy'));
  const mooded = await waitFor(() => {
    const s = window.__vrmcall();
    return s.emotion === 'happy' && typeof s.mouthExpr === 'number'
      && Math.abs(s.mouthExpr - s.mouth * 0.25) < 0.02;
  }, 8000);
  const mood = await page.evaluate(() => window.__vrmcall());
  check('an emotion quarters the mouth weight (ChatVRM\u2019s rule)', mooded,
        `emote()=${set}, emotion=${mood.emotion}, mouth=${mood.mouth} → ${mood.mouthExpr}`);

  await page.evaluate(() => window.__vrmcall.emote('neutral'));
  const undone = await waitFor(() => {
    const s = window.__vrmcall();
    return s.emotion === 'neutral' && typeof s.mouthExpr === 'number'
      && Math.abs(s.mouthExpr - s.mouth * 0.5) < 0.02;
  }, 8000);
  check('back to neutral restores the half weight', undone,
        JSON.stringify(await page.evaluate(() => ({ e: window.__vrmcall().emotion, x: window.__vrmcall().mouthExpr }))));

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
