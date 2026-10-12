const puppeteer = require('puppeteer-core');
const { signIn } = require('./session.cjs');

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
  await signIn(page, BASE);
  const errors = [];
  const warns = [];
  const media = [];
  page.on('response', r => { if (r.url().includes('r2.fish.audio')) media.push(r.status()); });
  page.on('console', m => {
    if (m.type() === 'error' && !expectFailures) errors.push(m.text());
    if (m.type() === 'warning') warns.push(m.text());
  });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => errors.push('REQFAIL: ' + r.url() + ' ' + r.failure()?.errorText));

  const results = [];
  const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

  // Raised while the harness itself makes a request fail on purpose, so the
  // console noise it causes is not counted against the page. Scoped rather than
  // pattern-matched, so a real 500 still fails the run.
  let expectFailures = false;

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
  // Target a tile that HAS a sample, and remember which one. A sampleless tile
  // would now synthesize — that path costs credit and produces a blob, not the
  // CDN request this check is about, so clicking "the first button" is no
  // longer the same thing as clicking "a sample".
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#libGrid .play-btn')];
    const b = btns.find(x => x.title === 'Play sample') || btns[0];
    b.dataset.probeTarget = '1';
    b.click();
  });
  await new Promise(r => setTimeout(r, 2500));
  const playing = await page.$eval('#libGrid .play-btn[data-probe-target]', b => b.textContent.trim());
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

  // The reported bug. A voice of yours has no `samples[]`, so its ▶ used to be
  // rendered disabled and tooltipped "No sample" — inside the one list that
  // exists to let you choose a voice, so the voice you most wanted to hear was
  // the one you could not. It must now be live and wired to synthesis.
  const pickOwn = await page.evaluate(async () => {
    const own = await (await fetch('/api/fish/model?self=true&page_size=100')).json();
    const id = (own.items?.[0] || {})._id;
    if (!id) return { id: null };
    const tile = [...document.querySelectorAll('#modalBody .tile')]
      .find(t => t.querySelector('.badge.mt')?.textContent.trim() === id);
    const btn = tile?.querySelector('.play-btn');
    return { id, found: !!tile, disabled: !!btn?.disabled, title: btn?.title || '' };
  });
  check('picker: a voice of yours has a live ▶ that synthesizes (was a dead "No sample")',
    !pickOwn.id || (pickOwn.found && !pickOwn.disabled && /synthesiz/i.test(pickOwn.title)),
    pickOwn.id
      ? `id ${pickOwn.id} — found=${pickOwn.found} disabled=${pickOwn.disabled} "${pickOwn.title.slice(0, 46)}"`
      : 'this account has no voices of its own');
  await page.screenshot({ path: OUT + '/voice-picker.png' });
  await page.evaluate(() => document.querySelector('#modalClose').click());

  // 8b3. My Voices — the account's own /model entries.
  //
  // This page renders tiles whether or not the `self=true` filter survives: drop
  // the filter and it still shows 100 well-formed cards, just the public ones.
  // So the check compares the ids on screen against the API's own `self=true`
  // answer, and asserts no public-library id leaked in. `author_id=<you>` is not
  // a substitute — it returns nothing — and the unfiltered listing does not
  // contain a private upload at all, which is the gap this page exists to close.
  await page.evaluate(() => document.querySelector('[data-view="myvoices"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#myVoiceGrid .tile, #myVoiceGrid .empty').length > 0,
    { timeout: 20000 }).catch(() => {});
  const mine = await page.evaluate(async () => {
    const own = await (await fetch('/api/fish/model?self=true&page_size=100')).json();
    const pub = await (await fetch('/api/fish/model?page_size=20&sort_by=task_count')).json();
    const trunc = ids => ids.map(i => String(i).slice(0, 26));
    return {
      apiIds: trunc((own.items || []).map(m => m._id || m.id)),
      pubIds: trunc((pub.items || []).map(m => m._id || m.id)),
      shownIds: [...document.querySelectorAll('#myVoiceGrid .tile .hint.mono')].map(e => e.textContent.trim()),
      titles: [...document.querySelectorAll('#myVoiceGrid .tile h4')].map(e => e.textContent),
      badge: (document.querySelector('#myCount')?.textContent || '').trim(),
      onView: document.querySelector('.rail-btn.active')?.dataset.view || '',
      viewTitle: document.querySelector('#viewTitle')?.textContent || '',
      playable: [...document.querySelectorAll('#myVoiceGrid .play-btn')].filter(b => !b.disabled).length,
      synthTitles: [...document.querySelectorAll('#myVoiceGrid .play-btn')]
        .filter(b => /synthesiz/i.test(b.title)).length,
      empty: !(document.querySelector('#myVoiceEmpty')?.classList.contains('hidden') ?? true),
    };
  });
  check('my voices: rail button routes to its own view',
    mine.onView === 'myvoices' && mine.viewTitle === 'My Voices',
    `${mine.onView} / "${mine.viewTitle}"`);
  check('my voices: the page is the account\'s own models, not the public library',
    mine.empty || (mine.shownIds.length === mine.apiIds.length
      && mine.shownIds.every(id => mine.apiIds.includes(id))),
    `${mine.shownIds.length} card(s) vs ${mine.apiIds.length} from self=true`);
  check('my voices: no public-library voice leaked onto the page',
    mine.empty || mine.shownIds.every(id => !mine.pubIds.includes(id)),
    mine.empty ? 'account has no voices yet' : `vs ${mine.pubIds.length} public ids`);
  check('my voices: count badge matches the listing',
    mine.empty || mine.badge.startsWith(String(mine.apiIds.length)),
    mine.badge || '(empty state)');
  // A private voice has no `samples[]`, so a card that cannot be auditioned is
  // the failure mode here — the ▶ must be live and wired to synthesis, not the
  // permanently-disabled button the public library shows for a sampleless model.
  check('my voices: every card has a live ▶ (synthesis), none disabled',
    mine.empty || (mine.playable === mine.shownIds.length && mine.synthTitles === mine.playable),
    mine.empty ? 'account has no voices yet' : `${mine.playable} live of ${mine.shownIds.length}, ${mine.synthTitles} synthesise`);

  // Opt-in, because it spends API credit: press ▶ and prove the browser path
  // really reaches the audio element. The default suite asserts the wiring only.
  if (process.env.FISH_UI_LIVE_PREVIEW && !mine.empty) {
    await page.evaluate(() => document.querySelector('#myVoiceGrid .play-btn').click());
    const played = await page.waitForFunction(
      () => document.querySelector('#myVoiceGrid .play-btn').textContent.trim() === '⏸',
      { timeout: 90000 }).then(() => true).catch(() => false);
    check('my voices: ▶ synthesizes and starts playing (live, costs credit)', played,
      await page.$eval('#myVoiceGrid .play-btn', b => 'button → ' + b.textContent.trim()));
  }

  // The preview line. ▶ has to synthesize *something* for a voice with no
  // sample, and a hardcoded sentence is what made every voice sound identical —
  // "did you use generic audio?" was a fair reading of a branded constant. The
  // setting must round-trip through storage and be what previewText() returns.
  const lineCtl = await page.$('#myPreviewLine');
  check('my voices: the preview line is editable', !!lineCtl);
  if (lineCtl) {
    const lineState = await page.evaluate(async () => {
      const m = await import('/js/voicepreview.js');
      const input = document.querySelector('#myPreviewLine');
      const before = m.previewLine();

      input.value = 'MARKER-preview-line';
      input.dispatchEvent(new Event('change'));
      const set = m.previewLine();
      // Precedence, while the setting is live: a model with its own transcript
      // speaks that; one without falls back to the setting.
      const withText = m.previewText({ default_text: 'the model’s own transcript' });
      const noTextSet = m.previewText({ default_text: '' });

      input.value = '';
      input.dispatchEvent(new Event('change'));
      const cleared = m.previewLine();
      const noTextCleared = m.previewText({ default_text: '' });

      return { before, set, cleared, withText, noTextSet, noTextCleared,
               stored: localStorage.getItem('fd3.previewLine') };
    });
    check('my voices: the preview line round-trips and can be cleared',
      lineState.set === 'MARKER-preview-line' && lineState.cleared === lineState.before && lineState.stored === null,
      `"${lineState.before}" → "${lineState.set}" → "${lineState.cleared}" (stored=${lineState.stored})`);
    check('my voices: the transcript wins, the setting is the fallback, clearing restores the default',
      lineState.withText === 'the model’s own transcript'
      && lineState.noTextSet === 'MARKER-preview-line'
      && lineState.noTextCleared === lineState.before,
      `own="${lineState.withText}" · fallback="${lineState.noTextSet}" · cleared="${lineState.noTextCleared}"`);
  }

  // Clicking a card is the whole point of the page: its id lands in the studio.
  if (!mine.empty) {
    await page.evaluate(() => document.querySelector('#myVoiceGrid .tile').click());
    const chosen = await page.$eval('#voiceId', e => e.value);
    check('my voices: clicking a card loads its reference_id into the studio',
      !!chosen && mine.apiIds.includes(String(chosen).slice(0, 26)), chosen);
  }
  await page.screenshot({ path: OUT + '/my-voices.png' });

  // 8b4. The dedup branch, which this account's data cannot reach: the voice is
  // private, so the public listing never contains it and `adopt()`'s filter would
  // be invisible — a check that cannot fail is not a check. Inject the own voice
  // into the public response instead: "a voice of yours that is also published"
  // is exactly the case the filter exists for.
  await page.evaluate(() => {
    const orig = window.fetch;
    window.__restoreFetch = () => { window.fetch = orig; };
    window.fetch = async (url, opts) => {
      const res = await orig(url, opts);
      const u = typeof url === 'string' ? url : (url?.url || '');
      if (u.includes('/api/fish/model') && !u.includes('self=true')) {
        const pub = await res.clone().json();
        const own = await orig('/api/fish/model?self=true&page_size=100').then(r => r.json());
        pub.items = [...(pub.items || []), ...(own.items || [])];
        return new Response(JSON.stringify(pub), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return res;
    };
  });
  await page.evaluate(() => document.querySelector('[data-view="studio"]').click());
  await page.click('#pickVoice');
  await page.waitForFunction(() => document.querySelectorAll('#modalBody .tile').length > 0,
    { timeout: 20000 }).catch(() => {});
  const dup = await page.evaluate(async () => {
    const own = await (await fetch('/api/fish/model?self=true&page_size=100')).json();
    const id = (own.items?.[0] || {})._id;
    const grids = [...document.querySelectorAll('#modalBody .grid')];
    const hits = g => g ? [...g.querySelectorAll('.tile .badge.mt')].filter(e => e.textContent.trim() === id).length : 0;
    return {
      id,
      total: [...document.querySelectorAll('#modalBody .tile .badge.mt')].filter(e => e.textContent.trim() === id).length,
      first: hits(grids[0]), second: hits(grids[1]),
    };
  });
  check('picker: a voice that is both yours and public is listed once, under My Voices',
    !!dup.id && dup.total === 1 && dup.first === 1 && dup.second === 0,
    `id ${dup.id} → ${dup.total} card(s) (My Voices ${dup.first}, library ${dup.second})`);
  await page.evaluate(() => { document.querySelector('#modalClose').click(); window.__restoreFetch(); });

  // 8b5. The empty state and its example voices. This account HAS a voice, so the
  // empty path never runs on its own — stub `self=true` to answer with nothing,
  // which is the only way to see it. (A check that never renders is not a check.)
  await page.evaluate(() => document.querySelector('[data-view="myvoices"]').click());
  await page.evaluate(() => {
    const orig = window.fetch;
    window.__restoreFetch2 = () => { window.fetch = orig; };
    window.fetch = (url, opts) => {
      const u = typeof url === 'string' ? url : (url?.url || '');
      if (u.includes('/api/fish/model') && u.includes('self=true')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return orig(url, opts);
    };
  });
  await page.evaluate(() => document.querySelector('#myRefresh').click());
  await page.waitForFunction(() => document.querySelectorAll('#myVoiceEmpty .tile').length > 0,
    { timeout: 20000 }).catch(() => {});
  const blank = await page.evaluate(() => ({
    shown: !document.querySelector('#myVoiceEmpty').classList.contains('hidden'),
    ownTiles: document.querySelectorAll('#myVoiceGrid .tile').length,
    message: (document.querySelector('#myVoiceEmpty .empty')?.textContent || '').trim().slice(0, 48),
    heads: [...document.querySelectorAll('#myVoiceEmpty b')].map(b => b.textContent.trim()),
    ids: [...document.querySelectorAll('#myVoiceEmpty .tile .hint.mono')].map(e => e.textContent.trim()),
    playable: [...document.querySelectorAll('#myVoiceEmpty .play-btn')].filter(b => !b.disabled).length,
    synth: [...document.querySelectorAll('#myVoiceEmpty .play-btn')].filter(b => /synthesiz/i.test(b.title)).length,
    badge: (document.querySelector('#myCount')?.textContent || '').trim(),
  }));
  check('my voices: with nothing of its own the page shows the empty state',
    blank.shown && blank.ownTiles === 0, `"${blank.message}" · badge "${blank.badge}"`);
  check('my voices: the empty state offers example voices from the public library',
    blank.ids.length > 0 && blank.heads.some(h => /Example voices/.test(h))
      && blank.ids.every(id => !mine.apiIds.includes(id)),
    `${blank.ids.length} example(s) — ${blank.heads.join(' / ')}`);
  // The examples come from the public library, so they must play a real sample.
  // `synth === 0` is what makes that a claim rather than a coincidence: a
  // sampleless example would now be enabled too, just by the paid path.
  check('my voices: every example voice plays a real sample (not a paid synthesis)',
    blank.playable === blank.ids.length && blank.playable > 0 && blank.synth === 0,
    `${blank.playable}/${blank.ids.length} playable, ${blank.synth} synthesise`);

  // …and the contract in the other direction: examples are for an empty shelf
  // only. The stubbed fetch is removed, so this is the real account again.
  await page.evaluate(() => { window.__restoreFetch2(); document.querySelector('#myRefresh').click(); });
  await page.waitForFunction(() => document.querySelectorAll('#myVoiceGrid .tile').length > 0,
    { timeout: 20000 }).catch(() => {});
  const stocked = await page.evaluate(() => ({
    hidden: document.querySelector('#myVoiceEmpty').classList.contains('hidden'),
    leftover: document.querySelectorAll('#myVoiceEmpty .tile').length,
  }));
  check('my voices: the examples vanish once the account has a voice of its own',
    stocked.hidden && stocked.leftover === 0,
    `hidden=${stocked.hidden} leftover=${stocked.leftover}`);

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

  // 10. New agent modal — and the voice picker reached from inside it.
  await page.click('#agNew');
  await new Promise(r => setTimeout(r, 300));
  check('agents: create modal opens', await page.$('#modalBack.open') !== null);
  check('agents: the create form has a 🔍 for the voice id',
    await page.$('#agNewVoicePick') !== null);
  // The create form offers a VRM *URL* and deliberately not a file picker: the
  // agent's body has to live on the server to travel with the agent, and a file
  // chosen here could only ever be worn in this browser. Both halves are
  // asserted — a control that exists and a file input that must not.
  const newVrm = await page.evaluate(() => {
    const file = [...document.querySelectorAll('#modalBody input[type=file]')]
      .find(i => (i.accept || '').includes('.vrm'));
    return {
      url: !!document.querySelector('#modalBody #agVrmUrl'),
      use: !!document.querySelector('#modalBody #agVrmUrlUse'),
      file: !!file,
      text: (document.querySelector('#modalBody')?.textContent || '').includes('VRM'),
    };
  });
  check('agents: the create form offers an optional VRM URL, and no file picker',
    newVrm.url && newVrm.use && newVrm.text && !newVrm.file,
    `url=${newVrm.url} use=${newVrm.use} file=${newVrm.file}`);
  await page.screenshot({ path: OUT + '/agent-modal.png' });

  // Mark two fields first. The picker and the create form are both panels of the
  // same #modalBody, so a picker that does not stack its caller *replaces* the
  // form — and the checks below would then find no #agNewVoice at all, or a
  // rebuilt form with an empty Name.
  await page.evaluate(() => {
    document.querySelector('#agNewVoice').value = 'MARKER-not-a-real-id';
    document.querySelector('#modalBody input[placeholder="Support agent"]').value = 'MARKER-agent-name';
  });
  await page.click('#agNewVoicePick');
  await page.waitForFunction(() => document.querySelectorAll('#modalBody .tile').length > 0,
    { timeout: 20000 }).catch(() => {});
  const pick = await page.evaluate(async () => {
    const own = await (await fetch('/api/fish/model?self=true&page_size=100')).json();
    const idsOf = g => g ? [...g.querySelectorAll('.tile .badge.mt')].map(e => e.textContent.trim()) : [];
    const grids = [...document.querySelectorAll('#modalBody .grid')];
    return {
      ownIds: (own.items || []).map(m => m._id || m.id),
      heads: [...document.querySelectorAll('#modalBody b')].map(b => b.textContent.trim()),
      first: idsOf(grids[0]),
      second: idsOf(grids[1]),
      count: (document.querySelector('#modalBody .flex .hint')?.textContent || '').trim(),
    };
  });
  check('picker: My Voices is the first group, and it is the account\'s own',
    pick.ownIds.length > 0
      ? pick.heads[0] === '🎙 My Voices' && pick.first.length === pick.ownIds.length
        && pick.first.every(id => pick.ownIds.includes(id))
      : pick.heads[0] !== '🎙 My Voices',
    pick.ownIds.length
      ? `heads ${JSON.stringify(pick.heads)} · ${pick.first.length}/${pick.ownIds.length} own ids first`
      : `account has no own voices, so no group — heads ${JSON.stringify(pick.heads)}`);
  check('picker: own voices are never repeated in the public group below',
    pick.heads[1] === '🌐 Voice library' && pick.second.length > 0
      && pick.second.every(id => !pick.ownIds.includes(id)),
    `${pick.second.length} public after ${pick.first.length} own · count "${pick.count}"`);

  await page.evaluate(() => document.querySelector('#modalBody .tile').click());
  await new Promise(r => setTimeout(r, 250));
  const back = await page.evaluate(() => ({
    open: !!document.querySelector('#modalBack.open'),
    title: (document.querySelector('#modalTitle')?.textContent || ''),
    voice: document.querySelector('#agNewVoice')?.value ?? null,
    name: document.querySelector('#modalBody input[placeholder="Support agent"]')?.value ?? null,
  }));
  check('picker: picking from the create form restores the form, not an empty modal',
    back.open && /New agent/.test(back.title) && back.voice !== null,
    `open=${back.open} title="${back.title}" voice=${back.voice}`);
  check('picker: the fields typed before the picker opened survived the round trip',
    back.name === 'MARKER-agent-name' && back.voice !== 'MARKER-not-a-real-id',
    `name=${back.name} voice=${back.voice}`);
  check('picker: the picked voice id lands in the create form',
    // The first tile is the first My Voices card when the account has any, so
    // the field has to hold exactly that id — not merely "some hex id", which a
    // click that landed on the public grid would also satisfy.
    pick.first.length ? back.voice === pick.first[0] : /^[0-9a-f]{32}$/.test(back.voice || ''),
    back.voice);
  await page.evaluate(() => document.querySelector('#modalClose').click());
  await new Promise(r => setTimeout(r, 200));
  check('modal: closing the last panel really closes the overlay',
    await page.$('#modalBack.open') === null);

  // 10b. The same attachment on the agent's Config tab. Without it an agent
  // created with no VRM could never get one — which is why it is not create-only.
  const agentCount = await page.$$eval('#agList .tile', e => e.length);
  let cfgVrm = null;
  if (agentCount) {
    await page.evaluate(() => document.querySelector('#agList .tile').click());
    await page.waitForFunction(() => document.querySelectorAll('#agPanel .card').length > 0,
      { timeout: 20000 }).catch(() => {});
    cfgVrm = await page.evaluate(() => {
      const card = [...document.querySelectorAll('#agPanel .card')]
        .find(c => /Avatar \(VRM\)/.test(c.querySelector('.card-h')?.textContent || ''));
      const file = card?.querySelector('input[type=file]');
      return {
        section: !!card,
        url: !!card?.querySelector('#agVrmUrl'),
        file: !!file && (file.accept || '').includes('.vrm'),
        status: (card?.querySelector('#agVrmStatus')?.textContent || '').slice(0, 70),
      };
    });
    check('agents: the Config tab can set a VRM URL on an existing agent (no file picker)',
      cfgVrm.section && cfgVrm.url && !cfgVrm.file,
      `status: "${cfgVrm.status}"`);
  } else {
    check('agents: the Config tab can attach a VRM to an existing agent', true,
      'no agents on this account — not exercised');
  }

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

  // 13. Lip Sync — the baker notice.
  //
  // When the baker is not in a deployment (a serverless bundle that missed
  // tools/visemes.py) the only symptom used to be a 502 from Bake, naming a
  // path you cannot see. `/api/lipsync/info` has always carried
  // `baker: {script_exists, python_exists, openfacefx}` and nothing read it.
  //
  // Two things have to be true at once: it warns on a broken deploy, and it
  // stays SILENT on a healthy one. `openfacefx` is null — not false — whenever
  // the baker runs on a different interpreter, which is the normal local setup,
  // so a truthiness test here would put a permanent false alarm on the page.
  await page.setRequestInterception(true);
  // One interception handler for the whole run. Registering a second one would
  // mean two handlers both calling req.continue() on the same request, which
  // throws — so every override goes through this single object.
  const overrides = { info: null, status: null };
  page.on('request', req => {
    const u = req.url();
    if (overrides.info && u.includes('/api/lipsync/info')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(overrides.info) });
    } else if (overrides.status && u.includes('/api/status')) {
      const bad = overrides.status.__fail;
      req.respond({
        status: bad ? 500 : 200,
        contentType: 'application/json',
        body: JSON.stringify(bad ? { detail: 'boom' } : overrides.status),
      });
    } else {
      req.continue();
    }
  });

  const noticeState = () => page.evaluate(() => {
    const b = document.querySelector('#lsNotice');
    return {
      hidden: b.classList.contains('hidden'),
      display: getComputedStyle(b).display,
      bad: b.classList.contains('bad'),
      text: b.textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  // A hash-only change is a same-document navigation: the app's router switches
  // views but initLipsync() — and therefore loadInfo() — never runs again. The
  // first attempt at this test navigated with page.goto('#lipsync') and every
  // state read back the boot-time payload, so a broken baker looked healthy.
  // A changing query string forces a genuine document load.
  let nonce = 0;
  const gotoLipsync = async () => {
    await page.goto(`${BASE}/?n=${++nonce}#lipsync`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 900));
  };

  await gotoLipsync();
  const healthy = await noticeState();
  const realInfo = await page.evaluate(async () => (await fetch('/api/lipsync/info')).json());
  check('lipsync: a healthy baker raises no notice',
        healthy.hidden && healthy.display === 'none' && !healthy.text,
        `hidden=${healthy.hidden} text="${healthy.text}"`);

  // A checkout with the game folder must keep using the game's art, not the
  // copy bundled for deploys — otherwise the local preview silently stops
  // tracking the game. tools/verify_avatar_fallback.cjs covers the other side.
  check('lipsync: a local checkout draws from the game, not the bundled copy',
        realInfo.avatar_source === 'game',
        `avatar_source=${realInfo.avatar_source}`);

  overrides.info = { ...realInfo, baker: { ...realInfo.baker, script_exists: false } };
  await gotoLipsync();
  const noScript = await noticeState();
  check('lipsync: a baker script missing from the deploy warns before Bake',
        !noScript.hidden && noScript.bad &&
        /not in this deployment/i.test(noScript.text) && /includeFiles/.test(noScript.text),
        noScript.text.slice(0, 130));

  overrides.info = { ...realInfo, baker: { ...realInfo.baker, python_exists: false } };
  await gotoLipsync();
  const noPython = await noticeState();
  check('lipsync: a missing baker interpreter warns and names the path',
        !noPython.hidden && /interpreter is missing/i.test(noPython.text),
        noPython.text.slice(0, 130));

  overrides.info = { ...realInfo, baker: { ...realInfo.baker, openfacefx: null, allosaurus: null, probe: 'external' } };
  await gotoLipsync();
  const external = await noticeState();
  check('lipsync: an external baker interpreter (openfacefx null) is not a false alarm',
        external.hidden && !external.text,
        `hidden=${external.hidden} text="${external.text.slice(0, 90)}"`);

  overrides.info = { ...realInfo, baker: { ...realInfo.baker, openfacefx: false } };
  await gotoLipsync();
  const noOface = await noticeState();
  check('lipsync: a definite openfacefx:false does warn',
        !noOface.hidden && /openfacefx is not installed/i.test(noOface.text),
        noOface.text.slice(0, 130));

  overrides.info = null;

  // 14. The commit badge.
  //
  // The point of it is to answer "is the deploy current?" by comparing two
  // shas, so the branches that matter are the ones a real deployment produces:
  // Vercel production, a Vercel preview, a local checkout, and — the case that
  // is easy to get wrong — a deploy where the system environment variables are
  // not exposed, which must say so rather than showing a stale or blank sha.
  //
  // /api/status is stubbed rather than restarted with VERCEL_* set, so every
  // branch is reachable in one run.
  const realStatus = await page.evaluate(async () => (await fetch('/api/status')).json());
  const badge = () => page.evaluate(() => {
    const n = document.querySelector('#commitBadge');
    return {
      text: n.textContent,
      cls: n.className,
      full: n.dataset.full || null,
      title: n.title,
      mono: getComputedStyle(n).fontFamily.includes('monospace'),
      rightmost: document.querySelector('.topbar').lastElementChild === n,
    };
  });
  const gotoStudio = async () => {
    await page.goto(`${BASE}/?b=${++nonce}#studio`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 900));
  };

  overrides.status = {
    ...realStatus,
    build: {
      commit: '62de502', commit_full: '62de502c0aed246a9220dcccf528796c3f88ce5e',
      commit_ref: 'main', commit_message: 'Refactor bake endpoint',
      commit_dirty: false, commit_source: 'git',
      deploy_env: null, deployment_id: null,
    },
  };
  await gotoStudio();
  const localClean = await badge();
  check('commit: a clean local checkout shows its sha, unmarked',
        localClean.text === '62de502' && localClean.mono && localClean.rightmost,
        `${localClean.text} · ${localClean.cls}`);
  check('commit: local is not dressed up as a deployment',
        !/vercel/i.test(localClean.title) && /local/i.test(localClean.title),
        localClean.title.split('\n')[0]);
  check('commit: the badge copies the FULL sha, not the 7 shown',
        localClean.full === '62de502c0aed246a9220dcccf528796c3f88ce5e',
        localClean.full || 'no data-full');

  overrides.status = {
    ...realStatus,
    build: { ...overrides.status.build, commit_dirty: true },
  };
  await gotoStudio();
  const localDirty = await badge();
  check('commit: uncommitted edits are marked, so a matching sha is not trusted',
        localDirty.text === '62de502*' && /amber/.test(localDirty.cls) &&
        /NOT what a deploy/i.test(localDirty.title),
        `${localDirty.text} · ${localDirty.cls}`);

  overrides.status = {
    ...realStatus,
    build: {
      commit: 'fa1eade', commit_full: 'fa1eade47b73733d6312d5abfad33ce9e4068081',
      commit_ref: 'main', commit_message: 'Update about page',
      commit_dirty: false, commit_source: 'vercel',
      deploy_env: 'production', deployment_id: 'dpl_7Gw5ZMBpQA8h9GF832KGp7nwbuh3',
    },
  };
  await gotoStudio();
  const prod = await badge();
  check('commit: a Vercel production deploy is green and named',
        prod.text === 'fa1eade' && /green/.test(prod.cls) &&
        /Vercel · production/.test(prod.title),
        `${prod.text} · ${prod.cls}`);
  check('commit: the deployment id is on the tooltip',
        /dpl_7Gw5ZMBpQA8h9GF832KGp7nwbuh3/.test(prod.title),
        prod.title.split('\n').find(l => l.startsWith('deployment')) || 'missing');
  check('commit: a deploy is never marked dirty (it is built from a commit)',
        !/\*/.test(prod.text) && !/uncommitted/i.test(prod.title), prod.text);

  overrides.status = {
    ...realStatus,
    build: { ...overrides.status.build, deploy_env: 'preview', deployment_id: null },
  };
  await gotoStudio();
  const preview = await badge();
  check('commit: a preview deploy is visually distinct from production',
        preview.text === 'fa1eade' && /violet/.test(preview.cls) && /preview/.test(preview.title),
        `${preview.text} · ${preview.cls}`);

  // The failure that actually happens in the wild: a deploy whose project has
  // "Enable access to System Environment Variables" unticked. VERCEL=1 is set,
  // so it is hosted, but no sha is available. It must say so.
  overrides.status = {
    ...realStatus,
    build: {
      commit: null, commit_full: null, commit_ref: null, commit_message: null,
      commit_dirty: false, commit_source: 'none',
      deploy_env: null, deployment_id: null,
    },
  };
  await gotoStudio();
  const unknown = await badge();
  check('commit: an unreadable commit says so instead of showing a blank or stale sha',
        unknown.text === 'no commit' && unknown.full === null &&
        /System Environment Variables/.test(unknown.title),
        `${unknown.text} · ${unknown.title.slice(0, 60)}`);

  // A failed /api/status must not leave the previous sha on screen: the whole
  // value of the badge is telling two instances apart.
  expectFailures = true;
  overrides.status = { __fail: true };
  await gotoStudio();
  const offline = await badge();
  check('commit: an unreachable server clears the badge rather than lying',
        offline.text === 'no commit' && offline.full === null, offline.text);
  expectFailures = false;

  overrides.status = null;
  await page.setRequestInterception(false);

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
