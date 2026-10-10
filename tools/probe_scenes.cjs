/**
 * Does the Scenes page render a multi-speaker example?
 *
 * The page built its voice list as `speaker-<n>` for any speaker with no voice
 * assigned, and posted that as `reference_id`. `speaker-<n>` is not a voice
 * model id — it only means something alongside uploaded `references` — so Fish
 * answered the whole request with 400 "Reference not found", and every example
 * scene failed until a voice was typed into every card. The Lip Sync page never
 * had the bug (studio.js only sets reference_id when it has one), which is why
 * probe_examples.cjs stayed green through all of it.
 *
 * This drives the real page: load the four-speaker example, render it, and
 * assert the request carries no fabricated id and the scene actually arrives.
 * Blank speaker cards are filled from the voice library first (autoAssignVoices
 * in web/js/scenes.js), so the expected outcome is one distinct real voice per
 * speaker, not the default-voice fallback.
 *
 * Costs one TTS call.  Usage: node tools/probe_scenes.cjs
 */
const puppeteer = require('puppeteer-core');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();

  const results = [];
  const check = (name, ok, extra = '') =>
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

  const errors = [];
  const ttsPosts = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('request', r => {
    if (r.method() !== 'POST' || !r.url().includes('/api/tts')) return;
    try { ttsPosts.push(JSON.parse(r.postData() || '{}')); } catch { ttsPosts.push(null); }
  });

  await page.goto(APP + '/#scenes', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  // --- load the example with the biggest cast -----------------------------
  const picked = await page.evaluate(async () => {
    const D3 = await import('/js/drama3.js');
    const items = [...document.querySelectorAll('#sceneExamples .list-item')];
    const names = items.map(el =>
      el.textContent.replace(/^📖/, '').replace(/load$/, '').trim());
    const cast = n => new Set((D3.SCENE_EXAMPLES[n] || '').split('\n')
      .map(l => (l.match(/^\s*([^:]+):/) || [])[1]).filter(Boolean)).size;
    const ranked = names.map(n => ({ n, c: cast(n) })).sort((a, b) => b.c - a.c);
    const best = ranked[0];
    if (!best) return null;
    const el = items[names.indexOf(best.n)];
    if (el) el.click();
    return { name: best.n, cast: best.c, index: names.indexOf(best.n), available: ranked.map(r => `${r.n}(${r.c})`) };
  });
  check('scenes: an example is loadable', !!picked,
        picked ? `${picked.available.length} examples` : 'none found');
  check('scenes: the picked example is a complex one', !!picked && picked.cast >= 3,
        picked ? `${picked.name} — ${picked.cast} speakers` : 'none');
  await sleep(700);

  const cards = await page.$$eval('#sceneSpeakers input.input', els =>
    els.filter(e => e.placeholder && e.placeholder.includes('voice')).map(e => e.value));
  check('scenes: the example detected multiple speakers', cards.length >= 2,
        `${cards.length} speaker card(s)`);
  check('scenes: none of them have a voice yet', cards.every(v => !v),
        cards.every(v => !v) ? 'all blank — the exact case that used to 400'
                             : `some assigned: ${JSON.stringify(cards)}`);

  const scriptText = await page.$eval('#sceneScript', e => e.value);
  check('scenes: the script has per-speaker markers',
        /<\|speaker:\d+\|>/.test(scriptText) || /^[A-Za-z][^:]*:/m.test(scriptText),
        `${scriptText.split('\n').length} lines`);

  // --- the manual control -------------------------------------------------
  // The same fill is also a button, for a scene written by hand rather than
  // loaded from the examples. It fetches the voice library but calls no TTS.
  const readCards = () => page.$$eval('#sceneSpeakers input.input', els =>
    els.filter(e => e.placeholder && e.placeholder.includes('voice')).map(e => e.value));

  const hasBtn = await page.evaluate(() =>
    [...document.querySelectorAll('#sceneSpeakers button')].some(b => /Assign voices/.test(b.textContent)));
  check('scenes: an “Assign voices” control is offered', hasBtn, hasBtn ? '' : 'button not found');

  if (hasBtn) {
    await page.evaluate(() =>
      [...document.querySelectorAll('#sceneSpeakers button')]
        .find(b => /Assign voices/.test(b.textContent)).click());
    for (let i = 0; i < 30; i++) {
      const v = await readCards();
      if (v.length && v.every(Boolean)) break;
      await sleep(500);
    }
    const filled = await readCards();
    check('scenes: the button fills every blank card',
          filled.length >= 2 && filled.every(Boolean),
          `${filled.filter(Boolean).length}/${filled.length} filled`);
    check('scenes: the button picks a distinct voice per speaker',
          new Set(filled).size === filled.length,
          `${new Set(filled).size} distinct`);

    // Reload the example so the render check below exercises the fill that
    // happens inside Render, not the one the button just did.
    await page.evaluate(i => document.querySelectorAll('#sceneExamples .list-item')[i].click(), picked.index);
    await sleep(700);
    const reset = await readCards();
    check('scenes: reloading the example clears the cast again',
          reset.every(v => !v), `${reset.length} blank card(s)`);
  }

  // --- render -------------------------------------------------------------
  await page.click('#sceneRender');
  for (let i = 0; i < 120 && !(await page.$('#scenePlayer audio')); i++) await sleep(1000);

  const toasts = await page.$$eval('#toasts .toast', els =>
    els.map(e => ({ text: e.textContent, err: e.classList.contains('err') })));
  const errToast = toasts.find(t => t.err);

  const body = ttsPosts.at(-1);
  check('scenes: it reached POST /api/tts', !!body,
        body ? `${ttsPosts.length} call(s)` : 'no request captured');

  if (body) {
    const ref = body.reference_id;
    const flat = Array.isArray(ref) ? ref : (ref ? [ref] : []);
    check('scenes: no fabricated `speaker-<n>` id is sent',
          !flat.some(v => /^speaker-\d+$/.test(String(v))),
          flat.length ? `reference_id=${JSON.stringify(flat)}` : 'reference_id omitted');
    check('scenes: speaker markers are in the text',
          /<\|speaker:\d+\|>/.test(body.text || ''),
          (body.text || '').slice(0, 60) + '…');
  }

  check('scenes: no error toast', !errToast, errToast ? errToast.text : 'none');

  const audio = await page.$eval('#scenePlayer audio', a => ({ src: a.src, len: a.src.length }))
    .catch(() => null);
  check('scenes: the rendered scene is playable', !!audio && audio.len > 30,
        audio ? 'audio element with a blob src' : 'no audio element');

  const info = await page.$eval('#scenePlayer .hint', e => e.textContent).catch(() => '');
  check('scenes: output reports turns and speakers', /turns?/.test(info), info.trim());

  // Blank cards should now be filled from the library rather than falling back
  // to the default voice, so the assertion is that the request carried one real
  // voice per speaker — all distinct — and that no fallback was needed.
  const ids = Array.isArray(body?.reference_id) ? body.reference_id : [];
  check('scenes: blank cards are filled with distinct real voices',
        cards.length > 0 && ids.length === cards.length && new Set(ids).size === ids.length,
        ids.length ? `${ids.length} distinct voice(s)` : 'no reference_id sent');
  const note = toasts.find(t => /default voice/i.test(t.text));
  check('scenes: no default-voice fallback is needed', !note,
        note ? note.text : 'no fallback note');

  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

  console.log('\n' + results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`\nSUMMARY: ${results.length - failed}/${results.length} passed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
