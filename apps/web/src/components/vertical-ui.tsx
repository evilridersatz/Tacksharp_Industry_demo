'use client';

import type { ReactNode } from 'react';
import { Clock3, Database, FlaskConical, Search } from 'lucide-react';
import { useWorkspace } from '@/lib/industry';
import { industryDef } from '@/lib/industries';
import { Card, cx } from './ui';
import { inputCls } from './textile';

/** Shared building blocks for the food, hotel and hospital pages (consistent look across modules). */

export const money = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const shortDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(iso.length === 10 ? { timeZone: 'UTC' } : { timeZone: 'Asia/Kolkata' }) });
export const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
export const when = (iso: string) => `${shortDate(iso)}, ${time(iso)}`;
export const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const plusDays = (day: string, k: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + k * 86_400_000).toISOString().slice(0, 10);

type ToneName = 'green' | 'blue' | 'amber' | 'red' | 'violet' | 'slate' | 'cyan';
const PILL: Record<ToneName, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/15',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-rose-50 text-rose-700 ring-rose-600/15',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/15',
  slate: 'bg-slate-100 text-slate-600 ring-slate-500/15',
  cyan: 'bg-cyan-50 text-cyan-800 ring-cyan-600/15',
};
/** Status → colour for every module (unknown statuses are slate). */
const STATUS_TONE: Record<string, ToneName> = {
  pending: 'amber', pending_confirmation: 'amber', booked: 'blue', confirmed: 'blue', preparing: 'violet', ready: 'cyan', dispatched: 'violet', completed: 'green',
  checked_in: 'violet', checked_out: 'green', cancelled: 'slate', no_show: 'red', expired: 'slate', needs_attention: 'red',
  documents_pending: 'amber', ready_to_submit: 'blue', submitted: 'violet', query_raised: 'amber', approved: 'green', partially_approved: 'cyan', rejected: 'red', settled: 'green', closed: 'slate',
  available: 'green', occupied: 'violet', out_of_service: 'red', clean: 'green', dirty: 'amber', inspecting: 'blue',
  not_required: 'slate', simulated_paid: 'cyan', simulated_failed: 'red', paid_verified: 'green',
  scheduled: 'blue', simulated: 'cyan', skipped: 'slate', failed: 'red', open: 'amber',
  passed: 'green', blocked: 'amber', provider_required: 'violet',
};

export function Pill({ status, children, tone, className }: { status?: string; children?: ReactNode; tone?: ToneName; className?: string }) {
  const t = tone ?? STATUS_TONE[status ?? ''] ?? 'slate';
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold ring-1 ring-inset', PILL[t], className)}>
      <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden />
      {children ?? (status ?? '').replace(/_/g, ' ')}
    </span>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'red' | 'amber' | 'green' }) {
  const { workspace } = useWorkspace();
  const def = industryDef(workspace?.industry);
  return (
    <Card className="relative overflow-hidden p-4">
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: tone === 'red' ? '#e11d48' : tone === 'amber' ? '#f59e0b' : tone === 'green' ? '#0f9f6e' : def.accent }} aria-hidden />
      <p className="text-[12.5px] leading-snug text-muted">{label}</p>
      <p className="mt-1 text-[22px] leading-tight font-bold text-ink tabular">{value}</p>
      {hint && <p className="mt-0.5 text-[11.5px] text-faint">{hint}</p>}
    </Card>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2.5">{children}</div>;
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative min-w-0 flex-[1_1_180px] sm:max-w-[300px]">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className={cx(inputCls, 'h-10 pl-9')} />
    </div>
  );
}

/** Responsive record list: a table from md up, stacked cards below. */
export function DataList<T>({ rows, columns, onOpen, rowKey, card, empty }: {
  rows: T[];
  columns: Array<{ head: string; cell: (r: T) => ReactNode; className?: string; align?: 'right' }>;
  onOpen?: (r: T) => void;
  rowKey: (r: T) => string;
  card: (r: T) => ReactNode;
  empty?: ReactNode;
}) {
  if (!rows.length) return <Card className="px-6 py-10 text-center text-[13px] text-muted">{empty ?? 'Nothing here yet.'}</Card>;
  return (
    <>
      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11.5px] font-semibold tracking-[0.04em] text-muted uppercase">
              {columns.map((c) => <th key={c.head} className={cx('px-4 py-2.5 font-semibold', c.align === 'right' && 'text-right', c.className)}>{c.head}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} onClick={onOpen ? () => onOpen(r) : undefined} className={cx('border-b border-line last:border-0', onOpen && 'cursor-pointer hover:bg-slate-50')}>
                {columns.map((c) => <td key={c.head} className={cx('px-4 py-2.5 align-middle', c.align === 'right' && 'text-right tabular', c.className)}>{c.cell(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <ul className="flex flex-col gap-2.5 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)}>
            <button type="button" onClick={onOpen ? () => onOpen(r) : undefined} className="block w-full text-left" disabled={!onOpen}>
              <Card className="p-3.5">{card(r)}</Card>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Timeline({ items }: { items: Array<{ label: string; actor?: string | null; at: string; note?: string | null }> }) {
  if (!items.length) return <p className="text-[12.5px] text-muted">No history yet.</p>;
  return (
    <ol className="relative ml-1.5 border-l border-line pl-4">
      {items.map((e, i) => (
        <li key={i} className="relative pb-3 last:pb-0">
          <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-white bg-slate-400" aria-hidden />
          <p className="text-[12.5px] font-semibold text-ink">{e.label.replace(/_/g, ' ')}</p>
          <p className="text-[11.5px] text-muted">
            <Clock3 className="mr-1 inline size-3" aria-hidden />
            {when(e.at)}
            {e.actor ? ` · ${e.actor.replace(/^user:/, '').replace(/^ai$/, 'AI assistant').replace('seed:demo', 'demo seed')}` : ''}
          </p>
          {e.note && <p className="mt-0.5 text-[12px] text-body">{e.note}</p>}
        </li>
      ))}
    </ol>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mb-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold tracking-[0.05em] text-muted uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Small "where does this come from" footer for data pages. */
export function SourceNote({ api, children }: { api: string; children?: ReactNode }) {
  return (
    <p className="mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
      <Database className="size-3" aria-hidden /> Data from <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-600">{api}</code>
      {children}
    </p>
  );
}

export function SimulatedNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 rounded-[10px] bg-cyan-50 px-3 py-2 text-[12px] text-cyan-900">
      <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {children}
    </p>
  );
}
