'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, Clock3, Lock, MessageSquare, PhoneCall, ShoppingBag, UserPlus, ListChecks, Inbox, TrendingDown, TrendingUp } from 'lucide-react';
import { useApi } from '@/lib/api';
import { industryDef } from '@/lib/industries';
import { useWorkspace } from '@/lib/industry';
import { TrendChart } from './charts';
import { Card, CardHeader, Empty, ErrorBanner, Segmented, Skeleton, cx } from './ui';

type StepStatus = 'complete' | 'action_required' | 'in_progress' | 'blocked';
type Home = {
  business: { name: string; industry: string; industryLabel: string; status: string; isDemo: boolean };
  range: 'today' | '7d' | '30d'; updatedAt: string;
  readiness: { done: number; total: number; ready: boolean; next: { label: string; href: string; why: string } | null };
  checklist: Array<{ id: string; label: string; status: StepStatus; detail: string; action?: { label: string; href: string } }>;
  attention: Array<{ id: string; severity: 'critical' | 'warning'; title: string; detail: string; action?: { label: string; href: string } }>;
  channels: Array<{ id: string; label: string; status: string; detail: string; href: string }>;
  metrics: Array<{ id: string; label: string; value: number; previous: number; why: string; href: string; hasData: boolean }>;
  series: { labels: string[]; messages: number[]; calls: number[] };
  callOutcomes: Record<string, number>;
  activity: Array<{ id: string; at: string; kind: string; text: string; href: string; tone: 'ok' | 'warn' | 'info' }>;
  mode: { dryRun: boolean };
};

const STATUS: Record<StepStatus, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  complete: { label: 'Complete', cls: 'text-brand-dark bg-brand-soft', icon: CheckCircle2 },
  action_required: { label: 'Action required', cls: 'text-amber-900 bg-amber-50', icon: AlertTriangle },
  in_progress: { label: 'In progress', cls: 'text-sky-800 bg-sky-50', icon: Clock3 },
  blocked: { label: 'Blocked', cls: 'text-slate-700 bg-slate-100', icon: Lock },
};
const METRIC_ICON: Record<string, typeof MessageSquare> = { enquiries: Inbox, conversations: MessageSquare, calls: PhoneCall, leads: UserPlus, orders: ShoppingBag, followups: ListChecks };
const RANGE_LABEL = { today: 'today', '7d': 'the last 7 days', '30d': 'the last 30 days' } as const;
const PREV_LABEL = { today: 'yesterday', '7d': 'the 7 days before', '30d': 'the 30 days before' } as const;
const fmtDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const since = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/**
 * Home for a business owner: what is happening, what it means, what to do next. Every number comes from GET /home
 * (this organization's records); setup steps are green only when the server says they are complete.
 */
export function HomeOverview() {
  const { workspace } = useWorkspace();
  const [range, setRange] = useState<'today' | '7d' | '30d'>('7d');
  const { data, error, reload } = useApi<Home>(`/home?range=${range}`, 60_000);
  const def = industryDef(workspace?.industry);
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="mb-6 h-[420px] rounded-[18px]" />;
  const pct = Math.round((data.readiness.done / data.readiness.total) * 100);
  const noActivity = data.metrics.every((m) => !m.hasData);

  return (
    <div className="mb-8 grid gap-5" data-testid="home-overview">
      {/* Welcome + the one next action */}
      <section className="relative overflow-hidden rounded-[20px] border border-line bg-white p-5 shadow-[var(--shadow-card)] sm:p-6">
        <div className="absolute inset-x-0 top-0 h-1" style={{ background: def.accent }} aria-hidden />
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-semibold text-muted">{today}</p>
            <h1 className="mt-1 text-[24px] leading-tight font-bold tracking-[-0.02em] text-ink sm:text-[28px]">Welcome to Tacksharp</h1>
            <p className="mt-1 max-w-2xl text-[14px] text-body">Your AI team helps your business respond to customers and follow up automatically.</p>
            <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-body">
              <span className="font-semibold text-ink">{data.business.name}</span>
              <span className="rounded-full px-2 py-0.5 text-[12px] font-semibold" style={{ background: def.accentSoft, color: def.accent }}>{data.business.industry === 'restaurant' ? 'GR Chicken / Chicken Shop' : data.business.industryLabel}</span>
              {data.business.isDemo && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[12px] font-semibold text-amber-900">Demo · sample data</span>}
              <span className={cx('rounded-full px-2 py-0.5 text-[12px] font-semibold', data.mode.dryRun ? 'bg-slate-100 text-slate-700' : 'bg-brand-soft text-brand-dark')}>{data.mode.dryRun ? 'Test mode: nothing is sent' : 'Live'}</span>
            </p>
          </div>
          <div className="w-full sm:w-auto sm:min-w-[260px]">
            <p className="text-[12.5px] font-semibold text-muted">Setup {data.readiness.done} of {data.readiness.total} complete</p>
            <div className="mt-1.5 h-2 rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress"><div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, background: def.accent }} /></div>
            {data.readiness.next ? (
              <Link href={data.readiness.next.href} className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-[10px] bg-ink px-4 text-[13.5px] font-semibold text-white hover:bg-ink/90" data-testid="next-action">
                {data.readiness.next.label}<ArrowRight className="size-4" />
              </Link>
            ) : <p className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-dark"><CheckCircle2 className="size-4" />Everything is set up.</p>}
            {data.readiness.next && <p className="mt-1.5 text-[12px] text-muted">{data.readiness.next.why}</p>}
          </div>
        </div>
      </section>

      {/* Attention required */}
      {data.attention.length > 0 && (
        <section aria-labelledby="attention-h" className="rounded-[18px] border border-amber-200 bg-amber-50/60 p-4 sm:p-5">
          <h2 id="attention-h" className="flex items-center gap-2 text-[15px] font-semibold text-amber-950"><AlertTriangle className="size-4" />Needs your attention ({data.attention.length})</h2>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {data.attention.map((a) => (
              <li key={a.id} className="flex items-start gap-3 rounded-[12px] bg-white p-3 ring-1 ring-amber-200/70">
                <span className={cx('mt-1 size-2 shrink-0 rounded-full', a.severity === 'critical' ? 'bg-rose' : 'bg-amber')} aria-hidden />
                <div className="min-w-0 flex-1"><p className="text-[13.5px] font-semibold text-ink">{a.title}</p><p className="text-[12.5px] text-body">{a.detail}</p></div>
                {a.action && <Link href={a.action.href} className="shrink-0 rounded-[8px] border border-line px-2.5 py-1 text-[12.5px] font-semibold text-ink hover:bg-canvas">{a.action.label}</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        {/* Results */}
        <div className="grid min-w-0 content-start gap-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[16px] font-semibold text-ink">How your business is doing</h2>
            <Segmented label="Period" value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }]} />
          </div>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Results">
            {data.metrics.map((m) => {
              const Icon = METRIC_ICON[m.id] ?? MessageSquare;
              const diff = m.value - m.previous;
              return (
                <li key={m.id}>
                  <Link href={m.href} className="block h-full rounded-[16px] border border-line bg-white p-4 shadow-[var(--shadow-card)] transition hover:border-ink/20" data-testid={`metric-${m.id}`}>
                    <span className="flex items-center gap-2 text-[12.5px] font-semibold text-muted"><Icon className="size-4" aria-hidden />{m.label}</span>
                    <span className="mt-2 block text-[28px] leading-none font-bold text-ink tabular">{m.value.toLocaleString('en-IN')}</span>
                    <span className="mt-2 block text-[12px] text-muted">
                      {!m.hasData ? `Nothing yet in ${RANGE_LABEL[data.range]}.` : diff === 0 ? `Same as ${PREV_LABEL[data.range]}.` : (
                        <span className={cx('inline-flex items-center gap-1 font-semibold', diff > 0 ? 'text-brand-dark' : 'text-rose')}>{diff > 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}{diff > 0 ? '+' : ''}{diff.toLocaleString('en-IN')} vs {PREV_LABEL[data.range]}</span>
                      )}
                    </span>
                    <span className="mt-1 block text-[11.5px] text-faint">{m.why}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <Card>
            <CardHeader title="Customer messages and calls per day" subtitle={`India time · updated ${since(data.updatedAt)} · refreshes every minute`} />
            {noActivity && data.series.messages.every((v) => v === 0) && data.series.calls.every((v) => v === 0) ? (
              <Empty icon={<MessageSquare className="size-7" />} title="No customer activity yet">When customers message or call, the daily trend appears here.</Empty>
            ) : data.range === 'today' ? (
              <p className="px-5 pb-5 text-[13px] text-body">Today: {data.series.messages[0] ?? 0} customer message(s) and {data.series.calls[0] ?? 0} call(s). Choose 7 or 30 days for the trend.</p>
            ) : (
              <div className="px-3 pb-4 sm:px-5">
                <TrendChart labels={data.series.labels.map(fmtDate)} series={[{ name: 'Customer messages', values: data.series.messages, color: def.accent }, { name: 'Calls', values: data.series.calls, color: '#0ea5e9', dashed: true }]} />
                <p className="mt-2 flex gap-4 text-[12px] text-muted"><span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: def.accent }} />Customer messages</span><span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded border-t-2 border-dashed border-sky-500" />Calls</span></p>
              </div>
            )}
          </Card>
        </div>

        {/* Setup checklist + activity */}
        <div className="grid min-w-0 content-start gap-5">
          <Card>
            <CardHeader title="Setup checklist" subtitle="Green only when it really works." />
            <ol className="divide-y divide-line px-5 pb-3" aria-label="Setup checklist">
              {data.checklist.map((c) => {
                const st = STATUS[c.status];
                const Icon = c.status === 'complete' ? CheckCircle2 : c.status === 'blocked' ? Lock : CircleDashed;
                return (
                  <li key={c.id} className="flex items-start gap-3 py-3" data-testid={`step-${c.id}`} data-status={c.status}>
                    <Icon className={cx('mt-0.5 size-[18px] shrink-0', c.status === 'complete' ? 'text-brand' : c.status === 'blocked' ? 'text-slate-400' : 'text-amber')} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink">{c.label}<span className={cx('rounded-full px-1.5 py-px text-[11px] font-semibold', st.cls)}>{st.label}</span></p>
                      <p className="mt-0.5 text-[12.5px] text-body">{c.detail}</p>
                      {c.action && c.status !== 'complete' && <Link href={c.action.href} className="mt-1 inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-dark hover:underline">{c.action.label}<ArrowRight className="size-3.5" /></Link>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </Card>
          <Card>
            <CardHeader title="Recent activity" />
            {data.activity.length === 0 ? <Empty title="Nothing has happened yet">New leads, calls, orders and setup changes appear here.</Empty> : (
              <ol className="divide-y divide-line px-5 pb-3" aria-label="Recent activity">
                {data.activity.map((a) => (
                  <li key={a.id}>
                    <Link href={a.href} className="flex items-start gap-3 py-2.5 hover:opacity-80">
                      <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', a.tone === 'ok' ? 'bg-brand' : a.tone === 'warn' ? 'bg-amber' : 'bg-sky-500')} aria-hidden />
                      <span className="min-w-0 flex-1 text-[13px] text-ink">{a.text}</span>
                      <time className="shrink-0 text-[11.5px] text-faint" dateTime={a.at}>{since(a.at)}</time>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
      <h2 className="mt-2 border-t border-line pt-6 text-[16px] font-semibold text-ink">{def.short} details</h2>
    </div>
  );
}
