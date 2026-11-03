'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/shell';
import { InvoicePrint } from '@/components/invoice-print';

export default function OrgInvoice() {
  const { id } = useParams<{ id: string }>();
  return (
    <>
      <div className="print:hidden"><PageHeader title="Invoice" crumb="Setup / Plan & billing" /></div>
      <InvoicePrint path={`/billing/invoices/${encodeURIComponent(id)}`} back="/settings/billing" />
    </>
  );
}
