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
  so a two-hander looked like both mouths hanging open at once.) The preview
  applies the game's own mouth timing on top: a shape must have been on screen
  for `avatar.voice.mouth_min_hold` (0.05 s) before it may change, and the clock
  is shifted back by `avatar.visemes.latency_seconds` so the mouth never leads
  the voice — the same two rules as `DialogueAvatar::UpdateMouth` and
  `AudioSystem::CurrentVoiceSeconds`.
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

#### The baker is checked against the audio, not against another baker

`tools/visemes.py` is the studio's own baker: it pins the aligner to Fish's word
timings instead of recovering them with an ASR. What matters is not that it
agrees with some other implementation — it is that the mouth it emits actually
follows the audio.

```bash
python tools/compare_bakers.py --endpoint http://127.0.0.1:8756
```

runs it over a tracked fixture (`tools/fixtures/speech.wav` — a real streamed
Fish line, with its Fish anchors) and checks four things:

- **Well-formed** — A–H/X only, sorted, non-overlapping, inside the audio,
  starting at 0, `metadata.duration` matching the WAV. The format contract.
- **The mouth moves where there is sound** — at most 5% of the *loud* frames may
  be closed, measured off the WAV's own energy. **This is the part that catches
  the real bug class**, and it exists because of one: Allosaurus emits the
  230-symbol universal IPA inventory, but OpenFaceFX's `--phones-alphabet ipa`
  table only knows 39 canonical spellings, so ordinary phones (`ə o ʀ ɹ̩ b̥ ɒ ɾ`)
  fell through to `sil` and baked as a **closed** mouth — the first 0.58 s of a
  line came out shut. `tools/visemes.py` now translates Allosaurus IPA → ARPAbet
  and passes `--phones-alphabet arpabet`, where every symbol maps.
- **Every Allosaurus phone reaches the viseme table** — the same failure isolated
  as a unit test, over the recognizer's real English inventory (67 symbols) plus
  the 21 that used to bake shut.
- **The guard is real** — the opt-in `--speech-guard` needs Fish anchors, so
  without them it is *inert*, and a naive harness would report a meaningless
  "no effect". This part asserts it is inert without anchors **and** that it
  changes the output once anchors exist.

With `--endpoint` it re-runs the well-formed and loud-audio checks against
`POST /api/visemes`, because the flags the server passes are what the app ships.

An earlier version of this harness diffed the studio's output against another
baker and called that parity. It passed while the studio shipped a shut mouth —
two implementations can share a misunderstanding, so agreement is not evidence.
The audio is the reference.

The timeline shape itself is still deliberately constrained by three things:

| | the studio used to | now |
|---|---|---|
| **gap filling** | pad the timeline out to `duration` and fill gaps with X | sort/clamp/merge only — `VisemeTrack::Sample` returns `'X'` outside a cue, so a gap and an explicit X cue render identically |
| **short cues** | drop any cue under 30 ms | keep them — the game *holds* a shape for `avatar.voice.mouth_min_hold` (0.05 s), so a 20 ms cue is a shape the game draws for 50 ms |
| **speech guard** | always on | opt-in via `--speech-guard` |

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
**Every Drama 3 feature from the Voice Guide, with the exact scripts** — 12
features, 39 runnable examples. Each card is syntax-highlighted and has
**Load into studio** (or **Open in Scenes** for dialogue), **▶ Hear it**
(load + synthesize), and copy. The sidebar carries a jump-nav to the twelve
features and a full tag reference.

The first nine blocks teach one feature each. The last three are deliberately
**complex**, because the features are meant to compose and a one-line demo never
shows that:

- **10 · Stack it all in one line** — a direction, a sound tag, a scoped span and
  a mid-line mood change in a single sentence, up to
  `[suddenly furious] <forceful>Get out.</forceful> [pause] [breath] [whispering, broken] <whisper>Please. Just go.</whisper>`
- **11 · Full scenes, longer casts** — four scenes from three to four speakers,
  up to nine turns, including an interrogation that escalates and a radio drama
  where the direction tracks a voice getting closer. These also appear in the
  Scenes tab's preset list.
- **12 · Long-form narration** — single-voice arcs where the direction changes
  two or three times inside one paragraph.

`verify_ui.cjs` lints **every** shipped script for tag balance, so a stray
`</whisper>` in a long example fails the harness rather than the synthesis.

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

#### When a call fails, the error says why

`@fishaudio/agent-client` funnels nearly every transport failure through a single
message — **"Could not establish the realtime session"** — and hangs the real
reason on `err.cause`. That is a trap for a caller, because the LiveKit transport
awaits `getUserMedia` *outside* the `try/catch` that produces the message, so a
microphone problem is reported as a failed **session**:

| actual cause | SDK message |
| --- | --- |
| `NotReadableError` — mic in use by another app | "Could not establish the realtime session" |
| `NotFoundError` — no microphone at all | "Could not establish the realtime session" |
| `mediaDevices` undefined — plain-HTTP non-localhost origin | "Could not establish the realtime session" |
| `OverconstrainedError` — selected device gone | "Could not establish the realtime session" |
| `NotAllowedError` — permission denied | "Microphone permission was denied" |

Only the last is distinguishable from the message alone. So `classifyCallError()`
walks the whole `cause` chain and reports the **root** cause in plain language:

```
Could not start call: the microphone could not be started — another app is probably using it
```

`preflightCall()` runs first and rejects a non-secure origin outright, before a
session token is minted. The full chain is kept on `window.__livecall().lastError`
and logged to the console.

#### A failed call no longer leaks a session

A start mints a session token *before* it connects. If the connect then fails,
nothing used to tell the server — so the session sat in `pending` until the
server-side `room_join_timeout`, and a user retrying a broken call quietly filled
their session list with abandoned calls. `startCall()` now remembers the minted
`session_id` and releases it on the failure path via
`POST /api/sessions/{id}/end` (best effort — the server times it out regardless).
The insecure-origin case never gets that far, because the preflight runs first.

Two things worth knowing about the API:

- `POST /v1/agent/sessions/{id}/end` is a **no-op once a session has recorded an
  `end_reason`** (e.g. `room_join_timeout`). It returns 204 either way, so it
  cannot be used to tidy up already-timed-out rows.
- `ended_at` is only set for sessions that actually joined a room. A session that
  never joined keeps `ended_at: null` forever, so "has no `ended_at`" is not the
  same as "is live" — filter on `status=active` instead. There is no delete
  endpoint; abandoned rows age out.

#### Testing a call: ask by text, then ask by voice

`tools/probe_call_voice.cjs` runs the whole loop for real. It generates a TTS
clip of the question, feeds it in as the **fake microphone**
(`--use-file-for-fake-audio-capture`), then drives the app: type the question
into the call and send it as text, then let the microphone carry the same
question so it goes through the agent's ASR.

```
--- after connect (agent greeting) ---
  agent: What is your name?
=== PHASE 1 · ask by TEXT ===
  agent: I'm your voice assistant, here to help you out.
=== PHASE 2 · ask by VOICE (fake mic plays the clip) ===
  user: What is your name?
  agent: I
=== output level (app FFT visualiser) ===
  peak while the agent was speaking: 78.0%
  PASS — the agent's voice is arriving
```

Chrome loops the fake-capture file, so the clip is **padded with silence**
(`ask_name_once.wav` = 1.5 s phrase + 20 s silence) — otherwise the question
repeats back to back and the transcript is unreadable.

The output-level check matters most. It reads the app's own FFT visualiser,
which is fed from the SDK's output analyser, so it is the only in-app evidence
that the agent's voice actually reached the client. **0% while the agent reports
`speaking` means the agent's TTS is not arriving** even though ASR, the LLM and
the text channel are all working — which is exactly what a bad `voice.voice_id`
looks like. That is how the `test` agent's broken voice was found: swapping
`Selene` (`b347db03…`) for `Happy Girl` (`1621cae2…`) took the output level from
0% to 78%.

> Config patches are **draft-only** — a `PATCH .../config` has no effect on live
> sessions until you `POST .../publish`. Easy to miss, and it looks exactly like
> "my change did nothing".

> **Model note.** The Agents / Live Call path does **not** use Drama 3, and
> cannot be made to. `AgentVoiceConfigView` exposes only `voice_id`,
> `speaking_language`, `expressive`, `speed` and `pronunciation_dictionary_ids`
> — there is no model field, so Fish's agent runtime picks the TTS model
> server-side. Drama 3 applies to the `/v1/tts` paths (studio, scenes, streaming,
> inpainting, zero-shot) only.

### VRM Call (`vrmcall`)
The same live call as **Call**, with the agent given a body. Add your own `.vrm`
(drag & drop, the file picker, or a URL) and it renders in the browser; the
agent's voice drives its mouth while you talk.

The call is not a second implementation. `web/js/agentcall.js` holds the whole
call lifecycle — the unwrapped error reporting, the microphone probe and
text-first fallback, the session-leak cleanup, the transcripts and the client
tools — and each page binds it to a set of element ids (`live*` / `vrm*`) plus an
`onLevel` hook. The Call page draws that level as bars and an orb; this page feeds
it to the avatar.

What the avatar does, and where it comes from (`web/js/vrmcall.js`):

| | |
| --- | --- |
| viewer | three.js + `@pixiv/three-vrm` through `GLTFLoader` + `VRMLoaderPlugin`, `rotateVRM0`, then `vrm.update(delta)` every frame — ChatVRM's load path |
| lip sync | the SDK's output level (`getOutputVolume()`, with `getOutputFrequencyData()` as a floor), shaped by a gamma, then an asymmetric smoother (fast attack, slower release) into the VRM `aa` expression — only `aa`, as ChatVRM does |
| blink | auto-blink on the `blink` expression; shut for ~0.12 s, then reopened after 2–5 s (ChatVRM's `BLINK_CLOSE_MAX` / `BLINK_OPEN_MAX`) |
| look-at | an `Object3D` parented to the camera becomes `vrm.lookAt.target`, so the eyes converge on you and keep following while you orbit |
| idle | a slow chest sway and breathing on the normalized bones — deliberately procedural, not a `.vrma` clip, because shipping an idle animation drags in an asset licence the studio does not need. The head is left to `VRMLookAt`; animating it here would fight the gaze |

Nothing is pre-rendered, so the mouth stops when the agent stops.

- **three.js loads on demand.** `index.html` carries an import map pinning
  `three@0.180.0` and `@pixiv/three-vrm@3.5.5`; nothing is fetched until the page
  is first opened. The bare specifiers matter: they are what makes `GLTFLoader`,
  three-vrm and the renderer share *one* three.js instance (two copies fail
  `instanceof` checks deep inside three-vrm).
- **Your model is remembered** in IndexedDB, so a 10 MB VRM does not have to be
  re-picked after a reload. **✕ Remove** clears it.
- **Mouth gain** is a per-model fader — VRM `aa` shapes differ a lot in how far
  they open.
- The call itself (mic, errors, text-only fallback) behaves exactly as on the
  Call page, including the failure path that releases a minted session.

> ChatVRM peaks the time-domain samples and pushes them through a sigmoid. That
> is the same *idea* — a level, shaped, into `aa` — but the SDK already hands us a
> 0–1 level, so a gamma replaces the sigmoid; the sigmoid's input range does not
> exist here.

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
  js/examples.js    all 12 Drama 3 features as loadable examples
  js/agents.js      agents console
  js/agentcall.js   the call lifecycle both call pages share
  js/livecall.js    the Live Call page (binds agentcall to the live* ids)
  js/vrmcall.js     the VRM Call page: a three.js/three-vrm avatar whose mouth the call drives
tools/visemes.py    the Fish-anchored viseme baker (openfacefx + allosaurus)
tools/fixtures/     the tracked bake fixture (a real streamed Fish line + anchors)
tools/bake_debug.py run the baker directly and print the real traceback
tools/compare_bakers.py  studio-only viseme checks (well-formed, loud-audio, phones, guard)
tools/verify_ui.cjs      headless-Chrome UI harness (33 checks)
tools/verify_lipsync.cjs headless-Chrome lip-sync harness (58 checks, real API)
tools/probe_duo.cjs      two-hander playback probe — no API, hand-built takes
tools/probe_examples.cjs  synthesize the complex examples end to end (1 call each)
tools/probe_call.cjs      drive the real Live Call UI and unwrap the error chain
tools/probe_call_failures.cjs  stub each call failure, check the message names it
tools/probe_call_voice.cjs  ask by text, then ask by voice (fake-mic TTS clip)
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
NODE_PATH=.../node_modules node tools/verify_ui.cjs        # 33/33, no credit needed
NODE_PATH=.../node_modules node tools/probe_duo.cjs        # two-hander + min-hold, no credit needed
NODE_PATH=.../node_modules node tools/verify_lipsync.cjs   # needs real API credit
NODE_PATH=.../node_modules node tools/probe_call_failures.cjs   # call errors, no credit
NODE_PATH=.../node_modules node tools/probe_vrm.cjs avatar.vrm   # the VRM avatar, no credit
python tools/compare_bakers.py                                    # viseme correctness, no credit
python tools/compare_bakers.py --endpoint http://127.0.0.1:8756   # + the shipped HTTP path
```

`compare_bakers.py` needs the **system** Python (the one with `numpy`,
`openfacefx` and `allosaurus`), not the studio's venv — same reason
`tools/visemes.py` does.

`verify_ui.cjs` drives the running app in headless Chrome and asserts the studio,
tag insertion, wrapping, auto-tag, scenes, design, voice samples (including that
the sample MP3 is actually fetched from the CDN), the voice picker, the examples
library, agents, modal, live view and settings all work — and that the console is
clean.

`probe_duo.cjs` is the cheap, deterministic half of the two-hander coverage: it
injects two hand-built takes (a generated WAV plus a hand-written sidecar)
straight into the shared library, then drives the real DOM path — duo mode,
assign A2/A1, play — while tracing each actor's audio element frame by frame. No
synthesis, no baking, so it can be run on every change. It prints each actor's
cue times and the shapes actually drawn.

It also measures the **mouth hold**. `DialogueAvatar` will not change a mouth
shape until it has been on screen for `avatar.voice.mouth_min_hold` (0.05 s), so
a cue shorter than that is *drawn and held*, not invisible noise. The probe puts
a deliberately tiny 20 ms `'D'` cue between two long ones, samples the shape on
every animation frame, and asserts the `'D'` stayed up for ≥ 40 ms. On a
60 fps page it measures ~67 ms — four frames instead of the one a naive
`cueAt()` renderer would give. That is the same reason the baker must not drop
short cues.

`verify_lipsync.cjs` generates real audio and asserts the mouth actually moves:
the bake round-trips, the cue timeline renders, the mouth cycles through
multiple shapes while playing, the **closed-eye frame is really drawn** (a
pixel-level eye-band comparison, not a class-name check), the eyes reopen after
the hold, auto-blink fires while playing and stops when switched off, the
Studio→Lip Sync take handoff auto-bakes, the exported sidecar is well-formed,
sorted and inside the audio, and the two-hander works — per-avatar voices reach
the wire, the script parser handles tags and unknown names, and **both** avatars
animate their own mouths while the idle one stays closed. It reads per-actor
state through a read-only `window.__lipsync()` snapshot rather than inferring it
from badge text, because a badge reading "closed" is also what an avatar with no
mouth track at all looks like.

`probe_call_failures.cjs` is the Live Call equivalent: it stubs each way a call
can fail — a busy microphone, a denied one, no microphone, a vanished device, an
insecure origin — drives the real UI, and asserts the toast names the actual
cause rather than repeating the SDK's one-size-fits-all message. It also proves
the healthy path still connects, so the error handling cannot be "fixed" by
breaking the success path — and it snapshots the account's sessions before and
after to assert the run leaves **nothing** pending. No API credit: the failures
all happen before the session is used.

`probe_call.cjs` is the manual diagnosis tool for a call that will not start. It
mints a session token, checks the mic, runs the SDK, and prints the whole
unwrapped error chain — the thing the app used to throw away. It releases the
sessions it creates.

`probe_call_voice.cjs` is the other half: the call *starts* fine, but is anyone
audible? It plays a TTS clip into the fake microphone so the agent hears a real
question, asks it by text first and then by voice, and reports the app's own
output level. It is what distinguishes "the call is broken" from "the agent's
voice is broken" — see the Live Call section. It hangs up through the UI and
releases its session.

`probe_vrm.cjs` is the avatar's harness. It opens the VRM Call page, loads a
`.vrm` through the **real file picker**, asserts the metadata parsed and that the
render loop is drawing (`triangles > 0`), drives a level down the same wire the
call's `onLevel` writes to and asserts it reaches the VRM `aa` expression and
closes again in silence, waits for an auto-blink, and then switches to the Live
Call page to prove it is unharmed. No API key and no credit: a call cannot be
started headlessly without a microphone and an agent, so the level is injected
through `window.__vrmcall.feed()` — everything downstream of that point is the
shipped path. On a machine without a GPU (a VM or CI box), pass software WebGL:
`CHROME_ARGS="--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader"`.
