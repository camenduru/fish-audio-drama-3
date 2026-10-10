/**
 * What does a Studio take actually sound like by the time the baker sees it?
 *
 * The harness caught a degenerate sidecar (a single all-X cue) when the Lip Sync
 * page auto-baked a Studio take. The transcode and the baker both check out in
 * isolation, so this measures the one remaining link: the bytes the Studio
 * publishes to the shared library, and what ensureWav() turns them into.
 *
 * Costs one TTS call.  Usage: node tools/probe_studio_audio.cjs
 */
const puppeteer = require('puppeteer-core');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
  page.on('pageerror', e => console.log('[pageerror]', String(e)));

  await page.goto(APP + '/#lipsync', { waitUntil: 'networkidle2' });
  await sleep(2000);

  await page.click('.rail-btn[data-view="studio"]');
  await sleep(600);
  await page.$eval('#editor', e => {
    e.value = 'Good morning! The kettle is already on.';
    e.dispatchEvent(new Event('input'));
  });
  await page.evaluate(() => {
    const c = document.querySelector('#streamTimestamps');
    if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change')); }
  });
  await page.click('#genBtn');

  let n = 0;
  for (let i = 0; i < 90; i++) {
    n = await page.evaluate(() => document.querySelectorAll('#takeList .list-item').length);
    if (n) break;
    await sleep(1000);
  }
  console.log('studio takes:', n);

  const out = await page.evaluate(async () => {
    const L = await import('/js/library.js');
    const A = await import('/js/audio.js');
    const take = L.listAudio().find(t => t.source === 'studio') || L.listAudio()[0];
    if (!take) return { error: 'no take in library' };

    const bytes = new Uint8Array(await take.blob.arrayBuffer());
    const head = [...bytes.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = String.fromCharCode(...bytes.slice(0, 4));
    const res = {
      name: take.name, text: take.text, blobType: take.blob.type,
      storedBytes: bytes.length, head, ascii,
      firstBytesAreRiff: ascii === 'RIFF',
    };

    // How much of the raw payload is non-zero? (catches zero-padded concat)
    let nz = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) nz++;
    res.nonZeroFraction = +(nz / bytes.length).toFixed(4);

    try {
      const decoded = await A.decode(take.blob);
      const d = decoded.getChannelData(0);
      let peak = 0, sum = 0;
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += v * v; }
      res.decoded = {
        rate: decoded.sampleRate, ch: decoded.numberOfChannels,
        dur: +decoded.duration.toFixed(3),
        rms: +Math.sqrt(sum / d.length).toFixed(5), peak: +peak.toFixed(5),
      };
    } catch (e) { res.decodeError = String(e.message || e); }

    try {
      const wav = await A.ensureWav(bytes);
      const dv = new DataView(wav.buffer, wav.byteOffset);
      const rate = dv.getUint32(24, true), ch = dv.getUint16(22, true);
      const cnt = Math.floor((wav.length - 44) / (2 * ch));
      let peak = 0, sum = 0;
      for (let i = 0; i < cnt; i++) {
        const s = dv.getInt16(44 + i * 2 * ch, true) / 32768;
        const v = Math.abs(s); if (v > peak) peak = v; sum += v * v;
      }
      res.ensureWav = {
        bytes: wav.length, rate, ch,
        dur: +(cnt / rate).toFixed(3),
        rms: +Math.sqrt(sum / cnt).toFixed(5), peak: +peak.toFixed(5),
      };
      // Keep it so the same clip can be re-baked from the command line.
      window.__probeWav = Array.from(wav);
      window.__probeText = take.text;
      window.__probeMeta = take.meta || null;
    } catch (e) { res.ensureWavError = String(e.message || e); }

    return res;
  });

  console.log(JSON.stringify(out, null, 2));

  // Bake the very bytes the Lip Sync page would send, and report the cues.
  const baked = await page.evaluate(async () => {
    const wav = Uint8Array.from(window.__probeWav || []);
    const fd = new FormData();
    fd.append('wav', new Blob([wav], { type: 'audio/wav' }), 'line.wav');
    fd.append('text', window.__probeText || '');
    const al = window.__probeMeta?.alignment;
    if (al?.segments?.length) fd.append('anchors', JSON.stringify(al));
    fd.append('aligner', 'auto');
    try {
      const r = await fetch('/api/visemes', { method: 'POST', body: fd });
      const out = await r.json();
      if (out.error) return { httpError: out.error };
      const cues = out.sidecar?.mouthCues || [];
      return {
        cues: cues.length,
        duration: out.sidecar?.metadata?.duration,
        aligner: out.stats?.aligner,
        anchorWords: out.stats?.anchorWords,
        note: out.stats?.note,
        shapes: cues.map(c => c.value).join('').slice(0, 60),
      };
    } catch (e) { return { bakeError: String(e.message || e) }; }
  });
  console.log('bake:', JSON.stringify(baked, null, 2));

  await browser.close();
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
