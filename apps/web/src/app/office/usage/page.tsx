'use client';

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, ErrorBanner, Segmented, Skeleton } from '@/components/ui';
import { Stat } from '@/components/vertical-ui';
import { toast } from '@/components/toast';
import { FormField, SectionCard } from '@/components/jarvis';
import { ROLE_LABEL, errorText, inputCls, usd, withInr, type OfficeSettings } from '@/components/office';

type Usage = {
  days: Array<{ date: string; usd: number; tokensIn: number; tokensOut: number; calls: number }>;
  agents: Array<{ role: string; usd: number; tokens: number; calls: number; completed: number; needsReview: number; failed: number }>;
  totals: { usd: number; calls: number; tokens: number };
  plans: { finished: number; completed: number; avgUsd: number | null; avgEstimateUsd: number | null; avgMinutes: number | null };
  inrPerUsd: number;
  priceSource: string;
};

export default function OfficeUsagePage() {
  const [days, setDays] = useState<'1' | '7' | '30'>('7');
  const { data, error, reload } = useApi<Usage>(`/office/usage?days=${days}`, 60_000);
  const settings = useApi<OfficeSettings>('/office/settings', 0);
  const [f, setF] = useState<OfficeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (settings.data && !f) setF(settings.data); }, [settings.data, f]);
  const save = async () => {
    if (!f) return;
    setBusy(true);
    try { setF(await api.put<OfficeSettings>('/office/settings', f)); toast('Office settings saved.'); reload(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const num = (v: string) => Number(v);
  const max = Math.max(0.0001, ...(data?.days.map((d) => d.usd) ?? [0]));
  return (
    <>
      <PageHeader title="Usage & settings" crumb="AI Office" actions={<Segmented label="Period" value={days} onChange={setDays} options={[{ value: '1', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />} />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-64" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="AI model cost" value={usd(data.totals.usd)} hint={data.inrPerUsd > 0 ? `≈ ₹${(data.totals.usd * data.inrPerUsd).toFixed(2)}` : 'Measured per model call'} />
            <Stat label="Model calls" value={data.totals.calls.toLocaleString('en-IN')} hint={`${data.totals.tokens.toLocaleString('en-IN')} tokens`} />
            <Stat label="Plans finished" value={data.plans.finished} hint={`${data.plans.completed} completed`} />
            <Stat label="Average plan" value={usd(data.plans.avgUsd)} hint={data.plans.avgEstimateUsd !== null ? `estimate ${usd(data.plans.avgEstimateUsd)}${data.plans.avgMinutes !== null ? ` · ${data.plans.avgMinutes} min` : ''}` : 'No finished plans yet'} />
          </div>
          <SectionCard title="Cost by day" subtitle={data.priceSource}>
            <ol className="flex h-36 items-end gap-1 px-4 pb-2" aria-label="Cost by day">
              {data.days.map((d) => (
                <li key={d.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${d.date}: ${usd(d.usd)}, ${d.calls} calls`}>
                  <span className="w-full max-w-10 rounded-t bg-violet-500/80" style={{ height: `${Math.max(2, (d.usd / max) * 100)}%` }} />
                  <span className="text-[10.5px] text-muted">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</span>
                </li>
              ))}
            </ol>
          </SectionCard>
          <SectionCard title="By agent" subtitle="Cost and how their work ended (tasks created in this period).">
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead><tr className="text-left text-muted"><th className="px-4 py-2 font-semibold">Agent</th><th className="px-4 py-2 text-right font-semibold">Cost</th><th className="px-4 py-2 text-right font-semibold">Model calls</th><th className="px-4 py-2 text-right font-semibold">Completed</th><th className="px-4 py-2 text-right font-semibold">Needed review</th><th className="px-4 py-2 text-right font-semibold">Failed</th></tr></thead>
                <tbody>{data.agents.map((a) => <tr key={a.role} className="border-t border-line tabular"><td className="px-4 py-2 text-ink">{ROLE_LABEL[a.role] ?? a.role}</td><td className="px-4 py-2 text-right">{usd(a.usd)}</td><td className="px-4 py-2 text-right">{a.calls}</td><td className="px-4 py-2 text-right">{a.completed}</td><td className="px-4 py-2 text-right">{a.needsReview}</td><td className="px-4 py-2 text-right">{a.failed}</td></tr>)}{!data.agents.length && <tr><td colSpan={6} className="px-4 py-3 text-muted">No usage in this period.</td></tr>}</tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}
      {f && (
        <SectionCard title="Office settings" subtitle="Budgets are enforced by the engine before every model call. Changing these needs the office.manage right." action={<Button variant="primary" onClick={() => void save()} busy={busy}><Save className="size-4" aria-hidden /> Save</Button>}>
          <div className="grid gap-4 px-4 pb-4 md:grid-cols-3">
            <FormField label="Default mode"><select className={inputCls} value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as OfficeSettings['mode'] })}><option value="manual">Manual</option><option value="supervised">Supervised</option><option value="autonomous">Autonomous within budget</option></select></FormField>
            <FormField label="Default model"><select className={inputCls} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}><option value="gpt-5.4-mini">gpt-5.4-mini</option><option value="gpt-5.4">gpt-5.4</option></select></FormField>
            <FormField label="Daily limit (US$, all plans)"><input type="number" min={0.05} step={0.5} className={inputCls} value={f.maxUsdPerDay} onChange={(e) => setF({ ...f, maxUsdPerDay: num(e.target.value) })} /></FormField>
            <FormField label="Per plan: max US$"><input type="number" min={0.01} step={0.1} className={inputCls} value={f.budgets.maxUsd} onChange={(e) => setF({ ...f, budgets: { ...f.budgets, maxUsd: num(e.target.value) } })} /></FormField>
            <FormField label="Per plan: max model steps"><input type="number" min={1} className={inputCls} value={f.budgets.maxSteps} onChange={(e) => setF({ ...f, budgets: { ...f.budgets, maxSteps: num(e.target.value) } })} /></FormField>
            <FormField label="Per plan: deadline (minutes)"><input type="number" min={5} className={inputCls} value={f.budgets.deadlineMinutes} onChange={(e) => setF({ ...f, budgets: { ...f.budgets, deadlineMinutes: num(e.target.value) } })} /></FormField>
            <FormField label="Tasks at the same time"><input type="number" min={1} max={5} className={inputCls} value={f.concurrency} onChange={(e) => setF({ ...f, concurrency: num(e.target.value) })} /></FormField>
            <FormField label="Messages per plan before stopping (hop cap)"><input type="number" min={2} max={20} className={inputCls} value={f.hopCap} onChange={(e) => setF({ ...f, hopCap: num(e.target.value) })} /></FormField>
            <FormField label="₹ per US$ (to show rupees; 0 = off)"><input type="number" min={0} step={0.01} className={inputCls} value={f.inrPerUsd} onChange={(e) => setF({ ...f, inrPerUsd: num(e.target.value) })} /></FormField>
          </div>
          <p className="px-4 pb-4 text-[11.5px] text-muted">Plan limit now: {withInr(f.budgets.maxUsd, f.inrPerUsd)}. Messages to customers always need a person’s approval, in every mode.</p>
        </SectionCard>
      )}
    </>
  );
}
