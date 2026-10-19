'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  CalendarCheck,
  CalendarDays,
  Columns3,
  Headset,
  MessageSquare,
  Phone,
  PhoneCall,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { industryDef } from '@/lib/industries';
import { IndustryDashboard } from '@/components/industry-dashboard';
import { RestaurantOverview } from '@/components/restaurant/overview';
import { VisionOpsOverview } from '@/components/visionops-overview';
import type { ActivityEvent, FollowUp, Summary } from '@/lib/types';
import {
  CALL_OUTCOME,
  dateTime,
  displayName,
  followUpLabel,
  minutesSeconds,
  pct,
  sourceLabel,
  timeAgo,
} from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { AddLeadButton } from '@/components/add-lead';
import { Avatar, Badge, Card, CardHeader, Delta, Empty, ErrorBanner, IconTile, Segmented, Skeleton, cx } from '@/components/ui';
import { Donut, Sparkline, TrendChart } from '@/components/charts';

const OUTCOME_COLORS: Record<string, string> = {
  brand: '#0f9f6e',
  violet: '#7c5cf0',
  amber: '#f59e0b',
  sky: '#0ea5e9',
  rose: '#e11d48',
  slate: '#94a3b8',
};

/**
 * Overview by industry: the GR Chicken restaurant overview and the real-estate dashboard stay exactly as they were;
 * textile, retail, manufacturing and agency use the industry dashboard (GET /industry/dashboard).
 */
export default function DashboardPage() {
  const { workspace } = useWorkspace();
  if (!workspace) return <Skeleton className="h-[480px] rounded-[18px]" />;
  if (workspace.industry === 'restaurant') return <RestaurantOverview />;
  if (workspace.industry === 'real_estate') return <RealEstateDashboard />;
  if (workspace.industry === 'cctv') return <VisionOpsOverview />;
  return <IndustryDashboard title={`${industryDef(workspace.industry).short} overview`} />;
}

function RealEstateDashboard() {
  const [days, setDays] = useState('7');
  const { data: s, error, reload } = useApi<Summary>(`/dashboard/summary?days=${days}`);
  const { data: activity } = useApi<ActivityEvent[]>('/dashboard/activity?limit=12');
  const { data: upcoming } = useApi<FollowUp[]>('/follow-ups?status=scheduled');

  const period = days === '7' ? 'this week' : `last ${days} days`;
  const labels = s?.series.map((d) => new Date(d.day).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })) ?? [];

  return (
    <>
      <PageHeader
        title="Dashboard"
        actions={
          <>
            <label className="relative inline-flex h-9 items-center gap-2 rounded-[10px] border border-line bg-white pr-2 pl-3 text-[13px] font-semibold text-ink">
              <CalendarDays className="size-4 text-muted" />
              <select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)} className="bg-transparent pr-1 outline-none">
                <option value="7">Last 7 days</option>
                <option value="14">Last 14 days</option>
                <option value="30">Last 30 days</option>
              </select>
            </label>
            <AddLeadButton onCreated={reload} />
          </>
        }
      />

      {error && !s && <ErrorBanner message={error} onRetry={reload} />}

      {/* Hero */}
      <section className="relative overflow-hidden rounded-[18px] bg-gradient-to-r from-[#0d5c4a] via-[#16525e] to-[#3b3f8f] p-6 text-white">
        <div className="pointer-events-none absolute -right-24 -bottom-32 size-[360px] rounded-full border-[40px] border-white/5" />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div className="max-w-xl">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold tracking-[0.06em] uppercase">
              <Sparkles className="size-3.5" /> {days === '7' ? 'This week at a glance' : `Last ${days} days`}
            </span>
            {s ? (
              <>
                <h2 className="mt-3 text-[24px] leading-tight font-bold">
                  Your AI employee followed up {s.leads.inRange} new {s.leads.inRange === 1 ? 'lead' : 'leads'} {period}
                </h2>
                <p className="mt-2 text-[13px] text-white/75">
                  {s.voice.connected} calls connected · {s.ai.replies} AI replies · {s.siteVisits.inRange} site visits booked ·{' '}
                  {s.humanTasksOpen} waiting for your team
                </p>
              </>
            ) : (
              <Skeleton className="mt-3 h-8 w-96 bg-white/10" />
            )}
          </div>
          <div className="grid w-full grid-cols-3 gap-3 sm:w-auto">
            {[
              { icon: MessageSquare, label: 'WhatsApp', value: s?.whatsapp.inboundMessages, unit: 'replies' },
              { icon: Phone, label: 'Voice', value: s?.voice.total, unit: 'calls' },
              { icon: CalendarCheck, label: 'Visits', value: s?.siteVisits.inRange, unit: 'booked' },
            ].map((t) => (
              <div key={t.label} className="min-w-0 rounded-[12px] border border-white/15 bg-white/[0.07] px-3 py-3 sm:min-w-[130px] sm:px-4">
                <p className="flex items-center gap-1.5 text-[12px] text-white/75">
                  <t.icon className="size-3.5" /> {t.label}
                </p>
                <p className="mt-1 text-[20px] font-bold tabular">
                  {t.value ?? '–'} <span className="text-[11px] font-medium text-white/70">{t.unit}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* KPI cards */}
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          tone="violet"
          icon={<UserPlus className="size-4.5" />}
          label="New leads"
          value={s?.leads.inRange}
          sub={s ? `${s.leads.newToday} today · ${s.leads.total} in total` : ''}
          delta={s ? <Delta now={s.leads.inRange} before={s.leads.prevRange} /> : null}
          spark={s?.series.map((d) => d.leads)}
          color="#7c5cf0"
          href="/leads"
        />
        <Kpi
          tone="brand"
          icon={<PhoneCall className="size-4.5" />}
          label="AI calls"
          value={s?.voice.total}
          sub={s ? `${pct(s.voice.connected, s.voice.total)}% connected · avg ${minutesSeconds(s.voice.avgDurationSec)}` : ''}
          delta={s ? <Delta now={s.voice.total} before={s.voice.prevRange} /> : null}
          spark={s?.series.map((d) => d.calls)}
          color="#0f9f6e"
          href="/calls"
        />
        <Kpi
          tone="sky"
          icon={<Columns3 className="size-4.5" />}
          label="Interested leads"
          value={s?.leads.qualified}
          sub={s ? `${pct(s.leads.qualified, s.leads.total)}% of all leads · ${s.siteVisits.total} visits` : ''}
          spark={s?.series.map((d) => d.whatsapp)}
          color="#0ea5e9"
          href="/leads"
        />
        <Kpi
          tone="rose"
          icon={<Headset className="size-4.5" />}
          label="Waiting for your team"
          value={s?.humanTasksOpen}
          sub={s?.humanTasksOpen ? 'Customers asked for a person or a callback' : 'Nobody is waiting'}
          color="#e11d48"
          href="/handoffs"
        />
      </div>

      {/* Pipeline + outcomes */}
      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader title="Lead pipeline" subtitle="From new lead to converted customer, all time" />
          <div className="flex flex-col gap-3 px-5 pb-5">
            {s
              ? s.funnel.map((f, i) => {
                  const top = s.funnel[0].count || 1;
                  const prev = i ? s.funnel[i - 1].count : f.count;
                  const colors = ['#7c5cf0', '#0ea5e9', '#6366f1', '#0f9f6e', '#0b7f58'];
                  return (
                    <div key={f.stage} className="grid grid-cols-[88px_1fr_118px] items-center gap-3">
                      <span className="text-[13px] font-semibold text-ink">{f.stage}</span>
                      <div className="h-7 rounded-[8px] bg-slate-50">
                        <div
                          className="flex h-full items-center rounded-[8px] px-2.5 text-[12px] font-bold text-white"
                          style={{ width: `${Math.max((f.count / top) * 100, f.count ? 6 : 0)}%`, background: colors[i] }}
                        >
                          {f.count > 0 && f.count}
                        </div>
                      </div>
                      <span className="text-right text-[12px] text-muted tabular">
                        {i === 0 ? `${f.count} leads` : `${pct(f.count, prev)}% of previous`}
                      </span>
                    </div>
                  );
                })
              : [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7" />)}
          </div>
          {s && (
            <div className="grid grid-cols-2 gap-3 border-t border-line px-5 py-4 sm:grid-cols-4">
              {[
                { label: 'Calling back', value: s.leads.byStatus.callback ?? 0, tone: 'text-amber' },
                { label: 'With your team', value: s.leads.byStatus.human_handoff ?? 0, tone: 'text-rose' },
                { label: 'Not interested', value: (s.leads.byStatus.not_interested ?? 0) + (s.leads.byStatus.lost ?? 0), tone: 'text-muted' },
                { label: 'Not reached yet', value: s.leads.byStatus.new ?? 0, tone: 'text-violet' },
              ].map((x) => (
                <div key={x.label}>
                  <p className={cx('text-[20px] font-bold tabular', x.tone)}>{x.value}</p>
                  <p className="text-[12px] text-muted">{x.label}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Call outcomes" subtitle={`AI calls ${period}`} />
          {s && s.voice.total > 0 ? (
            <div className="flex flex-col items-center gap-4 px-5 pb-5">
              <Donut
                total={s.voice.total}
                label="calls"
                parts={Object.entries(s.voice.outcomes).map(([k, v]) => ({ value: v, color: OUTCOME_COLORS[CALL_OUTCOME[k]?.tone ?? 'slate'] }))}
              />
              <ul className="w-full">
                {Object.entries(s.voice.outcomes)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <li key={k} className="flex items-center justify-between border-t border-line py-2 text-[13px] first:border-t-0">
                      <span className="flex items-center gap-2 text-body">
                        <span className="size-2.5 rounded-full" style={{ background: OUTCOME_COLORS[CALL_OUTCOME[k]?.tone ?? 'slate'] }} />
                        {CALL_OUTCOME[k]?.label ?? k}
                      </span>
                      <span className="font-semibold text-ink tabular">
                        {v} <span className="font-normal text-muted">· {pct(v, s.voice.total)}%</span>
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          ) : (
            <Empty icon={<Phone className="size-6" />} title="No AI calls yet">
              Calls start automatically 2 hours after a lead arrives, if they haven&apos;t replied on WhatsApp.
            </Empty>
          )}
        </Card>
      </div>

      {/* Trend + upcoming */}
      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader
            title="Leads and AI calls"
            subtitle="Per day, India time"
            action={
              <div className="flex items-center gap-4 text-[12px] text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4 rounded bg-brand" /> Leads
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0 w-4 border-t-2 border-dashed border-violet" /> AI calls
                </span>
              </div>
            }
          />
          <div className="px-3 pb-3">
            {s ? (
              <TrendChart
                labels={labels}
                series={[
                  { name: 'Leads', values: s.series.map((d) => d.leads), color: '#0f9f6e' },
                  { name: 'AI calls', values: s.series.map((d) => d.calls), color: '#7c5cf0', dashed: true },
                ]}
              />
            ) : (
              <Skeleton className="h-[220px]" />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Coming up" subtitle="Next automatic follow-ups" action={<Link href="/follow-ups" className="text-[12.5px] font-semibold text-brand">See all</Link>} />
          <ul className="px-5 pb-4">
            {(upcoming ?? [])
              .slice()
              .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
              .slice(0, 6)
              .map((f) => (
                <li key={f.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                  <IconTile size="sm" tone={f.channel === 'voice' ? 'violet' : 'brand'}>
                    {f.channel === 'voice' ? <Phone className="size-3.5" /> : <MessageSquare className="size-3.5" />}
                  </IconTile>
                  <div className="min-w-0 flex-1">
                    <Link href={`/leads/${f.leadId}`} className="block truncate text-[13px] font-semibold text-ink hover:underline">
                      {displayName(f.customer)}
                    </Link>
                    <p className="truncate text-[12px] text-muted">{followUpLabel(f)}</p>
                  </div>
                  <span className="text-[12px] whitespace-nowrap text-muted">{dateTime(f.scheduledAt)}</span>
                </li>
              ))}
            {upcoming && upcoming.length === 0 && <Empty title="Nothing scheduled">New leads get a WhatsApp message and an AI call automatically.</Empty>}
          </ul>
        </Card>
      </div>

      {/* Activity */}
      <Card className="mt-5">
        <CardHeader title="Live activity" subtitle="Everything the AI and your customers did, newest first" />
        <ul className="px-5 pb-3">
          {(activity ?? []).map((e, i) => (
            <ActivityRow key={i} event={e} />
          ))}
          {activity && activity.length === 0 && <Empty title="No activity yet">Add a lead or connect Meta Lead Ads to get started.</Empty>}
        </ul>
      </Card>
    </>
  );
}

function Kpi({
  tone,
  icon,
  label,
  value,
  sub,
  delta,
  spark,
  color,
  href,
}: {
  tone: 'brand' | 'violet' | 'sky' | 'rose';
  icon: React.ReactNode;
  label: string;
  value?: number;
  sub: string;
  delta?: React.ReactNode;
  spark?: number[];
  color: string;
  href: string;
}) {
  return (
    <Link href={href} className="group block">
      <Card className="h-full p-4 group-hover:border-slate-300">
        <div className="flex items-center justify-between">
          <IconTile tone={tone}>{icon}</IconTile>
          {delta}
        </div>
        <p className="mt-3 text-[13px] text-muted">{label}</p>
        <p className="text-[26px] leading-tight font-bold text-ink tabular">{value ?? '–'}</p>
        <p className="mt-0.5 truncate text-[12px] text-muted">{sub}</p>
        <div className={cx('mt-2', !spark && 'h-[34px]')}>{spark && <Sparkline values={spark} color={color} />}</div>
      </Card>
    </Link>
  );
}

const EVENT_STYLE: Record<ActivityEvent['type'], { icon: typeof Phone; tone: 'brand' | 'violet' | 'sky' | 'rose' | 'amber' | 'slate'; verb: string }> = {
  lead: { icon: UserPlus, tone: 'violet', verb: 'New lead' },
  message: { icon: MessageSquare, tone: 'brand', verb: 'WhatsApp' },
  call: { icon: Phone, tone: 'violet', verb: 'AI call' },
  followup: { icon: MessageSquare, tone: 'slate', verb: 'Follow-up' },
  handoff: { icon: Headset, tone: 'rose', verb: 'Needs your team' },
  visit: { icon: CalendarCheck, tone: 'sky', verb: 'Site visit booked' },
};

function ActivityRow({ event }: { event: ActivityEvent }) {
  const style = EVENT_STYLE[event.type];
  const Icon = style.icon;
  const outcome = event.type === 'call' ? CALL_OUTCOME[event.detail] : null;
  const href = event.callId ? `/calls?id=${event.callId}` : event.leadId ? `/leads/${event.leadId}` : '/conversations';
  return (
    <li className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
      <Avatar person={event.customer} size={32} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">
          <Link href={href} className="font-semibold hover:underline">
            {displayName(event.customer)}
          </Link>
          <span className="text-muted"> · {style.verb}</span>
        </p>
        <p className="truncate text-[12px] text-muted">
          {event.type === 'call' ? '' : event.type === 'visit' ? event.detail.split(',')[0] : event.type === 'lead' ? sourceLabel(event.detail) : event.detail}
        </p>
      </div>
      {outcome ? (
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
      ) : (
        <span className="hidden sm:inline">
          <IconTile size="sm" tone={style.tone}>
            <Icon className="size-3.5" />
          </IconTile>
        </span>
      )}
      <span className="w-10 text-right text-[12px] text-faint">{timeAgo(event.at)}</span>
    </li>
  );
}
