'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Bot, FlaskConical, Headset, MessageCircle, MessageSquare, PhoneCall, Search } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Message } from '@/lib/types';
import { dateTime, displayName, formatPhone, timeAgo, waLink } from '@/lib/format';
import { CHANNEL_LABEL, ORDER_STATUS, inr, plain, useMe, type RConversation, type RConversationDetail } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Button, Card, Empty, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Thread } from '@/components/conversation';

type Channel = 'all' | 'whatsapp' | 'voice' | 'test';

export function RestaurantConversations() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const [channel, setChannel] = useState<Channel>('all');
  const [onlyHandoff, setOnlyHandoff] = useState(params.get('status') === 'human_handoff');
  const [q, setQ] = useState('');
  const query = new URLSearchParams();
  if (channel !== 'all') query.set('channel', channel);
  if (onlyHandoff) query.set('status', 'human_handoff');
  const { data: list, error, reload } = useApi<RConversation[]>(`/restaurant/conversations?${query}`, 10_000);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (list ?? []).filter((c) => !t || c.customer?.name?.toLowerCase().includes(t) || c.customer?.phone?.includes(t.replace(/\D/g, '') || '#') || c.lastMessage?.content.toLowerCase().includes(t));
  }, [list, q]);
  const selectedId = params.get('id') ?? items[0]?.id ?? null;
  const { data: detail, reload: reloadDetail } = useApi<RConversationDetail>(selectedId ? `/restaurant/conversations/${selectedId}` : null, 8_000);
  const [busy, setBusy] = useState(false);

  const select = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('id', id);
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  async function setStatus(status: 'active' | 'human_handoff' | 'closed') {
    if (!detail) return;
    setBusy(true);
    try {
      await api.patch(`/restaurant/conversations/${detail.id}`, { status });
      await Promise.all([reloadDetail(), reload()]);
    } finally {
      setBusy(false);
    }
  }

  const needsStaff = detail?.status === 'human_handoff';

  return (
    <>
      <PageHeader title="AI conversations" crumb="Conversations" />
      {error && !list && <ErrorBanner message={error} onRetry={reload} />}

      <Card className="grid min-h-[640px] grid-cols-1 overflow-hidden md:grid-cols-[300px_1fr] xl:grid-cols-[320px_1fr_300px]">
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
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <Segmented<Channel>
              label="Channel"
              value={channel}
              onChange={setChannel}
              options={[
                { value: 'all', label: 'All' },
                { value: 'whatsapp', label: 'WhatsApp' },
                { value: 'voice', label: 'Calls' },
                { value: 'test', label: 'Test' },
              ]}
            />
            <label className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted">
              <input type="checkbox" checked={onlyHandoff} onChange={(e) => setOnlyHandoff(e.target.checked)} className="size-4" /> Needs staff
            </label>
          </div>
          <ul className="max-h-[560px] flex-1 overflow-y-auto pane-scroll">
            {!list && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="mx-4 my-2 h-14" />)}
            {items.map((c) => {
              const active = selectedId === c.id;
              return (
                <li key={c.id}>
                  <button
                    onClick={() => select(c.id)}
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
                        {c.lastMessage && c.lastMessage.role !== 'user' ? 'AI: ' : ''}
                        {c.lastMessage ? plain(c.lastMessage.content) : 'No messages'}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-faint">
                        {c.channel === 'voice' ? <PhoneCall className="size-3" /> : c.channel === 'test' ? <FlaskConical className="size-3" /> : <MessageCircle className="size-3" />}
                        {CHANNEL_LABEL[c.channel] ?? c.channel}
                        {c.orderCount > 0 && <Badge tone="brand">{c.orderCount} order{c.orderCount > 1 ? 's' : ''}</Badge>}
                        {c.status === 'human_handoff' && (
                          <Badge tone="rose" className="ml-auto">
                            Needs staff
                          </Badge>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {list && items.length === 0 && (
              <Empty icon={<MessageSquare className="size-6" />} title="No conversations">
                WhatsApp chats, order-ready calls and test chats appear here.
              </Empty>
            )}
          </ul>
        </div>

        <div className="flex min-w-0 flex-col">
          {detail ? (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
                <Avatar person={detail.customer} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-ink">{displayName(detail.customer)}</p>
                  <p className="text-[12px] text-muted">
                    {detail.customer?.phone ? `${formatPhone(detail.customer.phone)} · ` : ''}via {CHANNEL_LABEL[detail.channel] ?? detail.channel} · started {dateTime(detail.createdAt)}
                  </p>
                </div>
                {detail.channel === 'whatsapp' && detail.customer?.phone && (
                  <Button href={waLink(detail.customer.phone)} className="h-8">
                    Reply in WhatsApp
                  </Button>
                )}
              </div>
              <div className={cx('flex flex-wrap items-center gap-2 px-5 py-2 text-[12.5px] font-semibold', needsStaff ? 'bg-rose-soft text-rose' : 'bg-brand-soft text-brand-dark')}>
                {needsStaff ? <Headset className="size-4" /> : <Bot className="size-4" />}
                <span className="flex-1">
                  {needsStaff
                    ? 'Customer asked for staff. Contact them directly; the AI still answers menu and order questions.'
                    : detail.status === 'closed'
                      ? 'Closed by staff.'
                      : 'The AI assistant is handling this conversation.'}
                </span>
                {me && me.role !== 'viewer' && (
                  <span className="flex gap-2">
                    {needsStaff ? (
                      <Button className="h-7" busy={busy} onClick={() => setStatus('active')}>
                        Mark resolved
                      </Button>
                    ) : (
                      <Button className="h-7" busy={busy} onClick={() => setStatus('human_handoff')}>
                        Flag for staff
                      </Button>
                    )}
                  </span>
                )}
              </div>
              <div className="max-h-[560px] flex-1 overflow-y-auto p-4 pane-scroll">
                <Thread messages={detail.messages.map((m) => ({ ...m, content: plain(m.content) })) as unknown as Message[]} name={detail.customer ? displayName(detail.customer) : 'the customer'} />
              </div>
            </>
          ) : selectedId ? (
            <Skeleton className="m-4 h-64" />
          ) : (
            <Empty icon={<MessageSquare className="size-6" />} title="Select a conversation" />
          )}
        </div>

        {detail && (
          <aside className="hidden flex-col gap-3 border-l border-line p-5 xl:flex">
            <h3 className="text-[12px] font-semibold tracking-wide text-muted uppercase">Orders from this customer</h3>
            {!detail.orders.length ? (
              <p className="text-[13px] text-muted">No orders yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detail.orders.map((o) => (
                  <li key={o.id}>
                    <Link href={`/orders?id=${o.id}`} className="block rounded-[10px] border border-line p-3 hover:bg-slate-50">
                      <p className="flex items-center justify-between text-[13px] font-semibold text-ink">
                        {o.orderNumber} <span className="tabular">{inr(o.total)}</span>
                      </p>
                      <p className="mt-0.5 text-[12px] text-muted">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</p>
                      <Badge tone={ORDER_STATUS[o.status]?.tone ?? 'slate'} className="mt-1.5">
                        {ORDER_STATUS[o.status]?.label ?? o.status}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {detail.customer && (
              <Button href={`/customers?id=${detail.customer.id}`} className="mt-auto w-full">
                Customer profile
              </Button>
            )}
          </aside>
        )}
      </Card>
    </>
  );
}
