/**
 * STOP / START regression for real-estate and textile businesses (GR Chicken keeps its own STOP flow), against the
 * real MySQL test database:
 *   - a real-estate customer replies STOP on WhatsApp while follow-ups are scheduled -> all of them are cancelled,
 *     a follow-up scheduled AFTER the STOP is refused by the worker, an AI call is refused, the assistant is NOT run
 *     and the customer gets a confirmation instead; START lifts it;
 *   - approval-gated customer messages (payment reminder, stock-shortage decision, campaign) are never sent to a
 *     customer who opted out - whether the STOP came before the approval or between approval and sending - and are
 *     sent exactly as approved otherwise.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/opt-out.integration.spec.ts
 *
 * FAKE: WhatsApp sender / AI (recorded, never called for real), tenancy resolver. DRY_RUN stays on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const RE = 'org_optout_realestate';
const TX = 'org_optout_textile';
const GR = 'org_optout_restaurant';
const ADMIN = { sub: 'oo_admin', role: 'admin' };
const MANAGER = { sub: 'oo_mgr', role: 'manager' };
const FIN = { sub: 'oo_fin', role: 'finance' };
let n = 0;
const phone = () => `9193${String(Date.now()).slice(-6)}${String(n++).padStart(2, '0')}`;
const DAY = 86_400_000;

describe.skipIf(!enabled)('STOP / START opt-out (integration)', () => {
  let prisma: any, leads: any, followUps: any, webhook: any, worker: any, followUpWorker: any, voice: any, conversations: any;
  let textile: any, finance: any, collections: any, fulfilment: any, approvals: any, marketing: any, inventory: any;
  let orgFor = RE;
  const ai = { generateResponse: vi.fn() };
  const sender = { sendText: vi.fn(), downloadMedia: vi.fn(), sendNamedTemplate: vi.fn(), sendWithinPolicy: vi.fn() };

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { LeadsService } = await import('../src/leads/leads.service.js');
    const { FollowUpsService } = await import('../src/follow-ups/follow-ups.service.js');
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { InboundMessageService } = await import('../src/whatsapp/inbound-messages.service.js');
    const { WhatsAppService } = await import('../src/webhooks/whatsapp.service.js');
    const { WhatsAppMessageProcessor } = await import('../src/workers/whatsapp-message.processor.js');
    const { FollowUpProcessor } = await import('../src/workers/follow-up.processor.js');
    const { VoiceService } = await import('../src/voice/voice.service.js');
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
    const { Orchestrator } = await import('../src/agents/orchestrator.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.organization.upsert({ where: { id: RE }, update: { vertical: 'real_estate' }, create: { id: RE, name: 'OptOut Homes', vertical: 'real_estate' } });
    await prisma.organization.upsert({ where: { id: TX }, update: { vertical: 'real_estate' }, create: { id: TX, name: 'OptOut Silks', vertical: 'real_estate' } });
    await prisma.organization.upsert({ where: { id: GR }, update: { vertical: 'restaurant' }, create: { id: GR, name: 'OptOut Chicken', vertical: 'restaurant' } });
    const txSettings = { industry: 'textile', textile: { notifyOrderStatus: true }, finance: { autoDraftInvoice: true, dispatchPaymentRule: 'none', paymentTermsDays: 15 } };
    await prisma.organizationSettings.upsert({ where: { organizationId: TX }, update: { data: txSettings }, create: { organizationId: TX, data: txSettings } });
    const settings = new SettingsService(prisma);
    conversations = new ConversationsService(prisma);
    leads = new LeadsService(prisma);
    followUps = new FollowUpsService(prisma, settings);
    const inbound = new InboundMessageService(prisma);
    webhook = new WhatsAppService(prisma, followUps, { resolve: async () => orgFor } as any, { applyDeliveryStatus: vi.fn(async () => 0) } as any, conversations, inbound);
    webhook.queue = { add: vi.fn(async () => undefined) };
    worker = new WhatsAppMessageProcessor(ai as any, {} as any, sender as any, { advanceLeadStatus: vi.fn(async () => undefined) } as any, conversations, inbound, prisma);
    voice = new VoiceService(prisma, ai as any, conversations, leads, followUps, {} as any, { vertical: async (org: string) => (org === GR ? 'restaurant' : 'real_estate') } as any);
    approvals = new ApprovalsService(prisma);
    const workTasks = new WorkTasksService(prisma);
    const tevents = new TextileEvents();
    const fevents = new FinanceEvents();
    textile = new TextileService(prisma, followUps, leads, conversations, settings, sender as never, approvals, tevents);
    inventory = new InventoryService(prisma);
    finance = new FinanceService(prisma, approvals, workTasks, settings, fevents);
    collections = new CollectionsService(prisma, approvals, workTasks, followUps, fevents);
    fulfilment = new FulfilmentService(prisma, approvals, textile, inventory, followUps);
    marketing = new MarketingService(prisma, conversations, new WhatsAppSenderService(), approvals, settings);
    marketing.useQueue(null);
    (webhook as any).marketing = marketing; // reply attribution runs in the webhook fast path, as in production
    const orchestrator = new Orchestrator(prisma, inventory, workTasks, approvals, settings, tevents, finance, fevents, marketing, collections, followUps);
    orchestrator.useQueue(null);
    orchestrator.onModuleInit();
    followUpWorker = new FollowUpProcessor(prisma, conversations, leads, { startOutboundCall: vi.fn(async () => ({ started: true })) } as any, sender as any, followUps, collections);
    await prisma.textileProduct.deleteMany({ where: { organizationId: TX } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    const { followUpQueue, whatsappQueue, agentQueue, marketingQueue, closeRedisConnections } = await import('../src/queues/queues.js');
    await Promise.allSettled([followUpQueue.close(), whatsappQueue.close(), agentQueue.close(), marketingQueue.close()]);
    await closeRedisConnections();
  });

  beforeEach(() => {
    orgFor = RE;
    ai.generateResponse.mockReset().mockResolvedValue({ response: 'Porur-la 2BHK options irukku!', conversationId: undefined, leadId: '', actions: {}, path: 'llm' });
    sender.sendText.mockReset().mockImplementation(async () => `wamid.OUT${n++}`);
    sender.sendWithinPolicy.mockReset().mockImplementation(async (p: { text: string }) => ({ kind: 'text', messageId: `wamid.FU${n++}`, content: p.text }));
  });

  const inboundText = (from: string, text: string) => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pnid-optout' }, contacts: [{ wa_id: from, profile: { name: 'Karthik' } }], messages: [{ from, id: `wamid.IN${Date.now()}${n++}`, type: 'text', text: { body: text } }] } }] }],
  });
  /** Webhook fast path, then the worker job it queued (as in production). */
  async function receive(org: string, from: string, text: string) {
    orgFor = org;
    const body = inboundText(from, text);
    await webhook.processWebhook(body);
    const job = webhook.queue.add.mock.calls.at(-1)[1];
    return worker.process({ data: job, attemptsMade: 0, opts: { attempts: 3 } } as any);
  }
  const schedule = (org: string, lead: any, source: string, channel = 'whatsapp', message: string | null = 'reminder', inMs = 60_000) =>
    followUps.create({ organizationId: org, leadId: lead.id, customerId: lead.customerId, channel, action: channel === 'voice' ? 'call' : 'message', source, message, scheduledAt: new Date(Date.now() + inMs) });

  it('real estate: STOP cancels every scheduled follow-up, refuses later ones and AI calls, and is confirmed instead of answered by the AI', async () => {
    const p = phone();
    const lead = await leads.createLead({ organizationId: RE, name: 'Karthik', phone: p, source: 'meta' });
    await prisma.customer.update({ where: { id: lead.customerId }, data: { messagingConsent: true, callingConsent: true } });
    const seq = await schedule(RE, lead, 'sequence', 'whatsapp', 'day_2');
    const callback = await schedule(RE, lead, 'callback', 'voice', null, 2 * 3_600_000);
    const visit = await schedule(RE, lead, 'visit', 'whatsapp', 'visit:reminder:none', DAY);
    const alert = await schedule(RE, lead, 'alert', 'whatsapp', 'alert:hot_lead');

    const r = await receive(RE, p, 'STOP');
    // The assistant was not run; the customer got a confirmation (DRY_RUN would block the real send: the fake records it).
    expect(ai.generateResponse).not.toHaveBeenCalled();
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(sender.sendText.mock.calls[0][1]).toMatch(/will not receive any more messages or calls from OptOut Homes.*START/);
    expect(r).not.toHaveProperty('skipped'); // handled and replied, not skipped

    const cu = await prisma.customer.findUnique({ where: { id: lead.customerId } });
    expect(cu).toMatchObject({ optedOutAt: expect.any(Date), messagingConsent: false, callingConsent: false });
    for (const f of [seq, callback, visit]) expect(await prisma.followUp.findUnique({ where: { id: f.id } })).toMatchObject({ status: 'cancelled', cancellationReason: expect.stringMatching(/customer_opted_out|Customer replied/) });
    // Staff alerts are not customer messages: kept.
    expect((await prisma.followUp.findUnique({ where: { id: alert.id } })).status).toBe('scheduled');
    // The conversation shows the STOP and the confirmation.
    const conv = await prisma.conversation.findFirst({ where: { organizationId: RE, externalId: p }, include: { Message: { orderBy: { createdAt: 'asc' } } } });
    expect(conv.Message.map((m: any) => [m.role, m.content.slice(0, 20)])).toEqual(expect.arrayContaining([['user', 'STOP'], ['assistant', expect.stringContaining('Done.')]]));

    // A follow-up scheduled AFTER the STOP (automation, a staff click, a retry) is refused by the worker: nothing sent, no call.
    sender.sendWithinPolicy.mockClear();
    for (const [source, channel] of [['sequence', 'whatsapp'], ['callback', 'voice'], ['visit', 'whatsapp'], ['manual', 'whatsapp']] as const) {
      const late = await schedule(RE, lead, source, channel, source === 'visit' ? 'visit:reminder:none' : 'reminder', 0);
      expect(await followUpWorker.process(late.id)).toEqual({ skipped: 'opted_out' });
      expect((await prisma.followUp.findUnique({ where: { id: late.id } })).cancellationReason).toBe('opted_out');
    }
    expect(sender.sendWithinPolicy).not.toHaveBeenCalled();
    expect(sender.sendText).toHaveBeenCalledTimes(1); // still only the confirmation
    // An AI call (speed-to-lead, dashboard "call now") is refused.
    expect(await voice.startOutboundCall({ organizationId: RE, customerId: lead.customerId })).toMatchObject({ started: false, reason: 'opted_out' });

    // Any later message that is not START keeps the opt-out (and the assistant may answer the question itself).
    await receive(RE, p, 'what is the price of the Porur flat?');
    expect(ai.generateResponse).toHaveBeenCalledTimes(1);
    expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).optedOutAt).not.toBeNull();

    // START: confirmed (not answered by the AI), opt-out lifted; cancelled follow-ups stay cancelled.
    sender.sendText.mockClear();
    ai.generateResponse.mockClear();
    await receive(RE, p, 'START');
    expect(ai.generateResponse).not.toHaveBeenCalled();
    expect(sender.sendText.mock.calls[0][1]).toMatch(/receive updates from OptOut Homes again/);
    expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).optedOutAt).toBeNull();
    expect((await prisma.followUp.findUnique({ where: { id: seq.id } })).status).toBe('cancelled');
    const after = await schedule(RE, lead, 'manual', 'whatsapp', 'reminder', 0);
    expect(await followUpWorker.process(after.id)).not.toEqual({ skipped: 'opted_out' });
  });

  it('STOP inside a sentence is not an opt-out; Tamil STOP works and is confirmed in Tamil', async () => {
    const p = phone();
    const lead = await leads.createLead({ organizationId: RE, name: 'Meena', phone: p });
    await prisma.customer.update({ where: { id: lead.customerId }, data: { language: 'tamil' } });
    await receive(RE, p, "please don't stop sending me the brochure");
    expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).optedOutAt).toBeNull();
    expect(ai.generateResponse).toHaveBeenCalledTimes(1);
    sender.sendText.mockClear();
    await receive(RE, p, 'நிறுத்துங்க');
    expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).optedOutAt).not.toBeNull();
    expect(sender.sendText.mock.calls[0][1]).toMatch(/START/);
    expect(sender.sendText.mock.calls[0][1]).toMatch(/[஀-௿]/); // Tamil script
  });

  it('START from a customer who never opted out is an ordinary message: the assistant answers, no consent is recorded', async () => {
    const p = phone();
    const lead = await leads.createLead({ organizationId: RE, name: 'Suresh', phone: p });
    await receive(RE, p, 'Start');
    expect(ai.generateResponse).toHaveBeenCalledTimes(1);
    expect(sender.sendText.mock.calls[0][1]).toBe('Porur-la 2BHK options irukku!');
    expect(await prisma.customer.findUnique({ where: { id: lead.customerId } })).toMatchObject({ optedOutAt: null, messagingConsent: false });
  });

  it('GR Chicken is untouched: its STOP is left to the ordering engine (the shared path does nothing)', async () => {
    const p = phone();
    await prisma.customer.create({ data: { organizationId: GR, phone: p, messagingConsent: true } });
    const { applyOptKeyword } = await import('../src/consent/opt-out.js');
    expect(await applyOptKeyword(prisma, GR, p, 'STOP')).toBeNull();
    expect((await prisma.customer.findFirst({ where: { organizationId: GR, phone: p } })).optedOutAt).toBeNull();
    // The worker hands the message to the restaurant engine (the AI service) as before.
    await receive(GR, p, 'STOP');
    expect(ai.generateResponse).toHaveBeenCalledTimes(1);
  });

  describe('approval-gated messages after STOP (textile)', () => {
    let silk: any;
    beforeAll(async () => {
      silk = await textile.createProduct(TX, { sku: 'OO-SLK', name: 'OptOut Silk', fabricCategory: 'silk', priceUnit: 'piece', price: 5000, priceApproved: true }, 'test');
    });
    async function sale() {
      const p = phone();
      const lead = await leads.createLead({ organizationId: TX, name: 'Divya', phone: p });
      const q = await textile.createQuotation(TX, { leadId: lead.id, items: [{ productId: silk.id, quantity: 1 }], taxPercent: 5 }, 'test');
      await textile.setQuotationStatus(TX, q.id, 'approved', 'user:a', 'admin');
      await prisma.customer.update({ where: { id: lead.customerId }, data: { lastInboundAt: new Date() } });
      await textile.sendQuotation(TX, q.id, 'user:a');
      await textile.setQuotationStatus(TX, q.id, 'accepted', 'user:a');
      const { order } = await textile.convertToOrder(TX, q.id, 'user:a');
      await textile.setOrderStatus(TX, order.id, 'confirmed', 'user:a');
      return { order, lead, phone: p };
    }
    async function overdueInvoice(orderId: string) {
      const inv = await prisma.invoice.findFirst({ where: { orderId, activeKey: { not: null } } });
      await finance.setInvoiceStatus(TX, inv.id, 'approved', ADMIN);
      await finance.setInvoiceStatus(TX, inv.id, 'issued', ADMIN);
      await prisma.invoice.update({ where: { id: inv.id }, data: { dueDate: new Date(Date.now() - 7 * DAY) } }); // TEST FIXTURE
      return prisma.invoice.findUnique({ where: { id: inv.id } });
    }

    it('payment reminder: approved text is sent verbatim; STOP between approval and sending cancels it; after STOP none can be requested', async () => {
      const a = await sale();
      const invA = await overdueInvoice(a.order.id);
      const ok = await collections.requestReminder(TX, invA.id, FIN);
      expect(ok.status).toBe('queued');
      sender.sendWithinPolicy.mockClear();
      expect((await followUpWorker.process(ok.followUpId)).sent).toBeTruthy();
      expect(sender.sendWithinPolicy.mock.calls[0][0].text).toBe(ok.note); // exactly the text the approver saw
      expect((await prisma.collectionNote.findUnique({ where: { id: ok.id } })).status).toBe('sent');

      const b = await sale();
      const invB = await overdueInvoice(b.order.id);
      const queued = await collections.requestReminder(TX, invB.id, FIN);
      expect(queued.status).toBe('queued');
      await receive(TX, b.phone, 'STOP');
      expect((await prisma.collectionNote.findUnique({ where: { id: queued.id } })).status).toBe('cancelled');
      expect((await prisma.followUp.findUnique({ where: { id: queued.followUpId } })).status).toBe('cancelled');
      sender.sendWithinPolicy.mockClear();
      expect(await followUpWorker.process(queued.followUpId)).toEqual({ skipped: 'cancelled' });
      expect(sender.sendWithinPolicy).not.toHaveBeenCalled();
      await expect(collections.requestReminder(TX, invB.id, FIN)).rejects.toThrow(/opted out/);
    });

    it('payment reminder waiting for approval: STOP withdraws the approval request so nobody can approve it', async () => {
      const a = await sale();
      const inv = await overdueInvoice(a.order.id);
      // Requested by the Finance agent: never self-approved, waits in the queue.
      const waiting = await collections.requestReminder(TX, inv.id, { sub: 'agent' }, { requestedBy: 'agent:finance' });
      expect(waiting.status).toBe('pending_approval');
      expect((await approvals.get(TX, waiting.approvalId)).status).toBe('pending');
      await receive(TX, a.phone, 'STOP');
      expect((await prisma.collectionNote.findUnique({ where: { id: waiting.id } })).status).toBe('cancelled');
      expect(await approvals.get(TX, waiting.approvalId)).toMatchObject({ status: 'cancelled', decidedBy: 'system:opt_out' });
      await expect(approvals.decide(TX, waiting.approvalId, 'approve', FIN)).rejects.toThrow(/already cancelled/);
      expect(await prisma.followUp.count({ where: { organizationId: TX, source: 'invoice', message: { contains: inv.id } } })).toBe(0);
    });

    it('stock-shortage decision: an opted-out customer gets no message even after approval; a later STOP blocks the queued one', async () => {
      const a = await sale();
      await receive(TX, a.phone, 'STOP');
      const r = await fulfilment.requestDecision(TX, a.order.id, { decision: 'revised_date', newDate: new Date(Date.now() + 9 * DAY).toISOString(), customerMessage: 'New delivery date is next Friday.' }, MANAGER);
      expect(r.result.customerUpdate).toBe('not sent: customer opted out');
      expect(await prisma.followUp.count({ where: { organizationId: TX, message: `order:status:${a.order.id}:revised` } })).toBe(0);

      const b = await sale();
      const r2 = await fulfilment.requestDecision(TX, b.order.id, { decision: 'revised_date', newDate: new Date(Date.now() + 9 * DAY).toISOString(), customerMessage: 'New delivery date is next Friday.' }, MANAGER);
      expect(r2.result.customerUpdate).toMatch(/^queued/);
      await receive(TX, b.phone, 'STOP');
      const f = await prisma.followUp.findFirst({ where: { organizationId: TX, message: `order:status:${b.order.id}:revised` } });
      expect(f.status).toBe('cancelled');
      sender.sendWithinPolicy.mockClear();
      await followUpWorker.process(f.id);
      expect(sender.sendWithinPolicy).not.toHaveBeenCalled();

      // Not opted out: the approved message is what the customer receives.
      const c = await sale();
      await fulfilment.requestDecision(TX, c.order.id, { decision: 'alternative', customerMessage: 'We can offer the same silk in wine red instead.' }, MANAGER);
      const fc = await prisma.followUp.findFirst({ where: { organizationId: TX, message: `order:status:${c.order.id}:revised` } });
      sender.sendWithinPolicy.mockClear();
      expect((await followUpWorker.process(fc.id)).sent).toBeTruthy();
      expect(sender.sendWithinPolicy.mock.calls[0][0].text).toContain('We can offer the same silk in wine red instead.');
    });

    it('campaign: STOP after approval skips the queued message; the worker re-checks consent at send time', async () => {
      const p = phone();
      const cu = await prisma.customer.create({ data: { organizationId: TX, phone: p, name: 'Lakshmi', tags: ['oo_list'], messagingConsent: true } });
      const seg = await marketing.saveSegment(TX, { name: `OO list ${Date.now()}`, rules: { tags: ['oo_list'] } }, 'user:m');
      const c = await marketing.createCampaign(TX, { name: `OO campaign ${Date.now()}`, segmentId: seg.id, templateName: 'offer', templateLanguage: 'en', templateParams: ['{{name}}'] }, 'user:m');
      const est = await marketing.estimate(TX, c.id);
      await marketing.requestSend(TX, c.id, ADMIN, { confirm: true, expectedRecipients: est.eligible });
      const rec = await prisma.campaignRecipient.findFirst({ where: { campaignId: c.id, customerId: cu.id } });
      expect(rec.status).toBe('queued');
      await receive(TX, p, 'stop');
      expect((await prisma.campaignRecipient.findUnique({ where: { id: rec.id } })).status).toBe('skipped');
      // A STOP is never counted as a reply to the campaign.
      expect((await prisma.campaignRecipient.findUnique({ where: { id: rec.id } })).repliedAt).toBeNull();
      expect(await marketing.processRecipient({ campaignId: c.id, recipientId: rec.id })).toBe('already_skipped');
      // And the customer is out of every later audience.
      expect((await marketing.estimate(TX, c.id)).excluded.optedOut).toBeGreaterThanOrEqual(1);
    });

    it('a STOP reply to a DELIVERED campaign message is not credited as engagement; a real reply is', async () => {
      const mk = async () => {
        const p = phone();
        const cu = await prisma.customer.create({ data: { organizationId: TX, phone: p, name: 'Revathi', messagingConsent: true } });
        const c = await prisma.marketingCampaign.create({ data: { organizationId: TX, name: `OO delivered ${Date.now()}${n++}`, status: 'completed' } });
        // TEST FIXTURE: a message that was sent and delivered (the live path is covered in marketing.integration.spec.ts).
        const rec = await prisma.campaignRecipient.create({ data: { organizationId: TX, campaignId: c.id, customerId: cu.id, status: 'delivered', providerMessageId: `wamid.OO${n++}`, sentAt: new Date(), deliveredAt: new Date() } });
        return { p, rec };
      };
      const a = await mk();
      await receive(TX, a.p, 'STOP');
      expect(await prisma.campaignRecipient.findUnique({ where: { id: a.rec.id } })).toMatchObject({ status: 'delivered', repliedAt: null });
      const b = await mk();
      await receive(TX, b.p, 'Is the maroon silk still available?');
      expect(await prisma.campaignRecipient.findUnique({ where: { id: b.rec.id } })).toMatchObject({ status: 'replied', repliedAt: expect.any(Date) });
    });
  });
});
