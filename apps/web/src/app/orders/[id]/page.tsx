'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { useApi } from '@/lib/api';
import { useMe, type Order } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui';
import { OrderPanel } from '@/components/restaurant/order-panel';

/** One order on its own page (shareable link, printable): everything the side panel shows, full width. */
export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const { data: order } = useApi<Order>(`/restaurant/orders/${id}`, 0);
  return (
    <>
      <PageHeader title={order ? `Order ${order.orderNumber}` : 'Order'} crumb="Orders" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href="/orders" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink">
          <ArrowLeft className="size-4" /> All orders
        </Link>
        <Button variant="secondary" onClick={() => window.print()}>
          <Printer className="size-4" /> Print
        </Button>
      </div>
      <div className="mx-auto max-w-[980px]">
        <OrderPanel orderId={id} canEdit={!!me && me.role !== 'viewer'} />
      </div>
    </>
  );
}
