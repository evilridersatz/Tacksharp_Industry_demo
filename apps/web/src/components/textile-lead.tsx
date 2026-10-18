'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FileText, Pencil, Plus } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Quotation, SalesOrder } from '@/lib/types';
import { ORDER_STATUS, QUOTE_STATUS, inr, timeAgo } from '@/lib/format';
import { Badge, Button, Card, CardHeader, ErrorBanner, Field, Skeleton } from './ui';
import { Dialog, Label, errorText, inputCls } from './textile';

type Requirement = {
  buyerType: string | null; productInterest: string | null; fabricCategory: string | null; colour: string | null;
  quantity: string | number | null; quantityUnit: string | null; targetPrice: string | number | null; destination: string | null; neededBy: string | null; notes: string | null;
} | null;

type LeadTextile = { requirement: Requirement; quotations: Quotation[]; orders: SalesOrder[] };

const BUYER: Record<string, string> = { wholesaler: 'Wholesaler', retailer: 'Retailer', garment_manufacturer: 'Garment maker', exporter: 'Exporter', boutique: 'Boutique', other: 'Other' };

/** Lead page, textile businesses: what the buyer wants (AI-captured, editable) + their quotations and orders. */
export function TextileLeadPanel({ leadId }: { leadId: string }) {
  const { data, error, reload } = useApi<LeadTextile>(`/textile/leads/${leadId}`, 15_000);
  const [editing, setEditing] = useState(false);
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-48" />;
  const r = data.requirement;

  return (
    <>
      <Card>
        <CardHeader
          title="Buyer requirement"
          subtitle="Captured by the AI from the conversation; your team can correct it"
          action={<Button className="h-8" onClick={() => setEditing(true)}><Pencil className="size-4" /> Edit</Button>}
        />
        <div className="px-5 pb-4">
          <Field label="Looking for">{[r?.colour, r?.fabricCategory, r?.productInterest].filter(Boolean).join(' ') || '—'}</Field>
          <Field label="Quantity">{r?.quantity ? `${Number(r.quantity)} ${r.quantityUnit ?? ''}` : '—'}</Field>
          <Field label="Target price">{r?.targetPrice ? inr(r.targetPrice) : '—'}</Field>
          <Field label="Buyer type">{r?.buyerType ? BUYER[r.buyerType] ?? r.buyerType : '—'}</Field>
          <Field label="Deliver to">{r?.destination ?? '—'}</Field>
          <Field label="Needed by">{r?.neededBy ?? '—'}</Field>
          {r?.notes && <p className="mt-2 whitespace-pre-line rounded-[10px] bg-slate-50 px-3 py-2 text-[12.5px] text-body">{r.notes}</p>}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Quotations & orders"
          action={<Button className="h-8" href={`/quotations?lead=${leadId}`}><Plus className="size-4" /> Quotation</Button>}
        />
        <ul className="px-5 pb-4">
          {data.quotations.map((q) => (
            <li key={q.id} className="flex items-center justify-between gap-2 border-t border-line py-2.5 text-[13px] first:border-t-0">
              <Link href={`/quotations?id=${q.id}`} className="flex items-center gap-2 font-semibold text-ink hover:underline">
                <FileText className="size-4 text-faint" /> {q.number}
              </Link>
              <span className="flex items-center gap-2">
                <span className="tabular">{Number(q.total) > 0 ? inr(q.total) : ''}</span>
                <Badge tone={QUOTE_STATUS[q.status]?.tone ?? 'slate'}>{QUOTE_STATUS[q.status]?.label ?? q.status}</Badge>
              </span>
            </li>
          ))}
          {data.orders.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-2 border-t border-line py-2.5 text-[13px] first:border-t-0">
              <Link href={`/sales-orders?id=${o.id}`} className="font-semibold text-ink hover:underline">{o.number}</Link>
              <span className="flex items-center gap-2">
                <span className="tabular">{inr(o.total)}</span>
                <Badge tone={ORDER_STATUS[o.status]?.tone ?? 'slate'}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge>
                <span className="text-[12px] text-faint">{timeAgo(o.createdAt)}</span>
              </span>
            </li>
          ))}
          {!data.quotations.length && !data.orders.length && <p className="text-[12.5px] text-muted">No quotation yet.</p>}
        </ul>
      </Card>

      <Dialog open={editing} onClose={() => setEditing(false)} title="Buyer requirement">
        <RequirementForm
          leadId={leadId}
          value={r}
          onSaved={async () => {
            setEditing(false);
            await reload();
          }}
        />
      </Dialog>
    </>
  );
}

function RequirementForm({ leadId, value, onSaved }: { leadId: string; value: Requirement; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(form: FormData) {
    setBusy(true);
    setErr(null);
    const body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    try {
      await api.patch(`/textile/requirements/${leadId}`, body);
      onSaved();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const v = (x: string | number | null | undefined) => (x === null || x === undefined ? '' : String(x));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(new FormData(e.currentTarget));
      }}
      className="grid grid-cols-2 gap-3"
    >
      <Label text="Fabric"><input name="fabricCategory" defaultValue={v(value?.fabricCategory)} className={inputCls} /></Label>
      <Label text="Product"><input name="productInterest" defaultValue={v(value?.productInterest)} className={inputCls} /></Label>
      <Label text="Colour"><input name="colour" defaultValue={v(value?.colour)} className={inputCls} /></Label>
      <Label text="Buyer type">
        <select name="buyerType" defaultValue={value?.buyerType ?? ''} className={inputCls}>
          <option value="">—</option>
          {Object.entries(BUYER).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Label>
      <Label text="Quantity"><input name="quantity" type="number" min={0} step="0.01" defaultValue={value?.quantity ? Number(value.quantity) : ''} className={inputCls} /></Label>
      <Label text="Unit">
        <select name="quantityUnit" defaultValue={value?.quantityUnit ?? 'metre'} className={inputCls}>
          {['metre', 'piece', 'kg', 'roll', 'set'].map((u) => <option key={u}>{u}</option>)}
        </select>
      </Label>
      <Label text="Target price (₹)"><input name="targetPrice" type="number" min={0} step="0.01" defaultValue={value?.targetPrice ? Number(value.targetPrice) : ''} className={inputCls} /></Label>
      <Label text="Deliver to"><input name="destination" defaultValue={v(value?.destination)} className={inputCls} /></Label>
      <Label text="Needed by" className="col-span-2"><input name="neededBy" defaultValue={v(value?.neededBy)} placeholder="e.g. before Diwali" className={inputCls} /></Label>
      <Label text="Notes" className="col-span-2"><textarea name="notes" rows={2} defaultValue={v(value?.notes)} className={`${inputCls} h-auto py-2`} /></Label>
      {err && <p className="col-span-2 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="col-span-2 flex justify-end">
        <Button type="submit" variant="primary" busy={busy}>Save</Button>
      </div>
    </form>
  );
}
