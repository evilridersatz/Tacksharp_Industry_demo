'use client';

import { ChevronRight } from 'lucide-react';
import { useApi } from '@/lib/api';
import { cx } from '@/components/ui';
import type { Order } from '@/lib/restaurant';

const STEPS = [
  { key: 'pending', label: 'New', hint: 'confirm them', color: '#d97706', bg: '#fffbeb' },
  { key: 'confirmed', label: 'Confirmed', hint: 'to cut', color: '#0284c7', bg: '#f0f9ff' },
  { key: 'preparing', label: 'Cutting & packing', hint: 'in progress', color: '#7c3aed', bg: '#f5f3ff' },
  { key: 'ready', label: 'Ready', hint: 'to collect', color: '#059669', bg: '#ecfdf5' },
  { key: 'completed', label: 'Collected', hint: 'today', color: '#475569', bg: '#f8fafc' },
] as const;

/**
 * Today's orders as a pipeline, left to right: how many are new, being prepared, ready, collected. Tapping a step
 * filters the list below. Collected counts today (India time); the other stages are every open order.
 */
export function OrderPipeline({ onPick, includeDemo = false }: { onPick?: (status: string) => void; includeDemo?: boolean }) {
  const active = useApi<Order[]>('/restaurant/orders?status=active', 15_000);
  const done = useApi<Order[]>('/restaurant/orders?status=completed', 30_000);
  const data = active.data && done.data;
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const by: Record<string, number> = {};
  for (const o of (active.data ?? []).filter((x) => includeDemo || !x.isDemo)) by[o.status] = (by[o.status] ?? 0) + 1;
  by.completed = (done.data ?? []).filter((o) => (includeDemo || !o.isDemo) && new Date(new Date(o.updatedAt).getTime() + 330 * 60_000).toISOString().slice(0, 10) === today).length;
  return (
    <ol className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Today's orders by stage">
      {STEPS.map((s, i) => (
        <li key={s.key} className="relative">
          <button type="button" onClick={() => onPick?.(s.key)} className={cx('flex h-full w-full flex-col items-start rounded-[14px] border border-line bg-white p-3 text-left shadow-[var(--shadow-card)] transition hover:-translate-y-0.5', i === 4 && 'col-span-2 sm:col-span-1')} style={{ borderTop: `3px solid ${s.color}` }}>
            <span className="text-[12px] font-semibold text-muted">{s.label}</span>
            <span className="mt-1 text-[26px] leading-none font-bold tabular" style={{ color: (by[s.key] ?? 0) ? s.color : '#94a3b8' }}>{data ? by[s.key] ?? 0 : '…'}</span>
            <span className="mt-1 text-[11.5px] text-faint">{s.hint}</span>
          </button>
          {i < STEPS.length - 1 && <ChevronRight className="absolute top-1/2 -right-2.5 z-10 hidden size-4 -translate-y-1/2 rounded-full bg-white text-faint sm:block" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}
