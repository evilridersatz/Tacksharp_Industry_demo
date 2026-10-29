'use client';

import { RefreshCw } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Button, Card, CardHeader, Skeleton } from '@/components/ui';
import { Check, PlatformFrame, when } from '@/components/platform';

type C = { ok: boolean; ms: number; error?: string };
type Health = {
  checkedAt: string; ms: number;
  release: { id: string | null; node: string; uptimeSec: number; dryRun: boolean };
  api: { ok: boolean; memoryMb: number }; database: C; redis: C;
  queues: Record<string, Record<string, number> | { error: string }>;
  storage: { ok: boolean; freeGb?: number; totalGb?: number; error?: string };
  providersLastHour: Array<{ provider: string; ok: boolean; count: number; avgLatencyMs: number | null }>;
};

/** Operational status (live checks), separate from configuration. Read-only: no restarts, migrations or shells here. */
export default function PlatformHealth() {
  const { data: h, error, reload, loading } = useApi<Health>('/platform/health', 20_000);
  return (
    <PlatformFrame title="Service health" error={error} reload={reload}>
      {!h ? <Skeleton className="h-96" /> : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted">
            <span>Last check {when(h.checkedAt)} ({h.ms} ms) · refreshes every 20 s</span>
            <Button busy={loading} onClick={() => void reload()}><RefreshCw className="size-4" /> Check now</Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="p-4"><p className="text-[12px] text-muted">API</p><Check ok={h.api.ok} label={`Up ${Math.round(h.release.uptimeSec / 60)} min · ${h.api.memoryMb} MB`} /><p className="mt-1 text-[12px] text-muted">Release {h.release.id ?? 'not set'} · {h.release.node}</p></Card>
            <Card className="p-4"><p className="text-[12px] text-muted">Database</p><Check ok={h.database.ok} label={h.database.ok ? `${h.database.ms} ms` : h.database.error} /></Card>
            <Card className="p-4"><p className="text-[12px] text-muted">Redis</p><Check ok={h.redis.ok} label={h.redis.ok ? `${h.redis.ms} ms` : h.redis.error} /></Card>
            <Card className="p-4"><p className="text-[12px] text-muted">Storage (call audio)</p><Check ok={h.storage.ok} label={h.storage.freeGb !== undefined ? `${h.storage.freeGb} GB free of ${h.storage.totalGb}` : h.storage.error} /></Card>
          </div>
          <Card className="overflow-hidden">
            <CardHeader title="Queues" subtitle={`Sending mode: ${h.release.dryRun ? 'dry run (nothing is sent)' : 'live'}`} />
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="bg-slate-50 text-left text-[12px] text-muted"><tr><th className="px-4 py-2">Queue</th>{['waiting', 'active', 'delayed', 'failed', 'completed'].map((k) => <th key={k} className="px-4 py-2 text-right">{k}</th>)}</tr></thead>
                <tbody>
                  {Object.entries(h.queues).map(([name, q]) => (
                    <tr key={name} className="border-t border-line"><td className="px-4 py-2 font-semibold">{name}</td>
                      {'error' in q ? <td colSpan={5} className="px-4 py-2 text-rose-700">{String(q.error)}</td> : ['waiting', 'active', 'delayed', 'failed', 'completed'].map((k) => <td key={k} className={`px-4 py-2 text-right tabular ${k === 'failed' && (q as Record<string, number>)[k] ? 'font-semibold text-rose-700' : ''}`}>{(q as Record<string, number>)[k] ?? 0}</td>)}
                    </tr>
                  ))}
                  {!Object.keys(h.queues).length && <tr><td className="px-4 py-3 text-muted" colSpan={6}>Queue counts unavailable (Redis down).</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
          <Card>
            <CardHeader title="Providers in the last hour" subtitle="From requests this platform actually made (tests, model turns, calls)." />
            <ul className="grid gap-1.5 px-5 pb-4 text-[13px]">
              {h.providersLastHour.map((p) => <li key={`${p.provider}-${p.ok}`}><Check ok={p.ok} label={`${p.provider}: ${p.count} ${p.ok ? 'succeeded' : 'failed'}${p.avgLatencyMs !== null ? ` · avg ${p.avgLatencyMs} ms` : ''}`} /></li>)}
              {!h.providersLastHour.length && <li className="text-muted">No provider requests in the last hour.</li>}
            </ul>
          </Card>
          <p className="text-[12px] text-muted">Restarts, migrations and server configuration are deliberately not available here; they follow the deployment runbook (DEPLOY.md).</p>
        </div>
      )}
    </PlatformFrame>
  );
}
