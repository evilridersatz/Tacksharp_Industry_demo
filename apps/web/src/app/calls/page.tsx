'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { Bot, Clock3, Headset, Phone, PhoneCall, PhoneIncoming, PhoneOutgoing, Sparkles } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Call, Message, Summary } from '@/lib/types';
import { callBadge, dateTime, displayName, duration, formatPhone, languageLabel, minutesSeconds, pct, requirement, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Button, Card, Empty, ErrorBanner, IconTile, Segmented, Skeleton, cx } from '@/components/ui';
import { Transcript } from '@/components/conversation';

type Filter = 'all' | 'outbound' | 'inbound' | 'missed';

export default function CallsPage() {
  return (
    <Suspense>
      <Calls />
    </Suspense>
  );
}

function Calls() {
  const params = useSearchParams();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const { data: calls, error, reload } = useApi<Call[]>('/voice/calls', 5_000);
  const { data: s } = useApi<Summary>('/dashboard/summary?days=7');
  const shown = useMemo(
    () =>
      (calls ?? []).filter((c) =>
        filter === 'all' ? true : filter === 'missed' ? ['no_answer', 'busy', 'failed'].includes(c.status) : c.direction === filter,
      ),
    [calls, filter],
  );
  const selectedId = params.get('id') ?? (shown.find((c) => c.answeredAt) ?? shown[0])?.id ?? null;
  const { data: detail } = useApi<{ call: Call; transcript: Message[] }>(selectedId ? `/voice/calls/${selectedId}` : null, 5_000);
  const staff = s?.voice.outcomes.human_requested ?? 0;

  return (
    <>
      <PageHeader title="Voice calls" />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi icon={<Phone className="size-4.5" />} tone="violet" label="AI calls this week" value={s?.voice.total} />
        <Kpi icon={<Bot className="size-4.5" />} tone="brand" label="Answered" value={s ? `${pct(s.voice.connected, s.voice.total)}%` : undefined} extra={s ? `${s.voice.unanswered} not answered` : ''} />
        <Kpi icon={<Clock3 className="size-4.5" />} tone="sky" label="Avg call length" value={s ? minutesSeconds(s.voice.avgDurationSec) : undefined} />
        <Kpi icon={<Headset className="size-4.5" />} tone="amber" label="Sent to staff" value={staff} extra={s ? `${pct(staff, s.voice.connected)}% of answered` : ''} />
      </div>

      {error && !calls && <div className="mt-4"><ErrorBanner message={error} onRetry={reload} /></div>}

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_400px]">
        <Card className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
            <h2 className="text-[15px] font-semibold text-ink">Recent calls</h2>
            <Segmented
              label="Filter calls"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'outbound', label: 'Outbound' },
                { value: 'inbound', label: 'Inbound' },
                { value: 'missed', label: 'Not answered' },
              ]}
            />
          </div>
          <ul>
            {!calls && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="mx-5 my-2 h-12" />)}
            {shown.map((c) => {
              const b = callBadge(c);
              const active = c.id === selectedId;
              return (
                <li key={c.id}>
                  <button
                    onClick={() => router.replace(`/calls?id=${c.id}`, { scroll: false })}
                    aria-current={active}
                    className={cx('grid w-full grid-cols-[1fr_auto] items-center gap-3 border-t border-line px-5 py-3 text-left sm:grid-cols-[1.4fr_90px_70px_130px_48px]', active ? 'bg-violet-soft/50' : 'hover:bg-slate-50')}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar person={c.customer} size={32} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-ink">{displayName(c.customer)}</span>
                        <span className="flex items-center gap-1 truncate text-[12px] text-muted">
                          {c.direction === 'inbound' ? <PhoneIncoming className="size-3" /> : <PhoneOutgoing className="size-3" />}
                          {c.direction === 'inbound' ? 'Called in' : 'AI called'} · {requirement(c.customer) || formatPhone(c.customer?.phone)}
                        </span>
                      </span>
                    </span>
                    <span className="hidden sm:block">
                      <Badge tone="slate">{languageLabel(c.language)}</Badge>
                    </span>
                    <span className="hidden text-[12.5px] text-body tabular sm:block">{duration(c.durationSec)}</span>
                    <span>
                      <Badge tone={b.tone} dot={c.status === 'in_progress'}>
                        {b.label}
                      </Badge>
                    </span>
                    <span className="hidden text-right text-[12px] text-faint sm:block">{timeAgo(c.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {calls && shown.length === 0 && <Empty icon={<Phone className="size-6" />} title="No calls here">AI calls start 2 hours after a lead arrives if they haven&apos;t replied on WhatsApp.</Empty>}
        </Card>

        <CallPanel detail={detail} onCalled={reload} />
      </div>
    </>
  );
}

function Kpi({ icon, tone, label, value, extra }: { icon: React.ReactNode; tone: 'brand' | 'violet' | 'sky' | 'amber'; label: string; value?: number | string; extra?: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <IconTile tone={tone}>{icon}</IconTile>
      <div>
        <p className="text-[12.5px] text-muted">{label}</p>
        <p className="text-[20px] leading-tight font-bold text-ink tabular">
          {value ?? '–'} {extra && <span className="text-[11.5px] font-medium text-muted">{extra}</span>}
        </p>
      </div>
    </Card>
  );
}

const OUTCOME_TEXT: Record<string, string> = {
  site_visit_booked: 'A site visit was booked on the call.',
  callback_requested: 'The customer asked to be called back. The AI scheduled it.',
  human_requested: 'The customer wanted to speak to a person. A task was created for your team.',
  not_interested: 'The customer is not interested. All follow-ups were stopped.',
  wrong_number: 'Wrong number. All follow-ups were stopped.',
  qualified: 'The AI collected the requirements and qualified the lead.',
  interested: 'The customer is interested.',
  connected: 'The call connected but had no clear result. A task was created to review it.',
  no_answer: 'Not answered. The AI will try again during calling hours.',
  busy: 'The line was busy. The AI will try again during calling hours.',
  invalid_number: 'The number is invalid. The lead was closed.',
  failed: 'The call could not be placed.',
};

function CallPanel({ detail, onCalled }: { detail: { call: Call; transcript: Message[] } | null; onCalled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!detail) {
    return (
      <Card className="p-5">
        <Empty icon={<PhoneCall className="size-6" />} title="Select a call">See the transcript and what happened next.</Empty>
      </Card>
    );
  }
  const { call, transcript } = detail;
  const b = callBadge(call);
  const outcomeKey = call.outcome ?? call.status;

  async function callBack() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.post<{ started: boolean; reason?: string }>('/voice/call', { leadId: call.leadId, customerId: call.customerId });
      setNote(r.started ? 'Calling now…' : `Not started: ${r.reason}`);
      onCalled();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col p-5 xl:sticky xl:top-5 xl:max-h-[calc(100vh-40px)]">
      <div className="flex items-start gap-3">
        <Avatar person={call.customer} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink">{displayName(call.customer)}</p>
          <p className="text-[12px] text-muted">
            {dateTime(call.createdAt)} · {call.direction === 'inbound' ? 'customer called in' : `AI called · attempt ${call.attempt}`}
          </p>
        </div>
        <Badge tone={b.tone} dot>
          {b.label}
        </Badge>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 rounded-[12px] bg-violet-soft/60 p-3 text-center">
        <div>
          <p className="text-[16px] font-bold text-violet tabular">{duration(call.durationSec)}</p>
          <p className="text-[11px] text-muted">Length</p>
        </div>
        <div>
          <p className="text-[16px] font-bold text-violet">{call.turns}</p>
          <p className="text-[11px] text-muted">Replies</p>
        </div>
        <div>
          <p className="text-[16px] font-bold text-violet">{languageLabel(call.language)}</p>
          <p className="text-[11px] text-muted">Language</p>
        </div>
      </div>

      {(call.summary || OUTCOME_TEXT[outcomeKey]) && (
        <div
          className={cx(
            'mt-3 rounded-[12px] px-3.5 py-3 text-[12.5px]',
            b.tone === 'rose' ? 'bg-rose-soft text-rose' : b.tone === 'amber' ? 'bg-amber-soft text-[#b45309]' : b.tone === 'slate' ? 'bg-slate-100 text-slate-600' : 'bg-brand-soft text-brand-dark',
          )}
        >
          <p className="flex items-center gap-1.5 font-semibold">
            <Sparkles className="size-3.5" /> What happened
          </p>
          <p className="mt-0.5 text-ink">{call.summary ?? OUTCOME_TEXT[outcomeKey]}</p>
        </div>
      )}

      <h3 className="mt-4 mb-2 text-[13px] font-semibold text-ink">Transcript</h3>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1 pane-scroll">
        <Transcript lines={transcript} name={call.customer?.name ?? 'Customer'} />
      </div>

      {note && <p className="mt-3 text-[12.5px] text-muted">{note}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button onClick={callBack} busy={busy} disabled={call.customer?.doNotContact}>
          <Phone className="size-4" /> Call again
        </Button>
        {call.leadId ? (
          <Button variant="primary" href={`/leads/${call.leadId}`}>
            Open lead
          </Button>
        ) : (
          <Link href="/leads" className="text-center text-[13px]">Leads</Link>
        )}
      </div>
    </Card>
  );
}
