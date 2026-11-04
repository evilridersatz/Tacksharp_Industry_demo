import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { bindOrganization } from '../integrations/provider-scope.js';
import { Prisma } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { SarvamService } from '../sarvam/sarvam.service.js';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
import { orderFollowUpQueue } from '../queues/queues.js';
import { config } from '../common/config.js';
import { istHour, nextAllowedCallTime } from '../common/time.js';
import { errorMessage, log } from '../common/logger.js';
import { dependencyOf, describeError } from '../common/errors.js';
import { TelephonyService } from '../telephony/telephony.service.js';
import { firstName } from '../whatsapp/message-templates.js';
import { normalizePhone } from '../common/phone.js';
import { feedbackCallOpening } from './call-openings.js';
import { onOutboundResult, type OutboundResult } from '../telephony/outbound-events.js';
import { describeWhen } from '../conversation/when.js';
import { FeedbackService } from './feedback.service.js';
import { ReadyNoticeService } from './ready-notice.service.js';
import { followUpConfig, liveGate, type FollowUpConfig } from './followup-config.js';
import {
  SarvamVoiceTransport,
  LiveWhatsAppTransport,
  MockVoiceTransport,
  MockWhatsAppTransport,
  templatePayload,
  textPayload,
  type VoiceTransport,
  type WhatsAppPayload,
  type WhatsAppTransport,
} from './followup-transport.js';

export type FollowUpKind = 'order_confirmation' | 'status_update' | 'feedback_request' | 'feedback_call';
export type DemoScenario = 'whatsapp_5' | 'whatsapp_complaint' | 'call_happy' | 'call_complaint' | 'no_answer' | 'stop';
export const DEMO_SCENARIOS: DemoScenario[] = ['whatsapp_5', 'whatsapp_complaint', 'call_happy', 'call_complaint', 'no_answer', 'stop'];

type QueueLike = { add(name: string, data: { followUpId: string }, opts: { jobId: string; delay: number }): Promise<unknown> };
type Row = Prisma.OrderFollowUpGetPayload<object>;
type OrderFull = Prisma.OrderGetPayload<{ include: { customer: true; items: true; outlet: true } }>;
type Outcome = { status: string; result?: Record<string, unknown>; error?: string; retryAt?: Date; reschedule?: Date };

const OPEN = ['scheduled', 'retrying'];
const rs = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;
const qty = (q: number, unit: string) => (unit === 'piece' ? `${q} pcs` : q < 1 ? `${Math.round(q * 1000)} g` : `${+q.toFixed(2)} kg`);

/** What the simulated customer says on a dry-run call / WhatsApp, per demo scenario. */
const SIMULATED: Record<DemoScenario, { whatsapp?: string[]; call?: string | null }> = {
  whatsapp_5: { whatsapp: ['5'] },
  whatsapp_complaint: { whatsapp: ['2', 'Chicken fresh-ah illa, konjam smell vandhuchu'] },
  call_happy: { call: 'ஆமா, ரொம்ப நல்லா இருந்துச்சு. அஞ்சு குடுக்கிறேன்.' },
  call_complaint: { call: 'Chicken fresh-ah illa, smell vandhuchu. Rendu dhaan.' },
  no_answer: { call: null },
  stop: { whatsapp: ['STOP'] },
};

/**
 * GR Chicken order follow-ups on the existing queue / WhatsApp / voice infrastructure.
 *
 * Every follow-up is one OrderFollowUp row (unique per order + purpose, so it is never created twice) and is
 * processed by the restaurant follow-up queue. The row status is the source of truth: a duplicate job, a retry
 * after success or a re-run does nothing. DRY_RUN (default) runs the whole workflow with mock adapters and
 * records the exact request and a simulated result; live mode only reaches approved test numbers.
 */
@Injectable()
export class OrderFollowUpService implements OnModuleInit, OnModuleDestroy {
  /** Replaced in tests. */
  queue: QueueLike = orderFollowUpQueue;
  readonly mockWhatsApp = new MockWhatsAppTransport();
  readonly mockVoice = new MockVoiceTransport();
  liveWhatsApp: WhatsAppTransport;
  liveVoice: VoiceTransport;
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly sender: WhatsAppSenderService,
    private readonly ready: ReadyNoticeService,
    private readonly sarvam: SarvamService,
    private readonly feedback: FeedbackService,
    @Optional() private readonly telephony?: TelephonyService,
  ) {
    this.liveWhatsApp = new LiveWhatsAppTransport(this.sender);
    this.liveVoice = new SarvamVoiceTransport(this.telephony);
  }

  onModuleInit() {
    // A real feedback call's outcome (Sarvam post-call webhook): the rating / complaint goes on the order.
    onOutboundResult((r) => this.onFeedbackCallResult(r));
    // Safety net: anything due whose job was lost (Redis restart, seed data) is queued again. Re-queueing is
    // harmless because processing checks the row status first.
    if (!config.runWorkers) return;
    this.sweeper = setInterval(() => void this.sweep().catch((e) => log.warn('followup.sweep_failed', { error: errorMessage(e) })), 60_000);
    this.sweeper.unref();
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  // -----------------------------------------------------------------------------------------------
  // Scheduling
  // -----------------------------------------------------------------------------------------------

  /** Create (once) and queue a follow-up. The same dedupeKey returns the existing row. */
  async schedule(input: { organizationId: string; orderId: string; kind: FollowUpKind; at: Date; dedupeKey: string; payload?: Record<string, unknown>; forceDryRun?: boolean }) {
    const cfg = followUpConfig();
    const order = await this.prisma.order.findFirst({ where: { id: input.orderId, organizationId: input.organizationId }, select: { id: true, customerId: true } });
    if (!order) throw new Error('Order not found');
    const channel = input.kind === 'feedback_call' ? 'voice' : 'whatsapp';
    let row: Row;
    try {
      row = await this.prisma.orderFollowUp.create({
        data: {
          organizationId: input.organizationId,
          orderId: order.id,
          customerId: order.customerId,
          kind: input.kind,
          channel,
          status: 'scheduled',
          scheduledAt: input.at,
          maxAttempts: input.kind === 'feedback_call' ? cfg.callMaxAttempts : cfg.sendMaxAttempts,
          dedupeKey: input.dedupeKey,
          dryRun: cfg.dryRun || Boolean(input.forceDryRun),
          payload: (input.payload ?? undefined) as never,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.orderFollowUp.findUniqueOrThrow({ where: { organizationId_dedupeKey: { organizationId: input.organizationId, dedupeKey: input.dedupeKey } } });
        return { row: existing, created: false };
      }
      throw error;
    }
    await this.prisma.order.update({ where: { id: order.id }, data: { followUpStatus: 'scheduled', nextFollowUpAt: await this.nextDue(order.id) } });
    await this.enqueue(row);
    return { row, created: true };
  }

  async enqueue(row: Pick<Row, 'id' | 'attempts' | 'scheduledAt'>) {
    try {
      await this.queue.add('order-follow-up', { followUpId: row.id }, { jobId: `ofu-${row.id}-${row.attempts}`, delay: Math.max(0, row.scheduledAt.getTime() - Date.now()) });
    } catch (error) {
      // Redis down: the row stays scheduled and the sweeper queues it later.
      log.warn('followup.enqueue_failed', { followUpId: row.id, error: errorMessage(error) });
    }
  }

  /** Re-queue due follow-ups (lost jobs, restarts). */
  async sweep(now = new Date()) {
    const due = await this.prisma.orderFollowUp.findMany({ where: { status: { in: OPEN }, scheduledAt: { lte: new Date(now.getTime() + 30_000) } }, take: 200, orderBy: { scheduledAt: 'asc' } });
    for (const row of due) await this.enqueue(row);
    return due.length;
  }

  /** New order (not from the WhatsApp chat, which already confirmed it in the conversation). */
  async onOrderCreated(organizationId: string, orderId: string, channel: string) {
    if (channel === 'whatsapp' || channel === 'test') return;
    await this.schedule({ organizationId, orderId, kind: 'order_confirmation', at: new Date(), dedupeKey: `order_confirmation:${orderId}` });
  }

  /** Staff changed an order's status. */
  async onStatusChanged(organizationId: string, orderId: string, to: string) {
    const cfg = followUpConfig();
    if (to === 'confirmed') {
      await this.schedule({ organizationId, orderId, kind: 'status_update', at: new Date(), dedupeKey: `status_update:${orderId}:confirmed`, payload: { status: 'confirmed' } });
    } else if (to === 'completed') {
      const now = Date.now();
      await this.schedule({ organizationId, orderId, kind: 'feedback_request', at: new Date(now + cfg.feedbackDelayMinutes * 60_000), dedupeKey: `feedback_request:${orderId}` });
      await this.schedule({ organizationId, orderId, kind: 'feedback_call', at: new Date(now + cfg.callDelayMinutes * 60_000), dedupeKey: `feedback_call:${orderId}` });
    } else if (to === 'cancelled') {
      await this.prisma.orderFollowUp.updateMany({ where: { organizationId, orderId, status: { in: OPEN } }, data: { status: 'cancelled', lastError: 'Order cancelled', completedAt: new Date() } });
      await this.prisma.order.update({ where: { id: orderId }, data: { followUpStatus: 'skipped', nextFollowUpAt: null } });
    }
  }

  /**
   * Dashboard "Run demo follow-up": a WhatsApp feedback request and a feedback call for a collected demo order,
   * always simulated (dry-run), through the real queue and processor. The simulated customer follows `scenario`.
   */
  async runDemo(organizationId: string, input: { orderId?: string; scenario: DemoScenario }) {
    const order = input.orderId
      ? await this.prisma.order.findFirst({ where: { id: input.orderId, organizationId } })
      : await this.prisma.order.findFirst({ where: { organizationId, isDemo: true, status: 'completed' }, orderBy: { collectedAt: 'desc' } });
    if (!order) throw new Error('No collected demo order found. Run npm run seed:gr-chicken-demo first.');
    if (!order.isDemo) throw new Error('Demo follow-ups run only on demo orders.');
    if (order.status !== 'completed') throw new Error('The order must be collected (completed) before a follow-up.');
    const run = Date.now().toString(36);
    // A fresh demo run starts from no feedback, so the scenario can play out.
    await this.prisma.order.update({ where: { id: order.id }, data: { feedbackRating: null, feedbackComment: null, feedbackAt: null, feedbackChannel: null, complaintStatus: null, complaintNote: null } });
    await this.prisma.customer.update({ where: { id: order.customerId }, data: { optedOutAt: null, messagingConsent: true, callingConsent: true } });
    const payload = { demo: true, simulate: input.scenario, run };
    const wa = await this.schedule({ organizationId, orderId: order.id, kind: 'feedback_request', at: new Date(), dedupeKey: `demo:${run}:feedback_request`, payload, forceDryRun: true });
    const call = await this.schedule({ organizationId, orderId: order.id, kind: 'feedback_call', at: new Date(Date.now() + 4000), dedupeKey: `demo:${run}:feedback_call`, payload, forceDryRun: true });
    return { orderId: order.id, orderNumber: order.orderNumber, scenario: input.scenario, followUpIds: [wa.row.id, call.row.id] };
  }

  // -----------------------------------------------------------------------------------------------
  // Processing (queue worker)
  // -----------------------------------------------------------------------------------------------

  /**
   * Process one follow-up. Safe to call any number of times: only a scheduled / retrying row is processed, and it
   * is claimed with compare-and-set so two workers never send the same message. Throws on a temporary failure so
   * BullMQ retries with back-off; after maxAttempts the row is marked failed.
   */
  async process(followUpId: string, now = new Date()): Promise<{ status: string; skipped?: string }> {
    const row = await this.prisma.orderFollowUp.findUnique({ where: { id: followUpId } });
    if (!row) return { status: 'missing' };
    bindOrganization(row.organizationId);
    if (!OPEN.includes(row.status)) return { status: row.status, skipped: 'already processed' };
    if (row.scheduledAt.getTime() > now.getTime() + 5_000) return { status: row.status, skipped: 'not due yet' };
    const claimed = await this.prisma.orderFollowUp.updateMany({ where: { id: row.id, status: row.status, attempts: row.attempts }, data: { status: 'processing', attempts: row.attempts + 1 } });
    if (claimed.count !== 1) return { status: 'processing', skipped: 'claimed by another worker' };
    const attempt = row.attempts + 1;
    const cfg = followUpConfig();

    let outcome: Outcome;
    try {
      const order = await this.prisma.order.findFirstOrThrow({ where: { id: row.orderId, organizationId: row.organizationId }, include: { customer: true, items: true, outlet: true } });
      const gate = liveGate(cfg, order.customer);
      const simulated = row.dryRun || cfg.dryRun;
      if (!simulated && !gate.live) outcome = { status: 'skipped', error: `Live send blocked: ${gate.reason}` };
      else outcome = row.channel === 'voice' ? await this.callOnce(row, order, simulated, attempt, cfg, now) : await this.sendWhatsApp(row, order, simulated, cfg);
    } catch (error) {
      // Permanent: the provider rejected it for good, or a send whose delivery is unknown (never resent). An HTTP
      // 4xx status from a provider client counts too; "443" in "157.240.1.1:443" does not.
      const status = Number(
        (error as { status?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode ?? /\b(?:API|HTTP|status)\s+(\d{3})\b/i.exec(errorMessage(error))?.[1],
      );
      const permanent = error instanceof UnrecoverableError || (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429);
      const final = permanent || attempt >= row.maxAttempts;
      const detail = describeError(error);
      const ambiguous = (error as { ambiguous?: boolean })?.ambiguous === true;
      await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { status: final ? 'failed' : 'retrying', lastError: `${ambiguous ? 'Delivery unknown (not resent): ' : ''}${detail}`.slice(0, 1000), ...(final ? { completedAt: new Date() } : {}) } });
      log.error(final ? 'followup.failed' : 'followup.retrying', { followUpId: row.id, attempt, dependency: dependencyOf(error), error: detail });
      await this.refreshOrder(row.orderId);
      if (final) return { status: 'failed' };
      throw error; // BullMQ retries this job with back-off
    }

    await this.finish(row, outcome, attempt);
    return { status: outcome.status };
  }

  private async finish(row: Row, o: Outcome, attempt: number) {
    if (o.reschedule) {
      // Outside calling hours: not an attempt; wait for the window.
      await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { status: 'scheduled', attempts: attempt - 1, scheduledAt: o.reschedule, lastError: o.error ?? null } });
      await this.enqueue({ id: row.id, attempts: attempt - 1, scheduledAt: o.reschedule });
    } else if (o.retryAt) {
      await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { status: 'scheduled', scheduledAt: o.retryAt, lastError: o.error ?? null, result: (o.result ?? undefined) as never } });
      await this.enqueue({ id: row.id, attempts: attempt, scheduledAt: o.retryAt });
    } else {
      const terminal = ['completed', 'skipped', 'failed', 'no_answer', 'cancelled'].includes(o.status);
      // A feedback reply may already have completed this row (simulated reply right after sending): keep that.
      await this.prisma.orderFollowUp.updateMany({
        where: { id: row.id, status: 'processing' },
        data: { status: o.status, lastError: o.error ?? null, ...(o.result ? { result: o.result as never } : {}), ...(terminal ? { completedAt: new Date() } : {}) },
      });
    }
    await this.refreshOrder(row.orderId);
  }

  /** Order-level summary: next follow-up time and overall state. */
  private async refreshOrder(orderId: string) {
    const rows = await this.prisma.orderFollowUp.findMany({ where: { orderId }, select: { status: true, scheduledAt: true } });
    const open = rows.filter((r) => OPEN.includes(r.status) || r.status === 'processing' || r.status === 'calling');
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { followUpStatus: true } });
    const state = open.length ? 'scheduled' : order?.followUpStatus === 'done' ? 'done' : rows.some((r) => ['sent', 'delivered', 'read', 'completed', 'no_answer'].includes(r.status)) ? 'done' : rows.length ? 'skipped' : null;
    await this.prisma.order.update({ where: { id: orderId }, data: { followUpStatus: state, nextFollowUpAt: open.length ? open.map((r) => r.scheduledAt).sort((a, b) => +a - +b)[0] : null } });
  }

  private async nextDue(orderId: string) {
    const next = await this.prisma.orderFollowUp.findFirst({ where: { orderId, status: { in: OPEN } }, orderBy: { scheduledAt: 'asc' } });
    return next?.scheduledAt ?? null;
  }

  // -----------------------------------------------------------------------------------------------
  // WhatsApp
  // -----------------------------------------------------------------------------------------------

  private messagingBlock(order: OrderFull): string | undefined {
    if (order.customer.optedOutAt) return 'Customer opted out (STOP)';
    if (order.customer.doNotContact) return 'Customer is marked do-not-contact';
    if (!order.customer.messagingConsent) return 'No messaging consent recorded for this customer';
    if (!order.customer.phone) return 'No phone number';
    return undefined;
  }

  /** The text of each WhatsApp follow-up (amounts from the order, never typed by hand). */
  messageText(kind: FollowUpKind, order: OrderFull): string {
    const name = firstName(order.customer.name) || 'there';
    const items = order.items.map((i) => `${qty(Number(i.quantity), i.unit)} ${i.name}${i.cut ? ` (${i.cut})` : ''}`).join(', ');
    if (kind === 'order_confirmation') {
      return `Hi ${name}, your GR Chicken order ${order.orderNumber} is received: ${items}. Total ${rs(Number(order.total))}. Collect at ${order.outlet.name} — ${describeWhen(order.pickupAt, 'en')}. Reply STOP to opt out.`;
    }
    if (kind === 'status_update') {
      return `Hi ${name}, GR Chicken has confirmed your order ${order.orderNumber}. It will be ready at ${order.outlet.name} for ${describeWhen(order.pickupAt, 'en')}. Reply STOP to opt out.`;
    }
    return `Hi ${name}, thank you for ordering from GR Chicken! How was your order ${order.orderNumber}? Reply 1–5 to rate your experience. Reply STOP to opt out.`;
  }

  private async sendWhatsApp(row: Row, order: OrderFull, simulated: boolean, cfg: FollowUpConfig): Promise<Outcome> {
    const kind = row.kind as FollowUpKind;
    const block = this.messagingBlock(order);
    if (block) return { status: 'skipped', error: block };
    if (order.status === 'cancelled') return { status: 'skipped', error: 'Order cancelled' };
    if (kind === 'order_confirmation' && (order.channel === 'whatsapp' || order.channel === 'test')) return { status: 'skipped', error: 'Already confirmed in the WhatsApp chat' };
    if (kind === 'status_update' && (row.payload as { status?: string } | null)?.status !== order.status && !['preparing', 'ready', 'completed'].includes(order.status)) {
      return { status: 'skipped', error: `Order is now ${order.status}` };
    }
    if (kind === 'feedback_request') {
      if (order.status !== 'completed' || !order.collectedAt) return { status: 'skipped', error: 'Order not collected yet' };
      if (order.feedbackRating !== null) return { status: 'skipped', error: 'Feedback already received' };
    }

    // Already sent on an earlier attempt (the result update failed afterwards): never send twice.
    if (row.providerMessageId) return { status: 'sent', result: { note: 'Sent on an earlier attempt; not re-sent' } };

    const to = order.customer.phone!;
    const text = this.messageText(kind, order);
    const windowOpen = await this.conversations.isWhatsAppWindowOpen(row.organizationId, order.customerId);
    const templateName = kind === 'feedback_request' ? cfg.feedbackTemplate : cfg.confirmationTemplate;
    const params = kind === 'feedback_request' ? [order.orderNumber] : [order.orderNumber, firstName(order.customer.name) || 'Customer'];
    let payload: WhatsAppPayload;
    const notes: string[] = [];
    if (windowOpen) payload = textPayload(to, text);
    else if (templateName) payload = templatePayload(to, templateName, params);
    else if (simulated) {
      payload = templatePayload(to, kind === 'feedback_request' ? 'gr_feedback_request' : 'gr_order_update', params);
      notes.push(`Outside the 24h window: a real send needs an approved template (${kind === 'feedback_request' ? 'FOLLOWUP_FEEDBACK_TEMPLATE' : 'FOLLOWUP_CONFIRMATION_TEMPLATE'} is not set). Simulated with a placeholder template name.`);
    } else return { status: 'skipped', error: `Outside the 24h window and no approved template (${kind === 'feedback_request' ? 'FOLLOWUP_FEEDBACK_TEMPLATE' : 'FOLLOWUP_CONFIRMATION_TEMPLATE'})` };

    const transport = simulated ? this.mockWhatsApp : this.liveWhatsApp;
    const sent = await transport.send(payload);
    await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { providerMessageId: sent.messageId, payload: { request: payload, ...(row.payload as object | null ?? {}) } as never } });
    const conv = await this.conversations.getOrCreateConversation({ organizationId: row.organizationId, channel: 'whatsapp', externalId: to, customerId: order.customerId });
    await this.conversations.addMessage({
      organizationId: row.organizationId,
      conversationId: conv.id,
      role: 'assistant',
      content: payload.type === 'text' ? text : `[template:${payload.template.name}] ${params.join(' | ')}`,
      externalId: sent.messageId,
      metadata: { followUpId: row.id, kind, simulated: sent.simulated },
    });
    await this.prisma.order.update({ where: { id: order.id }, data: { lastContactAt: new Date() } });
    await this.prisma.orderEvent.create({ data: { organizationId: row.organizationId, orderId: order.id, type: 'follow_up', actor: 'system', note: `${kind.replace('_', ' ')} ${sent.simulated ? 'simulated (DRY_RUN)' : 'sent'} on WhatsApp` } });

    // Recorded as sent before any reply can arrive (a reply looks for a sent request).
    const baseResult = { simulated: sent.simulated, windowOpen, ...(notes.length ? { notes } : {}) };
    await this.prisma.orderFollowUp.updateMany({ where: { id: row.id, status: 'processing' }, data: { status: 'sent', result: baseResult as never } });

    // Dry-run demo: the simulated customer replies through the same handler real replies use.
    const scenario = this.scenarioFor(row, order);
    const replies = sent.simulated && kind === 'feedback_request' && scenario ? SIMULATED[scenario].whatsapp ?? [] : [];
    const simulatedReplies: Array<{ customer: string; assistant: string }> = [];
    for (const reply of replies) {
      await this.conversations.addMessage({ organizationId: row.organizationId, conversationId: conv.id, role: 'user', content: reply, metadata: { simulated: true, followUpId: row.id } });
      const handled = await this.feedback.handleInbound(row.organizationId, order.customerId, reply, { simulated: true, conversationId: conv.id });
      if (handled) {
        await this.conversations.addMessage({ organizationId: row.organizationId, conversationId: conv.id, role: 'assistant', content: handled.reply, metadata: { simulated: true, followUpId: row.id } });
        simulatedReplies.push({ customer: reply, assistant: handled.reply });
      }
    }
    if (simulatedReplies.length) {
      const current = await this.prisma.orderFollowUp.findUniqueOrThrow({ where: { id: row.id } });
      await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { result: { ...baseResult, ...((current.result as object | null) ?? {}), simulatedReplies } as never } });
    }
    return { status: 'sent', result: baseResult };
  }

  /**
   * Staff "Send confirmation on WhatsApp" from the order page: the order confirmation to the customer's number or to
   * ANOTHER number staff type (a family member, a second phone). Staff pressing the button is the request; the same
   * protections apply: STOP / do-not-contact of that number, DRY_RUN, the live test gate, the 24 h window (text) or the
   * approved confirmation template outside it. Recorded on the order (event) and in that number's conversation.
   */
  async sendConfirmationNow(organizationId: string, orderId: string, toRaw: string | undefined, actor: string): Promise<{ sent: boolean; simulated: boolean; to: string; note: string }> {
    const cfg = followUpConfig();
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId }, include: { customer: true, items: true, outlet: true } });
    if (!order) throw new Error('Order not found');
    if (order.status === 'cancelled') throw new Error('This order is cancelled: no confirmation is sent.');
    const to = toRaw ? normalizePhone(toRaw) : order.customer.phone ?? undefined;
    if (!to) throw new Error('Enter a valid mobile number.');
    // The receiving number's own choices win (it may be another customer of this business).
    const other = to === order.customer.phone ? order.customer : await this.prisma.customer.findFirst({ where: { organizationId, phone: to } });
    if (other?.optedOutAt) throw new Error('This number replied STOP: WhatsApp messages are not sent to it.');
    if (other?.doNotContact) throw new Error('This number is marked do-not-contact.');
    const gate = liveGate(cfg, { phone: to, isDemo: order.isDemo || Boolean(other?.isDemo) });
    const simulated = cfg.dryRun || !gate.live;
    const text = this.messageText('order_confirmation', order);
    const params = [order.orderNumber, firstName(order.customer.name) || 'Customer'];
    const receiver = other ?? (await this.conversations.getOrCreateCustomerByPhone(organizationId, to, { source: 'order_confirmation_forward' }));
    const windowOpen = await this.conversations.isWhatsAppWindowOpen(organizationId, receiver.id);
    let payload: WhatsAppPayload;
    if (windowOpen) payload = textPayload(to, text);
    else if (cfg.confirmationTemplate) payload = templatePayload(to, cfg.confirmationTemplate, params);
    else if (simulated) payload = templatePayload(to, 'gr_order_update', params);
    else throw new Error('This number has not messaged the shop in the last 24 hours, and no approved WhatsApp confirmation template is set (FOLLOWUP_CONFIRMATION_TEMPLATE). Ask the customer to message the shop first, or add the template.');
    const sent = await (simulated ? this.mockWhatsApp : this.liveWhatsApp).send(payload);
    const conv = await this.conversations.getOrCreateConversation({ organizationId, channel: 'whatsapp', externalId: to, customerId: receiver.id });
    await this.conversations.addMessage({ organizationId, conversationId: conv.id, role: 'assistant', content: payload.type === 'text' ? text : `[template:${payload.template.name}] ${params.join(' | ')}`, externalId: sent.messageId, metadata: { kind: 'order_confirmation', orderId: order.id, by: actor, simulated: sent.simulated } });
    const masked = `${to.slice(0, 2)}••••${to.slice(-4)}`;
    const note = `Order confirmation ${sent.simulated ? `simulated (${cfg.dryRun ? 'DRY_RUN' : gate.reason})` : 'sent'} on WhatsApp to ${masked}${to === order.customer.phone ? '' : ' (another number)'}`;
    await this.prisma.orderEvent.create({ data: { organizationId, orderId: order.id, type: 'follow_up', actor, note } });
    await this.prisma.order.update({ where: { id: order.id }, data: { lastContactAt: new Date() } });
    log.info('followup.confirmation_sent', { organizationId, orderId: order.id, simulated: sent.simulated, otherNumber: to !== order.customer.phone });
    return { sent: !sent.simulated, simulated: sent.simulated, to: masked, note };
  }

  /** WhatsApp delivery receipts (sent / delivered / read / failed) from the webhook. */
  async applyDeliveryStatus(organizationId: string, messageId: string, status: string, error?: string) {
    const rank: Record<string, number> = { sent: 1, delivered: 2, read: 3 };
    const row = await this.prisma.orderFollowUp.findFirst({ where: { organizationId, providerMessageId: messageId } });
    if (!row) return false;
    if (status === 'failed') {
      await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { status: 'failed', lastError: (error ?? 'WhatsApp reported the message as failed').slice(0, 1000), completedAt: new Date() } });
    } else if (rank[status] && (rank[row.status] ?? 0) < rank[status] && ['sent', 'delivered', 'read'].includes(row.status)) {
      await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { status } });
    }
    return true;
  }

  // -----------------------------------------------------------------------------------------------
  // Voice
  // -----------------------------------------------------------------------------------------------

  private scenarioFor(row: Row, order: OrderFull): DemoScenario | undefined {
    const s = (row.payload as { simulate?: string } | null)?.simulate ?? order.demoScenario ?? undefined;
    return s && (DEMO_SCENARIOS as string[]).includes(s) && order.isDemo ? (s as DemoScenario) : undefined;
  }

  /** Who may get a feedback call now. Pure checks; the caller records the reason when not eligible. */
  callEligibility(order: OrderFull, opts: { now: Date; ignoreHours?: boolean }): { ok: true } | { ok: false; reason: string; reschedule?: Date } {
    if (order.status !== 'completed' || !order.collectedAt) return { ok: false, reason: 'Order not collected yet' };
    if (order.customer.optedOutAt) return { ok: false, reason: 'Customer opted out (STOP)' };
    if (order.customer.doNotContact) return { ok: false, reason: 'Customer is marked do-not-contact' };
    if (!order.customer.callingConsent) return { ok: false, reason: 'No calling consent recorded for this customer' };
    if (!order.customer.phone) return { ok: false, reason: 'No phone number' };
    if (order.feedbackRating !== null) return { ok: false, reason: 'Feedback already received' };
    if (!opts.ignoreHours) {
      const hour = istHour(opts.now);
      if (hour < config.voice.callWindowStartHour || hour >= config.voice.callWindowEndHour) {
        return { ok: false, reason: `Outside calling hours (${config.voice.callWindowStartHour}:00–${config.voice.callWindowEndHour}:00 IST)`, reschedule: nextAllowedCallTime(opts.now, config.voice.callWindowStartHour, config.voice.callWindowEndHour) };
      }
    }
    return { ok: true };
  }

  private callOpening(order: OrderFull) {
    const name = firstName(order.customer.name);
    return order.language === 'english'
      ? `Hello${name ? ` ${name}` : ''}, this is GR Chicken. How was your order? Please tell us a rating from 1 to 5.`
      : `வணக்கம்${name ? ` ${name}` : ''}, GR Chicken-ல இருந்து பேசுறோம். நீங்க வாங்கின order எப்படி இருந்துச்சு? 1-ல இருந்து 5 வரைக்கும் ஒரு mark சொல்லுங்க.`;
  }

  private async callOnce(row: Row, order: OrderFull, simulated: boolean, attempt: number, cfg: FollowUpConfig, now: Date): Promise<Outcome> {
    const demo = Boolean((row.payload as { demo?: boolean } | null)?.demo);
    const ok = this.callEligibility(order, { now, ignoreHours: demo });
    if (!ok.ok) return ok.reschedule ? { status: 'scheduled', reschedule: ok.reschedule, error: ok.reason } : { status: 'skipped', error: ok.reason };
    const live = await this.prisma.call.findFirst({ where: { customerId: order.customerId, status: { in: ['queued', 'ringing', 'in_progress'] }, createdAt: { gt: new Date(now.getTime() - 10 * 60_000) } } });
    if (live && !simulated) return { status: 'scheduled', retryAt: new Date(now.getTime() + 10 * 60_000), error: 'Another call to this customer is in progress' };

    const request = { organizationId: row.organizationId, customerId: order.customerId, to: order.customer.phone!, idempotencyKey: `${row.id}:${attempt}`, purpose: 'order_feedback', variables: { order_number: order.orderNumber, customer_name: order.customer.name ?? '' }, overrides: (({ message, language }) => ({ initialBotMessage: message, initialLanguage: language }))(feedbackCallOpening({ orderNumber: order.orderNumber, customerName: order.customer.name, language: order.language })) };
    await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { payload: { request: { ...request, provider: simulated ? 'dry_run' : 'sarvam' }, ...((row.payload as object | null) ?? {}) } as never } });

    if (!simulated) {
      // Live: Sarvam outbound with the organization's automatic-call agent (every gate in TelephonyService). The call
      // record and transcript arrive with Sarvam's post-call webhook; reading the rating from it is pending.
      const r = await this.liveVoice.dial(request);
      if (!r.requestId) return { status: 'skipped', error: `Feedback call not placed: ${r.reason ?? 'voice not configured'}` };
      return { status: 'completed', result: { simulated: false, provider: 'sarvam', requestId: r.requestId, note: 'Call requested on Sarvam; outcome and transcript arrive by webhook.' } };
    }

    const call = await this.prisma.call.create({
      data: {
        organizationId: row.organizationId,
        customerId: order.customerId,
        direction: 'outbound',
        status: 'queued',
        toNumber: order.customer.phone!,
        fromNumber: 'dry-run',
        provider: 'dry_run',
        attempt,
        language: order.language === 'english' ? 'en-IN' : 'ta-IN',
        summary: `[SIMULATED] Feedback call for ${order.orderNumber}`,
      },
    });
    await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { callId: call.id } });

    // Dry-run: the same outcome handling as a real call, with a simulated customer.
    const dialed = await this.mockVoice.dial(request);
    const scenario = this.scenarioFor(row, order);
    const said = scenario ? SIMULATED[scenario].call : null; // a real (non-demo) customer is never given invented feedback
    if (said === null || said === undefined) {
      await this.prisma.call.update({ where: { id: call.id }, data: { status: 'no_answer', outcome: 'no_answer', providerCallId: dialed.requestId, endedAt: new Date(), hangupCause: 'SIMULATED_NO_ANSWER' } });
      return this.noAnswer(row, order, attempt, cfg, now, true);
    }
    await this.prisma.call.update({ where: { id: call.id }, data: { status: 'in_progress', providerCallId: dialed.requestId, answeredAt: new Date() } });
    const opening = this.callOpening(order);
    await this.saveCallLine(row.organizationId, order, 'assistant', opening, call.id, true);
    await this.saveCallLine(row.organizationId, order, 'user', said, call.id, true);
    const done = await this.applyCallReply(row, order, call.id, said, true);
    await this.saveCallLine(row.organizationId, order, 'assistant', done.reply, call.id, true);
    await this.prisma.call.update({ where: { id: call.id }, data: { status: 'completed', endedAt: new Date(), durationSec: 25 } });
    return { status: 'completed', result: { simulated: true, transcript: [opening, said, done.reply], rating: done.rating ?? null, complaint: done.complaint } };
  }

  private async noAnswer(row: Row, order: OrderFull, attempt: number, cfg: FollowUpConfig, now: Date, simulated: boolean): Promise<Outcome> {
    await this.prisma.order.update({ where: { id: order.id }, data: { lastContactAt: new Date() } });
    await this.prisma.orderEvent.create({ data: { organizationId: row.organizationId, orderId: order.id, type: 'follow_up', actor: 'system', note: `Feedback call not answered (attempt ${attempt}/${row.maxAttempts})${simulated ? ' (simulated)' : ''}` } });
    if (attempt < row.maxAttempts) {
      const retryAt = new Date(now.getTime() + cfg.callRetryMinutes * 60_000);
      return { status: 'scheduled', retryAt, error: `No answer (attempt ${attempt}/${row.maxAttempts}); retry at ${retryAt.toISOString()}`, result: { simulated, lastAttempt: 'no_answer' } };
    }
    return { status: 'no_answer', error: `No answer after ${attempt} attempt${attempt > 1 ? 's' : ''}`, result: { simulated } };
  }

  /**
   * Sarvam's post-call webhook for a feedback call we placed ("order_feedback:<follow-up id>:<attempt>"): what the
   * customer said -> rating / complaint on the order (the same rules as WhatsApp ratings and simulated calls).
   * Not answered -> recorded; the follow-up keeps its normal retry rules.
   */
  async onFeedbackCallResult(r: OutboundResult) {
    const m = r.idempotencyKey.match(/^order_feedback:([^:]+):(\d+)$/);
    if (!m) return;
    const row = await this.prisma.orderFollowUp.findFirst({ where: { id: m[1], organizationId: r.organizationId, kind: 'feedback_call' } });
    if (!row) return;
    const order = await this.prisma.order.findFirst({ where: { id: row.orderId, organizationId: r.organizationId }, include: { customer: true, items: true, outlet: true } });
    if (!order) return;
    const said = r.transcript.filter((l) => l.role === 'user').map((l) => l.content).join(' ').trim();
    if (r.status !== 'completed' || !said) {
      await this.prisma.orderEvent.create({ data: { organizationId: r.organizationId, orderId: order.id, type: 'follow_up', actor: 'system', note: `Feedback call ${r.status === 'completed' ? 'answered, no rating given' : `not answered (${r.status})`}` } });
      return;
    }
    if (order.feedbackRating !== null && order.feedbackRating !== undefined) return; // already rated (WhatsApp or an earlier call)
    const done = r.callId
      ? await this.applyCallReply(row, order, r.callId, said, false)
      : { ...(await this.feedback.apply(r.organizationId, order.id, { channel: 'voice', text: said, simulated: false })), reply: '' };
    await this.prisma.orderFollowUp.update({ where: { id: row.id }, data: { result: { ...((row.result as object | null) ?? {}), rating: done.rating ?? null, complaint: Boolean(done.complaint), fromCall: r.callId } as never } });
    log.info('followup.feedback_call_result', { organizationId: r.organizationId, orderId: order.id, rated: done.rating !== undefined, complaint: Boolean(done.complaint) });
  }

  /** What the customer said on the call -> rating / complaint on the order (shared by real and simulated calls). */
  private async applyCallReply(row: Row, order: OrderFull, callId: string, transcript: string, simulated: boolean) {
    const applied = await this.feedback.apply(row.organizationId, order.id, { channel: 'voice', text: transcript, simulated });
    await this.prisma.call.update({
      where: { id: callId },
      data: {
        outcome: applied.complaint ? 'human_requested' : 'connected',
        turns: { increment: 1 },
        summary: `${simulated ? '[SIMULATED] ' : ''}Feedback call for ${order.orderNumber}: ${applied.rating !== undefined ? `${applied.rating}/5` : 'no rating'}${applied.complaint ? ', complaint escalated' : ''}. Customer: "${transcript.slice(0, 200)}"`,
      },
    });
    const st = order.language === 'english' ? 'en' : 'ta';
    const reply = applied.complaint
      ? st === 'en' ? "Sorry about that. Our manager will call you back today. Thank you." : 'மன்னிச்சுக்கோங்க. எங்க manager இன்னைக்கே உங்களுக்கு call பண்ணுவாங்க. நன்றி.'
      : st === 'en' ? 'Thank you so much! See you again at GR Chicken.' : 'ரொம்ப நன்றி! திரும்ப GR Chicken-க்கு வாங்க.';
    return { ...applied, reply };
  }

  /** Call lines go into the customer's voice conversation so staff can read the call in the inbox. */
  private async saveCallLine(organizationId: string, order: OrderFull, role: 'user' | 'assistant', content: string, callId: string, simulated: boolean) {
    const conv = await this.conversations.getOrCreateConversation({ organizationId, channel: 'voice', externalId: order.customer.phone!, customerId: order.customerId });
    await this.conversations.addMessage({ organizationId, conversationId: conv.id, role, content, metadata: { callId, orderId: order.id, kind: 'feedback_call', simulated } });
  }
}
