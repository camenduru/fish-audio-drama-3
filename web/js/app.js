// app.js — bootstrap: router, settings, status, API coverage

import { $, $$, el, toast, apiFetch, modal, close } from './api.js';
import { stopPreview } from './audio.js';
import { initStudio } from './studio.js';
import { initScenes } from './scenes.js';
import { initVoices } from './voices.js';
import { initExamples } from './examples.js';
import { initLipsync } from './lipsync.js';
import { initAgents } from './agents.js';
import { initLive } from './livecall.js';
import { initVrmCall } from './vrmcall.js';
import { initTagPicker } from './tags.js';

const VIEWS = {
  studio:  { title: 'Drama 3 Studio', sub: 'Direct a performance in plain language' },
  scenes:  { title: 'Scenes',         sub: 'Multi-speaker dialogue in one pass' },
  design:  { title: 'Voice Design',   sub: 'Generate a voice from a description' },
  library: { title: 'Voices',         sub: 'Your voice models and reference clips' },
  examples:{ title: 'Examples',       sub: 'Every Drama 3 feature, ready to load' },
  lipsync: { title: 'Lip Sync',       sub: 'Bake game-ready mouth tracks from a line' },
  agents:  { title: 'Agents',         sub: 'Design, publish and monitor voice agents' },
  live:    { title: 'Live Call',      sub: 'Talk to an agent in the browser' },
  vrmcall: { title: 'VRM Call',       sub: 'Give the agent a VRM body and talk to it' },
  settings:{ title: 'Setup',          sub: 'API key, account and API coverage' },
};

function route(name) {
  if (!VIEWS[name]) name = 'studio';
  stopPreview();
  $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $('#viewTitle').textContent = VIEWS[name].title;
  $('#viewSub').textContent = VIEWS[name].sub;
  location.hash = name;
}

// ---------------------------------------------------------------------------
async function refreshStatus() {
  try {
    const s = await apiFetch('/api/status');
    const badge = $('#keyBadge');
    badge.textContent = s.key_configured ? 'key ✓' : 'key missing';
    badge.className = 'badge ' + (s.key_configured ? 'green' : 'red');
    $('#setKeyStatus').textContent = s.key_configured ? `Key configured (${s.key_hint}).` : 'No key configured.';
  } catch (e) {
    $('#keyBadge').textContent = 'offline';
    $('#keyBadge').className = 'badge red';
  }
}

const API_COVERAGE = [
  ['Text to speech', 'POST /v1/tts', 'tts'],
  ['Stream + timestamps', 'POST /v1/tts/stream/with-timestamp', 'tts'],
  ['Voice design', 'POST /v1/voice-design', 'tts'],
  ['Voice models', 'GET/POST /model', 'tts'],
  ['Agents', 'CRUD /v1/agent/agents', 'agents'],
  ['Agent config', 'GET/PATCH /v1/agent/agents/{id}/config', 'agents'],
  ['Publish', 'POST /v1/agent/agents/{id}/publish', 'agents'],
  ['Versions', 'GET /v1/agent/agents/{id}/versions', 'agents'],
  ['Widget', 'GET /v1/agent/agents/{id}/widget', 'agents'],
  ['Sessions', 'GET/POST /v1/agent/sessions', 'agents'],
  ['Session detail', 'GET /v1/agent/sessions/{id}', 'agents'],
  ['Recording', 'GET /v1/agent/sessions/{id}/recording', 'agents'],
  ['Tools', 'CRUD /v1/agent/tools', 'agents'],
  ['Knowledge', 'CRUD /v1/agent/knowledge-sources', 'agents'],
  ['Tests', 'CRUD /v1/agent/tests', 'agents'],
  ['Test runs', 'GET /v1/agent/test-runs', 'agents'],
  ['Phone numbers', 'CRUD /v1/agent/phone-numbers', 'agents'],
  ['Outbound calls', 'POST /v1/agent/phone-calls', 'agents'],
  ['Wallet', 'GET /wallet/{user_id}/api-credit', 'account'],
];

function renderCoverage() {
  const box = $('#apiCoverage');
  box.replaceChildren(...API_COVERAGE.map(([name, path]) => el('div.kv', {}, [
    el('span.k', {}, name), el('span.v.mono', { style: 'font-size:11.5px' }, path),
  ])));
}

async function loadWallet() {
  const box = $('#walletBox');
  box.replaceChildren(el('div.hint', {}, 'Reading…'));
  try {
    const agents = await apiFetch('/api/fish/v1/agent/agents', {});
    // wallet needs a user id; try to read it from the first model response
    const models = await apiFetch('/api/fish/model?page_size=1&self=true', {});
    const uid = models?.items?.[0]?.author?._id || models?.items?.[0]?.author_id || models?.items?.[0]?.author?.id;
    if (!uid) { box.replaceChildren(el('div.hint', {}, 'Could not determine user id from the API.')); return; }
    const w = await apiFetch(`/api/fish/wallet/${uid}/api-credit`, {});
    box.replaceChildren(el('div.kv', {}, [el('span.k', {}, 'API credit'), el('span.v', {}, JSON.stringify(w))]));
  } catch (e) {
    box.replaceChildren(el('div.hint', {}, 'Credit check failed: ' + e.message));
  }
}

// ---------------------------------------------------------------------------
function initSettings() {
  $('#setKeySave').addEventListener('click', async () => {
    const key = $('#setKey').value.trim();
    if (!key) { toast('Paste a key first.', 'err'); return; }
    try { await apiFetch('/api/settings', { method: 'POST', body: { api_key: key } }); toast('Key saved.', 'ok'); $('#setKey').value = ''; refreshStatus(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#walletLoad').addEventListener('click', loadWallet);
  renderCoverage();
}

function initModal() {
  $('#modalClose').addEventListener('click', close);
  $('#modalBack').addEventListener('click', e => { if (e.target.id === 'modalBack') close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

// ---------------------------------------------------------------------------
function boot() {
  $$('.rail-btn').forEach(b => b.addEventListener('click', () => route(b.dataset.view)));
  window.addEventListener('hashchange', () => route(location.hash.slice(1)));
  initModal();
  initSettings();

  initStudio();
  initScenes();
  initVoices();
  initExamples();
  initLipsync();
  initAgents();
  initLive();
  initVrmCall();
  initTagPicker();

  route(location.hash.slice(1) || 'studio');
  refreshStatus();
  console.log('%c🎭 Fish Audio Drama 3 Studio', 'font-size:14px;color:#ff7a59;font-weight:bold');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
