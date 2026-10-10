"""
Fish Audio Drama 3 Studio — backend.

A thin, secure, server-side proxy in front of https://api.fish.audio so the
API key never reaches the browser. Covers the whole published API surface:

  * generic authenticated passthrough for every /v1/* endpoint (39 paths)
  * a dedicated /api/tts route that also speaks MessagePack (zero-shot cloning)
  * streaming TTS with word-level timestamps
  * voice design, model/voice library, agent session tokens, phone calls

Run:  python -m uvicorn server.main:app --host 127.0.0.1 --port 8756
"""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx
import msgpack
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
ENV_FILE = ROOT / ".env"

# True when running inside a serverless function (Vercel sets VERCEL=1).
# Several things below behave differently because a function has a read-only
# filesystem, a duration ceiling, and no access to this machine's folders.
IS_SERVERLESS = bool(os.environ.get("VERCEL"))

# Vercel rejects a request body over 4.5 MB before the app ever sees it, so the
# UI is told the working limit and can explain itself instead of surfacing a
# bare 413. Locally there is no such cap (0 = unlimited).
MAX_UPLOAD_BYTES = int(os.environ.get(
    "MAX_UPLOAD_BYTES", "4400000" if IS_SERVERLESS else "0"))

API_BASE = os.environ.get("FISH_API_BASE", "https://api.fish.audio")
APP_VERSION = "1.0.0"


def _writable_dir(candidates: list[Path]) -> tuple[Path, bool]:
    """The first candidate we can actually write to, and whether it is the
    project's own data/ rather than a rented temporary.

    A serverless bundle is read-only: only /tmp is writable, and it is thrown
    away with the instance. So the studio has to *find* somewhere to keep takes
    instead of assuming it may create data/ beside its own code — that mkdir is
    exactly what would fail a cold start.
    """
    for path in candidates:
        try:
            path.mkdir(parents=True, exist_ok=True)
            probe = path / ".writable"
            probe.write_text("", encoding="utf-8")
            probe.unlink()
            return path, path == candidates[0]
        except OSError:
            continue
    return candidates[-1], False


DATA_DIR, DATA_DIR_PERSISTENT = _writable_dir([
    Path(os.environ["STUDIO_DATA_DIR"]) if os.environ.get("STUDIO_DATA_DIR")
    else ROOT / "data",
    Path(tempfile.gettempdir()) / "fish-studio" / "data",
])

# The model every generation path uses unless the caller says otherwise.
# NOTE: Fish silently falls back to `s2.1-pro` for an omitted *or unrecognized*
# model, so a typo here fails quietly rather than erroring.
DEFAULT_MODEL = "drama-3-preview"

# Headers we are happy to forward upstream / downstream.
_FORWARD_REQ_HEADERS = {
    "content-type",
    "accept",
    "traceparent",
    "model",
    "x-fish-model",
}
_FORWARD_RESP_HEADERS = {
    "content-type",
    "content-disposition",
    "cache-control",
    "x-request-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
}


# --------------------------------------------------------------------------- #
# API key handling
# --------------------------------------------------------------------------- #
def _read_env_file() -> dict[str, str]:
    out: dict[str, str] = {}
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def get_api_key() -> str:
    """Env var wins, then .env file."""
    return os.environ.get("FISH_API_KEY") or _read_env_file().get("FISH_API_KEY", "")


def key_source() -> str:
    """Where the key came from: env, file, or nowhere."""
    if os.environ.get("FISH_API_KEY"):
        return "env"
    if _read_env_file().get("FISH_API_KEY"):
        return "file"
    return "none"


def set_api_key(key: str) -> bool:
    """Use the key now, and save it to .env when there is a writable one.

    Returns whether it reached disk. A deployed function has no writable
    project directory, so there the key can only come from the environment —
    saying so beats a traceback in the Settings panel.
    """
    os.environ["FISH_API_KEY"] = key
    lines = []
    found = False
    try:
        if ENV_FILE.exists():
            for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
                if raw.strip().startswith("FISH_API_KEY"):
                    lines.append(f"FISH_API_KEY={key}")
                    found = True
                else:
                    lines.append(raw)
        if not found:
            lines.append(f"FISH_API_KEY={key}")
        ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return True
    except OSError:
        return False


def _auth_headers() -> dict[str, str]:
    key = get_api_key()
    if not key:
        raise HTTPException_ish(401, "No FISH_API_KEY configured. Set it in .env or via the Settings panel.")
    return {"Authorization": f"Bearer {key}"}


class HTTPException_ish(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
app = FastAPI(title="Fish Audio Drama 3 Studio", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Long timeout: long-form TTS can take a while.
_CLIENT_TIMEOUT = httpx.Timeout(float(os.environ.get("FISH_TIMEOUT", "600")), connect=30.0)

# One client per event loop. A function instance is reused across invocations,
# and an AsyncClient's connection pool belongs to the loop it first ran on, so a
# single module-level client would hand a later invocation a pool owned by a
# loop that has since closed. The shim keeps every call site unchanged.
_clients: dict[int, httpx.AsyncClient] = {}


class _LoopBoundClient:
    """Delegates attribute access to a client belonging to the running loop."""

    def __getattr__(self, name: str) -> Any:
        try:
            loop_id = id(asyncio.get_running_loop())
        except RuntimeError:
            loop_id = 0
        client = _clients.get(loop_id)
        if client is None or client.is_closed:
            client = httpx.AsyncClient(timeout=_CLIENT_TIMEOUT)
            _clients[loop_id] = client
        return getattr(client, name)


_client = _LoopBoundClient()


@app.on_event("shutdown")
async def _shutdown() -> None:
    for client in list(_clients.values()):
        await client.aclose()
    _clients.clear()


@app.exception_handler(HTTPException_ish)
async def _ish_handler(_req: Request, exc: HTTPException_ish) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"status": exc.status, "message": exc.message})


# --------------------------------------------------------------------------- #
# Status / settings
# --------------------------------------------------------------------------- #
def _has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def baker_status() -> dict[str, Any]:
    """Whether a viseme bake can run here, and on what.

    Allosaurus is optional: it needs torch, which is far past a Python bundle
    limit, so a deployment bakes with the Fish word-timing aligner instead. The
    baker script downgrades by itself when the import is missing.

    Only the interpreter running this process can be introspected here. When the
    baker is a *different* interpreter those two probes are null rather than
    false — locally the system Python has openfacefx while the studio venv does
    not, so reporting false would be plain wrong.
    """
    in_process = os.path.realpath(VISEME_PYTHON) == os.path.realpath(sys.executable)
    return {
        "python": VISEME_PYTHON,
        "python_exists": Path(VISEME_PYTHON).exists(),
        "script_exists": VISEME_SCRIPT.exists(),
        "allosaurus": _has_module("allosaurus") if in_process else None,
        "openfacefx": _has_module("openfacefx") if in_process else None,
        "probe": "in-process" if in_process else "external",
        "timeout": VISEME_TIMEOUT,
    }


@app.get("/api/status")
async def status() -> dict[str, Any]:
    key = get_api_key()
    return {
        "ok": True,
        "version": APP_VERSION,
        "api_base": API_BASE,
        "key_configured": bool(key),
        "key_hint": (key[:10] + "..." + key[-4:]) if len(key) > 16 else ("set" if key else ""),
        # Where the key lives, so Setup can say "set FISH_API_KEY in your host's
        # environment" instead of offering a save that silently cannot work.
        "key_source": key_source(),
        "hosted": IS_SERVERLESS,
        "data_dir": str(DATA_DIR),
        "data_dir_persistent": DATA_DIR_PERSISTENT,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "baker": baker_status(),
    }


@app.get("/api/settings")
async def get_settings() -> dict[str, Any]:
    return {
        "api_base": API_BASE,
        "key_configured": bool(get_api_key()),
        "key_source": key_source(),
    }


@app.post("/api/settings")
async def post_settings(payload: dict[str, Any]) -> dict[str, Any]:
    persisted = None
    if payload.get("api_key"):
        persisted = set_api_key(str(payload["api_key"]).strip())
    return {
        "ok": True,
        "key_configured": bool(get_api_key()),
        "key_persisted": persisted,
        "key_source": key_source(),
    }


# --------------------------------------------------------------------------- #
# Generic authenticated passthrough
# --------------------------------------------------------------------------- #
@app.api_route(
    "/api/fish/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
)
async def fish_proxy(path: str, request: Request) -> Response:
    url = f"{API_BASE}/{path}"
    body = await request.body()

    headers = {"Authorization": _auth_headers()["Authorization"]}
    for k, v in request.headers.items():
        if k.lower() in _FORWARD_REQ_HEADERS:
            if k.lower() == "x-fish-model":
                headers["model"] = v
            else:
                headers[k] = v

    # A raw /v1/tts call that forgets the model header would silently get
    # s2.1-pro upstream. Keep the studio's default on this path too.
    if path.startswith("v1/tts") and "model" not in headers:
        headers["model"] = DEFAULT_MODEL

    upstream = await _client.request(
        request.method,
        url,
        params=dict(request.query_params),
        content=body if body else None,
        headers=headers,
    )
    resp_headers = {
        k: v for k, v in upstream.headers.items() if k.lower() in _FORWARD_RESP_HEADERS
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type"),
    )


# --------------------------------------------------------------------------- #
# TTS — JSON and MessagePack (zero-shot cloning)
# --------------------------------------------------------------------------- #
def _strip_internal(payload: dict[str, Any]) -> dict[str, Any]:
    """Remove UI-only keys before sending upstream."""
    payload.pop("__model", None)
    return payload


@app.post("/api/tts")
async def tts(request: Request) -> Response:
    payload = await request.json()
    model = payload.get("__model") or request.headers.get("x-fish-model") or DEFAULT_MODEL
    body = json.dumps(_strip_internal(payload)).encode("utf-8")
    headers = {
        "Authorization": _auth_headers()["Authorization"],
        "Content-Type": "application/json",
        "model": model,
    }
    upstream = await _client.post(f"{API_BASE}/v1/tts", content=body, headers=headers)
    resp_headers = {
        k: v for k, v in upstream.headers.items() if k.lower() in _FORWARD_RESP_HEADERS
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type"),
    )


@app.post("/api/tts/with-references")
async def tts_with_references(request: Request) -> Response:
    """
    Zero-shot cloning. multipart/form-data:
      payload   : JSON string of the TTSRequest (minus references)
      ref_files : repeated uploads, ordered; speaker groups via ref_group_<i> index list
      ref_texts : JSON string list of transcripts, parallel to ref_files
      speakers  : JSON string list of ints, the speaker index each ref belongs to
    The request body is encoded as MessagePack, which the inline `references`
    field requires.
    """
    form = await request.form()
    payload = json.loads(form.get("payload") or "{}")
    model = payload.get("__model") or DEFAULT_MODEL
    ref_texts = json.loads(form.get("ref_texts") or "[]")
    speakers = json.loads(form.get("speakers") or "[]")
    files = form.getlist("ref_files")

    body = _strip_internal(payload)
    if files:
        groups: dict[int, list[dict[str, Any]]] = {}
        for i, f in enumerate(files):
            if not isinstance(f, UploadFile):
                continue
            data = await f.read()
            spk = speakers[i] if i < len(speakers) else 0
            txt = ref_texts[i] if i < len(ref_texts) else ""
            groups.setdefault(spk, []).append({"audio": data, "text": txt})
        ordered = [groups[k] for k in sorted(groups)]
        if len(ordered) == 1:
            body["references"] = ordered[0]
        else:
            body["references"] = ordered
            body.setdefault("reference_id", [f"speaker-{k}" for k in sorted(groups)])

    packed = msgpack.packb(body, use_bin_type=True)
    headers = {
        "Authorization": _auth_headers()["Authorization"],
        "Content-Type": "application/msgpack",
        "model": model,
    }
    upstream = await _client.post(f"{API_BASE}/v1/tts", content=packed, headers=headers)
    resp_headers = {
        k: v for k, v in upstream.headers.items() if k.lower() in _FORWARD_RESP_HEADERS
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type"),
    )


@app.post("/api/tts/stream")
async def tts_stream(request: Request) -> StreamingResponse:
    """Word-level timestamps. Streams the upstream NDJSON straight through."""
    payload = await request.json()
    model = payload.get("__model") or DEFAULT_MODEL
    body = json.dumps(_strip_internal(payload)).encode("utf-8")
    headers = {
        "Authorization": _auth_headers()["Authorization"],
        "Content-Type": "application/json",
        "model": model,
        "Accept": "application/x-ndjson",
    }

    async def gen():
        async with _client.stream(
            "POST", f"{API_BASE}/v1/tts/stream/with-timestamp", content=body, headers=headers
        ) as up:
            if up.status_code != 200:
                raw = await up.aread()
                yield b'{"type":"error","status":' + str(up.status_code).encode() + b',"body":' + json.dumps(raw.decode("utf-8", "replace")).encode() + b"}\n"
                return
            async for chunk in up.aiter_raw():
                yield chunk

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# --------------------------------------------------------------------------- #
# Voice design + voice library
# --------------------------------------------------------------------------- #
@app.post("/api/voice-design")
async def voice_design(request: Request) -> Response:
    payload = await request.json()
    headers = {"Authorization": _auth_headers()["Authorization"], "Content-Type": "application/json"}
    upstream = await _client.post(f"{API_BASE}/v1/voice-design", json=payload, headers=headers)
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type="application/json",
    )


@app.get("/api/models")
async def models(request: Request) -> Response:
    headers = {"Authorization": _auth_headers()["Authorization"]}
    upstream = await _client.get(
        f"{API_BASE}/model", params=dict(request.query_params), headers=headers
    )
    return Response(
        content=upstream.content, status_code=upstream.status_code, media_type="application/json"
    )


# --------------------------------------------------------------------------- #
# Convenience: agent sessions (keeps private agents working) & phone calls
# --------------------------------------------------------------------------- #
@app.post("/api/sessions")
async def create_session(request: Request) -> Response:
    payload = await request.json()
    headers = {"Authorization": _auth_headers()["Authorization"], "Content-Type": "application/json"}
    upstream = await _client.post(f"{API_BASE}/v1/agent/sessions", json=payload, headers=headers)
    return Response(
        content=upstream.content, status_code=upstream.status_code, media_type="application/json"
    )


@app.post("/api/sessions/{session_id}/end")
async def end_session(session_id: str) -> Response:
    """Hang up a session.

    Needed because a failed start leaks one: the SDK mints a token, then gives
    up before joining the room without telling the server, so the session sits
    in `pending` until the server-side room_join_timeout. A user who retries a
    broken call a few times fills their session list with abandoned calls. The
    client calls this from its own failure path.
    """
    headers = {"Authorization": _auth_headers()["Authorization"]}
    upstream = await _client.post(f"{API_BASE}/v1/agent/sessions/{session_id}/end", headers=headers)
    return Response(
        content=upstream.content, status_code=upstream.status_code, media_type="application/json"
    )


@app.post("/api/phone-calls")
async def phone_calls(request: Request) -> Response:
    payload = await request.json()
    headers = {"Authorization": _auth_headers()["Authorization"], "Content-Type": "application/json"}
    upstream = await _client.post(f"{API_BASE}/v1/agent/phone-calls", json=payload, headers=headers)
    return Response(
        content=upstream.content, status_code=upstream.status_code, media_type="application/json"
    )


# --------------------------------------------------------------------------- #
# Lip sync -> viseme sidecars for Wicked Roguelike
# --------------------------------------------------------------------------- #
# The baking needs openfacefx + numpy, which live in the SYSTEM Python. The
# studio venv deliberately does not carry torch, so we shell out rather than
# duplicate a multi-GB install.
ROGUELIKE_ROOT = Path(os.environ.get(
    "ROGUELIKE_ROOT", r"C:\Users\PC\Documents\content\wicked\RoguelikeGame"))
DIALOGUE_ROOT = Path(os.environ.get(
    "ROGUELIKE_DIALOGUE_DIR", str(ROGUELIKE_ROOT / "assets" / "dialogue")))
AVATAR_DIR = Path(os.environ.get(
    "ROGUELIKE_AVATAR_DIR", str(DIALOGUE_ROOT / "33")))
# The baker shells out to an interpreter that can import numpy + openfacefx.
# Locally that is a system Python (the studio venv carries neither). A deployed
# function has no such path, so it falls back to the interpreter this process is
# already running — the one the declared dependencies were installed into.
_BAKER_PYTHON_LOCAL = r"C:\Users\PC\AppData\Local\Programs\Python\Python313\python.exe"


def _baker_python() -> str:
    configured = os.environ.get("VISEME_PYTHON")
    if configured:
        return configured
    if Path(_BAKER_PYTHON_LOCAL).exists():
        return _BAKER_PYTHON_LOCAL
    return sys.executable


VISEME_PYTHON = _baker_python()
VISEME_SCRIPT = ROOT / "tools" / "visemes.py"
# Keep a bake inside the platform's function ceiling (a Hobby function is capped
# at 300 s): a clean error beats the platform killing the request with a 504.
VISEME_TIMEOUT = int(os.environ.get("VISEME_TIMEOUT", "240"))


def discover_avatars() -> list[dict[str, Any]]:
    """Every folder under assets/dialogue that carries a `<name>_face.json` atlas.

    Adding an avatar is dropping a new folder into the game — no code change
    here. `<npc>/<npc>_default_face.json` + `<npc>_default_face.png` is the
    sheet, `<npc>_default.png` the portrait it gets pasted into.
    """
    out: list[dict[str, Any]] = []
    if not DIALOGUE_ROOT.is_dir():
        return out
    for folder in sorted(DIALOGUE_ROOT.iterdir()):
        if not folder.is_dir():
            continue
        for face_json in sorted(folder.glob("*_face.json")):
            stem = face_json.name[: -len(".json")]        # 33_default_face
            sheet = face_json.with_suffix(".png")         # 33_default_face.png
            if not sheet.exists():
                continue
            prefix = stem[: -len("_face")] if stem.endswith("_face") else stem
            portrait = folder / f"{prefix}.png"
            try:
                face = json.loads(face_json.read_text(encoding="utf-8"))
            except Exception:
                face = None
            rel = f"{folder.name}/"
            out.append({
                "id": f"{folder.name}/{stem}",
                "npc": folder.name,
                "name": prefix,
                "face": face,
                "frames": len((face or {}).get("frames") or {}),
                "face_json_url": f"/api/avatar/{rel}{face_json.name}",
                "sheet_url": f"/api/avatar/{rel}{sheet.name}",
                "portrait_url": f"/api/avatar/{rel}{portrait.name}" if portrait.exists() else None,
            })
    return out


@app.get("/api/avatars")
async def list_avatars() -> JSONResponse:
    """The avatar registry the Lip Sync page builds its stages from."""
    return JSONResponse({
        "root": str(DIALOGUE_ROOT),
        "root_exists": DIALOGUE_ROOT.is_dir(),
        "avatars": discover_avatars(),
    })


@app.get("/api/lipsync/info")
async def lipsync_info() -> JSONResponse:
    """Everything the Lip Sync page needs to draw the portrait and know which
    mouth shapes the game actually renders."""
    avatars = discover_avatars()
    # The default avatar is the one configured by ROGUELIKE_AVATAR_DIR.
    default = next((a for a in avatars if a["npc"] == AVATAR_DIR.name), None)
    if default is None and avatars:
        default = avatars[0]
    face = (default or {}).get("face")

    viseme_states = None
    voice = None
    blink = None
    gs = ROGUELIKE_ROOT / "assets" / "game_settings.json"
    if gs.exists():
        try:
            avatar = json.loads(gs.read_text(encoding="utf-8")).get("avatar") or {}
            viseme_states = avatar.get("visemes")
            voice = avatar.get("voice")
            blink = avatar.get("blink")
        except Exception:
            viseme_states = None
            voice = None
            blink = None

    return JSONResponse({
        "avatar_dir": str(AVATAR_DIR),
        "avatar_dir_exists": AVATAR_DIR.exists(),
        "face": face,
        "sheet_url": (default or {}).get("sheet_url", "/api/avatar/33/33_default_face.png"),
        "portrait_url": (default or {}).get("portrait_url", "/api/avatar/33/33_default.png"),
        "avatars": avatars,
        "viseme_states": viseme_states,
        # The game's own blink tuning (DialogueAvatar::UpdateBlink reads these),
        # so the preview blinks like the game rather than on invented timing.
        "blink": blink,
        # avatar.voice carries mouth_min_hold, which DialogueAvatar applies as a
        # render hold (a shape cannot change until it has been on screen that
        # long). The preview needs it or it flickers on cues the game would hold.
        "voice": voice,
        "baker": baker_status(),
        "hosted": IS_SERVERLESS,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
    })


@app.get("/api/avatar/{name:path}")
async def avatar_asset(name: str) -> Response:
    """Serve the game's avatar art straight from the game folder, so the preview
    always reflects the source of truth instead of a stale copy."""
    base = DIALOGUE_ROOT.resolve()
    target = (base / name).resolve()
    try:
        target.relative_to(base)          # rejects ../ escapes
    except ValueError:
        raise HTTPException(status_code=403, detail="outside the dialogue directory")
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"no such avatar asset: {name}")
    media = {".png": "image/png", ".json": "application/json",
             ".jpg": "image/jpeg", ".webp": "image/webp"}.get(target.suffix.lower())
    return Response(content=target.read_bytes(),
                    media_type=media or "application/octet-stream")


@app.post("/api/visemes")
async def bake_visemes(
    wav: UploadFile = File(...),
    text: str = Form(""),
    anchors: str = Form(""),
    aligner: str = Form("auto"),
    style: str = Form(""),
    smooth: float = Form(0.0),
    lag: int = Form(0),
) -> JSONResponse:
    """Bake a Rhubarb-format mouth track for a Fish Audio line.

    Input: the WAV from the streaming TTS endpoint plus the word timings that
    same call returned. Output: the .visemes.json sidecar the game's
    VisemeTrack loads, and the WAV with its header repaired.
    """
    if not VISEME_SCRIPT.exists():
        raise HTTPException(status_code=500, detail=f"baker missing: {VISEME_SCRIPT}")
    if not Path(VISEME_PYTHON).exists():
        raise HTTPException(status_code=500, detail=f"baker python missing: {VISEME_PYTHON}")

    audio = await wav.read()
    if not audio:
        raise HTTPException(status_code=400, detail="empty wav")

    def work() -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="viseme_") as td:
            wav_path = Path(td) / "line.wav"
            wav_path.write_bytes(audio)
            out_path = Path(td) / "line.visemes.json"
            cmd = [VISEME_PYTHON, str(VISEME_SCRIPT),
                   "--wav", str(wav_path), "--text", text,
                   "--aligner", aligner, "-o", str(out_path)]
            if anchors:
                ap = Path(td) / "anchors.json"
                ap.write_text(anchors, encoding="utf-8")
                cmd += ["--anchors", str(ap)]
            if style:
                cmd += ["--style", style]
            if smooth > 0:
                cmd += ["--smooth", str(smooth)]
            if lag:
                cmd += ["--lag", str(lag)]

            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=VISEME_TIMEOUT)
            if proc.returncode != 0 or not out_path.exists():
                raise RuntimeError((proc.stderr or proc.stdout or "bake failed").strip())

            sidecar = json.loads(out_path.read_text(encoding="utf-8"))
            fixed = wav_path.read_bytes()          # repair_wav rewrote it in place
            return {
                "sidecar": sidecar,
                "wav_base64": base64.b64encode(fixed).decode("ascii"),
                "log": (proc.stdout or "").strip(),
            }

    try:
        result = await asyncio.to_thread(work)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)

    m = result["sidecar"].get("metadata", {})
    result["stats"] = {
        "cues": len(result["sidecar"].get("mouthCues") or []),
        "duration": m.get("duration"),
        "aligner": m.get("aligner"),
        "anchorWords": m.get("anchorWords"),
        "headerRepaired": m.get("wavHeaderRepaired"),
    }
    return JSONResponse(result)


# --------------------------------------------------------------------------- #
# Local persistence for takes / presets (nice-to-have, purely local)
# --------------------------------------------------------------------------- #
def _store_path(name: str) -> Path:
    return DATA_DIR / f"{name}.json"


@app.get("/api/store/{name}")
async def store_get(name: str) -> JSONResponse:
    p = _store_path(name)
    if not p.exists():
        return JSONResponse({"items": []})
    return JSONResponse(json.loads(p.read_text(encoding="utf-8")))


@app.put("/api/store/{name}")
async def store_put(name: str, payload: dict[str, Any]) -> JSONResponse:
    try:
        _store_path(name).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        # A deployed function has nowhere writable that outlives the request.
        # The take still works; it just will not be there next time.
        return JSONResponse({
            "ok": False,
            "persisted": False,
            "message": f"no writable storage here ({exc.__class__.__name__}); "
                       "takes are kept in memory for this session only",
        })
    return JSONResponse({"ok": True, "persisted": True})


# --------------------------------------------------------------------------- #
# Static frontend
# --------------------------------------------------------------------------- #
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
