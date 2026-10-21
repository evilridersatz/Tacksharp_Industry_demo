'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { IndustryOnly } from '@/components/textile';
import { SourceNote, money, plusDays, todayIst } from '@/components/vertical-ui';

type Cal = { from: string; days: number; roomTypes: Array<{ roomTypeId: string; name: string; code: string; sellable: number; nights: Array<{ date: string; booked: number; available: number; rate: number; rateSource: string }> }> };

export default function AvailabilityPage() {
  return (
    <>
      <PageHeader title="Availability calendar" crumb="Front desk" />
      <IndustryOnly allow={['hotel']}>
        <Calendar />
      </IndustryOnly>
    </>
  );
}

function Calendar() {
  const [from, setFrom] = useState(todayIst());
  const [days, setDays] = useState<'7' | '14' | '21'>('14');
  const { data, error, reload } = useApi<Cal>(`/hotel/calendar?from=${from}&days=${days}`, 30_000);
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Button aria-label="Earlier" onClick={() => setFrom(plusDays(from, -Number(days)))}><ChevronLeft className="size-4" /></Button>
        <Button onClick={() => setFrom(todayIst())}>Today</Button>
        <Button aria-label="Later" onClick={() => setFrom(plusDays(from, Number(days)))}><ChevronRight className="size-4" /></Button>
        <Segmented label="Days shown" value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '21', label: '21 days' }]} />
        <div className="ml-auto flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
          <span className="inline-flex items-center gap-1"><span className="size-3 rounded bg-emerald-100 ring-1 ring-emerald-300" /> plenty</span>
          <span className="inline-flex items-center gap-1"><span className="size-3 rounded bg-amber-100 ring-1 ring-amber-300" /> few left</span>
          <span className="inline-flex items-center gap-1"><span className="size-3 rounded bg-rose-100 ring-1 ring-rose-300" /> sold out</span>
        </div>
      </div>
      {!data ? <Skeleton className="h-72" /> : (
        <Card className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 min-w-[150px] border-b border-line bg-white px-3 py-2 text-left font-semibold text-muted">Room type</th>
                {data.roomTypes[0]?.nights.map((n) => {
                  const d = new Date(`${n.date}T00:00:00Z`);
                  const wknd = [5, 6].includes(d.getUTCDay());
                  return (
                    <th key={n.date} className={cx('min-w-[62px] border-b border-line px-1 py-2 text-center font-semibold', n.date === todayIst() ? 'text-ink' : 'text-muted', wknd && 'bg-slate-50')}>
                      <span className="block text-[10.5px] uppercase">{d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}</span>
                      {d.getUTCDate()} {d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.roomTypes.map((t) => (
                <tr key={t.roomTypeId}>
                  <th className="sticky left-0 z-10 border-b border-line bg-white px-3 py-2 text-left">
                    <p className="font-semibold text-ink">{t.name}</p>
                    <p className="text-[11px] font-normal text-muted">{t.sellable} sellable</p>
                  </th>
                  {t.nights.map((n) => {
                    const ratio = t.sellable ? n.available / t.sellable : 0;
                    return (
                      <td key={n.date} className="border-b border-line p-1 text-center">
                        <div className={cx('rounded-[8px] px-1 py-1.5 ring-1', n.available === 0 ? 'bg-rose-50 text-rose-700 ring-rose-200' : n.available <= 1 || ratio <= 0.3 ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-emerald-50 text-emerald-800 ring-emerald-200')} title={`${n.booked} booked of ${t.sellable}; rate ${money(n.rate)} (${n.rateSource})`}>
                          <p className="text-[14px] font-bold tabular">{n.available}</p>
                          <p className="text-[10px] opacity-80 tabular">{money(n.rate)}</p>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="mt-2 text-[12px] text-muted">Each cell: rooms still free that night and the rate that night (seasonal, weekend or base). Confirmed, in-house and still-held pending bookings count as taken.</p>
      <SourceNote api="GET /hotel/calendar" />
    </>
  );
}
