'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, FileText, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Lead, Quotation, TextileProduct } from '@/lib/types';
import { QUOTE_NEXT, QUOTE_STATUS, dateTime, displayName, formatPhone, inr, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, Segmented, Skeleton, cx } from '@/components/ui';
import { AuditTrail, Dialog, Label, Notice, TextileOnly, errorText, inputCls } from '@/components/textile';

type Filter = 'all' | 'pending_approval' | 'approved' | 'sent' | 'accepted';
const ACTION_LABEL: Record<string, string> = {
  pending_approval: 'Mark needs approval',
  approved: 'Approve',
  draft: 'Back to draft',
  rejected: 'Mark rejected',
  accepted: 'Customer accepted',
  expired: 'Mark expired',
};

export default function QuotationsPage() {
  return (
    <>
      <PageHeader title="Quotations" crumb="Textile sales / Quotations" />
      <TextileOnly>
        <Suspense>
          <Quotations />
        </Suspense>
      </TextileOnly>
    </>
  );
}

function Quotations() {
  const params = useSearchParams();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const { data, error, reload } = useApi<Quotation[]>('/textile/quotations', 15_000);
  const selectedId = params.get('id');
  const [creatingFor, setCreatingFor] = useState<string | null>(params.get('lead'));
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const rows = (data ?? []).filter((q) => filter === 'all' || q.status === filter);
  const count = (s: string) => (data ?? []).filter((q) => q.status === s).length;
  const select = (id: string | null) => router.replace(id ? `/quotations?id=${id}` : '/quotations');
  const closeCreate = useCallback(() => setCreatingFor(null), []);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Quotation status"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'pending_approval', label: `Needs pricing (${count('pending_approval')})` },
            { value: 'approved', label: `Ready to send (${count('approved')})` },
            { value: 'sent', label: `Sent (${count('sent')})` },
            { value: 'accepted', label: `Accepted (${count('accepted')})` },
          ]}
        />
        <Button variant="primary" onClick={() => setCreatingFor('')}>
          <Plus className="size-4" /> New quotation
        </Button>
      </div>
      <Notice notice={notice} />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      <div className={cx('grid grid-cols-1 gap-4', selectedId && 'xl:grid-cols-[1fr_520px]')}>
        <Card className="overflow-x-auto">
          <table className={cx('w-full text-[13px]', selectedId ? 'min-w-[560px]' : 'min-w-[720px]')}>
            <thead className="border-b border-line text-left text-[12px] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">Quotation</th>
                <th className="px-3 py-3 font-medium">Customer</th>
                {!selectedId && <th className="px-3 py-3 font-medium">Items</th>}
                <th className="px-3 py-3 text-right font-medium">Total</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {!data && (
                <tr><td colSpan={6} className="p-5"><Skeleton className="h-24" /></td></tr>
              )}
              {rows.map((q) => {
                const st = QUOTE_STATUS[q.status] ?? { label: q.status, tone: 'slate' as const };
                return (
                  <tr key={q.id} onClick={() => select(q.id)} className={cx('cursor-pointer border-t border-line hover:bg-slate-50', q.id === selectedId && 'bg-brand-soft/40')}>
                    <td className="px-5 py-2.5">
                      <p className="font-semibold text-ink">{q.number}</p>
                      <p className="text-[12px] text-muted">{q.origin === 'ai_request' ? 'Requested via AI' : 'Created by team'}</p>
                    </td>
                    <td className="px-3">
                      <p className="font-semibold text-ink">{displayName(q.customer)}</p>
                      <p className="text-[12px] text-muted">{formatPhone(q.customer?.phone)}</p>
                    </td>
                    {!selectedId && <td className="px-3 text-body">{q.items.map((i) => `${i.description} × ${Number(i.quantity)} ${i.unit}`).join(', ') || '—'}</td>}
                    <td className="px-3 text-right font-semibold text-ink tabular">{Number(q.total) > 0 ? inr(q.total) : <span className="text-faint">not priced</span>}</td>
                    <td className="px-3"><Badge tone={st.tone}>{st.label}</Badge></td>
                    <td className="px-5 text-right text-muted">{timeAgo(q.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data && rows.length === 0 && (
            <Empty icon={<FileText className="size-6" />} title="No quotations here">
              When a customer asks the AI for a quote, a request appears under &quot;Needs pricing&quot; for your team to price and approve.
            </Empty>
          )}
        </Card>
        {selectedId && <QuoteDetail id={selectedId} onClose={() => select(null)} onChanged={reload} setNotice={setNotice} />}
      </div>
      <Dialog open={creatingFor !== null} onClose={closeCreate} title="New quotation" wide>
        <QuoteEditor
          leadId={creatingFor || undefined}
          onSaved={async (q) => {
            setCreatingFor(null);
            setNotice({ tone: 'ok', text: `${q.number} created as a draft. Approve it, then send it on WhatsApp.` });
            await reload();
            select(q.id);
          }}
        />
      </Dialog>
    </>
  );
}

function QuoteDetail({ id, onClose, onChanged, setNotice }: { id: string; onClose: () => void; onChanged: () => Promise<void>; setNotice: (n: { tone: 'ok' | 'error'; text: string }) => void }) {
  const { data: q, error, reload } = useApi<Quotation>(`/textile/quotations/${id}`, 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const closeEdit = useCallback(() => setEditing(false), []);
  const router = useRouter();

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

  if (error && !q) return <ErrorBanner message={error} onRetry={reload} />;
  if (!q) return <Skeleton className="h-96" />;
  const st = QUOTE_STATUS[q.status] ?? { label: q.status, tone: 'slate' as const };
  const unpriced = q.items.some((i) => Number(i.unitPrice) <= 0);
  const editable = ['draft', 'pending_approval'].includes(q.status);

  return (
    <Card className="self-start">
      <CardHeader
        title={<span className="flex items-center gap-2">{q.number} <Badge tone={st.tone}>{st.label}</Badge></span>}
        subtitle={<Link href={q.leadId ? `/leads/${q.leadId}` : '#'} className="hover:underline">{displayName(q.customer)} · {formatPhone(q.customer?.phone)}</Link>}
        action={<button onClick={onClose} className="text-[12.5px] font-semibold text-muted hover:text-ink">Close</button>}
      />
      <div className="px-5 pb-5">
        <table className="w-full text-[13px]">
          <thead className="text-left text-[12px] text-muted">
            <tr><th className="py-1.5 font-medium">Item</th><th className="py-1.5 text-right font-medium">Qty</th><th className="py-1.5 text-right font-medium">Rate</th><th className="py-1.5 text-right font-medium">Amount</th></tr>
          </thead>
          <tbody>
            {q.items.map((i) => (
              <tr key={i.id} className="border-t border-line">
                <td className="py-2">{i.description}{i.sku && <span className="block text-[11.5px] text-muted">{i.sku}</span>}</td>
                <td className="py-2 text-right tabular">{Number(i.quantity)} {i.unit}</td>
                <td className="py-2 text-right tabular">{Number(i.unitPrice) > 0 ? inr(i.unitPrice) : <Badge tone="amber">price needed</Badge>}</td>
                <td className="py-2 text-right font-semibold tabular">{inr(i.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 border-t border-line pt-2">
          <Field label="Subtotal">{inr(q.subtotal)}</Field>
          {Number(q.discount) > 0 && <Field label="Discount">− {inr(q.discount)}</Field>}
          <Field label={`Tax (${Number(q.taxPercent)}%)`}>{inr(q.tax)}</Field>
          {Number(q.shipping) > 0 && <Field label="Shipping">{inr(q.shipping)}</Field>}
          <Field label="Total"><span className="text-[15px]">{inr(q.total)}</span></Field>
        </div>
        <div className="mt-2 text-[12.5px] text-muted">
          {q.validUntil && <p>Valid until {dateTime(q.validUntil)}</p>}
          {q.paymentTerms && <p>Payment: {q.paymentTerms}</p>}
          {q.deliveryTerms && <p>Delivery: {q.deliveryTerms}</p>}
          {q.notes && <p className="mt-1 whitespace-pre-line rounded-[10px] bg-slate-50 px-3 py-2 text-body">{q.notes}</p>}
        </div>

        {q.status === 'pending_approval' && unpriced && (
          <p className="mt-3 rounded-[10px] bg-amber-soft px-3 py-2 text-[12.5px] text-[#92400e]">
            The AI recorded this request without prices. Enter a rate for every item, check stock, then approve.
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {editable && (
            <Button onClick={() => setEditing(true)}><Pencil className="size-4" /> Edit prices & terms</Button>
          )}
          {(QUOTE_NEXT[q.status] ?? []).map((s) => (
            <Button
              key={s}
              variant={s === 'approved' || s === 'accepted' ? 'primary' : s === 'rejected' ? 'danger' : 'secondary'}
              busy={busy === s}
              disabled={s === 'approved' && unpriced}
              title={s === 'approved' && unpriced ? 'Every item needs a price first' : undefined}
              onClick={() => run(s, () => api.post(`/textile/quotations/${q.id}/status`, { status: s }), `${q.number}: ${QUOTE_STATUS[s]?.label ?? s}.`)}
            >
              {ACTION_LABEL[s] ?? s}
            </Button>
          ))}
          {q.status === 'approved' && (
            <Button variant="primary" busy={busy === 'send'} onClick={() => run('send', () => api.post(`/textile/quotations/${q.id}/send`), `${q.number} sent on WhatsApp. A reminder is scheduled if there is no reply.`)}>
              <Send className="size-4" /> Send on WhatsApp
            </Button>
          )}
          {q.status === 'accepted' && !q.order && (
            <Button
              variant="primary"
              busy={busy === 'convert'}
              onClick={() =>
                run('convert', async () => {
                  const r = await api.post<{ order: { id: string; number: string } }>(`/textile/quotations/${q.id}/convert`, {});
                  router.push(`/sales-orders?id=${r.order.id}`);
                }, `Order created from ${q.number}.`)
              }
            >
              <ArrowRightLeft className="size-4" /> Convert to order
            </Button>
          )}
          {q.order && <Button href={`/sales-orders?id=${q.order.id}`}>Order {q.order.number}</Button>}
        </div>
        {q.status === 'approved' && (
          <p className="mt-2 text-[12px] text-muted">
            Sending needs the customer&apos;s WhatsApp window open (they messaged in the last 24 h) or an approved quotation template. If neither, sending is refused and nothing changes.
          </p>
        )}

        <h3 className="mt-5 mb-2 text-[13px] font-semibold text-ink">History</h3>
        <AuditTrail events={q.audit} />
      </div>
      <Dialog open={editing} onClose={closeEdit} title={`Edit ${q.number}`} wide>
        <QuoteEditor
          quote={q}
          onSaved={async () => {
            setEditing(false);
            setNotice({ tone: 'ok', text: `${q.number} updated.` });
            await Promise.all([reload(), onChanged()]);
          }}
        />
      </Dialog>
    </Card>
  );
}

type Line = { productId: string; description: string; quantity: string; unit: string; unitPrice: string };

/** Create (from a lead) or edit (draft / pending) a quotation. Blank rate = the product's APPROVED catalogue price. */
function QuoteEditor({ quote, leadId, onSaved }: { quote?: Quotation; leadId?: string; onSaved: (q: Quotation) => void }) {
  const { data: products } = useApi<TextileProduct[]>('/textile/products?active=true', 0);
  const { data: leads } = useApi<Lead[]>(quote ? null : '/leads', 0);
  const [lead, setLead] = useState(leadId ?? '');
  const [lines, setLines] = useState<Line[]>(
    quote
      ? quote.items.map((i) => ({ productId: i.productId ?? '', description: i.description, quantity: String(Number(i.quantity)), unit: i.unit, unitPrice: Number(i.unitPrice) > 0 ? String(Number(i.unitPrice)) : '' }))
      : [{ productId: '', description: '', quantity: '', unit: 'metre', unitPrice: '' }],
  );
  const [discount, setDiscount] = useState(quote ? String(Number(quote.discount) || '') : '');
  const [taxPercent, setTax] = useState(quote ? String(Number(quote.taxPercent)) : '5');
  const [shipping, setShipping] = useState(quote ? String(Number(quote.shipping) || '') : '');
  const [validDays, setValidDays] = useState('7');
  const [paymentTerms, setPaymentTerms] = useState(quote?.paymentTerms ?? '');
  const [deliveryTerms, setDeliveryTerms] = useState(quote?.deliveryTerms ?? '');
  const [notes, setNotes] = useState(quote?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  useEffect(() => setLead(leadId ?? ''), [leadId]);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const preview = lines.reduce((a, l) => {
    const p = byId.get(l.productId);
    const rate = l.unitPrice !== '' ? Number(l.unitPrice) : p?.priceApproved ? Number(p.price) : NaN;
    return a + (Number(l.quantity) || 0) * (Number.isFinite(rate) ? rate : 0);
  }, 0);

  async function submit() {
    setBusy(true);
    setErr(null);
    const items = lines
      .filter((l) => l.productId || l.description.trim())
      .map((l) => ({
        ...(l.productId ? { productId: l.productId } : {}),
        description: l.description.trim() || undefined,
        quantity: Number(l.quantity),
        unit: l.unit,
        ...(l.unitPrice !== '' ? { unitPrice: Number(l.unitPrice) } : {}),
      }));
    const body = {
      items,
      discount: discount === '' ? 0 : Number(discount),
      taxPercent: taxPercent === '' ? 0 : Number(taxPercent),
      shipping: shipping === '' ? 0 : Number(shipping),
      validDays: Number(validDays) || undefined,
      paymentTerms,
      deliveryTerms,
      notes,
    };
    try {
      if (!quote && !lead) throw new Error('Choose the lead this quotation is for');
      const saved = quote ? await api.patch<Quotation>(`/textile/quotations/${quote.id}`, body) : await api.post<Quotation>('/textile/quotations', { ...body, leadId: lead });
      onSaved(saved);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {!quote && (
        <Label text="Lead *">
          <select value={lead} onChange={(e) => setLead(e.target.value)} className={inputCls}>
            <option value="">Choose a lead…</option>
            {(leads ?? []).map((l) => (
              <option key={l.id} value={l.id}>{displayName(l.customer)} · {formatPhone(l.customer?.phone)}</option>
            ))}
          </select>
        </Label>
      )}
      <div className="flex flex-col gap-2">
        {lines.map((l, i) => {
          const p = byId.get(l.productId);
          return (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-[10px] border border-line p-2.5 sm:grid-cols-[1.6fr_1.2fr_.7fr_.7fr_.8fr_auto]">
              <select
                aria-label="Product"
                value={l.productId}
                onChange={(e) => {
                  const np = byId.get(e.target.value);
                  setLine(i, { productId: e.target.value, unit: np?.priceUnit ?? l.unit, description: np ? '' : l.description });
                }}
                className={inputCls}
              >
                <option value="">Custom item (not in catalogue)</option>
                {(products ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.sku})</option>)}
              </select>
              <input aria-label="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder={p ? p.name : 'Description'} className={inputCls} />
              <input aria-label="Quantity" type="number" min={0} step="0.01" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} placeholder="Qty" className={inputCls} />
              <select aria-label="Unit" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} className={inputCls}>
                {['metre', 'piece', 'kg', 'set'].map((u) => <option key={u}>{u}</option>)}
              </select>
              <input
                aria-label="Rate"
                type="number"
                min={0}
                step="0.01"
                value={l.unitPrice}
                onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                placeholder={p?.priceApproved ? `${Number(p.price)} (approved)` : 'Rate ₹'}
                className={inputCls}
              />
              <button type="button" aria-label="Remove item" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1} className="grid size-9 place-items-center text-faint hover:text-rose disabled:opacity-30">
                <Trash2 className="size-4" />
              </button>
            </div>
          );
        })}
        <Button type="button" className="self-start" onClick={() => setLines((ls) => [...ls, { productId: '', description: '', quantity: '', unit: 'metre', unitPrice: '' }])}>
          <Plus className="size-4" /> Add item
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Label text="Discount (₹)"><input type="number" min={0} step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} className={inputCls} /></Label>
        <Label text="GST %"><input type="number" min={0} max={28} step="0.01" value={taxPercent} onChange={(e) => setTax(e.target.value)} className={inputCls} /></Label>
        <Label text="Shipping (₹)"><input type="number" min={0} step="0.01" value={shipping} onChange={(e) => setShipping(e.target.value)} className={inputCls} /></Label>
        <Label text="Valid for (days)"><input type="number" min={1} max={90} value={validDays} onChange={(e) => setValidDays(e.target.value)} className={inputCls} /></Label>
        <Label text="Payment terms" className="col-span-2"><input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="50% advance, balance before dispatch" className={inputCls} /></Label>
        <Label text="Delivery terms" className="col-span-2"><input value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} placeholder="Dispatch in 7 days, freight extra" className={inputCls} /></Label>
        <Label text="Notes" className="col-span-2 sm:col-span-4"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputCls} h-auto py-2`} /></Label>
      </div>
      <p className="text-[12.5px] text-muted">
        Items before discount/tax: <b className="text-ink">{inr(Math.round(preview * 100) / 100)}</b>. A blank rate uses the product&apos;s approved catalogue price; the server calculates the final totals.
      </p>
      {err && <p className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="flex justify-end">
        <Button variant="primary" busy={busy} onClick={submit}>{quote ? 'Save changes' : 'Create draft'}</Button>
      </div>
    </div>
  );
}
