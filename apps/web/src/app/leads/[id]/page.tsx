'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Ban,
  CalendarCheck,
  CheckCircle2,
  Headset,
  MessageSquare,
  Phone,
  PhoneCall,
  PhoneMissed,
  Sparkles,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Call, FollowUp, LeadDetail, Message } from '@/lib/types';
import { useIndustry } from '@/lib/industry';
import { TextileLeadPanel } from '@/components/textile-lead';
import {
  LEAD_STATUS,
  leadStatusesFor,
  callBadge,
  dateTime,
  dayLabel,
  displayName,
  followUpLabel,
  formatPhone,
  languageLabel,
  minutesSeconds,
  requirement,
  rupees,
  VISIT_STATUS,
  sourceLabel,
  stopReason,
  timeOnly,
  waLink,
} from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Thread, Transcript, transcriptFor } from '@/components/conversation';
import { Avatar, Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, IconTile, Segmented, Skeleton, cx } from '@/components/ui';

type Tab = 'journey' | 'whatsapp' | 'calls';

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<LeadDetail>(`/leads/${id}`);
  const [tab, setTab] = useState<Tab>('journey');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [calling, setCalling] = useState(false);
  const { industry } = useIndustry();

  if (error && !data) {
    return (
      <>
        <PageHeader title="Lead" crumb="Leads & CRM / Lead" />
        <ErrorBanner message={error} onRetry={reload} />
      </>
    );
  }
  if (!data) {
    return (
      <>
        <PageHeader title="Lead" crumb="Leads & CRM / Lead" />
        <Skeleton className="h-28" />
        <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </>
    );
  }

  const { lead } = data;
  const c = lead.customer;
  const status = LEAD_STATUS[lead.status] ?? { label: lead.status, tone: 'slate' as const };
  const whatsapp = data.conversations.find((x) => x.channel === 'whatsapp')?.messages ?? [];
  const voiceMessages = data.conversations.find((x) => x.channel === 'voice')?.messages ?? [];
  const pending = data.followUps.filter((f) => f.status === 'scheduled');
  const tasks = data.followUps.filter((f) => f.channel === 'human' && f.status === 'open');
  const liveCall = data.calls.find((x) => ['queued', 'ringing', 'in_progress'].includes(x.status));

  async function act(fn: () => Promise<unknown>, ok: string) {
    setNotice(null);
    try {
      await fn();
      setNotice({ tone: 'ok', text: ok });
      await reload();
    } catch (e) {
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  async function callNow() {
    // A real call to a real person: ask first. The server still checks consent, calling hours and the live gate.
    if (!window.confirm(`Call ${displayName(c)} now? If this workspace is live, a real phone call is placed.`)) return;
    setCalling(true);
    setNotice(null);
    try {
      const r = await api.post<{ started: boolean; reason?: string }>('/voice/call', { leadId: lead.id, confirm: true });
      setNotice(
        r.started
          ? { tone: 'ok', text: `Calling ${displayName(c)} now. The call appears below when it ends.` }
          : { tone: 'error', text: CALL_BLOCKED[r.reason ?? ''] ?? `Call not started: ${r.reason}` },
      );
      await reload();
    } catch (e) {
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setCalling(false);
    }
  }

  return (
    <>
      <PageHeader title="Lead journey" crumb={`Leads & CRM / ${displayName(c)}`} />

      <Card className="flex flex-wrap items-center gap-4 p-5">
        <Link href="/leads" aria-label="Back to leads" className="text-faint hover:text-ink">
          <ArrowLeft className="size-5" />
        </Link>
        <Avatar person={c} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[18px] font-bold text-ink">{displayName(c)}</h2>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
            {c.doNotContact && (
              <Badge tone="rose">
                <Ban className="size-3" /> Do not contact
              </Badge>
            )}
            {liveCall && <Badge tone="violet">On a call now</Badge>}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            {formatPhone(c.phone)} · {lead.campaign ?? sourceLabel(lead.source)} · added {dateTime(lead.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-line bg-white px-3 text-[13px] text-muted">
            Status
            <select
              aria-label="Lead status"
              value={lead.status}
              onChange={(e) => act(() => api.patch(`/leads/${lead.id}/status`, { status: e.target.value }), 'Status updated')}
              className="bg-transparent font-semibold text-ink outline-none"
            >
              {leadStatusesFor(industry, lead.status).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <Button href={waLink(c.phone)}>
            <MessageSquare className="size-4" /> WhatsApp
          </Button>
          <Button variant="primary" onClick={callNow} busy={calling} disabled={c.doNotContact || Boolean(liveCall)}>
            <PhoneCall className="size-4" /> Call with AI now
          </Button>
        </div>
      </Card>

      {notice && (
        <p role="status" className={cx('mt-3 rounded-[10px] px-4 py-2.5 text-[13px]', notice.tone === 'ok' ? 'bg-brand-soft text-brand-dark' : 'bg-rose-soft text-rose')}>
          {notice.text}
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-4">
          {industry === 'textile' ? <TextileLeadPanel leadId={lead.id} /> : industry && industry !== 'real_estate' ? (
            <Card>
              <CardHeader title="What they want" />
              <div className="px-5 pb-4">
                <p className="mb-2 text-[13px] text-body">{lead.notes || 'Not recorded yet.'}</p>
                {lead.campaign && <Field label="Campaign">{lead.campaign}</Field>}
                <Field label="Language">{languageLabel(c.language)}</Field>
                <Field label="Call back at">{c.callbackAt ? dateTime(c.callbackAt) : '—'}</Field>
                <Field label="Last replied">{c.lastInboundAt ? dateTime(c.lastInboundAt) : 'Not yet'}</Field>
              </div>
            </Card>
          ) : <Card>
            <CardHeader title="What they want" />
            <div className="px-5 pb-4">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {lead.location && <Badge tone="sky">{lead.location}</Badge>}
                {lead.bhk && <Badge tone="violet">{lead.bhk} BHK</Badge>}
                {lead.propertyType && <Badge tone="slate">{lead.propertyType}</Badge>}
                {lead.budget && <Badge tone="amber">{rupees(lead.budget)} budget</Badge>}
              </div>
              <Field label="Language">{languageLabel(c.language)}</Field>
              <Field label="Buying when">{c.purchaseTimeline ?? '—'}</Field>
              <Field label="Liked property">{c.interestedPropertyId ? data.siteVisits.find((v) => v.propertyId === c.interestedPropertyId)?.Property?.name ?? 'Saved' : '—'}</Field>
              <Field label="Call back at">{c.callbackAt ? dateTime(c.callbackAt) : '—'}</Field>
              <Field label="Last replied">{c.lastInboundAt ? dateTime(c.lastInboundAt) : 'Not yet'}</Field>
              {c.objections && (
                <div className="mt-2 rounded-[10px] bg-amber-soft px-3 py-2 text-[12.5px] text-[#92400e]">
                  <p className="font-semibold">Concerns raised</p>
                  {c.objections.split('\n').map((o) => (
                    <p key={o}>{o}</p>
                  ))}
                </div>
              )}
            </div>
          </Card>}

          {tasks.length > 0 && (
            <Card className="border-rose-soft">
              <CardHeader title="Waiting for your team" />
              <ul className="px-5 pb-4">
                {tasks.map((t) => (
                  <li key={t.id} className="border-t border-line py-2.5 first:border-t-0">
                    <p className="text-[13px] text-ink">{t.message?.replace(/^Handoff: /, '')}</p>
                    <p className="text-[12px] text-muted">{dateTime(t.createdAt)}</p>
                    <Button className="mt-2 h-8" onClick={() => act(() => api.patch(`/follow-ups/${t.id}/complete`), 'Marked as done')}>
                      <CheckCircle2 className="size-4" /> Mark done
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="Automation" subtitle={pending.length ? 'What the AI will do next' : 'Nothing scheduled'} />
            <ul className="px-5 pb-4">
              {pending.map((f) => (
                <li key={f.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                  <IconTile size="sm" tone={f.channel === 'voice' ? 'violet' : 'brand'}>
                    {f.channel === 'voice' ? <Phone className="size-3.5" /> : <MessageSquare className="size-3.5" />}
                  </IconTile>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-ink">{followUpLabel(f)}</p>
                    <p className="text-[12px] text-muted">{dateTime(f.scheduledAt)}</p>
                  </div>
                  <button
                    onClick={() => act(() => api.patch(`/follow-ups/${f.id}/cancel`, { reason: 'Cancelled from dashboard' }), 'Follow-up cancelled')}
                    className="text-[12px] font-semibold text-rose hover:underline"
                  >
                    Cancel
                  </button>
                </li>
              ))}
              {pending.length === 0 && (
                <p className="text-[12.5px] text-muted">{c.doNotContact ? 'This customer opted out, so the AI will not contact them.' : 'The AI has finished its follow-up sequence for this lead.'}</p>
              )}
            </ul>
          </Card>

          {data.siteVisits.length > 0 && (
            <Card>
              <CardHeader title="Site visits" />
              <ul className="px-5 pb-4">
                {data.siteVisits.map((v) => (
                  <li key={v.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                    <IconTile size="sm" tone="sky">
                      <CalendarCheck className="size-3.5" />
                    </IconTile>
                    <div className="flex-1">
                      <p className="text-[13px] font-semibold text-ink">{v.Property?.name}</p>
                      <p className="text-[12px] text-muted">{dateTime(v.scheduledAt)}</p>
                    </div>
                    <Badge tone={VISIT_STATUS[v.status]?.tone ?? 'slate'}>{VISIT_STATUS[v.status]?.label ?? v.status}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <Card className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
            <Segmented
              label="Lead history"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'journey', label: 'Journey' },
                { value: 'whatsapp', label: `WhatsApp (${whatsapp.length})` },
                { value: 'calls', label: `Calls (${data.calls.length})` },
              ]}
            />
          </div>
          <div className="px-5 pb-5">
            {tab === 'journey' && <Journey data={data} whatsapp={whatsapp} />}
            {tab === 'whatsapp' && <Thread messages={whatsapp} name={displayName(c)} />}
            {tab === 'calls' && <CallList calls={data.calls} voice={voiceMessages} />}
          </div>
        </Card>
      </div>
    </>
  );
}

const CALL_BLOCKED: Record<string, string> = {
  do_not_contact: 'This customer opted out, so the AI will not call them.',
  call_already_in_progress: 'A call to this customer is already in progress.',
  customer_has_no_phone: 'This lead has no phone number.',
  'PLIVO_FROM_NUMBER missing': 'Calling is not set up yet: add PLIVO_FROM_NUMBER to the API .env.',
};

type JourneyItem = { at: string; icon: ReactNode; tone: 'brand' | 'violet' | 'sky' | 'rose' | 'amber' | 'slate'; title: string; body?: ReactNode; stage: string };

function Journey({ data, whatsapp }: { data: LeadDetail; whatsapp: Message[] }) {
  const { lead } = data;
  const items: JourneyItem[] = [
    {
      at: lead.createdAt,
      icon: <UserPlus className="size-3.5" />,
      tone: 'violet',
      stage: sourceLabel(lead.source),
      title: `Lead received${lead.campaign ? ` from "${lead.campaign}"` : ''}`,
      body: requirement(lead) ? `${requirement(lead)}${lead.budget ? `, up to ${rupees(lead.budget)}` : ''}` : undefined,
    },
  ];

  for (const f of data.followUps) {
    if (f.channel === 'human') {
      items.push({ at: f.createdAt, icon: <Headset className="size-3.5" />, tone: 'rose', stage: 'Human handoff', title: f.status === 'open' ? 'Handed to your team' : 'Team task closed', body: f.message?.replace(/^Handoff: /, '') });
    } else if (f.status === 'completed' && f.channel === 'whatsapp') {
      items.push({ at: f.completedAt ?? f.scheduledAt, icon: <MessageSquare className="size-3.5" />, tone: 'brand', stage: 'Follow-up', title: `${followUpLabel(f)} sent` });
    } else if (f.status === 'skipped' || f.status === 'failed') {
      items.push({ at: f.scheduledAt, icon: <XCircle className="size-3.5" />, tone: 'slate', stage: 'Follow-up', title: `${followUpLabel(f)} not sent`, body: stopReason(f) });
    }
  }
  const stopped = data.followUps.filter((f) => f.status === 'cancelled');
  if (stopped.length) {
    const first = stopped.reduce((a, b) => (a.updatedAt < b.updatedAt ? a : b));
    items.push({
      at: first.updatedAt,
      icon: <Sparkles className="size-3.5" />,
      tone: 'slate',
      stage: 'Follow-up',
      title: `${stopped.length} follow-up${stopped.length > 1 ? 's' : ''} stopped`,
      body: stopReason(first),
    });
  }

  // WhatsApp: one entry per customer burst, so long chats stay readable
  let lastUserAt = 0;
  for (const m of whatsapp) {
    const t = new Date(m.createdAt).getTime();
    if (m.role === 'user' && t - lastUserAt > 30 * 60_000) {
      items.push({ at: m.createdAt, icon: <MessageSquare className="size-3.5" />, tone: 'brand', stage: 'WhatsApp', title: 'Customer messaged on WhatsApp', body: <q className="text-body">{m.content}</q> });
    }
    if (m.role === 'user') lastUserAt = t;
  }

  for (const call of data.calls) {
    const badge = callBadge(call);
    const answered = Boolean(call.answeredAt);
    items.push({
      at: call.createdAt,
      icon: answered ? <PhoneCall className="size-3.5" /> : <PhoneMissed className="size-3.5" />,
      tone: answered ? 'violet' : 'rose',
      stage: 'AI call',
      title: call.direction === 'inbound'
        ? `Customer called in, ${minutesSeconds(call.durationSec)}`
        : answered ? `AI call, ${minutesSeconds(call.durationSec)}` : `AI call attempt ${call.attempt}`,
      body: (
        <span className="flex flex-col gap-1">
          <Badge tone={badge.tone} className="w-fit">{badge.label}</Badge>
          {call.summary && <span>{call.summary}</span>}
        </span>
      ),
    });
  }
  for (const v of data.siteVisits) {
    items.push({ at: v.createdAt, icon: <CalendarCheck className="size-3.5" />, tone: 'sky', stage: 'Site visit', title: `Site visit booked: ${v.Property?.name ?? ''}`, body: `For ${dateTime(v.scheduledAt)}` });
  }

  items.sort((a, b) => a.at.localeCompare(b.at));
  let lastDay = '';
  return (
    <ol className="relative">
      {items.map((it, i) => {
        const day = dayLabel(it.at);
        const showDay = day !== lastDay;
        lastDay = day;
        return (
          <li key={i}>
            {showDay && <p className="mt-2 mb-2 text-[12px] font-semibold text-muted first:mt-0">{day}</p>}
            <div className="relative flex gap-3 pb-4">
              {i < items.length - 1 && <span className="absolute top-8 bottom-0 left-[13px] w-px bg-line" aria-hidden />}
              <IconTile size="sm" tone={it.tone}>
                {it.icon}
              </IconTile>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-[13px] text-ink">
                  <span className="font-semibold">{it.title}</span>
                  <span className="ml-2 text-[11.5px] text-faint">
                    {it.stage} · {timeOnly(it.at)}
                  </span>
                </p>
                {it.body && <div className="mt-1 text-[12.5px] text-muted">{it.body}</div>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function CallList({ calls, voice }: { calls: Call[]; voice: Message[] }) {
  const [open, setOpen] = useState<string | null>(calls.at(-1)?.id ?? null);
  if (calls.length === 0) return <Empty icon={<Phone className="size-6" />} title="No calls yet">The AI calls automatically if the lead doesn&apos;t reply on WhatsApp, or you can call now.</Empty>;
  return (
    <ul className="flex flex-col gap-2">
      {[...calls].reverse().map((call) => {
        const badge = callBadge(call);
        const expanded = open === call.id;
        return (
          <li key={call.id} className="rounded-[12px] border border-line">
            <button onClick={() => setOpen(expanded ? null : call.id)} aria-expanded={expanded} className="flex w-full items-center gap-3 px-4 py-3 text-left">
              <IconTile size="sm" tone={call.answeredAt ? 'violet' : 'rose'}>
                {call.answeredAt ? <PhoneCall className="size-3.5" /> : <PhoneMissed className="size-3.5" />}
              </IconTile>
              <span className="flex-1 text-[13px]">
                <span className="font-semibold text-ink">{dateTime(call.createdAt)}</span>
                <span className="text-muted">
                  {' '}
                  · attempt {call.attempt} · {call.answeredAt ? minutesSeconds(call.durationSec) : 'not answered'} · {languageLabel(call.language)}
                </span>
              </span>
              <Badge tone={badge.tone}>{badge.label}</Badge>
            </button>
            {expanded && (
              <div className="border-t border-line px-4 py-3">
                <Transcript lines={transcriptFor(call, voice)} name="Customer" />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
