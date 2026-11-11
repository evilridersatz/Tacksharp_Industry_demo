'use client';

import { useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Sparkles } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { BarList, ColumnChart } from '@/components/charts';
import { LiveStamp } from '@/components/live-stamp';
import { Button, Card, ErrorBanner, Skeleton } from '@/components/ui';
import { Stat } from '@/components/vertical-ui';
import { toast } from '@/components/toast';
import { AlertList, SectionCard, SpeakButton, inr, when, type Overview } from '@/components/jarvis';

export default function JarvisBriefingPage() {
  const { data, error, reload, updatedAt } = useApi<Overview>('/jarvis/overview', 60_000);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { await api.post('/jarvis/digest'); reload(); toast('Briefing refreshed.'); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const s = data?.snapshot;
  return (
    <>
      <PageHeader title="Daily briefing" crumb="Jarvis" actions={<Button onClick={() => void refresh()} busy={busy}><RefreshCw className="size-4" aria-hidden /> Refresh now</Button>} />
      <LiveStamp at={updatedAt} every="refreshes on every new order, call and message" />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data || !s ? <Skeleton className="h-96" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Orders today" value={s.today.orders} hint={inr(s.today.revenue)} />
            <Stat label="Yesterday" value={s.yesterday.orders} hint={inr(s.yesterday.revenue)} />
            <Stat label="Calls today" value={s.today.calls} hint={`${s.today.callMinutes} min`} />
            <Stat label="Open alerts" value={data.alerts.length} tone={data.alerts.some((a) => a.severity === 'critical') ? 'red' : data.alerts.length ? 'amber' : 'green'} />
          </div>

          <SectionCard title="Briefing" subtitle={data.settings.digest.on ? `Prepared every day at ${String(data.settings.digest.hour).padStart(2, '0')}:${String(data.settings.digest.minute).padStart(2, '0')} (India time). Below: live numbers right now.` : 'The scheduled briefing is off (Monitors & alerts → settings).'} action={<SpeakButton lines={[data.digest.headline, ...data.digest.lines.slice(1)]} />}>
            <div className="px-4 pb-4">
              <p className="flex items-start gap-2 text-[15px] font-semibold text-ink"><Sparkles className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--industry-accent)' }} aria-hidden />{data.digest.headline}</p>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-6 text-[13.5px] text-body">{data.digest.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              {data.lastDigest && <p className="mt-3 text-[11.5px] text-faint">Last saved briefing: {when(data.lastDigest.at)} ({data.lastDigest.source}). <Link href="/jarvis/monitors" className="underline">Settings</Link></p>}
            </div>
          </SectionCard>

          {s.days && s.days.some((d) => d.orders > 0) && (
            <SectionCard title="Sales this week" subtitle={`${inr(s.last7.revenue)} from ${s.last7.orders} orders`}>
              <div className="px-4 pb-4"><ColumnChart labels={s.days.map((d, i) => (i === s.days!.length - 1 ? 'Today' : new Date(`${d.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })))} values={s.days.map((d) => d.revenue)} color="var(--industry-accent)" format={(v) => (v >= 1000 ? `₹${(v / 1000).toFixed(1)}k` : `₹${Math.round(v)}`)} height={170} /></div>
            </SectionCard>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Top sellers (7 days)">
              {s.topItems.length ? (
                <div className="px-4 pb-4"><BarList labels={s.topItems.map((i) => `${i.name} · ${i.qty} ${i.unit}`)} values={s.topItems.map((i) => i.revenue)} color="var(--industry-accent)" format={(v) => inr(v)} /></div>
              ) : <p className="px-4 pb-4 text-[12.5px] text-muted">No orders in the last 7 days.</p>}
            </SectionCard>
            <SectionCard title="Top customers (30 days)" subtitle="Phone numbers masked.">
              {s.topCustomers.length ? (
                <table className="w-full text-[13px]"><tbody>{s.topCustomers.map((c, i) => <tr key={i} className="border-t border-line"><td className="px-4 py-2 text-ink">{c.name} <span className="text-muted">{c.phone}</span></td><td className="px-4 py-2 text-right tabular text-body">{c.orders} orders</td><td className="px-4 py-2 text-right tabular font-semibold text-ink">{inr(c.spend)}</td></tr>)}</tbody></table>
              ) : <p className="px-4 pb-4 text-[12.5px] text-muted">No orders in the last 30 days.</p>}
            </SectionCard>
          </div>

          <SectionCard title="Open alerts" subtitle="From the monitors. Each problem is raised once a day." action={<Link href="/jarvis/monitors" className="text-[12.5px] font-semibold" style={{ color: 'var(--industry-accent)' }}>All alerts</Link>}>
            <AlertList alerts={data.alerts.slice(0, 5)} onResolved={reload} />
          </SectionCard>
          <Card className="p-4 text-[12px] text-muted">Jarvis reads this workspace’s own orders, calls, conversations, stock and invoices. It never messages a customer or changes an order. Numbers as of {when(s.at)}.</Card>
        </>
      )}
    </>
  );
}
