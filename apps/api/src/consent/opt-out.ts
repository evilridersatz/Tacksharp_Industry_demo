import type { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import { isStart, isStop } from '../restaurant/feedback-parse.js';

export type OptKeyword = 'stop' | 'start';

/** STOP / START as the whole message (English, Tanglish, Tamil). Anything else is a normal message. */
export function optKeyword(text: string | undefined | null): OptKeyword | null {
  if (!text) return null;
  if (isStop(text)) return 'stop';
  if (isStart(text)) return 'start';
  return null;
}

/**
 * Apply STOP / START for real-estate and textile businesses. GR Chicken (vertical "restaurant") has its own STOP flow
 * in the ordering engine and is never touched here.
 *
 * STOP: opted out of every business-initiated message and call (marketing, follow-ups, visit reminders, AI calls,
 * payment reminders, order updates). Every scheduled follow-up for the customer is cancelled now, queued campaign
 * messages are skipped, and queued payment reminders are cancelled. The follow-up worker and the call starter also
 * re-check the opt-out, so anything created later is refused too.
 * START: the customer's own explicit opt-in; lifts the opt-out (and records messaging consent). START from a customer
 * who is NOT opted out is an ordinary message (returns null): no consent is recorded and the assistant answers it.
 *
 * `only: 'stop'` (the webhook fast path) applies STOP only, so the worker still sees an opted-out customer's START.
 * Idempotent: a repeated STOP keeps the first opt-out time.
 */
export async function applyOptKeyword(prisma: PrismaService, organizationId: string, phone: string, text: string | undefined | null, opts: { only?: OptKeyword } = {}): Promise<OptKeyword | null> {
  const kind = optKeyword(text);
  if (!kind || (opts.only && kind !== opts.only)) return null;
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { vertical: true } });
  if (!org || org.vertical === 'restaurant') return null;
  const cu = await prisma.customer.findFirst({ where: { organizationId, phone }, select: { id: true, optedOutAt: true } });
  if (!cu) return null;
  if (kind === 'stop') {
    await prisma.customer.update({ where: { id: cu.id }, data: { optedOutAt: cu.optedOutAt ?? new Date(), messagingConsent: false, callingConsent: false } });
    // Team alerts go to the business's own staff, not to this customer: they are kept.
    const followUps = await prisma.followUp.updateMany({
      where: { organizationId, customerId: cu.id, status: { in: ['scheduled', 'processing'] }, source: { not: 'alert' } },
      data: { status: 'cancelled', cancellationReason: 'customer_opted_out' },
    });
    const campaign = await prisma.campaignRecipient.updateMany({ where: { organizationId, customerId: cu.id, status: 'queued' }, data: { status: 'skipped', reason: 'customer replied STOP' } });
    // Payment reminders waiting for approval or queued: cancelled, and their open approval requests withdrawn so nobody
    // can approve a message to a customer who opted out.
    const waiting = await prisma.collectionNote.findMany({ where: { organizationId, customerId: cu.id, type: 'reminder', status: { in: ['pending_approval', 'queued'] } }, select: { approvalId: true } });
    const approvalIds = waiting.map((w) => w.approvalId).filter((x): x is string => !!x);
    if (approvalIds.length) await prisma.approval.updateMany({ where: { organizationId, id: { in: approvalIds }, status: 'pending' }, data: { status: 'cancelled', openKey: null, decidedBy: 'system:opt_out', decidedAt: new Date(), decisionNote: 'Customer replied STOP' } });
    const reminders = await prisma.collectionNote.updateMany({ where: { organizationId, customerId: cu.id, type: 'reminder', status: { in: ['pending_approval', 'queued'] } }, data: { status: 'cancelled' } });
    log.info('consent.opt_out', { organizationId, customerId: cu.id, followUpsCancelled: followUps.count, campaignSkipped: campaign.count, remindersCancelled: reminders.count });
    return 'stop';
  }
  if (!cu.optedOutAt) return null; // not opted out: an ordinary message, nothing to lift
  await prisma.customer.update({ where: { id: cu.id }, data: { optedOutAt: null, messagingConsent: true } });
  log.info('consent.opt_in', { organizationId, customerId: cu.id });
  return 'start';
}

/** The reply to STOP / START (sent inside the 24 h window: the customer just wrote). Never a sales message. */
export function optReply(kind: OptKeyword, orgName: string, language: string | null | undefined): string {
  const ta = language === 'tamil';
  if (kind === 'stop') {
    return ta
      ? `சரிங்க. ${orgName} இனிமேல் உங்களுக்கு message அல்லது call பண்ணாது. மறுபடி வேணும்னா START னு reply பண்ணுங்க.`
      : `Done. You will not receive any more messages or calls from ${orgName}. Reply START if you want to hear from us again.`;
  }
  return ta ? `நன்றி! ${orgName} updates மறுபடி வரும். எப்போ வேணும்னாலும் STOP னு reply பண்ணலாம்.` : `Thank you! You will receive updates from ${orgName} again. Reply STOP at any time to opt out.`;
}
