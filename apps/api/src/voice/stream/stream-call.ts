import { log, errorMessage } from '../../common/logger.js';
import type { DecidedTurn, ReplyTurn } from '../voice.service.js';
import { decodeMulaw, mulawMs, pcmToWav } from './audio.js';
import { DEFAULT_ENDPOINTER, Endpointer, type EndpointerOptions } from './endpointer.js';

/** Speech for one piece of text, already as phone-line μ-law (null when TTS failed). */
export type Speech = { audio: Buffer | null; languageCode?: string; cached?: boolean; attempts?: number; error?: string };

/** Everything the stream needs from the rest of the app. Injected so the whole call loop is testable offline. */
export type StreamDeps = {
  transcribe(wav: Buffer): Promise<{ transcript: string; languageCode?: string }>;
  understand(transcript: string, sttLanguage: string | undefined, durationMs: number): Promise<DecidedTurn>;
  speak(text: string, cache: boolean): Promise<Speech>;
  /** Audio already synthesized for a URL we hold (opening line, replay of the last question). */
  audioForUrl(url: string): Promise<Buffer | null>;
  ttsFailed(decided: ReplyTurn, error: string | undefined, attempts: number): Promise<{ audio: Buffer | null; fallback: string }>;
  markReplyNotHeard(): void;
  logTurn(decided: ReplyTurn, timings: Record<string, number>, tts: Record<string, unknown>): void;
  hangup(reason: string): Promise<void>;
  /** Short wait line played only when deciding the answer takes longer than fillerAfterMs (cached audio). `variant`
   *  rotates so the same line is never said twice in a row. */
  filler(english: boolean, variant: number): Promise<Buffer | null>;
  isEnglish(): boolean;
  /** True for a fixed line that is pre-recorded at startup (plays from disk with no TTS request). */
  isCachedLine?(text: string): boolean;
  /** Plivo's own call id from the stream start (needed to hang up through the REST API). */
  onStart?(info: { providerCallId?: string }): void;
  now?: () => number;
};

export type StreamOptions = {
  endpointer: EndpointerOptions;
  /** Customer speech (ms of voiced audio) that interrupts the AI while it is talking. 0 = never interrupt. */
  bargeInMs: number;
  /** Voiced speech needed to cut the OPENING line (people answer "Hello?" over it; that must not stop it). */
  openingBargeInMs?: number;
  /** Voiced speech needed to drop a reply still being prepared ("Hello?" while waiting must not discard it). */
  continueMs?: number;
  /** Play a short filler if deciding the answer (after STT) takes longer than this (ms). 0 = off. Rule-answered turns
   *  decide in tens of ms and never reach it. */
  fillerAfterMs: number;
  /** Nothing heard this long after we finished speaking: ask "ஹலோ? கேக்குதா?" (counts as a silent turn). */
  noResponseMs: number;
  /** Bytes per playAudio message (4000 = 0.5 s): small enough that clearAudio stops us quickly. */
  chunkBytes: number;
};

export const DEFAULT_STREAM: StreamOptions = { endpointer: DEFAULT_ENDPOINTER, bargeInMs: 400, openingBargeInMs: 1500, continueMs: 1500, fillerAfterMs: 700, noResponseMs: 7000, chunkBytes: 4000 };

/** How long our own audio can still come back as echo after playback ends (network + handset round trip): the
 *  raised speech gate stays on this long after the last checkpoint. */
export const ECHO_TAIL_MS = 1200;
/** A segment that STARTED before our playback ended (+ this margin) may be our echo; one that starts later is an
 *  answer, even when it repeats our words ("ஆமா" to "ஆமா, இல்ல வேண்டாம்னு சொல்லுங்க", a property name we listed). */
export const ECHO_START_MARGIN_MS = 250;
/**
 * Speech that goes on this long after our playback finished cannot be only our echo (echo stops with our audio plus
 * the line round trip). Such a segment is an answer said over the end of our question ("ஆமா" as the question ends):
 * it is checked for echo against the LAST words we said only, and is never dropped for being short.
 */
export const OUTLAST_MS = 200;

/** The last few words of what we said: all that can still come back as echo once our audio has finished. */
export const tailWords = (text: string, n = 3) => normWords(text).slice(-n).join(' ');

const normWords = (text: string) =>
  (text ?? '').toLowerCase().replace(/[.,!?？।:;"'()\-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * Is this transcript our own speech coming back (speakerphone / line echo)? Real call 2026-10-10: while the caller
 * stayed silent, Saaras transcribed the agent's own words ("Porur Premium Residency.", "Guduvanchery.", "ஆமா.") and
 * the engine acted on them. True when nearly every word of the transcript is a word of what we just said (Tamil
 * suffixes tolerated: "Residency-ல" ~ "Residency"). Only applied to audio that overlapped our playback or its tail.
 */
export function isEchoOf(transcript: string, agentText: string): boolean {
  const heard = normWords(transcript);
  const ours = normWords(agentText);
  if (!heard.length || !ours.length) return false;
  const match = (w: string) => ours.some((o) => o === w || (o.length >= 3 && w.length >= 3 && (o.startsWith(w) || w.startsWith(o))));
  const hits = heard.filter(match).length;
  return hits / heard.length >= 0.7;
}

/**
 * Text the speech could not have held: more characters than 35 per voiced second (+10). Generous on purpose - Tamil
 * script takes ~2 characters per syllable - so real speech is never rejected; Saaras sometimes returns a fluent
 * sentence for a short burst of noise, and that is never a customer answer.
 */
export function implausibleTranscript(transcript: string, voicedMs: number): boolean {
  const chars = transcript.replace(/\s+/g, '').length;
  return chars > (voicedMs / 1000) * 35 + 10;
}

/** "Hello?", "ஹலோ", "hello hello": a caller checking the line, not an answer. */
export function isBareHello(text: string): boolean {
  const t = (text ?? '').toLowerCase().replace(/[.,!?？]/g, ' ').replace(/\s+/g, ' ').trim();
  return Boolean(t) && /^(?:(?:hello|helo|hallo|halo|ஹலோ|ஹல்லோ|hi|ஹாய்)(?:ங்க)?\s*){1,3}$/u.test(t);
}

export type Send = (message: Record<string, unknown>) => void;

type State = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ending' | 'closed';

/**
 * One live call over a Plivo bidirectional audio stream:
 *   customer audio -> local end-of-speech detection (no recording upload / download, no 2 s silence wait)
 *   -> Saaras STT -> the SAME conversation engine and safety rules as record mode
 *   -> Bulbul TTS sentence by sentence, the first sentence playing while the next is synthesized
 *   -> back into the call. The customer can interrupt (barge-in); an interrupted question counts as not heard.
 */
export class StreamCall {
  private state: State = 'connecting';
  private streamId = '';
  private readonly endpointer: Endpointer;
  private queue: Promise<void> = Promise.resolve();
  /** Audio we asked Plivo to play, by checkpoint name, and when it should be done (fallback when no playedStream). */
  private playing = new Map<string, NodeJS.Timeout>();
  private seq = 0;
  private speakingUntil = 0;
  private interrupted = false;
  private replyHeard = true;
  private lastReplyAudio: Buffer | null = null;
  private pendingHangup?: string;
  private silenceTimer?: NodeJS.Timeout;
  /** A filler was played on the previous turn: none on this one. */
  private fillerLastTurn = false;
  private fillerVariant = 0;
  private readonly now: () => number;
  /** The opening line is playing (a short "Hello?" over it is the customer picking up, not an interruption). */
  private openingActive = false;
  /** What we said recently, with when it stopped playing: echo of it is not the customer. */
  private spoken: Array<{ text: string; until: number }> = [];
  /** When our last audio finished playing (Plivo checkpoint), for the echo tail. */
  private playbackEndedAt = 0;
  /** The current reply was cut by a barge-in (replayed once if the "speech" turns out to be our own echo). */
  private cutByBargeIn = false;
  private replayedAfterEcho = false;
  private segment = 0;
  private speechStartedAt = 0;
  private lastSeq = -1;

  constructor(
    readonly callId: string,
    private readonly send: Send,
    private readonly deps: StreamDeps,
    private readonly opts: StreamOptions = DEFAULT_STREAM,
    private readonly openingUrl?: string,
    private readonly openingText?: string,
  ) {
    this.endpointer = new Endpointer(opts.endpointer);
    this.now = deps.now ?? Date.now;
  }

  get currentState() {
    return this.state;
  }

  /** Raw WebSocket message from Plivo. */
  async onMessage(raw: string | Buffer) {
    let msg: { event?: string; sequenceNumber?: number | string; start?: { streamId?: string; callId?: string; mediaFormat?: { encoding?: string; sampleRate?: number } }; streamId?: string; media?: { payload?: string; track?: string }; name?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case 'start':
        this.streamId = msg.start?.streamId ?? msg.streamId ?? '';
        this.deps.onStart?.({ providerCallId: msg.start?.callId });
        log.info('voice.stream_start', { callId: this.callId, streamId: this.streamId, format: msg.start?.mediaFormat });
        if (msg.start?.mediaFormat?.encoding && !/mulaw|ulaw|pcmu/i.test(msg.start.mediaFormat.encoding)) {
          log.error('voice.stream_bad_format', { callId: this.callId, format: msg.start.mediaFormat });
        }
        await this.playOpening();
        break;
      case 'media': {
        // Only the caller's audio (our <Stream> asks for the inbound track; anything marked otherwise is dropped).
        if (!msg.media?.payload || (msg.media.track ?? 'inbound') !== 'inbound') break;
        // A repeated or late frame (same / older sequence number) is dropped, never heard twice.
        const seq = Number(msg.sequenceNumber);
        if (Number.isFinite(seq)) {
          if (seq <= this.lastSeq) break;
          this.lastSeq = seq;
        }
        this.onAudio(Buffer.from(msg.media.payload, 'base64'));
        break;
      }
      case 'playedStream':
        if (msg.name) this.played(msg.name);
        break;
      case 'clearedAudio':
        break;
      case 'stop':
        this.close('stream_stop');
        break;
    }
  }

  close(reason: string) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.disarmSilence();
    for (const t of this.playing.values()) clearTimeout(t);
    this.playing.clear();
    log.info('voice.stream_closed', { callId: this.callId, reason });
  }

  // ------------------------------------------------------------------ listening

  private onAudio(bytes: Buffer) {
    if (this.state === 'closed' || this.state === 'ending' || this.state === 'connecting') return;
    for (const ev of this.endpointer.push(decodeMulaw(bytes))) {
      if (ev.type === 'speech_start') {
        this.disarmSilence();
        this.speechStartedAt = this.now(); // when this segment's speech began (for the echo window)
      }
      if (ev.type === 'noise' && this.state === 'listening') this.armSilence();
      // Real call 2026-10-10: the caller's "Hello?" on pick-up (0.4 s) cut the opening, and every "Hello?" while a
      // reply was being prepared threw that reply away - the caller heard nothing at all and kept saying hello.
      // Now the opening needs a real sentence (1.5 s of speech) to be cut, and a pending reply is only dropped
      // when the caller clearly keeps talking (1.5 s); a short "hello?" is answered by the reply itself.
      const cutMs = this.openingActive ? this.opts.openingBargeInMs ?? 1500 : this.opts.bargeInMs;
      if (ev.type === 'speech' && this.opts.bargeInMs > 0 && this.state === 'speaking' && ev.voicedMs >= cutMs) {
        this.bargeIn();
      }
      if (ev.type === 'speech' && this.opts.bargeInMs > 0 && this.state === 'thinking' && ev.voicedMs >= (this.opts.continueMs ?? 1500)) {
        // Still talking after a pause, before we said anything: the pending answer is dropped, the rest is heard.
        if (!this.interrupted) {
          this.interrupted = true;
          this.state = 'listening';
          log.info('voice.customer_continued', { callId: this.callId });
        }
      }
      if (ev.type === 'utterance') {
        const endedAt = this.now();
        // Said while we were busy (opening / reply playing, or a reply being prepared) or just after: a bare
        // "hello" in it is a line check that our own audio already answers (decided after STT, in turn()).
        const overlappedOurAudio = this.openingActive || this.state === 'thinking' || this.state === 'speaking' || endedAt - ev.durationMs < this.speakingUntil + 1500;
        // Started while our audio was playing or within its echo tail: may be our own voice coming back.
        const startedAt = this.speechStartedAt || endedAt - ev.durationMs;
        this.speechStartedAt = 0;
        const playbackEnd = this.openingActive || this.state === 'speaking' ? Number.POSITIVE_INFINITY : this.playbackEndedAt;
        const inEchoWindow = startedAt < playbackEnd + ECHO_START_MARGIN_MS;
        // Started during our audio but still going well after it finished: an answer over the end of our line.
        // Not after a barge-in: audio already on its way when we cut it still echoes back after the cut.
        const outlasted = inEchoWindow && !this.cutByBargeIn && Number.isFinite(playbackEnd) && startedAt + ev.voicedMs > playbackEnd + OUTLAST_MS;
        const recent = inEchoWindow ? this.recentSpeech(startedAt) : '';
        const seg = { id: ++this.segment, voicedMs: ev.voicedMs, inEchoWindow, outlasted, echoOf: outlasted ? tailWords(recent) : recent };
        this.queue = this.queue.then(() => this.turn(ev.pcm, ev.durationMs, endedAt, overlappedOurAudio, seg)).catch((error) => {
          log.error('voice.stream_turn_failed', { callId: this.callId, error: errorMessage(error) });
        });
      }
    }
  }

  /** The customer talks over us: stop our audio at once and listen. */
  private bargeIn() {
    if (this.state !== 'speaking') return;
    this.send({ event: 'clearAudio', streamId: this.streamId });
    for (const t of this.playing.values()) clearTimeout(t);
    this.playing.clear();
    this.speakingUntil = 0;
    this.interrupted = true;
    this.cutByBargeIn = true;
    this.playbackEndedAt = this.now();
    for (const x of this.spoken) if (x.until === Number.POSITIVE_INFINITY) x.until = this.playbackEndedAt;
    this.openingActive = false;
    this.endpointer.setPlayback(false);
    // A question the customer did not hear to the end must not be "confirmed" by their next yes.
    if (!this.replyHeard) this.deps.markReplyNotHeard();
    this.state = 'listening';
    log.info('voice.barge_in', { callId: this.callId });
  }

  // ------------------------------------------------------------------ one turn

  private async turn(
    pcm: Int16Array,
    durationMs: number,
    endedAt: number,
    overlappedOurAudio = false,
    seg: { id: number; voicedMs: number; inEchoWindow: boolean; outlasted?: boolean; echoOf: string } = { id: 0, voicedMs: durationMs, inEchoWindow: false, echoOf: '' },
  ) {
    if (this.state === 'closed' || this.state === 'ending') return;
    this.state = 'thinking';
    this.interrupted = false;
    const t0 = endedAt;
    let fillerPlayed = false;
    let fillerTimer: NodeJS.Timeout | undefined;

    const timings: Record<string, number> = {};
    let transcript = '';
    let sttLanguage: string | undefined;
    let sttFailed = false;
    try {
      const stt = await this.deps.transcribe(pcmToWav(pcm));
      transcript = stt.transcript;
      sttLanguage = stt.languageCode;
    } catch (error) {
      sttFailed = true;
      log.error('voice.stt_failed', { callId: this.callId, error: errorMessage(error), mode: 'stream' });
    }
    timings.stt = this.now() - t0;
    // Speech validation BEFORE anything reaches the conversation engine (no state can change on a rejected segment).
    const reject = transcript.trim()
      ? seg.inEchoWindow && seg.echoOf && isEchoOf(transcript, seg.echoOf)
        ? 'echo_of_agent_audio'
        : seg.inEchoWindow && !seg.outlasted && seg.voicedMs < 400
          ? 'short_speech_during_echo_window'
          : implausibleTranscript(transcript, seg.voicedMs)
            ? 'text_longer_than_speech'
            : undefined
      : undefined;
    log.info('voice.segment', {
      callId: this.callId, streamId: this.streamId, segment: seg.id, durationMs, voicedMs: seg.voicedMs,
      inEchoWindow: seg.inEchoWindow, outlastedPlayback: Boolean(seg.outlasted), playback: this.state, sttChars: transcript.trim().length, accepted: !reject && Boolean(transcript.trim()), reason: reject ?? (transcript.trim() ? 'speech' : 'empty'),
    });
    if (reject) {
      if (reject === 'echo_of_agent_audio') {
        // Our own voice came back loud enough to pass the gate: raise it for the rest of this call.
        const gate = this.endpointer.raiseEchoGate();
        log.warn('voice.echo_rejected', { callId: this.callId, segment: seg.id, echoGate: Number(gate.toFixed(2)), cutOurReply: this.cutByBargeIn });
        // The echo cut our own reply: play it again once, so the caller still hears the question.
        if (this.cutByBargeIn && !this.replayedAfterEcho && this.lastReplyAudio) {
          this.replayedAfterEcho = true;
          this.cutByBargeIn = false;
          this.play(this.lastReplyAudio, `replay-${++this.seq}`, true);
          return;
        }
      }
      if (this.state === 'thinking') this.state = this.speakingUntil > this.now() ? 'speaking' : 'listening';
      if (this.state === 'listening') this.armSilence();
      return;
    }
    if (overlappedOurAudio && isBareHello(transcript)) {
      // "Hello?" said over (or right after) our own line: they are checking the line while we speak. What we were
      // saying answers it; replying "hello" again would talk over ourselves.
      if (this.state === 'thinking') this.state = this.speakingUntil > this.now() ? 'speaking' : 'listening';
      log.info('voice.stream_ignored_hello', { callId: this.callId });
      if (this.state === 'listening') this.armSilence();
      return;
    }
    if (!transcript.trim() && sttFailed && seg.voicedMs >= 600 && !seg.inEchoWindow) {
      // The caller really spoke but speech-to-text failed (timeout, provider error): ask them to say it again
      // (the engine's unclear-turn rules: "Sorry, சரியா கேக்கல…", and a polite end after repeated failures).
      log.warn('voice.stt_failed_ask_repeat', { callId: this.callId, voicedMs: seg.voicedMs });
      const decided = await this.deps.understand('', undefined, durationMs);
      if (decided.kind === 'unclear') await this.playUnclear(decided);
      else if (this.state === 'thinking') this.state = 'listening';
      return;
    }
    if (!transcript.trim()) {
      // Nothing intelligible (a passing bus, a door, a TV): on a live line that is not a turn. Say nothing and keep
      // listening; a caller who is really silent gets "ஹலோ? கேக்குதா?" from the no-response timer instead.
      if (fillerTimer) clearTimeout(fillerTimer);
      if (this.state === 'thinking') this.state = 'listening';
      log.info('voice.stream_ignored_sound', { callId: this.callId, durationMs });
      if (this.state === 'listening') this.armSilence();
      return;
    }
    // Filler policy: only the DECISION step is timed (started after STT, cancelled the moment the answer exists).
    // Rule-answered turns decide in tens of milliseconds, so they never get a filler; a slow model turn may get one
    // short line. Never on two turns in a row, never the same line twice running.
    if (this.opts.fillerAfterMs > 0 && !this.fillerLastTurn) {
      fillerTimer = setTimeout(() => {
        if (this.state !== 'thinking') return;
        const variant = this.fillerVariant++;
        void this.deps.filler(this.deps.isEnglish(), variant).then((audio) => {
          if (audio && this.state === 'thinking') {
            fillerPlayed = true;
            this.play(audio, 'filler', false);
          }
        });
      }, this.opts.fillerAfterMs);
    }
    let decided: DecidedTurn;
    try {
      decided = await this.deps.understand(transcript, sttLanguage, durationMs);
    } catch (error) {
      // The decision step crashed (database / provider down). Never leave the caller in silence: ask them to say
      // it again with the unclear-turn rules (which never reach the engine), and keep listening.
      log.error('voice.stream_understand_failed', { callId: this.callId, error: errorMessage(error) });
      if (fillerTimer) clearTimeout(fillerTimer);
      const retry = await this.deps.understand('', undefined, Math.max(durationMs, 600)).catch(() => undefined);
      if (retry?.kind === 'unclear') await this.playUnclear(retry);
      else if ((this.state as State) === 'thinking') {
        this.state = 'listening';
        this.armSilence();
      }
      return;
    } finally {
      if (fillerTimer) clearTimeout(fillerTimer);
    }
    timings.ai = this.now() - t0 - timings.stt;

    if (this.interrupted && (this.state as State) === 'listening') {
      // The customer started talking again while we were thinking: they will get the answer to that instead.
      // (The engine already recorded this turn; its reply is simply not spoken.)
      if (decided.kind === 'reply') this.deps.markReplyNotHeard();
      if (fillerTimer) clearTimeout(fillerTimer);
      return;
    }

    if (decided.kind === 'unclear') {
      if (fillerTimer) clearTimeout(fillerTimer);
      await this.playUnclear(decided);
      return;
    }

    // Sentence by sentence: every sentence's TTS starts now (the shared limiter keeps live calls first), and
    // each plays as soon as it and the ones before it are ready.
    const cachedLine = (t: string) => this.deps.isCachedLine?.(t) ?? false;
    this.cutByBargeIn = false;
    this.replayedAfterEcho = false;
    this.remember(decided.finalText);
    const sentences = splitForSpeech(decided.finalText, 28, cachedLine);
    const jobs = sentences.map((s) => this.deps.speak(s, decided.cacheable || cachedLine(s)));
    let firstAudioMs: number | undefined;
    let languageCode: string | undefined;
    let allCached = true;
    let attempts = 0;
    let fallback: string | undefined;
    const parts: Buffer[] = [];
    this.replyHeard = false;
    for (let i = 0; i < jobs.length; i++) {
      const speech = await jobs[i];
      if ((this.state as State) === 'closed' || this.interrupted) break;
      languageCode ??= speech.languageCode;
      allCached &&= Boolean(speech.cached);
      attempts += speech.attempts ?? 0;
      let audio = speech.audio;
      if (!audio) {
        if (decided.end) continue;
        // One failed sentence: the reply is not heard as a whole; ask the customer to repeat (same rule as record mode).
        const fb = await this.deps.ttsFailed(decided, speech.error, speech.attempts ?? 0);
        fallback = fb.fallback;
        audio = fb.audio;
        if (audio) this.play(audio, `fallback-${++this.seq}`, true);
        break;
      }
      if (i === 0) {
        if (fillerTimer) clearTimeout(fillerTimer);
        firstAudioMs = this.now() - t0;
      }
      parts.push(audio);
      const last = i === jobs.length - 1;
      this.play(audio, last ? (decided.end ? 'end' : `reply-${++this.seq}`) : `part-${++this.seq}`, last);
    }
    if (fillerTimer) clearTimeout(fillerTimer);
    if (parts.length) this.lastReplyAudio = Buffer.concat(parts);
    timings.tts = this.now() - t0 - timings.stt - timings.ai;
    timings.totalMs = this.now() - t0;
    this.fillerLastTurn = fillerPlayed;
    this.deps.logTurn(decided, timings, {
      mode: 'stream',
      languageCode,
      cached: allCached,
      attempts,
      fallback,
      firstAudioMs,
      sentences: sentences.length,
      filler: fillerPlayed,
    });
    if (decided.end) this.endAfterAudio('conversation_end');
    else if (this.state === 'thinking') this.state = 'listening';
  }

  /** Keep what we say (last few lines) to recognise its echo. */
  private remember(text: string) {
    if (!text) return;
    this.spoken.push({ text, until: Number.POSITIVE_INFINITY });
    if (this.spoken.length > 4) this.spoken.shift();
  }

  /** Our lines that were still playing (or whose echo tail had not passed) when a segment started. */
  private recentSpeech(startedAt: number): string {
    return this.spoken.filter((x) => x.until + ECHO_TAIL_MS > startedAt).map((x) => x.text).join(' ');
  }

  private async playUnclear(decided: Extract<DecidedTurn, { kind: 'unclear' }>) {
    this.remember(decided.text);
    const audio = decided.replayUrl ? this.lastReplyAudio ?? (await this.deps.audioForUrl(decided.replayUrl)) : (await this.deps.speak(decided.text, true)).audio;
    if (audio) this.play(audio, decided.end ? 'end' : `unclear-${++this.seq}`, true);
    if (decided.end) this.endAfterAudio('no_response');
    else if (!audio) {
      this.state = 'listening';
      this.armSilence();
    }
  }

  // ------------------------------------------------------------------ silence

  private armSilence() {
    this.disarmSilence();
    if (this.opts.noResponseMs <= 0 || this.state === 'closed' || this.state === 'ending') return;
    this.silenceTimer = setTimeout(() => {
      if (this.state !== 'listening' || this.endpointer.speaking) return;
      this.queue = this.queue.then(() => this.noResponse()).catch((error) => log.error('voice.stream_turn_failed', { callId: this.callId, error: errorMessage(error) }));
    }, this.opts.noResponseMs);
    this.silenceTimer.unref?.();
  }

  private disarmSilence() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  /** The caller said nothing at all: the same silent-turn rules as record mode (ask, replay, then end politely). */
  private async noResponse() {
    if (this.state !== 'listening' || this.endpointer.speaking) return;
    this.state = 'thinking';
    log.info('voice.stream_no_response', { callId: this.callId, afterMs: this.opts.noResponseMs });
    const decided = await this.deps.understand('', undefined, 0);
    if ((this.state as State) !== 'thinking') return;
    if (decided.kind === 'unclear') await this.playUnclear(decided);
    else this.state = 'listening';
  }

  // ------------------------------------------------------------------ playback

  private async playOpening() {
    const audio = this.openingUrl ? await this.deps.audioForUrl(this.openingUrl) : null;
    if (audio) {
      this.lastReplyAudio = audio;
      this.replyHeard = true; // the opening is not a question that a "yes" could confirm
      this.openingActive = true;
      if (this.openingText) this.remember(this.openingText);
      this.play(audio, 'opening', true);
    } else {
      this.state = 'listening';
      this.armSilence();
    }
  }

  /**
   * Queue μ-law audio in the call. `final` marks the end of what we are saying now: a checkpoint tells us when
   * Plivo has actually played it (playedStream), with a timer as a safety net if that event never arrives.
   */
  private play(audio: Buffer, name: string, final: boolean) {
    if (this.state === 'closed') return;
    for (let i = 0; i < audio.length; i += this.opts.chunkBytes) {
      this.send({
        event: 'playAudio',
        media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: audio.subarray(i, i + this.opts.chunkBytes).toString('base64') },
      });
    }
    const now = this.now();
    this.speakingUntil = Math.max(this.speakingUntil, now) + mulawMs(audio.length);
    if (this.state !== 'ending') this.state = 'speaking';
    this.endpointer.setPlayback(true);
    if (!final) return;
    this.send({ event: 'checkpoint', streamId: this.streamId, name });
    const timer = setTimeout(() => this.played(name), Math.max(0, this.speakingUntil - now) + 1500);
    timer.unref?.();
    this.playing.set(name, timer);
  }

  private played(name: string) {
    const timer = this.playing.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.playing.delete(name);
    if (name === 'opening') this.openingActive = false;
    if (this.playing.size > 0) return;
    const now = this.now();
    this.playbackEndedAt = now;
    for (const x of this.spoken) if (x.until === Number.POSITIVE_INFINITY) x.until = now;
    // Echo of the last words arrives after Plivo says playback ended: keep the raised gate through the tail.
    setTimeout(() => {
      if (this.playing.size === 0 && this.state !== 'speaking') this.endpointer.setPlayback(false);
    }, ECHO_TAIL_MS).unref?.();
    this.replyHeard = true;
    if (this.pendingHangup) {
      const reason = this.pendingHangup;
      this.pendingHangup = undefined;
      void this.deps.hangup(reason);
      this.close(reason);
      return;
    }
    if (this.state === 'speaking') {
      this.state = 'listening';
      this.armSilence();
    }
  }

  /** Hang up once the goodbye has been heard (or right away if nothing is playing). */
  private endAfterAudio(reason: string) {
    this.state = 'ending';
    if (this.playing.size === 0) {
      void this.deps.hangup(reason);
      this.close(reason);
    } else {
      this.pendingHangup = reason;
    }
  }
}

/**
 * Split a reply where a speaker would pause, so the first part can play while the rest is synthesized. Very short
 * pieces are joined to the next one (a lone "ஓகே." sounds clipped and costs a TTS request on its own).
 */
export function splitForSpeech(text: string, minChars = 28, isCachedLine: (s: string) => boolean = () => false): string[] {
  // A reply that is itself a pre-recorded line plays from cache as one piece.
  if (isCachedLine(text.trim())) return [text.trim()];
  const raw = text
    .split(/(?<=[.?!।？])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  let carry = '';
  for (const piece of raw) {
    // A pre-recorded sentence ("சரிங்க.", "ஓகே.", a fixed question) stays on its own so it plays from cache at once
    // while the next sentence is still being synthesized: an immediate, natural acknowledgement instead of a filler.
    if (isCachedLine(piece)) {
      if (carry) out.push(carry);
      carry = '';
      out.push(piece);
      continue;
    }
    const joined = carry ? `${carry} ${piece}` : piece;
    if (joined.length < minChars) carry = joined;
    else {
      out.push(joined);
      carry = '';
    }
  }
  if (carry) {
    if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${carry}`;
    else out.push(carry);
  }
  return out.length ? out : [text.trim()].filter(Boolean);
}
