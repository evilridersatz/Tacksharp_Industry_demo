'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Button, Card, Skeleton } from '@/components/ui';
import { inputCls } from '@/components/textile';
import { PlatformFrame, when } from '@/components/platform';

type A = { total: number; page: number; pageSize: number; rows: Array<{ id: string; organizationId: string; organizationName: string; actor: string; entityType: string; entityId: string; action: string; createdAt: string }> };

export default function PlatformAudit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const { data, error, reload } = useApi<A>(`/platform/audit?page=${page}${action ? `&action=${encodeURIComponent(action)}` : ''}`, 30_000);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <PlatformFrame title="Audit log" error={error} reload={reload}>
      <Card className="overflow-hidden">
        <form className="flex gap-2 border-b border-line p-3" onSubmit={(e) => { e.preventDefault(); setAction(q.trim()); setPage(1); }}>
          <label htmlFor="audit-q" className="sr-only">Filter by action</label>
          <input id="audit-q" className={inputCls} placeholder="Filter by action, e.g. integration or organization.suspended" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit">Filter</Button>
        </form>
        {!data ? <Skeleton className="m-4 h-64" /> : (
          <div className="overflow-x-auto"><table className="w-full text-[13px]"><thead className="bg-slate-50 text-left text-[12px] text-muted"><tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Organization</th><th className="px-4 py-2">Action</th><th className="px-4 py-2">Actor</th><th className="px-4 py-2">Entity</th></tr></thead>
            <tbody>{data.rows.map((r) => <tr key={r.id} className="border-t border-line"><td className="px-4 py-2 whitespace-nowrap text-muted">{when(r.createdAt)}</td><td className="px-4 py-2">{r.organizationName}</td><td className="px-4 py-2 font-semibold">{r.action}</td><td className="px-4 py-2 text-muted">{r.actor}</td><td className="px-4 py-2 text-muted">{r.entityType}</td></tr>)}
              {!data.rows.length && <tr><td colSpan={5} className="px-4 py-3 text-muted">No events.</td></tr>}</tbody></table></div>
        )}
        {data && <div className="flex items-center justify-end gap-1 border-t border-line px-4 py-2 text-[12.5px] text-muted"><Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>Page {page} of {pages}<Button variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button></div>}
      </Card>
    </PlatformFrame>
  );
}
