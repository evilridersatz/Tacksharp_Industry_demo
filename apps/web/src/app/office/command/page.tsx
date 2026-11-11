'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Ban, Crown, Pause, Play, Rocket } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { LiveStamp } from '@/components/live-stamp';
import { Button, Card, CardHeader, Empty, Segmented, Skeleton, cx } from '@/components/ui';
import { toast } from '@/components/toast';
import { PlanTaskList, RoleChip, StatusPill, TaskPanel, ago, errorText, usd, withInr, type OfficeSettings, type PlanRow, type PlanView } from '@/components/office';

const EXAMPLES = [
  'Manage today’s operations, follow up with pending customers, review sales and prepare my daily executive report.',
  'Check stock and pending orders and create jobs for my staff where something needs attention.',
  'Make sure every customer waiting for a person is assigned, then tell me how many there were.',
];

export default function CommandPage() {
  return (
    <>
      <PageHeader title="CEO command center" crumb="AI Office" />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Command />
      </Suspense>
    </>
  );
}

function Command() {
  const params = useSearchParams();
  const router = useRouter();
  const settings = useApi<OfficeSettings>('/office/settings', 0);
  const list = useApi<{ items: PlanRow[] }>('/office/plans', 15_000);
  const [instruction, setInstruction] = useState(params.get('instruction') ?? '');
  const [mode, setMode] = useState<'manual' | 'supervised' | 'autonomous' | ''>('');
  const [busy, setBusy] = useState<string | null>(null);
  const planId = params.get('plan');
  const [task, setTask] = useState<string | null>(null);
  const plan = useApi<PlanView>(planId ? `/office/plans/${planId}` : null, 5_000);
  useEffect(() => { if (settings.data && !mode) setMode(settings.data.mode); }, [settings.data, mode]);
  const open = (id: string | null) => router.replace(id ? `/office/command?plan=${id}` : '/office/command', { scroll: false });

  const submit = async () => {
    setBusy('plan');
    try {
      const p = await api.post<PlanView>('/office/plans', { instruction, mode, idempotencyKey: `click-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
      setInstruction('');
      toast(p.status === 'running' ? 'Plan approved within budget and started (autonomous mode).' : 'The CEO prepared a plan. Check it, then approve it.');
      open(p.id);
      list.reload();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };
  const action = async (a: 'run' | 'cancel' | 'pause' | 'resume') => {
    if (!planId) return;
    setBusy(a);
    try { await api.post(`/office/plans/${planId}/${a}`); toast(a === 'run' ? 'Approved: the office is working on it.' : a === 'cancel' ? 'Plan cancelled.' : a === 'pause' ? 'Plan paused.' : 'Plan resumed.'); plan.reload(); list.reload(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };
  const p = plan.data;
  const inrRate = settings.data?.inrPerUsd ?? 0;

  return (
    <>
    <LiveStamp at={plan.updatedAt ?? list.updatedAt} every="plan progress updates as tasks finish" />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        <Card className="mb-4">
          <CardHeader title="Instruction" subtitle="The CEO turns it into tasks for the specialists and shows the cost before anything runs." />
          <div className="px-5 pb-5">
            <label htmlFor="instruction" className="sr-only">Instruction</label>
            <textarea id="instruction" value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} maxLength={4000} placeholder="What should the office do?" className="w-full rounded-[10px] border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-slate-400" />
            <div className="mt-2 flex flex-wrap gap-1.5">{EXAMPLES.map((x) => <button key={x} type="button" onClick={() => setInstruction(x)} className="rounded-full border border-line px-2.5 py-1 text-left text-[12px] text-body hover:border-slate-300">{x.length > 70 ? `${x.slice(0, 68)}…` : x}</button>)}</div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              {mode && <Segmented label="Mode for this plan" value={mode} onChange={setMode} options={[{ value: 'manual', label: 'Manual' }, { value: 'supervised', label: 'Supervised' }, { value: 'autonomous', label: 'Autonomous' }]} />}
              <Button variant="primary" onClick={() => void submit()} busy={busy === 'plan'} disabled={instruction.trim().length < 5}><Crown className="size-4" aria-hidden /> Ask the CEO to plan</Button>
            </div>
            <p className="mt-2 text-[11.5px] text-muted">Manual: every action waits for you. Supervised: the agents act on their own inside the platform; anything sent to a customer waits for you. Autonomous: a plan within budget starts without your click; messages to customers still wait for you.</p>
          </div>
        </Card>

        {planId && !p && <Skeleton className="h-64" />}
        {p && (
          <Card className="mb-4 overflow-hidden">
            <CardHeader
              title={p.summary ?? 'Plan'}
              subtitle={<span className="flex flex-wrap items-center gap-2"><StatusPill status={p.status} /><span className="capitalize">{p.mode}</span><span>· {p.source === 'workflow' ? 'from a workflow' : 'from you'}</span><span>· {ago(p.createdAt)}</span></span>}
              action={
                <div className="flex flex-wrap gap-2">
                  {p.status === 'draft' && <Button variant="primary" onClick={() => void action('run')} busy={busy === 'run'}><Rocket className="size-4" aria-hidden /> Approve and run</Button>}
                  {p.status === 'running' && <Button onClick={() => void action('pause')} busy={busy === 'pause'}><Pause className="size-4" aria-hidden /> Pause</Button>}
                  {p.status === 'paused' && <Button variant="primary" onClick={() => void action('resume')} busy={busy === 'resume'}><Play className="size-4" aria-hidden /> Resume</Button>}
                  {['draft', 'running', 'paused'].includes(p.status) && <Button onClick={() => void action('cancel')} busy={busy === 'cancel'}><Ban className="size-4" aria-hidden /> {p.status === 'draft' ? 'Discard' : 'Cancel'}</Button>}
                </div>
              }
            />
            <div className="grid grid-cols-2 gap-3 border-t border-line px-5 py-3 text-[12.5px] md:grid-cols-4">
              <div><span className="block text-muted">Estimate</span><b className="text-ink">{withInr(p.estimate.usd, inrRate)}</b></div>
              <div><span className="block text-muted">Spent so far</span><b className="text-ink">{withInr(p.costUsd, inrRate)}</b></div>
              <div><span className="block text-muted">Model calls / tools</span><b className="text-ink">{p.steps} / {p.toolCalls}</b></div>
              <div><span className="block text-muted">Tokens</span><b className="text-ink">{(p.tokensIn + p.tokensOut).toLocaleString('en-IN')}</b></div>
            </div>
            <p className="border-t border-line px-5 py-2 text-[12.5px] text-body"><span className="text-muted">Instruction: </span>{p.instruction}</p>
            {p.status === 'draft' ? (
              <ol className="divide-y divide-line border-t border-line">
                {p.plan.tasks.map((t, i) => (
                  <li key={t.key} className="flex gap-3 px-5 py-2.5">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-slate-100 text-[11.5px] font-semibold text-body">{i + 1}</span>
                    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><b className="text-[13.5px] text-ink">{t.title}</b><RoleChip role={t.role} />{t.dependsOn.length > 0 && <span className="text-[11.5px] text-muted">after {t.dependsOn.join(', ')}</span>}</div><p className="mt-0.5 text-[12.5px] text-body">{t.instructions}</p></div>
                  </li>
                ))}
              </ol>
            ) : <PlanTaskList tasks={p.tasks} onOpen={setTask} />}
            {p.report && (
              <div className="border-t border-line bg-slate-50/60 px-5 py-4">
                <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Executive report</h3>
                <div className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{p.report}</div>
              </div>
            )}
          </Card>
        )}
        {task && <TaskPanel taskId={task} onClose={() => setTask(null)} onChanged={plan.reload} />}
      </div>

      <Card className="h-fit overflow-hidden">
        <CardHeader title="Recent plans" />
        {!list.data ? <Skeleton className="m-4 h-40" /> : list.data.items.length === 0 ? <Empty title="No plans yet">Give the CEO its first instruction.</Empty> : (
          <ul className="divide-y divide-line border-t border-line">
            {list.data.items.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => open(r.id)} className={cx('w-full px-4 py-2.5 text-left hover:bg-slate-50', r.id === planId && 'bg-slate-50')}>
                  <span className="line-clamp-2 text-[13px] font-semibold text-ink">{r.summary ?? r.instruction}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-muted"><StatusPill status={r.status} />{r._count.tasks || (r.estimate as { tasks?: number }).tasks || 0} tasks · {usd(r.costUsd)} · {ago(r.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
    </>
  );
}
