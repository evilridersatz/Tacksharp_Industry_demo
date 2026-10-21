/**
 * AI Orchestrator + four agents + operations (inventory) against the real MySQL test database.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/agents.integration.spec.ts
 *
 * REAL: Orchestrator, task kinds, ApprovalsService, WorkTasksService, InventoryService, TextileService + its events,
 * SettingsService, every database write. FAKE: WhatsApp sender (records calls). No message is sent, no call placed.
 * Test-only task kinds (prefixed `test.`) exercise retries, timeouts, approvals and loops.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const ORG = 'org_agents_test';
const OTHER = 'org_agents_other';
const ADMIN = { sub: 'u_admin', role: 'admin' };
const SALES = { sub: 'u_sales', role: 'sales' };
let n = 0;
const uniquePhone = () => `91${String(Date.now()).slice(-7)}${String(n++).padStart(3, '0')}`;
const key = (p: string) => `${p}-${Date.now()}-${n++}`;

describe.skipIf(!enabled)('AI agents + operations (integration)', () => {
  let prisma: any, leads: any, textile: any, inventory: any, orchestrator: any, approvals: any, workTasks: any, settings: any, events: any;
  const sender = { sendText: vi.fn(), sendWithinPolicy: vi.fn(), sendNamedTemplate: vi.fn() };
  let poplin: any, silk: any, untracked: any;

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { LeadsService } = await import('../src/leads/leads.service.js');
    const { FollowUpsService } = await import('../src/follow-ups/follow-ups.service.js');
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { ApprovalsService } = await import('../src/governance/approvals.service.js');
    const { WorkTasksService } = await import('../src/governance/work-tasks.service.js');
    const { TextileEvents } = await import('../src/textile/textile-events.js');
    const { TextileService } = await import('../src/textile/textile.service.js');
    const { InventoryService } = await import('../src/operations/inventory.service.js');
    const { Orchestrator } = await import('../src/agents/orchestrator.service.js');
    const { FinanceService } = await import('../src/finance/finance.service.js');
    const { FinanceEvents } = await import('../src/finance/finance-events.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, name] of [[ORG, 'Agents Textiles'], [OTHER, 'Other Agents Mills']]) {
      await prisma.organization.upsert({ where: { id }, update: {}, create: { id, name } });
      await prisma.organizationSettings.upsert({ where: { organizationId: id }, update: { data: { industry: 'textile', textile: { maxDiscountPct: 10 } } }, create: { organizationId: id, data: { industry: 'textile', textile: { maxDiscountPct: 10 } } } });
    }
    settings = new SettingsService(prisma);
    const conversations = new ConversationsService(prisma);
    leads = new LeadsService(prisma);
    const followUps = new FollowUpsService(prisma, settings);
    approvals = new ApprovalsService(prisma);
    workTasks = new WorkTasksService(prisma);
    events = new TextileEvents();
    textile = new TextileService(prisma, followUps, leads, conversations, settings, sender as never, approvals, events);
    inventory = new InventoryService(prisma);
    const fevents = new FinanceEvents();
    const finance = new FinanceService(prisma, approvals, workTasks, settings, fevents);
    orchestrator = new Orchestrator(prisma, inventory, workTasks, approvals, settings, events, finance, fevents);
    orchestrator.useQueue(null);
    orchestrator.onModuleInit();

    await prisma.textileProduct.deleteMany({ where: { organizationId: { in: [ORG, OTHER] } } });
    poplin = await textile.createProduct(ORG, { sku: 'AG-POP', name: 'Agent Poplin', fabricCategory: 'cotton shirting', priceUnit: 'metre', price: 180, priceApproved: true }, 'test');
    silk = await textile.createProduct(ORG, { sku: 'AG-SLK', name: 'Agent Silk', fabricCategory: 'silk saree', priceUnit: 'piece', price: 9000, priceApproved: true }, 'test');
    untracked = await textile.createProduct(ORG, { sku: 'AG-UNT', name: 'Agent Untracked', fabricCategory: 'linen', priceUnit: 'metre', price: 300, priceApproved: true }, 'test');
    await inventory.track(ORG, poplin.id, { lowStockAt: 100 });
    await inventory.track(ORG, silk.id, {});
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    const { followUpQueue, whatsappQueue, agentQueue, closeRedisConnections } = await import('../src/queues/queues.js');
    await Promise.allSettled([followUpQueue.close(), whatsappQueue.close(), agentQueue.close()]);
    await closeRedisConnections();
  });

  beforeEach(() => {
    sender.sendText.mockReset().mockResolvedValue('wamid.agents');
    sender.sendWithinPolicy.mockReset().mockImplementation(async (p: any) => ({ kind: 'text', messageId: 'wamid.step', content: p.text }));
  });

  const receive = (productId: string, quantity: number) => inventory.apply(ORG, [{ productId, type: 'receive', quantity, reference: 'GRN-T', actor: 'user:test', idempotencyKey: key('rcv') }]);
  const balance = async (productId: string) => {
    const b = await prisma.inventoryBalance.findFirst({ where: { productId } });
    return { onHand: Number(b.onHand), reserved: Number(b.reserved) };
  };
  /** Lead -> quotation -> approved -> sent (stub WhatsApp) -> accepted -> order. Returns the pending order. */
  async function orderFor(items: Array<{ productId?: string; description?: string; quantity: number; unitPrice?: number; unit?: string }>, org = ORG) {
    const lead = await leads.createLead({ organizationId: org, name: 'Agent Buyer', phone: uniquePhone(), source: 'meta_lead_ads', campaign: 'Diwali Shirting' });
    const q = await textile.createQuotation(org, { leadId: lead.id, items }, 'test');
    await textile.setQuotationStatus(org, q.id, 'approved', 'user:a', 'admin');
    await prisma.customer.update({ where: { id: lead.customerId }, data: { lastInboundAt: new Date() } });
    await textile.sendQuotation(org, q.id, 'user:a');
    await textile.setQuotationStatus(org, q.id, 'accepted', 'user:a');
    const { order } = await textile.convertToOrder(org, q.id, 'user:a');
    return { order, lead, quotation: q };
  }
  /** Operations-agent tasks for an order (Finance also drafts an invoice on confirmation; covered in finance spec). */
  const tasksFor = (orderId: string) => prisma.agentTask.findMany({ where: { organizationId: ORG, entityId: orderId, agent: { in: ['operations', 'sales'] } }, orderBy: { createdAt: 'asc' }, include: { events: true } });

  // ------------------------------------------------------------------ registry and routing
  describe('orchestrator', () => {
    it('four agents registered; every task kind routes to its declared agent; unknown kinds are refused', async () => {
      const overview = await orchestrator.agentsOverview(ORG);
      expect(overview.map((a: any) => a.name).sort()).toEqual(['finance', 'marketing', 'operations', 'sales']);
      for (const k of orchestrator.listKinds()) expect(k.kind.split('.')[0]).toBe(k.agent);
      await expect(orchestrator.submit(ORG, { kind: 'nope.task', trigger: 'user', idempotencyKey: key('x'), requestedBy: 'user:a' })).rejects.toThrow(/Unknown task kind/);
      await expect(orchestrator.submit(ORG, { kind: 'sales.availability_check', input: { productId: poplin.id, quantity: -1 }, trigger: 'user', idempotencyKey: key('x'), requestedBy: 'user:a' })).rejects.toThrow(/positive/);
    });

    it('server-side tool permissions: an agent calling a tool outside its list fails, recorded, no retry', async () => {
      orchestrator.registerKind({
        kind: 'test.finance_reserves', agent: 'finance', label: 'bad', description: '', userRunnable: false, parse: () => ({}),
        run: async (ctx: any) => { await ctx.tool('inventory.reserve', async () => 'should never run'); return { status: 'completed', summary: 'x', result: {} }; },
      });
      const { task } = await orchestrator.submit(ORG, { kind: 'test.finance_reserves', trigger: 'user', idempotencyKey: key('perm'), requestedBy: 'user:a' }, { runNow: true });
      expect(task.status).toBe('FAILED');
      expect(task.attempts).toBe(1);
      expect(task.error).toMatch(/finance agent cannot use tool inventory.reserve/);
      expect(task.events.map((e: any) => e.type)).toContain('tool_denied');
    });

    it('idempotent: the same key twice is one task and one run', async () => {
      const k = key('idem');
      const a = await orchestrator.submit(ORG, { kind: 'finance.receivables_snapshot', trigger: 'user', idempotencyKey: k, requestedBy: 'user:a' }, { runNow: true });
      const b = await orchestrator.submit(ORG, { kind: 'finance.receivables_snapshot', trigger: 'user', idempotencyKey: k, requestedBy: 'user:a' }, { runNow: true });
      expect(b.duplicate).toBe(true);
      expect(b.task.id).toBe(a.task.id);
      expect(a.task.events.filter((e: any) => e.type === 'started')).toHaveLength(1);
      expect(a.task.result).toMatchObject({ verified: true }); // balances from VERIFIED payments only (pending listed apart)
    });

    it('transient failure retries with back-off; timeout counts as failure; permanent errors fail at once; manual retry', async () => {
      let calls = 0;
      orchestrator.registerKind({
        kind: 'test.flaky', agent: 'operations', label: 'flaky', description: '', userRunnable: false, parse: () => ({}), maxAttempts: 2,
        run: async () => { calls++; if (calls === 1) throw new Error('database blip'); return { status: 'completed', summary: 'ok', result: { calls } }; },
      });
      const { task } = await orchestrator.submit(ORG, { kind: 'test.flaky', trigger: 'user', idempotencyKey: key('flaky'), requestedBy: 'user:a' }, { runNow: true });
      expect(task.status).toBe('PENDING');
      expect(task.runAfter).toBeTruthy();
      expect(task.events.map((e: any) => e.type)).toContain('retry');
      expect((await orchestrator.run(ORG, task.id)).status).toBe('PENDING'); // not before its retry time
      await prisma.agentTask.update({ where: { id: task.id }, data: { runAfter: new Date(Date.now() - 1000) } });
      expect((await orchestrator.run(ORG, task.id)).status).toBe('COMPLETED');

      orchestrator.registerKind({ kind: 'test.slow', agent: 'operations', label: 'slow', description: '', userRunnable: false, parse: () => ({}), timeoutMs: 50, maxAttempts: 1, run: () => new Promise(() => undefined) });
      const slow = await orchestrator.submit(ORG, { kind: 'test.slow', trigger: 'user', idempotencyKey: key('slow'), requestedBy: 'user:a' }, { runNow: true });
      expect(slow.task.status).toBe('FAILED');
      expect(slow.task.error).toMatch(/Timed out after 50 ms/);

      const { BadRequestException } = await import('@nestjs/common');
      let attempt = 0;
      orchestrator.registerKind({
        kind: 'test.rule', agent: 'operations', label: 'rule', description: '', userRunnable: false, parse: () => ({}),
        run: async () => { attempt++; if (attempt === 1) throw new BadRequestException('business rule'); return { status: 'completed', summary: 'ok', result: {} }; },
      });
      const rule = await orchestrator.submit(ORG, { kind: 'test.rule', trigger: 'user', idempotencyKey: key('rule'), requestedBy: 'user:a' }, { runNow: true });
      expect(rule.task.status).toBe('FAILED'); // 4xx = permanent, no pointless retries
      expect(rule.task.attempts).toBe(1);
      expect((await orchestrator.retry(ORG, rule.task.id, 'user:a')).status).toBe('COMPLETED');
      await expect(orchestrator.retry(ORG, rule.task.id, 'user:a')).rejects.toThrow(/Only a failed task/);
    });

    it('handoffs are bounded: an agent handing work to itself stops at the depth limit', async () => {
      orchestrator.registerKind({
        kind: 'test.loop', agent: 'sales', label: 'loop', description: '', userRunnable: false, parse: () => ({}),
        run: async () => ({ status: 'completed', summary: 'again', result: {}, handoffs: [{ kind: 'test.loop', input: {}, reason: 'loop' }] }),
      });
      const { task } = await orchestrator.submit(ORG, { kind: 'test.loop', trigger: 'user', idempotencyKey: key('loop'), requestedBy: 'user:a' }, { runNow: true });
      const chain = await prisma.agentTask.findMany({ where: { organizationId: ORG, idempotencyKey: { startsWith: task.idempotencyKey } } });
      expect(chain).toHaveLength(4); // depth 0..3
      const last = chain.find((t: any) => t.depth === 3);
      const evs = await prisma.agentTaskEvent.findMany({ where: { taskId: last.id } });
      expect(evs.some((e: any) => e.type === 'handoff_failed' && /too deep/.test(e.message))).toBe(true);
    });

    it('needs approval: task waits; only a person with the permission approves; approval runs it; rejection cancels it', async () => {
      orchestrator.registerKind({
        kind: 'test.binding', agent: 'sales', label: 'binding', description: '', userRunnable: false, parse: (raw: any) => ({ v: raw?.v ?? 1 }),
        entity: () => ({ type: 'product', id: poplin.id }),
        run: async (ctx: any, input: any) => (ctx.approved
          ? { status: 'completed', summary: 'done after approval', result: { approved: true } }
          : { status: 'needs_approval', action: 'promise_delivery', reason: 'Exceptional delivery promise', payload: { v: input.v }, requiredPermission: 'sales.approve_discount', entity: { type: 'product', id: poplin.id } }),
      });
      const a = await orchestrator.submit(ORG, { kind: 'test.binding', input: { v: 1 }, trigger: 'user', idempotencyKey: key('appr'), requestedBy: 'user:a' }, { runNow: true });
      expect(a.task.status).toBe('NEEDS_APPROVAL');
      await expect(approvals.decide(ORG, a.task.approvalId, 'approve', SALES)).rejects.toThrow(/sales.approve_discount/);
      await expect(approvals.decide(OTHER, a.task.approvalId, 'approve', ADMIN)).rejects.toThrow(/not found/); // tenant
      const decided = await approvals.decide(ORG, a.task.approvalId, 'approve', ADMIN);
      expect(decided.status).toBe('executed');
      expect((await orchestrator.getTask(ORG, a.task.id))).toMatchObject({ status: 'COMPLETED', result: { approved: true } });
      await expect(approvals.decide(ORG, a.task.approvalId, 'approve', ADMIN)).rejects.toThrow(/already executed/);

      const b = await orchestrator.submit(ORG, { kind: 'test.binding', input: { v: 2 }, trigger: 'user', idempotencyKey: key('appr'), requestedBy: 'user:a' }, { runNow: true });
      await expect(approvals.decide(ORG, b.task.approvalId, 'reject', ADMIN)).rejects.toThrow(/reason/);
      await approvals.decide(ORG, b.task.approvalId, 'reject', ADMIN, 'Not this month');
      await orchestrator.settleRejectedApprovals(ORG);
      expect(await orchestrator.getTask(ORG, b.task.id)).toMatchObject({ status: 'CANCELLED', error: 'Approval rejected: Not this month' });
    });

    it('pause / resume: a paused agent takes no work; resuming runs what waited', async () => {
      await orchestrator.setPaused(ORG, 'finance', true);
      const { task } = await orchestrator.submit(ORG, { kind: 'finance.receivables_snapshot', trigger: 'user', idempotencyKey: key('pause'), requestedBy: 'user:a' }, { runNow: true });
      expect(task.status).toBe('PENDING');
      expect(task.events.map((e: any) => e.type)).toContain('paused');
      await orchestrator.setPaused(ORG, 'finance', false);
      expect((await orchestrator.getTask(ORG, task.id)).status).toBe('COMPLETED');
    });

    it("tenant isolation: tasks, approvals, work tasks and stock of one business are invisible to another", async () => {
      const { task } = await orchestrator.submit(ORG, { kind: 'finance.receivables_snapshot', trigger: 'user', idempotencyKey: key('iso'), requestedBy: 'user:a' }, { runNow: true });
      await expect(orchestrator.getTask(OTHER, task.id)).rejects.toThrow(/not found/);
      await expect(orchestrator.cancel(OTHER, task.id, 'user:x')).rejects.toThrow(/not found/);
      expect((await orchestrator.listTasks(OTHER)).some((t: any) => t.id === task.id)).toBe(false);
      await expect(inventory.track(OTHER, poplin.id, {})).rejects.toThrow(/Product not found/);
      await expect(inventory.apply(OTHER, [{ productId: poplin.id, type: 'receive', quantity: 5, actor: 'x', idempotencyKey: key('iso') }])).rejects.toThrow(/not stock-tracked/);
      expect((await inventory.balances(OTHER)).some((r: any) => r.productId === poplin.id)).toBe(false);
      // Same idempotency key in another business is a different task.
      const k = key('shared');
      const mine = await orchestrator.submit(ORG, { kind: 'finance.receivables_snapshot', trigger: 'user', idempotencyKey: k, requestedBy: 'u' });
      const theirs = await orchestrator.submit(OTHER, { kind: 'finance.receivables_snapshot', trigger: 'user', idempotencyKey: k, requestedBy: 'u' });
      expect(theirs.duplicate).toBe(false);
      expect(theirs.task.id).not.toBe(mine.task.id);
    });
  });

  // ------------------------------------------------------------------ inventory
  describe('inventory', () => {
    it('receive / reserve / release / dispatch with history; never negative; adjust cannot go below reserved', async () => {
      const before = await balance(poplin.id);
      await receive(poplin.id, 100);
      const k = key('res');
      await inventory.apply(ORG, [{ productId: poplin.id, type: 'reserve', quantity: 40, actor: 't', idempotencyKey: k }]);
      const again = await inventory.apply(ORG, [{ productId: poplin.id, type: 'reserve', quantity: 40, actor: 't', idempotencyKey: k }]);
      expect(again[0].duplicate).toBe(true); // a retried reservation never takes stock twice
      expect(await balance(poplin.id)).toEqual({ onHand: before.onHand + 100, reserved: before.reserved + 40 });
      await expect(inventory.apply(ORG, [{ productId: poplin.id, type: 'reserve', quantity: before.onHand - before.reserved + 61, actor: 't', idempotencyKey: key('res') }])).rejects.toThrow(/Not enough stock/);
      await expect(inventory.apply(ORG, [{ productId: poplin.id, type: 'adjust', quantity: -(before.onHand + 100 - before.reserved - 40 + 1), actor: 't', idempotencyKey: key('adj') }])).rejects.toThrow(/below what is reserved/);
      await inventory.apply(ORG, [{ productId: poplin.id, type: 'release', quantity: 40, actor: 't', idempotencyKey: key('rel') }]);
      expect(await balance(poplin.id)).toEqual({ onHand: before.onHand + 100, reserved: before.reserved });
      const mv = await inventory.movements(ORG, { productId: poplin.id });
      expect(mv[0]).toMatchObject({ type: 'release' });
      expect(Number(mv[0].reservedAfter)).toBe(before.reserved);
      await expect(inventory.apply(ORG, [{ productId: untracked.id, type: 'receive', quantity: 5, actor: 't', idempotencyKey: key('u') }])).rejects.toThrow(/not stock-tracked/);
    });

    it('parallel reservations for the last stock: exactly one wins, stock never goes negative', async () => {
      const b = await balance(silk.id);
      const free = b.onHand - b.reserved;
      await receive(silk.id, 10 - free > 0 ? 10 - free : 0.01);
      const avail = (await balance(silk.id)).onHand - (await balance(silk.id)).reserved;
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => inventory.apply(ORG, [{ productId: silk.id, type: 'reserve', quantity: avail, actor: 't', idempotencyKey: key('par') }])));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const after = await balance(silk.id);
      expect(after.onHand - after.reserved).toBeCloseTo(0, 5);
      // give it back for later tests
      await inventory.apply(ORG, [{ productId: silk.id, type: 'release', quantity: avail, actor: 't', idempotencyKey: key('back') }]);
    });

    it('stock correction always goes through an approval and is applied exactly once', async () => {
      const before = await balance(poplin.id);
      const r = await approvals.request(ORG, { action: 'inventory.adjust', entityType: 'product', entityId: poplin.id, reason: 'count diff', payload: { productId: poplin.id, delta: -5, reason: 'count diff', request: key('c') }, requiredPermission: 'operations.adjust_stock', requestedBy: 'user:ops', requesterRole: 'operations' });
      expect(r.approved).toBe(false);
      approvals.registerExecutor('inventory.adjust', async (a: any, by: string) => {
        const p = a.payload;
        const [m] = await inventory.apply(a.organizationId, [{ productId: p.productId, type: 'adjust', quantity: p.delta, reason: p.reason, actor: by, idempotencyKey: `adjust:${a.id}` }]);
        return { movementId: m.id };
      });
      expect(await balance(poplin.id)).toEqual(before); // nothing until approved
      await expect(approvals.decide(ORG, r.approval.id, 'approve', { sub: 'ops', role: 'operations' })).rejects.toThrow(/operations.adjust_stock/);
      const done = await approvals.decide(ORG, r.approval.id, 'approve', ADMIN);
      expect(done.status).toBe('executed');
      expect(await balance(poplin.id)).toEqual({ onHand: before.onHand - 5, reserved: before.reserved });
    });
  });

  // ------------------------------------------------------------------ cross-agent workflows
  describe('workflows', () => {
    it('order confirmed -> Operations reserves (agent task); ready / dispatch need the reservation; dispatch deducts; history recorded', async () => {
      await receive(poplin.id, 500);
      const start = await balance(poplin.id);
      const { order } = await orderFor([{ productId: poplin.id, quantity: 200 }, { productId: untracked.id, quantity: 10 }]);
      await textile.setOrderStatus(ORG, order.id, 'confirmed', 'user:a');
      const [t] = await tasksFor(order.id);
      expect(t).toMatchObject({ agent: 'operations', kind: 'operations.reserve_order', trigger: 'event', status: 'COMPLETED', result: { outcome: 'reserved' } });
      expect(t.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['created', 'started', 'tool', 'completed']));
      expect(await balance(poplin.id)).toEqual({ onHand: start.onHand, reserved: start.reserved + 200 });
      // The same event again (retried webhook / double click) does nothing more.
      await events.orderStatus({ organizationId: ORG, orderId: order.id, orderNumber: order.number, from: 'pending_confirmation', to: 'confirmed', actor: 'user:a' });
      expect(await balance(poplin.id)).toEqual({ onHand: start.onHand, reserved: start.reserved + 200 });
      expect((await tasksFor(order.id)).length).toBe(1);

      await textile.setOrderStatus(ORG, order.id, 'processing', 'user:a');
      await textile.setOrderStatus(ORG, order.id, 'ready_to_dispatch', 'user:a');
      await textile.setOrderStatus(ORG, order.id, 'dispatched', 'user:a');
      expect(await balance(poplin.id)).toEqual({ onHand: start.onHand - 200, reserved: start.reserved });
      const kinds = (await tasksFor(order.id)).map((x: any) => `${x.kind}:${x.status}`);
      expect(kinds).toEqual(['operations.reserve_order:COMPLETED', 'operations.dispatch_order:COMPLETED']);
      const st = await inventory.orderStock(ORG, order.id);
      expect(st.fullyDispatched).toBe(true);
    });

    it('stock shortage: nothing reserved, exception + procurement tasks, Sales review handoff; dispatch blocked; after receiving, reserve succeeds', async () => {
      const b = await balance(silk.id);
      const avail = b.onHand - b.reserved;
      const { order } = await orderFor([{ productId: silk.id, quantity: avail + 5 }]);
      await textile.setOrderStatus(ORG, order.id, 'confirmed', 'user:a');
      const [ops] = await tasksFor(order.id);
      expect(ops.result).toMatchObject({ outcome: 'shortage' });
      expect(await balance(silk.id)).toEqual(b); // all-or-nothing: nothing reserved
      const child = await prisma.agentTask.findFirst({ where: { parentTaskId: ops.id } });
      expect(child).toMatchObject({ agent: 'sales', kind: 'sales.stock_shortage_review', trigger: 'handoff', status: 'COMPLETED', depth: 1 });
      expect(ops.events.some((e: any) => e.type === 'handoff')).toBe(true);
      const wt = await workTasks.list(ORG, { entityType: 'order', entityId: order.id });
      expect(wt.map((w: any) => `${w.agent}:${w.kind}`).sort()).toEqual(['operations:exception', 'sales:review']);
      expect(await prisma.workTask.count({ where: { organizationId: ORG, kind: 'procurement', entityId: silk.id } })).toBeGreaterThan(0);
      // Sales must not promise: availability check says not enough.
      const chk = await orchestrator.submit(ORG, { kind: 'sales.availability_check', input: { productId: silk.id, quantity: avail + 5 }, trigger: 'user', idempotencyKey: key('av'), requestedBy: 'user:a' }, { runNow: true });
      expect(chk.task.result).toMatchObject({ tracked: true, canPromise: false });
      const unt = await orchestrator.submit(ORG, { kind: 'sales.availability_check', input: { productId: untracked.id, quantity: 1 }, trigger: 'user', idempotencyKey: key('av'), requestedBy: 'user:a' }, { runNow: true });
      expect(unt.task.result).toMatchObject({ tracked: false, canPromise: false });
      // Dispatch is refused on the server while stock is not reserved.
      await textile.setOrderStatus(ORG, order.id, 'processing', 'user:a');
      await expect(textile.setOrderStatus(ORG, order.id, 'ready_to_dispatch', 'user:a')).rejects.toThrow(/Stock is not reserved/);
      expect((await prisma.salesOrder.findUnique({ where: { id: order.id } })).status).toBe('processing');
      // An exception cannot be closed without recording the decision.
      const ex = wt.find((w: any) => w.kind === 'exception');
      await expect(workTasks.update(ORG, ex.id, { status: 'done' })).rejects.toThrow(/Record the decision/);
      // Stock arrives -> reserve again (user) -> ready.
      await receive(silk.id, 10);
      const again = await orchestrator.submit(ORG, { kind: 'operations.reserve_order', input: { orderId: order.id }, trigger: 'user', idempotencyKey: key('re'), requestedBy: 'user:a' }, { runNow: true });
      expect(again.task.result).toMatchObject({ outcome: 'reserved' });
      await workTasks.update(ORG, ex.id, { status: 'done', resolution: 'Waited for replenishment; customer agreed new date' });
      await expect(textile.setOrderStatus(ORG, order.id, 'ready_to_dispatch', 'user:a')).resolves.toBeTruthy();
    });

    it('cancelled order releases its reservation', async () => {
      await receive(poplin.id, 50);
      const start = await balance(poplin.id);
      const { order } = await orderFor([{ productId: poplin.id, quantity: 30 }]);
      await textile.setOrderStatus(ORG, order.id, 'confirmed', 'user:a');
      expect((await balance(poplin.id)).reserved).toBe(start.reserved + 30);
      await textile.setOrderStatus(ORG, order.id, 'cancelled', 'user:a');
      expect(await balance(poplin.id)).toEqual(start);
      expect((await tasksFor(order.id)).map((t: any) => t.kind)).toEqual(['operations.reserve_order', 'operations.release_order']);
    });

    it('untracked products: reservation reports "not tracked" instead of pretending; dispatch allowed', async () => {
      const { order } = await orderFor([{ productId: untracked.id, quantity: 10 }]);
      await textile.setOrderStatus(ORG, order.id, 'confirmed', 'user:a');
      const [t] = await tasksFor(order.id);
      expect(t.result).toMatchObject({ outcome: 'not_tracked' });
    });

    it('exceptional discount: needs sales.approve_discount; the approval covers exactly those numbers', async () => {
      const lead = await leads.createLead({ organizationId: ORG, name: 'Disc Buyer', phone: uniquePhone() });
      const q = await textile.createQuotation(ORG, { leadId: lead.id, items: [{ productId: poplin.id, quantity: 100 }], discount: 3000 }, 'test'); // 3000 / 18000 = 16.7%
      await expect(textile.setQuotationStatus(ORG, q.id, 'approved', 'user:u_sales', 'sales')).rejects.toThrow(/16.7% discount is above your 10% limit/);
      expect((await prisma.quotation.findUnique({ where: { id: q.id } })).status).toBe('draft');
      // Asking again does not create a second request.
      await expect(textile.setQuotationStatus(ORG, q.id, 'approved', 'user:u_sales', 'sales')).rejects.toThrow(/approval queue/);
      const pending = await prisma.approval.findMany({ where: { organizationId: ORG, action: 'quotation.discount', entityId: q.id, status: 'pending' } });
      expect(pending).toHaveLength(1);
      await expect(approvals.decide(ORG, pending[0].id, 'approve', SALES)).rejects.toThrow(/sales.approve_discount/);
      const done = await approvals.decide(ORG, pending[0].id, 'approve', ADMIN, 'Bulk buyer');
      expect(done.status).toBe('executed');
      expect((await prisma.quotation.findUnique({ where: { id: q.id } })).status).toBe('approved');
      const audit = await prisma.auditEvent.findFirst({ where: { entityId: q.id, action: 'status:approved' } });
      expect(audit.data).toMatchObject({ approvalId: pending[0].id });
      // Within the limit: no approval needed. An admin approving over the limit is recorded as their own approval.
      const q2 = await textile.createQuotation(ORG, { leadId: lead.id, items: [{ productId: poplin.id, quantity: 100 }], discount: 1000 }, 'test');
      await expect(textile.setQuotationStatus(ORG, q2.id, 'approved', 'user:u_sales', 'sales')).resolves.toBeTruthy();
      const q3 = await textile.createQuotation(ORG, { leadId: lead.id, items: [{ productId: poplin.id, quantity: 100 }], discount: 5000 }, 'test');
      await textile.setQuotationStatus(ORG, q3.id, 'approved', 'user:u_admin', 'admin');
      expect(await prisma.approval.findFirst({ where: { entityId: q3.id } })).toMatchObject({ status: 'executed', decidedBy: 'user:u_admin' });
    });

    it('marketing attribution uses the source / campaign on each lead; no ad spend or ROI is invented', async () => {
      const { task } = await orchestrator.submit(ORG, { kind: 'marketing.source_report', input: { days: 30 }, trigger: 'user', idempotencyKey: key('mkt'), requestedBy: 'user:a' }, { runNow: true });
      const row = task.result.rows.find((r: any) => r.campaign === 'Diwali Shirting');
      expect(row.source).toBe('meta_lead_ads');
      expect(row.orders).toBeGreaterThan(0);
      expect(row.recordedOrderValue).toBeGreaterThan(0);
      expect(task.result.adSpend).toBeNull();
    });

    it('low-stock scan opens one procurement task per low product (not twice)', async () => {
      const b = await balance(poplin.id);
      await inventory.track(ORG, poplin.id, { lowStockAt: b.onHand - b.reserved + 1 });
      await prisma.workTask.updateMany({ where: { organizationId: ORG, kind: 'procurement', entityId: poplin.id }, data: { status: 'done' } });
      const a = await orchestrator.submit(ORG, { kind: 'operations.low_stock_scan', trigger: 'schedule', idempotencyKey: key('low'), requestedBy: 'system' }, { runNow: true });
      expect(a.task.result.created).toBe(1);
      const c = await orchestrator.submit(ORG, { kind: 'operations.low_stock_scan', trigger: 'schedule', idempotencyKey: key('low'), requestedBy: 'system' }, { runNow: true });
      expect(c.task.result.created).toBe(0);
    });
  });
});
