'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState, type ReactNode } from 'react';
import { AlertTriangle, BadgeCheck, Banknote, CheckCircle2, Clock, Download, FileText, Info, Plus, Printer, Receipt, Undo2, Wallet, XCircle } from 'lucide-react';
import { API_URL, api, useApi } from '@/lib/api';
import type { FinanceOverview, Invoice, Payment, Receivables, SalesOrder, WorkTask } from '@/lib/types';
import { INVOICE_STATUS, PAYMENT_METHODS, PAYMENT_RECORD_STATUS, dateOnly, dateTime, displayName, inr, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, IconTile, Segmented, Skeleton, cx, type Tone } from '@/components/ui';
import { AuditTrail, Dialog, Label, Notice, TextileOnly, errorText, inputCls } from '@/components/textile';
import { WorkTaskList } from '@/components/agents';
import { CollectionsPanel, ExpensesAndMargin, FinanceLimits, StatementMatch } from '@/components/finance-extra';

type Tab = 'overview' | 'invoices' | 'verify' | 'receivables' | 'exceptions' | 'expenses';
type Notify = (n: { tone: 'ok' | 'error'; text: string }) => void;

export default function FinancePage() {
  return (
    <>
      <PageHeader title="Finance" crumb="AI agents / Finance" />
      <TextileOnly allow={['textile', 'retail']}>
        <Suspense>
          <Finance />
        </Suspense>
      </TextileOnly>
    </>
  );
}

function Finance() {
  const params = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(params.get('invoice') ? 'invoices' : ((params.get('tab') as Tab) ?? 'overview'));
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const { data: ov, error, reload: reloadOv } = useApi<FinanceOverview>('/finance/overview?days=30', 20_000);
  const { data: invoices, reload: reloadInv } = useApi<Invoice[]>('/finance/invoices', 15_000);
  const { data: pending, reload: reloadPending } = useApi<Payment[]>('/finance/payments?status=pending_verification', 15_000);
  const { data: verified, reload: reloadVerified } = useApi<Payment[]>(tab === 'verify' ? '/finance/payments?status=verified' : null, 15_000);
  const { data: rec, reload: reloadRec } = useApi<Receivables>(tab === 'receivables' ? '/finance/receivables' : null, 20_000);
  const { data: exceptions, reload: reloadEx } = useApi<WorkTask[]>(tab === 'exceptions' ? '/agents/work-tasks/list?agent=finance&status=active' : null, 15_000);
  const selected = params.get('invoice');
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadOv(), reloadInv(), reloadPending(), reloadVerified(), reloadRec(), reloadEx()]);
  }, [reloadOv, reloadInv, reloadPending, reloadVerified, reloadRec, reloadEx]);
  const select = (id: string | null) => router.replace(id ? `/finance?invoice=${id}` : '/finance');

  if (error && !ov) return <ErrorBanner message={error} onRetry={reloadOv} />;
  return (
    <>
      <Notice notice={notice} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Finance section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'invoices', label: 'Invoices' },
            { value: 'verify', label: `Verify payments${pending?.length ? ` (${pending.length})` : ''}` },
            { value: 'receivables', label: 'Receivables' },
            { value: 'exceptions', label: `Exceptions${ov?.reconciliationExceptions ? ` (${ov.reconciliationExceptions})` : ''}` },
            { value: 'expenses', label: 'Expenses & margin' },
          ]}
        />
        <p className="flex items-center gap-1.5 text-[12px] text-muted"><Info className="size-3.5" /> No payment gateway or bank feed is connected: payments are verified by your team.</p>
      </div>

      {tab === 'overview' && <Overview ov={ov} />}
      {tab === 'invoices' && (
        <div className={cx('grid grid-cols-1 gap-4', selected && 'xl:grid-cols-[1fr_520px]')}>
          <InvoiceList invoices={invoices} selected={selected} onSelect={select} onCreated={async (id) => { await reloadAll(); select(id); }} notify={setNotice} />
          {selected && <InvoiceDetail id={selected} onClose={() => select(null)} onChanged={reloadAll} notify={setNotice} />}
        </div>
      )}
      {tab === 'verify' && (
        <div className="flex flex-col gap-4">
          <VerifyQueue pending={pending} verified={verified} onChanged={reloadAll} notify={setNotice} />
          <StatementMatch notify={setNotice} onChanged={reloadAll} />
        </div>
      )}
      {tab === 'expenses' && <ExpensesAndMargin notify={setNotice} />}
      {tab === 'receivables' && <ReceivablesView rec={rec} onSelect={(id) => { setTab('invoices'); select(id); }} />}
      {tab === 'exceptions' && (exceptions ? <WorkTaskList items={exceptions} onChanged={reloadAll} notify={setNotice} /> : <Skeleton className="h-40" />)}
    </>
  );
}

function Kpi({ icon, tone, label, value, sub, note }: { icon: ReactNode; tone: Tone; label: string; value: ReactNode; sub?: string; note?: string }) {
  return (
    <Card className="flex items-start gap-3 p-4">
      <IconTile tone={tone}>{icon}</IconTile>
      <div className="min-w-0">
        <p className="flex items-center gap-1 text-[12.5px] text-muted">
          {label}
          {note && <span title={note} aria-label={note} className="cursor-help text-faint"><Info className="size-3.5" /></span>}
        </p>
        <p className="text-[21px] leading-tight font-bold text-ink tabular">{value}</p>
        {sub && <p className="text-[12px] text-muted">{sub}</p>}
      </div>
    </Card>
  );
}

function Overview({ ov }: { ov: FinanceOverview | null }) {
  if (!ov) return <Skeleton className="h-48" />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<FileText className="size-4" />} tone="sky" label="Order value (30 days)" value={inr(ov.orderValue.amount)} sub={`${ov.orderValue.count} confirmed orders`} note={ov.notes.orderValue} />
        <Kpi icon={<Receipt className="size-4" />} tone="violet" label="Invoiced (30 days)" value={inr(ov.invoiced.amount)} sub={`${ov.invoiced.count} issued invoices`} note={ov.notes.invoiced} />
        <Kpi icon={<BadgeCheck className="size-4" />} tone="brand" label="Verified collections (30 days)" value={inr(ov.collectedVerified.amount)} sub={`${ov.collectedVerified.count} verified payments - cash, not profit`} note={ov.notes.collectedVerified} />
        <Kpi icon={<Wallet className="size-4" />} tone="amber" label="Outstanding now" value={inr(ov.outstanding.amount)} sub={`${ov.outstanding.count} open invoices`} note={ov.notes.outstanding} />
        <Kpi icon={<AlertTriangle className="size-4" />} tone="rose" label="Overdue" value={inr(ov.overdue.amount)} sub={`${ov.overdue.count} invoices past due date`} />
        <Kpi icon={<Clock className="size-4" />} tone="amber" label="Awaiting verification" value={inr(ov.awaitingVerification.amount)} sub={`${ov.awaitingVerification.count} payments - not counted as collected`} />
        <Kpi icon={<XCircle className="size-4" />} tone={ov.reconciliationExceptions ? 'rose' : 'slate'} label="Reconciliation exceptions" value={ov.reconciliationExceptions} sub="duplicates, overpayments" />
        <Kpi icon={<Banknote className="size-4" />} tone="slate" label="Expenses (30 days)" value={inr(ov.expenses.amount)} sub={`${ov.expenses.count} recorded - margin under "Expenses & margin"`} note={`${ov.notes.expenses} ${ov.notes.grossMargin}`} />
      </div>
      <FinanceLimits />
    </div>
  );
}

function InvoiceList({ invoices, selected, onSelect, onCreated, notify }: { invoices: Invoice[] | null; selected: string | null; onSelect: (id: string) => void; onCreated: (id: string) => Promise<void>; notify: Notify }) {
  const [creating, setCreating] = useState(false);
  const close = useCallback(() => setCreating(false), []);
  return (
    <Card className="overflow-x-auto">
      <CardHeader
        title="Invoices"
        subtitle="Drafted from confirmed orders. Amounts are computed by the server from the order and the quotation terms."
        action={
          <span className="flex gap-2">
            <Button className="h-8" href={`${API_URL}/finance/invoices.csv`}><Download className="size-4" /> CSV</Button>
            <Button variant="primary" className="h-8" onClick={() => setCreating(true)}><Plus className="size-4" /> Invoice an order</Button>
          </span>
        }
      />
      <table className={cx('w-full text-[13px]', selected ? 'min-w-[560px]' : 'min-w-[780px]')}>
        <thead className="border-y border-line text-left text-[12px] text-muted">
          <tr>
            <th className="px-5 py-2.5 font-medium">Invoice</th>
            <th className="px-3 py-2.5 font-medium">Customer</th>
            <th className="px-3 py-2.5 text-right font-medium">Total</th>
            {!selected && <th className="px-3 py-2.5 text-right font-medium">Verified paid</th>}
            <th className="px-3 py-2.5 text-right font-medium">Outstanding</th>
            <th className="px-5 py-2.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {!invoices && <tr><td colSpan={6} className="p-5"><Skeleton className="h-20" /></td></tr>}
          {invoices?.map((i) => {
            const st = INVOICE_STATUS[i.status] ?? { label: i.status, tone: 'slate' as const };
            return (
              <tr key={i.id} onClick={() => onSelect(i.id)} className={cx('cursor-pointer border-t border-line hover:bg-slate-50', i.id === selected && 'bg-brand-soft/40')}>
                <td className="px-5 py-2.5">
                  <p className="font-semibold text-ink">{i.number}</p>
                  <p className="text-[12px] text-muted">{i.order?.number} · due {dateOnly(i.dueDate)}</p>
                </td>
                <td className="px-3">{displayName(i.customer)}</td>
                <td className="px-3 text-right tabular">{inr(i.total)}</td>
                {!selected && <td className="px-3 text-right tabular">{inr(i.amountPaid)}</td>}
                <td className="px-3 text-right font-semibold text-ink tabular">{i.outstanding > 0 ? inr(i.outstanding) : '—'}</td>
                <td className="px-5">
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {i.overdue && <Badge tone="rose">{i.daysOverdue}d overdue</Badge>}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {invoices?.length === 0 && <Empty icon={<Receipt className="size-6" />} title="No invoices yet">The Finance agent drafts one when an order is confirmed (Settings → Finance). You can also invoice an order here.</Empty>}
      <Dialog open={creating} onClose={close} title="Invoice an order">
        {creating && <CreateInvoice onDone={async (inv, dup) => { setCreating(false); notify({ tone: 'ok', text: dup ? `${inv.number} already exists for that order.` : `${inv.number} drafted. Approve and issue it.` }); await onCreated(inv.id); }} />}
      </Dialog>
    </Card>
  );
}

function CreateInvoice({ onDone }: { onDone: (inv: Invoice, duplicate: boolean) => Promise<void> }) {
  const { data: orders } = useApi<SalesOrder[]>('/textile/orders', 0);
  const { data: invoices } = useApi<Invoice[]>('/finance/invoices', 0);
  const [orderId, setOrderId] = useState('');
  const [tax, setTax] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const invoiced = new Set((invoices ?? []).filter((i) => i.status !== 'cancelled').map((i) => i.orderId));
  const eligible = (orders ?? []).filter((o) => ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered'].includes(o.status) && !invoiced.has(o.id));
  const chosen = eligible.find((o) => o.id === orderId);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ invoice: Invoice; duplicate: boolean }>('/finance/invoices', { orderId, ...(chosen && !chosen.quotation ? { taxPercent: tax === '' ? null : Number(tax) } : {}) });
      await onDone(r.invoice, r.duplicate);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <Label text="Confirmed order without an invoice">
        <select value={orderId} onChange={(e) => setOrderId(e.target.value)} className={inputCls}>
          <option value="">Choose…</option>
          {eligible.map((o) => <option key={o.id} value={o.id}>{o.number} · {displayName(o.customer)} · {inr(o.total)}</option>)}
        </select>
      </Label>
      {chosen && !chosen.quotation && (
        <Label text="Tax % to charge (this order has no quotation terms; no rate is assumed) *">
          <input type="number" min={0} max={100} step="0.01" value={tax} onChange={(e) => setTax(e.target.value)} className={inputCls} />
        </Label>
      )}
      {chosen?.quotation && <p className="text-[12.5px] text-muted">Discount, tax and shipping are copied from quotation {chosen.quotation.number}.</p>}
      {err && <p className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="flex justify-end"><Button variant="primary" busy={busy} disabled={!orderId} onClick={submit}>Draft invoice</Button></div>
    </div>
  );
}

function InvoiceDetail({ id, onClose, onChanged, notify }: { id: string; onClose: () => void; onChanged: () => Promise<void>; notify: Notify }) {
  const { data: inv, error, reload } = useApi<Invoice>(`/finance/invoices/${id}`, 10_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [reason, setReason] = useState('');
  const [paying, setPaying] = useState(false);
  const closePay = useCallback(() => setPaying(false), []);
  async function move(to: string) {
    setBusy(to);
    try {
      await api.post(`/finance/invoices/${id}/status`, { status: to, ...(to === 'issued' && dueDate ? { dueDate } : {}), ...(to === 'cancelled' ? { reason } : {}) });
      notify({ tone: 'ok', text: `Invoice ${INVOICE_STATUS[to]?.label.toLowerCase() ?? to}.` });
      await Promise.all([reload(), onChanged()]);
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  if (error && !inv) return <ErrorBanner message={error} onRetry={reload} />;
  if (!inv) return <Skeleton className="h-96" />;
  const st = INVOICE_STATUS[inv.status] ?? { label: inv.status, tone: 'slate' as const };
  return (
    <Card className="self-start print:shadow-none" id="invoice-print">
      <CardHeader
        title={<span className="flex items-center gap-2">{inv.number} <Badge tone={st.tone}>{st.label}</Badge>{inv.overdue && <Badge tone="rose">{inv.daysOverdue} days overdue</Badge>}</span>}
        subtitle={<>{displayName(inv.customer)} · <Link href={`/sales-orders?id=${inv.orderId}`} className="hover:underline">{inv.order?.number}</Link></>}
        action={<button onClick={onClose} className="text-[12.5px] font-semibold text-muted hover:text-ink print:hidden">Close</button>}
      />
      <div className="px-5 pb-5 text-[13px]">
        <div className="grid grid-cols-2 gap-x-4 text-[12.5px] text-muted">
          <span>Invoice date: {dateOnly(inv.invoiceDate)}</span>
          <span>Due: {dateOnly(inv.dueDate)}</span>
        </div>
        <table className="mt-3 w-full">
          <thead className="text-left text-[12px] text-muted"><tr><th className="py-1.5 font-medium">Item</th><th className="py-1.5 text-right font-medium">Qty</th><th className="py-1.5 text-right font-medium">Rate</th><th className="py-1.5 text-right font-medium">Amount</th></tr></thead>
          <tbody>
            {inv.items?.map((i) => (
              <tr key={i.id} className="border-t border-line">
                <td className="py-2">{i.description}{i.sku && <span className="block text-[11.5px] text-muted">{i.sku}</span>}</td>
                <td className="py-2 text-right tabular">{Number(i.quantity)} {i.unit}</td>
                <td className="py-2 text-right tabular">{inr(i.unitPrice)}</td>
                <td className="py-2 text-right font-semibold tabular">{inr(i.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 border-t border-line pt-2">
          <Field label="Subtotal">{inr(inv.subtotal)}</Field>
          {Number(inv.discount) > 0 && <Field label="Discount">− {inr(inv.discount)}</Field>}
          <Field label={`Tax ${Number(inv.taxPercent)}% (${inv.taxSource === 'quotation' ? 'from quotation' : 'entered'})`}>{inr(inv.tax)}</Field>
          {Number(inv.shipping) > 0 && <Field label="Shipping">{inr(inv.shipping)}</Field>}
          <Field label="Total"><span className="text-[15px]">{inr(inv.total)}</span></Field>
          <Field label="Verified paid">{inr(inv.amountPaid)}</Field>
          <Field label="Outstanding">{inr(inv.outstanding)}</Field>
        </div>
        {inv.notes && <p className="mt-2 whitespace-pre-line text-[12.5px] text-muted">{inv.notes}</p>}

        <div className="mt-4 flex flex-col gap-2 print:hidden">
          {inv.status === 'draft' && <Button variant="primary" busy={busy === 'approved'} onClick={() => move('approved')}><CheckCircle2 className="size-4" /> Approve</Button>}
          {inv.status === 'approved' && (
            <div className="flex flex-wrap items-end gap-2">
              <Label text="Due date (default: payment terms)"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} /></Label>
              <Button variant="primary" busy={busy === 'issued'} onClick={() => move('issued')}>Issue</Button>
              <Button busy={busy === 'draft'} onClick={() => move('draft')}>Back to draft</Button>
            </div>
          )}
          {['approved', 'issued', 'partially_paid'].includes(inv.status) && <Button onClick={() => setPaying(true)}><Plus className="size-4" /> Record a payment</Button>}
          {inv.status !== 'cancelled' && inv.status !== 'paid' && (
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label="Cancel reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason to cancel" className={`${inputCls} flex-1`} />
              <Button variant="danger" busy={busy === 'cancelled'} disabled={!reason.trim()} onClick={() => move('cancelled')}>Cancel invoice</Button>
            </div>
          )}
          <Button variant="ghost" onClick={() => window.print()}><Printer className="size-4" /> Print / save as PDF</Button>
        </div>

        <h3 className="mt-5 mb-2 font-semibold text-ink">Payments</h3>
        {!inv.payments?.length && <p className="text-[12.5px] text-muted">None recorded.</p>}
        <ul className="flex flex-col gap-1.5">
          {inv.payments?.map((p) => {
            const ps = PAYMENT_RECORD_STATUS[p.status] ?? { label: p.status, tone: 'slate' as const };
            return (
              <li key={p.id} className="rounded-[10px] bg-slate-50 px-3 py-2 text-[12.5px]">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-ink">{inr(p.amount)} · {PAYMENT_METHODS[p.method] ?? p.method}{p.reference ? ` · ${p.reference}` : ''}</span>
                  <Badge tone={ps.tone}>{ps.label}</Badge>
                </span>
                <span className="text-muted">
                  paid {dateOnly(p.paidAt)} · {p.source === 'customer_claim' ? 'customer says paid' : 'entered by staff'}
                  {p.verifiedAt && ` · verified ${dateTime(p.verifiedAt)}: ${p.evidence}`}
                  {p.rejectedReason && ` · rejected: ${p.rejectedReason}`}
                  {p.reversalReason && ` · reversed: ${p.reversalReason}`}
                </span>
              </li>
            );
          })}
        </ul>
        <CollectionsPanel invoiceId={inv.id} open={['issued', 'partially_paid'].includes(inv.status)} notify={notify} onChanged={() => void reload()} />
        <h3 className="mt-5 mb-2 font-semibold text-ink">History</h3>
        <AuditTrail events={inv.audit} />
      </div>
      <Dialog open={paying} onClose={closePay} title={`Record a payment on ${inv.number}`}>
        {paying && <RecordPayment invoice={inv} onDone={async (flags) => { setPaying(false); notify({ tone: flags.length ? 'error' : 'ok', text: `Payment recorded - awaiting verification.${flags.includes('duplicate_reference') ? ' Warning: this reference was already recorded.' : ''}${flags.includes('exceeds_outstanding') ? ' Warning: more than the outstanding amount.' : ''}` }); await Promise.all([reload(), onChanged()]); }} />}
      </Dialog>
    </Card>
  );
}

function RecordPayment({ invoice, onDone }: { invoice: Invoice; onDone: (flags: string[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(form: FormData) {
    setBusy(true);
    setErr(null);
    const v = (k: string) => String(form.get(k) ?? '').trim();
    try {
      const r = await api.post<{ flags: string[] }>('/finance/payments', { invoiceId: invoice.id, amount: Number(v('amount')), method: v('method'), reference: v('reference'), paidAt: v('paidAt') || undefined, source: v('source'), notes: v('notes') });
      await onDone(r.flags);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(new FormData(e.currentTarget)); }} className="grid grid-cols-2 gap-3">
      <p className="col-span-2 rounded-[10px] bg-amber-soft px-3 py-2 text-[12.5px] text-[#92400e]">
        This records the payment as <b>awaiting verification</b>. It counts as collected only after someone with the verify permission checks it against the bank statement or receipt book.
      </p>
      <Label text="Amount (₹) *"><input name="amount" type="number" min={0} step="0.01" required defaultValue={invoice.outstanding || ''} className={inputCls} /></Label>
      <Label text="Method *">
        <select name="method" className={inputCls} defaultValue="upi">
          {Object.entries(PAYMENT_METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Label>
      <Label text="UTR / cheque / receipt no."><input name="reference" className={inputCls} /></Label>
      <Label text="Paid on"><input name="paidAt" type="date" className={inputCls} /></Label>
      <Label text="Source" className="col-span-2">
        <select name="source" className={inputCls} defaultValue="staff_entry">
          <option value="staff_entry">Entered by our team</option>
          <option value="customer_claim">Customer says they paid (screenshot / message)</option>
        </select>
      </Label>
      <Label text="Notes" className="col-span-2"><input name="notes" className={inputCls} /></Label>
      {err && <p className="col-span-2 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="col-span-2 flex justify-end"><Button type="submit" variant="primary" busy={busy}>Record payment</Button></div>
    </form>
  );
}

function VerifyQueue({ pending, verified, onChanged, notify }: { pending: Payment[] | null; verified: Payment[] | null; onChanged: () => Promise<void>; notify: Notify }) {
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  async function act(p: Payment, kind: 'verify' | 'reject' | 'reverse') {
    setBusy(`${p.id}:${kind}`);
    const t = text[p.id] ?? '';
    try {
      const r = await api.post<{ applied?: boolean }>(`/finance/payments/${p.id}/${kind}`, kind === 'verify' ? { evidence: t } : { reason: t });
      notify({ tone: 'ok', text: kind === 'verify' ? `Verified ${inr(p.amount)} on ${p.invoice?.number}.` : kind === 'reject' ? 'Payment rejected.' : r.applied ? 'Payment reversed (record correction; no money moved).' : 'Reversal sent for approval.' });
      setText((x) => ({ ...x, [p.id]: '' }));
      await onChanged();
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12.5px] text-muted">Verify only against your bank statement, gateway report or cash receipt book. A customer screenshot, message or UTR alone is not proof. Duplicates and overpayments are refused and sent to Exceptions.</p>
      {!pending && <Skeleton className="h-32" />}
      {pending?.length === 0 && <Card><Empty icon={<BadgeCheck className="size-6" />} title="Nothing waiting for verification" /></Card>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {pending?.map((p) => (
          <Card key={p.id} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[15px] font-semibold text-ink">{inr(p.amount)} <span className="text-[12.5px] font-normal text-muted">on {p.invoice?.number}</span></p>
                <p className="text-[12px] text-muted">{displayName(p.customer)} · {PAYMENT_METHODS[p.method] ?? p.method}{p.reference ? ` · ${p.reference}` : ''} · paid {dateOnly(p.paidAt)} · recorded {timeAgo(p.createdAt)}</p>
              </div>
              {p.source === 'customer_claim' ? <Badge tone="amber">Customer claim</Badge> : <Badge tone="slate">Staff entry</Badge>}
            </div>
            <p className="mt-1 text-[12px] text-muted">Invoice: {inr(p.invoice?.total)} total, {inr(p.invoice?.amountPaid)} verified so far</p>
            <textarea aria-label="Evidence or reason" rows={2} value={text[p.id] ?? ''} onChange={(e) => setText((x) => ({ ...x, [p.id]: e.target.value }))} placeholder='Evidence checked, e.g. "HDFC statement 14 Oct, credit ₹50,000, UTR …" (or the reason to reject)' className={`${inputCls} mt-2 h-auto py-2`} />
            <div className="mt-2 flex gap-2">
              <Button variant="primary" busy={busy === `${p.id}:verify`} onClick={() => act(p, 'verify')}><CheckCircle2 className="size-4" /> Verify</Button>
              <Button variant="danger" busy={busy === `${p.id}:reject`} onClick={() => act(p, 'reject')}><XCircle className="size-4" /> Reject</Button>
            </div>
          </Card>
        ))}
      </div>
      {!!verified?.length && (
        <Card>
          <CardHeader title="Verified payments" subtitle="A reversal (bounced cheque, chargeback, wrong invoice) is a record correction and goes through an approval" />
          <ul className="px-5 pb-4">
            {verified.slice(0, 50).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2.5 text-[13px] first:border-t-0">
                <span>
                  <b className="text-ink">{inr(p.amount)}</b> · {p.invoice?.number} · {displayName(p.customer)}
                  <span className="block text-[12px] text-muted">verified {p.verifiedAt ? dateTime(p.verifiedAt) : ''}: {p.evidence}</span>
                </span>
                <span className="flex items-center gap-2">
                  <input aria-label={`Reversal reason for ${p.id}`} value={text[p.id] ?? ''} onChange={(e) => setText((x) => ({ ...x, [p.id]: e.target.value }))} placeholder="Reason to reverse" className={`${inputCls} w-48`} />
                  <Button className="h-8" busy={busy === `${p.id}:reverse`} disabled={!(text[p.id] ?? '').trim()} onClick={() => act(p, 'reverse')}><Undo2 className="size-4" /> Reverse</Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ReceivablesView({ rec, onSelect }: { rec: Receivables | null; onSelect: (id: string) => void }) {
  if (!rec) return <Skeleton className="h-48" />;
  const buckets: Array<[keyof Receivables['aging'], string]> = [['current', 'Not yet due'], ['1_30', '1–30 days'], ['31_60', '31–60 days'], ['61_90', '61–90 days'], ['over_90', 'Over 90 days']];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {buckets.map(([k, l]) => (
          <Card key={k} className="p-3">
            <p className="text-[12px] text-muted">{l}</p>
            <p className={cx('text-[18px] font-bold tabular', k !== 'current' && rec.aging[k] > 0 ? 'text-rose' : 'text-ink')}>{inr(rec.aging[k]) === '—' ? '₹0' : inr(rec.aging[k])}</p>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
        <Card className="overflow-x-auto">
          <CardHeader title="Open invoices" subtitle={`Verified payments only · as of ${dateTime(rec.asOf)}`} />
          <table className="w-full min-w-[560px] text-[13px]">
            <thead className="border-y border-line text-left text-[12px] text-muted"><tr><th className="px-5 py-2.5 font-medium">Invoice</th><th className="px-3 py-2.5 font-medium">Customer</th><th className="px-3 py-2.5 font-medium">Due</th><th className="px-5 py-2.5 text-right font-medium">Outstanding</th></tr></thead>
            <tbody>
              {rec.invoices.map((i) => (
                <tr key={i.id} onClick={() => onSelect(i.id)} className="cursor-pointer border-t border-line hover:bg-slate-50">
                  <td className="px-5 py-2.5 font-semibold text-ink">{i.number}</td>
                  <td className="px-3">{displayName(i.customer)}</td>
                  <td className="px-3">{dateOnly(i.dueDate)} {i.overdue && <Badge tone="rose">{i.daysOverdue}d late</Badge>}</td>
                  <td className="px-5 text-right font-semibold tabular">{inr(i.outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rec.invoices.length === 0 && <Empty title="Nothing outstanding" />}
        </Card>
        <Card>
          <CardHeader title="Customer balances" />
          <ul className="px-5 pb-4">
            {rec.customers.map((c) => (
              <li key={c.customerId} className="flex justify-between gap-2 border-t border-line py-2 text-[13px] first:border-t-0">
                <span>{c.name ?? c.phone ?? 'Customer'} <span className="text-[12px] text-muted">· {c.invoices} invoice(s)</span></span>
                <span className="text-right tabular"><b className="text-ink">{inr(c.outstanding)}</b>{c.overdue > 0 && <span className="block text-[12px] text-rose">{inr(c.overdue)} overdue</span>}</span>
              </li>
            ))}
            {rec.customers.length === 0 && <p className="text-[12.5px] text-muted">No balances.</p>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
