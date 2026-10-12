// app.js — bootstrap: router, settings, status, API coverage

import { $, $$, el, toast, apiFetch, modal, close } from './api.js';
import { stopPreview } from './audio.js';
import { initStudio } from './studio.js';
import { initScenes } from './scenes.js';
import { initVoices, initMyVoices } from './voices.js';
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
  myvoices:{ title: 'My Voices',      sub: 'Every voice this account has created' },
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
// ---------------------------------------------------------------------------
/**
 * The commit badge — the quickest way to tell whether a deploy is current.
 *
 * Open the deployed URL and localhost and compare the two shas: equal means
 * Vercel is running your latest commit. Colour says which side you are looking
 * at, because a sha on its own cannot tell you whether you are on Vercel or on
 * your own machine — and a dirty local tree is the one case where matching
 * shas still mean different code.
 *
 *   green  — Vercel, production
 *   violet — Vercel, a preview/branch deployment
 *   amber  — local with uncommitted changes (the sha does NOT describe this code)
 *   grey   — local, clean
 */
function renderCommitBadge(b) {
  const node = $('#commitBadge');
  if (!node) return;

  const sha = b?.commit;
  if (!sha) {
    node.textContent = 'no commit';
    node.className = 'badge commit';
    node.title = b?.commit_source === 'none'
      ? 'This instance could not read a commit: there is no git repo here, and no ' +
        'Vercel build metadata. On a deploy that usually means "Enable access to ' +
        'System Environment Variables" is unticked in Project Settings.'
      : 'Commit unknown.';
    delete node.dataset.full;
    return;
  }

  const hosted = b.commit_source === 'vercel';
  const where = hosted
    ? (b.deploy_env === 'production' ? 'Vercel · production'
      : b.deploy_env ? `Vercel · ${b.deploy_env}` : 'Vercel')
    : 'local (this machine)';

  node.textContent = sha + (b.commit_dirty ? '*' : '');
  node.className = 'badge commit ' + (hosted
    ? (b.deploy_env === 'production' ? 'green' : 'violet')
    : (b.commit_dirty ? 'amber' : ''));
  node.title = [
    `${where} — ${sha}`,
    b.commit_ref ? `branch ${b.commit_ref}` : null,
    b.commit_message || null,
    b.deployment_id ? `deployment ${b.deployment_id}` : null,
    '',
    b.commit_dirty
      ? 'The working tree has uncommitted edits, so this is NOT what a deploy of ' +
        'this sha contains.'
      : 'Compare with the other instance — equal shas mean the deploy is current.',
    'Click to copy the full sha.',
  ].filter(v => v !== null).join('\n');
  node.dataset.full = b.commit_full || sha;
}

async function refreshStatus() {
  try {
    const s = await apiFetch('/api/status');
    const badge = $('#keyBadge');
    badge.textContent = s.key_configured ? 'key ✓' : 'key missing';
    badge.className = 'badge ' + (s.key_configured ? 'green' : 'red');
    // A deployed instance has nowhere to write .env, so the key has to come
    // from the host's environment — say which, rather than offering a save that
    // cannot stick.
    $('#setKeyStatus').textContent = s.key_configured
      ? (s.key_source === 'env'
          ? `Key configured from the environment (${s.key_hint}).`
          : `Key configured (${s.key_hint}).`)
      : (s.hosted
          ? 'No key: set FISH_API_KEY in this host\u2019s environment variables.'
          : 'No key configured.');
    // Only offered when this instance is actually behind the password gate.
    $('#lockRow').classList.toggle('hidden', !s.password_required);
    renderCommitBadge(s.build);
  } catch (e) {
    $('#keyBadge').textContent = 'offline';
    $('#keyBadge').className = 'badge red';
    // A failed /api/status means the badge cannot be trusted either — showing
    // the previous sha would be worse than showing nothing, since the whole
    // point is to tell two instances apart.
    renderCommitBadge(null);
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
  $('#lockOut').addEventListener('click', async () => {
    try { await apiFetch('/api/logout', { method: 'POST' }); } catch { /* leaving anyway */ }
    location.href = '/login';
  });

  $('#setKeySave').addEventListener('click', async () => {
    const key = $('#setKey').value.trim();
    if (!key) { toast('Paste a key first.', 'err'); return; }
    try {
      const r = await apiFetch('/api/settings', { method: 'POST', body: { api_key: key } });
      toast(r.key_persisted === false
        ? 'Key accepted for this instance, but this host has no writable disk — set FISH_API_KEY in its environment to make it stick.'
        : 'Key saved.', r.key_persisted === false ? 'err' : 'ok');
      $('#setKey').value = ''; refreshStatus();
    }
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

// The full sha is what you paste into Vercel's deployment list, so make the
// badge copy it rather than leaving you to retype seven characters.
function initCommitBadge() {
  const node = $('#commitBadge');
  if (!node) return;
  node.addEventListener('click', () => {
    const full = node.dataset.full;
    if (!full) { toast('No commit to copy on this instance.', 'err'); return; }
    navigator.clipboard?.writeText(full);
    toast(`Copied ${full}`);
  });
}

// ---------------------------------------------------------------------------
function boot() {
  $$('.rail-btn').forEach(b => b.addEventListener('click', () => route(b.dataset.view)));
  window.addEventListener('hashchange', () => route(location.hash.slice(1)));
  initModal();
  initSettings();
  initCommitBadge();

  initStudio();
  initScenes();
  initVoices();
  initMyVoices();
  initExamples();
  initLipsync();
  initAgents();
  initLive();
  initVrmCall();
  initTagPicker();

  // The avatar is the front door: an empty hash lands on VRM Call, and any
  // other page is still reachable by its own hash or the rail.
  route(location.hash.slice(1) || 'vrmcall');
  refreshStatus();
  console.log('%c🎭 Fish Audio Drama 3 Studio', 'font-size:14px;color:#ff7a59;font-weight:bold');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
