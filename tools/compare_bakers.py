#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Does the studio's baker produce the same sidecar as the game's?

The studio has its own tools/visemes.py (it can use Fish's word timings, which
the game's pipeline has to recover with an ASR). That is the point of it - but it
must still emit a track the game's VisemeTrack reads *identically*, or the
preview lies about what ships.

This runs both bakers over the same WAV with the same aligner and diffs the
resulting cue timelines. Run it after touching either side.

Two parts, and both matter:

  PART 1  PARITY      game vs studio, speech guard OFF - the default path on
                      both sides. This is the shipping claim and it must be
                      byte-identical. Exits non-zero if it is not.

  PART 2  GUARD       with Fish anchors present, guard ON must actually change
                      the output. `protect_speech_spans` needs align_json, so
                      without anchors the flag is INERT and a naive harness
                      would report a meaningless "identical" for guard=on.
                      PART 2 fails loudly if the flag has gone dead.

  PART 3  HTTP        with --endpoint, POST the same WAV to the running studio's
                      /api/visemes and diff THAT against the game's. Parts 1-2
                      prove the two modules agree; this proves the flags the
                      server actually passes are the parity-preserving ones.

Every sidecar either baker emits is also run through the game's own
tools/check_viseme_assets.py::check_sidecar, so "the game will load this" is
checked and not assumed.

Usage:
    python tools/compare_bakers.py                       # a game WAV, allosaurus
    python tools/compare_bakers.py --wav x.wav --text "Hello there."
    python tools/compare_bakers.py --anchors fish_alignment.json
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

GAME_ROOT = r"C:\Users\PC\Documents\content\wicked\RoguelikeGame"
GAME_TOOL = os.path.join(GAME_ROOT, "tools", "gen_visemes.py")
GAME_CHECK = os.path.join(GAME_ROOT, "tools", "check_viseme_assets.py")
STUDIO_TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "visemes.py")
DEFAULT_WAV = os.path.join(GAME_ROOT, "assets", "audio", "speech", "en", "33", "33_33000.wav")


def load(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def game_args():
    return argparse.Namespace(
        dry_run=False, smooth=0.0, lag=0, no_silence_pass=False,
        silence_min=0.16, rhubarb="", rhubarb_max_hold=0.6, lang="en",
    )


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


class Report:
    def __init__(self) -> None:
        self.fail = 0

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))
        if not ok:
            self.fail += 1
        return ok


def post_visemes(endpoint: str, wav: str, text: str, aligner: str):
    """POST a WAV to the studio's /api/visemes and return its mouthCues.

    Hand-rolled multipart so the harness stays dependency-free (no requests).
    """
    import urllib.error
    import urllib.request

    boundary = "----baker_cmp_boundary"
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
        return None
    if payload.get("error"):
        print(f"  server said: {payload['error']}", file=sys.stderr)
        return None
    return (payload.get("sidecar") or {}).get("mouthCues")


def main() -> int:
    ap = argparse.ArgumentParser(description="Compare the studio and game viseme bakers.")
    ap.add_argument("--wav", default=DEFAULT_WAV)
    ap.add_argument("--text", default="The old lamp still flickers. Nobody has lit it in years.")
    ap.add_argument("--aligner", default="allosaurus")
    ap.add_argument("--anchors", default="", help="real Fish alignment JSON (else synthetic ones)")
    ap.add_argument("--endpoint", default="",
                    help="running studio, e.g. http://127.0.0.1:8756 — adds the HTTP end-to-end check")
    args = ap.parse_args()

    for path, what in ((args.wav, "wav"), (GAME_TOOL, "game tool"), (GAME_CHECK, "game checker")):
        if not os.path.isfile(path):
            print(f"{what} not found: {path}", file=sys.stderr)
            return 2

    game = load(GAME_TOOL, "game_gen_visemes")
    studio = load(STUDIO_TOOL, "studio_visemes")
    checker = load(GAME_CHECK, "game_check_viseme_assets")

    real_anchors = None
    if args.anchors:
        with open(args.anchors, "r", encoding="utf-8") as fh:
            real_anchors = json.load(fh)

    rep = Report()

    with tempfile.TemporaryDirectory(prefix="baker_cmp_") as td:
        wav = os.path.join(td, "line.wav")
        shutil.copyfile(args.wav, wav)
        duration = studio.wav_duration(wav)

        def run_game():
            """The game's baker, transcript-free, exactly as gen_visemes ships."""
            out = os.path.join(td, "line.visemes.json")
            g_args = game_args()
            g_args.aligner = args.aligner
            line = {"audio": "line.wav", "text": args.text}
            result = game.bake(td, line, args.aligner, None, g_args)
            if result != "baked":
                print(f"  note: game baker returned {result!r}")
            cues = json.load(open(out, encoding="utf-8")).get("mouthCues", []) if os.path.isfile(out) else []
            if os.path.isfile(out):
                os.remove(out)
            return cues

        def run_studio(guard: bool, use_text: bool, align):
            payload = studio.bake(wav, args.text if use_text else "", align,
                                  studio_args(args.aligner, guard))
            return payload["mouthCues"]

        def game_accepts(cues, label):
            """Would the game's own asset guard load this sidecar?"""
            path = os.path.join(td, "probe.visemes.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"metadata": {"duration": round(duration, 3)}, "mouthCues": cues}, fh)
            problems = checker.check_sidecar(path)
            rep.check(not problems, f"{label}: the game's check_viseme_assets accepts it",
                      "clean" if not problems else "; ".join(problems[:3]))

        # ---------------------------------------------------------------- PART 1
        print("\n================ PART 1 · PARITY (the shipping claim) ================")
        print(f"wav={os.path.basename(args.wav)}  aligner={args.aligner}  duration={duration:.3f}s\n")
        g_cues = run_game()
        gs = summarise(g_cues)
        print(f"  game (transcript-free): {gs['n']} cues  first={gs['first']} last={gs['last']}")
        print(f"    values: {gs['values'][:70]}")
        if not g_cues:
            print("  the game baker produced nothing — cannot compare", file=sys.stderr)
            return 2
        game_accepts(g_cues, "game output")

        for use_text in (True, False):
            s_cues = run_studio(False, use_text, None)
            ss = summarise(s_cues)
            label = "studio, with --text" if use_text else "studio, transcript-free"
            print(f"\n  {label}: {ss['n']} cues  first={ss['first']} last={ss['last']}")
            print(f"    values: {ss['values'][:70]}")
            problems = diff(g_cues, s_cues)
            rep.check(not problems, f"{label} == game cue timeline",
                      "identical" if not problems else "; ".join(problems[:4]))
            game_accepts(s_cues, label)

        # ---------------------------------------------------------------- PART 2
        print("\n================ PART 2 · THE SPEECH GUARD IS REAL ==================")
        # protect_speech_spans needs align_json. Without it the flag is inert —
        # which is exactly the trap this part exists to catch.
        inert = run_studio(True, True, None)
        rep.check(diff(inert, run_studio(False, True, None)) == [],
                  "guard is inert without anchors (expected — it needs Fish word timings)",
                  "so PART 1's guard-off result is the honest default")

        align = real_anchors or synth_anchors(args.text, duration)
        origin = "real Fish alignment" if real_anchors else "SYNTHETIC anchors (wiring test only)"
        print(f"  anchors: {len(align.get('segments') or [])} spans — {origin}")
        on = run_studio(True, True, align)
        off = run_studio(False, True, align)
        rep.check(diff(on, off) != [],
                  "guard ON differs from guard OFF once anchors exist",
                  f"{len(on)} vs {len(off)} cues")
        game_accepts(on, "guarded output")

        # ---------------------------------------------------------------- PART 3
        if args.endpoint:
            print("\n================ PART 3 · THE SHIPPED HTTP PATH =====================")
            # The server shells out to tools/visemes.py. If it ever starts
            # passing --speech-guard (or drops the silence pass), the module is
            # still identical but the app ships something else. Check the wire.
            cues = post_visemes(args.endpoint, args.wav, args.text, args.aligner)
            if cues is None:
                rep.check(False, "POST /api/visemes returned a sidecar")
            else:
                print(f"  /api/visemes: {len(cues)} cues")
                problems = diff(g_cues, cues)
                rep.check(not problems, "/api/visemes == game cue timeline",
                          "identical" if not problems else "; ".join(problems[:4]))
                game_accepts(cues, "/api/visemes output")

    print(f"\n===== {rep.fail} failure(s) =====")
    print("PARITY HOLDS — the studio's default sidecar is the game's sidecar."
          if rep.fail == 0 else "PARITY BROKEN — the preview would lie about what ships.")
    return 1 if rep.fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
