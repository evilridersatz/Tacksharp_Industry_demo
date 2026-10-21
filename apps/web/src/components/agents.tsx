'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import type { Approval, WorkTask } from '@/lib/types';
import { AGENT_LABEL, APPROVAL_ACTION, APPROVAL_STATUS, WORK_STATUS, dateTime, inr, recordLink, timeAgo } from '@/lib/format';
import { Badge, Button, Card, Empty } from './ui';
import { errorText, inputCls } from './textile';

type Notify = (n: { tone: 'ok' | 'error'; text: string }) => void;

function payloadSummary(a: Approval) {
  const p = a.payload as Record<string, unknown>;
  if (a.action === 'quotation.discount') return `${p.number}: discount ${inr(p.discount as number)} on ${inr(p.subtotal as number)} (${p.discountPct}%) → total ${inr(p.total as number)}`;
  if (a.action === 'inventory.adjust') return `${Number(p.delta) > 0 ? '+' : ''}${p.delta} - ${p.reason}`;
  if (a.action === 'agent.task') return `${p.kind}: ${p.proposed}`;
  if (a.action === 'payment.reverse') return `Reverse verified payment of ${inr(p.amount as number)} - ${p.reason} (record correction only; no money is moved)`;
  return JSON.stringify(p).slice(0, 200);
}

const who = (s: string | null) => (!s ? '—' : s.startsWith('user:') ? 'Team member' : s.startsWith('agent:') ? `${AGENT_LABEL[s.slice(6)] ?? s.slice(6)} agent` : s);

/** The approval queue: each request shows what exactly will happen, who asked, why, and what permission it needs. */
export function ApprovalList({ items, onChanged, notify }: { items: Approval[]; onChanged: () => Promise<void>; notify: Notify }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(a: Approval, d: 'approve' | 'reject') {
    setBusy(`${a.id}:${d}`);
    try {
      const r = await api.post<Approval>(`/agents/approvals/${a.id}/${d}`, { note: notes[a.id] ?? '' });
      notify({ tone: r.status === 'failed' ? 'error' : 'ok', text: r.status === 'failed' ? `Approved, but carrying it out failed: ${(r.executionResult as { error?: string })?.error ?? 'unknown error'}` : d === 'approve' ? 'Approved and carried out.' : 'Rejected.' });
      await onChanged();
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  if (!items.length) return <Card><Empty title="No approval requests">Exceptional discounts, stock corrections and agent actions that bind the business wait here.</Empty></Card>;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {items.map((a) => {
        const st = APPROVAL_STATUS[a.status] ?? { label: a.status, tone: 'slate' as const };
        const link = recordLink(a.entityType, a.entityId);
        return (
          <Card key={a.id} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[14px] font-semibold text-ink">{APPROVAL_ACTION[a.action] ?? a.action}</p>
                <p className="text-[12px] text-muted">
                  by {who(a.requestedBy)} · {timeAgo(a.createdAt)} · needs <code className="text-[11.5px]">{a.requiredPermission}</code>
                </p>
              </div>
              <Badge tone={st.tone}>{st.label}</Badge>
            </div>
            <p className="mt-2 text-[13px] text-ink">{a.reason}</p>
            <p className="mt-1 rounded-[10px] bg-slate-50 px-3 py-2 text-[12.5px] text-body">{payloadSummary(a)}</p>
            {link && <Link href={link} className="mt-1 inline-block text-[12.5px] font-semibold text-brand-dark hover:underline">Open record</Link>}
            {a.status === 'pending' ? (
              <div className="mt-3 flex flex-col gap-2">
                <input aria-label="Decision note" value={notes[a.id] ?? ''} onChange={(e) => setNotes((x) => ({ ...x, [a.id]: e.target.value }))} placeholder="Note (required to reject)" className={inputCls} />
                <div className="flex gap-2">
                  <Button variant="primary" busy={busy === `${a.id}:approve`} onClick={() => decide(a, 'approve')}><CheckCircle2 className="size-4" /> Approve</Button>
                  <Button variant="danger" busy={busy === `${a.id}:reject`} onClick={() => decide(a, 'reject')}><XCircle className="size-4" /> Reject</Button>
                </div>
                {a.expiresAt && <p className="text-[11.5px] text-faint">Expires {dateTime(a.expiresAt)}</p>}
              </div>
            ) : (
              <p className="mt-2 text-[12px] text-muted">
                {a.decidedAt ? `${st.label} ${dateTime(a.decidedAt)} by ${who(a.decidedBy)}` : ''}
                {a.decisionNote ? ` - "${a.decisionNote}"` : ''}
                {a.status === 'failed' && a.executionResult ? ` - ${(a.executionResult as { error?: string }).error ?? ''}` : ''}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/** Jobs for people raised by agents (shortage exceptions, procurement, sales reviews). */
export function WorkTaskList({ items, onChanged, notify }: { items: WorkTask[]; onChanged: () => Promise<void>; notify: Notify }) {
  const [res, setRes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  async function move(t: WorkTask, status: string) {
    setBusy(`${t.id}:${status}`);
    try {
      await api.patch(`/agents/work-tasks/${t.id}`, { status, ...(res[t.id] ? { resolution: res[t.id] } : {}) });
      notify({ tone: 'ok', text: `"${t.title}" → ${WORK_STATUS[status]?.label ?? status}` });
      await onChanged();
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  if (!items.length) return <Card><Empty title="Nothing waiting for your team">Shortages, procurement needs and sales reviews raised by the agents appear here.</Empty></Card>;
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((t) => {
        const st = WORK_STATUS[t.status] ?? { label: t.status, tone: 'slate' as const };
        const link = recordLink(t.entityType, t.entityId);
        const active = t.status === 'open' || t.status === 'in_progress';
        return (
          <Card key={t.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-ink">{t.title}</p>
                <p className="text-[12px] text-muted">
                  {AGENT_LABEL[t.agent]} · {t.kind} · {timeAgo(t.createdAt)}
                  {link && <> · <Link href={link} className="font-semibold text-brand-dark hover:underline">record</Link></>}
                </p>
              </div>
              <span className="flex gap-1.5">
                {t.priority === 'high' && <Badge tone="rose">High</Badge>}
                <Badge tone={st.tone}>{st.label}</Badge>
              </span>
            </div>
            {t.detail && <p className="mt-2 whitespace-pre-line text-[12.5px] text-body">{t.detail}</p>}
            {t.resolution && <p className="mt-2 text-[12.5px] text-muted">Decision: {t.resolution}</p>}
            {active && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input aria-label={`Decision for ${t.title}`} value={res[t.id] ?? ''} onChange={(e) => setRes((x) => ({ ...x, [t.id]: e.target.value }))} placeholder={t.kind === 'exception' ? 'Decision (required to close)' : 'Note (optional)'} className={`${inputCls} max-w-md flex-1`} />
                {t.status === 'open' && <Button className="h-8" busy={busy === `${t.id}:in_progress`} onClick={() => move(t, 'in_progress')}>Start</Button>}
                <Button variant="primary" className="h-8" busy={busy === `${t.id}:done`} onClick={() => move(t, 'done')}>Done</Button>
                <Button variant="ghost" className="h-8" busy={busy === `${t.id}:cancelled`} onClick={() => move(t, 'cancelled')}>Cancel</Button>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
