'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Bot, Headset, MessageSquare, Phone, Search } from 'lucide-react';
import { useApi } from '@/lib/api';
import type { Conversation, Message } from '@/lib/types';
import { LEAD_STATUS, dateTime, displayName, formatPhone, languageLabel, requirement, rupees, sourceLabel, timeAgo, waLink } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Button, Card, Empty, ErrorBanner, Field, Segmented, Skeleton, cx } from '@/components/ui';
import { Thread, Transcript } from '@/components/conversation';

type Channel = 'all' | 'whatsapp' | 'voice';

export default function ConversationsPage() {
  const [channel, setChannel] = useState<Channel>('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const { data: list, error, reload } = useApi<Conversation[]>(`/conversations${channel === 'all' ? '' : `?channel=${channel}`}`);
  const items = useMemo(
    () =>
      (list ?? []).filter((c) => {
        const t = q.trim().toLowerCase();
        return !t || c.customer?.name?.toLowerCase().includes(t) || c.externalId?.includes(t.replace(/\D/g, '') || '#') || c.lastMessage?.content.toLowerCase().includes(t);
      }),
    [list, q],
  );
  const current = items.find((c) => c.id === selected) ?? items[0] ?? null;
  const { data: messages } = useApi<Message[]>(current ? `/conversations/${current.id}/messages` : null, 8_000);
  const lead = current?.customer?.lead ?? null;
  const st = lead ? LEAD_STATUS[lead.status] : null;
  const needsHuman = lead?.status === 'human_handoff';

  return (
    <>
      <PageHeader title="Conversations" />
      {error && !list && <ErrorBanner message={error} onRetry={reload} />}

      <Card className="grid min-h-[640px] grid-cols-1 overflow-hidden md:grid-cols-[300px_1fr] xl:grid-cols-[320px_1fr_300px]">
        {/* Inbox */}
        <div className="flex flex-col border-b border-line md:border-r md:border-b-0">
          <div className="flex items-center justify-between px-4 pt-4">
            <h2 className="text-[15px] font-semibold text-ink">Inbox</h2>
            <Badge tone="brand">{list?.length ?? 0} chats</Badge>
          </div>
          <div className="relative px-4 pt-3">
            <Search className="pointer-events-none absolute top-1/2 left-7 mt-1.5 size-4 -translate-y-1/2 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, number, message"
              aria-label="Search conversations"
              className="h-9 w-full rounded-[10px] border border-line pr-3 pl-9 text-[13px] text-ink placeholder:text-faint"
            />
          </div>
          <div className="px-4 py-3">
            <Segmented
              label="Channel"
              value={channel}
              onChange={(v) => {
                setChannel(v);
                setSelected(null);
              }}
              options={[
                { value: 'all', label: 'All' },
                { value: 'whatsapp', label: 'WhatsApp' },
                { value: 'voice', label: 'Voice' },
              ]}
            />
          </div>
          <ul className="max-h-[560px] flex-1 overflow-y-auto pane-scroll">
            {!list && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="mx-4 my-2 h-14" />)}
            {items.map((c) => {
              const active = current?.id === c.id;
              const l = c.customer?.lead;
              const human = l?.status === 'human_handoff';
              return (
                <li key={c.id}>
                  <button
                    onClick={() => setSelected(c.id)}
                    aria-current={active}
                    className={cx('flex w-full gap-3 border-l-[3px] px-4 py-3 text-left', active ? 'border-brand bg-brand-soft/60' : 'border-transparent hover:bg-slate-50')}
                  >
                    <Avatar person={c.customer} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-semibold text-ink">{displayName(c.customer)}</span>
                        <span className="text-[11px] text-faint">{timeAgo(c.lastMessage?.createdAt ?? c.updatedAt)}</span>
                      </span>
                      <span className="block truncate text-[12.5px] text-muted">
                        {c.lastMessage?.role !== 'user' && c.lastMessage ? 'AI: ' : ''}
                        {c.lastMessage?.content.replace(/^\[template:[^\]]+\]\s*/, 'Template: ') ?? 'No messages'}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-faint">
                        {c.channel === 'voice' ? <Phone className="size-3" /> : <MessageSquare className="size-3" />}
                        {c.channel === 'voice' ? 'Voice call' : 'WhatsApp'}
                        {human && <Badge tone="rose" className="ml-auto">Needs a human</Badge>}
                        {!human && l?.status === 'site_visit' && <Badge tone="sky" className="ml-auto">Visit booked</Badge>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {list && items.length === 0 && <Empty icon={<MessageSquare className="size-6" />} title="No conversations">Chats appear here when customers reply on WhatsApp or the AI calls them.</Empty>}
          </ul>
        </div>

        {/* Thread */}
        <div className="flex min-w-0 flex-col">
          {current ? (
            <>
              <div className="flex items-center gap-3 border-b border-line px-5 py-3">
                <Avatar person={current.customer} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-ink">{displayName(current.customer)}</p>
                  <p className="text-[12px] text-muted">
                    {formatPhone(current.externalId)} · via {current.channel === 'voice' ? 'AI voice calls' : 'WhatsApp'}
                  </p>
                </div>
                {current.channel === 'whatsapp' && (
                  <Button href={waLink(current.externalId)} className="h-8">
                    Reply in WhatsApp
                  </Button>
                )}
              </div>
              <p className={cx('flex items-center gap-2 px-5 py-2 text-[12.5px] font-semibold', needsHuman ? 'bg-rose-soft text-rose' : 'bg-brand-soft text-brand-dark')}>
                {needsHuman ? <Headset className="size-4" /> : <Bot className="size-4" />}
                {needsHuman ? 'Customer asked for a person. The AI has stopped following up.' : 'The AI is handling this conversation'}
              </p>
              <div className="max-h-[540px] flex-1 overflow-y-auto p-4 pane-scroll">
                {!messages ? (
                  <Skeleton className="h-64" />
                ) : current.channel === 'voice' ? (
                  <Transcript lines={messages} name={current.customer?.name ?? 'Customer'} />
                ) : (
                  <Thread messages={messages} name={displayName(current.customer)} />
                )}
              </div>
            </>
          ) : (
            <Empty icon={<MessageSquare className="size-6" />} title="Select a conversation" />
          )}
        </div>

        {/* Customer panel */}
        {current?.customer && (
          <aside className="hidden flex-col border-l border-line p-5 xl:flex">
            <div className="flex flex-col items-center text-center">
              <Avatar person={current.customer} size={56} />
              <p className="mt-2 text-[15px] font-semibold text-ink">{displayName(current.customer)}</p>
              <p className="text-[12px] text-muted">{formatPhone(current.customer.phone)}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {st && <Badge tone={st.tone}>{st.label}</Badge>}
                {current.customer.bhk && <Badge tone="violet">{current.customer.bhk} BHK</Badge>}
                {current.customer.location && <Badge tone="sky">{current.customer.location}</Badge>}
                {current.customer.budget && <Badge tone="amber">{rupees(current.customer.budget)} budget</Badge>}
              </div>
            </div>
            <div className="mt-5 border-t border-line pt-3">
              <Field label="Looking for">{requirement(current.customer) || '—'}</Field>
              <Field label="Language">{languageLabel(current.customer.language)}</Field>
              <Field label="Source">{sourceLabel(lead?.source ?? current.customer.source)}</Field>
              <Field label="First contact">{dateTime(current.customer.createdAt)}</Field>
              <Field label="Messages">{current.messageCount}</Field>
            </div>
            {lead && (
              <Button href={`/leads/${lead.id}`} className="mt-auto w-full">
                Open in CRM
              </Button>
            )}
          </aside>
        )}
      </Card>
    </>
  );
}
