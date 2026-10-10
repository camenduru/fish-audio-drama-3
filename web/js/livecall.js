// livecall.js — the Live Call page: in-browser voice calls with @fishaudio/agent-client.
//
// The call itself lives in agentcall.js, because the VRM Call page runs the very
// same call and only differs in what it does with the audio. This module is the
// binding: the `live` element ids, the agent list, and the window.__livecall seam
// the call probes read.

import { createAgentCall } from './agentcall.js';

let call = null;

export function initLive() {
  call = createAgentCall({
    id: 'live',
    storeKey: 'lastAgent',
    tagLabel: 'the message box',
  });
  call.init();

  // Read-only snapshot for the end-to-end harness. The toast disappears after
  // 4 s and carries only a summary, so a test that wants to know *why* a call
  // failed needs the unwrapped chain and the agent's real publish state.
  window.__livecall = () => call.snapshot();
}

/** Kept as a named export for callers that want to (re)load the agent list. */
export function loadAgentOptions() {
  return call ? call.loadAgents() : Promise.resolve([]);
}
