/**
 * CRM additions, DB-backed: stages, custom attributes, follow-up date, transparent lead score, notes, tasks,
 * filters, CSV export (formula-injection safe) and duplicate detection; tenant isolation and audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
}
const ORG = 'org_test_crm_a';
const ORG_B = 'org_test_crm_b';
const run = Date.now().toString().slice(-6);
const ME = { sub: 'user_crm_test', role: 'admin' };

describe.skipIf(!enabled)('CRM (integration)', () => {
  let prisma: any, svc: any;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { CustomersService } = await import('../src/customers/customers.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [ORG, ORG_B]) await prisma.organization.upsert({ where: { id }, create: { id, name: id, vertical: 'real_estate' }, update: {} });
    await prisma.customer.deleteMany({ where: { organizationId: { in: [ORG, ORG_B] } } });
    svc = new CustomersService(prisma);
    ids.a = (await svc.create(ORG, ME, { name: `=HYPERLINK("x") ${run}`, phone: `98${run}01`, email: `dup${run}@example.com` })).id;
    ids.b = (await svc.create(ORG, ME, { name: `Priya ${run}`, phone: `98${run}02`, email: `dup${run}@example.com`, messagingConsent: true, consentSource: 'customer_message' })).id;
    ids.c = (await svc.create(ORG, ME, { name: `Priya ${run}`, phone: `98${run}03` })).id;
    ids.other = (await svc.create(ORG_B, ME, { name: `Priya ${run}`, phone: `98${run}04`, email: `dup${run}@example.com` })).id;
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.workTask.deleteMany({ where: { organizationId: { in: [ORG, ORG_B] } } });
    await prisma.customer.deleteMany({ where: { organizationId: { in: [ORG, ORG_B] } } });
    await prisma.$disconnect();
  });

  it('stage, attributes and follow-up date are validated and saved', async () => {
    const r = await svc.update(ORG, ME, ids.b, { stage: 'qualified', attributes: { budget_band: '60-80L', visits: 2, vip: true }, followUpAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(r).toMatchObject({ stage: 'qualified', attributes: { budget_band: '60-80L', visits: 2, vip: true } });
    await expect(svc.update(ORG, ME, ids.b, { stage: 'hot' })).rejects.toMatchObject({ response: { errors: { stage: expect.any(String) } } });
    await expect(svc.update(ORG, ME, ids.b, { attributes: { 'Bad Key': 1 } })).rejects.toMatchObject({ response: { errors: { attributes: expect.any(String) } } });
    await expect(svc.update(ORG, ME, ids.b, { attributes: { nested: { x: 1 } } })).rejects.toMatchObject({ response: { errors: { attributes: expect.any(String) } } });
    await expect(svc.update(ORG, ME, ids.b, { followUpAt: 'not a date' })).rejects.toMatchObject({ response: { errors: { followUpAt: expect.any(String) } } });
    expect((await svc.update(ORG, ME, ids.b, { stage: 'new' })).stage).toBeNull();
    await svc.update(ORG, ME, ids.b, { stage: 'qualified', tags: ['wedding'] });
  });

  it('lead score is explained by facts; opted-out scores 0', async () => {
    await prisma.customer.update({ where: { id: ids.b }, data: { lastInboundAt: new Date() } });
    const d = await svc.detail(ORG, ids.b);
    expect(d.customer.lead.score).toBe(30 + 25 + 5 + 3);
    expect(d.customer.lead.reasons).toEqual(expect.arrayContaining(['Qualified', 'Wrote in the last day', 'WhatsApp consent', 'Email known']));
    await svc.update(ORG, ME, ids.c, { optedOut: true });
    expect((await svc.detail(ORG, ids.c)).customer.lead).toEqual({ score: 0, reasons: ['Opted out / do not contact'] });
  });

  it('filters: stage, tag, follow-up due', async () => {
    expect((await svc.list(ORG, { stage: 'qualified' })).rows.map((r: any) => r.id)).toEqual([ids.b]);
    expect((await svc.list(ORG, { tag: 'wedding' })).rows.map((r: any) => r.id)).toEqual([ids.b]);
    expect((await svc.list(ORG, { followUpDue: 'true' })).rows.map((r: any) => r.id)).toEqual([ids.b]);
    expect((await svc.list(ORG, { stage: 'new' })).rows.map((r: any) => r.id).sort()).toEqual([ids.a, ids.c].sort());
  });

  it('notes and tasks on the customer timeline; audited', async () => {
    await svc.addNote(ORG, ME, ids.b, 'Prefers evening calls.');
    const t = await svc.addTask(ORG, ME, ids.b, { title: 'Send brochure', dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    const d = await svc.detail(ORG, ids.b);
    expect(d.notes[0]).toMatchObject({ body: 'Prefers evening calls.' });
    expect(d.tasks[0]).toMatchObject({ id: t.id, title: 'Send brochure', status: 'open' });
    await expect(svc.addNote(ORG_B, ME, ids.b, 'x')).rejects.toThrow(/not found/);
    await expect(svc.addTask(ORG, ME, ids.b, { title: 'x' })).rejects.toThrow(/3 to 200/);
    const actions = (await prisma.auditEvent.findMany({ where: { organizationId: ORG, entityId: ids.b } })).map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['note_added', 'task_added']));
  });

  it('CSV export: this workspace only, filters applied, formula injection neutralised', async () => {
    const since = new Date(Date.now() - 1000);
    const r = await svc.exportCsv(ORG, ME, {});
    const lines = r.csv.trim().split('\r\n');
    expect(lines[0]).toContain('"name","phone","email"');
    expect(r.rows).toBe(3);
    expect(r.csv).toContain(`"'=HYPERLINK(""x"") ${run}"`); // prefixed with ' and quotes doubled
    expect(r.csv).not.toContain(`98${run}04`); // other organization
    const q = await svc.exportCsv(ORG, ME, { stage: 'qualified' });
    expect(q.rows).toBe(1);
    expect(q.csv).toContain('"qualified"');
    expect(await prisma.auditEvent.count({ where: { organizationId: ORG, action: 'exported', createdAt: { gte: since } } })).toBe(2);
  });

  it('duplicates: same email and same name are reported (never merged), across this workspace only', async () => {
    const groups = await svc.duplicates(ORG);
    const email = groups.find((g: any) => g.match === 'same email' && g.value === `dup${run}@example.com`);
    const name = groups.find((g: any) => g.match === 'same name' && g.value === `priya ${run}`);
    expect(email.customers.map((c: any) => c.id).sort()).toEqual([ids.a, ids.b].sort());
    expect(name.customers.map((c: any) => c.id).sort()).toEqual([ids.b, ids.c].sort());
    expect(JSON.stringify(groups)).not.toContain(ids.other);
    expect(await prisma.customer.count({ where: { organizationId: ORG } })).toBe(3);
  });
});
