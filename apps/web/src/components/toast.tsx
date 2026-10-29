'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { cx } from './ui';

type Toast = { id: number; tone: 'ok' | 'error'; text: string };
let next = 1;
let items: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
const emit = () => listeners.forEach((l) => l(items));

/** Show a short confirmation / error. Errors stay until dismissed; confirmations fade after 5 s. */
export function toast(text: string, tone: Toast['tone'] = 'ok') {
  const t = { id: next++, tone, text };
  items = [...items.slice(-3), t];
  emit();
  if (tone === 'ok') setTimeout(() => dismiss(t.id), 5000);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Rendered once by the app shell; announced to screen readers. */
export function Toaster() {
  const [list, setList] = useState<Toast[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed top-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
      {list.map((t) => (
        <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className={cx('pointer-events-auto flex items-start gap-2 rounded-[12px] border px-3.5 py-3 text-[13px] shadow-lg motion-safe:animate-[toast-in_.18s_ease-out]', t.tone === 'ok' ? 'border-emerald-200 bg-white text-ink' : 'border-rose-200 bg-white text-ink')}>
          {t.tone === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-rose-600" aria-hidden />}
          <p className="min-w-0 flex-1">{t.text}</p>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="-m-1 grid size-7 shrink-0 place-items-center rounded-[8px] text-muted hover:bg-slate-100">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
