'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { LiveStamp } from '@/components/live-stamp';
import { ErrorBanner, Skeleton, cx } from '@/components/ui';
import { ROLE_LABEL, RoleChip, StatusPill, TaskPanel, ago, inputCls, type TaskRow } from '@/components/office';

const COLUMNS: Array<{ key: string; title: string; statuses: string[]; tone: string }> = [
  { key: 'needs', title: 'Needs you', statuses: ['waiting_approval', 'needs_review', 'dead_letter', 'failed'], tone: 'border-amber-300' },
  { key: 'todo', title: 'To do', statuses: ['blocked', 'queued', 'paused'], tone: 'border-slate-200' },
  { key: 'doing', title: 'In progress', statuses: ['running', 'verifying', 'waiting_tool'], tone: 'border-violet-300' },
  { key: 'done', title: 'Done', statuses: ['completed', 'cancelled'], tone: 'border-emerald-300' },
];

export default function TaskBoardPage() {
  return (
    <>
      <PageHeader title="Task board" crumb="AI Office" />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Board />
      </Suspense>
    </>
  );
}

function Board() {
  const params = useSearchParams();
  const router = useRouter();
  const [role, setRole] = useState('');
  const { data, error, reload, updatedAt } = useApi<{ items: TaskRow[] }>(`/office/tasks${role ? `?role=${role}` : ''}`, 8_000);
  const selected = params.get('task');
  const open = (id: string | null) => router.replace(id ? `/office/tasks?task=${id}` : '/office/tasks', { scroll: false });
  return (
    <>
      <LiveStamp at={updatedAt} every="updates as agents work" />
      {selected && <TaskPanel taskId={selected} onClose={() => open(null)} onChanged={reload} />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor="role" className="text-[12.5px] font-semibold text-muted">Agent</label>
        <select id="role" value={role} onChange={(e) => setRole(e.target.value)} className={cx(inputCls, 'max-w-56')}>
          <option value="">All agents</option>
          {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="text-[12px] text-muted">The latest 200 tasks. Every status change is made by the engine, never by an agent.</span>
      </div>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-80" /> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const items = data.items.filter((t) => col.statuses.includes(t.status));
            return (
              <section key={col.key} aria-label={col.title} className={cx('rounded-[var(--radius-card)] border-t-4 bg-slate-50 p-2', col.tone)}>
                <h2 className="flex items-center justify-between px-1 py-1 text-[12.5px] font-semibold text-ink">{col.title}<span className="text-muted">{items.length}</span></h2>
                <ul className="flex flex-col gap-2">
                  {items.slice(0, 50).map((t) => (
                    <li key={t.id}>
                      <button type="button" onClick={() => open(t.id)} className={cx('w-full rounded-[12px] border border-line bg-white p-2.5 text-left hover:border-slate-300', selected === t.id && 'ring-2 ring-slate-300')}>
                        <span className="line-clamp-2 text-[13px] font-semibold text-ink">{t.title}</span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5"><RoleChip role={t.role} /><StatusPill status={t.status} /></span>
                        <span className="mt-1 block text-[11px] text-muted">{t.depth > 0 ? 'Delegated · ' : ''}{t.attempts} attempt(s) · {ago(t.updatedAt)}</span>
                      </button>
                    </li>
                  ))}
                  {!items.length && <li className="px-1 pb-2 text-[12px] text-muted">Nothing here.</li>}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
