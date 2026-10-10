import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { DEFAULT_SETTINGS, effectiveCallWindow, type TenantSettings } from '../settings/tenant-settings.js';
import { istHour } from '../common/time.js';
import { VoiceService } from '../voice/voice.service.js';
import { WhatsAppSenderService, WhatsAppWindowClosedError } from '../whatsapp/whatsapp-sender.service.js';
import { describeRequirement, firstName, sequenceMessage } from '../whatsapp/message-templates.js';
import { teamAlert, visitMessage, visitTimeLabel } from '../automation/automation-messages.js';
import { followUpQueue, queueRedis } from '../queues/queues.js';
import { customerLockKey, withLock } from '../common/redis-lock.js';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';

const CLOSED_LEAD = ['won', 'lost', 'not_interested', 'human_handoff'];

/**
 * Executes one scheduled follow-up. Every step re-checks the current state first,
 * so the system never blindly contacts someone who replied, booked, opted out,
 * asked for a human, or is already on a call.
 */
@Injectable()
export class FollowUpProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly leads: LeadsService,
    private readonly voice: VoiceService,
    private readonly whatsapp: WhatsAppSenderService,
    @Optional() private readonly followUps?: FollowUpsService,
  ) {}

  private settingsFor(organizationId: string): Promise<TenantSettings> {
    return this.followUps ? this.followUps.settingsFor(organizationId) : Promise.resolve(DEFAULT_SETTINGS);
  }

  async process(followUpId: string) {
    const head = await this.prisma.followUp.findUnique({ where: { id: followUpId }, select: { customerId: true } });
    if (!head) return { skipped: 'not_found' };
    // Everything below runs while holding the customer lock, so a WhatsApp reply arriving
    // at the same moment is applied either fully before (we skip) or fully after (it cancels the rest).
    return withLock(queueRedis, customerLockKey(head.customerId), () => this.processLocked(followUpId), { ttlMs: 60_000, waitMs: 30_000 });
  }

  private async processLocked(followUpId: string) {
    const followUp = await this.prisma.followUp.findUnique({ where: { id: followUpId } });
    if (!followUp) return { skipped: 'not_found' };
    if (followUp.status !== 'scheduled' && followUp.status !== 'processing') {
      return { skipped: followUp.status };
    }

    const [customer, lead] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: followUp.customerId } }),
      this.prisma.lead.findUnique({ where: { id: followUp.leadId } }),
    ]);

    const automation = followUp.source === 'visit' || followUp.source === 'alert';
    const cancelReason = (() => {
      if (!customer || !lead) return 'customer_or_lead_missing';
      // Team alerts go to the business's own staff: a customer's opt-out does not silence them.
      if (followUp.source === 'alert') return null;
      if (customer.doNotContact) return 'do_not_contact';
      // Visit reminders keep running after the customer replies or a human takes over; they stop only when the
      // customer opts out or the lead is closed as lost / not interested (the visit itself is re-checked later).
      if (automation) return ['lost', 'not_interested'].includes(lead.status) ? `lead_${lead.status}` : null;
      if (CLOSED_LEAD.includes(lead.status)) return `lead_${lead.status}`;
      if (followUp.source === 'sequence' && lead.status === 'site_visit') return 'site_visit_booked';
      if (
        followUp.source !== 'callback' &&
        customer.lastInboundAt &&
        customer.lastInboundAt > followUp.createdAt
      ) {
        return 'customer_replied';
      }
      return null;
    })();

    if (cancelReason) {
      await this.prisma.followUp.update({
        where: { id: followUp.id },
        data: { status: 'cancelled', cancellationReason: cancelReason },
      });
      log.info('followup.skipped', { followUpId, reason: cancelReason });
      return { skipped: cancelReason };
    }

    // Atomic claim: a second job for the same follow-up (duplicate / rescheduled) does nothing.
    const claimed = await this.prisma.followUp.updateMany({
      where: { id: followUp.id, status: { in: ['scheduled', 'processing'] }, updatedAt: followUp.updatedAt },
      data: { status: 'processing', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return { skipped: 'already_claimed' };

    if (followUp.source === 'alert') return this.sendTeamAlert(followUp, customer!, lead!);
    if (followUp.source === 'visit') return this.runVisitStep(followUp, customer!);
    if (followUp.channel === 'whatsapp') {
      return this.sendWhatsApp(followUp, customer!, lead!);
    }
    if (followUp.channel === 'voice') {
      return this.placeCall(followUp, lead!);
    }
    await this.complete(followUp.id);
    return { skipped: 'unsupported_channel' };
  }

  private async sendWhatsApp(
    followUp: { id: string; organizationId: string; message: string | null; leadId: string; source?: string },
    customer: NonNullable<Awaited<ReturnType<PrismaService['customer']['findUnique']>>>,
    lead: { id: string },
  ) {
    const organization = await this.prisma.organization.findUnique({ where: { id: followUp.organizationId } });
    const orgName = organization?.name ?? config.defaultOrganizationName;
    const windowOpen = await this.conversations.isWhatsAppWindowOpen(followUp.organizationId, customer.id);

    try {
      const sent = await this.whatsapp.sendWithinPolicy({
        to: customer.phone!,
        windowOpen,
        text: sequenceMessage(followUp.message ?? 'reminder', customer, orgName, await this.introCallHint(followUp)),
        step: followUp.message ?? undefined,
        templateParams: [firstName(customer.name) || 'there', describeRequirement(customer)],
      });

      const conversation = await this.conversations.getOrCreateConversation({
        organizationId: followUp.organizationId,
        channel: 'whatsapp',
        externalId: customer.phone!,
        customerId: customer.id,
      });
      await this.conversations.addMessage({
        organizationId: followUp.organizationId,
        conversationId: conversation.id,
        role: 'assistant',
        content: sent.content,
        externalId: sent.messageId,
        metadata: { followUpId: followUp.id, kind: sent.kind },
      });
      await this.leads.advanceLeadStatus({ organizationId: followUp.organizationId, leadId: lead.id, status: 'contacted' });
      await this.complete(followUp.id);
      return { sent: sent.kind };
    } catch (error) {
      if (error instanceof WhatsAppWindowClosedError) {
        // Not retryable until a template is approved. The voice step still runs.
        await this.prisma.followUp.update({
          where: { id: followUp.id },
          data: { status: 'skipped', lastError: error.message },
        });
        log.warn('followup.whatsapp_no_template', { followUpId: followUp.id });
        return { skipped: 'no_template' };
      }
      await this.prisma.followUp.update({ where: { id: followUp.id }, data: { lastError: errorMessage(error) } });
      throw error; // BullMQ retries
    }
  }

  private async placeCall(
    followUp: { id: string; organizationId: string; customerId: string; leadId: string; source: string },
    lead: { id: string },
  ) {
    if (followUp.source === 'sequence') {
      const spoken = await this.prisma.call.count({ where: { leadId: lead.id, status: 'completed' } });
      if (spoken > 0) {
        await this.prisma.followUp.update({
          where: { id: followUp.id },
          data: { status: 'cancelled', cancellationReason: 'already_spoke_on_call' },
        });
        return { skipped: 'already_spoke_on_call' };
      }
    }

    // Automatic calls (not a callback the customer asked for) are limited in number and never back to back.
    if (followUp.source === 'sequence' || followUp.source === 'retry') {
      const attempts = await this.prisma.call.count({ where: { leadId: lead.id, direction: 'outbound' } });
      const settings = await this.settingsFor(followUp.organizationId);
      if (attempts >= settings.calling.maxAttempts) {
        await this.prisma.followUp.update({
          where: { id: followUp.id },
          data: { status: 'cancelled', cancellationReason: 'max_call_attempts' },
        });
        log.info('followup.skipped', { followUpId: followUp.id, reason: 'max_call_attempts', attempts });
        return { skipped: 'max_call_attempts' };
      }
      const last = await this.prisma.call.findFirst({ where: { customerId: followUp.customerId, direction: 'outbound' }, orderBy: { createdAt: 'desc' } });
      const gapMs = config.voice.minGapMinutes * 60_000 * config.followUp.timeScale;
      if (last && Date.now() - last.createdAt.getTime() < gapMs) {
        const at = new Date(last.createdAt.getTime() + gapMs + 1000);
        await this.reschedule(followUp.id, at, 'recent_contact');
        return { rescheduled: at.toISOString(), reason: 'recent_contact' };
      }
    }

    const result = await this.voice.startOutboundCall({
      organizationId: followUp.organizationId,
      customerId: followUp.customerId,
      leadId: lead.id,
      followUpId: followUp.id,
    });

    if (result.started) {
      await this.complete(followUp.id);
      return { callId: result.callId };
    }

    if (result.reason === 'outside_call_window' || result.reason === 'call_already_in_progress') {
      const at = result.retryAt ?? new Date(Date.now() + 15 * 60_000);
      await this.reschedule(followUp.id, at, result.reason);
      return { rescheduled: at.toISOString(), reason: result.reason };
    }

    await this.prisma.followUp.update({
      where: { id: followUp.id },
      data: { status: 'failed', lastError: result.reason },
    });
    log.error('followup.call_failed', { followUpId: followUp.id, reason: result.reason });
    return { failed: result.reason };
  }

  /** First WhatsApp of a speed-to-lead sequence says when the AI will call: now, or in the morning. */
  private async introCallHint(followUp: { organizationId: string; message: string | null; source?: string }) {
    if (followUp.message !== 'first_contact' || followUp.source !== 'sequence') return {};
    const settings = await this.settingsFor(followUp.organizationId);
    if (!settings.speedToLead.instantCall) return {};
    const w = effectiveCallWindow(settings);
    const hour = istHour(new Date());
    return hour >= w.start && hour < w.end ? { callingNow: true } : { callingMorning: true };
  }

  /** Day-before confirmation, reminder with location, and the after-visit message. Re-checks the visit first. */
  private async runVisitStep(
    followUp: { id: string; organizationId: string; leadId: string; customerId: string; message: string | null; attempts: number },
    customer: NonNullable<Awaited<ReturnType<PrismaService['customer']['findUnique']>>>,
  ) {
    const [, kind, visitId] = (followUp.message ?? '').split(':');
    const visit = visitId
      ? await this.prisma.siteVisit.findFirst({ where: { id: visitId, organizationId: followUp.organizationId }, include: { Property: true } })
      : null;
    const skip = async (reason: string) => {
      await this.prisma.followUp.update({ where: { id: followUp.id }, data: { status: 'skipped', lastError: reason, completedAt: new Date() } });
      log.info('followup.visit_step_skipped', { followUpId: followUp.id, kind, reason });
      return { skipped: reason };
    };
    if (!visit) return skip('visit_missing');
    const settings = await this.settingsFor(followUp.organizationId);
    const site = settings.visits.sites[visit.propertyId] ?? {};
    const ctx = { customerName: customer.name, propertyName: visit.Property.name, scheduledAt: visit.scheduledAt, ...site };

    let text: string;
    if (kind === 'confirm') {
      if (visit.status !== 'scheduled') return skip(`visit_${visit.status}`);
      text = visitMessage('confirm', ctx);
    } else if (kind === 'reminder') {
      if (!['scheduled', 'confirmed'].includes(visit.status)) return skip(`visit_${visit.status}`);
      text = visitMessage('reminder', ctx);
    } else if (kind === 'after') {
      if (visit.status === 'completed') text = visitMessage('thank_you', ctx);
      else if (visit.status === 'no_show') text = visitMessage('no_show', ctx);
      else if (visit.status === 'cancelled' || visit.status === 'requested') return skip(`visit_${visit.status}`);
      else if (followUp.attempts < 1) {
        // Nobody marked the visit yet: look again tomorrow before saying anything to the customer.
        await this.reschedule(followUp.id, new Date(Date.now() + 22 * 3600_000 * config.followUp.timeScale), 'visit_not_marked_yet');
        return { rescheduled: true, reason: 'visit_not_marked_yet' };
      } else {
        if (this.followUps) {
          await this.followUps.createHumanTask({
            organizationId: followUp.organizationId,
            leadId: followUp.leadId,
            customerId: followUp.customerId,
            reason: `Please mark whether ${customer.name ?? 'the customer'} visited ${visit.Property.name} (${visitTimeLabel(visit.scheduledAt)}), so the right follow-up message goes out.`,
          });
        }
        return skip('visit_not_marked');
      }
    } else {
      return skip('unknown_step');
    }

    const windowOpen = await this.conversations.isWhatsAppWindowOpen(followUp.organizationId, customer.id);
    try {
      const sent = await this.whatsapp.sendWithinPolicy({
        to: customer.phone!,
        windowOpen,
        text,
        step: `visit_${kind}`,
        templateParams: [firstName(customer.name) || 'there', `${visit.Property.name}, ${visitTimeLabel(visit.scheduledAt)}`],
      });
      const conversation = await this.conversations.getOrCreateConversation({
        organizationId: followUp.organizationId,
        channel: 'whatsapp',
        externalId: customer.phone!,
        customerId: customer.id,
      });
      await this.conversations.addMessage({
        organizationId: followUp.organizationId,
        conversationId: conversation.id,
        role: 'assistant',
        content: sent.content,
        externalId: sent.messageId,
        metadata: { followUpId: followUp.id, kind: sent.kind, visitStep: kind, siteVisitId: visit.id },
      });
      await this.complete(followUp.id);
      return { sent: sent.kind, step: kind };
    } catch (error) {
      if (error instanceof WhatsAppWindowClosedError) return skip('no_template');
      await this.prisma.followUp.update({ where: { id: followUp.id }, data: { lastError: errorMessage(error) } });
      throw error;
    }
  }

  /**
   * WhatsApp alert to the business's own sales team. If WhatsApp refuses (no approved template and no recent
   * message from that phone), the alert becomes a dashboard task, so it is never silently lost.
   */
  private async sendTeamAlert(
    followUp: { id: string; organizationId: string; leadId: string; customerId: string; message: string | null },
    customer: NonNullable<Awaited<ReturnType<PrismaService['customer']['findUnique']>>>,
    lead: { id: string; location: string | null; bhk: number | null; budget: unknown; campaign: string | null },
  ) {
    const [, kind, ref] = (followUp.message ?? '').split(':') as [string, 'booked' | 'visit_soon' | 'hot', string];
    const settings = await this.settingsFor(followUp.organizationId);
    const done = async (status: 'completed' | 'skipped', note?: string) => {
      await this.prisma.followUp.update({ where: { id: followUp.id }, data: { status, completedAt: new Date(), lastError: note ?? null } });
    };
    if (!settings.team.alertPhones.length) {
      await done('skipped', 'no_team_phones');
      return { skipped: 'no_team_phones' };
    }

    let visit: { scheduledAt: Date; status: string; Property: { name: string; location: string } } | null = null;
    if (kind !== 'hot') {
      visit = await this.prisma.siteVisit.findFirst({ where: { id: ref, organizationId: followUp.organizationId }, include: { Property: true } });
      if (!visit || !['requested', 'scheduled', 'confirmed'].includes(visit.status)) {
        await done('skipped', `visit_${visit?.status ?? 'missing'}`);
        return { skipped: `visit_${visit?.status ?? 'missing'}` };
      }
    }
    const bookedVia = kind === 'booked'
      ? (await this.prisma.call.findFirst({ where: { customerId: customer.id, outcome: 'site_visit_booked' }, orderBy: { createdAt: 'desc' }, select: { id: true } })) ? 'AI call' : 'WhatsApp'
      : undefined;
    const alert = teamAlert({
      kind,
      customerName: customer.name,
      phone: customer.phone,
      propertyName: visit?.Property.name,
      propertyArea: visit?.Property.location,
      scheduledAt: visit?.scheduledAt,
      location: lead.location ?? customer.location,
      bhk: lead.bhk ?? customer.bhk,
      budget: lead.budget ?? customer.budget,
      timeline: customer.purchaseTimeline,
      bookedVia,
      campaign: lead.campaign,
    });

    const failures: string[] = [];
    for (const phone of settings.team.alertPhones) {
      try {
        if (settings.team.alertTemplate) await this.whatsapp.sendNamedTemplate(phone, settings.team.alertTemplate, [alert.oneLine]);
        else await this.whatsapp.sendText(phone, alert.text);
      } catch (error) {
        failures.push(errorMessage(error).slice(0, 120));
      }
    }
    if (failures.length === settings.team.alertPhones.length && this.followUps) {
      await this.followUps.createHumanTask({
        organizationId: followUp.organizationId,
        leadId: followUp.leadId,
        customerId: followUp.customerId,
        reason: `${alert.text.split('\n')[0]} (WhatsApp alert to the team failed: ${failures[0]}). ${alert.oneLine}`,
      });
    }
    log.info('followup.team_alert', { followUpId: followUp.id, kind, sent: settings.team.alertPhones.length - failures.length, failed: failures.length });
    await done('completed', failures.length ? `failed for ${failures.length} phone(s)` : undefined);
    return { alerted: settings.team.alertPhones.length - failures.length, failed: failures.length };
  }

  private async reschedule(followUpId: string, at: Date, reason: string) {
    await this.prisma.followUp.update({
      where: { id: followUpId },
      data: { status: 'scheduled', scheduledAt: at, lastError: reason },
    });
    await followUpQueue.add(
      'follow-up',
      { followUpId },
      { delay: Math.max(0, at.getTime() - Date.now()), jobId: `follow-up-${followUpId}-${at.getTime()}` },
    );
    log.info('followup.rescheduled', { followUpId, at, reason });
  }

  private complete(id: string) {
    return this.prisma.followUp.update({ where: { id }, data: { status: 'completed', completedAt: new Date() } });
  }

  async markFailed(followUpId: string, error: string) {
    await this.prisma.followUp.updateMany({
      where: { id: followUpId, status: { in: ['scheduled', 'processing'] } },
      data: { status: 'failed', lastError: error },
    });
  }
}
