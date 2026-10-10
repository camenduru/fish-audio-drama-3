# Fish Audio Drama 3 Studio

A complete, self-contained studio for Fish Audio's **Drama 3** text-to-speech
model *and* the Fish **Agents** platform — every feature from the Drama 3 Voice
Guide and the whole published `/v1/*` API surface, behind a local server that
keeps your API key off the client.

## Run

```bash
./run.sh                       # Windows Git Bash
# or
./.venv/Scripts/python.exe -m uvicorn server.main:app --host 127.0.0.1 --port 8756
```

Then open <http://127.0.0.1:8756>.

First-time setup (already done in this workspace):

```bash
python -m venv .venv
./.venv/Scripts/pip install fastapi "uvicorn[standard]" httpx python-multipart msgpack
```

## API key

The key lives in `.env` (`FISH_API_KEY=…`) and can also be set from **Setup →
API key** in the app. It is read by the server and never sent to the browser.

> **Note:** TTS/voice-design billing uses *API credit*, which is separate from
> platform credit. With an empty API-credit balance every synthesis call returns
> `402 Insufficient API credit` — the app surfaces that message verbatim. Add
> API credit at <https://fish.audio/app/developers>. Everything else (agents,
> voice library, sessions, tools, knowledge, tests, phone numbers) works on the
> current key.

## What's in it

### Drama 3 Studio (`studio`)
| Guide feature | Where |
|---|---|
| 01 Describe the performance | `[natural language direction]` before a line; highlight + quick chips |
| 02 Change the mood mid-line | a second `[direction]` partway through a line |
| 03 Add a sound or pause | `[pause] [laugh] [sigh] [breath]` chips |
| 04 Change only certain words | select text → `<whisper> <emphasis> <faster> <slower> <forceful>` |
| 05 Write a full scene | **Scenes** tab — speakers + `Name: line` → `<\|speaker:N\|>` |
| 06 Fix one moment | **✂ Fix a moment** — re-renders the selected span and splices it back |
| 07 Fix a pronunciation | IPA `<\|phoneme_start\|>…<\|phoneme_end\|>` + pronunciation dictionary |
| 08 Keep a voice consistent | direction + tags + a reference clip (layered control) |
| 09 Let Auto Tag start for you | **✨ Auto Tag** — styles: drama / comedy / podcast / audiobook / ad |
| — | Live syntax highlighting, lint for unbalanced tags, word/char/direction counts |

Also: prosody (speed, volume, loudness), sampling (temperature, top_p,
repetition penalty), output (mp3/wav/pcm/opus, sample rate, bitrate), engine
(chunk length, latency, normalize, condition-on-previous-chunks, quality guard),
streaming with word timestamps, take history with waveform + download + reuse.

### Voice Design (`design`)
Generate candidate voices from a text description (`/v1/voice-design`), preview
them, push one straight into the studio as a reference clip, or save it as a
reusable `reference_id`.

### Voices (`library`)
Browse the Fish Audio voice library (`/model`), search, and **press ▶ to hear a
real sample** of any voice (each card shows the sample's transcript too). Click a
card to load its `reference_id` into the studio. Upload a 10–30 s clip with its
transcript to clone a new voice.

**One picker everywhere.** Anywhere the app holds a `reference_id` there is a 🔍
button that opens the *same* searchable, previewable library popup:

| Where | Field |
|---|---|
| Studio | Voice (reference_id) |
| Scenes | one per speaker — each speaker keeps their own voice |
| Lip Sync | the avatar voice |
| Agents | the agent's Voice id (picking one also sets its speaking language) |

### Lip Sync (`lipsync`)
Turns a Drama 3 line into a **game-ready mouth track** and previews it on the
NPC's real face atlas.

- **Generate + bake** — one button: synthesize with Drama 3, then bake the
  Rhubarb-format sidecar the game's `VisemeTrack` loads. `[pause]` becomes real
  silence and closes the mouth.
- **All 18 atlas frames** — 9 mouth shapes × open/closed eyes. Blinking uses the
  game's own tuning from `assets/game_settings.json` → `avatar.blink`
  (`per_min 15`, snap-to-pause, 0.1–0.2 s hold), reproducing
  `DialogueAvatar::UpdateBlink`. Uncheck *blink* to freeze the eyes; 👁 Blink
  forces one.
- **Audio takes (right panel)** — every line generated this session, here *or* in
  the Studio. Click one and **its visemes generate themselves** (🍳 Bake all does
  the whole list). Studio takes default to mp3, so they're decoded and
  re-encoded to WAV in the browser before baking. A bake that comes back with no
  mouth movement at all is retried once and then reported as a failure — a
  sidecar that never opens the mouth exports cleanly and would ship a mute NPC.
- **Avatar voices** — each avatar speaks through its own `reference_id`. The
  default is *Happy Girl*, a high-pitched, energetic young female with a bright,
  cheerful tone (`1621cae243064f63989bcccd240004b5`). Swap it with 🔍 or drop
  back to the default.
- **1 avatar / 2 talking** — the stage is an actor model. In **2 talking** mode
  two avatars stand side by side, each with its own face, voice, mouth track and
  blink machine. Only the avatar whose audio is actually rolling drives its
  mouth: the other rests closed. (Driving a paused avatar from its sidecar would
  freeze it on `cueAt(sidecar, 0)` — the first viseme of a line it isn't saying —
  so a two-hander looked like both mouths hanging open at once.)
- **Conversation script** — write the whole exchange in one box, one turn per
  line:

  ```
  Avatar1: [suspiciously calm] Who ate the last slice of cake?
  Avatar2: [way too fast] Maybe the dog. Dogs love cake.
  Avatar1: [pause] We don't have a dog.
  ```

  **🎬 Generate all** synthesises each line with *that avatar's* voice, bakes it,
  and builds the conversation; **🎬▶ Generate + play** then performs it. Drama 3
  tags work inside each line — including a bare `[pause]` for a comic beat,
  though it is wildly variable (3s to 48s observed); write `[pause:1s]` when the
  timing matters. `Avatar1` / `A1` / `1` always mean the first avatar; any other
  name (`Mom:`, `Kid:`) is assigned in order of first appearance, the way the
  Scenes tab does it — so a scene script pastes straight in. Per-take
  **A1**/**A2** buttons assign a single line by hand. Both avatars reuse the same
  `33_default_face.png` until more avatar art exists.
- **Export** — `⬇ Both` writes the matched `.wav` + `.visemes.json` pair under
  `assets/audio/speech/en/33/`, ready to drop into the game.

**Adding an avatar** is dropping a folder into the game — no code change here.
`assets/dialogue/<npc>/` needs:

```
<npc>_default_face.json   # the atlas: canvas, dest, cell, frames
<npc>_default_face.png    # 5x4 sheet of 218x166 cells
<npc>_default.png         # the portrait the face gets pasted into
```

`GET /api/avatars` scans for that pattern and returns every avatar it finds;
`GET /api/avatar/<npc>/<file>` serves the art straight out of the game folder
(path-traversal guarded), so the preview can never drift from the source.

### Examples (`examples`)
**Every Drama 3 feature from the Voice Guide, with the exact scripts** — 9
features, 26 runnable examples. Each card is syntax-highlighted and has
**Load into studio** (or **Open in Scenes** for dialogue), **▶ Hear it**
(load + synthesize), and copy. The sidebar carries a jump-nav to the nine
features and a full tag reference.

### Agents (`agents`)
Full console over `/v1/agent/*`: list / create / edit / archive, and per-agent
tabs for **Config** (prompt, voice, ASR, conversation, LLM, variables,
guardrails), **Tools** (webhook + client, system tools), **Knowledge** (upload +
attach), **Tests** (next_reply / tool / simulation, run), **Versions**,
**Sessions** (transcripts, tool calls, analysis, recording), **Webhooks**
(conversation-init + post-call), **Widget** (embed snippet) and **Phone**
(numbers, bind, buy, outbound calls).

### Live Call (`live`)
In-browser voice calls via `@fishaudio/agent-client` — mic, orb + FFT
visualizer, live transcripts, mode indicator, tool-call feed, text input,
mute/end. Public agents connect directly; private agents get a session token
minted server-side with your API key.

> **Model note.** The Agents / Live Call path does **not** use Drama 3, and
> cannot be made to. `AgentVoiceConfigView` exposes only `voice_id`,
> `speaking_language`, `expressive`, `speed` and `pronunciation_dictionary_ids`
> — there is no model field, so Fish's agent runtime picks the TTS model
> server-side. Drama 3 applies to the `/v1/tts` paths (studio, scenes, streaming,
> inpainting, zero-shot) only.

## Which model does each generation path use?

`DEFAULT_MODEL = "drama-3-preview"` in `server/main.py` is the single source of
truth. Fish takes the model as an **HTTP header** (`model`), not a body field —
the enum is `s1 | s2-pro | s2.1-pro | s2.1-pro-free | drama-3-preview`.

| Path | Model sent |
| --- | --- |
| Studio generate / inpaint | `#ttsModel` dropdown → `drama-3-preview` (default) |
| Studio streaming | same dropdown |
| Scenes render | `#sceneModel` dropdown → `drama-3-preview` (default) |
| Examples "▶ Hear it" | routes through studio generate |
| Zero-shot (reference clip) | `__model` from the dropdown, via MessagePack |
| Raw `POST /api/fish/v1/tts` | `DEFAULT_MODEL`, unless `x-fish-model` is set |
| Agents / Live Call / Phone | **not settable** — Fish picks server-side |

> **Trap:** Fish falls back to `s2.1-pro` for an omitted *or unrecognized* model,
> so a typo fails **silently** rather than erroring. `tools/probe_model.cjs`
> (with `tools/echo_upstream.py`) is the wire-level check for this: it points the
> app at a recording stub and asserts the `model` header on every path.

## Layout

```
server/main.py      FastAPI: auth proxy + static host
web/                the studio (vanilla JS ES modules, no build step)
  js/drama3.js      the Drama 3 grammar: highlight, auto-tag, scene parsing
  js/studio.js      editor, generation, player, takes, inpainting
  js/scenes.js      multi-speaker dialogue
  js/voices.js      voice design + library (with sample playback)
  js/voicepicker.js the one searchable voice-library popup, used by every view
  js/library.js     session-wide audio library (Studio → Lip Sync handoff)
  js/lipsync.js     lip sync page: actors, generate → bake → preview on the face
  js/convo.js       conversation-script parsing (DOM-free, unit-tested)
  js/examples.js    all 9 Drama 3 features as loadable examples
  js/agents.js      agents console
  js/livecall.js    Web SDK live calls
tools/visemes.py    the Fish-anchored viseme baker (openfacefx + allosaurus)
tools/bake_debug.py run the baker directly and print the real traceback
tools/verify_ui.cjs      headless-Chrome UI harness (28 checks)
tools/verify_lipsync.cjs headless-Chrome lip-sync harness (52 checks, real API)
tools/verify_stream.cjs  streaming regression harness (7 checks)
tools/echo_upstream.py   recording stub that stands in for api.fish.audio
tools/probe_model.cjs    drives the real UI and asserts the `model` header sent
data/               local takes / presets (gitignored, recreated on startup)
.env.example        the env vars, without the key
openapi.json        cached Fish Audio OpenAPI schema
```

`.gitignore` keeps the API key out of the repo: `.env`, `.venv/`, `data/`,
`node_modules/`, `__pycache__/` and editor folders are all excluded, while
`.env.example` is committed so setup is still documented.

## Verification

```bash
NODE_PATH=.../node_modules node tools/verify_ui.cjs        # 28/28, no credit needed
NODE_PATH=.../node_modules node tools/verify_lipsync.cjs   # needs real API credit
```

`verify_ui.cjs` drives the running app in headless Chrome and asserts the studio,
tag insertion, wrapping, auto-tag, scenes, design, voice samples (including that
the sample MP3 is actually fetched from the CDN), the voice picker, the examples
library, agents, modal, live view and settings all work — and that the console is
clean.

`verify_lipsync.cjs` generates real audio and asserts the mouth actually moves:
the bake round-trips, the cue timeline renders, the mouth cycles through
multiple shapes while playing, the **closed-eye frame is really drawn** (a
pixel-level eye-band comparison, not a class-name check), the eyes reopen after
the hold, auto-blink fires while playing and stops when switched off, the
Studio→Lip Sync take handoff auto-bakes, the exported sidecar is well-formed,
sorted and inside the audio, and the two-hander works — per-avatar voices reach
the wire, the script parser handles tags and unknown names, and **both** avatars
animate their own mouths while the idle one stays closed.
