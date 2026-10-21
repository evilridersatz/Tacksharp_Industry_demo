'use client';

import { useState } from 'react';
import { BedDouble, Users } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { IndustryOnly, Notice, errorText } from '@/components/textile';
import { Pill, SourceNote, Stat, shortDate, money } from '@/components/vertical-ui';

type RoomType = {
  id: string; code: string; name: string; description: string | null; bedType: string | null; sizeSqft: number | null; maxAdults: number; maxChildren: number; maxOccupancy: number;
  baseRate: number; weekendRate: number | null; amenities: string[]; active: boolean; sellableRooms: number;
  rooms: Array<{ id: string; number: string; floor: string | null; status: string; housekeeping: string; notes: string | null }>;
  seasonalRates: Array<{ id: string; name: string; startDate: string; endDate: string; rate: number }>;
};

export default function RoomsPage() {
  return (
    <>
      <PageHeader title="Rooms & rates" crumb="Front desk" />
      <IndustryOnly allow={['hotel']}>
        <Rooms />
      </IndustryOnly>
    </>
  );
}

const NEXT_HK: Record<string, string> = { clean: 'dirty', dirty: 'inspecting', inspecting: 'clean' };

function Rooms() {
  const { data, error, reload } = useApi<RoomType[]>('/hotel/room-types', 30_000);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-96" />;
  const all = data.flatMap((t) => t.rooms);
  async function patch(id: string, body: Record<string, string>, text: string) {
    try {
      await api.patch(`/hotel/rooms/${id}`, body);
      setNotice({ tone: 'ok', text });
      await reload();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    }
  }
  return (
    <>
      <Notice notice={notice} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Rooms" value={all.length} hint={`${data.length} room types`} />
        <Stat label="Occupied now" value={all.filter((r) => r.status === 'occupied').length} />
        <Stat label="Need housekeeping" value={all.filter((r) => r.housekeeping !== 'clean').length} tone={all.some((r) => r.housekeeping === 'dirty') ? 'amber' : undefined} />
        <Stat label="Out of service" value={all.filter((r) => r.status === 'out_of_service').length} tone={all.some((r) => r.status === 'out_of_service') ? 'red' : undefined} />
      </div>
      <div className="flex flex-col gap-4">
        {data.map((t) => (
          <Card key={t.id} className="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[16px] font-bold text-ink"><BedDouble className="size-4 text-muted" aria-hidden /> {t.name} <span className="text-[12px] font-normal text-muted">{t.code}</span></p>
                <p className="mt-0.5 text-[12.5px] text-muted">{t.bedType} bed{t.sizeSqft ? ` · ${t.sizeSqft} sq ft` : ''} · <Users className="inline size-3.5" aria-hidden /> up to {t.maxAdults} adults / {t.maxOccupancy} guests</p>
                <div className="mt-2 flex flex-wrap gap-1.5">{t.amenities.map((a) => <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11.5px] text-slate-600">{a}</span>)}</div>
              </div>
              <div className="text-right">
                <p className="text-[18px] font-bold text-ink tabular">{money(t.baseRate)}<span className="text-[12px] font-normal text-muted"> / night</span></p>
                {t.weekendRate !== null && <p className="text-[12px] text-muted">Fri / Sat {money(t.weekendRate)}</p>}
                <p className="text-[12px] text-muted">{t.sellableRooms} sellable of {t.rooms.length}</p>
              </div>
            </div>
            {t.seasonalRates.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {t.seasonalRates.map((r) => <span key={r.id} className="rounded-[8px] border border-line px-2 py-1 text-[11.5px] text-body"><b>{r.name}</b> {shortDate(r.startDate)} – {shortDate(r.endDate)}: {money(r.rate)}</span>)}
              </div>
            )}
            <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {t.rooms.map((r) => (
                <li key={r.id}>
                  <div className={cx('flex h-full flex-col gap-1 rounded-[12px] border p-2.5', r.status === 'out_of_service' ? 'border-rose-200 bg-rose-50/50' : r.status === 'occupied' ? 'border-violet-200 bg-violet-50/40' : 'border-line bg-white')}>
                    <p className="text-[15px] font-bold text-ink">{r.number}</p>
                    <Pill status={r.status} />
                    <button type="button" onClick={() => patch(r.id, { housekeeping: NEXT_HK[r.housekeeping] ?? 'clean' }, `Room ${r.number}: ${NEXT_HK[r.housekeeping] ?? 'clean'}`)} className="text-left" title="Change housekeeping status">
                      <Pill status={r.housekeeping} />
                    </button>
                    {r.status !== 'occupied' && (
                      <button type="button" onClick={() => patch(r.id, { status: r.status === 'out_of_service' ? 'available' : 'out_of_service' }, `Room ${r.number}: ${r.status === 'out_of_service' ? 'back in service' : 'out of service'}`)} className="mt-auto text-left text-[11px] font-semibold text-muted underline-offset-2 hover:text-ink hover:underline">
                        {r.status === 'out_of_service' ? 'Return to service' : 'Take out of service'}
                      </button>
                    )}
                    {r.notes && <p className="text-[10.5px] text-muted">{r.notes}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-muted">Rooms out of service are not sold. Tap a housekeeping badge to move it clean → dirty → inspecting → clean.</p>
      <SourceNote api="GET /hotel/room-types · PATCH /hotel/rooms/:id" />
    </>
  );
}
