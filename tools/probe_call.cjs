/**
 * Diagnose the Live Call "Could not establish the realtime session" failure.
 *
 * The SDK's generic message hides the real reason on `err.cause`, and the app's
 * toast only prints `err.message`. This probe runs the real SDK in a real
 * browser (fake mic), unwraps the whole error chain, and reports it.
 *
 * Usage: node tools/probe_call.cjs [agent_id]
 */
const puppeteer = require('puppeteer-core');
const { signIn } = require('./session.cjs');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: [
      '--no-sandbox', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const page = await browser.newPage();
  await signIn(page, APP);
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e}`));

  await page.goto(APP + '/#live', { waitUntil: 'networkidle2' });
  await sleep(1500);

  // Pick the agent (or the one passed in).
  let agentId = process.argv[2];
  if (!agentId) {
    agentId = await page.evaluate(async () => {
      const r = await fetch('/api/fish/v1/agent/agents?page_size=50');
      const d = await r.json();
      return (d.agents || [])[0]?.agent_id || '';
    });
  }
  console.log('agent:', agentId || '(none)');
  if (!agentId) { await browser.close(); process.exit(1); }

  const out = await page.evaluate(async (id) => {
    const report = {};
    const unwrap = (e, depth = 0) => {
      if (!e || depth > 6) return null;
      return {
        name: e.name, message: e.message, code: e.code,
        statusCode: e.statusCode,
        stack: String(e.stack || '').split('\n').slice(0, 4).join(' | '),
        cause: unwrap(e.cause, depth + 1),
      };
    };

    // 1. Can we even get a session token through the app's own proxy?
    let token = null;
    try {
      const r = await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: id }),
      });
      const text = await r.text();
      report.sessionHttp = r.status;
      try { token = JSON.parse(text); } catch { report.sessionBody = text.slice(0, 300); }
    } catch (e) { report.sessionFetchError = String(e); }
    if (token) {
      report.token = {
        session_id: token.session_id, transport: token.transport,
        livekit_url: token.livekit_url, expires_at: token.expires_at,
        max_duration_seconds: token.max_duration_seconds,
        expires_in_s: token.expires_at
          ? Math.round((Date.parse(token.expires_at) - Date.now()) / 1000) : null,
        token_len: (token.token || '').length,
        keys: Object.keys(token),
      };
    }

    // 2. Mic, since the transport awaits getUserMedia before connecting.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      report.mic = 'granted: ' + s.getAudioTracks().map(t => t.label).join(',');
      s.getTracks().forEach(t => t.stop());
    } catch (e) { report.mic = `${e.name}: ${e.message}`; }

    // 3. The real SDK call.
    try {
      const { AgentSession } = await import('https://esm.sh/@fishaudio/agent-client@latest');
      report.sdkLoaded = true;
      try {
        await AgentSession.start({
          sessionToken: token,
          callbacks: { onError: () => {}, onDisconnect: () => {} },
        });
        report.result = 'CONNECTED (unexpected in a probe)';
      } catch (e) {
        report.result = 'THREW';
        report.error = unwrap(e);
      }
    } catch (e) {
      report.sdkLoaded = false;
      report.sdkError = unwrap(e);
    }
    return report;
  }, agentId);

  console.log(JSON.stringify(out, null, 2));

  // This probe mints a session directly (not through the UI), so it must
  // release it itself — otherwise every run leaves a pending session behind.
  if (out?.token?.session_id) {
    const ended = await page.evaluate(async sid => {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/end`, { method: 'POST' });
      return r.status;
    }, out.token.session_id);
    console.log(`released probe session ${out.token.session_id} -> HTTP ${ended}`);
  }

  // ------------------------------------------------ the real UI, exactly as a user
  console.log('\n=== driving the real UI ===');
  await page.goto(APP + '/#live', { waitUntil: 'networkidle2' });
  await sleep(1500);
  await page.evaluate(id => {
    const sel = document.querySelector('#liveAgent');
    if (![...sel.options].some(o => o.value === id)) {
      sel.append(Object.assign(document.createElement('option'), { value: id, text: 'probe agent' }));
    }
    sel.value = id;
  }, agentId);
  await sleep(300);
  await page.click('#liveStart');
  await sleep(9000);

  const ui = await page.evaluate(() => window.__livecall?.() || { error: 'no seam' });
  console.log(JSON.stringify({
    status: ui.status, live: ui.live, sessionId: ui.sessionId,
    lastError: ui.lastError, toasts: ui.toasts,
  }, null, 2));

  // Hang up through the app itself, or the browser closing leaves the session
  // `active` on the account until the server times it out.
  if (ui.sessionId) {
    await page.click('#liveEnd').catch(() => {});
    await sleep(1500);
    const done = await page.evaluate(() => window.__livecall?.().live);
    console.log(`hung up ${ui.sessionId} via the UI (call UI released: ${done === false})`);
  }

  if (logs.length) console.log('\n--- console ---\n' + logs.slice(0, 25).join('\n'));

  await browser.close();
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
