'use client';

import { Megaphone } from 'lucide-react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Card, CardHeader, ErrorBanner, Skeleton } from '@/components/ui';
import type { RCustomer } from '@/lib/restaurant';

type Integrations = {
  campaigns: { sendingEnabled: boolean; templateConfigured: boolean; note: string };
  channels: { whatsapp: { connected: boolean } };
};

/**
 * Campaigns are intentionally read-only: there is no sending until WhatsApp is connected, an
 * approved marketing template exists and customer opt-in is recorded.
 */
export default function CampaignsPage() {
  const { data: d, error, reload } = useApi<Integrations>('/restaurant/integrations', 0);
  const { data: customers } = useApi<RCustomer[]>('/restaurant/customers', 0);
  const optedOut = customers?.filter((c) => c.doNotContact).length ?? 0;
  const checks = d
    ? [
        { label: 'WhatsApp Business connected', ok: d.channels.whatsapp.connected },
        { label: 'Approved marketing template', ok: d.campaigns.templateConfigured },
        { label: 'Customer opt-in captured', ok: false },
      ]
    : [];

  return (
    <>
      <PageHeader title="Campaigns" />
      {error && !d && <ErrorBanner message={error} onRetry={reload} />}
      {!d ? (
        <Skeleton className="h-[300px] rounded-[14px]" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Card>
            <CardHeader title="Campaign sending" action={<Badge tone="slate">Disabled</Badge>} />
            <div className="px-5 pb-5 text-[13px]">
              <div className="flex items-start gap-3 rounded-[12px] bg-slate-50 p-4">
                <Megaphone className="mt-0.5 size-5 shrink-0 text-muted" />
                <p className="text-body">{d.campaigns.note} No campaign messages have been sent from this account.</p>
              </div>
              <h3 className="mt-4 mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Before sending can be enabled</h3>
              <ul className="flex flex-col gap-2">
                {checks.map((c) => (
                  <li key={c.label} className="flex items-center justify-between rounded-[10px] border border-line px-3 py-2">
                    <span className="text-ink">{c.label}</span>
                    <Badge tone={c.ok ? 'brand' : 'rose'}>{c.ok ? 'Done' : 'Missing'}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
          <Card>
            <CardHeader title="Audience" subtitle="From real customer records" />
            <div className="px-5 pb-5 text-[13px]">
              <p>
                <b className="tabular text-[22px] text-ink">{customers?.length ?? '—'}</b> <span className="text-muted">customers</span>
              </p>
              <p className="mt-1 text-muted">{optedOut} have opted out of promotional messages.</p>
              <p className="mt-3 text-[12px] text-muted">Message history will appear here once campaigns are enabled.</p>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
