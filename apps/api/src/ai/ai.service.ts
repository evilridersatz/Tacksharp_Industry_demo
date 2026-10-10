import { Injectable } from '@nestjs/common';
import { ConversationEngine, type GenerateResponseInput, type GenerateResponseResult } from './conversation-engine.service.js';

export type { GenerateResponseInput, GenerateResponseResult } from './conversation-engine.service.js';
export type { AiUsageMetrics } from './llm-runner.service.js';

/**
 * Entry point used by WhatsApp, voice and the test chat endpoint.
 *
 * All decisions (what state the conversation is in, whether the customer actually confirmed
 * something, whether a visit may be booked) are made by the ConversationEngine in application
 * code. The language model is used only to phrase replies that rules cannot answer.
 */
@Injectable()
export class AiService {
  constructor(private readonly engine: ConversationEngine) {}

  generateResponse(input: GenerateResponseInput): Promise<GenerateResponseResult> {
    return this.engine.generate(input);
  }

  /** Voice: create the call-scoped session at answer time so the first customer turn needs no lookups. */
  likelyFirstReplies(session: Parameters<ConversationEngine['likelyFirstReplies']>[0]) {
    return this.engine.likelyFirstReplies(session);
  }

  openCallSession(params: Parameters<ConversationEngine['openCallSession']>[0]) {
    return this.engine.openCallSession(params);
  }

  voiceSessionKey(organizationId: string, callId: string, phone: string) {
    return this.engine.voiceSessionKey(organizationId, callId, phone);
  }

  /** Run non-critical persistence off the reply path. Hang-up and tests wait for it with settle(). */
  background(key: string, work: () => Promise<unknown>) {
    this.engine.background(key, work);
  }

  settle(key: string, timeoutMs?: number) {
    return this.engine.settle(key, timeoutMs);
  }

  /** Voice: the last reply could not be played (TTS failure); a confirmation question in it does not count as asked. */
  markReplyNotHeard(key: string) {
    void this.engine.markReplyNotHeard(key);
  }

  closeSession(key: string) {
    return this.engine.closeSession(key);
  }
}
