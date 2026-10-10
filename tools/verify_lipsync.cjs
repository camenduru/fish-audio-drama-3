/**
 * Lip Sync end-to-end — needs real API credit.
 *
 * Generates a line with Drama 3, bakes the viseme sidecar, and asserts the
 * preview actually animates the mouth in sync (not just that a UI state
 * flipped). Also covers the two things that make the page usable: the shared
 * audio library on the right (Studio takes show up and auto-bake when picked)
 * and the avatar voice reference_id.
 */
const puppeteer = require('puppeteer-core');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const AVATAR_VOICE_ID = '1621cae243064f63989bcccd240004b5';   // Happy Girl

let pass = 0, fail = 0;
const check = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  — ' + d : ''));
  ok ? pass++ : fail++;
};

async function waitFor(fn, { tries = 120, every = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(APP + '/#lipsync', { waitUntil: 'networkidle2' });
  // The portrait + face atlas have to have decoded before the canvas means anything.
  await waitFor(async () => page.evaluate(() => {
    const cv = document.querySelector('#lsCanvas');
    if (!cv) return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
    return opaque > 1000 ? true : null;
  }), { tries: 30, every: 400 });

  // ---------------------------------------------------------------- the page
  check('lipsync view is active',
    await page.$eval('#view-lipsync', e => e.classList.contains('active')));

  const loaded = await page.evaluate(() => {
    const cv = document.querySelector('#lsCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
    return { opaque, total: d.length / 4 };
  });
  check('portrait drawn on the canvas',
    loaded.opaque > loaded.total * 0.2,
    `${loaded.opaque}/${loaded.total} opaque px`);

  const legend = await page.$$eval('#lsLegend .ls-legend:not(.eyes)',
    e => e.map(x => x.innerText.replace(/\s+/g, ' ')));
  check('all 9 mouth shapes in the legend', legend.length === 9, legend.join(' | '));

  // -------------------------------------------------------- avatar voice
  const voice = await page.evaluate(() => ({
    id: document.querySelector('#lsVoiceId').value,
    name: document.querySelector('#lsVoiceName').textContent,
    hint: document.querySelector('#lsVoiceHint').textContent,
  }));
  check('avatar voice defaults to the young/cheerful reference_id',
    voice.id === AVATAR_VOICE_ID, voice.id + ' · ' + voice.name);
  check('avatar voice hint explains the tone',
    /high-pitched|cheerful/i.test(voice.hint), voice.hint.slice(0, 80));

  await page.click('#lsPickVoice');
  // The library call takes ~3s; wait for tiles rather than guessing.
  const pickerTiles = await waitFor(async () => page.evaluate(() => {
    const back = document.querySelector('#modalBack');
    if (!back.classList.contains('open')) return null;
    return back.querySelectorAll('.tile').length || null;
  }), { tries: 40, every: 500 });

  const picker = await page.evaluate(() => {
    const back = document.querySelector('#modalBack');
    const input = back.querySelector('input.input');
    return {
      open: back.classList.contains('open'),
      title: document.querySelector('#modalTitle').textContent,
      hasSearch: !!input && /search/i.test(input.placeholder || ''),
      tiles: back.querySelectorAll('.tile').length,
      playButtons: back.querySelectorAll('.play-btn:not([disabled])').length,
    };
  });
  check('voice picker opens with a search box and real voices',
    picker.open && picker.hasSearch && picker.tiles > 0,
    `${picker.title} · ${picker.tiles} tiles · ${picker.playButtons} playable`);
  check('picker offers sample playback', picker.playButtons > 0,
    picker.playButtons + ' play buttons');

  // The search box must reach the WHOLE library, not just the loaded page.
  if (pickerTiles) {
    await page.type('#modalBack input.input', 'happy girl', { delay: 25 });
    const hits = await waitFor(async () => page.evaluate(() => {
      const titles = [...document.querySelectorAll('#modalBack .tile h4')]
        .map(x => x.textContent.trim().toLowerCase());
      return titles.length ? { n: titles.length, titles } : null;
    }), { tries: 40, every: 500 });
    check('searching the picker reaches the whole library',
      !!hits && hits.n > 0 && hits.n < 100,
      hits ? `${hits.n} matches` : 'no results');
    check('search finds the avatar default voice by name',
      !!hits && hits.titles.some(t => t.includes('happy girl')),
      hits ? hits.titles.slice(0, 4).join(' | ') : 'n/a');
  }

  await page.evaluate(() => document.querySelector('#modalBack').classList.remove('open'));
  await sleep(200);

  // ---- the real flow ----
  // Capture the outgoing TTS body so the reference_id is proven on the wire,
  // not just in the UI.
  const ttsBodies = [];
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().includes('/api/tts/stream')) {
      try { ttsBodies.push(JSON.parse(r.postData() || '{}')); } catch {}
    }
  });

  await page.$eval('#lsScript', e => {
    e.value = '[calm] The old lamp still flickers. [pause] Nobody has lit it in years.';
  });
  await page.click('#lsRun');

  const stats = await waitFor(async () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#lsStats .kv')]
      .map(r => [r.querySelector('.k').textContent, r.querySelector('.v').textContent]);
    return rows.length ? Object.fromEntries(rows) : null;
  }));
  check('bake completed', !!stats, stats ? JSON.stringify(stats) : 'no stats after 120s');

  check('the TTS call carried the avatar reference_id',
    ttsBodies.length > 0 && ttsBodies[0].reference_id === AVATAR_VOICE_ID,
    ttsBodies.length ? `reference_id=${ttsBodies[0].reference_id} model=${ttsBodies[0].__model}` : 'no request captured');

  if (stats) {
    check('cues produced', parseInt(stats.cues, 10) >= 3, stats.cues + ' cues');
    check('aligner reported', !!stats.aligner, stats.aligner);
    check('duration is sane (not the 48695s header bug)',
      parseFloat(stats.duration) > 0.5 && parseFloat(stats.duration) < 60, stats.duration + 's');
    check('wav header state reported', 'wav header repaired' in stats, stats['wav header repaired']);
  }

  const cues = await page.$$eval('#lsTimeline .tl-cue', e => e.length);
  check('cue timeline rendered', cues > 5, cues + ' blocks');

  // ---- does the mouth ACTUALLY move? ----
  await page.$eval('#lsPlay', e => e.click());
  const shapes = new Set();
  for (let i = 0; i < 40; i++) {
    await sleep(120);
    shapes.add(await page.$eval('#lsShape', e => e.textContent.trim()));
  }
  check('mouth animates through multiple shapes while playing',
    shapes.size >= 3, [...shapes].join(' → '));

  // ---- ALL 18 frames ----
  const frames = await page.evaluate(async () => {
    const i = await (await fetch('/api/lipsync/info')).json();
    const f = Object.keys(i.face.frames);
    return {
      total: f.length,
      base: f.filter(k => !k.endsWith('_eyes')).length,
      eyes: f.filter(k => k.endsWith('_eyes')).length,
      blink: i.blink,
    };
  });
  check('atlas exposes 9 shapes + 9 closed-eye twins',
    frames.base === 9 && frames.eyes === 9,
    `${frames.base} base + ${frames.eyes} eyes = ${frames.total}`);
  check('blink tuning read from game_settings',
    frames.blink && frames.blink.per_min > 0,
    frames.blink ? `per_min=${frames.blink.per_min} hold=${frames.blink.hold_min}-${frames.blink.hold_max}` : 'missing');

  const sampleEyes = () => page.evaluate(() => {
    const cv = document.querySelector('#lsCanvas');
    const ctx = cv.getContext('2d');
    const sx = cv.width / 576, sy = cv.height / 1024;
    const x = Math.round(179 * sx), y = Math.round((110 + 40) * sy);
    const w = Math.round(218 * sx), h = Math.round(45 * sy);
    const d = ctx.getImageData(x, y, w, h).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; n++; }
    return Math.round(sum / n);
  });

  const openPix = await sampleEyes();
  await page.click('#lsBlinkNow');
  await sleep(60);
  const closedPix = await sampleEyes();
  const badge = await page.$eval('#lsGame', e => e.textContent);

  check('closed-eye frame is actually drawn',
    Math.abs(closedPix - openPix) > 1.5,
    `eye-band mean ${openPix} (open) vs ${closedPix} (blink)`);
  check('blink reports "eyes shut"', /eyes shut/.test(badge), badge);

  await sleep(500);
  const reopened = await page.$eval('#lsGame', e => e.textContent);
  check('eyes reopen after the hold', !/eyes shut/.test(reopened), reopened);

  // Blink must fire on its own while the line plays.
  //
  // The hold is the game's 0.1–0.2 s, so a coarse poll can step straight over a
  // blink. Sample densely (the badge is the only observable) and give the
  // Poisson schedule room for a slow interval.
  await page.$eval('#lsAudio', a => { a.currentTime = 0; a.play(); });
  let sawAutoBlink = false, blinkSamples = 0;
  for (let i = 0; i < 220; i++) {
    const t = await page.$eval('#lsGame', e => e.textContent);
    blinkSamples++;
    if (/eyes shut/.test(t)) { sawAutoBlink = true; break; }
    await sleep(55);
  }
  check('auto-blink fires while playing', sawAutoBlink,
    sawAutoBlink ? `observed within ${blinkSamples} samples` : `never blinked in ${blinkSamples} samples`);
  await page.$eval('#lsAudio', a => a.pause());

  // ...and switching it off must stop it.
  await page.evaluate(() => {
    const c = document.querySelector('#lsBlink');
    c.checked = false; c.dispatchEvent(new Event('change'));
  });
  await sleep(150);
  let blinkWhileOff = 0;
  for (let i = 0; i < 60; i++) {
    const t = await page.$eval('#lsGame', e => e.textContent);
    if (/eyes shut/.test(t)) blinkWhileOff++;
    await sleep(55);
  }
  check('unchecking blink stops the eyes closing', blinkWhileOff === 0,
    blinkWhileOff + ' shut samples in 3.3s');
  await page.evaluate(() => {
    const c = document.querySelector('#lsBlink');
    c.checked = true; c.dispatchEvent(new Event('change'));
  });

  // ------------------------------------------------- the shared audio library
  const takes1 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#lsTakes .tk')];
    return rows.map(r => ({
      name: r.querySelector('.t').textContent,
      meta: r.querySelector('.tk-meta').textContent,
      baked: !!r.querySelector('.tk-dot.on'),
      active: r.classList.contains('active'),
    }));
  });
  check('the baked line lands in the right-panel take list',
    takes1.length === 1 && takes1[0].baked && takes1[0].active,
    takes1.length ? `${takes1[0].name} · ${takes1[0].meta.replace(/\s+/g, ' ').trim()}` : 'no takes');

  // ---- cross-page: a Studio take must show up here, unbaked, and bake on pick
  // In-SPA navigation (rail buttons) — a hard reload would drop the in-memory
  // library by design, since blobs cannot be persisted.
  await page.click('.rail-btn[data-view="studio"]');
  await sleep(600);
  await page.$eval('#editor', e => {
    // No [pause] here on purpose: Fish's bare [pause] is wildly variable
    // (3s–48s), and this test is about the handoff, not pause length.
    e.value = 'Good morning! The kettle is already on.';
    e.dispatchEvent(new Event('input'));
  });
  await page.evaluate(() => {
    const c = document.querySelector('#streamTimestamps');
    if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change')); }
  });
  await page.click('#genBtn');
  const studioTake = await waitFor(async () => page.evaluate(() =>
    document.querySelectorAll('#takeList .list-item').length || null),
    { tries: 90, every: 1000 });
  check('studio produced a take for the cross-page test', !!studioTake, `${studioTake} take(s)`);

  if (studioTake) {
    await page.click('.rail-btn[data-view="lipsync"]');
    await sleep(700);
    const rows = await page.$$eval('#lsTakes .tk', els => els.map(r => ({
      name: r.querySelector('.t').textContent,
      text: r.querySelector('.d').textContent,
      baked: !!r.querySelector('.tk-dot.on'),
      src: !!r.querySelector('.tk-src'),
    })));
    const fromStudio = rows.find(r => r.src);
    check('the Studio take appears in the Lip Sync right panel',
      !!fromStudio, rows.length + ' rows · ' + JSON.stringify(fromStudio || {}));
    check('it arrives un-baked (no mouth track yet)',
      fromStudio && !fromStudio.baked, fromStudio ? String(fromStudio.baked) : 'n/a');

    if (fromStudio) {
      // Pick it — the visemes must generate themselves.
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#lsTakes .tk')];
        const row = rows.find(r => r.querySelector('.tk-src'));
        row.click();
      });
      const baked = await waitFor(async () => page.evaluate(() => {
        const rows = [...document.querySelectorAll('#lsTakes .tk')];
        const row = rows.find(r => r.querySelector('.tk-src'));
        return row && row.querySelector('.tk-dot.on') ? true : null;
      }), { tries: 90, every: 1000 });
      check('picking an un-baked take auto-generates its visemes', !!baked,
        baked ? 'baked on pick' : 'still unbaked after 90s');

      if (baked) {
        const shown = await page.evaluate(() => ({
          active: !!document.querySelector('#lsTakes .tk.active .tk-src'),
          cues: document.querySelectorAll('#lsTimeline .tl-cue').length,
          shape: document.querySelector('#lsShape').textContent,
          playing: [...document.querySelectorAll('#lsStages audio')].some(a => !a.paused && !a.ended),
        }));
        // A take that is loaded but not playing must rest with its mouth shut:
        // cueAt(sidecar, 0) is the clip's *first* viseme, so driving the face
        // from it while idle leaves the avatar frozen mid-word.
        check('the picked take is the one on the face',
          shown.active && shown.cues >= 3,
          `active=${shown.active} cues=${shown.cues} shape=${shown.shape}`);
        check('a loaded but paused take rests with its mouth closed',
          !shown.playing && shown.shape === 'X',
          `playing=${shown.playing} shape=${shown.shape}`);
      }
    }
  }

  // ---- export ----
  // Reuse whatever take is on the face (the cross-page one, above) rather than
  // burning another synthesis.
  await page.evaluate(() => {
    window.__blobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob) window.__blobs.push(b); return orig(b); };
  });

  await page.click('#lsSaveJson');
  await sleep(500);
  await page.click('#lsSaveWav');
  await sleep(700);

  const grabbed = await page.evaluate(async () => {
    const out = {};
    for (const b of window.__blobs) {
      if (b.type.includes('json')) out.json = await b.text();
      else if (b.type.includes('audio')) out.audio = b.size;
    }
    return out;
  });

  check('visemes.json produced by the export', !!grabbed.json,
    grabbed.json ? grabbed.json.length + ' bytes' : 'nothing captured');
  check('wav produced by the export', (grabbed.audio || 0) > 1000,
    grabbed.audio ? Math.round(grabbed.audio / 1024) + ' KB' : 'nothing captured');

  if (grabbed.json) {
    const sc = JSON.parse(grabbed.json);
    check('sidecar has metadata.duration',
      typeof sc?.metadata?.duration === 'number' && sc.metadata.duration > 0,
      sc?.metadata?.duration + 's');
    const c = sc.mouthCues || [];
    const valid = new Set('ABCDEFGHX');
    check('mouthCues are well formed',
      c.length >= 3 &&
      c.every(x => valid.has(String(x.value).toUpperCase()) && x.end > x.start) &&
      c.every((x, i) => i === 0 || x.start >= c[i - 1].end - 1e-6),
      `${c.length} cues, sorted, contiguous`);
    check('every cue lies inside the audio',
      c.every(x => x.start >= 0 && x.end <= sc.metadata.duration + 0.01),
      'last end ' + c[c.length - 1].end + 's');
    check('sidecar records the Fish anchors it used',
      !!sc.metadata.aligner && sc.metadata.anchorWords > 0,
      'aligner=' + sc.metadata.aligner + ' anchors=' + sc.metadata.anchorWords);
  }

  const realErrors = errors.filter(e => !/AbortError|play\(\) request was interrupted/.test(e));

  // ------------------------------------------------------------------ duo
  // Two avatars on the same stage, taking turns. Both reuse the same face art
  // until more avatar folders exist in the game.
  await page.select('#lsMode', 'duo');
  await sleep(1200);

  const duo = await page.evaluate(() => ({
    stages: document.querySelectorAll('#lsStages .ls-stage').length,
    canvases: document.querySelectorAll('#lsStages canvas').length,
    badges: document.querySelectorAll('#lsStages .ls-badge').length,
    names: [...document.querySelectorAll('#lsStages .ls-name')].map(e => e.textContent),
    voiceRows: document.querySelectorAll('#lsVoices .vc-row').length,
    voiceInputs: [...document.querySelectorAll('#lsVoices input')].map(i => i.id),
    genForVisible: getComputedStyle(document.querySelector('#lsGenForWrap')).display !== 'none',
    convoVisible: getComputedStyle(document.querySelector('#lsConvoBox')).display !== 'none',
    genForOptions: document.querySelectorAll('#lsGenFor option').length,
  }));
  check('duo mode puts two avatars on the stage',
    duo.stages === 2 && duo.canvases === 2,
    `${duo.stages} stages, ${duo.canvases} canvases`);
  check('each avatar has its own name plate and badge',
    duo.badges === 2 && duo.names.length === 2, duo.names.join(' / '));
  check('each avatar gets its own voice row',
    duo.voiceRows === 2 && duo.voiceInputs.length === 2, duo.voiceInputs.join(', '));
  check('duo mode reveals the generate-for picker and the conversation strip',
    duo.genForVisible && duo.convoVisible && duo.genForOptions === 2,
    `genFor=${duo.genForOptions} options`);

  // Per-avatar voices must be independent. Give A2 a real second voice so the
  // script-driven test below can prove it reaches the wire.
  const SECOND_VOICE = '34baf74e966b41ce94200a8c42d0ab64';   // Cheerful Young Woman
  await page.evaluate(id => {
    const a2 = document.querySelector('#lsVoiceId2');
    a2.value = id;
    a2.dispatchEvent(new Event('input'));
  }, SECOND_VOICE);
  const voices = await page.evaluate(() => ({
    a1: document.querySelector('#lsVoiceId').value,
    a2: document.querySelector('#lsVoiceId2').value,
  }));
  check('per-avatar voices are independent',
    voices.a1 === AVATAR_VOICE_ID && voices.a2 === SECOND_VOICE,
    `A1=${voices.a1.slice(0, 8)}… A2=${voices.a2.slice(0, 8)}…`);

  // ---- the conversation-script parser (pure logic, imported straight in) ----
  const parsed = await page.evaluate(async () => {
    const m = await import('/js/convo.js');
    const turns = m.parseConversation([
      'Avatar1: hi there',
      'Avatar2: [pause:1s] hello',   // a tag with a colon must NOT become a name
      '',
      '// comment',
      '[pause] a tag-only line',     // no speaker
      'Mom: one',
      'Kid: two',
      'Mom: three',
    ].join('\n'));
    const r = m.makeSpeakerResolver([{ key: 'a1' }, { key: 'a2' }]);
    return {
      turns,
      map: ['Avatar1', 'Avatar2', 'A1', 'A2', '2', 'AVATAR 1'].map(n => r(n).key),
      named: ['Mom', 'Kid', 'Mom', 'Guard'].map(n => r(n).key),
      empty: m.makeSpeakerResolver([])('x'),
    };
  });
  check('parser: one turn per line, comments and blanks skipped',
    parsed.turns.length === 6 && parsed.turns[2].speaker === null,
    `${parsed.turns.length} turns`);
  check('parser: a colon inside a [tag] is not read as a speaker',
    parsed.turns[1].speaker === 'Avatar2' && parsed.turns[1].text === '[pause:1s] hello',
    JSON.stringify(parsed.turns[1]));
  check('parser: Avatar1/A1/1 all mean the first actor',
    parsed.map.slice(0, 4).join() === 'a1,a2,a1,a2' && parsed.map[5] === 'a1',
    parsed.map.join(' '));
  check('parser: unknown names are assigned in order, then reused',
    parsed.named.join() === 'a1,a2,a1,a1', parsed.named.join(' '));
  check('parser: no actors -> no crash', parsed.empty === null);

  // ---- script-driven conversation, end to end ----
  ttsBodies.length = 0;
  await page.evaluate(() => {
    document.querySelector('#lsConvoScript').value =
      'Avatar1: [excited] You made it!\nAvatar2: [breathless] The bridge was out.';
  });
  await page.click('#lsConvoGen');

  const convoDone = await waitFor(async () => page.evaluate(() => {
    const t = document.querySelector('#lsConvoProgress').textContent;
    return /turns baked/.test(t) ? t : null;
  }), { tries: 180, every: 1000 });
  check('a script drives one synthesis per line', !!convoDone, convoDone || 'timed out after 180s');

  check('each line was synthesised with its own avatar voice',
    ttsBodies.length === 2 &&
    ttsBodies[0].reference_id === AVATAR_VOICE_ID &&
    ttsBodies[1].reference_id === SECOND_VOICE,
    ttsBodies.map(b => (b.reference_id || 'none').slice(0, 8) + '…').join(' then '));

  const scripted = await page.evaluate(() => ({
    who: [...document.querySelectorAll('#lsConvo .cv-turn .cv-who')].map(e => e.textContent.trim()),
    names: [...document.querySelectorAll('#lsTakes .tk .t')].map(e => e.textContent.trim()),
    actors: window.__lipsync?.().actors || [],
  }));
  check('the script produced one turn per line, on the right avatar',
    scripted.who.length === 2 && scripted.who[0] === 'Avatar 1' && scripted.who[1] === 'Avatar 2',
    scripted.who.join(' → ') || 'no turns');
  check('each generated line landed as its own named take',
    scripted.names.some(n => /Avatar 1 · line 1/.test(n)) &&
    scripted.names.some(n => /Avatar 2 · line 2/.test(n)),
    scripted.names.slice(0, 3).join(' | '));
  // Assert the real state: a badge reading "closed" is also what an actor with
  // no mouth track at all looks like, so check the sidecar itself.
  check('both avatars hold a mouth track after the script runs',
    scripted.actors.length === 2 && scripted.actors.every(a => a.hasSidecar && a.cues > 0),
    scripted.actors.map(a => `${a.label}: cues=${a.cues}`).join(' · '));

  // Assign the two already-baked takes to the two avatars (no new synthesis).
  // Each click re-renders the take list, so re-query between them.
  await page.click('#lsConvoClear');      // start from a known-empty queue
  await sleep(300);

  const clickAssign = async (idx, label) => {
    await page.evaluate(({ idx, label }) => {
      const row = document.querySelectorAll('#lsTakes .tk')[idx];
      const b = [...(row?.querySelectorAll('.tk-assign .btn') || [])]
        .find(x => x.textContent.trim() === label);
      if (b) b.click();
    }, { idx, label });
    await sleep(500);
  };
  const assignInfo = await page.evaluate(() => ({
    takes: document.querySelectorAll('#lsTakes .tk').length,
    buttons: document.querySelectorAll('#lsTakes .tk-assign .btn').length,
  }));
  check('duo mode puts A1/A2 buttons on every take',
    assignInfo.takes > 0 && assignInfo.buttons === assignInfo.takes * 2,
    `${assignInfo.buttons} assign buttons for ${assignInfo.takes} takes`);

  await clickAssign(0, 'A2');
  await clickAssign(1, 'A1');
  await sleep(700);

  const convo = await page.$$eval('#lsConvo .cv-turn', els => els.map(e => ({
    who: e.querySelector('.cv-who').textContent.trim(),
    text: e.querySelector('.cv-text').textContent.trim().slice(0, 34),
  })));
  check('assigning takes builds a two-hander conversation',
    convo.length === 2 && convo.some(c => c.who === 'Avatar 1') && convo.some(c => c.who === 'Avatar 2'),
    convo.length
      ? convo.map(c => `${c.who}: ${c.text}`).join(' | ')
      : 'no turns in the conversation strip');

  // Play it and watch BOTH faces — each must move its own mouth.
  //
  // Sampled at 60ms rather than 110ms: a clipped line such as "[breathless] The
  // bridge was out." can be barely a second long, and a slow poll can step right
  // over a whole turn. The trace is kept so a failure says *why* — whether the
  // audio never advanced, never played, or simply wasn't sampled.
  await page.click('#lsConvoPlay');
  const seen = { a1: new Set(), a2: new Set() };
  const trace = [];
  let otherIdle = false;
  let idleLeak = false;
  let idleStreak = 0;
  for (let i = 0; i < 600; i++) {
    const s = await page.evaluate(() => {
      const st = window.__lipsync?.();
      const by = k => (st?.actors || []).find(a => a.key === k) || null;
      return {
        a1: document.querySelector('#lsShape')?.textContent,
        a2: document.querySelector('#lsShape2')?.textContent,
        s1: by('a1'),
        s2: by('a2'),
      };
    });
    if (s.a1) seen.a1.add(s.a1);
    if (s.a2) seen.a2.add(s.a2);
    // While one avatar's audio is rolling, the other must sit with its mouth
    // shut. Checking only "one is X and the other isn't" is satisfied for free
    // after a turn ends, which is how a frozen-open idle mouth slipped through;
    // so tie the assertion to which element is actually playing.
    const rolling1 = !!(s.s1 && !s.s1.paused && !s.s1.ended);
    const rolling2 = !!(s.s2 && !s.s2.paused && !s.s2.ended);
    if (rolling1 && !rolling2 && s.a1 && s.a1 !== 'X') {
      otherIdle = true;
      if (s.a2 !== 'X') idleLeak = true;
    }
    if (rolling2 && !rolling1 && s.a2 && s.a2 !== 'X') {
      otherIdle = true;
      if (s.a1 !== 'X') idleLeak = true;
    }
    trace.push(`${s.a1 || '-'}@${s.s1 ? s.s1.ct : '?'}${s.s1?.paused ? 'p' : ''}` +
               `/${s.a2 || '-'}@${s.s2 ? s.s2.ct : '?'}${s.s2?.paused ? 'p' : ''}`);
    // Done as soon as both have moved. Otherwise stop only after the stage has
    // been quiet for a while: the hand-off between two turns leaves a gap where
    // neither element is rolling, and breaking on that single sample skipped
    // the second avatar's whole turn.
    if (seen.a1.size >= 2 && seen.a2.size >= 2) break;
    const quiet = !rolling1 && !rolling2;
    idleStreak = quiet ? idleStreak + 1 : 0;
    if (idleStreak > 45) break;      // ~2.7s of genuine silence
    await sleep(60);
  }
  const traceDetail = trace.filter((l, i) => i === 0 || l !== trace[i - 1]).slice(0, 10).join('  ');
  const final = await page.evaluate(() => window.__lipsync?.().actors || []);
  check('both avatars animate their own mouths in the conversation',
    seen.a1.size >= 2 && seen.a2.size >= 2,
    `A1 ${[...seen.a1].join('')} · A2 ${[...seen.a2].join('')}  ‖  ${traceDetail}` +
    `  ‖  ${final.map(a => `${a.label} cues=${a.cues} dur=${a.dur}`).join(' · ')}`);
  check('the idle avatar keeps its mouth closed while the other speaks',
    otherIdle && !idleLeak,
    idleLeak ? 'an idle avatar held an open mouth while the other was speaking'
             : (otherIdle ? 'observed' : 'never saw one speaking alone'));

  // Back to a single avatar.
  await page.select('#lsMode', 'single');
  await sleep(900);
  const back = await page.evaluate(() => ({
    stages: document.querySelectorAll('#lsStages .ls-stage').length,
    voiceRows: document.querySelectorAll('#lsVoices .vc-row').length,
    convoVisible: getComputedStyle(document.querySelector('#lsConvoBox')).display !== 'none',
  }));
  check('switching back to one avatar cleans up',
    back.stages === 1 && back.voiceRows === 1 && !back.convoVisible,
    `${back.stages} stage, ${back.voiceRows} voice row`);

  check('no console errors', realErrors.length === 0, realErrors.slice(0, 2).join(' / '));

  console.log(`\nSUMMARY: ${pass}/${pass + fail} passed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
