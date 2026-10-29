'use client';

import { useApi } from '@/lib/api';
import { Card, Skeleton } from '@/components/ui';
import { PlatformFrame } from '@/components/platform';

type U = { days: number; note: string; rows: Array<{ organizationId: string; organizationName: string; provider: string; source: string | null; events: number; failed: number; units: number; costEstimate: number | null }> };

export default function PlatformUsage() {
  const { data: u, error, reload } = useApi<U>('/platform/usage', 60_000);
  return (
    <PlatformFrame title="Usage and cost" error={error} reload={reload}>
      {!u ? <Skeleton className="h-80" /> : (
        <Card className="overflow-hidden">
          <p className="px-4 py-3 text-[12.5px] text-muted">Last {u.days} days. {u.note}</p>
          <div className="overflow-x-auto"><table className="w-full text-[13px]"><thead className="bg-slate-50 text-left text-[12px] text-muted"><tr><th className="px-4 py-2">Organization</th><th className="px-4 py-2">Provider</th><th className="px-4 py-2">Account</th><th className="px-4 py-2 text-right">Requests</th><th className="px-4 py-2 text-right">Failed</th><th className="px-4 py-2 text-right">Units</th><th className="px-4 py-2 text-right">Est. cost</th></tr></thead>
            <tbody>{u.rows.map((r, i) => <tr key={i} className="border-t border-line"><td className="px-4 py-2">{r.organizationName}</td><td className="px-4 py-2">{r.provider}</td><td className="px-4 py-2">{r.source === 'organization' ? 'own' : r.source === 'environment' ? 'platform' : '—'}</td><td className="px-4 py-2 text-right tabular">{r.events}</td><td className="px-4 py-2 text-right tabular">{r.failed}</td><td className="px-4 py-2 text-right tabular">{r.units}</td><td className="px-4 py-2 text-right tabular">{r.costEstimate === null ? '—' : r.costEstimate.toFixed(2)}</td></tr>)}
              {!u.rows.length && <tr><td colSpan={7} className="px-4 py-3 text-muted">Nothing recorded yet.</td></tr>}</tbody></table></div>
        </Card>
      )}
    </PlatformFrame>
  );
}
