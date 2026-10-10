// livecall.js — in-browser voice calls with @fishaudio/agent-client

import { $, el, toast, apiFetch, fish, localStore, localSave } from './api.js';

let SDK = null;          // module namespace
let session = null;
let rafId = null;
let agents = [];
let lastError = null;    // the last start failure, unwrapped — see describeCallError

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
function classifyCallError(e) {
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
function describeCallError(e) {
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

// ---------------------------------------------------------------------------
async function loadAgentOptions() {
  const selEl = $('#liveAgent');
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
  const saved = localStore('lastAgent', '');
  if (saved && agents.some(a => a.agent_id === saved)) selEl.value = saved;
}

// ---------------------------------------------------------------------------
function bubble(role, text, id) {
  const chat = $('#liveChat');
  let b = id ? chat.querySelector(`[data-id="${id}"]`) : null;
  if (!b) {
    b = el('div.bubble.' + role, { dataset: id ? { id } : {} });
    chat.append(b);
  }
  b.textContent = text;
  b.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return b;
}

function setMode(mode) {
  $('#liveOrb').className = 'orb ' + mode;
  $('#liveMode').textContent = ({ listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' }[mode]) || mode || '—';
}

function startVisualizer() {
  const wave = $('#liveWave');
  const draw = () => {
    if (!session) return;
    try {
      const fft = session.getOutputFrequencyData?.();
      if (fft && fft.length) {
        const n = 40, step = Math.floor(fft.length / n) || 1;
        const bars = [];
        for (let i = 0; i < n; i++) bars.push(Math.max(4, (fft[i * step] / 255) * 100));
        wave.replaceChildren(...bars.map(h => el('i', { style: `height:${h}%` })));
      }
      const iv = session.getInputVolume?.() ?? 0;
      $('#liveOrb').style.setProperty('--mic', iv);
    } catch {}
    rafId = requestAnimationFrame(draw);
  };
  draw();
}

// ---------------------------------------------------------------------------
const CLIENT_TOOLS = {
  show_time: () => ({ time: new Date().toLocaleTimeString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  open_page: (p) => { toast('open_page → ' + (p?.page ?? JSON.stringify(p))); return { opened: true, page: p?.page ?? null }; },
  highlight_product: (p) => { toast('highlight_product → ' + (p?.name ?? JSON.stringify(p))); return { highlighted: true }; },
};

async function startCall() {
  const agentId = $('#liveAgent').value;
  if (!agentId) { toast('Pick an agent.', 'err'); return; }
  localSave('lastAgent', agentId);
  const agent = agents.find(a => a.agent_id === agentId);
  const btn = $('#liveStart');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Connecting…';
  $('#liveChat').replaceChildren();
  try {
    const blocked = preflightCall();
    if (blocked) throw new Error(blocked);

    const { AgentSession } = await loadSdk();
    const opts = {
      clientTools: CLIENT_TOOLS,
      toolEvents: $('#liveToolEvents').checked,
      callbacks: {
        onStatusChange: s => { $('#liveStatus').textContent = s; },
        onModeChange: setMode,
        onUserTranscript: ({ segmentId, text, final }) => bubble('user', text, 'u_' + segmentId),
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
          $('#liveReason').textContent = reason;
          $('#liveStatus').textContent = 'ended';
          stopVisualizer(); toggleLiveUi(false);
          bubble('tool', '— call ended: ' + reason + ' —');
        },
      },
    };

    if (agent?.public_enabled) {
      opts.agentId = agentId;
      session = await AgentSession.start(opts);
    } else {
      const token = await apiFetch('/api/sessions', { method: 'POST', body: { agent_id: agentId } });
      session = await AgentSession.start({ ...opts, sessionToken: token });
    }
    $('#liveSid').textContent = session.sessionId || '—';
    $('#liveTransport').textContent = 'livekit (WebRTC)';
    toggleLiveUi(true);
    setMode('listening');
    startVisualizer();
    toast('Connected.', 'ok');
  } catch (e) {
    lastError = { ...classifyCallError(e), message: e?.message, at: Date.now() };
    console.error('[livecall] start failed', e);
    toast('Could not start call: ' + describeCallError(e), 'err');
    toggleLiveUi(false);
  } finally {
    btn.disabled = false; btn.textContent = '🎙 Start call';
  }
}

function toggleLiveUi(live) {
  $('#liveStart').classList.toggle('hidden', live);
  $('#liveEnd').classList.toggle('hidden', !live);
  $('#liveMute').classList.toggle('hidden', !live);
  $('#liveText').disabled = !live;
  $('#liveSend').disabled = !live;
  $('#liveStatus').textContent = live ? 'live' : 'idle';
  if (!live) { $('#liveOrb').className = 'orb'; $('#liveMode').textContent = '—'; $('#liveWave').replaceChildren(); }
}

function stopVisualizer() { if (rafId) cancelAnimationFrame(rafId); rafId = null; session = null; }

async function endCall() {
  try { await session?.end(); } catch {}
  stopVisualizer(); toggleLiveUi(false);
  $('#liveReason').textContent = $('#liveReason').textContent || 'user_hangup';
}

// ---------------------------------------------------------------------------
export function initLive() {
  $('#liveAgent').addEventListener('focus', () => { if (!agents.length) loadAgentOptions(); }, { once: true });
  $('#liveStart').addEventListener('click', startCall);
  $('#liveEnd').addEventListener('click', endCall);
  $('#liveMute').addEventListener('click', () => {
    if (!session) return;
    const m = !session.micMuted;
    session.setMicMuted(m);
    $('#liveMute').textContent = m ? '🔊 Unmute' : '🔇 Mute';
  });
  $('#liveSend').addEventListener('click', sendText);
  $('#liveText').addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });
  $('#liveText').addEventListener('input', () => session?.sendUserActivity?.());
  $('#liveToolEvents').addEventListener('change', () => toast('Takes effect on the next call.'));
  loadAgentOptions();

  // Read-only snapshot for the end-to-end harness. The toast disappears after
  // 4 s and carries only a summary, so a test that wants to know *why* a call
  // failed needs the unwrapped chain and the agent's real publish state.
  window.__livecall = () => ({
    status: $('#liveStatus')?.textContent,
    mode: $('#liveMode')?.textContent,
    agent: $('#liveAgent')?.value || '',
    agents: agents.map(a => ({
      agent_id: a.agent_id, name: a.name,
      public_enabled: !!a.public_enabled, publication_state: a.publication_state,
    })),
    live: !$('#liveStart')?.classList.contains('hidden'),
    sessionId: session?.sessionId || null,
    lastError,
    toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent),
  });
}

function sendText() {
  const v = $('#liveText').value.trim();
  if (!v || !session) return;
  session.sendUserMessage(v);
  bubble('user', v, null);
  $('#liveText').value = '';
}

export { loadAgentOptions };
