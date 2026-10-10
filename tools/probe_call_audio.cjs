/**
 * Capture what the agent actually sends down the LiveKit audio track.
 *
 * "distorted beeping instead of a voice" has several possible causes that sound
 * identical to a human but look completely different in a waveform: no agent
 * audio at all, a codec/sample-rate mismatch (buzz), a stuck tone, or real
 * speech that the browser is playing at the wrong rate. So record the remote
 * track itself — not the speaker output — and look at it.
 *
 * Writes data/probe/call_audio.wav and prints an envelope + spectral summary.
 *
 * Usage: node tools/probe_call_audio.cjs [agent_id]
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { signIn } = require('./session.cjs');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SECONDS = Number(process.env.CAPTURE_SECONDS || 20);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
           '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage();
  await signIn(page, APP);
  const logs = [];
  page.on('console', m => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', e => logs.push(String(e)));

  await page.goto(APP + '/#live', { waitUntil: 'networkidle2' });
  await sleep(1200);

  let agentId = process.argv[2];
  if (!agentId) {
    agentId = await page.evaluate(async () => {
      const d = await (await fetch('/api/fish/v1/agent/agents?page_size=50')).json();
      return (d.agents || [])[0]?.agent_id || '';
    });
  }
  console.log('agent:', agentId);

  const result = await page.evaluate(async ({ id, seconds }) => {
    const report = {};
    const { AgentSession } = await import('https://esm.sh/@fishaudio/agent-client@latest');

    const token = await (await fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: id }),
    })).json();
    report.sessionId = token.session_id;

    const events = [];
    let session;
    try {
      session = await AgentSession.start({
        sessionToken: token,
        microphone: false,              // capture the AGENT only, no fake-mic beeps
        callbacks: {
          onError: e => events.push('error:' + (e?.code || e?.message)),
          onDisconnect: d => events.push('disconnect:' + d?.reason),
          onAgentResponse: ({ text }) => events.push('agent:' + text.slice(0, 80)),
          onStatusChange: s => events.push('status:' + s),
          onModeChange: m => events.push('mode:' + m),
        },
      });
    } catch (e) {
      report.startError = String(e?.message || e);
      return report;
    }
    report.connected = true;
    report.sessionId = session.sessionId || report.sessionId;

    // Wait for the agent to actually join the room.
    const room = session.getRoom();
    const joined = async () => {
      if (!room) return false;
      let n = 0;
      room.remoteParticipants.forEach(p => { n += p.audioTrackPublications?.size || 0; });
      return n > 0;
    };
    for (let i = 0; i < 40 && !(await joined()); i++) await new Promise(r => setTimeout(r, 500));
    report.remoteAudioTracks = await (async () => {
      let n = 0;
      if (room) room.remoteParticipants.forEach(p => { n += p.audioTrackPublications?.size || 0; });
      return n;
    })();
    report.participants = room ? [...room.remoteParticipants.values()].map(p => p.identity) : [];

    // Nudge the agent so there is definitely speech to capture.
    try { session.sendUserMessage('What is your name?'); } catch {}

    // The SDK's own analyser sits on the output stream — the same thing the
    // app's visualizer reads. If this reads zero while the agent says it is
    // speaking, the audio genuinely is not arriving, and a silent WebAudio tap
    // is not the explanation.
    const vol = [];
    const volTimer = setInterval(() => {
      try { vol.push(+(session.getOutputVolume?.() ?? -1).toFixed(4)); } catch { vol.push(-2); }
    }, 100);

    // Tap the remote audio track.
    const tracks = [];
    if (room) {
      room.remoteParticipants.forEach(p => {
        p.audioTrackPublications.forEach(pub => {
          const mt = pub.track?.mediaStreamTrack;
          if (mt) tracks.push(mt);
        });
      });
    }
    if (!tracks.length) {
      clearInterval(volTimer);
      report.capture = 'no remote audio track';
      session.end().catch(() => {});
      return report;
    }

    const ctx = new AudioContext();
    report.sampleRate = ctx.sampleRate;
    const stream = new MediaStream(tracks);
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(ctx.destination);      // silent: we never write to outputBuffer

    await new Promise(r => setTimeout(r, seconds * 1000));
    clearInterval(volTimer);
    proc.disconnect(); src.disconnect();
    try { await ctx.close(); } catch {}
    report.sdkOutputVolume = vol;
    report.sdkVolumePeak = vol.length ? Math.max(...vol) : null;
    report.sdkVolumeMean = vol.length ? +(vol.reduce((a, b) => a + b, 0) / vol.length).toFixed(4) : null;

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }

    // Per-100 ms RMS, so we can see an envelope rather than one number.
    const step = Math.floor(ctx.sampleRate * 0.1);
    const env = [];
    for (let i = 0; i + step <= pcm.length; i += step) {
      let s = 0;
      for (let j = i; j < i + step; j++) s += pcm[j] * pcm[j];
      env.push(Math.sqrt(s / step));
    }
    const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const rms = Math.sqrt(pcm.reduce((s, v) => s + v * v, 0) / Math.max(1, pcm.length));

    // 16-bit PCM WAV, base64 back to node.
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, ctx.sampleRate, true); dv.setUint32(28, ctx.sampleRate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));

    report.seconds = +(total / ctx.sampleRate).toFixed(2);
    report.rms = +rms.toFixed(4);
    report.peak = +peak.toFixed(4);
    report.envelope = env.map(v => +v.toFixed(3));
    report.events = events;
    report.wavBase64 = btoa(bin);

    try { await session.end(); } catch {}
    return report;
  }, { id: agentId, seconds: SECONDS });

  const dir = path.join(__dirname, '..', 'data', 'probe');
  fs.mkdirSync(dir, { recursive: true });
  if (result.wavBase64) {
    const out = path.join(dir, 'call_audio.wav');
    fs.writeFileSync(out, Buffer.from(result.wavBase64, 'base64'));
    console.log(`saved ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  }
  delete result.wavBase64;

  // Release the session this probe minted.
  if (result.sessionId) {
    const code = await page.evaluate(async sid => {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/end`, { method: 'POST' });
      return r.status;
    }, result.sessionId).catch(() => '?');
    console.log(`released ${result.sessionId} -> HTTP ${code}`);
  }

  console.log(JSON.stringify(result, null, 2));
  if (logs.length) console.log('\nconsole errors:', logs.slice(0, 6));
  await browser.close();
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
