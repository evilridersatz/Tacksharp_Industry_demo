/**
 * Advanced agent builder, DB-backed (real MySQL TEST database, real knowledge base and the real agent engine; no AI
 * model, so answers come from the knowledge base / rules and are deterministic). Proves: test cases (validation, unique
 * names, multi-turn with history, every check type, results stored, a run counts as testing); tests-must-pass publish
 * gate (no cases, failing case, passing); every publish makes a numbered version with note and test summary;
 * diff against the current configuration and between versions; restore an earlier version (needs a new test);
 * tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.KNOWLEDGE_DIR = `/tmp/ts-kb-builder-${process.pid}`;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
}
const run = Date.now().toString(36);
const A = `org_ab_a_${run}`;
const B = `org_ab_b_${run}`;
const actorA = { sub: 'user-a', org: A };
const actorB = { sub: 'user-b', org: B };

describe.skipIf(!enabled)('advanced agent builder (integration)', () => {
  let prisma: any, kb: any, agents: any, agent: any;

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { KnowledgeService } = await import('../src/knowledge/knowledge.service.js');
    const { VoiceAgentsService } = await import('../src/voice-agents/voice-agents.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    kb = new KnowledgeService(prisma);
    kb.processInline = true;
    agents = new VoiceAgentsService(prisma, kb);
    for (const id of [A, B]) await prisma.organization.create({ data: { id, name: id, vertical: 'restaurant' } });
    const base = await kb.createBase(A, 'Menu');
    const doc = await kb.upload(A, base.id, { originalname: 'menu.txt', buffer: Buffer.from('Broiler chicken costs Rs 240 per kg.\nNaatu kozhi costs Rs 520 per kg.\nThe Velachery outlet closes at 8 PM.') }, 'user:a');
    expect(doc.status).toBe('indexed');
    agent = await agents.create(actorA, { name: `Order desk ${run}`, industry: 'restaurant', instructions: 'Answer chicken price and timing questions from the menu.', greeting: 'Vanakkam!', fallbackMessage: 'Let me check with the team.', knowledgeBaseId: base.id, escalation: { keywords: ['manager', 'complaint'], handoffMessage: 'A team member will call you back.' } });
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.$disconnect();
  });

  it('test cases: validation, unique names, isolation', async () => {
    await expect(agents.createTest(actorA, agent.id, { name: '', turns: [] })).rejects.toMatchObject({ response: { errors: { name: expect.any(String), turns: expect.any(String) } } });
    const t = await agents.createTest(actorA, agent.id, { name: 'Broiler price', lang: 'en', turns: [{ message: 'broiler price per kg?', expect: { contains: ['240'], notContains: ['mutton'], escalate: false, source: 'knowledge' } }] });
    expect(t.turns[0].expect.contains).toEqual(['240']);
    await expect(agents.createTest(actorA, agent.id, { name: 'Broiler price', turns: [{ message: 'x' }] })).rejects.toThrow(/already exists/);
    await expect(agents.createTest(actorB, agent.id, { name: 'steal', turns: [{ message: 'x' }] })).rejects.toMatchObject({ status: 404 });
    await expect(agents.listTests(B, agent.id)).rejects.toMatchObject({ status: 404 });
  });

  it('run: multi-turn with history, every check type, results stored, failing checks reported, run counts as a test', async () => {
    await agents.createTest(actorA, agent.id, { name: 'Escalation then timing', turns: [{ message: 'I want to talk to the manager', expect: { escalate: true, source: 'escalation', contains: ['call you back'] } }, { message: 'when does the Velachery outlet close?', expect: { contains: ['8 PM'], escalate: false } }] });
    const wrong = await agents.createTest(actorA, agent.id, { name: 'Wrong expectation', turns: [{ message: 'naatu kozhi price?', expect: { contains: ['240'] } }] });
    const r = await agents.runTests(actorA, agent.id);
    expect(r).toMatchObject({ total: 3, passed: 2, failed: 1 });
    const esc = r.cases.find((c: any) => c.name === 'Escalation then timing');
    expect(esc.turns.map((t: any) => [t.source, t.escalate, t.ok])).toEqual([['escalation', true, true], ['knowledge', false, true]]);
    const bad = r.cases.find((c: any) => c.name === 'Wrong expectation');
    expect(bad.turns[0].reply).toMatch(/520/);
    expect(bad.turns[0].checks).toEqual([{ check: 'mentions "240"', ok: false }]);
    const stored = await prisma.agentTestCase.findUnique({ where: { id: wrong.id } });
    expect(stored.lastResult.ok).toBe(false);
    expect(stored.lastRunAt).not.toBeNull();
    expect((await agents.get(A, agent.id)).lastTestedAt).not.toBeNull();
    // Editing a test clears its old result.
    const fixed = await agents.updateTest(actorA, agent.id, wrong.id, { turns: [{ message: 'naatu kozhi price?', expect: { contains: ['520'] } }] });
    expect(fixed.lastResult).toBeNull();
  });

  it('publish gate: tests must pass when required; versions with note and summary', async () => {
    await agents.update(actorA, agent.id, { requireTestsToPublish: true });
    // The policy change alone does not need a new test.
    expect((await agents.get(A, agent.id)).lastTestedAt).not.toBeNull();
    const t = await prisma.agentTestCase.findFirst({ where: { agentId: agent.id, name: 'Wrong expectation' } });
    await agents.updateTest(actorA, agent.id, t.id, { turns: [{ message: 'naatu kozhi price?', expect: { contains: ['999'] } }] });
    await expect(agents.publish(actorA, agent.id, { note: 'first' })).rejects.toMatchObject({ response: { problems: [expect.stringMatching(/Test "Wrong expectation" failed: mentions "999"/)] } });
    expect(await prisma.agentVersion.count({ where: { agentId: agent.id } })).toBe(0);
    await agents.updateTest(actorA, agent.id, t.id, { turns: [{ message: 'naatu kozhi price?', expect: { contains: ['520'] } }] });
    const p1 = await agents.publish(actorA, agent.id, { note: 'Launch menu' });
    expect(p1.status).toBe('active');
    let v = await agents.versions(A, agent.id);
    expect(v).toMatchObject([{ version: 1, note: 'Launch menu', testSummary: { total: 3, passed: 3, failed: 0 } }]);
    // Change, test, publish again -> version 2.
    await agents.update(actorA, agent.id, { greeting: 'Vanakkam! GR order desk here.', fallbackMessage: 'One moment, checking with the team.' });
    await agents.test(actorA, agent.id, { message: 'hi' });
    await agents.publish(actorA, agent.id, {});
    v = await agents.versions(A, agent.id);
    expect(v.map((x: any) => x.version)).toEqual([2, 1]);
  });

  it('diff (version vs version, version vs current) and restore an earlier version', async () => {
    const d = await agents.diff(A, agent.id, '1', '2');
    expect(d.changes.map((c: any) => c.field).sort()).toEqual(['fallbackMessage', 'greeting']);
    expect(d.changes.find((c: any) => c.field === 'greeting')).toEqual({ field: 'greeting', before: 'Vanakkam!', after: 'Vanakkam! GR order desk here.' });
    expect((await agents.diff(A, agent.id, '2', 'current')).changes).toEqual([]);
    await expect(agents.diff(A, agent.id, '9', 'current')).rejects.toMatchObject({ status: 404 });
    const restored = await agents.rollback(actorA, agent.id, 1);
    expect(restored).toMatchObject({ greeting: 'Vanakkam!', fallbackMessage: 'Let me check with the team.', lastTestedAt: null, status: 'active' });
    expect((await agents.diff(A, agent.id, '1', 'current')).changes).toEqual([]);
    await expect(agents.rollback(actorB, agent.id, 1)).rejects.toMatchObject({ status: 404 });
    await expect(agents.versions(B, agent.id)).rejects.toMatchObject({ status: 404 });
    const audit = (await prisma.auditEvent.findMany({ where: { organizationId: A, entityId: agent.id } })).map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['agent.tests_run', 'agent.published', 'agent.rolled_back', 'agent.publish_policy']));
  });
});
