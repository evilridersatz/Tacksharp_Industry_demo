'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState } from 'react';
import { Bot, Pause, Play, RotateCcw, Square, Zap } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { AgentSummary, AgentTask, Approval, FulfilmentRow, Integration, StockRow, WorkTask } from '@/lib/types';
import { AGENT_LABEL, TASK_STATUS, dateTime, newClientKey, recordLink, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Dialog, Label, Notice, errorText, inputCls } from '@/components/textile';
import { AgentCatalogue } from '@/components/agent-catalogue';
import { useIndustry } from '@/lib/industry';
import { ORCHESTRATED_INDUSTRIES } from '@/lib/industries';
import { ApprovalList, WorkTaskList } from '@/components/agents';

type Tab = 'tasks' | 'approvals' | 'people' | 'integrations';

export default function AgentCentrePage() {
  return (
    <>
      <PageHeader title="AI agents" crumb="AI agents" />
      <Suspense>
        <AgentsHome />
      </Suspense>
    </>
  );
}

/**
 * Every industry sees its agent catalogue (what each agent does, status, metrics, playground). Industries where the
 * back-office agents run also get the existing Agent Centre (tasks, approvals, team tasks, integrations).
 */
function AgentsHome() {
  const params = useSearchParams();
  const router = useRouter();
  const { industry } = useIndustry();
  const orchestrated = Boolean(industry && ORCHESTRATED_INDUSTRIES.includes(industry));
  const deepLink = params.get('view') === 'runtime' || params.has('task') || params.has('tab');
  const view = orchestrated && deepLink ? 'runtime' : 'catalogue';
  if (!industry) return <Skeleton className="h-60" />;
  return (
    <>
      {orchestrated && (
        <div className="mb-4">
          <Segmented
            label="AI agents section"
            value={view}
            onChange={(v) => router.replace(v === 'runtime' ? '/agents?view=runtime' : '/agents')}
            options={[{ value: 'catalogue', label: 'Agent catalogue' }, { value: 'runtime', label: 'Tasks & approvals' }]}
          />
        </div>
      )}
      {view === 'runtime' ? <AgentCentre /> : <AgentCatalogue />}
    </>
  );
}

function AgentCentre() {
  const params = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) ?? 'tasks');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data: agents, error, reload: reloadAgents } = useApi<AgentSummary[]>('/agents', 10_000);
  const { data: tasks, reload: reloadTasks } = useApi<AgentTask[]>(`/agents/tasks?${new URLSearchParams({ ...(agentFilter ? { agent: agentFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}) })}`, 8_000);
  const { data: approvals, reload: reloadApprovals } = useApi<Approval[]>('/agents/approvals/list', 10_000);
  const { data: work, reload: reloadWork } = useApi<WorkTask[]>('/agents/work-tasks/list?status=active', 10_000);
  const { data: integrations } = useApi<Integration[]>('/agents/integrations', 0);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [running, setRunning] = useState<AgentSummary | null>(null);
  const selected = params.get('task');
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadAgents(), reloadTasks(), reloadApprovals(), reloadWork()]);
  }, [reloadAgents, reloadTasks, reloadApprovals, reloadWork]);
  const pendingApprovals = (approvals ?? []).filter((a) => a.status === 'pending').length;
  const select = (id: string | null) => router.replace(id ? `/agents?task=${id}` : '/agents?view=runtime');
  const closeRun = useCallback(() => setRunning(null), []);

  async function togglePause(a: AgentSummary) {
    try {
      await api.post(`/agents/${a.name}/${a.paused ? 'resume' : 'pause'}`);
      setNotice({ tone: 'ok', text: `${a.label} ${a.paused ? 'resumed: waiting tasks are running' : 'paused: new tasks will wait'}.` });
      await reloadAll();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    }
  }

  return (
    <>
      <Notice notice={notice} />
      {error && !agents && <ErrorBanner message={error} onRetry={reloadAgents} />}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {!agents && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-56" />)}
        {agents?.map((a) => (
          <Card key={a.name} className="flex flex-col p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Bot className="size-4 text-brand" /> {a.label}</p>
              <Badge tone={a.paused ? 'amber' : 'brand'} dot>{a.paused ? 'Paused' : 'Active'}</Badge>
            </div>
            <p className="mt-1.5 text-[12.5px] text-muted">{a.purpose}</p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11.5px] text-muted">
              <span><b className="block text-[16px] text-ink tabular">{a.last30Days.completed}</b>done</span>
              <span><b className={cx('block text-[16px] tabular', a.last30Days.failed ? 'text-rose' : 'text-ink')}>{a.last30Days.failed}</b>failed</span>
              <span><b className={cx('block text-[16px] tabular', a.last30Days.needsApproval ? 'text-[#b45309]' : 'text-ink')}>{a.last30Days.needsApproval + a.last30Days.pending}</b>waiting</span>
            </div>
            <details className="mt-3 text-[12px]">
              <summary className="cursor-pointer font-semibold text-body">What it does today</summary>
              <ul className="mt-1 list-disc pl-4 text-body">{a.implemented.map((x) => <li key={x}>{x}</li>)}</ul>
              {a.notYetBuilt.length > 0 && (
                <>
                  <p className="mt-2 font-semibold text-muted">Not built yet</p>
                  <ul className="list-disc pl-4 text-muted">{a.notYetBuilt.map((x) => <li key={x}>{x}</li>)}</ul>
                </>
              )}
            </details>
            <div className="mt-auto flex gap-2 pt-3">
              <Button className="h-8 flex-1" disabled={!a.kinds.some((k) => k.userRunnable)} onClick={() => setRunning(a)}><Zap className="size-4" /> Run task</Button>
              <Button className="h-8" aria-label={`${a.paused ? 'Resume' : 'Pause'} ${a.label}`} onClick={() => togglePause(a)}>
                {a.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-5 mb-3 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Agent Centre section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'tasks', label: 'Tasks' },
            { value: 'approvals', label: `Approvals${pendingApprovals ? ` (${pendingApprovals})` : ''}` },
            { value: 'people', label: `Team tasks${work?.length ? ` (${work.length})` : ''}` },
            { value: 'integrations', label: 'Integrations' },
          ]}
        />
        {tab === 'tasks' && (
          <div className="flex gap-2">
            <select aria-label="Filter by agent" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className={`${inputCls} w-40`}>
              <option value="">All agents</option>
              {Object.entries(AGENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${inputCls} w-44`}>
              <option value="">All statuses</option>
              {Object.entries(TASK_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
        )}
      </div>

      {tab === 'tasks' && (
        <div className={cx('grid grid-cols-1 gap-4', selected && 'xl:grid-cols-[1fr_480px]')}>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="border-b border-line text-left text-[12px] text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Task</th>
                  <th className="px-3 py-3 font-medium">Agent</th>
                  <th className="px-3 py-3 font-medium">Trigger</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {!tasks && <tr><td colSpan={5} className="p-5"><Skeleton className="h-20" /></td></tr>}
                {tasks?.map((t) => {
                  const st = TASK_STATUS[t.status] ?? { label: t.status, tone: 'slate' as const };
                  const label = agents?.flatMap((a) => a.kinds).find((k) => k.kind === t.kind)?.label ?? t.kind;
                  return (
                    <tr key={t.id} onClick={() => select(t.id)} className={cx('cursor-pointer border-t border-line hover:bg-slate-50', t.id === selected && 'bg-brand-soft/40')}>
                      <td className="px-5 py-2.5">
                        <p className="font-semibold text-ink">{label}</p>
                        <p className="text-[11.5px] text-muted">{t.depth > 0 ? `handoff · ` : ''}{t.entityType ? `${t.entityType} ${t.entityId?.slice(-6)}` : t.kind}</p>
                      </td>
                      <td className="px-3">{AGENT_LABEL[t.agent]}</td>
                      <td className="px-3 text-muted">{t.trigger}</td>
                      <td className="px-3"><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="px-5 text-right text-muted">{timeAgo(t.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {tasks && tasks.length === 0 && (
              <Empty icon={<Bot className="size-6" />} title="No agent tasks yet">
                Tasks appear when an order is confirmed, cancelled or dispatched, when one agent hands work to another, or when you run one.
              </Empty>
            )}
          </Card>
          {selected && <TaskDetail id={selected} onOpen={select} onClose={() => select(null)} onChanged={reloadAll} notify={setNotice} />}
        </div>
      )}

      {tab === 'approvals' && (approvals ? <ApprovalList items={approvals} onChanged={reloadAll} notify={setNotice} /> : <Skeleton className="h-40" />)}
      {tab === 'people' && (work ? <WorkTaskList items={work} onChanged={reloadAll} notify={setNotice} /> : <Skeleton className="h-40" />)}
      {tab === 'integrations' && (
        <Card>
          <ul>
            {integrations?.map((i) => (
              <li key={i.name} className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 first:border-t-0">
                <span>
                  <span className="block text-[13.5px] font-semibold text-ink">{i.name}</span>
                  <span className="text-[12px] text-muted">{i.note}</span>
                </span>
                <Badge tone={i.status === 'configured' ? 'brand' : i.status === 'blocked' ? 'rose' : i.status === 'unknown' || i.status === 'not_built' ? 'amber' : 'slate'}>
                  {i.status === 'configured' ? 'Configured' : i.status === 'blocked' ? 'Blocked (permission)' : i.status === 'not_configured' ? 'Not configured' : i.status === 'unknown' ? 'Not checked' : i.status === 'not_built' ? 'Permission granted, not built' : 'Not connected'}
                </Badge>
              </li>
            ))}
          </ul>
          {agents?.find((a) => a.name === 'marketing') && <p className="border-t border-line px-5 py-3 text-[12px] text-muted">AI usage: {agents.find((a) => a.name === 'marketing')!.aiCost.note}</p>}
        </Card>
      )}

      <Dialog open={running !== null} onClose={closeRun} title={running ? `Run a ${running.label} task` : ''}>
        {running && (
          <RunTask
            agent={running}
            onDone={async (t) => {
              setRunning(null);
              await reloadAll();
              select(t.id);
            }}
            notify={setNotice}
          />
        )}
      </Dialog>
    </>
  );
}

function TaskDetail({ id, onOpen, onClose, onChanged, notify }: { id: string; onOpen: (id: string) => void; onClose: () => void; onChanged: () => Promise<void>; notify: (n: { tone: 'ok' | 'error'; text: string }) => void }) {
  const { data: t, error, reload } = useApi<AgentTask>(`/agents/tasks/${id}`, 5_000);
  const [busy, setBusy] = useState<string | null>(null);
  async function act(kind: 'retry' | 'cancel') {
    setBusy(kind);
    try {
      const r = await api.post<AgentTask>(`/agents/tasks/${id}/${kind}`);
      notify({ tone: r.status === 'FAILED' ? 'error' : 'ok', text: kind === 'retry' ? `Retried: ${TASK_STATUS[r.status]?.label ?? r.status}` : 'Task cancelled.' });
      await Promise.all([reload(), onChanged()]);
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  if (error && !t) return <ErrorBanner message={error} onRetry={reload} />;
  if (!t) return <Skeleton className="h-96" />;
  const st = TASK_STATUS[t.status] ?? { label: t.status, tone: 'slate' as const };
  const link = recordLink(t.entityType, t.entityId);
  return (
    <Card className="self-start">
      <CardHeader
        title={<span className="flex items-center gap-2">{t.kind} <Badge tone={st.tone}>{st.label}</Badge></span>}
        subtitle={`${AGENT_LABEL[t.agent]} agent · ${t.trigger} · attempt ${t.attempts}/${t.maxAttempts} · id ${t.id.slice(-8)}`}
        action={<button onClick={onClose} className="text-[12.5px] font-semibold text-muted hover:text-ink">Close</button>}
      />
      <div className="flex flex-col gap-3 px-5 pb-5 text-[13px]">
        {link && <Link href={link} className="font-semibold text-brand-dark hover:underline">Open the {t.entityType}</Link>}
        {t.parent && <p className="text-muted">Handed over by <button className="font-semibold text-ink hover:underline" onClick={() => onOpen(t.parent!.id)}>{AGENT_LABEL[t.parent.agent]}: {t.parent.kind}</button></p>}
        {t.error && <p className="rounded-[10px] bg-rose-soft px-3 py-2 text-rose">{t.error}</p>}
        {t.status === 'NEEDS_APPROVAL' && <p className="rounded-[10px] bg-amber-soft px-3 py-2 text-[#92400e]">Waiting for approval - see the Approvals tab.</p>}
        {t.result && (
          <details open>
            <summary className="cursor-pointer font-semibold text-ink">Result</summary>
            <pre className="mt-1 max-h-60 overflow-auto rounded-[10px] bg-slate-50 p-3 text-[11.5px] whitespace-pre-wrap text-body">{JSON.stringify(t.result, null, 2)}</pre>
          </details>
        )}
        {!!t.children?.length && (
          <div>
            <p className="font-semibold text-ink">Handed over to</p>
            {t.children.map((c) => (
              <button key={c.id} onClick={() => onOpen(c.id)} className="block text-left text-muted hover:underline">{AGENT_LABEL[c.agent]}: {c.kind} - {TASK_STATUS[c.status]?.label ?? c.status}</button>
            ))}
          </div>
        )}
        <div>
          <p className="mb-1 font-semibold text-ink">Execution history</p>
          <ol className="flex flex-col gap-1">
            {t.events?.map((e) => (
              <li key={e.id} className="flex gap-2 text-[12.5px]">
                <span className="shrink-0 text-faint tabular">{dateTime(e.createdAt)}</span>
                <span className={cx('font-semibold', e.type === 'failed' || e.type === 'tool_denied' ? 'text-rose' : 'text-ink')}>{e.type.replace(/_/g, ' ')}</span>
                <span className="text-body">{e.message}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="flex gap-2">
          {t.status === 'FAILED' && <Button variant="primary" busy={busy === 'retry'} onClick={() => act('retry')}><RotateCcw className="size-4" /> Retry</Button>}
          {['PENDING', 'NEEDS_APPROVAL', 'FAILED'].includes(t.status) && <Button variant="danger" busy={busy === 'cancel'} onClick={() => act('cancel')}><Square className="size-4" /> Cancel</Button>}
        </div>
      </div>
    </Card>
  );
}

/** Start a task by hand. The click id makes a double click a single task. */
function RunTask({ agent, onDone, notify }: { agent: AgentSummary; onDone: (t: AgentTask) => void; notify: (n: { tone: 'ok' | 'error'; text: string }) => void }) {
  const kinds = agent.kinds.filter((k) => k.userRunnable);
  const [kind, setKind] = useState(kinds[0]?.kind ?? '');
  const [clientKey] = useState(newClientKey);
  const [orderId, setOrderId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needsOrder = kind === 'operations.reserve_order' || kind === 'operations.fulfilment_check';
  const needsProduct = kind === 'sales.availability_check';
  const { data: orders } = useApi<FulfilmentRow[]>(needsOrder ? '/operations/fulfilment' : null, 0);
  const { data: products } = useApi<StockRow[]>(needsProduct ? '/operations/inventory' : null, 0);
  const def = kinds.find((k) => k.kind === kind);

  async function submit() {
    setBusy(true);
    setErr(null);
    const input = needsOrder ? { orderId } : needsProduct ? { productId, quantity: Number(quantity) } : kind === 'marketing.source_report' ? { days: Number(days) } : {};
    try {
      const r = await api.post<{ task: AgentTask; duplicate: boolean }>('/agents/tasks', { kind, input, clientKey });
      notify({ tone: r.task.status === 'FAILED' ? 'error' : 'ok', text: `${def?.label}: ${TASK_STATUS[r.task.status]?.label ?? r.task.status}${r.task.events?.at(-1) ? ` - ${r.task.events.at(-1)!.message}` : ''}` });
      onDone(r.task);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Label text="Task">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
          {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
      </Label>
      {def && <p className="text-[12.5px] text-muted">{def.description}</p>}
      {needsOrder && (
        <Label text="Order">
          <select value={orderId} onChange={(e) => setOrderId(e.target.value)} className={inputCls}>
            <option value="">Choose an open order…</option>
            {orders?.map((o) => <option key={o.id} value={o.id}>{o.number} · {o.customer?.name ?? ''} · {o.status}</option>)}
          </select>
        </Label>
      )}
      {needsProduct && (
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <Label text="Product">
            <select value={productId} onChange={(e) => setProductId(e.target.value)} className={inputCls}>
              <option value="">Choose…</option>
              {products?.map((p) => <option key={p.productId} value={p.productId}>{p.name} ({p.sku})</option>)}
            </select>
          </Label>
          <Label text="Quantity"><input type="number" min={0} value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputCls} /></Label>
        </div>
      )}
      {kind === 'marketing.source_report' && <Label text="Days"><input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className={inputCls} /></Label>}
      {err && <p className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="flex justify-end">
        <Button variant="primary" busy={busy} disabled={(needsOrder && !orderId) || (needsProduct && (!productId || !Number(quantity)))} onClick={submit}><Zap className="size-4" /> Run</Button>
      </div>
    </div>
  );
}
