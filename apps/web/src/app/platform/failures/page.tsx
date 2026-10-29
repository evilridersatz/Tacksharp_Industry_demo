'use client';

import { useApi } from '@/lib/api';
import { Card, CardHeader, Skeleton } from '@/components/ui';
import { PlatformFrame, when } from '@/components/platform';

type F = {
  jobs: Array<{ queue: string; id?: string; name: string; failedReason: string; attemptsMade: number; finishedOn?: number; organizationId?: string }>;
  queueError: string | null;
  inbound: Array<{ id: string; organizationId: string; channel: string; status: string; attempts: number; lastError: string | null; updatedAt: string }>;
  webhooks: { since: string; recent: Array<{ at: string; source: string; reason: string; path: string }>; totals: Record<string, number> };
};

export default function PlatformFailures() {
  const { data: f, error, reload } = useApi<F>('/platform/failures', 30_000);
  return (
    <PlatformFrame title="Failures" error={error} reload={reload}>
      {!f ? <Skeleton className="h-96" /> : (
        <div className="grid gap-4">
          <Card className="overflow-hidden">
            <CardHeader title="Failed background jobs" subtitle={f.queueError ? `Queues unavailable: ${f.queueError}` : 'Latest failed jobs per queue (BullMQ). Payloads are not shown.'} />
            <div className="overflow-x-auto"><table className="w-full text-[13px]"><thead className="bg-slate-50 text-left text-[12px] text-muted"><tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Queue</th><th className="px-4 py-2">Organization</th><th className="px-4 py-2">Attempts</th><th className="px-4 py-2">Reason</th></tr></thead>
              <tbody>{f.jobs.map((j) => <tr key={`${j.queue}-${j.id}`} className="border-t border-line"><td className="px-4 py-2 whitespace-nowrap text-muted">{j.finishedOn ? when(new Date(j.finishedOn).toISOString()) : '—'}</td><td className="px-4 py-2">{j.queue}</td><td className="px-4 py-2">{j.organizationId ?? '—'}</td><td className="px-4 py-2">{j.attemptsMade}</td><td className="px-4 py-2 text-rose-800">{j.failedReason}</td></tr>)}
                {!f.jobs.length && <tr><td colSpan={5} className="px-4 py-3 text-muted">No failed jobs.</td></tr>}</tbody></table></div>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader title="Inbound messages that failed" subtitle="Customer messages the platform could not answer or whose reply delivery is unknown." />
            <div className="overflow-x-auto"><table className="w-full text-[13px]"><thead className="bg-slate-50 text-left text-[12px] text-muted"><tr><th className="px-4 py-2">Updated</th><th className="px-4 py-2">Organization</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Attempts</th><th className="px-4 py-2">Error</th></tr></thead>
              <tbody>{f.inbound.map((m) => <tr key={m.id} className="border-t border-line"><td className="px-4 py-2 whitespace-nowrap text-muted">{when(m.updatedAt)}</td><td className="px-4 py-2">{m.organizationId}</td><td className="px-4 py-2">{m.status}</td><td className="px-4 py-2">{m.attempts}</td><td className="px-4 py-2 text-rose-800">{m.lastError ?? '—'}</td></tr>)}
                {!f.inbound.length && <tr><td colSpan={5} className="px-4 py-3 text-muted">None.</td></tr>}</tbody></table></div>
          </Card>
          <Card>
            <CardHeader title="Rejected webhooks" subtitle={`Since this API process started (${when(f.webhooks.since)}). Bad signatures and unknown numbers; the log has the full record.`} />
            <div className="grid gap-3 px-5 pb-4 text-[13px]">
              <p>{Object.entries(f.webhooks.totals).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'None rejected.'}</p>
              <ul className="grid gap-1 text-[12.5px]">{f.webhooks.recent.map((w, i) => <li key={i}><span className="text-muted">{when(w.at)}</span> · {w.source} · {w.reason} · <code>{w.path}</code></li>)}</ul>
            </div>
          </Card>
        </div>
      )}
    </PlatformFrame>
  );
}
