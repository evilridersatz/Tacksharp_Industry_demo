'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { explainCallReason } from '@/lib/call-reasons';
import { PageHeader } from '@/components/shell';
import { Card, CardHeader, ErrorBanner, Skeleton, cx } from '@/components/ui';

type Health = { status: 'ok' | 'degraded'; release: { id: string | null; startedAt: string; dryRun: boolean }; api: { ok: boolean; uptimeSec: number }; database: { ok: boolean; ms: number }; redis: { ok: boolean; ms: number }; queues: Record<string, Record<string, number> | string>; ms: number };
type Home = { channels: Array<{ id: string; label: string; status: string; detail: string; href: string }>; agents: { total: number; active: number; builtIn: boolean }; mode: { dryRun: boolean; sarvamWebhookReady: boolean } };
type Integration = { provider: string; status: string; lastError: string | null; lastTestAt: string | null };
type CallRow = { requestId: string; status: string; failureReason: string | null; provider: string; createdAt: string };

function Row({ ok, warn, label, detail, href }: { ok: boolean; warn?: boolean; label: string; detail: string; href?: string }) {
  return (
    <li className="flex items-start gap-3 py-3">
      {ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" aria-label="Working" /> : warn ? <CircleDashed className="mt-0.5 size-5 shrink-0 text-amber" aria-label="Attention" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-rose" aria-label="Problem" />}
      <div className="min-w-0 flex-1"><p className="text-[14px] font-semibold text-ink">{label}</p><p className="text-[12.5px] text-body">{detail}</p></div>
      {!ok && href && <Link href={href} className="shrink-0 text-[12.5px] font-semibold text-brand-dark underline">Fix</Link>}
    </li>
  );
}

/**
 * System health in plain language for everyone; detailed checks, recent provider errors and refused call requests for
 * administrators. Read-only: nothing here restarts services or changes infrastructure. No secrets are ever returned.
 */
export default function DiagnosticsPage() {
  const { workspace } = useWorkspace();
  const admin = !workspace?.role || workspace.role === 'admin';
  const { data: health, error: healthErr } = useApi<Health>('/health', 30_000);
  const { data: home } = useApi<Home>('/home?range=today', 60_000);
  const { data: integrations } = useApi<{ items: Integration[] }>(admin ? '/integrations' : null, 60_000);
  const { data: calls } = useApi<CallRow[]>(admin ? '/telephony/calls' : null, 60_000);
  const queueBacklog = health && typeof health.queues === 'object' ? Object.values(health.queues).reduce((n, q) => n + (typeof q === 'object' ? (q.waiting ?? 0) + (q.delayed ?? 0) : 0), 0) : 0;
  const queueFailed = health && typeof health.queues === 'object' ? Object.values(health.queues).reduce((n, q) => n + (typeof q === 'object' ? q.failed ?? 0 : 0), 0) : 0;
  // Last sanitised error per provider (the server scrubs secrets before storing it).
  const errors = (integrations?.items ?? []).filter((i) => i.lastError).map((i) => ({ provider: i.provider, at: i.lastTestAt, message: i.lastError, status: i.status }));
  const refused = (calls ?? []).filter((c) => ['failed', 'rejected'].includes(c.status)).slice(0, 10);

  return (
    <>
      <PageHeader title="System health" crumb="Settings" />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Is everything working?" subtitle="Checked every 30 seconds." />
          {healthErr && !health ? <div className="px-5 pb-5"><ErrorBanner message="Tacksharp could not be reached. Check your internet connection; if it continues, contact Tacksharp support." /></div> : !health || !home ? <Skeleton className="mx-5 mb-5 h-48" /> : (
            <ul className="divide-y divide-line px-5 pb-2">
              <Row ok={health.api.ok} label="Application" detail={health.api.ok ? 'Tacksharp is running.' : 'The application is not responding.'} />
              <Row ok={health.database.ok} label="Your business data" detail={health.database.ok ? 'Saved and available.' : 'Data cannot be read or saved right now. Try again shortly; if it continues, contact Tacksharp support.'} />
              <Row ok={health.redis.ok && queueFailed === 0} warn={health.redis.ok} label="Background work (follow-ups, message sending)" detail={!health.redis.ok ? 'Background work is paused: scheduled follow-ups will run when it recovers.' : queueFailed ? `${queueFailed} background job(s) failed recently.` : queueBacklog ? `${queueBacklog} job(s) waiting to run.` : 'Up to date.'} />
              {home.channels.map((c) => <Row key={c.id} ok={c.status === 'connected'} warn={c.status !== 'needs_attention'} label={c.label} detail={c.detail} href={c.href} />)}
              <Row ok={home.agents.active > 0 || home.agents.builtIn} warn label="AI assistant" detail={home.agents.active ? `${home.agents.active} custom agent(s) active.` : home.agents.builtIn ? 'Your industry assistant is available.' : 'No AI assistant is active yet.'} href="/voice-agents" />
              <Row ok={!home.mode.dryRun} warn label="Sending mode" detail={home.mode.dryRun ? 'Test mode: messages and calls are checked but not sent.' : 'Live.'} />
            </ul>
          )}
        </Card>

        {admin ? (
          <Card>
            <CardHeader title="Advanced diagnostics" subtitle="For administrators. Sanitised: no keys, tokens or customer details." />
            {!health ? <Skeleton className="mx-5 mb-5 h-48" /> : (
              <div className="grid gap-4 px-5 pb-5 text-[12.5px]">
                <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted">Overall</dt><dd className={cx('font-semibold', health.status === 'ok' ? 'text-brand-dark' : 'text-rose')}>{health.status}</dd>
                  <dt className="text-muted">Release</dt><dd className="text-ink">{health.release.id ?? 'not set'} · running since {new Date(health.release.startedAt).toLocaleString()}</dd>
                  <dt className="text-muted">Database</dt><dd className="text-ink">{health.database.ok ? `ok · ${health.database.ms} ms` : 'unavailable'}</dd>
                  <dt className="text-muted">Queue store</dt><dd className="text-ink">{health.redis.ok ? `ok · ${health.redis.ms} ms` : 'unavailable'}</dd>
                  <dt className="text-muted">Queues</dt><dd className="text-ink break-words">{Object.entries(health.queues).map(([k, v]) => `${k}: ${typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ') : v}`).join(' · ') || '—'}</dd>
                  <dt className="text-muted">Health check</dt><dd className="text-ink">{health.ms} ms</dd>
                  <dt className="text-muted">Sarvam webhooks</dt><dd className="text-ink">{home?.mode.sarvamWebhookReady ? 'secret configured' : 'TELEPHONY_WEBHOOK_SECRET not set: Sarvam calls are refused'}</dd>
                </dl>
                <div>
                  <p className="mb-1 font-semibold text-ink">Last provider errors</p>
                  {errors.length === 0 ? <p className="text-muted">None recorded.</p> : (
                    <ul className="grid gap-1">{errors.map((e) => <li key={e.provider} className="flex gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber" /><span><b>{e.provider}</b> · last test {e.at ? new Date(e.at).toLocaleString() : 'never'} · {e.status === 'failed' ? 'failing' : 'recovered since'}<span className="block break-words text-muted">{e.message}</span></span></li>)}</ul>
                  )}
                </div>
                <div>
                  <p className="mb-1 font-semibold text-ink">Call requests not placed</p>
                  {refused.length === 0 ? <p className="text-muted">None.</p> : (
                    <ul className="grid gap-1">{refused.map((c) => <li key={c.requestId}><b>{c.provider}</b> · {new Date(c.createdAt).toLocaleString()} · {explainCallReason(c.failureReason)} <span className="text-muted">(request {c.requestId}, {c.failureReason})</span></li>)}</ul>
                  )}
                </div>
                <p className="text-muted">Remediation: open the integration with the error and run its test; for database or background problems, contact Tacksharp support with the release id above. Nothing on this page restarts services.</p>
              </div>
            )}
          </Card>
        ) : (
          <Card><CardHeader title="Advanced diagnostics" subtitle="Only workspace administrators can see technical details." /></Card>
        )}
      </div>
    </>
  );
}
