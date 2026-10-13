# Fish Audio Drama 3 Studio

https://github.com/user-attachments/assets/a7fcf6f8-2955-48a0-8418-3f4ac6217696

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

▶ is one shared helper (`voicepreview.js`), so it behaves identically on this
page, on My Voices and in every 🔍 picker: a real `samples[]` recording when the
voice has one, and a short synthesized line otherwise — see
[My Voices](#my-voices-myvoices) for why that fallback exists.

**One picker everywhere.** Anywhere the app holds a `reference_id` there is a 🔍
button that opens the *same* searchable, previewable library popup:

| Where | Field |
|---|---|
| Studio | Voice (reference_id) |
| Scenes | one per speaker — each speaker keeps their own voice |
| Lip Sync | the avatar voice |
| Agents → Config | the agent's Voice id (picking one also sets its speaking language) |
| Agents → ＋ New agent | the same, on the create form |

**Your own voices are the first group in it.** The picker fetches the account's
models (`self=true`) alongside the public listing and shows them under **🎙 My
Voices** above **🌐 Voice library**; a voice of yours that is also published stays
in the first group rather than appearing twice. Typing in the box searches *both*
— `title=` alone is the public library and would not find what you just created.
If the own-voices fetch fails the picker degrades to the public list, which is
exactly what it was before.

> **A modal can open a modal, and the one underneath survives.** The picker is
> opened *from* the agent create form, and both are panels of the same
> `#modalBody` — so opening the picker used to replace the form's nodes and
> closing it shut the whole overlay, which read as "clicking 🔍 threw away the
> agent I was half-way through naming". `modal()`/`close()` in `api.js` now keep
> the outgoing panel on a stack and re-attach the *same* elements, so every field
> still holds what was typed. The complex-tag picker attached to a prompt field
> inside that form was affected the same way and is fixed by the same change.

### My Voices (`myvoices`)
Every voice **this account** has created — an uploaded reference clip or a saved
design — on its own page, newest first.

It exists because they are invisible everywhere else. The public library is
`GET /model`, which does not contain your own private models, and
`author_id=<you>` returns nothing; only `self=true` is the account's own shelf.
So an uploaded voice used to be created, toasted, and then reachable nowhere in
the app.

- **▶ on every card — and in every picker.** Fish generates `samples[]` only for
  *published* voices, so an uploaded one has none. A voice with no sample used to
  render a ▶ that was **disabled** and tooltipped "No sample", which is exactly
  the voice you cannot audition, in the one list that exists to let you pick one.
  One shared helper (`voicepreview.js`) now decides what ▶ does everywhere: the
  real sample if there is one, otherwise a short line synthesized with the model
  as its own `reference_id` (the same call the studio makes with that id). It
  spends API credit and the tooltip says so; a `402` on an empty balance is
  surfaced verbatim rather than swallowed. The result is cached per voice, so
  pressing ▶ twice plays twice and pays once.
- **The preview line is yours to set.** A synthesized preview has to say
  *something*, and the first version of this said a hardcoded `"Welcome to Fish
  Audio."` — so every sampleless voice in the app was auditioned with the same
  branded jingle, and pressing ▶ on five different voices played one identical
  sentence. The reasonable conclusion was "this is generic audio", and about the
  *content* it was. The default is now a neutral pangram, the sentence is editable
  in the **🔊 Preview line** panel (saved in this browser, applied to every ▶ in
  the app), and a voice that has its own transcript on Fish still speaks that
  instead — it is the only text genuinely *of* that voice.
- **The state is shown, not assumed** — Fish's own `state` word
  (trained / training / failed), plus visibility, language and creation time.
- **⧉ Copy id** to paste the `reference_id` into the studio, a Scenes speaker or
  an agent's config; clicking the card itself loads it into the studio.
- **Search is server-side** (`self=true&title=…`), for the same reason the voice
  picker's is: filtering the loaded page cannot find a voice outside it.
- **Examples while the shelf is empty.** With no voices of your own the page
  offers six voices from the public library, keeping their real `samples[]` so ▶
  plays a recording rather than spending credit. They are rendered *outside*
  `#myVoiceGrid` — that grid means "voices you made", and a probe reading it must
  never see them — and they disappear the moment the account has one of its own.
- Creating a voice here *or* on Voices refreshes **both** lists, so a new one
  appears immediately instead of after the next reload.

> The **Voices** page still lists the public library only, so a voice you just
> created is reachable from My Voices and from every 🔍 picker, but not from that
> page's own grid. That is the next thing to fix, not something My Voices solves.

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

#### An agent can have a body — a URL, stored on the agent

`＋ New agent` and the agent's **Config** tab both carry an optional **VRM URL**,
so an agent created without one can still get one later. The VRM Call page loads
it when that agent is selected.

It is a URL and not a file, and that is the whole design. A `.vrm` is several
megabytes, the Fish API has no avatar field (`AgentVoiceConfigView` is voice_id,
speaking_language, expressive, speed and pronunciation ids), and the only other
place to put bytes is the browser — so a local file could be worn in exactly one
browser and would silently vanish everywhere else. That is not "the agent has a
body", it is "this browser has a body". A URL lives in the agent's own
`variables.defaults` on the server, so the agent carries its body with it.

The VRM Call page picks the body in this order:

| | source | where it lives |
| --- | --- | --- |
| 1 | the selected agent's VRM URL — `model.source === 'agent-url'` | the agent, on Fish |
| 2 | the model the user last picked for themselves — `model.source === 'restore'` | this browser (`fd3.vrm`) |
| 3 | the bundled `AvatarSample_B.vrm` — `model.source === 'default'` | the studio |

Switching agent switches body, so the page cannot be left showing the wrong
agent's avatar. Four things are deliberate:

- **`variables.defaults` is the only agent-scoped store the API offers**, and the
  map **replaces as a whole** — so every write is read-modify-write
  (`agentvars.js`). Sending `{vrm_url}` alone to an agent that also had
  `{tone: 'warm'}` would delete `tone`. The read-modify-write is not atomic (there
  is no compare-and-set), but it is far better than sending a map that is minutes
  old. `tools/probe_variables.cjs` measures all of this against the live API and
  restores the agent afterwards.
- **A variables-only PATCH is a real partial patch.** Verified, not assumed: if it
  were a full replace, setting a VRM URL would erase the agent's prompt and voice.
- **Variable names are validated, and `vrm_url` is legal.** Measured against the
  live API, the rule is `^[A-Za-z][A-Za-z0-9_]*$` — a letter first, then letters,
  digits and underscores. `_probe`, `__probe`, `probe-rmw`, `probe.rmw`, `1probe`,
  `"probe rmw"` and `áccent` are all rejected with a `422 Invalid dynamic variable
  name`. The feature's key was chosen to satisfy this, and the harness asserts the
  rule rather than trusting it.
- **A URL that will not load is not fatal.** A model host that blocks cross-origin
  reads, or a URL that has since 404'd, falls through to the next source with a
  toast — the stage is never left empty by someone else's server.
- **The agents load before the viewer boots.** The selected agent decides whose
  body loads, so starting the viewer first would load one model and immediately
  replace it with another.

Setting a URL writes straight to the server rather than into the Config tab's
unsaved draft, so the **🔤 Variables** editor is re-rendered from the server's
answer on every change — otherwise a later *Save changes* would send back a stale
`defaults` map and drop the key that was just written.

> **Retired: the per-agent file.** Earlier versions kept a `.vrm` in
> `fd3.agentvrm` (a second IndexedDB, keyed by `agent_id`). It is gone, and the
> database is dropped once on the next visit rather than left occupying the
> user's storage quota with nothing reading it.

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
The same live call as **Call**, with the agent given a body. The page has one
without being asked: `web/vrm/AvatarSample_B.vrm` is the default model and
`web/vrm/idle_loop.vrma` the default idle animation, both served from the
studio's own origin, so a first visit is a standing, breathing avatar rather than
an empty stage. Add your own `.vrm` (drag & drop, the file picker, or a URL) and
it renders in the browser instead; the agent's voice drives its mouth while you
talk.

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
| lip sync | the SDK's output level (`getOutputVolume()`, with `getOutputFrequencyData()` as a floor), shaped by a gamma, then an asymmetric smoother (fast attack, slower release), handed to the emote controller |
| mouth preset | whatever the model has: `JawOpen` when it is a perfect-sync model, otherwise `aa` — ChatVRM's own preference order |
| mouth weight | the value is *not* written raw: half of it while the emotion is neutral, a quarter under an emotion (`0.5` / `0.25`, ChatVRM's `ExpressionController::update`). The mouth-gain fader is what compensates |
| emotions | one at a time, the previous one zeroed on the way out; an emotion waits out the blink it interrupted, because applying an expression over closed eyelids reads as a glitch |
| blink | auto-blink on the `blink` expression via ChatVRM's `AutoBlink`; shut for `BLINK_CLOSE_MAX` (0.12 s), open for `BLINK_OPEN_MAX` (5 s) |
| look-at | an `Object3D` parented to the camera becomes `vrm.lookAt.target`, so the eyes converge on you and keep following while you orbit |
| idle | the bundled `.vrma` on a `THREE.AnimationMixer`, rebuilt for whichever model is loaded. If it cannot be fetched or parsed the rig falls back to the procedural chest sway it used before, so the page never sits stone still |
| framing | a head shot on open — cropped below the shoulders, not head to toe, because legs and hips cost you the pixels that should be going to a face |
| facing | held square to the camera: this model stands ~9.4° turned in its rest pose and the idle clip adds a little on top, so the yaw is measured on the world every frame and cancelled on the model root |
| camera | left drag orbits, the wheel zooms, a **right-held drag moves the avatar** (screen-space pan). Panning is clamped to 1.5 m from where framing put the target — an avatar dragged out of the scene looks exactly like a broken one |

Nothing is pre-rendered, so the mouth stops when the agent stops.

#### The expression side is ChatVRM's, ported as a unit

`web/js/emote.js` carries the whole emote feature set from ChatVRM's
`src/features`, because the files there only mean anything together and splitting
them invites the half-port that gets the interaction wrong:

| ChatVRM | here |
| --- | --- |
| `lipSync/lipSync.ts` | `cookVolume()` + `LipSync` — peak of the time-domain data, the sigmoid `1/(1+exp(-45v+5))`, and the `0.1` floor that makes silence a shut mouth |
| `emoteController/emoteController.ts` | `EmoteController` |
| `emoteController/expressionController.ts` | `ExpressionController` — the emotion / mouth / blink state machine and the `0.5` / `0.25` weights |
| `emoteController/autoBlink.ts` | `AutoBlink` — two timers, and `setEnable()` returning the seconds until the eyes reopen |
| `emoteController/autoLookAt.ts` | `attachLookAt()` |
| `emoteController/emoteConstants.ts` | `BLINK_CLOSE_MAX` / `BLINK_OPEN_MAX` |

What a half-port gets wrong is the interaction. The mouth weight depends on whether
an emotion is showing, and an emotion lands only after the eyes have reopened —
both live in the controller rather than in the render loop, which is why the harness
can assert them (neutral → `mouth × 0.5`, `emote('happy')` → `mouth × 0.25`,
`emote('neutral')` → back to `0.5`).

The one deliberate difference is where the level comes from. ChatVRM analyses its
own `AudioContext` because it plays its TTS buffers itself; this studio's audio
arrives from the agent SDK, which hands out a 0–1 output level rather than samples,
so that level is what feeds the controller. `cookVolume()` is kept exactly as
ChatVRM wrote it for anyone who *does* have samples, and the level path is modelled
on the same idea — a curve that lifts quiet speech, then a floor.

> The agent transport carries no emotion. ChatVRM reads one out of an LLM
> screenplay field and the Fish agent runtime exposes no equivalent, so an emotion
> can only be set in code or from the harness — `window.__vrmcall.emote('happy')`.
> That is why the weight rule is worth testing: nothing else would exercise it.

The facing is held square rather than corrected once. `AvatarSample_B` stands ~9.4°
turned and its idle clip turns it a little further, which reads as an avatar looking
over your shoulder — and the gaze does not save it, because the look-at applier only
moves the eyes inside a head that is already aimed past you. The fix is a per-frame
measurement of the head's world yaw, cancelled on the model *root*: the body keeps
its sway, lean and breathing while the facing stays locked. Two things make the
obvious versions wrong — squaring the *neck* leaves the shoulders turned and the
head twisted on them, and a one-shot correction at load does nothing at all, because
three-vrm has applied no pose at that point and the measurement comes back a flat
`0`. The correction is capped at 60°, so a model facing backwards (a VRM0/VRM1
mix-up, which `rotateVRM0` handles) is left alone instead of being spun around.

Framing is solved rather than guessed, and solved off the rig. The top of the
opening shot is the model's real top plus a little air; the bottom is just under the
*neck bone*, so a sliver of shoulder shows; the distance follows from what a 30° fov
can hold at that span. Framing off a fraction of the model's height is how the top
of the hair gets shaved off — the head *bone* sits below the highest vertex, so
anything centred on the head crops the hair above it. The probe reads the canvas
rather than the numbers: the silhouette must clear the top edge (nothing cropped
up there) *and* run off the bottom edge, which is what makes it a head shot instead
of a torso or full-body one that merely looks tight. This is also what **Reset
camera** and the opening view both use, so they cannot drift apart.

#### Bundled avatar and idle clip

Both files live in `web/vrm/` and are served by the same `StaticFiles` mount as
the rest of the UI. They came from pixiv's ChatVRM (`public/`); ChatVRM's own
LICENSE is MIT, but that covers its code, and neither file states terms of its own
— `AvatarSample_B.vrm` is the VRoid sample model and `idle_loop.vrma` a VRM
Animation sample, with no author or licence metadata in either container. They are
recorded here rather than assumed.

The idle path needed the separate `@pixiv/three-vrm-animation` package: a `.vrma`
is a glTF carrying the `VRMC_vrm_animation` extension, and the plugin that reads it
was removed from three-vrm's core after 1.x. A plain `GLTFLoader` parses such a
file into an empty scene with no animation at all, which is what "the clip is not
playing" looks like from the outside — the import map pins
`@pixiv/three-vrm-animation@3.5.5` to match the three-vrm next to it.

Two facts about this pair were measured, because the obvious assumptions are both
wrong:

- **The clip and the gaze never compete.** `VRMLookAtBoneApplier.applyYawPitch`
  rotates `leftEye`/`rightEye` and nothing else — verified in 1.0.9 (what ChatVRM
  pins) and in 3.5.5 (ours). So a clip that turns the head cannot fight the
  look-at, and an earlier version of this page that dropped the clip's head and
  neck tracks to "protect" the gaze was solving a problem that does not exist
  while silently deleting real neck motion.
- **The clip cannot turn this head anyway.** It animates 28 channels, but its
  `head` channel targets a VRoid node that is not in the file's own humanoid map,
  and a VRMA only carries humanoid bones — so the loader correctly binds nothing
  for the head. 22 of the 28 channels survive as tracks (neck, spine, chest, arms,
  legs, hips); the rest target nodes the spec has no way to reach. `probe_vrm.cjs`
  asserts this, so it fails if a future clip does bind a head track.

The clip does need one correction. The loader scales its hips translation to the
model's hip height but leaves the value *absolute*, so played as-is it slides the
body ~15 cm sideways off the origin the camera was framed on — the same "the
animation's origin is offset" that ChatVRM works around by re-framing the camera
after play. The offset is subtracted from the track instead, which keeps the sway
(~2.7 cm) and leaves the avatar where it was framed.

- **three.js loads on demand.** `index.html` carries an import map pinning
  `three@0.180.0` and `@pixiv/three-vrm@3.5.5`; nothing is fetched until the page
  is first opened. The bare specifiers matter: they are what makes `GLTFLoader`,
  three-vrm and the renderer share *one* three.js instance (two copies fail
  `instanceof` checks deep inside three-vrm).
- **Your model is remembered** in IndexedDB, so a 10 MB VRM does not have to be
  re-picked after a reload. The bundled avatar is deliberately *not* cached — it
  is already on disk. **✕ Remove** drops your model and brings the bundled one
  back, so the stage is never left blank.
- **The avatar never scrolls away.** The stage is pinned to the top of the page's
  own column and the transcript scrolls *inside* its box under it; sharing one
  scroller carried the avatar off the top of the page the moment a conversation got
  long enough to read. Only a very short window falls back to scrolling the column.
- **The transcript reads newest-first.** Appending put each turn at the bottom of a
  list that only grows, so the line you were waiting for arrived off-screen; new
  turns now go on top, and only a *new* turn moves the scroll, so a streaming
  partial cannot yank you out of what you were reading.
- **The agent list loads here too.** This page used to be created with
  `loadOnInit: false` and never filled, so its dropdown stayed empty until you
  happened to focus it — which looked like "agents are not loading on this page".
  Opening the page also retries, for a first fetch that failed before the server
  had a key.
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

## Password protection

Set `APP_PASSWORD` and the whole studio — every page, script and API route —
sits behind a password prompt:

```bash
APP_PASSWORD='your-password' ./run.sh     # or put APP_PASSWORD=… in .env
```

Leave it unset and nothing changes, so local development stays open.

- **The gate is server-side.** An unauthenticated page request is redirected to
  `/login`; an unauthenticated `/api/*` request gets a `401` carrying
  `login_required`, which is the marker the app keys off. The marker matters: a
  bare 401 is also how a missing Fish API key fails, and that must not bounce
  you to a login page.
- **The session is a signed cookie, not a server-side table.** Nothing is kept
  in memory, so it survives a serverless instance being recycled and works
  across several of them.
- **Changing the password signs everyone out.** `SESSION_SECRET` keys the
  signature; without it the password itself is the key.
- `SESSION_HOURS` (default `168`, one week) sets the session lifetime;
  `LOGIN_MAX_ATTEMPTS` (default `8`) and `LOGIN_WINDOW_SECONDS` (default `300`)
  throttle guessing. The counter is per-instance, so on a hosted deployment each
  function instance counts separately.
- Setup shows **🔒 Sign out** when the gate is on, and the cookie is sent
  `HttpOnly`, `SameSite=Lax`, and `Secure` whenever the request arrives over
  HTTPS.
- **The harnesses keep working.** Everything in `tools/` that drives the UI
  reads `APP_PASSWORD` (environment first, then `.env`, as the server does) and
  signs in through `tools/session.cjs` before it starts. `verify_bake_contract.cjs`
  talks to `/api/visemes` with `fetch` rather than a page, and gets its cookie
  from the same helper's `apiCookie()`. With no password set the helper does
  nothing, so an open studio is unaffected. The one exception is
  `tools/compare_bakers.py`, which posts to `/api/visemes` over plain HTTP and
  needs an ungated studio or the session cookie.

## Deploying to Vercel

Three files plus an ignore list are what Vercel needs, and they are all in the
repo — `vercel` (or importing the Git repo) deploys the whole app as one Python
Function:

| File | Why |
| --- | --- |
| `pyproject.toml` | dependencies, plus `[tool.vercel] entrypoint = "server.main:app"` |
| `requirements.txt` | the same dependency list, for a builder that only reads this one |
| `vercel.json` | `maxDuration: 300`, and `includeFiles` so `web/**` and `tools/visemes.py` ship |
| `.vercelignore` | keeps `.env` (your key) and local state out of the upload |

Set the key as an environment variable — Project → Settings → Environment
Variables, or `vercel env add FISH_API_KEY`. The server prefers `FISH_API_KEY`
from the environment over `.env`, which matters because a deploy has no writable
`.env` to fall back to. Add `APP_PASSWORD` the same way (see [Password
protection](#password-protection)) — on a public deployment you almost
certainly want it, since the server holds your Fish key.

### Telling whether the deploy is current

The top-right corner of the window carries the commit this instance is running —
`62de502`. Open the deployed URL and `localhost` and compare the two: equal
shas mean the deploy has your latest commit.

The colour says which side you are looking at, because a sha on its own cannot
tell you whether you are on Vercel or on your own machine:

| Badge | Means |
| --- | --- |
| grey `62de502` | a clean local checkout |
| amber `62de502*` | local, with uncommitted changes |
| green `62de502` | Vercel, production |
| violet `62de502` | Vercel, a preview/branch deployment |
| `no commit` | no repo and no build metadata — see below |

The `*` matters more than it looks. A deploy is built from a commit, so it can
never carry uncommitted edits — which makes a dirty local tree the one case
where two *matching* shas still mean different code. Hover for the branch,
commit subject and deployment id; click to copy the full sha.

`/api/status` carries the same thing as `build`, from
`VERCEL_GIT_COMMIT_SHA` / `_REF` / `_MESSAGE` and `VERCEL_DEPLOYMENT_ID` on a
deploy, and from `git rev-parse` locally. Those system variables are populated
at **runtime** as well as build time — but only when **Enable access to System
Environment Variables** is ticked in Project → Settings → Environment
Variables. If it is not, the badge says `no commit` rather than showing a blank
or a stale sha, and the tooltip names the setting to check.

### What changes on a serverless host

The backend was written for a local machine: a writable project directory, a
system Python, and the game folder next door. It detects `VERCEL` and adapts.

| Local assumption | What a deploy does instead |
| --- | --- |
| `data/` is writable | Falls back to a temp directory and reports `data_dir_persistent: false`; takes and presets live as long as the instance. |
| `.env` is writable | Nothing is written. Setup says the key has to come from the host's environment instead of offering a save that cannot stick. |
| The baker runs on a system Python | Falls back to the function's own interpreter, which has `numpy` + `openfacefx` from the manifest. `tools/visemes.py` is a separate file rather than an import, so nothing can trace it — but a Python function is **not tree-shaken**: Vercel bundles every file reachable at build time, so it ships anyway and the `includeFiles` entry is a redundant safety net. If the script or the interpreter is missing the page now says so *before* you press Bake, instead of failing with a `502` naming a path you cannot see. |
| Allosaurus is available | It isn't: it requires torch, far past the Python bundle limit. The baker uses the Fish word-timing aligner instead (`aligner: "anchors"`) — the word boundaries are still Fish's own, only the phone-level shapes are coarser. |
| The game folder exists | It doesn't — so the avatar art comes from the copy bundled at `web/avatars/`. The preview draws normally; only *other* npcs are missing. `/api/lipsync/info` reports `avatar_source: "game"` or `"bundled"` so the two can be told apart. |
| No request size cap | Vercel rejects a body over 4.5 MB — **and a response over 4.5 MB too**. The Lip Sync page measures the WAV against the advertised limit and explains, rather than surfacing a bare `413`. See [the response cap](#the-4-5-mb-cap-is-on-both-directions). |

`/api/status` reports all of it — `hosted`, `data_dir_persistent`,
`key_source`, `max_upload_bytes`, `baker` — so the UI can state what a deploy
cannot do instead of failing obscurely.

### Limits that cannot be coded around

- **Duration.** A Hobby function is capped at 300 s *and* that is its maximum
  (Pro allows up to 800). The proxy's own HTTP timeout is 600 s, so a very long
  generation can still outlive the platform. `vercel.json` sets 300.
- **Body size.** 4.5 MB per request **or response**. A 60-minute `transcribe-1-pro`
  recording is 100+ MB and cannot be uploaded through a function at all. See
  [the 4.5 MB cap](#the-4-5-mb-cap-is-on-both-directions).
- **No persistent disk.** Takes, presets and uploaded reference audio are
  per-instance and disappear with it.
- **Function bundle size.** 250 MB uncompressed for most runtimes, **500 MB for
  Python**. A Python function is not tree-shaken — it ships every file reachable
  at build time — so the only lever is `excludeFiles` in `vercel.json`. That is
  why `pyproject.toml` / `requirements.txt` list runtime dependencies only: a
  test runner or a notebook kernel in there is dead weight on every cold start.
  (Vercel also offers large functions up to 5 GB on fluid compute.)

#### The avatar has to ship, not just be referenced

`/api/lipsync/info` hands the page two URLs for the default avatar:

    /api/avatar/33/33_default.png        the portrait
    /api/avatar/33/33_default_face.png   the mouth-shape atlas

Both are served out of `DIALOGUE_ROOT` — the game folder next door. A deploy has
no game folder, so `discover_avatars()` returned nothing, the fallback to those
two hard-coded URLs 404'd, and the Lip Sync canvas stayed blank. Nothing on
screen named the cause; the console showed only two failed image requests.

`web/avatars/33/` now carries a copy, and `web/**` is already in
`vercel.json`'s `includeFiles`, so it ships. The game folder is still searched
first, so a local preview keeps tracking the game rather than a stale snapshot.
`web/avatars/avatar.json` carries the matching `avatar` block from
`game_settings.json` (blink schedule, mouth-hold, viseme map) for the same
reason — without it the preview loses its blink timing and stops matching the
game it exists to preview.

`tools/verify_avatar_fallback.cjs` launches a server with `VERCEL=1` and a
`ROGUELIKE_ROOT` that does not exist — reproducing the deploy exactly — and
asserts the portrait still draws. It also fails if the bundled copy has drifted
from the game's:

```bash
node tools/verify_avatar_fallback.cjs
```

#### The 4.5 MB cap is on both directions

The request side is the obvious one. The response side is the one that bit.

Baking used to send the repaired WAV back alongside the sidecar, base64-encoded.
Base64 costs 4/3 the bytes (`ceil(n/3)*4`), so a request that fit under the
advertised 4.4 MB limit produced a response of `4/3 × 4.4 MB ≈ 5.9 MB` — over
the cap. The practical ceiling was therefore not 4.4 MB of audio but

    4.5 MB / (4/3)  ≈  3.38 MB  ≈  40 s at 44.1 kHz / 16-bit mono

and a line longer than that failed with no message naming the cause.

The echo is gone. It was redundant: `repair_wav` rewrites exactly two header
fields, and the browser already had the identical repair in `fixWavHeader()`.
`tools/verify_wav_repair.cjs` now proves the two agree byte-for-byte — over the
placeholder header Fish actually streams, an odd-sized chunk (which exercises
the `size & 1` pad step), a correct header, and a non-RIFF file. It runs as the
first block of `verify_lipsync.cjs` and standalone with no API credit:

```bash
node tools/verify_wav_repair.cjs
```

The response is now the sidecar alone — a few KB, flat in the length of the
audio — so the usable line length is the full request-side limit.

Local development is unchanged: without `VERCEL` the studio keeps `data/`, the
system Python and the game folder exactly as before.

## Layout

```
server/main.py      FastAPI: auth proxy + static host
pyproject.toml      dependencies + the Vercel entrypoint (server.main:app)
requirements.txt    the same dependencies, for builders that read only this one
vercel.json         Vercel: maxDuration + includeFiles for web/ and the baker
.vercelignore       keeps .env and local state out of a Vercel upload
web/                the studio (vanilla JS ES modules, no build step)
  js/drama3.js      the Drama 3 grammar: highlight, auto-tag, scene parsing
  js/studio.js      editor, generation, player, takes, inpainting
  js/scenes.js      multi-speaker dialogue
  js/voices.js      voice design + My Voices + library (with sample playback)
  js/voicepreview.js what ▶ does on a voice, shared by every list and picker
  js/voicepicker.js the one searchable voice-library popup, used by every view
  js/library.js     session-wide audio library (Studio → Lip Sync handoff)
  js/lipsync.js     lip sync page: actors, generate → bake → preview on the face
  js/convo.js       conversation-script parsing (DOM-free, unit-tested)
  js/examples.js    all 12 Drama 3 features as loadable examples
  js/agents.js      agents console
  js/agentcall.js   the call lifecycle both call pages share
  js/livecall.js    the Live Call page (binds agentcall to the live* ids)
  js/vrmcall.js     the VRM Call page: a three.js/three-vrm avatar whose mouth the call drives
  js/emote.js       ChatVRM's expression side — lip sync, emotions, blinking, look-at
  js/agentvars.js   an agent's variables.defaults on the server (the VRM URL lives here)
  vrm/              the bundled default avatar + idle clip (6.9 MB, served by the studio)
  avatars/33/       the 2D portrait + mouth-shape atlas, so Lip Sync works on a deploy
  avatars/avatar.json  the game's `avatar` block: blink, mouth-hold, viseme map
tools/visemes.py    the Fish-anchored viseme baker (openfacefx, optional allosaurus)
tools/fixtures/     the tracked bake fixture (a real streamed Fish line + anchors)
tools/bake_debug.py run the baker directly and print the real traceback
tools/compare_bakers.py  studio-only viseme checks (well-formed, loud-audio, phones, guard)
tools/verify_ui.cjs      headless-Chrome UI harness (75 checks)
tools/probe_variables.cjs  the agent-variables round trip + the variable-name rule (live API)
tools/probe_clone_fidelity.py  how faithfully each TTS model reproduces a reference voice
tools/verify_lipsync.cjs headless-Chrome lip-sync harness (63 checks, real API)
tools/verify_wav_repair.cjs  browser vs baker WAV-header repair, byte-for-byte (no API)
tools/verify_bake_contract.cjs  the bake response carries the sidecar, not the audio (no API)
tools/verify_avatar_fallback.cjs  the Lip Sync avatar on a deploy with no game folder (no API)
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
NODE_PATH=.../node_modules node tools/verify_ui.cjs        # 75/75, no credit needed
NODE_PATH=.../node_modules node tools/probe_duo.cjs        # two-hander + min-hold, no credit needed
NODE_PATH=.../node_modules node tools/verify_lipsync.cjs   # 63/63 — needs real API credit
NODE_PATH=.../node_modules node tools/probe_call_failures.cjs   # call errors, no credit
NODE_PATH=.../node_modules node tools/probe_vrm.cjs             # 53/53 — the bundled avatar, its idle clip, and an agent's body by URL
NODE_PATH=.../node_modules node tools/probe_vrm.cjs avatar.vrm  # also: my own model over the default
node tools/verify_wav_repair.cjs                           # 3/3 — the two WAV repairs agree byte-for-byte, no credit
node tools/verify_bake_contract.cjs                        # 6/6 — the bake response is flat in clip length, no credit
node tools/verify_avatar_fallback.cjs                      # 15/15 — the Lip Sync avatar on a deploy with no game folder
node tools/probe_variables.cjs                             # 9/9 — the agent-variables round trip (writes and restores one key)
python tools/probe_clone_fidelity.py                       # does the clone sound like the voice? (spends credit)
python tools/probe_clone_fidelity.py --vs-default           # …and how far it sits from the generic default voice
python tools/compare_bakers.py                                    # viseme correctness, no credit
python tools/compare_bakers.py --endpoint http://127.0.0.1:8756   # + the shipped HTTP path
FISH_UI_LIVE_PREVIEW=1 NODE_PATH=... node tools/verify_ui.cjs     # + presses ▶ on My Voices (spends credit)
```

`compare_bakers.py` needs the **system** Python (the one with `numpy`,
`openfacefx` and `allosaurus`), not the studio's venv — same reason
`tools/visemes.py` does.

`verify_ui.cjs` drives the running app in headless Chrome and asserts the studio,
tag insertion, wrapping, auto-tag, scenes, design, voice samples (including that
the sample MP3 is actually fetched from the CDN), the voice picker, **My Voices**,
the examples library, agents, modal, live view and settings all work — and that
the console is clean.

The My Voices checks compare the ids on screen against the API's own `self=true`
answer rather than counting cards. That page renders 100 well-formed tiles
whether or not the filter survives — dropping `self=true` silently turns it into
a second copy of the public library and looks entirely correct — so the check
asserts the shown ids *are* the account's and that no public id leaked in. It
also asserts every card has a live ▶ rather than the library's disabled one, and
that clicking a card reaches `#voiceId`. `FISH_UI_LIVE_PREVIEW=1` additionally
presses it and waits for playback, which is opt-in because it spends credit.

The picker and modal checks are built the same way, and two of them exist because
a check that cannot fail is not a check:

- **The de-duplication is reachable only by stubbing.** This account's voice is
  private, so the public listing never contains it and `adopt()`'s filter would
  be invisible — the check would pass against a picker that lists it twice. The
  harness injects the own voice into the public `/model` response instead, which
  is exactly the case the filter is for.
- **"The form survived" is checked with two marked fields.** The name field holds
  `MARKER-agent-name` and the voice id holds a non-id marker before the picker
  opens; afterwards the name must be unchanged (proving the *same* nodes came
  back, not a rebuilt form) and the voice id must be the first My Voices id.

Both were mutation-tested: dropping the modal stack, dropping `self=true`, and
severing the pick→field write each flip the intended checks to FAIL. One
prediction was wrong and worth recording — the de-dup check does *not* catch a
dropped `self=true`, because the stub feeds the own voice to both queries; the
group check catches that one instead.

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

`probe_vrm.cjs` is the avatar's harness, and its baseline takes no arguments — a
fresh browser profile has an empty IndexedDB, so it is checking exactly what a
first visit sees. It asserts the bundled avatar loads with no file picker, that
the agent dropdown is populated on *this* page and matches the Call page's, that
the transcript scrolls on its own with the newest turn on top and does not scroll
you into history, that a right-held drag actually moves the avatar (measured off
the canvas pixels — "the camera panned" and "the avatar moved" are not the same
claim), that the idle clip is bound *and advancing* (a bound mixer whose clock is
stopped would otherwise pass) and that it poses the body, that the clip's absolute
hip offset was removed, that the gaze still converges on the camera while the clip
plays (read by orbiting with a real drag, since the look-at target is parented to
it), that no track binds this clip's head, that the emote controller applies
ChatVRM's weights (neutral `×0.5`, an emotion `×0.25`, back to `×0.5` on neutral),
and that **✕ Remove** restores the bundled avatar. It also drives the real
Config tab to set an agent's VRM **URL**, asserts the URL is stored on the *agent*
(reading the API with `{fresh: true}`, because the cached read is the very value
the UI just wrote), that selecting that agent puts `source === 'agent-url'` on the
stage, that re-selecting it re-reads rather than keeping the previous body, that
there is no `.vrm` file input left anywhere in the panel, and that **✕ Remove**
clears the server key and leaves no trace on the account. Pass a `.vrm` and it
additionally loads it through the **real file picker**, waits for the *uploaded*
model by name rather than `model.loaded` (the default is already loaded, so that
alone would pass too early), and checks the clip is rebuilt for it — then asserts
the metadata parsed, the render loop is drawing (`triangles > 0`), a level down the
same wire the call's `onLevel` writes reaches the mouth expression and closes
again in silence, an auto-blink fires, and the Live Call page is unharmed. No API
key and no credit: a call cannot be started headlessly without a microphone and an
agent, so the level is injected through `window.__vrmcall.feed()` — everything
downstream of that point is the shipped path. On a machine without a GPU (a VM or
CI box), pass software WebGL:
`CHROME_ARGS="--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader"`.

`probe_variables.cjs` is a *measurement*, not a UI test, and it exists because the
whole agent-VRM feature rests on claims about `/v1/agent/agents/{id}/config` that
were worth checking rather than assuming: that a `variables`-only PATCH is
accepted, that it is a genuine **partial** patch (prompt/voice/llm are
fingerprinted before and after — if it were a full replace, setting a VRM URL
would erase the agent), that the value round-trips, that the map **replaces as a
whole** (so a read-modify-write is required and existing keys survive it), and
what a legal variable name is. It needs a real API key and no browser.

> **Harnesses that touch a live account must restore, not clean up.** This one and
> `probe_vrm.cjs` both write to a real agent on a real account, and both were
> originally written to "leave no trace" by *deleting* what they had written. That
> is only correct while the agent happens to be blank: the moment a `vrm_url` was
> actually configured, the harnesses overwrote it and then deleted it, and the
> `probe_variables` check for it reported a false failure because it asserted the
> key was *absent* rather than *unchanged*. Both now snapshot the agent's own
> value first and restore it verbatim, and both assert the restoration. A test
> that quietly destroys the configuration it is testing is worse than no test.

`probe_clone_fidelity.py` answers "does the clone actually sound like the voice?"
with numbers instead of an opinion, because the question came up and guessing at
it is easy. It takes public voices that ship a real `samples[0].audio`, synthesizes
each voice's own transcript through its own `reference_id` once per model, and
compares every synthesis to the *recording* on two speaker-identity proxies: the
mean log-mel spectrum (timbre) and median F0 from autocorrelation (pitch). It
reports the models ranked by distance to the reference. `--vs-default` is the
sharper version of the same idea — it measures how far a voice's output sits from
the *same text with no `reference_id`*, so "is this a strong clone or is it
drifting toward the default voice" is a number rather than a suspicion. It spends
a little credit and writes nothing.
