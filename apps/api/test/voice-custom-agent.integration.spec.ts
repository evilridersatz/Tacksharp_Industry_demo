/**
 * Phone calls answered by a custom agent (Agent Builder) on the Plivo path, against the real database: the agent's
 * greeting opens the call, every turn is answered by the shared engine from the agent's knowledge base, the
 * transcript is saved, escalation ends the call with a handoff, duplicates are absorbed, and a number WITHOUT a
 * custom agent still goes to the built-in engine (GR Chicken and existing tenants unchanged). No provider is called.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
  process.env.KNOWLEDGE_DIR = `/tmp/ts-kb-voice-${process.pid}`;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
}
const run = Date.now().toString(36);
const ORG = `org_vca_${run}`;
const AGENT_NUMBER = `9144${String(Date.now()).slice(-8)}`;
const PLAIN_NUMBER = `9145${String(Date.now()).slice(-8)}`;

describe.skipIf(!enabled)('custom agent on phone calls (integration)', () => {
  let prisma: any, voice: any, ai: any, agent: any;
  const pending: Promise<unknown>[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { TenancyService } = await import('../src/tenancy/tenancy.service.js');
    const { KnowledgeService } = await import('../src/knowledge/knowledge.service.js');
    const { VoiceAgentsService } = await import('../src/voice-agents/voice-agents.service.js');
    const { VoiceService } = await import('../src/voice/voice.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.organization.create({ data: { id: ORG, name: 'Agent Calls Test', vertical: 'real_estate' } });
    await prisma.organizationChannel.createMany({ data: [{ organizationId: ORG, kind: 'plivo_number', externalId: AGENT_NUMBER }, { organizationId: ORG, kind: 'plivo_number', externalId: PLAIN_NUMBER }] });
    const kb = new KnowledgeService(prisma);
    kb.processInline = true;
    const agents = new VoiceAgentsService(prisma, kb);
    const base = await kb.createBase(ORG, 'Shop facts');
    await kb.upload(ORG, base.id, { originalname: 'facts.txt', buffer: Buffer.from('Broiler Chicken costs Rs 240 per kg.\nWe are open 6 AM to 9 PM every day.\n') }, 'user:t');
    agent = await prisma.voiceAgent.create({ data: { organizationId: ORG, name: 'Phone desk', industry: 'restaurant', instructions: 'Answer price and timing questions.', languages: ['ta', 'en'], greeting: 'Vanakkam! Phone desk here.', fallbackMessage: 'I will check with the team.', knowledgeBaseId: base.id, inbound: { enabled: true, phoneNumber: AGENT_NUMBER }, escalation: { keywords: ['manager'], handoffMessage: 'Our manager will call you back.' }, status: 'active' } });
    const sarvam = { enabled: true, keyterms: [], textToSpeechUrl: vi.fn(async () => 'https://example.test/voice/audio/g.wav'), textToSpeech: vi.fn(async () => ({ url: 'https://example.test/voice/audio/r.wav', cached: false, attempts: 0 })), speechToText: vi.fn(), deleteAudio: vi.fn(async () => undefined) };
    ai = {
      generateResponse: vi.fn(async () => ({ response: 'built-in engine reply', actions: {}, path: 'rules' })),
      openCallSession: vi.fn(async () => ({ key: 'k', conversationId: (await prisma.conversation.create({ data: { id: `conv_${run}`, organizationId: ORG, channel: 'voice', externalId: 'x', updatedAt: new Date() } })).id })),
      openRestaurantCall: vi.fn(),
      // Like the real engine: background work for one call runs in order.
      background: (_k: string, work: () => Promise<unknown>) => { chain = chain.then(() => work().catch(() => undefined)); pending.push(chain); },
      voiceSessionKey: (o: string, c: string) => `voice:${o}:${c}`,
      prefetch: vi.fn(),
    };
    const leads = { ensureActiveLead: vi.fn(async (org: string, customerId: string) => prisma.lead.create({ data: { organizationId: org, customerId, source: 'voice_inbound' } })) };
    voice = new VoiceService(prisma, ai, new ConversationsService(prisma), leads as any, { settingsFor: vi.fn() } as any, sarvam as any, new TenancyService(prisma), undefined, agents);
    (voice as any).client = { calls: { create: vi.fn(), hangup: vi.fn() } };
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await Promise.all(pending);
    await prisma.organizationChannel.deleteMany({ where: { organizationId: ORG } });
    await prisma.organization.deleteMany({ where: { id: ORG } });
    await prisma.$disconnect();
  });

  it('inbound to the agent number: the agent greeting answers, the call is linked to the agent, retries absorbed', async () => {
    const params = { From: '919811122233', To: AGENT_NUMBER, CallUUID: `uuid-${run}` };
    const xml = await voice.answerInbound(params);
    expect(xml).toContain('https://example.test/voice/audio/g.wav');
    expect(await voice.answerInbound(params)).toBe(xml);
    const calls = await prisma.call.findMany({ where: { organizationId: ORG, providerCallId: `uuid-${run}` } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agentId: agent.id, provider: 'plivo', direction: 'inbound' });
    expect(ai.openCallSession).not.toHaveBeenCalled();
  });

  it('turns are answered by the shared engine from the knowledge base; the built-in engine is not used', async () => {
    const call = await prisma.call.findFirst({ where: { organizationId: ORG, providerCallId: `uuid-${run}` } });
    const rt = (voice as any).calls.get(call.id);
    const d = await voice.understand(rt, 'what is the broiler chicken price per kg', 'en-IN', 2500);
    expect(d.kind).toBe('reply');
    expect(d.finalText).toMatch(/240/);
    expect(d.end).toBe(false);
    expect(ai.generateResponse).not.toHaveBeenCalled();
    const d2 = await voice.understand(rt, 'what are your opening hours', 'en-IN', 2500);
    expect(d2.finalText).toMatch(/6 AM to 9 PM/);
    await Promise.all(pending);
    const msgs = await prisma.message.findMany({ where: { organizationId: ORG, metadata: { path: '$.callId', equals: call.id } }, orderBy: { createdAt: 'asc' } });
    expect(msgs.map((m: any) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(msgs[2].metadata.sources[0]).toMatchObject({ filename: 'facts.txt' });
  });

  it('escalation keyword: handoff message and the call ends with reason handoff', async () => {
    const call = await prisma.call.findFirst({ where: { organizationId: ORG, providerCallId: `uuid-${run}` } });
    const rt = (voice as any).calls.get(call.id);
    const d = await voice.understand(rt, 'I want to speak to the manager now', 'en-IN', 2500);
    expect(d).toMatchObject({ kind: 'reply', end: true, finalText: 'Our manager will call you back.' });
    expect(rt.endReason).toBe('handoff');
  });

  it('a number without a custom agent keeps the built-in industry engine', async () => {
    await voice.answerInbound({ From: '919811122244', To: PLAIN_NUMBER, CallUUID: `uuid2-${run}` });
    expect(ai.openCallSession).toHaveBeenCalledTimes(1);
    const call = await prisma.call.findFirst({ where: { organizationId: ORG, providerCallId: `uuid2-${run}` } });
    expect(call.agentId).toBeNull();
  });
});
