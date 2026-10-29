'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Headphones, Loader2, Mic, MicOff, Send, Square, Volume2, VolumeX, X } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { cx } from './ui';

/**
 * "Tara": the Tacksharp assistant on the website and in the dashboard. Text or voice in Tamil, English or Tanglish;
 * answers come from the website's own content (server), speech from Sarvam (server). The face is an animated
 * illustration whose mouth follows the actual voice audio; it is labelled as an AI assistant, never as a person.
 */
type Style = 'ta' | 'en' | 'tanglish';
type Msg = { role: 'user' | 'assistant'; content: string; voice?: boolean };
type Phase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

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
const PHASE_LABEL: Record<Phase, string> = { idle: 'AI assistant · online', listening: 'Listening…', transcribing: 'Got it…', thinking: 'Thinking…', speaking: 'Speaking…' };
const STORE = 'ts-tara-v1';

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** Split a reply into speakable sentences (Tamil, English and mixed) so the first one plays while the rest are made. */
function sentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?।\n]+[.!?।]*\s*/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out.length && (out[out.length - 1].length < 25 || p.length < 12)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out.slice(0, 6);
}

/** 16 kHz mono 16-bit WAV from recorded float samples (what speech recognition expects). */
function encodeWav(chunks: Float32Array[], inRate: number): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = inRate / 16000;
  const n = Math.floor(all.length / ratio);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (p: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // Average the source samples that fall into this output sample (simple anti-aliasing).
    const a = Math.floor(i * ratio), b = Math.min(all.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    const x = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The animated face. `level` (0..1) opens the mouth with the live audio; eyes blink; rings show listening. */
function Face({ level, phase, size = 96 }: { level: number; phase: Phase; size?: number }) {
  const mouth = phase === 'speaking' ? 1.5 + level * 9 : phase === 'listening' ? 1.2 : 1;
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
      {phase === 'listening' && <span className="absolute inset-0 rounded-full bg-emerald-400/30 motion-safe:animate-ping" style={{ transform: `scale(${1 + level * 0.25})` }} />}
      <svg viewBox="0 0 120 120" width={size} height={size} className="relative drop-shadow-sm">
        <defs>
          <radialGradient id="tara-bg" cx="35%" cy="30%"><stop offset="0%" stopColor="#3b3f86" /><stop offset="100%" stopColor="#16183d" /></radialGradient>
          <linearGradient id="tara-skin" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#c98a62" /><stop offset="100%" stopColor="#a8694a" /></linearGradient>
        </defs>
        <circle cx="60" cy="60" r="58" fill="url(#tara-bg)" />
        {/* hair back, neck, shoulders */}
        <path d="M24 70c0-26 16-44 36-44s36 18 36 44v30H24z" fill="#1f1412" />
        <rect x="51" y="78" width="18" height="18" rx="6" fill="#a8694a" />
        <path d="M22 118c4-16 20-24 38-24s34 8 38 24z" fill="#0f9f6e" />
        {/* face */}
        <ellipse cx="60" cy="60" rx="24" ry="28" fill="url(#tara-skin)" />
        {/* hair front */}
        <path d="M35 56c2-18 14-27 27-27 13 0 24 9 25 26-8-9-20-14-33-13-7 1-13 6-19 14z" fill="#1f1412" />
        {/* eyes (blink) */}
        <g className="tara-blink">
          <ellipse cx="51" cy="60" rx="3.2" ry="3.6" fill="#1b1311" />
          <ellipse cx="69" cy="60" rx="3.2" ry="3.6" fill="#1b1311" />
          <circle cx="52" cy="59" r="0.9" fill="#fff" />
          <circle cx="70" cy="59" r="0.9" fill="#fff" />
        </g>
        <path d="M46 53.5q5-2.5 9 0M65 53.5q5-2.5 9 0" stroke="#1b1311" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <circle cx="60" cy="48.5" r="1.4" fill="#e11d48" />
        <path d="M58 64q2 3 4 0" stroke="#8a5238" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        {/* mouth: follows the voice */}
        <ellipse cx="60" cy="74" rx={5.5 - Math.min(1.5, level * 2)} ry={mouth} fill="#5a1f22" />
        {phase !== 'speaking' && <path d="M54.5 73.5q5.5 4 11 0" stroke="#5a1f22" strokeWidth="1.6" fill="none" strokeLinecap="round" />}
        <circle cx="38" cy="70" r="2" fill="#f2a516" />
        <circle cx="82" cy="70" r="2" fill="#f2a516" />
      </svg>
      {phase === 'thinking' && (
        <span className="absolute -right-1 -bottom-1 flex gap-0.5 rounded-full bg-white px-1.5 py-1 shadow">
          {[0, 1, 2].map((i) => <span key={i} className="size-1.5 rounded-full bg-[#16183d] motion-safe:animate-bounce" style={{ animationDelay: `${i * 120}ms` }} />)}
        </span>
      )}
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
  const [status, setStatus] = useState<{ chat: 'ai' | 'faq'; voice: boolean; greeting: string } | null>(null);
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
    api.get<{ chat: 'ai' | 'faq'; voice: boolean; greeting: string }>(`/assistant/status?lang=${style}`).then(setStatus).catch(() => setStatus({ chat: 'faq', voice: false, greeting: '' }));
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

  /** Speak a reply sentence by sentence: the next sentence's audio is fetched while the current one plays. */
  const speak = useCallback(async (text: string, st: Style) => {
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
      stopMeter();
      setPhase('idle');
    }
    return !cancelled;
  }, [meter]);

  const send = useCallback(async (text: string, viaVoice = false) => {
    const message = text.trim();
    if (!message || phase === 'thinking') return;
    stopSpeech.current();
    setNotice(null);
    const history = msgs.slice(-8).map(({ role, content }) => ({ role, content }));
    setMsgs((m) => [...m, { role: 'user', content: message, voice: viaVoice }]);
    setInput('');
    setPhase('thinking');
    try {
      const r = await api.post<{ reply: string; style: Style; source: 'ai' | 'faq' }>('/assistant/chat', { message, history, ...(lang !== 'auto' ? { lang } : {}) });
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply }]);
      if (voiceOut && status?.voice) {
        const finished = await speak(r.reply, r.style);
        if (finished && handsFreeRef.current) setTimeout(() => startListening(), 250);
      } else setPhase('idle');
    } catch (e) {
      setPhase('idle');
      setNotice(errText(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, lang, voiceOut, status, phase, speak]);

  /** Record the visitor until ~1 s of silence (or 25 s), then recognise and send it. */
  const startListening = useCallback(async () => {
    if (rec.current) { rec.current.stop(true); return; }
    stopSpeech.current();
    setNotice(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      setNotice('Microphone permission is needed to talk. You can type instead.');
      setHandsFree(false);
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
      stream.getTracks().forEach((t) => t.stop());
      stopMeter();
      if (!sendIt || !heard) { setPhase('idle'); if (!heard) setNotice('I did not hear anything. Tap the mic and speak, or type.'); setHandsFree(false); return; }
      setPhase('transcribing');
      api.post<{ transcript: string }>('/assistant/stt', { audioBase64: encodeWav(chunks, c.sampleRate) })
        .then((r) => { if (r.transcript) void send(r.transcript, true); else { setPhase('idle'); setNotice('I could not catch that. Please try again.'); } })
        .catch((e) => { setPhase('idle'); setNotice(errText(e)); setHandsFree(false); });
    };
    rec.current = { stop };
  }, [meter, send]);

  useEffect(() => () => { stopSpeech.current(); rec.current?.stop(false); cancelAnimationFrame(raf.current); }, []);

  const greeting = status?.greeting;
  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} aria-label="Chat or talk with Tara, the Tacksharp AI assistant" className="group fixed right-4 bottom-4 z-[55] flex items-center gap-2 rounded-full bg-[#16183d] py-1.5 pr-4 pl-1.5 text-[14px] font-semibold text-white shadow-[0_12px_30px_-10px_rgba(22,24,61,0.7)] hover:bg-[#262a63] print:hidden">
          <Face level={0} phase="idle" size={44} />
          <span className="hidden sm:inline">Ask Tara</span>
          <span className="sm:hidden">Ask</span>
          <span className="absolute top-1.5 left-10 size-3 rounded-full bg-emerald-400 ring-2 ring-[#16183d]" aria-hidden />
        </button>
      )}
      {open && (
        <section role="dialog" aria-modal="false" aria-label="Tara, Tacksharp AI assistant" className="fixed inset-0 z-[55] flex flex-col bg-white sm:inset-auto sm:right-4 sm:bottom-4 sm:h-[640px] sm:max-h-[calc(100dvh-2rem)] sm:w-[400px] sm:rounded-[22px] sm:shadow-[0_30px_80px_-20px_rgba(22,24,61,0.55)] print:hidden">
          <header className="flex items-center gap-3 rounded-t-[22px] bg-[#16183d] px-4 py-3 text-white">
            <Face level={level} phase={phase} size={64} />
            <div className="min-w-0 flex-1">
              <p className="text-[16px] font-bold">Tara</p>
              <p className="text-[12px] text-white/70" aria-live="polite">{PHASE_LABEL[phase]}</p>
            </div>
            <button onClick={() => { setVoiceOut(!voiceOut); stopSpeech.current(); }} aria-pressed={voiceOut} aria-label={voiceOut ? 'Mute voice replies' : 'Turn on voice replies'} title={voiceOut ? 'Voice replies on' : 'Voice replies off'} className="grid size-10 place-items-center rounded-full hover:bg-white/10" disabled={!status?.voice}>
              {voiceOut && status?.voice ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}
            </button>
            <button onClick={() => { stopSpeech.current(); rec.current?.stop(false); setHandsFree(false); setOpen(false); }} aria-label="Close assistant" className="grid size-10 place-items-center rounded-full hover:bg-white/10"><X className="size-5" /></button>
          </header>
          <div className="flex items-center gap-1 border-b border-black/5 px-3 py-2" role="radiogroup" aria-label="Reply language">
            {LANGS.map((l) => (
              <button key={l.id} role="radio" aria-checked={lang === l.id} onClick={() => setLang(l.id)} className={cx('rounded-full px-2.5 py-1 text-[12.5px] font-semibold', lang === l.id ? 'bg-[#16183d] text-white' : 'text-[#16183d]/70 hover:bg-[#ebeaf6]')}>{l.label}</button>
            ))}
            <span className="ml-auto text-[11px] text-[#16183d]/50">{status?.chat === 'faq' ? 'Quick answers' : 'AI'}</span>
          </div>
          <ol ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto bg-[#fbfcfe] px-3 py-3" aria-live="polite" aria-label="Conversation">
            {greeting && <li className="max-w-[88%] rounded-[16px] rounded-tl-[4px] bg-white px-3 py-2 text-[14px] text-[#16183d] shadow-sm ring-1 ring-black/5">{greeting}</li>}
            {msgs.map((m, i) => (
              <li key={i} className={cx('max-w-[88%] rounded-[16px] px-3 py-2 text-[14px] leading-snug whitespace-pre-wrap', m.role === 'user' ? 'ml-auto rounded-tr-[4px] bg-[#16183d] text-white' : 'rounded-tl-[4px] bg-white text-[#16183d] shadow-sm ring-1 ring-black/5')}>
                {m.voice && <Mic className="mr-1 inline size-3.5 opacity-70" aria-label="spoken" />}{m.content}
              </li>
            ))}
            {(phase === 'thinking' || phase === 'transcribing') && <li className="inline-flex items-center gap-2 rounded-[16px] bg-white px-3 py-2 text-[13px] text-[#16183d]/60 ring-1 ring-black/5"><Loader2 className="size-4 animate-spin" />{phase === 'transcribing' ? 'Listening back…' : 'Typing…'}</li>}
          </ol>
          {msgs.length === 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-2">
              {QUICK[style].map(([e, q]) => <button key={q} onClick={() => void send(q)} className="rounded-full bg-[#ebeaf6] px-3 py-1.5 text-[12.5px] font-medium text-[#16183d] hover:bg-[#dcdbf0]"><span aria-hidden>{e}</span> {q}</button>)}
            </div>
          )}
          {notice && <p role="status" className="mx-3 mb-2 rounded-[10px] bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">{notice}</p>}
          <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="flex items-end gap-2 border-t border-black/5 p-3">
            <label htmlFor="tara-input" className="sr-only">Message Tara</label>
            <textarea id="tara-input" ref={inputRef} rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} placeholder={style === 'ta' ? 'உங்க கேள்வியை type பண்ணுங்க…' : style === 'tanglish' ? 'Unga question type pannunga…' : 'Type your question…'} className="max-h-28 min-h-11 flex-1 resize-none rounded-[14px] border border-black/10 px-3 py-2.5 text-[14px] outline-none focus:border-[#16183d]" />
            {status?.voice && (
              <button type="button" onClick={() => { if (phase === 'speaking') { stopSpeech.current(); return; } void startListening(); }} aria-label={phase === 'listening' ? 'Stop and send' : phase === 'speaking' ? 'Stop speaking' : 'Speak your question'} className={cx('grid size-11 shrink-0 place-items-center rounded-full', phase === 'listening' ? 'bg-rose-600 text-white' : 'bg-[#ebeaf6] text-[#16183d] hover:bg-[#dcdbf0]')}>
                {phase === 'listening' ? <Square className="size-4" /> : phase === 'speaking' ? <MicOff className="size-5" /> : <Mic className="size-5" />}
              </button>
            )}
            <button type="submit" aria-label="Send" disabled={!input.trim() || phase === 'thinking'} className="grid size-11 shrink-0 place-items-center rounded-full bg-[#0f9f6e] text-white disabled:opacity-40"><Send className="size-5" /></button>
          </form>
          <div className="flex items-center justify-between px-3 pb-3 text-[11.5px] text-[#16183d]/55">
            {status?.voice ? (
              <label className="flex items-center gap-1.5 whitespace-nowrap"><input type="checkbox" checked={handsFree} onChange={(e) => { setHandsFree(e.target.checked); if (e.target.checked && phase === 'idle') void startListening(); }} /><Headphones className="size-3.5" aria-hidden /> Talk hands-free</label>
            ) : <span>Voice is not available right now; typing works.</span>}
            <span className="text-right">AI assistant · from our website</span>
          </div>
        </section>
      )}
    </>
  );
}
