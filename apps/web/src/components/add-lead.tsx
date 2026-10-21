'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from './ui';

type Created = { lead: { id: string; created: boolean }; followUps: unknown[] };

export function AddLeadButton({ onCreated }: { onCreated?: () => void }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startSequence, setStartSequence] = useState(true);

  useEffect(() => {
    const d = dialog.current;
    const reset = () => setError(null);
    d?.addEventListener('close', reset);
    return () => d?.removeEventListener('close', reset);
  }, []);

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries([...form.entries()].filter(([, v]) => String(v).trim() !== ''));
      const result = await api.post<Created>('/leads', { ...body, startSequence });
      dialog.current?.close();
      onCreated?.();
      router.push(`/leads/${result.lead.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const input = 'h-9 w-full rounded-[10px] border border-line px-3 text-[13px] text-ink placeholder:text-faint';

  return (
    <>
      <Button variant="primary" onClick={() => dialog.current?.showModal()}>
        <Plus className="size-4" /> Add lead
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="add-lead-title"
        className="m-auto w-[min(440px,calc(100vw-32px))] rounded-[16px] border border-line p-0 shadow-xl backdrop:bg-slate-900/40"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(new FormData(e.currentTarget));
          }}
          className="flex flex-col gap-3 p-5"
        >
          <div className="flex items-center justify-between">
            <h2 id="add-lead-title" className="text-[16px] font-bold text-ink">
              Add a lead
            </h2>
            <button type="button" aria-label="Close" onClick={() => dialog.current?.close()} className="text-faint hover:text-ink">
              <X className="size-5" />
            </button>
          </div>
          <label className="text-[12.5px] font-semibold text-body">
            Mobile number
            <input name="phone" required inputMode="tel" placeholder="98765 43210" className={`${input} mt-1`} />
          </label>
          <label className="text-[12.5px] font-semibold text-body">
            Name
            <input name="name" placeholder="Ravi Kumar" className={`${input} mt-1`} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[12.5px] font-semibold text-body">
              Location
              <input name="location" placeholder="Porur" className={`${input} mt-1`} />
            </label>
            <label className="text-[12.5px] font-semibold text-body">
              Budget
              <input name="budget" placeholder="80 lakhs" className={`${input} mt-1`} />
            </label>
            <label className="text-[12.5px] font-semibold text-body">
              BHK
              <input name="bhk" placeholder="2" className={`${input} mt-1`} />
            </label>
            <label className="text-[12.5px] font-semibold text-body">
              Property type
              <input name="propertyType" placeholder="Apartment" className={`${input} mt-1`} />
            </label>
          </div>
          <label className="mt-1 flex items-start gap-2.5 text-[13px] text-body">
            <input type="checkbox" checked={startSequence} onChange={(e) => setStartSequence(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-brand)]" />
            <span>
              Start AI follow-up
              <span className="block text-[12px] text-muted">WhatsApp now, reminder after 30 min, AI call after 2 h (9 AM–9 PM).</span>
            </span>
          </label>
          {error && <p className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{error}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <Button type="button" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              Add lead
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
