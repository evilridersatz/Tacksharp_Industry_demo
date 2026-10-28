'use client';

import { useState } from 'react';
import { ChevronDown, Database, ExternalLink } from 'lucide-react';
import { useApi } from '@/lib/api';
import { API_URL } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { LiveDemoSession } from '@/components/live-demo-session';
import { Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { Pill, Stat } from '@/components/vertical-ui';

type Entity = { key: string; label: string; table: string; api: string; total: number; demo: number | null; byStatus: Array<{ value: string; count: number }>; sample: Array<Record<string, unknown>> };
type Inventory = { industry: string; label: string; name: string; isDemo: boolean; generatedAt: string; entities: Entity[] };

export default function DemoDataPage() {
  const { data, error, reload } = useApi<Inventory>('/industry/data', 0);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Data & APIs" crumb="Setup" />
      <LiveDemoSession />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-96" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Entities in this workspace" value={data.entities.length} hint={data.label} />
            <Stat label="Records" value={data.entities.reduce((a, e) => a + e.total, 0).toLocaleString('en-IN')} />
            <Stat label="Flagged synthetic (demo)" value={data.entities.reduce((a, e) => a + (e.demo ?? 0), 0).toLocaleString('en-IN')} hint="Where the table has an isDemo flag" />
            <Stat label="Workspace" value={data.isDemo ? 'Demo' : 'Live'} hint={data.name} />
          </div>
          <Card className="mb-4 p-4 text-[12.5px] text-body">
            <p className="flex items-center gap-2 font-semibold text-ink"><Database className="size-4" aria-hidden /> How to read this page</p>
            <p className="mt-1">Every row is a database table filtered to this workspace only, with its record count, a status breakdown, the first three records, and the API endpoint the dashboard uses to read it. Open the API link while signed in to see the live JSON.</p>
          </Card>
          <ul className="flex flex-col gap-2.5">
            {data.entities.map((e) => {
              const isOpen = open === e.key;
              const href = e.api.includes(':') || e.api.startsWith('/(') ? null : `${API_URL}${e.api}`;
              return (
                <li key={e.key}>
                  <Card className="overflow-hidden">
                    <button type="button" onClick={() => setOpen(isOpen ? null : e.key)} aria-expanded={isOpen} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-slate-50">
                      <span className="min-w-[180px] flex-1">
                        <span className="block text-[13.5px] font-semibold text-ink">{e.label}</span>
                        <span className="block text-[11.5px] text-muted">table <code>{e.table}</code> · API <code>{e.api}</code></span>
                      </span>
                      <span className="text-[18px] font-bold text-ink tabular">{e.total.toLocaleString('en-IN')}</span>
                      {e.demo !== null && <Pill tone="amber">{e.demo} demo</Pill>}
                      <ChevronDown className={cx('size-4 text-muted transition', isOpen && 'rotate-180')} aria-hidden />
                    </button>
                    {isOpen && (
                      <div className="border-t border-line px-4 py-3">
                        {e.byStatus.length > 0 && (
                          <div className="mb-3 flex flex-wrap gap-1.5">{e.byStatus.map((b) => <Pill key={b.value} status={b.value}>{b.value.replace(/_/g, ' ')} · {b.count}</Pill>)}</div>
                        )}
                        {e.sample.length ? (
                          <div className="overflow-x-auto">
                            <table className="w-full text-[12px]">
                              <thead><tr className="text-left text-muted">{Object.keys(e.sample[0]).map((k) => <th key={k} className="px-2 py-1 font-semibold">{k}</th>)}</tr></thead>
                              <tbody>{e.sample.map((r, i) => <tr key={i} className="border-t border-line">{Object.values(r).map((v, j) => <td key={j} className="max-w-[260px] truncate px-2 py-1 font-mono text-[11.5px] text-body">{v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>)}</tr>)}</tbody>
                            </table>
                          </div>
                        ) : <p className="text-[12.5px] text-muted">No records.</p>}
                        {href && <a href={href} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold" style={{ color: 'var(--industry-accent)' }}>Open {e.api} <ExternalLink className="size-3.5" /></a>}
                      </div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11.5px] text-faint">Generated {new Date(data.generatedAt).toLocaleString('en-IN')} from GET /industry/data. Synthetic demo records are created only by the explicit seed command (never at startup).</p>
        </>
      )}
    </>
  );
}
