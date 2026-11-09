'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { CheckCircle2, CircleDashed, RotateCcw, ShieldCheck, X, XCircle } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { Button, Card, CardHeader, Skeleton, cx } from '@/components/ui';
import { Pill } from '@/components/vertical-ui';
import { toast } from '@/components/toast';

// ---------------------------------------------------------------------------------------------- types
export type Role = 'ceo' | 'operations' | 'sales' | 'support' | 'reporting' | 'qa' | 'finance' | 'marketing' | 'hr' | 'research';
export type TaskStatus = 'blocked' | 'queued' | 'running' | 'waiting_tool' | 'waiting_approval' | 'verifying' | 'needs_review' | 'completed' | 'failed' | 'paused' | 'cancelled' | 'dead_letter';
export type OfficeSettings = {
  mode: 'manual' | 'supervised' | 'autonomous';
  paused: boolean;
  model: string;
  budgets: { maxUsd: number; maxTokens: number; maxSteps: number; maxToolCalls: number; deadlineMinutes: number };
  maxUsdPerDay: number;
  concurrency: number;
  hopCap: number;
  maxDepth: number;
  webAllowlist: string[];
  inrPerUsd: number;
  retentionDays: { messages: number; executions: number; audit: number };
};
export type PlanTask = { id: string; key: string; role: Role; title: string; status: TaskStatus; depth: number; parentTaskId: string | null; attempts: number; error: string | null; result: { summary?: string; outcome?: Record<string, unknown> } | null; verification: { ok: boolean; how: string; detail: string } | null; dependsOn: string[]; updatedAt: string };
export type PlanView = {
  id: string; instruction: string; summary: string | null; status: string; mode: string; source: string; createdAt: string; startedAt: string | null; finishedAt: string | null;
  plan: { summary: string; tasks: Array<{ key: string; role: Role; title: string; instructions: string; dependsOn: string[] }> };
  estimate: { usd: number; inr: number | null; tokensIn: number; tokensOut: number; tasks: number; model: string };
  costUsd: number; tokensIn: number; tokensOut: number; steps: number; toolCalls: number; report: string | null; inrPerUsd: number;
  tasks: PlanTask[];
};
export type PlanRow = { id: string; instruction: string; summary: string | null; status: string; mode: string; source: string; costUsd: number; estimate: { usd: number }; createdAt: string; finishedAt: string | null; _count: { tasks: number } };
export type TaskRow = { id: string; planId: string | null; key: string; role: Role; title: string; status: TaskStatus; priority: number; attempts: number; depth: number; parentTaskId: string | null; error: string | null; createdAt: string; updatedAt: string; verifiedAt: string | null };

// ---------------------------------------------------------------------------------------------- helpers
export const ROLE_LABEL: Record<string, string> = { ceo: 'CEO', operations: 'Operations', sales: 'Sales', support: 'Customer Support', reporting: 'Reporting', qa: 'Quality Assurance', finance: 'Finance', marketing: 'Marketing', hr: 'HR', research: 'Research' };
/** One colour per role (avatar, chips). Light enough for text on white; never the only signal (always with a label). */
export const ROLE_COLOR: Record<string, string> = { ceo: '#7c3aed', operations: '#0369a1', sales: '#047857', support: '#b45309', reporting: '#4338ca', qa: '#be123c', finance: '#0f766e', marketing: '#c2410c', hr: '#6d28d9', research: '#475569' };

const TASK_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'violet' | 'slate' | 'cyan'> = {
  blocked: 'slate', queued: 'blue', running: 'violet', waiting_tool: 'cyan', waiting_approval: 'amber', verifying: 'cyan', needs_review: 'amber',
  completed: 'green', failed: 'red', paused: 'slate', cancelled: 'slate', dead_letter: 'red', draft: 'blue', idle: 'slate', working: 'violet', waiting: 'amber', off: 'slate', error: 'red',
  healthy: 'green', steering: 'amber', constrained: 'amber', stopped: 'red', pending: 'amber', started: 'blue', skipped: 'slate', approved: 'green', executed: 'green', rejected: 'red', expired: 'slate',
};
const STATUS_TEXT: Record<string, string> = { waiting_tool: 'waiting for a colleague', waiting_approval: 'waiting for approval', needs_review: 'needs your review', dead_letter: 'failed — needs a person', blocked: 'waiting for earlier tasks' };
export function StatusPill({ status }: { status: string }) {
  return <Pill tone={TASK_TONE[status] ?? 'slate'}>{STATUS_TEXT[status] ?? status.replace(/_/g, ' ')}</Pill>;
}

export const usd = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v < 0.01 && v > 0 ? `US$${v.toFixed(4)}` : `US$${v.toFixed(2)}`);
export const withInr = (v: number, inrPerUsd: number) => (inrPerUsd > 0 ? `${usd(v)} (≈ ₹${(v * inrPerUsd).toFixed(2)})` : usd(v));
export const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
export const errorText = (e: unknown) => {
  const b = (e as { body?: { problems?: string[] } })?.body;
  return [e instanceof Error ? e.message : String(e), ...(b?.problems?.length ? [b.problems.join('; ')] : [])].join(' — ');
};

export const inputCls = 'h-9 w-full rounded-[10px] border border-line bg-white px-3 text-[13.5px] text-ink outline-none focus:border-slate-400';

/** A small drawn employee (SVG) for the office floor: the role's colour, a status ring, nothing copied. */
export function AgentFigure({ role, status, size = 44 }: { role: string; status: string; size?: number }) {
  const c = ROLE_COLOR[role] ?? '#475569';
  const ring = status === 'working' ? '#7c3aed' : status === 'waiting' ? '#d97706' : status === 'paused' || status === 'off' ? '#94a3b8' : status === 'error' ? '#e11d48' : '#10b981';
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden className={cx(status === 'working' && 'motion-safe:animate-pulse')}>
      <circle cx="22" cy="22" r="20.5" fill="white" stroke={ring} strokeWidth="2.5" strokeDasharray={status === 'paused' || status === 'off' ? '4 3' : undefined} />
      <circle cx="22" cy="17" r="6.5" fill={c} opacity="0.9" />
      <path d="M10.5 35c1.6-6.4 6-9.6 11.5-9.6S31.9 28.6 33.5 35" fill={c} opacity="0.75" />
      {role === 'ceo' && <path d="M17 9.5l2.2 2 2.8-3.2 2.8 3.2 2.2-2-.8 4H17.8z" fill="#f59e0b" />}
    </svg>
  );
}

export function RoleChip({ role }: { role: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-semibold text-body">
      <span className="size-2 rounded-full" style={{ background: ROLE_COLOR[role] ?? '#475569' }} aria-hidden />
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

/** A plan's tasks in order, with status, verification and links to the task detail. */
export function PlanTaskList({ tasks, onOpen }: { tasks: PlanTask[]; onOpen?: (id: string) => void }) {
  return (
    <ol className="divide-y divide-line border-t border-line">
      {tasks.map((t) => (
        <li key={t.id} className={cx('flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5', t.depth > 0 && 'bg-slate-50/60 pl-9')}>
          <span className="mt-0.5">{t.status === 'completed' ? <CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> : ['dead_letter', 'failed'].includes(t.status) ? <XCircle className="size-4 text-rose-600" aria-hidden /> : <CircleDashed className="size-4 text-muted" aria-hidden />}</span>
          <div className="min-w-[200px] flex-1">
            <button type="button" onClick={() => onOpen?.(t.id)} className="text-left text-[13.5px] font-semibold text-ink hover:underline">{t.title}</button>
            <div className="mt-0.5 flex flex-wrap items-center gap-2"><RoleChip role={t.role} />{t.dependsOn.length > 0 && <span className="text-[11.5px] text-muted">after {t.dependsOn.join(', ')}</span>}</div>
            {t.result?.summary && <p className="mt-1 text-[12.5px] text-body">{t.result.summary}</p>}
            {t.verification && <p className={cx('mt-0.5 text-[11.5px]', t.verification.ok ? 'text-emerald-700' : 'text-amber-800')}>{t.verification.ok ? '✓ ' : '⚠ '}{t.verification.detail}</p>}
            {t.error && !['completed'].includes(t.status) && <p className="mt-0.5 text-[11.5px] text-rose-700">{t.error}</p>}
          </div>
          <StatusPill status={t.status} />
        </li>
      ))}
    </ol>
  );
}

type TaskDetail = PlanTask & {
  instructions: string; planId: string | null; context: unknown; executions: Array<{ id: string; attempt: number; status: string; model: string | null; steps: number; toolCalls: number; tokensIn: number; tokensOut: number; costUsd: number; error: string | null; startedAt: string }>;
  toolCalls: Array<{ id: string; tool: string; status: string; args: unknown; result: unknown; ms: number; createdAt: string }>;
  messages: Array<{ id: string; fromRole: string; toRole: string; act: string; body: string; createdAt: string }>;
  approvals: Array<{ id: string; status: string; decidedBy: string | null; decisionNote: string | null; createdAt: string }>;
  usage: { usd: number; tokensIn: number; tokensOut: number };
  children: Array<{ id: string; role: string; title: string; status: string }>;
};

const Json = ({ v }: { v: unknown }) => <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-2 text-[11.5px] text-body">{JSON.stringify(v, null, 2)}</pre>;

/** Task detail: what it was asked, every attempt, tool call, message and approval, and the controls a person has. */
export function TaskPanel({ taskId, onClose, onChanged }: { taskId: string; onClose: () => void; onChanged?: () => void }) {
  const { data, reload } = useApi<TaskDetail>(`/office/tasks/${taskId}`, 8_000);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (decision: 'accept' | 'retry' | 'cancel') => {
    const note = decision === 'accept' ? undefined : window.prompt(decision === 'retry' ? 'What should the agent do differently? (optional)' : 'Why cancel? (optional)') ?? undefined;
    setBusy(decision);
    try { await api.post(`/office/tasks/${taskId}/${decision}`, { note }); toast(decision === 'accept' ? 'Accepted.' : decision === 'retry' ? 'Sent back to the agent.' : 'Task cancelled.'); reload(); onChanged?.(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };
  return (
    <Card className="mb-4 overflow-hidden" aria-label="Task detail">
      <CardHeader
        title={data ? data.title : 'Task'}
        subtitle={data ? <span className="flex flex-wrap items-center gap-2"><RoleChip role={data.role} /><StatusPill status={data.status} /><span>{data.attempts} attempt(s) · {usd(data.usage.usd)}</span></span> : undefined}
        action={<button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-slate-100 hover:text-ink" aria-label="Close"><X className="size-4" /></button>}
      />
      {!data ? <Skeleton className="m-4 h-40" /> : (
        <div className="grid gap-4 px-5 pb-5 text-[13px] lg:grid-cols-2">
          <div>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Asked</h3>
            <p className="mt-1 whitespace-pre-wrap text-body">{data.instructions}</p>
            {data.result?.summary && (<><h3 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-muted">Agent’s answer</h3><p className="mt-1 text-body">{data.result.summary}</p>{data.result.outcome && Object.keys(data.result.outcome).length > 0 && <Json v={data.result.outcome} />}</>)}
            {data.verification && (<><h3 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-muted">Verification ({data.verification.how})</h3><p className={cx('mt-1', data.verification.ok ? 'text-emerald-700' : 'text-amber-800')}>{data.verification.detail}</p></>)}
            {data.error && <p className="mt-3 rounded-lg bg-rose-50 p-2 text-[12.5px] text-rose-800">{data.error}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {data.status === 'needs_review' && <Button variant="primary" onClick={() => void act('accept')} busy={busy === 'accept'}><CheckCircle2 className="size-4" aria-hidden /> Accept</Button>}
              {['needs_review', 'failed', 'dead_letter'].includes(data.status) && <Button onClick={() => void act('retry')} busy={busy === 'retry'}><RotateCcw className="size-4" aria-hidden /> Send back</Button>}
              {!['completed', 'cancelled', 'dead_letter'].includes(data.status) && <Button onClick={() => void act('cancel')} busy={busy === 'cancel'}>Cancel task</Button>}
              {data.status === 'waiting_approval' && <Button href="/office/approvals"><ShieldCheck className="size-4" aria-hidden /> Review approval</Button>}
              {data.planId && <Link href={`/office/command?plan=${data.planId}`} className="self-center text-[12.5px] font-semibold underline">Open the plan</Link>}
            </div>
          </div>
          <div className="min-w-0">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Tool calls ({data.toolCalls.length})</h3>
            <ul className="mt-1 flex flex-col gap-1.5">
              {data.toolCalls.map((c) => (
                <li key={c.id}>
                  <details className="rounded-lg border border-line px-2.5 py-1.5">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[12.5px]"><code className="font-semibold text-ink">{c.tool}</code><StatusPill status={c.status === 'ok' ? 'completed' : c.status === 'approval_required' ? 'waiting_approval' : c.status === 'rejected' ? 'rejected' : c.status === 'unknown' ? 'needs_review' : 'failed'} /><span className="text-muted">{c.ms} ms</span></summary>
                    <Json v={{ args: c.args, result: c.result }} />
                  </details>
                </li>
              ))}
              {!data.toolCalls.length && <li className="text-muted">None.</li>}
            </ul>
            {data.messages.length > 0 && (<><h3 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-muted">Messages</h3><ul className="mt-1 flex flex-col gap-1">{data.messages.map((m) => <li key={m.id} className="text-[12.5px]"><b>{ROLE_LABEL[m.fromRole] ?? m.fromRole}</b> → {ROLE_LABEL[m.toRole] ?? m.toRole} <span className="text-muted">({m.act})</span>: {m.body}</li>)}</ul></>)}
            {data.children.length > 0 && (<><h3 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-muted">Delegated</h3><ul className="mt-1">{data.children.map((c) => <li key={c.id} className="flex items-center gap-2 text-[12.5px]"><RoleChip role={c.role} />{c.title}<StatusPill status={c.status} /></li>)}</ul></>)}
            <h3 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-muted">Attempts</h3>
            <ul className="mt-1 text-[12.5px] text-body">{data.executions.map((e) => <li key={e.id}>#{e.attempt} {e.status} · {e.model} · {e.steps} model calls · {e.toolCalls} tools · {(e.tokensIn + e.tokensOut).toLocaleString('en-IN')} tokens · {usd(e.costUsd)}{e.error ? ` · ${e.error}` : ''}</li>)}{!data.executions.length && <li className="text-muted">Not started yet.</li>}</ul>
          </div>
        </div>
      )}
    </Card>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="mb-4 rounded-[12px] border border-line bg-white px-4 py-3 text-[12.5px] text-body">{children}</p>;
}
