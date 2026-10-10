import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { queueRedis, whatsappQueue } from '../queues/queues.js';
import { customerLockKey, withLock } from '../common/redis-lock.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { normalizePhone } from '../common/phone.js';
import { log } from '../common/logger.js';

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
  ) {}

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
          continue;
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

          await this.markInbound(organizationId, from, contactName);

          await whatsappQueue.add(
            'incoming-message',
            {
              organizationId,
              phoneNumberId,
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
