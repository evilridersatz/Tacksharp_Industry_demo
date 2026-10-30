import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, type VoiceAgent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { providerCredentials } from '../integrations/provider-scope.js';
import { log } from '../common/logger.js';
import type { Style } from '../assistant/knowledge.js';
import { AgentEngine, type AgentSpec, type ChatTurn, type ModelAccess } from './agent-engine.js';
import { validateAgent } from './agent-validation.js';
import { TEMPLATES, templateByKey, templatePassages, type Template } from './templates.js';

type Actor = { sub: string; org: string };

export function specOf(a: Pick<VoiceAgent, 'name' | 'instructions' | 'greeting' | 'fallbackMessage' | 'languages' | 'escalation' | 'businessHours'>): AgentSpec {
  return {
    name: a.name,
    instructions: a.instructions,
    greeting: a.greeting,
    fallbackMessage: a.fallbackMessage,
    languages: (a.languages as string[]) ?? ['ta', 'en', 'tanglish'],
    escalation: (a.escalation as AgentSpec['escalation']) ?? null,
    businessHours: (a.businessHours as AgentSpec['businessHours']) ?? null,
  };
}

export function templateSpec(t: Template): AgentSpec {
  return { name: t.title, instructions: t.instructions, greeting: t.greeting, fallbackMessage: t.fallbackMessage, languages: t.languages, escalation: { keywords: t.escalationKeywords, handoffMessage: 'Sari, oru team member ungalukku call back pannuvaanga. (Demo: no real call is placed.)' } };
}

/** The platform model for public demos (server env only), or the organization's own resolved OpenAI account. */
export async function modelFor(organizationId: string | null): Promise<ModelAccess> {
  const baseUrl = process.env.OPENAI_BASE_URL || undefined;
  const envModel = process.env.OPENAI_AGENT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const effort = process.env.OPENAI_AGENT_REASONING_EFFORT || undefined;
  if (!organizationId) {
    const key = process.env.OPENAI_API_KEY ?? '';
    return key || baseUrl ? { apiKey: key, model: envModel, baseUrl, reasoningEffort: effort } : null;
  }
  const c = await providerCredentials('openai', organizationId);
  if (c.source === 'none') return null;
  const apiKey = c.secrets.apiKey ?? '';
  if (!apiKey && !baseUrl) return null;
  return { apiKey, model: c.source === 'organization' ? c.config.model || envModel : envModel, baseUrl, reasoningEffort: effort };
}

@Injectable()
export class VoiceAgentsService {
  readonly engine = new AgentEngine();

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    @Optional() private readonly tenancy?: TenancyService,
  ) {}

  list(organizationId: string) {
    return this.prisma.voiceAgent.findMany({ where: { organizationId }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], include: { knowledgeBase: { select: { id: true, name: true } } } });
  }

  async get(organizationId: string, id: string) {
    const a = await this.prisma.voiceAgent.findFirst({ where: { id, organizationId }, include: { knowledgeBase: { select: { id: true, name: true } } } });
    if (!a) throw new NotFoundException('Agent not found');
    return a;
  }

  async create(actor: Actor, body: Record<string, unknown>) {
    const tpl = typeof body.templateKey === 'string' ? templateByKey(body.templateKey) : undefined;
    if (body.templateKey !== undefined && !tpl) throw new BadRequestException('Unknown template.');
    const merged = tpl
      ? {
          name: tpl.title, industry: tpl.industry, useCase: tpl.useCase, description: tpl.scenario, instructions: tpl.instructions, greeting: tpl.greeting,
          fallbackMessage: tpl.fallbackMessage, languages: tpl.languages, escalation: { keywords: tpl.escalationKeywords, handoffMessage: 'A team member will call you back shortly.' },
          ...body,
        }
      : body;
    const d = validateAgent(merged as Record<string, unknown>, true);
    if (d.knowledgeBaseId) await this.assertBase(actor.org, d.knowledgeBaseId as string);
    const agent = await this.prisma.voiceAgent.create({
      data: {
        organizationId: actor.org,
        templateKey: tpl?.key ?? null,
        createdBy: actor.sub,
        callLimits: { maxCallSeconds: 300, maxConcurrent: 2, dailyLimit: 50 },
        ...(d as Omit<Prisma.VoiceAgentUncheckedCreateInput, 'organizationId'>),
        status: 'draft',
      },
    });
    // From a template: a knowledge base with the template's SAMPLE knowledge, processed like any upload, so the
    // owner can see the format, then replace it with their own documents.
    if (tpl && !d.knowledgeBaseId) {
      const kb = await this.knowledge.createBase(actor.org, `${tpl.title} (sample knowledge)`);
      await this.knowledge.upload(actor.org, kb.id, { originalname: `${tpl.key}-sample.txt`, buffer: Buffer.from(`SAMPLE DATA - replace with your own.\n${tpl.knowledge}\n`) }, `user:${actor.sub}`);
      await this.prisma.voiceAgent.update({ where: { id: agent.id }, data: { knowledgeBaseId: kb.id } });
    }
    await this.audit(actor, agent.id, 'agent.created', { templateKey: tpl?.key ?? null });
    return this.get(actor.org, agent.id);
  }

  async update(actor: Actor, id: string, body: Record<string, unknown>) {
    const existing = await this.get(actor.org, id);
    if (existing.status === 'archived') throw new ConflictException('Restore the agent before editing it.');
    const d = validateAgent(body, false);
    if (d.knowledgeBaseId) await this.assertBase(actor.org, d.knowledgeBaseId as string);
    // Any change to what the agent says needs a new test before (re)publishing; an active agent stays active but
    // the dashboard shows "changed since last test".
    await this.prisma.voiceAgent.update({ where: { id }, data: { ...(d as Prisma.VoiceAgentUncheckedUpdateInput), lastTestedAt: null } });
    await this.audit(actor, id, 'agent.updated', { fields: Object.keys(d) });
    return this.get(actor.org, id);
  }

  /** Test mode: a real conversation turn against the agent's instructions and knowledge base (no call, no message). */
  async test(actor: Actor, id: string, body: { message?: unknown; history?: unknown; lang?: unknown }) {
    const agent = await this.get(actor.org, id);
    const r = await this.converse(actor.org, agent, body);
    await this.prisma.voiceAgent.update({ where: { id }, data: { lastTestedAt: new Date() } });
    return r;
  }

  async converse(organizationId: string, agent: VoiceAgent, body: { message?: unknown; history?: unknown; lang?: unknown }) {
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) throw new BadRequestException('Type or say something first.');
    const lang = ['ta', 'en', 'tanglish'].includes(String(body.lang)) ? (body.lang as Style) : null;
    return this.engine.reply({
      spec: specOf(agent),
      message,
      history: Array.isArray(body.history) ? (body.history as ChatTurn[]) : [],
      lang,
      search: (q) => this.knowledge.search(organizationId, agent.knowledgeBaseId, q),
      model: await modelFor(organizationId),
    });
  }

  /** Used by phone calls handled by a custom agent (Plivo path). */
  async replyForCall(organizationId: string, agentId: string, message: string, history: ChatTurn[]) {
    const agent = await this.prisma.voiceAgent.findFirst({ where: { id: agentId, organizationId } });
    if (!agent) return null;
    return this.converse(organizationId, agent, { message, history });
  }

  /** Public template demo: sample knowledge only, the platform model, nothing stored, labelled simulated. */
  async demo(key: string, body: { message?: unknown; history?: unknown; lang?: unknown }) {
    const t = templateByKey(key);
    if (!t) throw new NotFoundException('Unknown demo.');
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) throw new BadRequestException('Type or say something first.');
    const { bm25 } = await import('../knowledge/text.js');
    const passages = templatePassages(t);
    const r = await this.engine.reply({
      spec: templateSpec(t),
      message,
      history: Array.isArray(body.history) ? (body.history as ChatTurn[]) : [],
      lang: ['ta', 'en', 'tanglish'].includes(String(body.lang)) ? (body.lang as Style) : null,
      search: async (q) => bm25(q, passages, 3),
      model: await modelFor(null),
    });
    return { ...r, simulated: true };
  }

  templates() {
    return TEMPLATES.map((t) => ({ key: t.key, industry: t.industry, title: t.title, businessName: t.businessName, scenario: t.scenario, useCase: t.useCase, greeting: t.greeting, languages: t.languages, exampleQuestions: t.exampleQuestions, expectedOutcome: t.expectedOutcome, instructions: t.instructions, knowledge: t.knowledge }));
  }

  /**
   * draft -> active. Requires: a test conversation since the last edit; an attached knowledge base fully indexed;
   * a Sarvam agent id when Sarvam places the calls; an inbound number that this organization owns.
   */
  async publish(actor: Actor, id: string) {
    const a = await this.get(actor.org, id);
    if (a.status === 'archived') throw new ConflictException('Restore the agent first.');
    const problems: string[] = [];
    if (!a.lastTestedAt) problems.push('Test the agent (Test step) after your latest changes.');
    if (a.knowledgeBaseId) {
      const r = await this.knowledge.readiness(actor.org, a.knowledgeBaseId);
      if (r.pending) problems.push(`${r.pending} document(s) are still processing.`);
      if (r.failed) problems.push(`${r.failed} document(s) failed: retry or remove them.`);
      if (!r.indexed) problems.push('The knowledge base has no indexed document.');
    }
    if (a.telephonyProvider === 'sarvam' && ((a.inbound as { enabled?: boolean } | null)?.enabled || (a.outbound as { enabled?: boolean } | null)?.enabled) && !a.sarvamAppId) {
      problems.push('Calls through Sarvam need the Sarvam agent (app) id.');
    }
    const inbound = a.inbound as { enabled?: boolean; phoneNumber?: string } | null;
    if (inbound?.enabled && inbound.phoneNumber) {
      if (a.telephonyProvider === 'plivo' && this.tenancy) {
        const owner = await this.tenancy.resolve('plivo_number', inbound.phoneNumber).catch(() => undefined);
        if (owner !== actor.org) problems.push('The inbound number is not routed to this organization (Settings → Integrations → Plivo → Numbers).');
      }
      const clash = await this.prisma.voiceAgent.findFirst({ where: { organizationId: actor.org, status: 'active', id: { not: id }, inbound: { path: '$.phoneNumber', equals: inbound.phoneNumber } } });
      if (clash) problems.push(`Another active agent (${clash.name}) already answers ${inbound.phoneNumber}.`);
    }
    if (problems.length) throw new BadRequestException({ statusCode: 400, message: 'The agent cannot be published yet.', problems });
    await this.prisma.voiceAgent.update({ where: { id }, data: { status: 'active', publishedAt: new Date(), archivedAt: null } });
    await this.audit(actor, id, 'agent.published', {});
    log.info('agent.published', { agentId: id });
    return this.get(actor.org, id);
  }

  async archive(actor: Actor, id: string) {
    await this.get(actor.org, id);
    await this.prisma.voiceAgent.update({ where: { id }, data: { status: 'archived', archivedAt: new Date() } });
    await this.audit(actor, id, 'agent.archived', {});
    return this.get(actor.org, id);
  }

  async restore(actor: Actor, id: string) {
    const a = await this.get(actor.org, id);
    if (a.status !== 'archived') return a;
    await this.prisma.voiceAgent.update({ where: { id }, data: { status: 'draft', archivedAt: null, lastTestedAt: null } });
    await this.audit(actor, id, 'agent.restored', {});
    return this.get(actor.org, id);
  }

  /** The active custom agent that answers a dialled number for this organization, if any. */
  async inboundAgent(organizationId: string, dialled: string) {
    return this.prisma.voiceAgent.findFirst({ where: { organizationId, status: 'active', inbound: { path: '$.phoneNumber', equals: dialled } } });
  }

  private async assertBase(organizationId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findFirst({ where: { id, organizationId } });
    if (!kb) throw new BadRequestException({ statusCode: 400, message: 'Please correct the highlighted fields.', fields: { knowledgeBaseId: 'Unknown knowledge base.' } });
  }

  private audit(actor: Actor, entityId: string, action: string, data: Record<string, unknown>) {
    return this.prisma.auditEvent.create({ data: { organizationId: actor.org, actor: `user:${actor.sub}`, entityType: 'voice_agent', entityId, action, data: data as Prisma.InputJsonValue } });
  }
}
