'use client';

import type { LucideIcon } from 'lucide-react';

export type StatTile = { label: string; value: string | number; sub?: string; icon: LucideIcon; color: string; bg: string; onClick?: () => void };

/** A row of big, coloured number tiles: the owner's “at a glance” for a page. */
export function StatTiles({ tiles, label }: { tiles: StatTile[]; label: string }) {
  return (
    <ul className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={label}>
      {tiles.map((t) => {
        const body = (
          <>
            <span className="flex items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-[10px]" style={{ background: t.bg, color: t.color }}><t.icon className="size-4" aria-hidden /></span>
              <span className="text-[12px] leading-tight font-semibold text-muted">{t.label}</span>
            </span>
            <span className="mt-2.5 block text-[24px] leading-none font-bold tracking-[-0.02em] text-ink tabular">{t.value}</span>
            {t.sub && <span className="mt-1 block truncate text-[11.5px] text-muted">{t.sub}</span>}
          </>
        );
        const cls = 'block h-full w-full rounded-[16px] border border-line bg-white p-3.5 text-left shadow-[var(--shadow-card)]';
        return <li key={t.label}>{t.onClick ? <button type="button" onClick={t.onClick} className={`${cls} transition hover:-translate-y-0.5 hover:border-slate-300`}>{body}</button> : <div className={cls}>{body}</div>}</li>;
      })}
    </ul>
  );
}
