'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { PageHeader } from './shell';
import { Badge, ErrorBanner, cx } from './ui';

const TABS = [
  { href: '/platform', label: 'Organizations' },
  { href: '/platform/health', label: 'Service health' },
  { href: '/platform/failures', label: 'Failures' },
  { href: '/platform/usage', label: 'Usage' },
  { href: '/platform/audit', label: 'Audit log' },
];

/** Shell for every platform page: title, tab bar, and a clear message for non-staff (the API refuses them anyway). */
export function PlatformFrame({ title, error, reload, children }: { title: string; error?: string | null; reload?: () => void; children: ReactNode }) {
  const pathname = usePathname();
  const forbidden = error && /restricted to Tacksharp staff/.test(error);
  return (
    <>
      <PageHeader title={title} crumb="Platform console" />
      <nav aria-label="Platform sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => {
          const active = t.href === '/platform' ? pathname === '/platform' || pathname.startsWith('/platform/organizations') : pathname.startsWith(t.href);
          return <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined} className={cx('-mb-px border-b-2 px-3 py-2 text-[13.5px] font-semibold whitespace-nowrap', active ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink')}>{t.label}</Link>;
        })}
      </nav>
      {forbidden ? (
        <p role="alert" className="rounded-[12px] bg-slate-50 px-4 py-3 text-[13.5px] text-body">The platform console is restricted to Tacksharp staff.</p>
      ) : error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : (
        children
      )}
    </>
  );
}

export function OrgStatus({ status }: { status: string }) {
  return <Badge tone={status === 'active' ? 'brand' : status === 'suspended' ? 'rose' : 'amber'}>{status === 'pending_review' ? 'Pending review' : status === 'active' ? 'Active' : 'Suspended'}</Badge>;
}

export function Check({ ok, label }: { ok: boolean; label: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      {ok ? <CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> : <XCircle className="size-4 text-rose-600" aria-hidden />}
      <span className="sr-only">{ok ? 'OK: ' : 'Problem: '}</span>{label}
    </span>
  );
}

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
