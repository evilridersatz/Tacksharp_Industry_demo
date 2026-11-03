/**
 * Advanced analytics, DB-backed (real MySQL TEST database). Seeds a known set of conversations, messages (with exact
 * timestamps), leads, orders and automation rows, then checks every figure exactly: KPIs and the previous period,
 * AI / team response times, answered-by split, hand-over rate, channels, CRM stages, sources, revenue and repeat buyers,
 * automation counts, team table, heatmap, CSV (formula-safe), tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
}
const run = Date.now().toString(36);
const ORG = `org_an_a_${run}`;
const ORG_B = `org_an_b_${run}`;
const DAY = 86_400_000;

describe.skipIf(!enabled)('advanced analytics (integration)', () => {
  let prisma: any, svc: any, staff: any, outlet: any;
  const ago = (days: number, min = 0) => new Date(Date.now() - days * DAY + min * 60_000);
  let n = 0;

  async function conv(org: string, channel: string, customerId: string, handoffAt?: Date) {
    return prisma.conversation.create({ data: { id: `conv_an_${run}_${n++}`, organizationId: org, channel, externalId: `ext${run}${n}`, customerId, status: 'active', updatedAt: new Date(), ...(handoffAt ? { handoffAt, aiEnabled: false } : {}) } });
  }
  const msg = (org: string, conversationId: string, role: string, createdAt: Date, metadata: Record<string, unknown> = {}) =>
    prisma.message.create({ data: { id: `msg_an_${run}_${n++}`, organizationId: org, conversationId, role, content: `${role} ${n}`, createdAt, metadata } });
  const cust = (org: string, extra: Record<string, unknown> = {}) => prisma.customer.create({ data: { organizationId: org, name: `An ${n++}`, phone: `9193${String(Date.now()).slice(-6)}${String(n % 100).padStart(2, '0')}`, ...extra } });
  const order = (org: string, customerId: string, total: number, at: Date, status = 'completed') =>
    prisma.order.create({ data: { organizationId: org, orderNumber: `AN-${run}-${n++}`, customerId, outletId: outlet.id, channel: 'whatsapp', status, pickupAt: at, subtotal: total, total, paymentMethod: 'cash', idempotencyKey: `an-${run}-${n}`, updatedAt: at, createdAt: at } });

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { AnalyticsService } = await import('../src/analytics/analytics.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [ORG, ORG_B]) await prisma.organization.create({ data: { id, name: id, vertical: 'restaurant' } });
    staff = await prisma.user.create({ data: { organizationId: ORG, email: `an-staff-${run}@example.test`, name: 'Kavitha', passwordHash: 'x', role: 'support' } });
    outlet = await prisma.outlet.create({ data: { organizationId: ORG, name: 'An outlet', address: 'Chennai' } });
    svc = new AnalyticsService(prisma);

    // Current period (last 7 days).
    const a = await cust(ORG, { stage: 'converted' });
    const b = await cust(ORG, { stage: 'qualified' });
    const c = await cust(ORG);
    const c1 = await conv(ORG, 'whatsapp', a.id);
    await msg(ORG, c1.id, 'user', ago(2, 0));
    await msg(ORG, c1.id, 'user', ago(2, 0.5));
    await msg(ORG, c1.id, 'assistant', ago(2, 1)); // AI 60 s
    await msg(ORG, c1.id, 'user', ago(2, 10));
    await msg(ORG, c1.id, 'assistant', ago(2, 12)); // AI 120 s
    const c2 = await conv(ORG, 'instagram', b.id, ago(1, 0));
    await msg(ORG, c2.id, 'user', ago(1, 0));
    await msg(ORG, c2.id, 'assistant', ago(1, 0.1), { autoReply: true, simulated: true }); // automatic, closes the turn
    await msg(ORG, c2.id, 'user', ago(1, 5));
    await msg(ORG, c2.id, 'assistant', ago(1, 20), { author: 'staff', userId: staff.id }); // team 900 s
    const c3 = await conv(ORG, 'whatsapp', c.id);
    await msg(ORG, c3.id, 'user', ago(0.5)); // unanswered
    await prisma.conversation.update({ where: { id: c3.id }, data: { assigneeId: staff.id, inboxStatus: 'open' } });
    await prisma.lead.create({ data: { organizationId: ORG, customerId: a.id, source: 'whatsapp', status: 'contacted', createdAt: ago(3) } }); // customer converted -> counts
    await prisma.lead.create({ data: { organizationId: ORG, customerId: b.id, source: 'meta_ads', status: 'won', createdAt: ago(3) } });
    await prisma.lead.create({ data: { organizationId: ORG, customerId: c.id, source: 'meta_ads', status: 'new', createdAt: ago(3) } });
    await prisma.lead.create({ data: { organizationId: ORG, customerId: c.id, source: 'meta_ads', status: 'new', createdAt: ago(3) } });
    await order(ORG, a.id, 400, ago(1));
    await order(ORG, a.id, 600, ago(2));
    await order(ORG, b.id, 200, ago(2));
    await order(ORG, b.id, 999, ago(2), 'cancelled');
    // Previous period (8-14 days ago).
    const p1 = await conv(ORG, 'whatsapp', c.id);
    await msg(ORG, p1.id, 'user', ago(10));
    await msg(ORG, p1.id, 'assistant', ago(10, 3)); // AI 180 s
    await order(ORG, c.id, 300, ago(10));
    await prisma.lead.create({ data: { organizationId: ORG, customerId: c.id, source: 'web', status: 'new', createdAt: ago(10) } });
    // Automation.
    const seq = await prisma.dripSequence.create({ data: { organizationId: ORG, name: `an ${run}`, steps: [{ day: 0, channel: 'whatsapp', text: 'x' }] } });
    await prisma.dripEnrollment.create({ data: { organizationId: ORG, sequenceId: seq.id, customerId: a.id, status: 'stopped', stopReason: 'customer_replied' } });
    await prisma.dripEnrollment.create({ data: { organizationId: ORG, sequenceId: seq.id, customerId: b.id, status: 'completed' } });
    const wf = await prisma.workflow.create({ data: { organizationId: ORG, name: `an ${run}`, graph: { trigger: { type: 'lead_created' }, steps: [] } } });
    await prisma.workflowRun.create({ data: { organizationId: ORG, workflowId: wf.id, version: 1, graph: {}, triggerKey: 'k1', status: 'completed' } });
    await prisma.workflowRun.create({ data: { organizationId: ORG, workflowId: wf.id, version: 1, graph: {}, triggerKey: 'k2', status: 'waiting', test: false } });
    await prisma.workflowRun.create({ data: { organizationId: ORG, workflowId: wf.id, version: 1, graph: {}, triggerKey: 'k3', status: 'completed', test: true } });
    // Another organization: must never appear.
    const x = await cust(ORG_B);
    const xc = await conv(ORG_B, 'whatsapp', x.id);
    await msg(ORG_B, xc.id, 'user', ago(1));
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    for (const org of [ORG, ORG_B]) {
      await prisma.order.deleteMany({ where: { organizationId: org } });
      await prisma.workflow.deleteMany({ where: { organizationId: org } });
      await prisma.dripSequence.deleteMany({ where: { organizationId: org } });
    }
    await prisma.user.deleteMany({ where: { email: { contains: `-${run}@example.test` } } });
    await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
    await prisma.$disconnect();
  });

  it('KPIs with the previous period; response times; answered-by; hand-over rate', async () => {
    const r = await svc.advanced(ORG, 7);
    expect(r.days).toBe(7);
    expect(r.kpis.inboundMessages).toEqual({ value: 6, previous: 1, changePct: 500 });
    expect(r.kpis.conversations.value).toBe(3);
    expect(r.kpis.handoffRatePct.value).toBe(33.3); // 1 of 3
    expect(r.kpis.aiMedianResponseSec).toMatchObject({ value: 60, previous: 180 }); // [60, 120] -> lower median 60
    expect(r.kpis.teamMedianResponseSec.value).toBe(900);
    expect(r.kpis.unansweredTurns.value).toBe(1);
    expect(r.kpis.leads).toEqual({ value: 4, previous: 1, changePct: 300 });
    expect(r.kpis.leadConversionPct.value).toBe(50); // won + customer converted = 2 of 4
    expect(r.kpis.orders).toEqual({ value: 3, previous: 1, changePct: 200 });
    expect(r.kpis.revenue).toEqual({ value: 1200, previous: 300, changePct: 300 });
    expect(r.kpis.averageOrderValue.value).toBe(400);
    expect(r.responseTimes).toMatchObject({ ai: { count: 2, medianSec: 60, p90Sec: 120 }, team: { count: 1, medianSec: 900 }, unanswered: 1 });
    expect(r.answeredBy).toEqual({ ai: 2, team: 1, automatic: 1, simulated: 1 });
    expect(r.capped).toBe(false);
    expect(r.definitions.aiMedianResponseSec).toMatch(/Median seconds/);
  });

  it('channels, CRM stages, sources, revenue / repeat buyers, automation, team, heatmap, series', async () => {
    const r = await svc.advanced(ORG, 7);
    expect(r.channels).toEqual([{ channel: 'whatsapp', inbound: 4, conversations: 2 }, { channel: 'instagram', inbound: 2, conversations: 1 }]);
    expect(Object.fromEntries(r.crm.stages.map((s: any) => [s.stage, s.count]))).toMatchObject({ new: 1, qualified: 1, converted: 1, interested: 0, lost: 0 });
    expect(r.sources[0]).toEqual({ source: 'meta_ads', leads: 3, won: 1, conversionPct: 33.3 });
    expect(r.revenue).toMatchObject({ buyers: 2, repeatBuyers: 1, repeatRatePct: 50 }); // b's second order was cancelled
    expect(r.revenue.series.reduce((s: number, d: any) => s + d.revenue, 0)).toBe(1200);
    expect(r.automation).toMatchObject({ drips: { stopped: 1, completed: 1 }, dripStopReasons: { customer_replied: 1 }, workflows: { completed: 1, waiting: 1 } });
    expect(r.team).toEqual([{ userId: staff.id, name: 'Kavitha', openAssigned: 1, replies: 1, medianResponseSec: 900 }]);
    expect(r.heatmap.grid.flat().reduce((a: number, b: number) => a + b, 0)).toBe(6);
    expect(r.series.reduce((s: number, d: any) => s + d.customer, 0)).toBe(6);
    expect(r.series.reduce((s: number, d: any) => s + d.team, 0)).toBe(1);
  });

  it('isolation, empty organization, bounds; CSV export is formula-safe', async () => {
    const b = await svc.advanced(ORG_B, 7);
    expect(b.kpis.inboundMessages.value).toBe(1);
    expect(b.team).toEqual([]);
    expect(b.kpis.aiMedianResponseSec.value).toBeNull();
    expect((await svc.advanced(ORG, 9999)).days).toBe(180);
    expect((await svc.advanced(ORG, 'x')).days).toBe(30);
    const { csv } = await svc.csv(ORG, 7);
    expect(csv.startsWith('﻿"section","metric","value","previous period","change %"')).toBe(true);
    expect(csv).toContain('"kpi","revenue","1200","300","300"');
    expect(csv).toContain('"team","Kavitha","1"');
    await prisma.lead.create({ data: { organizationId: ORG, customerId: (await cust(ORG)).id, source: '=HYPERLINK("x")', createdAt: ago(1) } });
    expect((await svc.csv(ORG, 7)).csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
