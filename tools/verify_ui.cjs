const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8756';
const OUT = 'C:/Users/PC/AppData/Local/Temp/shots';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1500,950'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const errors = [];
  const warns = [];
  const media = [];
  page.on('response', r => { if (r.url().includes('r2.fish.audio')) media.push(r.status()); });
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning') warns.push(m.text());
  });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => errors.push('REQFAIL: ' + r.url() + ' ' + r.failure()?.errorText));

  const results = [];
  const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

  await page.goto(BASE + '/#studio', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 900));

  // 0. The chrome is the app's mark, not an emoji placeholder: a drawn SVG in the
  // rail and a matching SVG favicon (a theatre-mask emoji used to stand in for both).
  const chrome = await page.evaluate(() => ({
    logo: document.querySelector('.rail .logo')?.querySelector('svg') ? document.querySelector('.rail .logo svg').querySelectorAll('path, circle').length : 0,
    logoText: (document.querySelector('.rail .logo')?.textContent || '').trim(),
    icon: document.querySelector('link[rel="icon"]')?.getAttribute('href') || '',
  }));
  check('chrome: the rail logo is a drawn mark, not an emoji',
        chrome.logo >= 2 && chrome.logoText === '',
        `${chrome.logo} shapes, text "${chrome.logoText}"`);
  check('chrome: the favicon matches it',
        chrome.icon.startsWith('data:image/svg+xml') && chrome.icon.includes('<svg')
        && !/[\u{1F000}-\u{1FAFF}]/u.test(chrome.icon), chrome.icon.slice(0, 46) + '…');

  // 1. Studio renders
  check('studio: rail + editor present', await page.$('#editor') !== null);
  const tagChips = await page.$$eval('#tagbar .tag-chip', els => els.length);
  check('studio: tag chips built', tagChips >= 15, tagChips + ' chips');

  // 2. Typing + highlight
  await page.click('#editor');
  await page.type('#editor', "[calm] Everything's fine — [trembling, panicked] wait, did you hear that? [pause] Yeah. <whisper>quiet.</whisper>", { delay: 1 });
  await new Promise(r => setTimeout(r, 250));
  const hl = await page.$eval('#editorHL', e => e.innerHTML);
  check('highlight: direction span', hl.includes('tok-dir'), '');
  check('highlight: sound tag span', hl.includes('tok-tag'));
  const stats = await page.$eval('#statDir', e => e.textContent);
  check('analysis: direction count', /[1-9]/.test(stats), stats);

  // 3. Tag chip inserts
  const before = await page.$eval('#editor', e => e.value.length);
  await page.evaluate(() => [...document.querySelectorAll('#tagbar .tag-chip')].find(c => c.textContent === '[sigh]').click());
  const after = await page.$eval('#editor', e => e.value.length);
  check('tag chip inserts text', after > before, `${before}→${after}`);

  // 4. Wrap-selection
  await page.evaluate(() => { const ed = document.querySelector('#editor'); ed.setSelectionRange(0, 5); ed.dispatchEvent(new Event('select')); });
  await page.evaluate(() => [...document.querySelectorAll('#tagbar .tag-chip')].find(c => c.textContent === '<emphasis>').click());
  const v2 = await page.$eval('#editor', e => e.value);
  check('wrap selection adds paired tag', v2.includes('<emphasis>') && v2.includes('</emphasis>'), v2.slice(0, 24));

  // 5. Auto Tag
  await page.$eval('#editor', e => { e.value = 'Detective: You were there that night.\nSuspect: I was home. Asleep.\nDetective: Then why is your coat still wet?'; e.dispatchEvent(new Event('input')); });
  await page.click('#autoBtn');
  await new Promise(r => setTimeout(r, 300));
  const tagged = await page.$eval('#editor', e => e.value);
  check('auto-tag adds directions', /\[[a-z]/.test(tagged) && tagged.split('\n').filter(l => /^\S+:\s*\[/.test(l)).length >= 2, tagged.split('\n')[1]?.slice(0, 40));
  await page.screenshot({ path: OUT + '/studio-typed.png' });

  // 6. Scenes
  await page.evaluate(() => document.querySelector('[data-view="scenes"]').click());
  await new Promise(r => setTimeout(r, 400));
  check('scenes: script editor injected', await page.$('#sceneScript') !== null);
  await page.evaluate(() => [...document.querySelectorAll('#sceneExamples .list-item')][1].click());
  await new Promise(r => setTimeout(r, 300));
  const speakerCards = await page.$$eval('#sceneSpeakers .card', els => els.length);
  check('scenes: speakers detected from example', speakerCards >= 2, speakerCards + ' cards');
  await page.screenshot({ path: OUT + '/scenes.png' });

  // 7. Voice design
  await page.evaluate(() => document.querySelector('[data-view="design"]').click());
  await new Promise(r => setTimeout(r, 300));
  const vdExamples = await page.$$eval('#vdExamples .list-item', e => e.length);
  check('design: prompt examples loaded', vdExamples >= 3, vdExamples + ' prompts');
  await page.screenshot({ path: OUT + '/design.png' });

  // 8. Library (hits real API)
  await page.evaluate(() => document.querySelector('[data-view="library"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#libGrid .tile').length > 0, { timeout: 20000 }).catch(() => {});
  const libTiles = await page.$$eval('#libGrid .tile', e => e.length);
  check('library: voice models loaded from API', libTiles > 0, libTiles + ' tiles');

  // 8b. Voice samples actually play
  const playBtns = await page.$$eval('#libGrid .play-btn', els => els.filter(b => !b.disabled).length);
  check('library: sample play buttons present', playBtns > 0, playBtns + ' playable');
  const sampleTexts = await page.$$eval('#libGrid .sample-text', e => e.length);
  check('library: sample transcripts shown', sampleTexts > 0, sampleTexts + ' shown');
  await page.evaluate(() => document.querySelector('#libGrid .play-btn').click());
  await new Promise(r => setTimeout(r, 2500));
  const playing = await page.$eval('#libGrid .play-btn', b => b.textContent.trim());
  check('library: sample audio starts playing', playing === '⏸', 'button → ' + playing);
  check('library: sample MP3 fetched from CDN', media.some(s => s === 200 || s === 206), media.length ? 'status ' + media.join(',') : 'no media request seen');
  await page.screenshot({ path: OUT + '/library.png' });

  // 8b2. Studio voice picker also has samples
  await page.evaluate(() => document.querySelector('[data-view="studio"]').click());
  await new Promise(r => setTimeout(r, 200));
  await page.click('#pickVoice');
  await page.waitForFunction(() => document.querySelectorAll('#modalBody .tile').length > 0, { timeout: 20000 }).catch(() => {});
  const pickTiles = await page.$$eval('#modalBody .tile', e => e.length);
  const pickPlays = await page.$$eval('#modalBody .play-btn, #modalBody .btn.icon', e => e.length);
  check('picker: voices listed with play buttons', pickTiles > 0 && pickPlays > 0, `${pickTiles} voices, ${pickPlays} players`);
  await page.screenshot({ path: OUT + '/voice-picker.png' });
  await page.evaluate(() => document.querySelector('#modalClose').click());

  // 8c. Examples library
  await page.evaluate(() => document.querySelector('[data-view="examples"]').click());
  await new Promise(r => setTimeout(r, 400));
  const featBlocks = await page.$$eval('#exList .card', e => e.length);
  const exCards = await page.$$eval('#exList .example-card', e => e.length);
  const exNav = await page.$$eval('#exNav .ex-nav-item', e => e.length);
  // The tag reference is 7 grammar rows plus a hint div, with the tag-library
  // picker button above them — count the button too, it is a real way in.
  const exTags = await page.$$eval('#exTags > div', e => e.length);
  const exPicker = await page.$$eval('#exTags > button', e => e.length);
  // 12 hand-written feature blocks plus the tag library that is rendered out of
  // web/js/tags.js, which is a block but not a feature with its own items.
  check('examples: 12 feature blocks + the tag library', featBlocks === 13, featBlocks + ' blocks');
  check('examples: example scripts rendered', exCards >= 39, exCards + ' examples');
  check('examples: sidebar nav + tag reference + library button',
    exNav === featBlocks && exTags === 8 && exPicker === 1,
    `${exNav} nav, ${exTags} rows, ${exPicker} library button`);

  // Every shipped script must be tag-balanced — a stray </whisper> in a long
  // example is invisible in the UI but breaks the synthesis outright.
  const linted = await page.evaluate(async () => {
    const E = await import('/js/examples.js');
    const D3 = await import('/js/drama3.js');
    const T = await import('/js/tags.js');
    const bad = [];
    let total = 0;
    // A block may carry `items`, or be the tag library (`library: true`), which
    // renders its examples from tags.js instead of restating them. Both are
    // shipped scripts and both have to lint.
    for (const f of E.FEATURES) for (const it of f.items || []) {
      total++;
      const issues = D3.lint(it.script);
      if (issues.length) bad.push(`block ${f.n}: ${issues.join('; ')}`);
    }
    for (const c of T.TAG_CATEGORIES) for (const t of c.tags) {
      total++;
      const issues = D3.lint(t.text);
      if (issues.length) bad.push(`tag "${t.label}": ${issues.join('; ')}`);
    }
    for (const [name, s] of Object.entries(D3.SCENE_EXAMPLES)) {
      total++;
      const issues = D3.lint(s);
      if (issues.length) bad.push(`scene "${name}": ${issues.join('; ')}`);
    }
    return { total, bad };
  });
  check('examples: every script is tag-balanced', linted.bad.length === 0,
    linted.bad.length ? linted.bad.slice(0, 3).join(' | ') : `${linted.total} scripts clean`);

  // The longer scenes have to survive the scene parser too: four speakers must
  // come out as four speakers, not three with one line glued onto another.
  const parsed = await page.evaluate(async () => {
    const D3 = await import('/js/drama3.js');
    const out = {};
    for (const [name, s] of Object.entries(D3.SCENE_EXAMPLES)) {
      const p = D3.parseScene(s);
      out[name] = { speakers: p.speakers.length, turns: p.turns.length };
    }
    return out;
  });
  check('scenes: the four-hander parses to four speakers',
    parsed['Heist briefing']?.speakers === 4 && parsed['Heist briefing']?.turns === 9,
    JSON.stringify(parsed['Heist briefing'] || {}));
  check('scenes: every preset yields speakers and turns',
    Object.values(parsed).every(v => v.speakers >= 2 && v.turns >= 2),
    Object.entries(parsed).map(([k, v]) => `${k}:${v.speakers}s/${v.turns}t`).join(' '));
  await page.screenshot({ path: OUT + '/examples.png' });

  // 8d. Load an example into the studio
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#exList .example-card')].find(c => /barely holding it together/.test(c.textContent));
    [...card.querySelectorAll('button')].find(b => /Load into studio/.test(b.textContent)).click();
  });
  await new Promise(r => setTimeout(r, 400));
  const loaded = await page.$eval('#editor', e => e.value);
  check('examples: load into studio works', /barely holding it together/.test(loaded), loaded.slice(0, 42));
  const onStudio = await page.$eval('.rail-btn.active', e => e.dataset.view);
  check('examples: load switches to studio view', onStudio === 'studio', onStudio);

  // 8e. Scene example opens Scenes
  await page.evaluate(() => document.querySelector('[data-view="examples"]').click());
  await new Promise(r => setTimeout(r, 250));
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#exList .example-card')].find(c => /Who ate the last slice/.test(c.textContent));
    [...card.querySelectorAll('button')].find(b => /Open in Scenes/.test(b.textContent)).click();
  });
  await new Promise(r => setTimeout(r, 400));
  const sceneVal = await page.$eval('#sceneScript', e => e.value);
  check('examples: scene example opens in Scenes', /Who ate the last slice/.test(sceneVal), sceneVal.slice(0, 34));

  // 8f. The long four-hander has to reach Scenes and come back as four voices
  await page.evaluate(() => document.querySelector('[data-view="examples"]').click());
  await new Promise(r => setTimeout(r, 250));
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#exList .example-card')].find(c => /We have ninety seconds/.test(c.textContent));
    [...card.querySelectorAll('button')].find(b => /Open in Scenes/.test(b.textContent)).click();
  });
  await new Promise(r => setTimeout(r, 500));
  const fourHand = await page.evaluate(() => ({
    speakers: document.querySelectorAll('#sceneSpeakers .speaker-card, #sceneSpeakers .card').length,
    text: document.querySelector('#sceneScript')?.value || '',
  }));
  check('examples: the four-hander opens in Scenes',
    /We have ninety seconds/.test(fourHand.text) && /Dex:/.test(fourHand.text),
    fourHand.speakers + ' speaker card(s)');
  // Exactly four: loading a scene replaces the cast rather than piling onto it.
  check('examples: four speakers each get their own card', fourHand.speakers === 4,
    fourHand.speakers + ' cards');

  // 9. Agents (real API, empty workspace)
  await page.evaluate(() => document.querySelector('[data-view="agents"]').click());
  await new Promise(r => setTimeout(r, 1200));
  const agText = await page.$eval('#agList', e => e.textContent);
  check('agents: list rendered (empty workspace ok)', agText.length > 0 && !agText.includes('Could not load'), agText.trim().slice(0, 60));
  await page.screenshot({ path: OUT + '/agents.png' });

  // 10. New agent modal
  await page.click('#agNew');
  await new Promise(r => setTimeout(r, 300));
  check('agents: create modal opens', await page.$('#modalBack.open') !== null);
  await page.screenshot({ path: OUT + '/agent-modal.png' });
  await page.evaluate(() => document.querySelector('#modalClose').click());

  // 11. Live call view
  await page.evaluate(() => document.querySelector('[data-view="live"]').click());
  await new Promise(r => setTimeout(r, 500));
  const liveOpts = await page.$$eval('#liveAgent option', e => e.length);
  check('live: agent dropdown populated', liveOpts >= 1, liveOpts + ' options');

  // 12. Settings + coverage
  await page.evaluate(() => document.querySelector('[data-view="settings"]').click());
  await new Promise(r => setTimeout(r, 300));
  const cov = await page.$$eval('#apiCoverage .kv', e => e.length);
  check('settings: api coverage listed', cov >= 15, cov + ' endpoints');
  const keyBadge = await page.$eval('#keyBadge', e => e.textContent);
  check('settings: key status badge', /key/.test(keyBadge), keyBadge);
  await page.screenshot({ path: OUT + '/settings.png' });

  console.log('\n===== CHECKS =====');
  results.forEach(r => console.log(r));
  console.log('\n===== CONSOLE ERRORS (' + errors.length + ') =====');
  [...new Set(errors)].forEach(e => console.log(' • ' + e.slice(0, 220)));
  console.log('\n===== CONSOLE WARNINGS (' + warns.length + ') =====');
  [...new Set(warns)].slice(0, 8).forEach(e => console.log(' • ' + e.slice(0, 160)));

  const failed = results.filter(r => r.startsWith('FAIL'));
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
  await browser.close();
  process.exit(failed.length || errors.filter(e => !e.includes('REQFAIL')).length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
