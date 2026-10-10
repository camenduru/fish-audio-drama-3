// agentcall.js — one reusable @fishaudio/agent-client call, bound to a set of DOM ids.
//
// The Live Call page and the VRM Call page are the *same* call. Both need the
// unwrapped error reporting, the microphone probe and text-first fallback, the
// session-leak cleanup, the transcripts and the client tools. So there is one
// implementation — this file — and each view supplies an element-id prefix
// ("live" / "vrm") plus an optional onLevel hook for its own visualiser.
//
// Every id a call touches is `<prefix><Suffix>`:
//   Agent Start End Mute Status Orb Mode Wave Chat Text Send Sid Transport
//   Reason ToolEvents TextOnly
// The hook is what lets the VRM page drive a mouth off the same output level the
// Live Call page draws as bars.

import { el, toast, apiFetch, fish, localStore, localSave } from './api.js';
import { attachTagButton } from './tags.js';

// The module namespace is process-wide: whichever view loads the SDK first,
// the other reuses it.
let SDK = null;

const CDNS = [
  'https://esm.sh/@fishaudio/agent-client@latest',
  'https://cdn.jsdelivr.net/npm/@fishaudio/agent-client/+esm',
  'https://unpkg.com/@fishaudio/agent-client?module',
];

async function loadSdk() {
  if (SDK) return SDK;
  let lastErr;
  for (const url of CDNS) {
    try { SDK = await import(/* @vite-ignore */ url); return SDK; }
    catch (e) { lastErr = e; }
  }
  throw new Error('Could not load @fishaudio/agent-client from any CDN. ' + (lastErr?.message || ''));
}

/**
 * Work out what actually went wrong, and say it in a way a human can act on.
 *
 * `@fishaudio/agent-client` funnels nearly every transport failure through one
 * message — "Could not establish the realtime session" — and hangs the real
 * reason on `.cause`. Printing only `.message` therefore throws away the only
 * useful part. Worse, the LiveKit transport awaits getUserMedia *outside* the
 * try/catch that produces that message, so a busy microphone, a missing
 * microphone and an insecure origin are all reported as a failed *session*:
 *
 *   NotReadableError (mic in use)  -> "Could not establish the realtime session"
 *   NotFoundError    (no mic)      -> "Could not establish the realtime session"
 *   mediaDevices undefined (http)  -> "Could not establish the realtime session"
 *   NotAllowedError  (denied)      -> "Microphone permission was denied"
 *
 * Only the last is distinguishable from the message alone. So classify on the
 * root cause, and keep the whole chain for the console.
 */
export function classifyCallError(e) {
  const chain = [];
  for (let cur = e, i = 0; cur && i < 6; cur = cur.cause, i++) chain.push(cur);
  const root = chain[chain.length - 1] || e;
  const names = chain.map(c => c.name).filter(Boolean);
  const codes = chain.map(c => c.code).filter(c => typeof c === 'string');

  const summary = chain
    .map(c => {
      const label = typeof c.code === 'string' ? c.code
        : (c.name && c.name !== 'Error' ? c.name : '');
      return [label, c.message || (typeof c === 'string' ? c : '')].filter(Boolean).join(': ');
    })
    .filter(Boolean)
    .filter((s, i, a) => a.indexOf(s) === i)
    .join('  ←  ') || 'unknown error';

  const has = n => names.includes(n);
  let hint = '';
  if (has('NotAllowedError') || codes.includes('mic_permission_denied')) {
    hint = 'the browser blocked the microphone — allow it for this site, then retry';
  } else if (has('NotReadableError') || has('AbortError')) {
    hint = 'the microphone could not be started — another app is probably using it';
  } else if (has('NotFoundError')) {
    hint = 'no microphone was found on this device';
  } else if (has('OverconstrainedError')) {
    hint = 'the selected microphone is unavailable';
  } else if (has('TypeError') && /getUserMedia/.test(root?.message || '')) {
    hint = 'WebRTC needs a secure origin — open the studio on http://localhost (or https), not a LAN IP';
  } else if (codes.includes('session_expired')) {
    hint = 'the session token expired before the call connected — just start it again';
  } else if (codes.includes('origin_forbidden')) {
    hint = "this page's origin is not in the agent's allowed origins";
  } else if (codes.includes('agent_not_public')) {
    hint = 'the agent is not published as public';
  } else if (codes.includes('unsupported_transport')) {
    hint = 'this session needs a newer @fishaudio/agent-client';
  } else if (codes.includes('session_request_failed')) {
    hint = 'the session request was rejected by the API';
  } else if (codes.includes('provider_error') || codes.includes('internal_error')) {
    hint = 'the agent runtime failed — see the console for the raw error';
  } else if (/did not join/i.test(summary)) {
    hint = 'the agent never joined the room — check that it is live and deployed in the Fish dashboard';
  } else if (codes.includes('connection_failed')) {
    hint = 'the WebRTC / LiveKit connection failed — check the network and try again';
  }
  return { summary, hint, code: codes[0] || null, rootName: root?.name || null };
}

/** One line for the toast; the full chain goes to the console and the seam. */
export function describeCallError(e) {
  const { summary, hint } = classifyCallError(e);
  return hint || summary;
}

/**
 * A call needs WebRTC, and WebRTC needs a secure origin. `navigator.mediaDevices`
 * is simply absent on a plain-HTTP page that is not localhost, which the SDK
 * then reports as a failed session. Catch it here, before spending a session
 * token, so the reason is unambiguous.
 */
function preflightCall() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This page is not a secure origin, so WebRTC is unavailable. '
         + 'Open the studio on http://localhost (or https) rather than a LAN IP or hostname.';
  }
  return '';
}

/**
 * Is there a microphone to capture?
 *
 * A call does not require one. Asking for it anyway is what turned "this device
 * has no mic" into "the call could not start": `getUserMedia` throws
 * NotFoundError, the SDK surfaces that as a failed *session*, and the only way
 * forward was a device the user does not have. So find out first and join
 * text-first when there is nothing to capture.
 *
 * `enumerateDevices` answers this without a permission prompt. An empty list is
 * the one answer worth acting on: browsers that withhold device *labels* before
 * permission still list the devices themselves, so a real microphone is visible
 * here even before the user has granted anything.
 */
async function hasMicrophone() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some(d => d.kind === 'audioinput');
  } catch {
    return true;   // cannot tell — attempt the mic and let the fallback catch it
  }
}

/**
 * Did this failure come from the microphone rather than from the session?
 *
 * The SDK reports a busy, missing, blocked or unplugged microphone through the
 * same "Could not establish the realtime session" message, so the only reliable
 * signal is the classified hint (see classifyCallError).
 */
function isMicFailure(e) {
  const { hint, code } = classifyCallError(e);
  return code === 'mic_permission_denied' || /microphone|\bmic\b/i.test(hint);
}

// ---------------------------------------------------------------------------
const CLIENT_TOOLS = {
  show_time: () => ({ time: new Date().toLocaleTimeString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  open_page: (p) => { toast('open_page → ' + (p?.page ?? JSON.stringify(p))); return { opened: true, page: p?.page ?? null }; },
  highlight_product: (p) => { toast('highlight_product → ' + (p?.name ?? JSON.stringify(p))); return { highlighted: true }; },
};

/**
 * Build one call bound to the elements `<id><Suffix>`.
 *
 * opts:
 *   id            element-id prefix ("live" | "vrm")
 *   loadOnInit    fetch the agent list at init (default true)
 *   storeKey      localStorage key remembering the chosen agent
 *   onLevel       (level01, fft) every animation frame while live — the seam a
 *                 visualiser or an avatar lip sync reads
 *   onMode        (mode, textOnly) after the built-in mode handling
 *   onEnd         (reason) once the call is gone
 *   tagLabel      label for the 🏷 directions button on the text box
 *   snapshotExtra () => extra fields merged into the debug snapshot
 */
export function createAgentCall({
  id = 'live',
  loadOnInit = true,
  storeKey = 'lastAgent',
  onLevel = null,
  onMode = null,
  onEnd = null,
  tagLabel = 'the message box',
  snapshotExtra = null,
} = {}) {
  const q = sel => document.getElementById(id + sel);

  let session = null;
  let rafId = null;
  let agents = [];
  let lastError = null;        // the last start failure, unwrapped — see classifyCallError
  let mintedSessionId = null;  // a session token we minted but never handed to the SDK
  let textOnly = false;        // this call joined without capturing a microphone
  let micAvailable = null;     // last mic probe: true/false, null before the first call

  /**
   * Release a session we minted but never handed to the SDK. The token has
   * already created a session server-side, and nothing else will end it.
   */
  function releaseMinted() {
    if (!mintedSessionId) return;
    const sid = mintedSessionId;
    mintedSessionId = null;
    apiFetch(`/api/sessions/${encodeURIComponent(sid)}/end`, { method: 'POST' })
      .catch(() => {});          // best effort: the server times it out anyway
  }

  // -------------------------------------------------------------------------
  async function loadAgents() {
    const selEl = q('Agent');
    if (!selEl) return agents;
    try {
      const data = await fish.get('v1/agent/agents', { page_size: 50 });
      agents = data.agents || [];
    } catch (e) {
      agents = [];
      toast('Could not list agents: ' + e.message, 'err');
    }
    selEl.replaceChildren(
      el('option', { value: '' }, agents.length ? 'Select an agent…' : 'No agents — create one first'),
      ...agents.map(a => el('option', { value: a.agent_id }, `${a.name}${a.publication_state === 'live' ? '' : ' (draft)'}${a.public_enabled ? ' · public' : ''}`)),
    );
    const saved = localStore(storeKey, '');
    if (saved && agents.some(a => a.agent_id === saved)) selEl.value = saved;
    return agents;
  }

  // -------------------------------------------------------------------------
  function bubble(role, text, bid) {
    const chat = q('Chat');
    if (!chat) return null;
    let b = bid ? chat.querySelector(`[data-id="${bid}"]`) : null;
    if (!b) {
      b = el('div.bubble.' + role, { dataset: bid ? { id: bid } : {} });
      chat.append(b);
    }
    b.textContent = text;
    b.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return b;
  }

  function setMode(mode) {
    const orb = q('Orb');
    if (orb) orb.className = 'orb ' + mode;
    const label = {
      listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…',
      text: 'Text mode — type below',
    }[mode];
    // Without a microphone there is nothing to listen to, so the runtime's own
    // "listening" is misleading here; say what the user should actually do.
    const modeEl = q('Mode');
    if (modeEl) {
      modeEl.textContent =
        textOnly && mode === 'listening' ? 'Text mode — type below' : (label || mode || '—');
    }
    onMode?.(mode, textOnly);
  }

  /**
   * The mute button doubles as the way *into* a microphone from a text-only
   * call: on a session started with `microphone: false`, the first unmute is
   * what captures and publishes it (and so is where the permission prompt
   * appears).
   */
  function updateMuteBtn() {
    const b = q('Mute');
    if (!b) return;
    if (!session) { b.textContent = '🔇 Mute'; return; }
    b.textContent = textOnly ? '🎙 Use microphone' : (session.micMuted ? '🔊 Unmute' : '🔇 Mute');
  }

  /**
   * One level, two consumers.
   *
   * The SDK exposes the agent's output two ways: `getOutputVolume()` (0–1, the
   * documented level meter) and `getOutputFrequencyData()` (the FFT the bars are
   * drawn from). Take the larger so a quiet-but-present voice still registers,
   * and hand the same number to every onLevel consumer.
   */
  function outputLevel() {
    if (!session) return { level: 0, fft: null };
    let level = 0;
    try { const v = session.getOutputVolume?.(); if (typeof v === 'number' && v >= 0) level = Math.min(1, v); } catch {}
    let fft = null;
    try { fft = session.getOutputFrequencyData?.() ?? null; } catch {}
    if (fft && fft.length) {
      // Speech energy lives in the low ~40% of the spectrum; an average over
      // those bins is a steadier level than a single bin.
      const n = Math.min(fft.length, Math.max(16, Math.floor(fft.length * 0.4)));
      let sum = 0;
      for (let i = 0; i < n; i++) sum += fft[i];
      level = Math.max(level, (sum / n) / 255);
    }
    return { level, fft };
  }

  function startVisualizer() {
    const wave = q('Wave');
    const draw = () => {
      if (!session) { rafId = null; return; }
      const { level, fft } = outputLevel();
      try {
        if (wave && fft && fft.length) {
          const n = 40, step = Math.floor(fft.length / n) || 1;
          const bars = [];
          for (let i = 0; i < n; i++) bars.push(Math.max(4, (fft[i * step] / 255) * 100));
          wave.replaceChildren(...bars.map(h => el('i', { style: `height:${h}%` })));
        }
        const orb = q('Orb');
        if (orb) orb.style.setProperty('--mic', session.getInputVolume?.() ?? 0);
      } catch {}
      onLevel?.(level, fft);
      rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  // -------------------------------------------------------------------------
  async function start() {
    const selEl = q('Agent');
    const agentId = selEl?.value;
    if (!agentId) { toast('Pick an agent.', 'err'); return; }
    localSave(storeKey, agentId);
    const agent = agents.find(a => a.agent_id === agentId);
    const btn = q('Start');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Connecting…'; }
    q('Chat')?.replaceChildren();
    try {
      const blocked = preflightCall();
      if (blocked) throw new Error(blocked);

      const { AgentSession } = await loadSdk();

      // Decide up front whether this call captures a microphone. `microphone:
      // false` is the SDK's documented text-first mode: it connects without
      // requesting one, and `sendUserMessage` answers with text rather than
      // speech. The call is otherwise a normal call — the agent, the transcripts
      // and the client tools all work; only the input is the keyboard.
      const forcedText = !!q('TextOnly')?.checked;
      micAvailable = await hasMicrophone();
      const wantMic = !forcedText && micAvailable;

      const opts = {
        clientTools: CLIENT_TOOLS,
        toolEvents: q('ToolEvents')?.checked ?? true,
        microphone: wantMic,
        callbacks: {
          onStatusChange: s => {
            const st = q('Status');
            if (st) st.textContent = textOnly && s === 'connected' ? 'live · text' : s;
          },
          onModeChange: setMode,
          onUserTranscript: ({ segmentId, text }) => bubble('user', text, 'u_' + segmentId),
          onAgentResponseDelta: ({ segmentId, text }) => bubble('agent', text, 'a_' + segmentId),
          onAgentResponse: ({ segmentId, text }) => bubble('agent', text, 'a_' + segmentId),
          onToolCallStarted: ({ toolName, input }) => bubble('tool', `⚙ ${toolName}(${String(input).slice(0, 80)})`),
          onToolCallCompleted: ({ toolName }) => bubble('tool', `✓ ${toolName}`),
          onToolCallFailed: ({ toolName, error }) => bubble('tool', `✗ ${toolName}: ${error}`),
          onError: err => {
            lastError = { ...classifyCallError(err), message: err?.message, at: Date.now() };
            toast('Call error: ' + describeCallError(err), 'err');
          },
          onDisconnect: ({ reason }) => {
            const reasonEl = q('Reason'); if (reasonEl) reasonEl.textContent = reason;
            const st = q('Status'); if (st) st.textContent = 'ended';
            stopVisualizer();
            toggleUi(false);
            bubble('tool', '— call ended: ' + reason + ' —');
            onEnd?.(reason);
          },
        },
      };

      // One connect, parameterised by whether it takes the microphone, so the
      // text-only retry below is the same code path rather than a second one.
      const connect = async useMic => {
        const o = { ...opts, microphone: useMic };
        if (agent?.public_enabled) {
          o.agentId = agentId;
          return AgentSession.start(o);
        }
        const token = await apiFetch('/api/sessions', { method: 'POST', body: { agent_id: agentId } });
        // Remember the id: if the connect below fails, the token has already
        // minted a session server-side and nothing else will release it.
        mintedSessionId = token?.session_id || null;
        return AgentSession.start({ ...o, sessionToken: token });
      };

      textOnly = !wantMic;
      try {
        session = await connect(wantMic);
      } catch (e) {
        // A microphone we thought we had — busy, blocked, or unplugged between
        // the check above and the capture — must not cost the user the call.
        // Retry without it rather than reporting a dead session.
        if (!wantMic || !isMicFailure(e)) throw e;
        releaseMinted();
        session = await connect(false);
        textOnly = true;
        toast('No usable microphone — joined in text mode.', '');
      }

      mintedSessionId = null;    // the SDK owns it from here
      // Best effort: unlock playback so the agent's first spoken reply is not
      // swallowed by the autoplay policy. The click that started the call is the
      // gesture. sendText() repeats this, where a gesture is guaranteed.
      session.startAudio?.().catch(() => {});
      const sid = q('Sid'); if (sid) sid.textContent = session.sessionId || '—';
      const tr = q('Transport'); if (tr) tr.textContent = textOnly ? 'livekit (WebRTC) · text-only' : 'livekit (WebRTC)';
      const text = q('Text');
      if (text) text.placeholder = textOnly ? 'Type your message…' : 'Type instead of talking…';
      toggleUi(true);
      setMode(textOnly ? 'text' : 'listening');
      updateMuteBtn();
      startVisualizer();
      toast(textOnly ? 'Connected — type below to talk.' : 'Connected.', 'ok');
      if (textOnly) text.focus();
    } catch (e) {
      lastError = { ...classifyCallError(e), message: e?.message, at: Date.now() };
      console.error(`[${id}call] start failed`, e);
      toast('Could not start call: ' + describeCallError(e), 'err');
      toggleUi(false);
      // Release the session the failed attempt already minted, so retrying a
      // broken call does not pile abandoned sessions onto the account.
      releaseMinted();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🎙 Start call'; }
    }
  }

  function toggleUi(live) {
    q('Start')?.classList.toggle('hidden', live);
    q('End')?.classList.toggle('hidden', !live);
    q('Mute')?.classList.toggle('hidden', !live);
    const text = q('Text'); if (text) text.disabled = !live;
    const send = q('Send'); if (send) send.disabled = !live;
    const st = q('Status'); if (st) st.textContent = live ? (textOnly ? 'live · text' : 'live') : 'idle';
    if (!live) {
      textOnly = false;                  // the next call re-evaluates the mic
      const orb = q('Orb'); if (orb) orb.className = 'orb';
      const modeEl = q('Mode'); if (modeEl) modeEl.textContent = '—';
      q('Wave')?.replaceChildren();
    }
  }

  function stopVisualizer() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    session = null;
    onLevel?.(0, null);
  }

  async function end() {
    try { await session?.end(); } catch {}
    stopVisualizer();
    toggleUi(false);
    const reasonEl = q('Reason');
    if (reasonEl) reasonEl.textContent = reasonEl.textContent || 'user_hangup';
    onEnd?.('user_hangup');
  }

  async function sendText() {
    const input = q('Text');
    const v = input?.value.trim();
    if (!v || !session) return;
    input.value = '';
    // Two things must be true before the agent can be *heard* on a text-first
    // call. A typed turn is answered with text only unless we ask for audio — the
    // SDK's default, and the reason a no-mic call was silent. And the browser's
    // autoplay policy blocks playback that did not start from a gesture, which
    // this click (or Enter) is, so it is the right place to unlock it.
    try { await session.startAudio(); } catch {}
    session.sendUserMessage(v, { audio: true });
    // No bubble here: the SDK's onUserTranscript owns the user's side of the
    // transcript. Drawing one too is what showed every typed line twice.
  }

  // -------------------------------------------------------------------------
  function init() {
    const agentEl = q('Agent');
    agentEl?.addEventListener('focus', () => { if (!agents.length) loadAgents(); }, { once: true });
    q('Start')?.addEventListener('click', start);
    q('End')?.addEventListener('click', end);
    q('Mute')?.addEventListener('click', async () => {
      if (!session) return;
      // On a text-only call the button is the way *in*: unmuting captures the mic.
      const muted = textOnly ? false : !session.micMuted;
      try {
        await session.setMicMuted(muted);
      } catch (e) {
        // This is where a missing or denied microphone surfaces on a text-only
        // session. Stay text-only — the call is still perfectly usable.
        toast('Could not use the microphone: ' + describeCallError(e), 'err');
        updateMuteBtn();
        return;
      }
      if (!muted) {
        textOnly = false;
        setMode('listening');
        toast('Microphone on.', 'ok');
      }
      updateMuteBtn();
    });
    q('Send')?.addEventListener('click', sendText);
    const text = q('Text');
    text?.addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });
    text?.addEventListener('input', () => session?.sendUserActivity?.());
    // Directions work on typed turns too, so the library is worth having here.
    if (text && text.parentElement && q('Send')) {
      text.parentElement.insertBefore(
        attachTagButton(text, { label: tagLabel }),
        q('Send'),
      );
    }
    q('ToolEvents')?.addEventListener('change', () => toast('Takes effect on the next call.'));
    q('TextOnly')?.addEventListener('change', () => toast('Takes effect on the next call.'));
    if (loadOnInit) loadAgents();
  }

  const snapshot = () => ({
    status: q('Status')?.textContent,
    mode: q('Mode')?.textContent,
    agent: q('Agent')?.value || '',
    agents: agents.map(a => ({
      agent_id: a.agent_id, name: a.name,
      public_enabled: !!a.public_enabled, publication_state: a.publication_state,
    })),
    // toggleUi() hides the start button while a call is up, so the button
    // being hidden IS the live state. (This expression used to be negated, so
    // the seam reported `live: true` whenever no call was running.)
    live: !!q('Start')?.classList.contains('hidden'),
    sessionId: session?.sessionId || null,
    textOnly,
    micMuted: session?.micMuted ?? null,
    micAvailable,
    lastError,
    toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent),
    ...(snapshotExtra ? snapshotExtra() : {}),
  });

  return {
    init,
    loadAgents,
    start,
    end,
    snapshot,
    isLive: () => !!q('Start')?.classList.contains('hidden'),
    getSession: () => session,
    hasAgents: () => agents.length > 0,
  };
}
