// voicepreview.js — what the ▶ button on a voice does.
//
// One rule, in one place, because a voice is shown in four of them: the Voice
// library page, My Voices, and every picker (Studio, Scenes, Lip Sync, an
// agent's config).
//
// The problem it solves: Fish only generates `samples[]` for *published*
// voices. A voice you uploaded has none, so the naive ▶ is a permanently
// disabled button tooltipped "No sample" — and the one voice you most want to
// audition is the one voice you cannot hear.
//
// So: no sample is not "unplayable", it is "not generated yet". The button
// synthesizes one short line with the model as its own `reference_id` — the same
// call the studio makes with that id — and plays it. That spends API credit, and
// the tooltip says so rather than letting the user find out from a bill.
//
// The result is cached per voice, so pressing ▶ twice plays twice and pays once.

import { toast, apiFetch } from './api.js';
import * as A from './audio.js';

/**
 * The line spoken when a voice has no transcript of its own.
 *
 * A pangram, not a product name. The first version of this said "Welcome to Fish
 * Audio." — which meant every sampleless voice in the app was auditioned with
 * the same branded jingle, so a user pressing ▶ on five different voices heard
 * one identical sentence and reasonably concluded the audio was generic. It was:
 * the *content* was. A neutral test sentence at least says what it is, and the
 * line is now editable (below) so it does not have to be the same words twice.
 */
const DEFAULT_LINE = 'The quick brown fox jumps over the lazy dog.';

const LINE_KEY = 'fd3.previewLine';

/** Object URLs for synthesized previews, keyed the same way playback is. */
const synthesized = new Map();

const idOf = m => m._id || m.id;

/** The sentence ▶ speaks by default, as the user last set it. */
export function previewLine() {
  try { return localStorage.getItem(LINE_KEY) || DEFAULT_LINE; } catch { return DEFAULT_LINE; }
}

/**
 * Set the sentence ▶ speaks. Empty restores the default.
 *
 * Any preview already synthesized was made from the old words, so the cache is
 * dropped rather than replayed — otherwise the next ▶ would play the previous
 * line and look like the setting had been ignored.
 */
export function setPreviewLine(text) {
  const t = String(text || '').trim();
  try { t ? localStorage.setItem(LINE_KEY, t) : localStorage.removeItem(LINE_KEY); } catch { /* private mode */ }
  for (const url of synthesized.values()) { try { URL.revokeObjectURL(url); } catch {} }
  synthesized.clear();
  return previewLine();
}

/**
 * The text a preview speaks.
 *
 * The model's own transcript wins when Fish has one — it is the only text that
 * is genuinely *of* that voice. Otherwise the user's line, otherwise the
 * default pangram.
 */
export function previewText(m) {
  return String(m?.default_text || '').trim() || previewLine();
}

/**
 * Attach preview behaviour to `btn` for voice `m`.
 *
 * `key` must be unique per voice and shared with `A.playPreview`/`A.isPlaying`,
 * so two tiles for the same voice cannot both show ⏸.
 *
 * @returns {'sample'|'synth'} which branch was wired — the probe asserts on it,
 *          because "the button exists" and "the button can play this voice" are
 *          different claims and only the second one is the fix.
 */
export function attachVoicePreview(btn, m, key) {
  const sample = (m.samples || [])[0];
  if (sample?.audio) {
    btn.title = 'Play sample';
    btn.addEventListener('click', e => {
      e.stopPropagation();   // a tile's ▶ must not also pick the voice
      A.playPreview(sample.audio, key, playing => { btn.textContent = playing ? '⏸' : '▶'; });
    });
    return 'sample';
  }
  btn.title = 'No sample yet — ▶ synthesizes a short line with this voice (uses API credit)';
  btn.addEventListener('click', e => { e.stopPropagation(); synthesizeAndPlay(btn, m, key); });
  return 'synth';
}

async function synthesizeAndPlay(btn, m, key) {
  if (A.isPlaying(key)) { A.stopPreview(); return; }
  let url = synthesized.get(key);
  if (!url) {
    const was = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      const blob = await apiFetch('/api/tts', {
        method: 'POST',
        body: { text: previewText(m), reference_id: idOf(m), format: 'mp3' },
      });
      url = URL.createObjectURL(blob);
      synthesized.set(key, url);
    } catch (e) {
      // A 402 with an empty balance lands here and is shown verbatim — better a
      // real message than a button that silently does nothing.
      btn.textContent = was;
      toast('Preview failed: ' + e.message, 'err');
      return;
    } finally { btn.disabled = false; }
  }
  btn.textContent = '▶';
  A.playPreview(url, key, playing => { btn.textContent = playing ? '⏸' : '▶'; });
}

/** Forget a cached preview (used when a voice is deleted or re-uploaded). */
export function dropVoicePreview(key) {
  const url = synthesized.get(key);
  if (url) { URL.revokeObjectURL(url); synthesized.delete(key); }
}
