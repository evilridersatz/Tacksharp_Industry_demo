'use client';

import { Printer } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Button, ErrorBanner, Skeleton } from './ui';
import { day, inr, StatusBadge, type Invoice } from './billing';

type Doc = {
  invoice: Invoice;
  buyer: { name: string; workspace: string; gstin: string | null; address: string | null; email: string | null };
  seller: { name: string | null; gstin: string | null; address: string | null; email: string | null };
  note: string;
};

/** A printable invoice (the browser's "Save as PDF" makes the PDF). Seller details come from server configuration. */
export function InvoicePrint({ path, back }: { path: string; back: string }) {
  const { data: d, error, reload } = useApi<Doc>(path, 0);
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!d) return <Skeleton className="h-[600px]" />;
  const i = d.invoice;
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <a href={back} className="text-[13px] font-semibold text-muted hover:text-ink">← Back</a>
        <span className="flex gap-2">
          {i.payUrl && <Button href={i.payUrl} variant="primary">Pay online</Button>}
          <Button onClick={() => window.print()}><Printer className="size-4" /> Print / save as PDF</Button>
        </span>
      </div>
      <article data-testid="invoice-doc" className="rounded-[14px] border border-line bg-white p-6 text-[13px] text-ink sm:p-10 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
          <div>
            <p className="text-[20px] font-semibold">{d.seller.name ?? <span className="text-amber-700">Seller name not configured</span>}</p>
            {d.seller.address && <p className="whitespace-pre-line text-muted">{d.seller.address}</p>}
            <p className="text-muted">{d.seller.gstin ? `GSTIN ${d.seller.gstin}` : 'GSTIN not configured'}{d.seller.email ? ` · ${d.seller.email}` : ''}</p>
          </div>
          <div className="text-right">
            <p className="text-[12px] tracking-wide text-muted uppercase">Invoice</p>
            <p className="text-[18px] font-semibold">{i.number}</p>
            <p className="mt-1"><StatusBadge status={i.status} overdue={i.overdue} /></p>
          </div>
        </header>
        <section className="grid gap-4 border-b border-line py-5 sm:grid-cols-2">
          <div>
            <p className="text-[12px] text-muted">Billed to</p>
            <p className="font-semibold">{d.buyer.name}</p>
            {d.buyer.name !== d.buyer.workspace && <p className="text-muted">Workspace: {d.buyer.workspace}</p>}
            {d.buyer.address && <p className="whitespace-pre-line text-muted">{d.buyer.address}</p>}
            {d.buyer.gstin && <p className="text-muted">GSTIN {d.buyer.gstin}</p>}
            {d.buyer.email && <p className="text-muted">{d.buyer.email}</p>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 sm:justify-self-end">
            <dt className="text-muted">Issued</dt><dd>{day(i.issuedAt)}</dd>
            <dt className="text-muted">Due</dt><dd>{day(i.dueAt)}</dd>
            {i.paidAt && <><dt className="text-muted">Paid</dt><dd>{day(i.paidAt)}</dd></>}
            {i.paymentReference && <><dt className="text-muted">Payment ref.</dt><dd className="break-all">{i.paymentReference}</dd></>}
          </dl>
        </section>
        <table className="my-5 w-full" aria-label="Invoice lines">
          <thead className="text-left text-[12px] text-muted"><tr><th className="py-2">Description</th><th className="py-2 text-right">Amount</th></tr></thead>
          <tbody>
            <tr className="border-t border-line"><td className="py-3 pr-4">{i.description}<p className="text-[12px] text-muted">Service period {day(i.periodStart)} – {day(i.periodEnd)}</p></td><td className="py-3 text-right tabular">{inr(i.subtotal)}</td></tr>
            <tr className="border-t border-line text-muted"><td className="py-2">GST {i.taxRatePct}%</td><td className="py-2 text-right tabular">{inr(i.tax)}</td></tr>
            <tr className="border-t-2 border-ink font-semibold"><td className="py-3">Total</td><td className="py-3 text-right text-[16px] tabular" data-testid="invoice-total">{inr(i.total)}</td></tr>
          </tbody>
        </table>
        {i.status === 'void' && <p className="rounded-[10px] bg-slate-50 px-3 py-2 text-muted">Void: {i.voidReason}</p>}
        <p className="mt-6 text-[12px] text-muted" data-testid="invoice-note">{d.note} Pay by bank transfer or UPI with the invoice number as reference{i.payUrl ? ', or online with the payment link' : ''}.</p>
      </article>
    </div>
  );
}
