'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  BarChart3,
  Bell,
  CalendarCheck,
  Columns3,
  Headset,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  MessageSquare,
  Phone,
  Search,
  Settings,
  ShoppingBag,
  UtensilsCrossed,
  Users,
  Gift,
  FlaskConical,
  PlugZap,
  Activity,
  X,
} from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Summary } from '@/lib/types';
import { forgetMe, useMe, type Overview } from '@/lib/restaurant';
import { cx } from './ui';

type Badges = { live?: number; handoff?: number; orders?: number };
type NavGroup = { section: string; items: Array<{ href: string; label: string; icon: typeof LayoutDashboard; badge?: keyof Badges }> };

/** Restaurant tenants (GR Chicken): orders-first navigation. */
const RESTAURANT_NAV: NavGroup[] = [
  {
    section: 'Main',
    items: [
      { href: '/', label: 'Overview', icon: LayoutDashboard },
      { href: '/orders', label: 'Live orders', icon: ShoppingBag, badge: 'orders' },
      { href: '/conversations', label: 'Conversations', icon: MessageSquare, badge: 'handoff' },
      { href: '/follow-ups', label: 'Follow-ups', icon: ListChecks },
      { href: '/customers', label: 'Customers', icon: Users },
    ],
  },
  {
    section: 'Shop',
    items: [
      { href: '/offers', label: '₹50 Offer', icon: Gift },
      { href: '/menu', label: 'Products & rates', icon: UtensilsCrossed },
      { href: '/activity', label: 'Carts, stock & messages', icon: Activity },
      { href: '/test-chat', label: 'Test chat', icon: FlaskConical },
    ],
  },
  {
    section: 'Setup',
    items: [{ href: '/integrations', label: 'Settings & integrations', icon: PlugZap }],
  },
];

const NAV: NavGroup[] = [
  {
    section: 'Main',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/leads', label: 'Leads & CRM', icon: Columns3 },
      { href: '/conversations', label: 'Conversations', icon: MessageSquare },
      { href: '/calls', label: 'Voice calls', icon: Phone, badge: 'live' },
      { href: '/performance', label: 'Performance & ROI', icon: BarChart3 },
    ],
  },
  {
    section: 'Pipeline',
    items: [
      { href: '/follow-ups', label: 'Follow-ups', icon: ListChecks },
      { href: '/site-visits', label: 'Site visits', icon: CalendarCheck },
      { href: '/handoffs', label: 'Human handoff', icon: Headset, badge: 'handoff' },
    ],
  },
  {
    section: 'Setup',
    items: [{ href: '/settings', label: 'Settings', icon: Settings }],
  },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <span className="grid size-9 place-items-center rounded-full bg-[conic-gradient(from_200deg,#7c5cf0,#e11d48,#f59e0b,#7c5cf0)]">
        <span className="size-3.5 rounded-full border-[3px] border-white bg-sidebar" />
      </span>
      <div className="leading-tight">
        <p className="text-[15px] font-bold text-white">Tacksharp.ai</p>
        <p className="text-[11px] text-slate-400">AI employees platform</p>
      </div>
    </div>
  );
}

function NavList({ nav, badges, onNavigate }: { nav: NavGroup[]; badges: Badges; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="mt-6 flex flex-col gap-5">
      {nav.map((group) => (
        <div key={group.section}>
          <p className="px-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-slate-500 uppercase">{group.section}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              const count = item.badge ? badges[item.badge] : undefined;
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'flex h-9 items-center gap-3 rounded-[10px] px-3 text-[13.5px]',
                      active ? 'bg-sidebar-2 font-semibold text-white' : 'text-slate-400 hover:bg-sidebar-2/60 hover:text-slate-200',
                    )}
                  >
                    <Icon className={cx('size-[17px]', active && 'text-brand')} />
                    <span className="flex-1">{item.label}</span>
                    {!!count && (
                      <span
                        className={cx(
                          'min-w-6 rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold text-white',
                          item.badge === 'handoff' ? 'bg-rose' : item.badge === 'orders' ? 'bg-amber' : 'bg-violet',
                        )}
                      >
                        {item.badge === 'live' ? `${count} live` : count}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function AutomationCard({ summary }: { summary: Summary | null }) {
  const pending = summary?.followUpsPending ?? 0;
  const contacted = summary ? summary.funnel[1]?.count ?? 0 : 0;
  const total = summary?.leads.total ?? 0;
  const share = total ? Math.round((contacted / total) * 100) : 0;
  return (
    <div className="rounded-[12px] border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center justify-between text-[12px] font-semibold text-white">
        <span>Leads reached by AI</span>
        <span className="text-brand">{share}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-gradient-to-r from-brand to-sky" style={{ width: `${share}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-slate-400">
        {contacted} of {total} leads contacted · {pending} follow-ups queued
      </p>
    </div>
  );
}

function UserCard() {
  const me = useMe();
  const name = me?.name ?? me?.email ?? '…';
  async function logout() {
    await api.post('/auth/logout').catch(() => undefined);
    forgetMe();
    window.location.href = '/login';
  }
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="grid size-9 place-items-center rounded-full bg-gradient-to-br from-amber to-rose text-[14px] font-bold text-white">
        {name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[13px] font-semibold text-white">{name}</p>
        <p className="truncate text-[11px] text-slate-400">{me ? `${me.organizationName} · ${me.role}` : ''}</p>
      </div>
      <button onClick={logout} aria-label="Log out" title="Log out" className="text-slate-500 hover:text-white">
        <LogOut className="size-4" />
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') return <>{children}</>;
  return <Shell>{children}</Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const restaurant = me?.vertical === 'restaurant';
  const { data: summary } = useApi<Summary>(me && !restaurant ? '/dashboard/summary?days=7' : null, 15_000);
  const { data: overview } = useApi<Overview>(restaurant ? '/restaurant/overview?days=1' : null, 15_000);
  const [open, setOpen] = useState(false);
  const badges: Badges = restaurant
    ? { orders: overview?.orders.byStatus.pending, handoff: overview?.handoffsOpen }
    : { live: summary?.voice.live, handoff: summary?.humanTasksOpen };

  const sidebar = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col bg-sidebar px-3 py-5">
      <Logo />
      {me && <NavList nav={restaurant ? RESTAURANT_NAV : NAV} badges={badges} onNavigate={onNavigate} />}
      <div className="mt-auto flex flex-col gap-4 pt-6">
        {me && !restaurant && <AutomationCard summary={summary} />}
        <UserCard />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:pl-[248px]">
      <aside className="fixed inset-y-0 left-0 hidden w-[248px] lg:block">{sidebar()}</aside>

      <div className="flex h-14 items-center gap-3 bg-sidebar px-4 lg:hidden">
        <button aria-label="Open menu" onClick={() => setOpen(true)} className="text-white">
          <Menu className="size-5" />
        </button>
        <span className="text-[15px] font-bold text-white">Tacksharp.ai</span>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[260px]">
            <button aria-label="Close menu" onClick={() => setOpen(false)} className="absolute top-5 right-3 z-10 text-slate-400">
              <X className="size-5" />
            </button>
            {sidebar(() => setOpen(false))}
          </aside>
        </div>
      )}

      <main className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}

export function PageHeader({ title, crumb, actions }: { title: string; crumb?: string; actions?: ReactNode }) {
  const router = useRouter();
  const me = useMe();
  const restaurant = me?.vertical === 'restaurant';
  const { data: summary } = useApi<Summary>(me && !restaurant ? '/dashboard/summary?days=7' : null, 15_000);
  const { data: overview } = useApi<Overview>(restaurant ? '/restaurant/overview?days=1' : null, 15_000);
  const waiting = restaurant ? overview?.handoffsOpen ?? 0 : summary?.humanTasksOpen ?? 0;
  const [q, setQ] = useState('');
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-[12px] text-muted">Platform / {crumb ?? title}</p>
        <h1 className="mt-0.5 text-[26px] font-bold tracking-[-0.01em] text-ink">{title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`${restaurant ? '/orders' : '/leads'}?q=${encodeURIComponent(q)}`);
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={restaurant ? 'Search orders…' : 'Search leads…'}
            aria-label={restaurant ? 'Search orders' : 'Search leads'}
            className="h-9 w-[220px] rounded-[10px] border border-line bg-white pr-3 pl-9 text-[13px] text-ink placeholder:text-faint"
          />
        </form>
        <Link
          href={restaurant ? '/conversations?status=human_handoff' : '/handoffs'}
          aria-label={`${waiting} customers waiting for your team`}
          className="relative grid size-9 place-items-center rounded-[10px] border border-line bg-white text-body hover:bg-slate-50"
        >
          <Bell className="size-4" />
          {!!waiting && <span className="absolute top-2 right-2 size-2 rounded-full bg-rose ring-2 ring-white" />}
        </Link>
        {actions}
      </div>
    </header>
  );
}
