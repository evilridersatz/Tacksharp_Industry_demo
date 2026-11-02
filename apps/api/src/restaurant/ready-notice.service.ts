import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import { OrdersService, type OrderView } from './orders.service.js';
import { itemsPhrase, say, type Style } from './replies.js';
import { followUpConfig, liveGate } from './followup-config.js';
import { withLock } from '../common/redis-lock.js';
import { queueRedis } from '../queues/queues.js';

const waStyleOf = (lang: string | null | undefined): Style => (lang === 'english' ? 'en' : lang === 'tamil' ? 'ta' : 'tl');

/**
 * "Your order is ready, exactly as you asked — come and collect it."
 * When staff mark an order Ready, the customer gets the ready message on WhatsApp (free text inside the 24 h window,
 * otherwise the approved order-ready template). The old Plivo ready CALL was removed (2026-11); a Sarvam ready-call
 * agent is pending. Every outcome is written to the order's history; nothing is reported as delivered unless it was.
 */
@Injectable()
export class ReadyNoticeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly conversations: ConversationsService,
    private readonly sender: WhatsAppSenderService,
  ) {}

  /** Serialize ready notifications per order to prevent concurrent duplicate calls/messages. */
  async notify(organizationId: string, orderId: string, opts: { force?: boolean } = {}) {
    try {
      await withLock(
        queueRedis,
        `ready-notice:${organizationId}:${orderId}`,
        async () => this.notifyLocked(organizationId, orderId, opts),
        { ttlMs: 60_000, waitMs: 15_000 },
      );
    } catch (error) {
      log.error('ready_notice.failed', { organizationId, orderId, error: errorMessage(error) });
    }
  }

  private async notifyLocked(organizationId: string, orderId: string, opts: { force?: boolean }) {
    try {
      const order = await this.orders.getOrder(organizationId, orderId);
      if (order.status !== 'ready') return;
      if (!opts.force && order.readyNotice && ['calling', 'answered', 'whatsapp_sent'].includes(order.readyNotice)) return;

      const customer = await this.prisma.customer.findFirst({
        where: { id: order.customerId, organizationId },
        select: { phone: true, isDemo: true, optedOutAt: true },
      });

      if (customer?.optedOutAt) {
        return this.orders.recordReadyNotice(organizationId, order.id, {
          readyNotice: 'not_sent',
          note: 'Customer opted out (STOP): no call or message',
        });
      }

      const gate = liveGate(followUpConfig(), {
        phone: customer?.phone ?? null,
        isDemo: customer?.isDemo ?? false,
      });

      if (!gate.live && order.channel !== 'test') {
        return this.simulate(order, gate.reason ?? 'DRY_RUN');
      }

      if (!order.customerPhone) {
        return this.orders.recordReadyNotice(organizationId, order.id, {
          readyNotice: 'not_sent',
          note: 'No phone number on the order',
        });
      }

      await this.whatsapp(order, 'Order ready');
    } catch (error) {
      log.error('ready_notice.failed', { organizationId, orderId, error: errorMessage(error) });
    }
  }

  /** DRY_RUN or not an approved test number: show the ready message in the conversation, contact nobody. */
  private async simulate(order: OrderView, reason: string) {
    const organizationId = await this.orgOf(order.id);
    const st = waStyleOf(order.language);
    const text = say.readyWhatsApp(st, { orderNumber: order.orderNumber, items: itemsPhrase(order.items, st), shop: order.outlet.name, total: order.total, paid: order.paymentStatus === 'paid' });
    if (order.conversationId) await this.conversations.addMessage({ organizationId, conversationId: order.conversationId, role: 'assistant', content: text, metadata: { kind: 'order_ready', simulated: true } });
    await this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'whatsapp_sent', note: `Simulated (${reason}): nothing sent; the ready message is shown in the conversation.` });
  }

  /** The ready message on WhatsApp (within 24h: free text; otherwise the approved order-ready template). */
  private async whatsapp(order: OrderView, why: string, opts: { keepStatus?: boolean } = {}) {
    const organizationId = await this.orgOf(order.id);
    const st = waStyleOf(order.language);
    const text = say.readyWhatsApp(st, { orderNumber: order.orderNumber, items: itemsPhrase(order.items, st), shop: order.outlet.name, total: order.total, paid: order.paymentStatus === 'paid' });
    if (order.channel === 'test') {
      // Dashboard test chat: show the message in the test conversation, send nothing.
      if (order.conversationId) await this.conversations.addMessage({ organizationId, conversationId: order.conversationId, role: 'assistant', content: text, metadata: { kind: 'order_ready', test: true } });
      if (!opts.keepStatus) await this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'whatsapp_sent', note: `${why}. Test chat: ready message shown in the test conversation (not sent on WhatsApp).` });
      return;
    }
    try {
      const windowOpen = await this.conversations.isWhatsAppWindowOpen(organizationId, order.customerId);
      let content = text;
      if (windowOpen) await this.sender.sendText(order.customerPhone!, text);
      else if (config.whatsapp.stepTemplates.order_ready) {
        await this.sender.sendNamedTemplate(order.customerPhone!, config.whatsapp.stepTemplates.order_ready, [order.orderNumber]);
        content = `[template:${config.whatsapp.stepTemplates.order_ready}] ${order.orderNumber}`;
      } else {
        throw new Error('Customer has not messaged in 24h and WHATSAPP_TEMPLATE_ORDER_READY is not set');
      }
      if (order.conversationId) await this.conversations.addMessage({ organizationId, conversationId: order.conversationId, role: 'assistant', content, metadata: { kind: 'order_ready' } });
      if (!opts.keepStatus) await this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'whatsapp_sent', note: `${why}. Ready message sent on WhatsApp.` });
    } catch (error) {
      if (!opts.keepStatus) await this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'not_sent', note: `${why}. WhatsApp also failed: ${errorMessage(error).slice(0, 200)}. Please call the customer.` });
    }
  }

  private async orgOf(orderId: string) {
    return (await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { organizationId: true } })).organizationId;
  }
}
