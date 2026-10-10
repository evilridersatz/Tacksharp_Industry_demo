'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, CalendarDays, Globe, IndianRupee, MessageCircle, MessageSquare, Phone, ShoppingBag, TrendingUp } from 'lucide-react';
import { useApi } from '@/lib/api';
import { dateTime, displayName, timeAgo } from '@/lib/format';
import { CHANNEL_LABEL, ORDER_STATUS, inr, plain, type Overview } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Card, CardHeader, Empty, ErrorBanner, IconTile, Skeleton } from '@/components/ui';
import { TrendChart } from '@/components/charts';

const STATUS_ORDER = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'] as const;
const CHANNEL_ICON = { web: Globe, whatsapp: MessageCircle, voice: Phone } as const;

export function DemoBanner({ children }: { children?: React.ReactNode }) {
  return (
    <div role="note" className="mb-4 flex items-start gap-2.5 rounded-[12px] border border-amber-soft bg-[#fffbeb] px-4 py-3 text-[13px] text-[#92400e]">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>
        {children ?? (
          <>
            <b>Demo data.</b> Menu items, prices and outlets are placeholders, not verified GR Chicken information. Orders are not sent to any POS and no payment is taken.
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

export function RestaurantOverview() {
  const [days, setDays] = useState('7');
  const { data: o, error, reload, loading } = useApi<Overview>(`/restaurant/overview?days=${days}`);
  const labels = o?.series.map((d) => new Date(d.day).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })) ?? [];

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
            <Kpi label="Customer enquiries" value={o.enquiries.inRange} sub={`${o.enquiries.total} conversations in total`} icon={<MessageSquare className="size-4" />} tone="sky" />
            <Kpi label="Orders" value={o.orders.inRange} sub={`${o.orders.conversionRate}% of enquiries ordered · ${o.orders.total} all time`} icon={<ShoppingBag className="size-4" />} tone="brand" />
            <Kpi label="Today" value={o.orders.today} sub={`${inr(o.sales.today)} in orders (excl. cancelled)`} icon={<TrendingUp className="size-4" />} tone="violet" />
            <Kpi label={`Order value, last ${o.days} days`} value={inr(o.sales.inRange)} sub="Placed orders, not payments received" icon={<IndianRupee className="size-4" />} tone="amber" />
          </>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader title="Orders per day" subtitle="IST business days" />
          <div className="px-3 pb-3">
            {o ? (
              o.orders.inRange ? (
                <TrendChart labels={labels} series={[{ name: 'Orders', values: o.series.map((d) => d.orders), color: '#0f9f6e' }]} />
              ) : (
                <Empty icon={<ShoppingBag className="size-6" />} title="No orders in this period yet">
                  Orders placed through the website chat or WhatsApp appear here.
                </Empty>
              )
            ) : (
              <Skeleton className="h-[220px]" />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Order status" subtitle="All orders" action={<Link href="/orders" className="text-[12.5px] font-semibold text-brand">Live orders →</Link>} />
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

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Recent orders" action={<Link href="/orders" className="text-[12.5px] font-semibold text-brand">View all →</Link>} />
          {o && !o.recentOrders.length ? (
            <Empty icon={<ShoppingBag className="size-6" />} title="No orders yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead>
                  <tr className="border-y border-line bg-slate-50/60 text-left text-[11.5px] font-semibold tracking-wide text-muted uppercase">
                    <th className="px-5 py-2">Order</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Outlet</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-5 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(o?.recentOrders ?? []).map((r) => (
                    <tr key={r.id} className="border-b border-line last:border-0 hover:bg-slate-50/60">
                      <td className="px-5 py-2.5">
                        <Link href={`/orders?id=${r.id}`} className="font-semibold text-ink hover:text-brand">
                          {r.orderNumber}
                        </Link>
                        <p className="text-[11.5px] text-faint">{timeAgo(r.createdAt)} ago · {CHANNEL_LABEL[r.channel] ?? r.channel}</p>
                      </td>
                      <td className="px-3 py-2.5">{displayName({ name: r.customerName, phone: r.customerPhone })}</td>
                      <td className="px-3 py-2.5 text-muted">{r.outlet.name}</td>
                      <td className="tabular px-3 py-2.5 text-right font-semibold text-ink">{inr(r.total)}</td>
                      <td className="px-5 py-2.5">
                        <Badge tone={ORDER_STATUS[r.status].tone}>{ORDER_STATUS[r.status].label}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Channels" subtitle="Conversations and orders by channel" />
          <ul className="flex flex-col gap-3 px-5 pb-5">
            {(o?.channels ?? []).map((c) => {
              const Icon = CHANNEL_ICON[c.channel as keyof typeof CHANNEL_ICON] ?? Globe;
              return (
                <li key={c.channel} className="flex items-center gap-3">
                  <IconTile tone={c.channel === 'whatsapp' ? 'brand' : c.channel === 'voice' ? 'violet' : 'sky'} size="sm">
                    <Icon className="size-4" />
                  </IconTile>
                  <div className="flex-1">
                    <p className="text-[13px] font-semibold text-ink">{CHANNEL_LABEL[c.channel] ?? c.channel}</p>
                    <p className="text-[12px] text-muted">
                      {c.conversations} conversations · {c.orders} orders
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Recent conversations"
          subtitle={o?.handoffsOpen ? `${o.handoffsOpen} waiting for staff` : undefined}
          action={<Link href="/conversations" className="text-[12.5px] font-semibold text-brand">Open inbox →</Link>}
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
                      {c.customer ? displayName(c.customer) : 'Website visitor'}
                      <Badge tone="slate">{CHANNEL_LABEL[c.channel] ?? c.channel}</Badge>
                      {c.status === 'human_handoff' && <Badge tone="rose">Needs staff</Badge>}
                    </p>
                    <p className="truncate text-[12.5px] text-muted">
                      {c.lastMessage ? `${c.lastMessage.role === 'user' ? '' : 'AI: '}${plain(c.lastMessage.content)}` : '—'}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11.5px] text-faint">{dateTime(c.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
