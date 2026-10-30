'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, FileText, Loader2, MessageSquareText, Mic, PhoneOff, Phone, Square, UserRound, Volume2, VolumeX } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { encodeWav, sentences } from '@/lib/voice';
import { cx } from './ui';

export type Style = 'ta' | 'en' | 'tanglish';
export type AgentReply = {
  reply: string;
  style: Style;
  source: 'ai' | 'knowledge' | 'fallback' | 'escalation';
  escalate?: boolean;
  sources?: Array<{ filename: string; source: string }>;
  timings?: { retrievalMs: number; modelMs: number; totalMs: number };
  simulated?: boolean;
};
type Msg = { role: 'user' | 'assistant'; content: string; voice?: boolean; meta?: AgentReply; ms?: number };
type Phase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'reconnecting';
const LABEL: Record<Phase, string> = { idle: 'Ready', listening: 'Listening…', transcribing: 'Got it…', thinking: 'Thinking…', speaking: 'Speaking…', reconnecting: 'Reconnecting…' };
const SOURCE_LABEL: Record<AgentReply['source'], string> = { ai: 'AI answer from the knowledge base', knowledge: 'Quoted from the knowledge base (no AI model configured)', fallback: 'Not in the knowledge base: fallback message', escalation: 'Handed to a person' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const retryable = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500;

/**
 * One conversation console for every custom agent: the public template demos and the Agent Builder's Test step use
 * the same engine on the server. Chat or a continuous voice conversation (our server's Sarvam speech recognition and
 * voice; nothing runs in the browser's own speech engine), with barge-in, mute, and clear failure states.
 */
export function AgentConsole({ greeting, examples, send, label, voice: voiceAvailable, compact }: {
  greeting: string;
  examples: string[];
  send: (message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<AgentReply>;
  label: string;
  voice: boolean;
  compact?: boolean;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [call, setCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const callRef = useRef(false);
  callRef.current = call;
  const msgsRef = useRef<Msg[]>([]);
  msgsRef.current = msgs;
  const ctxRef = useRef<AudioContext | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const stopSpeech = useRef<() => void>(() => undefined);
  const stopRec = useRef<(send: boolean) => void>(() => undefined);
  const failures = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, phase]);
  const ctx = () => {
    if (!ctxRef.current) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new C();
    }
    void ctxRef.current.resume();
    return ctxRef.current;
  };
  const releaseMic = () => { mic.current?.getTracks().forEach((t) => t.stop()); mic.current = null; };
  useEffect(() => () => { stopSpeech.current(); stopRec.current(false); releaseMic(); void ctxRef.current?.close().catch(() => undefined); }, []);

  /** Plays the reply sentence by sentence (next sentence fetched while one plays). Stops when the caller talks over it. */
  const speak = useCallback(async (text: string, style: Style) => {
    const c = ctx();
    let cancelled = false;
    let playing: AudioBufferSourceNode | null = null;
    stopSpeech.current = () => { cancelled = true; try { playing?.stop(); } catch { /* done */ } };
    const parts = sentences(text);
    const audio = (s: string) => api.post<{ audioBase64: string }>('/assistant/tts', { text: s, style }).then((r) => {
      const bin = atob(r.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return c.decodeAudioData(bytes.buffer);
    });
    // Barge-in on the call's echo-cancelled mic: louder and sustained, so the agent's own voice does not trigger it.
    let barged = false;
    let bargeTimer: ReturnType<typeof setInterval> | undefined;
    if (callRef.current && mic.current) {
      const src = c.createMediaStreamSource(mic.current);
      const an = c.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.fftSize);
      let since = 0;
      bargeTimer = setInterval(() => {
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        if (Math.sqrt(sum / data.length) > 0.06) { since ||= performance.now(); if (performance.now() - since > 300) { barged = true; stopSpeech.current(); } } else since = 0;
      }, 50);
      const prev = stopSpeech.current;
      stopSpeech.current = () => { prev(); clearInterval(bargeTimer); try { src.disconnect(); } catch { /* gone */ } };
    }
    setPhase('speaking');
    try {
      let next = audio(parts[0]);
      for (let i = 0; i < parts.length && !cancelled; i++) {
        const buf = await next;
        if (i + 1 < parts.length) next = audio(parts[i + 1]);
        if (cancelled) break;
        await new Promise<void>((resolve) => {
          const s = c.createBufferSource();
          s.buffer = buf;
          s.connect(c.destination);
          s.onended = () => resolve();
          playing = s;
          s.start();
        });
      }
    } catch (e) {
      setNotice(`Voice reply unavailable (${errText(e)}). The text answer is shown.`);
    } finally {
      clearInterval(bargeTimer);
      setPhase('idle');
    }
    return { finished: !cancelled, barged };
  }, []);

  const ask = useCallback(async (text: string, viaVoice = false) => {
    const message = text.trim();
    if (!message) return;
    stopSpeech.current();
    setNotice(null);
    const history = msgsRef.current.slice(-8).map(({ role, content }) => ({ role, content }));
    setMsgs((m) => [...m, { role: 'user', content: message, voice: viaVoice }]);
    setInput('');
    setPhase('thinking');
    const started = performance.now();
    try {
      const r = await send(message, history);
      failures.current = 0;
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply, meta: r, ms: Math.round(performance.now() - started) }]);
      if (voiceAvailable && (!muted || callRef.current)) {
        const { finished, barged } = await speak(r.reply, r.style);
        if (callRef.current && (finished || barged)) setTimeout(() => void listenRef.current(), barged ? 0 : 200);
      } else {
        setPhase('idle');
        if (callRef.current) setTimeout(() => void listenRef.current(), 200);
      }
    } catch (e) {
      if (callRef.current && retryable(e) && failures.current++ < 1) { setPhase('reconnecting'); setTimeout(() => void listenRef.current(), 1500); return; }
      setPhase('idle');
      setNotice(errText(e));
      if (callRef.current) { setCall(false); releaseMic(); }
    }
  }, [send, speak, voiceAvailable, muted]);

  /** Record one utterance (ends after ~1 s of silence), recognise it on our server, and ask the agent. */
  const listenRef = useRef<() => Promise<void>>(async () => undefined);
  const listen = useCallback(async () => {
    stopSpeech.current();
    let stream: MediaStream;
    try {
      if (!mic.current) mic.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      stream = mic.current;
    } catch (e) {
      const n = (e as DOMException)?.name;
      setNotice(n === 'NotFoundError' ? 'No microphone found. You can type instead.' : 'Microphone permission is blocked. Allow it in the browser address bar, or type instead.');
      setCall(false);
      setPhase('idle');
      return;
    }
    const c = ctx();
    const source = c.createMediaStreamSource(stream);
    const proc = c.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    let heard = false, last = Date.now(), done = false;
    const begun = Date.now();
    const stop = (sendIt: boolean) => {
      if (done) return;
      done = true;
      stopRec.current = () => undefined;
      proc.disconnect(); source.disconnect();
      if (!callRef.current) releaseMic();
      if (!sendIt) { setPhase('idle'); return; }
      if (!heard) {
        setPhase('idle');
        setNotice(callRef.current ? 'No speech heard. The call is paused: press Voice to continue.' : 'No speech heard. Try again or type.');
        setCall(false); releaseMic();
        return;
      }
      setPhase('transcribing');
      api.post<{ transcript: string }>('/assistant/stt', { audioBase64: encodeWav(chunks, c.sampleRate) })
        .then((r) => { failures.current = 0; if (r.transcript) void ask(r.transcript, true); else if (callRef.current) void listenRef.current(); else setPhase('idle'); })
        .catch((e) => {
          if (callRef.current && retryable(e) && failures.current++ < 1) { setPhase('reconnecting'); setTimeout(() => void listenRef.current(), 1500); return; }
          setPhase('idle'); setNotice(errText(e)); setCall(false); releaseMic();
        });
    };
    proc.onaudioprocess = (ev) => {
      const d = ev.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      if (Math.sqrt(s / d.length) > 0.02) { heard = true; last = Date.now(); }
      if ((heard && Date.now() - last > 1000) || Date.now() - begun > 25_000 || (!heard && Date.now() - begun > 10_000)) stop(heard);
    };
    source.connect(proc);
    proc.connect(c.destination);
    stopRec.current = stop;
    setPhase('listening');
  }, [ask]);
  listenRef.current = listen;

  const toggleCall = () => {
    if (call) { callRef.current = false; setCall(false); stopSpeech.current(); stopRec.current(false); releaseMic(); setPhase('idle'); return; }
    callRef.current = true; setCall(true); failures.current = 0; setNotice(null); void listen();
  };

  return (
    <div className={cx('flex flex-col overflow-hidden rounded-[14px] border border-line bg-white', compact ? 'h-[460px]' : 'h-[560px]')}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={cx('size-2 rounded-full', phase === 'reconnecting' ? 'bg-amber-500' : phase === 'listening' ? 'bg-rose-500' : phase === 'idle' ? 'bg-emerald-500' : 'bg-brand')} />
        <span className="text-[12.5px] font-semibold text-ink" data-testid="console-status" aria-live="polite">{call && phase === 'idle' ? 'Call on' : LABEL[phase]}</span>
        <span className="ml-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">{label}</span>
        <div className="ml-auto flex items-center gap-1">
          {voiceAvailable && (
            <button onClick={() => { setMuted(!muted); stopSpeech.current(); }} aria-pressed={muted} aria-label={muted ? 'Unmute replies' : 'Mute replies'} className="grid size-8 place-items-center rounded-[8px] text-muted hover:bg-canvas">{muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}</button>
          )}
          {voiceAvailable ? (
            <button onClick={toggleCall} aria-pressed={call} className={cx('inline-flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-[12.5px] font-semibold', call ? 'bg-rose-600 text-white' : 'bg-ink text-white')}>
              {call ? <><PhoneOff className="size-3.5" />End voice</> : <><Phone className="size-3.5" />Voice</>}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-muted"><MessageSquareText className="size-3.5" />Chat only (voice not configured on this server)</span>
          )}
        </div>
      </div>
      <ol ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto bg-canvas px-3 py-3" aria-label="Conversation" aria-live="polite">
        <li className="max-w-[88%] rounded-[12px] rounded-tl-[4px] bg-white px-3 py-2 text-[13.5px] text-ink ring-1 ring-line">{greeting}</li>
        {msgs.map((m, i) => (
          <li key={i} className={cx('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
            <p className={cx('max-w-[88%] rounded-[12px] px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap', m.role === 'user' ? 'rounded-tr-[4px] bg-ink text-white' : 'rounded-tl-[4px] bg-white text-ink ring-1 ring-line')}>
              {m.voice && <Mic className="mr-1 inline size-3 opacity-70" aria-label="spoken" />}{m.content}
            </p>
            {m.meta && (
              <p className="mt-1 flex max-w-[88%] flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted" data-testid="reply-meta">
                {m.meta.escalate ? <span className="inline-flex items-center gap-1 font-semibold text-amber-800"><UserRound className="size-3" />Handoff to a person</span> : <span>{SOURCE_LABEL[m.meta.source]}</span>}
                {m.meta.sources?.map((s) => <span key={`${s.filename}${s.source}`} className="inline-flex items-center gap-1 rounded bg-white px-1.5 ring-1 ring-line"><FileText className="size-3" />{s.filename} · {s.source}</span>)}
                {m.ms !== undefined && <span className="tabular">{(m.ms / 1000).toFixed(1)} s</span>}
              </p>
            )}
          </li>
        ))}
        {(phase === 'thinking' || phase === 'transcribing') && <li className="inline-flex items-center gap-2 text-[12px] text-muted"><Loader2 className="size-3.5 animate-spin" />{LABEL[phase]}</li>}
      </ol>
      {msgs.length === 0 && examples.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-line px-3 pt-2">
          {examples.map((q) => <button key={q} onClick={() => void ask(q)} className="rounded-full border border-line bg-white px-2.5 py-1 text-[12px] font-medium text-ink hover:border-ink/30">{q}</button>)}
        </div>
      )}
      {notice && <p role="status" className="mx-3 mt-2 rounded-[8px] bg-amber-50 px-3 py-1.5 text-[12px] text-amber-900 ring-1 ring-amber-200">{notice}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void ask(input); }} className="flex items-center gap-1.5 p-2.5">
        <label className="sr-only" htmlFor="agent-console-input">Message the agent</label>
        <input id="agent-console-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type in Tamil, English or Tanglish…" className="h-10 flex-1 rounded-[10px] border border-line bg-white px-3 text-[13.5px] text-ink outline-none focus:border-brand" />
        {voiceAvailable && !call && (
          <button type="button" onClick={() => (phase === 'listening' ? stopRec.current(true) : void listen())} aria-label={phase === 'listening' ? 'Stop and send' : 'Speak once'} className={cx('grid size-10 place-items-center rounded-[10px]', phase === 'listening' ? 'bg-rose-600 text-white' : 'text-muted hover:bg-canvas')}>
            {phase === 'listening' ? <Square className="size-4" /> : <Mic className="size-4" />}
          </button>
        )}
        <button type="submit" aria-label="Send" disabled={!input.trim() || phase === 'thinking'} className="grid size-10 place-items-center rounded-[10px] bg-ink text-white disabled:opacity-30"><ArrowUp className="size-4" /></button>
      </form>
    </div>
  );
}
