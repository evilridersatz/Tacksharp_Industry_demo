'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Mic, MicOff, Phone, PhoneOff, ReceiptText, Sparkles, Store, UserRound, Video, X } from 'lucide-react';
import { API_URL, ApiError, api } from '@/lib/api';
import { LiveAgent } from './live-agent';
import { cx } from './ui';

/**
 * The dashboard's AI assistant: the business's OWN assistant, in a centred workspace over a dimmed dashboard.
 *
 * - Voice and video calls connect to the business's real Sarvam phone agent through Sarvam's official web SDK
 *   (sarvam-conv-ai-sdk): the same agent, voice, speed, speech recognition, tools and database answers as a phone
 *   call, streamed both ways in real time with barge-in. The customer number entered is the caller.
 * - Chat runs the same engine as WhatsApp (menu, prices, ordering, the customer's history).
 * The Sarvam key never reaches the browser: our API hands out a two-minute ticket for one call.
 * Workspaces where the business assistant is not available get Tara (help with Tacksharp) instead.
 */
type Msg = { role: 'user' | 'assistant'; content: string; via?: 'call' | 'chat'; order?: { orderNumber: string; total: number } };
type Status = {
  enabled?: boolean; organizationName?: string; ordering?: boolean; greeting: string; video?: boolean;
  liveAgent?: { name: string; version: number | null } | null;
  phoneVoice?: { speaker: string; pace: number } | null;
};
type Memory = { known: boolean; name?: string | null; orderCount?: number; recentOrders?: Array<{ orderNumber: string; total: number; status: string; at: string }>; channels?: string[] };
type CallState = 'off' | 'connecting' | 'listening' | 'speaking' | 'ended';
type SimliLike = { start(): Promise<void>; stop(): Promise<void>; sendAudioData(d: Uint8Array): void; ClearBuffer: () => void; on(ev: string, cb: (...a: unknown[]) => void): void };
type AgentLike = { start(): Promise<void>; stop(): Promise<void>; waitForConnect(t?: number): Promise<boolean>; mute(): void; unmute(): void; getInteractionId(): string | undefined };

const STORE = 'ts-business-assistant-v2';
const PHONE_STORE = 'ts-assistant-customer-v1';
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const QUICK_ORDERING = ["Today's menu and prices?", 'Broiler price evlo?', '2 kg broiler curry cut venum', 'Staff kitta pesanum'];
const QUICK_OTHER = ['What are your timings?', 'Price evlo?', 'I want to talk to a person'];
/** WhatsApp-style *bold* in the engine's replies, shown as bold (never raw asterisks). */
const rich = (text: string) => text.split(/(\*[^*\n]+\*)/g).map((part, i) => (/^\*[^*\n]+\*$/.test(part) ? <strong key={i} className="font-semibold">{part.slice(1, -1)}</strong> : part));
const STATE_LABEL: Record<CallState, string> = { off: 'Ready', connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking', ended: 'Call ended' };

function Orb({ size = 120, level = 0, active = false }: { size?: number; level?: number; active?: boolean }) {
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
      {active && <span className="absolute inset-[-18%] rounded-full bg-[#7c5cf0]/20 motion-safe:animate-ping" />}
      {active && <span className="absolute inset-[-8%] rounded-full ring-2 ring-[#a99bff]/40" style={{ transform: `scale(${1 + level * 0.25})` }} />}
      <span className="relative rounded-full shadow-[inset_0_-10px_24px_rgba(0,0,0,0.3),0_18px_50px_-12px_rgba(124,92,240,0.75)] transition-transform duration-75"
        style={{ width: size, height: size, transform: `scale(${1 + (active ? level * 0.08 : 0)})`, background: 'radial-gradient(circle at 32% 28%, #ffffff 0%, #c9c2ff 14%, #7c5cf0 42%, #3b2f9e 70%, #16183d 100%)' }} />
    </span>
  );
}

function Bars({ level, on }: { level: number; on: boolean }) {
  return (
    <span className="flex h-8 items-center gap-[3px]" aria-hidden data-level={level.toFixed(2)}>
      {Array.from({ length: 32 }, (_, i) => {
        const shape = Math.sin((i / 31) * Math.PI);
        const h = on ? Math.max(3, 30 * shape * Math.min(1, level * 1.8) * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + level * 9)))) : 3;
        return <span key={i} className="w-[3px] rounded-full bg-[#a99bff] transition-[height] duration-75" style={{ height: h }} />;
      })}
    </span>
  );
}

export function BusinessAssistant() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [memory, setMemory] = useState<Memory | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [call, setCall] = useState<CallState>('off');
  const [withVideo, setWithVideo] = useState(false);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const agent = useRef<AgentLike | null>(null);
  const simli = useRef<SimliLike | null>(null);
  const videoEl = useRef<HTMLVideoElement>(null);
  const videoAudioEl = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const startedAt = useRef(0);
  const callLines = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const starting = useRef(false);
  const phoneOk = phone.replace(/\D/g, '').length >= 10;
  const onCall = call === 'connecting' || call === 'listening' || call === 'speaking';
  const shop = status?.organizationName ?? 'Your business';

  // Probe once: is the business assistant available here? (Otherwise the dashboard keeps Tara.)
  useEffect(() => {
    api.get<Status>('/business-assistant/status').then(setStatus).catch(() => setStatus(null)).finally(() => setLoaded(true));
    try {
      const s = JSON.parse(localStorage.getItem(PHONE_STORE) ?? 'null');
      if (s?.phone) setPhone(s.phone);
      if (s?.name) setName(s.name);
      const m = JSON.parse(sessionStorage.getItem(STORE) ?? 'null');
      if (Array.isArray(m)) setMsgs(m.slice(-40));
    } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-40))); } catch { /* ignore */ }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs]);
  // Centred workspace: the page behind is dimmed and does not scroll.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    api.get<Status>('/business-assistant/status').then(setStatus).catch(() => undefined);
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  useEffect(() => {
    if (!onCall) return;
    const t = setInterval(() => setSeconds(Math.round((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [onCall]);

  const loadMemory = useCallback((p: string, n = name) => {
    if (p.replace(/\D/g, '').length < 10) { setMemory(null); return; }
    try { localStorage.setItem(PHONE_STORE, JSON.stringify({ phone: p, name: n })); } catch { /* ignore */ }
    api.get<Memory>(`/business-assistant/customer?phone=${encodeURIComponent(p)}`).then(setMemory).catch(() => setMemory(null));
  }, [name]);
  useEffect(() => { if (open) loadMemory(phone); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  /** One spoken line from the live call: pieces of the same turn grow one bubble. */
  const addCallLine = useCallback((role: 'user' | 'assistant', content: string) => {
    const text = content.trim();
    if (!text) return;
    const lines = callLines.current;
    const last = lines[lines.length - 1];
    if (last && last.role === role) last.content = text.startsWith(last.content) ? text : last.content.endsWith(text) ? last.content : `${last.content} ${text}`;
    else lines.push({ role, content: text });
    setMsgs((m) => {
      const prev = m[m.length - 1];
      if (prev && prev.via === 'call' && prev.role === role) return [...m.slice(0, -1), { ...prev, content: lines[lines.length - 1].content }];
      return [...m, { role, content: text, via: 'call' }];
    });
  }, []);

  const stopVideo = useCallback(() => {
    const c = simli.current;
    simli.current = null;
    void c?.stop().catch(() => undefined);
  }, []);

  const endCall = useCallback(async (reason?: string) => {
    const a = agent.current;
    agent.current = null;
    setCall((c) => (c === 'off' ? 'off' : 'ended'));
    setLevel(0);
    setMuted(false);
    await a?.stop().catch(() => undefined);
    stopVideo();
    if (reason) setNotice(reason);
    // The call goes on the customer's record (AI voice calls) with its transcript; memory refreshes.
    const lines = callLines.current;
    callLines.current = [];
    if (a && lines.length) {
      await api.post('/business-assistant/live/transcript', { phone, interactionId: a.getInteractionId() ?? null, durationSec: Math.round((Date.now() - startedAt.current) / 1000), lines }).catch(() => undefined);
    }
    loadMemory(phone);
  }, [phone, loadMemory, stopVideo]);

  /** Start the talking presenter; its lips follow the phone agent's own audio (16 kHz PCM). */
  const startPresenter = async (): Promise<SimliLike> => {
    const { sessionToken } = await api.post<{ sessionToken: string }>('/assistant/video/session');
    const testFactory = (window as unknown as { __TARA_SIMLI__?: (t: string, v: HTMLVideoElement, a: HTMLAudioElement) => SimliLike }).__TARA_SIMLI__;
    let client: SimliLike;
    if (testFactory) client = testFactory(sessionToken, videoEl.current!, videoAudioEl.current!);
    else {
      const { SimliClient, LogLevel } = await import('simli-client');
      client = new SimliClient(sessionToken, videoEl.current!, videoAudioEl.current!, null, LogLevel.ERROR, 'livekit') as unknown as SimliLike;
    }
    client.on('stop', () => { if (simli.current === client) void endCall('The video call ended.'); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([client.start(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer from the video service')), 15_000); })]);
    } finally { clearTimeout(timer); }
    simli.current = client;
    void videoAudioEl.current?.play().catch(() => undefined);
    return client;
  };

  const startCall = async (video: boolean) => {
    if (starting.current || onCall) return;
    if (!phoneOk) { setNotice('Enter the customer’s mobile number first: the agent answers for that customer, as on a phone call.'); return; }
    if (!status?.liveAgent) { setNotice('Live calls use your Sarvam phone agent. Add its Sarvam agent id on Voice agents, then try again.'); return; }
    starting.current = true;
    setNotice(null);
    setWithVideo(video);
    setCall('connecting');
    callLines.current = [];
    startedAt.current = Date.now();
    setSeconds(0);
    try {
      const [s, sdk] = await Promise.all([
        api.post<{ ticket: string; organizationId: string; config: Record<string, unknown> }>('/business-assistant/live/session', { phone }),
        import('sarvam-conv-ai-sdk/browser'),
      ]);
      const presenter = video ? await startPresenter() : null;
      const onLevel = (l: { rms: number }) => setLevel(Math.min(1, l.rms * 5));
      // Video: the agent's audio drives the presenter (which plays it); voice: the SDK plays it directly.
      const audio = presenter
        ? new (class extends sdk.BrowserAudioInterface {
            async output(a: Uint8Array) { presenter.sendAudioData(a); }
            interrupt() { try { presenter.ClearBuffer(); } catch { /* ended */ } }
          })(16000)
        : new sdk.BrowserAudioInterface(16000, { outputLevelCallback: onLevel });
      const a = new sdk.ConversationAgent({
        apiKey: '',
        baseUrl: `${API_URL}/business-assistant/live/runtime/${encodeURIComponent(s.organizationId)}/`,
        customHeaders: { 'x-assistant-ticket': s.ticket },
        config: { ...(s.config as object), interaction_type: sdk.InteractionType.CALL, input_sample_rate: 16000, output_sample_rate: presenter ? 16000 : 22050 } as never,
        audioInterface: audio,
        transcriptCallback: async (m: { role: string; content: string }) => addCallLine(m.role === 'user' ? 'user' : 'assistant', m.content),
        stateCallback: (st: string) => {
          if (st === 'listening' || st === 'connected') setCall('listening');
          else if (st === 'speaking') setCall('speaking');
          else if (st === 'error') void endCall('The call dropped. Check your internet and start it again.');
        },
        endCallback: async () => { if (agent.current === a) void endCall(); },
      }) as unknown as AgentLike;
      agent.current = a;
      await a.start();
      if (!(await a.waitForConnect(15))) throw new Error('Sarvam did not answer in time.');
      setCall((c) => (c === 'connecting' ? 'listening' : c));
    } catch (e) {
      const name = (e as DOMException)?.name;
      const why = name === 'NotAllowedError' ? 'Microphone permission is blocked. Allow it in the browser (lock icon in the address bar).' : name === 'NotFoundError' ? 'No microphone was found.' : errText(e);
      await endCall(`The call could not start: ${why}`);
      setCall('off');
    } finally {
      starting.current = false;
    }
  };

  const toggleMute = () => {
    const a = agent.current;
    if (!a) return;
    if (muted) a.unmute(); else a.mute();
    setMuted(!muted);
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || thinking) return;
    if (!phoneOk) { setNotice('Enter the customer’s mobile number first: answers and orders use that customer’s records.'); return; }
    setNotice(null);
    setInput('');
    setMsgs((m) => [...m, { role: 'user', content: message, via: 'chat' }]);
    setThinking(true);
    try {
      const r = await api.post<{ reply: string; order?: { orderNumber: string; total: number } | null }>('/business-assistant/chat', { message, phone, name: name || undefined, spoken: false });
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply, via: 'chat', ...(r.order ? { order: r.order } : {}) }]);
      loadMemory(phone);
    } catch (e) {
      setNotice(errText(e));
    } finally {
      setThinking(false);
    }
  };

  const close = () => { if (onCall) void endCall(); setOpen(false); };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  // Leaving the page ends the call (no microphone or session outlives the dashboard).
  useEffect(() => () => { void agent.current?.stop().catch(() => undefined); void simli.current?.stop().catch(() => undefined); }, []);

  if (!loaded) return null;
  if (!status?.enabled) return <LiveAgent />;

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const stageText = call === 'connecting' ? 'Connecting to your phone agent…'
    : call === 'listening' ? (muted ? 'You are muted' : 'Listening — just speak')
    : call === 'speaking' ? `${shop} is speaking`
    : call === 'ended' ? 'Call ended. Start again any time.'
    : status.liveAgent ? 'Talk to your phone agent, exactly as a customer would' : 'Chat is ready. Live calls need your Sarvam phone agent.';
  const quick = status.ordering ? QUICK_ORDERING : QUICK_OTHER;
  const roundBtn = 'grid size-14 place-items-center rounded-full transition-transform hover:scale-105 disabled:opacity-40 disabled:hover:scale-100';

  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} aria-label="Open the AI assistant" className="group fixed right-4 bottom-4 z-[55] flex items-center gap-3 rounded-full border border-white/10 bg-[#16183d] p-1.5 text-left text-white shadow-[0_18px_40px_-14px_rgba(22,24,61,0.75)] transition-transform hover:-translate-y-0.5 sm:pr-5 print:hidden">
          <span className="relative"><Orb size={44} /><span className="absolute right-0 bottom-0 size-3 rounded-full bg-emerald-400 ring-2 ring-[#16183d]" /></span>
          <span className="hidden leading-tight sm:block">
            <span className="block text-[14px] font-semibold">AI assistant</span>
            <span className="block text-[11.5px] text-white/60">Chat · voice · video</span>
          </span>
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#0b0d24]/60 backdrop-blur-[4px] sm:p-6 print:hidden" data-testid="assistant-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !onCall) close(); }}>
          <section role="dialog" aria-modal="true" aria-label={`${shop} assistant`} className="relative flex h-full w-full flex-col overflow-hidden bg-white sm:h-[min(780px,92vh)] sm:max-w-[1180px] sm:rounded-[26px] sm:shadow-[0_60px_140px_-30px_rgba(5,6,30,0.75)] lg:flex-row">
            <button onClick={close} aria-label="Close assistant" className="absolute top-3 right-3 z-10 grid size-10 place-items-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 lg:bg-black/5 lg:text-[#16183d]/70 lg:hover:bg-black/10 lg:hover:text-[#16183d]"><X className="size-5" /></button>

            {/* Call stage */}
            <div className="relative flex shrink-0 flex-col bg-[radial-gradient(120%_90%_at_50%_0%,#2a2f6e_0%,#16183d_55%,#0b0d24_100%)] px-5 pt-4 pb-4 text-white lg:w-[44%] lg:px-8 lg:pt-8 lg:pb-8">
              <div className="flex items-center gap-3 pr-12 lg:pr-0">
                <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-white/10 ring-1 ring-white/15"><Store className="size-5" /></span>
                <div className="min-w-0 leading-tight">
                  <p className="truncate text-[16px] font-semibold">{shop}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-white/60"><Sparkles className="size-3.5" />AI assistant{status.liveAgent ? ` · ${status.liveAgent.name}` : ''}</p>
                </div>
                <span data-testid="call-state" className={cx('ml-auto hidden shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold sm:inline-flex', onCall ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/10 text-white/70')}>
                  <span className={cx('size-1.5 rounded-full', onCall ? 'bg-emerald-400 motion-safe:animate-pulse' : 'bg-white/50')} />{onCall && call !== 'connecting' ? `${STATE_LABEL[call]} · ${mmss}` : STATE_LABEL[call]}
                </span>
              </div>

              <div className="flex flex-1 flex-col items-center justify-center gap-2 py-3 lg:gap-4 lg:py-0">
                {status.video && (
                  <div className={cx('relative w-full overflow-hidden rounded-[18px] bg-black/40 ring-1 ring-white/10', withVideo && onCall ? 'block' : 'hidden')}>
                    <video ref={videoEl} autoPlay playsInline className="aspect-video w-full object-cover" aria-label={`${shop} video assistant`} />
                    <audio ref={videoAudioEl} autoPlay />
                    {call === 'connecting' && <p className="absolute inset-0 grid place-items-center text-[13px] text-white/80"><span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />Connecting video…</span></p>}
                  </div>
                )}
                {!(withVideo && onCall) && (
                  <>
                    <span className="lg:hidden"><Orb size={64} level={level} active={call === 'speaking' || call === 'listening'} /></span>
                    <span className="hidden lg:block"><Orb size={150} level={level} active={call === 'speaking' || call === 'listening'} /></span>
                  </>
                )}
                <span className={cx(!onCall && 'hidden lg:block')}><Bars level={level} on={call === 'speaking'} /></span>
                <p className="max-w-[340px] text-center text-[13px] text-white/75 lg:text-[14px]" aria-live="polite" data-testid="stage-text">{stageText}</p>
              </div>

              <div className="flex items-center justify-center gap-4">
                {onCall ? (
                  <>
                    <button onClick={toggleMute} aria-pressed={muted} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} disabled={call === 'connecting'} className={cx(roundBtn, muted ? 'bg-white text-[#16183d]' : 'bg-white/12 text-white ring-1 ring-white/20')}>{muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}</button>
                    <button onClick={() => void endCall()} aria-label="End call" className={cx(roundBtn, 'size-16 bg-rose-600 text-white shadow-[0_12px_30px_-10px_rgba(225,29,72,0.8)]')}><PhoneOff className="size-7" /></button>
                  </>
                ) : (
                  <>
                    <button onClick={() => void startCall(false)} disabled={!status.liveAgent} className="inline-flex h-12 items-center gap-2 rounded-full bg-emerald-500 px-6 text-[15px] font-semibold text-white shadow-[0_12px_30px_-12px_rgba(16,185,129,0.9)] transition-transform hover:scale-[1.03] disabled:opacity-40 disabled:hover:scale-100"><Phone className="size-5" />Voice call</button>
                    {status.video && <button onClick={() => void startCall(true)} disabled={!status.liveAgent} className="inline-flex h-12 items-center gap-2 rounded-full bg-white/12 px-6 text-[15px] font-semibold text-white ring-1 ring-white/20 transition-transform hover:scale-[1.03] disabled:opacity-40 disabled:hover:scale-100"><Video className="size-5" />Video call</button>}
                  </>
                )}
              </div>
              <p className="mt-4 hidden text-center text-[11.5px] text-white/45 lg:block">{status.liveAgent ? 'Live Sarvam phone agent: same voice, tools and answers as your phone line' : 'Add the Sarvam agent id on Voice agents to enable live calls'}</p>
            </div>

            {/* Conversation */}
            <div className="flex min-h-0 flex-1 flex-col bg-[#f7f8fc]">
              <div className="border-b border-black/5 bg-white px-5 pt-4 pb-3 lg:pt-6 lg:pr-16">
                <p className="text-[12px] font-semibold tracking-wide text-[#16183d]/50 uppercase">Customer</p>
                <div className="mt-1.5 flex items-center gap-2" data-testid="assistant-customer">
                  <div className="relative min-w-0 flex-1">
                    <UserRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[#16183d]/40" aria-hidden />
                    <label className="sr-only" htmlFor="ba-phone">Customer mobile number</label>
                    <input id="ba-phone" inputMode="tel" autoComplete="off" disabled={onCall} value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={() => loadMemory(phone)} onKeyDown={(e) => e.key === 'Enter' && loadMemory(phone)} placeholder="Mobile number" className="h-10 w-full rounded-[12px] border border-black/10 bg-white pr-3 pl-9 text-[14px] text-[#16183d] outline-none focus:border-[#16183d]/40 focus:ring-4 focus:ring-[#16183d]/5 disabled:bg-[#f7f8fc]" />
                  </div>
                  <label className="sr-only" htmlFor="ba-name">Customer name (optional)</label>
                  <input id="ba-name" disabled={onCall} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => loadMemory(phone, name)} placeholder="Name (optional)" className="h-10 w-[38%] rounded-[12px] border border-black/10 bg-white px-3 text-[14px] text-[#16183d] outline-none focus:border-[#16183d]/40 focus:ring-4 focus:ring-[#16183d]/5 disabled:bg-[#f7f8fc]" />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-[#16183d]/60" aria-live="polite" data-testid="assistant-memory">
                  {!phoneOk ? <span>Answers, calls and orders use this customer’s records.</span>
                    : !memory ? <span>Looking up this customer…</span>
                    : !memory.known ? <span className="rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-800 ring-1 ring-sky-200">New customer</span>
                    : (
                      <>
                        <span className="rounded-full bg-[#16183d] px-2 py-0.5 font-semibold text-white">{memory.name || 'Known customer'}</span>
                        <span className="rounded-full bg-white px-2 py-0.5 ring-1 ring-black/10">{memory.orderCount ?? 0} order{memory.orderCount === 1 ? '' : 's'}</span>
                        {memory.recentOrders?.[0] && <span className="rounded-full bg-white px-2 py-0.5 ring-1 ring-black/10">Last {memory.recentOrders[0].orderNumber} · {inr(memory.recentOrders[0].total)} · {memory.recentOrders[0].status}</span>}
                        {!!memory.channels?.length && <span className="rounded-full bg-white px-2 py-0.5 ring-1 ring-black/10">{memory.channels.join(' · ')}</span>}
                      </>
                    )}
                </div>
              </div>

              <ol ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-5" aria-live="polite" aria-label="Conversation">
                <li className="flex items-start gap-2.5"><Orb size={28} /><p className="max-w-[82%] rounded-[16px] rounded-tl-[4px] bg-white px-3.5 py-2.5 text-[14px] leading-relaxed text-[#16183d] shadow-[0_1px_2px_rgba(22,24,61,0.06)] ring-1 ring-black/5">{status.greeting}</p></li>
                {msgs.map((m, i) => (
                  <li key={i} className={cx('flex items-start gap-2.5', m.role === 'user' && 'justify-end')}>
                    {m.role === 'assistant' && <Orb size={28} />}
                    <div className={cx('max-w-[82%] rounded-[16px] px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap', m.role === 'user' ? 'rounded-tr-[4px] bg-[#16183d] text-white' : 'rounded-tl-[4px] bg-white text-[#16183d] shadow-[0_1px_2px_rgba(22,24,61,0.06)] ring-1 ring-black/5')}>
                      {m.via === 'call' && <Phone className="mr-1.5 inline size-3.5 opacity-60" aria-label="on the call" />}{rich(m.content)}
                      {m.order && (
                        <span className="mt-2 flex items-center gap-2 rounded-[10px] bg-emerald-50 px-2.5 py-1.5 text-[12.5px] font-semibold text-emerald-900 ring-1 ring-emerald-200" data-testid="assistant-order">
                          <ReceiptText className="size-4 shrink-0" aria-hidden />Order {m.order.orderNumber} · {inr(m.order.total)} · saved in Orders
                        </span>
                      )}
                    </div>
                  </li>
                ))}
                {thinking && <li className="flex items-center gap-2.5"><Orb size={28} /><span className="inline-flex items-center gap-1 rounded-[16px] bg-white px-3.5 py-3 ring-1 ring-black/5" aria-label="Typing">{[0, 1, 2].map((d) => <span key={d} className="size-1.5 rounded-full bg-[#16183d]/40 motion-safe:animate-bounce" style={{ animationDelay: `${d * 140}ms` }} />)}</span></li>}
              </ol>

              {msgs.length === 0 && !onCall && (
                <div className="flex flex-wrap gap-1.5 px-5 pb-2">
                  {quick.map((q) => <button key={q} onClick={() => void send(q)} className="rounded-full border border-[#16183d]/12 bg-white px-3 py-1.5 text-[12.5px] font-medium text-[#16183d] hover:border-[#16183d]/30">{q}</button>)}
                </div>
              )}
              {notice && <p role="status" className="mx-5 mb-2 rounded-[12px] bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 ring-1 ring-amber-200">{notice}</p>}
              <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="border-t border-black/5 bg-white px-5 pt-3 pb-4">
                <div className="flex items-end gap-2 rounded-[16px] border border-black/10 bg-white p-1.5 focus-within:border-[#16183d]/40 focus-within:ring-4 focus-within:ring-[#16183d]/5">
                  <label htmlFor="ba-input" className="sr-only">Message the assistant</label>
                  <textarea id="ba-input" rows={1} disabled={onCall} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} placeholder={onCall ? 'On a call: just speak' : 'Type as the customer…'} className="max-h-28 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[14px] text-[#16183d] outline-none placeholder:text-[#16183d]/40" />
                  <button type="submit" aria-label="Send" disabled={!input.trim() || thinking || onCall} className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-[#16183d] text-white transition-opacity disabled:opacity-30"><ArrowUp className="size-[18px]" /></button>
                </div>
                <p className="mt-2 text-center text-[11px] text-[#16183d]/45">Chat is a test: nothing is sent to the customer. Live calls work exactly like a phone call, including orders and confirmations.</p>
              </form>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
