'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Search, ShoppingBag } from 'lucide-react';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { OrderPipeline } from '@/components/restaurant/pipeline';
import { displayName, timeAgo } from '@/lib/format';
import { CHANNEL_LABEL, ORDER_STATUS, READY_NOTICE, inr, pickupLabel, qty, useMe, type Order } from '@/lib/restaurant';
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
  const { data: allOrders, error, reload, loading } = useApi<Order[]>(`/restaurant/orders?${query}`, 8_000);
  // A live workspace hides demo (seed) orders unless asked; a demo workspace shows them (they are all it has).
  const { workspace } = useWorkspace();
  const [showDemo, setShowDemo] = useState(false);
  const demoCount = (allOrders ?? []).filter((o) => o.isDemo).length;
  const orders = allOrders && (workspace?.isDemo || showDemo ? allOrders : allOrders.filter((o) => !o.isDemo));

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
      {!workspace?.isDemo && demoCount > 0 && (
        <label className="mb-3 flex w-fit items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] text-body">
          <input type="checkbox" className="size-4" checked={showDemo} onChange={(e) => setShowDemo(e.target.checked)} />
          Show {demoCount} demo order{demoCount === 1 ? '' : 's'} (sample data, not real customers)
        </label>
      )}
      {error && !orders && <ErrorBanner message={error} onRetry={reload} />}
      <OrderPipeline includeDemo={Boolean(workspace?.isDemo || showDemo)} onPick={(st) => setFilter(st === 'pending' ? 'pending' : st === 'completed' ? 'completed' : 'active')} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-full overflow-x-auto pane-scroll">
        <Segmented<Filter>
          label="Order filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'pending', label: 'New' },
            { value: 'completed', label: 'Collected' },
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
              Orders confirmed on WhatsApp show up here automatically, sorted by pickup time.
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {orders.map((o) => (
                <li key={o.id}>
                  <button
                    onClick={() => select(o.id)}
                    aria-current={selected === o.id ? 'true' : undefined}
                    className={cx('grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-5 py-3 text-left hover:bg-slate-50/70 md:grid-cols-[130px_minmax(0,1fr)_84px_140px]', selected === o.id && 'bg-brand-soft/40')}
                  >
                    <div>
                      <p className="text-[13.5px] font-bold text-ink">{pickupLabel(o.pickupAt)}</p>
                      <p className="text-[11.5px] text-faint">
                        {o.orderNumber} · {CHANNEL_LABEL[o.channel] ?? o.channel}
                      </p>
                    </div>
                    <p className="tabular text-right text-[13.5px] font-bold text-ink md:order-3">
                      {inr(o.total)}
                      {o.discount > 0 && <span className="block text-[11px] font-semibold text-violet">−₹{o.discount} offer</span>}
                    </p>
                    <div className="col-span-2 min-w-0 md:order-2 md:col-span-1">
                      <p className="truncate text-[13px] font-semibold text-ink">{displayName({ name: o.customerName, phone: o.customerPhone })}</p>
                      <p className="truncate text-[12.5px] text-body">{o.items.map((i) => `${qty(i.quantity, i.unit)} ${i.name}${i.cut ? ` · ${i.cut}` : ''}`).join(', ')}</p>
                    </div>
                    <div className="col-span-2 flex flex-wrap gap-1 md:order-4 md:col-span-1 md:flex-col md:items-start">
                      <Badge tone={ORDER_STATUS[o.status].tone} dot>
                        {ORDER_STATUS[o.status].label}
                      </Badge>
                      {o.readyNotice && READY_NOTICE[o.readyNotice] && <Badge tone={READY_NOTICE[o.readyNotice].tone}>{READY_NOTICE[o.readyNotice].label}</Badge>}
                      {o.paymentStatus === 'paid' && <Badge tone="brand">Paid</Badge>}
                      {o.complaintStatus === 'open' && <Badge tone="rose">Complaint</Badge>}
                      {o.isDemo && <Badge tone="amber">Demo</Badge>}
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
