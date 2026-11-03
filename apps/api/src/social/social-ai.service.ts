import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Conversation, Customer, VoiceAgent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CredentialsService } from '../integrations/credentials.service.js';
import { VoiceAgentsService } from '../voice-agents/voice-agents.service.js';
import type { ChatTurn } from '../voice-agents/agent-engine.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { isKnowledgeGap } from '../knowledge/knowledge-studio.service.js';
import { activeGuidance } from '../inbox/steering.js';
import { log } from '../common/logger.js';
import { SocialSenderService, type SocialChannel } from './social-sender.service.js';

type Actor = { sub: string; org: string };
const HISTORY = 12;

/**
 * AI replies on Instagram / Messenger with one of the organization's own custom agents (chosen in the Instagram &
 * Messenger settings). Uses the same agent engine as calls and the test console: the agent's instructions and ITS
 * knowledge base only, never invented facts. It does NOT use the WhatsApp / phone ordering engines (GR Chicken), which
 * identify customers by phone number.
 *
 * Same rules as WhatsApp: review mode holds the reply for a person; team guidance steers it; a customer asking for a
 * person, or a question the knowledge cannot answer, hands the conversation to the team (and the question appears in
 * the knowledge studio). Sends go through the live gate (DRY_RUN, demo customers, approved test accounts).
 */
@Injectable()
export class SocialAiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: CredentialsService,
    private readonly agents: VoiceAgentsService,
    private readonly conversations: ConversationsService,
    private readonly sender: SocialSenderService,
  ) {}

  /** The active agent answering this organization's Instagram / Messenger, or null (the team answers). */
  async agentFor(org: string): Promise<VoiceAgent | null> {
    const c = await this.creds.resolve(org, 'meta_social').catch(() => null);
    const id = c?.source === 'organization' ? c.config.aiAgentId : undefined;
    if (!id) return null;
    return this.prisma.voiceAgent.findFirst({ where: { id, organizationId: org, status: 'active' } });
  }

  async settings(org: string) {
    const row = await this.prisma.integrationCredential.findFirst({ where: { organizationId: org, provider: 'meta_social' }, select: { config: true, enabled: true } });
    const id = ((row?.config ?? {}) as Record<string, string>).aiAgentId ?? null;
    const agents = await this.prisma.voiceAgent.findMany({ where: { organizationId: org, status: 'active' }, select: { id: true, name: true, knowledgeBaseId: true }, orderBy: { name: 'asc' } });
    const current = id ? await this.prisma.voiceAgent.findFirst({ where: { id, organizationId: org }, select: { id: true, name: true, status: true } }) : null;
    return { connected: Boolean(row), enabled: Boolean(row?.enabled), aiAgentId: id, current, agents, active: Boolean(current && current.status === 'active') };
  }

  /** Choose (or clear with null) the agent that answers. Only an active (published) agent of this organization. */
  async setAgent(actor: Actor, agentId: unknown) {
    const row = await this.prisma.integrationCredential.findFirst({ where: { organizationId: actor.org, provider: 'meta_social' } });
    if (!row) throw new BadRequestException('Connect Instagram & Messenger first.');
    let id: string | null = null;
    if (agentId) {
      const a = await this.prisma.voiceAgent.findFirst({ where: { id: String(agentId), organizationId: actor.org } });
      if (!a) throw new NotFoundException('Agent not found.');
      if (a.status !== 'active') throw new BadRequestException('Publish the agent first: only a tested, published agent may answer customers.');
      id = a.id;
    }
    const cfg = { ...((row.config ?? {}) as Record<string, string>) };
    if (id) cfg.aiAgentId = id;
    else delete cfg.aiAgentId;
    await this.prisma.integrationCredential.update({ where: { id: row.id }, data: { config: cfg } });
    this.creds.invalidate(actor.org, 'meta_social');
    await this.prisma.auditEvent.create({ data: { organizationId: actor.org, actor: `user:${actor.sub}`, entityType: 'integration', entityId: 'meta_social', action: id ? 'social.ai_agent_set' : 'social.ai_agent_cleared', data: id ? { agentId: id } : {} } });
    return this.settings(actor.org);
  }

  /**
   * Answers one inbound message (the caller holds the per-person lock and has stored the message). Returns what was
   * done, for logs and tests.
   */
  async answer(org: string, channel: SocialChannel, conv: Conversation, customer: Customer, from: string, text: string, inboundMessageId: string, agent: VoiceAgent): Promise<'sent' | 'held' | 'handoff' | 'skipped'> {
    if (!text) {
      await this.handoff(conv.id, 'Customer sent an attachment: the AI reads text only, so the team takes over.');
      return 'handoff';
    }
    const recent = await this.prisma.message.findMany({
      where: { conversationId: conv.id, organizationId: org, role: { in: ['user', 'assistant'] }, id: { not: inboundMessageId }, OR: [{ deliveryStatus: null }, { deliveryStatus: { notIn: ['held', 'discarded'] } }] },
      orderBy: { createdAt: 'desc' },
      take: HISTORY,
      select: { role: true, content: true },
    });
    const history: ChatTurn[] = recent.reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const r = await this.agents.converse(org, agent, { message: text, history, guidance: activeGuidance(conv) }, 'social');
    const gap = isKnowledgeGap(agent.fallbackMessage, r);
    const handoffReason = r.escalate ? 'Customer asked for a person (Instagram / Messenger AI handed over).' : gap ? 'The AI could not answer from its knowledge base; the team takes over.' : null;
    const meta = { ai: { agentId: agent.id, source: r.source, sources: r.sources, channel } };

    if (conv.aiMode === 'review') {
      const held = await this.conversations.addMessage({ organizationId: org, conversationId: conv.id, role: 'assistant', content: r.reply, metadata: meta as never });
      await this.prisma.message.update({ where: { id: held.id }, data: { deliveryStatus: 'held', deliveryUpdatedAt: new Date(), metadata: { ...meta, review: { status: 'pending' } } as never } });
      if (handoffReason) await this.handoff(conv.id, handoffReason);
      return 'held';
    }

    const sent = await this.sender.send(org, channel, from, customer.isDemo, r.reply);
    const msg = await this.conversations.addMessage({
      organizationId: org,
      conversationId: conv.id,
      role: 'assistant',
      content: r.reply,
      ...(sent.messageId ? { externalId: sent.messageId } : {}),
      metadata: { ...meta, ...(sent.sent || sent.error ? {} : { simulated: true, notSentReason: sent.notSentReason }) } as never,
    });
    const deliveryStatus = sent.sent ? 'accepted' : sent.error ? (sent.ambiguous ? 'unknown' : 'failed') : null;
    await this.prisma.message.update({ where: { id: msg.id }, data: { deliveryStatus, deliveryError: sent.error?.slice(0, 500) ?? null, deliveryUpdatedAt: new Date() } }).catch(() => undefined);
    if (sent.error) {
      // Not retried automatically (an ambiguous send may have reached the customer): a person follows up.
      await this.handoff(conv.id, `The AI reply was not accepted by Meta (${sent.ambiguous ? 'delivery unknown' : 'failed'}): the team takes over.`);
      log.warn('social.ai_send_failed', { channel, conversationId: conv.id });
      return 'handoff';
    }
    if (handoffReason) {
      await this.handoff(conv.id, handoffReason);
      return 'handoff';
    }
    return 'sent';
  }

  private async handoff(conversationId: string, reason: string) {
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { aiEnabled: false, status: 'human_handoff', handoffReason: reason, handoffAt: new Date(), inboxStatus: 'open' } });
  }
}
