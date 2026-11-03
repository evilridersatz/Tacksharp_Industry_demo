'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { API_URL, useApi } from '@/lib/api';
import { Button, Card, CardHeader, ErrorBanner, Segmented, Skeleton, cx } from './ui';
import { BarList, Funnel, TrendChart } from './charts';
import { toast } from './toast';

type Kpi = { value: number | null; previous: number | null; changePct: number | null };
type Data = {
  days: number; capped: boolean;
  kpis: Record<'inboundMessages' | 'conversations' | 'handoffRatePct' | 'aiMedianResponseSec' | 'teamMedianResponseSec' | 'unansweredTurns' | 'leads' | 'leadConversionPct' | 'orders' | 'revenue' | 'averageOrderValue', Kpi>;
  responseTimes: { ai: { count: number; medianSec: number | null; p90Sec: number | null }; team: { count: number; medianSec: number | null; p90Sec: number | null }; unanswered: number };
  answeredBy: { ai: number; team: number; automatic: number; simulated: number };
  channels: Array<{ channel: string; inbound: number; conversations: number }>;
  crm: { stages: Array<{ stage: string; count: number }>; note: string };
  sources: Array<{ source: string; leads: number; won: number; conversionPct: number | null }>;
  revenue: { series: Array<{ day: string; orders: number; revenue: number }>; buyers: number; repeatBuyers: number; repeatRatePct: number | null };
  automation: { campaigns: Record<string, number>; drips: Record<string, number>; dripStopReasons: Record<string, number>; workflows: Record<string, number>; metaCapi: Record<string, number> };
  team: Array<{ userId: string; name: string; openAssigned: number; replies: number; medianResponseSec: number | null }>;
  heatmap: { grid: number[][]; note: string };
  series: Array<{ day: string; customer: number; ai: number; team: number; automatic: number }>;
  definitions: Record<string, string>;
};

const CH: Record<string, string> = { whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', voice: 'Phone', web: 'Web chat' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const secs = (s: number | null) => (s === null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const num = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-IN'));
/** ₹ with Indian grouping; 0 is a real figure (shown as ₹0), only "no data" is a dash. */
const inr = (v: number | null) => (v === null ? '—' : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

const TILES: Array<{ key: keyof Data['kpis']; label: string; fmt: (v: number | null) => string; lowerIsBetter?: boolean }> = [
  { key: 'inboundMessages', label: 'Customer messages', fmt: num },
  { key: 'conversations', label: 'Active conversations', fmt: num },
  { key: 'aiMedianResponseSec', label: 'AI reply time (median)', fmt: secs, lowerIsBetter: true },
  { key: 'teamMedianResponseSec', label: 'Team reply time (median)', fmt: secs, lowerIsBetter: true },
  { key: 'handoffRatePct', label: 'Handed to a person', fmt: (v) => (v === null ? '—' : `${v}%`), lowerIsBetter: true },
  { key: 'unansweredTurns', label: 'Waiting for an answer', fmt: num, lowerIsBetter: true },
  { key: 'leads', label: 'New leads', fmt: num },
  { key: 'leadConversionPct', label: 'Lead conversion', fmt: (v) => (v === null ? '—' : `${v}%`) },
  { key: 'orders', label: 'Completed orders', fmt: num },
  { key: 'revenue', label: 'Revenue', fmt: inr },
  { key: 'averageOrderValue', label: 'Average order', fmt: inr },
];

function Change({ k, lowerIsBetter }: { k: Kpi; lowerIsBetter?: boolean }) {
  if (k.changePct === null) return <span className="text-[11.5px] text-faint">no earlier data</span>;
  const good = lowerIsBetter ? k.changePct <= 0 : k.changePct >= 0;
  return <span className={cx('rounded-full px-1.5 py-0.5 text-[11.5px] font-bold', good ? 'bg-brand-soft text-brand-dark' : 'bg-rose-soft text-rose')}>{k.changePct >= 0 ? '▲' : '▼'} {Math.abs(k.changePct)}%</span>;
}

function Counts({ title, data, labels }: { title: string; data: Record<string, number>; labels?: Record<string, string> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <p className="mb-1 text-[12px] font-bold uppercase tracking-wide text-muted">{title}</p>
      {entries.length === 0 ? <p className="text-[12.5px] text-faint">None in this period</p> : (
        <ul className="space-y-0.5 text-[12.5px]">{entries.map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span className="text-body">{labels?.[k] ?? k.replace(/_/g, ' ')}</span><span className="font-semibold tabular text-ink">{v}</span></li>)}</ul>
      )}
    </div>
  );
}

/** Advanced analytics: response times, AI vs team, channels, funnel, revenue, automation, team and busy hours. */
export function AdvancedAnalytics() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const { data, error, reload } = useApi<Data>(`/analytics/advanced?days=${days}`, 60_000);
  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    setExporting(true);
    try {
      const res = await fetch(`${API_URL}/analytics/advanced/export?days=${days}`, { credentials: 'include' });
      if (!res.ok) throw new Error(res.status === 403 ? 'Your role cannot export analytics.' : `Export failed (HTTP ${res.status}).`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `tacksharp-analytics-${days}d.csv`; a.click();
      URL.revokeObjectURL(url);
      toast('Analytics exported.');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setExporting(false);
    }
  }
  const max = data ? Math.max(1, ...data.heatmap.grid.flat()) : 1;
  const answered = data ? data.answeredBy.ai + data.answeredBy.team + data.answeredBy.automatic : 0;

  return (
    <section className="mt-6 space-y-4" data-testid="advanced-analytics">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[18px] font-bold text-ink">Advanced analytics</h2>
        <span className="text-[12.5px] text-muted">compared with the previous {days} days</span>
        <div className="ml-auto flex items-center gap-2">
          <Segmented label="Period" value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
          <Button busy={exporting} onClick={() => void exportCsv()}><Download className="size-4" />Export CSV</Button>
        </div>
      </div>
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error && <Skeleton className="h-64" />}
      {data && (
        <>
          {data.capped && <p className="text-[12.5px] text-amber-800">Very busy period: message figures use the first 50 000 messages.</p>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" data-testid="aa-kpis">
            {TILES.map((t) => (
              <Card key={t.key} className="p-4" title={data.definitions[t.key] ?? ''} data-testid={`aa-kpi-${t.key}`}>
                <p className="text-[12px] font-semibold text-muted">{t.label}</p>
                <p className="mt-1 text-[22px] font-bold tabular text-ink">{t.fmt(data.kpis[t.key].value)}</p>
                <div className="mt-1 flex items-center gap-2"><Change k={data.kpis[t.key]} lowerIsBetter={t.lowerIsBetter} /><span className="text-[11.5px] text-faint">before: {t.fmt(data.kpis[t.key].previous)}</span></div>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader title="Messages per day" subtitle="Customer messages and who answered them" />
              <div className="px-5 pb-5"><TrendChart labels={data.series.map((d) => d.day.slice(5))} series={[{ name: 'Customer', values: data.series.map((d) => d.customer), color: '#0f9f6e' }, { name: 'AI', values: data.series.map((d) => d.ai), color: '#6366f1', dashed: true }, { name: 'Team', values: data.series.map((d) => d.team), color: '#f59e0b', dashed: true }]} /></div>
            </Card>
            <Card data-testid="aa-answered">
              <CardHeader title="Who answered" subtitle={`${answered} replies in the period`} />
              <div className="space-y-3 px-5 pb-5">
                <BarList labels={['AI', 'Team', 'Automatic (acknowledgement, drip, workflow)']} values={[data.answeredBy.ai, data.answeredBy.team, data.answeredBy.automatic]} color="#6366f1" />
                {data.answeredBy.simulated > 0 && <p className="text-[12px] text-amber-800">{data.answeredBy.simulated} of these were recorded in test mode (not sent).</p>}
                <div className="grid grid-cols-2 gap-2 border-t border-line pt-3 text-[12.5px]">
                  <div><p className="text-muted">AI reply</p><p className="font-semibold text-ink">median {secs(data.responseTimes.ai.medianSec)} · p90 {secs(data.responseTimes.ai.p90Sec)}</p></div>
                  <div><p className="text-muted">Team reply</p><p className="font-semibold text-ink">median {secs(data.responseTimes.team.medianSec)} · p90 {secs(data.responseTimes.team.p90Sec)}</p></div>
                </div>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Card data-testid="aa-channels">
              <CardHeader title="Channels" subtitle="Customer messages per channel" />
              <div className="px-5 pb-5">{data.channels.length ? <BarList labels={data.channels.map((c) => `${CH[c.channel] ?? c.channel} · ${c.conversations} conv.`)} values={data.channels.map((c) => c.inbound)} color="#0f9f6e" /> : <p className="text-[12.5px] text-faint">No messages in this period</p>}</div>
            </Card>
            <Card data-testid="aa-crm">
              <CardHeader title="CRM pipeline" subtitle={data.crm.note} />
              <div className="px-5 pb-5">
                <Funnel labels={['All customers', 'Interested', 'Qualified', 'Converted']} values={(() => { const c = Object.fromEntries(data.crm.stages.map((s) => [s.stage, s.count])); const total = data.crm.stages.reduce((n, s) => n + s.count, 0); return [total, (c.interested ?? 0) + (c.qualified ?? 0) + (c.converted ?? 0), (c.qualified ?? 0) + (c.converted ?? 0), c.converted ?? 0]; })()} color="#0f9f6e" />
                <p className="mt-2 text-[12px] text-muted">Lost: {data.crm.stages.find((s) => s.stage === 'lost')?.count ?? 0}</p>
              </div>
            </Card>
            <Card data-testid="aa-sources">
              <CardHeader title="Lead sources" subtitle="Leads in the period and how many were won" />
              <div className="px-5 pb-5">
                {data.sources.length === 0 ? <p className="text-[12.5px] text-faint">No leads in this period</p> : (
                  <table className="w-full text-[12.5px]"><thead className="text-muted"><tr><th className="text-left font-semibold">Source</th><th className="text-right font-semibold">Leads</th><th className="text-right font-semibold">Won</th><th className="text-right font-semibold">Rate</th></tr></thead>
                    <tbody>{data.sources.map((s) => <tr key={s.source} className="border-t border-line"><td className="py-1 text-body">{s.source.replace(/_/g, ' ')}</td><td className="text-right tabular">{s.leads}</td><td className="text-right tabular">{s.won}</td><td className="text-right tabular">{s.conversionPct === null ? '—' : `${s.conversionPct}%`}</td></tr>)}</tbody>
                  </table>
                )}
              </div>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
            <Card data-testid="aa-revenue">
              <CardHeader title="Completed orders per day" subtitle={`${data.revenue.buyers} buyers · ${data.revenue.repeatBuyers} repeat${data.revenue.repeatRatePct !== null ? ` (${data.revenue.repeatRatePct}%)` : ''}`} />
              <div className="px-5 pb-5"><TrendChart labels={data.revenue.series.map((d) => d.day.slice(5))} series={[{ name: 'Orders', values: data.revenue.series.map((d) => d.orders), color: '#0f9f6e' }]} /></div>
            </Card>
            <Card data-testid="aa-automation">
              <CardHeader title="Automation" subtitle="Started in the period" />
              <div className="grid grid-cols-2 gap-4 px-5 pb-5">
                <Counts title="Campaign recipients" data={data.automation.campaigns} />
                <Counts title="Drip enrolments" data={data.automation.drips} />
                <Counts title="Drip stopped because" data={data.automation.dripStopReasons} />
                <Counts title="Workflow runs" data={data.automation.workflows} />
                <Counts title="Meta conversions" data={data.automation.metaCapi} />
              </div>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
            <Card data-testid="aa-team">
              <CardHeader title="Team" subtitle="Replies in the period, open conversations assigned now, median reply time" />
              <div className="px-5 pb-5">
                {data.team.length === 0 ? <p className="text-[12.5px] text-faint">No team replies or assignments yet</p> : (
                  <table className="w-full text-[12.5px]"><thead className="text-muted"><tr><th className="text-left font-semibold">Person</th><th className="text-right font-semibold">Replies</th><th className="text-right font-semibold">Open</th><th className="text-right font-semibold">Reply time</th></tr></thead>
                    <tbody>{data.team.map((t) => <tr key={t.userId} className="border-t border-line"><td className="py-1 text-body">{t.name}</td><td className="text-right tabular">{t.replies}</td><td className="text-right tabular">{t.openAssigned}</td><td className="text-right tabular">{secs(t.medianResponseSec)}</td></tr>)}</tbody>
                  </table>
                )}
              </div>
            </Card>
            <Card data-testid="aa-heatmap">
              <CardHeader title="Busy hours" subtitle={data.heatmap.note} />
              <div className="overflow-x-auto px-5 pb-5">
                <div className="grid min-w-[560px] grid-cols-[36px_repeat(24,minmax(0,1fr))] gap-[3px] text-[10px] text-faint">
                  <span />
                  {Array.from({ length: 24 }, (_, h) => <span key={h} className="text-center">{h % 3 === 0 ? h : ''}</span>)}
                  {data.heatmap.grid.map((row, d) => [
                    <span key={`l${d}`} className="pr-1 text-right leading-[18px]">{DAYS[d]}</span>,
                    ...row.map((v, h) => <span key={`${d}-${h}`} title={`${DAYS[d]} ${h}:00 · ${v} message(s)`} className="h-[18px] rounded-[3px]" style={{ background: v ? `rgba(15,159,110,${0.15 + 0.85 * (v / max)})` : '#f1f5f9' }} />),
                  ])}
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </section>
  );
}
