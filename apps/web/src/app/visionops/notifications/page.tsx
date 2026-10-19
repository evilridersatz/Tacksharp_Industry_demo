'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { ErrorBanner, Skeleton, cx } from '@/components/ui';
import { IndustryOnly, inputCls } from '@/components/textile';
import { DataList, Pill, SimulatedNote, SourceNote, Stat, Toolbar, when } from '@/components/vertical-ui';
import { Pager, qs } from '@/components/visionops';

type Row = { id: string; incidentId: string; incident: { number: string }; recipientType: string; recipientName: string | null; recipientPhone: string | null; channel: string; purpose: string; body: string; status: string; simulated: boolean; scheduledFor: string; sentAt: string | null; deliveredAt: string | null; attempts: number; lastError: string | null; costEstimate: string };
type Resp = { total: number; page: number; rows: Row[]; byStatus: Array<{ status: string; count: number }>; liveCostInr: number; liveMessages: number };

export default function NotificationsPage() {
  return (
    <>
      <PageHeader title="WhatsApp alerts" />
      <IndustryOnly allow={['cctv']}><Notifications /></IndustryOnly>
    </>
  );
}

function Notifications() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, reload } = useApi<Resp>(`/monitoring/notifications${qs({ status, page })}`, 20_000);
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-96" />;
  const n = (s: string) => data.byStatus.find((b) => b.status === s)?.count ?? 0;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Simulated (not sent)" value={n('simulated')} hint="DRY_RUN or demo" />
        <Stat label="Sent / delivered / read" value={n('sent') + n('delivered') + n('read')} tone="green" hint="Live provider only" />
        <Stat label="Waiting (quiet hours / retry)" value={n('deferred') + n('queued')} tone="amber" />
        <Stat label="Live messaging cost" value={`₹${data.liveCostInr.toFixed(2)}`} hint={`${data.liveMessages} live messages × rate in Settings`} />
      </div>
      <div className="mb-3"><SimulatedNote>While DRY_RUN is on (and always in demo workspaces) every message is recorded as SIMULATED with its exact text; nothing reaches WhatsApp. Live sends need DRY_RUN=false and an approved test number.</SimulatedNote></div>
      <Toolbar>
        <select aria-label="Status" className={cx(inputCls.replace('w-full', 'w-auto min-w-[150px]'), 'h-10')} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>{['simulated', 'queued', 'deferred', 'sent', 'delivered', 'read', 'failed', 'skipped', 'cancelled'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </Toolbar>
      <DataList rows={data.rows} rowKey={(r) => r.id} empty="No messages yet."
        columns={[
          { head: 'When', cell: (r) => <span className="text-[12px]">{when(r.sentAt ?? r.scheduledFor)}</span> },
          { head: 'Incident', cell: (r) => <Link className="font-semibold text-[#1e5bd8]" href={`/visionops/incidents?open=${r.incidentId}`}>{r.incident.number}</Link> },
          { head: 'Purpose', cell: (r) => <span className="capitalize">{r.purpose.replace('_', ' ')}</span> },
          { head: 'To', cell: (r) => <div><p>{r.recipientName ?? '—'}</p><p className="text-[11.5px] text-muted">{r.recipientType} · {r.recipientPhone}</p></div> },
          { head: 'Message', cell: (r) => <p className="line-clamp-2 max-w-[440px] text-[12px] text-body">{r.body}</p>, className: 'max-w-[460px]' },
          { head: 'Status', cell: (r) => <div className="flex flex-col items-start gap-0.5"><Pill status={r.status} />{r.attempts > 1 && <span className="text-[11px] text-muted">{r.attempts} attempts</span>}</div> },
        ]}
        card={(r) => <div><div className="flex items-center justify-between gap-2"><p className="font-semibold text-ink">{r.incident.number} · {r.purpose.replace('_', ' ')}</p><Pill status={r.status} /></div><p className="text-[12px] text-muted">{r.recipientName} · {when(r.sentAt ?? r.scheduledFor)}</p><p className="mt-1 line-clamp-3 text-[12px] text-body">{r.body}</p></div>}
      />
      <Pager page={data.page} total={data.total} size={50} onPage={setPage} />
      <SourceNote api="GET /monitoring/notifications" />
    </>
  );
}
