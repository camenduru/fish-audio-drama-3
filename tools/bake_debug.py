"""Throw the real traceback from the viseme baker instead of the one-liner.

The server's /api/visemes reports only `str(exc)`, which is fine in the UI but
useless when something inside bake() blows up. This runs the same code path and
prints the full traceback.

    python tools/bake_debug.py [wav] [text]
"""
import sys, types, traceback, importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "visemes", Path(__file__).with_name("visemes.py"))
v = importlib.util.module_from_spec(spec)
sys.modules["visemes"] = v
spec.loader.exec_module(v)

WAV = sys.argv[1] if len(sys.argv) > 1 else \
    str(Path(__file__).with_name("fixtures") / "speech.wav")
TEXT = sys.argv[2] if len(sys.argv) > 2 else \
    "The old lamp still flickers. Nobody has lit it in years."

class Args:
    aligner = "auto"
    anchors = None
    style = ""
    smooth = 0.0
    lag = 0
    no_silence_pass = False
    no_speech_guard = False
    silence_min = 0.16
    python = r"C:\Users\PC\AppData\Local\Programs\Python\Python313\python.exe"

try:
    out = v.bake(WAV, TEXT, {"segments": []}, Args())
    print("OK", len(out["mouthCues"]), "cues")
except Exception:
    traceback.print_exc()
