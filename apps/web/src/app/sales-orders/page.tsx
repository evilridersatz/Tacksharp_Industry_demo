'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ShoppingBag } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Invoice, SalesOrder } from '@/lib/types';
import { FEEDBACK_STATUS, INVOICE_STATUS, ORDER_NEXT, ORDER_STATUS, PAYMENT_STATUS, dateTime, displayName, formatPhone, inr, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, Segmented, Skeleton, cx } from '@/components/ui';
import { AuditTrail, Notice, TextileOnly, errorText } from '@/components/textile';
import { useIndustry } from '@/lib/industry';

type Filter = 'open' | 'all' | 'delivered' | 'cancelled';
const OPEN = ['pending_confirmation', 'confirmed', 'processing', 'ready_to_dispatch', 'dispatched'];
const NOTIFIES = ['confirmed', 'dispatched', 'delivered'];

export default function OrdersPage() {
  return (
    <>
      <PageHeader title="Sales orders" crumb="Sales / Orders" />
      <TextileOnly allow={['textile', 'retail']}>
        <Suspense>
          <Orders />
        </Suspense>
      </TextileOnly>
    </>
  );
}

function Orders() {
  const params = useSearchParams();
  const router = useRouter();
  const { industry } = useIndustry();
  // Opened from a link (quotation, feedback, lead): show every order so the selected one is in the list.
  const [filter, setFilter] = useState<Filter>(params.get('id') ? 'all' : 'open');
  const { data, error, reload } = useApi<SalesOrder[]>('/textile/orders', 15_000);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const selectedId = params.get('id');
  const rows = (data ?? []).filter((o) => (filter === 'all' ? true : filter === 'open' ? OPEN.includes(o.status) : o.status === filter));
  const select = (id: string | null) => router.replace(id ? `/sales-orders?id=${id}` : '/sales-orders');

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-muted">
          {industry === 'retail' ? 'Orders recorded for this store.' : 'Orders are created from accepted quotations.'} Payment status is recorded manually by your team - Tacksharp does not confirm payments.
        </p>
        <Segmented
          label="Order filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: `Open (${(data ?? []).filter((o) => OPEN.includes(o.status)).length})` },
            { value: 'delivered', label: 'Delivered' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <Notice notice={notice} />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      <div className={cx('grid grid-cols-1 gap-4', selectedId && 'xl:grid-cols-[1fr_480px]')}>
        <Card className="overflow-x-auto">
          <table className={cx('w-full text-[13px]', selectedId ? 'min-w-[560px]' : 'min-w-[720px]')}>
            <thead className="border-b border-line text-left text-[12px] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">Order</th>
                <th className="px-3 py-3 font-medium">Customer</th>
                <th className="px-3 py-3 text-right font-medium">Value</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Payment</th>
                <th className="px-5 py-3 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {!data && (
                <tr><td colSpan={6} className="p-5"><Skeleton className="h-24" /></td></tr>
              )}
              {rows.map((o) => {
                const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: 'slate' as const };
                const pay = PAYMENT_STATUS[o.paymentStatus] ?? { label: o.paymentStatus, tone: 'slate' as const };
                return (
                  <tr key={o.id} onClick={() => select(o.id)} className={cx('cursor-pointer border-t border-line hover:bg-slate-50', o.id === selectedId && 'bg-brand-soft/40')}>
                    <td className="px-5 py-2.5">
                      <p className="font-semibold text-ink">{o.number}</p>
                      <p className="text-[12px] text-muted">{o.quotation ? `from ${o.quotation.number}` : 'manual'}</p>
                    </td>
                    <td className="px-3">
                      <p className="font-semibold text-ink">{displayName(o.customer)}</p>
                      <p className="text-[12px] text-muted">{formatPhone(o.customer?.phone)}</p>
                    </td>
                    <td className="px-3 text-right font-semibold text-ink tabular">{inr(o.total)}</td>
                    <td className="px-3"><Badge tone={st.tone}>{st.label}</Badge></td>
                    <td className="px-3"><Badge tone={pay.tone}>{pay.label}</Badge></td>
                    <td className="px-5 text-right text-muted">{timeAgo(o.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data && rows.length === 0 && (
            <Empty icon={<ShoppingBag className="size-6" />} title="No orders here">
              Convert an accepted quotation to create an order.
            </Empty>
          )}
        </Card>
        {selectedId && <OrderDetail id={selectedId} onClose={() => select(null)} onChanged={reload} setNotice={setNotice} />}
      </div>
    </>
  );
}

function OrderDetail({ id, onClose, onChanged, setNotice }: { id: string; onClose: () => void; onChanged: () => Promise<void>; setNotice: (n: { tone: 'ok' | 'error'; text: string }) => void }) {
  const { data: o, error, reload } = useApi<SalesOrder>(`/textile/orders/${id}`, 15_000);
  const { data: invoices } = useApi<Invoice[]>(`/finance/invoices?orderId=${id}`, 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const invoice = invoices?.find((i) => i.status !== 'cancelled');
  const financeOwns = Boolean(invoice && invoice.status !== 'draft');

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      setNotice({ tone: 'ok', text: ok });
      await Promise.all([reload(), onChanged()]);
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  if (error && !o) return <ErrorBanner message={error} onRetry={reload} />;
  if (!o) return <Skeleton className="h-96" />;
  const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: 'slate' as const };
  const fb = o.feedback ? FEEDBACK_STATUS[o.feedback.status] : null;

  return (
    <Card className="self-start">
      <CardHeader
        title={<span className="flex items-center gap-2">{o.number} <Badge tone={st.tone}>{st.label}</Badge></span>}
        subtitle={<Link href={o.leadId ? `/leads/${o.leadId}` : '#'} className="hover:underline">{displayName(o.customer)} · {formatPhone(o.customer?.phone)}</Link>}
        action={<button onClick={onClose} className="text-[12.5px] font-semibold text-muted hover:text-ink">Close</button>}
      />
      <div className="px-5 pb-5">
        <ul className="flex flex-col">
          {o.items.map((i) => (
            <li key={i.id} className="flex justify-between gap-3 border-t border-line py-2 text-[13px] first:border-t-0">
              <span>{i.description} <span className="text-muted">× {Number(i.quantity)} {i.unit} @ {inr(i.unitPrice)}</span></span>
              <span className="font-semibold tabular">{inr(i.lineTotal)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 border-t border-line pt-2">
          <Field label="Order value">{inr(o.total)}</Field>
          {o.quotation && <Field label="Quotation"><Link className="hover:underline" href={`/quotations?id=${o.quotation.id}`}>{o.quotation.number}</Link></Field>}
          {o.expectedDelivery && <Field label="Expected delivery">{dateTime(o.expectedDelivery)}</Field>}
          {o.deliveredAt && <Field label="Delivered">{dateTime(o.deliveredAt)}</Field>}
          {fb && <Field label="Feedback"><Badge tone={fb.tone}>{fb.label}{o.feedback?.rating ? ` · ${o.feedback.rating}/5` : ''}</Badge></Field>}
        </div>

        <h3 className="mt-4 mb-2 text-[13px] font-semibold text-ink">Move order</h3>
        <div className="flex flex-wrap gap-2">
          {(ORDER_NEXT[o.status] ?? []).map((s) => (
            <Button
              key={s}
              variant={s === 'cancelled' ? 'danger' : 'primary'}
              busy={busy === s}
              onClick={() => {
                if (s === 'cancelled' && !window.confirm(`Cancel ${o.number}? This cannot be undone.`)) return;
                void run(s, () => api.post(`/textile/orders/${o.id}/status`, { status: s }), `${o.number}: ${ORDER_STATUS[s]?.label}.${NOTIFIES.includes(s) ? ' The customer gets a WhatsApp update (if enabled in Settings).' : ''}${s === 'delivered' ? ' A feedback request is scheduled.' : ''}`);
              }}
            >
              {ORDER_STATUS[s]?.label ?? s}
            </Button>
          ))}
          {(ORDER_NEXT[o.status] ?? []).length === 0 && <p className="text-[12.5px] text-muted">This order is closed.</p>}
        </div>

        <h3 className="mt-4 mb-2 text-[13px] font-semibold text-ink">{financeOwns ? 'Payment' : 'Payment (recorded by your team)'}</h3>
        {invoice && (
          <p className="mb-2 text-[12.5px] text-muted">
            Invoice <Link href={`/finance?invoice=${invoice.id}`} className="font-semibold text-brand-dark hover:underline">{invoice.number}</Link> ({INVOICE_STATUS[invoice.status]?.label ?? invoice.status}) · verified paid {inr(invoice.amountPaid)} of {inr(invoice.total)}
            {financeOwns && '. Payment status follows verified payments: record and verify payments under Finance.'}
          </p>
        )}
        <div className={financeOwns ? 'hidden' : 'flex flex-wrap gap-2'}>
          {Object.entries(PAYMENT_STATUS).map(([k, v]) => (
            <Button
              key={k}
              variant={o.paymentStatus === k ? 'primary' : 'secondary'}
              busy={busy === `pay:${k}`}
              disabled={o.paymentStatus === k}
              onClick={() => run(`pay:${k}`, () => api.post(`/textile/orders/${o.id}/payment`, { paymentStatus: k }), `${o.number} payment recorded as ${v.label.toLowerCase()}.`)}
            >
              {v.label}
            </Button>
          ))}
        </div>

        <h3 className="mt-5 mb-2 text-[13px] font-semibold text-ink">History</h3>
        <AuditTrail events={o.audit} />
      </div>
    </Card>
  );
}
