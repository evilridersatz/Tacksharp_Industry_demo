import { Injectable, Optional } from '@nestjs/common';
import { ConversationEngine, type GenerateResponseInput, type GenerateResponseResult } from './conversation-engine.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { OrderingEngine } from '../restaurant/ordering-engine.service.js';
import { config } from '../common/config.js';
import { SettingsService } from '../settings/settings.service.js';
import { VERTICAL_INDUSTRIES, VerticalAssistant, type VerticalIndustry } from '../verticals/vertical-assistant.service.js';

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
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly verticals?: VerticalAssistant,
  ) {}

  /** Food / hotel / hospital businesses (Settings → Industry) get their own assistant; null = not one of those. */
  async verticalIndustry(organizationId: string): Promise<VerticalIndustry | null> {
    if (!this.settings || !this.verticals) return null;
    const industry = (await this.settings.get(organizationId)).industry;
    return (VERTICAL_INDUSTRIES as string[]).includes(industry) ? (industry as VerticalIndustry) : null;
  }

  /** Routes the turn to the tenant's product: real-estate lead follow-up (default) or restaurant ordering. */
  async generateResponse(input: GenerateResponseInput): Promise<GenerateResponseResult> {
    const organizationId = input.organizationId ?? config.defaultOrganizationId;
    if ((await this.tenancy.vertical(organizationId)) !== 'restaurant') {
      const vertical = await this.verticalIndustry(organizationId);
      if (vertical) return this.verticals!.generate(vertical, { ...input, organizationId });
      return this.engine.generate(input);
    }
    const result = await this.ordering.generate({
      organizationId,
      // Phone calls use the same ordering rules with spoken replies. The authenticated /ai/chat test endpoint
      // ("web") behaves like the dashboard test chat.
      channel: input.channel === 'whatsapp' ? 'whatsapp' : input.channel === 'voice' ? 'voice' : 'test',
      phone: input.phone,
      message: input.message,
      customerName: input.customerName,
      metadata: input.metadata,
    });
    return { ...result, actions: AiService.restaurantActions(result), state: result.state, intent: result.intent };
  }

  /**
   * What a restaurant turn means for the call: it ends ONLY when the ordering engine says the customer ended it
   * (goodbye, "no" / "thanks" after their order, or a request for staff). A normal answer keeps the call open.
   */
  static restaurantActions(result: { endCall?: boolean; endReason?: string; order?: { status: string } }): GenerateResponseResult['actions'] {
    const outcome = result.order ? 'order_placed' : result.endReason === 'handoff' ? 'human_requested' : undefined;
    return {
      ...(result.endCall ? { endCall: true } : {}),
      ...(outcome ? { outcome } : {}),
    } as GenerateResponseResult['actions'];
  }

  /** Which product the organization runs (routes calls and chats; never decided from message content). */
  vertical(organizationId: string) {
    return this.tenancy.vertical(organizationId);
  }

  /** Restaurant calls: open the phone session and save the opening line. */
  openRestaurantCall(input: Parameters<OrderingEngine['openVoiceSession']>[0]) {
    return this.ordering.openVoiceSession(input);
  }

  restaurantKeyterms(organizationId: string) {
    return this.ordering.voiceKeyterms(organizationId);
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
