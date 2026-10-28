'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Check, ChevronsUpDown, FlaskConical, Loader2, LogOut, Menu, Pause, Play, Search, X } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Summary } from '@/lib/types';
import { forgetMe, useMe, type Overview } from '@/lib/restaurant';
import { INDUSTRIES, PRODUCT_LABEL, PRODUCT_TAGLINE, industryDef, productOf, type IndustryDef, type NavItem, type ProductFamily } from '@/lib/industries';
import { forgetWorkspace, switchWorkspace, useWorkspace, type WorkspaceOption } from '@/lib/industry';
import { cx } from './ui';

type Badges = { live?: number; handoff?: number; orders?: number };

function Logo({ product = 'agents' }: { product?: ProductFamily }) {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <span className="grid size-9 place-items-center rounded-full bg-[conic-gradient(from_200deg,#7c5cf0,#e11d48,#f59e0b,#7c5cf0)]">
        <span className="size-3.5 rounded-full border-[3px] border-white bg-sidebar" />
      </span>
      <div className="leading-tight">
        <p className="text-[15px] font-bold text-white">Tacksharp.ai</p>
        <p className="text-[11px] text-slate-400">{PRODUCT_TAGLINE[product]}</p>
      </div>
    </div>
  );
}

/** The single best-matching nav item is active: path match, then every query param of the item must match. */
function activeHref(items: NavItem[], pathname: string, search: URLSearchParams): string | null {
  let best: { href: string; score: number } | null = null;
  for (const item of items) {
    const [path, query] = item.href.split('?');
    const pathOk = path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
    if (!pathOk) continue;
    const params = new URLSearchParams(query ?? '');
    let ok = true;
    params.forEach((v, k) => {
      if (search.get(k) !== v) ok = false;
    });
    if (!ok) continue;
    const score = 1 + [...params.keys()].length;
    if (!best || score > best.score) best = { href: item.href, score };
  }
  return best?.href ?? null;
}

function NavListInner({ def, badges, onNavigate, search }: { def: IndustryDef; badges: Badges; onNavigate?: () => void; search: URLSearchParams }) {
  const pathname = usePathname();
  const active = activeHref(def.nav.flatMap((g) => g.items), pathname, search);
  return (
    <nav aria-label="Main" className="mt-5 flex flex-col gap-5">
      {def.nav.map((group) => (
        <div key={group.section}>
          <p className="px-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-slate-500 uppercase">{group.section}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const isActive = item.href === active;
              const count = item.badge ? badges[item.badge] : undefined;
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? 'page' : undefined}
                    className={cx(
                      'flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-[13.5px] lg:min-h-9',
                      isActive ? 'bg-sidebar-2 font-semibold text-white' : 'text-slate-400 hover:bg-sidebar-2/60 hover:text-slate-200',
                    )}
                  >
                    <Icon className="size-[17px] shrink-0" style={isActive ? { color: def.onDark } : undefined} aria-hidden />
                    <span className="flex-1 truncate">{item.label}</span>
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

function NavWithParams(props: { def: IndustryDef; badges: Badges; onNavigate?: () => void }) {
  const params = useSearchParams();
  return <NavListInner {...props} search={new URLSearchParams(params.toString())} />;
}

function NavList(props: { def: IndustryDef; badges: Badges; onNavigate?: () => void }) {
  // useSearchParams needs a Suspense boundary on statically rendered pages; the fallback ignores the query.
  return (
    <Suspense fallback={<NavListInner {...props} search={new URLSearchParams()} />}>
      <NavWithParams {...props} />
    </Suspense>
  );
}

/** Workspace (industry) switcher. Lists only workspaces the server says this user belongs to. */
function WorkspaceSwitcher({ def }: { def: IndustryDef | null }) {
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<WorkspaceOption[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (!list) api.get<WorkspaceOption[]>('/auth/workspaces').then(setList).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, list]);

  async function pick(id: string) {
    setBusy(id);
    setError(null);
    try {
      await switchWorkspace(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  if (!workspace || !def) return <div className="mt-5 h-[58px] rounded-[12px] bg-white/[0.03]" />;
  const Icon = def.icon;
  return (
    <div ref={ref} className="relative mt-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Workspace: ${workspace.name}, ${def.label}. Switch workspace`}
        className="flex min-h-[58px] w-full items-center gap-3 rounded-[12px] border border-white/10 bg-white/[0.04] px-3 py-2 text-left hover:bg-white/[0.07]"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px]" style={{ background: `${def.onDark}26`, color: def.onDark }}>
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-semibold text-white">{workspace.name}</span>
          <span className="block truncate text-[11px] text-slate-400">
            {def.label}
            {workspace.isDemo && ' · Demo'}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-slate-500" aria-hidden />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-[12px] border border-white/10 bg-sidebar-2 shadow-2xl">
          {!list && !error && <p className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-slate-400"><Loader2 className="size-4 animate-spin" /> Loading…</p>}
          {error && <p role="alert" className="px-3 py-2 text-[12.5px] text-rose-300">{error}</p>}
          <div className="max-h-[360px] overflow-y-auto pb-1.5">
            {(['agents', 'visionops'] as const).map((fam) => {
              const items = (list ?? []).filter((w) => productOf(w.industry) === fam);
              if (!items.length) return null;
              return (
                <div key={fam}>
                  <p id={`ws-${fam}`} className="px-3 pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-slate-500 uppercase">{PRODUCT_LABEL[fam]}</p>
                  <ul role="listbox" aria-labelledby={`ws-${fam}`}>
                    {items.map((w) => {
                      const d = INDUSTRIES[w.industry] ?? industryDef(w.industry);
                      const WIcon = d.icon;
                      return (
                        <li key={w.organizationId} role="option" aria-selected={w.current}>
                          <button
                            type="button"
                            disabled={w.current || busy !== null}
                            onClick={() => pick(w.organizationId)}
                            className="flex min-h-11 w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-white/[0.06] disabled:cursor-default"
                          >
                            <WIcon className="size-4 shrink-0" style={{ color: d.onDark }} aria-hidden />
                            <span className="min-w-0 flex-1 leading-tight">
                              <span className="block truncate text-[12.5px] font-semibold text-white">{w.name}</span>
                              <span className="block truncate text-[11px] text-slate-400">
                                {w.industryLabel}
                                {w.isDemo ? ' · Demo data' : ''}
                              </span>
                            </span>
                            {busy === w.organizationId ? <Loader2 className="size-4 animate-spin text-slate-400" /> : w.current && <Check className="size-4 text-slate-300" aria-label="Current" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
          {list && list.length < 2 && <p className="border-t border-white/10 px-3 py-2 text-[11.5px] text-slate-400">Ask an admin for access to other workspaces.</p>}
          <Link href="/onboarding" className="flex min-h-11 items-center border-t border-white/10 px-3 text-[12.5px] font-semibold text-slate-300 hover:bg-white/[0.06] hover:text-white">
            Setup guide
          </Link>
        </div>
      )}
    </div>
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
    forgetWorkspace();
    window.location.href = '/login';
  }
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-amber to-rose text-[14px] font-bold text-white">
        {name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[13px] font-semibold text-white">{name}</p>
        <p className="truncate text-[11px] text-slate-400">{me ? me.role : ''}</p>
      </div>
      <button onClick={logout} aria-label="Log out" title="Log out" className="grid size-11 place-items-center rounded-[10px] text-slate-500 hover:text-white lg:size-9">
        <LogOut className="size-4" />
      </button>
    </div>
  );
}

const BARE_ROUTES = ['/login', '/onboarding', '/invite'];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (BARE_ROUTES.includes(pathname)) return <>{children}</>;
  return <Shell>{children}</Shell>;
}

/** Accessible mobile drawer: Escape closes, page scroll is locked, focus moves into the drawer and back. */
function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <aside className="absolute inset-y-0 left-0 w-[min(290px,86vw)] overflow-y-auto">
        <button ref={closeRef} aria-label="Close menu" onClick={onClose} className="absolute top-4 right-2 z-10 grid size-11 place-items-center text-slate-400 hover:text-white">
          <X className="size-5" />
        </button>
        {children}
      </aside>
    </div>
  );
}

/**
 * A real (non-demo) workspace with no customers yet: say so plainly on the overview and offer the real next steps
 * (add a customer, import a consented list, connect WhatsApp). Never shown in demo workspaces.
 */
function LiveSetupCard({ industry }: { industry: string }) {
  const pathname = usePathname();
  const skip = pathname !== '/' || industry === 'cctv' || industry === 'restaurant';
  const { data } = useApi<{ total: number }>(skip ? null : '/customers?pageSize=5', 60_000);
  if (skip || !data || data.total > 0) return null;
  return (
    <div role="note" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-[13px]">
      <p className="text-body"><b>Live workspace — no customers yet.</b> Figures below stay at zero until real customers message you or you add them. Nothing here is sample data.</p>
      <span className="flex flex-wrap gap-2">
        <Link href="/contacts" className="inline-flex min-h-9 items-center rounded-[8px] bg-emerald-600 px-3 font-semibold text-white hover:bg-emerald-700">Add a customer</Link>
        <Link href="/marketing?tab=audience" className="inline-flex min-h-9 items-center rounded-[8px] border border-black/10 bg-white px-3 font-semibold text-ink">Import a list</Link>
        <Link href="/settings" className="inline-flex min-h-9 items-center rounded-[8px] border border-black/10 bg-white px-3 font-semibold text-ink">Connect WhatsApp</Link>
      </span>
    </div>
  );
}

type DemoLive = { available: boolean; enabled: boolean; since: string | null; lastActivityAt: string | null; scheduler: { on: boolean; reason: string } };

function agoShort(iso: string | null) {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}

/** Demo notice + the live demo switch: simulated customers, calls and records arrive every minute while it is on. */
function DemoBanner({ def }: { def: IndustryDef }) {
  const { data: live, reload } = useApi<DemoLive>('/demo/live', 15_000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function toggle(enabled: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/demo/live', { enabled });
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const age = live?.lastActivityAt ? (Date.now() - Date.parse(live.lastActivityAt)) / 1000 : Infinity;
  const flowing = Boolean(live?.enabled) && age < 180;
  return (
    <div role="note" className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[12px] border px-4 py-2.5 text-[12.5px]" style={{ borderColor: `${def.accent}40`, background: def.accentSoft, color: '#1e293b' }}>
      <FlaskConical className="size-4 shrink-0" style={{ color: def.accent }} aria-hidden />
      <b>Demo workspace</b>
      <span className="min-w-0 flex-1 text-body">Sample {def.short.toLowerCase()} data. Nothing here is sent to real customers, charged or called.</span>
      {live?.available && (
        <span className="flex flex-wrap items-center gap-2">
          {live.enabled ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-2 py-0.5 text-[11.5px] font-semibold text-emerald-700" aria-live="polite">
              <span className="relative flex size-2" aria-hidden>
                {flowing && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:hidden" />}
                <span className={cx('relative inline-flex size-2 rounded-full', flowing ? 'bg-emerald-500' : 'bg-amber-500')} />
              </span>
              {flowing ? `Live demo · activity ${agoShort(live.lastActivityAt)}` : live.scheduler.on ? 'Live demo · starting…' : 'Live demo on · scheduler off on this server'}
            </span>
          ) : (
            <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11.5px] font-semibold text-muted">Live demo paused</span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => toggle(!live.enabled)}
            className="inline-flex min-h-8 items-center gap-1 rounded-[8px] border border-black/10 bg-white px-2.5 text-[12px] font-semibold text-ink hover:bg-white/80 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : live.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            {live.enabled ? 'Pause live demo' : 'Start live demo'}
          </button>
        </span>
      )}
      {err && <span role="alert" className="w-full text-[12px] text-rose-700">{err}</span>}
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const { workspace } = useWorkspace();
  const def = workspace ? industryDef(workspace.industry) : null;
  const restaurant = workspace?.industry === 'restaurant';
  const { data: summary } = useApi<Summary>(workspace && !restaurant ? '/dashboard/summary?days=7' : null, 15_000);
  const { data: overview } = useApi<Overview>(restaurant ? '/restaurant/overview?days=1' : null, 15_000);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  const badges: Badges = restaurant
    ? { orders: overview?.orders.byStatus.pending, handoff: overview?.handoffsOpen }
    : { live: summary?.voice.live, handoff: summary?.humanTasksOpen };
  const showAutomation = workspace && ['real_estate', 'textile', 'agency'].includes(workspace.industry);

  const sidebar = (onNavigate?: () => void) => (
    <div className="flex min-h-full flex-col bg-sidebar px-3 py-5">
      <Logo product={productOf(workspace?.industry)} />
      {me && <WorkspaceSwitcher def={def} />}
      {def && <NavList def={def} badges={badges} onNavigate={onNavigate} />}
      <div className="mt-auto flex flex-col gap-4 pt-6">
        {showAutomation && <AutomationCard summary={summary} />}
        <UserCard />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:pl-[256px]" style={def ? ({ '--industry-accent': def.accent, '--industry-soft': def.accentSoft } as React.CSSProperties) : undefined}>
      <aside className="fixed inset-y-0 left-0 hidden w-[256px] overflow-y-auto bg-sidebar lg:block">{sidebar()}</aside>

      <div className="sticky top-0 z-40 flex h-14 items-center gap-2 bg-sidebar px-2 lg:hidden">
        <button aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)} className="grid size-11 place-items-center text-white">
          <Menu className="size-5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-white">
          {workspace?.name ?? 'Tacksharp.ai'}
        </span>
        {def && (
          <span className="mr-2 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: `${def.onDark}26`, color: def.onDark }}>
            {def.short}
            {workspace?.isDemo ? ' · Demo' : ''}
          </span>
        )}
      </div>
      <Drawer open={open} onClose={() => setOpen(false)}>
        {sidebar(() => setOpen(false))}
      </Drawer>

      <main className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">
        {workspace?.isDemo && def && <DemoBanner def={def} />}
        {workspace && !workspace.isDemo && def && <LiveSetupCard industry={workspace.industry} />}
        {children}
      </main>
    </div>
  );
}

export function PageHeader({ title, crumb, actions }: { title: string; crumb?: string; actions?: ReactNode }) {
  const router = useRouter();
  const { workspace } = useWorkspace();
  const def = industryDef(workspace?.industry);
  const restaurant = workspace?.industry === 'restaurant';
  const { data: summary } = useApi<Summary>(workspace && !restaurant ? '/dashboard/summary?days=7' : null, 15_000);
  const { data: overview } = useApi<Overview>(restaurant ? '/restaurant/overview?days=1' : null, 15_000);
  const waiting = restaurant ? overview?.handoffsOpen ?? 0 : summary?.humanTasksOpen ?? 0;
  const [q, setQ] = useState('');
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          {workspace ? def.short : 'Platform'} / {crumb ?? title}
          {workspace && <span className={cx('rounded-full px-1.5 py-px text-[10.5px] font-bold tracking-wide uppercase', workspace.isDemo ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800')}>{workspace.isDemo ? 'Demo data' : 'Live workspace'}</span>}
          {workspace?.role === 'viewer' && <span className="rounded-full bg-slate-200 px-1.5 py-px text-[10.5px] font-bold tracking-wide text-slate-700 uppercase" title="You can look around; changes are disabled for your account.">Read-only</span>}
        </p>
        <h1 className="mt-0.5 text-[22px] font-bold tracking-[-0.01em] text-ink sm:text-[26px]">{title}</h1>
      </div>
      <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`${def.search.href}?q=${encodeURIComponent(q)}`);
          }}
          className="relative min-w-0 flex-1 sm:flex-none"
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={def.search.placeholder}
            aria-label={def.search.placeholder.replace('…', '')}
            className="h-10 w-full rounded-[10px] border border-line bg-white pr-3 pl-9 text-[13px] text-ink placeholder:text-faint sm:h-9 sm:w-[220px]"
          />
        </form>
        <Link
          href={restaurant ? '/conversations?status=human_handoff' : '/handoffs'}
          aria-label={`${waiting} customers waiting for your team`}
          className="relative grid size-10 shrink-0 place-items-center rounded-[10px] border border-line bg-white text-body hover:bg-slate-50 sm:size-9"
        >
          <Bell className="size-4" />
          {!!waiting && <span className="absolute top-2 right-2 size-2 rounded-full bg-rose ring-2 ring-white" />}
        </Link>
        {actions}
      </div>
    </header>
  );
}
