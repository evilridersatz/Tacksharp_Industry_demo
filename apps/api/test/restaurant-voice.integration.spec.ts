/**
 * GR Chicken phone calls, cross-channel memory, tenant isolation and grounded answers — DB-backed.
 * Real MySQL TEST database; Plivo, Sarvam, WhatsApp and the language model are fakes (nothing leaves the machine).
 *
 *   TEST_DB_NAME=tacksharp_test npm run test:restaurant -w apps/api
 * Skipped automatically when TEST_DB_NAME is not set (never runs against your real DB).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.PLIVO_AUTH_ID = 'test';
  process.env.PLIVO_AUTH_TOKEN = 'test';
  process.env.PLIVO_FROM_NUMBER = '914400000000';
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
const GR_PLIVO = '914455500011';
let n = 0;
const phone = () => `97${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;
const NOW = new Date();
const PROPERTY = /\b(BHK|property|properties|site visit|apartment|villa|plot|lakhs?|Porur|Green Valley|Lake View|enquiry)\b/i;

describe.skipIf(!enabled)('GR Chicken calls, memory and isolation (integration)', () => {
  let prisma: any, conversations: any, catalog: any, orders: any, offers: any, engine: any, store: any, tenancy: any, ai: any, voice: any, llmFake: any, reEngine: any;
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

  let sarvamFake: any;
  let sharedRedis: any;
  let makeVoice: () => any;
  /** Minimal ioredis-like store (GET / SET with EX and NX / DEL) for the turn de-duplication. */
  function fakeRedis() {
    const m = new Map<string, string>();
    return {
      async get(k: string) { return m.get(k) ?? null; },
      async set(k: string, v: string, ...args: Array<string | number>) {
        if (args.includes('NX') && m.has(k)) return null;
        m.set(k, v);
        return 'OK';
      },
      async del(k: string) { return m.delete(k) ? 1 : 0; },
    };
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
    const { VoiceService } = await import('../src/voice/voice.service.js');
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
    const leads = { ensureActiveLead: vi.fn(), advanceLeadStatus: vi.fn() };
    const fu = { settingsFor: vi.fn(), createHumanTask: vi.fn(), cancelPending: vi.fn(), hasActiveVoiceAutomation: vi.fn(), create: vi.fn() };
    voice = new VoiceService(prisma, ai, conversations, leads as any, fu as any, sarvam as any, tenancy);
    // Two API processes sharing one Redis (or one process before / after a restart): a fake Redis, never the real one.
    sharedRedis = fakeRedis();
    voice.turnDedupe.useRedis(sharedRedis);
    makeVoice = () => {
      const v = new VoiceService(prisma, ai, conversations, leads as any, fu as any, sarvam as any, tenancy);
      (v as any).client = (voice as any).client;
      v.turnDedupe.useRedis(sharedRedis);
      return v;
    };
    sarvamFake = sarvam;
    // Never a real Plivo request from a test.
    (voice as any).client = { calls: { create: vi.fn(async () => ({ requestUuid: 'req-test' })), hangup: vi.fn(async () => undefined) } };
    await seedOrg(ORG);
    await seedOrg(ORG_B);
    await prisma.organization.upsert({ where: { id: RE_ORG }, create: { id: RE_ORG, name: 'Test Realty', vertical: 'real_estate' }, update: { vertical: 'real_estate' } });
    // A restaurant with no products configured (stock cannot be verified).
    await prisma.organization.upsert({ where: { id: EMPTY_ORG }, create: { id: EMPTY_ORG, name: 'GR Chicken Branch', vertical: 'restaurant' }, update: { vertical: 'restaurant' } });
    await prisma.menuItem.deleteMany({ where: { organizationId: EMPTY_ORG } });
    // GR Chicken's own Plivo number is mapped to it (seed: GR_PLIVO_NUMBER).
    await prisma.organizationChannel.upsert({ where: { kind_externalId: { kind: 'plivo_number', externalId: GR_PLIVO } }, create: { organizationId: ORG, kind: 'plivo_number', externalId: GR_PLIVO }, update: { organizationId: ORG } });
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
    (voice as any).client.calls.create.mockClear();
    process.env.DRY_RUN = 'true';
    delete process.env.LIVE_TEST_RECIPIENTS;
  });

  afterAll(async () => {
    await Promise.all(pending);
    await prisma?.$disconnect();
  });

  const wa = (p: string, org = ORG) => (message: string) => engine.generate({ organizationId: org, channel: 'whatsapp', phone: p, message, customerName: 'Priya', now: NOW });

  /** A live (approved test number) restaurant call, answered; returns a function that speaks one customer turn. */
  async function answeredCall(p: string, org = ORG, opts: { name?: string; language?: string } = {}) {
    const customer = await conversations.getOrCreateCustomerByPhone(org, p, { name: opts.name ?? 'Priya' });
    await prisma.customer.update({ where: { id: customer.id }, data: { callingConsent: true, ...(opts.language ? { language: opts.language } : {}) } });
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_RECIPIENTS = p;
    const start = await voice.startOutboundCall({ organizationId: org, customerId: customer.id, ignoreCallWindow: true });
    expect(start).toMatchObject({ started: true });
    const xml = await voice.answerOutbound(start.callId, { CallUUID: `uuid-${start.callId}` });
    const rt = await (voice as any).runtime(start.callId);
    const turn = (text: string, ms = 2500) => voice.understand(rt, text, 'ta-IN', ms);
    return { callId: start.callId, customer, rt, xml, turn };
  }

  // ------------------------------------------------------------------------------------------- voice
  describe('restaurant phone call (the 18-second call)', () => {
    it('opening line is about GR Chicken, never a property enquiry; no real-estate lead or session is created', async () => {
      const c = await answeredCall(phone());
      const call = await prisma.call.findUnique({ where: { id: c.callId } });
      expect(call.leadId).toBeNull();
      expect(reEngine.openCallSession).not.toHaveBeenCalled();
      const conv = await prisma.conversation.findFirst({ where: { organizationId: ORG, customerId: c.customer.id, channel: 'voice' }, include: { Message: { orderBy: { createdAt: 'asc' } } } }).catch(async () => prisma.conversation.findFirst({ where: { organizationId: ORG, customerId: c.customer.id, channel: 'voice' } }));
      const opening = (await prisma.message.findFirst({ where: { conversationId: conv.id, role: 'assistant' }, orderBy: { createdAt: 'asc' } })).content;
      expect(opening).toContain('GR Chicken');
      expect(opening).not.toMatch(PROPERTY);
      expect(c.xml).toContain('<Record');
      expect(c.rt.keyterms).toContain('Broiler Chicken'); // STT is biased to the shop's products, not property names
      expect(c.rt.keyterms.join(' ')).not.toMatch(PROPERTY);
    });

    it('greeting → Tamil order over 5 turns: every normal turn keeps the call open; it ends only after "இல்ல" to "anything else?"', async () => {
      const c = await answeredCall(phone());
      const t1 = await c.turn('ரெண்டு கிலோ broiler curry cut வேணும்');
      expect(t1).toMatchObject({ kind: 'reply', end: false });
      expect(t1.finalText).toContain('Payment');
      const t2 = await c.turn('cash');
      expect(t2.end).toBe(false);
      expect(t2.finalText).toContain('collect');
      const t3 = await c.turn('ரெண்டு மணி நேரத்துல வரேன்');
      expect(t3.end).toBe(false);
      expect(t3.finalText).toContain('confirm பண்ணவா');
      expect(t3.finalText).toContain('440 ரூபாய்');
      expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(0); // nothing placed before "yes"
      const t4 = await c.turn('ஆமா', 900);
      expect(t4.end).toBe(false);
      expect(t4.finalText).toContain('Order confirm ஆச்சு');
      expect(t4.finalText).toContain('வேற ஏதாவது வேணுமா');
      expect(await prisma.order.count({ where: { organizationId: ORG, customerId: c.customer.id, channel: 'voice' } })).toBe(1);
      const t5 = await c.turn('இல்ல', 900);
      expect(t5).toMatchObject({ end: true });
      for (const t of [t1, t2, t3, t4, t5]) {
        expect(t.finalText).not.toMatch(/[*₹✅🙏📞]|\n/u); // spoken, not WhatsApp formatting
        expect(t.finalText).not.toMatch(PROPERTY);
      }
      await reEngine.settle();
      await voice.handleHangup(c.callId, { CallStatus: 'completed', Duration: '55' });
      const call = await prisma.call.findUnique({ where: { id: c.callId } });
      expect(call).toMatchObject({ status: 'completed', outcome: 'order_placed', turns: 5, endReason: 'done_after_order' });
      expect(call.summary).toContain('placed an order');
      // Plivo retries the hang-up webhook: nothing changes the second time.
      expect(await voice.handleHangup(c.callId, { CallStatus: 'completed' })).toEqual({ ok: true, duplicate: true });
    });

    it('Tanglish and English callers get spoken answers and the call stays open', async () => {
      const ta = await answeredCall(phone());
      const r1 = await ta.turn('rendu kilo broiler curry cut venum');
      expect(r1.end).toBe(false);
      expect(r1.finalText).toMatch(/Payment/);
      const en = await answeredCall(phone(), ORG, { language: 'english' });
      const r2 = await en.turn('I want two kg broiler chicken curry cut please');
      expect(r2.end).toBe(false);
      expect(r2.finalText).toContain('How will you pay');
      const r3 = await en.turn('what are your prices today');
      expect(r3.end).toBe(false);
      expect(r3.finalText).toContain('Broiler Chicken — 220 rupees a kilo'); // answered from the catalogue
      expect(r3.finalText).not.toContain('/kg');
    });

    it('an explicit goodbye on turn 1 ends the call (customer_goodbye) and places nothing', async () => {
      const c = await answeredCall(phone());
      const r = await c.turn('சரி, bye', 1200);
      expect(r).toMatchObject({ kind: 'reply', end: true });
      await reEngine.settle();
      await voice.handleHangup(c.callId, { CallStatus: 'completed' });
      expect(await prisma.call.findUnique({ where: { id: c.callId } })).toMatchObject({ endReason: 'customer_goodbye', turns: 1 });
      expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(0);
    });

    it('goodbye while the summary waits for a yes: the customer is told it was NOT placed', async () => {
      const c = await answeredCall(phone());
      await c.turn('ரெண்டு கிலோ broiler curry cut, cash, ரெண்டு மணி நேரத்துல வரேன்');
      const r = await c.turn('ok bye', 1000);
      expect(r.end).toBe(true);
      expect(r.finalText).toContain('order இன்னும் போடல');
      expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(0);
    });

    it('silence / noise: asks again (never reaches the engine), and only repeated silence ends the call', async () => {
      const c = await answeredCall(phone());
      const spy = vi.spyOn(engine, 'generate');
      const a = await voice.understand(c.rt, '', undefined, 0);
      expect(a).toMatchObject({ kind: 'unclear', end: false });
      const b = await voice.understand(c.rt, '???', undefined, 1500);
      expect(b).toMatchObject({ kind: 'unclear', end: false });
      const d = await voice.understand(c.rt, '', undefined, 0);
      expect(d).toMatchObject({ kind: 'unclear', end: true });
      expect(d.text).not.toContain('team'); // no promise the restaurant does not keep
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      await reEngine.settle();
      expect((await prisma.call.findUnique({ where: { id: c.callId } })).endReason).toBe('no_response');
    });

    it('a property question on the GR Chicken line gets a chicken-shop answer (no BHK / property content)', async () => {
      const c = await answeredCall(phone());
      const r = await c.turn('Porur la 2 BHK flat iruka? site visit pannalaama?');
      expect(r.end).toBe(false);
      expect(r.finalText).not.toMatch(PROPERTY);
      expect(r.finalText).toMatch(/Broiler Chicken/); // answered with what the shop sells
      expect(reEngine.generate).not.toHaveBeenCalled();
    });

    it('delivery and unavailable items are answered from configuration, not invented', async () => {
      const c = await answeredCall(phone());
      const d = await c.turn('Velachery ku home delivery pannuveengala?');
      expect(d.end).toBe(false);
      expect(d.finalText).toContain('delivery இல்ல');
      const u = await c.turn('ஒரு கிலோ liver வேணும்');
      expect(u.finalText).toContain('Chicken Liver இன்னைக்கு இல்ல');
    });

    it('a call to a customer without calling consent, opted out, or in dry-run is never dialled', async () => {
      const p = phone();
      const customer = await conversations.getOrCreateCustomerByPhone(ORG, p, { name: 'Ravi' });
      expect(await voice.startOutboundCall({ organizationId: ORG, customerId: customer.id, ignoreCallWindow: true })).toMatchObject({ started: false, reason: 'no_calling_consent' });
      await prisma.customer.update({ where: { id: customer.id }, data: { callingConsent: true } });
      // DRY_RUN=true (the default): the dashboard "call" button cannot reach a real phone.
      const dry = await voice.startOutboundCall({ organizationId: ORG, customerId: customer.id, ignoreCallWindow: true });
      expect(dry.started).toBe(false);
      expect(dry.reason).toContain('DRY_RUN');
      // Live mode but not an approved test number.
      process.env.DRY_RUN = 'false';
      expect((await voice.startOutboundCall({ organizationId: ORG, customerId: customer.id, ignoreCallWindow: true })).reason).toContain('LIVE_TEST_RECIPIENTS');
      process.env.LIVE_TEST_RECIPIENTS = p;
      await prisma.customer.update({ where: { id: customer.id }, data: { optedOutAt: new Date() } });
      expect(await voice.startOutboundCall({ organizationId: ORG, customerId: customer.id, ignoreCallWindow: true })).toMatchObject({ started: false, reason: 'opted_out' });
      expect((voice as any).client.calls.create).not.toHaveBeenCalled();
      expect(await prisma.call.count({ where: { organizationId: ORG, customerId: customer.id } })).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------- real-time stream
  describe('real-time stream mode: the same rules end-to-end', () => {
    it('three spoken turns: no hang-up until the customer says bye; STT failure asks to repeat', { timeout: 60_000 }, async () => {
      const { StreamCall } = await import('../src/voice/stream/stream-call.js');
      const { DEFAULT_ENDPOINTER } = await import('../src/voice/stream/endpointer.js');
      const { encodeMulaw } = await import('../src/voice/stream/audio.js');
      const c = await answeredCall(phone());
      const script: Array<string | Error> = ['ரெண்டு கிலோ broiler curry cut வேணும்', new Error('Sarvam STT timeout'), 'cash', 'சரி, bye'];
      const sent: any[] = [];
      const hangup = vi.fn(async () => undefined);
      const spoken: string[] = [];
      const tone = (ms: number) => Int16Array.from({ length: Math.round(ms * 8) }, (_, i) => Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 8000)));
      const quiet = (ms: number) => Int16Array.from({ length: Math.round(ms * 8) }, () => Math.round((Math.random() * 2 - 1) * 60));
      // Audio arrives in real time on a call (20 ms per frame); the test feeds it faster, so the clock follows the frames.
      let clock = 1_000_000;
      const call = new StreamCall(
        c.callId,
        (m) => sent.push(m),
        {
          transcribe: vi.fn(async () => {
            const next = script.shift();
            if (next instanceof Error) throw next;
            return { transcript: next ?? '', languageCode: 'ta-IN' };
          }),
          understand: (t, lang, ms) => voice.withCallLock(c.callId, () => voice.understand(c.rt, t, lang, ms)),
          speak: vi.fn(async (text: string) => (spoken.push(text), { audio: encodeMulaw(tone(200)), languageCode: 'ta-IN', cached: false, attempts: 1 })),
          audioForUrl: vi.fn(async () => encodeMulaw(tone(200))),
          ttsFailed: vi.fn(async () => ({ audio: null, fallback: 'x' })),
          markReplyNotHeard: vi.fn(),
          logTurn: vi.fn(),
          hangup,
          filler: vi.fn(async () => null),
          isEnglish: () => false,
          now: () => clock,
        },
        { endpointer: DEFAULT_ENDPOINTER, bargeInMs: 400, fillerAfterMs: 0, noResponseMs: 0, chunkBytes: 4000 },
        'https://example.test/voice/audio/opening.wav',
      );
      const media = (pcm: Int16Array) => ((clock += pcm.length / 8), call.onMessage(JSON.stringify({ event: 'media', media: { track: 'inbound', payload: encodeMulaw(pcm).toString('base64') } })));
      const acked = new Set<string>();
      const ackAll = async () => {
        for (const m of sent) if (m.event === 'checkpoint' && !acked.has(m.name)) (acked.add(m.name), await call.onMessage(JSON.stringify({ event: 'playedStream', name: m.name })));
      };
      const waitFor = async (cond: () => boolean) => {
        for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
        expect(cond()).toBe(true);
      };
      const speakTurn = async () => {
        for (const piece of [quiet(200), tone(1200), quiet(900)]) for (let i = 0; i < piece.length; i += 160) await media(piece.subarray(i, i + 160));
      };
      await call.onMessage(JSON.stringify({ event: 'start', start: { streamId: 's1', callId: 'plivo-uuid', mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } } }));
      await ackAll();
      for (let turn = 1; turn <= 4; turn++) {
        const before = spoken.length;
        await speakTurn();
        await waitFor(() => spoken.length > before);
        await ackAll();
        clock += 2000; // the customer listens to the answer before speaking again
        if (turn < 4) {
          expect(hangup, `turn ${turn}`).not.toHaveBeenCalled();
          expect(call.currentState).toBe('listening');
        }
      }
      expect(spoken[1]).toContain('Payment'); // answer to turn 1, call open
      expect(spoken[2]).toMatch(/கேக்கல|repeat|again/i); // STT failed: asked to repeat, not hung up
      expect(spoken[3]).toContain('collect'); // turn 3 answered normally
      await waitFor(() => hangup.mock.calls.length === 1);
      expect(hangup).toHaveBeenCalledWith('conversation_end');
      expect(call.currentState).toBe('closed');
      call.close('socket_closed'); // closing again is harmless (idempotent)
      expect(hangup).toHaveBeenCalledTimes(1);
    });
  });

  // ------------------------------------------------------------------------------------------- memory
  describe('one customer across WhatsApp and phone', () => {
    it('WhatsApp draft → finished on the phone → the old WhatsApp summary cannot create a second order', async () => {
      const p = phone();
      const say = wa(p);
      await say('Hi');
      await say('rendu kilo broiler curry cut, cash');
      const c = await answeredCall(p);
      const r = await c.turn('ரெண்டு மணி நேரத்துல வரேன்');
      expect(r.finalText).toContain('2 கிலோ Broiler Chicken Curry cut'); // carried over from WhatsApp
      expect(r.finalText).toContain('50 ரூபாய் offer'); // the WhatsApp offer claim, not a new one
      await c.turn('ஆமா', 900);
      expect(await prisma.order.count({ where: { organizationId: ORG, customerId: c.customer.id } })).toBe(1);
      const late = await say('sari');
      expect(late.order).toBeUndefined();
      expect(await prisma.order.count({ where: { organizationId: ORG, customerId: c.customer.id } })).toBe(1);
      expect(await prisma.offerClaim.count({ where: { organizationId: ORG, customerId: c.customer.id } })).toBe(1);
    });

    it('phone draft → WhatsApp "Hi" OFFERS the call\'s order (never applied silently); "sari" continues it; language is remembered', async () => {
      const p = phone();
      const c = await answeredCall(p);
      await c.turn('ரெண்டு கிலோ broiler curry cut வேணும்');
      // What the caller spoke (Tamil mixed with English words) is saved on the customer and used on WhatsApp too.
      const lang = (await prisma.customer.findUnique({ where: { id: c.customer.id } })).language;
      expect(['tamil', 'tanglish']).toContain(lang);
      const chat = wa(p);
      const hi = await chat('Hi');
      expect(hi.draft.lines).toEqual([]); // offered, not in the cart yet
      expect(hi.response).toMatch(/2 kg Broiler Chicken Curry cut/);
      expect(hi.response).toMatch(lang === 'tamil' ? /continue பண்ணலாமா/ : /continue pannalaama/);
      const yes = await chat('sari');
      expect(yes.draft.lines).toEqual([expect.objectContaining({ name: 'Broiler Chicken', quantity: 2, cut: 'Curry cut' })]);
      expect(yes.response).toMatch(lang === 'tamil' ? /Payment எப்படி/ : /Payment eppadi/);
      // A different request instead sets the held draft aside (and says so).
      const p2 = phone();
      const c2 = await answeredCall(p2);
      await c2.turn('ரெண்டு கிலோ broiler curry cut வேணும்');
      const other = await wa(p2)('1 kg country chicken curry cut');
      expect(other.draft.lines).toEqual([expect.objectContaining({ name: 'Country Chicken', quantity: 1 })]);
      expect(other.response).toMatch(/thaniya vechutten|தனியா வெச்சுட்டேன்|set your earlier unplaced order aside/);
    });

    it('cross-tenant: the same phone number at another restaurant sees none of it', async () => {
      const p = phone();
      await wa(p)('rendu kilo broiler curry cut, cash');
      const other = await wa(p, ORG_B)('Hi');
      expect(other.draft.lines).toEqual([]);
      const a = await prisma.customer.findFirst({ where: { organizationId: ORG, phone: `91${p}` } });
      const b = await prisma.customer.findFirst({ where: { organizationId: ORG_B, phone: `91${p}` } });
      expect(a.id).not.toBe(b.id);
    });
  });

  // ------------------------------------------------------------------------------------------- isolation
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
  describe('inbound calls are routed by the dialled number, never by guesswork', () => {
    it('a call to GR Chicken\'s mapped Plivo number gets the GR Chicken assistant: no lead, no real-estate session', async () => {
      const p = phone();
      const xml = await voice.answerInbound({ From: `91${p}`, To: GR_PLIVO, CallUUID: `in-${p}` });
      expect(xml).toContain('<Record');
      const call = await prisma.call.findFirst({ where: { providerCallId: `in-${p}` } });
      expect(call).toMatchObject({ organizationId: ORG, direction: 'inbound', leadId: null });
      expect(reEngine.openCallSession).not.toHaveBeenCalled();
      const opening = await prisma.message.findFirst({ where: { organizationId: ORG, role: 'assistant', metadata: { path: '$.callId', equals: call.id } } });
      expect(opening.content).toContain('GR Chicken');
      expect(opening.content).not.toMatch(PROPERTY);
      const rt = await (voice as any).runtime(call.id);
      const t1 = await voice.understand(rt, 'ரெண்டு கிலோ broiler curry cut வேணும்', 'ta-IN', 2500);
      expect(t1.end).toBe(false);
      expect(t1.finalText).not.toMatch(PROPERTY);
      expect(reEngine.generate).not.toHaveBeenCalled();
    });

    it('the routing report shows whether this deployment\'s numbers are mapped or fall back to DEFAULT_ORGANIZATION_ID', async () => {
      const report = await tenancy.mappingReport();
      const plivo = report.find((r: any) => r.kind === 'plivo_number');
      // PLIVO_FROM_NUMBER of this test env is not mapped: it would reach the default organization.
      expect(plivo).toMatchObject({ configured: true, via: 'default_fallback' });
      expect(plivo.masked).not.toContain('4400000000');
    });

    it('if the organization\'s product cannot be read, the call turn fails (asked to repeat) instead of becoming a real-estate turn', async () => {
      const c = await answeredCall(phone());
      const spy = vi.spyOn(tenancy, 'vertical').mockRejectedValueOnce(new (await import('../src/tenancy/tenancy.service.js')).TenantResolutionError('db down', ORG));
      tenancy.clearCache();
      await expect(c.turn('ரெண்டு கிலோ broiler வேணும்')).rejects.toThrow('db down');
      expect(reEngine.generate).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ------------------------------------------------------------------------------------------- Bug 2: availability
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
  describe('one turn per utterance; audio that is really playable', () => {
    const userTurns = async (callId: string) => {
      const call = await prisma.call.findUnique({ where: { id: callId } });
      const conv = await prisma.conversation.findFirst({ where: { organizationId: ORG, customerId: call.customerId, channel: 'voice' }, orderBy: { createdAt: 'desc' } });
      const rows = await prisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: 'asc' } });
      return { user: rows.filter((r: any) => r.role === 'user').length, assistant: rows.filter((r: any) => r.role === 'assistant').length };
    };

    it('I. the same recording delivered twice (retry, even after a restart / on another instance) is ONE turn; an identical new utterance is a new turn', async () => {
      const c = await answeredCall(phone());
      sarvamFake.speechToText.mockResolvedValue({ transcript: 'ரெண்டு கிலோ broiler curry cut வேணும்', languageCode: 'ta-IN' });
      const recording = { RecordUrl: `https://media.example.test/rec-${c.callId}-1.wav`, RecordingDurationMs: '2500' };
      (voice as any).downloadRecording = vi.fn(async () => Buffer.alloc(320));
      const before = await userTurns(c.callId);
      const first = await voice.handleTurn(c.callId, recording);
      // Plivo re-posts the same recording to a restarted / different API process (no shared memory).
      const other = makeVoice();
      other.downloadRecording = vi.fn(async () => Buffer.alloc(320));
      const retry = await other.handleTurn(c.callId, recording);
      expect(retry).toBe(first); // the same reply, no second AI turn
      expect(other.downloadRecording).not.toHaveBeenCalled();
      const afterRetry = await userTurns(c.callId);
      expect(afterRetry.user - before.user).toBe(1);
      expect(afterRetry.assistant - before.assistant).toBe(1);
      // The customer really says the same sentence again: a new recording → a new turn.
      await voice.handleTurn(c.callId, { RecordUrl: `https://media.example.test/rec-${c.callId}-2.wav`, RecordingDurationMs: '2500' });
      const afterRepeat = await userTurns(c.callId);
      expect(afterRepeat.user - before.user).toBe(2);
      expect(afterRepeat.assistant - before.assistant).toBe(2);
      sarvamFake.speechToText.mockReset();
    });

    it('J. greeting and replies are played from TTS audio; a failed TTS gives an explicit fallback, never an empty <Play>', async () => {
      const c = await answeredCall(phone());
      expect(c.xml).toMatch(/<Play>https:\/\/example\.test\/voice\/audio\/x\.wav<\/Play>/); // the greeting
      sarvamFake.speechToText.mockResolvedValue({ transcript: 'ரெண்டு கிலோ broiler curry cut வேணும்', languageCode: 'ta-IN' });
      (voice as any).downloadRecording = vi.fn(async () => Buffer.alloc(320));
      const ok = await voice.handleTurn(c.callId, { RecordUrl: `https://media.example.test/j-${c.callId}-1.wav`, RecordingDurationMs: '2500' });
      expect(ok).toMatch(/<Play>https:\/\/example\.test\/voice\/audio\/y\.wav<\/Play>/); // the dynamic reply
      expect(ok).toContain('<Record');
      // Sarvam fails for the next (Tamil) reply: the cached "line issue" prompt is played and the turn is marked unheard.
      sarvamFake.textToSpeech.mockResolvedValueOnce({ url: '', cached: false, attempts: 2, languageCode: 'ta-IN', error: 'http_503' });
      sarvamFake.speechToText.mockResolvedValue({ transcript: 'cash', languageCode: 'ta-IN' });
      const failed = await voice.handleTurn(c.callId, { RecordUrl: `https://media.example.test/j-${c.callId}-2.wav`, RecordingDurationMs: '2500' });
      expect(failed).not.toMatch(/<Play><\/Play>/);
      expect(failed).toMatch(/<Play>https:\/\/example\.test\/voice\/audio\/x\.wav<\/Play>|<Speak/);
      expect(failed).toContain('<Record');
      sarvamFake.speechToText.mockReset();
    });

    it('J. startup audio check: a WAV served from PUBLIC_BASE_URL passes; a tunnel HTML page or a private URL is reported by key name', async () => {
      const { config } = await import('../src/common/config.js');
      const original = config.publicBaseUrl;
      const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(40)]);
      try {
        (config as any).publicBaseUrl = 'https://shop.example.test';
        const good = await voice.checkAudioReachable('https://shop.example.test/voice/audio/prompt-1.wav', (async () => new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } })) as any);
        expect(good).toMatchObject({ ok: true, status: 200 });
        const html = await voice.checkAudioReachable('https://shop.example.test/voice/audio/prompt-1.wav', (async () => new Response('<html>You are about to visit…</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as any);
        expect(html).toMatchObject({ ok: false, reason: 'not_audio', contentType: 'text/html' });
        (config as any).publicBaseUrl = 'http://localhost:3000';
        const fetchSpy = vi.fn();
        expect(await voice.checkAudioReachable('http://localhost:3000/voice/audio/prompt-1.wav', fetchSpy as any)).toMatchObject({ ok: false, reason: 'not_public_https' });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        (config as any).publicBaseUrl = original;
      }
    });
  });
});
