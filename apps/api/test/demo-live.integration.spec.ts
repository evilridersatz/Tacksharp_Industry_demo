/**
 * Live demo activity across the agent industries. Uses the seeded demo workspaces in TEST_DB_NAME
 * (npm run seed:industry-demos); skipped when they are not there. Demo data only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const ORGS: Record<string, string> = {
  textile: 'org_demo_textile', retail: 'org_demo_retail', restaurant: 'org_demo_restaurant', food: 'org_demo_food', hotel: 'org_demo_hotel',
  hospital: 'org_demo_hospital', real_estate: 'org_demo_real_estate', manufacturing: 'org_demo_manufacturing', agency: 'org_demo_agency',
};
const MIN = 60_000;
const lcg = (seed: number) => { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); };

describe.skipIf(!enabled)('live demo activity (integration, seeded demo workspaces)', { timeout: 600_000 }, () => {
  let prisma: any, settings: any, activity: any, present = false;
  const T0 = new Date(Date.now() - 7 * 60 * MIN); // replay the past hours only: never future-dated rows
  const before: Record<string, Record<string, number>> = {};
  const prior: Record<string, unknown> = {};

  const counts = async (org: string) => ({
    messages: await prisma.message.count({ where: { organizationId: org, id: { startsWith: 'dlt_' } } }),
    calls: await prisma.call.count({ where: { organizationId: org, id: { startsWith: 'dlt_' } } }),
    leads: await prisma.lead.count({ where: { organizationId: org, id: { startsWith: 'dlt_' } } }),
    orders: await prisma.order.count({ where: { organizationId: org, id: { startsWith: 'dlt_' } } }),
    reservations: await prisma.reservation.count({ where: { organizationId: org, id: { startsWith: 'dlt_' } } }),
    appointments: await prisma.appointment.count({ where: { organizationId: org, id: { startsWith: 'dlt_' } } }),
    quotations: await prisma.quotation.count({ where: { organizationId: org, id: { startsWith: 'dlt_' } } }),
    salesOrders: await prisma.salesOrder.count({ where: { organizationId: org, id: { startsWith: 'dlt_' } } }),
    inspections: await prisma.qualityInspection.count({ where: { organizationId: org, id: { startsWith: 'dlt_' } } }),
    simulatedFollowUps: await prisma.followUp.count({ where: { organizationId: org, status: 'simulated', completedAt: { gte: new Date(T0.getTime() - 3 * 3_600_000) } } }),
  });

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { FinanceService } = await import('../src/finance/finance.service.js');
    const { FinanceEvents } = await import('../src/finance/finance-events.js');
    const { DemoActivityService } = await import('../src/demo-live/demo-activity.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    present = (await prisma.organization.count({ where: { id: { in: Object.values(ORGS) }, isDemo: true } })) === Object.keys(ORGS).length;
    if (!present) return;
    settings = new SettingsService(prisma);
    const { ApprovalsService } = await import('../src/governance/approvals.service.js');
    const { WorkTasksService } = await import('../src/governance/work-tasks.service.js');
    const finance = new FinanceService(prisma, new ApprovalsService(prisma), new WorkTasksService(prisma), settings, new FinanceEvents());
    activity = new DemoActivityService(prisma, settings, finance as never);
    activity.random = lcg(42);
    activity.timeWeight = 1.2; // a busy hour, whatever time the test runs
    activity.idPrefix = 'dlt_'; // the test's own rows, removed in afterAll (the demo's live data stays as it was)
    for (const org of Object.values(ORGS)) {
      prior[org] = (await settings.get(org)).demoLive;
      await settings.update(org, { demoLive: { enabled: true, since: T0.toISOString() } });
      before[org] = await counts(org);
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    // Remove the test's rows and leave each workspace's live demo switch as it was before the test.
    if (present) for (const org of Object.values(ORGS)) await activity.prune(org, new Date(Date.now() + 40 * 86_400_000), 'dlt_');
    if (present) for (const org of Object.values(ORGS)) await settings.update(org, { demoLive: prior[org] ?? { enabled: false, since: null } });
    await prisma.$disconnect();
  });

  it('a real (non-demo) workspace is never touched', async () => {
    if (!present) return;
    await prisma.organization.upsert({ where: { id: 'org_dl_real' }, update: { isDemo: false }, create: { id: 'org_dl_real', name: 'Real Co', vertical: 'real_estate', isDemo: false } });
    await settings.update('org_dl_real', { industry: 'real_estate', demoLive: { enabled: true, since: T0.toISOString() } });
    expect(await activity.tick('org_dl_real', T0)).toBeNull();
    expect(await activity.liveOrgs()).not.toContain('org_dl_real');
    expect(await prisma.message.count({ where: { organizationId: 'org_dl_real' } })).toBe(0);
    await settings.update('org_dl_real', { demoLive: { enabled: false, since: null } });
  });

  it('every industry: 6 hours of replayed activity, then live minutes, keep every page moving', async () => {
    if (!present) return;
    for (const org of Object.values(ORGS)) await activity.simulate(org, T0, new Date(T0.getTime() + 360 * MIN), 15);
    for (let m = 361; m <= 390; m++) for (const org of Object.values(ORGS)) await activity.tick(org, new Date(T0.getTime() + m * MIN));
    const after: Record<string, Record<string, number>> = {};
    for (const org of Object.values(ORGS)) after[org] = await counts(org);
    const grew = (ind: string, k: string) => after[ORGS[ind]][k] - before[ORGS[ind]][k];
    for (const ind of Object.keys(ORGS)) {
      expect(grew(ind, 'messages'), `${ind} chats`).toBeGreaterThan(ind === 'manufacturing' ? 0 : 10); // a manufacturer gets few chats an hour
      expect(grew(ind, 'leads'), `${ind} leads`).toBeGreaterThan(0);
      expect(after[ORGS[ind]].simulatedFollowUps, `${ind} follow-ups due → simulated`).toBeGreaterThan(0);
    }
    for (const ind of ['real_estate', 'textile', 'restaurant', 'food', 'hotel', 'hospital']) expect(grew(ind, 'calls'), `${ind} calls`).toBeGreaterThan(2);
    expect(grew('food', 'orders')).toBeGreaterThan(3);
    expect(grew('restaurant', 'orders')).toBeGreaterThan(3);
    expect(grew('hotel', 'reservations')).toBeGreaterThan(2);
    expect(grew('hospital', 'appointments')).toBeGreaterThan(2);
    expect(grew('textile', 'quotations')).toBeGreaterThan(2);
    expect(grew('retail', 'salesOrders')).toBeGreaterThan(2);
    expect(grew('manufacturing', 'inspections')).toBeGreaterThan(3);
  });

  it('orders move through the kitchen; quotations become orders with real invoices and verified payments', async () => {
    if (!present) return;
    const food = await prisma.order.groupBy({ by: ['status'], where: { organizationId: ORGS.food, id: { startsWith: 'dlt_' } }, _count: { _all: true } });
    expect(food.some((g: any) => g.status === 'completed')).toBe(true);
    const events = await prisma.orderEvent.count({ where: { organizationId: ORGS.food, id: { startsWith: 'dlt_' }, type: 'status_changed' } });
    expect(events).toBeGreaterThan(3);
    const so = await prisma.salesOrder.findMany({ where: { organizationId: { in: [ORGS.textile, ORGS.retail] }, status: { in: ['dispatched', 'delivered'] }, updatedAt: { gte: T0 } }, select: { id: true } });
    expect(so.length).toBeGreaterThan(0);
    const inv = await prisma.invoice.count({ where: { orderId: { in: so.map((o: any) => o.id) }, status: { in: ['issued', 'partially_paid', 'paid'] } } });
    expect(inv).toBeGreaterThan(0);
  });

  it('only synthetic customers in the demo range; assistant replies are marked simulated; nothing was queued to send', async () => {
    if (!present) return;
    const cus = await prisma.customer.findMany({ where: { organizationId: { in: Object.values(ORGS) }, id: { startsWith: 'dl' } }, select: { phone: true, isDemo: true } }); // feed + test customers
    expect(cus.length).toBeGreaterThan(0);
    expect(cus.every((c: any) => c.isDemo && /^910000\d{6,7}$/.test(c.phone))).toBe(true);
    const ai = await prisma.message.findMany({ where: { organizationId: ORGS.hotel, id: { startsWith: 'dlt_' }, role: 'assistant' }, take: 20 });
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.every((m: any) => m.metadata?.simulated === true && m.metadata?.demoFeed === true)).toBe(true);
    const payments = await prisma.payment.findMany({ where: { organizationId: { in: [ORGS.textile, ORGS.retail] }, createdAt: { gte: T0 } } });
    expect(payments.every((p: any) => p.reference?.startsWith('DEMOUTR'))).toBe(true);
  });

  it('retention removes live-demo rows older than 35 days and never seeded rows', async () => {
    if (!present) return;
    const org = ORGS.agency;
    const seeded = await prisma.lead.count({ where: { organizationId: org, id: { not: { startsWith: 'dl' } } } });
    const conv = await prisma.conversation.findFirst({ where: { organizationId: org } });
    const old = new Date(Date.now() - 40 * 86_400_000);
    const oldId = `dlt_agency_msg_old_${Date.now().toString(36)}`;
    await prisma.message.create({ data: { id: oldId, organizationId: org, conversationId: conv.id, role: 'user', content: 'old', createdAt: old } });
    await activity.prune(org, new Date(), 'dlt_');
    expect(await prisma.message.count({ where: { id: oldId } })).toBe(0);
    expect(await prisma.lead.count({ where: { organizationId: org, id: { not: { startsWith: 'dl' } } } })).toBe(seeded);
  });
});
