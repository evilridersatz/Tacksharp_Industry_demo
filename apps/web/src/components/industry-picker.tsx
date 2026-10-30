'use client';

import { Check } from 'lucide-react';
import { INDUSTRY_CATEGORIES } from '@/lib/industry-choices';
import { cx } from './ui';

/**
 * Industry cards grouped by category (native radio buttons: keyboard and screen-reader friendly). Unavailable
 * choices are shown with the reason and cannot be picked.
 */
export function IndustryPicker({ value, onChange, name = 'industry', describedBy, invalid, compact }: { value: string; onChange: (v: string) => void; name?: string; describedBy?: string; invalid?: boolean; compact?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Industry" aria-describedby={describedBy} aria-invalid={invalid} className="grid gap-4">
      {INDUSTRY_CATEGORIES.map((cat) => (
        <fieldset key={cat.category} className="grid gap-2">
          <legend className="mb-1 text-[12px] font-semibold tracking-wide text-[#16183d]/55 uppercase">{cat.category}</legend>
          <div className={cx('grid gap-2', !compact && 'sm:grid-cols-2')}>
            {cat.choices.map((c) => {
              const selected = value === c.value;
              const Icon = c.icon;
              return (
                <label key={c.value} className={cx('relative flex gap-3 rounded-[14px] border p-3 text-left transition', c.unavailable ? 'cursor-not-allowed border-dashed border-[#16183d]/15 bg-[#f7f8fc] opacity-75' : 'cursor-pointer', !c.unavailable && (selected ? 'border-[#16183d] bg-[#16183d]/[0.03] ring-2 ring-[#16183d]/15' : 'border-[#16183d]/12 bg-white hover:border-[#16183d]/35'))}>
                  <input type="radio" name={name} value={c.value} checked={selected} disabled={Boolean(c.unavailable)} onChange={() => onChange(c.value)} className="sr-only" aria-describedby={`${name}-${c.value}-d`} />
                  <span className={cx('grid size-9 shrink-0 place-items-center rounded-[10px]', selected ? 'bg-[#16183d] text-white' : 'bg-[#ebeaf6] text-[#16183d]')}><Icon className="size-[18px]" aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[14px] font-semibold text-[#16183d]">{c.title}{c.unavailable && <span className="rounded-full bg-white px-1.5 py-px text-[10.5px] font-semibold text-[#16183d]/60 ring-1 ring-[#16183d]/10">Not available yet</span>}</span>
                    <span id={`${name}-${c.value}-d`} className="mt-0.5 block text-[12.5px] leading-snug text-[#16183d]/65">{c.unavailable ?? c.description}</span>
                  </span>
                  {selected && <Check className="absolute top-3 right-3 size-4 text-[#16183d]" aria-hidden />}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
