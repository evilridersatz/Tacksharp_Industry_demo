'use client';

import { useState } from 'react';
import { Boxes, MessageSquare, Phone, ShoppingCart } from 'lucide-react';
import { useApi } from '@/lib/api';
import { dateTime, rupees, timeAgo } from '@/lib/format';
import type { ActiveCart, InboundStatus, StockMovement } from '@/lib/restaurant';
import type { Call, Message } from '@/lib/types';
import { PageHeader } from '@/components/shell';
import { Badge, Card, CardHeader, Empty, ErrorBanner, Skeleton } from '@/components/ui';

const qty = (q: number, unit: 'kg' | 'piece') => (unit === 'piece' ? `${q} pcs` : q > 0 && q < 1 ? `${Math.round(q * 1000)} g` : `${q} kg`);
const signed = (q: number, unit: 'kg' | 'piece') => `${q > 0 ? '+' : q < 0 ? '−' : ''}${qty(Math.abs(q), unit)}`;

/** Who made a movement, in words (never a raw user id). */
const actorLabel = (a: string | null) => (!a || a === 'order' ? '' : a.startsWith('user:') ? 'Staff' : a.startsWith('seed:') ? 'Demo seed script' : a);

const REASON: Record<string, string> = {
  order_reserved: 'Order',
  order_cancelled: 'Order cancelled',
  staff_set: 'Staff count',
  staff_adjust: 'Staff adjustment',
  demo_seed: 'Demo seed',
};

/** What each inbound state means for the customer; "accepted" is Meta taking the reply, not delivery. */
const INBOUND: Record<string, { label: string; tone: 'brand' | 'amber' | 'rose' | 'slate' | 'sky' }> = {
  received: { label: 'Received', tone: 'slate' },
  queued: { label: 'Queued', tone: 'sky' },
  processing: { label: 'Processing', tone: 'sky' },
  replied: { label: 'Reply accepted by Meta', tone: 'brand' },
  reply_unknown: { label: 'Reply outcome unknown', tone: 'amber' },
  failed: { label: 'Failed', tone: 'rose' },
  skipped: { label: 'Skipped', tone: 'slate' },
  simulated: { label: 'Simulated (demo, not sent)', tone: 'sky' },
};

export default function ActivityPage() {
  const carts = useApi<ActiveCart[]>('/restaurant/carts', 8_000);
  const moves = useApi<StockMovement[]>('/restaurant/inventory-movements?limit=30', 15_000);
  const inbound = useApi<InboundStatus>('/restaurant/whatsapp-inbound?limit=40', 8_000);

  return (
    <>
      <PageHeader title="Carts, stock & messages" />
      <p className="mb-4 text-[13px] text-muted">
        Live view of carts being built on WhatsApp and calls, every stock movement, and how each incoming WhatsApp message was handled. A reply marked
        &ldquo;accepted&rdquo; was taken by Meta; delivery and read receipts appear in the conversation when Meta sends them.
      </p>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Active carts" subtitle="Customers building an order in the last 24 hours" />
          <div className="px-5 pb-5">
            {carts.error && !carts.data && <ErrorBanner message={carts.error} onRetry={carts.reload} />}
            {!carts.data && !carts.error && <Skeleton className="h-32" />}
            {carts.data?.length === 0 && <Empty icon={<ShoppingCart className="size-5" />} title="No carts right now" />}
            <ul className="flex flex-col gap-3">
              {carts.data?.map((c) => (
                <li key={c.key} className="rounded-[10px] border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-semibold text-ink">{c.customerName ?? c.phone}</p>
                    <Badge tone={c.channel === 'voice' ? 'violet' : 'sky'}>{c.channel === 'voice' ? 'Phone call' : c.channel === 'whatsapp' ? 'WhatsApp' : 'Test chat'}</Badge>
                    {c.awaitingConfirmation ? <Badge tone="amber">Waiting for “yes”</Badge> : <Badge tone="slate">Collecting details</Badge>}
                    <span className="ml-auto text-[12px] text-faint" title={dateTime(c.updatedAt)}>
                      {timeAgo(c.updatedAt)}
                    </span>
                  </div>
                  <ul className="mt-2 text-[13px] text-ink">
                    {c.lines.map((l, i) => (
                      <li key={i} className="flex justify-between gap-3">
                        <span>
                          {l.quantity !== null ? `${qty(l.quantity, l.unit)} ` : <span className="text-muted">qty? </span>}
                          {l.name}
                          {l.cut ? ` — ${l.cut}` : ''}
                          {!l.stockKnown && <span className="text-[11.5px] text-amber-700"> (stock unknown)</span>}
                        </span>
                        <span className="tabular-nums">{l.lineTotal !== null ? rupees(l.lineTotal) : '—'}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap justify-between gap-2 border-t border-line pt-2 text-[12.5px] text-muted">
                    <span>
                      {c.payment ? `Payment: ${c.payment.replace(/_/g, ' ')}` : 'Payment not chosen'} · {c.pickupAt ? `Pickup ${dateTime(c.pickupAt)}` : 'Pickup time not set'}
                    </span>
                    <span className="font-semibold text-ink">Total {rupees(c.total)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="WhatsApp messages"
            subtitle={
              inbound.data
                ? `Last 24 h: ${Object.entries(inbound.data.counts)
                    .map(([k, v]) => `${INBOUND[k]?.label ?? k} ${v}`)
                    .join(' · ') || 'none'}`
                : 'Incoming messages and their replies'
            }
          />
          <div className="px-5 pb-5">
            {inbound.error && !inbound.data && <ErrorBanner message={inbound.error} onRetry={inbound.reload} />}
            {!inbound.data && !inbound.error && <Skeleton className="h-32" />}
            {inbound.data?.messages.length === 0 && <Empty icon={<MessageSquare className="size-5" />} title="No WhatsApp messages yet" />}
            <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[420px] text-left text-[12.5px]">
              <tbody>
                {inbound.data?.messages.map((m) => {
                  const st = INBOUND[m.status] ?? { label: m.status, tone: 'slate' as const };
                  return (
                    <tr key={m.id} className="border-t border-line align-top">
                      <td className="py-1.5 pr-2 whitespace-nowrap text-faint" title={dateTime(m.receivedAt)}>
                        {timeAgo(m.receivedAt)}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums">{m.fromPhone}</td>
                      <td className="py-1.5 pr-2">{m.messageType}</td>
                      <td className="py-1.5 pr-2">
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {m.attempts > 1 && <span className="ml-1 text-faint">{m.attempts} attempts</span>}
                        {m.lastError && !['replied', 'simulated'].includes(m.status) && <p className="mt-0.5 max-w-[260px] truncate text-rose" title={m.lastError}>{m.lastError}</p>}
                      </td>
                      <td className="py-1.5 text-right">
                        {m.conversationId && (
                          <a className="text-brand-dark underline" href={`/conversations?id=${m.conversationId}`}>
                            Open
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </Card>

        <CallsPanel />

        <Card>
          <CardHeader title="Recent stock movements" subtitle="Orders take stock when the customer confirms; cancellations give it back once" />
          <div className="px-5 pb-5">
            {moves.error && !moves.data && <ErrorBanner message={moves.error} onRetry={moves.reload} />}
            {!moves.data && !moves.error && <Skeleton className="h-32" />}
            {moves.data?.length === 0 && <Empty icon={<Boxes className="size-5" />} title="No stock movements yet" />}
            <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[420px] text-left text-[12.5px]">
              <tbody>
                {moves.data?.map((m) => (
                  <tr key={m.id} className="border-t border-line">
                    <td className="py-1.5 pr-2 whitespace-nowrap text-faint" title={dateTime(m.createdAt)}>
                      {timeAgo(m.createdAt)}
                    </td>
                    <td className="py-1.5 pr-2 font-medium text-ink">{m.product}</td>
                    <td className={`py-1.5 pr-2 whitespace-nowrap tabular-nums ${m.delta < 0 ? 'text-rose' : 'text-brand-dark'}`}>{signed(m.delta, m.unit)}</td>
                    <td className="py-1.5 pr-2 whitespace-nowrap tabular-nums">→ {qty(m.balanceAfter, m.unit)}</td>
                    <td className="py-1.5 pr-2">{REASON[m.reason] ?? m.reason}</td>
                    <td className="hidden py-1.5 text-faint sm:table-cell">{actorLabel(m.actor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}

const END_REASON: Record<string, string> = {
  customer_goodbye: 'Customer said goodbye',
  done_after_order: 'Done after the order',
  handoff: 'Handed to staff',
  max_turns: 'Reached the call length limit',
  no_response: 'No response from the caller',
  conversation_end: 'Conversation ended',
  technical: 'Technical problem',
};

/** Phone calls: status, language, why each ended, and the transcript on click. */
function CallsPanel() {
  const calls = useApi<Call[]>('/voice/calls', 10_000);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useApi<{ call: Call; transcript: Message[] }>(selected ? `/voice/calls/${selected}` : null, 10_000);
  const list = (calls.data ?? []).slice(0, 15);
  return (
    <Card>
      <CardHeader title="Phone calls" subtitle="Status, language and why each call ended — click a call for its transcript" />
      <div className="px-5 pb-5">
        {calls.error && !calls.data && <ErrorBanner message={calls.error} onRetry={calls.reload} />}
        {!calls.data && !calls.error && <Skeleton className="h-32" />}
        {calls.data?.length === 0 && <Empty icon={<Phone className="size-5" />} title="No calls yet" />}
        <ul className="flex flex-col divide-y divide-line">
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setSelected(selected === c.id ? null : c.id)} className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-[12.5px] hover:bg-slate-50/60">
                <span className="text-faint" title={dateTime(c.createdAt)}>
                  {timeAgo(c.createdAt)}
                </span>
                <span className="font-medium text-ink">{c.customer?.name ?? `…${c.toNumber.slice(-4)}`}</span>
                <Badge tone="slate">{c.direction}</Badge>
                <Badge tone={c.status === 'completed' ? 'brand' : c.status === 'failed' ? 'rose' : 'sky'}>{c.status.replace(/_/g, ' ')}</Badge>
                {c.language && <Badge tone="violet">{c.language}</Badge>}
                <span className="ml-auto text-muted">
                  {c.endReason ? END_REASON[c.endReason] ?? c.endReason.replace(/_/g, ' ') : c.hangupCause ?? ''}
                  {c.durationSec ? ` · ${c.durationSec}s` : ''}
                  {c.turns ? ` · ${c.turns} turns` : ''}
                </span>
              </button>
              {selected === c.id && (
                <div className="mb-2 rounded-[10px] bg-slate-50 p-3 text-[12.5px]">
                  {!detail.data && <Skeleton className="h-16" />}
                  {detail.data?.transcript.length === 0 && <p className="text-muted">No transcript was recorded for this call.</p>}
                  {detail.data?.transcript.map((m) => (
                    <p key={m.id} className={m.role === 'user' ? 'text-ink' : 'text-brand-dark'}>
                      <span className="font-semibold">{m.role === 'user' ? 'Customer' : 'AI'}:</span> {m.content}
                    </p>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
