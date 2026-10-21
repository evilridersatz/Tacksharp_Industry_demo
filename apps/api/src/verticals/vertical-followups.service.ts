import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { WhatsAppSenderService, WhatsAppWindowClosedError } from '../whatsapp/whatsapp-sender.service.js';
import { config } from '../common/config.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { DEFAULT_SETTINGS } from '../settings/tenant-settings.js';
import { errorMessage, log } from '../common/logger.js';
import { addDays, inr, istDay, istInstant, n, prettyDay, prettyTime } from './common.js';
import { FOOD_STATUS_LABEL } from './food/food.service.js';
import { INSURANCE_STATUS_LABEL } from './hospital/hospital.service.js';

/** Follow-up sources owned by the vertical modules (FollowUp.source). Only an opt-out or a stale record stops them. */
export const VERTICAL_SOURCES = ['food', 'booking', 'appointment', 'insurance'] as const;
export type VerticalSource = (typeof VERTICAL_SOURCES)[number];

export type StepResult = { text: string; voice?: boolean } | { skip: string };

const first = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || 'there';

/**
 * Business-initiated messages for food orders, hotel reservations, hospital appointments and insurance cases.
 * Each step is stored as a FollowUp row (`<kind>:<action>:<id>`) and RE-CHECKS the record when it runs, so a cancelled
 * booking, a completed visit or a received document never gets a stale reminder. Same step twice -> one row.
 */
@Injectable()
export class VerticalFollowUps {
  constructor(
    private readonly prisma: PrismaService,
    private readonly followUps: FollowUpsService,
    private readonly leads: LeadsService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly conversations?: ConversationsService,
    @Optional() private readonly whatsapp?: WhatsAppSenderService,
  ) {}

  /**
   * Run one vertical step (called by the follow-up worker, and by the scenario runner for steps that are due).
   * DRY_RUN: the message is written to the conversation marked SIMULATED and the step is recorded as "simulated";
   * nothing reaches WhatsApp or a phone. Live: sent within WhatsApp policy (24 h window or this step's approved
   * template); outbound voice for these industries is not wired to the call provider yet and is skipped honestly.
   */
  async execute(followUpId: string): Promise<{ status: string; text?: string; reason?: string }> {
    const f = await this.prisma.followUp.findUnique({ where: { id: followUpId } });
    if (!f) return { status: 'not_found' };
    if (!['scheduled', 'processing'].includes(f.status)) return { status: f.status };
    const customer = await this.prisma.customer.findUnique({ where: { id: f.customerId } });
    const done = async (status: string, reason?: string) => {
      await this.prisma.followUp.update({ where: { id: f.id }, data: { status, lastError: reason ?? null, completedAt: new Date() } });
      return { status, reason };
    };
    if (!customer?.phone) return done('skipped', 'no_phone');
    if (customer.optedOutAt) return done('cancelled', 'opted_out');
    if (customer.doNotContact) return done('cancelled', 'do_not_contact');
    const step = await this.buildStep(f);
    if ('skip' in step) return done('skipped', step.skip);
    const dryRun = process.env.DRY_RUN !== 'false';
    if (f.channel === 'voice') {
      return dryRun ? { ...(await done('simulated', 'DRY_RUN: no call placed (simulated call script recorded)')), text: step.text } : done('skipped', 'outbound voice for this industry needs provider verification');
    }
    const conversation = this.conversations ? await this.conversations.getOrCreateConversation({ organizationId: f.organizationId, channel: 'whatsapp', externalId: customer.phone, customerId: customer.id }) : null;
    if (dryRun || !this.whatsapp) {
      if (conversation) await this.conversations!.addMessage({ organizationId: f.organizationId, conversationId: conversation.id, role: 'assistant', content: step.text, metadata: { followUpId: f.id, kind: 'simulated', simulated: true, note: 'DRY_RUN: not sent to WhatsApp' } });
      return { ...(await done('simulated', 'DRY_RUN: message not sent (simulated)')), text: step.text };
    }
    const windowOpen = this.conversations ? await this.conversations.isWhatsAppWindowOpen(f.organizationId, customer.id) : false;
    const kind = (f.message ?? '').split(':')[0];
    if (!windowOpen && !config.whatsapp.stepTemplates[`${kind}_step`]) return done('skipped', 'whatsapp_window_closed_no_template');
    try {
      const sent = await this.whatsapp.sendWithinPolicy({ to: customer.phone, windowOpen, text: step.text, templateParams: [first(customer.name), step.text.slice(0, 900)], step: `${kind}_step` });
      if (conversation) await this.conversations!.addMessage({ organizationId: f.organizationId, conversationId: conversation.id, role: 'assistant', content: sent.content, externalId: sent.messageId, metadata: { followUpId: f.id, kind: sent.kind } });
      await this.prisma.followUp.update({ where: { id: f.id }, data: { status: 'completed', completedAt: new Date() } });
      return { status: 'completed', text: step.text };
    } catch (error) {
      if (error instanceof WhatsAppWindowClosedError) return done('skipped', 'whatsapp_window_closed_no_template');
      await this.prisma.followUp.update({ where: { id: f.id }, data: { lastError: errorMessage(error).slice(0, 500) } });
      throw error;
    }
  }

  /** Schedule one step (deduplicated on organization + message while scheduled / done). */
  async schedule(org: string, customerId: string, source: VerticalSource, message: string, at: Date, channel: 'whatsapp' | 'voice' = 'whatsapp') {
    try {
      const exists = await this.prisma.followUp.findFirst({ where: { organizationId: org, customerId, source, message, status: { notIn: ['cancelled'] } } });
      if (exists) return { id: exists.id, duplicate: true };
      const lead = await this.leads.ensureActiveLead(org, customerId, source);
      const f = await this.followUps.create({ organizationId: org, leadId: lead.id, customerId, channel, action: channel === 'voice' ? 'call' : 'message', message, scheduledAt: at, source: source as never });
      return { id: f.id, duplicate: false };
    } catch (error) {
      log.warn('vertical_followup.schedule_failed', { org, source, message, error: errorMessage(error) });
      return null;
    }
  }

  async cancelFor(org: string, customerId: string, prefix: string, reason: string) {
    const rows = await this.prisma.followUp.findMany({ where: { organizationId: org, customerId, status: 'scheduled', message: { startsWith: prefix } }, select: { id: true } });
    if (rows.length) await this.prisma.followUp.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: 'cancelled', cancellationReason: reason } });
    return rows.length;
  }

  // ------------------------------------------------------------------ triggers

  async onFoodOrder(org: string, order: { id: string; customerId: string; channel: string; status: string }) {
    // A phone order gets its written confirmation on WhatsApp (the chat reply already is the confirmation for WhatsApp orders).
    if (order.channel === 'voice') await this.schedule(org, order.customerId, 'food', `food:ack:${order.id}`, new Date());
  }

  async onFoodStatus(org: string, order: { id: string; customerId: string; status: string }) {
    if (['confirmed', 'ready', 'dispatched', 'cancelled'].includes(order.status)) await this.schedule(org, order.customerId, 'food', `food:status:${order.id}:${order.status}`, new Date());
    if (order.status === 'completed') await this.schedule(org, order.customerId, 'food', `food:feedback:${order.id}`, new Date(Date.now() + 2 * 3600_000));
  }

  async onReservation(org: string, r: { id: string; customerId: string; status: string; checkIn: string; checkOut: string }) {
    const cfg = (await this.settings?.get(org))?.hotel ?? DEFAULT_SETTINGS.hotel;
    if (r.status === 'confirmed') {
      await this.schedule(org, r.customerId, 'booking', `booking:confirmed:${r.id}`, new Date());
      const pre = istInstant(addDays(r.checkIn, -1), '10:00');
      if (pre.getTime() > Date.now()) await this.schedule(org, r.customerId, 'booking', `booking:pre_arrival:${r.id}`, pre);
      const remind = istInstant(r.checkIn, '09:00');
      if (remind.getTime() > Date.now()) await this.schedule(org, r.customerId, 'booking', `booking:checkin_reminder:${r.id}`, remind);
      const checkout = istInstant(r.checkOut, `${String(Math.max(0, Number(cfg.checkOutTime.slice(0, 2)) - 2)).padStart(2, '0')}:00`);
      if (checkout.getTime() > Date.now()) await this.schedule(org, r.customerId, 'booking', `booking:checkout_reminder:${r.id}`, checkout);
    }
    if (r.status === 'checked_out') await this.schedule(org, r.customerId, 'booking', `booking:feedback:${r.id}`, new Date(Date.now() + 3 * 3600_000));
    if (r.status === 'cancelled' || r.status === 'no_show') await this.cancelFor(org, r.customerId, `booking:`, `reservation_${r.status}`);
    if (r.status === 'cancelled') await this.schedule(org, r.customerId, 'booking', `booking:cancelled:${r.id}`, new Date());
  }

  /** A guest asked for availability and got a quote but did not book: one gentle follow-up next day. */
  async onAbandonedEnquiry(org: string, customerId: string, key: string) {
    await this.schedule(org, customerId, 'booking', `booking:abandoned:${customerId}:${key}`, new Date(Date.now() + 24 * 3600_000));
  }

  async onAppointment(org: string, a: { id: string; customerId: string; status: string; startAt: Date }) {
    const cfg = (await this.settings?.get(org))?.hospital ?? DEFAULT_SETTINGS.hospital;
    if (a.status === 'booked' || a.status === 'confirmed') {
      const at = new Date(a.startAt.getTime() - cfg.reminderHoursBefore * 3600_000);
      if (cfg.reminderHoursBefore > 0 && at.getTime() > Date.now()) await this.schedule(org, a.customerId, 'appointment', `appointment:reminder:${a.id}:${a.startAt.getTime()}`, at);
    }
    if (a.status === 'no_show') await this.schedule(org, a.customerId, 'appointment', `appointment:no_show:${a.id}`, new Date());
    if (a.status === 'completed') await this.schedule(org, a.customerId, 'appointment', `appointment:feedback:${a.id}`, new Date(Date.now() + 3 * 3600_000));
    if (a.status === 'cancelled') await this.cancelFor(org, a.customerId, `appointment:reminder:${a.id}`, 'appointment_cancelled');
  }

  /** Missing insurance documents: a reminder now and again every 2 days, at most 3 in all (each re-checks). */
  async onInsuranceDocsPending(org: string, c: { id: string; customerId: string }) {
    for (let k = 0; k < 3; k++) await this.schedule(org, c.customerId, 'insurance', `insurance:docs:${c.id}:${k}`, new Date(Date.now() + k * 2 * 86_400_000));
  }

  async onInsuranceStatus(org: string, c: { id: string; customerId: string; status: string }) {
    if (['submitted', 'query_raised', 'approved', 'partially_approved', 'rejected', 'settled'].includes(c.status)) await this.schedule(org, c.customerId, 'insurance', `insurance:status:${c.id}:${c.status}`, new Date());
    if (c.status !== 'documents_pending') await this.cancelFor(org, c.customerId, `insurance:docs:${c.id}`, `insurance_${c.status}`);
  }

  // ------------------------------------------------------------------ step text (re-checks state)

  async buildStep(f: { organizationId: string; customerId: string; message: string | null; createdAt: Date }): Promise<StepResult> {
    const [kind, action, id, extra] = (f.message ?? '').split(':');
    const org = await this.prisma.organization.findUnique({ where: { id: f.organizationId }, select: { name: true } });
    const orgName = org?.name ?? 'us';
    const customer = await this.prisma.customer.findUnique({ where: { id: f.customerId } });
    if (!customer) return { skip: 'customer_missing' };
    const name = first(customer.name);

    if (kind === 'food') {
      const o = await this.prisma.order.findFirst({ where: { id, organizationId: f.organizationId } });
      if (!o) return { skip: 'order_missing' };
      if (action === 'ack') return { text: `Hi ${name}, your ${orgName} order ${o.orderNumber} is received: total ${inr(n(o.total))} (${o.fulfilment}). We will update you when it is ${o.fulfilment === 'delivery' ? 'out for delivery' : 'ready'}.` };
      if (action === 'status') {
        if (o.status !== extra) return { skip: `status_now_${o.status}` };
        const line: Record<string, string> = {
          confirmed: `your order ${o.orderNumber} is accepted and will be ready around ${prettyTime(o.pickupAt)}.`,
          ready: `your order ${o.orderNumber} is ready for pickup.`,
          dispatched: `your order ${o.orderNumber} is out for delivery.`,
          cancelled: `your order ${o.orderNumber} has been cancelled. Reply here if you need help.`,
        };
        return line[o.status] ? { text: `Hi ${name}, ${line[o.status]}` } : { skip: `no_message_for_${o.status}` };
      }
      if (action === 'feedback') {
        if (o.status !== 'completed') return { skip: `order_${o.status}` };
        if (o.feedbackRating !== null) return { skip: 'already_rated' };
        return { text: `Hi ${name}, thank you for ordering from ${orgName}! How was your order ${o.orderNumber}? Reply with a rating from 1 (poor) to 5 (excellent).` };
      }
    }

    if (kind === 'booking') {
      if (action === 'abandoned') {
        const booked = await this.prisma.reservation.count({ where: { organizationId: f.organizationId, customerId: f.customerId, createdAt: { gte: f.createdAt } } });
        if (booked) return { skip: 'booked_since' };
        if (customer.lastInboundAt && customer.lastInboundAt > f.createdAt) return { skip: 'customer_replied' };
        return { text: `Hi ${name}, still planning your stay at ${orgName}? Reply with your dates and we will check availability for you.` };
      }
      const r = await this.prisma.reservation.findFirst({ where: { id, organizationId: f.organizationId }, include: { roomType: true } });
      if (!r) return { skip: 'reservation_missing' };
      const cfg = (await this.settings?.get(f.organizationId))?.hotel ?? DEFAULT_SETTINGS.hotel;
      const ci = r.checkIn.toISOString().slice(0, 10), co = r.checkOut.toISOString().slice(0, 10);
      const stay = `${r.roomType.name}, ${prettyDay(ci)} – ${prettyDay(co)}`;
      if (action === 'cancelled') return r.status === 'cancelled' ? { text: `Hi ${name}, your reservation ${r.reference} (${stay}) is cancelled. ${r.cancellationReason ?? ''}`.trim() } : { skip: `status_${r.status}` };
      if (action === 'feedback') return r.status === 'checked_out' && r.feedbackRating === null ? { text: `Hi ${name}, thank you for staying with ${orgName}! How was your stay? Reply with a rating from 1 to 5.` } : { skip: `status_${r.status}` };
      if (r.status !== 'confirmed' && !(action === 'checkout_reminder' && r.status === 'checked_in')) return { skip: `status_${r.status}` };
      if (action === 'confirmed') return { text: `Hi ${name}, your reservation ${r.reference} is confirmed: ${stay}, total ${inr(n(r.total))}. Check-in from ${cfg.checkInTime}.` };
      if (action === 'pre_arrival') return { text: `Hi ${name}, we look forward to welcoming you tomorrow at ${orgName}. ${stay}. Check-in from ${cfg.checkInTime}; please carry a photo ID for every adult. Reply here with your arrival time or any request.` };
      if (action === 'checkin_reminder') return { text: `Hi ${name}, your room at ${orgName} is ready from ${cfg.checkInTime} today (reservation ${r.reference}). Safe travels!` };
      if (action === 'checkout_reminder') return r.status === 'checked_in' ? { text: `Hi ${name}, a reminder that check-out is at ${cfg.checkOutTime} today. Need a late check-out? Reply here and the front desk will check.` } : { skip: `status_${r.status}` };
    }

    if (kind === 'appointment') {
      const a = await this.prisma.appointment.findFirst({ where: { id, organizationId: f.organizationId }, include: { doctor: true } });
      if (!a) return { skip: 'appointment_missing' };
      if (action === 'reminder') {
        if (!['booked', 'confirmed'].includes(a.status)) return { skip: `status_${a.status}` };
        if (extra && String(a.startAt.getTime()) !== extra) return { skip: 'rescheduled' };
        return { text: `Hi ${name}, reminder: your appointment ${a.reference} with ${a.doctor.name} is on ${prettyDay(istDay(a.startAt))} at ${prettyTime(a.startAt)}. Please arrive 15 minutes early with any previous reports. Reply CANCEL or RESCHEDULE if you cannot make it.` };
      }
      if (action === 'no_show') return a.status === 'no_show' ? { text: `Hi ${name}, we missed you at your appointment with ${a.doctor.name}. Would you like to book another time? Reply here and we will share the next available slots.` } : { skip: `status_${a.status}` };
      if (action === 'feedback') return a.status === 'completed' && a.feedbackRating === null ? { text: `Hi ${name}, thank you for visiting ${orgName}. How was your experience today? Reply with a rating from 1 to 5.` } : { skip: `status_${a.status}` };
    }

    if (kind === 'insurance') {
      const c = await this.prisma.insuranceCase.findFirst({ where: { id, organizationId: f.organizationId } });
      if (!c) return { skip: 'case_missing' };
      if (action === 'docs') {
        if (c.status !== 'documents_pending') return { skip: `status_${c.status}` };
        const required = (c.requiredDocs as string[]) ?? [], received = (c.receivedDocs as string[]) ?? [];
        const missing = required.filter((d) => !received.includes(d));
        if (!missing.length) return { skip: 'nothing_missing' };
        return { text: `Hi ${name}, for your ${c.insurer} case ${c.reference} we still need: ${missing.join(', ')}. Please share them at the insurance desk or reply here with clear photos; our team will verify them.` };
      }
      if (action === 'status') {
        if (c.status !== extra) return { skip: `status_now_${c.status}` };
        return { text: `Hi ${name}, update on your insurance case ${c.reference} (${c.insurer}): ${INSURANCE_STATUS_LABEL[c.status] ?? c.status}, as recorded by our insurance desk. Reply here for details.` };
      }
    }
    return { skip: 'unknown_step' };
  }

  /** Statuses of a step for dashboards (label only). */
  static label(message: string | null) {
    const [kind, action] = (message ?? '').split(':');
    return `${kind} ${action ?? ''}`.trim().replace(/_/g, ' ');
  }
}

export { FOOD_STATUS_LABEL };
