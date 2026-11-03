'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, Compass, Hand, Inbox as InboxIcon, Lock, MessageSquare, Search, Send, StickyNote, Tag, Trash2, UserPlus } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Message } from '@/lib/types';
import { displayName, formatPhone, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Button, Card, Empty, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Thread } from '@/components/conversation';
import { inputCls } from '@/components/textile';
import { toast } from '@/components/toast';
import { useWorkspace } from '@/lib/industry';

type Person = { id: string; name: string; role?: string };
type Row = {
  id: string; channel: string; externalId: string | null; inboxStatus: 'open' | 'pending' | 'resolved'; priority: string; labels: string[]; aiEnabled: boolean; aiMode?: 'auto' | 'review';
  needsHuman: boolean; handoffReason: string | null; assignee: Person | null; customer: { id: string; name: string | null; phone: string | null; optedOutAt: string | null } | null;
  lastMessage: { content: string; role: string; createdAt: string } | null; updatedAt: string;
};
type List = { counts: { open: number; pending: number; resolved: number; mine: number; unassigned: number; needsHuman: number; aiOff: number }; items: Row[] };
type Detail = Omit<Row, 'customer' | 'lastMessage'> & {
  handoff: { reason: string | null; at: string | null; lastCustomerMessages: string[] } | null;
  guidance: { text: string; until: string | null } | null; pendingDrafts: number;
  customer: { id: string; name: string | null; phone: string | null; email: string | null; language: string | null; tags: unknown; source: string | null; messagingConsent: boolean; callingConsent: boolean; optedOutAt: string | null; doNotContact: boolean; createdAt: string } | null;
  orders: Array<{ id: string; orderNumber: string; status: string; total: number; createdAt: string }>;
  leads: Array<{ id: string; status: string; source: string | null }>;
  replyWindow: { open: boolean; note: string; comment?: boolean };
  notes: Array<{ id: string; body: string; author: string; createdAt: string }>;
  messages: Message[];
};
type Saved = { id: string; title: string; body: string };
type Me = { id: string; role: string };

const PRIORITY_TONE: Record<string, 'slate' | 'sky' | 'amber' | 'rose'> = { low: 'slate', normal: 'sky', high: 'amber', urgent: 'rose' };
const STATUS_LABEL = { open: 'Open', pending: 'Pending', resolved: 'Resolved' } as const;
const MANAGE = ['admin', 'manager', 'team_lead'];
const REPLY = [...MANAGE, 'sales', 'front_desk', 'reception', 'operator', 'support'];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', instagram_comment: 'Instagram comment', voice: 'Phone', web: 'Web chat' };
const SOCIAL = ['instagram', 'messenger', 'instagram_comment'];
/** Who the conversation is with: a phone number, or (Instagram / Messenger) the channel and a masked Meta id. */
const contactLine = (channel: string, externalId: string | null) => (SOCIAL.includes(channel) ? `${CHANNEL_LABEL[channel]} id ••${(externalId ?? '').slice(-4)}` : formatPhone(externalId));

/** Team inbox: every conversation of this workspace, shared by the team and the AI. */
export default function InboxPage() {
  const { data: me } = useApi<Me>('/auth/me', 0);
  const [status, setStatus] = useState<'open' | 'pending' | 'resolved' | 'all'>('open');
  const [who, setWho] = useState<'all' | 'me' | 'unassigned'>('all');
  const [q, setQ] = useState('');
  const [channel, setChannel] = useState('all');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const params = new URLSearchParams({ status, assignee: who, ...(channel !== 'all' ? { channel } : {}), ...(query ? { q: query } : {}) });
  const { data, error, reload } = useApi<List>(`/inbox/conversations?${params}`, 8_000);
  const [selected, setSelected] = useState<string | null>(null);
  const current = useMemo(() => data?.items.find((i) => i.id === selected) ?? data?.items[0] ?? null, [data, selected]);
  const canReply = Boolean(me && REPLY.includes(me.role));
  const canManage = Boolean(me && MANAGE.includes(me.role));

  return (
    <>
      <PageHeader title="Team inbox" />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'open', label: `Open (${data?.counts.open ?? 0})` }, { value: 'pending', label: `Pending (${data?.counts.pending ?? 0})` }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]} />
        <Segmented label="Assignee" value={who} onChange={setWho} options={[{ value: 'all', label: 'Everyone' }, { value: 'me', label: `Mine (${data?.counts.mine ?? 0})` }, { value: 'unassigned', label: `Unassigned (${data?.counts.unassigned ?? 0})` }]} />
        <select aria-label="Channel" className={cx(inputCls.replace('w-full', ''), 'h-9 w-44')} value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">All channels</option>
          {['whatsapp', 'instagram', 'messenger', 'instagram_comment', 'voice'].map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
        </select>
        {data && data.counts.needsHuman > 0 && <Badge tone="rose">{data.counts.needsHuman} need a person</Badge>}
        {data && data.counts.aiOff > 0 && <Badge tone="amber">{data.counts.aiOff} handled by the team (AI off)</Badge>}
      </div>
      <Card className="grid min-h-[640px] grid-cols-1 overflow-hidden md:grid-cols-[320px_1fr] xl:grid-cols-[320px_1fr_300px]">
        <div className="flex flex-col border-b border-line md:border-r md:border-b-0">
          <div className="p-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-faint" aria-hidden />
              <input className={cx(inputCls, 'pl-9')} placeholder="Search name, number, message" aria-label="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          </div>
          <ul className="max-h-[600px] flex-1 overflow-y-auto" aria-label="Conversations">
            {!data && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="mx-3 my-2 h-16" />)}
            {data?.items.length === 0 && <Empty icon={<InboxIcon className="size-6" />} title="Nothing here">No conversations match these filters.</Empty>}
            {data?.items.map((c) => (
              <li key={c.id}>
                <button onClick={() => setSelected(c.id)} aria-current={current?.id === c.id} className={cx('flex w-full gap-3 border-l-[3px] px-3 py-3 text-left', current?.id === c.id ? 'border-brand bg-brand-soft/60' : 'border-transparent hover:bg-slate-50')}>
                  <Avatar person={c.customer ?? { name: null, phone: c.externalId }} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold text-ink">{c.customer ? displayName(c.customer) : contactLine(c.channel, c.externalId)}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-faint">{timeAgo(c.updatedAt)}</span>
                    </span>
                    <span className="block truncate text-[12.5px] text-muted">{c.lastMessage ? `${c.lastMessage.role === 'user' ? '' : 'Reply: '}${c.lastMessage.content}` : 'No messages'}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {c.channel !== 'whatsapp' && <Badge tone="violet">{CHANNEL_LABEL[c.channel] ?? c.channel}</Badge>}
                      {c.needsHuman && <Badge tone="rose">needs a person</Badge>}
                      {!c.aiEnabled && <Badge tone="amber">AI off</Badge>}
                      {c.aiMode === 'review' && <Badge tone="violet">review first</Badge>}
                      {c.priority !== 'normal' && <Badge tone={PRIORITY_TONE[c.priority]}>{c.priority}</Badge>}
                      {c.assignee && <Badge tone="slate">{c.assignee.name}</Badge>}
                      {c.labels.slice(0, 3).map((l) => <Badge key={l} tone="sky">{l}</Badge>)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {current ? <ConversationPane key={current.id} id={current.id} canReply={canReply} canManage={canManage} me={me ?? null} onChanged={reload} /> : <div className="grid place-items-center p-10 text-[13px] text-muted">Choose a conversation.</div>}
      </Card>
    </>
  );
}

function ConversationPane({ id, canReply, canManage, me, onChanged }: { id: string; canReply: boolean; canManage: boolean; me: Me | null; onChanged: () => Promise<void> }) {
  const { data: d, error, reload } = useApi<Detail>(`/inbox/conversations/${id}`, 6_000);
  const { data: members } = useApi<Person[]>('/inbox/members', 0);
  const { data: saved } = useApi<Saved[]>('/inbox/saved-replies', 0);
  const [tab, setTab] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [labelText, setLabelText] = useState('');

  async function run(key: string, fn: () => Promise<unknown>, ok?: string | ((r: unknown) => string)) {
    setBusy(key);
    try {
      const r = await fn();
      await Promise.all([reload(), onChanged()]);
      if (ok) toast(typeof ok === 'function' ? ok(r) : ok);
      return true;
    } catch (e) {
      toast(errMsg(e), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  }
  if (error && !d) return <div className="p-6"><ErrorBanner message={error} onRetry={reload} /></div>;
  if (!d) return <div className="p-6"><Skeleton className="h-96" /></div>;
  const patch = (body: Record<string, unknown>, ok: string) => run('patch', () => api.patch(`/inbox/conversations/${id}`, body), ok);

  return (
    <>
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-ink">{d.customer ? displayName(d.customer) : contactLine(d.channel, d.externalId)}</p>
            <p className="text-[12px] text-muted" data-testid="contact-line">{contactLine(d.channel, d.externalId)} · {CHANNEL_LABEL[d.channel] ?? d.channel}</p>
          </div>
          {d.channel === 'instagram_comment' ? null : d.aiEnabled ? (
            <Button disabled={!canReply} busy={busy === 'take'} onClick={() => void run('take', () => api.post(`/inbox/conversations/${id}/take-over`), 'You are handling this conversation. The AI will not reply.')}><Hand className="size-4" />Take over</Button>
          ) : (
            <Button disabled={!canReply} busy={busy === 'ai'} onClick={() => void run('ai', () => api.post(`/inbox/conversations/${id}/return-to-ai`), 'Returned to the AI.')}><Bot className="size-4" />Return to AI</Button>
          )}
          {d.inboxStatus !== 'resolved' ? (
            <Button variant="primary" disabled={!canReply} busy={busy === 'patch'} onClick={() => void patch({ inboxStatus: 'resolved' }, 'Resolved.')}><CheckCircle2 className="size-4" />Resolve</Button>
          ) : (
            <Button disabled={!canReply} onClick={() => void patch({ inboxStatus: 'open' }, 'Re-opened.')}>Re-open</Button>
          )}
        </div>
        <p className={cx('flex items-center gap-2 px-4 py-2 text-[12.5px] font-semibold', d.aiEnabled ? 'bg-[#e7f6ee] text-[#15803d]' : 'bg-amber-soft text-[#b45309]')} data-testid="ai-state">
          {d.aiEnabled ? <><Bot className="size-4" aria-hidden />The AI is answering this conversation</> : <><Hand className="size-4" aria-hidden />The team is handling this conversation — the AI is silent</>}
        </p>
        {d.aiEnabled && <Steering d={d} id={id} canReply={canReply} busy={busy} run={run} />}
        {d.handoff && (
          <div className="mx-4 mt-3 rounded-[10px] border border-rose-200 bg-rose-50 p-3 text-[12.5px]" data-testid="handoff-summary">
            <p className="font-semibold text-rose-800">Hand-over: {d.handoff.reason ?? 'needs a person'}</p>
            {d.handoff.lastCustomerMessages.length > 0 && <p className="mt-1 text-body">Customer said: {d.handoff.lastCustomerMessages.map((m) => `“${m}”`).join(' · ')}</p>}
          </div>
        )}
        <div className="max-h-[440px] flex-1 overflow-y-auto p-4">
          <Thread messages={d.messages} name={d.customer ? displayName(d.customer) : 'the customer'} channel={d.channel} />
        </div>
        <Drafts d={d} id={id} canReply={canReply} busy={busy} run={run} />
        <div className="border-t border-line p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Segmented label="Write" value={tab} onChange={setTab} options={[{ value: 'reply', label: 'Reply to customer' }, { value: 'note', label: 'Internal note' }]} />
            {tab === 'reply' && saved && saved.length > 0 && (
              <select className={cx(inputCls, 'h-8 w-auto')} aria-label="Insert a saved reply" value="" onChange={(e) => setText(saved.find((s) => s.id === e.target.value)?.body ?? text)}>
                <option value="">Saved replies…</option>
                {saved.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            )}
          </div>
          {tab === 'reply' && !d.replyWindow.open && <p className="mb-2 flex items-center gap-1.5 text-[12px] text-amber-800"><Lock className="size-3.5" aria-hidden />{d.replyWindow.note}</p>}
          {tab === 'reply' && d.replyWindow.comment && <p className="mb-2 text-[12px] text-muted" data-testid="comment-note">{d.replyWindow.note}</p>}
          <form className="flex gap-2" onSubmit={async (e) => {
            e.preventDefault();
            const body = text.trim();
            if (!body) return;
            const ok = await run('send', () => (tab === 'reply' ? api.post(`/inbox/conversations/${id}/reply`, { text: body }) : api.post(`/inbox/conversations/${id}/notes`, { body })), tab === 'reply' ? (r) => ((r as { sent?: boolean; notSentReason?: string }).sent === false ? `Saved but NOT sent: ${(r as { notSentReason?: string }).notSentReason ?? 'test mode'}.` : 'Sent to WhatsApp. Delivery shows when Meta reports it.') : 'Note added (only your team sees it).');
            if (ok) setText('');
          }}>
            <textarea className={cx(inputCls, 'h-20 py-2')} aria-label={tab === 'reply' ? 'Reply message' : 'Internal note'} placeholder={tab === 'reply' ? `Write to the customer (sent as your business on ${CHANNEL_LABEL[d.channel] ?? 'WhatsApp'})…` : 'Write a note for your team (never sent to the customer)…'} value={text} onChange={(e) => setText(e.target.value)} disabled={!canReply || (tab === 'reply' && !d.replyWindow.open)} />
            <div className="flex flex-col justify-end gap-1.5">
              {tab === 'reply' && d.replyWindow.comment && (
                <Button type="button" className="whitespace-nowrap" busy={busy === 'private'} disabled={!canReply || !text.trim()} onClick={async () => { if (await run('private', () => api.post(`/inbox/conversations/${id}/private-reply`, { text: text.trim() }), (r) => ((r as { sent?: boolean; notSentReason?: string }).sent === false ? `Saved but NOT sent: ${(r as { notSentReason?: string }).notSentReason}` : 'Private message sent.'))) setText(''); }}>Send as private message</Button>
              )}
              <Button type="submit" variant="primary" className="whitespace-nowrap" busy={busy === 'send'} disabled={!canReply || !text.trim() || (tab === 'reply' && !d.replyWindow.open)}>{tab === 'reply' ? <><Send className="size-4" />{d.replyWindow.comment ? 'Reply publicly' : 'Send'}</> : <><StickyNote className="size-4" />Add note</>}</Button>
            </div>
          </form>
        </div>
      </div>

      <aside className="hidden flex-col gap-4 border-l border-line p-4 xl:flex" aria-label="Conversation details">
        <section className="text-[12.5px]">
          <p className="mb-1 font-semibold text-ink">Status</p>
          <select className={inputCls} aria-label="Status" value={d.inboxStatus} disabled={!canReply} onChange={(e) => void patch({ inboxStatus: e.target.value }, 'Status changed.')}>
            {(['open', 'pending', 'resolved'] as const).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <p className="mt-3 mb-1 font-semibold text-ink">Priority</p>
          <select className={inputCls} aria-label="Priority" value={d.priority} disabled={!canReply} onChange={(e) => void patch({ priority: e.target.value }, 'Priority changed.')}>
            {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <p className="mt-3 mb-1 font-semibold text-ink">Assigned to</p>
          <select className={inputCls} aria-label="Assigned to" value={d.assignee?.id ?? ''} disabled={!canReply} onChange={(e) => void patch({ assigneeId: e.target.value || null }, 'Assignment changed.')}>
            <option value="">Unassigned</option>
            {(members ?? []).filter((m) => canManage || m.id === me?.id || m.id === d.assignee?.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {canManage && <Button className="mt-2 w-full" busy={busy === 'rr'} onClick={() => void run('rr', () => api.post(`/inbox/conversations/${id}/assign-round-robin`), 'Assigned to the least busy person.')}><UserPlus className="size-4" />Assign round-robin</Button>}
        </section>
        <section className="text-[12.5px]">
          <p className="mb-1 flex items-center gap-1 font-semibold text-ink"><Tag className="size-3.5" aria-hidden />Labels</p>
          <div className="flex flex-wrap gap-1">
            {d.labels.map((l) => <button key={l} disabled={!canManage} className="rounded-full bg-sky-50 px-2 py-0.5 text-[11.5px] font-semibold text-sky-800" title={canManage ? 'Remove' : undefined} onClick={() => void patch({ labels: d.labels.filter((x) => x !== l) }, 'Label removed.')}>{l}{canManage ? ' ×' : ''}</button>)}
            {!d.labels.length && <span className="text-muted">None</span>}
          </div>
          {canManage && (
            <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (labelText.trim()) void patch({ labels: [...d.labels, labelText.trim()] }, 'Label added.').then(() => setLabelText('')); }}>
              <input className={cx(inputCls, 'h-8')} aria-label="New label" placeholder="vip, complaint…" value={labelText} onChange={(e) => setLabelText(e.target.value)} />
              <Button type="submit" className="h-8">Add</Button>
            </form>
          )}
        </section>
        <section className="text-[12.5px]">
          <p className="mb-1 font-semibold text-ink">Customer</p>
          {d.customer ? (
            <ul className="space-y-0.5 text-body">
              <li>{displayName(d.customer)} · {formatPhone(d.customer.phone)}</li>
              {d.customer.email && <li>{d.customer.email}</li>}
              <li>Language: {d.customer.language ?? 'not known yet'}</li>
              <li>{SOCIAL.includes(d.channel) ? `Wrote on ${CHANNEL_LABEL[d.channel]}` : `WhatsApp consent: ${d.customer.messagingConsent ? 'yes' : 'no'}`}{d.customer.optedOutAt ? ' · opted out (STOP)' : ''}</li>
              {d.customer.source && <li>Source: {d.customer.source}</li>}
            </ul>
          ) : <p className="text-muted">No customer record.</p>}
          {d.orders.length > 0 && (
            <>
              <p className="mt-2 mb-1 font-semibold text-ink">Recent orders</p>
              <ul className="space-y-0.5 text-body">{d.orders.map((o) => <li key={o.id}>{o.orderNumber} · {o.status} · ₹{o.total}</li>)}</ul>
            </>
          )}
          {d.leads.length > 0 && <p className="mt-2 text-body">Lead: {d.leads[0].status}{d.leads[0].source ? ` · ${d.leads[0].source}` : ''}</p>}
        </section>
        <section className="text-[12.5px]" data-testid="notes">
          <p className="mb-1 flex items-center gap-1 font-semibold text-ink"><StickyNote className="size-3.5" aria-hidden />Internal notes</p>
          {d.notes.length === 0 ? <p className="text-muted">No notes.</p> : (
            <ul className="space-y-2">{d.notes.map((n) => <li key={n.id} className="rounded-[8px] bg-amber-50 p-2"><p className="text-body">{n.body}</p><p className="mt-0.5 text-[11px] text-muted">{n.author} · {timeAgo(n.createdAt)}</p></li>)}</ul>
          )}
        </section>
        {!canReply && <p className="flex items-center gap-1 text-[12px] text-muted"><MessageSquare className="size-3.5" aria-hidden />Your role can read the inbox but not reply.</p>}
      </aside>
    </>
  );
}

type Run = (key: string, fn: () => Promise<unknown>, ok?: string | ((r: unknown) => string)) => Promise<boolean | undefined>;

/** Live AI steering: send automatically or review first, and private guidance for the AI in this conversation. */
function Steering({ d, id, canReply, busy, run }: { d: Detail; id: string; canReply: boolean; busy: string | null; run: Run }) {
  const { workspace } = useWorkspace();
  const [text, setText] = useState(d.guidance?.text ?? '');
  const [hours, setHours] = useState('24');
  // Review mode: WhatsApp (not the restaurant ordering engine, which cannot hold a reply) and Instagram / Messenger.
  const reviewable = SOCIAL.includes(d.channel) || (d.channel === 'whatsapp' && workspace?.industry !== 'restaurant');
  return (
    <div className="mx-4 mt-3 rounded-[10px] border border-violet-200 bg-violet-50/60 p-3 text-[12.5px]" data-testid="ai-steering">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 font-semibold text-ink"><Compass className="size-4 text-violet-700" aria-hidden />Steer the AI</span>
        {reviewable ? (
          <Segmented label="AI replies" value={d.aiMode ?? 'auto'} onChange={(v) => void run('mode', () => api.patch(`/inbox/conversations/${id}`, { aiMode: v }), v === 'review' ? 'Review first: the AI drafts each reply and waits for your approval.' : 'The AI sends its replies automatically again.')} options={[{ value: 'auto', label: 'Send automatically' }, { value: 'review', label: 'Review first' }]} />
        ) : (
          <span className="text-muted">{workspace?.industry === 'restaurant' ? 'Order replies always go out at once (take over to answer yourself).' : 'Review first is available on WhatsApp.'}</span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="min-w-[220px] flex-1">
          <span className="sr-only">Guidance for the AI</span>
          <input className={inputCls} aria-label="Guidance for the AI" maxLength={500} placeholder="Private guidance, e.g. “Customer is price sensitive: lead with the 55L option”" value={text} onChange={(e) => setText(e.target.value)} disabled={!canReply} />
        </label>
        <select className={cx(inputCls.replace('w-full', ''), 'w-36')} aria-label="Guidance lasts" value={hours} onChange={(e) => setHours(e.target.value)} disabled={!canReply}>
          <option value="2">for 2 hours</option><option value="24">for 24 hours</option><option value="72">for 3 days</option><option value="">until cleared</option>
        </select>
        <Button busy={busy === 'guide'} disabled={!canReply || !text.trim()} onClick={() => void run('guide', () => api.patch(`/inbox/conversations/${id}`, { aiGuidance: text, aiGuidanceHours: hours || null }), 'Guidance saved. The AI uses it from its next reply.')}>Save guidance</Button>
        {d.guidance && <Button variant="ghost" busy={busy === 'unguide'} disabled={!canReply} onClick={() => void run('unguide', () => api.patch(`/inbox/conversations/${id}`, { aiGuidance: null }), 'Guidance cleared.').then(() => setText(''))}>Clear</Button>}
      </div>
      <p className="mt-1.5 text-[11.5px] text-muted" data-testid="guidance-state">
        {d.guidance ? `In force${d.guidance.until ? ` until ${new Date(d.guidance.until).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ' until cleared'}. ` : 'No guidance. '}
        Never shown to the customer. It shapes replies the AI writes with its language model; answers taken straight from your data (prices, slots, bookings) are not changed by it.
      </p>
    </div>
  );
}

/** Review mode: the AI's replies waiting for a person. Approve as written, edit and send, or discard. */
function Drafts({ d, id, canReply, busy, run }: { d: Detail; id: string; canReply: boolean; busy: string | null; run: Run }) {
  const held = d.messages.filter((m) => (m as { deliveryStatus?: string | null }).deliveryStatus === 'held');
  const [edits, setEdits] = useState<Record<string, string>>({});
  if (!held.length) return null;
  const sentMsg = (r: unknown) => ((r as { sent?: boolean; notSentReason?: string }).sent === false ? `Approved but NOT sent: ${(r as { notSentReason?: string }).notSentReason ?? 'test mode'}.` : 'Sent to WhatsApp.');
  return (
    <div className="border-t border-violet-200 bg-violet-50/50 p-3" data-testid="ai-drafts">
      <p className="mb-2 text-[12.5px] font-semibold text-violet-900">{held.length} AI {held.length === 1 ? 'reply waits' : 'replies wait'} for your approval</p>
      {held.map((m) => {
        const value = edits[m.id] ?? m.content;
        const changed = value.trim() !== m.content;
        return (
          <div key={m.id} className="mb-2 rounded-[10px] border border-violet-200 bg-white p-2" data-testid="ai-draft">
            <textarea className={cx(inputCls, 'h-20 py-2')} aria-label="AI draft" value={value} onChange={(e) => setEdits({ ...edits, [m.id]: e.target.value })} disabled={!canReply} />
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Button variant="primary" busy={busy === `ap-${m.id}`} disabled={!canReply || !value.trim()} onClick={() => void run(`ap-${m.id}`, () => api.post(`/inbox/conversations/${id}/drafts/${m.id}/approve`, changed ? { text: value } : {}), sentMsg)}><Send className="size-4" />{changed ? 'Send edited' : 'Approve & send'}</Button>
              <Button variant="ghost" busy={busy === `ds-${m.id}`} disabled={!canReply} onClick={() => void run(`ds-${m.id}`, () => api.post(`/inbox/conversations/${id}/drafts/${m.id}/discard`, {}), 'Discarded: not sent.')}><Trash2 className="size-4" />Discard</Button>
              <span className="text-[11.5px] text-muted">Whatever the AI did (a booking, an update) is already recorded; only its message waits.</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
