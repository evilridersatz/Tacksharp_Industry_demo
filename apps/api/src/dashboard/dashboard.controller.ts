import { Org } from '../auth/decorators.js';
import { Controller, Get, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { computeRoi } from './roi.js';

const IST_OFFSET_MS = 330 * 60_000;
const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Read-only aggregates for the dashboard. */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Speed to lead, contact / booking / show-up rates and cost per attended visit, for leads created in the period. */
  @Get('roi')
  async roi(@Org() organizationId: string, @Query('days') daysParam?: string) {
    const days = Math.min(Math.max(Number(daysParam) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000);
    const leads = await this.prisma.lead.findMany({
      where: { organizationId, createdAt: { gte: since } },
      select: { id: true, createdAt: true, source: true, campaign: true, status: true, customer: { select: { lastInboundAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    });
    const leadIds = leads.map((l) => l.id);
    const [calls, visits, whatsappSent, settings] = await Promise.all([
      this.prisma.call.findMany({ where: { organizationId, leadId: { in: leadIds } }, select: { leadId: true, createdAt: true, status: true, direction: true, durationSec: true } }),
      this.prisma.siteVisit.findMany({ where: { organizationId, leadId: { in: leadIds } }, select: { leadId: true, status: true } }),
      this.prisma.message.count({ where: { organizationId, role: 'assistant', createdAt: { gte: since }, Conversation: { channel: 'whatsapp' } } }),
      this.settings.get(organizationId),
    ]);
    return {
      days,
      ...computeRoi({
        leads: leads.map((l) => ({ id: l.id, createdAt: l.createdAt, source: l.source, campaign: l.campaign, status: l.status, repliedAt: l.customer.lastInboundAt })),
        calls,
        visits,
        whatsappSent,
        costs: settings.roi,
      }),
    };
  }

  @Get('summary')
  async summary(@Org() organizationId: string, @Query('days') daysParam?: string) {
    const days = Math.min(Math.max(Number(daysParam) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000);
    const prevSince = new Date(since.getTime() - days * 86_400_000);
    const startOfDay = new Date(Date.now() - ((Date.now() + IST_OFFSET_MS) % 86_400_000));

    const [
      totalLeads, newToday, leadsInRange, leadsPrevRange, byStatus, bySource,
      whatsappConversations, inboundWhatsapp, aiReplies,
      callsInRange, callsPrevRange, siteVisits, siteVisitsInRange, openTasks, pendingFollowUps,
      leadsSeries, callsSeries, messagesSeries,
    ] = await Promise.all([
      this.prisma.lead.count({ where: { organizationId } }),
      this.prisma.lead.count({ where: { organizationId, createdAt: { gte: startOfDay } } }),
      this.prisma.lead.count({ where: { organizationId, createdAt: { gte: since } } }),
      this.prisma.lead.count({ where: { organizationId, createdAt: { gte: prevSince, lt: since } } }),
      this.prisma.lead.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['source'], where: { organizationId }, _count: { _all: true } }),
      this.prisma.conversation.count({ where: { organizationId, channel: 'whatsapp' } }),
      this.prisma.message.count({ where: { organizationId, role: 'user', createdAt: { gte: since }, Conversation: { channel: 'whatsapp' } } }),
      this.prisma.message.count({ where: { organizationId, role: 'assistant', createdAt: { gte: since } } }),
      this.prisma.call.findMany({
        where: { organizationId, createdAt: { gte: since } },
        select: { status: true, outcome: true, durationSec: true, direction: true },
      }),
      this.prisma.call.count({ where: { organizationId, createdAt: { gte: prevSince, lt: since } } }),
      this.prisma.siteVisit.count({ where: { organizationId } }),
      this.prisma.siteVisit.count({ where: { organizationId, createdAt: { gte: since } } }),
      this.prisma.followUp.count({ where: { organizationId, channel: 'human', status: 'open' } }),
      this.prisma.followUp.count({ where: { organizationId, status: 'scheduled' } }),
      this.prisma.lead.findMany({ where: { organizationId, createdAt: { gte: since } }, select: { createdAt: true } }),
      this.prisma.call.findMany({ where: { organizationId, createdAt: { gte: since } }, select: { createdAt: true, status: true } }),
      this.prisma.message.findMany({
        where: { organizationId, role: 'user', createdAt: { gte: since } },
        select: { createdAt: true, Conversation: { select: { channel: true } } },
      }),
    ]);

    const statusCount = (...statuses: string[]) =>
      byStatus.filter((s) => statuses.includes(s.status)).reduce((sum, s) => sum + s._count._all, 0);
    const callCount = (status: string) => callsInRange.filter((c) => c.status === status).length;
    const connected = callsInRange.filter((c) => c.status === 'completed');
    const outcomes: Record<string, number> = {};
    for (const c of callsInRange) {
      const key = c.outcome ?? c.status;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }

    // One bucket per IST day so the chart lines up with the business day.
    const buckets = Array.from({ length: days }, (_, i) => istDay(new Date(Date.now() - (days - 1 - i) * 86_400_000)));
    const series = buckets.map((day) => ({
      day,
      leads: leadsSeries.filter((l) => istDay(l.createdAt) === day).length,
      calls: callsSeries.filter((c) => istDay(c.createdAt) === day).length,
      connectedCalls: callsSeries.filter((c) => istDay(c.createdAt) === day && c.status === 'completed').length,
      whatsapp: messagesSeries.filter((m) => istDay(m.createdAt) === day && m.Conversation.channel === 'whatsapp').length,
    }));

    const contactedPlus = statusCount('contacted', 'qualified', 'property_interested', 'site_visit', 'callback', 'human_handoff', 'won');
    return {
      days,
      leads: {
        total: totalLeads,
        newToday,
        inRange: leadsInRange,
        prevRange: leadsPrevRange,
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
        bySource: Object.fromEntries(bySource.map((s) => [s.source ?? 'unknown', s._count._all])),
        qualified: statusCount('qualified', 'property_interested', 'site_visit', 'won'),
        conversions: statusCount('won'),
      },
      funnel: [
        { stage: 'Leads', count: totalLeads },
        { stage: 'Contacted', count: contactedPlus },
        { stage: 'Interested', count: statusCount('qualified', 'property_interested', 'site_visit', 'won') },
        { stage: 'Site visit', count: statusCount('site_visit', 'won') },
        { stage: 'Converted', count: statusCount('won') },
      ],
      whatsapp: { conversations: whatsappConversations, inboundMessages: inboundWhatsapp },
      ai: { replies: aiReplies },
      voice: {
        total: callsInRange.length,
        prevRange: callsPrevRange,
        connected: connected.length,
        unanswered: callCount('no_answer') + callCount('busy'),
        failed: callCount('failed'),
        live: callCount('in_progress') + callCount('ringing'),
        avgDurationSec: connected.length
          ? Math.round(connected.reduce((sum, c) => sum + (c.durationSec ?? 0), 0) / connected.length)
          : 0,
        outcomes,
      },
      siteVisits: { total: siteVisits, inRange: siteVisitsInRange },
      humanTasksOpen: openTasks,
      followUpsPending: pendingFollowUps,
      series,
    };
  }

  /** Latest events across the pipeline, newest first. */
  @Get('activity')
  async activity(@Org() organizationId: string, @Query('limit') limitParam?: string) {
    const take = Math.min(Number(limitParam) || 20, 50);
    const customer = { select: { id: true, name: true, phone: true } };
    const [leads, calls, followUps, visits, inbound] = await Promise.all([
      this.prisma.lead.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take, include: { customer } }),
      this.prisma.call.findMany({ where: { organizationId, endedAt: { not: null } }, orderBy: { endedAt: 'desc' }, take, include: { customer } }),
      this.prisma.followUp.findMany({
        where: { organizationId, OR: [{ completedAt: { not: null }, channel: 'whatsapp' }, { channel: 'human' }] },
        orderBy: { updatedAt: 'desc' },
        take,
        include: { customer },
      }),
      this.prisma.siteVisit.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take, include: { Customer: customer, Property: true } }),
      this.prisma.message.findMany({
        where: { organizationId, role: 'user', Conversation: { channel: 'whatsapp' } },
        orderBy: { createdAt: 'desc' },
        take,
        include: { Conversation: { select: { Customer: customer } } },
      }),
    ]);

    const events = [
      ...leads.map((l) => ({ type: 'lead', at: l.createdAt, customer: l.customer, leadId: l.id, detail: l.source ?? 'manual' })),
      ...calls.map((c) => ({ type: 'call', at: c.endedAt!, customer: c.customer, leadId: c.leadId, detail: c.outcome ?? c.status, callId: c.id })),
      ...followUps.map((f) => ({
        type: f.channel === 'human' ? 'handoff' : 'followup',
        at: f.completedAt ?? f.createdAt,
        customer: f.customer,
        leadId: f.leadId,
        detail: f.channel === 'human' ? (f.message ?? '').replace(/^Handoff: /, '') : 'WhatsApp follow-up sent',
      })),
      ...visits.map((v) => ({ type: 'visit', at: v.createdAt, customer: v.Customer, leadId: v.leadId, detail: `${v.Property.name}, ${v.scheduledAt.toISOString()}` })),
      ...inbound.map((m) => ({ type: 'message', at: m.createdAt, customer: m.Conversation.Customer, leadId: null, detail: m.content.slice(0, 120) })),
    ];
    return events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, take);
  }
}
