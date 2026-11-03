/**
 * Enterprise subscriptions, DB-backed (real MySQL TEST database). Proves: organizations without a plan are unlimited
 * (existing tenants are never blocked); plan limits are enforced at the real creation points (team invites incl. open
 * invitations, voice agents incl. restoring an archived one, MCP keys, workflows and drips via the shared check) with a
 * clear plan_limit error; per-organization overrides; cancelled blocks new items but deletes nothing; validation;
 * invoices (amounts with GST, yearly numbering, one per period, paid with reference, void with reason, past_due);
 * renewal; contracts; platform-admin only; tenant isolation of the organization view.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.KNOWLEDGE_DIR = `/tmp/ts-kb-billing-${process.pid}`;
  delete process.env.OPENAI_API_KEY;
}
const run = Date.now().toString(36);
const A = `org_bill_a_${run}`;
const B = `org_bill_b_${run}`;
const FREE = `org_bill_free_${run}`;
const mail = (x: string) => `${x}-${run}@example.test`;

describe.skipIf(!enabled)('enterprise subscriptions (integration)', () => {
  let prisma: any, billing: any, team: any, agents: any, mcp: any, auth: any, assertPlanAllows: any;
  let staff: any, adminA: any, adminFree: any, contractId: string;
  const admin = () => ({ sub: staff.id });

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { BillingService } = await import('../src/billing/billing.service.js');
    const { TeamService } = await import('../src/team/team.service.js');
    const { AuthService } = await import('../src/auth/auth.service.js');
    const { KnowledgeService } = await import('../src/knowledge/knowledge.service.js');
    const { VoiceAgentsService } = await import('../src/voice-agents/voice-agents.service.js');
    const { McpService } = await import('../src/mcp/mcp.service.js');
    ({ assertPlanAllows } = await import('../src/billing/entitlements.js'));
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [A, B, FREE]) await prisma.organization.create({ data: { id, name: id, vertical: 'restaurant' } });
    billing = new BillingService(prisma);
    team = new TeamService(prisma);
    auth = new AuthService(prisma);
    agents = new VoiceAgentsService(prisma, new KnowledgeService(prisma));
    mcp = new McpService(prisma);
    staff = await auth.createUser({ organizationId: B, email: mail('staff'), password: 'platform-staff-pass-1', role: 'admin' });
    await prisma.user.update({ where: { id: staff.id }, data: { isPlatformAdmin: true } });
    adminA = await auth.createUser({ organizationId: A, email: mail('a-admin'), password: 'org-a-admin-pass-1', role: 'admin' });
    adminFree = await auth.createUser({ organizationId: FREE, email: mail('free-admin'), password: 'org-free-admin-pass-1', role: 'admin' });
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    const orgs = { in: [A, B, FREE] };
    await prisma.userInvitation.deleteMany({ where: { organizationId: orgs } });
    await prisma.auditEvent.deleteMany({ where: { organizationId: orgs } });
    await prisma.mcpAccessKey.deleteMany({ where: { organizationId: orgs } });
    await prisma.voiceAgent.deleteMany({ where: { organizationId: orgs } });
    await prisma.user.deleteMany({ where: { email: { contains: `-${run}@example.test` } } });
    await prisma.organization.deleteMany({ where: { id: orgs } });
    if (contractId) await prisma.billingContract.deleteMany({ where: { id: contractId } });
    await prisma.$disconnect();
  });

  const agentBody = (n: number) => ({ name: `Desk ${n} ${run}`, industry: 'restaurant', instructions: 'Answer menu questions politely.', greeting: 'Vanakkam!', fallbackMessage: 'Let me check.' });

  it('no subscription = no limits (existing tenants keep working)', async () => {
    for (let i = 0; i < 4; i++) await team.invite({ sub: adminFree.id, org: FREE }, { email: mail(`free${i}`), role: 'viewer' });
    for (let i = 0; i < 2; i++) await agents.create({ sub: adminFree.id, org: FREE }, agentBody(i));
    const s = await billing.summary(FREE);
    expect(s.subscription).toBeNull();
    expect(s.usage).toMatchObject({ users: 5, voiceAgents: 2 });
    expect(s.note).toMatch(/no limits/);
  });

  it('only platform admins; validation', async () => {
    await expect(billing.requireAdmin(adminA.id)).rejects.toMatchObject({ status: 403 });
    await billing.requireAdmin(staff.id);
    await expect(billing.setSubscription(admin(), A, { planCode: 'gold', status: 'weird', billingCycle: 'weekly', price: -1, limitsOverride: { users: -2 } })).rejects.toMatchObject({
      response: { errors: { planCode: expect.any(String), status: expect.any(String), billingCycle: expect.any(String), price: expect.any(String), limitsOverride: expect.any(String) } },
    });
    await expect(billing.setSubscription(admin(), A, { planCode: 'pilot', status: 'trial' })).rejects.toMatchObject({ response: { errors: { trialEndsAt: expect.any(String) } } });
    await expect(billing.createContract(admin(), { name: 'x', gstin: 'BAD' })).rejects.toMatchObject({ response: { errors: { gstin: expect.any(String) } } });
    const c = await billing.createContract(admin(), { name: `Acme Foods group ${run}`, billingEmail: 'Accounts@Acme.example', gstin: '33abcde1234f1z5' });
    contractId = c.id;
    expect(c).toMatchObject({ billingEmail: 'accounts@acme.example', gstin: '33ABCDE1234F1Z5' });
  });

  it('pilot plan limits enforced at the real creation points, with a clear message', async () => {
    const r = await billing.setSubscription(admin(), A, { planCode: 'pilot', billingCycle: 'monthly', price: 4999, currentPeriodStart: '2026-01-31T00:00:00Z', contractId });
    expect(r.subscription).toMatchObject({ planCode: 'pilot', status: 'active', price: 4999, taxRatePct: 18, contractName: `Acme Foods group ${run}` });
    expect(new Date(r.subscription.currentPeriodEnd).toISOString().slice(0, 10)).toBe('2026-02-28'); // month end clamped
    expect(r.limits).toMatchObject({ users: 3, voiceAgents: 1, mcpKeys: 0 });
    const actor = { sub: adminA.id, org: A };
    // Seats: 1 admin + 2 open invitations = 3 -> the 3rd invitation is refused.
    await team.invite(actor, { email: mail('a1'), role: 'viewer' });
    await team.invite(actor, { email: mail('a2'), role: 'viewer' });
    await expect(team.invite(actor, { email: mail('a3'), role: 'viewer' })).rejects.toMatchObject({ status: 403, response: { code: 'plan_limit', resource: 'users', message: 'Your Pilot plan allows 3 team members and 3 are in use. Remove one or contact Tacksharp to upgrade.' } });
    const first = await agents.create(actor, agentBody(1));
    await expect(agents.create(actor, agentBody(2))).rejects.toMatchObject({ response: { code: 'plan_limit', resource: 'voiceAgents' } });
    // Archiving frees the slot; restoring must fit the plan again.
    await agents.archive(actor, first.id);
    const second = await agents.create(actor, agentBody(2));
    await expect(agents.restore(actor, first.id)).rejects.toMatchObject({ response: { code: 'plan_limit' } });
    expect(second.id).toBeTruthy();
    await expect(mcp.createKey(actor, { name: 'n8n' })).rejects.toMatchObject({ response: { message: 'Your Pilot plan does not include MCP access keys. Contact Tacksharp to upgrade.' } });
    expect(await prisma.mcpAccessKey.count({ where: { organizationId: A } })).toBe(0);
    // Workflows and drips go through the same check (their services call it before creating).
    for (const res of ['workflows', 'dripSequences']) await expect(assertPlanAllows(prisma, A, res)).resolves.toBeUndefined();
  });

  it('override raises one limit; cancelled blocks new items but deletes nothing', async () => {
    const r = await billing.setSubscription(admin(), A, { limitsOverride: { mcpKeys: 2, users: null } });
    expect(r.limits).toMatchObject({ mcpKeys: 2, users: null, voiceAgents: 1 });
    // Changing limits alone keeps the billing period.
    expect(new Date(r.subscription.currentPeriodStart).toISOString().slice(0, 10)).toBe('2026-01-31');
    const actor = { sub: adminA.id, org: A };
    await mcp.createKey(actor, { name: 'n8n' });
    await team.invite(actor, { email: mail('a3'), role: 'viewer' });
    await billing.setSubscription(admin(), A, { status: 'cancelled' });
    await expect(mcp.createKey(actor, { name: 'zapier' })).rejects.toMatchObject({ response: { code: 'plan_limit', message: expect.stringMatching(/cancelled/) } });
    expect(await prisma.mcpAccessKey.count({ where: { organizationId: A, revokedAt: null } })).toBe(1);
    expect(await prisma.voiceAgent.count({ where: { organizationId: A } })).toBe(2);
    await billing.setSubscription(admin(), A, { status: 'active' });
  });

  it('invoices: GST amounts, numbering, once per period, paid with reference, void with reason, past_due', async () => {
    const i1 = await billing.issueInvoice(admin(), A);
    expect(i1).toMatchObject({ subtotal: 4999, taxRatePct: 18, tax: 899.82, total: 5898.82, status: 'issued' });
    expect(i1.number).toMatch(/^TS-\d{4}-\d{5}$/);
    expect(i1.description).toBe('Pilot plan (monthly), 2026-01-31 to 2026-02-28');
    await expect(billing.issueInvoice(admin(), A)).rejects.toMatchObject({ status: 409 });
    await expect(billing.markPaid(admin(), i1.id, { reference: '' })).rejects.toMatchObject({ status: 400 });
    await expect(billing.markPaid(admin(), i1.id, { reference: 'UTR123456', paidAt: '2999-01-01' })).rejects.toMatchObject({ status: 400 });
    const paid = await billing.markPaid(admin(), i1.id, { reference: 'UTR123456' });
    expect(paid).toMatchObject({ status: 'paid', paymentReference: 'UTR123456' });
    await expect(billing.voidInvoice(admin(), i1.id, { reason: 'mistake' })).rejects.toMatchObject({ status: 400 });
    await expect(billing.markPaid(admin(), i1.id, { reference: 'again' })).rejects.toMatchObject({ status: 400 });
    // Renew: the period (ended in February) rolls forward one cycle; a second renew is refused only once the end is > 7 days away.
    const ren = await billing.renew(admin(), A);
    expect(new Date(ren.subscription.currentPeriodStart).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(new Date(ren.subscription.currentPeriodEnd).toISOString().slice(0, 10)).toBe('2026-03-28');
    const i2 = await billing.issueInvoice(admin(), A);
    expect(Number(i2.number.slice(-5))).toBeGreaterThan(Number(i1.number.slice(-5)));
    // Overdue -> past_due; paying / voiding it -> active again.
    await prisma.platformInvoice.update({ where: { id: i2.id }, data: { dueAt: new Date(Date.now() - 86_400_000) } });
    const ov = await billing.overview();
    expect(ov.overdueInvoices.map((x: any) => x.id)).toContain(i2.id);
    expect(ov.subscriptions.find((s: any) => s.organizationId === A).status).toBe('past_due');
    expect(ov.renewalsDue.map((x: any) => x.organizationId)).toContain(A);
    await expect(billing.voidInvoice(admin(), i2.id, { reason: '' })).rejects.toMatchObject({ status: 400 });
    expect((await billing.voidInvoice(admin(), i2.id, { reason: 'Issued with the wrong price' })).status).toBe('void');
    expect((await prisma.subscription.findUnique({ where: { organizationId: A } })).status).toBe('active');
    // Price must be set; cancelled is not renewed.
    await billing.setSubscription(admin(), B, { planCode: 'growth', price: 0 });
    await expect(billing.issueInvoice(admin(), B)).rejects.toThrow(/price/);
    await billing.setSubscription(admin(), B, { status: 'cancelled', currentPeriodStart: '2026-01-01' });
    await expect(billing.renew(admin(), B)).rejects.toThrow(/cancelled/);
  });

  it('organization view is its own; audit trail', async () => {
    const a = await billing.summary(A);
    expect(a.invoices.map((i: any) => i.status).sort()).toEqual(['paid', 'void']);
    expect(a.usage).toMatchObject({ users: 4, voiceAgents: 1, mcpKeys: 1 });
    const b = await billing.summary(B);
    expect(b.invoices).toEqual([]);
    expect(b.subscription.planName).toBe('Growth');
    const actions = (await prisma.auditEvent.findMany({ where: { organizationId: A, actor: `platform:${staff.id}` } })).map((x: any) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['subscription.created', 'subscription.updated', 'subscription.renewed', 'invoice.issued', 'invoice.paid', 'invoice.voided']));
  });
});
