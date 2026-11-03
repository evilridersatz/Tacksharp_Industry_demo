/**
 * AI replies on Instagram / Messenger, DB-backed (real MySQL TEST database, credential encryption, Redis lock, the real
 * knowledge base and agent engine without an AI model; Meta's Graph API is a fake fetch). Proves: choosing the agent
 * (only a published agent of this organization; clearing it); with an agent, a signed message gets a grounded reply
 * (simulated in DRY_RUN, sent live only to an approved test id, exact Graph request); a question the knowledge cannot
 * answer and a request for a person hand over to the team (and the question shows in the knowledge studio), after
 * which the AI stays quiet; attachments hand over; STOP wins over the AI; a send Meta refuses hands over; review mode
 * holds the reply and approving sends it on the channel; return to AI needs an agent; without an agent nothing changes.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.CREDENTIALS_KEYS = `t1:${randomBytes(32).toString('base64')}`;
  process.env.CREDENTIALS_ACTIVE_KEY = 't1';
  process.env.KNOWLEDGE_DIR = `/tmp/ts-kb-socialai-${process.pid}`;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
}
const run = Date.now().toString(36);
const ORG = `org_sai_a_${run}`;
const ORG_B = `org_sai_b_${run}`;
const digits = String(Date.now()).slice(-9);
const PAGE = `93${digits}`;
const SECRET = `appsecret${run}abcdef`;
let n = 0;

describe.skipIf(!enabled)('AI replies on Instagram / Messenger (integration)', () => {
  let prisma: any, creds: any, integrations: any, conversations: any, inbox: any, social: any, hook: any, controller: any, ai: any, agents: any, admin: any, agent: any, draftAgent: any, kbBase: any;
  const actor = () => ({ sub: admin.id, org: ORG, role: 'admin' });
  const calls: Array<{ url: string; body: any }> = [];
  let reply: () => Response = () => new Response('{}', { status: 500 });
  const fakeFetch = async (url: string, init: any = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return reply();
  };
  const user = () => `3${digits}${String(n++).padStart(3, '0')}`;
  const post = async (from: string, message: Record<string, unknown>) => {
    const body = { object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: PAGE }, timestamp: Date.now(), message }] }] };
    const raw = Buffer.from(JSON.stringify(body));
    return controller.receive({ rawBody: raw } as any, `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`, JSON.parse(raw.toString()));
  };
  const text = (from: string, t: string) => post(from, { mid: `m.${run}.${n++}`, text: t });
  const convOf = (from: string) => prisma.conversation.findFirst({ where: { organizationId: ORG, channel: 'messenger', externalId: from }, include: { Message: { orderBy: { createdAt: 'asc' } } } });
  const live = async (from: string, fn: () => Promise<void>) => {
    const prev = { dry: process.env.DRY_RUN, ids: process.env.LIVE_TEST_SOCIAL_IDS };
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_SOCIAL_IDS = from;
    try { await fn(); } finally {
      process.env.DRY_RUN = prev.dry ?? 'true';
      if (prev.ids === undefined) delete process.env.LIVE_TEST_SOCIAL_IDS; else process.env.LIVE_TEST_SOCIAL_IDS = prev.ids;
    }
  };

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { CredentialsService } = await import('../src/integrations/credentials.service.js');
    const { IntegrationsService } = await import('../src/integrations/integrations.service.js');
    const { TenancyService } = await import('../src/tenancy/tenancy.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { InboxService } = await import('../src/inbox/inbox.service.js');
    const { SocialSenderService } = await import('../src/social/social-sender.service.js');
    const { SocialWebhookService } = await import('../src/social/social-webhook.service.js');
    const { SocialAiService } = await import('../src/social/social-ai.service.js');
    const { SocialController } = await import('../src/social/social.controller.js');
    const { KnowledgeService } = await import('../src/knowledge/knowledge.service.js');
    const { VoiceAgentsService } = await import('../src/voice-agents/voice-agents.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [ORG, ORG_B]) await prisma.organization.create({ data: { id, name: `Social AI ${id}`, vertical: 'restaurant' } });
    admin = await prisma.user.create({ data: { organizationId: ORG, email: `sai-admin-${run}@example.test`, name: 'Admin', passwordHash: 'x', role: 'admin' } });
    creds = new CredentialsService(prisma);
    creds.onModuleInit();
    integrations = new IntegrationsService(prisma, creds);
    integrations.fetchImpl = fakeFetch;
    conversations = new ConversationsService(prisma);
    social = new SocialSenderService(prisma, creds);
    social.fetchImpl = fakeFetch;
    inbox = new InboxService(prisma, conversations, { sendText: async () => 'x' } as any, social);
    const kb = new KnowledgeService(prisma);
    kb.processInline = true;
    agents = new VoiceAgentsService(prisma, kb);
    ai = new SocialAiService(prisma, creds, agents, conversations, social);
    hook = new SocialWebhookService(prisma, new TenancyService(prisma), conversations, creds, social, inbox, ai);
    controller = new SocialController(hook);

    kbBase = await kb.createBase(ORG, 'Shop');
    await kb.upload(ORG, kbBase.id, { originalname: 'menu.txt', buffer: Buffer.from('Broiler chicken costs Rs 240 per kg.\nThe Velachery outlet closes at 8 PM.') }, 'user:a');
    agent = await agents.create({ sub: admin.id, org: ORG }, { name: `Chat desk ${run}`, industry: 'restaurant', instructions: 'Answer chicken price and timing questions.', greeting: 'Vanakkam!', fallbackMessage: 'Let me check with the team.', knowledgeBaseId: kbBase.id, escalation: { keywords: ['manager'], handoffMessage: 'A team member will reply here shortly.' } });
    await prisma.voiceAgent.update({ where: { id: agent.id }, data: { status: 'active' } });
    draftAgent = await agents.create({ sub: admin.id, org: ORG }, { name: `Draft ${run}`, industry: 'restaurant', instructions: 'Not published yet, answers nothing.', greeting: 'Hi', fallbackMessage: 'One moment.' });

    await integrations.save(actor(), 'meta_social', { pageAccessToken: `EAAtoken${run}xyz`, appSecret: SECRET, pageId: PAGE });
    reply = () => new Response(JSON.stringify({ id: PAGE, name: 'Shop Page' }), { status: 200 });
    await integrations.test(actor(), 'meta_social', 'connection', {});
    await integrations.setEnabled(actor(), 'meta_social', true);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    creds?.onModuleDestroy();
    await prisma.organizationChannel.deleteMany({ where: { organizationId: { in: [ORG, ORG_B] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
    await prisma.$disconnect();
  });

  it('without an agent: unchanged (team answers, AI off)', async () => {
    const from = user();
    await text(from, 'broiler price?');
    const c = await convOf(from);
    expect(c).toMatchObject({ aiEnabled: false, handoffReason: expect.stringMatching(/no AI agent is chosen/) });
    expect(c.Message.map((m: any) => m.role)).toEqual(['user']);
    await expect(inbox.returnToAi(actor(), c.id)).rejects.toThrow(/No AI agent answers Instagram/);
  });

  it('choosing the agent: only a published agent of this organization', async () => {
    await expect(ai.setAgent({ sub: admin.id, org: ORG }, draftAgent.id)).rejects.toThrow(/Publish the agent first/);
    await expect(ai.setAgent({ sub: 'b', org: ORG_B }, agent.id)).rejects.toThrow(/Connect Instagram/);
    const s = await ai.setAgent({ sub: admin.id, org: ORG }, agent.id);
    expect(s).toMatchObject({ aiAgentId: agent.id, active: true, current: { name: `Chat desk ${run}` } });
    expect(s.agents.map((a: any) => a.id)).toEqual([agent.id]);
    // Re-saving the integration form keeps the choice.
    await integrations.save(actor(), 'meta_social', { autoReply: 'Thanks!' });
    reply = () => new Response(JSON.stringify({ id: PAGE, name: 'Shop Page' }), { status: 200 });
    await integrations.test(actor(), 'meta_social', 'connection', {});
    expect((await ai.settings(ORG)).aiAgentId).toBe(agent.id);
  });

  it('a grounded reply: simulated in DRY_RUN; live only to an approved id with the exact Graph request; AI stays on', async () => {
    const from = user();
    calls.length = 0;
    await text(from, 'What is the broiler price per kg?');
    let c = await convOf(from);
    expect(c.aiEnabled).toBe(true);
    const a = c.Message.find((m: any) => m.role === 'assistant');
    expect(a.content).toMatch(/240/);
    expect(a.metadata).toMatchObject({ ai: { agentId: agent.id, source: 'knowledge', channel: 'messenger' }, simulated: true, notSentReason: 'DRY_RUN is on' });
    expect(calls).toEqual([]);
    await live(from, async () => {
      reply = () => new Response(JSON.stringify({ recipient_id: from, message_id: 'mid.AI1' }), { status: 200 });
      await text(from, 'When does the Velachery outlet close?');
    });
    c = await convOf(from);
    const last = c.Message.at(-1);
    expect(last).toMatchObject({ role: 'assistant', externalId: 'mid.AI1', deliveryStatus: 'accepted' });
    expect(last.content).toMatch(/8 PM/);
    expect(calls.at(-1)!.body).toEqual({ recipient: { id: from }, messaging_type: 'RESPONSE', message: { text: last.content } });
  });

  it('cannot answer -> fallback sent, handed to the team, question in the knowledge studio; then the AI stays quiet', async () => {
    const from = user();
    await text(from, 'broiler price per kg?'); // a previous topic must not answer the next, unrelated question
    await text(from, 'Do you deliver to Tambaram?');
    let c = await convOf(from);
    expect(c).toMatchObject({ aiEnabled: false, status: 'human_handoff', handoffReason: expect.stringMatching(/could not answer/) });
    expect(c.Message.at(-1)).toMatchObject({ role: 'assistant', content: 'Let me check with the team.' });
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.knowledgeGap.findFirst({ where: { knowledgeBaseId: kbBase.id, question: 'Do you deliver to Tambaram?' } })).toMatchObject({ channel: 'social', status: 'open' });
    await text(from, 'broiler price?');
    c = await convOf(from);
    expect(c.Message.at(-1).role).toBe('user');
    // A person returns it to the AI (an agent is chosen): it answers again.
    await inbox.returnToAi(actor(), c.id);
    await text(from, 'broiler price per kg?');
    expect((await convOf(from)).Message.at(-1).content).toMatch(/240/);
  });

  it('asks for a person -> hand-over message and the team; attachment only -> the team; STOP wins over the AI', async () => {
    const a = user();
    await text(a, 'I want to talk to the manager');
    let c = await convOf(a);
    expect(c.Message.at(-1).content).toBe('A team member will reply here shortly.');
    expect(c).toMatchObject({ aiEnabled: false, handoffReason: expect.stringMatching(/asked for a person/) });
    const b = user();
    await post(b, { mid: `m.${run}.img`, attachments: [{ type: 'image', payload: { url: 'https://example.invalid/x.jpg' } }] });
    c = await convOf(b);
    expect(c.Message.map((m: any) => m.role)).toEqual(['user']);
    expect(c).toMatchObject({ aiEnabled: false, handoffReason: expect.stringMatching(/attachment/) });
    const s = user();
    await text(s, 'STOP');
    c = await convOf(s);
    expect(c.Message.at(-1).metadata).toMatchObject({ optOut: true });
    await text(s, 'broiler price?');
    expect((await convOf(s)).Message.at(-1).role).toBe('user');
  });

  it('Meta refuses the AI reply -> recorded as failed and handed to the team (not retried)', async () => {
    const from = user();
    await live(from, async () => {
      reply = () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }), { status: 400 });
      await text(from, 'broiler price?');
    });
    const c = await convOf(from);
    expect(c.Message.at(-1)).toMatchObject({ role: 'assistant', deliveryStatus: 'failed' });
    expect(c).toMatchObject({ aiEnabled: false, handoffReason: expect.stringMatching(/not accepted by Meta/) });
  });

  it('review mode: the reply is held; approving sends it on Messenger (live to the approved id)', async () => {
    const from = user();
    await text(from, 'hello there');
    let c = await convOf(from);
    await prisma.conversation.update({ where: { id: c.id }, data: { aiMode: 'review', aiEnabled: true, status: 'active', handoffReason: null } });
    calls.length = 0;
    await live(from, async () => {
      await text(from, 'What is the broiler price per kg?');
      expect(calls).toEqual([]);
      c = await convOf(from);
      const held = c.Message.at(-1);
      expect(held).toMatchObject({ role: 'assistant', deliveryStatus: 'held', metadata: expect.objectContaining({ review: { status: 'pending' } }) });
      reply = () => new Response(JSON.stringify({ recipient_id: from, message_id: 'mid.APPROVED' }), { status: 200 });
      await inbox.approveDraft(actor(), c.id, held.id, { text: 'Broiler is Rs 240 per kg today.' });
    });
    const sent = (await convOf(from)).Message.at(-1);
    expect(sent).toMatchObject({ content: 'Broiler is Rs 240 per kg today.', externalId: 'mid.APPROVED', deliveryStatus: 'accepted', metadata: expect.objectContaining({ review: expect.objectContaining({ status: 'edited' }) }) });
    expect(calls.at(-1)!.body.message.text).toBe('Broiler is Rs 240 per kg today.');
  });

  it('an internal error while answering hands the conversation to the team (never silent)', async () => {
    const from = user();
    const orig = ai.answer.bind(ai);
    ai.answer = async () => { throw new Error('boom'); };
    try { await text(from, 'broiler price?'); } finally { ai.answer = orig; }
    const c = await convOf(from);
    expect(c).toMatchObject({ aiEnabled: false, status: 'human_handoff', handoffReason: expect.stringMatching(/internal error/) });
  });

  it('clearing the agent: new conversations go to the team; return to AI refused again', async () => {
    await ai.setAgent({ sub: admin.id, org: ORG }, null);
    const from = user();
    await text(from, 'broiler price?');
    const c = await convOf(from);
    expect(c.aiEnabled).toBe(false);
    await expect(inbox.returnToAi(actor(), c.id)).rejects.toThrow(/No AI agent/);
  });
});
