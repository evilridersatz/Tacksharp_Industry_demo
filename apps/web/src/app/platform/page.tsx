'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Badge, Button, Card, Empty, Skeleton } from '@/components/ui';
import { OrgStatus, PlatformFrame, when } from '@/components/platform';
import { inputCls } from '@/components/textile';

type Overview = { organizations: Record<string, number>; pendingRegistrations: number; activeUsers: number; providerEvents24h: { total: number; failed: number }; health: { database: { ok: boolean }; redis: { ok: boolean } } };
type Org = { id: string; name: string; status: string; selfServe: boolean; isDemo: boolean; industry: string; industryLabel: string; users: number; customers: number; createdAt: string };
type Page = { total: number; page: number; pageSize: number; rows: Org[] };

export default function PlatformOrganizations() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data: ov, error: ovErr, reload } = useApi<Overview>('/platform/overview', 30_000);
  const qs = new URLSearchParams({ page: String(page), ...(search ? { search } : {}), ...(status ? { status } : {}) });
  const { data, error } = useApi<Page>(`/platform/organizations?${qs}`, 30_000);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <PlatformFrame title="Organizations" error={ovErr ?? error} reload={reload}>
      {!ov ? <Skeleton className="h-24" /> : (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            ['Active', ov.organizations.active ?? 0],
            ['Pending review', ov.pendingRegistrations],
            ['Suspended', ov.organizations.suspended ?? 0],
            ['Active users', ov.activeUsers],
            ['Provider requests (24 h)', `${ov.providerEvents24h.total} · ${ov.providerEvents24h.failed} failed`],
          ].map(([k, v]) => (
            <Card key={k as string} className="p-4"><p className="text-[12px] text-muted">{k}</p><p className="mt-1 text-[20px] font-bold text-ink">{v}</p></Card>
          ))}
        </div>
      )}
      <Card className="overflow-hidden">
        <form className="flex flex-wrap gap-2 border-b border-line p-3" role="search" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); setPage(1); }}>
          <label htmlFor="org-q" className="sr-only">Search organizations</label>
          <span className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" /><input id="org-q" className={`${inputCls} pl-9`} placeholder="Name, id or a user's email" value={q} onChange={(e) => setQ(e.target.value)} /></span>
          <label htmlFor="org-status" className="sr-only">Status</label>
          <select id="org-status" className={`${inputCls} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option><option value="pending_review">Pending review</option><option value="active">Active</option><option value="suspended">Suspended</option>
          </select>
          <Button type="submit">Search</Button>
        </form>
        {!data ? <Skeleton className="m-4 h-64" /> : data.rows.length === 0 ? <Empty title="No organizations match">Try another search or status.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-slate-50 text-left text-[12px] font-semibold text-muted"><tr><th className="px-4 py-2">Organization</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Industry</th><th className="px-4 py-2 text-right">Users</th><th className="px-4 py-2 text-right">Customers</th><th className="px-4 py-2">Created</th></tr></thead>
              <tbody>
                {data.rows.map((o) => (
                  <tr key={o.id} className="border-t border-line">
                    <td className="px-4 py-2.5"><Link href={`/platform/organizations/${encodeURIComponent(o.id)}`} className="font-semibold text-ink hover:text-brand hover:underline">{o.name}</Link><p className="text-[11.5px] text-muted">{o.id}{o.isDemo ? ' · demo' : ''}{o.selfServe ? ' · self-service' : ''}</p></td>
                    <td className="px-4 py-2.5"><OrgStatus status={o.status} /></td>
                    <td className="px-4 py-2.5"><Badge tone="slate">{o.industryLabel}</Badge></td>
                    <td className="px-4 py-2.5 text-right tabular">{o.users}</td>
                    <td className="px-4 py-2.5 text-right tabular">{o.customers}</td>
                    <td className="px-4 py-2.5 text-muted">{when(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12.5px] text-muted">
            <span>{data.total} organization(s)</span>
            <span className="flex items-center gap-1">
              <Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
              Page {page} of {pages}
              <Button variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
            </span>
          </div>
        )}
      </Card>
    </PlatformFrame>
  );
}
