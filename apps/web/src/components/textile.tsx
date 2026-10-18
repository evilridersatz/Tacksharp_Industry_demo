'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useIndustry } from '@/lib/industry';
import { INDUSTRIES, industryDef, type IndustryId } from '@/lib/industries';
import type { AuditEvent } from '@/lib/types';
import { auditActor, dateTime } from '@/lib/format';
import { Button, Card, Empty, cx } from './ui';

export const inputCls = 'h-9 w-full rounded-[10px] border border-line bg-white px-3 text-[13px] text-ink placeholder:text-faint outline-none focus:border-brand';

/** Native <dialog> modal (same pattern as Add lead). */
export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    d?.addEventListener('close', onClose);
    return () => d?.removeEventListener('close', onClose);
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={cx('m-auto rounded-[16px] border border-line p-0 shadow-xl backdrop:bg-slate-900/40', wide ? 'w-[min(760px,calc(100vw-32px))]' : 'w-[min(480px,calc(100vw-32px))]')}
    >
      <div className="flex items-center justify-between px-5 pt-4">
        <h2 className="text-[16px] font-bold text-ink">{title}</h2>
        <button type="button" aria-label="Close" onClick={() => ref.current?.close()} className="text-faint hover:text-ink">
          <X className="size-5" />
        </button>
      </div>
      <div className="p-5 pt-3">{open && children}</div>
    </dialog>
  );
}

export function Label({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block text-[12.5px] font-semibold text-body', className)}>
      {text}
      <div className="mt-1">{children}</div>
    </label>
  );
}

export function Notice({ notice }: { notice: { tone: 'ok' | 'error'; text: string } | null }) {
  if (!notice) return null;
  return (
    <p role="status" className={cx('mb-4 rounded-[10px] px-4 py-2.5 text-[13px]', notice.tone === 'ok' ? 'bg-brand-soft text-brand-dark' : 'bg-rose-soft text-rose')}>
      {notice.text}
    </p>
  );
}

/** Who changed what, oldest first. */
export function AuditTrail({ events }: { events?: AuditEvent[] }) {
  if (!events?.length) return <p className="text-[12.5px] text-muted">No changes recorded yet.</p>;
  return (
    <ol className="flex flex-col gap-1.5">
      {events.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
          <span className="text-faint tabular">{dateTime(e.createdAt)}</span>
          <span className="font-semibold text-ink">
            {e.action.replace(/^status:/, '→ ').replace(/_/g, ' ')}
            {typeof e.data?.to === 'string' && ` → ${e.data.to.replace(/_/g, ' ')}`}
          </span>
          <span className="text-muted">by {auditActor(e.actor)}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Pages that belong to some industries only. Other workspaces see a short explanation instead of empty tables or
 * irrelevant tools (the API stays tenant-scoped either way; this guard is about relevance, not access).
 */
export function IndustryOnly({ allow, children }: { allow: IndustryId[]; children: ReactNode }) {
  const { industry, loading } = useIndustry();
  if (loading && !industry) return null;
  if (!industry || !allow.includes(industry)) {
    const def = industryDef(industry);
    const names = allow.map((i) => INDUSTRIES[i].short).join(', ');
    return (
      <Card>
        <Empty title={`Not part of ${def.label}`}>
          This page is used by {names} workspaces. Your menu shows everything that applies to {def.short.toLowerCase()}.
          {def.settings.includes('industry') && (
            <span className="block mt-1">If this business is in a different industry, an admin can change it in Settings.</span>
          )}
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button href="/">Back to overview</Button>
            {def.settings.includes('industry') && <Button href="/settings">Open Settings</Button>}
          </div>
        </Empty>
      </Card>
    );
  }
  return <>{children}</>;
}

/** Textile-only pages (quotations, the textile sales dashboard). */
export function TextileOnly({ children, allow = ['textile'] }: { children: ReactNode; allow?: IndustryId[] }) {
  return <IndustryOnly allow={allow}>{children}</IndustryOnly>;
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
