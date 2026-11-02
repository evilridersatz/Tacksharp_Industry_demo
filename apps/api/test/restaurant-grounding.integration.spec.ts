/**
 * GR Chicken tenant isolation and grounded answers (WhatsApp) — DB-backed. Phone calls run on Sarvam (hosted agent +
 * grounded tools: test/sarvam-tools.integration.spec.ts); the Plivo phone engine tests were removed with Plivo.
 * Real MySQL TEST database; WhatsApp and the language model are fakes (nothing leaves the machine).
 *
 *   TEST_DB_NAME=tacksharp_test npm run test:restaurant -w apps/api
 * Skipped automatically when TEST_DB_NAME is not set (never runs against your real DB).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
    process.env.PUBLIC_BASE_URL = 'https://example.test';
  process.env.VOICE_MODE = 'record';
  process.env.DRY_RUN = 'true';
  delete process.env.LIVE_TEST_RECIPIENTS;
  delete process.env.LIVE_ALLOW_ALL_CUSTOMERS;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
}

const ORG = 'org_test_grv_a';
const ORG_B = 'org_test_grv_b';
const RE_ORG = 'org_test_re_v';
const EMPTY_ORG = 'org_test_grv_empty';
let n = 0;
const phone = () => `97${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;
const NOW = new Date();
const PROPERTY = /\b(BHK|property|properties|site visit|apartment|villa|plot|lakhs?|Porur|Green Valley|Lake View|enquiry)\b/i;

describe.skipIf(!enabled)('GR Chicken calls, memory and isolation (integration)', () => {
  let prisma: any, conversations: any, catalog: any, orders: any, offers: any, engine: any, store: any, tenancy: any, ai: any, llmFake: any, reEngine: any;
  const pending: Promise<unknown>[] = [];

  async function seedOrg(id: string, name = 'GR Chicken') {
    await prisma.organization.upsert({ where: { id }, create: { id, name, vertical: 'restaurant' }, update: { vertical: 'restaurant', name } });
    const cat = await prisma.menuCategory.upsert({ where: { organizationId_name: { organizationId: id, name: 'Chicken' } }, create: { id: `${id}_cat`, organizationId: id, name: 'Chicken' }, update: {} });
    const products = [
      { key: 'broiler', name: 'Broiler Chicken', price: 220, aliases: 'broiler, chicken, kozhi, கோழி, பிராய்லர்', cuts: ['Curry cut', 'Biryani cut', 'Fry cut', 'Whole'] },
      { key: 'country', name: 'Country Chicken', price: 450, aliases: 'country, nattu kozhi', cuts: ['Curry cut', 'Biryani cut', 'Whole'] },
      { key: 'liver', name: 'Chicken Liver', price: 160, aliases: 'liver, ஈரல்', cuts: [], available: false },
    ];
    for (const p of products) {
      const rid = `${id}_${p.key}`;
      const data = { organizationId: id, categoryId: cat.id, name: p.name, price: p.price, aliases: p.aliases, cutOptions: p.cuts, unit: 'kg', minQty: 0.5, maxQty: 10, qtyStep: 0.25, available: p.available ?? true, isDemo: false };
      await prisma.menuItem.upsert({ where: { id: rid }, create: { id: rid, ...data }, update: data });
    }
    const shop = { organizationId: id, name: 'GR Chicken Shop', address: 'Test address', opensAt: '00:00', closesAt: '00:00', prepMinutes: 30, minOrderValue: 0, acceptOutsideHours: false, active: true };
    await prisma.outlet.upsert({ where: { id: `${id}_shop` }, create: { id: `${id}_shop`, ...shop }, update: shop });
    await prisma.offerCampaign.upsert({
      where: { organizationId_code: { organizationId: id, code: 'GR50' } },
      create: { organizationId: id, code: 'GR50', name: 'Website ₹50 off', amount: 50, minOrderValue: 0, validDays: 7, active: true },
      update: { amount: 50, minOrderValue: 0, active: true, templateName: null },
    });
  }

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { CatalogService } = await import('../src/restaurant/catalog.service.js');
    const { OrdersService } = await import('../src/restaurant/orders.service.js');
    const { OffersService } = await import('../src/restaurant/offers.service.js');
    const { OrderSessionStore } = await import('../src/restaurant/order-session.store.js');
    const { OrderingEngine } = await import('../src/restaurant/ordering-engine.service.js');
    const { FeedbackService } = await import('../src/restaurant/feedback.service.js');
    const { OrderFollowUpService } = await import('../src/restaurant/order-followup.service.js');
    const { TenancyService } = await import('../src/tenancy/tenancy.service.js');
    const { AiService } = await import('../src/ai/ai.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    conversations = new ConversationsService(prisma);
    catalog = new CatalogService(prisma);
    orders = new OrdersService(prisma);
    const sender = { sendText: vi.fn(async () => 'wamid.1'), sendNamedTemplate: vi.fn(async () => 'wamid.2') };
    offers = new OffersService(prisma, conversations, sender as any, catalog);
    store = new OrderSessionStore();
    store.useRedis(null);
    llmFake = { run: vi.fn(async () => ({ text: '', failed: true, aborted: false, usage: {} })) };
    const sarvam = { enabled: true, keyterms: [], textToSpeechUrl: vi.fn(async () => 'https://example.test/voice/audio/x.wav'), textToSpeech: vi.fn(async () => ({ url: 'https://example.test/voice/audio/y.wav', cached: true, attempts: 0, languageCode: 'ta-IN' })), speechToText: vi.fn(), deleteAudio: vi.fn(async () => undefined) };
    const feedback = new FeedbackService(prisma);
    const ready = { voiceStatus: () => ({ ready: false, missing: [] }) };
    const followUps = new OrderFollowUpService(prisma, conversations, sender as any, ready as any, sarvam as any, feedback);
    followUps.queue = { add: vi.fn(async () => undefined) };
    engine = new OrderingEngine(prisma, conversations, catalog, orders, offers, feedback, followUps, store, llmFake);
    tenancy = new TenancyService(prisma);
    // The real-estate engine is a spy: a restaurant turn must never reach it (and vice versa).
    reEngine = {
      generate: vi.fn(async () => ({ conversationId: 'c', customerId: 'x', leadId: 'l', response: 'Porur-ல 2 BHK options இருக்கு.', actions: {}, timings: {}, path: 'rules' })),
      background: (_k: string, work: () => Promise<unknown>) => void pending.push(work().catch(() => undefined)),
      settle: async () => void (await Promise.all(pending)),
      closeSession: async () => undefined,
      voiceSessionKey: (o: string, c: string) => `voice:${o}:${c}`,
      openCallSession: vi.fn(),
      likelyFirstReplies: () => [],
      markReplyNotHeard: () => undefined,
    };
    ai = new AiService(reEngine as any, tenancy, engine);
    await seedOrg(ORG);
    await seedOrg(ORG_B);
    await prisma.organization.upsert({ where: { id: RE_ORG }, create: { id: RE_ORG, name: 'Test Realty', vertical: 'real_estate' }, update: { vertical: 'real_estate' } });
    // A restaurant with no products configured (stock cannot be verified).
    await prisma.organization.upsert({ where: { id: EMPTY_ORG }, create: { id: EMPTY_ORG, name: 'GR Chicken Branch', vertical: 'restaurant' }, update: { vertical: 'restaurant' } });
    await prisma.menuItem.deleteMany({ where: { organizationId: EMPTY_ORG } });
  });

  beforeEach(async () => {
    for (const org of [ORG, ORG_B, RE_ORG]) {
      await prisma.offerClaim.deleteMany({ where: { organizationId: org } });
      await prisma.order.deleteMany({ where: { organizationId: org } });
      await prisma.call.deleteMany({ where: { organizationId: org } });
    }
    await prisma.menuItem.updateMany({ where: { organizationId: ORG }, data: { available: true } });
    await prisma.menuItem.updateMany({ where: { organizationId: ORG, name: 'Broiler Chicken' }, data: { price: 220 } });
    await prisma.menuItem.updateMany({ where: { organizationId: ORG, name: 'Chicken Liver' }, data: { available: false } });
    catalog.invalidate(ORG);
    reEngine.generate.mockClear();
    llmFake.run.mockClear();
    process.env.DRY_RUN = 'true';
    delete process.env.LIVE_TEST_RECIPIENTS;
  });

  afterAll(async () => {
    await Promise.all(pending);
    await prisma?.$disconnect();
  });

  const wa = (p: string, org = ORG) => (message: string) => engine.generate({ organizationId: org, channel: 'whatsapp', phone: p, message, customerName: 'Priya', now: NOW });

  describe('tenant / product isolation', () => {
    it('a restaurant question in the real-estate tenant goes to the real-estate engine only; no restaurant state is touched', async () => {
      const spy = vi.spyOn(engine, 'generate');
      const p = phone();
      const r = await ai.generateResponse({ organizationId: RE_ORG, channel: 'whatsapp', phone: p, message: '2 kg broiler curry cut venum' });
      expect(reEngine.generate).toHaveBeenCalledTimes(1);
      expect(spy).not.toHaveBeenCalled();
      expect(r.response).toContain('BHK'); // the real-estate product answers as itself
      expect(await prisma.order.count({ where: { organizationId: RE_ORG } })).toBe(0);
      expect(await store.get(`${RE_ORG}:whatsapp:91${p}`)).toBeUndefined();
      spy.mockRestore();
    });

    it('a property question in the GR Chicken tenant never reaches the real-estate engine, its prompts or inventory', async () => {
      const r = await ai.generateResponse({ organizationId: ORG, channel: 'whatsapp', phone: phone(), message: 'Porur la 2 BHK iruka? Green Valley Residency site visit?' });
      expect(reEngine.generate).not.toHaveBeenCalled();
      expect(r.response).not.toMatch(/\b(BHK options|Green Valley Residency is|site visit booked)\b/i);
      const { getRestaurantAgent } = await import('ai/agents/restaurant-agent.js');
      const agent = getRestaurantAgent('voice');
      expect((agent as any).tools).toEqual([]); // no property search / site-visit tools exist for the restaurant agent
    });
  });

  // ------------------------------------------------------------------------------------------- grounding
  describe('grounded restaurant answers', () => {
    it('menu and price come from the catalogue; a model reply with an invented price is dropped', async () => {
      const p = phone();
      const menu = await wa(p)('rate enna?');
      expect(menu.response).toContain('Broiler Chicken — ₹220/kg');
      process.env.OPENAI_API_KEY = 'test-not-used';
      llmFake.run.mockResolvedValueOnce({ text: 'Broiler is ₹999 per kg today.', failed: false, aborted: false, usage: {} });
      const r = await wa(p)('is the shop clean?');
      delete process.env.OPENAI_API_KEY;
      expect(llmFake.run).toHaveBeenCalled();
      expect(r.response).not.toContain('999');
    });

    it('price changed after the summary: no confirmation is claimed, the new total is shown', async () => {
      const p = phone();
      const say = wa(p);
      await say('Hi');
      const sum = await say('rendu kilo broiler curry cut, cash, 2 mani nerathula varen');
      expect(sum.state).toBe('awaiting_confirmation');
      await prisma.menuItem.updateMany({ where: { organizationId: ORG, name: 'Broiler Chicken' }, data: { price: 240 } });
      catalog.invalidate(ORG);
      const r = await say('sari');
      expect(r.order).toBeUndefined();
      expect(r.response).toContain('order poda mudiyala');
      expect(r.response).not.toContain('confirm aachu');
      expect(r.response).toContain('₹480');
      expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(0);
    });

    it('item became unavailable after the summary: no order, no false confirmation', async () => {
      const p = phone();
      const say = wa(p);
      await say('Hi');
      await say('rendu kilo broiler curry cut, cash, 2 mani nerathula varen');
      await prisma.menuItem.updateMany({ where: { organizationId: ORG, name: 'Broiler Chicken' }, data: { available: false } });
      catalog.invalidate(ORG);
      const r = await say('sari');
      expect(r.order).toBeUndefined();
      expect(r.response).not.toContain('confirm aachu');
      expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(0);
    });

    it('expired offer is not applied; a valid one is', async () => {
      const p = phone();
      const say = wa(p);
      await say('Hi');
      await prisma.offerClaim.updateMany({ where: { organizationId: ORG, phone: `91${p}` }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      const sum = await say('rendu kilo broiler curry cut, cash, 2 mani nerathula varen');
      expect(sum.response).toContain('Offer expire');
      expect(sum.response).not.toContain('−₹50');
      const q = phone();
      await wa(q)('Hi');
      expect((await wa(q)('rendu kilo broiler curry cut, cash, 2 mani nerathula varen')).response).toContain('Offer: −₹50');
    });

    it('order status is read from the order service for this customer only', async () => {
      const p = phone();
      const say = wa(p);
      await say('Hi');
      await say('rendu kilo broiler curry cut, cash, 2 mani nerathula varen');
      const placed = await say('sari');
      const status = await say('order status?');
      expect(status.response).toContain(placed.order.orderNumber);
      expect(status.response).toContain('kadai confirm pannanum');
      const stranger = await wa(phone())(`${placed.order.orderNumber} status`);
      expect(stranger.response).not.toContain(placed.order.orderNumber);
    });

    it('delivery question on WhatsApp: pickup only, from the configured shop', async () => {
      const r = await wa(phone())('home delivery irukka?');
      expect(r.response).toContain('delivery illa');
      expect(r.response).toContain('GR Chicken Shop');
    });
  });

  // ------------------------------------------------------------------------------------------- WhatsApp webhook + receipts
  describe('WhatsApp webhook and delivery receipts', () => {
    it('the same Meta message delivered twice is queued once', async () => {
      const { WhatsAppService } = await import('../src/webhooks/whatsapp.service.js');
      const { InboundMessageService } = await import('../src/whatsapp/inbound-messages.service.js');
      const svc = new WhatsAppService(prisma, { cancelPending: vi.fn(async () => undefined) } as any, { resolve: async () => ORG } as any, { applyDeliveryStatus: vi.fn(async () => 0) } as any, conversations, new InboundMessageService(prisma));
      svc.queue = { add: vi.fn(async () => undefined) };
      const p = phone();
      const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pnid' }, messages: [{ from: `91${p}`, id: `wamid.DUP.${p}`, type: 'text', text: { body: 'Hi' } }] } }] }] };
      expect(await svc.processWebhook(body)).toEqual({ success: true, queued: 1 });
      expect(await svc.processWebhook(body)).toEqual({ success: true, queued: 0 });
      expect(svc.queue.add).toHaveBeenCalledTimes(1);
      expect(await prisma.customer.count({ where: { organizationId: ORG, phone: `91${p}` } })).toBe(1);
    });

    it('accepted is not delivered: receipts move it forward only, failures are recorded', async () => {
      const p = phone();
      const r = await wa(p)('Hi');
      await conversations.recordReplySend(ORG, r.conversationId, { providerMessageId: `wamid.R.${p}`, status: 'accepted' });
      const msg = () => prisma.message.findFirst({ where: { organizationId: ORG, externalId: `wamid.R.${p}` } });
      expect((await msg()).deliveryStatus).toBe('accepted');
      await conversations.applyDeliveryStatus(ORG, `wamid.R.${p}`, 'delivered');
      await conversations.applyDeliveryStatus(ORG, `wamid.R.${p}`, 'read');
      await conversations.applyDeliveryStatus(ORG, `wamid.R.${p}`, 'sent'); // late, out of order: ignored
      expect((await msg()).deliveryStatus).toBe('read');
      expect(await conversations.applyDeliveryStatus(ORG_B, `wamid.R.${p}`, 'failed')).toBe(0); // another tenant cannot touch it
      await conversations.applyDeliveryStatus(ORG, `wamid.R.${p}`, 'failed', '131026 Message undeliverable');
      expect(await msg()).toMatchObject({ deliveryStatus: 'failed', deliveryError: '131026 Message undeliverable' });
    });
  });
  // ------------------------------------------------------------------------------------------- Bug 1: inbound routing
  describe('WhatsApp availability answers come from the catalogue', () => {
    it('"chicken irukka?" → every chicken that can be sold, with catalogue prices (no "illa"), and nothing is ordered', async () => {
      const r = await wa(phone())('chicken irukka?');
      expect(r.response).toContain('Broiler Chicken — ₹220/kg');
      expect(r.response).toContain('Country Chicken — ₹450/kg');
      expect(r.response).not.toContain('Chicken Liver'); // marked not available by the shop
      expect(r.draft.lines).toEqual([]); // a question, not an order for broiler
      expect(r.response).not.toMatch(/inniku illa|not available/i);
      expect(llmFake.run).not.toHaveBeenCalled();
    });

    it('Tamil and English availability questions', async () => {
      const ta = await wa(phone())('கோழி இருக்கா?');
      expect(ta.response).toContain('Broiler Chicken — ₹220/kg');
      const country = await wa(phone())('கண்ட்ரி சிக்கன் இருக்கா?'); // Tamil-script "country chicken"
      // No stock recorded for these products (NULL = unknown): the price, and the shop confirms — never "available ✅", never "out".
      expect(country.response).toContain('Country Chicken — ₹450/kg');
      expect(country.response).toContain('confirm');
      expect(country.response).not.toMatch(/✅|stock இல்ல/);
      const en = await wa(phone())('Is country chicken available today?');
      expect(en.response).toContain("Country Chicken is ₹450/kg. I can't confirm today's stock");
      expect(en.response).not.toMatch(/not available|out of stock|is available/i);
    });

    it('only a product the shop marked unavailable is called unavailable — and alternatives are offered', async () => {
      await prisma.menuItem.updateMany({ where: { organizationId: ORG, name: 'Broiler Chicken' }, data: { available: false } });
      catalog.invalidate(ORG);
      const r = await wa(phone())('1 kg chicken venum');
      expect(r.response).toContain('Broiler Chicken inniku illa');
      expect(r.response).toContain('Aanaa Country Chicken irukku');
      const liver = await wa(phone())('chicken liver irukka?');
      expect(liver.response).toContain('Chicken Liver ippo stock illa');
      expect(liver.response).toContain('Country Chicken irukku');
    });

    it('something not in the catalogue ("mutton irukka?") is "cannot confirm", not "unavailable", and the model is not asked', async () => {
      const r = await wa(phone())('mutton irukka?');
      expect(r.response).toContain('confirm panna mudiyala');
      expect(r.response).toContain('Broiler Chicken');
      expect(r.response).not.toMatch(/mutton.*illa|not available|unavailable/i);
      expect(llmFake.run).not.toHaveBeenCalled();
    });

    it('a restaurant with no products configured says stock cannot be confirmed and hands over to staff', async () => {
      const r = await wa(phone(), EMPTY_ORG)('chicken irukka?');
      expect(r.response).toContain('confirm panna mudiyala');
      expect(r.response).not.toMatch(/inniku illa|not available|unavailable/i);
      expect((await prisma.conversation.findUnique({ where: { id: r.conversationId } })).status).toBe('human_handoff');
      const menu = await wa(phone(), EMPTY_ORG)('rate enna?');
      expect(menu.response).not.toBe('');
      expect(menu.response).not.toMatch(/sold out|mudinjiduchu/);
    });

    it('the model is shown the full catalogue with stock status, and its "not available" sentences are removed', async () => {
      process.env.OPENAI_API_KEY = 'test-not-used';
      llmFake.run.mockResolvedValueOnce({ text: 'Sorry, Broiler Chicken is not available today. Country Chicken is ₹450 per kg.', failed: false, aborted: false, usage: {} });
      const q = wa(phone());
      await q('Hi');
      const r = await q('unga kadai eppo thirakkum sir, fresh-ah cut pannuveengala');
      delete process.env.OPENAI_API_KEY;
      expect(llmFake.run).toHaveBeenCalledTimes(1);
      const args = llmFake.run.mock.calls[0][0];
      expect(args.context.brief).toContain('Broiler Chicken ₹220 per kg');
      expect(args.context.brief).toContain('Chicken Liver ₹160 per kg, [marked not available today by the shop]'.replace(', [', ' ['));
      expect(args.agent.name).toContain('Restaurant'); // the restaurant agent, never the default real-estate one
      expect(r.response).not.toMatch(/not available/i);
      expect(r.response).toContain('Country Chicken is ₹450 per kg.');
    });
  });
  // ------------------------------------------------------------------------------------------- round 7: duplicates + audio
});
