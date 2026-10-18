/**
 * Textile sales module (industry = textile) against the real MySQL test database and Redis.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/textile.integration.spec.ts
 *
 * REAL: TextileService, the conversation engine's textile assistant, the follow-up processor's textile steps, every
 * database write. FAKE: WhatsApp (a stub that records what would be sent). Nothing here sends a real message or call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const TORG = 'org_textile_test';
const OTHER = 'org_textile_other';
let n = 0;
const uniquePhone = () => `91${String(Date.now()).slice(-7)}${String(n++).padStart(3, '0')}`;

describe.skipIf(!enabled)('Textile sales (integration)', () => {
  let m: any, prisma: any, conversations: any, leads: any, followUps: any, textile: any, engine: any, processor: any, store: any, DEFAULTS: any;
  const llm = { run: vi.fn(async () => ({ text: '', failed: false, aborted: false, usage: { requests: 0 } })) };
  const sender = { sendText: vi.fn(), sendWithinPolicy: vi.fn(), sendNamedTemplate: vi.fn() };
  const settingsStub = { get: async () => ({ ...DEFAULTS, industry: 'textile', textile: { quoteReminderDays: 2, feedbackAfterHours: 24, notifyOrderStatus: true } }) };

  beforeAll(async () => {
    m = {
      ...(await import('../src/prisma/prisma.service.js')),
      ...(await import('../src/conversations/conversations.service.js')),
      ...(await import('../src/leads/leads.service.js')),
      ...(await import('../src/follow-ups/follow-ups.service.js')),
      ...(await import('../src/properties/properties.service.js')),
      ...(await import('../src/site-visits/site-visits.service.js')),
      ...(await import('../src/ai/conversation-engine.service.js')),
      ...(await import('../src/ai/session.store.js')),
      ...(await import('../src/textile/textile.service.js')),
      ...(await import('../src/workers/follow-up.processor.js')),
    };
    DEFAULTS = (await import('../src/settings/tenant-settings.js')).DEFAULT_SETTINGS;
    prisma = new m.PrismaService();
    await prisma.$connect();
    for (const [id, name] of [[TORG, 'Sri Lakshmi Textiles'], [OTHER, 'Other Mills']]) {
      await prisma.organization.upsert({ where: { id }, update: {}, create: { id, name } });
      await prisma.organizationSettings.upsert({ where: { organizationId: id }, update: { data: { industry: 'textile' } }, create: { organizationId: id, data: { industry: 'textile' } } });
    }
    conversations = new m.ConversationsService(prisma);
    leads = new m.LeadsService(prisma);
    followUps = new m.FollowUpsService(prisma, settingsStub);
    textile = new m.TextileService(prisma, followUps, leads, conversations, settingsStub, sender);
    store = new m.SessionStore();
    store.useRedis(null);
    engine = new m.ConversationEngine(prisma, conversations, leads, new m.PropertiesService(prisma), new m.SiteVisitsService(prisma), followUps, store, llm, textile);
    engine.clearIndustryCache();
    processor = new m.FollowUpProcessor(prisma, conversations, leads, {} as never, sender, followUps);

    // Catalogue: one approved price, one "price on request".
    await prisma.textileProduct.deleteMany({ where: { organizationId: { in: [TORG, OTHER] } } });
    await textile.createProduct(TORG, { sku: 'CT-POP-60', name: 'Cotton Poplin Shirting', fabricCategory: 'cotton shirting', composition: '100% cotton', gsm: 110, width: '58 inch', colour: 'white', moq: 100, priceUnit: 'metre', price: 182.5, priceApproved: true, stockStatus: 'in_stock', catalogueUrl: 'https://example.com/poplin.pdf' }, 'test');
    await textile.createProduct(TORG, { sku: 'SK-KAN-01', name: 'Kanchipuram Silk Saree', fabricCategory: 'silk saree', priceUnit: 'piece', price: 9500, priceApproved: false, stockStatus: 'low' }, 'test');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    const { followUpQueue, whatsappQueue, closeRedisConnections } = await import('../src/queues/queues.js');
    await followUpQueue.close();
    await whatsappQueue.close();
    await closeRedisConnections();
  });

  beforeEach(() => {
    sender.sendText.mockReset().mockResolvedValue('wamid.textile');
    sender.sendWithinPolicy.mockReset().mockImplementation(async (p: any) => ({ kind: 'text', messageId: 'wamid.step', content: p.text }));
    llm.run.mockClear();
  });

  async function newLead(org = TORG) {
    const phone = uniquePhone();
    const lead = await leads.createLead({ organizationId: org, name: 'Ravi Kumar', phone, source: 'meta_lead_ads' });
    return { phone, leadId: lead.id as string, customerId: lead.customerId as string };
  }
  const chat = (lead: { phone: string; leadId: string }, channel: 'whatsapp' | 'voice' = 'whatsapp') => async (message: string) => {
    const callId = `call-${lead.leadId}`;
    const r = await engine.generate({ organizationId: TORG, channel, phone: lead.phone, message, leadId: lead.leadId, ...(channel === 'voice' ? { callContext: { direction: 'outbound', callId, reason: 'test' } } : {}) });
    const { sessionKey } = await import('../src/conversation/session.js');
    await engine.settle(sessionKey({ channel, organizationId: TORG, phone: lead.phone, ...(channel === 'voice' ? { callId } : {}) }));
    return r;
  };
  const openWindow = (customerId: string) => prisma.customer.update({ where: { id: customerId }, data: { lastInboundAt: new Date() } });
  const product = (sku: string) => prisma.textileProduct.findFirst({ where: { organizationId: TORG, sku } });

  // ------------------------------------------------------------------ catalogue
  describe('catalogue', () => {
    it('SKU is unique per business; an approved price needs a price; changing the price withdraws the approval; audited', async () => {
      await expect(textile.createProduct(TORG, { sku: 'CT-POP-60', name: 'dup', fabricCategory: 'cotton' }, 'test')).rejects.toThrow(/already exists/);
      await expect(textile.createProduct(TORG, { sku: 'X-1', name: 'x', fabricCategory: 'cotton', priceApproved: true }, 'test')).rejects.toThrow(/needs a price/);
      const p = await textile.createProduct(TORG, { sku: 'RY-01', name: 'Rayon Print', fabricCategory: 'rayon', price: 95, priceApproved: true, imageUrls: ['https://ok.example/a.jpg', 'javascript:alert(1)'] }, 'test');
      expect(p.imageUrls).toEqual(['https://ok.example/a.jpg']); // unsafe link dropped
      const changed = await textile.updateProduct(TORG, p.id, { price: 99 }, 'user:1');
      expect(changed.priceApproved).toBe(false);
      const audit = await prisma.auditEvent.findMany({ where: { organizationId: TORG, entityId: p.id } });
      expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['created', 'price_changed']));
      // Same SKU in ANOTHER business is fine.
      await expect(textile.createProduct(OTHER, { sku: 'RY-01', name: 'Other rayon', fabricCategory: 'rayon' }, 'test')).resolves.toBeTruthy();
    });

    it("tenant isolation: one business never lists or reads another business's records", async () => {
      const mine = await textile.listProducts(TORG);
      const theirs = await textile.listProducts(OTHER);
      expect(mine.every((p: any) => p.organizationId === TORG)).toBe(true);
      expect(theirs.every((p: any) => p.organizationId === OTHER)).toBe(true);
      const lead = await newLead();
      const q = await textile.createQuotation(TORG, { leadId: lead.leadId, items: [{ description: 'Cotton', quantity: 10, unitPrice: 100 }] }, 'test');
      await expect(textile.getQuotation(OTHER, q.id)).rejects.toThrow(/not found/i);
      await expect(textile.setQuotationStatus(OTHER, q.id, 'approved', 'x')).rejects.toThrow(/not found/i);
      await expect(textile.createQuotation(OTHER, { leadId: lead.leadId, items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }, 'x')).rejects.toThrow(/Lead not found/);
    });

    it('buyer requirement: only whitelisted fields are written (the body cannot move a row to another business)', async () => {
      const lead = await newLead();
      const r = await textile.saveRequirement(TORG, lead.leadId, { colour: ' navy ', quantity: '750', organizationId: OTHER, leadId: 'x', id: 'hijack' });
      expect(r).toMatchObject({ organizationId: TORG, leadId: lead.leadId, colour: 'navy' });
      expect(Number(r.quantity)).toBe(750);
      await expect(textile.saveRequirement(TORG, lead.leadId, { quantity: -5 })).rejects.toThrow(/positive/);
      await expect(textile.saveRequirement(OTHER, lead.leadId, { colour: 'red' })).rejects.toThrow(/Lead not found/);
      const cleared = await textile.saveRequirement(TORG, lead.leadId, { quantity: null, colour: '' });
      expect([cleared.quantity, cleared.colour]).toEqual([null, null]);
      await textile.saveRequirement(TORG, lead.leadId, { colour: 'navy' });
      const view = await textile.forLead(TORG, lead.leadId);
      expect(view.requirement.colour).toBe('navy');
      await expect(textile.forLead(OTHER, lead.leadId)).rejects.toThrow(/Lead not found/);
    });
  });

  // ------------------------------------------------------------------ quotation -> order
  describe('quotation -> order', () => {
    it('no guessed prices: an unapproved catalogue price must be entered; totals computed exactly', async () => {
      const lead = await newLead();
      const silk = await product('SK-KAN-01');
      await expect(textile.createQuotation(TORG, { leadId: lead.leadId, items: [{ productId: silk.id, quantity: 10 }] }, 'test')).rejects.toThrow(/Enter a price/);
      const poplin = await product('CT-POP-60');
      const q = await textile.createQuotation(TORG, { leadId: lead.leadId, items: [{ productId: poplin.id, quantity: 500 }, { productId: silk.id, quantity: 2, unitPrice: 9000 }], discount: 1000, taxPercent: 5, shipping: 500 }, 'test');
      expect(q.number).toMatch(/^Q-\d{4}-\d{4}$/);
      expect(Number(q.subtotal)).toBe(109250); // 500 x 182.50 + 2 x 9000
      expect(Number(q.tax)).toBe(5412.5); // 5% of 108250
      expect(Number(q.total)).toBe(114162.5); // 108250 + 5412.50 tax + 500 shipping
      expect(q.status).toBe('draft');
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('quotation_requested');
    });

    it('send: only approved; marked sent only when WhatsApp accepted it; closed window / failure reported, status unchanged', async () => {
      const lead = await newLead();
      const q = await textile.createQuotation(TORG, { leadId: lead.leadId, items: [{ description: 'Cotton Poplin', quantity: 100, unitPrice: 180 }] }, 'test');
      await expect(textile.sendQuotation(TORG, q.id, 'u')).rejects.toThrow(/approved/);
      await expect(textile.setQuotationStatus(TORG, q.id, 'sent', 'u')).rejects.toThrow(/Use "send"/);
      await textile.setQuotationStatus(TORG, q.id, 'approved', 'u');
      await expect(textile.sendQuotation(TORG, q.id, 'u')).rejects.toThrow(/24 hours/); // window closed
      expect((await prisma.quotation.findUnique({ where: { id: q.id } })).status).toBe('approved');
      await openWindow(lead.customerId);
      sender.sendText.mockRejectedValueOnce(new Error('WhatsApp API 500'));
      await expect(textile.sendQuotation(TORG, q.id, 'u')).rejects.toThrow(/did not accept/);
      expect((await prisma.quotation.findUnique({ where: { id: q.id } })).status).toBe('approved');
      const sent = await textile.sendQuotation(TORG, q.id, 'u');
      expect(sent.status).toBe('sent');
      expect(sender.sendText.mock.calls.at(-1)![1]).toMatch(/Quotation Q-.*Total: ₹18,000/s);
      const reminder = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: `quote:reminder:${q.id}` } });
      expect(reminder).toBeTruthy();
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('quotation_sent');
    });

    it('convert: only accepted; exactly one order even when converted twice or in parallel', async () => {
      const lead = await newLead();
      const q = await textile.createQuotation(TORG, { leadId: lead.leadId, items: [{ description: 'Rayon', quantity: 50, unitPrice: 95 }] }, 'test');
      await expect(textile.convertToOrder(TORG, q.id, 'u')).rejects.toThrow(/accepted/);
      await textile.setQuotationStatus(TORG, q.id, 'approved', 'u');
      await openWindow(lead.customerId);
      await textile.sendQuotation(TORG, q.id, 'u');
      await textile.setQuotationStatus(TORG, q.id, 'accepted', 'u');
      const [a, b] = await Promise.all([textile.convertToOrder(TORG, q.id, 'u'), textile.convertToOrder(TORG, q.id, 'u')]);
      expect(a.order.id).toBe(b.order.id);
      expect(await prisma.salesOrder.count({ where: { quotationId: q.id } })).toBe(1);
      const again = await textile.convertToOrder(TORG, q.id, 'u');
      expect(again.duplicate).toBe(true);
      expect(Number(a.order.total)).toBe(4750);
    });

    it('order statuses follow the rules; delivered schedules the feedback request and customer updates; payment is audited', async () => {
      const lead = await newLead();
      const q = await textile.createQuotation(TORG, { leadId: lead.leadId, items: [{ description: 'Cotton', quantity: 10, unitPrice: 100 }] }, 'test');
      await textile.setQuotationStatus(TORG, q.id, 'approved', 'u');
      await openWindow(lead.customerId);
      await textile.sendQuotation(TORG, q.id, 'u');
      await textile.setQuotationStatus(TORG, q.id, 'accepted', 'u');
      const { order } = await textile.convertToOrder(TORG, q.id, 'u');
      await expect(textile.setOrderStatus(TORG, order.id, 'delivered', 'u')).rejects.toThrow(/Cannot move/);
      for (const s of ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered']) await textile.setOrderStatus(TORG, order.id, s, 'u');
      const done = await prisma.salesOrder.findUnique({ where: { id: order.id } });
      expect(done.status).toBe('delivered');
      expect(done.deliveredAt).toBeTruthy();
      const steps = (await prisma.followUp.findMany({ where: { leadId: lead.leadId, source: { in: ['order', 'feedback'] } } })).map((f: any) => f.message.split(':').slice(0, 1).concat(f.message.split(':').slice(3)).join(':'));
      expect(steps.sort()).toEqual(['feedback', 'order:confirmed', 'order:delivered', 'order:dispatched'].sort());
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('order_confirmed');
      await textile.setPaymentStatus(TORG, order.id, 'paid', 'user:7');
      const audit = await prisma.auditEvent.findMany({ where: { organizationId: TORG, entityType: 'order', entityId: order.id }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((x: any) => x.action)).toContain('payment_status');
      await expect(textile.setOrderStatus(TORG, order.id, 'cancelled', 'u')).rejects.toThrow(/Cannot move/);
    });
  });

  // ------------------------------------------------------------------ follow-up steps
  describe('follow-up steps (stubbed WhatsApp)', () => {
    async function deliveredOrder() {
      const lead = await newLead();
      const q = await textile.createQuotation(TORG, { leadId: lead.leadId, items: [{ description: 'Cotton', quantity: 10, unitPrice: 100 }] }, 'test');
      await textile.setQuotationStatus(TORG, q.id, 'approved', 'u');
      await openWindow(lead.customerId);
      await textile.sendQuotation(TORG, q.id, 'u');
      await textile.setQuotationStatus(TORG, q.id, 'accepted', 'u');
      const { order } = await textile.convertToOrder(TORG, q.id, 'u');
      for (const s of ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered']) await textile.setOrderStatus(TORG, order.id, s, 'u');
      return { lead, q, order };
    }

    it('feedback request: sent once per order (a second run is skipped); a low rating opens a task, a high one does not', async () => {
      const { lead, order } = await deliveredOrder();
      const step = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: `feedback:request:${order.id}` } });
      expect(await processor.process(step.id)).toEqual({ sent: 'text', step: 'feedback' });
      expect(sender.sendWithinPolicy.mock.calls.at(-1)![0].text).toMatch(/rating from 1 to 5/);
      expect(await prisma.feedback.count({ where: { orderId: order.id } })).toBe(1);
      const dup = await followUps.create({ organizationId: TORG, leadId: lead.leadId, customerId: lead.customerId, channel: 'whatsapp', source: 'feedback', message: `feedback:request:${order.id}`, scheduledAt: new Date() });
      expect(await processor.process(dup.id)).toEqual({ skipped: 'already_requested' });

      const reply = await chat(lead)('2 - cloth quality was poor');
      expect(reply.response).toMatch(/call you and sort it out/);
      const fb = await prisma.feedback.findFirst({ where: { orderId: order.id } });
      expect(fb).toMatchObject({ rating: 2, status: 'needs_action' });
      expect(await prisma.followUp.findFirst({ where: { customerId: lead.customerId, channel: 'human', status: 'open' } })).toBeTruthy();

      const second = await deliveredOrder();
      const s2 = await prisma.followUp.findFirst({ where: { leadId: second.lead.leadId, message: `feedback:request:${second.order.id}` } });
      await processor.process(s2.id);
      const good = await chat(second.lead)('5');
      expect(good.response).toMatch(/Thank you for the feedback/);
      expect(await prisma.followUp.count({ where: { customerId: second.lead.customerId, channel: 'human', status: 'open' } })).toBe(0);
    });

    it('quotation reminder only while the quotation is still open; an opted-out customer gets nothing', async () => {
      const lead = await newLead();
      const q = await textile.createQuotation(TORG, { leadId: lead.leadId, items: [{ description: 'Cotton', quantity: 10, unitPrice: 100 }] }, 'test');
      await textile.setQuotationStatus(TORG, q.id, 'approved', 'u');
      await openWindow(lead.customerId);
      await textile.sendQuotation(TORG, q.id, 'u');
      const step = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: `quote:reminder:${q.id}` } });
      await textile.setQuotationStatus(TORG, q.id, 'accepted', 'u');
      expect(await processor.process(step.id)).toEqual({ skipped: 'quotation_accepted' });

      const lead2 = await newLead();
      const q2 = await textile.createQuotation(TORG, { leadId: lead2.leadId, items: [{ description: 'Cotton', quantity: 10, unitPrice: 100 }] }, 'test');
      await textile.setQuotationStatus(TORG, q2.id, 'approved', 'u');
      await openWindow(lead2.customerId);
      await textile.sendQuotation(TORG, q2.id, 'u');
      await prisma.customer.update({ where: { id: lead2.customerId }, data: { doNotContact: true } });
      const step2 = await prisma.followUp.findFirst({ where: { leadId: lead2.leadId, message: `quote:reminder:${q2.id}` } });
      expect(await processor.process(step2.id)).toEqual({ skipped: 'do_not_contact' });
      expect(sender.sendWithinPolicy).not.toHaveBeenCalled();
    });

    it('outside the 24 h window with no textile template: skipped with the reason, never sent with the lead template', async () => {
      const { lead, order } = await deliveredOrder();
      await prisma.customer.update({ where: { id: lead.customerId }, data: { lastInboundAt: new Date(Date.now() - 48 * 3600_000) } });
      const step = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: `order:status:${order.id}:dispatched` } });
      expect(await processor.process(step.id)).toEqual({ skipped: 'whatsapp_window_closed_no_template' });
      expect(sender.sendWithinPolicy).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ the textile assistant
  describe('textile assistant (WhatsApp and voice)', () => {
    it('enquiry -> real catalogue match (approved price, specs) -> yes -> quotation request for a salesperson; no model', async () => {
      const lead = await newLead();
      const send = chat(lead);
      const hi = await send('Hi');
      expect(hi.response).toMatch(/Which fabric or product/);
      const r = await send('Need white cotton shirting 500 metres, deliver to Tiruppur');
      expect(r.response).toMatch(/Cotton Poplin Shirting \(CT-POP-60\) - ₹182\.50\/metre/);
      expect(r.response).toMatch(/110 GSM/);
      expect(r.response).toMatch(/Shall I ask our team to prepare a quotation\?$/);
      const req = await prisma.textileRequirement.findUnique({ where: { leadId: lead.leadId } });
      expect(req).toMatchObject({ fabricCategory: 'cotton', productInterest: 'shirting', colour: 'white', quantityUnit: 'metre', destination: 'Tiruppur' });
      expect(Number(req.quantity)).toBe(500);
      const yes = await send('yes');
      expect(yes.response).toMatch(/Quotation request Q-\d{4}-\d{4} is with our team/);
      const q = await prisma.quotation.findFirst({ where: { leadId: lead.leadId }, include: { items: true } });
      expect(q).toMatchObject({ status: 'pending_approval', origin: 'ai_request' });
      expect(q.notes).toMatch(/Customer on whatsapp: "Need white cotton shirting 500 metres, deliver to Tiruppur"/); // their words, not "yes"
      expect(Number(q.items[0].unitPrice)).toBe(182.5); // the approved catalogue price, never a guess
      expect(await prisma.followUp.findFirst({ where: { customerId: lead.customerId, channel: 'human', status: 'open' } })).toBeTruthy();
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('counted stock (Operations) overrides the manual "in stock" label: never promised beyond what is available', async () => {
      const p = await product('CT-POP-60'); // manual label: in_stock
      const bal = await prisma.inventoryBalance.create({ data: { organizationId: TORG, productId: p.id, onHand: 120, reserved: 0 } });
      try {
        const lead = await newLead();
        const r = await chat(lead)('Need white cotton shirting 500 metres');
        expect(r.response).toMatch(/limited stock/);
        expect(r.response).not.toMatch(/in stock/);
        await prisma.inventoryBalance.update({ where: { id: bal.id }, data: { reserved: 120 } });
        const r2 = await chat(await newLead())('Need white cotton shirting 50 metres');
        expect(r2.response).toMatch(/out of stock now/);
      } finally {
        await prisma.inventoryBalance.delete({ where: { id: bal.id } });
      }
    });

    it('asking about a different product starts a new item: the old quantity / colour are not carried over', async () => {
      const lead = await newLead();
      const send = chat(lead);
      await send('Need white cotton shirting 500 metres, we are wholesalers');
      const r = await send('what about silk saree?');
      expect(r.response).toMatch(/Kanchipuram Silk Saree/);
      expect(r.response).toMatch(/How much do you need\?$/); // quantity unknown for the NEW item, so it asks
      const req = await prisma.textileRequirement.findUnique({ where: { leadId: lead.leadId } });
      expect(req).toMatchObject({ fabricCategory: 'silk', productInterest: 'saree', colour: null, quantity: null, quantityUnit: null, buyerType: 'wholesaler' });
    });

    it('an unapproved price is never stated ("price on request"); the quotation request carries no price', async () => {
      const lead = await newLead();
      const send = chat(lead);
      const r = await send('silk saree 20 pieces');
      expect(r.response).toMatch(/Kanchipuram Silk Saree/);
      expect(r.response).toMatch(/price on request/);
      expect(r.response).not.toMatch(/9,?500/);
      await send('yes');
      const q = await prisma.quotation.findFirst({ where: { leadId: lead.leadId }, include: { items: true } });
      expect(Number(q.items[0].unitPrice)).toBe(0); // a salesperson must enter it before approval
      await expect(textile.setQuotationStatus(TORG, q.id, 'approved', 'u')).rejects.toThrow(/needs a price/);
    });

    it('discount / credit / custom: recorded for a salesperson before saying so; not-in-catalogue enquiries become tasks', async () => {
      const lead = await newLead();
      const send = chat(lead);
      const d = await send('Can you give some discount for 2000 metres?');
      expect(d.response).toMatch(/salesperson handles that personally/);
      expect(d.actions.handoff).toBe(true);
      const lead2 = await newLead();
      const nope = await chat(lead2)('Need 300 metres of velvet');
      expect(nope.response).toMatch(/velvet is not in our catalogue right now\. I have asked a salesperson/);
      const task = await prisma.followUp.findFirst({ where: { customerId: lead2.customerId, channel: 'human', status: 'open' } });
      expect(task.message).toMatch(/not in the catalogue: velvet/);
    });

    it('catalogue request sends the approved links and marks the lead catalogue_shared', async () => {
      const lead = await newLead();
      await chat(lead)('cotton shirting');
      const r = await chat(lead)('send me the catalogue');
      expect(r.response).toMatch(/https:\/\/example\.com\/poplin\.pdf/);
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('catalogue_shared');
    });

    it('"confirm" on a sent quotation asks first; only the explicit yes accepts it and opens a convert-to-order task', async () => {
      const lead = await newLead();
      const q = await textile.createQuotation(TORG, { leadId: lead.leadId, items: [{ description: 'Cotton', quantity: 100, unitPrice: 180 }] }, 'test');
      await textile.setQuotationStatus(TORG, q.id, 'approved', 'u');
      await openWindow(lead.customerId);
      await textile.sendQuotation(TORG, q.id, 'u');
      const send = chat(lead);
      const ask = await send('ok confirm');
      expect(ask.response).toMatch(new RegExp(`Confirm quotation ${q.number}, total ₹18,000\\?`));
      expect((await prisma.quotation.findUnique({ where: { id: q.id } })).status).toBe('sent');
      const yes = await send('yes');
      expect(yes.response).toMatch(/is confirmed\. Our team will create the order/);
      expect((await prisma.quotation.findUnique({ where: { id: q.id } })).status).toBe('accepted');
      expect(await prisma.salesOrder.count({ where: { quotationId: q.id } })).toBe(0); // the order is created by a person
    });

    it('"not interested" stops all automation for the customer', async () => {
      const lead = await newLead();
      const r = await chat(lead)('not interested, stop messaging me');
      expect(r.actions.notInterested).toBe(true);
      expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).doNotContact).toBe(true);
    });

    it('voice: short spoken list (no links, at most 2 items) with the same facts', async () => {
      const lead = await newLead();
      await engine.openCallSession({ organizationId: TORG, callId: `call-${lead.leadId}`, phone: lead.phone, leadId: lead.leadId, openingText: 'Hi Ravi, Sri Lakshmi Textiles calling.' });
      const r = await chat(lead, 'voice')('cotton shirting 500 metres');
      expect(r.response).toMatch(/Cotton Poplin Shirting, ₹182\.50\//); // voice calls speak Tamil: "/மீட்டர்"
      expect(r.response).not.toMatch(/https?:|GSM|CT-POP/);
    });

    it('overview: metrics from real rows, with definitions; Meta spend reported unavailable', async () => {
      const o = await textile.overview(TORG, 30);
      expect(o.quotations.sent).toBeGreaterThan(0);
      expect(o.orders.confirmed).toBeGreaterThan(0);
      expect(o.orders.recordedRevenue).toBeGreaterThan(0);
      expect(o.meta.spendAvailable).toBe(false);
      expect(o.definitions.answerRatePct).toMatch(/Ringing is not answered/);
      const other = await textile.overview(OTHER, 30);
      expect(other.orders.confirmed).toBe(0); // nothing leaks across businesses
    });
  });
});
