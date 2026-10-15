import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AiService } from '../ai/ai.service.js';
import { SarvamService } from '../sarvam/sarvam.service.js';
import { WhatsAppSenderService, WhatsAppAmbiguousSendError, WhatsAppTransientError } from '../whatsapp/whatsapp-sender.service.js';
import { InboundMessageService } from '../whatsapp/inbound-messages.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { describeError } from '../common/errors.js';
import { LeadsService } from '../leads/leads.service.js';
import type { WhatsAppMessageJobData } from '../queues/queues.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { errorMessage, log } from '../common/logger.js';
import { recordTurn } from '../common/latency.js';
import { assessTranscript } from '../conversation/transcript-gate.js';

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
  ) {}

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
    try {
      if (!reply) {
        // Retry after a failed send never gets here: the stored reply is re-sent and the AI is not run again.
        let text = data.text?.trim();
        let viaVoiceNote = false;
        let quality: 'ok' | 'weak' = 'ok';
        if (!text && data.audioId) {
          try {
            const media = await this.sender.downloadMedia(data.audioId);
            const stt = await this.sarvam.speechToText(media.buffer, 'voice-note.ogg', media.mimeType);
            // Same quality gate as phone calls: garbled speech-to-text never drives the conversation.
            const gate = assessTranscript({ transcript: stt.transcript, sttLanguage: stt.languageCode });
            text = gate.verdict === 'reject' ? '' : gate.text;
            quality = gate.verdict === 'ok' ? 'ok' : 'weak';
            viaVoiceNote = true;
          } catch (error) {
            log.error('whatsapp.voice_note_failed', { messageId: data.messageId, error: errorMessage(error) });
          }
          if (!text) reply = 'Sorry, voice note clear-ah kekkala. Text-la anuppa mudiyuma? 🙏';
        }
        if (!text && !reply) {
          log.info('whatsapp.unsupported_type', { messageId: data.messageId, type: data.messageType });
          await this.inbound.markSkipped(row.id, `unsupported message type: ${data.messageType}`);
          return { skipped: data.messageType };
        }
        if (!reply) {
          result = await this.ai.generateResponse({
            organizationId: data.organizationId,
            channel: 'whatsapp',
            phone: data.from,
            message: text!,
            customerName: data.customerName,
            quality,
            metadata: { waMessageId: data.messageId, viaVoiceNote },
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

    const sendStartedAt = Date.now();
    await this.sendReply(row.id, data, reply!, conversationId, finalAttempt);
    const sendMs = Date.now() - sendStartedAt;
    // Everything below is bookkeeping: a failure here must never make the job retry (and resend the reply).
    if (result) {
      try {
        this.afterReply(data, result, aiMs, sendMs, startedAt);
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
  private async sendReply(inboundId: string, data: WhatsAppMessageJobData, text: string, conversationId: string | undefined, finalAttempt: boolean) {
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
          .recordReplySend(data.organizationId, conversationId, { providerMessageId: id, status: 'accepted' })
          .catch((error) => log.warn('whatsapp.reply_status_save_failed', { messageId: data.messageId, error: describeError(error) }));
      }
      return id;
    } catch (error) {
      const detail = describeError(error);
      if (error instanceof WhatsAppAmbiguousSendError) {
        await this.inbound.markUnknown(inboundId, detail);
        if (conversationId) await this.conversations.recordReplySend(data.organizationId, conversationId, { status: 'unknown', error: detail }).catch(() => undefined);
      } else if (error instanceof WhatsAppTransientError && !finalAttempt) {
        // Meta never got it (or said try later): the same stored reply goes out on the next attempt.
        await this.inbound.markSendRetryable(inboundId, detail);
      } else {
        // Refused before or by the provider (not configured, invalid recipient, retries used up): nothing was sent.
        await this.inbound.markFailed(inboundId, detail, { replyFailed: true });
        if (conversationId) await this.conversations.recordReplySend(data.organizationId, conversationId, { status: 'failed', error: detail }).catch(() => undefined);
      }
      log.error('whatsapp.reply_send_failed', { messageId: data.messageId, inboundId, error: detail });
      throw error;
    }
  }

  private afterReply(data: WhatsAppMessageJobData, result: Awaited<ReturnType<AiService['generateResponse']>>, aiMs: number, sendMs: number, startedAt: number) {
    recordTurn(
      {
        aiMs,
        sendMs,
        totalMs: Date.now() - startedAt,
        aiRequests: result.aiUsage?.requests ?? 0,
        toolMs: result.aiUsage?.toolMs,
        pureAiMs: result.aiUsage?.pureAiMs,
        path: result.path,
      },
      'whatsapp',
    );
  }
}
