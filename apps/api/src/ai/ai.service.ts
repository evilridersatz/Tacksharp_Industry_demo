import { Injectable } from '@nestjs/common';
import { ConversationEngine, type GenerateResponseInput, type GenerateResponseResult } from './conversation-engine.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { OrderingEngine } from '../restaurant/ordering-engine.service.js';
import { config } from '../common/config.js';

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
  constructor(
    private readonly engine: ConversationEngine,
    private readonly tenancy: TenancyService,
    private readonly ordering: OrderingEngine,
  ) {}

  /** Routes the turn to the tenant's product: real-estate lead follow-up (default) or restaurant ordering. */
  async generateResponse(input: GenerateResponseInput): Promise<GenerateResponseResult> {
    const organizationId = input.organizationId ?? config.defaultOrganizationId;
    if ((await this.tenancy.vertical(organizationId)) !== 'restaurant') return this.engine.generate(input);
    if (input.channel === 'voice') {
      // Voice ordering is not built for restaurants yet: never guess an order on a phone line.
      return {
        conversationId: '',
        customerId: '',
        leadId: '',
        response: 'Sorry, phone ordering is not available yet. Please order on WhatsApp or our website.',
        actions: { endCall: true },
        timings: {},
        path: 'rules',
      };
    }
    const result = await this.ordering.generate({
      organizationId,
      channel: input.channel,
      phone: input.phone,
      message: input.message,
      customerName: input.customerName,
      metadata: input.metadata,
    });
    return { ...result, actions: {}, state: result.state, intent: result.intent };
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
