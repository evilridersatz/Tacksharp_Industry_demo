'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CalendarCheck, CalendarDays, IndianRupee, PhoneCall, Timer, TrendingUp, Users } from 'lucide-react';
import { useApi } from '@/lib/api';
import type { Roi } from '@/lib/types';
import { PageHeader } from '@/components/shell';
import { Card, CardHeader, Empty, ErrorBanner, IconTile, Skeleton, type Tone } from '@/components/ui';

const inr = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
/** Per-unit rates keep their paise (₹4.50 per minute), totals are whole rupees. */
const rateInr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const pctText = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`);

/**
 * A rate with its denominator: 0 cases means "no data yet" (not 0%), and a handful of cases is shown but flagged,
 * so a 100% from one visit is not read as a result.
 */
function rateWithSample(pct: number | null | undefined, n: number | undefined, min: number | undefined, hint: string) {
  if (n === undefined) return { value: pctText(pct), hint };
  if (n === 0) return { value: '—', hint: `No data yet · ${hint}` };
  if (n < (min ?? 5)) return { value: pctText(pct), hint: `Not enough data (${n} case${n === 1 ? '' : 's'}) · ${hint}` };
  return { value: pctText(pct), hint: `${hint} · n=${n}` };
}

function duration(sec: number | null | undefined) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 90) return `${sec}s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)} min`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86_400)} days`;
}

function Kpi({ icon, tone, label, value, hint }: { icon: React.ReactNode; tone: Tone; label: string; value: string; hint: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2.5">
        <IconTile tone={tone} size="sm">{icon}</IconTile>
        <p className="text-[12.5px] font-semibold text-muted">{label}</p>
      </div>
      <p className="mt-3 text-[26px] leading-none font-bold text-ink tabular">{value}</p>
      <p className="mt-1.5 text-[12px] text-muted">{hint}</p>
    </Card>
  );
}

export default function PerformancePage() {
  const [days, setDays] = useState('30');
  const { data, error, reload } = useApi<Roi>(`/dashboard/roi?days=${days}`, 60_000);
  const top = data?.funnel[0]?.count ?? 0;
  const costsUnset = data && data.costs.inputs.voiceCostPerMinuteInr === 0 && data.costs.inputs.whatsappCostPerMessageInr === 0;

  return (
    <>
      <PageHeader
        title="Performance & ROI"
        actions={
          <label className="relative inline-flex h-9 items-center gap-2 rounded-[10px] border border-line bg-white pr-2 pl-3 text-[13px] font-semibold text-ink">
            <CalendarDays className="size-4 text-muted" />
            <select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)} className="bg-transparent pr-1 outline-none">
              <option value="7">Leads from last 7 days</option>
              <option value="30">Leads from last 30 days</option>
              <option value="90">Leads from last 90 days</option>
            </select>
          </label>
        }
      />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {!data && [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[118px]" />)}
        {data && (
          <>
            <Kpi icon={<Timer className="size-4" />} tone="violet" label="Speed to first call" value={duration(data.speedToFirstCall.medianSec)}
              hint={data.speedToFirstCall.called === 0 ? 'No AI calls in this period yet' : `median · ${pctText(data.speedToFirstCall.within2MinPct)} called within 2 min${data.speedToFirstCall.called < (data.samples?.minSample ?? 5) ? ` · not enough data (${data.speedToFirstCall.called})` : ''}`} />
            <Kpi icon={<PhoneCall className="size-4" />} tone="sky" label="Contact rate" {...rateWithSample(data.rates.contactPct, data.samples?.contact, data.samples?.minSample, 'answered a call or replied on WhatsApp')} />
            <Kpi icon={<CalendarCheck className="size-4" />} tone="brand" label="Visit booking rate" {...rateWithSample(data.rates.bookingPct, data.samples?.booking, data.samples?.minSample, 'of leads reached')} />
            <Kpi icon={<Users className="size-4" />} tone="amber" label="Show-up rate" {...rateWithSample(data.rates.showUpPct, data.samples?.showUp, data.samples?.minSample, 'visited ÷ (visited + no-show)')} />
            <Kpi icon={<IndianRupee className="size-4" />} tone="rose" label="Cost per attended visit" value={inr(data.costs.perAttendedVisitInr)} hint="ad spend + voice + WhatsApp" />
          </>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Lead funnel" subtitle="Where leads drop off, for leads created in the period" />
          <div className="flex flex-col gap-3 px-5 pb-5">
            {!data && <Skeleton className="h-40" />}
            {data && top === 0 && <Empty icon={<TrendingUp className="size-6" />} title="No leads in this period">New Meta leads appear here as the AI works them.</Empty>}
            {data && top > 0 &&
              data.funnel.map((f, i) => {
                const width = Math.max(2, Math.round((f.count / top) * 100));
                const prev = i > 0 ? data.funnel[i - 1].count : 0;
                return (
                  <div key={f.stage}>
                    <div className="mb-1 flex items-baseline justify-between text-[13px]">
                      <span className="font-semibold text-ink">{f.stage}</span>
                      <span className="text-muted tabular">
                        <span className="font-semibold text-ink">{f.count}</span>
                        {i > 0 && prev > 0 && <span> · {Math.round((f.count / prev) * 100)}% of previous</span>}
                      </span>
                    </div>
                    <div className="h-3 rounded-full bg-slate-100">
                      <div className="h-3 rounded-full bg-brand" style={{ width: `${width}%`, opacity: 1 - i * 0.12 }} />
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>

        <Card>
          <CardHeader title="Cost" subtitle={data ? `${data.leads} leads · ${data.usage.connectedMinutes} connected call minutes · ${data.usage.whatsappSent} WhatsApp messages` : ' '} />
          <div className="px-5 pb-5 text-[13px]">
            {!data && <Skeleton className="h-32" />}
            {data && (
              <>
                {[
                  ['Ad spend', data.costs.adSpendInr, `${rateInr(data.costs.inputs.costPerLeadInr)} per lead`],
                  ['Voice', data.costs.voiceInr, `${rateInr(data.costs.inputs.voiceCostPerMinuteInr)} per minute`],
                  ['WhatsApp', data.costs.whatsappInr, `${rateInr(data.costs.inputs.whatsappCostPerMessageInr)} per message`],
                ].map(([label, value, hint]) => (
                  <div key={label as string} className="flex items-baseline justify-between border-b border-line py-2">
                    <span className="text-muted">{label} <span className="text-[11.5px]">({hint})</span></span>
                    <span className="font-semibold text-ink tabular">{inr(value as number)}</span>
                  </div>
                ))}
                <div className="flex items-baseline justify-between py-2">
                  <span className="font-semibold text-ink">Total</span>
                  <span className="font-bold text-ink tabular">{inr(data.costs.totalInr)}</span>
                </div>
                {costsUnset && (
                  <p className="mt-2 rounded-[10px] bg-amber-soft px-3 py-2 text-[12px] text-[#b45309]">
                    Voice and WhatsApp costs are not set, so they count as ₹0. Add your rates in <Link href="/settings" className="font-semibold underline">Settings</Link>.
                  </p>
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="By campaign" subtitle="Which ads bring visits, not just leads" />
        <div className="overflow-x-auto px-5 pb-4">
          <table className="w-full min-w-[560px] text-[13px]">
            <thead>
              <tr className="text-left text-[11.5px] text-muted uppercase">
                <th className="py-2 font-semibold">Campaign / source</th>
                <th className="py-2 text-right font-semibold">Leads</th>
                <th className="py-2 text-right font-semibold">Reached</th>
                <th className="py-2 text-right font-semibold">Visits booked</th>
                <th className="py-2 text-right font-semibold">Visited</th>
                <th className="py-2 text-right font-semibold">Ad cost per visit</th>
              </tr>
            </thead>
            <tbody>
              {data?.byCampaign.map((c) => (
                <tr key={c.name} className="border-t border-line">
                  <td className="py-2.5 font-semibold text-ink">{c.name}</td>
                  <td className="py-2.5 text-right tabular">{c.leads}</td>
                  <td className="py-2.5 text-right tabular">{c.reached}</td>
                  <td className="py-2.5 text-right tabular">{c.booked}</td>
                  <td className="py-2.5 text-right tabular">{c.attended}</td>
                  <td className="py-2.5 text-right tabular">{inr(c.costPerAttendedInr)}</td>
                </tr>
              ))}
              {data && data.byCampaign.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-muted">No leads in this period.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
