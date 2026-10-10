// livecall.js — in-browser voice calls with @fishaudio/agent-client

import { $, el, toast, apiFetch, fish, localStore, localSave } from './api.js';

let SDK = null;          // module namespace
let session = null;
let rafId = null;
let agents = [];

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
        onError: err => toast('Call error: ' + (err?.code || err?.message || err), 'err'),
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
    toast('Could not start call: ' + e.message, 'err');
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
}

function sendText() {
  const v = $('#liveText').value.trim();
  if (!v || !session) return;
  session.sendUserMessage(v);
  bubble('user', v, null);
  $('#liveText').value = '';
}

export { loadAgentOptions };
