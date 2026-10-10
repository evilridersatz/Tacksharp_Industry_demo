'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Search, ShoppingBag } from 'lucide-react';
import { useApi } from '@/lib/api';
import { displayName, timeAgo } from '@/lib/format';
import { CHANNEL_LABEL, ORDER_STATUS, inr, useMe, type Order } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Badge, Card, Empty, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { OrderPanel } from '@/components/restaurant/order-panel';
import { DemoBanner } from '@/components/restaurant/overview';

type Filter = 'active' | 'pending' | 'completed' | 'cancelled' | 'all';

export default function OrdersPage() {
  return (
    <Suspense>
      <Orders />
    </Suspense>
  );
}

function Orders() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const [filter, setFilter] = useState<Filter>('active');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const selected = params.get('id');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const query = new URLSearchParams();
  if (filter !== 'all') query.set('status', filter);
  if (debounced.trim()) query.set('q', debounced.trim());
  const { data: orders, error, reload, loading } = useApi<Order[]>(`/restaurant/orders?${query}`, 8_000);

  const select = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('id', id);
    else next.delete('id');
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  return (
    <>
      <PageHeader title="Live orders" crumb="Orders" />
      {orders?.some((o) => o.isDemo) && <DemoBanner />}
      {error && !orders && <ErrorBanner message={error} onRetry={reload} />}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-full overflow-x-auto pane-scroll">
        <Segmented<Filter>
          label="Order filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'pending', label: 'Needs confirmation' },
            { value: 'completed', label: 'Completed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'all', label: 'All' },
          ]}
        />
        </div>
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Order no, name or phone"
            aria-label="Search orders"
            className="h-9 w-full rounded-[10px] border border-line bg-white pr-3 pl-9 text-[13px] text-ink placeholder:text-faint sm:w-[260px]"
          />
        </div>
      </div>

      <div className={cx('grid grid-cols-1 gap-4', selected && 'xl:grid-cols-[minmax(0,1fr)_480px]')}>
        <Card className={cx(selected && 'hidden xl:block')}>
          {loading && !orders ? (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : !orders?.length ? (
            <Empty icon={<ShoppingBag className="size-6" />} title={debounced ? 'No orders match your search' : 'No orders here'}>
              New orders from the website chat and WhatsApp show up here automatically.
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {orders.map((o) => (
                <li key={o.id}>
                  <button
                    onClick={() => select(o.id)}
                    aria-current={selected === o.id ? 'true' : undefined}
                    className={cx('grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-5 py-3 text-left hover:bg-slate-50/70 md:grid-cols-[130px_minmax(0,1fr)_90px_minmax(150px,auto)]', selected === o.id && 'bg-brand-soft/40')}
                  >
                    <div>
                      <p className="text-[13.5px] font-bold text-ink">{o.orderNumber}</p>
                      <p className="text-[11.5px] text-faint">
                        {timeAgo(o.createdAt)} ago · {CHANNEL_LABEL[o.channel] ?? o.channel}
                      </p>
                    </div>
                    <p className="tabular text-right text-[13.5px] font-bold text-ink md:order-3">{inr(o.total)}</p>
                    <div className="col-span-2 min-w-0 md:order-2 md:col-span-1">
                      <p className="truncate text-[13px] font-semibold text-ink">{displayName({ name: o.customerName, phone: o.customerPhone })}</p>
                      <p className="truncate text-[12px] text-muted">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</p>
                      <p className="truncate text-[11.5px] text-faint">
                        {o.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'} · {o.outlet.name}
                      </p>
                    </div>
                    <div className="col-span-2 md:order-4 md:col-span-1">
                      <Badge tone={ORDER_STATUS[o.status].tone} dot>
                        {ORDER_STATUS[o.status].label}
                      </Badge>
                      {o.paymentStatus === 'paid' && (
                        <Badge tone="brand" className="ml-1">
                          Paid
                        </Badge>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {selected && (
          <div className="xl:sticky xl:top-5 xl:self-start">
            <OrderPanel orderId={selected} onClose={() => select(null)} onChanged={reload} canEdit={!!me && me.role !== 'viewer'} />
          </div>
        )}
      </div>
    </>
  );
}
