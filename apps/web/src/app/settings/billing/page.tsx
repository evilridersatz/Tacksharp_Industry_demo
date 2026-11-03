'use client';

import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Card, CardHeader, ErrorBanner, Field, Skeleton } from '@/components/ui';
import { InvoiceTable, StatusBadge, UsageBars, day, inr, type Summary } from '@/components/billing';

/** The workspace's own plan, what it uses against the plan's limits, and Tacksharp's invoices (read-only). */
export default function PlanAndBilling() {
  const { data: b, error, reload } = useApi<Summary>('/billing', 60_000);
  const s = b?.subscription;
  return (
    <>
      <PageHeader title="Plan & billing" crumb="Setup" />
      {error ? <ErrorBanner message={error} onRetry={reload} /> : !b ? <Skeleton className="h-96" /> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <Card>
            <CardHeader title={s ? `${s.planName} plan` : 'No plan assigned'} subtitle={s ? `${s.billingCycle} billing${s.contractName ? ` · ${s.contractName}` : ''}` : undefined} action={s && <StatusBadge status={s.status} />} />
            <div className="px-5 pb-4">
              {s && (
                <div className="mb-4 border-b border-line pb-3">
                  <Field label="Current period">{day(s.currentPeriodStart)} – {day(s.currentPeriodEnd)}</Field>
                  <Field label="Price per period">{inr(s.price)} + {s.taxRatePct}% GST</Field>
                  {s.status === 'trial' && <Field label="Trial ends">{day(s.trialEndsAt)}</Field>}
                  <Field label="Renewal">{s.status === 'cancelled' ? 'Cancelled' : s.autoRenew ? 'Renews automatically' : 'Ends with this period'}</Field>
                </div>
              )}
              <UsageBars limits={b.limits} usage={b.usage} />
              {s?.status === 'past_due' && <p role="alert" className="mt-4 rounded-[10px] bg-rose-50 px-3 py-2 text-[13px] text-rose-800">An invoice is past its due date. Please pay it with the invoice number as reference.</p>}
              {s?.status === 'cancelled' && <p role="alert" className="mt-4 rounded-[10px] bg-slate-50 px-3 py-2 text-[13px] text-body">This subscription is cancelled. Everything you have stays, but nothing new can be added. Contact Tacksharp to renew.</p>}
              <p className="mt-4 text-[12.5px] text-muted">{b.note}</p>
            </div>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader title="Invoices from Tacksharp" />
            <InvoiceTable invoices={b.invoices} viewHref={(i) => `/settings/billing/invoices/${i.id}`} />
          </Card>
        </div>
      )}
    </>
  );
}
