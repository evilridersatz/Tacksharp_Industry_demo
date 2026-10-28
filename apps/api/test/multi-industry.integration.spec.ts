/**
 * Multi-industry platform, against the real MySQL test database:
 *   - workspace switching goes through memberships only, the switched session is scoped to that organization, and a
 *     removed membership stops the session;
 *   - a restaurant (GR Chicken) workspace can never change industry; other workspaces can (audited);
 *   - retail / manufacturing / agency conversations never get the property assistant: one handoff, no promises;
 *   - quality inspections: validation, stats totals, alert scan deduplication;
 *   - dashboards are computed from the workspace's own records only and match their sources;
 *   - the agent catalogue lists only the workspace's industry (plus shared) agents, unavailable ones honestly;
 *   - the playground is refused in a live workspace and never sends anything in a demo workspace.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/multi-industry.integration.spec.ts
 *
 * FAKE: LLM runner (never called by the generic path), AI service in the playground test. DRY_RUN stays on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const HOME = 'org_mi_home_re';
const RETAIL = 'org_mi_demo_retail';
const MFG = 'org_mi_demo_mfg';
const MFG_LIVE = 'org_mi_live_mfg';
const GR = 'org_mi_restaurant';
const OTHER = 'org_mi_other';
const ORGS = [HOME, RETAIL, MFG, MFG_LIVE, GR, OTHER];
const USER = 'u_mi_owner';
let n = 0;
const phone = () => `9195${String(Date.now()).slice(-6)}${String(n++).padStart(2, '0')}`;

describe.skipIf(!enabled)('Multi-industry platform (integration)', () => {
  let prisma: any, auth: any, settings: any, settingsCtl: any, quality: any, industry: any, orchestrator: any, engine: any, workTasks: any;
  let AuthGuard: any, invalidateAccess: any, verifySession: any, config: any;
  const sentWhatsApp = vi.fn();

  const ctx = (token: string) => ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }) }),
  });
  const reflector = { getAllAndOverride: () => false };

  async function wipe() {
    await prisma.qualityInspection.deleteMany({ where: { organizationId: { in: ORGS } } });
    await prisma.workTask.deleteMany({ where: { organizationId: { in: ORGS } } });
    await prisma.agentTaskEvent?.deleteMany?.({ where: { task: { organizationId: { in: ORGS } } } }).catch(() => undefined);
    await prisma.agentTask.deleteMany({ where: { organizationId: { in: ORGS } } }).catch(() => undefined);
    await prisma.salesOrderItem?.deleteMany?.({ where: { order: { organizationId: { in: ORGS } } } }).catch(() => undefined);
    await prisma.salesOrder.deleteMany({ where: { organizationId: { in: ORGS } } });
    await prisma.followUp.deleteMany({ where: { organizationId: { in: ORGS } } });
    await prisma.message.deleteMany({ where: { organizationId: { in: ORGS } } });
    await prisma.conversation.deleteMany({ where: { organizationId: { in: ORGS } } });
    await prisma.lead.deleteMany({ where: { organizationId: { in: ORGS } } });
    await prisma.customer.deleteMany({ where: { organizationId: { in: ORGS } } });
    await prisma.auditEvent.deleteMany({ where: { organizationId: { in: ORGS } } });
    await prisma.organizationMembership.deleteMany({ where: { userId: USER } });
  }

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { AuthService } = await import('../src/auth/auth.service.js');
    ({ AuthGuard, invalidateAccess } = await import('../src/auth/auth.guard.js'));
    ({ verifySession } = await import('../src/auth/token.js'));
    ({ config } = await import('../src/common/config.js'));
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { SettingsController } = await import('../src/settings/settings.controller.js');
    const { QualityService } = await import('../src/industry/quality.service.js');
    const { IndustryService } = await import('../src/industry/industry.service.js');
    const { Orchestrator } = await import('../src/agents/orchestrator.service.js');
    const { InventoryService } = await import('../src/operations/inventory.service.js');
    const { WorkTasksService } = await import('../src/governance/work-tasks.service.js');
    const { ApprovalsService } = await import('../src/governance/approvals.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { LeadsService } = await import('../src/leads/leads.service.js');
    const { FollowUpsService } = await import('../src/follow-ups/follow-ups.service.js');
    const { PropertiesService } = await import('../src/properties/properties.service.js');
    const { SiteVisitsService } = await import('../src/site-visits/site-visits.service.js');
    const { ConversationEngine } = await import('../src/ai/conversation-engine.service.js');
    const { SessionStore } = await import('../src/ai/session.store.js');
    prisma = new PrismaService();
    await prisma.$connect();
    const org = (id: string, name: string, vertical: string, isDemo: boolean) =>
      prisma.organization.upsert({ where: { id }, update: { vertical, isDemo, name }, create: { id, name, vertical, isDemo } });
    await org(HOME, 'MI Homes', 'real_estate', false);
    await org(RETAIL, 'MI Demo Store', 'real_estate', true);
    await org(MFG, 'MI Demo Plant', 'real_estate', true);
    await org(MFG_LIVE, 'MI Live Plant', 'real_estate', false);
    await org(GR, 'MI Chicken', 'restaurant', false);
    await org(OTHER, 'MI Other Tenant', 'real_estate', false);
    const ind = (id: string, industry: string) => prisma.organizationSettings.upsert({ where: { organizationId: id }, update: { data: { industry } }, create: { organizationId: id, data: { industry } } });
    await ind(RETAIL, 'retail');
    await ind(MFG, 'manufacturing');
    await ind(MFG_LIVE, 'manufacturing');
    await ind(OTHER, 'manufacturing');
    await prisma.organizationSettings.deleteMany({ where: { organizationId: { in: [HOME, GR] } } });
    await prisma.user.upsert({
      where: { id: USER },
      update: { organizationId: HOME, role: 'admin' },
      create: { id: USER, organizationId: HOME, email: 'mi-owner@tacksharp.test', name: 'MI Owner', role: 'admin', passwordHash: 'x' },
    });
    await wipe();
    await prisma.organizationMembership.createMany({ data: [{ userId: USER, organizationId: RETAIL, role: 'admin' }, { userId: USER, organizationId: MFG, role: 'manager' }] });

    settings = new SettingsService(prisma);
    auth = new AuthService(prisma);
    settingsCtl = new SettingsController(settings, prisma);
    quality = new QualityService(prisma);
    workTasks = new WorkTasksService(prisma);
    orchestrator = new Orchestrator(prisma, new InventoryService(prisma), workTasks, new ApprovalsService(prisma), settings, undefined, undefined, undefined, undefined, undefined, undefined, quality);
    const ai = { generateResponse: vi.fn(async () => ({ response: 'Thanks, our team will reply here.', path: 'rules', actions: { handoff: true, outcome: 'human_requested' } })) };
    industry = new IndustryService(prisma, settings, quality, orchestrator, ai as any);
    const conversations = new ConversationsService(prisma);
    const leads = new LeadsService(prisma);
    const followUps = new FollowUpsService(prisma);
    const store = new SessionStore();
    store.useRedis(null);
    engine = new ConversationEngine(prisma, conversations, leads, new PropertiesService(prisma), new SiteVisitsService(prisma), followUps, store, { run: vi.fn() } as any, undefined, settings);
  });

  afterAll(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.$disconnect();
  });

  // ------------------------------------------------------------------ workspaces

  it('lists only the home organization and memberships, each with its effective industry', async () => {
    const list = await auth.workspaces(USER);
    expect(list.map((w: any) => w.organizationId).sort()).toEqual([HOME, MFG, RETAIL].sort());
    const byId = Object.fromEntries(list.map((w: any) => [w.organizationId, w]));
    expect(byId[HOME].industry).toBe('real_estate');
    expect(byId[RETAIL]).toMatchObject({ industry: 'retail', isDemo: true, role: 'admin' });
    expect(byId[MFG]).toMatchObject({ industry: 'manufacturing', role: 'manager' });
  });

  it('switching issues a session scoped to the target workspace; a non-member workspace is refused', async () => {
    const r = await auth.switchWorkspace(USER, MFG);
    const claims = verifySession(r.token, config.auth.secret);
    expect(claims).toMatchObject({ sub: USER, org: MFG, role: 'manager', ws: true });
    const me = await auth.me(USER, claims);
    expect(me).toMatchObject({ organizationId: MFG, role: 'manager', isDemo: true, homeOrganizationId: HOME });
    await expect(auth.switchWorkspace(USER, OTHER)).rejects.toThrow(/access/i);
    await expect(auth.switchWorkspace(USER, GR)).rejects.toThrow(/access/i);
    // Back home: no ws claim needed.
    const home = verifySession((await auth.switchWorkspace(USER, HOME)).token, config.auth.secret);
    expect(home.org).toBe(HOME);
    expect(home.ws).toBeUndefined();
  });

  it('a switched session stops working once the membership is removed', async () => {
    const token = (await auth.switchWorkspace(USER, RETAIL)).token;
    expect(await new AuthGuard(reflector, prisma).canActivate(ctx(token))).toBe(true);
    await prisma.organizationMembership.delete({ where: { userId_organizationId: { userId: USER, organizationId: RETAIL } } });
    // Access checks are cached process-wide (as with the single production guard); removal through the team API
    // clears the cache at once, an out-of-band database edit applies within seconds.
    invalidateAccess(USER);
    await expect(new AuthGuard(reflector, prisma).canActivate(ctx(token))).rejects.toThrow(/removed/i);
    await expect(auth.me(USER, verifySession(token, config.auth.secret))).rejects.toThrow();
    await prisma.organizationMembership.create({ data: { userId: USER, organizationId: RETAIL, role: 'admin' } });
    invalidateAccess(USER);
  });

  // ------------------------------------------------------------------ industry lock

  it('a restaurant workspace cannot change industry; others can, and the change is audited', async () => {
    await expect(settingsCtl.update(GR, { sub: USER, role: 'admin' }, { industry: 'textile' })).rejects.toThrow(/restaurant/i);
    expect((await industry.workspace(GR)).industry).toBe('restaurant');
    expect((await industry.workspace(GR)).canChangeIndustry).toBe(false);

    await settingsCtl.update(OTHER, { sub: USER, role: 'admin' }, { industry: 'agency' });
    expect((await industry.workspace(OTHER)).industry).toBe('agency');
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: OTHER, action: 'industry_changed' } });
    expect(audit?.data).toMatchObject({ from: 'manufacturing', to: 'agency' });
    await settingsCtl.update(OTHER, { sub: USER, role: 'admin' }, { industry: 'manufacturing' });
    await expect(settingsCtl.update(OTHER, { sub: USER, role: 'manager' }, { industry: 'retail' })).rejects.toThrow(/admin/i);
  });

  // ------------------------------------------------------------------ generic engine

  it('a retail conversation never gets the property assistant: one handoff, no promises', async () => {
    const p = phone();
    const customer = await prisma.customer.create({ data: { organizationId: RETAIL, phone: p, name: 'Shopper' } });
    const lead = await prisma.lead.create({ data: { organizationId: RETAIL, customerId: customer.id, source: 'whatsapp', status: 'new' } });
    const send = (message: string) => engine.generate({ organizationId: RETAIL, channel: 'whatsapp', phone: p, message, leadId: lead.id });
    const first = await send('Hi, I want a 2 BHK flat in Velachery under 80 lakhs, can I visit tomorrow?');
    expect(first.response).not.toMatch(/BHK|site visit|property|flat|lakh/i);
    expect(first.response).toMatch(/team/i);
    expect(first.actions?.handoff).toBe(true);
    const second = await send('Is the blue kurta available in size M?');
    expect(second.response).not.toMatch(/available|in stock|price|₹/i);
    // Later messages in the thread are noted for the team: never a second greeting, and never a real-estate question
    // (the repeat guard once swapped a repeated line for "Which locality would you prefer?").
    for (const m of ['I want to talk to someone', 'Budget around 50,000, Chennai', 'ok']) {
      const r = await send(m);
      expect(r.response).not.toMatch(/locality|area|budget|BHK|visit|Thank you for contacting/i);
      expect(r.response).toMatch(/team/i);
    }
    const tasks = await prisma.followUp.findMany({ where: { organizationId: RETAIL, customerId: customer.id, channel: 'human' } });
    expect(tasks).toHaveLength(1);
    const after = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(after.bhk).toBeNull();
    expect(after.location).toBeNull();
    expect(after.budget).toBeNull();
    expect(await prisma.siteVisit.count({ where: { organizationId: RETAIL } })).toBe(0);
  });

  // ------------------------------------------------------------------ quality

  it('quality inspections validate input and stats add up from the recorded quantities', async () => {
    await expect(quality.create(MFG, { batchCode: 'B-1', productName: 'Bracket', inspectedQty: 100, rejectedQty: 120 }, 'user:t')).rejects.toThrow(/between/);
    await expect(quality.create(MFG, { batchCode: '', productName: 'Bracket', inspectedQty: 100 }, 'user:t')).rejects.toThrow(/batch/i);
    const a = await quality.create(MFG, { batchCode: 'B-1', productName: 'Bracket', line: 'Line 1', inspectedQty: 200, rejectedQty: 4, defects: [{ category: 'Burr', count: 3 }, { category: 'burr', count: 2 }, { category: 'dent', count: 1 }] }, 'user:t');
    expect(a.defects).toEqual([{ category: 'burr', count: 5 }, { category: 'dent', count: 1 }]);
    await quality.create(MFG, { batchCode: 'B-2', productName: 'Bracket', line: 'Line 3', inspectedQty: 100, rejectedQty: 12, severity: 'major', defects: [{ category: 'weld crack', count: 12 }] }, 'user:t');
    const clean = await quality.create(MFG, { batchCode: 'B-3', productName: 'Hinge', line: 'Line 1', inspectedQty: 100, rejectedQty: 0 }, 'user:t');
    expect(clean.status).toBe('resolved');
    await expect(quality.create(MFG, { batchCode: 'B-1', productName: 'Again', inspectedQty: 5 }, 'user:t')).rejects.toThrow(/already recorded/);
    // Another tenant's inspection must never be counted.
    await quality.create(OTHER, { batchCode: 'B-1', productName: 'Foreign', inspectedQty: 1000, rejectedQty: 900 }, 'user:t');

    const s = await quality.stats(MFG, 30);
    expect(s).toMatchObject({ inspections: 3, unitsInspected: 400, unitsRejected: 16, defects: 18, rejectionRate: 4, defectRate: 4.5, open: 2 });
    expect(s.byCategory[0]).toEqual({ category: 'weld crack', count: 12 });
    expect(s.byLine.find((l: any) => l.line === 'Line 3').rejectionRate).toBe(12);
  });

  it('the quality alert scan raises one corrective-action task per batch above the threshold (deduplicated)', async () => {
    const run = (key: string) => orchestrator.submit(MFG, { kind: 'operations.quality_alert_scan', input: { days: 30, thresholdPct: 5 }, trigger: 'user', idempotencyKey: key, requestedBy: 'user:t' }, { runNow: true });
    const first = await run(`scan-a-${Date.now()}`);
    await run(`scan-b-${Date.now()}`);
    expect((await orchestrator.getTask(MFG, first.task.id)).status).toBe('COMPLETED');
    const tasks = await prisma.workTask.findMany({ where: { organizationId: MFG, entityType: 'quality_inspection' } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toMatch(/B-2/);
  });

  it('a resolved inspection records the action; resolving twice is refused', async () => {
    const row = (await quality.list(MFG, { q: 'B-2' }))[0];
    await quality.resolve(MFG, row.id, 'Welder re-trained, fixture replaced', 'user:t');
    await expect(quality.resolve(MFG, row.id, 'again', 'user:t')).rejects.toThrow(/already resolved/);
    await expect(quality.resolve(OTHER, row.id, 'cross-tenant', 'user:t')).rejects.toThrow(/not found/i);
    expect((await quality.stats(MFG, 30)).open).toBe(1);
  });

  // ------------------------------------------------------------------ dashboards

  it('the manufacturing dashboard matches the inspection records and ignores other tenants', async () => {
    const d = await industry.dashboard(MFG, 30);
    const k = Object.fromEntries(d.kpis.map((x: any) => [x.key, x.value]));
    const s = await quality.stats(MFG, 30);
    expect(d.industry).toBe('manufacturing');
    expect(d.demo).toBe(true);
    expect(k).toMatchObject({ inspections: s.inspections, units: s.unitsInspected, rejection_rate: s.rejectionRate, defect_rate: s.defectRate, open: s.open });
    expect(d.kpis.map((x: any) => x.key)).not.toContain('sales');
  });

  it('the retail dashboard counts only confirmed orders of this workspace and shows no quotation figures', async () => {
    const c = await prisma.customer.create({ data: { organizationId: RETAIL, phone: phone(), name: 'Buyer' } });
    const mk = (number: string, status: string, total: number, org = RETAIL, customerId = c.id) =>
      prisma.salesOrder.create({ data: { organizationId: org, customerId, number, status, total } });
    await mk('MI-1', 'confirmed', 1500);
    await mk('MI-2', 'delivered', 2500);
    await mk('MI-3', 'cancelled', 9999);
    await mk('MI-4', 'pending_confirmation', 700);
    const oc = await prisma.customer.create({ data: { organizationId: OTHER, phone: phone(), name: 'Foreign buyer' } });
    await mk('MI-X', 'confirmed', 50000, OTHER, oc.id);
    const d = await industry.dashboard(RETAIL, 30);
    const k = Object.fromEntries(d.kpis.map((x: any) => [x.key, x.value]));
    expect(k.sales).toBe(4000);
    expect(k.orders).toBe(2);
    expect(Object.keys(k)).not.toContain('pending_quotes');
    expect(Object.keys(k)).not.toContain('quote_conversion');
    const funnel = d.charts.find((x: any) => x.key === 'funnel');
    expect(funnel.labels.join(' ')).not.toMatch(/quotation/i);
  });

  it('the restaurant dashboard never shows sales-order or property figures', async () => {
    const d = await industry.dashboard(GR, 7);
    const keys = d.kpis.map((x: any) => x.key);
    expect(d.industry).toBe('restaurant');
    expect(keys).toEqual(expect.arrayContaining(['today_revenue', 'orders', 'aov', 'feedback']));
    expect(keys).not.toContain('visits');
    expect(keys).not.toContain('pending_quotes');
  });

  // ------------------------------------------------------------------ catalogue

  it('each workspace lists only its own industry agents (plus shared ones); unavailable agents say so', async () => {
    for (const [org, ind] of [[RETAIL, 'retail'], [MFG, 'manufacturing'], [GR, 'restaurant'], [HOME, 'real_estate']] as const) {
      const c = await industry.catalogue(org);
      expect(c.industry).toBe(ind);
      expect(c.agents.length).toBeGreaterThanOrEqual(10);
      for (const a of c.agents) expect([ind, 'shared']).toContain(a.industry);
      for (const a of c.agents.filter((x: any) => x.runtime.type === 'unavailable')) {
        expect(a.status).toBe('unavailable');
        expect(a.playground).toBe('none');
      }
    }
    const retail = await industry.catalogue(RETAIL);
    // Retail never routes to the property or textile assistants.
    for (const a of retail.agents.filter((x: any) => x.runtime.type === 'conversation')) expect(a.runtime.engine).toBe('generic');
    const mfg = await industry.catalogue(MFG);
    const summary = mfg.agents.find((a: any) => a.runtime.type === 'task' && a.runtime.kind === 'operations.quality_summary');
    expect(summary.status).toBe('demo');
    expect(summary.playground).toBe('task');
    const live = await industry.catalogue(MFG_LIVE);
    expect(live.agents.find((a: any) => a.id === summary.id).status).toBe('active');
  });

  // ------------------------------------------------------------------ playground

  it('the playground is refused in a live workspace', async () => {
    const agent = (await industry.catalogue(MFG_LIVE)).agents.find((a: any) => a.playground === 'task');
    await expect(industry.playground(MFG_LIVE, USER, { agentId: agent.id })).rejects.toThrow(/demo workspace/i);
    await expect(industry.playground(GR, USER, { agentId: 'restaurant.ordering', message: 'hi' })).rejects.toThrow(/demo workspace/i);
  });

  it('in a demo workspace a task agent runs on demo records and a conversation agent uses a synthetic customer; nothing is sent', async () => {
    const agent = (await industry.catalogue(MFG)).agents.find((a: any) => a.runtime.type === 'task' && a.runtime.kind === 'operations.quality_summary');
    const r = await industry.playground(MFG, USER, { agentId: agent.id });
    expect(r).toMatchObject({ mode: 'task', status: 'COMPLETED', sent: false });
    expect(r.result.inspections).toBe(3);

    const conv = (await industry.catalogue(RETAIL)).agents.find((a: any) => a.playground === 'conversation');
    const before = await prisma.customer.count({ where: { organizationId: RETAIL, isDemo: false } });
    const c = await industry.playground(RETAIL, USER, { agentId: conv.id, message: 'Do you deliver to Coimbatore?', session: 's1' });
    expect(c).toMatchObject({ mode: 'conversation', sent: false });
    const synthetic = await prisma.customer.findFirst({ where: { organizationId: RETAIL, source: 'playground' } });
    expect(synthetic.isDemo).toBe(true);
    expect(await prisma.customer.count({ where: { organizationId: RETAIL, isDemo: false } })).toBe(before);
    expect(sentWhatsApp).not.toHaveBeenCalled();
    // An agent from another industry is not runnable here.
    await expect(industry.playground(RETAIL, USER, { agentId: agent.id })).rejects.toThrow(/not part/i);
  });
});
