import { Injectable, Optional } from '@nestjs/common';
import type { DowntimeIncident, SiteTechnician } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { WhatsAppPermanentError, WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
import { followUpConfig, liveGate } from '../restaurant/followup-config.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';
import { alertMessage, customerReport, escalationMessage, inQuietHours, onShift, quietHoursEnd, restoredMessage } from './rules.js';

type Inc = DowntimeIncident & { site: { id: string; name: string; customer: { id: string; name: string; contactName: string | null; contactPhone: string | null; notifyOnResolution: boolean } } };
export type Recipient = { technicianId?: string; type: 'technician' | 'supervisor' | 'manager' | 'customer'; name?: string | null; phone: string };

/** Max sends per incident per hour (protects technicians and cost from a flapping device). */
const MAX_PER_INCIDENT_HOUR = 12;

/**
 * Incident notifications: who is alerted, when (quiet hours, shifts, on-call), escalation when nobody acknowledges,
 * and the restoration / customer messages. Every message is a NotificationAttempt with an idempotency key, so a retry
 * or a repeated event never double-sends.
 *
 * Under DRY_RUN (default), for demo workspaces and for numbers that are not approved test recipients, the message is
 * recorded as SIMULATED and nothing is sent. Voice escalation is off unless enabled AND live; even then it is reported
 * as needing provider verification rather than pretending a call happened.
 */
@Injectable()
export class MonitoringNotifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Optional() private readonly whatsapp?: WhatsAppSenderService,
  ) {}

  private async timeline(org: string, incidentId: string, type: string, message: string, data?: unknown, at = new Date()) {
    await this.prisma.incidentTimelineEvent.create({ data: { organizationId: org, incidentId, type, message, actor: 'system', at, ...(data ? { data: data as never } : {}) } });
  }

  private reachable(t: SiteTechnician) {
    return t.active && t.whatsappConsent && !t.optedOutAt;
  }

  /** Technicians for the site (site-specific first, then organization-wide), on shift; on-call people outside shifts. */
  async recipientsFor(org: string, siteId: string, role: 'technician' | 'supervisor' | 'manager', at: Date, critical: boolean): Promise<Recipient[]> {
    const people = (await this.prisma.siteTechnician.findMany({ where: { organizationId: org, role, OR: [{ siteId }, { siteId: null }] }, orderBy: [{ siteId: 'desc' }, { name: 'asc' }] })).filter((t) => this.reachable(t));
    const siteSpecific = people.filter((p) => p.siteId === siteId);
    const pool = siteSpecific.length ? siteSpecific : people;
    let chosen = pool.filter((p) => onShift(p.shift as never, at));
    if (!chosen.length) chosen = pool.filter((p) => p.onCall);
    if (!chosen.length && critical) chosen = pool.slice(0, 1);
    return chosen.map((p) => ({ technicianId: p.id, type: role, name: p.name, phone: p.phone }));
  }

  async onOpened(inc: Inc, at = new Date()) {
    const s = (await this.settings.get(inc.organizationId)).monitoring;
    const critical = inc.severity === 'critical' || inc.severity === 'high';
    let to = await this.recipientsFor(inc.organizationId, inc.siteId, 'technician', at, critical);
    if (!to.length) to = await this.recipientsFor(inc.organizationId, inc.siteId, 'supervisor', at, true);
    if (!to.length) {
      await this.timeline(inc.organizationId, inc.id, 'notified', 'No technician is configured or on duty for this site: nobody was alerted. Add technicians on the Technicians page.', undefined, at);
      return [];
    }
    const quiet = inQuietHours(s.quietHours, at);
    const text = alertMessage(inc, inc.site.name, at);
    const out = [];
    for (const r of to) {
      // Quiet hours: a non-critical alert waits; critical alerts still go to whoever is on duty / on call.
      const defer = quiet && !critical;
      const a = await this.queue(inc, r, 'alert', text, `${inc.id}:alert:${r.technicianId ?? r.phone}:r${inc.reopenCount}`, defer ? quietHoursEnd(s.quietHours, at) : at, at);
      if (a) out.push(a);
    }
    await this.timeline(inc.organizationId, inc.id, 'notified', `${quiet && !critical ? 'Alert queued until quiet hours end' : 'Alert'} for ${to.map((r) => r.name ?? r.phone).join(', ')}. Escalates if not acknowledged in ${s.ackDeadlineMinutes} min.`, undefined, at);
    await this.dispatchDue(inc.organizationId, at);
    return out;
  }

  async onRestored(inc: Inc, checks: number, at = new Date()) {
    const s = (await this.settings.get(inc.organizationId)).monitoring;
    const alerted = await this.prisma.notificationAttempt.findMany({ where: { organizationId: inc.organizationId, incidentId: inc.id, purpose: { in: ['alert', 'escalation'] }, recipientType: { not: 'customer' } }, distinct: ['recipientPhone'] });
    const people: Recipient[] = alerted.map((a) => ({ technicianId: a.technicianId ?? undefined, type: a.recipientType as Recipient['type'], name: a.recipientName, phone: a.recipientPhone }));
    // Queued alerts that never went out (quiet hours) are cancelled: the fault is already gone.
    await this.prisma.notificationAttempt.updateMany({ where: { organizationId: inc.organizationId, incidentId: inc.id, status: { in: ['queued', 'deferred'] } }, data: { status: 'cancelled', lastError: 'Incident resolved before the message was due' } });
    const text = restoredMessage(inc, checks, at);
    for (const r of people) await this.queue(inc, r, 'restored', text, `${inc.id}:restored:${r.technicianId ?? r.phone}:r${inc.reopenCount}`, at, at);
    const c = inc.site.customer;
    if (s.notifyCustomerOnResolution && c.notifyOnResolution && c.contactPhone && inc.deviceType !== 'agent') {
      await this.queue(inc, { type: 'customer', name: c.contactName ?? c.name, phone: c.contactPhone }, 'customer_report', customerReport(inc, inc.site.name, at), `${inc.id}:customer_report:r${inc.reopenCount}`, at, at);
      await this.timeline(inc.organizationId, inc.id, 'customer_notified', `Resolution summary for ${c.name} (${c.contactName ?? 'contact'}).`, undefined, at);
    }
    await this.dispatchDue(inc.organizationId, at);
  }

  /** A reply to a technician who wrote to us (acknowledgment confirmations etc.). */
  async reply(inc: Inc, r: Recipient, text: string, key: string, at = new Date()) {
    await this.queue(inc, r, 'reply', text, key, at, at);
    await this.dispatchDue(inc.organizationId, at);
  }

  /**
   * Escalation: an incident nobody acknowledged by its deadline goes to the supervisor (L1), then the manager (L2).
   * Runs from the worker sweep (or "Run checks" on staging, where workers stay off).
   */
  async escalateDue(org: string | undefined, at = new Date(), onlyIncidentId?: string) {
    const due = await this.prisma.downtimeIncident.findMany({
      where: { ...(org ? { organizationId: org } : {}), ...(onlyIncidentId ? { id: onlyIncidentId } : {}), status: 'OPEN', acknowledgedAt: null, nextEscalationAt: { lte: at } },
      include: { site: { select: { id: true, name: true, customer: { select: { id: true, name: true, contactName: true, contactPhone: true, notifyOnResolution: true } } } } },
      take: 200,
    });
    let escalated = 0;
    for (const inc of due) {
      const s = (await this.settings.get(inc.organizationId)).monitoring;
      const level = inc.escalationLevel + 1;
      const role = level === 1 ? 'supervisor' : 'manager';
      const to = await this.recipientsFor(inc.organizationId, inc.siteId, role, at, true);
      const next = level < 2 ? new Date(at.getTime() + s.escalationStepMinutes * 60_000) : null;
      await this.prisma.downtimeIncident.update({ where: { id: inc.id }, data: { escalationLevel: level, nextEscalationAt: next } });
      if (!to.length) {
        await this.timeline(inc.organizationId, inc.id, 'escalated', `Escalation L${level}: no ${role} configured for this site.`, { level }, at);
        continue;
      }
      const text = escalationMessage(inc, inc.site.name, level, at);
      for (const r of to) await this.queue(inc as Inc, r, 'escalation', text, `${inc.id}:escalation:L${level}:${r.technicianId ?? r.phone}:r${inc.reopenCount}`, at, at);
      if (s.voiceEscalation && level >= 2) {
        for (const r of to) await this.queue(inc as Inc, r, 'escalation', `Voice escalation: ${text}`, `${inc.id}:voice:L${level}:${r.technicianId ?? r.phone}:r${inc.reopenCount}`, at, at, 'voice');
      }
      await this.timeline(inc.organizationId, inc.id, 'escalated', `Not acknowledged in time: escalated to ${role} (${to.map((r) => r.name).join(', ')}), level ${level}.`, { level }, at);
      escalated++;
    }
    if (due.length) await this.dispatchDue(org, at);
    return { escalated };
  }

  private async queue(inc: Pick<Inc, 'id' | 'organizationId' | 'isDemo'>, r: Recipient, purpose: string, body: string, key: string, scheduledFor: Date, at: Date, channel: 'whatsapp' | 'voice' = 'whatsapp') {
    const phone = normalizePhone(r.phone) ?? r.phone;
    try {
      return await this.prisma.notificationAttempt.create({
        data: {
          organizationId: inc.organizationId, incidentId: inc.id, technicianId: r.technicianId ?? null, recipientType: r.type, recipientName: r.name ?? null, recipientPhone: phone, channel, purpose,
          body: body.slice(0, 3900), idempotencyKey: key.slice(0, 190), status: scheduledFor > at ? 'deferred' : 'queued', scheduledFor, isDemo: Boolean(inc.isDemo),
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return null; // the same message was already queued / sent
      throw error;
    }
  }

  /** Deliver what is due. Dry-run / demo / unapproved numbers: recorded as SIMULATED. Transient failures retry with backoff. */
  async dispatchDue(org: string | undefined, at = new Date()) {
    const due = await this.prisma.notificationAttempt.findMany({ where: { ...(org ? { organizationId: org } : {}), status: { in: ['queued', 'deferred'] }, scheduledFor: { lte: at } }, orderBy: { scheduledFor: 'asc' }, take: 100 });
    const results = [];
    for (const a of due) results.push(await this.deliver(a.id, at));
    return results;
  }

  async deliver(id: string, at = new Date()) {
    const a = await this.prisma.notificationAttempt.findUnique({ where: { id } });
    if (!a || !['queued', 'deferred'].includes(a.status)) return a;
    const s = (await this.settings.get(a.organizationId)).monitoring;
    const cost = a.channel === 'whatsapp' ? s.whatsappCostInr : 0;
    const set = (data: Record<string, unknown>) => this.prisma.notificationAttempt.update({ where: { id }, data: { attempts: { increment: 1 }, ...data } });

    // Rate limit per incident (a flapping device must not flood a technician).
    const lastHour = await this.prisma.notificationAttempt.count({ where: { organizationId: a.organizationId, incidentId: a.incidentId, status: { in: ['sent', 'simulated', 'delivered', 'read'] }, sentAt: { gte: new Date(at.getTime() - 3_600_000) } } });
    if (lastHour >= MAX_PER_INCIDENT_HOUR) return set({ status: 'skipped', lastError: `Rate limit: ${MAX_PER_INCIDENT_HOUR} messages per incident per hour` });

    const tech = a.technicianId ? await this.prisma.siteTechnician.findUnique({ where: { id: a.technicianId } }) : null;
    if (tech && (tech.optedOutAt || !tech.whatsappConsent)) return set({ status: 'skipped', lastError: 'Recipient opted out / no WhatsApp consent' });

    const gate = liveGate(followUpConfig(), { phone: a.recipientPhone, isDemo: a.isDemo });
    if (!gate.live) return set({ status: 'simulated', simulated: true, sentAt: at, costEstimate: cost, lastError: `SIMULATED: ${gate.reason}` });
    if (a.channel === 'voice') return set({ status: 'skipped', lastError: 'Voice escalation needs provider verification before it can place real calls' });
    if (!this.whatsapp) return set({ status: 'failed', lastError: 'WhatsApp sender not available' });
    try {
      const messageId = s.alertTemplate && a.purpose !== 'reply'
        ? await this.whatsapp.sendNamedTemplate(a.recipientPhone, s.alertTemplate, [a.body.slice(0, 1000)])
        : await this.whatsapp.sendText(a.recipientPhone, a.body);
      return set({ status: 'sent', sentAt: at, providerMessageId: messageId ?? null, costEstimate: cost, lastError: null });
    } catch (error) {
      const permanent = error instanceof WhatsAppPermanentError || a.attempts + 1 >= 3;
      log.warn('visionops.notify_send_failed', { id, error: errorMessage(error), permanent });
      return set(permanent
        ? { status: 'failed', lastError: errorMessage(error).slice(0, 500) }
        : { status: 'queued', scheduledFor: new Date(at.getTime() + 2 ** (a.attempts + 1) * 60_000), lastError: errorMessage(error).slice(0, 500) });
    }
  }

  /** WhatsApp delivery receipts for alert messages (status webhook → providerMessageId). */
  async markDelivery(providerMessageId: string, status: 'delivered' | 'read' | 'failed', at = new Date()) {
    const a = await this.prisma.notificationAttempt.findFirst({ where: { providerMessageId } });
    if (!a) return false;
    await this.prisma.notificationAttempt.update({ where: { id: a.id }, data: { status, ...(status !== 'failed' ? { deliveredAt: a.deliveredAt ?? at } : {}) } });
    return true;
  }
}
