'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, Empty, ErrorBanner, Segmented, Skeleton } from '@/components/ui';
import { toast } from '@/components/toast';
import { RoleChip, StatusPill, ago, errorText, inputCls } from '@/components/office';

type Approval = {
  id: string; status: string; reason: string; createdAt: string; expiresAt: string | null; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; requestedBy: string;
  payload: { taskId: string; tool: string; args: Record<string, unknown> };
  executionResult: unknown;
  task: { id: string; title: string; role: string; planId: string | null } | null;
  customer: { name: string; phone: string | null } | null;
};

const TOOL_LABEL: Record<string, string> = { send_whatsapp: 'Send a WhatsApp message', create_work_task: 'Create a staff job', assign_conversation: 'Assign a conversation', update_lead_stage: 'Change a CRM stage', draft_whatsapp: 'Save a message draft', propose_memory: 'Propose a memory fact' };

export default function OfficeApprovalsPage() {
  const [show, setShow] = useState<'pending' | 'all'>('pending');
  const { data, error, reload } = useApi<{ items: Approval[] }>(`/office/approvals${show === 'pending' ? '?status=pending' : ''}`, 8_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const decide = async (a: Approval, decision: 'approve' | 'reject') => {
    if (decision === 'reject' && !notes[a.id]?.trim()) { toast('Write why you reject it (the agent reads this).', 'error'); return; }
    setBusy(`${a.id}:${decision}`);
    try {
      const r = await api.post<{ status: string; executionResult?: { error?: string } }>(`/office/approvals/${a.id}/${decision}`, { note: notes[a.id] });
      if (decision === 'approve') toast(r.status === 'executed' ? 'Approved and done.' : `Approved, but it did not go through: ${r.executionResult?.error ?? r.status}`, r.status === 'executed' ? 'ok' : 'error');
      else toast('Rejected. The agent continues without it.');
      reload();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };
  return (
    <>
      <PageHeader title="Approvals" crumb="AI Office" actions={<Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'pending', label: 'Waiting' }, { value: 'all', label: 'History' }]} />} />
      <p className="mb-4 text-[12.5px] text-muted">An approval runs exactly what is shown here, once, as you. Anything else the agent wants needs a new approval. Requests expire after 48 hours.</p>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-64" /> : data.items.length === 0 ? <Card><Empty title={show === 'pending' ? 'Nothing waiting for you' : 'No approvals yet'}>When an agent wants to do something that needs a person (like messaging a customer), it appears here.</Empty></Card> : (
        <ul className="flex flex-col gap-3">
          {data.items.map((a) => {
            const args = a.payload?.args ?? {};
            return (
              <li key={a.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-ink">{TOOL_LABEL[a.payload?.tool] ?? a.payload?.tool}{a.customer ? ` to ${a.customer.name}${a.customer.phone ? ` (${a.customer.phone})` : ''}` : ''}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">{a.task && <RoleChip role={a.task.role} />}{a.task && <Link href={`/office/tasks?task=${a.task.id}`} className="underline">{a.task.title}</Link>}<span>· asked {ago(a.createdAt)}</span>{a.expiresAt && a.status === 'pending' && <span>· expires {new Date(a.expiresAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>}</p>
                    </div>
                    <StatusPill status={a.status} />
                  </div>
                  {typeof args.text === 'string' ? (
                    <blockquote className="mt-3 whitespace-pre-wrap rounded-[12px] border-l-4 border-emerald-500 bg-emerald-50/60 px-3 py-2 text-[14px] text-ink">{args.text}</blockquote>
                  ) : (
                    <pre className="mt-3 overflow-auto rounded-lg bg-slate-50 p-2 text-[12px] text-body">{JSON.stringify(args, null, 2)}</pre>
                  )}
                  {a.status === 'pending' ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <label htmlFor={`note-${a.id}`} className="sr-only">Note</label>
                      <input id={`note-${a.id}`} value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} placeholder="Note (required to reject)" className={`${inputCls} min-w-[200px] flex-1`} />
                      <Button variant="primary" onClick={() => void decide(a, 'approve')} busy={busy === `${a.id}:approve`}><Check className="size-4" aria-hidden /> Approve</Button>
                      <Button onClick={() => void decide(a, 'reject')} busy={busy === `${a.id}:reject`}><X className="size-4" aria-hidden /> Reject</Button>
                    </div>
                  ) : (
                    <p className="mt-2 text-[12px] text-muted">{a.decidedAt ? `Decided ${ago(a.decidedAt)}` : ''}{a.decisionNote ? ` · “${a.decisionNote}”` : ''}{a.executionResult && typeof a.executionResult === 'object' && 'error' in (a.executionResult as object) ? ` · ${(a.executionResult as { error: string }).error}` : ''}</p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
