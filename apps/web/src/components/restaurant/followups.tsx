'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FlaskConical, MessageCircle, Phone, PhoneCall, PlayCircle, ShieldAlert, Star } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { dateTime, displayName, formatPhone } from '@/lib/format';
import { FOLLOWUP_KIND, FOLLOWUP_STATUS, SCENARIO_LABEL, inr, useMe, type FeedbackRow, type FollowUpRow, type FollowUpSummary } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, IconTile, Segmented, Skeleton, cx } from '@/components/ui';

type Tab = 'all' | 'open' | 'whatsapp' | 'voice' | 'problems';

function ModeBanner({ s }: { s: FollowUpSummary }) {
  if (s.mode === 'dry_run') {
    return (
      <div role="note" className="mb-4 flex items-start gap-2.5 rounded-[12px] border border-violet-soft bg-violet-soft/60 px-4 py-3 text-[13px] text-[#4c1d95]">
        <FlaskConical className="mt-0.5 size-4 shrink-0" />
        <span>
          <b>Simulation (DRY_RUN).</b> Follow-ups run the real workflow and queue, but no WhatsApp message is sent and no call is placed. Every request and its simulated result is recorded below.
        </span>
      </div>
    );
  }
  return (
    <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-[12px] border border-rose-soft bg-rose-soft/60 px-4 py-3 text-[13px] text-[#9f1239]">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <span>
        <b>Live mode.</b> {s.liveAllowAll ? 'Follow-ups reach every consenting (non-demo) customer.' : `Follow-ups reach only the ${s.liveTestRecipients} approved test number${s.liveTestRecipients === 1 ? '' : 's'} (LIVE_TEST_RECIPIENTS).`} Demo customers are never contacted.
      </span>
    </div>
  );
}

function Stat({ label, value, sub, icon, tone }: { label: string; value: React.ReactNode; sub?: string; icon: React.ReactNode; tone: 'brand' | 'violet' | 'amber' | 'sky' | 'rose' }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] font-medium text-muted">{label}</p>
        <IconTile tone={tone} size="sm">
          {icon}
        </IconTile>
      </div>
      <p className="tabular mt-2 text-[24px] font-bold text-ink">{value}</p>
      {sub && <p className="text-[12px] text-muted">{sub}</p>}
    </Card>
  );
}

function Stars({ n }: { n: number | null }) {
  if (n === null) return <span className="text-faint">—</span>;
  return (
    <span className={cx('inline-flex items-center gap-0.5 font-semibold', n <= 2 ? 'text-rose' : n >= 4 ? 'text-brand-dark' : 'text-[#b45309]')}>
      <Star className="size-3.5 fill-current" /> {n}/5
    </span>
  );
}

function DemoRunner({ s, onRan }: { s: FollowUpSummary; onRan: () => void }) {
  const [orderId, setOrderId] = useState('');
  const [scenario, setScenario] = useState('call_happy');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const input = 'h-9 w-full rounded-[10px] border border-line bg-white px-3 text-[13px] text-ink';
  return (
    <Card>
      <CardHeader title="Run demo follow-up" subtitle="Always simulated: a WhatsApp feedback request, then a feedback call, for a collected demo order." action={<Badge tone="violet">Dry-run</Badge>} />
      <form
        className="grid grid-cols-1 gap-3 px-5 pb-5 md:grid-cols-[1fr_1.4fr_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMsg(null);
          try {
            const r = await api.post<{ orderNumber: string; scenario: string }>('/restaurant/followups/demo-run', { orderId: orderId || undefined, scenario });
            setMsg(`Queued for ${r.orderNumber} — watch the list below (it updates every few seconds).`);
            onRan();
          } catch (err) {
            setMsg(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="text-[12px] text-muted">
          Demo order
          <select value={orderId} onChange={(e) => setOrderId(e.target.value)} className={input} aria-label="Demo order">
            <option value="">Latest collected demo order</option>
            {s.demoOrders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.orderNumber} · {o.customerName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] text-muted">
          Simulated customer
          <select value={scenario} onChange={(e) => setScenario(e.target.value)} className={input} aria-label="Scenario">
            {s.scenarios.map((sc) => (
              <option key={sc} value={sc}>
                {SCENARIO_LABEL[sc] ?? sc}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <Button type="submit" variant="primary" busy={busy} disabled={!s.demoOrders.length}>
            <PlayCircle className="size-4" /> Run
          </Button>
        </div>
        {!s.demoOrders.length && <p className="text-[12.5px] text-[#b45309] md:col-span-3">No collected demo orders. Run <code>npm run seed:gr-chicken-demo</code>.</p>}
        {msg && <p className="text-[12.5px] text-body md:col-span-3">{msg}</p>}
      </form>
    </Card>
  );
}

function Details({ f }: { f: FollowUpRow }) {
  const transcript = (f.result?.transcript as string[] | undefined) ?? [];
  const replies = (f.result?.simulatedReplies as Array<{ customer: string; assistant: string }> | undefined) ?? [];
  const notes = (f.result?.notes as string[] | undefined) ?? [];
  const request = (f.payload as { request?: unknown } | null)?.request;
  return (
    <div className="grid grid-cols-1 gap-3 bg-slate-50/70 px-5 py-4 text-[12.5px] lg:grid-cols-2">
      <div>
        <p className="mb-1 font-semibold text-ink">{f.channel === 'voice' ? 'Call request' : 'WhatsApp request'}{f.dryRun ? ' (simulated — not sent)' : ''}</p>
        {request ? <pre className="max-h-64 overflow-auto rounded-[8px] bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">{JSON.stringify(request, null, 2)}</pre> : <p className="text-muted">Not sent yet.</p>}
        {f.providerMessageId && <p className="mt-1 break-all text-faint">Message id: {f.providerMessageId}</p>}
      </div>
      <div className="flex flex-col gap-2">
        {notes.map((n) => (
          <p key={n} className="flex gap-1.5 text-[#b45309]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {n}
          </p>
        ))}
        {f.lastError && <p className="text-body"><b>Note:</b> {f.lastError}</p>}
        {transcript.length > 0 && (
          <div>
            <p className="mb-1 font-semibold text-ink">Call transcript{f.dryRun ? ' (simulated)' : ''}</p>
            <ol className="flex flex-col gap-1">
              {transcript.map((line, i) => (
                <li key={i} className={cx('rounded-[8px] px-2.5 py-1.5', i % 2 ? 'bg-white text-ink' : 'bg-brand-soft text-brand-dark')}>
                  <b>{i % 2 ? 'Customer' : 'Assistant'}:</b> {line}
                </li>
              ))}
            </ol>
          </div>
        )}
        {replies.length > 0 && (
          <div>
            <p className="mb-1 font-semibold text-ink">Simulated customer replies</p>
            {replies.map((r, i) => (
              <p key={i} className="text-body">
                <b>Customer:</b> {r.customer} → <b>Assistant:</b> {r.assistant}
              </p>
            ))}
          </div>
        )}
        {f.call && (
          <p className="text-body">
            <b>Call:</b> {f.call.status}
            {f.call.durationSec ? ` · ${f.call.durationSec}s` : ''} {f.call.summary ? `· ${f.call.summary}` : ''}
          </p>
        )}
        <p className="text-faint">
          Attempt {f.attempts}/{f.maxAttempts} · created {dateTime(f.createdAt)}
          {f.completedAt ? ` · finished ${dateTime(f.completedAt)}` : ''}
        </p>
      </div>
    </div>
  );
}

function FollowUpTable({ rows, canEdit, onChanged }: { rows: FollowUpRow[]; canEdit: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <Empty icon={<MessageCircle className="size-6" />} title="No follow-ups here" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-[13px]">
        <thead>
          <tr className="border-y border-line bg-slate-50/60 text-left text-[11.5px] font-semibold tracking-wide text-muted uppercase">
            <th className="w-8 px-3 py-2" />
            <th className="px-2 py-2">Follow-up</th>
            <th className="px-3 py-2">Customer · order</th>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-5 py-2 text-right" />
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const st = FOLLOWUP_STATUS[f.status] ?? { label: f.status, tone: 'slate' as const };
            const isOpen = open === f.id;
            return (
              <Fragment key={f.id}>
                <tr className="cursor-pointer border-b border-line hover:bg-slate-50/60" onClick={() => setOpen(isOpen ? null : f.id)}>
                  <td className="px-3 py-2.5 text-muted">{isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</td>
                  <td className="px-2 py-2.5">
                    <span className="flex items-center gap-2 font-semibold text-ink">
                      {f.channel === 'voice' ? <Phone className="size-3.5 text-violet" /> : <MessageCircle className="size-3.5 text-brand" />}
                      {FOLLOWUP_KIND[f.kind] ?? f.kind}
                    </span>
                    <span className="mt-0.5 flex gap-1">
                      {f.dryRun && <Badge tone="violet">Simulated</Badge>}
                      {f.customer.isDemo && <Badge tone="amber">Demo</Badge>}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="block font-semibold text-ink">{displayName(f.customer)}</span>
                    <Link href={`/orders?id=${f.order.id}`} onClick={(e) => e.stopPropagation()} className="text-[12px] text-brand">
                      {f.order.orderNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-body">{dateTime(f.status === 'scheduled' || f.status === 'retrying' ? f.scheduledAt : f.completedAt ?? f.updatedAt)}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {f.lastError && <p className="mt-1 max-w-[280px] truncate text-[11.5px] text-muted" title={f.lastError}>{f.lastError}</p>}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {canEdit && ['scheduled', 'retrying'].includes(f.status) && (
                      <Button
                        className="h-8"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await api.post(`/restaurant/followups/${f.id}/cancel`).catch(() => undefined);
                          onChanged();
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-line">
                    <td colSpan={6}>
                      <Details f={f} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FeedbackPanel({ canEdit }: { canEdit: boolean }) {
  const [filter, setFilter] = useState<'all' | 'complaints'>('all');
  const { data, reload } = useApi<FeedbackRow[]>(`/restaurant/feedback${filter === 'complaints' ? '?filter=complaints' : ''}`, 8_000);
  return (
    <Card>
      <CardHeader
        title="Feedback & complaints"
        subtitle="Ratings from WhatsApp replies and calls. 1–2 or complaint words are escalated to staff."
        action={<Segmented label="Feedback filter" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'complaints', label: 'Complaints' }]} />}
      />
      {!data ? (
        <Skeleton className="m-5 h-24" />
      ) : !data.length ? (
        <Empty icon={<Star className="size-6" />} title="No feedback yet" />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {data.map((f) => (
            <li key={f.id} className="flex flex-wrap items-start gap-3 px-5 py-3 text-[13px]">
              <div className="min-w-[180px] flex-1">
                <p className="flex items-center gap-2 font-semibold text-ink">
                  {displayName({ name: f.customerName, phone: f.customerPhone })}
                  <Link href={`/orders?id=${f.id}`} className="text-[12px] font-semibold text-brand">
                    {f.orderNumber}
                  </Link>
                  {f.isDemo && <Badge tone="amber">Demo</Badge>}
                </p>
                <p className="text-[12px] text-muted">
                  {f.feedbackChannel === 'voice' ? 'On the call' : f.feedbackChannel === 'whatsapp' ? 'On WhatsApp' : ''} {f.feedbackAt ? `· ${dateTime(f.feedbackAt)}` : ''} · {inr(f.total)}
                </p>
                {(f.complaintNote || f.feedbackComment) && <p className="mt-1 text-body">“{f.complaintNote ?? f.feedbackComment}”</p>}
              </div>
              <Stars n={f.feedbackRating} />
              {f.complaintStatus && (
                <span className="flex items-center gap-2">
                  <Badge tone={f.complaintStatus === 'open' ? 'rose' : 'brand'}>{f.complaintStatus === 'open' ? 'Complaint open' : 'Resolved'}</Badge>
                  {canEdit && (
                    <Button
                      className="h-8"
                      onClick={async () => {
                        const resolve = f.complaintStatus === 'open';
                        const note = resolve ? window.prompt('How was it resolved? (optional)') ?? '' : '';
                        await api.patch(`/restaurant/orders/${f.id}/complaint`, { status: resolve ? 'resolved' : 'open', note }).catch(() => undefined);
                        reload();
                      }}
                    >
                      {f.complaintStatus === 'open' ? <><CheckCircle2 className="size-4" /> Resolve</> : 'Re-open'}
                    </Button>
                  )}
                </span>
              )}
              {f.customerPhone && f.complaintStatus === 'open' && (
                <a href={`tel:+${f.customerPhone}`} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand">
                  <PhoneCall className="size-3.5" /> {formatPhone(f.customerPhone)}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RestaurantFollowUps() {
  const me = useMe();
  const canEdit = !!me && me.role !== 'viewer';
  const [tab, setTab] = useState<Tab>('all');
  const { data: s, error, reload: reloadSummary } = useApi<FollowUpSummary>('/restaurant/followups/summary', 5_000);
  const query = tab === 'open' ? '?status=open' : tab === 'whatsapp' ? '?channel=whatsapp' : tab === 'voice' ? '?channel=voice' : tab === 'problems' ? '?status=failed' : '';
  const { data: rows, reload } = useApi<FollowUpRow[]>(`/restaurant/followups${query}`, 4_000);
  const refresh = () => {
    reload();
    reloadSummary();
  };

  return (
    <>
      <PageHeader title="Follow-ups" crumb="Follow-ups" />
      {error && !s && <ErrorBanner message={error} onRetry={reloadSummary} />}
      {s && <ModeBanner s={s} />}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {!s ? (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-[14px]" />)
        ) : (
          <>
            <Stat label="Scheduled" value={s.scheduled} sub={`Feedback ${s.settings.feedbackDelayMinutes} min · call ${s.settings.callDelayMinutes / 60} h after collection`} icon={<MessageCircle className="size-4" />} tone="sky" />
            <Stat label="WhatsApp sent" value={s.whatsappSent} sub={`${s.whatsappDelivered} delivered / read`} icon={<MessageCircle className="size-4" />} tone="brand" />
            <Stat label="Calls answered" value={s.callsAnswered} sub={`${s.callsNoAnswer} not answered · ${s.settings.callMaxAttempts} tries max`} icon={<Phone className="size-4" />} tone="violet" />
            <Stat label="Average rating" value={s.averageRating ?? '—'} sub={`${s.ratings} rating${s.ratings === 1 ? '' : 's'}`} icon={<Star className="size-4" />} tone="amber" />
            <Stat label="Open complaints" value={s.complaintsOpen} sub={`${s.complaintsResolved} resolved · ${s.failed} failed sends`} icon={<AlertTriangle className="size-4" />} tone="rose" />
          </>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        {s && canEdit ? <DemoRunner s={s} onRan={refresh} /> : <div />}
        {s && (
          <Card>
            <CardHeader title="Rules" />
            <ul className="flex flex-col gap-1.5 px-5 pb-5 text-[12.5px] text-body">
              <li>• WhatsApp needs messaging consent; a call needs calling consent. STOP cancels everything pending.</li>
              <li>• Outside WhatsApp&apos;s 24h window an approved template is required (feedback template {s.settings.feedbackTemplateSet ? 'set' : 'not set'}).</li>
              <li>• Calls only during calling hours; not answered → retried after {s.settings.callRetryMinutes} min, up to {s.settings.callMaxAttempts} calls.</li>
              <li>• A rating on WhatsApp cancels the call. 1–2 or complaint words → complaint for staff.</li>
              <li>• Each follow-up is created once per order and sent at most once, even if retried.</li>
            </ul>
          </Card>
        )}
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Messages & calls"
          subtitle="Click a row for the exact request, delivery status, transcript and errors"
          action={
            <Segmented<Tab>
              label="Follow-up filter"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'all', label: 'All' },
                { value: 'open', label: 'Scheduled' },
                { value: 'whatsapp', label: 'WhatsApp' },
                { value: 'voice', label: 'Calls' },
                { value: 'problems', label: 'Failed' },
              ]}
            />
          }
        />
        {!rows ? <Skeleton className="m-5 h-40" /> : <FollowUpTable rows={rows} canEdit={canEdit} onChanged={refresh} />}
      </Card>

      <div className="mt-4">
        <FeedbackPanel canEdit={canEdit} />
      </div>
    </>
  );
}
