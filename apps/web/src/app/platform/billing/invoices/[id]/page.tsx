'use client';

import { useParams } from 'next/navigation';
import { PlatformFrame } from '@/components/platform';
import { InvoicePrint } from '@/components/invoice-print';

export default function PlatformInvoice() {
  const { id } = useParams<{ id: string }>();
  return (
    <PlatformFrame title="Invoice">
      <InvoicePrint path={`/platform/billing/invoices/${encodeURIComponent(id)}`} back="/platform/billing" />
    </PlatformFrame>
  );
}
