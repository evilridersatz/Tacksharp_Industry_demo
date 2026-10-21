'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Bot, Database, Info } from 'lucide-react';
import { useApi } from '@/lib/api';
import { rupees } from '@/lib/format';
import { industryDef, type IndustryDef } from '@/lib/industries';
import { PageHeader } from './shell';
import { BarList, Donut, Funnel, TrendChart } from './charts';
import { Badge, Card, CardHeader, Empty, ErrorBanner, Segmented, Skeleton, cx } from './ui';

export type DashKpi = { key: string; label: string; value: number | null; format: 'number' | 'inr' | 'pct' | 'hours'; hint?: string; tone?: 'brand' | 'sky' | 'violet' | 'amber' | 'rose' | 'slate' };
export type DashChart = { key: string; title: string; kind: 'line' | 'bar' | 'donut' | 'funnel'; unit: string; labels: string[]; series: Array<{ name: string; values: number[] }>; source: string; empty?: string };
export type IndustryDashboardData = { industry: string; label: string; days: number; demo: boolean; generatedAt: string; kpis: DashKpi[]; charts: DashChart[]; notes: string[] };

const PALETTE = ['#0ea5e9', '#f59e0b', '#e11d48', '#0f9f6e', '#7c5cf0', '#64748b', '#14b8a6', '#a855f7'];
const TONE_BAR: Record<string, string> = { brand: '#0f9f6e', sky: '#0ea5e9', violet: '#7c5cf0', amber: '#f59e0b', rose: '#e11d48', slate: '#94a3b8' };

export function formatValue(v: number | null | undefined, format: DashKpi['format'] | string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (format === 'inr') return v === 0 ? '₹0' : rupees(v);
  if (format === 'pct') return `${v}%`;
  if (format === 'hours') return `${v} h`;
  return v.toLocaleString('en-IN');
}
const unitFormat = (unit: string) => (v: number) => formatValue(v, unit === 'inr' || unit === '₹' ? 'inr' : unit === 'pct' || unit === '%' ? 'pct' : unit === 'hours' ? 'hours' : 'number');

function KpiCard({ k, def }: { k: DashKpi; def: IndustryDef }) {
  return (
    <Card className="relative overflow-hidden p-4">
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: k.tone ? TONE_BAR[k.tone] : def.accent }} aria-hidden />
      <p className="text-[12.5px] leading-snug text-muted">{k.label}</p>
      <p className="mt-1 text-[22px] leading-tight font-bold text-ink tabular sm:text-[24px]">{formatValue(k.value, k.format)}</p>
      {k.hint && <p className="mt-1 text-[11.5px] leading-snug text-faint">{k.hint}</p>}
    </Card>
  );
}

function ChartCard({ c, def }: { c: DashChart; def: IndustryDef }) {
  const colors = [def.accent, ...PALETTE];
  const total = c.series[0]?.values.reduce((a, b) => a + b, 0) ?? 0;
  const empty = c.empty || !c.labels.length || (c.kind !== 'line' && total === 0) || (c.kind === 'line' && c.series.every((s) => s.values.every((v) => !v)));
  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader title={c.title} subtitle={c.kind === 'line' && c.series.length > 1 ? c.series.map((s) => s.name).join(' vs ') : undefined} />
      <div className="min-w-0 flex-1 px-5 pb-3">
        {empty ? (
          <div className="grid h-full min-h-[140px] place-items-center rounded-[12px] border border-dashed border-line px-4 text-center text-[12.5px] text-muted">
            {c.empty ?? 'No records in this period.'}
          </div>
        ) : c.kind === 'line' ? (
          <>
            <TrendChart labels={c.labels} series={c.series.map((s, i) => ({ name: s.name, values: s.values, color: colors[i], dashed: i > 0 }))} />
            {c.series.length > 1 && (
              <div className="mt-1 flex flex-wrap gap-3 text-[12px] text-muted">
                {c.series.map((s, i) => (
                  <span key={s.name} className="inline-flex items-center gap-1.5">
                    <span className="h-1 w-4 rounded-full" style={{ background: colors[i] }} /> {s.name}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : c.kind === 'bar' ? (
          <BarList labels={c.labels} values={c.series[0]?.values ?? []} color={def.accent} format={unitFormat(c.unit)} />
        ) : c.kind === 'funnel' ? (
          <Funnel labels={c.labels} values={c.series[0]?.values ?? []} color={def.accent} />
        ) : (
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
            <Donut parts={(c.series[0]?.values ?? []).map((v, i) => ({ value: v, color: colors[i % colors.length] }))} total={total} label={c.unit === 'count' ? 'total' : c.unit} />
            <ul className="flex w-full min-w-0 flex-col gap-1.5 text-[12.5px]">
              {c.labels.map((l, i) => (
                <li key={l} className="flex items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors[i % colors.length] }} />
                  <span className="min-w-0 flex-1 truncate text-body">{l.replace(/_/g, ' ')}</span>
                  <span className="font-semibold text-ink tabular">{c.series[0]?.values[i]}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <p className="flex items-center gap-1.5 border-t border-line px-5 py-2 text-[11.5px] text-faint">
        <Database className="size-3 shrink-0" aria-hidden /> <span className="truncate">Source: {c.source}</span>
      </p>
    </Card>
  );
}

/**
 * Industry dashboard (textile, retail, manufacturing, agency, and the analytics page of every industry). Every number
 * comes from GET /industry/dashboard, computed from this workspace's records; nothing is estimated in the browser.
 */
export function IndustryDashboard({ title, analytics }: { title?: string; analytics?: boolean }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const { data, error, loading, reload } = useApi<IndustryDashboardData>(`/industry/dashboard?days=${days}`, 60_000);
  const def = industryDef(data?.industry);
  return (
    <>
      <PageHeader title={title ?? (data ? `${def.short} overview` : 'Overview')} crumb={analytics ? 'Reports & analytics' : 'Overview'} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {data && (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold" style={{ background: def.accentSoft, color: def.accent }}>
              <def.icon className="size-3.5" aria-hidden /> {def.label}
            </span>
          )}
          {data?.demo && <Badge tone="amber">Demo data</Badge>}
          {data && <span className="text-[12px] text-muted">Updated {new Date(data.generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
        <Segmented label="Date range" value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      </div>

      {error && !data && <ErrorBanner message={error} onRetry={reload} />}

      <section aria-label="Key figures" className={cx('grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6', loading && data && 'opacity-70')}>
        {!data && !error && Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-[104px]" />)}
        {data?.kpis.map((k) => <KpiCard key={k.key} k={k} def={def} />)}
      </section>

      {data && !data.kpis.length && (
        <Card className="mt-4">
          <Empty title="Nothing recorded yet">Figures appear here as soon as this workspace records activity.</Empty>
        </Card>
      )}

      <section aria-label="Charts" className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {!data && !error && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[300px]" />)}
        {data?.charts.map((c) => <ChartCard key={c.key} c={c} def={def} />)}
      </section>

      {data && (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
          <Card className="p-4">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <Info className="size-4 text-muted" aria-hidden /> How these figures are calculated
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px] text-muted">
              <li>Only this workspace&apos;s records, for the last {data.days} days (India time).</li>
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Card>
          {!analytics && (
            <Link href="/agents" className="group flex items-center gap-3 rounded-[var(--radius-card)] border border-line bg-white p-4 shadow-[var(--shadow-card)] hover:border-slate-300">
              <span className="grid size-10 shrink-0 place-items-center rounded-[12px]" style={{ background: def.accentSoft, color: def.accent }}>
                <Bot className="size-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-ink">{def.short} AI agents</span>
                <span className="block text-[12px] text-muted">See what each agent does, its status and try it safely.</span>
              </span>
              <ArrowRight className="size-4 text-muted group-hover:translate-x-0.5" aria-hidden />
            </Link>
          )}
        </div>
      )}
    </>
  );
}
