import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { authorOf, change, csvRows, istDay, istSlot, isSimulated, median, percentile, responseTimes, type Author } from './metrics.js';

const MESSAGE_CAP = 50_000;
const STAGES = ['new', 'interested', 'qualified', 'converted', 'lost'];

/**
 * Advanced analytics for one organization over a period (with the previous period of the same length for comparison).
 * Every figure is counted from the database with a stated definition; nothing is estimated. Message-based figures read
 * at most 50 000 messages per period (the response says when that cap was reached).
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async advanced(org: string, daysRaw: unknown) {
    const days = Math.min(Math.max(Math.round(Number(daysRaw) || 30), 1), 180);
    const now = new Date();
    const since = new Date(now.getTime() - days * 86_400_000);
    const prevSince = new Date(since.getTime() - days * 86_400_000);

    const [cur, prev] = await Promise.all([this.period(org, since, now), this.period(org, prevSince, since)]);
    const [channels, crm, sources, revenue, automation, team, heatmap] = await Promise.all([
      this.channels(org, cur.messages),
      this.crm(org),
      this.sources(org, since),
      this.revenue(org, since, now, days),
      this.automation(org, since),
      this.team(org, cur.messages),
      Promise.resolve(this.heatmap(cur.messages)),
    ]);

    const k = (key: keyof typeof cur.kpis) => ({ value: cur.kpis[key], previous: prev.kpis[key], changePct: change(cur.kpis[key], prev.kpis[key]) });
    // Daily series from the messages already read.
    const buckets = Array.from({ length: Math.min(days, 90) }, (_, i) => istDay(new Date(now.getTime() - (Math.min(days, 90) - 1 - i) * 86_400_000)));
    // One pass over the messages, then one row per day.
    const perDay = new Map<string, Record<Author, number>>();
    for (const m of cur.messages) {
      const d = istDay(m.createdAt);
      const row = perDay.get(d) ?? { customer: 0, ai: 0, team: 0, automatic: 0 };
      row[authorOf(m)]++;
      perDay.set(d, row);
    }
    const series = buckets.map((day) => ({ day, ...(perDay.get(day) ?? { customer: 0, ai: 0, team: 0, automatic: 0 }) }));

    return {
      days,
      from: since,
      to: now,
      capped: cur.capped,
      kpis: {
        inboundMessages: k('inboundMessages'),
        conversations: k('conversations'),
        handoffRatePct: k('handoffRatePct'),
        aiMedianResponseSec: k('aiMedianResponseSec'),
        teamMedianResponseSec: k('teamMedianResponseSec'),
        unansweredTurns: k('unansweredTurns'),
        leads: k('leads'),
        leadConversionPct: k('leadConversionPct'),
        orders: k('orders'),
        revenue: k('revenue'),
        averageOrderValue: k('averageOrderValue'),
      },
      responseTimes: cur.responseTimes,
      answeredBy: cur.answeredBy,
      channels,
      crm,
      sources,
      revenue,
      automation,
      team,
      heatmap,
      series,
      definitions: {
        inboundMessages: 'Messages customers sent (all channels) in the period.',
        conversations: 'Conversations with at least one message in the period.',
        handoffRatePct: 'Share of those conversations handed to a person (AI hand-over or team take-over) in the period.',
        aiMedianResponseSec: 'Median seconds from a customer message to the AI answer (consecutive customer messages count from the first).',
        teamMedianResponseSec: 'Median seconds from a customer message to a team member answer.',
        unansweredTurns: 'Conversations whose last customer message in the period has no answer yet.',
        leadConversionPct: 'Leads created in the period that are now won (or whose customer is at the CRM stage "converted").',
        revenue: 'Total of orders completed (collected) in the period, ₹.',
        averageOrderValue: 'Revenue divided by completed orders.',
      },
    };
  }

  async csv(org: string, days: unknown) {
    const a = await this.advanced(org, days);
    const rows: Array<Array<string | number | null>> = [['section', 'metric', 'value', 'previous period', 'change %']];
    for (const [key, v] of Object.entries(a.kpis)) rows.push(['kpi', key, v.value, v.previous, v.changePct]);
    for (const [k, v] of Object.entries(a.answeredBy)) rows.push(['answered by', k, v, null, null]);
    for (const c of a.channels) rows.push(['channel', c.channel, c.inbound, null, null], ['channel conversations', c.channel, c.conversations, null, null]);
    for (const s of a.crm.stages) rows.push(['crm stage', s.stage, s.count, null, null]);
    for (const s of a.sources) rows.push(['lead source', s.source, s.leads, null, null], ['lead source won', s.source, s.won, null, null]);
    for (const t of a.team) rows.push(['team', t.name, t.replies, null, null], ['team median response sec', t.name, t.medianResponseSec, null, null]);
    for (const [k, v] of Object.entries(a.automation.campaigns)) rows.push(['campaign recipients', k, v, null, null]);
    for (const [k, v] of Object.entries(a.automation.drips)) rows.push(['drip enrolments', k, v, null, null]);
    for (const [k, v] of Object.entries(a.automation.workflows)) rows.push(['workflow runs', k, v, null, null]);
    for (const [k, v] of Object.entries(a.automation.metaCapi)) rows.push(['meta capi events', k, v, null, null]);
    for (const d of a.revenue.series) rows.push(['revenue by day', d.day, d.revenue, null, null], ['orders by day', d.day, d.orders, null, null]);
    return { csv: `﻿${csvRows(rows)}\r\n`, days: a.days };
  }

  // -------------------------------------------------------------------------------------------- sections
  private async period(org: string, from: Date, to: Date) {
    const messages = await this.prisma.message.findMany({
      where: { organizationId: org, createdAt: { gte: from, lt: to } },
      select: { conversationId: true, role: true, createdAt: true, metadata: true },
      orderBy: { createdAt: 'asc' },
      take: MESSAGE_CAP,
    });
    const convIds = [...new Set(messages.map((m) => m.conversationId))];
    const [handoffs, leads, orders] = await Promise.all([
      convIds.length ? this.prisma.conversation.count({ where: { organizationId: org, id: { in: convIds }, handoffAt: { gte: from, lt: to } } }) : 0,
      this.prisma.lead.findMany({ where: { organizationId: org, createdAt: { gte: from, lt: to } }, select: { id: true, status: true, customerId: true } }),
      this.prisma.order.findMany({ where: { organizationId: org, status: 'completed', updatedAt: { gte: from, lt: to } }, select: { total: true } }),
    ]);
    const convertedCustomers = leads.length ? new Set((await this.prisma.customer.findMany({ where: { id: { in: [...new Set(leads.map((l) => l.customerId))] }, stage: 'converted' }, select: { id: true } })).map((c) => c.id)) : new Set<string>();
    const wonLeads = leads.filter((l) => l.status === 'won' || convertedCustomers.has(l.customerId)).length;
    const rt = responseTimes(messages);
    const answeredBy: Record<Exclude<Author, 'customer'> | 'simulated', number> = { ai: 0, team: 0, automatic: 0, simulated: 0 };
    for (const m of messages) {
      const a = authorOf(m);
      if (a !== 'customer') answeredBy[a]++;
      if (a !== 'customer' && isSimulated(m.metadata)) answeredBy.simulated++;
    }
    const revenue = orders.reduce((s, o) => s + Number(o.total), 0);
    const round = (v: number | null) => (v === null ? null : Math.round(v));
    return {
      messages,
      capped: messages.length >= MESSAGE_CAP,
      answeredBy,
      responseTimes: {
        ai: { count: rt.ai.length, medianSec: round(median(rt.ai)), p90Sec: round(percentile(rt.ai, 90)) },
        team: { count: rt.team.length, medianSec: round(median(rt.team)), p90Sec: round(percentile(rt.team, 90)) },
        unanswered: rt.unanswered,
      },
      kpis: {
        inboundMessages: messages.filter((m) => m.role === 'user').length,
        conversations: convIds.length,
        handoffRatePct: convIds.length ? Math.round((handoffs / convIds.length) * 1000) / 10 : null,
        aiMedianResponseSec: round(median(rt.ai)),
        teamMedianResponseSec: round(median(rt.team)),
        unansweredTurns: rt.unanswered,
        leads: leads.length,
        leadConversionPct: leads.length ? Math.round((wonLeads / leads.length) * 1000) / 10 : null,
        orders: orders.length,
        revenue: Math.round(revenue * 100) / 100,
        averageOrderValue: orders.length ? Math.round((revenue / orders.length) * 100) / 100 : null,
      } as Record<string, number | null>,
    };
  }

  /** Channel of each conversation in the messages already read (one small query, no second message scan). */
  private async channels(org: string, messages: Array<{ conversationId: string; role: string }>) {
    const inbound = messages.filter((m) => m.role === 'user');
    const ids = [...new Set(inbound.map((m) => m.conversationId))];
    const channelOf = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 5000) {
      for (const c of await this.prisma.conversation.findMany({ where: { organizationId: org, id: { in: ids.slice(i, i + 5000) } }, select: { id: true, channel: true } })) channelOf.set(c.id, c.channel);
    }
    const map = new Map<string, { inbound: number; convs: Set<string> }>();
    for (const r of inbound) {
      const ch = channelOf.get(r.conversationId) ?? 'unknown';
      const e = map.get(ch) ?? { inbound: 0, convs: new Set<string>() };
      e.inbound++;
      e.convs.add(r.conversationId);
      map.set(ch, e);
    }
    return [...map.entries()].map(([channel, e]) => ({ channel, inbound: e.inbound, conversations: e.convs.size })).sort((a, b) => b.inbound - a.inbound);
  }

  private async crm(org: string) {
    const g = await this.prisma.customer.groupBy({ by: ['stage'], where: { organizationId: org, isDemo: false }, _count: { _all: true } });
    const count = (s: string) => g.filter((x) => (x.stage ?? 'new') === s).reduce((n, x) => n + x._count._all, 0);
    return { stages: STAGES.map((stage) => ({ stage, count: count(stage) })), note: 'Current CRM stage of every customer (demo records excluded).' };
  }

  private async sources(org: string, since: Date) {
    const leads = await this.prisma.lead.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { source: true, status: true } });
    const map = new Map<string, { leads: number; won: number }>();
    for (const l of leads) {
      const k = l.source ?? 'unknown';
      const e = map.get(k) ?? { leads: 0, won: 0 };
      e.leads++;
      if (l.status === 'won') e.won++;
      map.set(k, e);
    }
    return [...map.entries()].map(([source, e]) => ({ source, ...e, conversionPct: e.leads ? Math.round((e.won / e.leads) * 1000) / 10 : null })).sort((a, b) => b.leads - a.leads).slice(0, 12);
  }

  private async revenue(org: string, since: Date, now: Date, days: number) {
    const orders = await this.prisma.order.findMany({ where: { organizationId: org, status: 'completed', updatedAt: { gte: since } }, select: { total: true, updatedAt: true, customerId: true } });
    const n = Math.min(days, 90);
    const buckets = Array.from({ length: n }, (_, i) => istDay(new Date(now.getTime() - (n - 1 - i) * 86_400_000)));
    const series = buckets.map((day) => {
      const os = orders.filter((o) => istDay(o.updatedAt) === day);
      return { day, orders: os.length, revenue: Math.round(os.reduce((s, o) => s + Number(o.total), 0) * 100) / 100 };
    });
    const buyers = [...new Set(orders.map((o) => o.customerId))];
    const counts = buyers.length ? await this.prisma.order.groupBy({ by: ['customerId'], where: { organizationId: org, status: 'completed', customerId: { in: buyers } }, _count: { _all: true } }) : [];
    const repeat = counts.filter((c) => c._count._all >= 2).length;
    return { series, buyers: buyers.length, repeatBuyers: repeat, repeatRatePct: buyers.length ? Math.round((repeat / buyers.length) * 1000) / 10 : null };
  }

  private async automation(org: string, since: Date) {
    const [camp, drips, stops, wf, capi] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({ by: ['status'], where: { organizationId: org, createdAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.dripEnrollment.groupBy({ by: ['status'], where: { organizationId: org, enrolledAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.dripEnrollment.groupBy({ by: ['stopReason'], where: { organizationId: org, enrolledAt: { gte: since }, status: 'stopped' }, _count: { _all: true } }),
      this.prisma.workflowRun.groupBy({ by: ['status'], where: { organizationId: org, createdAt: { gte: since }, test: false }, _count: { _all: true } }),
      this.prisma.metaCapiEvent.groupBy({ by: ['status'], where: { organizationId: org, createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const obj = <T extends { _count: { _all: number } }>(rows: T[], k: (r: T) => string | null) => Object.fromEntries(rows.map((r) => [k(r) ?? 'unknown', r._count._all]));
    return {
      campaigns: obj(camp, (r) => r.status),
      drips: obj(drips, (r) => r.status),
      dripStopReasons: obj(stops, (r) => r.stopReason),
      workflows: obj(wf, (r) => r.status),
      metaCapi: obj(capi, (r) => r.status),
    };
  }

  /** Per team member: conversations assigned now (open), replies in the period, median response to the customer. */
  private async team(org: string, messages: Array<{ conversationId: string; role: string; createdAt: Date; metadata: unknown }>) {
    const users = await this.prisma.user.findMany({ where: { organizationId: org }, select: { id: true, name: true, email: true } });
    const open = await this.prisma.conversation.groupBy({ by: ['assigneeId'], where: { organizationId: org, inboxStatus: { in: ['open', 'pending'] }, assigneeId: { not: null } }, _count: { _all: true } });
    // Response per author: customer turn start -> this person's message.
    const byConv = new Map<string, typeof messages>();
    for (const m of messages) byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m]);
    const per = new Map<string, { replies: number; rt: number[] }>();
    for (const list of byConv.values()) {
      let turn: Date | null = null;
      for (const m of list) {
        const a = authorOf(m);
        if (a === 'customer') { turn ??= m.createdAt; continue; }
        if (a === 'team') {
          const uid = String((m.metadata as { userId?: string } | null)?.userId ?? '');
          const e = per.get(uid) ?? { replies: 0, rt: [] };
          e.replies++;
          if (turn) e.rt.push((m.createdAt.getTime() - turn.getTime()) / 1000);
          per.set(uid, e);
        }
        turn = null;
      }
    }
    return users
      .map((u) => {
        const e = per.get(u.id);
        const med = e ? median(e.rt) : null;
        return { userId: u.id, name: u.name ?? u.email, openAssigned: open.find((o) => o.assigneeId === u.id)?._count._all ?? 0, replies: e?.replies ?? 0, medianResponseSec: med === null ? null : Math.round(med) };
      })
      .filter((t) => t.replies > 0 || t.openAssigned > 0)
      .sort((a, b) => b.replies - a.replies);
  }

  private heatmap(messages: Array<{ role: string; createdAt: Date }>) {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const m of messages) {
      if (m.role !== 'user') continue;
      const s = istSlot(m.createdAt);
      grid[s.dow][s.hour]++;
    }
    return { grid, note: 'Customer messages by IST weekday (Mon-Sun) and hour.' };
  }
}
