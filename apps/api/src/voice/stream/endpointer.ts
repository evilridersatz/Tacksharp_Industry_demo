import { FRAME_SAMPLES, STREAM_RATE, rms } from './audio.js';

export type EndpointerOptions = {
  /** Silence after speech that ends the customer's turn (ms). Plivo <Record> needed >= 1-2 s; 600-800 ms feels live. */
  endSilenceMs: number;
  /** Shortest real speech (ms of voiced audio). Shorter blips (a cough, a click) are ignored. */
  minSpeechMs: number;
  /** Longest single turn before it is cut and sent anyway (Sarvam REST STT accepts <= 30 s). */
  maxUtteranceMs: number;
  /** Absolute floor for "voiced" (RMS of 16-bit PCM). Phone speech is ~800-6000, line noise ~50-400. */
  minLevel: number;
  /** Voiced = louder than the background level x this (2.2 ≈ 7 dB above the background). */
  noiseRatio: number;
  /** Audio kept from just before speech started, so the first syllable is not clipped (ms). */
  preRollMs: number;
};

export const DEFAULT_ENDPOINTER: EndpointerOptions = {
  endSilenceMs: 700,
  minSpeechMs: 240,
  maxUtteranceMs: 25_000,
  minLevel: 600,
  noiseRatio: 2.2,
  preRollMs: 240,
};

export type EndpointEvent =
  | { type: 'speech_start' }
  /** Still speaking: voicedMs = voiced audio so far in this utterance (used for barge-in). */
  | { type: 'speech'; voicedMs: number }
  | { type: 'utterance'; pcm: Int16Array; durationMs: number; voicedMs: number; cut: boolean }
  /** Speech started but was too short to be words (cough, click, "hm"): nothing is sent to STT. */
  | { type: 'noise'; voicedMs: number };

const FRAME_MS = (FRAME_SAMPLES / STREAM_RATE) * 1000;
/** 2 s of 20 ms frames for the background estimate. */
const FLOOR_WINDOW = 100;
const LEARN_FRAMES = 15;

/**
 * Energy-based end-of-turn detection on 20 ms frames, with an adaptive noise floor. Deliberately simple and local:
 * no model, no network, < 0.1 ms per frame. It only decides WHEN the customer stopped talking; Saaras still decides
 * WHAT was said, and the transcript gate still rejects noise.
 */
export class Endpointer {
  /** Background level: a low percentile of the last 2 s of frame levels, measured ALWAYS (also mid-speech, from
   * the gaps between words). Steady noise (fan, traffic, crowd) raises it, so noise is never mistaken for speech
   * and a turn still ends when the caller stops talking. */
  private noiseFloor = 150;
  private levels: number[] = [];
  private inSpeech = false;
  private voicedFrames = 0;
  private silentFrames = 0;
  private startRun = 0;
  private frames: Int16Array[] = [];
  private preRoll: Int16Array[] = [];
  private pending = new Int16Array(0);
  /** Raised while our own audio is playing, so line echo is not taken for the customer. */
  private boost = 1;

  constructor(private readonly opts: EndpointerOptions = DEFAULT_ENDPOINTER) {}

  /** While the AI is talking, require louder speech (echo of our own voice must not interrupt us). */
  /** Echo gate while our audio plays (and its echo tail): speech must be this much louder than usual. */
  private playbackBoost = 1.8;

  setPlayback(playing: boolean) {
    this.boost = playing ? this.playbackBoost : 1;
  }

  /** Raise the echo gate for this call (our own audio came back loud enough to pass it). Capped at 4x. */
  raiseEchoGate() {
    this.playbackBoost = Math.min(4, this.playbackBoost * 1.4);
    if (this.boost > 1) this.boost = this.playbackBoost;
    return this.playbackBoost;
  }

  get speaking() {
    return this.inSpeech;
  }

  reset() {
    this.inSpeech = false;
    this.voicedFrames = 0;
    this.silentFrames = 0;
    this.startRun = 0;
    this.frames = [];
  }

  /** Feed any amount of PCM; it is cut into 20 ms frames internally. */
  push(pcm: Int16Array): EndpointEvent[] {
    const events: EndpointEvent[] = [];
    let buf = pcm;
    if (this.pending.length) {
      buf = new Int16Array(this.pending.length + pcm.length);
      buf.set(this.pending, 0);
      buf.set(pcm, this.pending.length);
    }
    let i = 0;
    for (; i + FRAME_SAMPLES <= buf.length; i += FRAME_SAMPLES) this.frame(buf.slice(i, i + FRAME_SAMPLES), events);
    this.pending = buf.slice(i);
    return events;
  }

  private threshold() {
    return Math.max(this.opts.minLevel, this.noiseFloor * this.opts.noiseRatio) * this.boost;
  }

  private frame(f: Int16Array, events: EndpointEvent[]) {
    const level = rms(f);
    this.levels.push(level);
    if (this.levels.length > FLOOR_WINDOW) this.levels.shift();
    const learning = this.levels.length < LEARN_FRAMES;
    const sorted = [...this.levels].sort((a, b) => a - b);
    this.noiseFloor = Math.max(30, sorted[Math.floor(sorted.length * 0.05)]);
    const voiced = level >= this.threshold();
    if (!this.inSpeech) {
      this.preRoll.push(f);
      const maxPre = Math.ceil(this.opts.preRollMs / FRAME_MS);
      if (this.preRoll.length > maxPre) this.preRoll.shift();
      // The first 300 ms only measure the line (the opening line is playing then anyway).
      this.startRun = voiced && !learning ? this.startRun + 1 : 0;
      // Three voiced frames in a row (60 ms) start a turn.
      if (this.startRun >= 3) {
        this.inSpeech = true;
        this.frames = [...this.preRoll];
        this.preRoll = [];
        this.voicedFrames = this.startRun;
        this.silentFrames = 0;
        events.push({ type: 'speech_start' });
      }
      return;
    }
    this.frames.push(f);
    if (voiced) {
      this.voicedFrames++;
      this.silentFrames = 0;
      events.push({ type: 'speech', voicedMs: this.voicedFrames * FRAME_MS });
    } else {
      this.silentFrames++;
    }
    const durationMs = this.frames.length * FRAME_MS;
    const ended = this.silentFrames * FRAME_MS >= this.opts.endSilenceMs;
    const cut = durationMs >= this.opts.maxUtteranceMs;
    if (!ended && !cut) return;

    const voicedMs = this.voicedFrames * FRAME_MS;
    if (voicedMs < this.opts.minSpeechMs) {
      events.push({ type: 'noise', voicedMs });
    } else {
      // Trailing silence is not sent to STT (shorter upload, nothing for Saaras to hallucinate on); keep 200 ms.
      const keep = Math.max(0, this.frames.length - Math.max(0, this.silentFrames - Math.ceil(200 / FRAME_MS)));
      const used = this.frames.slice(0, keep);
      const pcm = new Int16Array(used.length * FRAME_SAMPLES);
      used.forEach((fr, k) => pcm.set(fr, k * FRAME_SAMPLES));
      events.push({ type: 'utterance', pcm, durationMs: used.length * FRAME_MS, voicedMs, cut });
    }
    this.reset();
  }
}
