'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Crown, Pause, Play, Send } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { Stat } from '@/components/vertical-ui';
import { toast } from '@/components/toast';
import { AgentFigure, StatusPill, errorText, usd, withInr } from '@/components/office';

type FloorAgent = { id: string; role: string; name: string; status: string; breaker: string; enabled: boolean; purpose: string; currentTask: { id: string; title: string } | null; open: Record<string, number> };
type Floor = { mode: string; paused: boolean; runningPlans: number; pendingApprovals: number; spendTodayUsd: number; maxUsdPerDay: number; inrPerUsd: number; departments: Array<{ key: string; name: string; agents: FloorAgent[] }> };

const MODE_LABEL: Record<string, string> = { manual: 'Manual: every action needs approval', supervised: 'Supervised: sensitive actions need approval', autonomous: 'Autonomous within budget and policy' };

export default function OfficeFloorPage() {
  const { data, error, reload } = useApi<Floor>('/office/floor', 10_000);
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState('');
  const router = useRouter();
  const togglePause = async () => {
    if (!data) return;
    setBusy(true);
    try { await api.put('/office/settings', { paused: !data.paused }); toast(data.paused ? 'The office is working again.' : 'The office is paused: no agent takes a step until you resume.'); reload(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const openCount = (a: FloorAgent) => Object.values(a.open).reduce((x, y) => x + y, 0);
  return (
    <>
      <PageHeader title="Office floor" crumb="AI Office" actions={data && <Button onClick={() => void togglePause()} busy={busy} variant={data.paused ? 'primary' : 'secondary'}>{data.paused ? <><Play className="size-4" aria-hidden /> Resume office</> : <><Pause className="size-4" aria-hidden /> Pause office</>}</Button>} />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-96" /> : (
        <>
          {data.paused && <p role="status" className="mb-4 rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-semibold text-amber-900">The AI Office is paused. No agent takes a step or calls a tool until you resume it.</p>}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Plans running" value={data.runningPlans} />
            <Stat label="Waiting for your approval" value={data.pendingApprovals} tone={data.pendingApprovals ? 'amber' : 'green'} hint={data.pendingApprovals ? <Link href="/office/approvals" className="underline">Review now</Link> : 'Nothing waiting'} />
            <Stat label="AI spend today" value={usd(data.spendTodayUsd)} hint={`Daily limit ${withInr(data.maxUsdPerDay, data.inrPerUsd)}`} tone={data.spendTodayUsd >= data.maxUsdPerDay * 0.8 ? 'amber' : undefined} />
            <Stat label="Mode" value={<span className="text-[15px] capitalize">{data.mode}</span>} hint={MODE_LABEL[data.mode]} />
          </div>

          <Card className="mb-4 p-4">
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); router.push(`/office/command?instruction=${encodeURIComponent(instruction)}`); }}>
              <Crown className="size-5 shrink-0" style={{ color: '#7c3aed' }} aria-hidden />
              <label htmlFor="quick-instruction" className="sr-only">Instruction for the CEO</label>
              <input id="quick-instruction" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Tell the CEO what you need, e.g. “Review today’s pending orders and prepare my report”" className="h-10 min-w-[220px] flex-1 rounded-[10px] border border-line bg-white px-3 text-[14px] outline-none focus:border-slate-400" />
              <Button variant="primary" type="submit" disabled={instruction.trim().length < 5}><Send className="size-4" aria-hidden /> Plan it</Button>
            </form>
          </Card>

          <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.departments.map((d) => (
              <section key={d.key} aria-label={d.name} className="rounded-[var(--radius-card)] border border-line bg-[repeating-linear-gradient(45deg,#f8fafc_0,#f8fafc_12px,#f1f5f9_12px,#f1f5f9_24px)] p-3">
                <h2 className="mb-2 flex items-center justify-between px-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{d.name}<span className="font-normal normal-case">{d.agents.filter((a) => a.status === 'working').length} working</span></h2>
                <ul className="flex flex-col gap-2">
                  {d.agents.map((a) => (
                    <li key={a.id}>
                      <Link href={`/office/agents?agent=${a.id}`} className={cx('flex items-start gap-3 rounded-[12px] border border-line bg-white p-3 transition hover:border-slate-300', !a.enabled && 'opacity-60')}>
                        <AgentFigure role={a.role} status={a.status} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2"><span className="text-[14px] font-semibold text-ink">{a.name}</span><StatusPill status={a.status} />{a.breaker !== 'healthy' && <Badge tone={a.breaker === 'stopped' ? 'rose' : 'amber'}>breaker: {a.breaker}</Badge>}</div>
                          <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{a.currentTask ? <>Working on: <span className="text-body">{a.currentTask.title}</span></> : a.purpose}</p>
                          {openCount(a) > 0 && <p className="mt-1 text-[11.5px] text-body">{Object.entries(a.open).map(([s, c]) => `${c} ${s.replace(/_/g, ' ')}`).join(' · ')}</p>}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="mt-4 text-[11.5px] text-faint">Agents are AI. They only use the tools listed on their page, never see passwords or keys, and every action is recorded in the audit trail. Messages to customers always wait for a person’s approval.</p>
        </>
      )}
    </>
  );
}
