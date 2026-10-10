#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Is the studio's viseme baker actually RIGHT?

Everything here is studio-local. It reads no file from the game project and
imports none of its Python — the only cross-project contract that matters is the
SIDECAR FORMAT, and that is checked directly on the bytes this baker emits.

Why this is not "does the studio agree with the game's baker" any more
---------------------------------------------------------------------
It used to be exactly that, and that test passed while the studio shipped a
broken mouth track. The reason is worth keeping written down:

  The studio baked Allosaurus's phones with OpenFaceFX's
  `--anchors-format phones --phones-alphabet ipa`. That table is a 39-entry
  bijection onto canonical IPA. Allosaurus speaks the 230-symbol universal
  inventory, so its ordinary English output (ə o ʀ ɹ̩ b̥ ɒ ɾ ɾʲ ...) missed the
  table, passed through unconverted, and was routed to `sil` at the viseme
  stage — i.e. the mouth CLOSED. On the fixture in tools/fixtures/ the first
  0.58 s of audible speech was baked shut.

  Agreement between two bakers cannot detect a shared misunderstanding. The
  reference has to be the AUDIO, not the other implementation. That is what
  PART 2 does, and it is the check that would have failed.

Parts
-----
  PART 1  WELL-FORMED   the sidecar is a track the game can load at all:
                        sorted, contiguous, in-range, A-H/X, duration sane.

  PART 2  SOUND         the mouth is not closed over audio that is actually
                        loud. Aligner-agnostic, measured off the WAV itself.
                        THE regression guard for the bug above.

  PART 3  PHONES        every symbol in Allosaurus's English inventory reaches
                        the viseme table, and the ones that used to fall
                        through map where they should.

  PART 4  GUARD         `--speech-guard` is inert without anchors and really
                        changes the output once anchors exist. A dead flag
                        would otherwise read as "no effect" and be missed.

  PART 5  HTTP          with --endpoint, POST the fixture to the running
                        studio's /api/visemes and re-run PART 1+2 on the wire.
                        Parts 1-4 test the module; this tests what the app
                        actually sends.

Usage:
    python tools/compare_bakers.py                       # the tracked fixture
    python tools/compare_bakers.py --wav x.wav --text "Hello there."
    python tools/compare_bakers.py --anchors fish_alignment.json
    python tools/compare_bakers.py --endpoint http://127.0.0.1:8756
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO_TOOL = os.path.join(HERE, "visemes.py")
FIXTURE_WAV = os.path.join(HERE, "fixtures", "speech.wav")
FIXTURE_ANCHORS = os.path.join(HERE, "fixtures", "speech.anchors.json")
FIXTURE_TEXT = "The old lamp still flickers. Nobody has lit it in years."

# Allosaurus's English inventory (pretrained/uni2005/inventory/stan1293.txt) -
# the set the recognizer actually emits for our lines. Every one of these must
# reach a viseme.
ALLO_ENGLISH = (
    "a aː b d d̠ e eː e̞ f h i iː j k kʰ l m n o oː p pʰ r s t tʰ t̠ u uː v w "
    "x z æ ð øː ŋ ɐ ɐː ɑ ɑː ɒ ɒː ɔ ɔː ɘ ə əː ɛ ɛː ɜː ɡ ɪ ɪ̯ ɯ ɵː ɹ ɻ ʃ ʉ ʉː ʊ "
    "ʌ ʍ ʒ ʔ θ"
).split()

# The full 230-symbol universal inventory the decoder can emit. Not every
# symbol is expected to map (many are for languages we never bake), so this is
# reported as coverage rather than asserted.
ALLO_UNIVERSAL = (
    "I a aː ã ă b bʲ bʲj bʷ bʼ bː b̞ b̤ b̥ c d dʒ dʲ dː d̚ d̥ d̪ d̯ d͡z d͡ʑ d͡ʒ "
    "d͡ʒː d͡ʒ̤ e eː e̞ f fʲ fʷ fː g gʲ gʲj gʷ gː h hʷ i ij iː i̞ i̥ i̯ j k kx kʰ "
    "kʲ kʲj kʷ kʷʼ kʼ kː k̟ʲ k̟̚ k͡p̚ l lʲ lː l̪ m mʲ mʲj mʷ mː n nj nʲ nː n̪ "
    "n̺ o oː o̞ o̥ p pf pʰ pʲ pʲj pʷ pʷʼ pʼ pː p̚ q r rː s sʲ sʼ sː s̪ t ts "
    "tsʰ tɕ tɕʰ tʂ tʂʰ tʃ tʰ tʲ tʷʼ tʼ tː t̚ t̪ t̪ʰ t̪̚ t͡s t͡sʼ t͡ɕ t͡ɬ t͡ʃ "
    "t͡ʃʲ t͡ʃʼ t͡ʃː u uə uː u͡w v vʲ vʷ vː v̞ v̞ʲ w x x̟ʲ y z zj zʲ z̪ ä æ ç çj ð "
    "ø ŋ ŋ̟ ŋ͡m œ œ̃ ɐ ɐ̞ ɑ ɑ̱ ɒ ɓ ɔ ɔ̃ ɕ ɕː ɖ̤ ɗ ə ɛ ɛ̃ ɟ ɡ ɡʲ ɡ̤ ɡ̥ ɣ ɣj ɤ "
    "ɤɐ̞ ɤ̆ ɥ ɦ ɨ ɪ ɫ ɯ ɯ̟ ɯ̥ ɰ ɱ ɲ ɳ ɴ ɵ ɸ ɹ ɹ̩ ɻ ɻ̩ ɽ ɾ ɾj ɾʲ ɾ̠ ʀ ʁ ʁ̝ "
    "ʂ ʃ ʃʲː ʃ͡ɣ ʈ ʉ̞ ʊ ʋ ʋʲ ʌ ʎ ʏ ʐ ʑ ʒ ʒ͡ɣ ʔ ʝ ː β β̞ θ χ ә ḁ"
).split()

# The symbols measured on a real line that used to bake as a shut mouth.
BUG_SYMBOLS = {
    "ə": "AH", "o": "OW", "ʀ": "R", "ɹ̩": "R", "b̥": "B", "ɒ": "AA", "ɾ": "R",
    "ɾʲ": "R", "ɪ": "IH", "æ": "AE", "d": "D", "l": "L", "m": "M", "f": "F",
    "n": "N", "i": "IY", "h": "HH", "z": "Z", "ɹ": "R", "w": "W", "k": "K",
}


def is_structural(symbol: str, strip: frozenset) -> bool:
    """True for a bare stress/length mark, which is a suprasegmental and not a
    phoneme. It reduces to nothing and is *meant* to fall to silence, so it is
    not a coverage gap."""
    import unicodedata
    return not "".join(ch for ch in symbol
                       if ch not in strip and not unicodedata.combining(ch))


def load(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def studio_args(aligner: str, speech_guard: bool):
    return argparse.Namespace(
        aligner=aligner, style="", smooth=0.0, lag=0,
        no_silence_pass=False, silence_min=0.16,
        speech_guard=speech_guard, python=sys.executable,
    )


def synth_anchors(text: str, duration: float) -> dict:
    """Evenly spaced pseudo word spans, each with a deliberate silent tail.

    This is NOT an alignment. Its only job is to make `protect_speech_spans`
    actually run, so the harness can prove the guard flag is wired up rather
    than silently inert. Pass --anchors <file> for a real Fish alignment.
    """
    words = re.findall(r"[A-Za-z']+", text or "")
    if not words or duration <= 0:
        return {}
    step = (duration * 0.85) / len(words)
    segs = [
        {"text": w, "start": round(i * step, 3), "end": round(i * step + step * 0.75, 3)}
        for i, w in enumerate(words)
    ]
    return {"segments": segs, "audio_duration": round(duration, 3)}


def summarise(cues: list) -> dict:
    return {
        "n": len(cues),
        "values": "".join(str(c.get("value", "?")) for c in cues),
        "first": (cues[0]["start"], cues[0]["end"]) if cues else None,
        "last": (cues[-1]["start"], cues[-1]["end"]) if cues else None,
    }


def diff(a: list, b: list) -> list:
    """Compare two cue lists at the timeline level."""
    problems = []
    if len(a) != len(b):
        problems.append(f"cue count {len(a)} vs {len(b)}")
    for i in range(min(len(a), len(b))):
        va, vb = str(a[i].get("value")), str(b[i].get("value"))
        sa, ea = float(a[i]["start"]), float(a[i]["end"])
        sb, eb = float(b[i]["start"]), float(b[i]["end"])
        if va != vb:
            problems.append(f"cue[{i}] value {va} vs {vb}  @{sa:.3f}-{ea:.3f}")
        elif abs(sa - sb) > 1e-3 or abs(ea - eb) > 1e-3:
            problems.append(f"cue[{i}] {va} timing {sa:.3f}-{ea:.3f} vs {sb:.3f}-{eb:.3f}")
    return problems


def sidecar_problems(sidecar: dict, duration: float) -> list:
    """Is this a track the game's VisemeTrack can load without misbehaving?

    The format contract, checked on the bytes: A-H plus X, sorted, non-
    overlapping, inside the audio, and starting at 0 (a track that begins late
    leaves the head of the line un-animated).
    """
    problems = []
    cues = sidecar.get("mouthCues")
    if not isinstance(cues, list) or not cues:
        return ["no mouthCues"]
    prev_end = None
    for i, c in enumerate(cues):
        v = str(c.get("value", "")).upper()
        try:
            s, e = float(c["start"]), float(c["end"])
        except Exception:
            problems.append(f"cue[{i}] missing/invalid start-end")
            continue
        if v not in "ABCDEFGHX":
            problems.append(f"cue[{i}] value {v!r} is not A-H/X")
        if e <= s:
            problems.append(f"cue[{i}] end {e:.3f} <= start {s:.3f}")
        if s < -1e-6 or e > duration + 1e-3:
            problems.append(f"cue[{i}] {s:.3f}-{e:.3f} outside 0-{duration:.3f}")
        if prev_end is not None and s < prev_end - 1e-3:
            problems.append(f"cue[{i}] starts {s:.3f} before previous end {prev_end:.3f}")
        prev_end = e
    if float(cues[0]["start"]) > 1e-3:
        problems.append(f"track starts at {float(cues[0]['start']):.3f}, not 0")
    return problems


def loud_frames(wav: str, hop: float = 0.02):
    """Times (s) where the recording actually has sound.

    Same energy rule the baker's own silence pass uses, so the reference and the
    thing under test cannot drift apart. Needs numpy; returns None without it.
    """
    import wave
    try:
        import numpy as np
    except Exception:
        return None
    try:
        with wave.open(wav, "rb") as w:
            sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
            if sr <= 0 or n <= 0:
                return None
            d = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32)
    except Exception:
        return None
    if ch > 1:
        d = d.reshape(-1, ch).mean(1)
    d /= 32768.0
    f = max(1, int(sr * hop))
    m = max(1, len(d) // f)
    rms = np.sqrt(np.mean(d[: m * f].reshape(m, f) ** 2, axis=1))
    thr = max(0.006, 0.06 * float(np.percentile(rms, 95)))
    return [i * hop for i in range(m) if rms[i] >= thr]


def shut_over_sound(cues: list, loud: list) -> float:
    """Percentage of loud time the mouth is CLOSED (an X cue, or a gap).

    A gap counts as shut because the game's VisemeTrack::Sample returns X
    outside a cue - so a missing cue and an X cue draw the same face.
    """
    if not loud:
        return 0.0
    def shut(t: float) -> bool:
        for c in cues:
            if c["start"] <= t < c["end"]:
                return str(c["value"]).upper() == "X"
        return True
    return 100.0 * sum(1 for t in loud if shut(t)) / len(loud)


class Report:
    def __init__(self) -> None:
        self.fail = 0

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))
        if not ok:
            self.fail += 1
        return ok


def post_visemes(endpoint: str, wav: str, text: str, aligner: str, anchors: dict | None):
    """POST a WAV to the studio's /api/visemes and return (sidecar, stats).

    Hand-rolled multipart so the harness stays dependency-free (no requests).
    Anchors are sent when present, because that is what the app's bakeInto()
    does — testing the endpoint without them tests a path the app never takes.
    """
    import urllib.request

    boundary = "----viseme_check_boundary"
    with open(wav, "rb") as fh:
        audio = fh.read()

    def field(name: str, value: str) -> bytes:
        return (f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n").encode("utf-8")

    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="wav"; filename="line.wav"\r\n',
        b"Content-Type: audio/wav\r\n\r\n",
        audio,
        b"\r\n",
        field("text", text),
        field("aligner", aligner),
        *([field("anchors", json.dumps(anchors))] if anchors else []),
        f"--{boundary}--\r\n".encode(),
    ])

    req = urllib.request.Request(
        endpoint.rstrip("/") + "/api/visemes", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - a failed probe is a failed check
        print(f"  POST failed: {exc}", file=sys.stderr)
        return None, None
    if payload.get("error"):
        print(f"  server said: {payload['error']}", file=sys.stderr)
        return None, None
    return payload.get("sidecar"), payload.get("stats")


def main() -> int:
    ap = argparse.ArgumentParser(description="Check the studio's viseme baker.")
    ap.add_argument("--wav", default=FIXTURE_WAV,
                    help=f"WAV to bake (default: the tracked fixture)")
    ap.add_argument("--text", default=FIXTURE_TEXT)
    ap.add_argument("--aligner", default="allosaurus")
    ap.add_argument("--anchors", default="",
                    help="Fish alignment JSON (default: the fixture's, if it exists)")
    ap.add_argument("--endpoint", default="",
                    help="running studio, e.g. http://127.0.0.1:8756 — adds the HTTP end-to-end check")
    args = ap.parse_args()

    if not os.path.isfile(args.wav):
        print(f"wav not found: {args.wav}", file=sys.stderr)
        return 2

    anchors_path = args.anchors
    if not anchors_path and args.wav == FIXTURE_WAV and os.path.isfile(FIXTURE_ANCHORS):
        anchors_path = FIXTURE_ANCHORS

    studio = load(STUDIO_TOOL, "studio_visemes")
    real_anchors = None
    if anchors_path:
        try:
            with open(anchors_path, "r", encoding="utf-8") as fh:
                real_anchors = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            print(f"could not read anchors {anchors_path}: {exc}", file=sys.stderr)

    rep = Report()

    with tempfile.TemporaryDirectory(prefix="viseme_check_") as td:
        wav = os.path.join(td, "line.wav")
        shutil.copyfile(args.wav, wav)
        duration = studio.wav_duration(wav)

        def run_studio(guard: bool, use_text: bool, align):
            return studio.bake(wav, args.text if use_text else "", align,
                               studio_args(args.aligner, guard))["mouthCues"]

        print(f"\nwav={os.path.basename(args.wav)}  aligner={args.aligner}  "
              f"duration={duration:.3f}s")
        if real_anchors:
            print(f"anchors={os.path.basename(anchors_path)}  "
                  f"({len(real_anchors.get('segments') or [])} word spans)")
        else:
            print("anchors=none  (transcript-free path)")

        loud = loud_frames(wav)

        # ------------------------------------------------------------------ PART 1
        print("\n================ PART 1 · WELL-FORMED ==============================")
        baked = studio.bake(wav, args.text, real_anchors, studio_args(args.aligner, False))
        cues = baked["mouthCues"]
        s = summarise(cues)
        print(f"  {s['n']} cues  first={s['first']} last={s['last']}")
        print(f"  values: {s['values'][:70]}")
        probs = sidecar_problems(baked, duration)
        rep.check(not probs, "sidecar is a loadable track (A-H/X, sorted, in range)",
                  "clean" if not probs else "; ".join(probs[:4]))
        rep.check(abs(float(baked["metadata"]["duration"]) - duration) < 1e-2,
                  "metadata.duration matches the WAV",
                  f"{baked['metadata']['duration']}s vs {duration:.3f}s")
        rep.check(bool(cues), "the baker produced cues at all",
                  "an empty track means the aligner read the clip as silence")

        # ------------------------------------------------------------------ PART 2
        print("\n================ PART 2 · THE MOUTH MOVES WHERE THERE IS SOUND =====")
        # This is the check that would have caught the IPA->silent-mouth bug.
        # Agreement with another baker cannot catch a shared misunderstanding;
        # the audio is the reference.
        if loud is None:
            print("  skipped — numpy or a readable WAV is required to measure energy")
        else:
            print(f"  {len(loud)} loud frame(s) in {os.path.basename(args.wav)}")
            for label, cl in (("anchored", cues),
                              ("transcript-free", run_studio(False, False, None))):
                pct = shut_over_sound(cl, loud)
                rep.check(pct <= 5.0,
                          f"{label}: mouth shut over <=5% of the loud audio",
                          f"{pct:.1f}% shut — a high number means the aligner's "
                          f"phones are not reaching the viseme table")

        # ------------------------------------------------------------------ PART 3
        print("\n================ PART 3 · ALLOSAURUS PHONES REACH THE TABLE =======")
        # Unit-level, no audio: the exact failure mode from PART 2, isolated.
        strip = studio._IPA_STRIP
        real_en = [s for s in ALLO_ENGLISH if not is_structural(s, strip)]
        bad = [sym for sym in real_en if not studio.normalise_phone(sym)]
        rep.check(not bad, "every Allosaurus English symbol maps to a phoneme",
                  f"{len(real_en)} symbols, clean" if not bad
                  else f"{len(bad)} unmapped: {' '.join(bad[:12])}")
        wrong = {sym: (studio.normalise_phone(sym), want)
                 for sym, want in BUG_SYMBOLS.items()
                 if studio.normalise_phone(sym) != want}
        rep.check(not wrong, "the symbols that used to bake as a shut mouth map correctly",
                  f"{len(BUG_SYMBOLS)} checked, all correct" if not wrong
                  else "; ".join(f"{k}: got {g!r} want {w!r}" for k, (g, w) in wrong.items()))
        real_all = [s for s in ALLO_UNIVERSAL if not is_structural(s, strip)]
        covered = sum(1 for s in real_all if studio.normalise_phone(s))
        print(f"  universal inventory coverage: {covered}/{len(real_all)} "
              f"({100.0 * covered / len(real_all):.0f}%) — reported, not asserted")

        # ------------------------------------------------------------------ PART 4
        print("\n================ PART 4 · THE SPEECH GUARD IS REAL =================")
        # protect_speech_spans needs align_json. Without it the flag is inert —
        # which is exactly the trap this part exists to catch.
        rep.check(diff(run_studio(True, True, None), run_studio(False, True, None)) == [],
                  "guard is inert without anchors (expected — it needs Fish word timings)",
                  "so the guard-off result is the honest default")
        align = real_anchors or synth_anchors(args.text, duration)
        origin = ("real Fish alignment" if real_anchors
                  else "SYNTHETIC anchors (wiring test only)")
        print(f"  anchors: {len(align.get('segments') or [])} spans — {origin}")
        on, off = run_studio(True, True, align), run_studio(False, True, align)
        rep.check(diff(on, off) != [],
                  "guard ON differs from guard OFF once anchors exist",
                  f"{len(on)} vs {len(off)} cues")

        # ------------------------------------------------------------------ PART 5
        if args.endpoint:
            print("\n================ PART 5 · THE SHIPPED HTTP PATH ====================")
            # The server shells out to tools/visemes.py. If it ever starts
            # passing --speech-guard (or drops the silence pass, or stops
            # forwarding the anchors), the module is still fine but the app
            # ships something else. Check the wire.
            sidecar, stats = post_visemes(args.endpoint, wav, args.text,
                                          args.aligner, real_anchors)
            if sidecar is None:
                rep.check(False, "POST /api/visemes returned a sidecar")
            else:
                wire = sidecar.get("mouthCues") or []
                print(f"  /api/visemes: {len(wire)} cues  stats={stats}")
                probs = sidecar_problems(sidecar, duration)
                rep.check(not probs, "/api/visemes output is a loadable track",
                          "clean" if not probs else "; ".join(probs[:4]))
                if loud:
                    pct = shut_over_sound(wire, loud)
                    rep.check(pct <= 5.0,
                              "/api/visemes: mouth shut over <=5% of the loud audio",
                              f"{pct:.1f}% shut")

    print(f"\n===== {rep.fail} failure(s) =====")
    print("VISEMES OK — the mouth follows the audio."
          if rep.fail == 0 else "VISEMES BROKEN — see the failures above.")
    return 1 if rep.fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
