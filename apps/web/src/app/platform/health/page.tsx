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
  responseTimes?: Record<'voice' | 'whatsapp', { turns: number } & Record<string, { p50: number | null; p95: number | null; count: number } | number | string | object>>;
};

type Stat = { p50: number | null; p95: number | null; count: number };
const STAGES: Record<'voice' | 'whatsapp', Array<[string, string]>> = {
  whatsapp: [['providerDelay', 'Meta → our webhook'], ['queueWait', 'Waiting in our queue'], ['ai', 'Deciding the reply (AI / rules)'], ['send', 'Sending to Meta'], ['total', 'Our total (pick-up → sent)']],
  voice: [['download', 'Recording download'], ['stt', 'Speech to text'], ['ai', 'Deciding the reply'], ['postAiDb', 'Saving'], ['tts', 'Text to speech'], ['total', 'Our total per turn']],
};
const sec = (ms: number | null) => (ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

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
          {h.responseTimes && (
            <Card className="overflow-hidden">
              <CardHeader title="Response times" subtitle="p50 / p95 per stage for the recent replies handled by this API process (resets on restart). Use it to see where a slow reply spends its time." />
              <div className="grid gap-4 px-5 pb-5 md:grid-cols-2">
                {(['whatsapp', 'voice'] as const).map((ch) => (
                  <div key={ch}>
                    <h3 className="text-[13px] font-semibold text-ink">{ch === 'whatsapp' ? 'WhatsApp replies' : 'Voice call turns'} <span className="font-normal text-muted">({h.responseTimes![ch].turns} recorded)</span></h3>
                    <table className="mt-2 w-full text-[12.5px]">
                      <thead className="text-left text-muted"><tr><th className="py-1">Stage</th><th className="py-1 text-right">p50</th><th className="py-1 text-right">p95</th></tr></thead>
                      <tbody>{STAGES[ch].map(([k, l]) => { const st = h.responseTimes![ch][k] as Stat | undefined; return <tr key={k} className="border-t border-line"><td className="py-1">{l}</td><td className="py-1 text-right tabular">{sec(st?.p50 ?? null)}</td><td className="py-1 text-right tabular">{sec(st?.p95 ?? null)}</td></tr>; })}</tbody>
                    </table>
                  </div>
                ))}
              </div>
            </Card>
          )}
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
