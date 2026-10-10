/**
 * Does the browser's mp3 -> PCM WAV transcode survive headless Chrome?
 *
 * ensureWav() is the only thing standing between a Studio take (mp3) and the
 * viseme baker (which reads a RIFF header). If headless decodeAudioData returns
 * silence, the baker sees a silent clip and emits a single all-X cue — which is
 * exactly the degenerate sidecar the harness caught. This measures the level.
 *
 * Usage: node tools/probe_transcode.cjs
 */
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const APP = process.env.APP_URL || 'http://127.0.0.1:8756';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const b64 = fs.readFileSync('data/probe/tone.mp3').toString('base64');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.goto(APP + '/#lipsync', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));

  const out = await page.evaluate(async (b64) => {
    const A = await import('/js/audio.js');
    const bin = atob(b64);
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    const mp3 = new Blob([raw], { type: 'audio/mpeg' });

    const res = {};
    try {
      const decoded = await A.decode(mp3);
      res.decoded = { rate: decoded.sampleRate, dur: +decoded.duration.toFixed(3), ch: decoded.numberOfChannels };
      const d = decoded.getChannelData(0);
      let peak = 0, sum = 0;
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += v * v; }
      res.decodedRms = +Math.sqrt(sum / d.length).toFixed(5);
      res.decodedPeak = +peak.toFixed(5);
    } catch (e) { res.decodeError = String(e.message || e); }

    try {
      const wav = await A.ensureWav(mp3);
      res.wavBytes = wav.length;
      // Parse the header we produced.
      const dv = new DataView(wav.buffer, wav.byteOffset, 44);
      const rate = dv.getUint32(24, true), ch = dv.getUint16(22, true), bits = dv.getUint16(34, true);
      res.wavHeader = { rate, ch, bits, riff: String.fromCharCode(wav[0], wav[1], wav[2], wav[3]) };
      // RMS of the PCM payload.
      const n = Math.floor((wav.length - 44) / 2);
      let peak = 0, sum = 0;
      for (let i = 0; i < n; i++) {
        const s = dv.getInt16 ? new DataView(wav.buffer, wav.byteOffset).getInt16(44 + i * 2, true) : 0;
        const v = Math.abs(s) / 32768; if (v > peak) peak = v; sum += v * v;
      }
      res.pcmRms = +Math.sqrt(sum / n).toFixed(5);
      res.pcmPeak = +peak.toFixed(5);
      res.pcmSamples = n;
    } catch (e) { res.ensureWavError = String(e.message || e); }

    return res;
  }, b64);

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
