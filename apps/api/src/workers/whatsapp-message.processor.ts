import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { applyOptKeyword, optReply } from '../consent/opt-out.js';
import type { Job } from 'bullmq';
import { AiService } from '../ai/ai.service.js';
import { SarvamService } from '../sarvam/sarvam.service.js';
import { MediaRejectedError, WhatsAppSenderService, WhatsAppAmbiguousSendError, WhatsAppTransientError } from '../whatsapp/whatsapp-sender.service.js';
import { InboundMessageService } from '../whatsapp/inbound-messages.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { describeError } from '../common/errors.js';
import { LeadsService } from '../leads/leads.service.js';
import type { WhatsAppMessageJobData } from '../queues/queues.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { errorMessage, log } from '../common/logger.js';
import { recordTurn } from '../common/latency.js';
import { MultimodalService } from '../media/multimodal.service.js';
import { InboxService } from '../inbox/inbox.service.js';

@Injectable()
export class WhatsAppMessageProcessor {
  /** One message at a time per customer, so replies stay in order and context is consistent. */
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly ai: AiService,
    private readonly sarvam: SarvamService,
    private readonly sender: WhatsAppSenderService,
    private readonly leads: LeadsService,
    private readonly conversations: ConversationsService,
    private readonly inbound: InboundMessageService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly multimodalService?: MultimodalService,
    @Optional() private readonly inboxService?: InboxService,
  ) {}

  /** Injected in the app; built from the same Sarvam / WhatsApp services where a test constructs the processor. */
  private get multimodal(): MultimodalService {
    return (this.mm ??= this.multimodalService ?? new MultimodalService(this.sarvam, this.sender));
  }
  private mm?: MultimodalService;

  process(job: Job<WhatsAppMessageJobData>) {
    return this.mutex.run(job.data.from, () => this.handle(job));
  }

  private async handle(job: Job<WhatsAppMessageJobData>) {
    const data = job.data;
    const startedAt = Date.now();
    const finalAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);

    // One logical reply per inbound message: the database row is claimed with compare-and-set, so a re-delivered,
    // retried or stalled job running in parallel finds nothing to do.
    const row = await this.inbound.claim({ organizationId: data.organizationId, providerMessageId: data.messageId, fromPhone: data.from, messageType: data.messageType });
    if (!row) {
      log.info('whatsapp.inbound_skipped', { messageId: data.messageId, reason: 'already handled or being handled by another worker' });
      return { skipped: 'claimed_or_done' };
    }
    log.info('whatsapp.inbound_claimed', { messageId: data.messageId, inboundId: row.id, attempt: row.attempts });

    // A previous attempt already sent it, or started sending and never learned the result: never send again.
    if (row.replyStatus === 'accepted') {
      await this.inbound.markSent(row.id, row.replyProviderId ?? undefined);
      return { alreadySent: row.replyProviderId };
    }
    if (row.replyStatus === 'sending' || row.replyStatus === 'unknown') {
      await this.inbound.markUnknown(row.id, 'An earlier attempt was sending this reply when it stopped; not resent to avoid a duplicate.');
      return { skipped: 'delivery_unknown' };
    }

    let reply = row.replyText ?? undefined;
    let conversationId = row.conversationId ?? undefined;
    let result: Awaited<ReturnType<AiService['generateResponse']>> | undefined;
    let aiMs = 0;
    // Where time goes BEFORE we start: Meta -> our webhook (message timestamp has 1 s resolution), and our queue wait.
    const receivedAt = row.receivedAt?.getTime();
    const queueWaitMs = receivedAt ? Math.max(0, startedAt - receivedAt) : undefined;
    const metaDelayMs = receivedAt && Number(data.timestamp) > 0 ? Math.max(0, receivedAt - Number(data.timestamp) * 1000) : undefined;
    try {
      if (!reply) {
        // Perceived latency: the customer sees "read" and "typing…" at once instead of silence while the reply is made.
        void Promise.resolve().then(() => this.sender.markReadWithTyping?.(data.messageId)).catch(() => undefined); // best effort (blocked in DRY_RUN)
        // Retry after a failed send never gets here: the stored reply is re-sent and the AI is not run again.
        let text = data.text?.trim();
        let viaVoiceNote = false;
        let quality: 'ok' | 'weak' = 'ok';
        // Multimodal (every industry): voice notes and images become text for the industry's own engine, which
        // checks every product / price / availability against its database. Media bytes are never stored.
        let media: Record<string, unknown> | undefined;
        if (!text && (data.audioId || data.imageId || data.documentId)) {
          const understood = data.audioId
            ? await this.multimodal.understandAudio(data.audioId)
            : data.imageId
              ? await this.multimodal.understandImage(data.imageId, data.caption, await this.catalogueNames(data.organizationId))
              : this.multimodal.understandDocument(data.caption, data.mediaMime);
          media = understood.meta;
          viaVoiceNote = Boolean(data.audioId);
          if (understood.kind === 'text') {
            text = understood.text;
            quality = understood.quality;
          } else {
            reply = understood.reply;
            conversationId = await this.recordMediaExchange(data, understood.meta, reply, Boolean(understood.handoff));
          }
        }
        if (!text && !reply) {
          log.info('whatsapp.unsupported_type', { messageId: data.messageId, type: data.messageType });
          await this.inbound.markSkipped(row.id, `unsupported message type: ${data.messageType}`);
          return { skipped: data.messageType };
        }
        // STOP / START (real estate and textile): record it and confirm. The sales assistant never answers a STOP.
        // GR Chicken returns null here and keeps its own STOP flow inside the ordering engine.
        if (!reply && text && this.prisma) {
          const kind = await applyOptKeyword(this.prisma, data.organizationId, data.from, text);
          if (kind) {
            reply = await this.optReplyFor(data, kind);
            conversationId = await this.recordOptExchange(data, text, reply);
          }
        }
        // A person took this conversation over in the team inbox: the message is kept for them, the AI stays silent.
        if (!reply && text && this.prisma) {
          const held = await this.prisma.conversation.findFirst({ where: { organizationId: data.organizationId, channel: 'whatsapp', externalId: data.from, aiEnabled: false }, select: { id: true } });
          if (held) {
            await this.conversations.addMessage({ organizationId: data.organizationId, conversationId: held.id, role: 'user', content: text, externalId: data.messageId, metadata: { waMessageId: data.messageId, viaVoiceNote, ...(media ? { media } : {}), heldForTeam: true } as never });
            await this.inboxService?.onCustomerMessage(data.organizationId, held.id).catch(() => undefined);
            await this.inbound.markSkipped(row.id, 'human_takeover: the team is handling this conversation');
            log.info('whatsapp.held_for_team', { messageId: data.messageId, conversationId: held.id });
            return { held: held.id };
          }
        }
        if (!reply) {
          result = await this.ai.generateResponse({
            organizationId: data.organizationId,
            channel: 'whatsapp',
            phone: data.from,
            message: text!,
            customerName: data.customerName,
            quality,
            metadata: { waMessageId: data.messageId, viaVoiceNote, ...(media ? { media } : {}) },
          });
          aiMs = Date.now() - startedAt;
          reply = result.response;
          conversationId = result.conversationId;
        }
        await this.inbound.saveReply(row.id, reply!, conversationId);
      }
    } catch (error) {
      // Nothing was sent: hand the message back for BullMQ's next (bounded) attempt, or fail it on the last one.
      if (finalAttempt) await this.inbound.markFailed(row.id, describeError(error));
      else await this.inbound.release(row.id, describeError(error));
      throw error;
    }

    // Live AI steering, review mode: the AI's reply (already decided and recorded by its engine) waits in the team
    // inbox for a person to approve, edit or discard it. Only AI replies are held (STOP / START confirmations and
    // media acknowledgements are not), and only where a person switched the conversation to review.
    if (result && conversationId && this.prisma) {
      const conv = await this.prisma.conversation.findFirst({ where: { id: conversationId, organizationId: data.organizationId }, select: { aiMode: true } });
      if (conv?.aiMode === 'review') {
        await this.holdForReview(row.id, data, conversationId, reply!, new Date(startedAt - 1000));
        try {
          await this.leads.advanceLeadStatus({ organizationId: data.organizationId, leadId: result.leadId, status: 'contacted' });
        } catch {
          /* bookkeeping only */
        }
        return { heldForReview: conversationId };
      }
    }

    const sendStartedAt = Date.now();
    await this.sendReply(row.id, data, reply!, conversationId, finalAttempt, new Date((row.receivedAt?.getTime() ?? startedAt - 60_000) - 2000));
    if (conversationId) await this.inboxService?.onCustomerMessage(data.organizationId, conversationId).catch((e) => log.warn('inbox.update_failed', { error: errorMessage(e) }));
    const sendMs = Date.now() - sendStartedAt;
    // Optional spoken reply to a voice note, AFTER the text (which is the fallback). Real Sarvam audio only.
    if (data.audioId && result) {
      const voice = await this.multimodal.sendVoiceReply(data.from, reply!).catch((e) => ({ sent: false, reason: errorMessage(e) }));
      if (voice.reason !== 'disabled') log.info('whatsapp.voice_reply', { messageId: data.messageId, sent: voice.sent, reason: voice.reason });
      if (voice.sent && conversationId) await this.conversations.addMessage({ organizationId: data.organizationId, conversationId, role: 'assistant', content: reply!, metadata: { media: { messageType: 'voice', generated: true, provider: 'sarvam', processing: 'ok' }, providerMessageId: (voice as { messageId?: string }).messageId } as never }).catch(() => undefined);
    }
    // Everything below is bookkeeping: a failure here must never make the job retry (and resend the reply).
    if (result) {
      try {
        this.afterReply(data, result, aiMs, sendMs, startedAt, queueWaitMs, metaDelayMs);
        await this.leads.advanceLeadStatus({ organizationId: data.organizationId, leadId: result.leadId, status: 'contacted' });
      } catch (error) {
        log.warn('whatsapp.post_send_bookkeeping_failed', { messageId: data.messageId, error: describeError(error) });
      }
    }
    return { conversationId, actions: result?.actions };
  }

  /**
   * Send the stored reply once. "sending" is claimed in the database before the request, so only one send is ever
   * in flight; the outcome is written straight after. "accepted" means Meta took it — delivered / read only come
   * from Meta's receipts.
   */
  private async optReplyFor(data: WhatsAppMessageJobData, kind: 'stop' | 'start') {
    const [org, cu] = await Promise.all([
      this.prisma!.organization.findUnique({ where: { id: data.organizationId }, select: { name: true } }),
      this.prisma!.customer.findFirst({ where: { organizationId: data.organizationId, phone: data.from }, select: { language: true } }),
    ]);
    return optReply(kind, org?.name ?? 'us', cu?.language);
  }

  /** The STOP / START message and our confirmation appear in the conversation like any other exchange. */
  /** Product names the vision model may map a picture to (the engine still checks every one against the database). */
  private async catalogueNames(organizationId: string): Promise<string[]> {
    if (!this.prisma) return [];
    const rows = await this.prisma.menuItem.findMany({ where: { organizationId }, select: { name: true }, take: 80 }).catch(() => []);
    return rows.map((r) => r.name);
  }

  /** A media message answered without the engine (unclear, needs confirmation, or for staff): kept in the inbox. */
  private async recordMediaExchange(data: WhatsAppMessageJobData, meta: Record<string, unknown>, reply: string, handoff: boolean) {
    try {
      const cu = this.prisma ? await this.prisma.customer.findFirst({ where: { organizationId: data.organizationId, phone: data.from }, select: { id: true } }) : null;
      const conv = await this.conversations.getOrCreateConversation({ organizationId: data.organizationId, channel: 'whatsapp', externalId: data.from, customerId: cu?.id });
      const label = meta.messageType === 'voice' ? '[Voice note]' : meta.messageType === 'image' ? '[Image]' : '[Document]';
      const said = typeof meta.transcription === 'string' && meta.transcription ? ` ${meta.transcription}` : data.caption ? ` ${data.caption}` : '';
      await this.conversations.addMessage({ organizationId: data.organizationId, conversationId: conv.id, role: 'user', content: `${label}${said}`.slice(0, 2000), externalId: data.messageId, metadata: { waMessageId: data.messageId, media: meta } as never });
      await this.conversations.addMessage({ organizationId: data.organizationId, conversationId: conv.id, role: 'assistant', content: reply, metadata: { media: { replyTo: meta.messageType }, ...(handoff ? { handoff: true } : {}) } as never });
      if (handoff && this.prisma) await this.prisma.conversation.updateMany({ where: { id: conv.id, organizationId: data.organizationId }, data: { status: 'human_handoff', updatedAt: new Date() } });
      return conv.id;
    } catch (error) {
      log.warn('whatsapp.media_exchange_record_failed', { messageId: data.messageId, error: describeError(error) });
      return undefined;
    }
  }

  private async recordOptExchange(data: WhatsAppMessageJobData, text: string, reply: string) {
    try {
      const cu = await this.prisma!.customer.findFirst({ where: { organizationId: data.organizationId, phone: data.from }, select: { id: true } });
      const conv = await this.conversations.getOrCreateConversation({ organizationId: data.organizationId, channel: 'whatsapp', externalId: data.from, customerId: cu?.id });
      await this.conversations.addMessage({ organizationId: data.organizationId, conversationId: conv.id, role: 'user', content: text, externalId: data.messageId });
      await this.conversations.addMessage({ organizationId: data.organizationId, conversationId: conv.id, role: 'assistant', content: reply, metadata: { optOut: true } as never });
      return conv.id;
    } catch (error) {
      log.warn('whatsapp.opt_exchange_record_failed', { messageId: data.messageId, error: describeError(error) });
      return undefined;
    }
  }

  /**
   * Marks THIS turn's AI reply as held. Engines may save their reply in the background just after answering, so the
   * reply is found by its exact text and time (created during this turn), waiting up to 10 s for it; it never marks an
   * earlier message. If it does not appear in time, nothing is marked (the reply is still not sent) and it is logged.
   */
  private async holdForReview(inboundId: string, data: WhatsAppMessageJobData, conversationId: string, reply: string, since: Date) {
    let msg: { id: string; metadata: unknown } | null = null;
    for (let i = 0; i < 40 && !msg; i++) {
      msg = await this.prisma!.message.findFirst({ where: { organizationId: data.organizationId, conversationId, role: 'assistant', content: reply, createdAt: { gte: since }, deliveryStatus: null }, orderBy: { createdAt: 'desc' }, select: { id: true, metadata: true } });
      if (!msg) await new Promise((r) => setTimeout(r, 250));
    }
    if (msg) {
      const md = (msg.metadata ?? {}) as Record<string, unknown>;
      await this.prisma!.message.update({ where: { id: msg.id }, data: { deliveryStatus: 'held', deliveryUpdatedAt: new Date(), metadata: { ...md, review: { status: 'pending', inboundId } } as never } });
    } else {
      log.warn('whatsapp.held_reply_not_found', { messageId: data.messageId, conversationId });
    }
    await this.inbound.markSkipped(inboundId, 'held_for_review: the AI reply waits for a person to approve it');
    await this.inboxService?.onCustomerMessage(data.organizationId, conversationId).catch(() => undefined);
    log.info('whatsapp.held_for_review', { messageId: data.messageId, conversationId, found: Boolean(msg) });
  }

  private async sendReply(inboundId: string, data: WhatsAppMessageJobData, text: string, conversationId: string | undefined, finalAttempt: boolean, since: Date) {
    const match = { content: text, since };
    if (!(await this.inbound.markSending(inboundId))) {
      log.warn('whatsapp.send_already_claimed', { messageId: data.messageId, inboundId });
      return undefined;
    }
    try {
      const id = await this.sender.sendText(data.from, text);
      await this.inbound.markSent(inboundId, id);
      log.info('whatsapp.reply_accepted', { messageId: data.messageId, inboundId, providerMessageId: id, conversationId });
      if (conversationId) {
        await this.conversations
          .recordReplySend(data.organizationId, conversationId, { providerMessageId: id, status: 'accepted' }, match)
          .catch((error) => log.warn('whatsapp.reply_status_save_failed', { messageId: data.messageId, error: describeError(error) }));
      }
      return id;
    } catch (error) {
      const detail = describeError(error);
      if (error instanceof WhatsAppAmbiguousSendError) {
        await this.inbound.markUnknown(inboundId, detail);
        if (conversationId) await this.conversations.recordReplySend(data.organizationId, conversationId, { status: 'unknown', error: detail }, match).catch(() => undefined);
      } else if (error instanceof WhatsAppTransientError && !finalAttempt) {
        // Meta never got it (or said try later): the same stored reply goes out on the next attempt.
        await this.inbound.markSendRetryable(inboundId, detail);
      } else {
        // Refused before or by the provider (not configured, invalid recipient, retries used up): nothing was sent.
        await this.inbound.markFailed(inboundId, detail, { replyFailed: true });
        if (conversationId) await this.conversations.recordReplySend(data.organizationId, conversationId, { status: 'failed', error: detail }, match).catch(() => undefined);
      }
      log.error('whatsapp.reply_send_failed', { messageId: data.messageId, inboundId, error: detail });
      throw error;
    }
  }

  private afterReply(data: WhatsAppMessageJobData, result: Awaited<ReturnType<AiService['generateResponse']>>, aiMs: number, sendMs: number, startedAt: number, queueWaitMs?: number, metaDelayMs?: number) {
    const totalMs = Date.now() - startedAt;
    log.info('whatsapp.latency', { messageId: data.messageId, metaDelayMs, queueWaitMs, aiMs, sendMs, totalMs, path: result.path, aiRequests: result.aiUsage?.requests ?? 0 });
    recordTurn(
      {
        aiMs,
        sendMs,
        queueWaitMs,
        providerDelayMs: metaDelayMs,
        totalMs,
        aiRequests: result.aiUsage?.requests ?? 0,
        toolMs: result.aiUsage?.toolMs,
        pureAiMs: result.aiUsage?.pureAiMs,
        path: result.path,
      },
      'whatsapp',
    );
  }
}
