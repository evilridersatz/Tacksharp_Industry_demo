'use client';

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, ErrorBanner, Segmented, Skeleton } from '@/components/ui';
import { Stat } from '@/components/vertical-ui';
import { toast } from '@/components/toast';
import { FormField, SectionCard, inr, type JarvisSettings } from '@/components/jarvis';

type Day = { date: string; phoneMin: number; dashboardMin: number; videoMin: number; tokens: number; whatsapp: number; cost: number };
type Usage = { days: Day[]; totals: Omit<Day, 'date'>; ratesSet: boolean };
const input = 'h-9 w-full rounded-[10px] border border-line bg-white px-3 text-[13.5px] text-ink outline-none focus:border-slate-400';

export default function JarvisUsagePage() {
  const [days, setDays] = useState<'1' | '7' | '30'>('7');
  const { data, error, reload } = useApi<Usage>(`/jarvis/usage?days=${days}`, 60_000);
  const settings = useApi<JarvisSettings>('/jarvis/settings', 0);
  const [form, setForm] = useState<JarvisSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (settings.data && !form) setForm(settings.data); }, [settings.data, form]);
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try { setForm(await api.put<JarvisSettings>('/jarvis/settings', form)); toast('Rates saved.'); reload(); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  const t = data?.totals;
  const rate = (k: keyof JarvisSettings['rates'], label: string, hint: string) => form && (
    <FormField label={label}>
      <input type="number" min={0} step="0.01" className={input} value={form.rates[k]} onChange={(e) => setForm({ ...form, rates: { ...form.rates, [k]: Number(e.target.value) } })} aria-describedby={`${k}-hint`} />
      <span id={`${k}-hint`} className="mt-1 block text-[11.5px] text-muted">{hint}</span>
    </FormField>
  );
  return (
    <>
      <PageHeader title="Usage & cost" crumb="Jarvis" actions={<Segmented label="Period" value={days} onChange={setDays} options={[{ value: '1', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />} />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data || !t ? <Skeleton className="h-64" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Phone call minutes" value={t.phoneMin} hint="Sarvam voice agent" />
            <Stat label="Dashboard call minutes" value={t.dashboardMin} hint="Sarvam, from the assistant" />
            <Stat label="Video minutes" value={t.videoMin} hint="Presenter (Simli)" />
            <Stat label="AI tokens" value={t.tokens.toLocaleString('en-IN')} hint="OpenAI, as recorded" />
            <Stat label="WhatsApp sent" value={t.whatsapp} hint="Replies and messages" />
            <Stat label="Estimated cost" value={data.ratesSet ? inr(t.cost) : '—'} hint={data.ratesSet ? 'From your rates' : 'Enter your rates below'} />
          </div>
          <SectionCard title="By day">
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead><tr className="text-left text-muted"><th className="px-4 py-2 font-semibold">Day</th><th className="px-4 py-2 text-right font-semibold">Phone min</th><th className="px-4 py-2 text-right font-semibold">Dashboard min</th><th className="px-4 py-2 text-right font-semibold">Video min</th><th className="px-4 py-2 text-right font-semibold">Tokens</th><th className="px-4 py-2 text-right font-semibold">WhatsApp</th><th className="px-4 py-2 text-right font-semibold">Cost</th></tr></thead>
                <tbody>{[...data.days].reverse().map((d) => (
                  <tr key={d.date} className="border-t border-line tabular"><td className="px-4 py-2 text-ink">{new Date(`${d.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</td><td className="px-4 py-2 text-right">{d.phoneMin}</td><td className="px-4 py-2 text-right">{d.dashboardMin}</td><td className="px-4 py-2 text-right">{d.videoMin}</td><td className="px-4 py-2 text-right">{d.tokens.toLocaleString('en-IN')}</td><td className="px-4 py-2 text-right">{d.whatsapp}</td><td className="px-4 py-2 text-right font-semibold text-ink">{data.ratesSet ? inr(d.cost) : '—'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}
      {form && (
        <SectionCard title="Your rates and budget" subtitle="Enter what your providers actually charge you (₹). Cost is an estimate: units × your rates." action={<Button variant="primary" onClick={() => void save()} busy={busy}><Save className="size-4" aria-hidden /> Save</Button>}>
          <div className="grid gap-4 px-4 pb-4 md:grid-cols-3">
            {rate('sarvamAgentPerMin', '₹ per voice-agent minute', 'Sarvam bill ÷ minutes (phone and dashboard calls).')}
            {rate('simliPerMin', '₹ per video minute', 'Simli plan ÷ minutes.')}
            {rate('openaiPer1kTokens', '₹ per 1,000 AI tokens', 'Input and output together.')}
            {rate('whatsappPerMsg', '₹ per WhatsApp message', 'Your average per message sent.')}
            <FormField label="Daily budget (₹)">
              <input type="number" min={0} className={input} value={form.dailyBudget} onChange={(e) => setForm({ ...form, dailyBudget: Number(e.target.value) })} />
              <span className="mt-1 block text-[11.5px] text-muted">Turn on “Daily spend budget” under Monitors to be alerted.</span>
            </FormField>
          </div>
        </SectionCard>
      )}
    </>
  );
}
