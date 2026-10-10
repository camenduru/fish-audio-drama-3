// examples.js — every Drama 3 feature from the Voice Guide, ready to load and hear

import { $, el, toast, esc } from './api.js';
import { highlight } from './drama3.js';
import { setScript, generate } from './studio.js';
import { loadSceneScript } from './scenes.js';
import { openTagPicker, TAG_CATEGORIES, TAG_TOTAL } from './tags.js';

export const FEATURES = [
  {
    n: '01', icon: '🎭', title: 'Describe the performance',
    blurb: 'Write how a line should sound in brackets before it. The same words can sound completely different depending on the direction.',
    items: [
      { script: `I'm fine. Really. Go on without me.`, note: 'Neutral read — no direction, just the words.' },
      { script: `[barely holding it together] I'm fine. Really. Go on without me.`, note: 'Shaky voice, close to breaking.' },
      { script: `[cheerful, clearly lying] I'm fine. Really. Go on without me.`, note: 'Bright and upbeat, but unconvincing.' },
      { script: `[exhausted, whispering to a friend in the dark] I'm fine. Really. Go on without me.`, note: 'Quiet, tired and intimate.' },
    ],
  },
  {
    n: '02', icon: '🔀', title: 'Change the mood mid-line',
    blurb: 'Add a second direction partway through a line and the voice shifts at that exact point — no separate take.',
    items: [
      { script: `[calm] Everything's fine — [trembling, panicked] wait, did you hear that?`, note: 'Calm narration that suddenly turns to fear.' },
      { script: `[bored, monotone] Another Monday meeting — [suddenly thrilled] wait, there's free pizza?`, note: 'Flat delivery that jumps to excitement.' },
      { script: `[confident] I've totally got this — [quietly, losing confidence] I think.`, note: 'A bold start that trails off into doubt.' },
    ],
  },
  {
    n: '03', icon: '⏸', title: 'Add a sound or pause',
    blurb: 'Tags like [sigh], [laugh], [breath] and [pause] add that sound at the exact spot you place them — the small reactions that make a voice sound human.',
    items: [
      { script: `So I checked my bank account. [pause] Yeah. [laugh] We're not talking about it.`, note: 'A beat of silence before the punchline, then a laugh.' },
      { script: `[sigh] Okay, day three of waking up at 5am.`, note: 'A tired sigh before speaking.' },
      { script: `I opened the door, [breath] and the room was empty.`, note: 'A nervous breath that builds suspense.' },
    ],
  },
  {
    n: '04', icon: '✨', title: 'Change only certain words',
    blurb: 'Wrap a span in a paired tag and the effect applies only to those words — whisper, emphasis, faster, slower, forceful.',
    items: [
      { script: `Here's the secret: <whisper>it's the timing.</whisper>`, note: 'Normal voice, then only the last words whispered.' },
      { script: `This is the <emphasis>only</emphasis> setting you need.`, note: 'Extra weight on “only”.' },
      { script: `I love this brand. <faster>Terms apply, link in bio.</faster>`, note: 'A natural ad read with a quick disclaimer.' },
      { script: `And the winner is... <slower>you.</slower>`, note: 'The reveal drawn out for drama.' },
      { script: `Stop scrolling. <forceful>This one matters.</forceful>`, note: 'A calm hook, then a commanding line.' },
    ],
  },
  {
    n: '05', icon: '💬', title: 'Write a full scene',
    blurb: 'Give each speaker a voice and write the dialogue — Drama 3 generates the whole conversation at once. Each speaker reacts to the previous line.',
    scene: true,
    items: [
      { script: `Mom: [suspiciously calm] Who ate the last slice of cake?\nKid: [way too fast] Maybe the dog. Dogs love cake.\nMom: [pause] We don't have a dog.`, note: 'Comedy skit.' },
      { script: `Detective: You were there that night.\nSuspect: [defensive, slightly uneasy tone] I was home. [pause] Asleep.\nDetective: [skeptical, questioning tone] Then why is your coat still wet?`, note: 'Crime drama.' },
      { script: `Host A: [excited, leaning in] Okay, I have to tell you what happened at the airport.\nHost B: [laughing] Oh no. Not again.`, note: 'Podcast intro.' },
    ],
  },
  {
    n: '06', icon: '🛠', title: 'Fix one moment',
    blurb: 'Select part of a generated take, give it a new direction, and only that section is regenerated. Keep the take you like, fix what is wrong.',
    items: [
      { script: `[shocked, voice dropping to a whisper] and it was her all along`, note: 'The plot reveal sounds flat → shocked, dropping to a whisper.' },
      { script: `The punchline [pause before it, deadpan] lands like this`, note: 'The punchline lands too fast → add a beat before it.' },
      { script: `[genuinely excited] Our sponsor, Nordwind`, note: 'The sponsor name sounds bored → make it sincere.' },
    ],
  },
  {
    n: '07', icon: '🗣', title: 'Fix a pronunciation',
    blurb: 'Phoneme tags tell Drama 3 exactly how to say a word — names, brands, and words with two pronunciations. English, Chinese, Japanese, Korean and Spanish.',
    items: [
      { script: `The book was <|phoneme_start|>R EH1 D<|phoneme_end|> yesterday.`, note: '“read” said as “red”.' },
      { script: `It's pronounced <|phoneme_start|>JH IH1 F<|phoneme_end|>, fight me.`, note: '“GIF” with a soft G.' },
      { script: `Huge thanks to my editor, Linh <|phoneme_start|>W IH1 N<|phoneme_end|>.`, note: 'The surname said correctly.' },
    ],
  },
  {
    n: '08', icon: '🎙', title: 'Keep a voice consistent',
    blurb: 'Stack a direction, tags and a reference clip of a past take you liked, so new lines match its tone and pacing. Useful for series intros and recurring characters.',
    items: [
      { script: `[tired but proud, end of a long day] Welcome back to [pause] <emphasis>Day 47.</emphasis>`, note: 'Direction + sound tag + scoped emphasis in one line. Add a reference clip in the studio for the same tone as last episode.' },
    ],
  },
  {
    n: '09', icon: '🪄', title: 'Let Auto Tag start for you',
    blurb: 'Auto Tag reads your plain script and adds directions automatically. Keep what works and rewrite the rest.',
    autotag: true,
    items: [
      { script: `Detective: You were there that night.\nSuspect: I was home. Asleep.\nDetective: Then why is your coat still wet?`, note: 'Press “Auto Tag” in the studio and Drama 3 suggests the directions for you.' },
    ],
  },
  {
    n: '10', icon: '🧩', title: 'Stack it all in one line',
    blurb: 'The features are designed to compose. Every line here carries a direction, a sound tag and a scoped span at once — and some change mood partway through. This is the shape most real lines end up taking. One caveat: a bare [pause] can run anywhere from a beat to a dozen seconds, so [short pause] is steadier when the timing matters.',
    items: [
      {
        script: `[calm, professional narrator] In 1969, [pause] a single engineer <slower>rewired everything.</slower> [breath] The rest, as they say, is history.`,
        note: 'Direction + pause + scoped slowdown + a breath. Four features, one sentence, no seams.',
      },
      {
        script: `[deadpan, utterly serious] Our sponsor today is <emphasis>Nordwind</emphasis> — [pause] yes, [laugh] the knife people.`,
        note: 'Deadpan direction, a weighted brand name, then a pause and a laugh that undercut it.',
      },
      {
        script: `[gently, reading a bedtime story] The little fox <whisper>crept past the sleeping giant</whisper>, [pause] and <slower>never once looked back.</slower>`,
        note: 'A whispered span inside a calm read — the volume drops and comes back without a new take.',
      },
      {
        script: `[barely holding it together] I said <|phoneme_start|>R EH1 D<|phoneme_end|> the letter — [pause] <whisper>I never read it out loud.</whisper>`,
        note: 'A phoneme fixes the past-tense “read”, then the line drops to a whisper. Note “read” appears twice, said two different ways.',
      },
      {
        script: `[suddenly furious] <forceful>Get out.</forceful> [pause] [breath] [whispering, broken] <whisper>Please. Just go.</whisper>`,
        note: 'Anger, then a break: forceful → pause → breath → a second direction → whisper. The hardest thing to fake, and it happens inside one line. This one measured 11.8 s on a test run — the pause is doing that, so shorten it if you want a tighter beat.',
      },
    ],
  },
  {
    n: '11', icon: '🎬', title: 'Full scenes, longer casts',
    blurb: 'Four speakers, nine turns, and Drama 3 keeps each one in character across the whole exchange — including who interrupts whom. Each speaker gets its own voice in the Scenes tab. Pauses carry a lot of the timing here; if a beat drags, swap [pause] for [short pause].',
    scene: true,
    items: [
      {
        script: `Vex: [clipped, all business] We have ninety seconds. In and out.\nMarla: [chewing gum, unbothered] Relax. I've done this a hundred times.\nVex: [flat] You've done it twice.\nMarla: [pause] ...Ninety-one seconds.\nNova: [over the radio, distorted] Guys? The door's already open.\nVex: [very slowly] Say that again.\nNova: [small voice] The door. It's already open.\nDex: [from the van, delighted] I told you the keycard was a bad idea.\nVex: [pause] Everyone. Stop talking.`,
        note: 'Four speakers in a heist briefing — one of them on a radio, one in the van. The comedy is in the pauses: Marla conceding, Vex slowing right down.',
      },
      {
        script: `Dad: [too cheerful] So. Anyone want to explain the car?\nTeen: [mouth full] Nope.\nMom: [not looking up] The car is fine.\nDad: [pause] The car is in the kitchen.\nTeen: [pause] Okay, so, technically —\nMom: [cutting in, dangerously calm] <emphasis>Finish your vegetables.</emphasis>`,
        note: 'Three speakers, and the last line is an interruption — a direction plus a scoped span, landing the punchline.',
      },
      {
        script: `Narrator: [low, documentary] The lighthouse had been dark for eleven years.\nKeeper: [distant, over static] Is anyone receiving? [pause] Please.\nNarrator: [pause] That was the first transmission.\nOperator: [startled] Sir — you need to hear this.\nKeeper: [closer now, urgent] It's not a lighthouse. [pause] It never was.`,
        note: 'A radio drama where the same speaker moves closer over the scene — the direction tracks the distance.',
      },
      {
        script: `Detective: [measured, serious] Let's go back to the fourteenth.\nSuspect: [trying to stay calm] I've told you. I was home.\nDetective: [pause] You were home.\nSuspect: [defensive, slightly uneasy tone] Yes.\nDetective: [quietly] Then why does your neighbour say she saw your car?\nSuspect: [pause] [voice dropping] ...She's mistaken.\nDetective: [gently questioning] She wrote down the plate.\nSuspect: [breaking] <whisper>I want to call my lawyer.</whisper>`,
        note: 'Eight turns of an interrogation that ends on a whispered collapse. A two-hander with real escalation.',
      },
    ],
  },
  {
    n: '12', icon: '📖', title: 'Long-form narration',
    blurb: 'One voice, many turns. These are the lines where a single speaker has to carry a whole arc, and where a mid-line direction change does the heavy lifting. A bare [pause] is dramatic but its length swings a lot between takes — [short pause] is steadier when the timing matters.',
    items: [
      {
        script: `[calm narration] The house on Alder Lane had stood empty for as long as anyone could remember. [pause] <slower>Almost anyone.</slower> [breath] Because Mrs Pell remembered. [quietly, almost to himself] She remembered <emphasis>everything.</emphasis>`,
        note: 'An audiobook opening that turns on three words. The direction changes twice mid-paragraph.',
      },
      {
        script: `[measured, serious] In the spring of 1986, [pause] a reactor in the north began to hum. [suddenly intense] Not loudly — <faster>that was the problem.</faster> [pause] [quietly, holding back] By morning the town was gone.`,
        note: 'Documentary register that snaps to alarm, speeds up for the key clause, then drops away entirely.',
      },
      {
        script: `[warm and conversational] Okay, so — [pause] this is the part where I'm supposed to say it gets easier. [laugh] It doesn't. [lowering her voice] On the night of the fourteenth, [breath] three people drove out to the lake. [pause] Only two came back.`,
        note: 'Podcast cadence: chatty, self-aware, then quiet. The laugh is what makes the turn land.',
      },
      {
        script: `[bright and confident] Meet Nordwind — [pause] the last knife you'll ever buy. [genuinely excited] Forged, folded, and <emphasis>absurdly</emphasis> sharp. [conspiratorial whisper] <whisper>Don't tell my landlord.</whisper>`,
        note: 'An ad read that ends somewhere the brand did not plan for. Direction, emphasis and whisper in three beats.',
      },
    ],
  },
  // The library is rendered from web/js/tags.js rather than restated here, so a
  // tag and its example can never drift apart — adding one to the picker adds it
  // to this page.
  {
    n: '13', icon: '🏷', title: 'Complex tags — the whole library',
    blurb: `Every one of the ${TAG_TOTAL} ready-made combinations, grouped exactly as the picker groups them. Each is a complete line you can load and hear — the same text the 🏷 button drops at your cursor. Load one, then rewrite the words around it and keep the shape.`,
    library: true,
  },
];

// ---------------------------------------------------------------------------
function exampleCard(item, feature) {
  const code = el('pre.example-script', { html: highlight(item.script) });

  const load = el('button.btn.sm.primary', { onclick: () => {
    if (feature.scene) {
      document.querySelector('[data-view="scenes"]').click();
      loadSceneScript(item.script);
      toast('Loaded into Scenes.');
    } else {
      document.querySelector('[data-view="studio"]').click();
      setScript(item.script);
      if (feature.autotag) toast('Loaded — now press ✨ Auto Tag.');
      else toast('Loaded into the studio.');
    }
  } }, feature.scene ? 'Open in Scenes →' : 'Load into studio →');

  const hear = el('button.btn.sm', { title: 'Load and synthesize (needs API credit)', onclick: async () => {
    if (feature.scene) { document.querySelector('[data-view="scenes"]').click(); loadSceneScript(item.script); toast('Press “Render scene”.'); return; }
    document.querySelector('[data-view="studio"]').click();
    setScript(item.script);
    await generate();
  } }, '▶ Hear it');

  const copy = el('button.btn.sm.ghost', { onclick: () => { navigator.clipboard?.writeText(item.script); toast('Copied.'); } }, '⧉');

  return el('div.example-card', {}, [
    code,
    item.note ? el('div.example-note', {}, item.note) : null,
    el('div.flex.gap', { style: 'margin-top:10px;flex-wrap:wrap' }, [load, hear, copy]),
  ]);
}

function featureBlock(feature) {
  return el('div.card.mb', {}, [
    el('div.card-h', {}, [
      el('span.badge.accent', {}, feature.n),
      el('span', {}, feature.icon + ' ' + feature.title),
      el('div.grow'),
      el('span.hint', {}, feature.items.length + (feature.items.length === 1 ? ' example' : ' examples')),
    ]),
    el('div.card-b', {}, [
      el('div.hint.mb', { style: 'font-size:12.5px' }, feature.blurb),
      el('div.grid', { style: 'grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px' },
        feature.items.map(it => exampleCard(it, feature))),
    ]),
  ]);
}

/**
 * One tag from the library, as a card you can load and hear.
 *
 * `example` wins over `text` when a tag is a bare fragment — you cannot hear
 * [short pause] on its own, so the library carries a line that shows the beat
 * in place. Everything else is already a complete line, and showing exactly
 * what the picker would insert is the point.
 */
function tagExampleCard(tag, cat) {
  const script = tag.example || tag.text;
  const isScene = !!cat.scene;

  const code = el('pre.example-script', { html: highlight(script) });
  const load = el('button.btn.sm.primary', { onclick: () => {
    if (isScene) {
      document.querySelector('[data-view="scenes"]').click();
      loadSceneScript(script);
      toast('Loaded into Scenes.');
    } else {
      document.querySelector('[data-view="studio"]').click();
      setScript(script);
      toast('Loaded into the studio.');
    }
  } }, isScene ? 'Open in Scenes →' : 'Load into studio →');

  const hear = el('button.btn.sm', { title: 'Load and synthesize (needs API credit)', onclick: async () => {
    if (isScene) { document.querySelector('[data-view="scenes"]').click(); loadSceneScript(script); toast('Press “Render scene”.'); return; }
    document.querySelector('[data-view="studio"]').click();
    setScript(script);
    await generate();
  } }, '▶ Hear it');

  const copy = el('button.btn.sm.ghost', { title: 'Copy', onclick: () => { navigator.clipboard?.writeText(script); toast('Copied.'); } }, '⧉');

  return el('div.example-card', {}, [
    el('div.example-label', {}, [
      el('span', {}, tag.label),
      tag.example ? el('span.pill', { title: 'The library carries a full line for this fragment' }, 'fragment') : null,
    ]),
    code,
    tag.note ? el('div.example-note', {}, tag.note) : null,
    el('div.flex.gap', { style: 'margin-top:10px;flex-wrap:wrap' }, [load, hear, copy]),
  ]);
}

/** The whole tag library, grouped exactly as the picker groups it. */
function tagLibraryBlock(feature) {
  const groups = TAG_CATEGORIES.map((c, i) => el('details.tag-cat', { open: i === 0 }, [
    el('summary', {}, [
      el('span', {}, c.icon),
      el('span', {}, c.title),
      el('span.pill', {}, String(c.tags.length)),
      el('div.grow'),
      el('span.tag-cat-blurb', {}, c.blurb || ''),
    ]),
    el('div.tag-cat-b', {}, c.tags.map(t => tagExampleCard(t, c))),
  ]));

  return el('div.card.mb', {}, [
    el('div.card-h', {}, [
      el('span.badge.accent', {}, feature.n),
      el('span', {}, feature.icon + ' ' + feature.title),
      el('div.grow'),
      el('span.hint', {}, `${TAG_TOTAL} tags · ${TAG_CATEGORIES.length} categories`),
    ]),
    el('div.card-b', {}, [
      el('div.hint.mb', { style: 'font-size:12.5px' }, feature.blurb),
      el('div.flex.gap.mb', { style: 'flex-wrap:wrap' }, [
        el('button.btn.sm.primary', { onclick: () => openTagPicker() }, '🏷 Open the picker'),
        el('button.btn.sm', { onclick: () => groups.forEach(g => { g.open = true; }) }, 'Expand all'),
        el('button.btn.sm.ghost', { onclick: () => groups.forEach(g => { g.open = false; }) }, 'Collapse all'),
      ]),
      ...groups,
    ]),
  ]);
}

export function initExamples() {
  const box = $('#exList');
  if (!box) return;
  box.replaceChildren(...FEATURES.map(f => (f.library ? tagLibraryBlock(f) : featureBlock(f))));

  const nav = $('#exNav');
  if (nav) {
    nav.replaceChildren(...FEATURES.map(f => el('div.ex-nav-item', {
      onclick: () => box.querySelectorAll('.card')[FEATURES.indexOf(f)]?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, [el('span.n', {}, f.n), el('span.grow', {}, f.icon + ' ' + f.title)])));
  }

  const tags = $('#exTags');
  if (tags) {
    const rows = [
      ['[direction]', 'Describe the performance in plain language'],
      ['[pause] [laugh] [sigh] [breath]', 'Sound & timing tags'],
      ['<whisper>…</whisper>', 'Scoped — only these words'],
      ['<emphasis> <faster> <slower> <forceful>', 'Scoped paired tags'],
      ['<|phoneme_start|>R EH1 D<|phoneme_end|>', 'IPA phonemes for one span'],
      ['<|speaker:0|>', 'Speaker turn in a multi-speaker scene'],
      ['Name: line', 'Scene shorthand — converted to speaker tags'],
    ];
    tags.replaceChildren(
      el('button.btn.primary.sm', {
        style: 'width:100%;margin-bottom:8px',
        onclick: () => openTagPicker(),
      }, `🏷 Complex tag library (${TAG_TOTAL})`),
      el('div.hint', { style: 'margin-bottom:14px' },
        'The grammar is above; the library is the lines already built from it — click any tag to drop it at your cursor.'),
      ...rows.map(([tag, desc]) => el('div', { style: 'margin-bottom:10px' }, [
        el('div.mono', { style: 'font-size:11.5px;color:var(--teal)' }, tag),
        el('div.hint', {}, desc),
      ])),
    );
  }
}
