import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { followUpQueue } from '../queues/queues.js';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';
import { SettingsService } from '../settings/settings.service.js';
import { DEFAULT_SETTINGS, type TenantSettings } from '../settings/tenant-settings.js';
import { speedToLeadSequence, visitIdOf } from './follow-up-plan.js';

export { speedToLeadSequence, visitIdOf };

export interface CreateFollowUpInput {
  organizationId: string;
  leadId: string;
  customerId: string;
  channel?: 'whatsapp' | 'voice' | 'human';
  action?: 'message' | 'call' | 'handoff' | 'callback';
  message?: string;
  scheduledAt: Date | string;
  source?: 'sequence' | 'callback' | 'retry' | 'task' | 'manual' | 'visit' | 'alert' | 'quote' | 'order' | 'feedback' | 'invoice' | 'payment';
}

/**
 * Classic lead sequence (used when a business turns "instant call" off):
 * WhatsApp -> WhatsApp follow-up -> AI call -> final WhatsApp.
 * Each step re-checks state before running (replied? booked? not interested? already called?).
 * Delays are multiplied by FOLLOWUP_TIME_SCALE for local testing.
 */
const LEAD_SEQUENCE: Array<{
  afterMinutes: number;
  channel: 'whatsapp' | 'voice';
  step: 'first_contact' | 'reminder' | 'call' | 'final';
}> = [
  { afterMinutes: 0, channel: 'whatsapp', step: 'first_contact' },
  { afterMinutes: 30, channel: 'whatsapp', step: 'reminder' },
  { afterMinutes: 120, channel: 'voice', step: 'call' },
  { afterMinutes: 24 * 60, channel: 'whatsapp', step: 'final' },
];

const ACTIVE = ['scheduled', 'processing'];

@Injectable()
export class FollowUpsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  settingsFor(organizationId: string): Promise<TenantSettings> {
    return this.settings ? this.settings.get(organizationId) : Promise.resolve(DEFAULT_SETTINGS);
  }

  async create(input: CreateFollowUpInput) {
    const scheduledAt = new Date(input.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Invalid scheduledAt');
    }

    const followUp = await this.prisma.followUp.create({
      data: {
        organizationId: input.organizationId,
        leadId: input.leadId,
        customerId: input.customerId,
        channel: input.channel ?? 'whatsapp',
        action: input.action ?? 'message',
        message: input.message ?? null,
        scheduledAt,
        status: 'scheduled',
        source: input.source ?? 'manual',
      },
    });

    await followUpQueue.add(
      'follow-up',
      { followUpId: followUp.id },
      {
        delay: Math.max(0, scheduledAt.getTime() - Date.now()),
        jobId: `follow-up-${followUp.id}`,
      },
    );

    log.info('followup.scheduled', {
      followUpId: followUp.id,
      leadId: followUp.leadId,
      channel: followUp.channel,
      action: followUp.action,
      scheduledAt: followUp.scheduledAt,
    });
    return followUp;
  }

  /** Starts the automatic sequence for a brand-new lead (idempotent per lead). */
  async startLeadSequence(params: { organizationId: string; leadId: string; customerId: string }) {
    const existing = await this.prisma.followUp.count({
      where: { leadId: params.leadId, source: 'sequence' },
    });
    if (existing > 0) {
      log.info('followup.sequence_exists', { leadId: params.leadId });
      return [];
    }

    const settings = await this.settingsFor(params.organizationId);
    const sequence = settings.speedToLead.instantCall ? speedToLeadSequence(settings) : LEAD_SEQUENCE;
    const base = Date.now() + 3000;
    const created = [];
    for (const item of sequence) {
      created.push(
        await this.create({
          ...params,
          channel: item.channel,
          action: item.channel === 'voice' ? 'call' : 'message',
          message: item.step,
          scheduledAt: new Date(base + item.afterMinutes * 60_000 * config.followUp.timeScale),
          source: 'sequence',
        }),
      );
    }
    return created;
  }

  /**
   * After a visit is booked: alert the team now, ask the customer to confirm the day before, remind them
   * with the location, alert the team just before, and follow up after (thank-you / no-show recovery).
   * Idempotent: a step that already exists for this visit is not created twice. Every step re-checks the
   * visit when it runs, so a cancelled or moved visit sends nothing.
   */
  async scheduleVisitFollowThrough(visit: { id: string; organizationId: string; leadId: string; customerId: string; scheduledAt: Date }) {
    const s = await this.settingsFor(visit.organizationId);
    const at = visit.scheduledAt.getTime();
    const now = Date.now();
    const scale = config.followUp.timeScale;
    const steps: Array<{ message: string; when: number; source: 'visit' | 'alert' }> = [];
    const hasTeam = s.team.alertPhones.length > 0;

    if (hasTeam && s.team.alertOnBooking) steps.push({ message: `alert:booked:${visit.id}`, when: now, source: 'alert' });
    if (s.visits.confirmDayBefore && at - 24 * 3600_000 > now + 10 * 60_000) {
      steps.push({ message: `visit:confirm:${visit.id}`, when: at - 24 * 3600_000, source: 'visit' });
    }
    if (s.visits.reminderHoursBefore > 0 && at - s.visits.reminderHoursBefore * 3600_000 > now + 5 * 60_000) {
      steps.push({ message: `visit:reminder:${visit.id}`, when: at - s.visits.reminderHoursBefore * 3600_000, source: 'visit' });
    }
    if (hasTeam && s.visits.teamAlertMinutesBefore > 0 && at - s.visits.teamAlertMinutesBefore * 60_000 > now) {
      steps.push({ message: `alert:visit_soon:${visit.id}`, when: at - s.visits.teamAlertMinutesBefore * 60_000, source: 'alert' });
    }
    if (s.visits.afterVisit) steps.push({ message: `visit:after:${visit.id}`, when: at + 2 * 3600_000, source: 'visit' });

    await this.cancelStaleVisitSteps(visit.organizationId, visit.customerId);
    const existing = new Set(
      (
        await this.prisma.followUp.findMany({
          where: { leadId: visit.leadId, source: { in: ['visit', 'alert'] }, message: { in: steps.map((x) => x.message) } },
          select: { message: true },
        })
      ).map((f) => f.message),
    );
    const created = [];
    for (const step of steps) {
      if (existing.has(step.message)) continue;
      // Time scaling (tests) only shortens the wait from now; real deployments use scale 1.
      const when = scale === 1 ? step.when : now + Math.max(0, step.when - now) * scale;
      created.push(
        await this.create({
          organizationId: visit.organizationId,
          leadId: visit.leadId,
          customerId: visit.customerId,
          channel: 'whatsapp',
          action: 'message',
          message: step.message,
          scheduledAt: new Date(when),
          source: step.source,
        }),
      );
    }
    return created;
  }

  /** Reminders for visits that were cancelled or moved are cancelled, so the follow-ups page stays truthful. */
  async cancelStaleVisitSteps(organizationId: string, customerId: string) {
    const pending = await this.prisma.followUp.findMany({
      where: { organizationId, customerId, status: 'scheduled', source: { in: ['visit', 'alert'] } },
      select: { id: true, message: true },
    });
    const visitIds = [...new Set(pending.map((f) => visitIdOf(f.message)).filter((v): v is string => Boolean(v)))];
    if (!visitIds.length) return 0;
    const rows = await this.prisma.siteVisit.findMany({ where: { id: { in: visitIds } }, select: { id: true, status: true } });
    const active = new Set(rows.filter((v) => ['requested', 'scheduled', 'confirmed'].includes(v.status)).map((v) => v.id));
    const cancelled = new Set(rows.filter((v) => v.status === 'cancelled').map((v) => v.id));
    // A completed visit keeps its after-visit message; a cancelled / moved one never happened, so it goes too.
    const stale = pending.filter((f) => {
      const id = visitIdOf(f.message);
      return id && !active.has(id) && (!f.message?.startsWith('visit:after:') || cancelled.has(id));
    });
    if (!stale.length) return 0;
    await this.prisma.followUp.updateMany({
      where: { id: { in: stale.map((f) => f.id) }, status: 'scheduled' },
      data: { status: 'cancelled', cancellationReason: 'Visit cancelled or moved' },
    });
    return stale.length;
  }

  /** One alert per lead when it turns hot (buying soon + a matching property shown). */
  async scheduleHotLeadAlert(params: { organizationId: string; leadId: string; customerId: string }) {
    const s = await this.settingsFor(params.organizationId);
    if (!s.team.alertOnHotLead || s.team.alertPhones.length === 0) return null;
    const message = `alert:hot:${params.leadId}`;
    if (await this.prisma.followUp.count({ where: { leadId: params.leadId, message } })) return null;
    return this.create({ ...params, channel: 'whatsapp', action: 'message', message, scheduledAt: new Date(), source: 'alert' });
  }

  /** Cancel pending automation for a customer. Optionally limit to channels / sources. */
  async cancelPending(params: {
    organizationId: string;
    customerId: string;
    reason: string;
    channels?: string[];
    sources?: string[];
    exceptId?: string;
  }) {
    const pending = await this.prisma.followUp.findMany({
      where: {
        organizationId: params.organizationId,
        customerId: params.customerId,
        status: 'scheduled',
        channel: params.channels ? { in: params.channels } : { not: 'human' },
        ...(params.sources ? { source: { in: params.sources } } : {}),
        ...(params.exceptId ? { id: { not: params.exceptId } } : {}),
      },
    });
    if (pending.length === 0) return 0;

    await this.prisma.followUp.updateMany({
      where: { id: { in: pending.map((f) => f.id) }, status: 'scheduled' },
      data: { status: 'cancelled', cancellationReason: params.reason },
    });
    await Promise.all(
      pending.map(async (f) => {
        try {
          await (await followUpQueue.getJob(`follow-up-${f.id}`))?.remove();
        } catch {
          // Job may already be active; the processor re-checks status before running.
        }
      }),
    );
    log.info('followup.cancelled', {
      customerId: params.customerId,
      count: pending.length,
      reason: params.reason,
    });
    return pending.length;
  }

  /** Customer asked to be called back: replace pending automation with one callback call. */
  async scheduleCallback(params: {
    organizationId: string;
    leadId: string;
    customerId: string;
    callbackAt?: Date;
    note?: string;
  }) {
    await this.cancelPending({
      organizationId: params.organizationId,
      customerId: params.customerId,
      reason: 'Customer requested a callback',
    });
    if (!params.callbackAt || params.callbackAt.getTime() < Date.now() + 60_000) {
      // No resolvable time: leave it to the sales team.
      return this.createHumanTask({ ...params, reason: `Callback requested: ${params.note ?? 'no time given'}` });
    }
    return this.create({
      organizationId: params.organizationId,
      leadId: params.leadId,
      customerId: params.customerId,
      channel: 'voice',
      action: 'callback',
      message: params.note ?? 'callback',
      scheduledAt: params.callbackAt,
      source: 'callback',
    });
  }

  /** A task for a human salesperson (shown in the dashboard). Not queued. */
  async createHumanTask(params: {
    organizationId: string;
    leadId: string;
    customerId: string;
    reason: string;
  }) {
    const open = await this.prisma.followUp.findFirst({
      where: { customerId: params.customerId, channel: 'human', status: 'open' },
    });
    if (open) {
      return this.prisma.followUp.update({
        where: { id: open.id },
        data: { message: `${open.message ?? ''}\n${params.reason}`.trim() },
      });
    }
    return this.prisma.followUp.create({
      data: {
        organizationId: params.organizationId,
        leadId: params.leadId,
        customerId: params.customerId,
        channel: 'human',
        action: 'handoff',
        message: params.reason,
        scheduledAt: new Date(),
        status: 'open',
        source: 'task',
      },
    });
  }

  async hasActiveVoiceAutomation(customerId: string) {
    const count = await this.prisma.followUp.count({
      where: { customerId, channel: 'voice', status: { in: ACTIVE } },
    });
    return count > 0;
  }

  findAll(organizationId: string, filter: { channel?: string; status?: string } = {}) {
    return this.prisma.followUp.findMany({
      where: {
        organizationId,
        ...(filter.channel ? { channel: filter.channel } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { scheduledAt: 'desc' },
      take: 500,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        lead: { select: { id: true, status: true, location: true, bhk: true, propertyType: true, budget: true } },
      },
    });
  }

  async findLead(organizationId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, organizationId } });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async findOne(organizationId: string, followUpId: string) {
    const followUp = await this.prisma.followUp.findFirst({ where: { id: followUpId, organizationId } });
    if (!followUp) throw new NotFoundException('Follow-up not found');
    return followUp;
  }

  async cancel(organizationId: string, followUpId: string, reason?: string) {
    const followUp = await this.findOne(organizationId, followUpId);
    if (!['scheduled', 'open'].includes(followUp.status)) return followUp;
    const updated = await this.prisma.followUp.update({
      where: { id: followUp.id },
      data: { status: 'cancelled', cancellationReason: reason ?? 'Cancelled manually' },
    });
    try {
      await (await followUpQueue.getJob(`follow-up-${followUp.id}`))?.remove();
    } catch {
      /* already running */
    }
    return updated;
  }

  async completeTask(organizationId: string, followUpId: string) {
    const followUp = await this.findOne(organizationId, followUpId);
    return this.prisma.followUp.update({
      where: { id: followUp.id },
      data: { status: 'completed', completedAt: new Date() },
    });
  }
}

