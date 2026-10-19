'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, ArrowRight, Cctv, HardDrive, RadioTower, RefreshCw, ServerCog, Siren, Timer, WifiOff } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from './shell';
import { Button, Card, CardHeader, ErrorBanner, Segmented, Skeleton, cx } from './ui';
import { BarList, TrendChart } from './charts';
import { Pill, SourceNote } from './vertical-ui';
import { INTERNET_LABEL, SeverityMark, ago, dur, minutes, type IncidentRow, type SiteRow } from './visionops';
import { errorText } from './textile';

type Overview = {
  days: number; generatedAt: string; demo: boolean;
  kpis: { customers: number; sites: number; cameras: number; recorders: number; online: number; offline: number; unknown: number; degraded: number; maintenance: number; recordersOffline: number; activeIncidents: number; critical: number; unacknowledged: number; mttaMinutes: number | null; mttrMinutes: number | null; uptimePct: number | null; sitesWithOutage: number; agentsOnline: number; agentsOffline: number };
  charts: { availability: Array<{ day: string; uptimePct: number | null; unknownMinutes: number }>; downtimeBySite: Array<{ site: string; downMinutes: number; uptimePct: number | null }>; byRootCause: Array<{ label: string; count: number }>; responseByWeek: Array<{ week: string; mttaMinutes: number | null; mttrMinutes: number | null; incidents: number }>; incidentsByDay: Array<{ day: string; incidents: number }> };
  notes: string[];
};

const lbl = (d: string) => d.slice(5).split('-').reverse().join('/');
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/** Tacksharp VisionOps operations center: everything on one screen, from authorised database queries only. */
export function VisionOpsOverview() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const { data, error, reload } = useApi<Overview>(`/monitoring/overview?days=${days}`, 30_000);
  const { data: sites } = useApi<SiteRow[]>('/monitoring/sites', 30_000);
  const { data: active, reload: reloadActive } = useApi<{ rows: IncidentRow[] }>('/monitoring/incidents?status=active&pageSize=50&lab=exclude', 20_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function runChecks() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ agentsOffline: number; escalated: number; delivered: number }>('/monitoring/run-checks', {});
      setMsg(`Checks run: ${r.agentsOffline} agent(s) newly silent, ${r.escalated} escalation(s), ${r.delivered} message(s) processed (simulated under DRY_RUN).`);
      await Promise.all([reload(), reloadActive()]);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const k = data?.kpis;
  const attention = [...(active?.rows ?? [])].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || Number(Boolean(a.acknowledgedAt)) - Number(Boolean(b.acknowledgedAt)) || a.firstDetectedAt.localeCompare(b.firstDetectedAt));

  return (
    <>
      <PageHeader title="Operations center" actions={<Button busy={busy} onClick={runChecks}><RefreshCw className="size-4" /> Run checks now</Button>} />
      {msg && <p role="status" className="mb-3 rounded-[10px] bg-slate-100 px-3 py-2 text-[12.5px] text-body">{msg}</p>}
      {error && !data ? <ErrorBanner message={error} onRetry={reload} /> : !data || !k ? <Skeleton className="h-[420px] rounded-[18px]" /> : (
        <>
          {/* Status board */}
          <section aria-label="Live status" className="mb-4 overflow-hidden rounded-[18px] bg-[#0b1730] text-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
              <div className="flex items-center gap-2.5">
                <span className="relative flex size-2.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" /><span className="relative inline-flex size-2.5 rounded-full bg-emerald-400" /></span>
                <p className="text-[13px] font-semibold tracking-wide">Centralized CCTV monitoring · {k.sites} sites · {k.customers} customers</p>
              </div>
              <p className="text-[11.5px] text-white/60">Updated {ago(data.generatedAt)} · status from health checks, never from AI</p>
            </div>
            <div className="grid grid-cols-2 gap-px bg-white/10 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { label: 'Cameras', value: k.cameras, sub: `${k.recorders} NVR / DVR`, icon: Cctv, tone: 'text-white' },
                { label: 'Online', value: k.online, sub: k.cameras ? `${Math.round((k.online / k.cameras) * 100)}% of fleet` : '—', icon: RadioTower, tone: 'text-emerald-300' },
                { label: 'Offline', value: k.offline, sub: `${k.recordersOffline} recorder(s) down`, icon: AlertTriangle, tone: 'text-rose-300' },
                { label: 'Unknown', value: k.unknown, sub: `${k.agentsOffline} agent(s) silent`, icon: WifiOff, tone: 'text-slate-300' },
                { label: 'Active incidents', value: k.activeIncidents, sub: `${k.critical} critical`, icon: Siren, tone: 'text-amber-300' },
                { label: 'Not acknowledged', value: k.unacknowledged, sub: `${k.sitesWithOutage} site(s) with outage`, icon: Timer, tone: 'text-amber-200' },
              ].map((t) => (
                <div key={t.label} className="bg-[#0b1730] px-5 py-4">
                  <p className="flex items-center gap-1.5 text-[11.5px] font-medium tracking-wide text-white/60 uppercase"><t.icon className="size-3.5" aria-hidden />{t.label}</p>
                  <p className={cx('mt-1 text-[30px] leading-none font-bold tabular', t.tone)}>{t.value}</p>
                  <p className="mt-1 text-[11.5px] text-white/50">{t.sub}</p>
                </div>
              ))}
            </div>
            {/* Site health strip */}
            <ul className="grid grid-cols-1 gap-px bg-white/10 sm:grid-cols-2 xl:grid-cols-5" aria-label="Sites">
              {(sites ?? []).filter((s) => !s.code.startsWith('LAB-')).map((s) => (
                <li key={s.id} className="bg-[#0d1d3b]">
                  <Link href={`/visionops/sites?site=${s.id}`} className="block px-4 py-3 hover:bg-white/5 focus-visible:bg-white/10">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[13px] font-semibold">{s.name}</p>
                      <span className={cx('rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase', s.health === 'healthy' ? 'bg-emerald-400/15 text-emerald-300' : s.health === 'outage' ? 'bg-rose-400/20 text-rose-200' : s.health === 'unknown' ? 'bg-white/10 text-slate-200' : 'bg-amber-400/15 text-amber-200')}>{s.health}</span>
                    </div>
                    <p className="truncate text-[11.5px] text-white/50">{s.customer.name} · {INTERNET_LABEL[s.internetStatus] ?? s.internetStatus}</p>
                    <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-white/10" role="img" aria-label={`${s.online} online, ${s.offline} offline, ${s.unknown} unknown of ${s.cameras}`}>
                      <span className="bg-emerald-400" style={{ width: `${(s.online / Math.max(1, s.cameras)) * 100}%` }} />
                      <span className="bg-amber-400" style={{ width: `${(s.degraded / Math.max(1, s.cameras)) * 100}%` }} />
                      <span className="bg-rose-400" style={{ width: `${(s.offline / Math.max(1, s.cameras)) * 100}%` }} />
                      <span className="bg-slate-400/60" style={{ width: `${(s.unknown / Math.max(1, s.cameras)) * 100}%` }} />
                    </div>
                    <p className="mt-1.5 text-[11.5px] text-white/70 tabular">{s.online}/{s.cameras} online{s.activeIncidents ? ` · ${s.activeIncidents} incident${s.activeIncidents > 1 ? 's' : ''}` : ''}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.25fr_1fr]">
            <Card>
              <CardHeader title="Needs attention" subtitle="Active incidents, worst first" action={<Link href="/visionops/incidents" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-[#1e5bd8]">All incidents <ArrowRight className="size-3.5" /></Link>} />
              {attention.length ? (
                <ul className="divide-y divide-line">
                  {attention.slice(0, 7).map((i) => (
                    <li key={i.id}>
                      <Link href={`/visionops/incidents?open=${i.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-slate-50">
                        <SeverityMark s={i.severity} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-semibold text-ink">{i.number} · {i.categoryLabel}{i.deviceCode ? ` · ${i.deviceCode}` : ''}</p>
                          <p className="truncate text-[12px] text-muted">{i.site.name}{i.affectedCount > 1 ? ` · ${i.affectedCount} cameras` : ''} · {dur(minutes(i.firstDetectedAt))}{i.assignedTechnician ? ` · ${i.assignedTechnician.name}` : ''}</p>
                        </div>
                        <Pill status={i.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <p className="px-5 pb-5 text-[13px] text-muted">No active incidents. Every monitored device is reporting normally.</p>}
            </Card>
            <Card className="p-5">
              <p className="text-[12.5px] font-semibold text-muted">Service levels · last {data.days} days</p>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <Metric label="Uptime" value={k.uptimePct === null ? '—' : `${k.uptimePct.toFixed(2)}%`} hint="measured time" />
                <Metric label="Time to acknowledge" value={dur(k.mttaMinutes)} hint="mean" />
                <Metric label="Time to restore" value={dur(k.mttrMinutes)} hint="mean" />
              </div>
              <div className="mt-4"><Segmented label="Period" value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} /></div>
              <p className="mt-4 text-[12px] text-muted">Agents: <b className="text-ink">{k.agentsOnline}</b> reporting, <b className="text-ink">{k.agentsOffline}</b> silent. Cameras behind a silent agent show <b>unknown</b>, never offline.</p>
              {data.demo && <p className="mt-3 rounded-[10px] bg-cyan-50 px-3 py-2 text-[12px] text-cyan-900">Demo workspace: synthetic sites and devices; WhatsApp messages are simulated.</p>}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Camera availability" subtitle="Uptime % per day (unknown time excluded)" />
              <div className="px-3 pb-4"><TrendChart labels={data.charts.availability.map((d) => lbl(d.day))} series={[{ name: 'Uptime %', values: data.charts.availability.map((d) => d.uptimePct ?? 0), color: '#1e5bd8' }]} /></div>
            </Card>
            <Card>
              <CardHeader title="Incident trend" subtitle="Incidents detected per day" />
              <div className="px-3 pb-4"><TrendChart labels={data.charts.incidentsByDay.map((d) => lbl(d.day))} series={[{ name: 'Incidents', values: data.charts.incidentsByDay.map((d) => d.incidents), color: '#e11d48' }]} /></div>
            </Card>
            <Card className="p-5">
              <p className="mb-3 text-[14px] font-semibold text-ink">Downtime by site <span className="text-[12px] font-normal text-muted">· down camera-minutes</span></p>
              <BarList labels={data.charts.downtimeBySite.map((s) => s.site)} values={data.charts.downtimeBySite.map((s) => s.downMinutes)} color="#e11d48" format={(v) => dur(v)} />
            </Card>
            <Card className="p-5">
              <p className="mb-3 text-[14px] font-semibold text-ink">Incidents by root cause</p>
              {data.charts.byRootCause.length ? <BarList labels={data.charts.byRootCause.map((c) => c.label)} values={data.charts.byRootCause.map((c) => c.count)} color="#1e5bd8" /> : <p className="text-[13px] text-muted">No incidents in this period.</p>}
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader title="Response times per week" subtitle="Mean minutes to acknowledge and to restore" />
              <div className="px-3 pb-4"><TrendChart labels={data.charts.responseByWeek.map((w) => lbl(w.week))} series={[{ name: 'Acknowledge (min)', values: data.charts.responseByWeek.map((w) => w.mttaMinutes ?? 0), color: '#f59e0b' }, { name: 'Restore (min)', values: data.charts.responseByWeek.map((w) => w.mttrMinutes ?? 0), color: '#1e5bd8' }]} /></div>
            </Card>
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-faint"><ServerCog className="size-3" /> {data.notes[0]}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-faint"><HardDrive className="size-3" /> Recording is shown as verified only where the recorder reports it; a reachable camera is not assumed to be recording.</p>
          <SourceNote api="GET /monitoring/overview · /monitoring/sites · /monitoring/incidents" />
        </>
      )}
    </>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-[12px] bg-slate-50 px-3 py-2.5">
      <p className="text-[11.5px] text-muted">{label}</p>
      <p className="text-[18px] font-bold text-ink tabular">{value}</p>
      <p className="text-[11px] text-faint">{hint}</p>
    </div>
  );
}
