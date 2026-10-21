'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CalendarCheck, CheckCircle2, MapPin } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { SiteVisit } from '@/lib/types';
import { VISIT_STATUS, dayLabel, displayName, formatPhone, rupees, timeOnly } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Button, Card, Empty, ErrorBanner, Segmented, Skeleton, type Tone } from '@/components/ui';

const STATUS = VISIT_STATUS;

/** Next actions allowed by the API for each status. */
const ACTIONS: Record<string, Array<{ to: string; label: string }>> = {
  requested: [{ to: 'scheduled', label: 'Book' }, { to: 'cancelled', label: 'Cancel' }],
  scheduled: [{ to: 'confirmed', label: 'Confirm' }, { to: 'no_show', label: 'No-show' }, { to: 'cancelled', label: 'Cancel' }],
  confirmed: [{ to: 'completed', label: 'Mark visited' }, { to: 'no_show', label: 'No-show' }, { to: 'cancelled', label: 'Cancel' }],
};

export default function SiteVisitsPage() {
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const { data, error, reload } = useApi<SiteVisit[]>('/site-visits');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = Date.now();
  const visits = (data ?? []).filter((v) =>
    tab === 'upcoming'
      ? new Date(v.scheduledAt).getTime() >= now - 3 * 3600_000 && !['completed', 'cancelled', 'no_show'].includes(v.status)
      : new Date(v.scheduledAt).getTime() < now - 3 * 3600_000 || ['completed', 'cancelled', 'no_show'].includes(v.status),
  );
  if (tab === 'past') visits.reverse();

  async function change(v: SiteVisit, status: string) {
    setBusy(v.id);
    setErr(null);
    try {
      await api.patch(`/site-visits/${v.id}/status`, { status });
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  let lastDay = '';
  return (
    <>
      <PageHeader title="Site visits" />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Visits booked by the AI</h2>
            <p className="text-[12.5px] text-muted">Confirm the day before, then mark what happened</p>
          </div>
          <Segmented label="Visits" value={tab} onChange={setTab} options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }]} />
        </div>
        {(err || (error && !data)) && <div className="px-5 pb-2"><ErrorBanner message={err ?? error!} onRetry={reload} /></div>}
        <ul className="px-5 pb-4">
          {!data && [0, 1].map((i) => <Skeleton key={i} className="my-2 h-16" />)}
          {visits.map((v) => {
            const day = dayLabel(v.scheduledAt);
            const showDay = day !== lastDay;
            lastDay = day;
            const st = STATUS[v.status] ?? { label: v.status, tone: 'slate' as Tone };
            return (
              <li key={v.id}>
                {showDay && <p className="mt-3 mb-1 text-[12px] font-semibold text-muted">{day}</p>}
                <div className="flex flex-wrap items-center gap-3 border-t border-line py-3">
                  <span className="w-16 text-[13px] font-semibold text-ink tabular">{timeOnly(v.scheduledAt)}</span>
                  <Avatar person={v.Customer} size={34} />
                  <div className="min-w-[180px] flex-1">
                    <Link href={`/leads/${v.leadId}`} className="text-[13px] font-semibold text-ink hover:underline">
                      {displayName(v.Customer)}
                    </Link>
                    <p className="text-[12px] text-muted">{formatPhone(v.Customer?.phone)}</p>
                  </div>
                  <div className="min-w-[200px] flex-1">
                    <p className="text-[13px] font-semibold text-ink">{v.Property?.name}</p>
                    <p className="flex items-center gap-1 text-[12px] text-muted">
                      <MapPin className="size-3" /> {v.Property?.location} · {v.Property?.bhk ? `${v.Property.bhk} BHK · ` : ''}
                      {rupees(v.Property?.price)}
                    </p>
                  </div>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  <div className="flex gap-1.5">
                    {(ACTIONS[v.status] ?? []).map((a) => (
                      <Button key={a.to} variant={a.to === 'cancelled' || a.to === 'no_show' ? 'ghost' : 'secondary'} className="h-8 px-2.5" disabled={busy === v.id} onClick={() => change(v, a.to)}>
                        {a.to === 'completed' && <CheckCircle2 className="size-3.5" />}
                        {a.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
          {data && visits.length === 0 && (
            <Empty icon={<CalendarCheck className="size-6" />} title={tab === 'upcoming' ? 'No visits booked' : 'No past visits'}>
              The AI books a visit when a customer agrees to a property, date and time.
            </Empty>
          )}
        </ul>
      </Card>
    </>
  );
}
