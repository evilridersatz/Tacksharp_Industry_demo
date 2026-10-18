'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { ArrowUpRight, Bot, CalendarClock, CircleSlash, FlaskConical, LayoutDashboard, MessageSquare, Phone, Play, RotateCcw, Search, Send, ShieldCheck, Workflow, Zap } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { industryDef } from '@/lib/industries';
import { Badge, Button, Card, Empty, ErrorBanner, Segmented, Skeleton, cx, type Tone } from './ui';
import { Dialog, errorText, inputCls } from './textile';

type Runtime =
  | { type: 'conversation'; engine: string; voice?: boolean }
  | { type: 'task'; kind: string; agent: string }
  | { type: 'workflow'; source: string; note: string }
  | { type: 'dashboard'; route: string }
  | { type: 'unavailable'; reason: string };
type Status = 'active' | 'demo' | 'paused' | 'needs_setup' | 'unavailable';
export type CatalogueAgent = {
  id: string; industry: string; name: string; purpose: string; channels: string[]; capabilities: string[]; runtime: Runtime; tools: string[]; handoff: string;
  scenario?: string; rules: string[]; status: Status; statusNote: string; metrics: Array<{ label: string; value: number }>; lastActivity: string | null; playground: 'conversation' | 'task' | 'none';
};
type Catalogue = { industry: string; label: string; demo: boolean; integrations: { whatsapp: boolean; voice: boolean; ai: boolean; dryRun: boolean }; agents: CatalogueAgent[] };

const STATUS: Record<Status, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'brand' },
  demo: { label: 'Demo', tone: 'sky' },
  paused: { label: 'Paused', tone: 'amber' },
  needs_setup: { label: 'Needs setup', tone: 'amber' },
  unavailable: { label: 'Not available yet', tone: 'slate' },
};
const RUNTIME_LABEL: Record<Runtime['type'], string> = { conversation: 'Conversation agent', task: 'Back-office task', workflow: 'Automated workflow', dashboard: 'Reporting view', unavailable: 'Planned' };
const RUNTIME_ICON: Record<Runtime['type'], typeof Bot> = { conversation: MessageSquare, task: Zap, workflow: Workflow, dashboard: LayoutDashboard, unavailable: CircleSlash };
const CHANNEL_ICON: Record<string, typeof Bot> = { whatsapp: MessageSquare, voice: Phone, dashboard: LayoutDashboard, scheduled: CalendarClock };

/** Industry AI agent catalogue: what each agent does, what actually runs, its status, metrics and a safe playground. */
export function AgentCatalogue() {
  const { data, error, reload } = useApi<Catalogue>('/industry/agents', 30_000);
  const [filter, setFilter] = useState<'all' | 'running' | 'unavailable'>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<CatalogueAgent | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const def = industryDef(data?.industry);
  const agents = useMemo(
    () =>
      (data?.agents ?? []).filter((a) => {
        if (filter === 'running' && a.status === 'unavailable') return false;
        if (filter === 'unavailable' && a.status !== 'unavailable') return false;
        const s = q.trim().toLowerCase();
        return !s || a.name.toLowerCase().includes(s) || a.purpose.toLowerCase().includes(s);
      }),
    [data, filter, q],
  );
  const counts = useMemo(() => {
    const c = { total: 0, running: 0, setup: 0, unavailable: 0 };
    for (const a of data?.agents ?? []) {
      c.total++;
      if (a.status === 'unavailable') c.unavailable++;
      else if (a.status === 'needs_setup' || a.status === 'paused') c.setup++;
      else c.running++;
    }
    return c;
  }, [data]);

  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: `${def.short} agents`, value: counts.total },
          { label: data?.demo ? 'Ready (demo)' : 'Running', value: counts.running },
          { label: 'Need setup / paused', value: counts.setup },
          { label: 'Not available yet', value: counts.unavailable },
        ].map((s) => (
          <Card key={s.label} className="p-4">
            <p className="text-[12.5px] text-muted">{s.label}</p>
            <p className="mt-1 text-[22px] font-bold text-ink tabular">{data ? s.value : '…'}</p>
          </Card>
        ))}
      </div>
      {data && (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
          <span>WhatsApp: <b className="text-body">{data.integrations.whatsapp ? 'configured' : 'not configured'}</b></span>
          <span>Voice: <b className="text-body">{data.integrations.voice ? 'configured' : 'not configured'}</b></span>
          <span>AI model: <b className="text-body">{data.integrations.ai ? 'configured' : 'rules only'}</b></span>
          {data.integrations.dryRun && <span>DRY_RUN on: <b className="text-body">no real messages or calls</b></span>}
        </p>
      )}

      <div className="mt-4 mb-3 flex flex-wrap items-center gap-2.5">
        <Segmented label="Show agents" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'running', label: 'Available' }, { value: 'unavailable', label: 'Planned' }]} />
        <div className="relative min-w-0 flex-1 sm:max-w-[280px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents" aria-label="Search agents" className={cx(inputCls, 'h-10 pl-9')} />
        </div>
      </div>

      {!data && <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-48" />)}</div>}
      {data && !agents.length && <Card><Empty title="No agents match">Try another filter.</Empty></Card>}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="AI agents">
        {agents.map((a) => {
          const RIcon = RUNTIME_ICON[a.runtime.type];
          const st = STATUS[a.status];
          return (
            <li key={a.id}>
              <button type="button" onClick={() => setOpen(a)} className="group block h-full w-full text-left" aria-label={`${a.name}: ${st.label}. Open details`}>
                <Card className={cx('flex h-full flex-col p-4 transition group-hover:border-slate-300 group-focus-visible:border-slate-400', a.status === 'unavailable' && 'bg-slate-50/60')}>
                  <div className="flex items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-[12px]" style={{ background: a.status === 'unavailable' ? '#f1f5f9' : def.accentSoft, color: a.status === 'unavailable' ? '#94a3b8' : def.accent }}>
                      <RIcon className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] leading-snug font-semibold text-ink">{a.name}</p>
                      <p className="text-[11.5px] text-muted">{RUNTIME_LABEL[a.runtime.type]}</p>
                    </div>
                    <Badge tone={st.tone} dot>{st.label}</Badge>
                  </div>
                  <p className="mt-2.5 line-clamp-3 text-[12.5px] text-body">{a.purpose}</p>
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
                    {a.channels.map((c) => {
                      const CI = CHANNEL_ICON[c] ?? Bot;
                      return (
                        <span key={c} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                          <CI className="size-3" aria-hidden /> {c}
                        </span>
                      );
                    })}
                    {a.playground !== 'none' && <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold" style={{ color: def.accent }}><FlaskConical className="size-3.5" /> Try it</span>}
                  </div>
                </Card>
              </button>
            </li>
          );
        })}
      </ul>

      <Dialog open={!!open} onClose={close} title={open?.name ?? 'Agent'} wide>
        {open && data && <AgentDetail a={open} demo={data.demo} accent={def.accent} industry={data.industry} />}
      </Dialog>
    </>
  );
}

function AgentDetail({ a, demo, accent, industry }: { a: CatalogueAgent; demo: boolean; accent: string; industry: string }) {
  const [tab, setTab] = useState<'overview' | 'playground'>('overview');
  const st = STATUS[a.status];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={st.tone} dot>{st.label}</Badge>
        <span className="text-[12px] text-muted">{RUNTIME_LABEL[a.runtime.type]}</span>
        {a.lastActivity && <span className="text-[12px] text-muted">· last activity {timeAgo(a.lastActivity)} ago</span>}
      </div>
      {a.playground !== 'none' && (
        <div className="mb-4">
          <Segmented label="Agent section" value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'playground', label: 'Playground' }]} />
        </div>
      )}
      {tab === 'overview' ? (
        <div className="space-y-4 text-[13px]">
          <p className="text-body">{a.purpose}</p>
          <p className="rounded-[10px] bg-slate-50 px-3 py-2 text-[12.5px] text-muted">{a.statusNote}</p>
          {a.runtime.type === 'unavailable' && <p className="text-[12.5px] text-muted">This agent is listed so you can see what is planned for {industryDef(industry).short.toLowerCase()}; it does not run.</p>}
          {a.runtime.type === 'dashboard' && (
            <Link href={a.runtime.route} className="inline-flex items-center gap-1 font-semibold" style={{ color: accent }}>Open the report <ArrowUpRight className="size-4" /></Link>
          )}
          <Section title="What it can do">
            <ul className="list-disc space-y-0.5 pl-5 text-body">{a.capabilities.map((c) => <li key={c}>{c}</li>)}</ul>
          </Section>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Section title="Channels"><p className="text-body">{a.channels.join(', ')}</p></Section>
            <Section title="Data and tools it uses"><p className="text-body">{a.tools.join(', ') || '—'}</p></Section>
          </div>
          <Section title="When a person takes over"><p className="text-body">{a.handoff}</p></Section>
          <Section title="Rules it always follows">
            <ul className="space-y-1">{a.rules.map((r) => <li key={r} className="flex gap-2 text-body"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />{r}</li>)}</ul>
          </Section>
          {a.runtime.type === 'workflow' && <Section title="How it runs"><p className="text-body">{a.runtime.note}</p></Section>}
          {a.metrics.length > 0 && (
            <Section title="Activity (last 30 days)">
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {a.metrics.map((m) => (
                  <div key={m.label} className="rounded-[10px] border border-line px-3 py-2">
                    <dt className="text-[11.5px] text-muted">{m.label}</dt>
                    <dd className="text-[16px] font-bold text-ink tabular">{m.value}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}
          {a.runtime.type === 'task' && <Link href="/agents?view=runtime" className="inline-flex items-center gap-1 text-[12.5px] font-semibold" style={{ color: accent }}>Run history in Tasks & approvals <ArrowUpRight className="size-4" /></Link>}
        </div>
      ) : !demo ? (
        <div className="rounded-[12px] border border-dashed border-line p-4 text-[13px] text-body">
          <p className="font-semibold text-ink">The playground runs in demo workspaces only</p>
          <p className="mt-1 text-muted">So it can never message a real customer or change live records. Switch to a demo workspace from the menu to try this agent{industry === 'restaurant' ? ', or use Test chat for the live ordering assistant (dry run)' : ''}.</p>
          {industry === 'restaurant' && <div className="mt-3"><Button href="/test-chat">Open Test chat</Button></div>}
        </div>
      ) : a.playground === 'conversation' ? (
        <ChatPlayground a={a} accent={accent} />
      ) : (
        <TaskPlayground a={a} />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-[12px] font-semibold tracking-[0.04em] text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

type ChatTurn = { from: 'customer' | 'agent' | 'error'; text: string; meta?: string };

function ChatPlayground({ a, accent }: { a: CatalogueAgent; accent: string }) {
  const [session, setSession] = useState(() => Math.random().toString(36).slice(2));
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [text, setText] = useState(a.scenario ?? '');
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setTurns((t) => [...t, { from: 'customer', text: message }]);
    setText('');
    setBusy(true);
    try {
      const r = await api.post<{ reply?: string; error?: string; path?: string; intent?: string | null; escalated?: boolean; latencyMs: number }>('/industry/playground', { agentId: a.id, message, session });
      if (r.error) setTurns((t) => [...t, { from: 'error', text: r.error! }]);
      else setTurns((t) => [...t, { from: 'agent', text: r.reply ?? '', meta: [r.intent && `intent: ${r.intent}`, r.path && `path: ${r.path}`, r.escalated && 'handed to a person', `${r.latencyMs} ms`].filter(Boolean).join(' · ') }]);
    } catch (err) {
      setTurns((t) => [...t, { from: 'error', text: errorText(err) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-2 text-[12px] text-muted">Synthetic demo customer through the dashboard test channel. Nothing is sent to WhatsApp or a phone.</p>
      <div className="flex h-[min(360px,50vh)] flex-col gap-2 overflow-y-auto rounded-[12px] border border-line bg-slate-50 p-3" aria-live="polite">
        {!turns.length && <p className="m-auto text-center text-[12.5px] text-muted">Send the example message or type your own.</p>}
        {turns.map((t, i) => (
          <div key={i} className={cx('max-w-[85%] rounded-[12px] px-3 py-2 text-[13px]', t.from === 'customer' ? 'self-end text-white' : t.from === 'error' ? 'self-start bg-rose-soft text-rose' : 'self-start bg-white text-ink shadow-sm')} style={t.from === 'customer' ? { background: accent } : undefined}>
            <p className="whitespace-pre-wrap">{t.text}</p>
            {t.meta && <p className="mt-1 text-[10.5px] text-muted">{t.meta}</p>}
          </div>
        ))}
        {busy && <p className="self-start text-[12px] text-muted">Agent is replying…</p>}
      </div>
      <form onSubmit={send} className="mt-2 flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a customer message" aria-label="Customer message" className={cx(inputCls, 'h-10 flex-1')} />
        <Button variant="primary" type="submit" busy={busy} aria-label="Send"><Send className="size-4" /></Button>
        <Button type="button" aria-label="New chat" title="New chat" onClick={() => { setTurns([]); setSession(Math.random().toString(36).slice(2)); setText(a.scenario ?? ''); }}><RotateCcw className="size-4" /></Button>
      </form>
    </div>
  );
}

function TaskPlayground({ a }: { a: CatalogueAgent }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ status?: string; result?: { summary?: string } & Record<string, unknown>; error?: string | null; toolCalls?: Array<{ tool: string; note: string }>; latencyMs?: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.post('/industry/playground', { agentId: a.id }));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 text-[13px]">
      <p className="text-[12px] text-muted">Runs the real task on this demo workspace&apos;s sample records. It never contacts customers.</p>
      <Button variant="primary" onClick={run} busy={busy}><Play className="size-4" /> Run on demo data</Button>
      {err && <p role="alert" className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      {res && (
        <div role="status" className="space-y-2 rounded-[12px] border border-line p-3">
          <p className="flex flex-wrap items-center gap-2"><Badge tone={res.status === 'COMPLETED' ? 'brand' : res.status === 'FAILED' ? 'rose' : 'amber'}>{res.status?.toLowerCase().replace(/_/g, ' ')}</Badge>{res.latencyMs !== undefined && <span className="text-[11.5px] text-muted">{res.latencyMs} ms</span>}</p>
          {res.error && <p className="text-rose">{res.error}</p>}
          {res.result && (
            <pre className="max-h-[240px] overflow-auto rounded-[10px] bg-slate-50 p-2 text-[11.5px] whitespace-pre-wrap text-body">{JSON.stringify(res.result, null, 2)}</pre>
          )}
          {!!res.toolCalls?.length && <p className="text-[12px] text-muted">Tools used: {res.toolCalls.map((t) => t.tool).join(', ')}</p>}
        </div>
      )}
    </div>
  );
}
