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
import { MAX_CASES, diffSnapshots, evaluateTurn, snapshotOf, validateTestCase, type Snapshot, type TestTurn, type TurnResult } from './agent-tests.js';
import { TEMPLATES, templateByKey, templatePassages, type Template } from './templates.js';
import { assertPlanAllows } from '../billing/entitlements.js';

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
    await assertPlanAllows(this.prisma, actor.org, 'voiceAgents');
    if (d.knowledgeBaseId) await this.assertBase(actor.org, d.knowledgeBaseId as string);
    const agent = await this.prisma.voiceAgent.create({
      data: {
        organizationId: actor.org,
        telephonyProvider: 'sarvam', // the only provider (Plivo removed); the column's old default was 'plivo'
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
    // Publish policy only (no change to what the agent says): no new test needed.
    if (body.requireTestsToPublish !== undefined && Object.keys(body).length === 1) {
      await this.prisma.voiceAgent.update({ where: { id }, data: { requireTestsToPublish: body.requireTestsToPublish === true } });
      await this.audit(actor, id, 'agent.publish_policy', { requireTestsToPublish: body.requireTestsToPublish === true });
      return this.get(actor.org, id);
    }
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
  async publish(actor: Actor, id: string, body: { note?: unknown } = {}) {
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
    if (((a.inbound as { enabled?: boolean } | null)?.enabled || (a.outbound as { enabled?: boolean } | null)?.enabled) && !a.sarvamAppId) {
      problems.push('Calls through Sarvam need the Sarvam agent (app) id.');
    }
    const inbound = a.inbound as { enabled?: boolean; phoneNumber?: string } | null;
    if (inbound?.enabled && inbound.phoneNumber) {
      const clash = await this.prisma.voiceAgent.findFirst({ where: { organizationId: actor.org, status: 'active', id: { not: id }, inbound: { path: '$.phoneNumber', equals: inbound.phoneNumber } } });
      if (clash) problems.push(`Another active agent (${clash.name}) already answers ${inbound.phoneNumber}.`);
    }
    // Saved test cases as a publish gate, when the agent asks for it.
    let testSummary: { total: number; passed: number; failed: number } | null = null;
    if (a.requireTestsToPublish && !problems.length) {
      const r = await this.runTests(actor, id);
      testSummary = { total: r.total, passed: r.passed, failed: r.failed };
      if (!r.total) problems.push('Add at least one test case: this agent requires passing tests to publish.');
      for (const c of r.cases.filter((x) => !x.ok)) problems.push(`Test "${c.name}" failed: ${c.turns.flatMap((t) => t.checks.filter((k) => !k.ok).map((k) => k.check)).slice(0, 3).join('; ')}.`);
    }
    if (problems.length) throw new BadRequestException({ statusCode: 400, message: 'The agent cannot be published yet.', problems });
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null;
    // A numbered version of exactly what was published (retried once if two publishes race for the same number).
    let version = 0;
    for (let attempt = 0; attempt < 2 && !version; attempt++) {
      const last = await this.prisma.agentVersion.findFirst({ where: { agentId: id }, orderBy: { version: 'desc' }, select: { version: true } });
      try {
        await this.prisma.agentVersion.create({ data: { organizationId: actor.org, agentId: id, version: (last?.version ?? 0) + 1, snapshot: snapshotOf(a as unknown as Record<string, unknown>) as Prisma.InputJsonValue, note, publishedBy: actor.sub, ...(testSummary ? { testSummary } : {}) } });
        version = (last?.version ?? 0) + 1;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
    await this.prisma.voiceAgent.update({ where: { id }, data: { status: 'active', publishedAt: new Date(), archivedAt: null } });
    await this.audit(actor, id, 'agent.published', { version, note: Boolean(note) });
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
    await assertPlanAllows(this.prisma, actor.org, 'voiceAgents');
    await this.prisma.voiceAgent.update({ where: { id }, data: { status: 'draft', archivedAt: null, lastTestedAt: null } });
    await this.audit(actor, id, 'agent.restored', {});
    return this.get(actor.org, id);
  }

  // ------------------------------------------------------------------------------------- versions
  async versions(organizationId: string, id: string) {
    await this.get(organizationId, id);
    const rows = await this.prisma.agentVersion.findMany({ where: { agentId: id, organizationId }, orderBy: { version: 'desc' } });
    return rows.map((v) => ({ id: v.id, version: v.version, note: v.note, publishedBy: v.publishedBy, testSummary: v.testSummary, createdAt: v.createdAt }));
  }

  /** Differences between a version and another version, or the current (possibly unpublished) configuration. */
  async diff(organizationId: string, id: string, from: string, to: string) {
    const a = await this.get(organizationId, id);
    const snap = async (v: string): Promise<Snapshot> => {
      if (v === 'current') return snapshotOf(a as unknown as Record<string, unknown>);
      const row = await this.prisma.agentVersion.findFirst({ where: { agentId: id, organizationId, version: Number(v) } });
      if (!row) throw new NotFoundException(`Version ${v} not found.`);
      return row.snapshot as Snapshot;
    };
    return { from, to, changes: diffSnapshots(await snap(from), await snap(to)) };
  }

  /** Restores a version's configuration. Like any edit, the agent must be tested (and published) again. */
  async rollback(actor: Actor, id: string, version: number) {
    const a = await this.get(actor.org, id);
    if (a.status === 'archived') throw new ConflictException('Restore the agent before editing it.');
    const row = await this.prisma.agentVersion.findFirst({ where: { agentId: id, organizationId: actor.org, version } });
    if (!row) throw new NotFoundException(`Version ${version} not found.`);
    const snap = row.snapshot as Record<string, unknown>;
    if (snap.knowledgeBaseId) await this.assertBase(actor.org, String(snap.knowledgeBaseId)).catch(() => (snap.knowledgeBaseId = null));
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(snap)) data[k] = v === null && ['voice', 'inbound', 'outbound', 'businessHours', 'escalation', 'callLimits'].includes(k) ? Prisma.DbNull : v;
    await this.prisma.voiceAgent.update({ where: { id }, data: { ...(data as Prisma.VoiceAgentUncheckedUpdateInput), lastTestedAt: null } });
    await this.audit(actor, id, 'agent.rolled_back', { version });
    return this.get(actor.org, id);
  }

  // ------------------------------------------------------------------------------------- test cases
  async listTests(organizationId: string, id: string) {
    await this.get(organizationId, id);
    return this.prisma.agentTestCase.findMany({ where: { agentId: id, organizationId }, orderBy: { createdAt: 'asc' } });
  }

  async createTest(actor: Actor, id: string, body: Record<string, unknown>) {
    await this.get(actor.org, id);
    if ((await this.prisma.agentTestCase.count({ where: { agentId: id } })) >= MAX_CASES) throw new BadRequestException(`At most ${MAX_CASES} test cases per agent.`);
    const v = validateTestCase(body);
    if (Object.keys(v.errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please fix the test case.', errors: v.errors });
    try {
      return await this.prisma.agentTestCase.create({ data: { organizationId: actor.org, agentId: id, name: v.value.name, lang: v.value.lang, turns: v.value.turns as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ message: 'A test with this name already exists.', errors: { name: 'Name already used' } });
      throw e;
    }
  }

  async updateTest(actor: Actor, id: string, testId: string, body: Record<string, unknown>) {
    const t = await this.prisma.agentTestCase.findFirst({ where: { id: testId, agentId: id, organizationId: actor.org } });
    if (!t) throw new NotFoundException('Test case not found.');
    const v = validateTestCase({ name: t.name, lang: t.lang, turns: t.turns, ...body });
    if (Object.keys(v.errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please fix the test case.', errors: v.errors });
    return this.prisma.agentTestCase.update({ where: { id: t.id }, data: { name: v.value.name, lang: v.value.lang, turns: v.value.turns as unknown as Prisma.InputJsonValue, lastResult: Prisma.DbNull, lastRunAt: null } });
  }

  async deleteTest(actor: Actor, id: string, testId: string) {
    const r = await this.prisma.agentTestCase.deleteMany({ where: { id: testId, agentId: id, organizationId: actor.org } });
    if (!r.count) throw new NotFoundException('Test case not found.');
    return { ok: true };
  }

  /**
   * Runs every saved test case through the same engine, instructions, knowledge base and model as live conversations
   * (nothing is sent to anyone; with an AI model configured, each turn is a real model call). A full run counts as
   * testing the agent.
   */
  async runTests(actor: Actor, id: string) {
    const agent = await this.get(actor.org, id);
    const cases = await this.prisma.agentTestCase.findMany({ where: { agentId: id, organizationId: actor.org }, orderBy: { createdAt: 'asc' } });
    const out: Array<{ id: string; name: string; ok: boolean; turns: TurnResult[] }> = [];
    for (const c of cases) {
      const history: ChatTurn[] = [];
      const turns: TurnResult[] = [];
      for (const t of c.turns as unknown as TestTurn[]) {
        const r = await this.converse(actor.org, agent, { message: t.message, history: [...history], lang: c.lang ?? undefined });
        const checks = evaluateTurn(t.expect, r);
        turns.push({ message: t.message, reply: r.reply, source: r.source, escalate: r.escalate, checks, ok: checks.every((k) => k.ok) });
        history.push({ role: 'user', content: t.message }, { role: 'assistant', content: r.reply });
      }
      const ok = turns.every((t) => t.ok);
      await this.prisma.agentTestCase.update({ where: { id: c.id }, data: { lastResult: { ok, turns } as unknown as Prisma.InputJsonValue, lastRunAt: new Date() } });
      out.push({ id: c.id, name: c.name, ok, turns });
    }
    if (out.length) await this.prisma.voiceAgent.update({ where: { id }, data: { lastTestedAt: new Date() } });
    const passed = out.filter((c) => c.ok).length;
    await this.audit(actor, id, 'agent.tests_run', { total: out.length, passed });
    return { total: out.length, passed, failed: out.length - passed, cases: out };
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
