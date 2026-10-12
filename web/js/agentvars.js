// agentvars.js — an agent's 🔤 Variables, as they live on the server.
//
// Why this module exists: everything else about an agent is stored by Fish
// (`prompt`, `voice`, `llm`, …), but a VRM is not — the API has no avatar field
// at all. `variables.defaults` is the one agent-scoped string map the API does
// expose, so a *URL* to a model lives there and travels with the agent.
//
// That is the whole reason the agent's VRM is a URL and not a file: bytes kept
// in the browser would be worn only in the browser that uploaded them.
//
// Measured against the live API (tools/probe_variables.cjs):
//
//   * `PATCH /v1/agent/agents/{id}/config` with `{"variables":{"defaults":{…}}}`
//     returns 200, and is a genuine PARTIAL patch — prompt/voice/llm are left
//     alone. (Checked explicitly; if it were a full replace, writing one key
//     would erase the agent.)
//   * The value round-trips and reads back identically.
//   * The map REPLACES AS A WHOLE. Sending `{vrm_url: x}` to an agent that
//     already had `{tone: 'warm'}` deletes `tone`. Hence every write here is
//     read-modify-write, and the whole current map is spread back in.
//
// The read-modify-write is not atomic — the API offers no compare-and-set — so
// two writers racing can still lose one update. It is the best the API allows,
// and far better than the alternative of sending a map from memory that is
// minutes old.

import { fish } from './api.js';

/** The key the VRM URL is stored under. Also the `{{placeholder}}` name. */
export const VRM_URL_KEY = 'vrm_url';

// ---------------------------------------------------------------------------
// A short-lived cache.
//
// `loadBodyFor()` reads the URL every time the agent dropdown changes, and the
// Config tab reads it when it opens. Without a cache that is two or three
// round trips to the same endpoint in a second, for a value that changes only
// when this very module changes it — and writes invalidate it, so a stale read
// is not possible through the UI.
// ---------------------------------------------------------------------------
const TTL_MS = 10_000;
const cache = new Map();          // agentId -> { at, variables }
const inflight = new Map();       // agentId -> Promise, so parallel readers share one GET

const idOf = agentId => String(agentId || '').trim();

/** Drop the cached copy for one agent, or all of them when called bare. */
export function clearAgentVarsCache(agentId) {
  if (agentId === undefined) cache.clear();
  else cache.delete(idOf(agentId));
}

/** The full `variables` object: `{ defaults, on_missing }`. */
export async function getAgentVariables(agentId, { fresh = false } = {}) {
  const id = idOf(agentId);
  if (!id) return {};
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.variables;

  const existing = inflight.get(id);
  if (existing && !fresh) return existing;

  const p = (async () => {
    const cfg = await fish.get(`v1/agent/agents/${id}/config`);
    const variables = cfg?.variables || {};
    cache.set(id, { at: Date.now(), variables });
    return variables;
  })();
  inflight.set(id, p);
  try { return await p; } finally { inflight.delete(id); }
}

/**
 * One default value, or `null` when unset.
 *
 * `null` rather than `undefined` on purpose: this is read from a network
 * response, and a caller checking `if (!v)` should not have to care which of
 * the two flavours of "nothing" came back.
 */
export async function getAgentVar(agentId, key, opts) {
  const variables = await getAgentVariables(agentId, opts);
  const v = variables?.defaults?.[key];
  return v === undefined || v === null || v === '' ? null : v;
}

/** The whole defaults map, as a plain object. Never null. */
export async function getAgentVarDefaults(agentId, opts) {
  const variables = await getAgentVariables(agentId, opts);
  return { ...(variables?.defaults || {}) };
}

// ---------------------------------------------------------------------------
// Change notifications: the URL is set on the agent's Config tab but *worn* on
// the VRM Call page, and a page that keeps showing the old body after an edit
// reads as "the edit did nothing".
// ---------------------------------------------------------------------------
const listeners = new Set();

/** Subscribe to writes. Returns an unsubscribe function. */
export function onAgentVarsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(agentId) {
  for (const fn of listeners) {
    try { fn(agentId); } catch { /* one bad listener must not stop the rest */ }
  }
}

/**
 * Write one default. Read-modify-write, because the map replaces as a whole —
 * see the header. Returns the new defaults map.
 */
export async function setAgentVar(agentId, key, value) {
  const id = idOf(agentId);
  if (!id) throw new Error('no agent id');
  if (!key) throw new Error('no variable name');
  const current = await getAgentVarDefaults(id, { fresh: true });
  const defaults = { ...current, [key]: value };
  await fish.patch(`v1/agent/agents/${id}/config`, { variables: { defaults } });
  cache.set(id, { at: Date.now(), variables: { ...(cache.get(id)?.variables || {}), defaults } });
  notify(id);
  return defaults;
}

/** Remove one default. A no-op write is skipped so a missing key costs no PATCH. */
export async function deleteAgentVar(agentId, key) {
  const id = idOf(agentId);
  if (!id) return null;
  const current = await getAgentVarDefaults(id, { fresh: true });
  if (!(key in current)) return current;
  const defaults = { ...current };
  delete defaults[key];
  await fish.patch(`v1/agent/agents/${id}/config`, { variables: { defaults } });
  cache.set(id, { at: Date.now(), variables: { ...(cache.get(id)?.variables || {}), defaults } });
  notify(id);
  return defaults;
}

// ---------------------------------------------------------------------------
// The VRM URL, the one variable this studio defines.
// ---------------------------------------------------------------------------

/**
 * Only http(s) is accepted. A `javascript:` or `data:` URL in a value that is
 * later handed to `fetch()` is not a model, and there is no reason to store one
 * — this is the validation, not decoration.
 */
export function normalizeVrmUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { throw new Error('that is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs can be loaded');
  return u.href;
}

export const getAgentVrmUrl = agentId => getAgentVar(agentId, VRM_URL_KEY);
export const setAgentVrmUrl = (agentId, url) => setAgentVar(agentId, VRM_URL_KEY, normalizeVrmUrl(url));
export const deleteAgentVrmUrl = agentId => deleteAgentVar(agentId, VRM_URL_KEY);
