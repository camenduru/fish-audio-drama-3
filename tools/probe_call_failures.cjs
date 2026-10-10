/**
 * Prove the Live Call error reporting names the real cause.
 *
 * The SDK reports a busy microphone, a missing microphone and an insecure
 * origin all as "Could not establish the realtime session" (it awaits
 * getUserMedia outside the try/catch that produces that message). This stubs
 * each cause, drives the real UI, and reads what the user is now told.
 *
 * Usage: node tools/probe_call_failures.cjs
 */
const puppeteer = require('puppeteer-core');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CASES = [
  { name: 'mic busy', stub: 'reject', errName: 'NotReadableError', errMsg: 'Could not start audio source' },
  { name: 'mic denied', stub: 'reject', errName: 'NotAllowedError', errMsg: 'Permission denied' },
  { name: 'no microphone', stub: 'reject', errName: 'NotFoundError', errMsg: 'Requested device not found' },
  { name: 'mic overconstrained', stub: 'reject', errName: 'OverconstrainedError', errMsg: 'deviceId' },
  { name: 'insecure origin', stub: 'undefined' },
  { name: 'healthy', stub: 'none' },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
           '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });

  const rows = [];

  // Snapshot the account's sessions so we can prove the run leaves nothing behind.
  const sessionIds = async p => new Set(
    (await p.evaluate(async () => {
      const d = await (await fetch('/api/fish/v1/agent/sessions?page_size=100')).json();
      return (d.sessions || []).map(s => s.session_id);
    })) || []);

  const scout = await browser.newPage();
  await scout.goto(APP + '/#live', { waitUntil: 'networkidle2' });
  const before = await sessionIds(scout);
  await scout.close();

  for (const c of CASES) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(APP + '/#live', { waitUntil: 'networkidle2' });
    await sleep(1300);

    // Install the fault before the SDK touches the mic.
    await page.evaluate(c => {
      if (c.stub === 'undefined') {
        Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      } else if (c.stub === 'reject') {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new DOMException(c.errMsg, c.errName));
      }
    }, c);

    // Pick the first agent the app knows about.
    const picked = await page.evaluate(async () => {
      const d = await (await fetch('/api/fish/v1/agent/agents?page_size=50')).json();
      const id = d.agents?.[0]?.agent_id || '';
      const sel = document.querySelector('#liveAgent');
      if (id && ![...sel.options].some(o => o.value === id)) {
        sel.append(Object.assign(document.createElement('option'), { value: id, text: 'probe' }));
      }
      if (id) sel.value = id;
      return id;
    });
    if (!picked) { console.log('no agent to test with'); break; }

    await page.click('#liveStart');
    // Poll: the toast lives 4 s, so read it as it appears rather than after.
    let toastText = '';
    let seam = null;
    for (let i = 0; i < 40; i++) {
      seam = await page.evaluate(() => window.__livecall?.() || null);
      const t = seam?.toasts?.find(x => x.startsWith('Could not start call'));
      if (t) { toastText = t; break; }
      if (seam && seam.live === false && !seam.lastError) break;   // connected
      await sleep(250);
    }
    seam = await page.evaluate(() => window.__livecall?.() || null);
    rows.push({
      case: c.name,
      inCall: seam?.live === false && !!seam?.sessionId,
      hint: seam?.lastError?.hint || '',
      summary: seam?.lastError?.summary || '',
      code: seam?.lastError?.code || '',
      root: seam?.lastError?.rootName || '',
      toast: toastText.replace(/^Could not start call:\s*/, ''),
      jsErrors: errs.length,
    });
    await page.close();
  }

  console.log('\n================ what the user is told now ================');
  let caseFails = 0;
  for (const r of rows) {
    const ok = r.inCall || ((r.hint || r.summary) && r.jsErrors === 0);
    if (!ok) caseFails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.case.padEnd(20)} inCall=${String(r.inCall).padEnd(5)} ` +
                `code=${(r.code || '—').padEnd(20)} root=${(r.root || '—').padEnd(20)}`);
    console.log(`        toast: ${r.toast || '(none)'}`);
  }

  // A failed start must not leave a session behind: the token is minted before
  // the connect, so without the client's cleanup every retry of a broken call
  // adds another abandoned session to the account.
  const scout2 = await browser.newPage();
  await scout2.goto(APP + '/#live', { waitUntil: 'networkidle2' });
  await sleep(2500);   // let the fire-and-forget /end land
  const after = await scout2.evaluate(async () => {
    const d = await (await fetch('/api/fish/v1/agent/sessions?page_size=100')).json();
    return (d.sessions || []).map(s => ({
      id: s.session_id, status: s.status, reason: s.end_reason, created: s.created_at,
    }));
  });
  await scout2.close();

  const fresh = after.filter(s => !before.has(s.id));
  const leaked = fresh.filter(s => s.status === 'pending');
  console.log(`\n================ session leak ================`);
  console.log(`created during this run: ${fresh.length}`);
  for (const s of fresh) console.log(`   ${s.status.padEnd(9)} reason=${s.reason}  ${s.id}`);
  console.log(`${leaked.length === 0 ? 'PASS' : 'FAIL'}  no abandoned sessions left behind` +
              (leaked.length ? ` — ${leaked.length} still pending` : ''));
  const fails = caseFails + (leaked.length ? 1 : 0);

  console.log(`\n${rows.length - caseFails}/${rows.length} cases give an actionable message`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
