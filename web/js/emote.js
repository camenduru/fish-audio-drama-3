// emote.js — the expression side of a VRM avatar: lip sync, emotions and blinking.
//
// This is ChatVRM's `src/features` ported as a unit, because the three files there
// only make sense together and splitting them invites the subtle half-port:
//
//   lipSync/lipSync.ts                     → cookVolume() + LipSync
//   emoteController/emoteController.ts     → EmoteController
//   emoteController/expressionController.ts→ ExpressionController
//   emoteController/autoBlink.ts           → AutoBlink
//   emoteController/autoLookAt.ts          → attachLookAt()
//   emoteController/emoteConstants.ts      → BLINK_CLOSE_MAX / BLINK_OPEN_MAX
//
// What a half-port gets wrong is the interaction, not the parts: the mouth weight
// depends on whether an emotion is showing (0.5 vs 0.25), and an emotion waits for
// the eyes to reopen before it lands, because applying an expression over closed
// eyelids looks like a glitch. Both live here rather than in the render loop.
//
// The one deliberate difference: ChatVRM analyses its own AudioContext (it plays
// ElevenLabs buffers itself). This studio's audio arrives from the agent SDK, which
// hands us a 0–1 output level rather than samples, so the level is what feeds the
// controller. `cookVolume()` is kept exactly as ChatVRM wrote it for callers that
// *do* have samples, and it is what the level path is modelled on: a peak, a curve
// that lifts quiet speech, and a hard floor so silence shuts the mouth completely.

// --- constants (emoteConstants.ts) -----------------------------------------
/** How long the eyes stay shut in one blink, in seconds. */
export const BLINK_CLOSE_MAX = 0.12;
/** How long the eyes stay open between blinks, in seconds. */
export const BLINK_OPEN_MAX = 5;

// --- lipSync.ts -------------------------------------------------------------
export const TIME_DOMAIN_DATA_LENGTH = 2048;

/**
 * Raw peak amplitude (0–1) → mouth value (0–1), ChatVRM's "cook":
 *
 *   volume = 1 / (1 + Math.exp(-45 * volume + 5))
 *   if (volume < 0.1) volume = 0
 *
 * The sigmoid turns a small amplitude into most of the range (0.1 already reads
 * ~0.38) so quiet consonants move the lips, and the floor is what makes silence
 * read as a closed mouth instead of a slightly parted one.
 */
export function cookVolume(peak) {
  const v = 1 / (1 + Math.exp(-45 * peak + 5));
  return v < 0.1 ? 0 : v;
}

/**
 * ChatVRM's LipSync: an AnalyserNode on its own AudioContext, played back and
 * analysed at the same time. Used by anything that hands the avatar a decoded
 * buffer (their own TTS); the agent call uses the SDK's level instead.
 */
export class LipSync {
  constructor(audio) {
    this.audio = audio;
    this.analyser = audio.createAnalyser();
    this.timeDomainData = new Float32Array(TIME_DOMAIN_DATA_LENGTH);
  }

  /** The peak sample this frame, cooked. Silence is exactly 0. */
  update() {
    this.analyser.getFloatTimeDomainData(this.timeDomainData);
    let volume = 0.0;
    for (let i = 0; i < TIME_DOMAIN_DATA_LENGTH; i++) {
      volume = Math.max(volume, Math.abs(this.timeDomainData[i]));
    }
    return { volume: cookVolume(volume) };
  }

  async playFromArrayBuffer(buffer, onEnded) {
    const audioBuffer = await this.audio.decodeAudioData(buffer);
    const source = this.audio.createBufferSource();
    source.buffer = audioBuffer;
    // Both taps matter: the destination so you hear it, the analyser so the mouth
    // can follow it.
    source.connect(this.audio.destination);
    source.connect(this.analyser);
    source.start();
    if (onEnded) source.addEventListener('ended', onEnded);
  }

  async playFromURL(url, onEnded) {
    const res = await fetch(url);
    this.playFromArrayBuffer(await res.arrayBuffer(), onEnded);
  }
}

// --- autoBlink.ts -----------------------------------------------------------
/**
 * Automatic blinking on the `blink` expression.
 *
 * The eyes alternate on two timers rather than a random interval, and the class
 * reports how long a caller would have to wait for them to be open again — which
 * is the whole reason it holds `_remainingTime` instead of just setting a flag.
 */
export class AutoBlink {
  constructor(expressionManager, { onBlink = null } = {}) {
    this.em = expressionManager;
    this.onBlink = onBlink;
    this.remainingTime = 0;
    this.isOpen = true;
    this.isAutoBlink = true;
    this.count = 0;
  }

  /**
   * Turn automatic blinking on or off.
   *
   * Returns the seconds until the eyes are open, so an emotion can wait for them
   * instead of landing on closed eyelids.
   */
  setEnable(isAuto) {
    this.isAutoBlink = isAuto;
    if (!this.isOpen) return this.remainingTime;
    return 0;
  }

  update(delta) {
    if (this.remainingTime > 0) {
      this.remainingTime -= delta;
      return;
    }
    if (this.isOpen && this.isAutoBlink) {
      this.close();
      return;
    }
    this.open();
  }

  close() {
    this.isOpen = false;
    this.remainingTime = BLINK_CLOSE_MAX;
    this.em?.setValue?.('blink', 1);
    this.count++;
    this.onBlink?.();
  }

  open() {
    this.isOpen = true;
    this.remainingTime = BLINK_OPEN_MAX;
    this.em?.setValue?.('blink', 0);
  }

  /** Blink once now, without waiting for the timer. */
  blinkNow() {
    this.close();
  }
}

// --- expressionController.ts ------------------------------------------------
/**
 * Owns the expressions: one emotion at a time, one mouth expression at a time,
 * blinking in between, and the weight the mouth gets depends on the emotion.
 *
 * The mouth preset is the VRM "perfect sync" one when the model has it (JawOpen),
 * otherwise the standard `aa` — ChatVRM's own preference order.
 */
export class ExpressionController {
  constructor(vrm, { onBlink = null } = {}) {
    this.vrm = vrm;
    this.em = vrm?.expressionManager ?? null;
    const hasJawOpen = !!this.em?.getExpression?.('JawOpen');
    this.mouthPreset = hasJawOpen ? 'JawOpen' : 'aa';
    this.currentEmotion = 'neutral';
    this.currentLipSync = null;
    this.autoBlink = this.em ? new AutoBlink(this.em, { onBlink }) : null;
  }

  /** How wide the mouth is drawn for a given lip-sync value, per the emotion. */
  mouthWeight(value) {
    return this.currentEmotion === 'neutral' ? value * 0.5 : value * 0.25;
  }

  playEmotion(preset) {
    if (this.currentEmotion !== 'neutral') this.em?.setValue?.(this.currentEmotion, 0);

    if (preset === 'neutral') {
      this.autoBlink?.setEnable(true);
      this.currentEmotion = preset;
      return;
    }

    // An emotion waits out the blink it interrupted: `setEnable(false)` returns the
    // seconds left until the eyes reopen.
    const t = this.autoBlink?.setEnable(false) || 0;
    this.currentEmotion = preset;
    setTimeout(() => this.em?.setValue?.(preset, 1), t * 1000);
  }

  /** Record the mouth value. The weight is applied in update(), not here. */
  lipSync(preset, value) {
    if (this.currentLipSync) this.em?.setValue?.(this.currentLipSync.preset, 0);
    this.currentLipSync = { preset, value };
  }

  update(delta) {
    this.autoBlink?.update(delta);
    if (this.currentLipSync) {
      this.em?.setValue?.(this.currentLipSync.preset, this.mouthWeight(this.currentLipSync.value));
    }
  }

  get blinkWeight() {
    return this.em?.getExpression?.('blink')?.weight ?? 0;
  }

  get mouthExpressionWeight() {
    return this.em?.getExpression?.(this.currentLipSync?.preset || this.mouthPreset)?.weight ?? null;
  }
}

// --- emoteController.ts -----------------------------------------------------
/** ChatVRM's EmoteController: the name the rest of the app talks to. */
export class EmoteController {
  constructor(vrm, opts) {
    this.expressionController = new ExpressionController(vrm, opts);
  }

  playEmotion(preset) {
    this.expressionController.playEmotion(preset);
  }

  lipSync(preset, value) {
    this.expressionController.lipSync(preset, value);
  }

  update(delta) {
    this.expressionController.update(delta);
  }

  get mouthPreset() {
    return this.expressionController.mouthPreset;
  }

  get emotion() {
    return this.expressionController.currentEmotion;
  }

  get blinkWeight() {
    return this.expressionController.blinkWeight;
  }

  get mouthWeight() {
    return this.expressionController.mouthExpressionWeight;
  }

  get blinkCount() {
    return this.expressionController.autoBlink?.count ?? 0;
  }

  blinkNow() {
    this.expressionController.autoBlink?.blinkNow();
  }
}

// --- autoLookAt.ts ----------------------------------------------------------
/**
 * AutoLookAt, verbatim in effect: a node parented to the camera becomes the
 * look-at target, so the eyes converge on the viewer and keep following while the
 * camera orbits. three-vrm's applier writes the eyes and nothing else.
 */
export function attachLookAt(vrm, target) {
  if (vrm?.lookAt && target) vrm.lookAt.target = target;
  return target;
}
