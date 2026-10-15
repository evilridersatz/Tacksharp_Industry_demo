import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import { assessFeedback, isComplaint, isStart, isStop, readRating } from './feedback-parse.js';

type Style = 'tl' | 'ta' | 'en';
const styleOf = (lang?: string | null): Style => (lang === 'english' ? 'en' : lang === 'tamil' ? 'ta' : 'tl');
const AWAITING = ['sent', 'delivered', 'read'];
const PENDING = ['scheduled', 'retrying'];
const REPLY_WINDOW_MS = 72 * 3600_000;

const T = {
  stopped: {
    en: 'You will not receive any more messages or calls from GR Chicken. Reply START to subscribe again.',
    tl: 'Sari, GR Chicken-la irundhu inimel message / call varaadhu. Thirumba venum-na START nu anuppunga.',
    ta: 'சரி, GR Chicken-ல இருந்து இனிமேல் message / call வராது. திரும்ப வேணும்னா START-னு அனுப்புங்க.',
  },
  started: {
    en: 'Welcome back! You will receive order updates from GR Chicken again. Reply STOP to opt out.',
    tl: 'Vanakkam! Inimel order updates varum. Vendam-na STOP nu anuppunga.',
    ta: 'வணக்கம்! இனிமேல் order updates வரும். வேண்டாம்னா STOP-னு அனுப்புங்க.',
  },
  thanksGood: (n: number) => ({
    en: `Thank you for rating us ${n}/5! 🙏 See you again at GR Chicken.`,
    tl: `${n}/5 kuduthadhukku romba nandri! 🙏 Thirumba vaanga.`,
    ta: `${n}/5 கொடுத்ததுக்கு ரொம்ப நன்றி! 🙏 திரும்ப வாங்க.`,
  }),
  sorry: {
    en: "We're sorry your order was not right. 🙏 Our shop manager will call you. If you like, tell us what went wrong.",
    tl: 'Order sariyaa illadhadhukku sorry 🙏 Engal shop manager ungalukku call pannuvaanga. Enna problem nu sonna help-ah irukkum.',
    ta: 'Order சரியா இல்லாததுக்கு sorry 🙏 எங்க shop manager உங்களுக்கு call பண்ணுவாங்க. என்ன problem-னு சொன்னா help-ஆ இருக்கும்.',
  },
  noted: {
    en: 'Thank you, we have noted it. Our manager will contact you. 🙏',
    tl: 'Nandri, note pannittom. Manager ungalai contact pannuvaanga 🙏',
    ta: 'நன்றி, note பண்ணிட்டோம். Manager உங்களை contact பண்ணுவாங்க 🙏',
  },
};

export type FeedbackApplied = { orderId: string; rating?: number; complaint: boolean };

/**
 * Customer feedback and messaging consent for GR Chicken follow-ups.
 * - STOP / START from any message (opt-out blocks every business-initiated message and call).
 * - A 1-5 reply to a feedback request is recorded on the order; 1-2 or complaint words escalate to staff.
 * - The first free-text message after a low rating is saved as the complaint detail.
 */
@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns the reply when the message was feedback / STOP / START; undefined lets the ordering chat handle it. */
  async handleInbound(organizationId: string, customerId: string, text: string, opts: { simulated?: boolean; conversationId?: string; channel?: 'whatsapp' | 'voice' } = {}): Promise<{ reply: string; kind: 'stop' | 'start' | 'rating' | 'complaint_detail' } | undefined> {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, organizationId } });
    if (!customer) return undefined;
    const lastOrder = await this.prisma.order.findFirst({ where: { organizationId, customerId }, orderBy: { createdAt: 'desc' }, select: { language: true } });
    const st = styleOf(customer.language ?? lastOrder?.language);

    if (isStop(text)) {
      await this.optOut(organizationId, customerId, opts.simulated);
      return { reply: T.stopped[st], kind: 'stop' };
    }
    if (isStart(text)) {
      await this.prisma.customer.update({ where: { id: customerId }, data: { optedOutAt: null, messagingConsent: true } });
      log.info('followup.opt_in', { organizationId, customerId });
      return { reply: T.started[st], kind: 'start' };
    }

    // A reply to the feedback request we sent (within 72h, order not yet rated).
    const pending = await this.prisma.orderFollowUp.findFirst({
      where: { organizationId, customerId, kind: 'feedback_request', status: { in: AWAITING }, updatedAt: { gt: new Date(Date.now() - REPLY_WINDOW_MS) } },
      orderBy: { updatedAt: 'desc' },
      include: { order: { select: { id: true, feedbackRating: true } } },
    });
    const rating = readRating(text);
    if (pending && !pending.order.feedbackRating && rating !== undefined) {
      const applied = await this.apply(organizationId, pending.order.id, { rating, comment: undefined, channel: opts.channel ?? 'whatsapp', text, followUpId: pending.id, simulated: opts.simulated, conversationId: opts.conversationId });
      return { reply: applied.complaint ? T.sorry[st] : T.thanksGood(rating)[st], kind: 'rating' };
    }

    // Free text right after a low rating: the complaint detail.
    const awaitingDetail = await this.prisma.order.findFirst({
      where: { organizationId, customerId, complaintStatus: 'open', complaintNote: null, feedbackAt: { gt: new Date(Date.now() - 24 * 3600_000) } },
      orderBy: { feedbackAt: 'desc' },
    });
    if (awaitingDetail && text.trim().length >= 3 && rating === undefined) {
      await this.prisma.order.update({ where: { id: awaitingDetail.id }, data: { complaintNote: text.trim().slice(0, 1000), feedbackComment: awaitingDetail.feedbackComment ?? text.trim().slice(0, 1000) } });
      await this.prisma.orderEvent.create({ data: { organizationId, orderId: awaitingDetail.id, type: 'complaint', actor: 'ai', note: `Customer explained: "${text.trim().slice(0, 300)}"${opts.simulated ? ' (simulated)' : ''}` } });
      return { reply: T.noted[st], kind: 'complaint_detail' };
    }
    return undefined;
  }

  /**
   * Record feedback on the order (from WhatsApp or a call). Escalates complaints: order complaint open, the
   * customer's chat flagged for staff, an audit event, and any still-pending feedback call cancelled.
   */
  async apply(
    organizationId: string,
    orderId: string,
    input: { rating?: number; comment?: string; channel: 'whatsapp' | 'voice'; text: string; followUpId?: string; simulated?: boolean; conversationId?: string },
  ): Promise<FeedbackApplied> {
    const { rating, complaint: complaintWords } = assessFeedback(input.text, input.channel === 'voice');
    const finalRating = input.rating ?? rating;
    const complaint = complaintWords || isComplaint(input.comment ?? '') || (finalRating !== undefined && finalRating <= 2);
    const order = await this.prisma.order.findFirstOrThrow({ where: { id: orderId, organizationId } });
    const tag = input.simulated ? ' (simulated)' : '';
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        ...(finalRating !== undefined ? { feedbackRating: finalRating } : {}),
        feedbackComment: input.comment ?? (input.channel === 'voice' ? input.text.slice(0, 1000) : order.feedbackComment),
        feedbackAt: new Date(),
        feedbackChannel: input.channel,
        lastContactAt: new Date(),
        followUpStatus: 'done',
        nextFollowUpAt: null,
        ...(complaint && order.complaintStatus !== 'open' ? { complaintStatus: 'open', complaintNote: input.channel === 'voice' ? input.text.slice(0, 1000) : order.complaintNote } : {}),
      },
    });
    await this.prisma.orderEvent.create({
      data: {
        organizationId,
        orderId: order.id,
        type: complaint ? 'complaint' : 'feedback',
        actor: 'ai',
        note: `${complaint ? 'Complaint escalated to staff' : 'Feedback received'} via ${input.channel}${finalRating !== undefined ? `: ${finalRating}/5` : ''}${input.channel === 'voice' ? ` — "${input.text.slice(0, 300)}"` : ''}${tag}`,
      },
    });
    if (input.followUpId) {
      await this.prisma.orderFollowUp.update({ where: { id: input.followUpId }, data: { status: 'completed', completedAt: new Date(), result: { rating: finalRating ?? null, complaint, reply: input.text.slice(0, 500), simulated: Boolean(input.simulated) } } });
    }
    // One answer is enough: do not also call / message about this order.
    await this.prisma.orderFollowUp.updateMany({
      where: { organizationId, orderId: order.id, status: { in: PENDING }, kind: { in: ['feedback_call', 'feedback_request'] }, ...(input.followUpId ? { id: { not: input.followUpId } } : {}) },
      data: { status: 'skipped', lastError: `Feedback already received via ${input.channel}`, completedAt: new Date() },
    });
    if (complaint) {
      const conv = input.conversationId ?? order.conversationId;
      const where = conv ? { id: conv, organizationId } : { organizationId, customerId: order.customerId, channel: 'whatsapp' };
      await this.prisma.conversation.updateMany({ where, data: { status: 'human_handoff', updatedAt: new Date() } });
      log.warn('followup.complaint_escalated', { organizationId, orderId: order.id, rating: finalRating, channel: input.channel, simulated: Boolean(input.simulated) });
    }
    return { orderId: order.id, rating: finalRating, complaint };
  }

  /** STOP: no more business-initiated messages or calls; pending follow-ups are cancelled, not sent later. */
  async optOut(organizationId: string, customerId: string, simulated?: boolean) {
    await this.prisma.customer.update({ where: { id: customerId }, data: { optedOutAt: new Date(), messagingConsent: false, callingConsent: false } });
    const cancelled = await this.prisma.orderFollowUp.updateMany({
      where: { organizationId, customerId, status: { in: PENDING } },
      data: { status: 'cancelled', lastError: `Customer replied STOP${simulated ? ' (simulated)' : ''}`, completedAt: new Date() },
    });
    await this.prisma.order.updateMany({ where: { organizationId, customerId, followUpStatus: { in: ['scheduled', 'in_progress'] } }, data: { followUpStatus: 'skipped', nextFollowUpAt: null } });
    log.info('followup.opt_out', { organizationId, customerId, cancelled: cancelled.count });
  }
}
