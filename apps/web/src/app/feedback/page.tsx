'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, Star } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Feedback } from '@/lib/types';
import { FEEDBACK_STATUS, dateTime, displayName, formatPhone, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, Empty, ErrorBanner, Segmented, Skeleton } from '@/components/ui';
import { Notice, TextileOnly, errorText, inputCls } from '@/components/textile';

type Filter = 'needs_action' | 'received' | 'requested' | 'resolved';

export default function FeedbackPage() {
  return (
    <>
      <PageHeader title="Feedback" crumb="Sales / Feedback" />
      <TextileOnly allow={['textile', 'retail']}>
        <FeedbackList />
      </TextileOnly>
    </>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span aria-label={`${rating} out of 5`} className="inline-flex">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`size-4 ${i <= rating ? 'fill-amber text-amber' : 'text-slate-300'}`} />
      ))}
    </span>
  );
}

function FeedbackList() {
  const [filter, setFilter] = useState<Filter>('needs_action');
  const { data, error, reload } = useApi<Feedback[]>('/textile/feedback', 15_000);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const rows = (data ?? []).filter((f) => f.status === filter);
  const count = (s: string) => (data ?? []).filter((f) => f.status === s).length;

  async function resolve(f: Feedback) {
    setBusy(f.id);
    try {
      await api.post(`/textile/feedback/${f.id}/resolve`, { resolution: drafts[f.id] ?? '' });
      setNotice({ tone: 'ok', text: `Feedback from ${displayName(f.customer)} marked resolved.` });
      await reload();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-muted">
          After delivery the AI asks for a 1–5 rating on WhatsApp. A rating of 3 or less, or a complaint, comes here for your team and creates a handoff task.
        </p>
        <Segmented
          label="Feedback filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'needs_action', label: `Needs action (${count('needs_action')})` },
            { value: 'received', label: `Received (${count('received')})` },
            { value: 'requested', label: `Waiting (${count('requested')})` },
            { value: 'resolved', label: 'Resolved' },
          ]}
        />
      </div>
      <Notice notice={notice} />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {!data && [0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}
        {rows.map((f) => {
          const st = FEEDBACK_STATUS[f.status] ?? { label: f.status, tone: 'slate' as const };
          return (
            <Card key={f.id} className="flex flex-col p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[14px] font-semibold text-ink">{displayName(f.customer)}</p>
                  <p className="text-[12px] text-muted">
                    {formatPhone(f.customer?.phone)}
                    {f.order && <> · <Link href={`/sales-orders?id=${f.order.id}`} className="hover:underline">{f.order.number}</Link></>}
                  </p>
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <div className="mt-3 flex-1">
                {f.rating ? <Stars rating={f.rating} /> : <p className="text-[12.5px] text-muted">No rating yet · asked {timeAgo(f.requestedAt)}</p>}
                {f.comment && <p className="mt-2 rounded-[10px] bg-slate-50 px-3 py-2 text-[13px] text-ink">&ldquo;{f.comment}&rdquo;</p>}
                {f.resolution && (
                  <p className="mt-2 text-[12.5px] text-muted">
                    Resolved {f.resolvedAt ? dateTime(f.resolvedAt) : ''}: {f.resolution}
                  </p>
                )}
              </div>
              {f.status === 'needs_action' && (
                <div className="mt-3 flex flex-col gap-2">
                  <textarea
                    aria-label="What was done"
                    rows={2}
                    value={drafts[f.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [f.id]: e.target.value }))}
                    placeholder="What did the team do? e.g. Called, replacement roll dispatched."
                    className={`${inputCls} h-auto py-2`}
                  />
                  <Button variant="primary" busy={busy === f.id} disabled={!(drafts[f.id] ?? '').trim()} onClick={() => resolve(f)}>
                    <CheckCircle2 className="size-4" /> Mark resolved
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      {data && rows.length === 0 && (
        <Card className="mt-2">
          <Empty icon={<Star className="size-6" />} title="Nothing here">
            {filter === 'needs_action' ? 'No unhappy customers waiting. Low ratings and complaints appear here.' : null}
          </Empty>
        </Card>
      )}
    </>
  );
}
