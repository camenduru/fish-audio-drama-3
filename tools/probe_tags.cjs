/**
 * Does the complex tag library work from anywhere, and insert where it should?
 *
 * The library is a shelf of ready-made combinations (direction + sound tag +
 * scoped span in one line). The risky parts are not the content but the
 * plumbing: that the picker is reachable from every entry point, that it knows
 * which field to write into, and that a paired tag wraps a selection instead of
 * destroying it. Those are what this drives, in a real browser, on the real
 * page — including the studio editor's caret, which is the hardest case.
 *
 * Costs no API calls.  Usage: node tools/probe_tags.cjs
 */
const puppeteer = require('puppeteer-core');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto(APP + '/#studio', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1500);

  // ---------------------------------------------------------------- library
  const lib = await page.evaluate(async () => {
    const T = await import('/js/tags.js');
    return {
      total: T.TAG_TOTAL,
      cats: T.TAG_CATEGORIES.map(c => ({ id: c.id, title: c.title, n: c.tags.length })),
      // every entry must be insertable: non-empty text, and a wrap pair that
      // actually encloses something if one is declared
      bad: T.TAG_CATEGORIES.flatMap(c => c.tags.filter(t =>
        !t.text || !t.label || (t.wrap && (!t.wrap.open || !t.wrap.close)))),
      // scene starters are multi-line; the rest are single lines
      multiline: T.TAG_CATEGORIES.flatMap(c => c.tags.filter(t => t.text.includes('\n'))).length,
      hasCombos: T.TAG_CATEGORIES.flatMap(c => c.tags).filter(t =>
        /\[/.test(t.text) && (/<[a-z]/.test(t.text) || /\[\w/.test(t.text.replace(/^\[[^\]]*\]/, '')))).length,
      sceneCats: T.TAG_CATEGORIES.filter(c => c.scene).length,
      // A tag whose text is only tags/uppercase phonemes cannot be heard on its
      // own, so the Examples page needs an `example` for it.
      fragments: T.TAG_CATEGORIES.flatMap(c => c.tags)
        .filter(t => !t.example && !/[a-z]{3,}/.test(t.text.replace(/<[^>]*>/g, '')))
        .map(t => t.label),
      fragmentsOk: T.TAG_CATEGORIES.flatMap(c => c.tags)
        .filter(t => !t.example && !/[a-z]{3,}/.test(t.text.replace(/<[^>]*>/g, ''))).length === 0,
    };
  });

  check('library: it is a real library', lib.total >= 60, `${lib.total} tags in ${lib.cats.length} categories`);
  check('library: every category has tags', lib.cats.every(c => c.n > 0),
        lib.cats.map(c => c.n).join(','));
  check('library: every entry is insertable', lib.bad.length === 0,
        lib.bad.length ? lib.bad.map(t => t.label).join(', ') : 'no empty text or broken wrap pairs');
  check('library: entries are combinations, not single keywords', lib.hasCombos >= 40,
        `${lib.hasCombos} entries stack a direction with a tag or a scoped span`);
  check('library: scene starters are multi-line', lib.multiline >= 4, `${lib.multiline} multi-line entries`);
  check('library: fragments carry a standalone example', lib.fragmentsOk,
        lib.fragments.length ? 'missing examples: ' + lib.fragments.join(', ') : 'every bare fragment has one');
  check('library: scene categories are flagged', lib.sceneCats === 2,
        `${lib.sceneCats} categories load into Scenes`);

  // ------------------------------------------------------------- the opener
  const fab = await page.$('#tagFab');
  check('opener: a floating button exists on every page', !!fab);
  await page.click('#tagFab');
  await sleep(500);

  const opened = await page.evaluate(() => {
    const back = document.querySelector('#modalBack');
    return {
      open: back?.classList.contains('open'),
      title: document.querySelector('#modalTitle')?.textContent || '',
      cats: document.querySelectorAll('#tagList .tag-cat').length,
      openCats: document.querySelectorAll('#tagList .tag-cat[open]').length,
      items: document.querySelectorAll('#tagList .tag-item').length,
      options: [...document.querySelectorAll('#tagCat option')].map(o => o.textContent),
      where: document.querySelector('#tagWhere')?.textContent || '',
    };
  });
  check('opener: the popup opens', opened.open === true);
  check('opener: the title states the size', /\d\d/.test(opened.title), opened.title);
  check('opener: categories render as dropdowns', opened.cats === lib.cats.length,
        `${opened.cats} dropdowns, ${opened.openCats} open by default`);
  check('opener: the category select lists them all', opened.options.length === lib.cats.length + 1,
        `${opened.options.length} options (incl. All)`);
  check('opener: tags are rendered', opened.items >= lib.total, `${opened.items} tag cards`);
  check('opener: it says where it will insert', /No text field/.test(opened.where), opened.where);

  // ------------------------------------------------------ category dropdown
  await page.select('#tagCat', 'game');
  await sleep(300);
  const filtered = await page.evaluate(() => ({
    cats: document.querySelectorAll('#tagList .tag-cat').length,
    items: document.querySelectorAll('#tagList .tag-item').length,
    title: document.querySelector('#tagList .tag-cat summary')?.textContent || '',
  }));
  check('dropdown: choosing a category shows only it', filtered.cats === 1 && /Game barks/.test(filtered.title),
        `${filtered.cats} category, ${filtered.items} tags — ${filtered.title.trim().slice(0, 40)}`);

  // ---------------------------------------------------------------- search
  await page.select('#tagCat', '');
  await sleep(200);
  await page.click('#tagSearch');
  await page.type('#tagSearch', 'whisper');
  await sleep(300);
  const searched = await page.evaluate(() => ({
    items: [...document.querySelectorAll('#tagList .tag-item .tag-item-label')].map(e => e.textContent),
  }));
  check('search: it narrows the list', searched.items.length > 0 && searched.items.length < lib.total,
        `${searched.items.length} matches for "whisper"`);
  await page.evaluate(() => {
    const s = document.querySelector('#tagSearch');
    s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);

  // -------------------------------------------- insertion into the studio
  await page.click('#modalClose');
  await sleep(300);

  // Focus the editor and leave the caret in an empty buffer.
  await page.evaluate(() => {
    const ed = document.querySelector('#editor');
    ed.value = '';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.focus();
    ed.setSelectionRange(0, 0);
  });
  await page.click('#tagLibBtn');
  await sleep(400);

  const whereStudio = await page.evaluate(() => document.querySelector('#tagWhere')?.textContent || '');
  check('studio: the picker knows the editor is the target', /Inserting into/.test(whereStudio), whereStudio);

  const inserted = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('#tagList .tag-item')]
      .find(i => /Anger → collapse/.test(i.querySelector('.tag-item-label')?.textContent || ''));
    if (!hit) return null;
    hit.click();
    return document.querySelector('#editor').value;
  });
  check('studio: a tag inserts into the editor', !!inserted && /Get out/.test(inserted),
        inserted ? inserted.slice(0, 46) + '…' : 'tag card not found');
  check('studio: the popup stays open for stacking',
        await page.evaluate(() => document.querySelector('#modalBack').classList.contains('open')));
  check('studio: the editor highlight kept up',
        await page.evaluate(() => /tok-dir|tok-tag/.test(document.querySelector('#editorHL').innerHTML)));

  // ------------------------------------------- a paired tag wraps a selection
  await page.evaluate(() => {
    const ed = document.querySelector('#editor');
    ed.value = 'I never said that out loud';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.focus();
    ed.setSelectionRange(13, 21);          // exactly "that out"
  });
  await page.evaluate(() => {
    const s = document.querySelector('#tagSearch');
    s.value = 'Wrap any word'; s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(250);
  const wrapped = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('#tagList .tag-item')]
      .find(i => /Wrap any word/.test(i.querySelector('.tag-item-label')?.textContent || ''));
    if (!hit) return null;
    hit.click();
    return document.querySelector('#editor').value;
  });
  check('studio: a paired tag wraps the selection instead of replacing it',
        !!wrapped && /<\|phoneme_start\|>that out<\|phoneme_end\|>/.test(wrapped),
        wrapped || 'tag card not found');
  await page.click('#modalClose');
  await sleep(300);

  // --------------------------------------------------------- the shortcut
  await page.evaluate(() => document.querySelector('#editor').focus());
  await page.keyboard.down('Control');
  await page.keyboard.press('/');
  await page.keyboard.up('Control');
  await sleep(500);
  const viaKey = await page.evaluate(() => ({
    open: document.querySelector('#modalBack')?.classList.contains('open'),
    where: document.querySelector('#tagWhere')?.textContent || '',
  }));
  check('shortcut: Ctrl+/ opens the picker', viaKey.open === true);
  check('shortcut: it targets the field you were last in', /Inserting into/.test(viaKey.where), viaKey.where);
  await page.click('#modalClose');
  await sleep(300);

  // ------------------------------------------------------ insertion into Scenes
  await page.evaluate(() => document.querySelector('[data-view="scenes"]').click());
  await sleep(600);
  const hasSceneBtn = await page.$('#sceneTags');
  check('scenes: the script editor offers the library', !!hasSceneBtn);
  await page.click('#sceneTags');
  await sleep(400);
  const sceneWhere = await page.evaluate(() => document.querySelector('#tagWhere')?.textContent || '');
  check('scenes: the picker targets the scene script', /Inserting into/.test(sceneWhere), sceneWhere);

  await page.evaluate(() => {
    const s = document.querySelector('#tagSearch');
    s.value = 'Reactor breach'; s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(250);
  const sceneInserted = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('#tagList .tag-item')]
      .find(i => /Reactor breach/.test(i.querySelector('.tag-item-label')?.textContent || ''));
    if (!hit) return null;
    hit.click();
    return document.querySelector('#sceneScript').value;
  });
  // The page re-parses the script on a 250 ms debounce, so the cast appears a
  // beat after the text does.
  await sleep(700);
  const sceneCards = await page.evaluate(() =>
    document.querySelectorAll('#sceneSpeakers input[placeholder*="voice"]').length);
  check('scenes: a whole multi-speaker scene inserts', !!sceneInserted && /Sentry:/.test(sceneInserted),
        sceneInserted ? sceneInserted.split('\n').length + ' lines' : 'tag card not found');
  // Narrator, Sentry, Captain — Sentry speaks twice, so three unique speakers.
  check('scenes: the cast is detected from what was inserted', sceneCards === 3,
        `${sceneCards} speaker card(s)`);
  await page.click('#modalClose');
  await sleep(300);

  // ---------------------------------------------------------- the other hooks
  const hooks = await page.evaluate(() => ({
    live: !!document.querySelector('#liveText')?.parentElement?.querySelector('button[title*="Complex tags"]'),
    examples: /Complex tag library/.test(document.querySelector('#exTags')?.textContent || ''),
  }));
  check('live call: the message box offers the library', hooks.live);
  check('examples: the sidebar links to the library', hooks.examples);

  // ------------------------------------- the library as examples, on the page
  await page.evaluate(() => document.querySelector('[data-view="examples"]').click());
  await sleep(900);
  const exLib = await page.evaluate(() => {
    const inLib = [...document.querySelectorAll('#exList .example-card')].filter(c => c.closest('.tag-cat'));
    const scripts = inLib.map(c => c.querySelector('.example-script')?.textContent || '');
    return {
      cats: document.querySelectorAll('#exList .tag-cat').length,
      cards: inLib.length,
      empty: scripts.filter(s => !s.trim()).length,
      labelled: inLib.filter(c => (c.querySelector('.example-label span')?.textContent || '').trim()).length,
      loadButtons: inLib.filter(c => /Load into studio|Open in Scenes/.test(c.textContent)).length,
      sceneButtons: inLib.filter(c => /Open in Scenes/.test(c.textContent)).length,
      nav: [...document.querySelectorAll('#exNav .ex-nav-item')].map(n => n.textContent),
    };
  });
  check('examples: the library is a section of its own', exLib.cats === lib.cats.length,
        `${exLib.cats} category dropdowns on the page`);
  check('examples: every tag has an example card', exLib.cards === lib.total,
        `${exLib.cards} cards for ${lib.total} tags`);
  check('examples: every card is named', exLib.labelled === exLib.cards, `${exLib.labelled}/${exLib.cards}`);
  check('examples: no card is empty', exLib.empty === 0, `${exLib.empty} empty scripts`);
  check('examples: every card can be loaded', exLib.loadButtons === exLib.cards,
        `${exLib.loadButtons}/${exLib.cards} have a load action`);
  check('examples: scene starters load into Scenes instead', exLib.sceneButtons === 7,
        `${exLib.sceneButtons} scene cards`);
  check('examples: the nav lists the new section', exLib.nav.some(n => /Complex tags/.test(n)),
        `${exLib.nav.length} nav items`);

  const original = await page.evaluate(() => {
    const all = [...document.querySelectorAll('#exList .example-card')];
    return all.filter(c => !c.closest('.tag-cat')).length;
  });
  check('examples: the original feature sections still render', original >= 30,
        `${original} cards outside the library`);

  const loaded = await page.evaluate(() => {
    document.querySelectorAll('#exList .tag-cat').forEach(d => { d.open = true; });
    const card = [...document.querySelectorAll('#exList .example-card')]
      .find(c => /Calm → panic/.test(c.querySelector('.example-label')?.textContent || ''));
    if (!card) return null;
    const script = card.querySelector('.example-script').textContent;
    [...card.querySelectorAll('button')].find(b => /Load into studio/.test(b.textContent)).click();
    return { script, editor: document.querySelector('#editor')?.value };
  });
  check('examples: an example loads into the studio editor',
        !!loaded && loaded.editor === loaded.script,
        loaded ? 'editor = ' + (loaded.editor || '').slice(0, 44) + '…' : 'card not found');

  const frag = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#exList .example-card')]
      .find(c => /A single beat/.test(c.querySelector('.example-label')?.textContent || ''));
    return card ? { script: card.querySelector('.example-script').textContent, hasPill: !!card.querySelector('.pill') } : null;
  });
  check('examples: a bare fragment shows a full line, not just the fragment',
        !!frag && frag.script.length > 20 && frag.hasPill,
        frag ? frag.script : 'card not found');

  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

  await page.evaluate(() => document.querySelector('[data-view="examples"]').click());
  await sleep(800);
  await page.evaluate(() => {
    document.querySelectorAll('#exList .tag-cat').forEach((d, i) => { d.open = i < 2; });
    document.querySelectorAll('#exList .card')[12]?.scrollIntoView({ block: 'start' });
  });
  await sleep(600);
  await page.screenshot({ path: 'data/examples-tags.png' });
  console.log('\nscreenshot -> data/examples-tags.png');

  await page.evaluate(() => document.querySelector('[data-view="studio"]').click());
  await sleep(400);
  await page.click('#tagLibBtn');
  await sleep(600);
  await page.screenshot({ path: 'data/tagpicker.png' });
  console.log('screenshot -> data/tagpicker.png');

  console.log('\n' + results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`\nSUMMARY: ${results.length - failed}/${results.length} passed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('PROBE ERROR', e); process.exit(2); });
