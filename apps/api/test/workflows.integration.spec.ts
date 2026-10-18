/**
 * Pilot completion: Finance collections, Operations dispatch / shortage decisions, Marketing AI drafts, STOP handling,
 * and the five cross-agent workflows (A marketing → sale → cash, B payment → fulfilment, C stock shortage,
 * D overdue invoice, E campaign reporting) against the real MySQL test database.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/workflows.integration.spec.ts
 *
 * REAL: Orchestrator + all agent task kinds, Textile / Inventory / Finance / Collections / Fulfilment / Marketing
 * services, ApprovalsService, FollowUpProcessor (the worker step), every database write.
 * FAKE: the AI copy generator, and WhatsApp (a fake fetch on the real sender, or a recording sender). DRY_RUN stays on
 * except inside one block that proves a live path with the fake provider. No real message or call.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const ORG = 'org_workflows_test';
const OTHER = 'org_workflows_other';
const ADMIN = { sub: 'wf_admin', role: 'admin' };
const FIN = { sub: 'wf_fin', role: 'finance' };
const SALES = { sub: 'wf_sales', role: 'sales' };
const MANAGER = { sub: 'wf_mgr', role: 'manager' };
let n = 0;
const phone = () => `9195${String(Date.now()).slice(-6)}${String(n++).padStart(2, '0')}`;
const key = (p: string) => `${p}-${Date.now()}-${n++}`;
const DAY = 86_400_000;

describe.skipIf(!enabled)('Pilot workflows (integration)', () => {
  let prisma: any, leads: any, textile: any, finance: any, collections: any, fulfilment: any, inventory: any, orchestrator: any, approvals: any, settings: any, marketing: any, processor: any, followUps: any, config: any;
  let silk: any, cotton: any;
  let workTaskKey: (org: string, k: string) => string;
  const recSender = { sendText: vi.fn(), sendNamedTemplate: vi.fn(), sendWithinPolicy: vi.fn(async (p: { text: string }) => ({ kind: 'text', messageId: `wamid.rec${n++}`, content: p.text })) };

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
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
    const { FinanceService } = await import('../src/finance/finance.service.js');
    const { FinanceEvents } = await import('../src/finance/finance-events.js');
    const { CollectionsService } = await import('../src/finance/collections.service.js');
    const { FulfilmentService } = await import('../src/operations/fulfilment.service.js');
    const { MarketingService } = await import('../src/marketing/marketing.service.js');
    const { WhatsAppSenderService } = await import('../src/whatsapp/whatsapp-sender.service.js');
    workTaskKey = (await import('../src/governance/work-tasks.service.js')).workTaskKey;
    const { Orchestrator } = await import('../src/agents/orchestrator.service.js');
    const { FollowUpProcessor } = await import('../src/workers/follow-up.processor.js');
    config = (await import('../src/common/config.js')).config;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, name, vertical] of [[ORG, 'Workflow Silks', 'real_estate'], [OTHER, 'Other Workflow Mills', 'real_estate']]) {
      await prisma.organization.upsert({ where: { id }, update: {}, create: { id, name, vertical } });
      const data = { industry: 'textile', textile: { notifyOrderStatus: true, maxDiscountPct: 10 }, finance: { autoDraftInvoice: true, dispatchPaymentRule: 'none', paymentTermsDays: 15 }, roi: { whatsappCostPerMessageInr: 0.8 } };
      await prisma.organizationSettings.upsert({ where: { organizationId: id }, update: { data }, create: { organizationId: id, data } });
    }
    for (const t of ['contentItem', 'marketingCampaign', 'marketingSegment', 'expense']) await prisma[t].deleteMany({ where: { organizationId: { in: [ORG, OTHER] } } });
    settings = new SettingsService(prisma);
    const conversations = new ConversationsService(prisma);
    leads = new LeadsService(prisma);
    followUps = new FollowUpsService(prisma, settings);
    approvals = new ApprovalsService(prisma);
    const workTasks = new WorkTasksService(prisma);
    const tevents = new TextileEvents();
    const fevents = new FinanceEvents();
    textile = new TextileService(prisma, followUps, leads, conversations, settings, recSender as never, approvals, tevents);
    inventory = new InventoryService(prisma);
    finance = new FinanceService(prisma, approvals, workTasks, settings, fevents);
    collections = new CollectionsService(prisma, approvals, workTasks, followUps, fevents);
    fulfilment = new FulfilmentService(prisma, approvals, textile, inventory, followUps);
    const sender = new WhatsAppSenderService();
    marketing = new MarketingService(prisma, conversations, sender, approvals, settings);
    marketing.useQueue(null);
    marketing.copyGenerator = null;
    orchestrator = new Orchestrator(prisma, inventory, workTasks, approvals, settings, tevents, finance, fevents, marketing, collections, followUps);
    orchestrator.useQueue(null);
    orchestrator.onModuleInit();
    processor = new FollowUpProcessor(prisma, conversations, leads, {} as never, recSender as never, followUps, collections);
    await prisma.textileProduct.deleteMany({ where: { organizationId: { in: [ORG, OTHER] } } });
    silk = await textile.createProduct(ORG, { sku: 'WF-SLK', name: 'Wedding Silk', fabricCategory: 'silk saree', colour: 'maroon', priceUnit: 'piece', price: 9000, priceApproved: true, stockStatus: 'in_stock' }, 'test');
    cotton = await textile.createProduct(ORG, { sku: 'WF-COT', name: 'Daily Cotton', fabricCategory: 'cotton', priceUnit: 'metre', price: 150, priceApproved: false, stockStatus: 'low' }, 'test');
    await prisma.textileProduct.update({ where: { id: silk.id }, data: { unitCost: 6000 } });
    await inventory.track(ORG, silk.id, {});
    await inventory.apply(ORG, [{ productId: silk.id, type: 'receive', quantity: 20, reference: 'GRN-WF-1', actor: 'test', idempotencyKey: key('grn') }]);
  });

  afterAll(async () => {
    process.env.DRY_RUN = 'true';
    await prisma?.$disconnect();
    const { followUpQueue, whatsappQueue, agentQueue, marketingQueue, closeRedisConnections } = await import('../src/queues/queues.js');
    await Promise.allSettled([followUpQueue.close(), whatsappQueue.close(), agentQueue.close(), marketingQueue.close()]);
    await closeRedisConnections();
  });

  /** lead → quotation → accepted → order (→ confirmed: Operations reserves, Finance drafts the invoice). */
  async function sale(opts: { productId?: string; qty?: number; confirm?: boolean; leadId?: string; customerPhone?: string; unitPrice?: number } = {}) {
    const lead = opts.leadId ? await prisma.lead.findUnique({ where: { id: opts.leadId } }) : await leads.createLead({ organizationId: ORG, name: 'Kavitha Buyer', phone: opts.customerPhone ?? phone() });
    const q = await textile.createQuotation(ORG, { leadId: lead.id, items: [{ productId: opts.productId ?? silk.id, quantity: opts.qty ?? 2, ...(opts.unitPrice ? { unitPrice: opts.unitPrice } : {}) }], taxPercent: 5 }, 'test');
    await textile.setQuotationStatus(ORG, q.id, 'approved', 'user:a', 'admin');
    await prisma.customer.update({ where: { id: lead.customerId }, data: { lastInboundAt: new Date() } });
    await textile.sendQuotation(ORG, q.id, 'user:a');
    await textile.setQuotationStatus(ORG, q.id, 'accepted', 'user:a');
    const { order } = await textile.convertToOrder(ORG, q.id, 'user:a');
    if (opts.confirm !== false) await textile.setOrderStatus(ORG, order.id, 'confirmed', 'user:a');
    return { order, quotation: q, lead };
  }
  async function issuedInvoice(orderId: string) {
    const inv = await prisma.invoice.findFirst({ where: { orderId, activeKey: { not: null } } });
    await finance.setInvoiceStatus(ORG, inv.id, 'approved', ADMIN);
    await finance.setInvoiceStatus(ORG, inv.id, 'issued', ADMIN);
    return prisma.invoice.findUnique({ where: { id: inv.id } });
  }
  const overdue = (invoiceId: string, days = 10) => prisma.invoice.update({ where: { id: invoiceId }, data: { dueDate: new Date(Date.now() - days * DAY) } }); // TEST FIXTURE
  const runFollowUp = async (where: Record<string, unknown>) => {
    const f = await prisma.followUp.findFirst({ where: { organizationId: ORG, ...where }, orderBy: { createdAt: 'desc' } });
    expect(f).toBeTruthy();
    return { f, result: await processor.process(f.id) };
  };

  // ------------------------------------------------------------------------------------------------ Finance

  describe('Finance collections (Workflow D)', () => {
    it('overdue scan prepares a reminder that waits for a person; sales cannot approve; finance approves; DRY_RUN never reports sent', async () => {
      const { order } = await sale();
      const inv = await issuedInvoice(order.id);
      await overdue(inv.id);
      const { task } = await orchestrator.submit(ORG, { kind: 'finance.overdue_scan', input: {}, trigger: 'user', idempotencyKey: key('scan'), requestedBy: 'user:wf_fin' }, { runNow: true });
      expect(task.status).toBe('COMPLETED');
      expect(task.result.remindersRequested).toBeGreaterThanOrEqual(1);
      const note = await prisma.collectionNote.findFirst({ where: { invoiceId: inv.id, type: 'reminder' } });
      expect(note).toMatchObject({ status: 'pending_approval', createdBy: 'agent:finance' });
      expect(note.note).toContain(inv.number);
      const approval = await approvals.get(ORG, note.approvalId);
      expect(approval).toMatchObject({ status: 'pending', requiredPermission: 'finance.send_reminder', requestedBy: 'agent:finance' });
      // A second scan does not stack another reminder.
      const again = await orchestrator.submit(ORG, { kind: 'finance.overdue_scan', input: {}, trigger: 'user', idempotencyKey: key('scan'), requestedBy: 'user:wf_fin' }, { runNow: true });
      expect(await prisma.collectionNote.count({ where: { invoiceId: inv.id, type: 'reminder' } })).toBe(1);
      expect(again.task.result.skipped.find((s: any) => s.number === inv.number)?.reason).toMatch(/already waiting/);

      await expect(approvals.decide(ORG, note.approvalId, 'approve', SALES)).rejects.toThrow(/finance.send_reminder/);
      expect((await approvals.decide(ORG, note.approvalId, 'approve', FIN)).status).toBe('executed');
      const queued = await prisma.collectionNote.findUnique({ where: { id: note.id } });
      expect(queued.status).toBe('queued');
      const f = await prisma.followUp.findUnique({ where: { id: queued.followUpId } });
      expect(f).toMatchObject({ source: 'invoice', message: `invoice:reminder:${inv.id}:${note.id}` });

      // The worker with the REAL sender and DRY_RUN on: refused by the provider guard -> reminder "failed", never "sent".
      const { FollowUpProcessor } = await import('../src/workers/follow-up.processor.js');
      const { WhatsAppSenderService } = await import('../src/whatsapp/whatsapp-sender.service.js');
      const { ConversationsService } = await import('../src/conversations/conversations.service.js');
      const dry = new FollowUpProcessor(prisma, new ConversationsService(prisma), leads, {} as never, new WhatsAppSenderService(), followUps, collections);
      await prisma.customer.update({ where: { id: inv.customerId }, data: { lastInboundAt: new Date() } }); // window open
      await expect(dry.process(f.id)).rejects.toThrow(/DRY_RUN/);
      expect((await prisma.collectionNote.findUnique({ where: { id: note.id } })).status).toBe('failed');
    });

    it('promise pauses reminders until its date; dispute pauses them and opens a review; reminder re-checked at send time; paid stops everything', async () => {
      const { order } = await sale();
      const inv = await issuedInvoice(order.id);
      await overdue(inv.id);
      await expect(collections.addNote(ORG, inv.id, { type: 'promise', promisedAmount: 999999, promisedDate: new Date(Date.now() + 3 * DAY).toISOString() }, SALES)).rejects.toThrow(/more than/);
      const promise = await collections.addNote(ORG, inv.id, { type: 'promise', promisedAmount: 5000, promisedDate: new Date(Date.now() + 3 * DAY).toISOString(), note: 'Will pay Friday' }, SALES);
      expect(await collections.reminderBlocker(ORG, inv.id)).toMatch(/promised/);
      await expect(collections.requestReminder(ORG, inv.id, FIN)).rejects.toThrow(/promised/);
      // The promise date passes unpaid -> broken; a reminder is possible again (finance approves by requesting).
      await prisma.collectionNote.update({ where: { id: promise.id }, data: { promisedDate: new Date(Date.now() - 2 * DAY) } }); // TEST FIXTURE
      expect(await collections.markBrokenPromises(ORG)).toBeGreaterThanOrEqual(1);
      expect((await prisma.collectionNote.findUnique({ where: { id: promise.id } })).status).toBe('broken');
      const reminder = await collections.requestReminder(ORG, inv.id, FIN);
      expect(reminder.status).toBe('queued'); // FIN holds finance.send_reminder: approved by requesting (recorded)
      // Before the worker runs, the customer disputes: the queued reminder is cancelled and a review task opens.
      await collections.addNote(ORG, inv.id, { type: 'dispute', note: 'Two pieces had colour defects' }, SALES);
      expect((await prisma.collectionNote.findUnique({ where: { id: reminder.id } })).status).toBe('cancelled');
      expect(await prisma.followUp.findUnique({ where: { id: reminder.followUpId } })).toMatchObject({ status: 'cancelled' });
      expect(await prisma.workTask.count({ where: { organizationId: ORG, entityId: inv.id, kind: 'review', title: { contains: 'Dispute' } } })).toBe(1);
      expect(await collections.reminderBlocker(ORG, inv.id)).toBe('invoice is disputed');

      // Paid in full (verified) -> collection tasks closed automatically.
      const dispute = await prisma.collectionNote.findFirst({ where: { invoiceId: inv.id, type: 'dispute' } });
      await collections.setNoteStatus(ORG, dispute.id, 'resolved', FIN, 'Replaced two pieces');
      const { payment } = await finance.recordPayment(ORG, { invoiceId: inv.id, amount: Number(inv.total), method: 'upi', reference: `UTR${Date.now()}`, source: 'staff_entry' }, 'user:clerk');
      await finance.verifyPayment(ORG, payment.id, FIN, 'HDFC statement today, credit matches amount and UTR');
      expect(await prisma.workTask.count({ where: { organizationId: ORG, agent: 'finance', kind: 'review', entityId: inv.id, status: { in: ['open', 'in_progress'] } } })).toBe(0);
      expect(await collections.reminderBlocker(ORG, inv.id)).toBe('invoice is paid');
    });

    it('a queued reminder whose invoice got paid meanwhile is skipped by the worker (re-checked), not sent', async () => {
      const { order } = await sale();
      const inv = await issuedInvoice(order.id);
      await overdue(inv.id);
      const r = await collections.requestReminder(ORG, inv.id, FIN);
      // Paid outside Finance's knowledge of the queue (simulate the race: amountPaid updated directly).
      await prisma.invoice.update({ where: { id: inv.id }, data: { amountPaid: inv.total, status: 'paid' } }); // TEST FIXTURE
      const { result } = await runFollowUp({ id: r.followUpId });
      expect(result.skipped).toMatch(/^reminder_invoice_is_paid/);
      expect((await prisma.collectionNote.findUnique({ where: { id: r.id } })).status).toBe('skipped');
      expect(recSender.sendWithinPolicy).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(inv.number) }));
    });

    it('bank statement matching is read-only: matched, mismatched, unmatched and missing are reported; exceptions opened', async () => {
      const a = await sale(); const b = await sale(); const c = await sale();
      const [ia, ib, ic] = [await issuedInvoice(a.order.id), await issuedInvoice(b.order.id), await issuedInvoice(c.order.id)];
      const utr = (s: string) => `UTR${run}${s}`;
      const run = String(Date.now()).slice(-6);
      const pa = (await finance.recordPayment(ORG, { invoiceId: ia.id, amount: 1000, method: 'upi', reference: utr('A1'), paidAt: new Date().toISOString() }, 'user:clerk')).payment;
      const pb = (await finance.recordPayment(ORG, { invoiceId: ib.id, amount: 2000, method: 'upi', reference: utr('B2'), paidAt: new Date().toISOString() }, 'user:clerk')).payment;
      const pc = (await finance.recordPayment(ORG, { invoiceId: ic.id, amount: 3000, method: 'upi', reference: utr('C3'), paidAt: new Date().toISOString() }, 'user:clerk')).payment;
      await finance.verifyPayment(ORG, pc.id, FIN, 'Customer statement checked against UTR in bank app');
      const today = new Date().toISOString().slice(0, 10);
      const csv = ['Txn Date,Narration,Credit', `${today},UPI/${utr('A1')}/KAVITHA,1000`, `${today},NEFT ${utr('B2')} BALA,1500`, `${today},UPI/999988887777/UNKNOWN,750`].join('\n');
      const r = await collections.matchStatement(ORG, { originalname: 'stmt.csv', buffer: Buffer.from(csv) }, FIN);
      expect(r.matched.map((m: any) => m.paymentId)).toContain(pa.id);
      expect(r.mismatched).toEqual([expect.objectContaining({ paymentId: pb.id, amount: 1500, recordedAmount: 2000 })]);
      expect(r.unmatchedStatementLines).toEqual([expect.objectContaining({ amount: 750 })]);
      expect(r.recordedNotInStatement.map((m: any) => m.paymentId)).toContain(pc.id);
      // Nothing verified by matching.
      expect((await prisma.payment.findUnique({ where: { id: pa.id } })).status).toBe('pending_verification');
      expect(await prisma.workTask.count({ where: { organizationId: ORG, kind: 'reconciliation', entityId: pb.id } })).toBe(1);
      expect(await prisma.workTask.count({ where: { organizationId: ORG, kind: 'reconciliation', entityId: pc.id, title: { contains: 'not found in the bank statement' } } })).toBe(1);
    });

    it('expenses (duplicate reference guarded, voided not deleted) and profitability with cost coverage; no invented profit', async () => {
      const ref = `BILL-${Date.now()}`;
      await collections.recordExpense(ORG, { spentOn: new Date().toISOString(), category: 'freight', amount: 1200, vendor: 'ABC Transport', reference: ref }, FIN);
      await expect(collections.recordExpense(ORG, { spentOn: new Date().toISOString(), category: 'freight', amount: 1200, reference: ref }, FIN)).rejects.toThrow(/already recorded/);
      const e2 = await collections.recordExpense(ORG, { spentOn: new Date().toISOString(), category: 'rent', amount: 500 }, FIN);
      await collections.voidExpense(ORG, e2.id, 'entered twice', FIN);
      expect((await prisma.expense.findUnique({ where: { id: e2.id } })).status).toBe('void');
      // One costed sale (silk) and one uncosted (cotton) in the period.
      await prisma.inventoryBalance.deleteMany({ where: { productId: cotton.id } });
      const s2 = await sale({ productId: cotton.id, qty: 10, unitPrice: 160 });
      await issuedInvoice(s2.order.id);
      const p = await collections.profitability(ORG, 30);
      expect(p.expenses.byCategory.freight).toBeGreaterThanOrEqual(1200);
      expect(p.expenses.byCategory.rent ?? 0).toBe(0); // voided
      expect(p.grossMargin.coveragePct).toBeGreaterThan(0);
      expect(p.grossMargin.coveragePct).toBeLessThan(100);
      expect(p.operatingEstimate).toBeNull(); // not every line is costed: no profit figure
      expect(p.grossMargin.amount).toBeCloseTo(p.grossMargin.costedRevenue - p.grossMargin.cost, 2);
      expect(p.revenueInvoiced).not.toBe(p.cashCollectedVerified);
      const other = await collections.profitability(OTHER, 30);
      expect(other.expenses.total).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ Operations

  describe('Operations dispatch and stock shortage (Workflow C)', () => {
    it('dispatch records courier + tracking and moves the order; the customer update carries the tracking number', async () => {
      const { order } = await sale({ qty: 1 });
      await expect(fulfilment.dispatch(ORG, order.id, { courier: '' }, ADMIN)).rejects.toThrow(/courier/);
      await textile.setOrderStatus(ORG, order.id, 'processing', 'user:a');
      await textile.setOrderStatus(ORG, order.id, 'ready_to_dispatch', 'user:a');
      const o = await fulfilment.dispatch(ORG, order.id, { courier: 'ST Courier', trackingRef: 'ST123456' }, ADMIN);
      expect(o).toMatchObject({ status: 'dispatched', courier: 'ST Courier', trackingRef: 'ST123456' });
      const moves = await prisma.stockMovement.findMany({ where: { orderId: order.id, type: 'dispatch' } });
      expect(moves.length).toBe(1);
      recSender.sendWithinPolicy.mockClear();
      const { result } = await runFollowUp({ source: 'order', message: `order:status:${order.id}:dispatched` });
      expect(result.sent).toBeTruthy();
      expect(recSender.sendWithinPolicy.mock.calls[0][0].text).toContain('tracking ST123456');
    });

    it('a failed dispatch (stock not reserved) leaves no dispatch details behind', async () => {
      await prisma.inventoryBalance.updateMany({ where: { productId: silk.id }, data: { onHand: 0, reserved: 0 } }); // TEST FIXTURE: empty shelf
      try {
      const { order } = await sale({ qty: 3 }); // confirmed but short: nothing reserved
      await textile.setOrderStatus(ORG, order.id, 'processing', 'user:a');
      await expect(fulfilment.dispatch(ORG, order.id, { courier: 'ST Courier', trackingRef: 'X1' }, ADMIN)).rejects.toThrow();
      expect(await prisma.salesOrder.findUnique({ where: { id: order.id } })).toMatchObject({ courier: null, trackingRef: null, dispatchedAt: null });
      // Shortage -> Operations exception + Sales review (existing agents) -> owner decision with the exact message.
      expect(await prisma.workTask.count({ where: { organizationId: ORG, entityId: order.id, dedupeKey: workTaskKey(ORG, `shortage_review:${order.id}`) } })).toBe(1);
      const newDate = new Date(Date.now() + 10 * DAY).toISOString();
      const asSales = await fulfilment.requestDecision(ORG, order.id, { decision: 'revised_date', newDate, customerMessage: 'The silk arrives next week; new delivery date is in 10 days.' }, SALES);
      expect(asSales.applied).toBe(false); // sales cannot decide: waits for sales.decide_shortage
      await expect(approvals.decide(ORG, asSales.approval.id, 'approve', SALES)).rejects.toThrow(/sales.decide_shortage/);
      expect((await approvals.decide(ORG, asSales.approval.id, 'approve', MANAGER)).status).toBe('executed');
      const after = await prisma.salesOrder.findUnique({ where: { id: order.id } });
      expect(after.expectedDelivery.toISOString()).toBe(newDate);
      expect((await prisma.workTask.findFirst({ where: { dedupeKey: workTaskKey(ORG, `shortage_review:${order.id}`) } })).status).toBe('done');
      recSender.sendWithinPolicy.mockClear();
      const { result } = await runFollowUp({ source: 'order', message: `order:status:${order.id}:revised` });
      expect(result.sent).toBeTruthy();
      expect(recSender.sendWithinPolicy.mock.calls[0][0].text).toContain('The silk arrives next week');
      } finally {
        await inventory.apply(ORG, [{ productId: silk.id, type: 'receive', quantity: 30, reference: 'GRN-WF-2', actor: 'test', idempotencyKey: key('grn') }]);
      }
    });

    it('a cancellation decision cancels the order (stock released) and still sends the approved message', async () => {
      const { order } = await sale({ qty: 1 });
      const r = await fulfilment.requestDecision(ORG, order.id, { decision: 'cancel', customerMessage: 'We are sorry, this design is discontinued; your order is cancelled.' }, MANAGER);
      expect(r.applied).toBe(true);
      expect((await prisma.salesOrder.findUnique({ where: { id: order.id } })).status).toBe('cancelled');
      const { result } = await runFollowUp({ source: 'order', message: `order:status:${order.id}:revised` });
      expect(result.sent).toBeTruthy();
      await expect(fulfilment.requestDecision(ORG, order.id, { decision: 'cancel', customerMessage: 'again again again' }, MANAGER)).rejects.toThrow(/cancelled order/);
    });
  });

  // ------------------------------------------------------------------------------------------------ Workflow B

  it('Workflow B: verified payment → authoritative status → dispatch rule → Operations check → customer receipt (only after verification)', async () => {
    const { order } = await sale({ qty: 1 });
    const inv = await issuedInvoice(order.id);
    const { payment } = await finance.recordPayment(ORG, { invoiceId: inv.id, amount: 5000, method: 'upi', reference: `UTR${Date.now()}9`, source: 'customer_claim' }, 'user:clerk');
    // A claim alone: no receipt, no status change.
    expect(await prisma.followUp.count({ where: { message: `payment:received:${payment.id}` } })).toBe(0);
    expect((await prisma.salesOrder.findUnique({ where: { id: order.id } })).paymentStatus).toBe('unpaid');
    await finance.verifyPayment(ORG, payment.id, FIN, 'Bank statement 17 Oct credit 5000 UTR matches');
    const task = await prisma.agentTask.findFirst({ where: { organizationId: ORG, kind: 'finance.payment_verified', entityId: payment.id } });
    expect(task.status).toBe('COMPLETED');
    expect(task.result.customerUpdate).toMatch(/^queued/);
    const child = await prisma.agentTask.findFirst({ where: { parentTaskId: task.id } });
    expect(child).toMatchObject({ kind: 'operations.fulfilment_check', status: 'COMPLETED' });
    expect((await prisma.salesOrder.findUnique({ where: { id: order.id } })).paymentStatus).toBe('partial');
    recSender.sendWithinPolicy.mockClear();
    const { result } = await runFollowUp({ source: 'payment', message: `payment:received:${payment.id}` });
    expect(result.sent).toBeTruthy();
    expect(recSender.sendWithinPolicy.mock.calls[0][0].text).toMatch(/received your payment of ₹5000.*Balance/);
    // Re-running the event does not queue a second receipt.
    await orchestrator.submit(ORG, { kind: 'finance.payment_verified', input: { paymentId: payment.id }, trigger: 'user', idempotencyKey: key('pv'), requestedBy: 'user:x' }, { runNow: true });
    expect(await prisma.followUp.count({ where: { message: `payment:received:${payment.id}` } })).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------ Workflows A + E

  it('Workflows A + E: campaign → approval → delivered → reply → enquiry → stock check → quotation → order → invoice → verified cash, all in the campaign report', async () => {
    const buyerPhone = phone();
    const cu = await prisma.customer.create({ data: { organizationId: ORG, phone: buyerPhone, name: 'Revathi', tags: ['wf_wedding'], messagingConsent: true } });
    const seg = await marketing.saveSegment(ORG, { name: `WF wedding ${Date.now()}`, rules: { tags: ['wf_wedding'] } }, 'user:m');
    const c = await marketing.createCampaign(ORG, { name: `WF Wedding ${Date.now()}`, segmentId: seg.id, templateName: 'wedding_offer', templateLanguage: 'en', templateParams: ['{{name}}'] }, 'user:m');
    // Live path with a fake provider for this one block only.
    const sent: any[] = [];
    const saved = { token: config.whatsapp.accessToken, pid: config.whatsapp.phoneNumberId, live: process.env.LIVE_TEST_RECIPIENTS };
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_RECIPIENTS = buyerPhone;
    Object.assign(config.whatsapp, { accessToken: 'test-token', phoneNumberId: 'test-phone-id' });
    (marketing as any).sender.fetchImpl = async (_u: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.WF${sent.length}` }] }), { status: 200 });
    };
    try {
      const est = await marketing.estimate(ORG, c.id);
      await marketing.requestSend(ORG, c.id, ADMIN, { confirm: true, expectedRecipients: est.eligible });
      const r = await prisma.campaignRecipient.findFirst({ where: { campaignId: c.id, customerId: cu.id } });
      expect(await marketing.processRecipient({ campaignId: c.id, recipientId: r.id })).toBe('sent');
    } finally {
      process.env.DRY_RUN = 'true';
      if (saved.live === undefined) delete process.env.LIVE_TEST_RECIPIENTS; else process.env.LIVE_TEST_RECIPIENTS = saved.live;
      Object.assign(config.whatsapp, { accessToken: saved.token, phoneNumberId: saved.pid });
    }
    expect(sent).toHaveLength(1);
    await marketing.applyDeliveryStatus(ORG, 'wamid.WF1', 'delivered');
    expect(await marketing.recordReply(ORG, buyerPhone)).toBe(c.id);
    // Sales qualification creates the enquiry (lead) after the reply; attribution links it.
    const lead = await leads.createLead({ organizationId: ORG, name: 'Revathi', phone: buyerPhone });
    const stock = await orchestrator.submit(ORG, { kind: 'sales.availability_check', input: { productId: silk.id, quantity: 2 }, trigger: 'user', idempotencyKey: key('av'), requestedBy: 'agent:sales' }, { runNow: true });
    expect(stock.task.result).toMatchObject({ tracked: true, canPromise: true });
    const { order } = await sale({ leadId: lead.id, qty: 2 });
    const inv = await issuedInvoice(order.id);
    const { payment } = await finance.recordPayment(ORG, { invoiceId: inv.id, amount: 10000, method: 'bank_transfer', reference: `NEFT${Date.now()}` }, 'user:clerk');
    let report = await marketing.report(ORG, c.id);
    expect(report).toMatchObject({ sent: 1, delivered: 1, replied: 1, leads: 1, quotations: 1, orders: 1, verifiedCollections: 0 }); // recorded, not yet verified
    await finance.verifyPayment(ORG, payment.id, FIN, 'Bank statement NEFT credit 10000 verified');
    report = await marketing.report(ORG, c.id);
    expect(report.verifiedCollections).toBe(10000);
    expect((await prisma.lead.findUnique({ where: { id: lead.id } })).campaign).toBe(c.name);
    const overview = await textile.overview(ORG, 30);
    expect(overview.marketing).toMatchObject({ attributedEnquiries: expect.any(Number), attributedOrders: expect.any(Number) });
    expect(overview.marketing.attributedVerifiedCollections).toBeGreaterThanOrEqual(10000);
  });

  // ------------------------------------------------------------------------------------------------ STOP

  it('STOP from a textile customer opts them out (campaigns skip them, reminders and updates stop); START re-opts in; GR Chicken untouched', async () => {
    const p = phone();
    const cu = await prisma.customer.create({ data: { organizationId: ORG, phone: p, name: 'Stopper', messagingConsent: true } });
    expect(await marketing.handleOptKeyword(ORG, p, 'hello')).toBeNull();
    expect(await marketing.handleOptKeyword(ORG, p, 'STOP')).toBe('stop');
    expect(await prisma.customer.findUnique({ where: { id: cu.id } })).toMatchObject({ messagingConsent: false, optedOutAt: expect.any(Date) });
    // A textile follow-up for an opted-out customer is cancelled by the worker.
    const lead = await leads.createLead({ organizationId: ORG, name: 'Stopper', phone: p });
    const f = await followUps.create({ organizationId: ORG, leadId: lead.id, customerId: cu.id, channel: 'whatsapp', action: 'message', source: 'quote', message: 'quote:reminder:x', scheduledAt: new Date() });
    expect(await processor.process(f.id)).toEqual({ skipped: 'opted_out' });
    expect(await marketing.handleOptKeyword(ORG, p, 'START')).toBe('start');
    expect((await prisma.customer.findUnique({ where: { id: cu.id } })).optedOutAt).toBeNull();
    // Restaurant tenants keep their own STOP handling (not changed here).
    await prisma.organization.upsert({ where: { id: 'org_wf_restaurant' }, update: { vertical: 'restaurant' }, create: { id: 'org_wf_restaurant', name: 'WF Chicken', vertical: 'restaurant' } });
    await prisma.customer.upsert({ where: { organizationId_phone: { organizationId: 'org_wf_restaurant', phone: p } }, update: {}, create: { organizationId: 'org_wf_restaurant', phone: p } });
    expect(await marketing.handleOptKeyword('org_wf_restaurant', p, 'STOP')).toBeNull();
  });

  // ------------------------------------------------------------------------------------------------ Marketing AI

  describe('Marketing AI drafts', () => {
    it('uses only approved facts: invented price, discount, stock or delivery sentences are removed; revisions recorded; tenant-scoped', async () => {
      marketing.copyGenerator = async () => ({ text: 'Wedding Silk in maroon, ₹9000 per piece. Get 20% off today only! Only 3 left in stock. Free delivery in 2 days. Reply to see photos.', model: 'fake-model', inputTokens: 120, outputTokens: 40 });
      const r = await marketing.aiDraft(ORG, { kind: 'caption', language: 'english', productIds: [silk.id] }, 'user:m');
      expect(r.source).toBe('ai');
      expect(r.item.body).toContain('₹9000');
      expect(r.item.body).not.toMatch(/20%|Free delivery|3 left/);
      expect(r.removed.length).toBe(3);
      const revs = await marketing.revisions(ORG, r.item.id);
      expect(revs[0]).toMatchObject({ source: 'ai', model: 'fake-model', inputTokens: 120, outputTokens: 40 });
      // The unapproved cotton price never reaches the model's fact sheet, and a stated price for it is removed.
      let sheetSeen = '';
      marketing.copyGenerator = async (_req: unknown, sheet: string) => { sheetSeen = sheet; return { text: 'Daily Cotton at ₹150 per metre. Soft for everyday wear.', model: 'fake-model' }; };
      const c2 = await marketing.aiDraft(ORG, { kind: 'promo', language: 'tanglish', productIds: [cotton.id], contentId: r.item.id }, 'user:m');
      expect(sheetSeen).toContain('price: do not mention');
      expect(sheetSeen).not.toContain('150');
      expect(c2.item.body).not.toContain('150');
      expect((await marketing.revisions(ORG, r.item.id)).length).toBe(2);
      // Restore the first revision -> a third, manual revision; approval still required before publishing.
      await marketing.restoreRevision(ORG, r.item.id, revs[0].id, 'user:m');
      expect((await marketing.revisions(ORG, r.item.id))[0].source).toBe('manual');
      await expect(marketing.markPublished(ORG, r.item.id, 'user:m')).rejects.toThrow(/Only approved/);
      await expect(marketing.revisions(OTHER, r.item.id)).rejects.toThrow(/not found/);
      // A model that only invents is rejected entirely -> template draft, labelled.
      marketing.copyGenerator = async () => ({ text: 'Flat 50% sale! Free gift!', model: 'fake-model' });
      const bad = await marketing.aiDraft(ORG, { kind: 'caption', productIds: [silk.id] }, 'user:m');
      expect(bad.source).toBe('template');
      expect(bad.note).toMatch(/rejected/);
      // No model configured -> template, labelled.
      marketing.copyGenerator = null;
      const tpl = await marketing.aiDraft(ORG, { kind: 'caption', language: 'tamil', productIds: [silk.id] }, 'user:m');
      expect(tpl.source).toBe('template');
      const usage = await marketing.aiUsage(ORG, 30);
      expect(usage.marketingDrafts).toBeGreaterThanOrEqual(2);
      expect(usage.costInr).toBeNull();
    });

    it('Meta permission check: ads_read reported from Meta, never assumed', async () => {
      const { metaPermissions, adSpendStatus, clearMetaPermissionCache } = await import('../src/marketing/meta-permissions.js');
      const saved = config.meta.pageAccessToken;
      config.meta.pageAccessToken = 'test-page-token';
      try {
        clearMetaPermissionCache();
        const without = await metaPermissions((async () => new Response(JSON.stringify({ data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'ads_read', status: 'declined' }] }), { status: 200 })) as never);
        expect(without).toMatchObject({ checked: true, adsRead: false });
        expect(adSpendStatus(without).status).toBe('blocked');
        clearMetaPermissionCache();
        const withAds = await metaPermissions((async () => new Response(JSON.stringify({ data: [{ permission: 'ads_read', status: 'granted' }] }), { status: 200 })) as never);
        expect(adSpendStatus(withAds).status).toBe('not_built'); // still no numbers shown
        clearMetaPermissionCache();
        const down = await metaPermissions((async () => { throw new Error('ECONNREFUSED'); }) as never);
        expect(adSpendStatus(down).status).toBe('unknown');
      } finally {
        config.meta.pageAccessToken = saved;
        clearMetaPermissionCache();
      }
    });
  });

  it('tenant isolation: another business cannot read or act on these finance / operations records', async () => {
    const { order } = await sale({ qty: 1 });
    const inv = await prisma.invoice.findFirst({ where: { orderId: order.id } });
    await expect(collections.notes(OTHER, inv.id)).rejects.toThrow(/not found/);
    await expect(collections.requestReminder(OTHER, inv.id, FIN)).rejects.toThrow(/not found/);
    await expect(fulfilment.dispatch(OTHER, order.id, { courier: 'x' }, ADMIN)).rejects.toThrow(/not found/);
    await expect(fulfilment.requestDecision(OTHER, order.id, { decision: 'cancel', customerMessage: 'cancel this order now' }, ADMIN)).rejects.toThrow(/not found/);
  });
});
