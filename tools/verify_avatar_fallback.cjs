/**
 * The Lip Sync avatar has to exist on a deploy.
 *
 * This is the bug the badge was meant to help spot: on Vercel the Lip Sync page
 * requested
 *
 *     /api/avatar/33/33_default.png
 *     /api/avatar/33/33_default_face.png
 *
 * and both 404'd. The cause was not the network — it was that `DIALOGUE_ROOT`
 * points at the game folder next to the studio, and a deploy has no game folder
 * at all. `discover_avatars()` therefore returned nothing, `lipsync_info()`
 * fell back to those two hard-coded URLs, and the canvas stayed blank with
 * nothing on screen naming the reason.
 *
 * A copy of the default avatar now ships under web/avatars/ (web/** is already
 * in vercel.json's includeFiles). This harness launches a server that looks
 * like a deploy — VERCEL=1 and a game root that does not exist — and asserts
 * the page still works, which no other harness covers because they all run
 * against a checkout that has the game folder.
 *
 * No API credit needed.
 *
 *     node tools/verify_avatar_fallback.cjs
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const { signIn } = require('./session.cjs');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = 'C:/Users/PC/AppData/Local/Temp/shots';

const GAME_AVATAR_DIR = path.join(
  process.env.ROGUELIKE_ROOT || 'C:/Users/PC/Documents/content/wicked/RoguelikeGame',
  'assets', 'dialogue', '33');
const BUNDLED_DIR = path.join(ROOT, 'web', 'avatars', '33');

const ASSETS = ['33_default.png', '33_default_face.png', '33_default_face.json'];

const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function python() {
  const win = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(win)) return win;
  const nix = path.join(ROOT, '.venv', 'bin', 'python');
  return fs.existsSync(nix) ? nix : (process.platform === 'win32' ? 'python' : 'python3');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/api/status');
      if (r.status === 200 || r.status === 401) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

(async () => {
  let pass = 0, fail = 0;
  const check = (n, ok, d) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  — ' + d : ''));
    ok ? pass++ : fail++;
  };

  // ---------------------------------------------------------------- the bundle
  // Checked before anything is launched, so a missing file is reported as a
  // missing file rather than as a mysterious 404 later.
  const bundled = ASSETS.filter(f => fs.existsSync(path.join(BUNDLED_DIR, f)));
  check('the default avatar ships with the studio',
    bundled.length === ASSETS.length,
    bundled.length === ASSETS.length
      ? `${ASSETS.length} files, ${(ASSETS.reduce((n, f) => n + fs.statSync(path.join(BUNDLED_DIR, f)).size, 0) / 1024).toFixed(0)} KB`
      : `missing: ${ASSETS.filter(f => !bundled.includes(f)).join(', ')}`);
  check('the avatar tuning block ships too (blink, mouth-hold, viseme map)',
    fs.existsSync(path.join(ROOT, 'web', 'avatars', 'avatar.json')),
    'web/avatars/avatar.json');

  // Drift guard: the game is the source of truth, so a bundle that no longer
  // matches it means the deploy shows different art from the local preview —
  // silently, because both look plausible on their own.
  const gameHere = fs.existsSync(GAME_AVATAR_DIR);
  if (gameHere) {
    const drifted = ASSETS.filter(f => {
      const g = path.join(GAME_AVATAR_DIR, f);
      const b = path.join(BUNDLED_DIR, f);
      return fs.existsSync(g) && fs.existsSync(b) && sha256(g) !== sha256(b);
    });
    check('the bundled copy matches the game\u2019s (re-copy if the art changed)',
      drifted.length === 0,
      drifted.length ? `differs: ${drifted.join(', ')}` : `identical across ${ASSETS.length} files`);
  } else {
    console.log('SKIP  bundled-vs-game drift — no game folder on this machine');
  }

  // ------------------------------------------------------------- a fake deploy
  const child = spawn(python(), [
    '-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', String(PORT),
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      VERCEL: '1',
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_SHA: 'fa1eade47b73733d6312d5abfad33ce9e4068081',
      // The whole point: a game root that is not there.
      ROGUELIKE_ROOT: path.join(ROOT, '__no_game_folder_here__'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });

  const kill = () => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {}
  };

  let browser = null;
  try {
    if (!await waitForServer()) {
      check('the simulated deploy started', false, serverLog.slice(-400) || 'no output');
      throw new Error('server never came up');
    }
    check('the simulated deploy started', true, `127.0.0.1:${PORT}`);

    const { apiCookie } = require('./session.cjs');
    const cookie = await apiCookie(BASE);
    const h = cookie ? { cookie } : {};

    const reg = await (await fetch(BASE + '/api/avatars', { headers: h })).json();
    check('the deploy really has no game folder (or this proves nothing)',
      reg.root_exists === false, `root ${reg.root}`);

    check('the avatar is discovered anyway, from the bundled copy',
      reg.avatars.length >= 1 && reg.avatars.every(a => a.bundled === true),
      reg.avatars.map(a => a.id + (a.bundled ? ' (bundled)' : ' (game!)')).join(', ') || 'none found');

    const info = await (await fetch(BASE + '/api/lipsync/info', { headers: h })).json();
    check('the info payload says the preview runs off the bundled art',
      info.avatar_source === 'bundled', String(info.avatar_source));

    // The two URLs that were 404ing, plus the atlas the canvas needs.
    for (const name of ASSETS) {
      const url = '/api/avatar/33/' + name;
      const r = await fetch(BASE + url, { headers: h });
      const body = Buffer.from(await r.arrayBuffer());
      const want = name.endsWith('.png') ? 'image/png' : 'application/json';
      check(`the deploy serves ${name}`,
        r.status === 200 && (r.headers.get('content-type') || '').includes(want) && body.length > 500,
        `${r.status} ${r.headers.get('content-type')} ${body.length} B`);
    }

    check('the blink / mouth-hold / viseme tuning survives the deploy',
      info.blink?.per_min > 0 && info.voice?.mouth_min_hold >= 0 && !!info.viseme_states?.states,
      `per_min=${info.blink?.per_min} hold=${info.voice?.mouth_min_hold} states=${JSON.stringify(info.viseme_states?.states)}`);

    // ------------------------------------------------- and it actually draws
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: 'new',
      args: ['--no-sandbox', '--disable-gpu'],
      defaultViewport: { width: 1500, height: 950 },
    });
    const page = await browser.newPage();
    await signIn(page, BASE);
    const errors = [];
    const badResponses = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    page.on('response', r => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().replace(BASE, '')}`); });

    await page.goto(BASE + '/#lipsync', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2500);

    const canvas = await page.evaluate(() => {
      const c = document.querySelector('#lsCanvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
      return { opaque, total: d.length / 4, w: c.width, h: c.height };
    });
    check('the portrait is drawn on the canvas',
      !!canvas && canvas.opaque > canvas.total * 0.2,
      canvas ? `${(100 * canvas.opaque / canvas.total).toFixed(1)}% of ${canvas.w}x${canvas.h} opaque` : 'no canvas');

    check('nothing on the page 404s any more',
      badResponses.length === 0, badResponses.slice(0, 3).join(' | ') || 'no 4xx/5xx');
    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' / ') || 'none');

    const legend = await page.$$eval('#lsLegend .ls-legend:not(.eyes)', e => e.length);
    check('the 9 mouth shapes come from the bundled atlas', legend === 9, legend + ' shapes');

    try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch {}
    await page.screenshot({ path: path.join(SHOT_DIR, 'ls-bundled-deploy.png'),
      clip: { x: 340, y: 52, width: 500, height: 620 } });
  } finally {
    if (browser) await browser.close().catch(() => {});
    kill();
  }

  console.log(`\nSUMMARY: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
