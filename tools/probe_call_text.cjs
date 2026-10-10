/**
 * Can a call start with no microphone, and be held by typing?
 *
 * A call used to require a mic: the SDK defaults to `microphone: true`, so on a
 * device without one `getUserMedia` throws NotFoundError, the SDK reports it as
 * a failed *session*, and the app said "Could not start call: no microphone was
 * found on this device". The "Type instead of talking…" box existed but was
 * disabled until a call was live, so there was no way in.
 *
 * Two phases, because there are two ways to end up text-only:
 *   AUTO   — the browser has no audio input at all (Chrome launched without the
 *            fake device). The mic probe must notice and join text-first.
 *   FORCED — the "Text only (no microphone)" switch, on a browser that does
 *            have one. The mic must not even be requested.
 *
 * Costs one session per phase.  Usage: node tools/probe_call_text.cjs [agent_id]
 */
const puppeteer = require('puppeteer-core');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

/** Launch, drive one call, and report what the app did. */
async function phase(label, { fakeDevice, forceTextOnly, expectText, agentId }) {
  const args = ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'];
  // The fake device is what gives a headless Chrome a microphone. Leaving it
  // out is the only way to get a genuinely mic-less browser.
  if (fakeDevice) args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args,
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto(APP + '/#live', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1500);

  const devices = await page.evaluate(async () => {
    const d = await navigator.mediaDevices.enumerateDevices();
    return d.filter(x => x.kind === 'audioinput').length;
  });

  await page.evaluate(id => {
    const sel = document.querySelector('#liveAgent');
    if (![...sel.options].some(o => o.value === id)) {
      sel.append(Object.assign(document.createElement('option'), { value: id, text: 'probe agent' }));
    }
    sel.value = id;
  }, agentId);

  if (forceTextOnly) {
    const has = await page.$('#liveTextOnly');
    check(`${label}: the “Text only” switch is present`, !!has);
    // `.switch input` is `display: none` — the visible control is the label, so
    // the checkbox has no clickable point and must be driven directly.
    await page.evaluate(() => {
      const cb = document.querySelector('#liveTextOnly');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const on = await page.evaluate(() => document.querySelector('#liveTextOnly').checked);
    check(`${label}: the switch is on`, on === true, `checked=${on}`);
  }
  await sleep(200);

  await page.click('#liveStart');
  let failed = null;
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => ({
      live: window.__livecall?.().live,
      err: [...document.querySelectorAll('#toasts .toast.err')].map(t => t.textContent)[0] || null,
    }));
    if (st.live) break;
    if (st.err) { failed = st.err; break; }
    await sleep(1000);
  }
  if (failed) check(`${label}: the call is live`, false, `failed: ${failed}`);

  const seam = await page.evaluate(() => window.__livecall?.() || {});
  const ui = await page.evaluate(() => ({
    status: document.querySelector('#liveStatus')?.textContent,
    mode: document.querySelector('#liveMode')?.textContent,
    transport: document.querySelector('#liveTransport')?.textContent,
    mute: document.querySelector('#liveMute')?.textContent,
    placeholder: document.querySelector('#liveText')?.placeholder,
    textDisabled: document.querySelector('#liveText')?.disabled,
    sendDisabled: document.querySelector('#liveSend')?.disabled,
    toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent),
  }));

  const report = { label, audioInputs: devices, live: !!seam.live, seam, ui, errors };
  console.log(`\n--- ${label} (audioinput devices: ${devices}) ---`);
  console.log(JSON.stringify({ live: report.live, textOnly: seam.textOnly, micAvailable: seam.micAvailable, status: ui.status, transport: ui.transport, mode: ui.mode, mute: ui.mute, toasts: ui.toasts }, null, 2));

  check(`${label}: the call is live`, report.live, report.live ? `status=${ui.status}` : `toasts=${JSON.stringify(ui.toasts)}`);
  check(`${label}: no microphone error is reported`, !/microphone|mic\b/i.test(JSON.stringify(seam.lastError || {})) && !ui.toasts.some(t => /microphone/i.test(t)),
        seam.lastError ? seam.lastError.hint || seam.lastError.summary : 'no error');
  check(`${label}: the text box is usable`, ui.textDisabled === false && ui.sendDisabled === false,
        `input disabled=${ui.textDisabled}, send disabled=${ui.sendDisabled}`);

  if (expectText) {
    check(`${label}: it joined in text mode`, seam.textOnly === true, `textOnly=${seam.textOnly}`);
    check(`${label}: the transport says so`, /text-only/.test(ui.transport || ''), ui.transport);
    // `#liveMode` shows Thinking…/Speaking… while the agent works, so this cannot
    // demand the text hint at every instant. What it must never do is claim to be
    // "Listening…" — there is no microphone to listen with.
    check(`${label}: the mode never claims to be listening`, !/^Listening/i.test(ui.mode || ''), ui.mode);
    check(`${label}: the mode is the text hint or an activity state`,
          /text|thinking|speaking/i.test(ui.mode || ''), ui.mode);
    check(`${label}: the mute button offers the microphone`, /Use microphone/.test(ui.mute || ''), ui.mute);
  } else {
    // The ordinary voice call must come through all of the above untouched.
    check(`${label}: it joined with the microphone`, seam.textOnly === false, `textOnly=${seam.textOnly}`);
    check(`${label}: a microphone was found`, seam.micAvailable === true, `micAvailable=${seam.micAvailable}`);
    check(`${label}: the transport is plain WebRTC`, !/text-only/.test(ui.transport || ''), ui.transport);
    check(`${label}: the mute button is still a mute button`,
          /Mute/.test(ui.mute || '') && !/Use microphone/.test(ui.mute || ''), ui.mute);
    check(`${label}: the mode is a normal call state`,
          /listening|thinking|speaking/i.test(ui.mode || ''), ui.mode);
  }

  // The agent used to open every call with a hardcoded `first_message` of
  // "What is your name?" (first_message_mode: fixed). That is now `prompt`, so
  // the greeting is generated from first_message_prompt — give it a moment.
  await sleep(6000);
  const opener = await page.evaluate(() =>
    [...document.querySelectorAll('#liveChat .bubble.agent')].map(b => b.textContent).join(' | '));
  check(`${label}: the removed opener is gone`, !/what is your name/i.test(opener),
        opener.slice(0, 90) || 'no agent bubble yet');

  // Typing is the whole point of the mode.
  if (report.live) {
    await page.click('#liveText');
    await page.type('#liveText', 'Hello, are you there?');
    await page.click('#liveSend');
    await sleep(1200);
    const typed = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('#liveChat .bubble.user')].map(b => b.textContent);
      return { bubbles, input: document.querySelector('#liveText')?.value };
    });
    check(`${label}: a typed line reaches the transcript`,
          typed.bubbles.some(b => /Hello, are you there\?/.test(b)), JSON.stringify(typed.bubbles));
    // Exactly once. The app used to draw its own bubble *and* let the SDK's
    // onUserTranscript draw another, so every typed line appeared twice.
    check(`${label}: it appears exactly once`,
          typed.bubbles.filter(b => /Hello, are you there\?/.test(b)).length === 1,
          `${typed.bubbles.length} user bubble(s)`);
    check(`${label}: the box clears after sending`, typed.input === '', `value=${JSON.stringify(typed.input)}`);
  }

  check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

  // Hang up through the app, or the session stays active on the account.
  if (report.live) {
    await page.click('#liveEnd').catch(() => {});
    await sleep(1800);
    const after = await page.evaluate(() => window.__livecall?.() || {});
    check(`${label}: the call ends cleanly`, after.live === false, `live=${after.live}`);
    check(`${label}: text mode does not leak into the next call`, after.textOnly === false, `textOnly=${after.textOnly}`);
  }

  await browser.close();
}

(async () => {
  const agentId = process.argv[2] || await (async () => {
    const r = await fetch(APP + '/api/fish/v1/agent/agents?page_size=50');
    const d = await r.json();
    return (d.agents || [])[0]?.agent_id || '';
  })();
  console.log('agent:', agentId || '(none)');
  if (!agentId) { console.log('No agent to call.'); process.exit(1); }

  await phase('auto (no audio input)', { fakeDevice: false, forceTextOnly: false, expectText: true, agentId })
    .catch(e => check('auto (no audio input): phase ran', false, String(e.message || e)));
  await phase('forced switch', { fakeDevice: true, forceTextOnly: true, expectText: true, agentId })
    .catch(e => check('forced switch: phase ran', false, String(e.message || e)));
  await phase('normal voice call', { fakeDevice: true, forceTextOnly: false, expectText: false, agentId })
    .catch(e => check('normal voice call: phase ran', false, String(e.message || e)));

  console.log('\n' + results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`\nSUMMARY: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('PROBE ERROR', e); process.exit(2); });
