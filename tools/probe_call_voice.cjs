/**
 * End-to-end call test: ask by TEXT, then ask by VOICE.
 *
 * Phase 1 — type "What is your name?" into the call and send it as text.
 * Phase 2 — let the microphone carry the same question, so it goes through the
 *           agent's ASR instead of the text channel.
 *
 * The mic is Chrome's fake capture device playing a real TTS clip of the
 * question (--use-file-for-fake-audio-capture), so the voice phase exercises the
 * true audio path: TTS clip -> fake mic -> WebRTC -> agent ASR -> LLM -> agent
 * TTS -> back to the client.
 *
 * Chrome LOOPS that file, so the clip is padded with silence: the question is
 * spoken once per cycle instead of repeating back to back, which is what makes
 * the transcript readable.
 *
 * It also watches the app's own FFT visualiser (#liveWave), which is fed from
 * the SDK's output analyser — the only in-app evidence of whether the agent's
 * voice is actually arriving.
 *
 * Usage: node tools/probe_call_voice.cjs [agent_id]
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { signIn } = require('./session.cjs');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CLIP = path.join(__dirname, '..', 'data', 'probe',
                       process.env.CLIP || 'ask_name_once.wav');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(CLIP)) {
    console.error(`missing ${CLIP} — generate it first (see README: probe_call_voice)`);
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: [
      '--no-sandbox', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${CLIP}`,
    ],
  });
  const page = await browser.newPage();
  await signIn(page, APP);
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push(String(e)));

  await page.goto(APP + '/#live', { waitUntil: 'networkidle2' });
  await sleep(1500);

  let agentId = process.argv[2];
  if (!agentId) {
    agentId = await page.evaluate(async () => {
      const d = await (await fetch('/api/fish/v1/agent/agents?page_size=50')).json();
      return (d.agents || [])[0]?.agent_id || '';
    });
  }
  await page.evaluate(id => {
    const sel = document.querySelector('#liveAgent');
    if (id && ![...sel.options].some(o => o.value === id)) {
      sel.append(Object.assign(document.createElement('option'), { value: id, text: 'probe' }));
    }
    if (id) sel.value = id;
  }, agentId);
  console.log('agent:', agentId);

  const chat = () => page.$$eval('#liveChat .bubble', els => els.map(e => ({
    role: [...e.classList].find(c => c !== 'bubble'),
    text: e.textContent.trim(),
  })));
  // The visualiser bars are driven by the SDK's output analyser.
  const wavePeak = () => page.$$eval('#liveWave i', els =>
    els.reduce((m, e) => Math.max(m, parseFloat(e.style.height) || 0), 0));

  await page.click('#liveStart');

  // ---- connect -------------------------------------------------------------
  let up = null;
  for (let i = 0; i < 60; i++) {
    up = await page.evaluate(() => window.__livecall?.() || null);
    if (up?.live === false && up?.sessionId) break;
    if (up?.lastError) break;
    await sleep(500);
  }
  if (up?.lastError) {
    console.log('call FAILED to start:', JSON.stringify(up.lastError, null, 2));
    await browser.close();
    process.exit(1);
  }
  if (!up?.sessionId) { console.log('call never connected'); await browser.close(); process.exit(1); }
  console.log(`connected: ${up.sessionId}\n`);

  // Sample the output level across the whole call.
  let peakAll = 0, peakSpeaking = 0;
  const sampler = setInterval(async () => {
    try {
      const p = await wavePeak();
      peakAll = Math.max(peakAll, p);
      const m = await page.$eval('#liveMode', e => e.textContent);
      if (m === 'Speaking…') peakSpeaking = Math.max(peakSpeaking, p);
    } catch {}
  }, 250);

  // The agent greets on join; give it a moment to finish.
  await sleep(9000);
  const greeting = await chat();
  console.log('--- after connect (agent greeting) ---');
  greeting.forEach(b => console.log(`  ${b.role}: ${b.text}`));

  // ---- phase 1: TEXT -------------------------------------------------------
  console.log('\n=== PHASE 1 · ask by TEXT ===');
  const before1 = greeting.length;
  await page.click('#liveText');
  await page.type('#liveText', 'What is your name?');
  await page.click('#liveSend');
  let textPhase = [];
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const c = await chat();
    textPhase = c.slice(before1);
    if (textPhase.some(b => b.role === 'agent')) break;
  }
  textPhase.forEach(b => console.log(`  ${b.role}: ${b.text}`));
  await sleep(4000);

  // ---- phase 2: VOICE ------------------------------------------------------
  console.log('\n=== PHASE 2 · ask by VOICE (fake mic plays the clip) ===');
  const before2 = (await chat()).length;
  let voicePhase = [];
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const c = await chat();
    voicePhase = c.slice(before2);
    if (voicePhase.some(b => b.role === 'user') && voicePhase.some(b => b.role === 'agent')) break;
  }
  voicePhase.forEach(b => console.log(`  ${b.role}: ${b.text}`));
  if (!voicePhase.some(b => b.role === 'user')) {
    console.log('  (the agent never transcribed the spoken question)');
  }
  await sleep(3000);

  clearInterval(sampler);
  const final = await page.evaluate(() => window.__livecall?.() || {});
  console.log('\n=== output level (app FFT visualiser) ===');
  console.log(`  peak while the agent was speaking: ${peakSpeaking.toFixed(1)}%`);
  console.log(`  peak overall: ${peakAll.toFixed(1)}%`);
  console.log(`  ${peakSpeaking > 10 ? 'PASS — the agent\'s voice is arriving'
    : 'SUSPECT — no output audio reached the client while the agent was speaking'}`);
  console.log(`  lastError: ${final.lastError ? JSON.stringify(final.lastError) : 'none'}`);

  // ---- hang up + release ---------------------------------------------------
  await page.click('#liveEnd').catch(() => {});
  await sleep(1500);
  const sid = final.sessionId;
  if (sid) {
    const code = await page.evaluate(async s => {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s)}/end`, { method: 'POST' });
      return r.status;
    }, sid).catch(() => '?');
    console.log(`\nreleased ${sid} -> HTTP ${code}`);
  }
  if (errs.length) console.log('console errors:', errs.slice(0, 6));

  await browser.close();
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
