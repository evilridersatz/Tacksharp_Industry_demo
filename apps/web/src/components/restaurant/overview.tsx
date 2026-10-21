'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, CalendarDays, Clock, Gift, IndianRupee, MessageSquare, PhoneCall, ShoppingBag } from 'lucide-react';
import { useApi } from '@/lib/api';
import { dateTime, displayName } from '@/lib/format';
import { CHANNEL_LABEL, ORDER_STATUS, READY_NOTICE, inr, pickupLabel, plain, qty, type Overview } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Card, CardHeader, Empty, ErrorBanner, IconTile, Skeleton } from '@/components/ui';
import { TrendChart } from '@/components/charts';

const STATUS_ORDER = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'] as const;

export function DemoBanner({ children }: { children?: React.ReactNode }) {
  return (
    <div role="note" className="mb-4 flex items-start gap-2.5 rounded-[12px] border border-amber-soft bg-[#fffbeb] px-4 py-3 text-[13px] text-[#92400e]">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>
        {children ?? (
          <>
            <b>Demo data.</b> Products, per-kg prices and the shop address are placeholders, not verified GR Chicken information. Orders are not sent to any POS and no payment is taken.
          </>
        )}
      </span>
    </div>
  );
}

function Kpi({ label, value, sub, icon, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon: React.ReactNode; tone: 'brand' | 'violet' | 'amber' | 'sky' | 'rose' }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] font-medium text-muted">{label}</p>
        <IconTile tone={tone} size="sm">
          {icon}
        </IconTile>
      </div>
      <p className="tabular mt-2 text-[26px] font-bold tracking-[-0.01em] text-ink">{value}</p>
      {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
    </Card>
  );
}

function Funnel({ o }: { o: Overview }) {
  const steps = [
    { label: 'Offers created', value: o.offers.total },
    { label: 'Message sent', value: o.offers.sent },
    { label: 'Customer chatting', value: o.offers.started },
    { label: 'Claimed (ordered)', value: o.offers.claimed },
  ];
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <ul className="flex flex-col gap-3 px-5 pb-5">
      {steps.map((s) => (
        <li key={s.label}>
          <div className="flex justify-between text-[12.5px]">
            <span className="text-body">{s.label}</span>
            <span className="tabular font-semibold text-ink">{s.value}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-brand" style={{ width: `${(s.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
      {o.offers.notSent > 0 && (
        <li className="text-[12px] text-[#b45309]">
          {o.offers.notSent} offer message{o.offers.notSent > 1 ? 's' : ''} not sent yet — see <Link href="/offers" className="font-semibold underline">Offer</Link>.
        </li>
      )}
    </ul>
  );
}

export function RestaurantOverview() {
  const [days, setDays] = useState('7');
  const { data: o, error, reload, loading } = useApi<Overview>(`/restaurant/overview?days=${days}`);
  const labels = o?.series.map((d) => new Date(d.day).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })) ?? [];
  const calls = o ? (o.readyNotices.answered ?? 0) : 0;
  const notified = o ? Object.entries(o.readyNotices).filter(([k]) => ['answered', 'whatsapp_sent'].includes(k)).reduce((s, [, v]) => s + v, 0) : 0;

  return (
    <>
      <PageHeader
        title="Overview"
        actions={
          <label className="relative inline-flex h-9 items-center gap-2 rounded-[10px] border border-line bg-white pr-2 pl-3 text-[13px] font-semibold text-ink">
            <CalendarDays className="size-4 text-muted" />
            <select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)} className="bg-transparent pr-1 outline-none">
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </label>
        }
      />
      {o?.demoData && <DemoBanner />}
      {error && !o && <ErrorBanner message={error} onRetry={reload} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading && !o ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[112px] rounded-[14px]" />)
        ) : o ? (
          <>
            <Kpi label="₹50 offers claimed" value={`${o.offers.claimed}/${o.offers.sent}`} sub={`${o.offers.claimRate}% of offers sent turned into orders`} icon={<Gift className="size-4" />} tone="violet" />
            <Kpi label="Orders" value={o.orders.inRange} sub={`${o.orders.active} active now`} icon={<ShoppingBag className="size-4" />} tone="brand" />
            <Kpi label="Pickups today" value={o.orders.pickupsToday} sub={`${calls} ready calls answered · ${notified} customers told`} icon={<Clock className="size-4" />} tone="sky" />
            <Kpi label={`Order value, ${o.days} days`} value={inr(o.sales.inRange)} sub={`${inr(o.sales.discountGiven)} offer discount given · not payments`} icon={<IndianRupee className="size-4" />} tone="amber" />
          </>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Next pickups" subtitle="Active orders by collection time — what to cut next" action={<Link href="/orders" className="text-[12.5px] font-semibold text-brand">Live orders →</Link>} />
          {o && !o.upcoming.length ? (
            <Empty icon={<ShoppingBag className="size-6" />} title="No active orders">
              Orders confirmed on WhatsApp appear here.
            </Empty>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {(o?.upcoming ?? []).map((r) => (
                <li key={r.id}>
                  <Link href={`/orders?id=${r.id}`} className="grid grid-cols-[110px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 hover:bg-slate-50/60">
                    <span>
                      <span className="block text-[13px] font-bold text-ink">{pickupLabel(r.pickupAt).replace(/^(Today|Tomorrow) /, '')}</span>
                      <span className="text-[11.5px] text-faint">{pickupLabel(r.pickupAt).startsWith('Today') ? 'Today' : pickupLabel(r.pickupAt).startsWith('Tomorrow') ? 'Tomorrow' : pickupLabel(r.pickupAt).split(',')[0]}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-ink">
                        {displayName({ name: r.customerName, phone: r.customerPhone })} · {r.orderNumber}
                      </span>
                      <span className="block truncate text-[12px] text-muted">{r.items.map((i) => `${qty(i.quantity, i.unit)} ${i.name}${i.cut ? ` (${i.cut})` : ''}`).join(', ')}</span>
                    </span>
                    <span className="flex flex-col items-end gap-1">
                      <Badge tone={ORDER_STATUS[r.status].tone}>{ORDER_STATUS[r.status].label}</Badge>
                      {r.readyNotice && READY_NOTICE[r.readyNotice] && <Badge tone={READY_NOTICE[r.readyNotice].tone}>{READY_NOTICE[r.readyNotice].label}</Badge>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="₹50 offer funnel" subtitle={`Last ${days} days`} action={<Link href="/offers" className="text-[12.5px] font-semibold text-brand">Offer →</Link>} />
            {o ? <Funnel o={o} /> : <Skeleton className="m-5 h-32" />}
          </Card>
          <Card>
            <CardHeader title="Order status" subtitle="All orders" />
            <ul className="px-5 pb-4">
              {STATUS_ORDER.map((s) => (
                <li key={s} className="flex items-center justify-between border-b border-line py-2 text-[13px] last:border-0">
                  <Badge tone={ORDER_STATUS[s].tone} dot>
                    {ORDER_STATUS[s].label}
                  </Badge>
                  <span className="tabular font-semibold text-ink">{o?.orders.byStatus[s] ?? 0}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Orders per day" subtitle="IST business days" />
          <div className="px-3 pb-3">
            {o ? (
              o.orders.inRange ? (
                <TrendChart labels={labels} series={[{ name: 'Orders', values: o.series.map((d) => d.orders), color: '#0f9f6e' }]} />
              ) : (
                <Empty icon={<ShoppingBag className="size-6" />} title="No orders in this period yet" />
              )
            ) : (
              <Skeleton className="h-[220px]" />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Recent conversations"
            subtitle={o?.handoffsOpen ? `${o.handoffsOpen} waiting for staff` : undefined}
            action={<Link href="/conversations" className="text-[12.5px] font-semibold text-brand">Inbox →</Link>}
          />
          {o && !o.recentConversations.length ? (
            <Empty icon={<MessageSquare className="size-6" />} title="No conversations yet" />
          ) : (
            <ul className="divide-y divide-line">
              {(o?.recentConversations ?? []).map((c) => (
                <li key={c.id}>
                  <Link href={`/conversations?id=${c.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50/60">
                    <Avatar person={c.customer} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                        {displayName(c.customer)}
                        <Badge tone="slate">
                          {c.channel === 'voice' && <PhoneCall className="size-3" />}
                          {CHANNEL_LABEL[c.channel] ?? c.channel}
                        </Badge>
                        {c.status === 'human_handoff' && <Badge tone="rose">Needs staff</Badge>}
                      </p>
                      <p className="truncate text-[12.5px] text-muted">{c.lastMessage ? `${c.lastMessage.role === 'user' ? '' : 'AI: '}${plain(c.lastMessage.content)}` : '—'}</p>
                    </div>
                    <span className="shrink-0 text-[11.5px] text-faint">{dateTime(c.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
