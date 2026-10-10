// examples.js — every Drama 3 feature from the Voice Guide, ready to load and hear

import { $, el, toast, esc } from './api.js';
import { highlight } from './drama3.js';
import { setScript, generate } from './studio.js';

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
];

// ---------------------------------------------------------------------------
function exampleCard(item, feature) {
  const code = el('pre.example-script', { html: highlight(item.script) });

  const load = el('button.btn.sm.primary', { onclick: () => {
    if (feature.scene) {
      document.querySelector('[data-view="scenes"]').click();
      const ta = $('#sceneScript');
      if (ta) { ta.value = item.script; ta.dispatchEvent(new Event('input')); }
      toast('Loaded into Scenes.');
    } else {
      document.querySelector('[data-view="studio"]').click();
      setScript(item.script);
      if (feature.autotag) toast('Loaded — now press ✨ Auto Tag.');
      else toast('Loaded into the studio.');
    }
  } }, feature.scene ? 'Open in Scenes →' : 'Load into studio →');

  const hear = el('button.btn.sm', { title: 'Load and synthesize (needs API credit)', onclick: async () => {
    if (feature.scene) { document.querySelector('[data-view="scenes"]').click(); const ta = $('#sceneScript'); if (ta) ta.value = item.script; toast('Press “Render scene”.'); return; }
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

export function initExamples() {
  const box = $('#exList');
  if (!box) return;
  box.replaceChildren(...FEATURES.map(featureBlock));

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
    tags.replaceChildren(...rows.map(([tag, desc]) => el('div', { style: 'margin-bottom:10px' }, [
      el('div.mono', { style: 'font-size:11.5px;color:var(--teal)' }, tag),
      el('div.hint', {}, desc),
    ])));
  }
}
