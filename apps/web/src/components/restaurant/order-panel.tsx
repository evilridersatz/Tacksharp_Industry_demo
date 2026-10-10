'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Bike, Check, IndianRupee, MapPin, MessageSquare, Phone, Store, X } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { dateTime, displayName, formatPhone } from '@/lib/format';
import { ACTION_LABEL, CHANNEL_LABEL, ORDER_STATUS, actorLabel, inr, paymentLabel, type Order, type OrderStatus } from '@/lib/restaurant';
import { Badge, Button, Card, ErrorBanner, Field, Skeleton } from '@/components/ui';

/** One order: items, customer, outlet, payment, staff actions and the audit trail. */
export function OrderPanel({ orderId, onClose, onChanged, canEdit }: { orderId: string; onClose?: () => void; onChanged?: () => void; canEdit: boolean }) {
  const { data: order, error, reload } = useApi<Order>(`/restaurant/orders/${orderId}`, 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function change(body: { status?: OrderStatus; paymentStatus?: 'paid' | 'unpaid' }) {
    if (body.status === 'cancelled' && !window.confirm('Cancel this order? The customer is not notified automatically.')) return;
    setBusy(body.status ?? body.paymentStatus ?? 'x');
    setActionError(null);
    try {
      await api.patch(`/restaurant/orders/${orderId}`, body);
      await reload();
      onChanged?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (error && !order) return <ErrorBanner message={error} onRetry={reload} />;
  if (!order) return <Skeleton className="h-[480px] rounded-[14px]" />;
  const st = ORDER_STATUS[order.status];

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <p className="text-[12px] text-muted">
            {dateTime(order.createdAt)} · {CHANNEL_LABEL[order.channel] ?? order.channel}
          </p>
          <h2 className="mt-0.5 text-[20px] font-bold text-ink">{order.orderNumber}</h2>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone={st.tone} dot>
              {st.label}
            </Badge>
            <Badge tone={order.fulfilment === 'delivery' ? 'violet' : 'sky'}>{order.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}</Badge>
            {order.isDemo && <Badge tone="amber">Demo order</Badge>}
          </div>
        </div>
        {onClose && (
          <button onClick={onClose} aria-label="Close order" className="text-muted hover:text-ink">
            <X className="size-5" />
          </button>
        )}
      </div>

      {canEdit && (order.allowedNext.length > 0 || order.paymentStatus === 'unpaid') && (
        <div className="flex flex-wrap gap-2 border-b border-line bg-slate-50/60 px-5 py-3">
          {order.allowedNext
            .filter((s) => s !== 'cancelled')
            .map((s) => (
              <Button key={s} variant="primary" busy={busy === s} onClick={() => change({ status: s })}>
                <Check className="size-4" /> {ACTION_LABEL[s]}
              </Button>
            ))}
          {order.paymentStatus === 'unpaid' && order.status !== 'cancelled' && (
            <Button variant="secondary" busy={busy === 'paid'} onClick={() => change({ paymentStatus: 'paid' })}>
              <IndianRupee className="size-4" /> Mark paid
            </Button>
          )}
          {order.allowedNext.includes('cancelled') && (
            <Button variant="danger" busy={busy === 'cancelled'} onClick={() => change({ status: 'cancelled' })}>
              Cancel order
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
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Items</h3>
          <ul className="divide-y divide-line rounded-[10px] border border-line">
            {order.items.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                <span>
                  <b className="text-ink">{i.quantity} ×</b> {i.name}
                  <span className="text-faint"> @ {inr(i.unitPrice)}</span>
                </span>
                <span className="tabular font-semibold text-ink">{inr(i.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 px-1 text-[13px]">
            <Field label="Subtotal">{inr(order.subtotal)}</Field>
            {order.fulfilment === 'delivery' && <Field label="Delivery fee">{inr(order.deliveryFee)}</Field>}
            <Field label="Total">
              <span className="text-[15px]">{inr(order.total)}</span>
            </Field>
            <Field label="Payment">{paymentLabel(order)}</Field>
            <Field label="POS">{order.posStatus === 'not_integrated' ? 'Not sent (no POS integration)' : order.posStatus}</Field>
          </div>
        </section>

        <section className="flex flex-col gap-3 text-[13px]">
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
                Customer history →
              </Link>
              {order.conversationId && (
                <Link href={`/conversations?id=${order.conversationId}`} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-muted hover:text-ink">
                  <MessageSquare className="size-3.5" /> Chat
                </Link>
              )}
            </div>
          </div>
          <div>
            <h3 className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">{order.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}</h3>
            <p className="flex items-start gap-1.5 text-ink">
              <Store className="mt-0.5 size-3.5 shrink-0 text-muted" /> {order.outlet.name}
            </p>
            {order.fulfilment === 'delivery' && (
              <p className="mt-1 flex items-start gap-1.5 text-ink">
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted" /> {order.deliveryAddress}
                {order.deliveryArea ? ` (${order.deliveryArea})` : ''}
              </p>
            )}
            {order.status === 'out_for_delivery' && (
              <p className="mt-1 flex items-center gap-1.5 text-violet">
                <Bike className="size-3.5" /> On the way
              </p>
            )}
          </div>
        </section>
      </div>

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
