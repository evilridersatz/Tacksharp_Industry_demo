import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { errorMessage, log } from '../common/logger.js';
import { normalizePhone } from '../common/phone.js';
import { detectLanguage } from '../conversation/language.js';
import type { GenerateResponseInput, GenerateResponseResult } from '../ai/conversation-engine.service.js';
import { AgentSessionStore } from './common.js';
import { spoken, type AgentChannel, type AgentCtx, type AgentOut, type Style } from './agent-types.js';
import { FoodAgent, newFoodState, type FoodState } from './food/food-agent.js';
import { HotelAgent, newHotelState, type HotelState } from './hotel/hotel-agent.js';
import { HospitalAgent, newHospitalState, type HospitalState } from './hospital/hospital-agent.js';

export type VerticalIndustry = 'food' | 'hotel' | 'hospital';
export const VERTICAL_INDUSTRIES: VerticalIndustry[] = ['food', 'hotel', 'hospital'];

type AnyState = (FoodState | HotelState | HospitalState) & { style?: Style };

/**
 * Entry point for the food, hotel and hospital assistants (WhatsApp, voice and test chat). Handles the shared parts —
 * customer, lead, conversation history, language, durable state, human handoff — and delegates the business logic.
 * The opt-out (STOP) and duplicate-webhook protection happen before this, in the WhatsApp pipeline.
 */
@Injectable()
export class VerticalAssistant {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly leads: LeadsService,
    private readonly followUps: FollowUpsService,
    private readonly sessions: AgentSessionStore,
    private readonly foodAgent: FoodAgent,
    private readonly hotelAgent: HotelAgent,
    private readonly hospitalAgent: HospitalAgent,
  ) {}

  sessionKey(industry: VerticalIndustry, org: string, channel: string, phone: string) {
    return `${industry}:${org}:${channel === 'voice' ? 'voice' : channel === 'whatsapp' ? 'whatsapp' : 'web'}:${phone}`;
  }

  async generate(industry: VerticalIndustry, input: GenerateResponseInput & { organizationId: string }, now = new Date()): Promise<GenerateResponseResult> {
    const started = Date.now();
    const org = input.organizationId;
    const phone = normalizePhone(input.phone) ?? input.phone;
    const channel: AgentChannel = input.channel === 'voice' ? 'voice' : input.channel === 'whatsapp' ? 'whatsapp' : 'web';
    const organization = await this.prisma.organization.findUnique({ where: { id: org }, select: { name: true, isDemo: true } });
    const customer0 = await this.conversations.getOrCreateCustomerByPhone(org, phone, { name: input.customerName, source: channel === 'web' ? 'test_chat' : channel });
    const customer = await this.prisma.customer.update({ where: { id: customer0.id }, data: { lastInboundAt: now } });
    const lead = await this.leads.ensureActiveLead(org, customer.id, channel);
    const conversation = await this.conversations.getOrCreateConversation({ organizationId: org, channel: channel === 'web' ? 'web' : channel, externalId: phone, customerId: customer.id });
    await this.conversations.addMessage({ organizationId: org, conversationId: conversation.id, role: 'user', content: input.message.slice(0, 4000), metadata: { ...(input.metadata ?? {}), channel } });

    const key = this.sessionKey(industry, org, channel, phone);
    const saved = (await this.sessions.get<AnyState>(key)) ?? undefined;
    const det = detectLanguage(input.message);
    const style: Style = det.lang === 'tamil' || det.lang === 'tanglish' ? 'tl' : det.lang === 'english' ? 'en' : saved?.style ?? (customer.language === 'tanglish' || customer.language === 'tamil' ? 'tl' : 'en');
    const ctx: AgentCtx = { org, orgName: organization?.name ?? 'us', isDemo: Boolean(organization?.isDemo), customer, leadId: lead.id, conversationId: conversation.id, channel, text: input.message, style, voice: channel === 'voice', now };

    let result: AgentOut<AnyState>;
    try {
      if (industry === 'food') result = (await this.foodAgent.turn(ctx, (saved as FoodState) ?? newFoodState())) as AgentOut<AnyState>;
      else if (industry === 'hotel') result = (await this.hotelAgent.turn(ctx, (saved as HotelState) ?? newHotelState())) as AgentOut<AnyState>;
      else result = (await this.hospitalAgent.turn(ctx, (saved as HospitalState) ?? newHospitalState())) as AgentOut<AnyState>;
    } catch (error) {
      log.error('vertical.turn_failed', { org, industry, error: errorMessage(error) });
      result = { reply: style === 'tl' ? 'Sorry, oru problem aagiduchu. Engal team inga reply pannuvaanga.' : 'Sorry, something went wrong on our side. Our team will reply to you here.', state: saved ?? ({ v: 1, step: 'handoff' } as AnyState), intent: 'error', handoff: { reason: `Assistant error: ${errorMessage(error).slice(0, 160)}` } };
    }

    if (result.handoff) {
      try {
        await this.followUps.createHumanTask({ organizationId: org, leadId: lead.id, customerId: customer.id, reason: `${result.handoff.urgent ? 'URGENT ' : ''}Handoff: ${result.handoff.reason}` });
        await this.followUps.cancelPending({ organizationId: org, customerId: customer.id, reason: 'Human handoff requested', channels: ['voice'] });
        await this.prisma.conversation.update({ where: { id: conversation.id }, data: { status: 'human_handoff', updatedAt: new Date() } });
        await this.leads.advanceLeadStatus({ organizationId: org, leadId: lead.id, status: 'human_handoff' });
      } catch (error) {
        log.warn('vertical.handoff_failed', { org, error: errorMessage(error) });
      }
    }
    if (result.outcome === 'booked' || result.outcome === 'order_placed') {
      await this.leads.advanceLeadStatus({ organizationId: org, leadId: lead.id, status: 'won' }).catch(() => undefined);
    } else if (result.intent !== 'greeting') {
      await this.leads.advanceLeadStatus({ organizationId: org, leadId: lead.id, status: 'contacted' }).catch(() => undefined);
    }
    if (channel === 'whatsapp' && !customer.messagingConsent) await this.prisma.customer.update({ where: { id: customer.id }, data: { messagingConsent: true } }).catch(() => undefined);

    const reply = channel === 'voice' ? spoken(result.reply) : result.reply;
    await this.sessions.set(key, org, industry, { ...result.state, style });
    await this.conversations.addMessage({
      organizationId: org, conversationId: conversation.id, role: 'assistant', content: reply,
      metadata: { channel, intent: result.intent, industry, path: 'rules', ...(result.record ? { record: result.record } : {}), ...(channel !== 'whatsapp' ? { simulated: channel === 'web' } : {}) },
    });
    return {
      conversationId: conversation.id, customerId: customer.id, leadId: lead.id, response: reply,
      actions: { ...(result.handoff ? { handoff: true, outcome: 'human_requested' } : {}), ...(result.endCall ? { endCall: true } : {}), ...(result.outcome && result.outcome !== 'human_requested' ? { outcome: result.outcome } : {}) } as GenerateResponseResult['actions'],
      timings: { totalMs: Date.now() - started }, path: 'rules', state: String(result.state.step), intent: result.intent,
      ...(result.record ? { record: result.record } : {}),
    } as GenerateResponseResult;
  }

  /** Clear the assistant's memory for a conversation ("new chat" in the playground / scenario runner). */
  async reset(industry: VerticalIndustry, org: string, channel: string, phone: string) {
    await this.sessions.clear(this.sessionKey(industry, org, channel, normalizePhone(phone) ?? phone));
  }
}
