'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, CardHeader, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { IndustryOnly, Label, inputCls } from '@/components/textile';
import { DataList, Pill, SourceNote, Stat, Toolbar, plusDays, todayIst, when } from '@/components/vertical-ui';
import { TrendChart } from '@/components/charts';
import { ScopeFilters, downloadCsv, dur, qs } from '@/components/visionops';

type Report = {
  from: string; to: string; uptimePct: number | null; downMinutes: number; unknownMinutes: number; unresolved: number;
  bySite: Array<{ siteId: string; site: string; code: string; cameras: number; cameraMinutes: number; downMinutes: number; unknownMinutes: number; uptimePct: number | null }>;
  byDay: Array<{ day: string; uptimePct: number | null; downMinutes: number; unknownMinutes: number }>;
  byCustomer: Array<{ customerId: string; customer: string; sites: number; cameras: number; uptimePct: number | null; downMinutes: number; unknownMinutes: number; incidents: number; unresolved: number; slaHours: number | null; slaBreaches: number }>;
  incidents: Array<{ number: string; site: string; device: string | null; category: string; severity: string; status: string; detected: string; acknowledged: string | null; resolved: string | null; minutes: number; rootCause: string | null; resolvedBy: string | null }>;
};

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}%`);

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Uptime & SLA reports" />
      <IndustryOnly allow={['cctv']}><Reports /></IndustryOnly>
    </>
  );
}

function Reports() {
  const [from, setFrom] = useState(plusDays(todayIst(), -30));
  const [to, setTo] = useState(todayIst());
  const [scope, setScope] = useState({ customerId: '', siteId: '' });
  const fromIso = new Date(`${from}T00:00:00+05:30`).toISOString();
  const toIso = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000).toISOString();
  const { data, error, reload } = useApi<Report>(`/monitoring/reports/uptime${qs({ from: fromIso, to: toIso, ...scope })}`);
  return (
    <>
      <Toolbar>
        <Label text="From" className="flex items-center gap-2"><input type="date" className={cx(inputCls.replace('w-full', 'w-auto min-w-[150px]'), 'h-10')} value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Label>
        <Label text="To" className="flex items-center gap-2"><input type="date" className={cx(inputCls.replace('w-full', 'w-auto min-w-[150px]'), 'h-10')} value={to} min={from} max={todayIst()} onChange={(e) => setTo(e.target.value)} /></Label>
        <ScopeFilters value={scope} onChange={setScope} />
      </Toolbar>
      {error && !data ? <ErrorBanner message={error} onRetry={reload} /> : !data ? <Skeleton className="h-96" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Uptime (measured)" value={pct(data.uptimePct)} tone={data.uptimePct !== null && data.uptimePct < 99 ? 'amber' : 'green'} />
            <Stat label="Down camera-time" value={dur(data.downMinutes)} tone="red" />
            <Stat label="Unknown (no data)" value={dur(data.unknownMinutes)} hint="Excluded from uptime, reported separately" />
            <Stat label="Unresolved incidents" value={data.unresolved} tone={data.unresolved ? 'amber' : undefined} />
          </div>
          <Card className="mb-4">
            <CardHeader title="Daily uptime" subtitle={`${when(data.from).split(',')[0]} – ${when(data.to).split(',')[0]}`} />
            <div className="px-3 pb-4"><TrendChart labels={data.byDay.map((d) => d.day.slice(5).split('-').reverse().join('/'))} series={[{ name: 'Uptime %', values: data.byDay.map((d) => d.uptimePct ?? 0), color: '#1e5bd8' }]} /></div>
          </Card>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-[15px] font-bold text-ink">By customer (AMC / SLA)</h2><Button onClick={() => downloadCsv('customer-sla.csv', ['Customer', 'Sites', 'Cameras', 'Uptime %', 'Down min', 'Unknown min', 'Incidents', 'Unresolved', 'SLA hours', 'SLA breaches'], data.byCustomer.map((c) => [c.customer, c.sites, c.cameras, c.uptimePct, c.downMinutes, c.unknownMinutes, c.incidents, c.unresolved, c.slaHours, c.slaBreaches]))}><Download className="size-4" /> CSV</Button></div>
          <DataList rows={data.byCustomer} rowKey={(c) => c.customerId}
            columns={[
              { head: 'Customer', cell: (c) => <span className="font-semibold text-ink">{c.customer}</span> },
              { head: 'Sites / cameras', cell: (c) => `${c.sites} / ${c.cameras}` },
              { head: 'Uptime', cell: (c) => pct(c.uptimePct), align: 'right' },
              { head: 'Down', cell: (c) => dur(c.downMinutes), align: 'right' },
              { head: 'Unknown', cell: (c) => dur(c.unknownMinutes), align: 'right' },
              { head: 'Incidents', cell: (c) => `${c.incidents}${c.unresolved ? ` (${c.unresolved} open)` : ''}`, align: 'right' },
              { head: 'SLA', cell: (c) => (c.slaHours ? <span>{c.slaHours} h · {c.slaBreaches ? <Pill tone="red">{c.slaBreaches} breach{c.slaBreaches > 1 ? 'es' : ''}</Pill> : <Pill tone="green">met</Pill>}</span> : '—') },
            ]}
            card={(c) => <div className="flex justify-between gap-2"><div><p className="font-semibold text-ink">{c.customer}</p><p className="text-[12px] text-muted">{c.incidents} incidents · SLA breaches {c.slaBreaches}</p></div><p className="font-bold text-ink">{pct(c.uptimePct)}</p></div>}
          />
          <div className="mt-5 mb-2 flex items-center justify-between"><h2 className="text-[15px] font-bold text-ink">By site</h2><Button onClick={() => downloadCsv('site-uptime.csv', ['Site', 'Code', 'Cameras', 'Camera minutes', 'Down min', 'Unknown min', 'Uptime %'], data.bySite.map((s) => [s.site, s.code, s.cameras, s.cameraMinutes, s.downMinutes, s.unknownMinutes, s.uptimePct]))}><Download className="size-4" /> CSV</Button></div>
          <DataList rows={data.bySite.filter((s) => !s.code.startsWith('LAB-'))} rowKey={(s) => s.siteId}
            columns={[
              { head: 'Site', cell: (s) => <div><p className="font-semibold text-ink">{s.site}</p><p className="text-[11.5px] text-muted">{s.code}</p></div> },
              { head: 'Cameras', cell: (s) => s.cameras, align: 'right' },
              { head: 'Uptime', cell: (s) => pct(s.uptimePct), align: 'right' },
              { head: 'Down', cell: (s) => dur(s.downMinutes), align: 'right' },
              { head: 'Unknown', cell: (s) => dur(s.unknownMinutes), align: 'right' },
            ]}
            card={(s) => <div className="flex justify-between"><p className="font-semibold text-ink">{s.site}</p><p className="font-bold">{pct(s.uptimePct)}</p></div>}
          />
          <div className="mt-5 mb-2 flex items-center justify-between"><h2 className="text-[15px] font-bold text-ink">Incidents in the period · {data.incidents.length}</h2><Button onClick={() => downloadCsv('downtime-incidents.csv', ['Incident', 'Site', 'Device', 'Fault', 'Severity', 'Status', 'Detected', 'Acknowledged', 'Resolved', 'Minutes', 'Root cause', 'Resolved by'], data.incidents.map((i) => [i.number, i.site, i.device, i.category, i.severity, i.status, i.detected, i.acknowledged, i.resolved, i.minutes, i.rootCause, i.resolvedBy]))}><Download className="size-4" /> CSV</Button></div>
          <DataList rows={data.incidents.slice().reverse().slice(0, 60)} rowKey={(i) => i.number}
            columns={[
              { head: 'Incident', cell: (i) => <span className="font-semibold text-ink">{i.number}</span> },
              { head: 'Site / device', cell: (i) => `${i.site}${i.device ? ` · ${i.device}` : ''}` },
              { head: 'Fault', cell: (i) => i.category },
              { head: 'Detected', cell: (i) => when(i.detected) },
              { head: 'Downtime', cell: (i) => dur(i.minutes), align: 'right' },
              { head: 'Root cause', cell: (i) => <span className="text-[12px]">{i.rootCause ?? '—'}</span> },
              { head: 'Status', cell: (i) => <Pill status={i.status} /> },
            ]}
            card={(i) => <div><p className="font-semibold text-ink">{i.number} · {i.category}</p><p className="text-[12px] text-muted">{i.site} · {dur(i.minutes)} · {i.status}</p></div>}
          />
          <p className="mt-3 text-[11.5px] text-muted">Uptime counts camera-minutes; a recorder or network outage counts every affected camera. Time while an agent was silent is unknown and is excluded, never counted as uptime. SLA breaches compare restore time with the contract target.</p>
        </>
      )}
      <SourceNote api="GET /monitoring/reports/uptime" />
    </>
  );
}
