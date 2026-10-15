/**
 * GR Chicken inventory: database stock in answers (WhatsApp and phone), no repeated generic questions, order-time
 * reservation without overselling or double deduction, release on cancel, demo stock seed, low-stock alerts.
 * Real MySQL TEST database; WhatsApp / Plivo / SNS are fakes.
 *
 *   TEST_DB_NAME=tacksharp_test npm test -w apps/api
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.GR_ORGANIZATION_ID = 'org_test_inv_demo';
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.STOCK_ALERT_SNS_TOPIC_ARN;
}

const ORG = 'org_test_inv';
const OTHER = 'org_test_inv_other';
const DEMO = 'org_test_inv_demo';
let n = 0;
const phone = () => `96${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;
const NOW = new Date();

describe.skipIf(!enabled)('GR Chicken inventory (integration)', () => {
  let prisma: any, catalog: any, orders: any, engine: any, inventory: any, alerts: any, conversations: any;
  const published: Array<{ subject: string; message: string }> = [];

  async function seedOrg(id: string, stock: Record<string, { qty: number | null; low?: number; demo?: boolean; available?: boolean }>) {
    await prisma.organization.upsert({ where: { id }, create: { id, name: 'GR Chicken', vertical: 'restaurant' }, update: { vertical: 'restaurant' } });
    const cat = await prisma.menuCategory.upsert({ where: { organizationId_name: { organizationId: id, name: 'Chicken' } }, create: { id: `${id}_cat`, organizationId: id, name: 'Chicken' }, update: {} });
    const products = [
      { key: 'broiler', name: 'Broiler Chicken', price: 220, aliases: 'broiler, chicken, kozhi, கோழி', cuts: ['Curry cut', 'Whole'], unit: 'kg' },
      { key: 'country', name: 'Country Chicken', price: 450, aliases: 'country, nattu kozhi', cuts: ['Curry cut', 'Whole'], unit: 'kg' },
      { key: 'liver', name: 'Chicken Liver', price: 160, aliases: 'liver', cuts: [], unit: 'kg' },
      { key: 'eggs', name: 'Country Eggs', price: 12, aliases: 'eggs, egg, muttai', cuts: [], unit: 'piece' },
    ];
    for (const p of products) {
      const st = stock[p.key] ?? { qty: null };
      const data = {
        organizationId: id, categoryId: cat.id, name: p.name, price: p.price, aliases: p.aliases, cutOptions: p.cuts, unit: p.unit,
        minQty: p.unit === 'piece' ? 1 : 0.5, maxQty: p.unit === 'piece' ? 60 : 10, qtyStep: p.unit === 'piece' ? 1 : 0.25,
        available: st.available ?? true, isDemo: true,
        stockQty: st.qty, lowStockThreshold: st.low ?? null, stockIsDemo: st.demo ?? true, stockAlertLevel: null,
      };
      await prisma.menuItem.upsert({ where: { id: `${id}_${p.key}` }, create: { id: `${id}_${p.key}`, ...data }, update: data });
    }
    const shop = { organizationId: id, name: 'GR Chicken Shop', address: 'Test address', opensAt: '00:00', closesAt: '00:00', prepMinutes: 30, minOrderValue: 0, acceptOutsideHours: false, active: true };
    await prisma.outlet.upsert({ where: { id: `${id}_shop` }, create: { id: `${id}_shop`, ...shop }, update: shop });
    catalog?.invalidate(id);
  }
  const standardStock = { broiler: { qty: 18, low: 5 }, country: { qty: 8, low: 3 }, liver: { qty: 0, low: 1 }, eggs: { qty: 120, low: 24 } };

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { CatalogService } = await import('../src/restaurant/catalog.service.js');
    const { OrdersService } = await import('../src/restaurant/orders.service.js');
    const { OffersService } = await import('../src/restaurant/offers.service.js');
    const { OrderSessionStore } = await import('../src/restaurant/order-session.store.js');
    const { OrderingEngine } = await import('../src/restaurant/ordering-engine.service.js');
    const { FeedbackService } = await import('../src/restaurant/feedback.service.js');
    const { InventoryService } = await import('../src/restaurant/inventory.service.js');
    const { StockAlertService } = await import('../src/restaurant/stock-alerts.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    conversations = new ConversationsService(prisma);
    catalog = new CatalogService(prisma);
    alerts = new StockAlertService(prisma);
    orders = new OrdersService(prisma, alerts);
    inventory = new InventoryService(prisma, catalog, alerts);
    const store = new OrderSessionStore();
    store.useRedis(null);
    const offers = new OffersService(prisma, conversations, { sendText: vi.fn(), sendNamedTemplate: vi.fn() } as any, catalog);
    engine = new OrderingEngine(prisma, conversations, catalog, orders, offers, new FeedbackService(prisma), { onOrderCreated: vi.fn(async () => undefined) } as any, store, { run: vi.fn() } as any);
    await seedOrg(OTHER, standardStock);
  });

  beforeEach(async () => {
    for (const org of [ORG, OTHER]) {
      await prisma.inventoryMovement.deleteMany({ where: { organizationId: org } });
      await prisma.order.deleteMany({ where: { organizationId: org } });
    }
    await seedOrg(ORG, standardStock);
    published.length = 0;
    alerts.config = { topicArn: 'arn:aws:sns:ap-south-1:000000000000:test-topic', region: 'ap-south-1', enabled: true };
    alerts.publisher = { publish: vi.fn(async (m: { subject: string; message: string }) => (published.push(m), { messageId: `m${published.length}` })) };
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const wa = (p: string, org = ORG) => (message: string) => engine.generate({ organizationId: org, channel: 'whatsapp', phone: p, message, customerName: 'Priya', now: NOW });
  async function call(p: string, org = ORG) {
    await engine.openVoiceSession({ organizationId: org, phone: p, openingText: 'opening', callId: `c-${p}` });
    return (message: string) => engine.generate({ organizationId: org, channel: 'voice', phone: p, message, now: NOW });
  }
  const stockOf = async (key: string, org = ORG) => Number((await prisma.menuItem.findUnique({ where: { id: `${org}_${key}` } })).stockQty);

  // ------------------------------------------------------------------------------------------ answers
  describe('stock questions are answered from the database', () => {
    it('1. "Which chicken is available?" lists sellable products with price and demo stock, and orders nothing', async () => {
      const say = wa(phone());
      await say('Hi');
      const r = await say('Which chicken is available?');
      expect(r.response).toContain('Broiler Chicken — ₹220/kg (18 kg in demo stock)');
      expect(r.response).toContain('Country Chicken — ₹450/kg (8 kg in demo stock)');
      expect(r.response).not.toContain('Chicken Liver'); // 0 kg: not offered
      expect(r.response).toContain('Which would you like?');
      expect(r.draft.lines).toEqual([]);
    });

    it('2. "How much stock is available?" gives the current quantities with units, never a generic question', async () => {
      const say = wa(phone());
      await say('Hi');
      const r = await say('How much stock is available?');
      expect(r.response).toContain('Broiler Chicken — 18 kg');
      expect(r.response).toContain('Country Eggs — 120 pcs');
      expect(r.response).toContain('Out of stock: Chicken Liver');
      expect(r.response).toContain('Demo stock');
      expect(r.response).not.toMatch(/Which chicken|Enna chicken venum|How many kg/i);
      // The number follows the database, not a fixed example.
      await prisma.menuItem.update({ where: { id: `${ORG}_broiler` }, data: { stockQty: 11.5 } });
      catalog.invalidate(ORG);
      expect((await say('stock evlo irukku?')).response).toContain('Broiler Chicken — 11.5 kg');
    });

    it('3. an out-of-stock product: said plainly, with only alternatives that have stock', async () => {
      await prisma.menuItem.update({ where: { id: `${ORG}_country` }, data: { stockQty: 0 } });
      catalog.invalidate(ORG);
      const say = wa(phone());
      await say('Hi');
      const r = await say('Do you have chicken liver?');
      expect(r.response).toContain('Chicken Liver is currently out of stock');
      expect(r.response).toContain('Broiler Chicken, Country Eggs are available');
      expect(r.response).not.toContain('Country Chicken'); // no stock: never suggested
    });

    it('4. nothing suitable in stock: says so and offers staff (no invented availability)', async () => {
      await prisma.menuItem.updateMany({ where: { organizationId: ORG }, data: { stockQty: 0 } });
      catalog.invalidate(ORG);
      const say = wa(phone());
      await say('Hi');
      const list = await say('Which chicken is available?');
      expect(list.response).toMatch(/mudinjiduchu|sold out/);
      expect(list.response).toMatch(/staff/);
      const liver = await say('Do you have chicken liver?');
      expect(liver.response).toContain('out of stock');
      expect(liver.response).toContain('Nothing else is in stock right now');
      // The order rules agree: an order for it is refused.
      expect((await say('2 kg broiler curry cut, cash, 2 mani nerathula varen')).response).toMatch(/inniku illa|not available/);
    });
  });

  // ------------------------------------------------------------------------------------------ conversation
  describe('no repeated generic questions; details carry across turns', () => {
    it('5. the same question twice gets the same answer, not a generic prompt; repeated unclear replies escalate to staff', async () => {
      const say = wa(phone());
      await say('Hi');
      const a = await say('How much stock is available?');
      const b = await say('How much stock is available?');
      expect(b.response).toBe(a.response);
      const c = await call(phone());
      const r1 = await c('hmm');
      const r2 = await c('hmm');
      const r3 = await c('hmm');
      expect(r2.response).not.toBe(r1.response);
      expect(r2.response).toMatch(/didn't get that|புரியல/);
      expect(r2.response).toContain('Broiler Chicken'); // shows the actual choices
      expect(r3.response).toMatch(/staff/);
      expect(r3.response).not.toBe(r1.response);
    });

    it('6. product, quantity and cut persist: asked-about product + "2 kg" + "curry cut" build one line', async () => {
      const say = wa(phone());
      await say('Hi');
      const q = await say('country chicken irukka?');
      expect(q.response).toContain('Country Chicken irukku ✅ — ₹450/kg, 8 kg (demo stock)');
      expect(q.response).toMatch(/Country Chicken ethana kg venum/);
      const kg = await say('2 kg');
      expect(kg.draft.lines).toEqual([expect.objectContaining({ name: 'Country Chicken', quantity: 2 })]);
      expect(kg.response).toMatch(/Country Chicken eppadi cut/);
      const cut = await say('curry cut');
      expect(cut.draft.lines).toEqual([expect.objectContaining({ name: 'Country Chicken', quantity: 2, cut: 'Curry cut' })]);
      expect(cut.response).not.toMatch(/Enna chicken venum|Which chicken/);
      // A question in the middle does not lose or change the draft.
      const mid = await say('How much stock is available?');
      expect(mid.draft.lines).toEqual([expect.objectContaining({ name: 'Country Chicken', quantity: 2, cut: 'Curry cut' })]);
      expect(mid.response).toMatch(/Payment eppadi|How will you pay/); // the next genuinely missing detail (in the language just used)
    });

    it('7. WhatsApp and phone apply the same rules to the same question', async () => {
      const p = phone();
      const w = wa(p);
      await w('Hi');
      const onChat = await w('How much stock is available?');
      const onCall = await (await call(phone()))('How much stock is available?');
      for (const fact of ['Broiler Chicken', '18 kg', 'Chicken Liver']) {
        expect(onChat.response).toContain(fact);
        expect(onCall.response).toContain(fact);
      }
      expect(onCall.response).not.toMatch(/[*•₹\n]/); // spoken form of the same answer
      const tamilCall = await (await call(phone()))('கண்ட்ரி சிக்கன் இருக்கா?');
      expect(tamilCall.response).toContain('Country Chicken இருக்கு');
      expect(tamilCall.response).toContain('8 kg');
    });
  });

  // ------------------------------------------------------------------------------------------ reservation
  describe('stock is taken when an order is confirmed, never twice, never below zero', () => {
    async function confirmedOrder(p: string, msg: string) {
      const say = wa(p);
      await say('Hi');
      const sum = await say(msg);
      expect(sum.state).toBe('awaiting_confirmation');
      return say('sari');
    }

    it('8. mentioning a product or building a draft does not touch stock; confirming takes it once', async () => {
      const say = wa(phone());
      await say('Hi');
      await say('2 kg broiler curry cut');
      expect(await stockOf('broiler')).toBe(18);
      const placed = await confirmedOrder(phone(), '2 kg broiler curry cut, cash, 2 mani nerathula varen');
      expect(placed.order.status).toBe('created');
      expect(await stockOf('broiler')).toBe(16);
      expect(await prisma.inventoryMovement.count({ where: { organizationId: ORG, orderId: placed.order.id, reason: 'order_reserved' } })).toBe(1);
    });

    it('9a. a repeated confirmation / webhook (same idempotency key) does not take stock again', async () => {
      const c = await conversations.getOrCreateCustomerByPhone(ORG, phone(), {});
      const input = { organizationId: ORG, idempotencyKey: `idem-${Date.now()}`, customerId: c.id, channel: 'whatsapp', lines: [{ itemId: `${ORG}_broiler`, quantity: 3, cut: 'Curry cut' }], outletId: `${ORG}_shop`, pickupAt: new Date(Date.now() + 3 * 3600_000), paymentMethod: 'cash_at_shop' as const, expectedTotal: 660 };
      const first = await orders.createOrder(input);
      const again = await orders.createOrder(input);
      expect(first.status).toBe('created');
      expect(again.status).toBe('duplicate');
      expect(await stockOf('broiler')).toBe(15);
    });

    it('9b. two customers racing for the last stock: one order, stock never negative', async () => {
      await prisma.menuItem.update({ where: { id: `${ORG}_country` }, data: { stockQty: 2 } });
      const mk = async (i: number) => {
        const c = await conversations.getOrCreateCustomerByPhone(ORG, phone(), {});
        return orders.createOrder({ organizationId: ORG, idempotencyKey: `race-${Date.now()}-${i}`, customerId: c.id, channel: 'whatsapp', lines: [{ itemId: `${ORG}_country`, quantity: 1.5, cut: 'Curry cut' }], outletId: `${ORG}_shop`, pickupAt: new Date(Date.now() + 3 * 3600_000), paymentMethod: 'cash_at_shop' as const, expectedTotal: 675 });
      };
      const results = await Promise.all([mk(1), mk(2), mk(3)]);
      expect(results.filter((r: any) => r.status === 'created')).toHaveLength(1);
      expect(results.filter((r: any) => r.status === 'rejected').every((r: any) => /left today|not available/.test(r.problems.join(' ')))).toBe(true);
      expect(await stockOf('country')).toBe(0.5);
    });

    it('9c. cancelling returns the stock once, however often it is repeated', async () => {
      const placed = await confirmedOrder(phone(), '2 kg broiler curry cut, cash, 2 mani nerathula varen');
      expect(await stockOf('broiler')).toBe(16);
      const staff = { sub: 'u1', role: 'admin' };
      await orders.updateStatus(ORG, placed.order.id, { status: 'cancelled' }, staff);
      expect(await stockOf('broiler')).toBe(18);
      const { releaseStockForOrder } = await import('../src/restaurant/inventory.js');
      await releaseStockForOrder(prisma, { organizationId: ORG, orderId: placed.order.id, actor: 'retry' });
      expect(await stockOf('broiler')).toBe(18);
      expect(await prisma.inventoryMovement.count({ where: { orderId: placed.order.id, reason: 'order_cancelled' } })).toBe(1);
    });

    it('9d. staff updates are validated: no negative stock, whole eggs, other tenants cannot touch it', async () => {
      const staff = 'user:u1';
      await expect(inventory.update(ORG, `${ORG}_broiler`, { adjustBy: -20 }, staff)).rejects.toThrow('cannot remove');
      await expect(inventory.update(ORG, `${ORG}_broiler`, { stockQty: -1 }, staff)).rejects.toThrow('cannot be negative');
      await expect(inventory.update(ORG, `${ORG}_eggs`, { stockQty: 10.5 }, staff)).rejects.toThrow('whole number');
      const row = await inventory.update(ORG, `${ORG}_broiler`, { adjustBy: -3 }, staff);
      expect(row).toMatchObject({ stockQty: 15, stockIsDemo: false, stockStatus: 'in_stock' });
      // 11. Tenant isolation: another organization's product is "not found", and its stock is unchanged.
      await expect(inventory.update(ORG, `${OTHER}_broiler`, { stockQty: 1 }, staff)).rejects.toThrow('Product not found');
      expect(await stockOf('broiler', OTHER)).toBe(18);
      expect((await inventory.list(ORG)).every((r: any) => r.id.startsWith(ORG))).toBe(true);
      // ...and the other organization's chat never sees this one's stock change.
      expect((await wa(phone(), OTHER)('How much stock is available?')).response).toContain('Broiler Chicken — 18 kg');
    });
  });

  // ------------------------------------------------------------------------------------------ demo seed
  describe('demo stock seed', () => {
    it('8. seeds labelled demo stock idempotently and never overwrites stock entered by staff', async () => {
      await prisma.inventoryMovement.deleteMany({ where: { organizationId: DEMO } });
      await seedOrg(DEMO, {});
      await prisma.menuItem.update({ where: { id: `${DEMO}_country` }, data: { stockQty: 42, stockIsDemo: false } }); // counted by staff
      const { seedDemoStock } = await import('../scripts/seed-gr-chicken-demo.js');
      const first = await seedDemoStock(prisma);
      const second = await seedDemoStock(prisma);
      expect(first.stock.find((s: any) => s.name === 'Broiler Chicken')).toMatchObject({ qty: 18, status: 'in_stock' });
      expect(first.stock.find((s: any) => s.name === 'Chicken Liver')).toMatchObject({ qty: 0, status: 'out' });
      expect(first.skipped.join(' ')).toContain('Country Chicken: real stock entered by staff');
      expect(await stockOf('country', DEMO)).toBe(42);
      expect(await prisma.menuItem.findUnique({ where: { id: `${DEMO}_broiler` } })).toMatchObject({ stockIsDemo: true });
      expect(second.stock).toEqual(first.stock);
      expect(await prisma.inventoryMovement.count({ where: { organizationId: DEMO, reason: 'demo_seed', menuItemId: `${DEMO}_broiler` } })).toBe(1); // second run changed nothing
      expect(published).toHaveLength(0); // seeding sends no alert
    });
  });

  // ------------------------------------------------------------------------------------------ alerts
  describe('10. low-stock alerts (SNS)', () => {
    it('crossing the threshold publishes once; repeated checks and stock questions do not', async () => {
      await inventory.update(ORG, `${ORG}_broiler`, { stockQty: 4 }, 'user:u1'); // 18 -> 4 (low at 5)
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect(published[0].subject).toContain('Broiler Chicken low stock');
      expect(published[0].message).toContain('4 kg');
      await alerts.check(ORG, [`${ORG}_broiler`]);
      await alerts.check(ORG, [`${ORG}_broiler`]);
      await wa(phone())('How much stock is available?');
      expect(published).toHaveLength(1);
    });

    it('low → out escalates once; restocking clears it for the next time', async () => {
      await inventory.update(ORG, `${ORG}_broiler`, { stockQty: 4 }, 'user:u1');
      await vi.waitFor(() => expect(published).toHaveLength(1));
      await inventory.update(ORG, `${ORG}_broiler`, { stockQty: 0 }, 'user:u1');
      await vi.waitFor(() => expect(published).toHaveLength(2));
      expect(published[1].subject).toContain('out of stock');
      await inventory.update(ORG, `${ORG}_broiler`, { stockQty: 20 }, 'user:u1');
      await vi.waitFor(async () => expect((await prisma.menuItem.findUnique({ where: { id: `${ORG}_broiler` } })).stockAlertLevel).toBeNull());
      await inventory.update(ORG, `${ORG}_broiler`, { stockQty: 3 }, 'user:u1');
      await vi.waitFor(() => expect(published).toHaveLength(3));
    });

    it('an order that takes stock below the threshold alerts; demo stock is labelled', async () => {
      const c = await conversations.getOrCreateCustomerByPhone(ORG, phone(), {});
      await orders.createOrder({ organizationId: ORG, idempotencyKey: `a-${Date.now()}`, customerId: c.id, channel: 'whatsapp', lines: [{ itemId: `${ORG}_country`, quantity: 6, cut: 'Curry cut' }], outletId: `${ORG}_shop`, pickupAt: new Date(Date.now() + 3 * 3600_000), paymentMethod: 'cash_at_shop' as const, expectedTotal: 2700 });
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect(published[0].subject).toMatch(/^\[DEMO STOCK\]/);
      expect(published[0].message).toContain('demo / sample stock');
    });

    it('no SNS topic configured: skipped and logged, stock and orders keep working', async () => {
      alerts.config = { topicArn: '', region: '', enabled: false };
      const r = await inventory.update(ORG, `${ORG}_broiler`, { stockQty: 2 }, 'user:u1');
      expect(r.stockQty).toBe(2);
      const res = await alerts.check(ORG, [`${ORG}_broiler`]);
      expect(res).toEqual([]); // already claimed by the update's own check
      expect(alerts.publisher.publish).not.toHaveBeenCalled();
      expect((await prisma.menuItem.findUnique({ where: { id: `${ORG}_broiler` } })).stockAlertLevel).toBe('low');
    });

    it('a failed publish is retried on the next stock change (no alert lost, none duplicated)', async () => {
      alerts.publisher.publish = vi.fn().mockRejectedValueOnce(new Error('AccessDenied')).mockResolvedValue({ messageId: 'ok' });
      await alerts.check(ORG, []); // no-op
      await prisma.menuItem.update({ where: { id: `${ORG}_broiler` }, data: { stockQty: 4 } });
      const first = await alerts.check(ORG, [`${ORG}_broiler`]);
      expect(first[0]).toMatchObject({ level: 'low', sent: false, skipped: 'publish_failed' });
      const second = await alerts.check(ORG, [`${ORG}_broiler`]);
      expect(second[0]).toMatchObject({ level: 'low', sent: true });
      expect(await alerts.check(ORG, [`${ORG}_broiler`])).toEqual([]);
    });
  });
});
