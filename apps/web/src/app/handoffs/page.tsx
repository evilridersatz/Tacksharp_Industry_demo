'use client';

import { useState } from 'react';
import { CheckCircle2, Headset, MessageSquare, Phone } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { FollowUp } from '@/lib/types';
import { LEAD_STATUS, dateTime, displayName, formatPhone, requirement, rupees, telLink, timeAgo, waLink } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Button, Card, Empty, ErrorBanner, Segmented, Skeleton } from '@/components/ui';

export default function HandoffsPage() {
  const [tab, setTab] = useState<'open' | 'completed'>('open');
  const { data, error, reload } = useApi<FollowUp[]>('/follow-ups?channel=human', 8_000);
  const [busy, setBusy] = useState<string | null>(null);
  const tasks = (data ?? []).filter((t) => t.status === tab).sort((a, b) => (tab === 'open' ? a.createdAt.localeCompare(b.createdAt) : b.updatedAt.localeCompare(a.updatedAt)));
  const open = (data ?? []).filter((t) => t.status === 'open').length;

  async function done(t: FollowUp) {
    setBusy(t.id);
    try {
      await api.patch(`/follow-ups/${t.id}/complete`);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader title="Human handoff" />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          Customers who asked for a person, wanted a callback without a time, or had an unclear AI call. The AI has stopped contacting them.
        </p>
        <Segmented
          label="Tasks"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'open', label: `Waiting (${open})` },
            { value: 'completed', label: 'Done' },
          ]}
        />
      </div>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {!data && [0, 1, 2].map((i) => <Skeleton key={i} className="h-48" />)}
        {tasks.map((t) => {
          const st = t.lead ? LEAD_STATUS[t.lead.status] : null;
          const reasons = (t.message ?? '').split('\n').map((r) => r.replace(/^Handoff: /, '')).filter(Boolean);
          return (
            <Card key={t.id} className="flex flex-col p-4">
              <div className="flex items-center gap-3">
                <Avatar person={t.customer} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-ink">{displayName(t.customer)}</p>
                  <p className="text-[12px] text-muted">{formatPhone(t.customer?.phone)}</p>
                </div>
                <span className="text-[12px] text-faint" title={dateTime(t.createdAt)}>
                  waiting {timeAgo(t.createdAt)}
                </span>
              </div>
              <div className="mt-3 flex-1 rounded-[10px] bg-rose-soft/60 px-3 py-2.5">
                {reasons.map((r) => (
                  <p key={r} className="text-[13px] text-ink">
                    {r}
                  </p>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
                {st && <Badge tone={st.tone}>{st.label}</Badge>}
                {t.lead && requirement(t.lead) && <Badge tone="slate">{requirement(t.lead)}</Badge>}
                {t.lead?.budget && <Badge tone="amber">{rupees(t.lead.budget)}</Badge>}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <Button href={telLink(t.customer?.phone)} className="px-2">
                  <Phone className="size-4" /> Call
                </Button>
                <Button href={waLink(t.customer?.phone)} className="px-2">
                  <MessageSquare className="size-4" /> Chat
                </Button>
                <Button href={`/leads/${t.leadId}`} className="px-2">
                  Lead
                </Button>
              </div>
              {tab === 'open' && (
                <Button variant="primary" className="mt-2 w-full" busy={busy === t.id} onClick={() => done(t)}>
                  <CheckCircle2 className="size-4" /> Mark done
                </Button>
              )}
            </Card>
          );
        })}
      </div>
      {data && tasks.length === 0 && (
        <Card className="mt-2">
          <Empty icon={<Headset className="size-6" />} title={tab === 'open' ? 'Nobody is waiting' : 'No completed tasks yet'}>
            {tab === 'open' ? 'When a customer asks for a person, they appear here with the reason.' : null}
          </Empty>
        </Card>
      )}
    </>
  );
}
