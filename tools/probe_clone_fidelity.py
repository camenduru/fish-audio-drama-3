"""Which TTS model actually reproduces a reference voice?

The question this answers: "the preview for my voice doesn't sound like my
voice". The studio's ▶ sends `reference_id` and no `__model`, so it falls back to
the server's `DEFAULT_MODEL` (`drama-3-preview`). The studio page, by contrast,
lets you pick from five models. If `drama-3-preview` does not reproduce a
reference faithfully, every preview in the app is wrong for the same reason.

It cannot be answered by ear here, and it cannot be answered by comparing
syntheses *to each other* — they will all differ, and differing is not the same
as being wrong. So it is measured against ground truth:

  1. Pick a PUBLIC voice that ships a real `samples[0].audio`. That recording is
     the reference performance — the thing a clone should sound like.
  2. Synthesize that sample's own transcript through that voice's `reference_id`,
     once per model.
  3. Compare each synthesis to the recording on two speaker-identity proxies:
     * timbre  — the mean log-mel spectrum (a 40-dim vector), cosine distance
     * pitch   — median F0 in Hz, from autocorrelation
     Both are robust to the small timing differences between takes, and neither
     depends on the text being re-synthesized at exactly the same speed.

A model whose output sits far from the recording on BOTH axes is not reproducing
the speaker. The nearest one is the best clone.

Costs a little API credit (one short line per model). Nothing is written to the
account.

Usage:
    python tools/probe_clone_fidelity.py [base] [--voice <id>] [--text "..."]
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:8756"
MODELS = ["drama-3-preview", "s2.1-pro", "s2-pro", "s2.1-pro-free", "s1"]
SR = 16000


# --------------------------------------------------------------------------- HTTP
def password() -> str:
    if os.environ.get("APP_PASSWORD"):
        return os.environ["APP_PASSWORD"]
    try:
        m = re.search(r"^\s*APP_PASSWORD\s*=\s*(.*)$", (ROOT / ".env").read_text(), re.M)
        return m.group(1).strip().strip("\"'") if m else ""
    except OSError:
        return ""


COOKIE = ""


def _req(url: str, data: bytes | None = None, ctype: str | None = None) -> bytes:
    r = urllib.request.Request(url, data=data)
    if COOKIE:
        r.add_header("Cookie", COOKIE)
    if ctype:
        r.add_header("Content-Type", ctype)
    with urllib.request.urlopen(r, timeout=180) as resp:
        return resp.read()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """The login answers 303 + Set-Cookie. Following it discards both."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def sign_in() -> None:
    global COOKIE
    pw = password()
    if not pw:
        return
    body = urllib.parse.urlencode({"password": pw}).encode()
    r = urllib.request.Request(BASE + "/api/login", data=body)
    r.add_header("Content-Type", "application/x-www-form-urlencoded")
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        resp = opener.open(r, timeout=60)
    except urllib.error.HTTPError as e:      # a 3xx is raised once we refuse to follow
        resp = e
    raw = resp.headers.get("set-cookie") or ""
    COOKIE = raw.split(";")[0]
    if not COOKIE:
        sys.exit(f"could not sign in (status {getattr(resp, 'status', getattr(resp, 'code', '?'))}) "
                 "— check APP_PASSWORD in .env")


def api(path: str) -> dict:
    return json.loads(_req(BASE + "/api/fish" + path))


def tts(text: str, ref: str, model: str, fmt: str = "wav") -> bytes:
    payload = {"text": text, "format": fmt}
    if ref:
        # An empty string is rejected (400): "no reference" means the key is absent.
        payload["reference_id"] = ref
    body = json.dumps(payload).encode()
    r = urllib.request.Request(BASE + "/api/tts", data=body)
    r.add_header("Content-Type", "application/json")
    r.add_header("x-fish-model", model)
    if COOKIE:
        r.add_header("Cookie", COOKIE)
    with urllib.request.urlopen(r, timeout=300) as resp:
        return resp.read()


# --------------------------------------------------------------------------- audio
def decode(raw: bytes, name: str = "x") -> np.ndarray:
    """Anything ffmpeg can read → mono float32 at SR."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", str(SR), "pipe:1"],
        input=raw, capture_output=True, check=True,
    )
    return np.frombuffer(out.stdout, dtype=np.float32)


def trim(x: np.ndarray, thr: float = 0.01) -> np.ndarray:
    """Drop leading/trailing silence so durations are comparable."""
    if x.size == 0:
        return x
    env = np.abs(x)
    idx = np.where(env > thr * env.max())[0]
    return x[idx[0]: idx[-1] + 1] if idx.size else x


def mel_filterbank(n_mels: int = 40, n_fft: int = 512) -> np.ndarray:
    def hz2mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel2hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    pts = mel2hz(np.linspace(hz2mel(50), hz2mel(SR / 2), n_mels + 2))
    bins = np.floor((n_fft + 1) * pts / SR).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for i in range(n_mels):
        a, b, c = bins[i], bins[i + 1], bins[i + 2]
        if b == a:
            b = a + 1
        if c == b:
            c = b + 1
        fb[i, a:b] = np.linspace(0, 1, b - a, endpoint=False)
        fb[i, b:c] = np.linspace(1, 0, c - b, endpoint=False)
    return fb


FB = mel_filterbank()


def logmel(x: np.ndarray, win: int = 400, hop: int = 160) -> np.ndarray:
    """Mean log-mel spectrum: a compact, text-robust timbre fingerprint."""
    if x.size < win:
        x = np.pad(x, (0, win - x.size))
    frames = 1 + (x.size - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(frames)[:, None]
    fr = x[idx] * np.hanning(win)[None, :]
    spec = np.abs(np.fft.rfft(fr, n=512, axis=1)) ** 2
    mel = np.log(spec @ FB.T + 1e-8)
    return mel.mean(axis=0)


def cos_dist(a: np.ndarray, b: np.ndarray) -> float:
    return float(1.0 - (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


def f0_track(x: np.ndarray, fmin: int = 70, fmax: int = 400,
             win: int = 1024, hop: int = 256) -> np.ndarray:
    """Autocorrelation F0 per frame; 0 where the frame is unvoiced."""
    lo, hi = SR // fmax, SR // fmin
    out = []
    for s in range(0, max(1, x.size - win), hop):
        fr = x[s:s + win]
        if fr.size < win:
            break
        fr = fr - fr.mean()
        if np.sqrt((fr ** 2).mean()) < 0.01:
            out.append(0.0)
            continue
        ac = np.correlate(fr, fr, mode="full")[win - 1:]
        seg = ac[lo:hi]
        if seg.size == 0:
            out.append(0.0)
            continue
        peak = int(np.argmax(seg)) + lo
        # Reject a weak, non-periodic frame rather than reporting noise as pitch.
        out.append(float(SR / peak) if ac[peak] > 0.3 * ac[0] else 0.0)
    return np.array(out)


def f0_stats(x: np.ndarray) -> tuple[float, float]:
    t = f0_track(x)
    v = t[t > 0]
    if v.size < 5:
        return 0.0, 0.0
    return float(np.median(v)), float(np.percentile(v, 75) - np.percentile(v, 25))


# --------------------------------------------------------------------------- main
def run_one(voice_id: str, text: str, gt_url: str | None) -> dict:
    """Synthesize one reference voice through every model; return the distances."""
    gt = None
    if gt_url:
        try:
            gt = trim(decode(_req(gt_url)))
        except Exception:  # noqa: BLE001
            gt = None
    gt_mel = logmel(gt) if gt is not None else None
    gt_f0 = f0_stats(gt)[0] if gt is not None else 0.0

    out = {"gt_seconds": (gt.size / SR) if gt is not None else None,
           "gt_f0": gt_f0, "models": {}}
    for model in MODELS:
        try:
            x = trim(decode(tts(text, voice_id, model)))
        except Exception as e:  # noqa: BLE001
            out["models"][model] = {"error": str(e)}
            continue
        f0, iqr = f0_stats(x)
        out["models"][model] = {
            "seconds": x.size / SR,
            "timbre": cos_dist(logmel(x), gt_mel) if gt_mel is not None else None,
            "f0": f0, "iqr": iqr,
            "pitch_off": abs(f0 - gt_f0) if gt_f0 and f0 else None,
        }
    return out


def contrast() -> int:
    """Is a reference voice actually DISTINCT from the no-reference default?

    This is the direct test of "did you use generic audio?". Byte-inequality
    proves nothing — two clips of the same sentence always differ in bytes. What
    matters is whether the reference moves the audio *away* from the default
    voice by a perceptually meaningful margin.

    A well-cloned public voice is the yardstick: if it sits far from the default
    and one of your own voices sits close to it, that voice's clone is weak and
    the audio really does sound generic — not because the wrong request was sent,
    but because the clone barely took.
    """
    print("contrast: each voice's output vs the SAME text with no reference_id")
    print("metric  : cosine distance on the mean log-mel spectrum (higher = more distinct)\n")

    own = api("/model?self=true&page_size=20").get("items", [])
    pub_page = api("/model?page_size=40&sort_by=task_count").get("items", [])
    pub = [m for m in pub_page if (m.get("samples") or [None])[0]][:3]

    text = "The quick brown fox jumps over the lazy dog."
    print(f'text: "{text}"\n')

    base_mel = None
    for model in ("drama-3-preview",):
        try:
            base_mel = logmel(trim(decode(tts(text, "", model))))
        except Exception as e:  # noqa: BLE001
            print(f"no-reference synthesis failed: {e}")
            return 1

    def report(label: str, m: dict) -> None:
        vid = m["_id"]
        try:
            x = trim(decode(tts(text, vid, "drama-3-preview")))
        except Exception as e:  # noqa: BLE001
            print(f"{label:<28} FAILED — {e}")
            return
        d = cos_dist(logmel(x), base_mel)
        f0, _ = f0_stats(x)
        print(f"{label:<28} {x.size / SR:5.2f}s  distinctness {d:.3f}  F0 {f0:6.1f}Hz")

    print("— reference voices with a known-good clone (the yardstick) —")
    for m in pub:
        report((m.get("title") or "?")[:27], m)
    print("\n— your own voices —")
    if not own:
        print("(none)")
    for m in own:
        note = "" if (m.get("samples") or [None])[0] else "  [no samples[]]"
        report((m.get("title") or "?")[:27] + note, m)

    print("\nA voice whose distinctness is far below the yardstick is a weak clone:")
    print("its output stays close to the default voice, which is what 'generic' sounds like.")
    return 0


def main() -> int:
    args = sys.argv[1:]
    base = next((a for a in args if a.startswith("http")), BASE)
    globals()["BASE"] = base
    want = int(args[args.index("--voices") + 1]) if "--voices" in args else 3

    sign_in()

    if "--vs-default" in args:
        return contrast()

    page = api("/model?page_size=60&sort_by=task_count")
    picks = []
    for m in page.get("items", []):
        s = (m.get("samples") or [None])[0]
        if s and s.get("audio") and 40 <= len(s.get("text") or "") <= 140:
            picks.append((m, s))
        if len(picks) >= want:
            break
    if not picks:
        sys.exit("no public voice with a usable sample found")

    print(f"models   : {', '.join(MODELS)}")
    print(f"reference: {len(picks)} public voices, each compared to its own recording")
    print("metric   : cosine distance on the mean log-mel spectrum (lower = closer)\n")

    # model -> [timbre distances], [pitch errors]
    agg: dict[str, list[float]] = {m: [] for m in MODELS}
    pitch: dict[str, list[float]] = {m: [] for m in MODELS}

    for m, s in picks:
        text = s["text"]
        print(f"── {m.get('title')}  ({m['_id']})")
        r = run_one(m["_id"], text, s["audio"])
        gt_note = f"{r['gt_seconds']:.2f}s / F0 {r['gt_f0']:.0f}Hz" if r["gt_seconds"] else "no recording"
        print(f"   recording: {gt_note}")
        for model in MODELS:
            d = r["models"][model]
            if "error" in d:
                print(f"   {model:<18} FAILED — {d['error']}")
                continue
            if d["timbre"] is not None:
                agg[model].append(d["timbre"])
            if d["pitch_off"] is not None:
                pitch[model].append(d["pitch_off"])
            t = f"{d['timbre']:.3f}" if d["timbre"] is not None else "  —  "
            print(f"   {model:<18} {d['seconds']:5.2f}s  timbre {t}  F0 {d['f0']:6.1f}Hz")
        print()

    print("=" * 66)
    print("mean timbre distance to the reference recording (lower = closer)\n")
    ranked = sorted(MODELS, key=lambda m: np.mean(agg[m]) if agg[m] else 9e9)
    for i, model in enumerate(ranked, 1):
        if not agg[model]:
            print(f"  {i}. {model:<18} no data")
            continue
        spread = f"±{np.std(agg[model]):.3f}" if len(agg[model]) > 1 else ""
        print(f"  {i}. {model:<18} {np.mean(agg[model]):.3f} {spread}   (n={len(agg[model])})")

    print("\nmean median-pitch error vs the recording (lower = closer)\n")
    for i, model in enumerate(sorted([m for m in MODELS if pitch[m]],
                                     key=lambda m: np.mean(pitch[m])), 1):
        print(f"  {i}. {model:<18} {np.mean(pitch[model]):6.1f} Hz")

    default = "drama-3-preview"
    if agg[default] and len(ranked) > 1:
        print(f"\n{default} — what every ▶ preview currently uses — ranks "
              f"{ranked.index(default) + 1} of {len(ranked)} on timbre.")
        print(f"the closest model is {ranked[0]}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
