'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Check, Clock, Gift, IndianRupee, MessageSquare, Phone, PhoneCall, Store, X } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { dateTime, displayName, formatPhone } from '@/lib/format';
import { ACTION_LABEL, CHANNEL_LABEL, FOLLOWUP_KIND, FOLLOWUP_STATUS, ORDER_STATUS, READY_NOTICE, SOURCE_LABEL, actorLabel, inr, paymentLabel, pickupLabel, qty, type FollowUpRow, type Order, type OrderStatus } from '@/lib/restaurant';
import { Badge, Button, Card, ErrorBanner, Field, Skeleton } from '@/components/ui';

/** One pickup order: what to cut, when they come, payment, offer, ready call and the audit trail. */
export function OrderPanel({ orderId, onClose, onChanged, canEdit }: { orderId: string; onClose?: () => void; onChanged?: () => void; canEdit: boolean }) {
  const { data: order, error, reload } = useApi<Order>(`/restaurant/orders/${orderId}`, 6_000);
  const { data: followUps } = useApi<FollowUpRow[]>(`/restaurant/followups?orderId=${orderId}`, 6_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await reload();
      onChanged?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  const change = (body: { status?: OrderStatus; paymentStatus?: 'paid' | 'unpaid' }) => {
    if (body.status === 'cancelled' && !window.confirm('Cancel this order? The customer is not told automatically; their ₹50 offer becomes usable again.')) return;
    return run(body.status ?? body.paymentStatus ?? 'x', () => api.patch(`/restaurant/orders/${orderId}`, body));
  };

  if (error && !order) return <ErrorBanner message={error} onRetry={reload} />;
  if (!order) return <Skeleton className="h-[480px] rounded-[14px]" />;
  const st = ORDER_STATUS[order.status];
  const notice = order.readyNotice ? READY_NOTICE[order.readyNotice] : null;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <p className="text-[12px] text-muted">
            Placed {dateTime(order.createdAt)} · {CHANNEL_LABEL[order.channel] ?? order.channel}
          </p>
          <h2 className="mt-0.5 text-[20px] font-bold text-ink">{order.orderNumber}</h2>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone={st.tone} dot>
              {st.label}
            </Badge>
            {notice && <Badge tone={notice.tone}>{notice.label}</Badge>}
            {order.offer && <Badge tone="violet">₹{order.offer.amount} offer</Badge>}
            {order.isDemo && <Badge tone="amber">Demo order</Badge>}
          </div>
        </div>
        {onClose && (
          <button onClick={onClose} aria-label="Close order" className="text-muted hover:text-ink">
            <X className="size-5" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 bg-sky-soft px-5 py-2.5 text-[13.5px] font-semibold text-[#075985]">
        <Clock className="size-4" /> Collect: {pickupLabel(order.pickupAt)} · {order.outlet.name}
      </div>

      {canEdit && (order.allowedNext.length > 0 || order.paymentStatus !== 'paid') && order.status !== 'cancelled' && (
        <div className="flex flex-wrap gap-2 border-b border-line bg-slate-50/60 px-5 py-3">
          {order.allowedNext
            .filter((s) => s !== 'cancelled')
            .map((s, i) => (
              <Button key={s} variant={i === 0 ? 'primary' : 'secondary'} busy={busy === s} onClick={() => change({ status: s })}>
                <Check className="size-4" /> {ACTION_LABEL[s]}
              </Button>
            ))}
          {order.paymentStatus !== 'paid' && (
            <Button variant="secondary" busy={busy === 'paid'} onClick={() => change({ paymentStatus: 'paid' })}>
              <IndianRupee className="size-4" /> {order.paymentStatus === 'customer_says_paid' ? 'Verified paid' : 'Mark paid'}
            </Button>
          )}
          {order.status === 'ready' && (
            <Button variant="secondary" busy={busy === 'call'} onClick={() => run('call', () => api.post(`/restaurant/orders/${orderId}/notify-ready`))}>
              <PhoneCall className="size-4" /> Call again
            </Button>
          )}
          {order.allowedNext.includes('cancelled') && (
            <Button variant="danger" busy={busy === 'cancelled'} onClick={() => change({ status: 'cancelled' })}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {actionError && (
        <div className="px-5 pt-3">
          <ErrorBanner message={actionError} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 px-5 py-4 md:grid-cols-2">
        <section>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">To cut & pack</h3>
          <ul className="divide-y divide-line rounded-[10px] border border-line">
            {order.items.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
                <span>
                  <b className="text-[14px] text-ink">{qty(i.quantity, i.unit)}</b> {i.name}
                  {i.cut && <span className="ml-1.5 rounded-md bg-amber-soft px-1.5 py-0.5 text-[12px] font-semibold text-[#92400e]">{i.cut}</span>}
                  <span className="block text-[11.5px] text-faint">
                    @ {inr(i.unitPrice)}/{i.unit === 'piece' ? 'pc' : 'kg'}
                  </span>
                </span>
                <span className="tabular font-semibold text-ink">{inr(i.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 px-1 text-[13px]">
            <Field label="Subtotal">{inr(order.subtotal)}</Field>
            {order.discount > 0 && <Field label="Offer">−{inr(order.discount)}</Field>}
            <Field label="To collect">
              <span className="text-[15px]">{inr(order.total)}</span>
            </Field>
            <Field label="Payment">{paymentLabel(order)}</Field>
            <Field label="POS">{order.posStatus === 'not_integrated' ? 'Not sent (no POS integration)' : order.posStatus}</Field>
          </div>
        </section>

        <section className="flex flex-col gap-4 text-[13px]">
          <div>
            <h3 className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">Customer</h3>
            <p className="font-semibold text-ink">{displayName({ name: order.customerName, phone: order.customerPhone })}</p>
            {order.customerPhone && (
              <a href={`tel:+${order.customerPhone}`} className="mt-0.5 inline-flex items-center gap-1.5 text-brand">
                <Phone className="size-3.5" /> {formatPhone(order.customerPhone)}
              </a>
            )}
            <div className="mt-1.5 flex gap-3">
              <Link href={`/customers?id=${order.customerId}`} className="text-[12.5px] font-semibold text-muted hover:text-ink">
                History →
              </Link>
              {order.conversationId && (
                <Link href={`/conversations?id=${order.conversationId}`} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-muted hover:text-ink">
                  <MessageSquare className="size-3.5" /> Chat
                </Link>
              )}
            </div>
          </div>
          <div>
            <h3 className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">Pickup</h3>
            <p className="flex items-start gap-1.5 text-ink">
              <Store className="mt-0.5 size-3.5 shrink-0 text-muted" /> {order.outlet.name}
            </p>
          </div>
          {order.offer && (
            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">Offer</h3>
              <p className="flex items-center gap-1.5 text-ink">
                <Gift className="size-3.5 text-violet" /> ₹{order.offer.amount} off · {SOURCE_LABEL[order.offer.source] ?? order.offer.source}
                {order.offer.websiteOrderRef && <span className="text-muted">(website order {order.offer.websiteOrderRef})</span>}
              </p>
              {order.offer.source === 'whatsapp_link' && <p className="mt-0.5 text-[12px] text-muted">Started from the WhatsApp link — not linked to a website order.</p>}
            </div>
          )}
          {order.readyNotice && (
            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">Ready call</h3>
              {notice && <Badge tone={notice.tone}>{notice.label}</Badge>}
              {order.readyNoticeNote && <p className="mt-1 text-[12.5px] text-body">{order.readyNoticeNote}</p>}
            </div>
          )}
        </section>
      </div>

      {(order.feedbackRating !== null || order.complaintStatus || (followUps && followUps.length > 0)) && (
        <section className="border-t border-line px-5 py-4 text-[13px]">
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Feedback & follow-ups</h3>
          {order.collectedAt && <p className="text-muted">Collected {dateTime(order.collectedAt)}{order.nextFollowUpAt ? ` · next follow-up ${dateTime(order.nextFollowUpAt)}` : ''}</p>}
          {order.feedbackRating !== null && (
            <p className="mt-1 text-ink">
              Rating <b>{order.feedbackRating}/5</b> {order.feedbackChannel === 'voice' ? 'on the call' : 'on WhatsApp'}
              {order.feedbackComment ? ` — “${order.feedbackComment}”` : ''}
            </p>
          )}
          {order.complaintStatus && (
            <p className="mt-1">
              <Badge tone={order.complaintStatus === 'open' ? 'rose' : 'brand'}>{order.complaintStatus === 'open' ? 'Complaint open — call the customer' : 'Complaint resolved'}</Badge>
              {order.complaintNote && <span className="ml-2 text-body">“{order.complaintNote}”</span>}
            </p>
          )}
          {followUps && followUps.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {followUps.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-[8px] bg-slate-50 px-3 py-1.5">
                  <span className="font-semibold text-ink">{FOLLOWUP_KIND[f.kind] ?? f.kind}</span>
                  <Badge tone={FOLLOWUP_STATUS[f.status]?.tone ?? 'slate'}>{FOLLOWUP_STATUS[f.status]?.label ?? f.status}</Badge>
                  {f.dryRun && <Badge tone="violet">Simulated</Badge>}
                  <span className="text-[12px] text-muted">{dateTime(['scheduled', 'retrying'].includes(f.status) ? f.scheduledAt : f.completedAt ?? f.updatedAt)}</span>
                  {f.lastError && <span className="w-full text-[11.5px] text-muted">{f.lastError}</span>}
                </li>
              ))}
            </ul>
          )}
          <Link href="/follow-ups" className="mt-2 inline-block text-[12.5px] font-semibold text-brand">
            All follow-ups →
          </Link>
        </section>
      )}

      <section className="border-t border-line px-5 py-4">
        <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">History</h3>
        <ol className="flex flex-col gap-2.5">
          {order.events.map((e) => (
            <li key={e.id} className="flex gap-3 text-[12.5px]">
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" />
              <div>
                <p className="text-ink">
                  <b>
                    {e.type === 'created'
                      ? 'Order placed'
                      : e.type === 'status_changed'
                        ? `${ORDER_STATUS[e.fromStatus as OrderStatus]?.label ?? e.fromStatus} → ${ORDER_STATUS[e.toStatus as OrderStatus]?.label ?? e.toStatus}`
                        : e.type === 'payment_changed'
                          ? 'Payment updated'
                          : e.type === 'ready_notice'
                            ? 'Customer notified'
                            : e.type}
                  </b>{' '}
                  <span className="text-muted">by {actorLabel(e.actor)}</span>
                </p>
                {e.note && <p className="text-muted">{e.note}</p>}
                <p className="text-faint">{dateTime(e.createdAt)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </Card>
  );
}
