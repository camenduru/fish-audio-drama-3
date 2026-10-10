// tags.js — the complex tag library: ready-made, dramatic, and insertable anywhere
//
// A tag here is a whole *combination*, not a single keyword. The Drama 3
// grammar composes — a direction, a sound tag and a scoped span all in one
// line, and a second direction partway through to turn the mood — and that is
// the shape real dialogue ends up taking. The Examples page proves the grammar
// feature by feature; this library is the other half: the lines you reach for
// when you already know what you want to write.
//
// The picker is deliberately global. Every field that takes a script can open
// it, and so can Ctrl/⌘ + / from anywhere, which inserts into whatever text
// field the user was last in.

import { $, el, toast, modal, close, esc } from './api.js';
import { highlight } from './drama3.js';

// ---------------------------------------------------------------------------
// The library
//
// Each entry is { label, text, note?, wrap?, example? }.
//   text    — inserted verbatim at the caret.
//   wrap    — the open/close this entry is built from, so that a selection can
//             be wrapped in place instead of replaced.
//   example — a fuller line demonstrating the tag, for entries whose own text is
//             a bare fragment ([short pause]) rather than something you can hear
//             on its own. The Examples page prefers it; the picker ignores it.
// A category may set `scene: true` — those entries are multi-speaker scripts,
// and the Examples page loads them into Scenes rather than the studio.
// ---------------------------------------------------------------------------
export const TAG_CATEGORIES = [
  {
    id: 'directions', icon: '🎙', title: 'Directions',
    blurb: 'plain-language delivery notes',
    // `bare` marks the one category that also reads correctly OUTSIDE a script —
    // as a voice description, or in the "new direction" box. Those fields want
    // the phrase, not the bracketed tag, so the picker opens there in bare mode.
    bare: true,
    tags: [
      { label: 'Warm and relaxed', text: `[warm and relaxed, like talking to an old friend]`, note: 'The default human register. Podcasts, narration, support lines.' },
      { label: 'Clipped, all business', text: `[clipped, all business]`, note: 'Short, flat, no wasted air. Military, procedural, corporate.' },
      { label: 'Barely holding it together', text: `[barely holding it together]`, note: 'A voice about to break. Pairs with a late [pause].' },
      { label: 'Suspiciously calm', text: `[suspiciously calm]`, note: 'Calm that is obviously a decision. Comedy and threat both.' },
      { label: 'Deadpan', text: `[deadpan, utterly serious]`, note: 'No joke signalled. The funniest register for a punchline.' },
      { label: 'Low, documentary', text: `[low, documentary]`, note: 'Measured, unhurried, slightly removed from the subject.' },
      { label: 'Conspiratorial whisper', text: `[conspiratorial whisper]`, note: 'Close, quiet, sharing something they should not.' },
      { label: 'Suddenly intense', text: `[suddenly intense]`, note: 'A hard turn without changing the words.' },
      { label: 'Exhausted', text: `[exhausted, whispering to a friend in the dark]`, note: 'Tired and intimate. Very low energy.' },
      { label: 'Genuinely excited', text: `[genuinely excited]`, note: 'Sincere enthusiasm — hard to fake, so state it plainly.' },
      { label: 'Skeptical', text: `[skeptical, questioning tone]`, note: 'Doubt carried by the voice, not the words.' },
      { label: 'Voice dropping', text: `[voice dropping]`, note: 'A drop in volume and register mid-line. Pairs with [pause].' },
      { label: 'Tired but proud', text: `[tired but proud, end of a long day]`, note: 'Weariness with warmth under it. Good for sign-offs.' },
      { label: 'Cinematic trailer voice', text: `[cinematic trailer voice — deep, slow, every word placed like a drumbeat]`, note: 'For Voice Design, or a trailer read.' },
    ],
  },
  {
    id: 'emotion', icon: '🎭', title: 'Emotion arcs',
    blurb: 'a mood that turns mid-line',
    tags: [
      { label: 'Calm → panic', text: `[calm] Everything's fine — [trembling, panicked] wait. Did you hear that?`, note: 'The shift lands on the second direction. Two performances, one take.' },
      { label: 'Confident → doubt', text: `[confident] I've got this — [quietly, losing confidence] I think.`, note: 'Bravado that drains away on the last two words.' },
      { label: 'Bored → thrilled', text: `[bored, monotone] Another Monday meeting — [suddenly thrilled] wait, there's free pizza?`, note: 'Flat delivery that jumps register mid-sentence.' },
      { label: 'Warm → ice cold', text: `[warm, welcoming] Come in, sit down — [ice cold] you're not welcome here.`, note: 'Hospitality that curdles. Good for a reveal.' },
      { label: 'Steady → breaking', text: `[steady, in control] I can hold this line — [voice cracking] I can't. I can't.`, note: 'Control failing in real time.' },
      { label: 'Anger → collapse', text: `[suddenly furious] <forceful>Get out.</forceful> [pause] [breath] [whispering, broken] <whisper>Please. Just go.</whisper>`, note: 'Forceful → pause → breath → a second direction → whisper. The hardest thing to fake, in one line.' },
      { label: 'Composed → delighted', text: `[measured, serious] The numbers are in — [laughing, delighted] we're ruined. Absolutely ruined.`, note: 'The laugh does the work. Deadpan→joy is a comedy staple.' },
    ],
  },
  {
    id: 'tension', icon: '🕯', title: 'Tension & dread',
    blurb: 'horror, thriller, the long beat',
    tags: [
      { label: 'Don\'t move', text: `[barely above a whisper] <slower>Don't move.</slower> [pause] [breath] It's right behind you.`, note: 'Whisper → a drawn-out beat → a breath → the line. Slowest possible reveal.' },
      { label: 'Locked from inside', text: `[dead calm] The door was locked from the inside. [pause] <whisper>And we're the only ones here.</whisper>`, note: 'Calm delivery, then the drop. The pause is the scare.' },
      { label: 'It was never a house', text: `[voice cracking] It's not a house. [pause] [breath] <whisper>It never was.</whisper>`, note: 'A correction that reframes everything before it.' },
      { label: 'The first transmission', text: `[distant, over static] Is anyone receiving? [pause] <slower>Please.</slower>`, note: 'Distance in the direction, desperation in the pace.' },
      { label: 'Counting down', text: `[clipped, all business] We have ninety seconds. [pause] [very slowly] Make that forty.`, note: 'Brisk → slow. The pace change is the bad news.' },
      { label: 'Something is wrong', text: `[calm narration] The reading was normal. [pause] [quietly] Then it wasn't. [pause] [breath] <whisper>Then it was very wrong.</whisper>`, note: 'Three beats, each quieter than the last.' },
    ],
  },
  {
    id: 'action', icon: '💥', title: 'Action & combat',
    blurb: 'barked, breathless, urgent',
    tags: [
      { label: 'Move, move, move', text: `[barking orders, urgent] <forceful>Move, move, move!</forceful> [breath] <faster>They're flanking us.</faster>`, note: 'Forceful command, a breath, then a rushed clause.' },
      { label: 'I\'m hit', text: `[grunting, out of breath] I'm hit — [pause] [strained] <forceful>I'm fine. Keep going.</forceful>`, note: 'Pain, a beat, then a lie told forcefully.' },
      { label: 'Wrong door', text: `[cold, lethal] <slower>You picked the wrong door.</slower>`, note: 'Slowing down reads as more dangerous than shouting.' },
      { label: 'Contact', text: `[startled] Contact! [pause] <forceful>Open fire!</forceful>`, note: 'Two words, a beat, an order. The shortest useful bark.' },
      { label: 'Reloading', text: `[mock-cheerful] Reloading! [pause] [flat] Out of ammo.`, note: 'Cheer undercut by deadpan. Comedy in an action beat.' },
      { label: 'Hold the line', text: `[measured] Hold the line. Nobody fires until I say. [pause] [breaking] <faster>Captain — it's already inside.</faster>`, note: 'Command voice, then the report that ends the plan.' },
    ],
  },
  {
    id: 'game', icon: '🎮', title: 'Game barks',
    blurb: 'short NPC lines that repeat well',
    tags: [
      { label: 'Objective secure', text: `[triumphant] <emphasis>Objective secure.</emphasis> [laugh] Told you it'd hold.`, note: 'Short, punchy, ends on a laugh — repeats without grating.' },
      { label: 'Tell them we held', text: `[dying, strained] <slower>Tell them… [breath] tell them we held the line.</slower>`, note: 'A death line. The trailing-off is the whole performance.' },
      { label: 'Spotted you', text: `[sharp, alert] There you are. [pause] <forceful>Nowhere left to run.</forceful>`, note: 'Boss or elite-enemy aggro bark.' },
      { label: 'Quest accepted', text: `[warm, relieved] You came back. [pause] [laugh] I knew you would. Mostly.`, note: 'A quest-giver beat with a joke that keeps it human.' },
      { label: 'Low health', text: `[breathless] Still standing — [pause] [strained] barely.`, note: 'For a player character on low health.' },
      { label: 'Ambient crowd', text: `[chattering, overlapping, cheerful] Fresh bread! Two for a copper! [pause] [shouting over the noise] Two for a copper!`, note: 'Market ambience. The repeat is what sells a crowd.' },
      { label: 'Taunt', text: `[sneering, unhurried] You fight like a farmer. [pause] <slower>Let me show you how it's done.</slower>`, note: 'Villain bark that gets slower as it gets crueller.' },
    ],
  },
  {
    id: 'trailer', icon: '🎬', title: 'Movie trailer',
    blurb: 'big, slow, building',
    tags: [
      { label: 'In a world…', text: `[low, gravelly, building] In a world where <slower>nothing is what it seems</slower>… [pause] one man will risk <emphasis>everything.</emphasis>`, note: 'The classic trailer cadence. Long pauses are the genre.' },
      { label: 'This summer', text: `[whispered, intense] This summer — [pause] [forceful] <emphasis>the truth comes home.</emphasis>`, note: 'Whisper into a hard cut. Two seconds of audio.' },
      { label: 'One choice', text: `[measured, serious] One decision. [pause] One mistake. [pause] [low] <slower>No way back.</slower>`, note: 'Three short lines, each slower. Builds by decelerating.' },
      { label: 'Based on a true story', text: `[calm, documentary] It began as a routine inspection. [pause] [suddenly intense] It ended as <emphasis>the worst day in the town's history.</emphasis>`, note: 'Documentary calm into a hard turn.' },
      { label: 'Rated R button', text: `[low, ominous] Some doors are locked for a reason. [pause] [forceful] <emphasis>Open it.</emphasis>`, note: 'A button line to end a trailer.' },
    ],
  },
  {
    id: 'villain', icon: '🦹', title: 'Villain & menace',
    blurb: 'quiet, patient, worse for it',
    tags: [
      { label: 'I chose it', text: `[soft, almost kind] You think I wanted this? [pause] <slower>I <emphasis>chose</emphasis> it.</slower> [laugh]`, note: 'Kindness is scarier than shouting. The laugh is the tell.' },
      { label: 'Everyone breaks', text: `[quietly amused] Everyone breaks. [pause] <whisper>You just break prettier than most.</whisper>`, note: 'Amusement dropping into a whisper.' },
      { label: 'You misunderstand me', text: `[patient, reasonable] I'm not going to hurt you. [pause] [flat] <slower>I'm going to keep you.</slower>`, note: 'The reassurance is the threat.' },
      { label: 'The offer', text: `[measured, generous] Work for me and no one touches her. [pause] [ice cold] Refuse, and I'll ask again tomorrow.`, note: 'A two-part offer. The second part is quieter.' },
      { label: 'Final word', text: `[calm] You were never the hero. [pause] [breath] <whisper>You were the warning.</whisper>`, note: 'A closing line that reframes the whole story.' },
      { label: 'Villain monologue (long)', text: `[low, almost gentle] When I was young, they told me the world was fair. [pause] [quietly amused] I believed them for <emphasis>years.</emphasis> [pause] [ice cold] <slower>Then I started counting.</slower>`, note: 'A monologue built from three turns, each colder than the last.' },
    ],
  },
  {
    id: 'grief', icon: '💔', title: 'Grief & loss',
    blurb: 'holding it together, then not',
    tags: [
      { label: 'I\'m fine', text: `[barely holding it together] I'm fine. [pause] [breath] <whisper>Really. Go on without me.</whisper>`, note: 'The whole performance is the pause. Do not rush it.' },
      { label: 'Reading the letter', text: `[calm narration] The book was <|phoneme_start|>R EH1 D<|phoneme_end|> yesterday. [pause] <whisper>I never read it out loud.</whisper>`, note: 'A phoneme fixes past-tense “read”, then the line drops to a whisper.' },
      { label: 'After the funeral', text: `[tired but proud, end of a long day] People keep saying she's in a better place. [pause] [quietly, almost to himself] She liked <emphasis>this</emphasis> one.`, note: 'Grief expressed as mild disagreement.' },
      { label: 'The empty room', text: `[quietly, losing confidence] I still say goodnight. [pause] [breaking] <slower>I know. I know.</slower>`, note: 'Reassuring nobody. Slower is the only way to land it.' },
      { label: 'Anger under grief', text: `[cutting in, dangerously calm] Don't. [pause] [voice cracking] Don't you dare say it was for the best.`, note: 'Anger that breaks on the second sentence.' },
      { label: 'Losing confidence', text: `[genuinely excited] We did it — [pause] [quietly, losing confidence] didn't we?`, note: 'Celebration that turns into a question.' },
    ],
  },
  {
    id: 'romance', icon: '❤️', title: 'Romance & intimacy',
    blurb: 'close to the mic, unhurried',
    tags: [
      { label: 'I\'ve got you', text: `[soft, close to the mic] Hey. [pause] <whisper>You're okay. I've got you.</whisper>`, note: 'Direction says "close to the mic" — it does change the read.' },
      { label: 'Don\'t ever change', text: `[warm, teasing] You're impossible. [pause] [laugh] [tender] <slower>Don't ever change.</slower>`, note: 'Tease, laugh, then mean it. Three beats in one line.' },
      { label: 'The confession', text: `[nervous, quiet] There's something I should have said. [pause] [breath] [barely holding it together] <whisper>I never stopped.</whisper>`, note: 'Nervous → pause → breath → whisper. Nothing is stated plainly.' },
      { label: 'Goodnight', text: `[warm and relaxed, like talking to an old friend] Sleep well. [pause] <slower>Same time tomorrow?</slower>`, note: 'Easy intimacy with a hopeful ask.' },
      { label: 'Reunion', text: `[startled] You're — [pause] [laughing, delighted] <faster>You're actually here.</faster> [breath] <whisper>You came back.</whisper>`, note: 'Shock → laugh → rush → whisper. A whole reunion in five seconds.' },
    ],
  },
  {
    id: 'comedy', icon: '😂', title: 'Comedy timing',
    blurb: 'the pause is the joke',
    tags: [
      { label: 'The knife people', text: `[deadpan, utterly serious] Our sponsor today is <emphasis>Nordwind</emphasis> — [pause] yes, [laugh] the knife people.`, note: 'Deadpan, a weighted brand name, then a pause and a laugh that undercut it.' },
      { label: 'We\'re going to die', text: `[bright, reassuring] We're going to be fine. [pause] [flat] We're going to die.`, note: 'Whiplash. Two short clauses and one pause.' },
      { label: 'Technically', text: `[pause] Okay, so, technically — [pause] [cutting in, dangerously calm] <emphasis>Finish your vegetables.</emphasis>`, note: 'An interruption. The second speaker never gets to finish.' },
      { label: 'No dog', text: `[way too fast] Maybe the dog. Dogs love cake. [pause] [suspiciously calm] We don't have a dog.`, note: 'Fast lie, long beat, calm demolition.' },
      { label: 'Bad idea', text: `[from the van, delighted] I told you the keycard was a bad idea. [pause] [flat] It was a great idea.`, note: 'Delight flipping to flat in one beat.' },
      { label: 'Under her breath', text: `[cheerful] Of course I remembered. [pause] [under his breath] <slower>I forgot completely.</slower>`, note: 'Two directions, two volumes, one breath apart.' },
    ],
  },
  {
    id: 'narration', icon: '📖', title: 'Narration & documentary',
    blurb: 'one voice, a whole arc',
    tags: [
      { label: 'Alder Lane', text: `[calm narration] The house on Alder Lane had stood empty for as long as anyone could remember. [pause] <slower>Almost anyone.</slower> [breath] Because Mrs Pell remembered. [quietly, almost to himself] She remembered <emphasis>everything.</emphasis>`, note: 'An audiobook opening that turns on three words.' },
      { label: 'Documentary turn', text: `[measured, serious] In the spring of 1986, [pause] a reactor in the north began to hum. [suddenly intense] Not loudly — <faster>that was the problem.</faster> [pause] [quietly, holding back] By morning the town was gone.`, note: 'Calm register that snaps to alarm, speeds up, then drops away.' },
      { label: '1969', text: `[calm, professional narrator] In 1969, [pause] a single engineer <slower>rewired everything.</slower> [breath] The rest, as they say, is history.`, note: 'Direction + pause + scoped slowdown + a breath. Four features, one sentence.' },
      { label: 'Podcast turn', text: `[warm and conversational] Okay, so — [pause] this is the part where I'm supposed to say it gets easier. [laugh] It doesn't. [lowering her voice] On the night of the fourteenth, [breath] three people drove out to the lake. [pause] Only two came back.`, note: 'Chatty, self-aware, then quiet. The laugh makes the turn land.' },
      { label: 'Nature documentary', text: `[low, documentary] The herd moves at dawn. [pause] [quietly] They do not know what waits in the tall grass. [pause] [flat] They never do.`, note: 'Warm nature register with a cold last line.' },
    ],
  },
  {
    id: 'scifi', icon: '📡', title: 'Sci-fi & radio comms',
    blurb: 'over comms, distorted, failing',
    tags: [
      { label: 'Do you copy', text: `[over the radio, distorted] Do you copy? [pause] [urgent] <faster>I'm losing pressure.</faster>`, note: 'Distortion in the direction, panic in the pace.' },
      { label: 'System warning', text: `[synthetic, even] System nominal. [pause] [glitching] <faster>Warning — breach in sector seven.</faster>`, note: 'A machine voice that breaks mid-report.' },
      { label: 'Not one of ours', text: `[over the radio, distorted] Movement. Sector seven. [pause] [clipped, all business] It's not one of ours.`, note: 'Radio drama in three short beats.' },
      { label: 'Last transmission', text: `[distant, over static] If anyone's listening — [pause] [breath] <slower>we were here. We were here.</slower>`, note: 'The repeat is the performance.' },
      { label: 'AI addressing you', text: `[synthetic, even, polite] I have run the simulation four million times. [pause] [flat] You die in all of them. [pause] [glitching] <slower>Would you like to try anyway?</slower>`, note: 'Politeness plus omniscience. The question is the threat.' },
    ],
  },
  {
    id: 'pacing', icon: '🧱', title: 'Sound & pacing blocks',
    blurb: 'drop these in where the beat goes',
    tags: [
      { label: 'A single beat', text: `[short pause]`, example: `[measured, serious] It was the fourteenth. [short pause] Or the fifteenth.`, note: 'Steadier than a bare [pause] when the timing matters — a bare one swings a lot between takes.' },
      { label: 'A dramatic beat', text: `[pause]`, example: `[deadpan] Our sponsor today is Nordwind. [pause] Yes. The knife people.`, note: 'Anywhere from a beat to a dozen seconds. Dramatic, but unpredictable.' },
      { label: 'Breath + beat', text: `[breath] [pause]`, example: `I opened the door, [breath] [pause] and the room was empty.`, note: 'A nervous inhale, then silence. Builds suspense.' },
      { label: 'Recover', text: `[pause] [breath] [sigh]`, example: `[shaken] I'm fine. [pause] [breath] [sigh] Give me a second.`, note: 'For a character collecting themselves.' },
      { label: 'Disbelief', text: `[pause] [laugh] [pause]`, example: `[flat] He left you the house. [pause] [laugh] [pause] He left you the house.`, note: 'Silence, a disbelieving laugh, silence.' },
      { label: 'Before the punchline', text: `[pause before it, deadpan]`, example: `[calm] The results are in — [pause before it, deadpan] you won.`, note: 'A direction that exists only to buy a beat.' },
    ],
  },
  {
    id: 'phoneme', icon: '🗣', title: 'Pronunciation fixes',
    blurb: 'IPA for one span',
    tags: [
      { label: 'read (past tense)', text: `The book was <|phoneme_start|>R EH1 D<|phoneme_end|> yesterday.`, note: '“read” as “red”.' },
      { label: 'GIF (soft G)', text: `It's pronounced <|phoneme_start|>JH IH1 F<|phoneme_end|>, fight me.`, note: 'Settles the argument in one line.' },
      { label: 'A surname', text: `Huge thanks to my editor, Linh <|phoneme_start|>W IH1 N<|phoneme_end|>.`, note: 'Names are the most common reason to reach for a phoneme.' },
      { label: 'Wrap any word', text: `R EH1 D`, example: `It was a <|phoneme_start|>L AY1 V<|phoneme_end|> performance.`, wrap: { open: '<|phoneme_start|>', close: '<|phoneme_end|>' }, note: 'Select a word first, then click — it wraps the selection in phoneme tags.' },
      { label: 'live (adj.)', text: `This is a <|phoneme_start|>L AY1 V<|phoneme_end|> broadcast.`, note: '“live” as in “alive”, not “liv”.' },
    ],
  },
  {
    id: 'scene-game', icon: '🕹', title: 'Scene starters — game',
    blurb: 'multi-speaker, ready to render',
    scene: true,
    tags: [
      {
        label: 'Reactor breach (4 speakers)',
        text: `Narrator: [low, documentary] The reactor has been cold for a hundred years.\nSentry: [over comms, clipped] Movement. Sector seven. [pause] It's not one of ours.\nCaptain: [measured] Hold the line. Nobody fires until I say.\nSentry: [breaking] Captain — <faster>it's already inside.</faster>`,
        note: 'Four turns of escalation. Load it into Scenes and give each speaker a voice.',
      },
      {
        label: 'Heist briefing (4 speakers)',
        text: `Vex: [clipped, all business] We have ninety seconds. In and out.\nMarla: [chewing gum, unbothered] Relax. I've done this a hundred times.\nVex: [flat] You've done it twice.\nMarla: [pause] ...Ninety-one seconds.\nNova: [over the radio, distorted] Guys? The door's already open.\nVex: [very slowly] Say that again.\nDex: [from the van, delighted] I told you the keycard was a bad idea.`,
        note: 'The comedy is in the pauses — one character conceding, one slowing right down.',
      },
      {
        label: 'Boss encounter (2 speakers)',
        text: `Villain: [quietly amused] You climbed all this way. [pause] For what?\nHero: [defiant, breathless] For the ones you took.\nVillain: [soft, almost kind] Then you'll want to sit down. [pause] <slower>This is going to take a while.</slower>`,
        note: 'A two-hander where the villain is calmer than the hero.',
      },
    ],
  },
  {
    id: 'scene-movie', icon: '🎞', title: 'Scene starters — movie',
    blurb: 'multi-speaker, ready to render',
    scene: true,
    tags: [
      {
        label: 'Interrogation (2 speakers)',
        text: `Detective: [measured, serious] Let's go back to the fourteenth.\nSuspect: [trying to stay calm] I've told you. I was home.\nDetective: [pause] You were home.\nSuspect: [defensive, slightly uneasy tone] Yes.\nDetective: [quietly] Then why does your neighbour say she saw your car?\nSuspect: [pause] [voice dropping] ...She's mistaken.\nDetective: [gently questioning] She wrote down the plate.\nSuspect: [breaking] <whisper>I want to call my lawyer.</whisper>`,
        note: 'Eight turns ending on a whispered collapse. A two-hander with real escalation.',
      },
      {
        label: 'The reveal (3 speakers)',
        text: `Villain: [soft, almost kind] You think I wanted this?\nHero: [defiant] You had a choice.\nVillain: [pause] [quietly amused] Everyone says that. [pause] <slower>Then they choose anyway.</slower>\nWitness: [startled] Sir — you need to hear this.\nHero: [quietly] Not now.\nWitness: [breaking] It's about the fourteenth.`,
        note: 'A villain scene interrupted by the news that ends it.',
      },
      {
        label: 'Family dinner (3 speakers)',
        text: `Dad: [too cheerful] So. Anyone want to explain the car?\nTeen: [mouth full] Nope.\nMom: [not looking up] The car is fine.\nDad: [pause] The car is in the kitchen.\nTeen: [pause] Okay, so, technically —\nMom: [cutting in, dangerously calm] <emphasis>Finish your vegetables.</emphasis>`,
        note: 'Comedy built on an interruption and a scoped span for the punchline.',
      },
      {
        label: 'Radio drama (4 speakers)',
        text: `Narrator: [low, documentary] The lighthouse had been dark for eleven years.\nKeeper: [distant, over static] Is anyone receiving? [pause] Please.\nNarrator: [pause] That was the first transmission.\nOperator: [startled] Sir — you need to hear this.\nKeeper: [closer now, urgent] It's not a lighthouse. [pause] It never was.`,
        note: 'The same speaker moves closer across the scene — the direction tracks distance.',
      },
    ],
  },
];

/** Total entries, for the UI counters. */
export const TAG_TOTAL = TAG_CATEGORIES.reduce((n, c) => n + c.tags.length, 0);

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------
const NON_TEXT_INPUTS = /^(checkbox|radio|file|submit|button|reset|range|color|image|date|time)$/i;

/** Is this something we can put text into at a caret? */
export function isField(node) {
  if (!node || !node.tagName) return false;
  if (node.tagName === 'TEXTAREA') return true;
  if (node.tagName === 'INPUT') return !NON_TEXT_INPUTS.test(node.type || 'text');
  return false;
}

/** A short human name for a field, for the "inserting into…" line. */
function fieldLabel(field) {
  if (!field) return '';
  if (field.dataset?.tagLabel) return field.dataset.tagLabel;
  const ph = field.getAttribute?.('placeholder');
  if (ph) {
    // Placeholders can be a whole sample script; only the first line is a name.
    const first = ph.split('\n')[0].replace(/\s*[…\.]+$/, '').trim();
    if (first) return first.length > 40 ? first.slice(0, 40) + '…' : first;
  }
  return field.id ? '#' + field.id : field.tagName.toLowerCase();
}

/**
 * Put `text` into `field` at the caret, replacing whatever is selected.
 *
 * A paired entry carries `wrap` — the open/close it is built from — so a
 * selection is wrapped in place rather than thrown away. With no selection the
 * sample goes in and is left selected, so the user can type straight over it.
 */
export function insertIntoField(field, text, wrap) {
  if (!isField(field)) return false;
  const s = field.selectionStart ?? field.value.length;
  const e = field.selectionEnd ?? s;
  const sel = field.value.slice(s, e);

  let insert = text;
  let selFrom = s, selTo = s + text.length;
  if (wrap && sel) {
    insert = wrap.open + sel + wrap.close;
    selFrom = s + wrap.open.length;
    selTo = selFrom + sel.length;
  } else {
    // Never glue onto the previous word.
    const prev = field.value[s - 1];
    const pre = prev && !/\s/.test(prev) ? ' ' : '';
    insert = pre + text;
    selFrom = s + pre.length;
    selTo = selFrom + text.length;
  }

  field.setRangeText(insert, s, e, 'end');
  try { field.setSelectionRange(selFrom, selTo); } catch {}
  // The host pages listen for `input` to re-highlight, re-analyse and re-parse,
  // so the insertion has to announce itself.
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------
let lastField = null;   // the last text field the user was in — see initTagPicker

/**
 * A direction entry stripped of its brackets — `[clipped, all business]` becomes
 * `clipped, all business`.
 *
 * Description fields (the Voice Design instruction, the "new direction" box) are
 * prose, not scripts: brackets there would be read out as literal characters. So
 * the picker opens those in bare mode, which offers only the direction category
 * and writes the phrase itself.
 */
function barePhrase(text) {
  const m = /^\[([^\]\n]+)\]$/.exec((text || '').trim());
  return m ? m[1] : null;
}

/**
 * Open the tag library.
 *
 * @param {object}  [opts]
 * @param {Element} [opts.target]   field to insert into (defaults to the last one focused)
 * @param {Function}[opts.onInsert] custom inserter, called as onInsert(text, wrap)
 * @param {boolean} [opts.bare]     description-field mode: directions only, no brackets
 */
export function openTagPicker({ target = null, onInsert = null, bare = false } = {}) {
  const field = isField(target) ? target : (isField(lastField) ? lastField : null);

  const cats = bare ? TAG_CATEGORIES.filter(c => c.bare) : TAG_CATEGORIES;
  const total = bare ? cats.reduce((n, c) => n + c.tags.length, 0) : TAG_TOTAL;

  const search = el('input.input', { id: 'tagSearch', placeholder: bare ? 'Search directions…' : 'Search tags, moods, genres…', style: 'max-width:260px' });
  const catSel = el('select.select', { id: 'tagCat', style: 'max-width:250px' }, [
    el('option', { value: '' }, `All categories (${total})`),
    ...cats.map(c => el('option', { value: c.id }, `${c.icon} ${c.title} (${c.tags.length})`)),
  ]);
  const where = el('div.tag-target', { id: 'tagWhere' }, field
    ? `Inserting into: ${fieldLabel(field)}${bare ? ' — as a description' : ''}`
    : 'No text field focused — clicking a tag copies it instead.');
  const list = el('div', { id: 'tagList' });

  const place = tag => {
    const text = bare ? (barePhrase(tag.text) || tag.text) : tag.text;
    if (field) {
      if (onInsert) onInsert(text, bare ? null : tag.wrap);
      else insertIntoField(field, text, bare ? null : tag.wrap);
      toast('Inserted · ' + tag.label, 'ok');
    } else {
      navigator.clipboard?.writeText(text);
      toast('Copied · ' + tag.label);
    }
  };

  const card = tag => {
    const shown = bare ? (barePhrase(tag.text) || tag.text) : tag.text;
    return el('div.tag-item', {
      title: field ? 'Insert at the cursor' : 'Copy to clipboard',
      onclick: () => place(tag),
    }, [
      el('div.tag-item-h', {}, [
        el('span.tag-item-label', {}, tag.label),
        el('div.grow'),
        el('button.btn.sm.ghost', {
          title: 'Copy to clipboard',
          onclick: e => { e.stopPropagation(); navigator.clipboard?.writeText(shown); toast('Copied.'); },
        }, '⧉'),
      ]),
      el('pre.tag-item-code', { html: bare ? esc(shown) : highlight(shown) }),
      tag.note ? el('div.tag-item-note', {}, tag.note) : null,
    ]);
  };

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const only = catSel.value;
    const shown = cats
      .filter(c => !only || c.id === only)
      .map(c => ({
        ...c,
        tags: q
          ? c.tags.filter(t => (t.label + ' ' + t.text + ' ' + (t.note || '')).toLowerCase().includes(q))
          : c.tags,
      }))
      .filter(c => c.tags.length);

    if (!shown.length) {
      list.replaceChildren(el('div.hint', { style: 'padding:18px 4px' }, 'No tags match that search.'));
      return;
    }
    list.replaceChildren(...shown.map((c, i) => el('details.tag-cat', { open: !!only || !!q || i === 0 }, [
      el('summary', {}, [
        el('span', {}, c.icon),
        el('span', {}, c.title),
        el('span.pill', {}, String(c.tags.length)),
        el('div.grow'),
        el('span.tag-cat-blurb', {}, c.blurb || ''),
      ]),
      el('div.tag-cat-b', {}, c.tags.map(card)),
    ])));
  };

  search.addEventListener('input', paint);
  catSel.addEventListener('change', paint);

  modal({
    title: bare
      ? `🎙 Directions — ${total} delivery notes`
      : `🏷 Complex tags — ${total} ready-made combinations`,
    wide: true,
    body: el('div', {}, [
      el('div.tag-tools', {}, [search, catSel, el('div.grow'), where]),
      el('div.hint.mb', {}, bare
        ? 'Click a direction to insert the phrase itself — no brackets, because this field is prose. The popup stays open, so you can stack several.'
        : 'Click any tag to insert it at your cursor. Paired tags wrap whatever you have selected. The popup stays open, so you can stack several.'),
      list,
    ]),
    footer: [
      el('span.hint.grow', { style: 'text-align:left' }, 'Ctrl / ⌘ + /  opens this from any text field'),
      el('button.btn', { onclick: close }, 'Done'),
    ],
  });
  paint();
  search.focus();
}

/**
 * A small 🏷 button that opens the library for `input`.
 *
 * @param {Element} input
 * @param {object}  [opts]
 * @param {string}  [opts.label]   name shown in the picker's "inserting into…"
 * @param {string}  [opts.cls]     button classes (default: a small icon button)
 * @param {string}  [opts.text]    button caption (default: 🏷)
 * @param {boolean} [opts.bare]    description-field mode (see openTagPicker)
 * @param {Function}[opts.onInsert] custom inserter instead of writing to `input`
 */
export function attachTagButton(input, { label, cls = 'btn sm icon', text = '🏷', onInsert = null, title, bare = false } = {}) {
  if (input && label) input.dataset.tagLabel = label;
  return el('button.' + cls.split(' ').join('.'), {
    type: 'button',
    title: title || (bare
      ? 'Delivery directions — insert a phrase, no brackets'
      : 'Complex tags — ready-made dramatic combinations'),
    onclick: e => { e.preventDefault(); e.stopPropagation(); openTagPicker({ target: input, onInsert, bare }); },
  }, text);
}

/**
 * Make the library reachable from anywhere.
 *
 * Tracks the last text field the user was in, so the floating button and the
 * Ctrl/⌘ + / shortcut know where to insert without the user having to click
 * into the field again first.
 */
export function initTagPicker() {
  document.addEventListener('focusin', e => {
    if (isField(e.target)) lastField = e.target;
  }, true);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      openTagPicker();
    }
  });

  const fab = $('#tagFab');
  if (fab) {
    // Keep the count honest — the library grows.
    fab.title = `Complex tags — ${TAG_TOTAL} ready-made dramatic combinations (Ctrl / ⌘ + /)`;
    fab.addEventListener('click', () => openTagPicker());
  }
}
