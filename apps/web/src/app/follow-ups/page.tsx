'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CheckCircle2, Clock3, ListChecks, MessageSquare, Phone, XCircle } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { FollowUp } from '@/lib/types';
import { dayLabel, displayName, followUpLabel, requirement, stopReason, timeOnly } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Card, Empty, ErrorBanner, IconTile, Segmented, Skeleton } from '@/components/ui';
import { useMe } from '@/lib/restaurant';
import { RestaurantFollowUps } from '@/components/restaurant/followups';

type Tab = 'upcoming' | 'done' | 'stopped';

export default function FollowUpsPage() {
  const me = useMe();
  if (!me) return <Skeleton className="h-[480px] rounded-[14px]" />;
  return me.vertical === 'restaurant' ? <RestaurantFollowUps /> : <RealEstateFollowUps />;
}

function RealEstateFollowUps() {
  const [tab, setTab] = useState<Tab>('upcoming');
  const { data, error, reload } = useApi<FollowUp[]>('/follow-ups');
  const [busy, setBusy] = useState<string | null>(null);

  const all = (data ?? []).filter((f) => f.channel !== 'human');
  const groups = {
    upcoming: all.filter((f) => f.status === 'scheduled' || f.status === 'processing').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
    done: all.filter((f) => f.status === 'completed').sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)),
    stopped: all.filter((f) => ['cancelled', 'skipped', 'failed'].includes(f.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
  const list = groups[tab];

  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of groups.stopped) m.set(stopReason(f), (m.get(stopReason(f)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [groups.stopped]);

  async function cancel(f: FollowUp) {
    setBusy(f.id);
    try {
      await api.patch(`/follow-ups/${f.id}/cancel`, { reason: 'Cancelled from dashboard' });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  let lastDay = '';
  return (
    <>
      <PageHeader title="Follow-ups" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">Follow-up timeline</h2>
              <p className="text-[12.5px] text-muted">Every automatic WhatsApp message and AI call, by day</p>
            </div>
            <Segmented
              label="Follow-up status"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'upcoming', label: `Upcoming (${groups.upcoming.length})` },
                { value: 'done', label: `Done (${groups.done.length})` },
                { value: 'stopped', label: `Stopped (${groups.stopped.length})` },
              ]}
            />
          </div>
          {error && !data && <div className="px-5"><ErrorBanner message={error} onRetry={reload} /></div>}
          <ul className="px-5 pb-4">
            {!data && [0, 1, 2].map((i) => <Skeleton key={i} className="my-2 h-12" />)}
            {list.slice(0, 200).map((f) => {
              const day = dayLabel(tab === 'stopped' ? f.updatedAt : f.scheduledAt);
              const showDay = day !== lastDay;
              lastDay = day;
              return (
                <li key={f.id}>
                  {showDay && <p className="mt-3 mb-1 text-[12px] font-semibold text-muted">{day}</p>}
                  <div className="flex items-center gap-3 border-t border-line py-2.5">
                    <span className="w-16 text-[12px] text-muted tabular">{timeOnly(f.scheduledAt)}</span>
                    <IconTile size="sm" tone={f.channel === 'voice' ? 'violet' : 'brand'}>
                      {f.channel === 'voice' ? <Phone className="size-3.5" /> : <MessageSquare className="size-3.5" />}
                    </IconTile>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-ink">
                        <span className="font-semibold">{followUpLabel(f)}</span>
                        <span className="text-muted"> to </span>
                        <Link href={`/leads/${f.leadId}`} className="font-semibold hover:underline">
                          {displayName(f.customer)}
                        </Link>
                      </p>
                      <p className="truncate text-[12px] text-muted">{tab === 'stopped' ? stopReason(f) : requirement(f.lead) || ' '}</p>
                    </div>
                    {tab === 'upcoming' && (
                      <button onClick={() => cancel(f)} disabled={busy === f.id} className="text-[12px] font-semibold text-rose hover:underline disabled:opacity-50">
                        Cancel
                      </button>
                    )}
                    {tab === 'done' && <CheckCircle2 className="size-4 text-brand" aria-label="Done" />}
                    {tab === 'stopped' && (
                      <Badge tone={f.status === 'failed' ? 'rose' : f.status === 'skipped' ? 'amber' : 'slate'}>{f.status === 'cancelled' ? 'Stopped' : f.status === 'skipped' ? 'Not sent' : 'Failed'}</Badge>
                    )}
                  </div>
                </li>
              );
            })}
            {data && list.length === 0 && (
              <Empty icon={<ListChecks className="size-6" />} title={tab === 'upcoming' ? 'Nothing scheduled' : tab === 'done' ? 'Nothing sent yet' : 'Nothing stopped'}>
                {tab === 'upcoming' ? 'New leads get a WhatsApp message and an AI call automatically.' : null}
              </Empty>
            )}
          </ul>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <h2 className="text-[15px] font-semibold text-ink">How follow-up works</h2>
            <ol className="mt-3 flex flex-col gap-3 text-[13px]">
              {[
                ['Right away', 'WhatsApp message', MessageSquare],
                ['30 minutes', 'WhatsApp reminder', MessageSquare],
                ['2 hours', 'AI call, 9 AM–9 PM only', Phone],
                ['24 hours', 'Last WhatsApp follow-up', MessageSquare],
              ].map(([when, what, Icon], i) => {
                const I = Icon as typeof Phone;
                return (
                  <li key={i} className="flex items-center gap-3">
                    <IconTile size="sm" tone={I === Phone ? 'violet' : 'brand'}>
                      <I className="size-3.5" />
                    </IconTile>
                    <span className="flex-1 text-ink">{what as string}</span>
                    <span className="flex items-center gap-1 text-[12px] text-muted">
                      <Clock3 className="size-3" /> {when as string}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-3 text-[12px] text-muted">Each step checks first and stops if the customer replied, booked a visit, opted out or asked for a person.</p>
          </Card>
          <Card className="p-5">
            <h2 className="text-[15px] font-semibold text-ink">Why follow-ups stopped</h2>
            <ul className="mt-2">
              {reasons.map(([r, n]) => (
                <li key={r} className="flex items-center justify-between border-t border-line py-2 text-[13px] first:border-t-0">
                  <span className="flex items-center gap-2 text-body">
                    <XCircle className="size-3.5 text-faint" /> {r}
                  </span>
                  <span className="font-semibold text-ink tabular">{n}</span>
                </li>
              ))}
              {reasons.length === 0 && <p className="text-[12.5px] text-muted">None yet.</p>}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
