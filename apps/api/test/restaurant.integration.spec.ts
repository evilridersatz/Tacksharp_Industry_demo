/**
 * GR Chicken offer → WhatsApp order → ready call, DB-backed. Real MySQL test database; WhatsApp,
 * Plivo, Sarvam and the language model are fakes.
 *
 *   TEST_DB_NAME=tacksharp_test npm test -w apps/api
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
  process.env.VOICE_CALL_WINDOW_START = '0';
  process.env.VOICE_CALL_WINDOW_END = '24';
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
}

const ORG = 'org_test_gr_a';
const ORG_B = 'org_test_gr_b';
let n = 0;
const phone = () => `98${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;
// 10:00 IST, so "saayangaalam 6 mani" is later the same day.
const NOW = new Date(Date.now());

describe.skipIf(!enabled)('GR Chicken offer + pickup orders (integration)', () => {
  let prisma: any, engine: any, orders: any, catalog: any, offers: any, ready: any, sender: any, sarvam: any, conversations: any, publicOffers: any;

  async function seedOrg(id: string) {
    await prisma.organization.upsert({ where: { id }, create: { id, name: 'GR Chicken', vertical: 'restaurant' }, update: { vertical: 'restaurant' } });
    const cat = await prisma.menuCategory.upsert({ where: { organizationId_name: { organizationId: id, name: 'Chicken' } }, create: { id: `${id}_cat`, organizationId: id, name: 'Chicken' }, update: {} });
    const products = [
      { key: 'broiler', name: 'Broiler Chicken', price: 220, aliases: 'broiler, chicken, kozhi, கோழி', cuts: ['Curry cut', 'Biryani cut', 'Fry cut', 'Whole'] },
      { key: 'country', name: 'Country Chicken', price: 450, aliases: 'country, nattu kozhi', cuts: ['Curry cut', 'Biryani cut', 'Whole'] },
      { key: 'boneless', name: 'Boneless Chicken', price: 380, aliases: 'boneless', cuts: [], minQty: 0.25 },
      { key: 'liver', name: 'Chicken Liver', price: 160, aliases: 'liver', cuts: [], available: false },
    ];
    for (const p of products) {
      const rid = `${id}_${p.key}`;
      const data = { organizationId: id, categoryId: cat.id, name: p.name, price: p.price, aliases: p.aliases, cutOptions: p.cuts, unit: 'kg', minQty: p.minQty ?? 0.5, maxQty: 10, qtyStep: 0.25, available: p.available ?? true, isDemo: false };
      await prisma.menuItem.upsert({ where: { id: rid }, create: { id: rid, ...data }, update: data });
    }
    const oid = `${id}_shop`;
    const shop = { organizationId: id, name: 'GR Chicken Shop', address: 'Test address', opensAt: '00:00', closesAt: '00:00', prepMinutes: 30, minOrderValue: 0, acceptOutsideHours: false, active: true };
    await prisma.outlet.upsert({ where: { id: oid }, create: { id: oid, ...shop }, update: shop });
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
    const { ReadyNoticeService } = await import('../src/restaurant/ready-notice.service.js');
    const { PublicOffersController } = await import('../src/restaurant/public-offers.controller.js');
    prisma = new PrismaService();
    await prisma.$connect();
    conversations = new ConversationsService(prisma);
    catalog = new CatalogService(prisma);
    orders = new OrdersService(prisma);
    sender = { sendText: vi.fn(async () => 'wamid.1'), sendNamedTemplate: vi.fn(async () => 'wamid.2') };
    offers = new OffersService(prisma, conversations, sender, catalog);
    const store = new OrderSessionStore();
    store.useRedis(null);
    const llmFake = { run: vi.fn(async () => ({ text: '', failed: true, aborted: false, usage: {} })) };
    engine = new OrderingEngine(prisma, conversations, catalog, orders, offers, store, llmFake as any);
    sarvam = { enabled: true, textToSpeechUrl: vi.fn(async () => 'https://example.test/voice/audio/x.wav'), speechToText: vi.fn(async () => ({ transcript: '' })) };
    ready = new ReadyNoticeService(prisma, orders, conversations, sarvam, sender);
    ready.dialer = vi.fn(async () => ({ requestUuid: 'req-1' }));
    ready.fetchRecording = vi.fn(async () => Buffer.alloc(100));
    publicOffers = new PublicOffersController(prisma, offers);
    await seedOrg(ORG);
    await seedOrg(ORG_B);
  });

  beforeEach(async () => {
    for (const org of [ORG, ORG_B]) {
      await prisma.offerClaim.deleteMany({ where: { organizationId: org } });
      await prisma.order.deleteMany({ where: { organizationId: org } });
      await prisma.call.deleteMany({ where: { organizationId: org } });
    }
    catalog.invalidate(ORG);
    sender.sendText.mockClear();
    sender.sendNamedTemplate.mockClear();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const wa = (p: string, org = ORG) => (message: string) => engine.generate({ organizationId: org, channel: 'whatsapp', phone: p, message, customerName: 'Priya', now: NOW });
  const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
  const hhmm = (d: Date) => {
    const x = new Date(d.getTime() + 330 * 60_000);
    return `${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`;
  };

  it('customer says Hi from the link → Tanglish offer message → chicken, kg, cut, payment, time → ₹50 off order, offer used once', async () => {
    const p = phone();
    const say = wa(p);
    const hi = await say('Hi');
    expect(hi.response).toContain('Vanakkam Priya');
    expect(hi.response).toContain('₹50 offer');
    expect(hi.response).toContain('Broiler Chicken — ₹220/kg');
    expect(hi.response).not.toContain('Chicken Liver'); // not available today
    const claim = await prisma.offerClaim.findFirst({ where: { organizationId: ORG, phone: `91${p}` } });
    expect(claim).toMatchObject({ source: 'whatsapp_link', status: 'started' });

    expect((await say('rendu kilo broiler')).response).toContain('eppadi cut');
    expect((await say('curry cut')).response).toContain('Payment eppadi');
    expect((await say('gpay')).response).toContain('Eppo vandhu collect');
    const summary = await say(`${hhmm(later(3))} ku varen`);
    expect(summary.state).toBe('awaiting_confirmation');
    expect(summary.response).toContain('2 kg Broiler Chicken — Curry cut — ₹440');
    expect(summary.response).toContain('Offer: −₹50');
    expect(summary.response).toContain('*Kattavendiyadhu: ₹390*');
    expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(0);

    const placed = await say('sari');
    expect(placed.order.status).toBe('created');
    expect(placed.response).toContain(placed.order.orderNumber);
    const order = await orders.getOrder(ORG, placed.order.id);
    expect(order).toMatchObject({ subtotal: 440, discount: 50, total: 390, paymentMethod: 'upi_at_shop', paymentStatus: 'unpaid', status: 'pending', posStatus: 'not_integrated', language: 'tanglish' });
    expect(order.items.map((i: any) => [i.name, i.quantity, i.cut, i.lineTotal])).toEqual([['Broiler Chicken', 2, 'Curry cut', 440]]);
    expect(order.offer).toMatchObject({ source: 'whatsapp_link', amount: 50 });
    expect(await prisma.offerClaim.findFirst({ where: { id: claim.id } })).toMatchObject({ status: 'claimed', orderId: order.id });

    // Retry / double tap: no second order.
    const again = await say('sari');
    expect(again.order).toBeUndefined();
    expect(again.response).toContain('already confirm');

    // The link offer cannot be claimed twice: the next order has no discount.
    await say('1 kg boneless, cash, ' + hhmm(later(4)));
    const second = await say('yes');
    expect((await orders.getOrder(ORG, second.order.id)).discount).toBe(0);
    const tryAgain = await say('offer claim GR50');
    expect(tryAgain.response).toMatch(/already (use|been used)/);
  });

  it('everything in one message, a correction after the summary, then Tamil-script confirmation', async () => {
    const say = wa(phone());
    await say('Hi');
    const s1 = await say(`1.5 kg nattu kozhi biryani cut and arai kilo boneless, cash la tharen, ${hhmm(later(5))} manikku varen`);
    expect(s1.state).toBe('awaiting_confirmation');
    expect(s1.response).toContain('1.5 kg Country Chicken — Biryani cut — ₹675');
    expect(s1.response).toContain('500 g Boneless Chicken — ₹190');
    const s2 = await say('illa 2 kg nattu kozhi');
    expect(s2.state).toBe('awaiting_confirmation');
    expect(s2.response).toContain('2 kg Country Chicken — Biryani cut — ₹900');
    expect(s2.response).toContain('₹1040');
    const placed = await say('சரி');
    expect(placed.order.total).toBe(1040);
  });

  it('Tamil script: replies in Tamil, "already paid" is recorded as the customer\'s word, too-early pickup moves to the earliest ready time', async () => {
    const say = wa(phone());
    const hi = await say('வணக்கம்');
    expect(hi.response).toContain('வணக்கம் Priya');
    await say('ரெண்டு கிலோ கோழி கறி கட்');
    await say('ஏற்கனவே online-ல பே பண்ணிட்டேன்');
    const s = await say('இப்போ வரேன்');
    expect(s.response).toContain('30 நிமிஷம்');
    expect(s.state).toBe('awaiting_confirmation');
    const placed = await say('சரி');
    const order = await orders.getOrder(ORG, placed.order.id);
    expect(order.paymentMethod).toBe('paid_online');
    expect(order.paymentStatus).toBe('customer_says_paid');
    expect(new Date(order.pickupAt).getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 29 * 60_000);
    expect(order.language).toBe('tamil');
  });

  it('changing anything after the summary cancels the pending confirmation', async () => {
    const say = wa(phone());
    await say('Hi');
    await say(`2 kg broiler curry cut, cash, ${hhmm(later(3))}`);
    const changed = await say('fry cut');
    expect(changed.state).toBe('awaiting_confirmation');
    expect(changed.response).toContain('Fry cut');
    const no = await say('venam');
    expect(no.state).toBe('collecting');
    expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('website / dashboard offers: sent on WhatsApp inside 24h, recorded honestly outside it, retry-safe, then claimed in chat', async () => {
    const p = phone();
    // Not in the 24h window and no approved template: nothing is sent, the claim says why.
    const r1 = await offers.createAndSend({ organizationId: ORG, phone: p, name: 'Kumar', source: 'website', websiteOrderRef: `WEB-${p}` });
    expect(r1.claim.status).toBe('pending_send');
    expect(r1.claim.sendError).toContain('template');
    expect(sender.sendText).not.toHaveBeenCalled();
    const dup = await offers.createAndSend({ organizationId: ORG, phone: p, source: 'website', websiteOrderRef: `WEB-${p}` });
    expect(dup.duplicate).toBe(true);
    expect(dup.claim.id).toBe(r1.claim.id);

    // With an approved template it is sent.
    await prisma.offerCampaign.updateMany({ where: { organizationId: ORG }, data: { templateName: 'gr_offer_v1' } });
    const sent = await offers.send(ORG, r1.claim.id);
    expect(sent.status).toBe('sent');
    expect(sender.sendNamedTemplate).toHaveBeenCalledWith(`91${p}`, 'gr_offer_v1', ['Kumar']);
    await prisma.offerCampaign.updateMany({ where: { organizationId: ORG }, data: { templateName: null } });

    // The customer replies: the website offer is used (not a new link offer).
    const say = engine.generate.bind(engine);
    const t = (message: string) => say({ organizationId: ORG, channel: 'whatsapp', phone: p, message, now: NOW });
    expect((await t('Hi')).response).toContain('₹50 offer');
    await t(`1 kg boneless, cash, ${hhmm(later(2))}`);
    const placed = await t('yes');
    const order = await orders.getOrder(ORG, placed.order.id);
    expect(order.offer).toMatchObject({ source: 'website', websiteOrderRef: `WEB-${p}` });
    expect(order.total).toBe(330);

    // Inside the 24h window the offer message goes as normal text.
    const p2 = phone();
    const c2 = await prisma.customer.create({ data: { organizationId: ORG, phone: `91${p2}`, lastInboundAt: new Date() } });
    const r2 = await offers.createAndSend({ organizationId: ORG, phone: p2, source: 'dashboard' });
    expect(r2.claim.status).toBe('sent');
    expect(sender.sendText).toHaveBeenCalledWith(`91${p2}`, expect.stringContaining('₹50 offer'));
    expect(c2).toBeTruthy();
  });

  it('website API: tenant from the key, bad key rejected', async () => {
    const key = await offers.rotateWebsiteKey(ORG);
    await expect(publicOffers.create('grk_wrong_key_wrong_key_wrong', { phone: '9876543210' })).rejects.toThrow('Invalid API key');
    const res = await publicOffers.create(key, { phone: phone(), name: 'Anu', websiteOrderId: `W-${Date.now()}` });
    expect(res).toMatchObject({ status: 'pending_send', duplicate: false, amount: 50 });
    const claim = await prisma.offerClaim.findUnique({ where: { id: res.offerId } });
    expect(claim.organizationId).toBe(ORG);
  });

  it('one offer discounts at most one order, even with concurrent confirmations', async () => {
    const p = phone();
    const customer = await prisma.customer.create({ data: { organizationId: ORG, phone: `91${p}` } });
    const campaign = await prisma.offerCampaign.findFirst({ where: { organizationId: ORG } });
    const claim = await prisma.offerClaim.create({ data: { organizationId: ORG, campaignId: campaign.id, customerId: customer.id, phone: `91${p}`, source: 'dashboard', status: 'started', amount: 50, expiresAt: later(48) } });
    const base = { organizationId: ORG, customerId: customer.id, channel: 'whatsapp', lines: [{ itemId: `${ORG}_boneless`, quantity: 1 }], outletId: `${ORG}_shop`, pickupAt: later(2), paymentMethod: 'cash_at_shop', claimId: claim.id, expectedTotal: 330, now: NOW };
    const same = await Promise.all([orders.createOrder({ ...base, idempotencyKey: 'k1' }), orders.createOrder({ ...base, idempotencyKey: 'k1' })]);
    expect(new Set(same.map((r: any) => r.order?.id)).size).toBe(1);
    const other = await orders.createOrder({ ...base, idempotencyKey: 'k2' });
    expect(other.status).toBe('rejected'); // the offer is used; ₹330 would be the wrong total now
    expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('server-side validation: cut required, quantity steps/min, unavailable product, shop prep time, other tenant\'s product', async () => {
    const q = (lines: any[], pickupAt = later(2)) => orders.quote({ organizationId: ORG, lines, outletId: `${ORG}_shop`, pickupAt, now: NOW });
    expect((await q([{ itemId: `${ORG}_broiler`, quantity: 2 }])).problems.join()).toContain('Which cut');
    expect((await q([{ itemId: `${ORG}_broiler`, quantity: 1.3, cut: 'Curry cut' }])).problems.join()).toContain('steps of');
    expect((await q([{ itemId: `${ORG}_broiler`, quantity: 0.25, cut: 'Curry cut' }])).problems.join()).toContain('Minimum');
    expect((await q([{ itemId: `${ORG}_broiler`, quantity: 2, cut: 'Boneless' }])).problems.join()).toContain('not available as');
    expect((await q([{ itemId: `${ORG}_liver`, quantity: 1 }])).problems.join()).toContain('not available today');
    expect((await q([{ itemId: `${ORG}_boneless`, quantity: 1 }], later(0.1))).problems.join()).toContain('30 minutes');
    expect((await q([{ itemId: `${ORG_B}_boneless`, quantity: 1 }])).ok).toBe(false);
    const ok = await q([{ itemId: `${ORG}_broiler`, quantity: 1.5, cut: 'Fry cut' }]);
    expect(ok).toMatchObject({ ok: true, subtotal: 330, total: 330 });
  });

  it('staff mark Ready → Tamil call → customer says they are coming → noted on the order', async () => {
    const say = wa(phone());
    await say('Hi');
    await say(`rendu kilo broiler curry cut, cash la tharen, ${hhmm(later(3))} manikku varen`);
    const { order: placed } = await say('sari');
    expect((await orders.getOrder(ORG, placed.id)).language).toBe('tanglish');
    const staff = { sub: 'staff-1', role: 'admin' };
    for (const s of ['confirmed', 'preparing']) await orders.updateStatus(ORG, placed.id, { status: s }, staff);
    const { changedTo } = await orders.updateStatus(ORG, placed.id, { status: 'ready' }, staff);
    expect(changedTo).toBe('ready');
    await ready.notify(ORG, placed.id);
    expect(ready.dialer).toHaveBeenCalledWith('914400000000', expect.any(String), expect.stringContaining('/voice/ready/answer?callId='), expect.stringContaining('/voice/ready/hangup?callId='));
    let order = await orders.getOrder(ORG, placed.id);
    expect(order.readyNotice).toBe('calling');

    const xml = await ready.answer(order.readyCallId, { CallUUID: 'cu-1' });
    expect(xml).toContain('<Play>https://example.test/voice/audio/x.wav</Play>');
    expect(xml).toContain('/voice/ready/turn?callId=');
    const spoken = sarvam.textToSpeechUrl.mock.calls.at(-1)[0];
    expect(spoken).toContain('நீங்க சொன்ன மாதிரி 2 கிலோ Broiler Chicken Curry cut எல்லாம் ready-ஆ இருக்கு');

    sarvam.speechToText.mockResolvedValueOnce({ transcript: 'சரி, பத்து நிமிஷத்துல வரேன்' });
    const turn = await ready.turn(order.readyCallId, { RecordUrl: 'https://plivo.test/rec.wav' });
    expect(turn).toContain('<Hangup/>');
    await ready.hangup(order.readyCallId, { Duration: '24', HangupCause: 'NORMAL_HANGUP' });
    order = await orders.getOrder(ORG, placed.id);
    expect(order.readyNotice).toBe('answered');
    expect(order.readyNoticeNote).toContain('பத்து நிமிஷத்துல வரேன்');
    expect(order.readyNoticeNote).toContain('(coming)');
    const call = await prisma.call.findUnique({ where: { id: order.readyCallId } });
    expect(call).toMatchObject({ status: 'completed', durationSec: 24 });
    // The call is readable in the inbox.
    const voiceConv = await prisma.conversation.findFirst({ where: { organizationId: ORG, channel: 'voice', customerId: order.customerId }, include: { Message: true } });
    expect(voiceConv.Message.map((m: any) => m.role)).toEqual(['assistant', 'user', 'assistant']);

    // Customer collects.
    const done = await orders.updateStatus(ORG, placed.id, { status: 'completed' }, staff);
    expect(done.order.status).toBe('completed');
  });

  it('unanswered ready call → WhatsApp ready message; no calling setup → straight to WhatsApp', async () => {
    const p = phone();
    const say = wa(p);
    await say('Hi');
    await say(`1 kg boneless, upi, ${hhmm(later(2))}`);
    const { order: placed } = await say('sari');
    // The WhatsApp webhook records the customer's last message (24h window); the engine is called after it.
    await prisma.customer.updateMany({ where: { organizationId: ORG, phone: `91${p}` }, data: { lastInboundAt: new Date() } });
    const staff = { sub: 's', role: 'admin' };
    await orders.updateStatus(ORG, placed.id, { status: 'confirmed' }, staff);
    await orders.updateStatus(ORG, placed.id, { status: 'ready' }, staff);
    await ready.notify(ORG, placed.id);
    let order = await orders.getOrder(ORG, placed.id);
    await ready.hangup(order.readyCallId, { HangupCause: 'NO_ANSWER' });
    order = await orders.getOrder(ORG, placed.id);
    expect(order.readyNotice).toBe('whatsapp_sent');
    expect(sender.sendText).toHaveBeenCalledWith(`91${p}`, expect.stringContaining(placed.orderNumber));
    expect((await prisma.call.findUnique({ where: { id: order.readyCallId } })).status).toBe('no_answer');

    // Calling not configured (e.g. Sarvam key missing): WhatsApp at once, reason recorded.
    sarvam.enabled = false;
    sender.sendText.mockClear();
    await ready.notify(ORG, placed.id, { force: true });
    order = await orders.getOrder(ORG, placed.id);
    expect(order.readyNoticeNote).toContain('SARVAM_API_KEY');
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    sarvam.enabled = true;
  });

  it('cancelling an order gives the offer back; viewers cannot change orders; tenants are isolated', async () => {
    const say = wa(phone());
    await say('Hi');
    await say(`1 kg boneless, cash, ${hhmm(later(2))}`);
    const { order: placed } = await say('sari');
    await expect(orders.updateStatus(ORG, placed.id, { status: 'confirmed' }, { sub: 'v', role: 'viewer' })).rejects.toThrow('only view');
    await expect(orders.updateStatus(ORG, placed.id, { status: 'completed' }, { sub: 's', role: 'admin' })).rejects.toThrow('cannot be moved');
    await expect(orders.getOrder(ORG_B, placed.id)).rejects.toThrow('Order not found');
    await expect(orders.updateStatus(ORG_B, placed.id, { status: 'cancelled' }, { sub: 's', role: 'admin' })).rejects.toThrow('Order not found');
    await orders.updateStatus(ORG, placed.id, { status: 'cancelled' }, { sub: 's', role: 'admin' });
    const claim = await prisma.offerClaim.findFirst({ where: { organizationId: ORG, customer: { id: (await orders.getOrder(ORG, placed.id)).customerId } } });
    expect(claim).toMatchObject({ status: 'started', orderId: null });
  });
});
