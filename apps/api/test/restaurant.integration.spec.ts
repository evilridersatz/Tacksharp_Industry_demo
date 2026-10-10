/**
 * Restaurant (GR Chicken) ordering, DB-backed. Real MySQL test database; the language model is a fake.
 *
 *   TEST_DB_NAME=tacksharp_test npm test -w apps/api
 * Skipped automatically when TEST_DB_NAME is not set (never runs against your real DB).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
}

const ORG_A = 'org_test_restaurant_a';
const ORG_B = 'org_test_restaurant_b';
let n = 0;
const sid = () => `test-session-${Date.now()}-${n++}`.padEnd(20, 'x');
const phone = () => `98${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;

describe.skipIf(!enabled)('Restaurant ordering (integration)', () => {
  let prisma: any, engine: any, orders: any, catalog: any, store: any, llmFake: any, tenancy: any, ai: any;

  async function seedOrg(id: string, name: string, opts: { outlets: number }) {
    await prisma.organization.upsert({ where: { id }, create: { id, name, vertical: 'restaurant' }, update: { vertical: 'restaurant', name } });
    const cat = await prisma.menuCategory.upsert({
      where: { organizationId_name: { organizationId: id, name: 'Mains' } },
      create: { id: `${id}_mains`, organizationId: id, name: 'Mains' },
      update: {},
    });
    const items = [
      { key: 'biryani', name: 'Chicken Biryani', price: 220, aliases: 'biryani' },
      { key: 'soda', name: 'Lime Soda', price: 50, aliases: 'soda' },
      { key: 'c65', name: 'Chicken 65', price: 180, aliases: '65' },
      { key: 'sold_out', name: 'Pepper Chicken', price: 200, aliases: 'pepper', available: false },
    ];
    for (const it of items) {
      const rid = `${id}_${it.key}`;
      const data = { organizationId: id, categoryId: cat.id, name: it.name, price: it.price, aliases: it.aliases, available: it.available ?? true, isDemo: false };
      await prisma.menuItem.upsert({ where: { id: rid }, create: { id: rid, ...data }, update: data });
    }
    for (let i = 0; i < opts.outlets; i++) {
      const rid = `${id}_outlet_${i}`;
      const data = {
        organizationId: id,
        name: i === 0 ? `${name} Velachery` : `${name} Anna Nagar`,
        area: i === 0 ? 'Velachery' : 'Anna Nagar',
        address: `Test address ${i}`,
        serviceAreas: i === 0 ? ['velachery', 'guindy'] : ['anna nagar'],
        opensAt: '00:00',
        closesAt: '00:00', // open all day for tests
        acceptsPickup: true,
        acceptsDelivery: true,
        deliveryFee: 40,
        minOrderValue: 100,
        active: true,
        sortOrder: i,
      };
      await prisma.outlet.upsert({ where: { id: rid }, create: { id: rid, ...data }, update: data });
    }
  }

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { CatalogService } = await import('../src/restaurant/catalog.service.js');
    const { OrdersService } = await import('../src/restaurant/orders.service.js');
    const { OrderSessionStore } = await import('../src/restaurant/order-session.store.js');
    const { OrderingEngine } = await import('../src/restaurant/ordering-engine.service.js');
    const { TenancyService } = await import('../src/tenancy/tenancy.service.js');
    const { AiService } = await import('../src/ai/ai.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    const conversations = new ConversationsService(prisma);
    catalog = new CatalogService(prisma);
    orders = new OrdersService(prisma);
    store = new OrderSessionStore();
    store.useRedis(null);
    llmFake = { run: vi.fn(async () => ({ text: '', failed: true, aborted: false, usage: {} })) };
    engine = new OrderingEngine(prisma, conversations, catalog, orders, store, llmFake);
    tenancy = new TenancyService(prisma);
    const realEstateEngine = { generate: vi.fn(async () => ({ response: 'real-estate engine' })) };
    ai = new AiService(realEstateEngine as any, tenancy, engine);
    await seedOrg(ORG_A, 'Test Chicken', { outlets: 2 });
    await seedOrg(ORG_B, 'Other Chicken', { outlets: 1 });
  });

  beforeEach(async () => {
    for (const org of [ORG_A, ORG_B]) await prisma.order.deleteMany({ where: { organizationId: org } });
    catalog.invalidate(ORG_A);
    catalog.invalidate(ORG_B);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const chat = (organizationId: string, sessionId: string) => async (message: string) =>
    engine.generate({ organizationId, channel: 'web', sessionId, message });

  async function webOrderToConfirmation(say: (m: string) => Promise<any>) {
    await say('2 chicken biryani and 1 lime soda');
    await say('checkout');
    await say('1'); // Velachery
    await say('delivery');
    await say('guindy');
    await say('No 5, 2nd street, near the park, Guindy');
    return say(`Priya ${phone()}`);
  }

  it('web chat: menu → cart → outlet → delivery → contact → YES creates one correctly priced order', async () => {
    const say = chat(ORG_A, sid());
    const menu = await say('menu');
    expect(menu.response).toContain('Chicken Biryani — ₹220');
    expect(menu.response).not.toContain('Pepper Chicken'); // unavailable items are not offered

    const summary = await webOrderToConfirmation(say);
    expect(summary.state).toBe('awaiting_confirmation');
    expect(summary.response).toContain('*Total: ₹530*'); // 2×220 + 50 + 40 delivery
    expect(await prisma.order.count({ where: { organizationId: ORG_A } })).toBe(0); // nothing before YES

    const placed = await say('yes');
    expect(placed.order?.status).toBe('created');
    expect(placed.response).toContain(placed.order.orderNumber);
    expect(placed.response).toMatch(/waiting for .* to confirm/);

    const order = await orders.getOrder(ORG_A, placed.order.id);
    expect(order.total).toBe(530);
    expect(order.subtotal).toBe(490);
    expect(order.deliveryFee).toBe(40);
    expect(order.status).toBe('pending');
    expect(order.posStatus).toBe('not_integrated');
    expect(order.paymentStatus).toBe('unpaid');
    expect(order.paymentMethod).toBe('cash_on_delivery');
    expect(order.items.map((i: any) => [i.name, i.quantity, i.lineTotal])).toEqual([['Chicken Biryani', 2, 440], ['Lime Soda', 1, 50]]);
    expect(order.events[0]).toMatchObject({ type: 'created', actor: 'ai', toStatus: 'pending' });

    // A second YES (double tap / retried request) never creates another order.
    const again = await say('yes');
    expect(again.order).toBeUndefined();
    expect(again.response).toContain('already placed');
    expect(await prisma.order.count({ where: { organizationId: ORG_A } })).toBe(1);

    // The conversation and both sides of it are stored and linked to the customer.
    const conv = await prisma.conversation.findFirst({ where: { id: placed.conversationId }, include: { Message: true } });
    expect(conv.customerId).toBeTruthy();
    expect(conv.Message.filter((m: any) => m.role === 'user').length).toBeGreaterThanOrEqual(8);

    const status = await say('order status');
    expect(status.response).toContain(placed.order.orderNumber);
    expect(status.response).toContain('waiting for the outlet');
  });

  it('createOrder is idempotent for the same confirmation, even when called concurrently', async () => {
    const customer = await prisma.customer.create({ data: { organizationId: ORG_A, phone: `91${phone()}`, name: 'Idem' } });
    const input = {
      organizationId: ORG_A,
      idempotencyKey: `idem-${Date.now()}`,
      customerId: customer.id,
      channel: 'web',
      lines: [{ itemId: `${ORG_A}_biryani`, quantity: 1 }],
      outletId: `${ORG_A}_outlet_0`,
      fulfilment: 'pickup' as const,
      expectedTotal: 220,
    };
    const results = await Promise.all([orders.createOrder(input), orders.createOrder(input), orders.createOrder(input)]);
    const ids = new Set(results.map((r: any) => r.order.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r: any) => r.status === 'created').length).toBe(1);
    expect(await prisma.order.count({ where: { organizationId: ORG_A, idempotencyKey: input.idempotencyKey } })).toBe(1);
  });

  it('server-side validation: prices come from the DB, unavailable items, minimum order, service area and a changed price are rejected', async () => {
    const outletId = `${ORG_A}_outlet_0`;
    const unavailable = await orders.quote({ organizationId: ORG_A, lines: [{ itemId: `${ORG_A}_sold_out`, quantity: 1 }], outletId, fulfilment: 'pickup' });
    expect(unavailable.ok).toBe(false);
    expect(unavailable.problems.join(' ')).toContain('not available');

    const tooSmall = await orders.quote({ organizationId: ORG_A, lines: [{ itemId: `${ORG_A}_soda`, quantity: 1 }], outletId, fulfilment: 'pickup' });
    expect(tooSmall.problems.join(' ')).toContain('Minimum order');

    const farAway = await orders.quote({ organizationId: ORG_A, lines: [{ itemId: `${ORG_A}_biryani`, quantity: 1 }], outletId, fulfilment: 'delivery', deliveryArea: 'tambaram' });
    expect(farAway.problems.join(' ')).toContain('does not deliver to tambaram');

    const tooMany = await orders.quote({ organizationId: ORG_A, lines: [{ itemId: `${ORG_A}_biryani`, quantity: 21 }], outletId, fulfilment: 'pickup' });
    expect(tooMany.ok).toBe(false);

    const otherTenantsItem = await orders.quote({ organizationId: ORG_A, lines: [{ itemId: `${ORG_B}_biryani`, quantity: 1 }], outletId, fulfilment: 'pickup' });
    expect(otherTenantsItem.ok).toBe(false);

    const customer = await prisma.customer.create({ data: { organizationId: ORG_A, phone: `91${phone()}` } });
    const stale = await orders.createOrder({
      organizationId: ORG_A, idempotencyKey: `stale-${Date.now()}`, customerId: customer.id, channel: 'web',
      lines: [{ itemId: `${ORG_A}_biryani`, quantity: 1 }], outletId, fulfilment: 'pickup', expectedTotal: 199,
    });
    expect(stale.status).toBe('rejected');
    expect(await prisma.order.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('chat never adds a dish we do not sell, or items only asked about', async () => {
    const say = chat(ORG_A, sid());
    const q = await say('do you have mutton biryani?');
    expect(q.response).toContain("don't have mutton biryani");
    expect(q.cart).toEqual([]);
    const price = await say('how much is chicken 65?');
    expect(price.response).toContain('₹180');
    expect(price.cart).toEqual([]);
    const sold = await say('2 pepper chicken');
    expect(sold.response).toContain('not available');
    expect(sold.cart).toEqual([]);
    const add = await say('can you add 2 biryani?');
    expect(add.cart).toEqual([{ name: 'Chicken Biryani', quantity: 2, unitPrice: 220, lineTotal: 440 }]);
  });

  it('changing the cart after the summary cancels the pending confirmation', async () => {
    const say = chat(ORG_A, sid());
    await webOrderToConfirmation(say);
    const changed = await say('add 1 chicken 65');
    expect(changed.state).toBe('browsing');
    const yes = await say('yes');
    expect(yes.order).toBeUndefined(); // "yes" now only restarts checkout with the new total
    expect(yes.state).toBe('awaiting_confirmation');
    expect(yes.response).toContain('*Total: ₹710*');
    expect(await prisma.order.count({ where: { organizationId: ORG_A } })).toBe(0);
    const no = await say('no');
    expect(no.state).toBe('browsing');
    expect(await prisma.order.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('WhatsApp: the customer is known from the number; single-outlet tenant goes straight to pickup/delivery', async () => {
    const wa = phone();
    const say = (message: string) => ai.generateResponse({ organizationId: ORG_B, channel: 'whatsapp', phone: wa, message, customerName: 'Arun' });
    await say('1 chicken biryani');
    const f = await say('checkout');
    expect(f.response).toContain('pickup* or *delivery');
    const summary = await say('pickup');
    expect(summary.state).toBe('awaiting_confirmation');
    expect(summary.response).toContain('*Total: ₹220*');
    expect(summary.response).toContain('Pay at the outlet');
    const placed = await say('yes');
    expect(placed.order?.status).toBe('created');
    const order = await orders.getOrder(ORG_B, placed.order.id);
    expect(order.channel).toBe('whatsapp');
    expect(order.customerPhone).toBe(`91${wa}`);
    expect(order.paymentMethod).toBe('pay_at_outlet');
  });

  it('tenant isolation: one restaurant cannot read or change another restaurant\'s orders', async () => {
    const say = chat(ORG_A, sid());
    await webOrderToConfirmation(say);
    const placed = await say('yes');
    await expect(orders.getOrder(ORG_B, placed.order.id)).rejects.toThrow('Order not found');
    await expect(orders.updateStatus(ORG_B, placed.order.id, { status: 'confirmed' }, { sub: 'u', role: 'admin' })).rejects.toThrow('Order not found');
    expect((await orders.list(ORG_B, {})).map((o: any) => o.id)).not.toContain(placed.order.id);
    expect(await orders.findByNumber(ORG_B, placed.order.orderNumber)).toBeNull();
  });

  it('staff status updates follow the allowed transitions and are audited; viewers cannot change orders', async () => {
    const say = chat(ORG_A, sid());
    await webOrderToConfirmation(say);
    const { order } = await say('yes');
    const staff = { sub: 'staff-1', role: 'admin' };
    await expect(orders.updateStatus(ORG_A, order.id, { status: 'completed' }, staff)).rejects.toThrow('cannot be moved');
    await expect(orders.updateStatus(ORG_A, order.id, { status: 'confirmed' }, { sub: 'v', role: 'viewer' })).rejects.toThrow('only view');
    for (const s of ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed']) await orders.updateStatus(ORG_A, order.id, { status: s }, staff);
    const paid = await orders.updateStatus(ORG_A, order.id, { paymentStatus: 'paid', note: 'cash collected' }, staff);
    expect(paid.status).toBe('completed');
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.events.map((e: any) => e.toStatus ?? e.type)).toEqual(['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'payment_changed']);
    expect(paid.events.slice(1).every((e: any) => e.actor === 'user:staff-1')).toBe(true);
    await expect(orders.updateStatus(ORG_A, order.id, { status: 'cancelled' }, staff)).rejects.toThrow('cannot be moved');
  });

  it('routing: restaurant tenants get the ordering engine, phone calls are declined politely, other tenants are untouched', async () => {
    const voice = await ai.generateResponse({ organizationId: ORG_A, channel: 'voice', phone: phone(), message: 'hello' });
    expect(voice.response).toContain('phone ordering is not available');
    expect(voice.actions.endCall).toBe(true);
    await prisma.organization.upsert({ where: { id: 'org_test_real_estate_x' }, create: { id: 'org_test_real_estate_x', name: 'Realty' }, update: {} });
    const re = await ai.generateResponse({ organizationId: 'org_test_real_estate_x', channel: 'whatsapp', phone: phone(), message: 'hi' });
    expect(re.response).toBe('real-estate engine');
  });

  it('without a configured model, free-form questions get a safe help reply (no invented answers)', async () => {
    const say = chat(ORG_A, sid());
    const r = await say('is your chicken halal and how spicy is it');
    expect(r.path).toBe('rules');
    expect(r.response).toContain('talk to staff');
    expect(llmFake.run).not.toHaveBeenCalled();
  });
});
