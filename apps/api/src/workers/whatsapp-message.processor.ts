import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AiService } from '../ai/ai.service.js';
import { SarvamService } from '../sarvam/sarvam.service.js';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
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
  ) {}

  process(job: Job<WhatsAppMessageJobData>) {
    return this.mutex.run(job.data.from, () => this.handle(job));
  }

  private async handle(job: Job<WhatsAppMessageJobData>) {
    const data = job.data;
    const startedAt = Date.now();

    // Retry after a failed send: don't run the AI (and save messages) twice.
    if (data.generatedReply) {
      await this.sender.sendText(data.from, data.generatedReply);
      return { resent: true };
    }

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
      if (!text) {
        await this.sender.sendText(data.from, 'Sorry, voice note clear-ah kekkala. Text-la anuppa mudiyuma? 🙏');
        return { skipped: 'voice_note_unclear' };
      }
    }

    if (!text) {
      log.info('whatsapp.unsupported_type', { messageId: data.messageId, type: data.messageType });
      return { skipped: data.messageType };
    }

    const result = await this.ai.generateResponse({
      organizationId: data.organizationId,
      channel: 'whatsapp',
      phone: data.from,
      message: text,
      customerName: data.customerName,
      quality,
      metadata: { waMessageId: data.messageId, viaVoiceNote },
    });
    const aiMs = Date.now() - startedAt;

    await job.updateData({ ...data, generatedReply: result.response });
    const sendStartedAt = Date.now();
    await this.sender.sendText(data.from, result.response);
    const sendMs = Date.now() - sendStartedAt;
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
    await this.leads.advanceLeadStatus({
      organizationId: data.organizationId,
      leadId: result.leadId,
      status: 'contacted',
    });
    return { conversationId: result.conversationId, actions: result.actions };
  }
}
