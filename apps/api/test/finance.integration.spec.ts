/**
 * Finance agent: invoices, payment verification, reconciliation, receivables and the payment -> fulfilment workflow,
 * against the real MySQL test database. Synthetic customers / orders; the WhatsApp sender is a stub.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/finance.integration.spec.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const ORG = 'org_finance_test';
const OTHER = 'org_finance_other';
const ADMIN = { sub: 'fin_admin', role: 'admin' };
const FIN = { sub: 'fin_clerk', role: 'finance' };
const SALES = { sub: 'fin_sales', role: 'sales' };
const MANAGER = { sub: 'fin_mgr', role: 'manager' };
let n = 0;
const phone = () => `91${String(Date.now()).slice(-7)}${String(n++).padStart(3, '0')}`;

describe.skipIf(!enabled)('Finance (integration)', () => {
  let prisma: any, leads: any, textile: any, finance: any, orchestrator: any, approvals: any, settings: any, inventory: any;
  const sender = { sendText: vi.fn(), sendWithinPolicy: vi.fn(), sendNamedTemplate: vi.fn() };
  let cloth: any;

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
    const { FinanceService } = await import('../src/finance/finance.service.js');
    const { FinanceEvents } = await import('../src/finance/finance-events.js');
    const { Orchestrator } = await import('../src/agents/orchestrator.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, name] of [[ORG, 'Finance Textiles'], [OTHER, 'Other Finance Mills']]) {
      await prisma.organization.upsert({ where: { id }, update: {}, create: { id, name } });
      await prisma.organizationSettings.upsert({ where: { organizationId: id }, update: { data: { industry: 'textile' } }, create: { organizationId: id, data: { industry: 'textile' } } });
    }
    settings = new SettingsService(prisma);
    const conversations = new ConversationsService(prisma);
    leads = new LeadsService(prisma);
    const followUps = new FollowUpsService(prisma, settings);
    approvals = new ApprovalsService(prisma);
    const workTasks = new WorkTasksService(prisma);
    const tevents = new TextileEvents();
    const fevents = new FinanceEvents();
    textile = new TextileService(prisma, followUps, leads, conversations, settings, sender as never, approvals, tevents);
    inventory = new InventoryService(prisma);
    finance = new FinanceService(prisma, approvals, workTasks, settings, fevents);
    orchestrator = new Orchestrator(prisma, inventory, workTasks, approvals, settings, tevents, finance, fevents);
    orchestrator.useQueue(null);
    orchestrator.onModuleInit();
    await prisma.textileProduct.deleteMany({ where: { organizationId: { in: [ORG, OTHER] } } });
    cloth = await textile.createProduct(ORG, { sku: 'FN-CL', name: 'Finance Cloth', fabricCategory: 'cotton', priceUnit: 'metre', price: 100, priceApproved: true }, 'test');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    const { followUpQueue, whatsappQueue, agentQueue, closeRedisConnections } = await import('../src/queues/queues.js');
    await Promise.allSettled([followUpQueue.close(), whatsappQueue.close(), agentQueue.close()]);
    await closeRedisConnections();
  });

  beforeEach(async () => {
    sender.sendText.mockReset().mockResolvedValue('wamid.fin');
    await settings.update(ORG, { finance: { dispatchPaymentRule: 'none', autoDraftInvoice: true, paymentTermsDays: 15 } });
  });

  /** quotation (terms) -> approved -> sent -> accepted -> order; optionally confirmed (which drafts the invoice). */
  async function order(opts: { qty?: number; discount?: number; taxPercent?: number; shipping?: number; confirm?: boolean; org?: string } = {}) {
    const org = opts.org ?? ORG;
    const lead = await leads.createLead({ organizationId: org, name: 'Fin Buyer', phone: phone() });
    const items = org === ORG ? [{ productId: cloth.id, quantity: opts.qty ?? 100 }] : [{ description: 'Cloth', quantity: opts.qty ?? 100, unitPrice: 100 }];
    const q = await textile.createQuotation(org, { leadId: lead.id, items, discount: opts.discount ?? 0, taxPercent: opts.taxPercent ?? 5, shipping: opts.shipping ?? 0 }, 'test');
    await textile.setQuotationStatus(org, q.id, 'approved', 'user:a', 'admin');
    await prisma.customer.update({ where: { id: lead.customerId }, data: { lastInboundAt: new Date() } });
    await textile.sendQuotation(org, q.id, 'user:a');
    await textile.setQuotationStatus(org, q.id, 'accepted', 'user:a');
    const { order } = await textile.convertToOrder(org, q.id, 'user:a');
    if (opts.confirm !== false) await textile.setOrderStatus(org, order.id, 'confirmed', 'user:a');
    return { order, quotation: q, lead };
  }
  const invoiceOf = (orderId: string) => prisma.invoice.findFirst({ where: { orderId, activeKey: { not: null } } });
  async function issued(opts: Parameters<typeof order>[0] = {}) {
    const o = await order(opts);
    const inv = await invoiceOf(o.order.id);
    await finance.setInvoiceStatus(ORG, inv.id, 'approved', ADMIN);
    await finance.setInvoiceStatus(ORG, inv.id, 'issued', ADMIN);
    return { ...o, invoice: await prisma.invoice.findUnique({ where: { id: inv.id } }) };
  }
  const pay = (invoiceId: string, amount: number, reference = `UTR${Date.now()}${n++}`, method = 'upi', source = 'staff_entry') => finance.recordPayment(ORG, { invoiceId, amount, method, reference, source }, 'user:fin_clerk');

  describe('invoices', () => {
    it('order confirmed -> Finance agent drafts the invoice from the quotation terms; totals computed on the server', async () => {
      const { order: o } = await order({ qty: 250, discount: 500, taxPercent: 5, shipping: 300 });
      const tasks = await prisma.agentTask.findMany({ where: { organizationId: ORG, entityId: o.id, agent: 'finance' } });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ kind: 'finance.invoice_draft', status: 'COMPLETED', result: { outcome: 'drafted' } });
      const inv = await invoiceOf(o.id);
      expect(inv.number).toMatch(/^INV-\d{4}-\d{4}$/);
      expect(inv).toMatchObject({ status: 'draft', taxSource: 'quotation' });
      // 250 x 100 = 25000; -500 = 24500; 5% = 1225; +300 shipping
      expect([Number(inv.subtotal), Number(inv.discount), Number(inv.tax), Number(inv.shipping), Number(inv.total)]).toEqual([25000, 500, 1225, 300, 26025]);
      expect(Number(inv.total)).toBe(Number(o.total)); // same as the order; order untouched
      const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
      expect(items.map((i: any) => [i.sku, Number(i.quantity), Number(i.lineTotal)])).toEqual([['FN-CL', 250, 25000]]);
      // A draft nobody has reviewed yet does not take over payment status; an approved invoice does.
      await expect(textile.setPaymentStatus(ORG, o.id, 'partial', 'user:a')).resolves.toBeTruthy();
      await finance.setInvoiceStatus(ORG, inv.id, 'approved', ADMIN);
      await expect(textile.setPaymentStatus(ORG, o.id, 'paid', 'user:a')).rejects.toThrow(/follows verified payments/);
    });

    it('one live invoice per order, even in parallel; none for an unconfirmed order; a manual order needs the tax % entered', async () => {
      const { order: o } = await order();
      const [a, b] = await Promise.all([finance.createInvoice(ORG, o.id, 'user:x'), finance.createInvoice(ORG, o.id, 'user:y')]);
      expect(a.invoice.id).toBe(b.invoice.id);
      expect(await prisma.invoice.count({ where: { orderId: o.id } })).toBe(1);
      const pending = await order({ confirm: false });
      await expect(finance.createInvoice(ORG, pending.order.id, 'user:x')).rejects.toThrow(/only for a confirmed order/);
      // An order without quotation terms (e.g. entered by hand): no tax rate is assumed.
      const manual = await prisma.salesOrder.create({ data: { organizationId: ORG, customerId: pending.lead.customerId, number: `SO-M-${Date.now()}`, status: 'confirmed', total: 1000, items: { create: [{ description: 'Cloth', quantity: 10, unit: 'metre', unitPrice: 100, lineTotal: 1000 }] } } });
      await expect(finance.createInvoice(ORG, manual.id, 'user:x')).rejects.toThrow(/enter the tax %/);
      const m = await finance.createInvoice(ORG, manual.id, 'user:x', { taxPercent: 12 });
      expect([Number(m.invoice.tax), Number(m.invoice.total), m.invoice.taxSource]).toEqual([120, 1120, 'entered']);
    });

    it('lifecycle: approve and issue need finance.approve_invoice; issue sets the due date from payment terms; paid is never set by hand', async () => {
      const { order: o } = await order();
      const inv = await invoiceOf(o.id);
      await expect(finance.setInvoiceStatus(ORG, inv.id, 'issued', ADMIN)).rejects.toThrow(/cannot move from draft to issued/);
      await expect(finance.setInvoiceStatus(ORG, inv.id, 'approved', SALES)).rejects.toThrow(/finance.approve_invoice/);
      await finance.setInvoiceStatus(ORG, inv.id, 'approved', FIN);
      const iss = await finance.setInvoiceStatus(ORG, inv.id, 'issued', FIN);
      expect(iss.status).toBe('issued');
      const days = Math.round((new Date(iss.dueDate).getTime() - new Date(new Date(iss.invoiceDate).toDateString()).getTime()) / 86_400_000);
      expect(days).toBe(15);
      await expect(finance.setInvoiceStatus(ORG, inv.id, 'paid', ADMIN)).rejects.toThrow(/follow verified payments/);
      expect(iss.audit.map((a: any) => a.action)).toEqual(['created', 'status:approved', 'status:issued']);
    });

    it('cancel needs a reason, frees the order for a new invoice; not allowed once a payment is verified', async () => {
      const { order: o } = await order();
      const inv = await invoiceOf(o.id);
      await expect(finance.setInvoiceStatus(ORG, inv.id, 'cancelled', ADMIN)).rejects.toThrow(/reason/);
      await finance.setInvoiceStatus(ORG, inv.id, 'cancelled', ADMIN, { reason: 'Wrong GST' });
      const again = await finance.createInvoice(ORG, o.id, 'user:x');
      expect(again.duplicate).toBe(false);
      expect(again.invoice.id).not.toBe(inv.id);
      const { invoice } = await issued();
      const { payment } = await pay(invoice.id, 100);
      await finance.verifyPayment(ORG, payment.id, FIN, 'Bank statement line checked, credit 100');
      await expect(finance.setInvoiceStatus(ORG, invoice.id, 'cancelled', ADMIN, { reason: 'x' })).rejects.toThrow(/verified payments/);
    });
  });

  describe('payments', () => {
    it('a recorded payment (even a customer claim) is only pending; verification needs permission + evidence; partial then paid', async () => {
      const { invoice, order: o } = await issued({ qty: 100, taxPercent: 0 }); // total 10000
      const { payment, flags } = await pay(invoice.id, 4000, `UTR-AAA-${Date.now()}`, 'upi', 'customer_claim');
      expect(payment.status).toBe('pending_verification');
      expect(flags).toEqual([]);
      expect((await prisma.salesOrder.findUnique({ where: { id: o.id } })).paymentStatus).toBe('unpaid'); // a claim changes nothing
      await expect(finance.verifyPayment(ORG, payment.id, SALES, 'Statement checked carefully')).rejects.toThrow(/finance.verify_payment/);
      await expect(finance.verifyPayment(ORG, payment.id, FIN, 'screenshot')).rejects.toThrow(/not proof/);
      const v = await finance.verifyPayment(ORG, payment.id, FIN, 'HDFC statement 14 Oct: credit 4,000 UTR AAA111');
      expect(v).toMatchObject({ amountPaid: 4000, invoiceStatus: 'partially_paid', orderPaymentStatus: 'partial' });
      expect(v.payment).toMatchObject({ status: 'verified', verificationSource: 'manual', verifiedBy: 'user:fin_clerk' });
      await expect(finance.verifyPayment(ORG, payment.id, FIN, 'again and again')).rejects.toThrow(/already verified/);
      const { payment: p2 } = await pay(invoice.id, 6000);
      const v2 = await finance.verifyPayment(ORG, p2.id, FIN, 'HDFC statement 15 Oct: credit 6,000');
      expect(v2).toMatchObject({ amountPaid: 10000, invoiceStatus: 'paid', orderPaymentStatus: 'paid' });
      // The manual payment-status buttons no longer override verified payments.
      await expect(textile.setPaymentStatus(ORG, o.id, 'unpaid', 'user:a')).rejects.toThrow(/follows verified payments/);
      const audit = await prisma.auditEvent.findMany({ where: { organizationId: ORG, entityId: o.id, action: 'payment_status' } });
      expect(audit.map((a: any) => a.data.to)).toEqual(['partial', 'paid']);
    });

    it('the same transaction twice: flagged on entry, refused at verification, exception raised; stays pending', async () => {
      const { invoice } = await issued({ qty: 100, taxPercent: 0 });
      const ref = `UTR${Date.now()}`;
      const a = await pay(invoice.id, 1000, ref);
      await finance.verifyPayment(ORG, a.payment.id, FIN, 'Statement line 7 checked');
      const b = await pay(invoice.id, 1000, ` ${ref.slice(0, 5)}-${ref.slice(5)} `); // same reference, different formatting
      expect(b.flags).toContain('duplicate_reference');
      await expect(finance.verifyPayment(ORG, b.payment.id, FIN, 'Statement line 7 checked')).rejects.toThrow(/already a verified payment/);
      expect((await prisma.payment.findUnique({ where: { id: b.payment.id } })).status).toBe('pending_verification');
      const ex = await prisma.workTask.findMany({ where: { organizationId: ORG, agent: 'finance', kind: 'reconciliation', entityId: invoice.id } });
      expect(ex.length).toBeGreaterThanOrEqual(2);
      expect(Number((await prisma.invoice.findUnique({ where: { id: invoice.id } })).amountPaid)).toBe(1000);
    });

    it('overpayment is flagged and never verified; two parallel verifications cannot exceed the invoice', async () => {
      const { invoice } = await issued({ qty: 10, taxPercent: 0 }); // total 1000
      const over = await pay(invoice.id, 1500);
      expect(over.flags).toContain('exceeds_outstanding');
      await expect(finance.verifyPayment(ORG, over.payment.id, FIN, 'Statement says 1500')).rejects.toThrow(/more than the/);
      await finance.rejectPayment(ORG, over.payment.id, FIN, 'Belongs to another invoice');
      const a = await pay(invoice.id, 600), b = await pay(invoice.id, 600);
      const results = await Promise.allSettled([finance.verifyPayment(ORG, a.payment.id, FIN, 'Statement line A ok'), finance.verifyPayment(ORG, b.payment.id, FIN, 'Statement line B ok')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(Number((await prisma.invoice.findUnique({ where: { id: invoice.id } })).amountPaid)).toBe(600);
    });

    it('reject needs a reason; a rejected payment cannot be verified; record validations', async () => {
      const { invoice } = await issued();
      const { payment } = await pay(invoice.id, 100);
      await expect(finance.rejectPayment(ORG, payment.id, FIN, '')).rejects.toThrow(/reason/);
      await finance.rejectPayment(ORG, payment.id, FIN, 'Not on the bank statement');
      await expect(finance.verifyPayment(ORG, payment.id, FIN, 'Statement checked again')).rejects.toThrow(/already rejected/);
      await expect(finance.recordPayment(ORG, { invoiceId: invoice.id, amount: -5, method: 'upi', reference: 'x1234' }, 'u')).rejects.toThrow(/amount/);
      await expect(finance.recordPayment(ORG, { invoiceId: invoice.id, amount: 5, method: 'crypto', reference: 'x1234' }, 'u')).rejects.toThrow(/Method/);
      await expect(finance.recordPayment(ORG, { invoiceId: invoice.id, amount: 5, method: 'upi' }, 'u')).rejects.toThrow(/reference/);
      await expect(finance.recordPayment(ORG, { invoiceId: invoice.id, amount: 5, method: 'upi', reference: 'x1234', paidAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }, 'u')).rejects.toThrow(/future/);
      const draft = await invoiceOf((await order()).order.id);
      await expect(finance.recordPayment(ORG, { invoiceId: draft.id, amount: 5, method: 'cash' }, 'u')).rejects.toThrow(/draft/);
    });

    it('reversal is a correction through an approval: a manager asks, an admin approves, balances follow', async () => {
      const { invoice, order: o } = await issued({ qty: 10, taxPercent: 0 });
      const { payment } = await pay(invoice.id, 1000);
      await finance.verifyPayment(ORG, payment.id, FIN, 'Cheque cleared per statement');
      expect((await prisma.salesOrder.findUnique({ where: { id: o.id } })).paymentStatus).toBe('paid');
      await expect(finance.requestReversal(ORG, payment.id, MANAGER, '')).rejects.toThrow(/reason/);
      const r = await finance.requestReversal(ORG, payment.id, MANAGER, 'Cheque bounced');
      expect(r.applied).toBe(false);
      expect((await prisma.payment.findUnique({ where: { id: payment.id } })).status).toBe('verified'); // nothing until approved
      await expect(approvals.decide(ORG, r.approval.id, 'approve', MANAGER)).rejects.toThrow(/finance.reverse_payment/);
      const done = await approvals.decide(ORG, r.approval.id, 'approve', ADMIN);
      expect(done.status).toBe('executed');
      expect((await prisma.payment.findUnique({ where: { id: payment.id } })).status).toBe('reversed');
      expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).toMatchObject({ status: 'issued' });
      expect(Number((await prisma.invoice.findUnique({ where: { id: invoice.id } })).amountPaid)).toBe(0);
      expect((await prisma.salesOrder.findUnique({ where: { id: o.id } })).paymentStatus).toBe('unpaid');
    });
  });

  describe('receivables and workflows', () => {
    it('overdue from the real due date; aging; overdue scan opens one follow-up per invoice; overview counts only verified cash', async () => {
      const { invoice } = await issued({ qty: 20, taxPercent: 0 }); // 2000
      await prisma.invoice.update({ where: { id: invoice.id }, data: { dueDate: new Date(Date.now() - 40 * 86_400_000) } });
      const { payment } = await pay(invoice.id, 500);
      await finance.verifyPayment(ORG, payment.id, FIN, 'UPI credit seen in statement');
      await pay(invoice.id, 700); // pending: not collected
      const rec = await finance.receivables(ORG);
      const row = rec.invoices.find((i: any) => i.id === invoice.id);
      expect(row).toMatchObject({ outstanding: 1500, overdue: true });
      expect(row.daysOverdue).toBeGreaterThanOrEqual(39);
      expect(rec.aging['31_60']).toBeGreaterThanOrEqual(1500);
      const a = await orchestrator.submit(ORG, { kind: 'finance.overdue_scan', trigger: 'schedule', idempotencyKey: `od-${Date.now()}`, requestedBy: 'system' }, { runNow: true });
      expect(a.task.status).toBe('COMPLETED');
      expect(a.task.result.overdue.some((x: any) => x.invoiceId === invoice.id)).toBe(true);
      const b = await orchestrator.submit(ORG, { kind: 'finance.overdue_scan', trigger: 'schedule', idempotencyKey: `od2-${Date.now()}`, requestedBy: 'system' }, { runNow: true });
      expect(await prisma.workTask.count({ where: { organizationId: ORG, agent: 'finance', kind: 'review', entityId: invoice.id } })).toBe(1);
      expect(b.task.status).toBe('COMPLETED');
      const ov = await finance.overview(ORG, 30);
      const verified = await prisma.payment.aggregate({ where: { organizationId: ORG, status: 'verified' }, _sum: { amount: true } });
      expect(ov.collectedVerified.amount).toBeCloseTo(Number(verified._sum.amount) - 0, 2);
      expect(ov.awaitingVerification.count).toBeGreaterThan(0);
      expect(ov.expenses).toEqual({ amount: expect.any(Number), count: expect.any(Number) }); // recorded expenses (period), never invented
      expect(ov.grossMargin).toBeNull();
    });

    it('payment -> fulfilment: with "full" rule dispatch is refused until verified; verification hands over to Operations', async () => {
      await settings.update(ORG, { finance: { dispatchPaymentRule: 'full' } });
      const { invoice, order: o } = await issued({ qty: 10, taxPercent: 0 });
      await textile.setOrderStatus(ORG, o.id, 'processing', 'user:a');
      await expect(textile.setOrderStatus(ORG, o.id, 'ready_to_dispatch', 'user:a')).rejects.toThrow(/fully paid/);
      const { payment } = await pay(invoice.id, 1000);
      await expect(textile.setOrderStatus(ORG, o.id, 'ready_to_dispatch', 'user:a')).rejects.toThrow(/fully paid/); // a recorded claim is not enough
      await finance.verifyPayment(ORG, payment.id, FIN, 'NEFT credit in statement');
      const t = await prisma.agentTask.findFirst({ where: { organizationId: ORG, kind: 'finance.payment_verified', entityId: payment.id }, include: { children: true } });
      expect(t).toMatchObject({ status: 'COMPLETED', result: { eligibleForDispatch: true, dispatchRule: 'full', orderPaymentStatus: 'paid' } });
      expect(t.children.map((c: any) => `${c.agent}:${c.kind}:${c.status}`)).toEqual(['operations:operations.fulfilment_check:COMPLETED']);
      await expect(textile.setOrderStatus(ORG, o.id, 'ready_to_dispatch', 'user:a')).resolves.toBeTruthy();
      // The same verification event again does not run the workflow twice.
      await orchestrator.submit(ORG, { kind: 'finance.payment_verified', input: { paymentId: payment.id }, trigger: 'event', idempotencyKey: `payment:${payment.id}:verified`, requestedBy: 'x' }, { runNow: true });
      expect(await prisma.agentTask.count({ where: { organizationId: ORG, kind: 'finance.payment_verified', entityId: payment.id } })).toBe(1);
    });

    it('tenant isolation: invoices and payments of one business are invisible and untouchable to another', async () => {
      const { invoice } = await issued();
      const { payment } = await pay(invoice.id, 100);
      await expect(finance.getInvoice(OTHER, invoice.id)).rejects.toThrow(/not found/);
      await expect(finance.verifyPayment(OTHER, payment.id, ADMIN, 'Statement line checked')).rejects.toThrow(/not found/);
      await expect(finance.recordPayment(OTHER, { invoiceId: invoice.id, amount: 5, method: 'cash' }, 'u')).rejects.toThrow(/Choose the invoice/);
      await expect(finance.setInvoiceStatus(OTHER, invoice.id, 'cancelled', ADMIN, { reason: 'x' })).rejects.toThrow(/not found/);
      expect((await finance.listInvoices(OTHER)).some((i: any) => i.id === invoice.id)).toBe(false);
      expect((await finance.listPayments(OTHER)).some((p: any) => p.id === payment.id)).toBe(false);
    });

    it('CSV export has the invoices and neutralises spreadsheet formulas', async () => {
      const { invoice } = await issued();
      await prisma.customer.update({ where: { id: invoice.customerId }, data: { name: '=HYPERLINK("http://x")' } });
      const csv = await finance.exportInvoicesCsv(ORG);
      expect(csv.split('\n')[0]).toMatch(/^number,status,order,customer/);
      expect(csv).toContain(invoice.number);
      expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    });
  });
});
