// probe_variables.cjs — can an agent's 🔤 Variables defaults live on the server?
//
// The question this answers, in one run, against the real account:
//
//   1. GET  …/config          → read the current `variables.defaults`
//   2. PATCH …/config         → write one extra key (vrm_url)
//   3. GET  …/config          → read it back
//   4. PATCH …/config         → restore the ORIGINAL map byte-for-byte
//
// Step 4 is not optional. `variables.defaults` is documented as "the map
// replaces as a whole", so a probe that writes a test key and leaves it behind
// would silently edit the user's live agent. The original object is captured
// before anything is written and put back verbatim — including deleting the key
// entirely when there was no `variables` block to begin with.
//
// Usage: node tools/probe_variables.cjs [base]
const { apiCookie, studioPassword } = require('./session.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:8756';

// A key that cannot collide with a real setting. This used to be `vrm_url`,
// which is a real one — so once the account actually had a VRM URL set, the
// probe overwrote it and then reported the read-modify-write as broken. The
// collision made the check say the opposite of the truth.
//
// It also has to be a *legal* name: Fish validates these (see NAMING below), and
// a leading underscore is rejected with a 422.
const TEST_KEY = 'probe_rmw';
const TEST_VAL = 'probe-value';

// Measured against the live API. `vrm_url` is legal, which the whole VRM-URL
// feature depends on — so the rule is asserted below rather than trusted.
//   accepted: probe_rmw, Probe, p1, vrm_url, 60 chars
//   rejected: _probe, __probe, probe-rmw, probe.rmw, 1probe, "probe rmw", áccent
const NAMING = { legal: /^[A-Za-z][A-Za-z0-9_]*$/, illegal: ['_probe', 'probe-rmw', '1probe', 'probe rmw', 'áccent'] };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

async function main() {
  const cookie = await apiCookie(BASE);
  if (studioPassword() && !cookie) { console.error('could not sign in'); process.exit(2); }
  const h = { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
  const j = async (path, init) => {
    const res = await fetch(BASE + '/api/fish' + path, { ...init, headers: { ...h, ...(init?.headers || {}) } });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  };

  // Pick the first agent the account has.
  const list = await j('/v1/agent/agents?page_size=5');
  const agent = (list.body?.agents || [])[0];
  if (!agent) { console.error('no agents on this account to probe'); process.exit(2); }
  const id = agent.agent_id;
  console.log(`agent: ${agent.name} (${id})\n`);

  // 1 — the original state, captured before any write.
  const before = await j(`/v1/agent/agents/${id}/config`);
  check('GET config returns 200', before.status === 200, `status=${before.status}`);
  const origVars = before.body?.variables;
  const origDefaults = origVars?.defaults;
  console.log('  variables before:', JSON.stringify(origVars));

  // The single most dangerous assumption in this feature: that a PATCH carrying
  // only `variables` is a *partial* patch. If it were a full replace, then
  // "attach a VRM by URL" would silently wipe the agent's prompt and voice — so
  // the neighbours are fingerprinted here and compared after the write.
  const neighbours = JSON.stringify({ prompt: before.body?.prompt, voice: before.body?.voice, llm: before.body?.llm });

  // 1b — the naming rule. The whole feature stores its URL under `vrm_url`, so
  // "is that a legal variable name" is load-bearing, not trivia.
  check('the VRM_URL_KEY the client uses is a legal variable name',
        NAMING.legal.test('vrm_url'), 'vrm_url');
  const bad = [];
  for (const name of NAMING.illegal) {
    const r = await j(`/v1/agent/agents/${id}/config`, {
      method: 'PATCH', body: JSON.stringify({ variables: { defaults: { ...(origDefaults || {}), [name]: 'x' } } }),
    });
    if (r.status !== 422) bad.push(`${name}=${r.status}`);
  }
  check('names outside [A-Za-z][A-Za-z0-9_]* are rejected with a 422',
        bad.length === 0, bad.length ? `accepted: ${bad.join(', ')}` : `${NAMING.illegal.length} rejected`);

  // 2 — write. The map replaces as a whole, so the existing keys are spread back
  // in: this is the read-modify-write the client has to do.
  const patch = await j(`/v1/agent/agents/${id}/config`, {
    method: 'PATCH',
    body: JSON.stringify({ variables: { defaults: { ...(origDefaults || {}), [TEST_KEY]: TEST_VAL } } }),
  });
  check('PATCH variables.defaults accepted', patch.status === 200, `status=${patch.status}`);

  // 3 — read it back.
  const after = await j(`/v1/agent/agents/${id}/config`);
  const got = after.body?.variables?.defaults?.[TEST_KEY];
  check('the value round-trips through the server', got === TEST_VAL, `read back ${JSON.stringify(got)}`);
  // The real question: does a write of ONE key leave the agent's OTHER settings
  // alone? On this account `vrm_url` is a setting someone actually made, so the
  // check is asserting something with consequences, not a synthetic invariant.
  const afterDefaults = after.body?.variables?.defaults || {};
  const kept = Object.keys(origDefaults || {}).every(k => afterDefaults[k] === origDefaults[k]);
  check('existing defaults survive the write (read-modify-write works)', kept,
    `${Object.keys(origDefaults || {}).length} pre-existing key(s); now ${JSON.stringify(afterDefaults)}`);
  console.log('  variables after :', JSON.stringify(after.body?.variables));

  // The partial-patch assertion. A variables-only PATCH must not touch prompt,
  // voice or llm — otherwise attaching a VRM by URL would erase the agent.
  const afterNeighbours = JSON.stringify({ prompt: after.body?.prompt, voice: after.body?.voice, llm: after.body?.llm });
  check('a variables-only PATCH leaves prompt/voice/llm untouched', afterNeighbours === neighbours,
    afterNeighbours === neighbours ? 'identical' : `before=${neighbours}\n     after =${afterNeighbours}`);

  // 4 — restore. Always.
  const restoreBody = origVars === undefined
    ? { variables: {} }                       // there was no variables block at all
    : { variables: { defaults: origDefaults ?? {} } };
  const restore = await j(`/v1/agent/agents/${id}/config`, { method: 'PATCH', body: JSON.stringify(restoreBody) });
  check('restore PATCH returns 200', restore.status === 200, `status=${restore.status}`);

  const final = await j(`/v1/agent/agents/${id}/config`);
  const finalDefaults = final.body?.variables?.defaults ?? {};
  const originalDefaults2 = origDefaults ?? {};

  // "Restored" means back to what was there, NOT "empty". This agent is a real
  // one on a real account and `vrm_url` is a real setting someone may have made
  // — an earlier version of this check asserted the key was absent, which would
  // have passed only while the agent happened to have no URL, and reported a
  // false failure the moment one was set.
  const restoredExactly = JSON.stringify(finalDefaults) === JSON.stringify(originalDefaults2);
  check('the probe restored the agent exactly as it found it', restoredExactly,
    restoredExactly ? `defaults=${JSON.stringify(finalDefaults)}`
                    : `original=${JSON.stringify(originalDefaults2)} final=${JSON.stringify(finalDefaults)}`);
  console.log('  variables final :', JSON.stringify(final.body?.variables));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
