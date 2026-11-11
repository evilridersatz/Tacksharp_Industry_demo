'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowRight, BarChart3, CheckCircle2, ChevronDown, CircleDashed, Clock3, IndianRupee, Lock, MessageCircleWarning, PhoneCall, ShoppingBag, Sparkles } from 'lucide-react';
import { useApi } from '@/lib/api';
import { industryDef } from '@/lib/industries';
import { useWorkspace } from '@/lib/industry';
import { useMe, ORDER_STATUS, pickupLabel, qty, type Overview as RestaurantOverviewData } from '@/lib/restaurant';
import { displayName } from '@/lib/format';
import { BarList, ColumnChart, Donut, Ring, Sparkline } from './charts';
import { LiveStamp } from './live-stamp';
import { Badge, Card, CardHeader, Empty, ErrorBanner, Skeleton, cx } from './ui';

type Step = { id: string; label: string; status: 'complete' | 'action_required' | 'in_progress' | 'blocked'; detail: string; action?: { label: string; href: string } };
type Home = {
  business: { name: string; isDemo: boolean };
  readiness: { done: number; total: number; next: { label: string; href: string; why: string } | null };
  checklist: Step[];
  attention: Array<{ id: string; severity: 'critical' | 'warning'; title: string; detail: string; action?: { label: string; href: string } }>;
  activity: Array<{ id: string; at: string; text: string; href: string; tone: 'ok' | 'warn' | 'info' }>;
  mode: { dryRun: boolean };
};
type Period = { orders: number; revenue: number; byChannel: Record<string, number>; calls: number };
type Snapshot = {
  today: Period; yesterday: Period; last7: Period; sameTimeLastWeek: number;
  days: Array<{ date: string; orders: number; revenue: number }>;
  topItems: Array<{ name: string; qty: number; unit: string; revenue: number }>;
  pendingOrders: Array<{ orderNumber: string; minutes: number; total: number }>;
  handoffs: Array<{ minutes: number }>;
  stock: { low: Array<{ name: string; level: 'low' | 'out' }> };
};
type Alert = { id: string; severity: string; title: string; detail: string; href?: string };

const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const short = (v: number) => (v >= 100_000 ? `₹${(v / 100_000).toFixed(1)}L` : v >= 1000 ? `₹${(v / 1000).toFixed(1)}k` : `₹${Math.round(v)}`);
const CHANNEL: Record<string, { label: string; color: string }> = {
  whatsapp: { label: 'WhatsApp', color: '#16a34a' }, voice: { label: 'Phone calls', color: '#7c3aed' }, assistant: { label: 'AI assistant', color: '#0ea5e9' },
  web: { label: 'Website', color: '#f59e0b' }, test: { label: 'Test chat', color: '#94a3b8' }, dashboard: { label: 'Shop counter', color: '#ea580c' },
};
const since = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
const greeting = () => {
  const h = new Date(Date.now() + 330 * 60_000).getUTCHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/**
 * The owner's Home: today's money and orders at a glance, what needs them, this week as pictures, then the details.
 * Numbers come from Jarvis (the business's real records; demo data left out in a live workspace) and GET /home.
 */
export function OwnerHome() {
  const { workspace } = useWorkspace();
  const def = industryDef(workspace?.industry);
  const me = useMe();
  const home = useApi<Home>('/home?range=7d', 60_000);
  const jv = useApi<{ snapshot: Snapshot; alerts: Alert[] }>('/jarvis/overview', 60_000);
  const isRestaurant = workspace?.industry === 'restaurant' || workspace?.industry === 'food';
  const ro = useApi<RestaurantOverviewData>(isRestaurant ? '/restaurant/overview?days=7' : null, 30_000);

  if ((home.error && !home.data) || (jv.error && !jv.data)) return <ErrorBanner message={home.error ?? jv.error ?? ''} onRetry={() => { home.reload(); jv.reload(); }} />;
  if (!home.data || !jv.data) return <Skeleton className="h-[640px] rounded-[20px]" />;
  const h = home.data;
  const s = jv.data.snapshot;
  const accent = def.accent;
  const dayLabel = (iso: string, i: number) => (i === s.days.length - 1 ? 'Today' : new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' }));
  const channels = Object.entries(s.last7.byChannel).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const attention = [
    ...h.attention.map((a) => ({ id: a.id, critical: a.severity === 'critical', title: a.title, detail: a.detail, href: a.action?.href, cta: a.action?.label })),
    ...jv.data.alerts.slice(0, 4).map((a) => ({ id: `alert-${a.id}`, critical: a.severity === 'critical', title: a.title, detail: a.detail, href: a.href ?? '/jarvis/monitors', cta: 'Open' })),
  ];
  const setupDone = h.readiness.done >= h.readiness.total;
  // A live workspace shows only real orders here (same rule as Jarvis); a demo workspace shows its demo orders.
  const pickups = (ro.data?.upcoming ?? []).filter((o) => h.business.isDemo || !o.isDemo);
  const first = (me?.name ?? '').split(/\s+/)[0];

  const tiles = [
    { label: 'Sales today', value: inr(s.today.revenue), sub: `Yesterday ${inr(s.yesterday.revenue)}`, icon: IndianRupee, color: '#059669', bg: '#ecfdf5', spark: s.days.map((d) => d.revenue), href: '/analytics' },
    { label: 'Orders today', value: String(s.today.orders), sub: s.sameTimeLastWeek ? `${s.sameTimeLastWeek} by this time last week` : `${s.yesterday.orders} yesterday`, icon: ShoppingBag, color: accent, bg: def.accentSoft, spark: s.days.map((d) => d.orders), href: '/orders' },
    { label: 'Customers waiting for you', value: String(s.handoffs.length), sub: s.handoffs.length ? `Longest ${Math.max(...s.handoffs.map((x) => x.minutes))} min` : 'Nobody waiting', icon: MessageCircleWarning, color: s.handoffs.length ? '#e11d48' : '#64748b', bg: s.handoffs.length ? '#fff1f2' : '#f1f5f9', href: '/inbox' },
    { label: s.pendingOrders.length ? 'Orders to confirm' : 'Calls today', value: String(s.pendingOrders.length || s.today.calls), sub: s.pendingOrders.length ? `Oldest waiting ${Math.max(...s.pendingOrders.map((p) => p.minutes))} min` : `${s.yesterday.calls} yesterday`, icon: s.pendingOrders.length ? Clock3 : PhoneCall, color: s.pendingOrders.length ? '#d97706' : '#7c3aed', bg: s.pendingOrders.length ? '#fffbeb' : '#f5f3ff', href: s.pendingOrders.length ? '/orders' : '/analytics' },
  ];

  return (
    <div className="grid gap-5" data-testid="owner-home">
      {/* Greeting */}
      <section className="relative overflow-hidden rounded-[22px] p-5 text-white shadow-[var(--shadow-card)] sm:p-7" style={{ background: `linear-gradient(120deg, #0f172a 0%, #1e293b 55%, ${accent} 140%)` }}>
        <div className="pointer-events-none absolute -top-16 -right-10 size-56 rounded-full opacity-25 blur-2xl" style={{ background: accent }} aria-hidden />
        <div className="relative flex flex-wrap items-center gap-5">
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <p className="text-[12.5px] font-semibold text-white/60">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            <h1 className="mt-1 text-[24px] leading-tight font-bold tracking-[-0.02em] sm:text-[30px]">{greeting()}{first ? `, ${first}` : ''}</h1>
            <p className="mt-1.5 text-[14px] text-white/75">Here is {h.business.name} right now.</p>
            <p className="mt-3 flex flex-wrap gap-2 text-[12px] font-semibold">
              <span className={cx('rounded-full px-2.5 py-1', h.mode.dryRun ? 'bg-white/10 text-white/80' : 'bg-emerald-400/20 text-emerald-200')}>{h.mode.dryRun ? 'Test mode: nothing is sent to customers' : '● Live: customers are being served'}</span>
              {h.business.isDemo && <span className="rounded-full bg-amber-300/20 px-2.5 py-1 text-amber-100">Demo workspace</span>}
            </p>
          </div>
          {!setupDone && h.readiness.next && (
            <Link href={h.readiness.next.href} className="flex w-full items-center gap-3 rounded-[16px] sm:w-auto bg-white/10 p-3 pr-4 ring-1 ring-white/15 hover:bg-white/15" data-testid="next-action">
              <span className="rounded-full bg-white p-0.5"><Ring value={h.readiness.done} total={h.readiness.total} color={accent} size={60} label={`Setup ${h.readiness.done} of ${h.readiness.total} done`} /></span>
              <span className="min-w-0">
                <span className="block text-[11.5px] font-semibold text-white/60">Finish setting up</span>
                <span className="flex items-center gap-1 text-[14px] font-semibold">{h.readiness.next.label}<ArrowRight className="size-4" aria-hidden /></span>
              </span>
            </Link>
          )}
        </div>
      </section>

      <LiveStamp at={jv.updatedAt} every="updates the moment an order, call or message arrives" />

      {/* Today at a glance */}
      <ul className="-mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Today at a glance">
        {tiles.map((t) => (
          <li key={t.label}>
            <Link href={t.href} className="block h-full rounded-[18px] border border-line bg-white p-4 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:border-slate-300">
              <span className="flex items-center gap-2">
                <span className="grid size-9 place-items-center rounded-[12px]" style={{ background: t.bg, color: t.color }}><t.icon className="size-[18px]" aria-hidden /></span>
                <span className="text-[12.5px] leading-tight font-semibold text-muted">{t.label}</span>
              </span>
              <span className="mt-3 block text-[26px] leading-none font-bold tracking-[-0.02em] text-ink tabular sm:text-[30px]">{t.value}</span>
              <span className="mt-1.5 block truncate text-[12px] text-muted">{t.sub}</span>
              {t.spark && <span className="mt-2 block"><Sparkline values={t.spark} color={t.color} /></span>}
            </Link>
          </li>
        ))}
      </ul>

      {/* Needs you */}
      {attention.length > 0 && (
        <section aria-labelledby="needs-h">
          <h2 id="needs-h" className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-ink"><AlertTriangle className="size-4 text-amber-600" aria-hidden />Needs you ({attention.length})</h2>
          <ul className="grid gap-2 md:grid-cols-2">
            {attention.map((a) => (
              <li key={a.id} className={cx('flex items-start gap-3 rounded-[14px] border bg-white p-3.5', a.critical ? 'border-rose-200' : 'border-amber-200')}>
                <span className={cx('mt-0.5 grid size-8 shrink-0 place-items-center rounded-full', a.critical ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-600')}><AlertTriangle className="size-4" aria-hidden /></span>
                <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-semibold text-ink">{a.title}</span><span className="block text-[12.5px] text-body">{a.detail}</span></span>
                {a.href && <Link href={a.href} className="shrink-0 rounded-[10px] bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-ink/90">{a.cta ?? 'Open'}</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* This week in pictures */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Sales this week" subtitle={`${inr(s.last7.revenue)} from ${s.last7.orders} orders in 7 days`} action={<Link href="/analytics" className="text-[12.5px] font-semibold" style={{ color: accent }}>More →</Link>} />
          <div className="px-4 pb-5 sm:px-6">
            {s.last7.orders ? <ColumnChart labels={s.days.map((d, i) => dayLabel(d.date, i))} values={s.days.map((d) => d.revenue)} color={accent} format={short} /> : <Empty icon={<BarChart3 className="size-7" />} title="No sales yet this week">When customers order, each day’s sales appear here as a bar.</Empty>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Where orders come from" subtitle="Last 7 days" />
          {channels.length ? (
            <div className="flex flex-wrap items-center gap-5 px-5 pb-5">
              <Donut parts={channels.map(([k, v]) => ({ value: v, color: CHANNEL[k]?.color ?? '#94a3b8' }))} total={s.last7.orders} label="orders" />
              <ul className="flex min-w-[140px] flex-1 flex-col gap-2">
                {channels.map(([k, v]) => (
                  <li key={k} className="flex items-center gap-2 text-[13px]">
                    <span className="size-3 rounded-[4px]" style={{ background: CHANNEL[k]?.color ?? '#94a3b8' }} aria-hidden />
                    <span className="flex-1 text-body">{CHANNEL[k]?.label ?? k}</span>
                    <b className="text-ink tabular">{v}</b>
                    <span className="w-10 text-right text-[11.5px] text-muted">{Math.round((v / Math.max(1, s.last7.orders)) * 100)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : <Empty title="No orders yet">WhatsApp, phone and website orders are counted here.</Empty>}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Best sellers" subtitle="By sales, last 7 days" action={<Link href="/menu" className="text-[12.5px] font-semibold" style={{ color: accent }}>Menu →</Link>} />
          <div className="px-5 pb-5">
            {s.topItems.length ? <BarList labels={s.topItems.map((i) => `${i.name} · ${i.qty} ${i.unit}`)} values={s.topItems.map((i) => i.revenue)} color={accent} format={inr} /> : <p className="text-[13px] text-muted">Nothing sold yet this week.</p>}
            {s.stock.low.length > 0 && <p className="mt-4 rounded-[10px] bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900"><b>Stock:</b> {s.stock.low.slice(0, 3).map((x) => `${x.name} ${x.level === 'out' ? 'is out' : 'is low'}`).join(', ')}</p>}
          </div>
        </Card>
        {isRestaurant ? (
          <Card className="xl:col-span-2">
            <CardHeader title="Next pickups" subtitle="What to cut and pack next" action={<Link href="/orders/board" className="text-[12.5px] font-semibold" style={{ color: accent }}>Live board →</Link>} />
            {!ro.data ? <Skeleton className="mx-5 mb-5 h-32" /> : !pickups.length ? <Empty icon={<ShoppingBag className="size-6" />} title="No orders to prepare">Confirmed orders appear here by pickup time.</Empty> : (
              <ul className="divide-y divide-line border-t border-line">
                {pickups.slice(0, 5).map((r) => (
                  <li key={r.id}>
                    <Link href={`/orders/${r.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50/70">
                      <span className="grid w-16 shrink-0 place-items-center rounded-[12px] py-1.5 text-center" style={{ background: def.accentSoft, color: accent }}>
                        <span className="text-[13px] leading-tight font-bold">{pickupLabel(r.pickupAt).replace(/^(Today|Tomorrow) /, '')}</span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-semibold text-ink">{displayName({ name: r.customerName, phone: r.customerPhone })}</span>
                        <span className="block truncate text-[12px] text-muted">{r.items.map((i) => `${qty(i.quantity, i.unit)} ${i.name}`).join(', ')}</span>
                      </span>
                      <Badge tone={ORDER_STATUS[r.status].tone}>{ORDER_STATUS[r.status].label}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : (
          <ActivityCard h={h} className="xl:col-span-2" />
        )}
      </div>

      {isRestaurant && <ActivityCard h={h} />}

      {/* Setup, folded */}
      <details className="group rounded-[var(--radius-card)] border border-line bg-white shadow-[var(--shadow-card)]" open={!setupDone && h.readiness.done < 3}>
        <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
          <Ring value={h.readiness.done} total={h.readiness.total} color={accent} size={46} />
          <span className="min-w-0 flex-1"><span className="block text-[14px] font-semibold text-ink">Setup {setupDone ? 'complete' : 'checklist'}</span><span className="block text-[12.5px] text-muted">{setupDone ? 'Everything is connected.' : `${h.readiness.total - h.readiness.done} step(s) left. Steps turn green only when they really work.`}</span></span>
          <ChevronDown className="size-4 text-muted transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <ol className="grid gap-x-6 border-t border-line px-5 py-2 md:grid-cols-2">
          {h.checklist.map((c) => {
            const Icon = c.status === 'complete' ? CheckCircle2 : c.status === 'blocked' ? Lock : CircleDashed;
            return (
              <li key={c.id} className="flex items-start gap-3 border-b border-line py-3 last:border-0 md:[&:nth-last-child(2)]:border-0" data-status={c.status}>
                <Icon className={cx('mt-0.5 size-[18px] shrink-0', c.status === 'complete' ? 'text-brand' : c.status === 'blocked' ? 'text-slate-400' : 'text-amber')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold text-ink">{c.label}</span>
                  <span className="block text-[12.5px] text-body">{c.detail}</span>
                  {c.action && c.status !== 'complete' && <Link href={c.action.href} className="mt-1 inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-dark hover:underline">{c.action.label}<ArrowRight className="size-3.5" aria-hidden /></Link>}
                </span>
              </li>
            );
          })}
        </ol>
      </details>

      <p className="flex items-center gap-1.5 text-[12px] text-muted"><Sparkles className="size-3.5" aria-hidden />Want the full picture? Open <Link href="/jarvis" className="font-semibold underline">Jarvis</Link> for today’s briefing or <Link href="/analytics" className="font-semibold underline">Sales &amp; analytics</Link> for every number.</p>
    </div>
  );
}

function ActivityCard({ h, className }: { h: Home; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader title="What just happened" subtitle="Orders, calls and messages, newest first" />
      {h.activity.length === 0 ? <Empty title="Nothing has happened yet">New orders, calls and messages appear here.</Empty> : (
        <ol className="grid border-t border-line px-5 py-1 md:grid-cols-2 md:gap-x-6">
          {h.activity.slice(0, 8).map((a) => (
            <li key={a.id} className="border-b border-line last:border-0">
              <Link href={a.href} className="flex items-center gap-3 py-2.5 hover:opacity-80">
                <span className={cx('size-2 shrink-0 rounded-full', a.tone === 'ok' ? 'bg-brand' : a.tone === 'warn' ? 'bg-amber' : 'bg-sky-500')} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{a.text}</span>
                <time className="shrink-0 text-[11.5px] text-faint" dateTime={a.at}>{since(a.at)}</time>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
