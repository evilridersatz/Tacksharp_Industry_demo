'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Columns3, List, MessageSquare, Phone, Search, Target, TrendingUp, UserPlus, Users } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Call, FollowUp, Lead, Summary } from '@/lib/types';
import { LEAD_STATUS, callBadge, dateTime, displayName, formatPhone, pct, requirement, rupees, sourceLabel, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { AddLeadButton } from '@/components/add-lead';
import { Avatar, Badge, Card, Empty, ErrorBanner, IconTile, Segmented, Skeleton, cx } from '@/components/ui';

/** Board columns. Several backend statuses can share a column. */
const COLUMNS = [
  { key: 'new', title: 'New', statuses: ['new'], color: '#6366f1' },
  { key: 'contacted', title: 'Contacted', statuses: ['contacted', 'callback', 'human_handoff'], color: '#0ea5e9' },
  { key: 'interested', title: 'Interested', statuses: ['qualified', 'property_interested'], color: '#7c5cf0' },
  { key: 'site_visit', title: 'Site visit', statuses: ['site_visit'], color: '#0f9f6e' },
  { key: 'converted', title: 'Converted', statuses: ['won'], color: '#0b7f58' },
] as const;

const CLOSED = ['not_interested', 'lost'];
const ORDER = ['new', 'contacted', 'qualified', 'site_visit', 'won'];

export default function LeadsPage() {
  return (
    <Suspense>
      <Leads />
    </Suspense>
  );
}

function Leads() {
  const params = useSearchParams();
  const router = useRouter();
  const [view, setView] = useState<'board' | 'list'>('board');
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [source, setSource] = useState('all');
  const [showClosed, setShowClosed] = useState(true);
  const { data: leads, error, reload } = useApi<Lead[]>('/leads');
  const { data: calls } = useApi<Call[]>('/voice/calls', 15_000);
  const { data: followUps } = useApi<FollowUp[]>('/follow-ups?status=scheduled', 15_000);
  const { data: summary } = useApi<Summary>('/dashboard/summary?days=7');

  const lastCall = useMemo(() => {
    const m = new Map<string, Call>();
    for (const c of calls ?? []) if (c.leadId && !m.has(c.leadId)) m.set(c.leadId, c);
    return m;
  }, [calls]);
  const nextStep = useMemo(() => {
    const m = new Map<string, FollowUp>();
    for (const f of [...(followUps ?? [])].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)))
      if (!m.has(f.leadId)) m.set(f.leadId, f);
    return m;
  }, [followUps]);

  const sources = useMemo(() => [...new Set((leads ?? []).map((l) => l.source ?? 'unknown'))], [leads]);
  const filtered = (leads ?? []).filter((l) => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const matches =
      !q ||
      l.customer?.name?.toLowerCase().includes(q) ||
      (digits.length >= 3 && l.customer?.phone?.includes(digits)) ||
      l.location?.toLowerCase().includes(q) ||
      l.campaign?.toLowerCase().includes(q);
    return matches && (source === 'all' || (l.source ?? 'unknown') === source);
  });

  async function move(lead: Lead, status: string) {
    await api.patch(`/leads/${lead.id}/status`, { status });
    await reload();
  }

  const won = summary?.leads.conversions ?? 0;
  return (
    <>
      <PageHeader title="Leads & CRM" actions={<AddLeadButton onCreated={reload} />} />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat icon={<UserPlus className="size-4.5" />} tone="violet" label="New leads this week" value={summary?.leads.inRange} />
        <Stat icon={<Target className="size-4.5" />} tone="brand" label="Interested" value={summary?.leads.qualified} />
        <Stat icon={<TrendingUp className="size-4.5" />} tone="sky" label="Converted" value={won} extra={summary ? `${pct(won, summary.leads.total)}% of leads` : ''} />
        <Stat icon={<Users className="size-4.5" />} tone="rose" label="Needs attention" value={(summary?.leads.byStatus.callback ?? 0) + (summary?.leads.byStatus.human_handoff ?? 0)} />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'board', label: <><Columns3 className="size-3.5" /> Board</> },
            { value: 'list', label: <><List className="size-3.5" /> List</> },
          ]}
        />
        <label className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-line bg-white px-3 text-[13px] text-muted">
          Source:
          <select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)} className="bg-transparent font-semibold text-ink outline-none">
            <option value="all">All</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
          Show not interested
        </label>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              router.replace(e.target.value ? `/leads?q=${encodeURIComponent(e.target.value)}` : '/leads');
            }}
            placeholder="Name, phone, area, campaign"
            aria-label="Filter leads"
            className="h-9 w-[240px] rounded-[10px] border border-line bg-white pr-3 pl-9 text-[13px] text-ink placeholder:text-faint"
          />
        </div>
      </div>

      {error && !leads && <div className="mt-4"><ErrorBanner message={error} onRetry={reload} /></div>}

      {view === 'board' ? (
        <div className="mt-4 flex gap-4 overflow-x-auto pb-4 pane-scroll">
          {[...COLUMNS, ...(showClosed ? [{ key: 'closed', title: 'Not interested', statuses: CLOSED, color: '#94a3b8' }] : [])].map((col) => {
            const items = filtered.filter((l) => (col.statuses as readonly string[]).includes(l.status));
            return (
              <section key={col.key} aria-label={col.title} className="flex w-[272px] shrink-0 flex-col rounded-[14px] bg-[#e9edf4] p-2.5">
                <header className="flex items-center gap-2 px-1.5 pt-1 pb-2" style={{ boxShadow: `inset 0 -3px 0 ${col.color}` }}>
                  <span className="size-2 rounded-full" style={{ background: col.color }} />
                  <h2 className="flex-1 text-[13.5px] font-semibold text-ink">{col.title}</h2>
                  <span className="rounded-full bg-white px-2 text-[11.5px] font-bold text-ink">{items.length}</span>
                </header>
                <div className="mt-2 flex flex-col gap-2.5">
                  {!leads && [0, 1].map((i) => <Skeleton key={i} className="h-28 bg-white" />)}
                  {items.map((l) => (
                    <LeadCard key={l.id} lead={l} call={lastCall.get(l.id)} next={nextStep.get(l.id)} onMove={move} />
                  ))}
                  {leads && items.length === 0 && <p className="px-2 py-6 text-center text-[12.5px] text-faint">No leads here</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Card className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[860px] text-[13px]">
            <thead className="border-b border-line text-left text-[12px] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">Customer</th>
                <th className="px-3 py-3 font-medium">Looking for</th>
                <th className="px-3 py-3 font-medium">Budget</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Last call</th>
                <th className="px-3 py-3 font-medium">Next step</th>
                <th className="px-5 py-3 text-right font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {filtered
                .filter((l) => showClosed || !CLOSED.includes(l.status))
                .map((l) => {
                  const st = LEAD_STATUS[l.status] ?? { label: l.status, tone: 'slate' as const };
                  const call = lastCall.get(l.id);
                  const next = nextStep.get(l.id);
                  return (
                    <tr key={l.id} className="border-t border-line hover:bg-slate-50">
                      <td className="px-5 py-2.5">
                        <Link href={`/leads/${l.id}`} className="flex items-center gap-2.5">
                          <Avatar person={l.customer} size={30} />
                          <span>
                            <span className="block font-semibold text-ink">{displayName(l.customer)}</span>
                            <span className="text-[12px] text-muted">{formatPhone(l.customer?.phone)}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 text-body">{requirement(l) || '—'}</td>
                      <td className="px-3 font-semibold text-ink tabular">{rupees(l.budget)}</td>
                      <td className="px-3"><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="px-3">{call ? <Badge tone={callBadge(call).tone}>{callBadge(call).label}</Badge> : <span className="text-faint">—</span>}</td>
                      <td className="px-3 text-muted">{next ? dateTime(next.scheduledAt) : '—'}</td>
                      <td className="px-5 text-right text-muted">{timeAgo(l.createdAt)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          {leads && filtered.length === 0 && <Empty title="No leads match">Try a different name, phone number or source.</Empty>}
        </Card>
      )}
    </>
  );
}

function Stat({ icon, tone, label, value, extra }: { icon: React.ReactNode; tone: 'brand' | 'violet' | 'sky' | 'rose'; label: string; value?: number; extra?: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <IconTile tone={tone}>{icon}</IconTile>
      <div>
        <p className="text-[12.5px] text-muted">{label}</p>
        <p className="text-[20px] leading-tight font-bold text-ink tabular">
          {value ?? '–'} {extra && <span className="text-[12px] font-semibold text-brand">{extra}</span>}
        </p>
      </div>
    </Card>
  );
}

function LeadCard({ lead, call, next, onMove }: { lead: Lead; call?: Call; next?: FollowUp; onMove: (l: Lead, s: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const idx = ORDER.indexOf(lead.status === 'property_interested' ? 'qualified' : lead.status);
  const prev = idx > 0 ? ORDER[idx - 1] : null;
  const fwd = idx >= 0 && idx < ORDER.length - 1 ? ORDER[idx + 1] : lead.status === 'callback' || lead.status === 'human_handoff' ? 'qualified' : null;
  const st = LEAD_STATUS[lead.status];
  const go = async (s: string) => {
    setBusy(true);
    try {
      await onMove(lead, s);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={cx('rounded-[12px] bg-white p-3 shadow-[var(--shadow-card)]', busy && 'opacity-60')}>
      <Link href={`/leads/${lead.id}`} className="block">
        <p className="text-[13.5px] font-semibold text-ink">{displayName(lead.customer)}</p>
        <p className="mt-0.5 truncate text-[11.5px] text-muted">
          {lead.campaign ?? sourceLabel(lead.source)} · {timeAgo(lead.createdAt)}
        </p>
        <p className="mt-2 text-[12.5px] text-body">{requirement(lead) || 'Requirement not known yet'}</p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[14px] font-bold text-ink tabular">{rupees(lead.budget)}</span>
          {call ? (
            <Badge tone={callBadge(call).tone}>
              <Phone className="size-3" /> {callBadge(call).label}
            </Badge>
          ) : st && (lead.status === 'callback' || lead.status === 'human_handoff' || lead.status === 'property_interested') ? (
            <Badge tone={st.tone}>{st.label}</Badge>
          ) : null}
        </div>
        {next && (
          <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted">
            {next.channel === 'voice' ? <Phone className="size-3" /> : <MessageSquare className="size-3" />}
            {next.channel === 'voice' ? 'AI call' : 'WhatsApp'} {dateTime(next.scheduledAt)}
          </p>
        )}
      </Link>
      <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2 text-[12px] font-semibold">
        <button disabled={!prev || busy} onClick={() => prev && go(prev)} className="inline-flex items-center gap-0.5 text-muted hover:text-ink disabled:text-slate-300">
          <ChevronLeft className="size-3.5" /> Back
        </button>
        <button disabled={!fwd || busy} onClick={() => fwd && go(fwd)} className="inline-flex items-center gap-0.5 text-brand hover:text-brand-dark disabled:text-slate-300">
          {fwd ? LEAD_STATUS[fwd].label : 'Next stage'} <ChevronRight className="size-3.5" />
        </button>
      </div>
    </article>
  );
}
