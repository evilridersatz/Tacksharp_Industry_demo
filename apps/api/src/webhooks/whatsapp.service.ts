import { Injectable, Optional } from '@nestjs/common';
import { recordWebhookFailure } from '../common/webhook-failures.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { queueRedis, whatsappQueue } from '../queues/queues.js';
import { customerLockKey, withLock } from '../common/redis-lock.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { normalizePhone } from '../common/phone.js';
import { log } from '../common/logger.js';
import { OrderFollowUpService } from '../restaurant/order-followup.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { InboundMessageService } from '../whatsapp/inbound-messages.service.js';
import { MarketingService } from '../marketing/marketing.service.js';
import { applyOptKeyword, optKeyword } from '../consent/opt-out.js';
import { DemoSessionsService } from '../demo-sessions/demo-sessions.service.js';

type IncomingQueue = { add(name: string, data: unknown, opts: { jobId: string }): Promise<unknown> };

type WhatsAppMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
};

type WhatsAppWebhookBody = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: WhatsAppMessage[];
        statuses?: Array<{ id?: string; status?: string; recipient_id?: string; errors?: Array<{ title?: string; message?: string; code?: number }> }>;
      };
    }>;
  }>;
};

@Injectable()
export class WhatsAppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly followUps: FollowUpsService,
    private readonly tenancy: TenancyService,
    private readonly orderFollowUps: OrderFollowUpService,
    private readonly conversations: ConversationsService,
    private readonly inbound: InboundMessageService,
    @Optional() private readonly marketing?: MarketingService,
    @Optional() private readonly demoSessions?: DemoSessionsService,
  ) {}

  /** The BullMQ queue in production; tests swap in a fake. */
  queue: IncomingQueue = whatsappQueue as unknown as IncomingQueue;

  /**
   * Fast path only: record that the customer replied, stop pending automation,
   * and queue the message. The AI runs in the worker. Meta needs a quick 200.
   */
  async processWebhook(body: unknown) {
    const payload = body as WhatsAppWebhookBody;
    if (payload?.object !== 'whatsapp_business_account') {
      return { success: true, ignored: true };
    }

    let queued = 0;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages' || !change.value) continue;
        const value = change.value;
        // The organization comes from the receiving business number (signed by Meta), never from the message.
        const phoneNumberId = value.metadata?.phone_number_id;
        const organizationId = await this.tenancy.resolve('whatsapp_phone_number_id', phoneNumberId);
        if (!organizationId || !phoneNumberId) {
          log.warn('whatsapp.unknown_phone_number_id', { messages: value.messages?.length ?? 0 });
          recordWebhookFailure('whatsapp', 'unknown_phone_number_id', '/webhooks/whatsapp');
          continue;
        }

        // Delivery receipts for messages we sent (sent / delivered / read / failed): chat replies and follow-ups.
        for (const st of value.statuses ?? []) {
          if (!st.id || !st.status) continue;
          const error = st.errors?.map((e) => `${e.code ?? ''} ${e.title ?? e.message ?? ''}`.trim()).join('; ');
          // Shared demo number: a message sent from an industry demo workspace is stored there, so its receipt is
          // applied to the owner and to workspaces this recipient was bound to (matched by Meta's message id).
          const receiptOrgs = this.demoSessions ? await this.demoSessions.receiptOrgs(organizationId, st.recipient_id) : [organizationId];
          for (const org of receiptOrgs) {
            await this.orderFollowUps.applyDeliveryStatus(org, st.id, st.status, error);
            await this.conversations.applyDeliveryStatus(org, st.id, st.status, error);
            await this.marketing?.applyDeliveryStatus(org, st.id, st.status, error).catch((e) => log.warn('marketing.receipt_failed', { messageId: st.id, error: e instanceof Error ? e.message : String(e) }));
          }
          if (st.status === 'failed') log.warn('whatsapp.delivery_failed', { messageId: st.id, error });
        }

        for (const message of value.messages ?? []) {
          const from = normalizePhone(message.from);
          if (!from || !message.id) continue;

          const text =
            message.text?.body ??
            message.button?.text ??
            message.interactive?.button_reply?.title ??
            message.interactive?.list_reply?.title;
          const audioId = message.type === 'audio' ? message.audio?.id : undefined;
          const contactName = value.contacts?.find((c) => normalizePhone(c.wa_id) === from)?.profile?.name;

          // Shared demo number: an approved tester bound to an industry workspace is answered by that workspace.
          // Decided per message from the stored session, never from whatever the dashboard currently shows.
          const routed = this.demoSessions ? await this.demoSessions.routeInbound('whatsapp', organizationId, from) : null;
          if (routed && 'unrouted' in routed) {
            // Strict mode and no session: do not guess an industry. Recorded (deduplicated), never answered.
            const kept = await this.inbound.accept({ organizationId, providerMessageId: message.id, fromPhone: from, messageType: message.type ?? 'unknown', payload: { phoneNumberId, text: text ?? null, unrouted: true } });
            if (kept.outcome !== 'duplicate') await this.prisma.inboundMessage.update({ where: { id: kept.row.id }, data: { status: 'skipped' } }).catch(() => undefined);
            log.warn('whatsapp.unrouted_shared_number', { messageId: message.id });
            continue;
          }
          const org = routed ? routed.organizationId : organizationId;
          const demoSessionId = routed ? routed.sessionId : undefined;
          // Meta message ids are global: a re-delivery after a session started / ended must not be answered again
          // by the other workspace.
          if (this.demoSessions && (await this.prisma.inboundMessage.findFirst({ where: { providerMessageId: message.id, organizationId: { not: org } }, select: { id: true } }))) {
            log.info('whatsapp.duplicate_inbound', { messageId: message.id, status: 'other_workspace' });
            continue;
          }

          // Persisted first, keyed by Meta's message id (unique per organization): a re-delivered webhook — after a
          // lost 200, or days later — is recognised here and never answered twice.
          const accepted = await this.inbound.accept({
            organizationId: org,
            providerMessageId: message.id,
            fromPhone: from,
            messageType: message.type ?? 'unknown',
            payload: { phoneNumberId, ...(demoSessionId ? { demoSessionId } : {}), text: text ?? null, audioId: audioId ?? null, customerName: contactName ?? null, timestamp: message.timestamp ?? null },
          });
          if (accepted.outcome === 'duplicate') {
            log.info('whatsapp.duplicate_inbound', { messageId: message.id, status: accepted.row.status });
            continue;
          }
          try {
            await this.markInbound(org, from, contactName);
            // STOP / START (textile and real estate) and campaign reply attribution; never block the reply.
            // Applied here, in the fast path, so the opt-out holds even if the AI queue is slow or down.
            // STOP only: START is handled by the worker (it must still see the customer as opted out to confirm it).
            await applyOptKeyword(this.prisma, org, from, text, { only: 'stop' }).catch((e) => log.error('consent.opt_keyword_failed', { error: e instanceof Error ? e.message : String(e) }));
            // A STOP / START is not engagement: it is never credited to a campaign.
            if (!optKeyword(text)) await this.marketing?.recordReply(org, from).catch((e) => log.warn('marketing.reply_attribution_failed', { error: e instanceof Error ? e.message : String(e) }));
            await this.queue.add(
              'incoming-message',
              {
                organizationId: org,
                phoneNumberId,
                ...(demoSessionId ? { demoSessionId } : {}),
                from,
                messageId: message.id,
                messageType: message.type ?? 'unknown',
                text,
                audioId,
                customerName: contactName,
                timestamp: message.timestamp,
              },
              { jobId: `whatsapp-${message.id}` }, // Meta retries the same id -> deduplicated
            );
          } catch (error) {
            // Not queued: the row stays "received", so Meta's retry of this webhook (we answer 500) queues it, and
            // the worker's sweep re-queues it if Meta does not retry.
            log.error('whatsapp.queue_failed', { messageId: message.id, error: error instanceof Error ? error.message : String(error) });
            throw error;
          }
          await this.inbound.markQueued(accepted.row.id);
          queued++;
          log.info('whatsapp.queued', { messageId: message.id, type: message.type });
        }
      }
    }
    return { success: true, queued };
  }

  /** Customer wrote to us: open the 24h window, re-enable contact, cancel pending automation. */
  private async markInbound(organizationId: string, phone: string, name?: string) {
    const existing = await this.prisma.customer.findFirst({ where: { organizationId, phone }, select: { id: true } });
    const run = async () => {
      const customer = await this.prisma.customer.upsert({
        where: { organizationId_phone: { organizationId, phone } },
        create: { organizationId, phone, name, source: 'whatsapp', lastInboundAt: new Date() },
        update: { lastInboundAt: new Date(), doNotContact: false },
      });
      await this.followUps.cancelPending({
        organizationId,
        customerId: customer.id,
        reason: 'Customer replied on WhatsApp',
        sources: ['sequence', 'retry'],
      });
    };
    // Same lock as the follow-up worker: a reply and a follow-up for one customer never interleave.
    if (existing) await withLock(queueRedis, customerLockKey(existing.id), run);
    else await run();
  }
}
