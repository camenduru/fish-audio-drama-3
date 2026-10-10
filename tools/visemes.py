#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bake a Rhubarb-format VISEME sidecar for a Fish Audio Drama 3 line.

This is the bridge between the Fish Audio studio and Wicked Roguelike. The game
loads a mouth-shape timeline from a sidecar next to the recording:

    assets/audio/speech/en/33/33_33000.wav
    assets/audio/speech/en/33/33_33000.visemes.json   <- what this writes

Format (identical to the game's tools/gen_visemes.py and to Rhubarb Lip Sync):

    { "metadata": { "duration": 4.551 },
      "mouthCues": [ { "start": 0.0, "end": 0.16, "value": "B" }, ... ] }

Values are the Hanna-Barbera shapes A-H plus X (idle/closed).

WHY THIS IS BETTER THAN THE GAME'S OWN PIPELINE
-----------------------------------------------
`tools/gen_visemes.py` has to RECOVER word timing - Rhubarb, Whisper, Allosaurus
or a wav2vec2 forced aligner. Fish already knows it: the streaming TTS endpoint
returns per-word start/end alongside the audio. So we pin the aligner to Fish's
exact boundaries and never guess:

  * no ASR (Whisper) - so no mishearing, no re-run-on-disagreement dance
  * no torch / wav2vec2 download
  * the timings already encode the Drama 3 tags: [pause] shows up as a real gap
    between word end and the next word start, so the mouth closes exactly there

The energy silence pass still runs afterwards, because it is the only thing that
catches silence INSIDE a word's span and the tail after the last word.

REQUIRES the system Python (it has openfacefx + numpy); the fish.audio venv does
not, and installing torch there would be absurd. Pass it with --python.

Usage:
    python tools/visemes.py --wav line.wav --text "[calm] Hello there." \\
        --anchors fish_alignment.json -o line.visemes.json

Exit code 0 = baked.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import traceback
import wave

# --------------------------------------------------------------------------- #
# Drama 3 script cleaning
# --------------------------------------------------------------------------- #
# Tags are PERFORMANCE instructions, not spoken words. Feeding them to the
# aligner shifts every phoneme after them, so they come out before alignment.
_DIRECTION_RE = re.compile(r"\[[^\]]*\]")        # [calm], [pause], [laugh]
_PAIRED_RE = re.compile(r"</?[^>|]+>")           # <whisper>, </whisper>, <slower>
_SPEAKER_RE = re.compile(r"<\|speaker:\s*\d+\|>")  # <|speaker:0|>
_TOKEN_RE = re.compile(r"\{[^}]*\}")             # {merchant.luck_charm_cost}


def clean_text(text: str) -> str:
    """Strip every Drama 3 tag so only spoken words remain."""
    out = _SPEAKER_RE.sub(" ", text)
    out = _PAIRED_RE.sub(" ", out)
    out = _DIRECTION_RE.sub(" ", out)
    out = _TOKEN_RE.sub(" ", out)
    return re.sub(r"\s+", " ", out).strip()


# --------------------------------------------------------------------------- #
# WAV handling
# --------------------------------------------------------------------------- #
def wav_info(path: str):
    """(channels, sample_rate, bits, data_offset, data_bytes_declared, data_bytes_real)."""
    with open(path, "rb") as fh:
        raw = fh.read()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    off = 12
    ch = sr = bits = None
    while off + 8 <= len(raw):
        cid = raw[off:off + 4]
        csz = struct.unpack("<I", raw[off + 4:off + 8])[0]
        if cid == b"fmt ":
            fmt = struct.unpack("<HHIIHH", raw[off + 8:off + 8 + 16])
            ch, sr, bits = fmt[1], fmt[2], fmt[5]
        elif cid == b"data":
            real = len(raw) - (off + 8)
            return ch, sr, bits, off + 8, csz, real
        off += 8 + csz + (csz & 1)
    raise ValueError("no data chunk")


def repair_wav(path: str) -> bool:
    """Fix the RIFF/data size fields, returning True when the file changed.

    Fish's streaming endpoint writes a placeholder data size (0xFFFFFC00) into
    the first chunk because the total is unknown when it is emitted. Tools that
    trust the header - openfacefx included - then read a duration of ~48695 s.
    """
    with open(path, "rb") as fh:
        raw = bytearray(fh.read())
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return False
    off = 12
    changed = False
    while off + 8 <= len(raw):
        cid = raw[off:off + 4]
        csz = struct.unpack("<I", raw[off + 4:off + 8])[0]
        if cid == b"data":
            real = len(raw) - (off + 8)
            if csz != real:
                raw[off + 4:off + 8] = struct.pack("<I", real)
                changed = True
            break
        off += 8 + csz + (csz & 1)
    want = len(raw) - 8
    if struct.unpack("<I", raw[4:8])[0] != want:
        raw[4:8] = struct.pack("<I", want)
        changed = True
    if changed:
        with open(path, "wb") as fh:
            fh.write(raw)
    return changed


def wav_duration(path: str) -> float:
    try:
        ch, sr, bits, _o, _d, real = wav_info(path)
    except Exception:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate() or 1)
    if not sr or not ch or not bits:
        return 0.0
    return real / float(sr * ch * (bits // 8))


# --------------------------------------------------------------------------- #
# Anchors
# --------------------------------------------------------------------------- #
def build_anchors(align_json: dict, out_path: str) -> int:
    """Fish alignment -> the `whisper` anchor shape openfacefx reads.

    Fish emits {"segments":[{"text","start","end"}], "audio_duration"}; the
    aligner wants {"segments":[{"words":[{word,start,end}]}]}. Same data, the
    key is renamed - which is why this beats running an ASR to re-derive it.
    """
    words = []
    for seg in align_json.get("segments") or []:
        txt = (seg.get("text") or "").strip()
        if not txt:
            continue
        words.append({
            "word": txt,
            "start": round(float(seg["start"]), 3),
            "end": round(float(seg["end"]), 3),
        })
    if not words:
        return 0
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"segments": [{"words": words}]}, fh)
    return len(words)


# --------------------------------------------------------------------------- #
# Silence pass (same algorithm as the game's tools/gen_visemes.py)
# --------------------------------------------------------------------------- #
def apply_silence_pass(cues: list, wav_path: str, min_silence: float) -> list:
    """Force the mouth CLOSED wherever the recording is actually silent.

    Aligner-agnostic, and the reason [pause] works: the aligner may spread a
    mouth shape across the gap, but the audio energy decides where the silence
    really is, and any cue overlapping it is split and set to X.
    """
    try:
        import numpy as np
    except Exception:
        return cues
    try:
        with wave.open(wav_path, "rb") as w:
            sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
            if sr <= 0 or n <= 0:
                return cues
            d = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32)
    except Exception:
        return cues
    if d.size == 0:
        return cues
    if ch > 1:
        d = d.reshape(-1, ch).mean(1)
    d /= 32768.0

    hop = 0.02
    f = max(1, int(sr * hop))
    m = max(1, len(d) // f)
    if not m:
        return cues
    rms = np.sqrt(np.mean(d[: m * f].reshape(m, f) ** 2, axis=1))
    if rms.size == 0:
        return cues
    # Threshold relative to the loud part, kept LOW so soft consonants are not
    # mistaken for silence (which would close the mouth mid-word).
    thr = max(0.006, 0.06 * float(np.percentile(rms, 95)))

    runs = []
    i = 0
    while i < m:
        if rms[i] < thr:
            j = i
            while j < m and rms[j] < thr:
                j += 1
            if (j - i) * hop >= min_silence:
                runs.append((i * hop, j * hop))
            i = j
        else:
            i += 1
    if not runs:
        return cues

    out = []
    for cue in cues:
        segs = [(float(cue["start"]), float(cue["end"]), str(cue.get("value", "X")))]
        for a, b in runs:
            nxt = []
            for s, e, v in segs:
                if b <= s or a >= e:
                    nxt.append((s, e, v))
                    continue
                if a > s:
                    nxt.append((s, a, v))
                nxt.append((max(a, s), min(b, e), "X"))
                if b < e:
                    nxt.append((b, e, v))
            segs = nxt
        out.extend(segs)
    return [{"start": s, "end": e, "value": v} for s, e, v in out]


def normalise(cues: list, duration: float) -> list:
    """Sort, clamp to the audio, drop empties, and make the timeline contiguous.

    The game's guard (tools/check_viseme_assets.py) FAILS a sidecar whose cues
    are unsorted, non-contiguous, or have end <= start - so this is required,
    not cosmetic. Gaps are filled with X (mouth closed).
    """
    items = []
    for c in cues:
        try:
            s, e = float(c["start"]), float(c["end"])
            v = str(c["value"]).upper()
        except Exception:
            continue
        if v not in "ABCDEFGHX" or len(v) != 1:
            v = "X"
        s = max(0.0, min(s, duration))
        e = max(0.0, min(e, duration))
        if e - s > 1e-4:
            items.append([s, e, v])
    if not items:
        return []
    items.sort(key=lambda t: t[0])

    out = []
    for s, e, v in items:
        if out and s > out[-1][1] + 1e-6:
            out.append([out[-1][1], s, "X"])      # fill the gap with a closed mouth
        if out and abs(out[-1][1] - s) < 1e-6 and out[-1][2] == v:
            out[-1][1] = e                        # merge an identical neighbour
        else:
            out.append([s, e, v])
    if out and out[0][0] > 1e-6:
        out.insert(0, [0.0, out[0][0], "X"])
    if out and out[-1][1] < duration - 1e-3:
        out.append([out[-1][1], duration, "X"])
    # Final sweep: the tail append above can land on a zero-length span, and the
    # game's guard is stricter than "harmless".
    clean = []
    for s, e, v in out:
        s, e = round(min(s, duration), 3), round(min(e, duration), 3)
        if e - s <= 1e-4:
            continue
        # The game only renders a shape held >= min_hold_seconds (0.05), so a
        # sub-30 ms cue is invisible noise - absorb it into the previous shape.
        if e - s < 0.03 and clean:
            clean[-1][1] = e
            continue
        if clean and abs(clean[-1][1] - s) < 1e-6 and clean[-1][2] == v:
            clean[-1][1] = e
        else:
            clean.append([s, e, v])
    return [{"start": s, "end": e, "value": v} for s, e, v in clean]


def speech_gaps(align_json: dict, duration: float, min_gap: float = 0.05) -> list:
    """Spans where NO word is being spoken: before the first, after the last,
    and the gaps between consecutive words (which is where [pause] lands)."""
    words = []
    for seg in (align_json or {}).get("segments") or []:
        try:
            words.append((float(seg["start"]), float(seg["end"])))
        except Exception:
            continue
    if not words:
        return []
    words.sort()
    gaps = []
    if words[0][0] > min_gap:
        gaps.append((0.0, words[0][0]))
    for (a_s, a_e), (b_s, b_e) in zip(words, words[1:]):
        if b_s - a_e > min_gap:
            gaps.append((a_e, b_s))
    if duration - words[-1][1] > min_gap:
        gaps.append((words[-1][1], duration))
    return gaps


def protect_speech_spans(cues: list, align_json: dict, duration: float) -> list:
    """Un-close the mouth where a word is actually being spoken.

    The phone recognizer gates on audio energy, and soft onsets ("The", "No-")
    can fall under the threshold - so it emits X across the start of a word.
    Fish knows exactly when each word is spoken, so an X cue that overlaps no
    real inter-word gap is spurious and gets the neighbouring shape instead.

    This is the one place the Fish timings improve an aligner that never sees
    the text at all.
    """
    gaps = speech_gaps(align_json, duration)
    if not gaps:
        return cues

    def overlaps_gap(s, e):
        for a, b in gaps:
            if min(e, b) - max(s, a) > 0.02:
                return True
        return False

    out = [dict(c) for c in cues]
    last_shape = "B"   # a small open mouth: better than wide open for a soft onset
    for c in out:
        if str(c["value"]).upper() != "X":
            last_shape = c["value"]
            continue
        if overlaps_gap(float(c["start"]), float(c["end"])):
            continue
        c["value"] = last_shape
    return out


# --------------------------------------------------------------------------- #
# Allosaurus: transcript-free phone recognition
# --------------------------------------------------------------------------- #
_ALLO_MODEL = None


def have_allosaurus() -> bool:
    try:
        import allosaurus  # noqa: F401
        return True
    except Exception:
        return False


def allosaurus_phone_file(wav_abs: str, out_path: str, silence_rms: float = 0.03) -> bool:
    """Phone-level timing from the universal recognizer, gated by audio energy.

    Ported from the game's tools/gen_visemes.py. Transcript-free, so it never
    disagrees with the script - it just says what the audio actually sounds
    like. The energy gate is what turns the gaps between phones into real
    silence instead of a closed-mouth flutter.
    """
    global _ALLO_MODEL
    import numpy as np
    from allosaurus.app import read_recognizer

    if _ALLO_MODEL is None:
        _ALLO_MODEL = read_recognizer()
    text = _ALLO_MODEL.recognize(wav_abs, timestamp=True)

    rows = []
    for ln in text.splitlines():
        p = ln.split(None, 2)
        if len(p) >= 3:
            try:
                rows.append((float(p[0]), float(p[1]), p[2]))
            except ValueError:
                continue
    if not rows:
        return False

    with wave.open(wav_abs, "rb") as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        d = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32)
    if ch > 1:
        d = d.reshape(-1, ch).mean(1)
    d /= 32768.0
    hop = 0.02
    f = max(1, int(sr * hop))
    m = max(1, len(d) // f)
    rms = np.sqrt(np.mean(d[: m * f].reshape(m, f) ** 2, axis=1)) if m else np.zeros(1)

    # Threshold relative to the loud part, kept LOW so soft consonants are not
    # mistaken for silence (which would close the mouth mid-word).
    p95 = float(np.percentile(rms, 95)) if m else 0.0
    thr = max(silence_rms * 0.5, 0.06 * p95)

    voiced = rms >= thr
    runs, i = [], 0
    while i < m:
        if voiced[i]:
            j = i
            while j < m and voiced[j]:
                j += 1
            runs.append([i * hop, j * hop])
            i = j
        else:
            i += 1
    # A mouth that closes for < 150 ms between words reads as a stutter, so
    # only longer gaps become silence.
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] < 0.15:
            merged[-1][1] = r[1]
        else:
            merged.append(list(r))

    onsets = [r[0] for r in rows]
    lines = []
    for s, e in merged:
        idx = [k for k, o in enumerate(rows) if s <= o[0] < e]
        if not idx:
            continue
        for n_i, k in enumerate(idx):
            # Cover the run END TO END: the first phone starts at the run start,
            # each next at its own onset, the last ends at the run end. Otherwise
            # the head of every run would be silent.
            t = s if n_i == 0 else max(s, onsets[k])
            end = min(e, onsets[idx[n_i + 1]]) if n_i + 1 < len(idx) else e
            if end > t:
                lines.append(f"{t:.3f} {end:.3f} {rows[k][2]}")
    if not lines:
        return False
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    return True


# --------------------------------------------------------------------------- #
# Baking
# --------------------------------------------------------------------------- #
def run_openfacefx(py: str, wav: str, text: str, anchors: str | None,
                   anchors_mode: str, out: str, style: str | None,
                   smooth: float, lag: int) -> tuple[bool, str]:
    cmd = [py, "-m", "openfacefx", "naive"]
    if text:
        cmd += ["--text", text]
    cmd += ["--wav", wav, "-o", out, "--cue-format", "json-cues"]
    if anchors and anchors_mode == "phones":
        cmd += ["--anchors", anchors, "--anchors-format", "phones",
                "--phones-alphabet", "ipa", "--phones-timing", "start_end"]
    elif anchors:
        cmd += ["--anchors", anchors, "--anchors-format", "whisper"]
    if style:
        cmd += ["--style", style]
    if smooth > 0:
        cmd += ["--smooth", str(smooth)]
    if lag:
        cmd += ["--lag", str(lag)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "openfacefx failed").strip()
    return True, ""


def bake(wav: str, text: str, align_json: dict | None, args) -> dict:
    repaired = repair_wav(wav)
    duration = wav_duration(wav)
    spoken = clean_text(text)

    tmpdir = tempfile.mkdtemp(prefix="viseme_")
    raw_out = os.path.join(tmpdir, "raw.json")

    # Pick the aligner. `auto` prefers Allosaurus (real per-phone timing read off
    # the audio), then the Fish word anchors (exact boundaries, no ASR), then
    # plain text+duration.
    aligner = args.aligner
    if aligner == "auto":
        aligner = "allosaurus" if have_allosaurus() else ("anchors" if align_json else "naive")

    anchors_path, anchors_mode, note = None, "whisper", ""
    n_anchors = 0
    # The Fish word timings are used by BOTH aligners: as the alignment anchors,
    # and (for allosaurus) as the speech-span guard that stops the mouth closing
    # mid-word. Report the count whenever we were given them.
    if align_json:
        n_anchors = len(align_json.get("segments") or [])
    if aligner == "allosaurus":
        phone_file = os.path.join(tmpdir, "phones.txt")
        try:
            if allosaurus_phone_file(wav, phone_file):
                anchors_path, anchors_mode = phone_file, "phones"
            else:
                note = "allosaurus produced no phones; fell back"
                aligner = "anchors" if align_json else "naive"
        except Exception as exc:
            note = f"allosaurus unavailable ({type(exc).__name__}); fell back"
            aligner = "anchors" if align_json else "naive"
    if aligner == "anchors":
        if align_json:
            anchors_path = os.path.join(tmpdir, "anchors.json")
            n_anchors = build_anchors(align_json, anchors_path)
            anchors_mode = "whisper"
            if not n_anchors:
                anchors_path, aligner = None, "naive"
        else:
            aligner = "naive"

    ok, err = run_openfacefx(args.python, wav, spoken, anchors_path, anchors_mode,
                             raw_out, args.style, args.smooth, args.lag)
    if not ok:
        raise RuntimeError(err)

    with open(raw_out, "r", encoding="utf-8") as fh:
        baked = json.load(fh)
    cues = baked.get("mouthCues") or []

    if not args.no_silence_pass:
        cues = apply_silence_pass(cues, wav, args.silence_min)
    if align_json and not args.no_speech_guard:
        cues = protect_speech_spans(cues, align_json, duration)
    cues = normalise(cues, duration)
    if not cues:
        raise RuntimeError("aligner produced no usable cues")

    result = {
        "metadata": {
            "soundFile": os.path.basename(wav),
            "duration": round(duration, 3),
            "generator": "fish-audio-drama3-visemes",
            "aligner": aligner,
            "anchorWords": n_anchors,
            "text": spoken,
            "wavHeaderRepaired": repaired,
        },
        "mouthCues": cues,
    }
    if note:
        result["metadata"]["note"] = note
    try:
        for f in os.listdir(tmpdir):
            os.remove(os.path.join(tmpdir, f))
        os.rmdir(tmpdir)
    except Exception:
        pass
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="Bake a viseme sidecar for a Fish Audio line.")
    ap.add_argument("--wav", required=True)
    ap.add_argument("--text", default="")
    ap.add_argument("--anchors", default="", help="Fish alignment JSON (word timings)")
    ap.add_argument("-o", "--out", default="", help="sidecar path (default: next to the wav)")
    ap.add_argument("--aligner", choices=["auto", "allosaurus", "anchors", "naive"], default="auto")
    ap.add_argument("--style", default="", help="openfacefx style (neutral, whisper, shout, ...)")
    ap.add_argument("--smooth", type=float, default=0.0)
    ap.add_argument("--lag", type=int, default=0)
    ap.add_argument("--no-silence-pass", action="store_true")
    ap.add_argument("--no-speech-guard", action="store_true",
                    help="skip re-opening the mouth inside a word Fish says is spoken")
    ap.add_argument("--silence-min", type=float, default=0.16)
    ap.add_argument("--python", default=sys.executable,
                    help="interpreter that has openfacefx (the system Python)")
    ap.add_argument("--stdout", action="store_true", help="print the sidecar instead of writing it")
    args = ap.parse_args()

    if not os.path.isfile(args.wav):
        print(f"wav not found: {args.wav}", file=sys.stderr)
        return 1

    align = None
    if args.anchors:
        try:
            with open(args.anchors, "r", encoding="utf-8") as fh:
                align = json.load(fh)
        except Exception as exc:
            print(f"could not read anchors ({exc}); falling back to text+duration", file=sys.stderr)

    try:
        payload = bake(args.wav, args.text, align, args)
    except Exception as exc:
        print(f"bake failed: {exc}", file=sys.stderr)
        # The server only forwards the one-line message, so a bare ValueError
        # inside bake() arrives with no context at all. Keep the traceback.
        traceback.print_exc()
        return 1

    if args.stdout:
        json.dump(payload, sys.stdout)
        return 0

    out = args.out or (os.path.splitext(args.wav)[0] + ".visemes.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    m = payload["metadata"]
    print(f"baked {len(payload['mouthCues'])} cues -> {out}")
    print(f"  duration={m['duration']}s aligner={m['aligner']} anchors={m['anchorWords']} "
          f"headerRepaired={m['wavHeaderRepaired']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
