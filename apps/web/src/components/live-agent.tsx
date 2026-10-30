'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Languages, Loader2, MessageSquareText, Mic, MicOff, Phone, Square, Video, Volume2, VolumeX, X } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { cx } from './ui';
import { encodeWav, sentences, wavPcm } from '@/lib/voice';

/**
 * "Tara": the Tacksharp assistant on the website and in the dashboard. Text or voice in Tamil, English or Tanglish;
 * answers come from the website's own content (server), speech from Sarvam (server). The face is an animated
 * illustration whose mouth follows the actual voice audio; it is labelled as an AI assistant, never as a person.
 */
type Style = 'ta' | 'en' | 'tanglish';
type Msg = { role: 'user' | 'assistant'; content: string; voice?: boolean };
type Phase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'reconnecting';
/** Video call states shown to the visitor. */
type VideoState = 'off' | 'connecting' | 'live' | 'ended';

const LANGS: Array<{ id: Style | 'auto'; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'ta', label: 'தமிழ்' },
  { id: 'tanglish', label: 'Tanglish' },
  { id: 'en', label: 'English' },
];
const QUICK: Record<Style, Array<[string, string]>> = {
  en: [['💬', 'How does the WhatsApp assistant work?'], ['📞', 'Can it make voice calls in Tamil?'], ['💰', 'What does it cost?'], ['🚀', 'How do I get started?']],
  ta: [['💬', 'WhatsApp assistant எப்படி வேலை செய்யும்?'], ['📞', 'தமிழ்ல call பண்ணுமா?'], ['💰', 'விலை எவ்வளவு?'], ['🚀', 'எப்படி ஆரம்பிக்கறது?']],
  tanglish: [['💬', 'WhatsApp assistant epdi work aagum?'], ['📞', 'Tamil la call pannuma?'], ['💰', 'Price evlo?'], ['🚀', 'Epdi start panradhu?']],
};
const PHASE_LABEL: Record<Phase, string> = { idle: 'Online', listening: 'Listening…', transcribing: 'Got it…', thinking: 'Thinking…', speaking: 'Speaking…', reconnecting: 'Reconnecting…' };
/** Barge-in: the visitor talking over Tara (echo-cancelled mic, louder and sustained, so her own voice never triggers it). */
const BARGE_RMS = 0.06;
const BARGE_MS = 300;
const STORE = 'ts-tara-v1';

type SimliLike = { start(): Promise<void>; stop(): Promise<void>; sendAudioData(d: Uint8Array): void; ClearBuffer: () => void; on(ev: string, cb: (...a: unknown[]) => void): void };

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
/** Network trouble or a server hiccup is worth one quiet retry during a call; a refusal (4xx) is not. */
const retryable = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500;

/**
 * Tara's mark: a brand-coloured orb that breathes with the live audio level (no cartoon face). Used in the launcher,
 * the header, beside her messages and, large, on the voice stage.
 */
function Orb({ level = 0, phase = 'idle', size = 40 }: { level?: number; phase?: Phase; size?: number }) {
  const active = phase === 'speaking' || phase === 'listening';
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
      {active && <span className="absolute inset-0 rounded-full bg-[#7c5cf0]/25 motion-safe:animate-ping" />}
      <span
        className="relative rounded-full shadow-[inset_0_-6px_14px_rgba(0,0,0,0.25),0_6px_18px_-6px_rgba(124,92,240,0.6)] transition-transform duration-75"
        style={{
          width: size, height: size,
          transform: `scale(${1 + (active ? level * 0.12 : 0)})`,
          background: 'radial-gradient(circle at 32% 28%, #ffffff 0%, #c9c2ff 14%, #7c5cf0 42%, #3b2f9e 70%, #16183d 100%)',
        }}
      />
      <span className="absolute rounded-full bg-white/70 blur-[1px]" style={{ width: size * 0.18, height: size * 0.1, top: size * 0.2, left: size * 0.28 }} />
    </span>
  );
}

/** A live waveform of the actual audio (speaking or listening); a calm line otherwise. */
function Waveform({ level, phase }: { level: number; phase: Phase }) {
  const bars = 28;
  const active = phase === 'speaking' || phase === 'listening';
  return (
    <span className="flex h-10 items-center gap-[3px]" aria-hidden data-level={level.toFixed(2)}>
      {Array.from({ length: bars }, (_, i) => {
        const shape = Math.sin((i / (bars - 1)) * Math.PI);
        const jitter = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + level * 9));
        const h = active ? Math.max(3, 40 * shape * Math.min(1, level * 1.6) * jitter) : 3;
        return <span key={i} className={cx('w-[3px] rounded-full transition-[height] duration-75', phase === 'listening' ? 'bg-emerald-400' : 'bg-[#a99bff]')} style={{ height: h }} />;
      })}
    </span>
  );
}

export function LiveAgent() {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<Style | 'auto'>('auto');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [voiceOut, setVoiceOut] = useState(true);
  const [handsFree, setHandsFree] = useState(false);
  const [status, setStatus] = useState<{ chat: 'ai' | 'faq'; voice: boolean; video?: boolean; greeting: string } | null>(null);
  /** Talking video presenter (Simli): off until the visitor starts it (it is billed per minute). */
  const [video, setVideo] = useState<VideoState>('off');
  /** Duplicate-start guard: a double click or a re-render never opens a second (billable) video session. */
  const videoStarting = useRef(false);
  /** The greeting is spoken once per video session. */
  const greeted = useRef(false);
  /** The browser blocked autoplay: one "Start conversation" tap unlocks audio. */
  const [needsStart, setNeedsStart] = useState(false);
  /** The visitor ended the video themselves (vs. the session ending on its own). */
  const userStopped = useRef(false);
  /** One microphone stream reused across turns while a voice / video call is on (no permission prompt per turn). */
  const mic = useRef<MediaStream | null>(null);
  const failures = useRef(0);
  const videoEl = useRef<HTMLVideoElement>(null);
  const videoAudioEl = useRef<HTMLAudioElement>(null);
  const simli = useRef<SimliLike | null>(null);
  const silentWaiter = useRef<(() => void) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const playing = useRef<AudioBufferSourceNode | null>(null);
  const stopSpeech = useRef<() => void>(() => undefined);
  const rec = useRef<{ stop: (send: boolean) => void } | null>(null);
  const raf = useRef<number>(0);
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const handsFreeRef = useRef(false);
  handsFreeRef.current = handsFree;
  const startListeningRef = useRef<() => Promise<void>>(async () => undefined);
  const greetRef = useRef<() => Promise<void>>(async () => undefined);
  const bargedRef = useRef(false);
  const quiet = useRef(0);
  const style: Style = lang === 'auto' ? 'en' : lang;

  // Restore the conversation for this tab (convenience only; nothing is stored on the server).
  useEffect(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem(STORE) ?? 'null');
      if (Array.isArray(s?.msgs)) setMsgs(s.msgs.slice(-30));
      if (s?.lang) setLang(s.lang);
    } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(STORE, JSON.stringify({ msgs: msgs.slice(-30), lang })); } catch { /* ignore */ }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, lang]);
  useEffect(() => {
    if (!open) return;
    api.get<{ chat: 'ai' | 'faq'; voice: boolean; video?: boolean; greeting: string }>(`/assistant/status?lang=${style}`).then(setStatus).catch(() => setStatus({ chat: 'faq', voice: false, greeting: '' }));
    setTimeout(() => inputRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, style]);

  const ctx = () => {
    if (!audioCtx.current) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx.current = new C();
      analyser.current = audioCtx.current.createAnalyser();
      analyser.current.fftSize = 512;
      analyser.current.connect(audioCtx.current.destination);
    }
    void audioCtx.current.resume();
    return audioCtx.current;
  };

  // Mouth / rings follow the real signal level.
  const meter = useCallback((node: AnalyserNode) => {
    const data = new Uint8Array(node.fftSize);
    const tick = () => {
      node.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
      raf.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf.current);
    tick();
  }, []);
  const stopMeter = () => { cancelAnimationFrame(raf.current); setLevel(0); };

  /** The microphone for this call (reused across turns, released when the call ends). */
  const getMic = useCallback(async () => {
    if (mic.current?.getAudioTracks().some((t) => t.readyState === 'live')) return mic.current;
    mic.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    return mic.current;
  }, []);
  const releaseMic = useCallback(() => { mic.current?.getTracks().forEach((t) => t.stop()); mic.current = null; }, []);

  /**
   * Start the talking presenter: ONE short-lived session from our server, then the provider's video stream. Never
   * retried automatically (each session is billed); a failure falls back to voice and chat.
   */
  const startVideo = useCallback(async () => {
    if (videoStarting.current || simli.current || !videoEl.current || !videoAudioEl.current) return;
    videoStarting.current = true;
    userStopped.current = false;
    greeted.current = false;
    setVideo('connecting');
    setNotice(null);
    try {
      const { sessionToken } = await api.post<{ sessionToken: string }>('/assistant/video/session');
      // Browser tests can substitute a stand-in presenter (window.__TARA_SIMLI__); otherwise the real Simli client.
      const testFactory = (window as unknown as { __TARA_SIMLI__?: (token: string, v: HTMLVideoElement, a: HTMLAudioElement) => SimliLike }).__TARA_SIMLI__;
      let client: SimliLike;
      if (testFactory) client = testFactory(sessionToken, videoEl.current, videoAudioEl.current);
      else {
        const { SimliClient, LogLevel } = await import('simli-client');
        client = new SimliClient(sessionToken, videoEl.current, videoAudioEl.current, null, LogLevel.ERROR, 'livekit') as unknown as SimliLike;
      }
      client.on('silent', () => { silentWaiter.current?.(); silentWaiter.current = null; });
      client.on('stop', () => {
        // Session over (time / idle limit, network, or the visitor). Never reopened automatically.
        const wasLive = simli.current === client;
        simli.current = null;
        stopSpeech.current();
        if (wasLive && !userStopped.current) {
          // End the call loop too: no half-finished recording is sent after the video ended.
          handsFreeRef.current = false;
          rec.current?.stop(false);
          releaseMic();
          setVideo('ended');
          setHandsFree(false);
          setNotice('The video call ended. You can continue by voice or chat, or start a new video call.');
        } else setVideo('off');
      });
      client.on('error', () => setNotice('The video presenter had a problem. Tara keeps answering by voice and text.'));
      // The SDK retries a failed connection for a long time; the visitor gets an answer within 15 s either way.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([client.start(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer from the video service')), 15_000); })]);
      } catch (e) {
        void client.stop().catch(() => undefined);
        throw e;
      } finally {
        clearTimeout(timer);
      }
      simli.current = client;
      setVideo('live');
      setHandsFree(true);
      // Autoplay: the tap on "Video call" normally allows sound; if the browser still blocks it, ask for one tap.
      // play() can stay pending until the provider attaches its audio track: wait briefly, never forever.
      try {
        await Promise.race([videoAudioEl.current?.play(), new Promise((r) => setTimeout(r, 1500))]);
      } catch (e) {
        if ((e as DOMException)?.name === 'NotAllowedError') { setNeedsStart(true); return; }
      }
      void greetRef.current();
    } catch (e) {
      simli.current = null;
      setVideo('off');
      setHandsFree(false);
      setNotice(`${errText(e)}`.startsWith('The video') || `${errText(e)}`.startsWith('Too many') ? errText(e) : `The video presenter could not start (${errText(e)}). Chat and voice still work.`);
    } finally {
      videoStarting.current = false;
    }
  }, [releaseMic]);
  const stopVideo = useCallback(() => {
    const c = simli.current;
    userStopped.current = true;
    simli.current = null;
    setNeedsStart(false);
    setVideo('off');
    void c?.stop().catch(() => undefined);
  }, []);

  /** Presenter speaks: our Sarvam voice at 16 kHz is streamed to it; it renders lip-synced video and plays the audio. */
  const speakVideo = useCallback(async (text: string, st: Style) => {
    const client = simli.current!;
    let cancelled = false;
    stopSpeech.current = () => { cancelled = true; try { client.ClearBuffer(); } catch { /* ended */ } silentWaiter.current?.(); };
    const parts = sentences(text);
    const pcmOf = (s: string) => api.post<{ audioBase64: string }>('/assistant/tts', { text: s, style: st, sampleRate: 16000 }).then((r) => {
      const bin = atob(r.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return wavPcm(bytes);
    });
    setPhase('speaking');
    let totalBytes = 0;
    try {
      let next = pcmOf(parts[0]);
      for (let i = 0; i < parts.length && !cancelled; i++) {
        const pcm = await next;
        if (i + 1 < parts.length) next = pcmOf(parts[i + 1]);
        if (cancelled) break;
        for (let o = 0; o < pcm.length; o += 6000) client.sendAudioData(pcm.subarray(o, Math.min(pcm.length, o + 6000)));
        totalBytes += pcm.length;
      }
      // Done when the presenter reports silence (or after the audio's length, as a fallback).
      if (!cancelled) await new Promise<void>((resolve) => { silentWaiter.current = resolve; setTimeout(resolve, (totalBytes / 32000) * 1000 + 2500); });
    } catch (e) {
      setNotice(`Voice reply unavailable: ${errText(e)} The text answer is above.`);
    } finally {
      silentWaiter.current = null;
      setPhase('idle');
    }
    return !cancelled;
  }, []);

  /**
   * While Tara speaks during a call, listen for the visitor talking over her (barge-in): stop her and listen.
   * Uses the call's echo-cancelled mic, a higher level than normal speech detection and a sustained 300 ms, so her
   * own voice from the speaker does not interrupt her (feedback loop).
   */
  const bargeIn = useCallback((onBarge: () => void) => {
    const stream = mic.current;
    if (!stream || !handsFreeRef.current) return () => undefined;
    const c = ctx();
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.fftSize);
    let loudSince = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      if (rms > BARGE_RMS) { loudSince ||= performance.now(); if (performance.now() - loudSince > BARGE_MS) { stop(); onBarge(); return; } } else loudSince = 0;
      setTimeout(tick, 50);
    };
    const stop = () => { if (!stopped) { stopped = true; try { src.disconnect(); } catch { /* gone */ } } };
    tick();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Speak a reply sentence by sentence: the next sentence's audio is fetched while the current one plays. */
  const speak = useCallback(async (text: string, st: Style) => {
    if (simli.current) {
      const endBarge = bargeIn(() => { stopSpeech.current(); bargedRef.current = true; });
      try { return await speakVideo(text, st); } finally { endBarge(); }
    }
    const c = ctx();
    let cancelled = false;
    stopSpeech.current = () => { cancelled = true; try { playing.current?.stop(); } catch { /* already stopped */ } };
    const parts = sentences(text);
    const fetchAudio = (s: string) => api.post<{ audioBase64: string }>('/assistant/tts', { text: s, style: st }).then(async (r) => {
      const bin = atob(r.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return c.decodeAudioData(bytes.buffer);
    });
    let next = fetchAudio(parts[0]);
    setPhase('speaking');
    meter(analyser.current!);
    const endBarge = bargeIn(() => { stopSpeech.current(); bargedRef.current = true; });
    try {
      for (let i = 0; i < parts.length && !cancelled; i++) {
        const buf = await next;
        if (i + 1 < parts.length) next = fetchAudio(parts[i + 1]);
        if (cancelled) break;
        await new Promise<void>((resolve) => {
          const src = c.createBufferSource();
          src.buffer = buf;
          src.connect(analyser.current!);
          src.onended = () => resolve();
          playing.current = src;
          src.start();
        });
      }
    } catch (e) {
      setNotice(`Voice reply unavailable: ${errText(e)} The text answer is above.`);
      setVoiceOut(false);
    } finally {
      endBarge();
      stopMeter();
      setPhase('idle');
    }
    return !cancelled;
  }, [meter, speakVideo, bargeIn]);

  const send = useCallback(async (text: string, viaVoice = false) => {
    const message = text.trim();
    if (!message || phase === 'thinking') return;
    stopSpeech.current();
    // Typed while the call was listening: drop that recording (the typed question wins; no double turn).
    if (!viaVoice) rec.current?.stop(false);
    setNotice(null);
    const history = msgs.slice(-8).map(({ role, content }) => ({ role, content }));
    setMsgs((m) => [...m, { role: 'user', content: message, voice: viaVoice }]);
    setInput('');
    setPhase('thinking');
    try {
      const r = await api.post<{ reply: string; style: Style; source: 'ai' | 'faq' }>('/assistant/chat', { message, history, ...(lang !== 'auto' ? { lang } : {}) });
      failures.current = 0;
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply }]);
      if ((voiceOut || simli.current) && status?.voice) {
        bargedRef.current = false;
        const finished = await speak(r.reply, r.style);
        // Continuous call: listen again after Tara finishes, or at once when the visitor talked over her.
        if (handsFreeRef.current && (finished || bargedRef.current)) setTimeout(() => void startListeningRef.current(), finished ? 250 : 0);
      } else {
        setPhase('idle');
        if (handsFreeRef.current) setTimeout(() => void startListeningRef.current(), 250);
      }
    } catch (e) {
      if (handsFreeRef.current && retryable(e) && failures.current++ < 1) {
        // One quiet retry of the turn (network blip); the visitor sees "Reconnecting".
        setPhase('reconnecting');
        setTimeout(() => void startListeningRef.current(), 1500);
        return;
      }
      setPhase('idle');
      setNotice(errText(e));
      if (handsFreeRef.current) { setHandsFree(false); setNotice(`${errText(e)} The call was paused; tap Voice call to continue.`); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, lang, voiceOut, status, phase, speak]);

  /** Record the visitor until ~1 s of silence (or 25 s), then recognise and send it. */
  const startListening = useCallback(async (fromButton = false) => {
    // The mic button toggles (tap again to send); the call loop never interrupts a recording already running.
    if (rec.current) { if (fromButton) rec.current.stop(true); return; }
    stopSpeech.current();
    setNotice(null);
    let stream: MediaStream;
    try {
      stream = await getMic();
    } catch (e) {
      const name = (e as DOMException)?.name;
      setNotice(name === 'NotFoundError' ? 'No microphone was found. Connect one, or type instead.' : name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone permission is blocked. Allow it in the browser (lock icon in the address bar), or type instead.' : 'The microphone could not start. You can type instead.');
      setHandsFree(false);
      setPhase('idle');
      return;
    }
    const c = ctx();
    const source = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 512;
    source.connect(an);
    const proc = c.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    let heard = false, lastVoice = Date.now();
    const started = Date.now();
    proc.onaudioprocess = (ev) => {
      const d = ev.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      const rms = Math.sqrt(s / d.length);
      if (rms > 0.02) { heard = true; lastVoice = Date.now(); }
      if ((heard && Date.now() - lastVoice > 1000) || Date.now() - started > 25_000 || (!heard && Date.now() - started > 8000)) stop(heard);
    };
    source.connect(proc);
    proc.connect(c.destination);
    meter(an);
    setPhase('listening');
    let done = false;
    const stop = (sendIt: boolean) => {
      if (done) return;
      done = true;
      rec.current = null;
      proc.disconnect(); source.disconnect();
      // The call keeps its microphone between turns; a single tap-to-talk releases it.
      if (!handsFreeRef.current) releaseMic();
      stopMeter();
      if (!sendIt) { setPhase('idle'); return; }
      if (!heard) {
        // In a call, silence just means "keep listening" a few times; then the call pauses (no endless open mic).
        if (handsFreeRef.current && quiet.current++ < 2) { setTimeout(() => void startListeningRef.current(), 100); return; }
        quiet.current = 0;
        setPhase('idle');
        setNotice(handsFreeRef.current ? 'Still there? The call is paused. Tap Voice call to continue.' : 'I did not hear anything. Tap the mic and speak, or type.');
        setHandsFree(false);
        releaseMic();
        return;
      }
      quiet.current = 0;
      setPhase('transcribing');
      api.post<{ transcript: string }>('/assistant/stt', { audioBase64: encodeWav(chunks, c.sampleRate) })
        .then((r) => {
          failures.current = 0;
          if (r.transcript) void send(r.transcript, true);
          else if (handsFreeRef.current) setTimeout(() => void startListeningRef.current(), 100);
          else { setPhase('idle'); setNotice('I could not catch that. Please try again.'); }
        })
        .catch((e) => {
          if (handsFreeRef.current && retryable(e) && failures.current++ < 1) { setPhase('reconnecting'); setTimeout(() => void startListeningRef.current(), 1500); return; }
          setPhase('idle'); setNotice(errText(e)); setHandsFree(false); releaseMic();
        });
    };
    rec.current = { stop };
  }, [meter, send, getMic, releaseMic]);
  startListeningRef.current = startListening;

  /** Spoken once per video session, as soon as the presenter is connected (and audio is allowed). */
  const greet = useCallback(async () => {
    if (greeted.current || !simli.current) return;
    greeted.current = true;
    const text = status?.greeting || 'Vanakkam! I am Tara, the Tacksharp AI assistant. How can I help?';
    setMsgs((m) => [...m, { role: 'assistant', content: text }]);
    try { await getMic(); } catch { /* the first listen will explain */ }
    bargedRef.current = false;
    const finished = await speak(text, lang === 'auto' ? 'en' : lang);
    if (handsFreeRef.current && (finished || bargedRef.current)) void startListening();
  }, [status, speak, startListening, lang, getMic]);
  greetRef.current = greet;

  // Unmount: stop speech, the mic, the meter and the video session (no session outlives the page).
  useEffect(() => () => { stopSpeech.current(); rec.current?.stop(false); cancelAnimationFrame(raf.current); mic.current?.getTracks().forEach((t) => t.stop()); void simli.current?.stop().catch(() => undefined); }, []);

  const greeting = status?.greeting;
  const mode: 'chat' | 'voice' | 'video' = video === 'connecting' || video === 'live' ? 'video' : handsFree ? 'voice' : 'chat';
  const setMode = (m: 'chat' | 'voice' | 'video') => {
    if (m === mode) return;
    if (m !== 'video' && video !== 'off') stopVideo();
    if (m === 'chat') { handsFreeRef.current = false; setHandsFree(false); stopSpeech.current(); rec.current?.stop(false); releaseMic(); }
    if (m === 'voice') { handsFreeRef.current = true; setHandsFree(true); failures.current = 0; quiet.current = 0; if (phase === 'idle' || phase === 'speaking') { stopSpeech.current(); void startListening(); } }
    if (m === 'video') { rec.current?.stop(false); stopSpeech.current(); void startVideo(); }
  };
  const close = () => { handsFreeRef.current = false; stopSpeech.current(); rec.current?.stop(false); setHandsFree(false); releaseMic(); stopVideo(); setOpen(false); };
  const videoLabel = video === 'connecting' ? 'Connecting…' : video === 'ended' ? 'Ended' : PHASE_LABEL[phase];
  const iconBtn = 'grid size-9 place-items-center rounded-[10px] text-[#16183d]/70 hover:bg-[#16183d]/5 hover:text-[#16183d] disabled:opacity-40';
  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} aria-label="Chat or talk with Tara, the Tacksharp AI assistant" className="group fixed right-4 bottom-4 z-[55] flex items-center gap-3 rounded-full border border-white/10 bg-[#16183d] p-1.5 text-left text-white shadow-[0_18px_40px_-14px_rgba(22,24,61,0.75)] transition-transform hover:-translate-y-0.5 sm:pr-5 print:hidden">
          <span className="relative">
            <Orb size={44} />
            <span className="absolute right-0 bottom-0 size-3 rounded-full bg-emerald-400 ring-2 ring-[#16183d]" />
          </span>
          <span className="hidden leading-tight sm:block">
            <span className="block text-[14px] font-semibold">Talk to Tara</span>
            <span className="block text-[11.5px] text-white/60">AI assistant · தமிழ் · English</span>
          </span>
        </button>
      )}
      {open && (
        <section role="dialog" aria-modal="false" aria-label="Tara, Tacksharp AI assistant" className="fixed inset-0 z-[55] flex flex-col overflow-hidden bg-white sm:inset-auto sm:right-4 sm:bottom-4 sm:h-[680px] sm:max-h-[calc(100dvh-2rem)] sm:w-[420px] sm:rounded-[20px] sm:border sm:border-black/5 sm:shadow-[0_40px_90px_-30px_rgba(22,24,61,0.6)] print:hidden">
          <header className="flex items-center gap-3 border-b border-black/5 px-4 py-3">
            <Orb size={36} level={level} phase={phase} />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-[15px] font-semibold text-[#16183d]">Tara <span className="ml-1 rounded-full bg-[#ebeaf6] px-1.5 py-px align-middle text-[10.5px] font-semibold text-[#16183d]/70">AI</span></p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[#16183d]/60" aria-live="polite">
                <span className={cx('size-1.5 rounded-full', phase === 'reconnecting' || video === 'ended' ? 'bg-amber-500' : phase === 'idle' ? 'bg-emerald-500' : phase === 'listening' ? 'bg-rose-500' : 'bg-[#7c5cf0]')} /><span data-testid="tara-status">{video !== 'off' ? videoLabel : PHASE_LABEL[phase]}</span>
              </p>
            </div>
            <button onClick={() => { setVoiceOut(!voiceOut); stopSpeech.current(); }} aria-pressed={voiceOut} aria-label={voiceOut ? 'Mute voice replies' : 'Turn on voice replies'} title={voiceOut ? 'Voice replies on' : 'Voice replies off'} className={iconBtn} disabled={!status?.voice}>
              {voiceOut && status?.voice ? <Volume2 className="size-[18px]" /> : <VolumeX className="size-[18px]" />}
            </button>
            <button onClick={close} aria-label="Close assistant" className={iconBtn}><X className="size-[18px]" /></button>
          </header>

          {/* Stage: the video presenter, or the voice visual. */}
          <div className="relative bg-[radial-gradient(120%_100%_at_50%_0%,#262a63_0%,#16183d_60%,#0d0f2b_100%)] px-4 pt-4 pb-3 text-white">
            {status?.video && (
              <div className={cx('relative overflow-hidden rounded-[14px] bg-black/40', video === 'connecting' || video === 'live' ? 'block' : 'hidden')}>
                <video ref={videoEl} autoPlay playsInline muted={false} className="aspect-video w-full object-cover" aria-label="Tara, AI video presenter" />
                <audio ref={videoAudioEl} autoPlay />
                {video === 'connecting' && <p className="absolute inset-0 grid place-items-center text-[13px] text-white/80"><span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />Connecting video…</span></p>}
                <span className="absolute bottom-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur">AI presenter · our voice</span>
                {video === 'live' && <span className="absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur" aria-live="polite">{videoLabel}</span>}
                {needsStart && (
                  <button onClick={() => { setNeedsStart(false); void videoAudioEl.current?.play().catch(() => undefined); void greetRef.current(); }} className="absolute inset-0 grid place-items-center bg-black/50 text-[14px] font-semibold text-white">
                    <span className="rounded-full bg-white px-4 py-2 text-[#16183d]">Start conversation</span>
                  </button>
                )}
              </div>
            )}
            {(video === 'off' || video === 'ended') && (
              <div className="flex items-center gap-4">
                <Orb size={64} level={level} phase={phase} />
                <div className="min-w-0 flex-1">
                  <Waveform level={level} phase={phase} />
                  <p className="mt-1 truncate text-[12px] text-white/60">{video === 'ended' ? 'Video call ended' : phase === 'idle' ? (mode === 'voice' ? 'Voice call on · just start talking' : 'Ask by typing, or switch to a voice call') : PHASE_LABEL[phase]}</p>
                </div>
              </div>
            )}
            <div className="mt-3 grid grid-flow-col gap-1 rounded-[12px] bg-white/8 p-1" role="group" aria-label="How to talk">
              {([['chat', 'Chat', MessageSquareText], ...(status?.voice ? [['voice', 'Voice call', Phone]] : []), ...(status?.video ? [['video', 'Video call', Video]] : [])] as Array<[typeof mode, string, typeof Video]>).map(([m, label, Icon]) => (
                <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m} disabled={m === 'video' && video === 'connecting'} className={cx('inline-flex items-center justify-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[12.5px] font-semibold transition-colors', mode === m ? 'bg-white text-[#16183d]' : 'text-white/75 hover:bg-white/10')}>
                  {m === 'video' && video === 'connecting' ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}{label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1 border-b border-black/5 px-3 py-2" role="radiogroup" aria-label="Reply language">
            <Languages className="mr-1 size-3.5 text-[#16183d]/40" aria-hidden />
            {LANGS.map((l) => (
              <button key={l.id} role="radio" aria-checked={lang === l.id} onClick={() => setLang(l.id)} className={cx('rounded-full px-2.5 py-1 text-[12px] font-semibold', lang === l.id ? 'bg-[#16183d] text-white' : 'text-[#16183d]/65 hover:bg-[#ebeaf6]')}>{l.label}</button>
            ))}
          </div>

          <ol ref={listRef} className="flex-1 space-y-3 overflow-y-auto bg-[#f7f8fc] px-3 py-4" aria-live="polite" aria-label="Conversation">
            {greeting && (
              <li className="flex items-start gap-2"><Orb size={24} /><p className="max-w-[85%] rounded-[14px] rounded-tl-[4px] bg-white px-3 py-2 text-[14px] leading-relaxed text-[#16183d] shadow-[0_1px_2px_rgba(22,24,61,0.06)] ring-1 ring-black/5">{greeting}</p></li>
            )}
            {msgs.map((m, i) => (
              <li key={i} className={cx('flex items-start gap-2', m.role === 'user' && 'justify-end')}>
                {m.role === 'assistant' && <Orb size={24} />}
                <p className={cx('max-w-[85%] rounded-[14px] px-3 py-2 text-[14px] leading-relaxed whitespace-pre-wrap', m.role === 'user' ? 'rounded-tr-[4px] bg-[#16183d] text-white' : 'rounded-tl-[4px] bg-white text-[#16183d] shadow-[0_1px_2px_rgba(22,24,61,0.06)] ring-1 ring-black/5')}>
                  {m.voice && <Mic className="mr-1 inline size-3.5 opacity-70" aria-label="spoken" />}{m.content}
                </p>
              </li>
            ))}
            {(phase === 'thinking' || phase === 'transcribing') && (
              <li className="flex items-center gap-2"><Orb size={24} phase="speaking" level={0.4} /><span className="inline-flex items-center gap-1 rounded-[14px] bg-white px-3 py-2.5 ring-1 ring-black/5" aria-label={phase === 'transcribing' ? 'Listening back' : 'Typing'}>{[0, 1, 2].map((d) => <span key={d} className="size-1.5 rounded-full bg-[#16183d]/40 motion-safe:animate-bounce" style={{ animationDelay: `${d * 140}ms` }} />)}</span></li>
            )}
          </ol>
          {msgs.length === 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-black/5 px-3 pt-2.5">
              {QUICK[style].map(([e, q]) => <button key={q} onClick={() => void send(q)} className="rounded-full border border-[#16183d]/12 bg-white px-3 py-1.5 text-[12.5px] font-medium text-[#16183d] hover:border-[#16183d]/30 hover:bg-[#f7f8fc]"><span aria-hidden>{e}</span> {q}</button>)}
            </div>
          )}
          {notice && <p role="status" className="mx-3 mt-2 rounded-[10px] bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 ring-1 ring-amber-200">{notice}</p>}
          <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="p-3">
            <div className="flex items-end gap-1.5 rounded-[16px] border border-black/10 bg-white p-1.5 focus-within:border-[#16183d]/40 focus-within:ring-4 focus-within:ring-[#16183d]/5">
              <label htmlFor="tara-input" className="sr-only">Message Tara</label>
              <textarea id="tara-input" ref={inputRef} rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} placeholder={style === 'ta' ? 'உங்க கேள்வியை type பண்ணுங்க…' : style === 'tanglish' ? 'Unga question type pannunga…' : 'Ask about Tacksharp…'} className="max-h-28 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[14px] text-[#16183d] outline-none placeholder:text-[#16183d]/40" />
              {status?.voice && (
                <button type="button" onClick={() => { if (phase === 'speaking') { stopSpeech.current(); return; } void startListening(true); }} aria-label={phase === 'listening' ? 'Stop and send' : phase === 'speaking' ? 'Stop speaking' : 'Speak your question'} className={cx('grid size-10 shrink-0 place-items-center rounded-[12px] transition-colors', phase === 'listening' ? 'bg-rose-600 text-white' : 'text-[#16183d]/70 hover:bg-[#16183d]/5')}>
                  {phase === 'listening' ? <Square className="size-4" /> : phase === 'speaking' ? <MicOff className="size-[18px]" /> : <Mic className="size-[18px]" />}
                </button>
              )}
              <button type="submit" aria-label="Send" disabled={!input.trim() || phase === 'thinking'} className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-[#16183d] text-white transition-opacity disabled:opacity-30"><ArrowUp className="size-[18px]" /></button>
            </div>
            <p className="mt-2 text-center text-[11px] text-[#16183d]/45">AI assistant · please don&apos;t share personal details</p>
          </form>
        </section>
      )}
    </>
  );
}
