'use client';

import { useState, type ReactNode } from 'react';
import { AlertTriangle, FileText, Info, Package, Phone, ShoppingBag, Star, Users } from 'lucide-react';
import { useApi } from '@/lib/api';
import type { TextileOverview } from '@/lib/types';
import { inr, minutesSeconds } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Button, Card, CardHeader, ErrorBanner, IconTile, Segmented, Skeleton, type Tone } from '@/components/ui';
import { TextileOnly } from '@/components/textile';

export default function TextileOverviewPage() {
  return (
    <>
      <PageHeader title="Sales overview" crumb="Textile sales / Overview" />
      <TextileOnly>
        <Overview />
      </TextileOnly>
    </>
  );
}

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

function Metric({ icon, tone, label, value, sub, definition, href }: { icon: ReactNode; tone: Tone; label: string; value: ReactNode; sub?: ReactNode; definition?: string; href?: string }) {
  const body = (
    <Card className="flex h-full items-start gap-3 p-4">
      <IconTile tone={tone}>{icon}</IconTile>
      <div className="min-w-0">
        <p className="flex items-center gap-1 text-[12.5px] text-muted">
          {label}
          {definition && (
            <span title={definition} aria-label={definition} className="cursor-help text-faint">
              <Info className="size-3.5" />
            </span>
          )}
        </p>
        <p className="text-[22px] leading-tight font-bold text-ink tabular">{value}</p>
        {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
      </div>
    </Card>
  );
  return href ? <a href={href} className="block">{body}</a> : body;
}

function Overview() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const { data: o, error, reload } = useApi<TextileOverview>(`/textile/overview?days=${days}`, 30_000);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">Every number below comes from your own records. Hover the ⓘ for how it is counted.</p>
        <Segmented
          label="Period"
          value={days}
          onChange={setDays}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
      </div>
      {error && !o && <ErrorBanner message={error} onRetry={reload} />}
      {!o && !error && <Skeleton className="h-64" />}
      {o && (
        <div className="flex flex-col gap-4">
          {!o.meta.spendAvailable && (
            <div role="note" className="flex items-start gap-3 rounded-[12px] border border-amber-soft bg-white px-4 py-3 text-[13px] text-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber" />
              <span>
                <b>Meta ad spend: not connected.</b> {o.meta.reason} Cost per lead in reports uses your Settings estimate ({inr(o.meta.costPerLeadEstimateInr)}).
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={<Users className="size-4" />} tone="sky" label="New leads" value={o.leads.total} sub={`${o.tasks.openHandoffs} waiting for your team`} href="/leads" />
            <Metric icon={<FileText className="size-4" />} tone="amber" label="Quotations sent" value={o.quotations.sent} sub={`${o.quotations.accepted} accepted · ${pct(o.quotations.acceptRatePct)}`} href="/quotations" />
            <Metric
              icon={<ShoppingBag className="size-4" />}
              tone="brand"
              label="Recorded order value"
              value={inr(o.orders.recordedRevenue)}
              sub={`${o.orders.confirmed} confirmed · ${inr(o.orders.paidRevenue)} marked paid`}
              definition={`${o.definitions.recordedRevenue} ${o.definitions.paidRevenue}`}
              href="/orders"
            />
            <Metric icon={<Star className="size-4" />} tone="violet" label="Average rating" value={o.feedback.avgRating ?? '—'} sub={`${o.feedback.received} of ${o.feedback.requested} replied · ${o.feedback.needsAction} need action`} href="/feedback" />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Conversion" subtitle={`Last ${o.days} days`} />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 pb-5 text-[13px]">
                <Def label="Lead → order" value={pct(o.orders.leadToOrderPct)} definition={o.definitions.leadToOrderPct} />
                <Def label="Quote → order" value={pct(o.orders.quoteToOrderPct)} definition={o.definitions.quoteToOrderPct} />
                <Def label="Orders pending confirmation" value={o.orders.pendingConfirmation} />
                <Def label="Orders cancelled" value={o.orders.cancelled} />
                <Def label="Active catalogue products" value={o.catalogue.activeProducts} />
                <Def label="Qualified enquiries" value={o.sales.qualifiedEnquiries} />
                <Def label="Quotations created" value={o.sales.quotationsCreated} />
                <Def label="Quotes awaiting the customer" value={o.sales.quotationsAwaitingResponse} />
              </dl>
            </Card>
            <Card>
              <CardHeader title="AI voice calls" subtitle="Outbound calls placed by the AI" />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 pb-5 text-[13px]">
                <Def label="Attempted" value={o.calls.attempted} />
                <Def label="Answered" value={o.calls.answered} definition={o.definitions.answerRatePct} />
                <Def label="Not answered" value={o.calls.notAnswered} />
                <Def label="Answer rate" value={pct(o.calls.answerRatePct)} definition={o.definitions.answerRatePct} />
                <Def label="Avg. answered call" value={o.calls.avgDurationSec ? minutesSeconds(o.calls.avgDurationSec) : '—'} />
              </dl>
              <div className="px-5 pb-4">
                <Button href="/calls"><Phone className="size-4" /> Call log</Button>
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Operations" subtitle="Counted stock and fulfilment (now)" action={<Button className="h-8" href="/operations">Open</Button>} />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 pb-5 text-[13px]">
                <Def label="Stock-tracked products" value={o.operations.trackedProducts} />
                <Def label="Low / out of stock" value={`${o.operations.lowStock} / ${o.operations.outOfStock}`} />
                <Def label="Reserved for orders" value={o.operations.reservedUnits} />
                <Def label="Orders awaiting fulfilment" value={o.operations.ordersAwaitingFulfilment} />
                <Def label="Past expected delivery" value={o.operations.delayedOrders} />
                <Def label="Open procurement tasks" value={o.operations.openProcurementTasks} />
              </dl>
            </Card>
            <Card>
              <CardHeader title="AI agents" subtitle={`Last ${o.days} days`} action={<Button className="h-8" href="/agents">Agent Centre</Button>} />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 pb-5 text-[13px]">
                <Def label="Tasks completed" value={o.agents.tasksCompleted} />
                <Def label="Tasks failed" value={o.agents.tasksFailed} />
                <Def label="Waiting for approval" value={o.agents.pendingApprovals} />
                <Def label="Open team tasks" value={o.agents.openTeamTasks} />
                <Def label="AI model calls (agents)" value={o.agents.modelCalls} definition="Marketing drafts made with the AI model. Conversation-assistant usage is in the API logs." />
              </dl>
            </Card>
          </div>

          {o.marketing && (
            <Card>
              <CardHeader title="Campaign-attributed" subtitle={`Replies to delivered campaign messages and what followed (last ${o.days} days)`} action={<Button className="h-8" href="/marketing?tab=performance">Marketing</Button>} />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 pb-5 text-[13px] md:grid-cols-5">
                <Def label="Campaigns sent (live)" value={o.marketing.campaignsSent} definition="Simulated (DRY_RUN) campaigns are not counted." />
                <Def label="Enquiries" value={o.marketing.attributedEnquiries} />
                <Def label="Quotations" value={o.marketing.attributedQuotations} />
                <Def label="Confirmed orders" value={o.marketing.attributedOrders} />
                <Def label="Verified collections" value={inr(o.marketing.attributedVerifiedCollections)} definition="Payments Finance verified on those orders. No ad spend or ROI: Meta ad reporting is not connected." />
              </dl>
            </Card>
          )}

          <Card>
            <CardHeader title="Finance" subtitle={`Invoices and verified collections (last ${o.days} days; balances now)`} action={<Button className="h-8" href="/finance">Open</Button>} />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 pb-5 text-[13px] md:grid-cols-4">
              <Def label="Invoiced" value={inr(o.finance.invoiced)} />
              <Def label="Verified collections" value={inr(o.finance.collectedVerified)} definition="Payments verified by an authorised person with evidence. Unverified claims are excluded. Cash collected, not profit." />
              <Def label="Outstanding" value={inr(o.finance.outstanding)} />
              <Def label="Overdue" value={`${inr(o.finance.overdue)} (${o.finance.overdueInvoices})`} />
              <Def label="Payments awaiting verification" value={o.finance.paymentsAwaitingVerification} />
              <Def label="Reconciliation exceptions" value={o.finance.reconciliationExceptions} />
            </dl>
          </Card>

          {o.catalogue.activeProducts === 0 && (
            <Card className="flex flex-wrap items-center gap-3 p-4">
              <IconTile tone="amber"><Package className="size-4" /></IconTile>
              <p className="flex-1 text-[13px] text-ink">Your catalogue is empty, so the AI can only take requirements and pass them to your team.</p>
              <Button variant="primary" href="/catalogue">Add products</Button>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

function Def({ label, value, definition }: { label: string; value: ReactNode; definition?: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-muted">
        {label}
        {definition && (
          <span title={definition} aria-label={definition} className="cursor-help text-faint">
            <Info className="size-3.5" />
          </span>
        )}
      </dt>
      <dd className="text-[18px] font-bold text-ink tabular">{value}</dd>
    </div>
  );
}
