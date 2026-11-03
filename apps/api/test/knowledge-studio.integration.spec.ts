/**
 * Knowledge studio, DB-backed (real MySQL TEST database, real indexing pipeline, the real agent engine without an AI
 * model). Proves: typed answers are indexed like uploads and used by the agent; editing re-indexes; uploads cannot be
 * edited as answers; unanswered questions are recorded from the test console and calls (grouped, counted), not from
 * saved test runs, greetings or escalations; answering a gap fixes the agent's reply; asking an answered question
 * that still falls back reopens it; ignore; passages view; tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.KNOWLEDGE_DIR = `/tmp/ts-kb-studio-${process.pid}`;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
}
const run = Date.now().toString(36);
const A = `org_ks_a_${run}`;
const B = `org_ks_b_${run}`;
const actorA = { sub: 'user-a', org: A };
const actorB = { sub: 'user-b', org: B };
const settle = () => new Promise((r) => setTimeout(r, 300));

describe.skipIf(!enabled)('knowledge studio (integration)', () => {
  let prisma: any, kb: any, studio: any, agents: any, base: any, agent: any, upload: any;

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { KnowledgeService } = await import('../src/knowledge/knowledge.service.js');
    const { KnowledgeStudioService } = await import('../src/knowledge/knowledge-studio.service.js');
    const { VoiceAgentsService } = await import('../src/voice-agents/voice-agents.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    kb = new KnowledgeService(prisma);
    kb.processInline = true;
    studio = new KnowledgeStudioService(prisma, kb);
    agents = new VoiceAgentsService(prisma, kb);
    for (const id of [A, B]) await prisma.organization.create({ data: { id, name: id, vertical: 'restaurant' } });
    base = await kb.createBase(A, 'Shop');
    upload = await kb.upload(A, base.id, { originalname: 'menu.txt', buffer: Buffer.from('Broiler chicken costs Rs 240 per kg.\nThe Velachery outlet closes at 8 PM.') }, 'user:a');
    agent = await agents.create(actorA, { name: `Desk ${run}`, industry: 'restaurant', instructions: 'Answer chicken questions from the menu.', greeting: 'Vanakkam!', fallbackMessage: 'Let me check with the team.', knowledgeBaseId: base.id, escalation: { keywords: ['manager'], handoffMessage: 'A team member will call you.' } });
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.$disconnect();
  });

  it('unanswered questions: recorded from the console and calls, grouped and counted; not greetings, escalations or saved test runs', async () => {
    const r = await agents.test(actorA, agent.id, { message: 'Do you deliver to Tambaram?' });
    expect(r.source).toBe('fallback');
    await agents.test(actorA, agent.id, { message: 'do you DELIVER to tambaram' });
    await agents.replyForCall(A, agent.id, 'Do you deliver to Tambaram??', []);
    await agents.test(actorA, agent.id, { message: 'hi' });
    await agents.test(actorA, agent.id, { message: 'I want the manager now' });
    await agents.test(actorA, agent.id, { message: 'broiler price per kg?' }); // answered from knowledge
    await agents.createTest(actorA, agent.id, { name: 'Parking', turns: [{ message: 'Is there parking near the shop?' }] });
    await agents.runTests(actorA, agent.id);
    await settle();
    const gaps = await studio.gaps(A, { knowledgeBaseId: base.id });
    expect(gaps.map((g: any) => [g.question, g.count, g.channel])).toEqual([['Do you deliver to Tambaram?', 3, 'call']]);
    expect((await studio.overview(A)).find((b: any) => b.id === base.id)).toMatchObject({ openGaps: 1, documents: 1 });
  });

  it('answering a gap writes an indexed answer the agent then uses; the gap is answered', async () => {
    const [gap] = await studio.gaps(A, { knowledgeBaseId: base.id });
    await expect(studio.writeAnswer(actorA, base.id, { title: 'x', text: 'short' })).rejects.toMatchObject({ response: { errors: { title: expect.any(String), text: expect.any(String) } } });
    const doc = await studio.writeAnswer(actorA, base.id, { gapId: gap.id, title: 'Do you deliver to Tambaram?', text: 'Yes, we deliver to Tambaram every day from 11 AM to 7 PM. Delivery is free above Rs 500.' });
    expect(doc).toMatchObject({ status: 'indexed', authored: true, filename: 'Do you deliver to Tambaram.txt' });
    expect((await prisma.knowledgeGap.findUnique({ where: { id: gap.id } })).status).toBe('answered');
    const r = await agents.test(actorA, agent.id, { message: 'Do you deliver to Tambaram?' });
    expect(r.source).toBe('knowledge');
    expect(r.reply).toMatch(/Tambaram/);
    expect(await studio.gaps(A, { knowledgeBaseId: base.id })).toEqual([]);
  });

  it('edit an answer: re-indexed with the new text; uploaded files are not editable here', async () => {
    const doc = await prisma.knowledgeDocument.findFirst({ where: { organizationId: A, authored: true } });
    expect(await studio.answer(A, doc.id)).toMatchObject({ title: 'Do you deliver to Tambaram?', text: expect.stringMatching(/^Yes, we deliver/) });
    const e = await studio.editAnswer(actorA, doc.id, { title: 'Do you deliver to Tambaram?', text: 'Yes, Tambaram delivery runs from 10 AM to 9 PM; free above Rs 400.' });
    expect(e.status).toBe('indexed');
    const p = await studio.passages(A, doc.id);
    expect(p.passages.map((x: any) => x.text).join(' ')).toMatch(/10 AM to 9 PM/);
    expect((await agents.test(actorA, agent.id, { message: 'tambaram delivery timing?' })).reply).toMatch(/10 AM to 9 PM/);
    await expect(studio.editAnswer(actorA, upload.id, { title: 'Menu', text: 'Hacked menu text here' })).rejects.toMatchObject({ status: 400 });
    expect((await studio.passages(A, upload.id)).passages.length).toBeGreaterThan(0);
  });

  it('a question asked again while still unanswered after "answered" is reopened; ignore hides it', async () => {
    await agents.test(actorA, agent.id, { message: 'Do you sell duck eggs?' });
    await settle();
    let [g] = await studio.gaps(A, { knowledgeBaseId: base.id });
    await prisma.knowledgeGap.update({ where: { id: g.id }, data: { status: 'answered' } });
    await agents.test(actorA, agent.id, { message: 'do you sell duck eggs' });
    await settle();
    [g] = await studio.gaps(A, { knowledgeBaseId: base.id });
    expect(g).toMatchObject({ question: 'Do you sell duck eggs?', count: 2, status: 'open' });
    await studio.setGapStatus(actorA, g.id, 'ignored');
    expect(await studio.gaps(A, { knowledgeBaseId: base.id })).toEqual([]);
    expect((await studio.gaps(A, { status: 'ignored' })).map((x: any) => x.id)).toEqual([g.id]);
    await agents.test(actorA, agent.id, { message: 'do you sell duck eggs' });
    await settle();
    expect((await prisma.knowledgeGap.findUnique({ where: { id: g.id } })).status).toBe('ignored');
  });

  it('tenant isolation', async () => {
    const doc = await prisma.knowledgeDocument.findFirst({ where: { organizationId: A, authored: true } });
    await expect(studio.passages(B, doc.id)).rejects.toMatchObject({ status: 404 });
    await expect(studio.answer(B, doc.id)).rejects.toMatchObject({ status: 404 });
    await expect(studio.editAnswer(actorB, doc.id, { title: 'Stolen', text: 'Overwritten by another tenant' })).rejects.toMatchObject({ status: 404 });
    await expect(studio.writeAnswer(actorB, base.id, { title: 'Injected', text: 'Written into another tenant base' })).rejects.toMatchObject({ status: 404 });
    const g = await prisma.knowledgeGap.findFirst({ where: { organizationId: A } });
    await expect(studio.setGapStatus(actorB, g.id, 'open')).rejects.toMatchObject({ status: 404 });
    expect(await studio.gaps(B, {})).toEqual([]);
    expect(await studio.overview(B)).toEqual([]);
  });
});
