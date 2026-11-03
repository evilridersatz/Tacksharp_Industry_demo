/**
 * Dashboard assistant, business mode (chat, voice, video in the sidebar) — DB-backed. Real MySQL TEST database;
 * WhatsApp and the language model are fakes. Proves: answers and prices come from the business's own menu, an order
 * placed from the assistant is a real order for the entered customer, the customer's history (memory) is returned,
 * voice / video turns are worded for speech on the SAME session (a cart started by chat continues by voice), nothing
 * is sent on WhatsApp, viewers cannot use it, and a non-demo non-restaurant workspace is refused.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/business-assistant.integration.spec.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.PUBLIC_BASE_URL = 'https://example.test';
  process.env.DRY_RUN = 'true';
  delete process.env.LIVE_TEST_RECIPIENTS;
  delete process.env.LIVE_ALLOW_ALL_CUSTOMERS;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  process.env.SARVAM_API_KEY = 'test-sarvam-key-not-real';
  process.env.TELEPHONY_WEBHOOK_SECRET = 'y'.repeat(16) + 'business-assistant-live-secret';
  process.env.SARVAM_AGENTS_API_KEY = 'agents-key-not-real';
  process.env.SARVAM_AGENTS_ORG_ID = 'sv-org';
  process.env.SARVAM_AGENTS_WORKSPACE_ID = 'sv-ws';
  process.env.SARVAM_AGENTS_CONNECTION_ID = 'sv-conn';
  process.env.SARVAM_AGENTS_PHONE_NUMBER = '918000000000';
}

const ORG = 'org_test_ba_a';
const ORG_B = 'org_test_ba_b';
const RE_ORG = 'org_test_ba_re';
const NOW = new Date();
const staff = { sub: 'u_ba', org: ORG, role: 'admin' } as any;

describe.skipIf(!enabled)('Dashboard business assistant (integration)', () => {
  let prisma: any, conversations: any, catalog: any, orders: any, offers: any, engine: any, store: any, tenancy: any, ai: any, llmFake: any, reEngine: any, ctl: any, sender: any, assistant: any;
  const pending: Promise<unknown>[] = [];
  let n = 0;
  const phone = () => `96${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;

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
    sender = { sendText: vi.fn(async () => 'wamid.1'), sendNamedTemplate: vi.fn(async () => 'wamid.2') };
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
    const { AssistantService } = await import('../src/assistant/assistant.service.js');
    const { BusinessAssistantController } = await import('../src/assistant/business-assistant.controller.js');
    assistant = new AssistantService();
    ctl = new BusinessAssistantController(prisma, tenancy, ai, assistant);
    await seedOrg(ORG);
    await seedOrg(ORG_B, 'Other Shop');
    await prisma.menuItem.updateMany({ where: { organizationId: ORG_B, name: 'Broiler Chicken' }, data: { price: 999 } });
    await prisma.organization.upsert({ where: { id: RE_ORG }, create: { id: RE_ORG, name: 'Test Realty', vertical: 'real_estate', isDemo: false }, update: { vertical: 'real_estate', isDemo: false } });
    for (const org of [ORG, ORG_B]) await prisma.order.deleteMany({ where: { organizationId: org } });
  });

  afterAll(async () => {
    await Promise.all(pending);
    if (!prisma) return;
    for (const org of [ORG, ORG_B]) {
      await prisma.orderFollowUp.deleteMany({ where: { organizationId: org } }).catch(() => undefined);
      await prisma.order.deleteMany({ where: { organizationId: org } });
    }
    await prisma.$disconnect();
  });

  const chat = (p: string, message: string, extra: Record<string, unknown> = {}, org = ORG) => ctl.chat(org, { ...staff, org }, { phone: p, message, name: 'Priya', ...extra });

  it('status: the business assistant is on for a restaurant, with its own name and greeting', async () => {
    const s = await ctl.status(ORG, 'en');
    expect(s.enabled).toBe(true);
    expect(s.ordering).toBe(true);
    expect(s.organizationName).toBe('GR Chicken');
    expect(s.greeting).toContain('GR Chicken assistant');
  });

  it('menu and prices come from THIS business database (never another tenant)', async () => {
    const r = await chat(phone(), 'broiler price evlo?');
    expect(r.reply).toContain('220');
    expect(r.reply).not.toContain('999');
    expect(r.sent).toBe(false);
  });

  it('chat builds a cart, voice continues it (same customer, spoken wording), the order is real and nothing is sent', async () => {
    const p = phone();
    await chat(p, 'Hi');
    const typed = await chat(p, 'rendu kilo broiler curry cut, cash, 2 mani nerathula varen');
    expect(typed.step).toBe('awaiting_confirmation');
    expect(typed.reply).toContain('440');
    // Same customer switches to the voice call in the sidebar: the summary is still there and is worded for speech.
    const spoken = await chat(p, 'total evlo?', { spoken: true });
    expect(spoken.reply).not.toMatch(/[*•]/);
    const placed = await chat(p, 'sari', { spoken: true });
    expect(placed.order?.orderNumber).toBeTruthy();
    const row = await prisma.order.findFirst({ where: { organizationId: ORG, orderNumber: placed.order.orderNumber } });
    // 2 kg × ₹220 from the menu, less the business's active ₹50 welcome offer: the backend's total, not the model's.
    expect(Number(row.subtotal)).toBe(440);
    expect(placed.order.total).toBe(Number(row.total));
    expect(row.channel).toBe('test');
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendNamedTemplate).not.toHaveBeenCalled();
    // Memory: the customer's history is what the assistant (and WhatsApp / phone) know about them.
    const mem = await ctl.customer(ORG, p);
    expect(mem.known).toBe(true);
    expect(mem.name).toBe('Priya');
    expect(mem.orderCount).toBe(1);
    expect(mem.recentOrders[0].orderNumber).toBe(placed.order.orderNumber);
  });

  it('an unknown number is a new customer; another tenant never sees this customer', async () => {
    const p = phone();
    expect((await ctl.customer(ORG, p)).known).toBe(false);
    await chat(p, 'Hi');
    expect((await ctl.customer(ORG, p)).known).toBe(true);
    expect((await ctl.customer(ORG_B, p)).known).toBe(false);
  });

  it('speaks in the phone agent\'s voice (speaker, pace, model) and opens with its greeting', async () => {
    await prisma.voiceAgent.deleteMany({ where: { organizationId: ORG } });
    const before = await ctl.status(ORG, 'en');
    expect(before.phoneVoice.source).toBe('account');
    await prisma.voiceAgent.create({ data: { organizationId: ORG, name: 'GR Phone Agent', industry: 'restaurant', instructions: 'x', languages: ['ta', 'en'], voice: { speaker: 'anushka', pace: 1.1 }, greeting: 'Vanakkam {{customer_name}}, GR Chicken pesuren!', fallbackMessage: 'x', status: 'active', telephonyProvider: 'sarvam', sarvamAppId: 'GR-test-app', sarvamAppVersion: 3 } });
    const s = await ctl.status(ORG, 'en');
    expect(s.phoneVoice).toMatchObject({ agent: 'GR Phone Agent', speaker: 'anushka', pace: 1.1, source: 'agent' });
    expect(s.greeting).toBe('Vanakkam, GR Chicken pesuren!');
    const sent: any[] = [];
    assistant.fetchImpl = async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ audios: ['UklGRg=='] }), { status: 200 }); };
    await ctl.tts(ORG, { text: 'Broiler 220 rupees. Total 12500.', style: 'en' });
    await ctl.tts(ORG, { text: 'ப்ராய்லர் கிலோ 220 ரூபாய்.' });
    expect(sent[0]).toMatchObject({ speaker: 'anushka', pace: 1.1, language_code: 'en-IN' });
    expect(sent[0].text).toContain('12,500');
    expect(sent[1].language_code).toBe('ta-IN');
    await prisma.voiceAgent.deleteMany({ where: { organizationId: ORG } });
  });

  it('live call: a ticket for the business\'s own Sarvam phone agent; the SDK URL request is checked and forwarded', async () => {
    await prisma.voiceAgent.deleteMany({ where: { organizationId: ORG } });
    await expect(ctl.liveSession(ORG, staff, { phone: '9876500001' })).rejects.toThrow(/not set up/);
    expect((await ctl.status(ORG, 'en')).liveAgent).toBeNull();
    await prisma.voiceAgent.create({ data: { organizationId: ORG, name: 'GR Phone Agent', industry: 'restaurant', instructions: 'x', languages: ['ta'], greeting: 'Vanakkam!', fallbackMessage: 'x', status: 'active', telephonyProvider: 'sarvam', sarvamAppId: 'GR-app-1', sarvamAppVersion: 3 } });
    expect((await ctl.status(ORG, 'en')).liveAgent).toEqual({ name: 'GR Phone Agent', version: 3 });
    await expect(ctl.liveSession(ORG, { ...staff, role: 'viewer' }, { phone: '9876500001' })).rejects.toThrow(/only view/);
    const s = await ctl.liveSession(ORG, staff, { phone: '9876500001' });
    expect(s.config).toEqual({ org_id: 'sv-org', workspace_id: 'sv-ws', app_id: 'GR-app-1', version: 3, user_identifier: '+919876500001', user_identifier_type: 'phone_number' });
    expect(JSON.stringify(s)).not.toContain('agents-key-not-real');
    const calls: any[] = [];
    ctl.fetchImpl = async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ url: 'wss://example.test/signed', reference_id: 'ref-1' }), { status: 200 }); };
    const req = (ticket: string) => ({ headers: { 'x-assistant-ticket': ticket } }) as any;
    const p = { tenant: ORG, org: 'sv-org', ws: 'sv-ws', app: 'GR-app-1' };
    const r = await ctl.liveUrl(p, { interaction_type: 'call', version: '3' }, req(s.ticket));
    expect(r).toEqual({ url: 'wss://example.test/signed', reference_id: 'ref-1' });
    expect(calls[0].url).toBe('https://apps.sarvam.ai/api/app-runtime/orgs/sv-org/workspaces/sv-ws/apps/GR-app-1/url?interaction_type=call&version=3');
    expect(calls[0].init.headers['X-API-Key']).toBe('agents-key-not-real');
    // Refused: no / forged / expired ticket, another app, another tenant's ticket.
    await expect(ctl.liveUrl(p, {}, req(''))).rejects.toThrow(/expired|ticket/i);
    await expect(ctl.liveUrl(p, {}, req(s.ticket.replace(/.$/, (c: string) => (c === 'a' ? 'b' : 'a'))))).rejects.toThrow(/Invalid ticket/);
    await expect(ctl.liveUrl(p, {}, req(`${Date.now() - 1}.${s.ticket.split('.')[1]}`))).rejects.toThrow(/expired/i);
    await expect(ctl.liveUrl({ ...p, app: 'Other-app' }, {}, req(s.ticket))).rejects.toThrow(/Invalid ticket/);
    await expect(ctl.liveUrl({ ...p, tenant: ORG_B }, {}, req(s.ticket))).rejects.toThrow(/Invalid ticket/);
    expect(calls.length).toBe(1);
    // Sarvam refusing (no committed version) is reported, not hidden.
    ctl.fetchImpl = async () => new Response('{}', { status: 404 });
    await expect(ctl.liveUrl(p, {}, req(s.ticket))).rejects.toThrow(/committed version/);
    await prisma.voiceAgent.deleteMany({ where: { organizationId: ORG } });
  });

  it('live call transcript is saved once on the customer (AI voice calls + voice conversation)', async () => {
    const p = phone();
    const lines = [{ role: 'assistant', content: 'Vanakkam! GR Chicken.' }, { role: 'user', content: 'broiler price evlo?' }, { role: 'assistant', content: 'Broiler kilo 220 rupees.' }];
    const r = await ctl.liveTranscript(ORG, staff, { phone: p, interactionId: `int-${p}`, durationSec: 42, lines });
    expect(r.saved).toBe(true);
    expect((await ctl.liveTranscript(ORG, staff, { phone: p, interactionId: `int-${p}`, durationSec: 42, lines })).duplicate).toBe(true);
    const call = await prisma.call.findFirst({ where: { organizationId: ORG, providerCallId: `int-${p}` } });
    expect(call).toMatchObject({ direction: 'inbound', status: 'completed', provider: 'sarvam', durationSec: 42 });
    expect(call.summary).toContain('broiler price evlo?');
    expect(await prisma.message.count({ where: { organizationId: ORG, metadata: { path: '$.callId', equals: call.id } } })).toBe(3);
    expect((await ctl.customer(ORG, p)).channels).toContain('voice');
    await prisma.message.deleteMany({ where: { organizationId: ORG, conversation: { externalId: `91${p.slice(-10)}`, channel: 'voice' } } }).catch(() => undefined);
    await prisma.call.deleteMany({ where: { id: call.id } });
  });

  it('refuses: viewers, a missing number, and a live non-restaurant workspace', async () => {
    await expect(ctl.chat(ORG, { ...staff, role: 'viewer' }, { phone: phone(), message: 'Hi' })).rejects.toThrow(/only view/);
    await expect(ctl.chat(ORG, staff, { phone: '', message: 'Hi' })).rejects.toThrow(/mobile number/);
    const s = await ctl.status(RE_ORG, 'en');
    expect(s.enabled).toBe(false);
    await expect(ctl.chat(RE_ORG, { ...staff, org: RE_ORG }, { phone: phone(), message: 'Hi' })).rejects.toThrow(/demo workspace/);
    expect(reEngine.generate).not.toHaveBeenCalled();
  });
});
