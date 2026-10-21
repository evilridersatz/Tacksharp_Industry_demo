/**
 * MVP: the demo inventory seed (scripts/seed-demo-inventory.ts) and the ordering conversation on top of it —
 * availability, price, quantity follow-ups, multi-item cart with totals, insufficient / zero / unknown stock,
 * unit and quantity errors, explicit confirmation, no overselling, order status, staff handoff, Tamil / Tanglish.
 * Real MySQL TEST database; no provider is contacted.
 *
 *   TEST_DB_NAME=tacksharp_test npm test -w apps/api
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.STOCK_ALERT_SNS_TOPIC_ARN;
}
const ORG = 'org_test_mvp';
const OTHER = 'org_test_mvp_other';
let n = 0;
const phone = () => `95${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;
const NOW = new Date();

describe.skipIf(!enabled)('MVP demo inventory and conversation (integration)', () => {
  let ordersSvc: any;
  let prisma: any, engine: any, catalog: any, seed: typeof import('../scripts/seed-demo-inventory.js');

  async function resetOrg(id: string) {
    await prisma.order.deleteMany({ where: { organizationId: id } });
    await prisma.inventoryMovement.deleteMany({ where: { organizationId: id } });
    await prisma.menuItem.deleteMany({ where: { organizationId: id } });
    await prisma.organization.upsert({ where: { id }, create: { id, name: 'GR Chicken', vertical: 'restaurant' }, update: { vertical: 'restaurant' } });
    const shop = { organizationId: id, name: 'GR Chicken Shop', address: 'Test address', opensAt: '00:00', closesAt: '00:00', prepMinutes: 30, minOrderValue: 0, acceptOutsideHours: false, active: true };
    await prisma.outlet.upsert({ where: { id: `${id}_shop` }, create: { id: `${id}_shop`, ...shop }, update: shop });
    catalog?.invalidate(id);
  }
  const item = (name: string, org = ORG) => prisma.menuItem.findUnique({ where: { organizationId_name: { organizationId: org, name } } });

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { CatalogService } = await import('../src/restaurant/catalog.service.js');
    const { OrdersService } = await import('../src/restaurant/orders.service.js');
    const { OffersService } = await import('../src/restaurant/offers.service.js');
    const { OrderSessionStore } = await import('../src/restaurant/order-session.store.js');
    const { OrderingEngine } = await import('../src/restaurant/ordering-engine.service.js');
    const { FeedbackService } = await import('../src/restaurant/feedback.service.js');
    seed = await import('../scripts/seed-demo-inventory.js');
    prisma = new PrismaService();
    await prisma.$connect();
    const conversations = new ConversationsService(prisma);
    catalog = new CatalogService(prisma);
    const orders = new OrdersService(prisma);
    ordersSvc = orders;
    const store = new OrderSessionStore();
    store.useRedis(null);
    const offers = new OffersService(prisma, conversations, { sendText: vi.fn(), sendNamedTemplate: vi.fn() } as any, catalog);
    engine = new OrderingEngine(prisma, conversations, catalog, orders, offers, new FeedbackService(prisma), { onOrderCreated: vi.fn(async () => undefined) } as any, store, { run: vi.fn() } as any);
  });

  beforeEach(async () => {
    await resetOrg(ORG);
    await seed.seedDemoInventory(prisma, { organizationId: ORG });
    catalog.invalidate(ORG);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const wa = (p: string, org = ORG) => (message: string) => engine.generate({ organizationId: org, channel: 'whatsapp', phone: p, message, customerName: 'Priya', now: NOW });

  // ------------------------------------------------------------------------------------------ seed
  describe('demo inventory seed', () => {
    it('creates the brief\'s catalogue with prices, units, stock and demo labels', async () => {
      const items = await prisma.menuItem.findMany({ where: { organizationId: ORG }, orderBy: { sortOrder: 'asc' } });
      expect(items.map((i: any) => [i.name, Number(i.price), i.unit, Number(i.stockQty)])).toEqual([
        ['Whole Chicken', 240, 'kg', 20],
        ['Chicken Breast', 320, 'kg', 8],
        ['Chicken Curry Cut', 260, 'kg', 15],
        ['Chicken Drumsticks', 300, 'kg', 6],
        ['Chicken Wings', 280, 'kg', 5],
        ['Boneless Chicken', 360, 'kg', 7],
        ['Eggs', 8, 'piece', 120],
      ]);
      expect(items.every((i: any) => i.isDemo && i.stockIsDemo && i.available)).toBe(true);
      expect(await prisma.inventoryMovement.count({ where: { organizationId: ORG, reason: 'demo_seed' } })).toBe(7);
    });

    it('is repeatable: a second run changes nothing and records no new movements', async () => {
      const r = await seed.seedDemoInventory(prisma, { organizationId: ORG });
      expect(r.changes.filter((c) => c.action !== 'unchanged')).toEqual([]);
      expect(await prisma.menuItem.count({ where: { organizationId: ORG } })).toBe(7);
      expect(await prisma.inventoryMovement.count({ where: { organizationId: ORG } })).toBe(7);
    });

    it('preserves real data: a non-demo product and stock entered by staff are never overwritten', async () => {
      await prisma.menuItem.update({ where: { id: (await item('Chicken Wings')).id }, data: { isDemo: false, price: 299 } });
      await prisma.menuItem.update({ where: { id: (await item('Eggs')).id }, data: { stockQty: 30, stockIsDemo: false } });
      const r = await seed.seedDemoInventory(prisma, { organizationId: ORG });
      expect(r.changes.find((c) => c.product === 'Chicken Wings')).toMatchObject({ action: 'skipped' });
      expect(Number((await item('Chicken Wings')).price)).toBe(299);
      expect(Number((await item('Eggs')).stockQty)).toBe(30);
    });

    it('dry run writes nothing; other demo products are only hidden (never deleted) when asked', async () => {
      await resetOrg(OTHER);
      const dry = await seed.seedDemoInventory(prisma, { organizationId: OTHER, dryRun: true });
      expect(dry.changes.filter((c) => c.action === 'created')).toHaveLength(7);
      expect(await prisma.menuItem.count({ where: { organizationId: OTHER } })).toBe(0);
      const cat = await prisma.menuCategory.findFirst({ where: { organizationId: ORG } });
      await prisma.menuItem.create({ data: { organizationId: ORG, categoryId: cat.id, name: 'Broiler Chicken', price: 220, cutOptions: [], isDemo: true } });
      await seed.seedDemoInventory(prisma, { organizationId: ORG, hideOtherDemoProducts: true });
      expect(await item('Broiler Chicken')).toMatchObject({ available: false });
    });

    it('tenant-scoped: seeding one organization never touches another; a non-restaurant organization is refused', async () => {
      await resetOrg(OTHER);
      await seed.seedDemoInventory(prisma, { organizationId: OTHER });
      await prisma.menuItem.update({ where: { id: (await item('Boneless Chicken', OTHER)).id }, data: { stockQty: 1, stockIsDemo: false } });
      await seed.seedDemoInventory(prisma, { organizationId: ORG });
      expect(Number((await item('Boneless Chicken', OTHER)).stockQty)).toBe(1);
      await prisma.organization.upsert({ where: { id: 'org_test_mvp_re' }, create: { id: 'org_test_mvp_re', name: 'Realty', vertical: 'real_estate' }, update: {} });
      await expect(seed.seedDemoInventory(prisma, { organizationId: 'org_test_mvp_re' })).rejects.toThrow(/not a restaurant/);
      await expect(seed.seedDemoInventory(prisma, { organizationId: 'org_does_not_exist' })).rejects.toThrow(/does not exist/);
    });

    it('refuses production unless explicitly confirmed; rejects an invalid data file; checks the schema', async () => {
      const t = { host: 'db', port: 3306, database: 'tacksharp', user: 'app' };
      expect(seed.productionGuard(t, {}, { NODE_ENV: 'production' })).toMatch(/Refusing/);
      expect(seed.productionGuard({ ...t, database: 'tacksharp_prod' }, {}, {})).toMatch(/Refusing/);
      expect(seed.productionGuard(t, { allowProduction: true }, { NODE_ENV: 'production' })).toMatch(/Refusing/); // flag alone is not enough
      expect(seed.productionGuard(t, { allowProduction: true }, { NODE_ENV: 'production', CONFIRM_DEMO_SEED_DB: 'tacksharp' })).toBeNull();
      expect(seed.productionGuard(t, {}, { NODE_ENV: 'development' })).toBeNull();
      const bad = { categories: [{ name: 'Chicken' }], products: [{ name: 'X', category: 'Chicken', price: -5, unit: 'kg' as const, stock: 1 }, { name: 'Y', category: 'Fish', price: 10, unit: 'piece' as const, stock: 1.5 }] };
      expect(() => seed.validateDemoInventory(bad)).toThrow(/price must be a positive number[\s\S]*category "Fish"[\s\S]*whole number/);
      expect(await seed.checkSchema(prisma)).toMatchObject({ ok: true });
    });
  });

  // ------------------------------------------------------------------------------------------ conversation
  describe('conversation on the demo catalogue', () => {
    it('the brief\'s flow: availability → price → "half kilo" → add "one kg curry cut" → cart ₹440 → next step; no repeated greeting', async () => {
      const say = wa(phone());
      const r1 = await say('Do you have boneless chicken?');
      expect(r1.response).toContain('Boneless Chicken is available ✅ — ₹360/kg, 7 kg in demo stock.');
      expect(r1.response).toContain('How many kg of Boneless Chicken?');
      const r2 = await say('Half kilo');
      expect(r2.response).toContain('500 g Boneless Chicken — ₹180');
      expect(r2.draft.lines).toEqual([expect.objectContaining({ name: 'Boneless Chicken', quantity: 0.5 })]);
      const r3 = await say('Add one kg curry cut also');
      expect(r3.response).toContain('500 g Boneless Chicken — ₹180');
      expect(r3.response).toContain('1 kg Chicken Curry Cut — ₹260');
      expect(r3.response).toContain('Total: ₹440');
      expect(r3.response).toContain('How will you pay?'); // the next missing detail (pickup only — no delivery)
      for (const r of [r2, r3]) expect(r.response).not.toMatch(/Hello|Vanakkam|வணக்கம்/);
    });

    it('insufficient stock: says how much there is, offers that or less and alternatives, and stores nothing until a valid amount', async () => {
      const say = wa(phone());
      await say('Hello, what do you have today?');
      const r = await say('8 kg drumsticks');
      expect(r.response).toContain('we have only 6 kg of Chicken Drumsticks right now. Would you like 6 kg or less?');
      expect(r.response).toMatch(/Or we have .*Whole Chicken/);
      expect(r.draft.lines[0]?.quantity).toBeUndefined();
      const r2 = await say('5 kg');
      expect(r2.draft.lines).toEqual([expect.objectContaining({ name: 'Chicken Drumsticks', quantity: 5 })]);
    });

    it('zero stock is "out of stock" with alternatives; NULL stock is unknown — never available, never out', async () => {
      await prisma.menuItem.update({ where: { id: (await item('Chicken Wings')).id }, data: { stockQty: 0 } });
      await prisma.menuItem.update({ where: { id: (await item('Chicken Breast')).id }, data: { stockQty: null, stockIsDemo: false } });
      catalog.invalidate(ORG);
      const say = wa(phone());
      const wings = await say('Do you have chicken wings?');
      expect(wings.response).toContain('Chicken Wings is currently out of stock');
      expect(wings.response).toMatch(/Boneless Chicken/);
      const breast = await say('Do you have chicken breast?');
      expect(breast.response).toContain("Chicken Breast is ₹320/kg. I can't confirm today's stock");
      expect(breast.response).not.toMatch(/Chicken Breast is available|out of stock/);
      const list = await say('Which chicken is available?');
      expect(list.response).toContain('Chicken Breast — ₹320/kg (stock not confirmed)');
      expect(list.response).not.toContain('Chicken Wings');
    });

    it('unit and quantity errors are rejected with the reason', async () => {
      const say = wa(phone());
      await say('Hello, what do you have today?');
      const kg = await say('2 kg eggs'); // eggs are counted: the reason, and "2 Eggs?" offered — nothing set until a yes
      expect(kg.response).toContain('Eggs are sold by count, not by kilo. Shall I put 2 Eggs?');
      expect(kg.draft.lines).toEqual([expect.objectContaining({ name: 'Eggs', quantity: undefined })]);
      expect((await say('6 pieces boneless')).response).toContain('Boneless Chicken is sold by weight. How many kg would you like?');
      expect((await say('0.3 kg boneless')).response).toContain('sold in steps of 250 g');
      expect((await say('20 kg boneless')).response).toContain('up to 10 kg per order');
      const ok = await say('12 eggs');
      expect(ok.draft.lines).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Eggs', quantity: 12 })]));
    });

    it('explicit confirmation places one order, takes stock once, and the status / staff requests work after it', async () => {
      const p = phone();
      const say = wa(p);
      await say('1 kg boneless and 6 eggs, cash');
      const summary = await say('pickup at 8 pm');
      expect(summary.response).toContain('Reply *Yes* to confirm');
      expect(await prisma.order.count({ where: { organizationId: ORG, customerPhone: { contains: p } } })).toBe(0); // nothing before yes
      const placed = await say('yes');
      expect(placed.order?.status).toBe('created');
      await say('yes'); // a repeated yes never places or takes stock again
      expect(Number((await item('Boneless Chicken')).stockQty)).toBe(6);
      expect(Number((await item('Eggs')).stockQty)).toBe(114);
      expect(await prisma.inventoryMovement.count({ where: { organizationId: ORG, reason: 'order_reserved' } })).toBe(2);
      expect((await say('order status?')).response).toContain(placed.order.orderNumber);
      const human = await say('I want to talk to staff');
      expect(human.response).toMatch(/staff/i);
      expect((await prisma.conversation.findFirst({ where: { organizationId: ORG, externalId: { contains: p } } })).status).toBe('human_handoff');
    });

    it('two customers racing for the last kilos: never oversold', async () => {
      await prisma.menuItem.update({ where: { id: (await item('Boneless Chicken')).id }, data: { stockQty: 1 } });
      catalog.invalidate(ORG);
      const a = wa(phone());
      const b = wa(phone());
      for (const say of [a, b]) {
        await say('1 kg boneless, cash');
        await say('pickup at 8 pm');
      }
      const [ra, rb] = await Promise.all([a('yes'), b('yes')]);
      expect([ra.order?.status, rb.order?.status].filter((s) => s === 'created')).toHaveLength(1);
      expect(Number((await item('Boneless Chicken')).stockQty)).toBe(0);
    });

    it('a phone call uses the same engine and data, spoken (no symbols), and keeps the cart across turns', async () => {
      const p = phone();
      await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c-${p}` });
      const call = (message: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: p, message, now: NOW });
      const r1 = await call('Do you have boneless chicken today?');
      expect(r1.response).toContain('Boneless Chicken is available');
      expect(r1.response).toContain('360 rupees a kilo');
      expect(r1.response).not.toMatch(/[₹✅*•]/u);
      const r2 = await call('half a kilo please');
      expect(r2.draft.lines).toEqual([expect.objectContaining({ name: 'Boneless Chicken', quantity: 0.5 })]);
      expect(r2.response).toContain('180 rupees');
      expect(r2.path).toBe('rules');
      expect(r2.llm).toBe('not_needed'); // why aiRequests is 0: the rules answered
    });

    it('call language: a short Tamil-script transcript does not flip an English call; a clear sentence does', async () => {
      const p = phone();
      await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c-${p}` });
      const call = (message: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: p, message, now: NOW });
      const en = await call('I would like some chicken wings');
      expect(en.language).toBe('en-IN');
      const ok = await call('ஓகே'); // speech-to-text wrote "ok" in Tamil script
      expect(ok.language).toBe('en-IN');
      expect(ok.languageInfo.changed).toBe(false);
      const ta = await call('எனக்கு ஒரு கிலோ விங்ஸ் வேணும்');
      expect(ta.language).toBe('ta-IN');
      expect(ta.languageInfo).toMatchObject({ previous: 'english', changed: true });
    });

    it('call language: Tamil heard as ta-IN switches an English call to Tamil on the FIRST Tamil turn (reported call); "ஓகே" never does', async () => {
      const p = phone();
      await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c-${p}` });
      const call = (message: string, sttLanguage: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: p, message, now: NOW, metadata: { callId: `c-${p}`, sttLanguage } });
      expect((await call('I would like some chicken wings', 'en-IN')).language).toBe('en-IN');
      expect((await call('ஓகே', 'ta-IN')).language).toBe('en-IN'); // speech-to-text wrote "ok" in Tamil script
      const ta = await call('ரெண்டு கிலோ', 'ta-IN'); // two Tamil words heard as Tamil
      expect(ta.language).toBe('ta-IN');
      expect(ta.response).toMatch(/[\u0B80-\u0BFF]/u); // Tamil script → ta-IN voice
      expect(ta.draft.lines).toEqual([expect.objectContaining({ name: 'Chicken Wings', quantity: 2 })]);
      // A single Tamil word needs a second Tamil turn; an English turn in between resets it.
      const p2 = phone();
      await engine.openVoiceSession({ organizationId: ORG, phone: p2, openingText: 'opening', callId: `c-${p2}` });
      const call2 = (message: string, sttLanguage: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: p2, message, now: NOW, metadata: { callId: `c-${p2}`, sttLanguage } });
      await call2('I would like some chicken wings', 'en-IN');
      expect((await call2('வேணும்', 'ta-IN')).language).toBe('en-IN');
      await call2('two kg please', 'en-IN');
      expect((await call2('வேணும்', 'ta-IN')).language).toBe('en-IN');
      expect((await call2('ஆமா', 'ta-IN')).language).toBe('ta-IN'); // second single Tamil word in a row
      // Typed text with no speech-to-text evidence keeps the 3-word rule.
      const p3 = phone();
      await engine.openVoiceSession({ organizationId: ORG, phone: p3, openingText: 'opening', callId: `c-${p3}` });
      await engine.generate({ organizationId: ORG, channel: 'voice', phone: p3, message: 'I would like some chicken wings', now: NOW });
      expect((await engine.generate({ organizationId: ORG, channel: 'voice', phone: p3, message: 'ரெண்டு கிலோ', now: NOW })).language).toBe('en-IN');
    });

    it('spoken Tamil confirmation ("ஆமாங்க") places the order; the WhatsApp and phone carts price the same request identically', async () => {
      const p = phone();
      await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c-${p}` });
      const call = (message: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: p, message, now: NOW, metadata: { callId: `c-${p}`, sttLanguage: 'ta-IN' } });
      const v1 = await call('ஒன் கேஜி போன்லெஸ், கேஷ்'); // Saaras writes "one kg" and "cash" in Tamil script
      expect(v1.draft.lines).toEqual([expect.objectContaining({ name: 'Boneless Chicken', quantity: 1 })]);
      const summary = await call('ராத்திரி எட்டு மணிக்கு');
      expect(summary.state).toBe('awaiting_confirmation');
      const placed = await call('ஆமாங்க');
      expect(placed.order?.status).toBe('created');
      expect(placed.order.total).toBe(360); // database price, 1 kg × ₹360
      const w = wa(phone());
      await w('Hello, what do you have today?');
      const wr = await w('1 kg boneless');
      expect(wr.response).toContain('1 kg Boneless Chicken — ₹360');
    });

    it('an amount said before the product is kept and applied to the product named next (no unpriced line)', async () => {
      const say = wa(phone());
      await say('Hello, what do you have today?');
      const r1 = await say('ஒரு கிலோ வேணும்');
      expect(r1.response).toContain('1 kg — எது வேணும்?');
      expect(r1.response).toContain('Boneless Chicken');
      expect(r1.draft.lines).toEqual([]);
      const r2 = await say('போன்லெஸ்');
      expect(r2.draft.lines).toEqual([expect.objectContaining({ name: 'Boneless Chicken', quantity: 1 })]);
      expect(r2.response).toContain('₹360');
    });

    it('"order pannanum" and help texts come from this shop\'s catalogue (no fixed broiler / cut examples)', async () => {
      const say = wa(phone());
      await say('Hello, what do you have today?');
      const start = await say('order pannanum');
      expect(start.response).toContain('Boneless Chicken — ₹360/kg');
      expect(start.response).not.toMatch(/broiler|biryani cut|fry cut/i);
      const help = await say('asdf qwerty zxcv');
      expect(help.response).toContain('1 kg Whole Chicken'); // example built from the first product for sale
      expect(help.response).not.toMatch(/broiler|biryani cut|fry cut|which cut/i); // this catalogue has no cuts
    });

    it('menu and prices are tenant-specific: the same product name at another shop answers with that shop\'s price', async () => {
      await resetOrg(OTHER);
      await seed.seedDemoInventory(prisma, { organizationId: OTHER });
      await prisma.menuItem.update({ where: { id: (await item('Boneless Chicken', OTHER)).id }, data: { price: 400, isDemo: false } });
      catalog.invalidate(OTHER);
      const here = await wa(phone())('Do you have boneless chicken?');
      const there = await wa(phone(), OTHER)('Do you have boneless chicken?');
      expect(here.response).toContain('₹360/kg');
      expect(there.response).toContain('₹400/kg');
      expect(there.response).not.toContain('₹360');
    });

    it('turns that carry order details are logged as order_details, not unknown', async () => {
      const say = wa(phone());
      await say('Hello, what do you have today?');
      expect((await say('1 kg boneless')).intent).toBe('order_details');
    });

    it('unclear / unknown messages without a model configured: a useful help reply, and the log says why', async () => {
      const say = wa(phone());
      await say('Hello, what do you have today?');
      const r = await say('asdf qwerty zxcv');
      expect(r.path).toBe('rules');
      expect(r.llm).toBe('not_configured');
      expect(r.response.length).toBeGreaterThan(20);
    });

    // ---------------------------------------------------------------- round 3: Chennai Tamil / Tanglish flows
    it('a price question answers THAT price from the database and never changes the cart (logs: intent=menu, cartLines=1, cartPriced=0)', async () => {
      const say = wa(phone());
      await say('Vanakkam');
      const r = await say('Boneless price enna?');
      expect(r.response).toContain('Boneless Chicken irukku ✅ — ₹360/kg');
      expect(r.response).not.toContain('Whole Chicken'); // not the whole menu
      expect(r.draft.lines).toEqual([]);
      const next = await say('1 kg'); // the follow-up amount is for the product just asked about
      expect(next.draft.lines).toEqual([expect.objectContaining({ name: 'Boneless Chicken', quantity: 1 })]);
    });

    it('"Evlo aagum?" gives the cart total; "innum oru kilo" adds; "adha remove pannunga" removes that product only', async () => {
      const say = wa(phone());
      await say('Vanakkam');
      await say('Oru kilo boneless kudu');
      expect((await say('Innum oru kilo add pannunga')).draft.lines).toEqual([expect.objectContaining({ name: 'Boneless Chicken', quantity: 2 })]);
      await say('Rendu kilo curry cut venum');
      const total = await say('Evlo aagum?');
      expect(total.response).toContain('2 kg Boneless Chicken — ₹720');
      expect(total.response).toContain('2 kg Chicken Curry Cut — ₹520');
      expect(total.response).toContain('Total: ₹1240');
      const removed = await say('Adha remove pannunga'); // "that" = Chicken Curry Cut, the product just talked about
      expect(removed.draft.lines).toEqual([expect.objectContaining({ name: 'Boneless Chicken', quantity: 2 })]);
      await say('Rendu kilo curry cut venum');
      await say('evlo aagum'); // talking about the cart, no product in focus
      const ambiguous = await say('remove pannunga');
      expect(ambiguous.response).toMatch(/Edhu eduthudanum\?.*Boneless Chicken.*Chicken Curry Cut/);
      expect(ambiguous.draft.lines).toHaveLength(2); // never guesses between two products
    });

    it('the arrival-time question is answered, focused, and never repeated after a valid answer (the "ethana manikku varuvinga?" loop)', async () => {
      const say = wa(phone());
      await say('Vanakkam');
      const replies: string[] = [];
      const ask = /Eppo vandhu collect|Ethana manikku varuveenga|When will you come|What time will you come/;
      for (const m of ['1 kg boneless, cash', 'Ethana manikku varanum?', 'Pickup-ku varren']) replies.push((await say(m)).response);
      expect(replies[1]).toMatch(/open.*ready/); // the customer's question is answered: hours + earliest ready time
      expect(replies[1]).not.toMatch(/To order, tell me|Order panna:/); // no generic help text
      expect(replies[2]).toMatch(/Ethana manikku varuveenga\?.*seekiram/); // one focused question with the earliest option
      const answered = await say('Naan 8 manikku varuven');
      expect(answered.state).toBe('awaiting_confirmation');
      expect(answered.draft.pickupAt).toBeTruthy();
      // After a valid answer the time is never asked again, whatever the customer says next.
      for (const m of ['Evlo aagum?', 'ok', 'hmm']) expect((await say(m)).response, m).not.toMatch(ask);
      // "seekiram" (as soon as possible) is a valid answer: the earliest time.
      const quick = wa(phone());
      await quick('Vanakkam');
      await quick('1 kg boneless, cash');
      expect((await quick('seekiram')).state).toBe('awaiting_confirmation');
    });

    it('"Chicken biryani irukka?" is not on the list: said so, the real list given, nothing ordered', async () => {
      const say = wa(phone());
      await say('Vanakkam');
      const r = await say('Chicken biryani irukka?');
      expect(r.response).toMatch(/confirm panna mudiyala/);
      expect(r.response).toContain('Boneless Chicken');
      expect(r.draft.lines).toEqual([]);
    });

    it('Tanglish questions keep a Tanglish chat in Tanglish; an unclear message re-asks the pending question once (no generic help)', async () => {
      const say = wa(phone());
      await say('Vanakkam');
      await say('Oru kilo boneless kudu');
      const q = await say('Ethana manikku varanum?');
      expect(q.response).toMatch(/irundhu ready-ah irukkum/); // Tanglish, not "Your order can be ready"
      const unclear = await say('Spicy ah venum');
      expect(unclear.response).toMatch(/^Sorry, enakku puriyala\./);
      expect(unclear.response).toMatch(/Payment eppadi/); // the pending question, once
      expect(unclear.response).not.toMatch(/Order panna:/);
    });

    it('channel parity: the same Tanglish order over WhatsApp and a phone call gives the same cart, prices, state and order total', async () => {
      const script = ['Oru kilo boneless kudu', 'Innum oru kilo add pannunga', 'Rendu kilo curry cut venum', 'Cash kudukaren', 'Naan 8 manikku varuven'];
      const w = wa(phone());
      await w('Vanakkam');
      const p = phone();
      await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c-${p}` });
      const v = (message: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: p, message, now: NOW, metadata: { callId: `c-${p}`, sttLanguage: 'ta-IN' } });
      for (const m of script) {
        const [a, b] = [await w(m), await v(m)];
        expect(b.draft.lines, m).toEqual(a.draft.lines);
        expect(b.state, m).toBe(a.state);
        expect(Boolean(b.draft.pickupAt), m).toBe(Boolean(a.draft.pickupAt));
        expect(b.response, m).not.toMatch(/[₹✅*•]/u); // spoken form only differs in presentation
      }
      const [ow, ov] = [await w('Seri, confirm pannunga'), await v('Seri, confirm pannunga')];
      expect(ow.order?.status).toBe('created');
      expect(ov.order?.status).toBe('created');
      expect(ov.order.total).toBe(ow.order.total);
      expect(ow.order.total).toBe(1240); // 2 kg × 360 + 2 kg × 260, database prices
    });

    // ---------------------------------------------------------------- round 4: the reported failed conversations
    const voice = async (p: string) => {
      await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c-${p}` });
      return (message: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: p, message, now: NOW, metadata: { callId: `c-${p}`, sttLanguage: 'ta-IN' } });
    };
    const IST = (d: string) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: false });

    it('A. egg-only order: "chicken curry cut வேண்டாம்" adds nothing, "no chicken" keeps the eggs, no chicken question is ever asked', async () => {
      for (const ch of ['whatsapp', 'voice', 'test'] as const) {
        const p = phone();
        const say = ch === 'voice' ? await voice(p) : (m: string) => engine.generate({ organizationId: ORG, channel: ch, phone: p, message: m, customerName: 'Priya', now: NOW });
        if (ch !== 'voice') await say('Hello, what do you have today?');
        await say('Eggs irukka?');
        const eight = await say('எட்டு');
        expect(eight.draft.lines, ch).toEqual([expect.objectContaining({ name: 'Eggs', quantity: 8 })]);
        for (const m of ['Chicken curry cut வேண்டாம்', 'எனக்கு chicken வேணாம்', 'No chicken', 'Egg mattum venum']) {
          const r = await say(m);
          expect(r.draft.lines, `${ch}: ${m}`).toEqual([expect.objectContaining({ name: 'Eggs', quantity: 8 })]);
          expect(r.response, `${ch}: ${m}`).not.toMatch(/Chicken Curry Cut (eduthutten|எடுத்துட்டேன்)|Removed Chicken Curry Cut|ethana kg|எத்தனை கிலோ|how many kg/i);
        }
      }
    });

    it('B. a new product while "how many eggs?" is pending: the question moves to it and each amount lands on the right product and unit', async () => {
      const say = wa(phone());
      await say('Hello, what do you have today?');
      expect((await say('Eggs venum')).response).toContain('How many Eggs?');
      const curry = await say('Curry cut');
      expect(curry.response).toContain('How many kg of Chicken Curry Cut?');
      expect(curry.response).not.toContain('How many Eggs?');
      const five = await say('5');
      expect(five.draft.lines).toEqual([expect.objectContaining({ name: 'Eggs', quantity: undefined }), expect.objectContaining({ name: 'Chicken Curry Cut', quantity: 5 })]);
      expect(five.response).toContain('How many Eggs?');
      const twelve = await say('twelve twelve'); // speech-to-text repeat
      expect(twelve.draft.lines).toEqual([expect.objectContaining({ name: 'Eggs', quantity: 12 }), expect.objectContaining({ name: 'Chicken Curry Cut', quantity: 5 })]);
    });

    it('C. pickup times: "evening four o\'clock", "4 PM", "நாலு மணி", "மாலை நாலு மணி", "4 mani" are 16:00; thanks / good night never change it', async () => {
      // The shop's real hours (07:00–21:00) and a fixed 12:00 IST clock: "four o'clock" can only be 4 PM there.
      await prisma.outlet.update({ where: { id: `${ORG}_shop` }, data: { opensAt: '07:00', closesAt: '21:00' } });
      catalog.invalidate(ORG);
      const noon = new Date(new Date().toISOString().slice(0, 10) + 'T06:30:00Z');
      for (const t of ["Evening four o'clock", '4 PM', "four o'clock", 'நாலு மணி', 'மாலை நாலு மணி', '4 mani']) {
        const p = phone();
        const say = (message: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: p, message, customerName: 'Priya', now: noon });
        await say('Hello, what do you have today?');
        await say('1 kg curry cut, cash');
        const r = await say(t);
        expect(r.state, t).toBe('awaiting_confirmation');
        expect(IST(r.draft.pickupAt), t).toBe('16:00');
        for (const m of ['thanks', 'Thanks, good night']) {
          const after = await say(m);
          if (after.draft.pickupAt) expect(IST(after.draft.pickupAt), `${t} / ${m}`).toBe('16:00');
          expect(after.response, m).not.toMatch(/When will you come|What time will you come/);
        }
      }
      // A 24-hour shop: a bare "4" could be 4 AM or 4 PM — asked, never guessed; the answer sets it.
      await prisma.outlet.update({ where: { id: `${ORG}_shop` }, data: { opensAt: '00:00', closesAt: '00:00' } });
      catalog.invalidate(ORG);
      const p = phone();
      const say = (message: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: p, message, customerName: 'Priya', now: noon });
      await say('Hello, what do you have today?');
      await say('1 kg curry cut, cash');
      const ask = await say('4');
      expect(ask.draft.pickupAt).toBeFalsy();
      expect(ask.response).toMatch(/AM.*PM/);
      const pm = await say('PM');
      expect(IST(pm.draft.pickupAt)).toBe('16:00');
      expect(pm.state).toBe('awaiting_confirmation');
    });

    it('D. Country Chicken out of stock while Eggs are in stock: said accurately, alternatives with prices', async () => {
      const cat = await prisma.menuCategory.findFirst({ where: { organizationId: ORG, name: 'Chicken' } });
      await prisma.menuItem.create({ data: { organizationId: ORG, categoryId: cat.id, name: 'Country Chicken', price: 450, unit: 'kg', cutOptions: [], aliases: 'country chicken, nattu kozhi', isDemo: true, available: true, stockQty: 0, stockIsDemo: true } });
      catalog.invalidate(ORG);
      const say = wa(phone());
      await say('Hello, what do you have today?');
      const country = await say('Country chicken irukka?');
      expect(country.response).toContain('Country Chicken ippo stock illa'); // Tanglish question → Tanglish answer
      expect(country.response).toContain('Eggs');
      expect((await say('Eggs irukka?')).response).toContain('Eggs irukku ✅ — ₹8/pc');
      const other = await say('What else is available?');
      expect(other.response).toContain('Eggs — ₹8/pc');
      expect(other.response).toContain('Boneless Chicken — ₹360/kg');
      expect(other.response).not.toContain('Country Chicken');
      expect(other.response).not.toMatch(/sold out for today|nothing else is in stock/i);
    });

    it('E. "அவ்வளவுதான்" moves on; "Order place pannunga போதும்" at the summary places ONE order; repeating it does not place another', async () => {
      const say = wa(phone());
      await say('Hello, what do you have today?');
      await say('1 kg curry cut');
      expect((await say('அவ்வளவுதான்')).response).toMatch(/Payment எப்படி|How will you pay/);
      await say('cash');
      expect((await say('6 pm')).state).toBe('awaiting_confirmation');
      const placed = await say('Order place pannunga போதும்');
      expect(placed.order?.status).toBe('created');
      const again = await say('Place the order');
      expect(again.order).toBeUndefined();
      expect(await prisma.order.count({ where: { organizationId: ORG, id: placed.order.id } })).toBe(1);
      expect(await prisma.order.count({ where: { organizationId: ORG, orderNumber: placed.order.orderNumber } })).toBe(1);
    });

    it('F. staff, cut the call, good night, cancel and thanks each do the right thing (and never ask about chicken)', async () => {
      const w = wa(phone());
      await w('Hello, what do you have today?');
      await w('1 kg curry cut');
      expect((await w('Staff kitta pesanum')).response).toMatch(/staff/i);
      for (const [m, end] of [['Thanks, good night', true], ['Cut the call', true], ['thanks', false]] as const) {
        const call = await voice(phone());
        await call('1 kg curry cut');
        const r = await call(m);
        expect(Boolean(r.endCall), m).toBe(end);
        expect(r.draft.pickupAt, m).toBeFalsy(); // "good night" is not a pickup time
        if (end) expect(r.response, m).toMatch(/not been placed/);
        else expect(r.response, m).toMatch(/How will you pay/); // thanks keeps the order going
      }
      const c = wa(phone());
      await c('Hello, what do you have today?');
      await c('1 kg curry cut');
      expect((await c('cancel')).response).not.toMatch(/ethana kg|how many kg/i);
    });

    it('order creation failure: no success message, the summary stays pending, and a retry places exactly one order', async () => {
      const say = wa(phone());
      await say('Hello, what do you have today?');
      await say('12 eggs, cash, 6 pm');
      const spy = vi.spyOn(ordersSvc, 'createOrder').mockRejectedValueOnce(new Error('(conn:-1) pool timeout'));
      const failed = await say('yes');
      expect(failed.response).not.toMatch(/confirmed|confirm aachu|confirm ஆச்சு/i);
      expect(failed.order).toBeUndefined();
      expect(failed.state).toBe('awaiting_confirmation');
      spy.mockRestore();
      const ok = await say('yes');
      expect(ok.order?.status).toBe('created');
      expect(await prisma.order.count({ where: { organizationId: ORG, idempotencyKey: { startsWith: (await prisma.order.findUnique({ where: { id: ok.order.id } })).idempotencyKey.split(':').slice(0, -1).join(':') } } })).toBe(1);
    });

    // ---------------------------------------------------------------- round 5: the reported transcripts
    const NOON = new Date(new Date().toISOString().slice(0, 10) + 'T06:30:00Z'); // 12:00 IST today (derived, not hardcoded)
    const at = (org: string, ch: 'whatsapp' | 'voice', when = NOON) => {
      const p = phone();
      const opened = ch === 'voice' ? engine.openVoiceSession({ organizationId: org, phone: p, openingText: 'opening', callId: `c-${p}` }) : Promise.resolve();
      return async (message: string) => {
        await opened;
        return engine.generate({ organizationId: org, channel: ch, phone: p, message, customerName: 'Priya', now: when, metadata: ch === 'voice' ? { callId: `c-${p}`, sttLanguage: 'ta-IN' } : undefined });
      };
    };
    async function withUnavailableBroiler() {
      const cat = await prisma.menuCategory.findFirst({ where: { organizationId: ORG, name: 'Chicken' } });
      await prisma.menuItem.create({ data: { organizationId: ORG, categoryId: cat.id, name: 'Broiler Chicken', price: 220, unit: 'kg', cutOptions: ['Curry cut'], aliases: 'broiler, chicken, kozhi, கோழி', isDemo: true, available: false } });
      catalog.invalidate(ORG);
    }
    const chickenQty = /Curry Cut (ethana kg|எத்தனை கிலோ)|How many kg of Chicken Curry Cut|How many kg of Broiler/;

    it('R1. eggs only (Broiler unavailable holds "chicken"): rejecting chicken never adds, falsely removes or asks chicken quantity', async () => {
      await withUnavailableBroiler();
      for (const ch of ['whatsapp', 'voice'] as const) {
        const say = at(ORG, ch);
        if (ch === 'whatsapp') await say('Hello, what do you have today?');
        await say('8 eggs');
        await say('curry cut'); // pending "how many kg?"
        const no = await say('No chicken.');
        expect(no.draft.lines, ch).toEqual([expect.objectContaining({ name: 'Eggs', quantity: 8 })]);
        expect(no.response, ch).not.toMatch(chickenQty);
        expect(no.response, ch).not.toMatch(/Broiler/); // never "Broiler not available" for a rejection
        const again = await say('எனக்கு chicken வேணாம்.');
        expect(again.response, ch).not.toMatch(/எடுத்துட்டேன்|eduthutten|Removed/); // nothing to remove: no false claim
        const done = await say('அவ்வளவுதான் order place பண்ணிடுங்க. egg மட்டும்தான்.');
        expect(done.draft.lines, ch).toEqual([expect.objectContaining({ name: 'Eggs', quantity: 8 })]);
        expect(done.response, ch).toMatch(/Payment|payment/); // the next genuinely missing field
        expect(done.response, ch).not.toMatch(chickenQty);
      }
    });

    it('R2. quantity corrections update the cart and totals ("not six … only four", "நாலு போதும்"), also at the review', async () => {
      for (const ch of ['whatsapp', 'voice'] as const) {
        const say = at(ORG, ch);
        if (ch === 'whatsapp') await say('Hello, what do you have today?');
        await say('8 eggs, cash');
        expect((await say('Not six pieces sir. I need only four.')).draft.lines, ch).toEqual([expect.objectContaining({ name: 'Eggs', quantity: 4 })]);
        await say('8 eggs');
        const review = await say('6 pm');
        expect(review.state, ch).toBe('awaiting_confirmation');
        const corrected = await say('நாலு போதும்');
        expect(corrected.order, ch).toBeUndefined(); // a correction is not a yes
        expect(corrected.state, ch).toBe('awaiting_confirmation'); // back at the review…
        expect(corrected.draft.lines, ch).toEqual([expect.objectContaining({ name: 'Eggs', quantity: 4 })]);
        expect(corrected.response, ch).toMatch(/32/); // …with the corrected total (4 × ₹8)
      }
    });

    it('R3. switching product clears the obsolete pending question (chicken → eggs and eggs → chicken)', async () => {
      const a = at(ORG, 'whatsapp');
      await a('Hello, what do you have today?');
      await a('curry cut');
      const eggs = await a('எனக்கு eggs தான் வேணும்.');
      expect(eggs.draft.lines).toEqual([expect.objectContaining({ name: 'Eggs', quantity: undefined })]);
      expect(eggs.response).toMatch(/Eggs எத்தனை வேணும்/);
      expect(eggs.response).not.toMatch(chickenQty);
      const b = at(ORG, 'whatsapp');
      await b('Hello, what do you have today?');
      await b('Eggs venum');
      const curry = await b('curry cut');
      expect(curry.response).toContain('How many kg of Chicken Curry Cut?');
      expect(curry.draft.lines.find((l: any) => l.name === 'Eggs')?.quantity).toBeUndefined(); // no default amount invented
    });

    it('R4. pickup time: outside hours rejected with a reason (never "got it" first); vague "evening" asks the hour; "4" then is 4 PM, not 4 eggs', async () => {
      await prisma.outlet.update({ where: { id: `${ORG}_shop` }, data: { opensAt: '07:00', closesAt: '21:00' } }); // real hours for this test
      catalog.invalidate(ORG);
      const night = new Date(NOON.getTime() - 11.5 * 3600_000); // 00:30 IST
      const n = at(ORG, 'whatsapp', night);
      await n('Hello, what do you have today?');
      await n('6 eggs, cash');
      const hr = await n('1 hr');
      expect(hr.draft.pickupAt).toBeFalsy();
      expect(hr.response).not.toMatch(/^(Got it|Sari) ✅/);
      expect(hr.response).toMatch(/closed|close-ah|மூடியிருக்கும்/);
      const e = at(ORG, 'whatsapp');
      await e('Hello, what do you have today?');
      await e('6 eggs, cash');
      const evening = await e('evening');
      expect(evening.draft.pickupAt).toBeFalsy();
      expect(evening.response).toMatch(/What time will you come|Ethana manikku/);
      const four = await e('4');
      expect(four.draft.lines).toEqual([expect.objectContaining({ name: 'Eggs', quantity: 6 })]);
      expect(new Date(four.draft.pickupAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false })).toBe('16');
      expect(four.state).toBe('awaiting_confirmation');
      expect((await e('thanks')).response).not.toMatch(/What time will you come|Ethana manikku/); // never asked again
    });

    it('R5. at the review: "change" edits, "No" never leaves a yes armed, "பண்ணு" confirms', async () => {
      const say = at(ORG, 'whatsapp');
      await say('Hello, what do you have today?');
      await say('6 eggs, cash, 6 pm');
      const change = await say('change பண்ணனும்');
      expect(change.state).toBe('collecting');
      expect(change.response).toMatch(/என்ன மாத்தணும்|what would you like to change/i);
      const no = await say('No');
      expect(no.order).toBeUndefined();
      const yes = await say('yes'); // after "No", a yes must NOT place the order (it used to)
      expect(yes.order).toBeUndefined();
      const v = at(ORG, 'voice');
      await v('6 eggs, cash');
      await v('மாலை 4 மணி');
      await v('change பண்ணனும்');
      await v('4 eggs');
      const placed = await v('பண்ணு');
      expect(placed.order?.status).toBe('created');
      expect(placed.order.total).toBe(32);
    });

    it('R6. offers: never makes an order free; applied only above the offer amount; totals add up in summary and order', async () => {
      await resetOrg(OTHER);
      await seed.seedDemoInventory(prisma, { organizationId: OTHER });
      await prisma.offerCampaign.deleteMany({ where: { organizationId: OTHER } });
      await prisma.offerCampaign.create({ data: { organizationId: OTHER, name: 'Website order ₹50 off', code: 'GR50T', amount: 50, minOrderValue: 0, validDays: 7, active: true } });
      try {
        const small = at(OTHER, 'whatsapp');
        await small('Hi');
        const s1 = await small('6 eggs, cash, 6 pm');
        expect(s1.response).toContain('To pay: ₹48');
        expect(s1.response).not.toMatch(/Offer: −/);
        expect(s1.response).toContain('The offer needs an order above ₹50');
        const o1 = await small('yes');
        expect(o1.order.total).toBe(48);
        const big = at(OTHER, 'whatsapp');
        await big('Hi');
        const s2 = await big('1 kg curry cut, cash, 6 pm');
        expect(s2.response).toContain('Subtotal: ₹260');
        expect(s2.response).toContain('Offer: −₹50');
        expect(s2.response).toContain('To pay: ₹210');
        const o2 = await big('yes');
        expect(o2.order.total).toBe(210);
        const row = await prisma.order.findUnique({ where: { id: o2.order.id } });
        expect(Number(row.subtotal) - Number(row.discount)).toBe(Number(row.total));
      } finally {
        await prisma.offerClaim.deleteMany({ where: { organizationId: OTHER } });
        await prisma.order.deleteMany({ where: { organizationId: OTHER } });
        await prisma.offerCampaign.deleteMany({ where: { organizationId: OTHER } });
      }
    });

    it('R7. WhatsApp and voice: the same messages give the same cart, review state and order total', async () => {
      const script = ['8 eggs', 'curry cut', 'No chicken.', 'Not six pieces sir. I need only four.', 'cash', 'evening', '4', 'பண்ணு'];
      const w = at(ORG, 'whatsapp');
      await w('Hello, what do you have today?');
      const v = at(ORG, 'voice');
      let last: any[] = [];
      for (const m of script) {
        last = [await w(m), await v(m)];
        expect(last[1].draft.lines, m).toEqual(last[0].draft.lines);
        expect(last[1].state, m).toBe(last[0].state);
        expect(Boolean(last[1].draft.pickupAt), m).toBe(Boolean(last[0].draft.pickupAt));
      }
      expect(last[0].order?.status).toBe('created');
      expect(last[1].order?.total).toBe(last[0].order.total);
      expect(last[0].order.total).toBe(32);
    });

    // ---------------------------------------------------------------------------------------- round 6
    /** The live shop's shape: generic "chicken" belongs to Broiler (off today); Country Chicken and Quail are off too. */
    async function liveCatalogue() {
      const cat = await prisma.menuCategory.findFirst({ where: { organizationId: ORG, name: 'Chicken' } });
      for (const [name, aliases] of [
        ['Broiler Chicken', 'broiler, chicken, kozhi, கோழி'],
        ['Country Chicken', 'country chicken, nattu kozhi, nattukozhi, naatu kozhi, நாட்டுக்கோழி, நாட்டு கோழி'],
        ['Quail', 'quail, kaadai, காடை'],
      ]) {
        await prisma.menuItem.create({ data: { organizationId: ORG, categoryId: cat.id, name, price: 220, unit: 'kg', cutOptions: [], aliases, isDemo: true, available: false } });
      }
      await prisma.outlet.update({ where: { id: `${ORG}_shop` }, data: { opensAt: '07:00', closesAt: '21:00' } });
      catalog.invalidate(ORG);
    }
    const names = (r: any) => r.draft.lines.map((l: any) => `${l.quantity ?? '?'} ${l.name}`);
    const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, 'g')) ?? []).length;
    const drumQty = /How many kg of Chicken Drumsticks|How many kilos of Chicken Drumsticks|Chicken Drumsticks (ethana kg|எத்தனை கிலோ)/;

    it('S1. a specific product is never rejected because generic Broiler Chicken is off; one quantity question', async () => {
      await liveCatalogue();
      for (const ch of ['whatsapp', 'voice'] as const) {
        for (const [msg, product] of [
          ['Chicken leg piece.', 'Chicken Drumsticks'], ['chicken legs', 'Chicken Drumsticks'], ['leg piece', 'Chicken Drumsticks'], ['லெக் பீஸ்', 'Chicken Drumsticks'],
          ['chicken curry cut', 'Chicken Curry Cut'], ['chicken breast', 'Chicken Breast'], ['chicken wings', 'Chicken Wings'], ['boneless chicken', 'Boneless Chicken'],
        ]) {
          const say = at(ORG, ch);
          if (ch === 'whatsapp') await say('Hi');
          const r = await say(msg);
          expect(names(r), `${ch} ${msg}`).toEqual([`? ${product}`]);
          expect(r.response, `${ch} ${msg}`).not.toMatch(/Broiler|not available|inniku illa|இன்னைக்கு இல்ல/);
          if (product === 'Chicken Drumsticks') expect(count(r.response, drumQty), `${ch} ${msg}`).toBe(1);
        }
        // Generic "chicken" with an amount while Broiler is off: said truthfully, nothing added, the amount is kept for
        // the chicken they pick next.
        const g = at(ORG, ch);
        if (ch === 'whatsapp') await g('Hi');
        const generic = await g('1 kg chicken');
        expect(generic.draft.lines, ch).toEqual([]);
        expect(generic.response, ch).toMatch(/Broiler Chicken/);
        expect(names(await g('Chicken Curry Cut')), ch).toEqual(['1 Chicken Curry Cut']);
      }
    });

    it('S2. removing Eggs from an Eggs + Drumsticks cart keeps the Drumsticks, re-prices, and does not place the order', async () => {
      await liveCatalogue();
      const phrases = [
        'Remove eggs', 'Eggs வேண்டாம்', 'egg எடுத்துருங்க வேண்டாம்', 'ஆறு egg வேண்டாம்', 'Chicken மட்டும் போதும்', 'Egg மட்டும் வேண்டாம், chicken மட்டும்',
        'ஆ change பண்ணுங்க. egg-அ close பண்ணிடுங்க வேண்டாம்.',
        'ஆறு egg எடுத்துருங்க வேண்டாம் அது. ஆறு egg மட்டும் வேண்டாம். Chicken மட்டும் போதும்.',
      ];
      for (const ch of ['whatsapp', 'voice'] as const) {
        for (const msg of phrases) {
          const say = at(ORG, ch);
          if (ch === 'whatsapp') await say('Hi');
          await say('6 eggs');
          await say('2 kg leg piece');
          await say('cash');
          const review = await say('4 pm');
          expect(review.state).toBe('awaiting_confirmation');
          const r = await say(msg);
          expect(names(r), `${ch} ${msg}`).toEqual(['2 Chicken Drumsticks']);
          expect(r.order, `${ch} ${msg}`).toBeUndefined();
          expect(r.state, `${ch} ${msg}`).toBe('awaiting_confirmation'); // an updated review, waiting for a new yes
          expect(r.response, `${ch} ${msg}`).toMatch(/Eggs (eduthutten|எடுத்துட்டேன்)|Removed Eggs/);
          expect(r.response, `${ch} ${msg}`).toMatch(/₹600|600 ரூபாய்|600 rupees/);
          expect(r.response, `${ch} ${msg}`).not.toMatch(/Drumsticks (eduthutten|எடுத்துட்டேன்)|Removed Chicken Drumsticks|₹648|648/);
          if (ch === 'whatsapp' && msg === phrases[0]) {
            const placed = await say('yes');
            expect(placed.order.total).toBe(600);
          }
        }
      }
      // The opposite item, a product not in the cart, a contradiction, and a correction (not a removal).
      const base = async () => {
        const say = at(ORG, 'whatsapp');
        await say('Hi');
        await say('6 eggs');
        await say('2 kg leg piece');
        return say;
      };
      let say = await base();
      expect(names(await say('leg piece வேண்டாம்'))).toEqual(['6 Eggs']);
      say = await base();
      const wings = await say('wings வேண்டாம்');
      expect(names(wings)).toEqual(['6 Eggs', '2 Chicken Drumsticks']);
      expect(wings.response).not.toMatch(/eduthutten|எடுத்துட்டேன்|Removed/);
      say = await base();
      const clash = await say('eggs வேண்டாம், eggs மட்டும்');
      expect(names(clash)).toEqual(['6 Eggs', '2 Chicken Drumsticks']);
      expect(clash.response).toMatch(/Edhu eduthudanum|எதை எடுக்கணும்|Which one should I remove/);
      say = await base();
      expect(names(await say('ஆறு egg வேண்டாம், நாலு போதும்'))).toEqual(['4 Eggs', '2 Chicken Drumsticks']);
    });

    it('S3. Quail / Country Chicken meat / country-chicken eggs / regular eggs are told apart (English, Tamil, Tanglish)', async () => {
      await liveCatalogue();
      for (const ch of ['whatsapp', 'voice'] as const) {
        const say = at(ORG, ch);
        if (ch === 'whatsapp') await say('Hi');
        const quail = await say('quail availble ?');
        expect(quail.response, ch).toMatch(/Quail (inniku illa|இன்னைக்கு இல்ல|is not available)/);
        for (const msg of ['nattukozhi muttai', 'நாட்டுக்கோழி முட்டை இருக்கா', 'country chicken eggs']) {
          const r = await say(msg);
          expect(r.response, `${ch} ${msg}`).not.toMatch(/Country Chicken (inniku illa|இன்னைக்கு இல்ல|is not available|ippo stock illa|இப்போ stock இல்ல)/);
          expect(r.response, `${ch} ${msg}`).toMatch(/Country Chicken (muttai|முட்டை|eggs)/);
          expect(r.response, `${ch} ${msg}`).toMatch(/Eggs/);
          expect(r.draft.lines, `${ch} ${msg}`).toEqual([]); // nothing added until they accept regular eggs
        }
        const ok = await say('ok');
        expect(names(ok), ch).toEqual(['? Eggs']);
        expect(names(await say('6')), ch).toEqual(['6 Eggs']);
        const meat = await say('nattu kozhi 1 kg');
        expect(meat.response, ch).toMatch(/Country Chicken (inniku illa|இன்னைக்கு இல்ல|is not available)/);
        expect(names(meat), ch).toEqual(['6 Eggs']);
      }
      // An amount said with the egg kind is kept for when they accept regular eggs.
      const w = at(ORG, 'whatsapp');
      await w('Hi');
      await w('12 nattukozhi muttai');
      expect(names(await w('yes'))).toEqual(['12 Eggs']);
      // A shop whose egg product IS that kind ("Country Eggs", alias "nattu muttai") just takes the order.
      await prisma.menuItem.update({ where: { id: (await item('Eggs')).id }, data: { name: 'Country Eggs', aliases: 'egg, eggs, muttai, nattu muttai, முட்டை, நாட்டு முட்டை' } });
      catalog.invalidate(ORG);
      const c = at(ORG, 'whatsapp');
      await c('Hi');
      expect(names(await c('6 nattukozhi muttai'))).toEqual(['6 Country Eggs']);
    });

    it('S4. a bare "4" answers the question that is pending: egg quantity, pickup time, or a correction at the review', async () => {
      await liveCatalogue();
      for (const ch of ['whatsapp', 'voice'] as const) {
        const q = at(ORG, ch);
        if (ch === 'whatsapp') await q('Hi');
        await q('eggs');
        expect(names(await q('4')), ch).toEqual(['4 Eggs']);

        const t = at(ORG, ch);
        if (ch === 'whatsapp') await t('Hi');
        await t('3 eggs');
        await t('cash');
        const four = await t('4');
        expect(names(four), ch).toEqual(['3 Eggs']); // never 4 eggs
        expect(new Date(four.draft.pickupAt).toISOString(), ch).toBe(new Date(NOON.getTime() + 4 * 3600_000).toISOString()); // 4 PM IST today
        expect(four.state, ch).toBe('awaiting_confirmation');
        expect(count(four.response, /Order confirm பண்ணவா|Shall I place the order|Confirm panna|Reply \*Yes\*/), ch).toBe(1);

        const r = at(ORG, ch);
        if (ch === 'whatsapp') await r('Hi');
        await r('3 eggs');
        await r('cash');
        const review = await r('5 pm');
        const corrected = await r('4');
        expect(names(corrected), ch).toEqual(['4 Eggs']);
        expect(corrected.draft.pickupAt, ch).toBe(review.draft.pickupAt);
        expect(corrected.state, ch).toBe('awaiting_confirmation');
        expect(corrected.order, ch).toBeUndefined();
      }
      // The shop is closed at 4 (open 07:00–15:00): said, not stored, asked again.
      await prisma.outlet.update({ where: { id: `${ORG}_shop` }, data: { opensAt: '07:00', closesAt: '15:00' } });
      catalog.invalidate(ORG);
      const c = at(ORG, 'whatsapp');
      await c('Hi');
      await c('3 eggs');
      await c('cash');
      const closed = await c('4');
      expect(names(closed)).toEqual(['3 Eggs']);
      expect(closed.draft.pickupAt).toBeFalsy();
      expect(closed.response).toMatch(/won't work|mudiyaadhu|முடியாது/); // 4 PM is after closing; never moved to tomorrow silently
    });

    it('S5. the reported call: no repeated or contradictory prompts, the same cart on WhatsApp and voice, goodbye places nothing', async () => {
      await liveCatalogue();
      const script = ['Chicken leg piece.', 'என்னங்க bro, kg-ல.', 'leg piece.', 'ரெண்டு kilo.', '6 eggs', 'cash', '4 pm', 'Egg மட்டும் வேண்டாம், chicken மட்டும்', 'சரி Good Night'];
      const w = at(ORG, 'whatsapp');
      await w('Hi');
      const v = at(ORG, 'voice');
      for (const m of script) {
        const [a, b] = [await w(m), await v(m)];
        expect(b.draft.lines, m).toEqual(a.draft.lines);
        expect(b.state, m).toBe(a.state);
        expect(b.draft.payment, m).toBe(a.draft.payment);
        expect(b.draft.pickupAt, m).toBe(a.draft.pickupAt);
        for (const r of [a, b]) {
          expect(count(r.response, drumQty), m).toBeLessThanOrEqual(1);
          expect(r.response, m).not.toMatch(/Broiler|புரியல|puriyala|didn't understand/);
        }
        if (m === 'ரெண்டு kilo.') expect(names(b)).toEqual(['2 Chicken Drumsticks']);
        if (m === 'Egg மட்டும் வேண்டாம், chicken மட்டும்') expect(names(b)).toEqual(['2 Chicken Drumsticks']);
        if (m === 'சரி Good Night') {
          expect(b.endCall).toBe(true);
          expect(a.order).toBeUndefined();
          expect(b.order).toBeUndefined();
        }
      }
    });

    // ---------------------------------------------------------------------------------------- round 7
    const placedItems = async (orderId: string) =>
      (await prisma.orderItem.findMany({ where: { orderId }, orderBy: { name: 'asc' } })).map((i: any) => ({ menuItemId: i.menuItemId, qty: Number(i.quantity), unitPrice: Number(i.unitPrice), lineTotal: Number(i.lineTotal) }));
    const ordersFor = async (p: string) => prisma.order.count({ where: { organizationId: ORG, customer: { phone: `91${p}` } } });

    it('T-A. a fresh call asking for chicken never gets the WhatsApp eggs draft or its review; repeating gives the same answer; other customers see nothing', async () => {
      await liveCatalogue();
      const p = phone();
      const w = (m: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: p, message: m, customerName: 'Priya', now: NOON });
      await w('Hi');
      await w('6 eggs');
      await w('cash');
      expect((await w('naalaikku madhiyam 2 mani')).state).toBe('awaiting_confirmation');
      await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c-${p}` });
      const v = (m: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: p, message: m, now: NOON, metadata: { callId: `c-${p}`, sttLanguage: 'ta-IN' } });
      for (const m of ['எனக்கு ரெண்டு kilo chicken வேணும்.', 'எனக்கு ரெண்டு kilo chicken வேணும்.', 'எனக்கு 2 kg country chicken வேணும்.']) {
        const r = await v(m);
        expect(r.draft.lines, m).toEqual([]); // no eggs from the other channel
        expect(r.state, m).toBe('collecting'); // no review armed
        expect(r.response, m).not.toMatch(/Eggs.*48|Order confirm|place the order/);
        expect(r.draft.payment, m).toBeUndefined();
        expect(r.draft.pickupAt, m).toBeUndefined();
      }
      expect((await v('சரி')).order).toBeUndefined(); // a yes cannot place anything
      expect(await ordersFor(p)).toBe(0);
      // Another customer at the same shop: nothing of this.
      const other = await engine.generate({ organizationId: ORG, channel: 'voice', phone: phone(), message: 'சரி', now: NOON });
      expect(other.draft.lines).toEqual([]);
      // A returning caller with their own earlier call's cart: offered, restored only on "continue" / yes.
      const q = phone();
      await engine.openVoiceSession({ organizationId: ORG, phone: q, openingText: 'opening', callId: `c1-${q}` });
      const v1 = (m: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: q, message: m, now: NOON, metadata: { callId: `c1-${q}`, sttLanguage: 'ta-IN' } });
      await v1('6 eggs');
      await engine.openVoiceSession({ organizationId: ORG, phone: q, openingText: 'opening', callId: `c2-${q}` });
      const offer = await v1('வணக்கம்');
      expect(offer.draft.lines).toEqual([]);
      expect(offer.response).toMatch(/6 pcs Eggs.*continue பண்ணலாமா/);
      expect(names(await v1('சரி'))).toEqual(['6 Eggs']);
    });

    it('T-B. country chicken / broiler curry cut: answered from the inventory both ways, never swapped for another product without a yes', async () => {
      await liveCatalogue();
      const curry = await item('Chicken Curry Cut');
      for (const ch of ['whatsapp', 'voice'] as const) {
        for (const m of ['எனக்கு 2 kg country chicken வேணும்.', '2 kg nattukozhi', 'ரெண்டு கிலோ நாட்டு கோழி கறி கட்', 'நாட்டு கோழி']) {
          const say = at(ORG, ch);
          if (ch === 'whatsapp') await say('Hi');
          await say('6 eggs');
          const r = await say(m);
          expect(r.response, `${ch} ${m}`).toMatch(/Country Chicken (inniku illa|இன்னைக்கு இல்ல|is not available)/);
          expect(names(r), `${ch} ${m}`).toEqual(['6 Eggs']); // eggs kept, nothing added
          expect(r.state, `${ch} ${m}`).toBe('collecting');
        }
        // "broiler curry cut" while Broiler is off: Chicken Curry Cut is OFFERED; added (with the amount said) only on yes.
        const b = at(ORG, ch);
        if (ch === 'whatsapp') await b('Hi');
        const offer = await b('2 kg broiler curry cut');
        expect(offer.draft.lines, ch).toEqual([]);
        expect(offer.response, ch).toMatch(/Broiler Chicken/);
        expect(offer.response, ch).toMatch(/Chicken Curry Cut/);
        const yes = await b(ch === 'voice' ? 'சரி' : 'sari');
        expect(names(yes), ch).toEqual(['2 Chicken Curry Cut']);
      }
      // The same words when the inventory HAS Country Chicken / Broiler: that product, with the cut.
      await prisma.menuItem.updateMany({ where: { organizationId: ORG, name: { in: ['Country Chicken', 'Broiler Chicken'] } }, data: { available: true, stockQty: 10, cutOptions: ['Curry cut', 'Biryani cut'] } });
      catalog.invalidate(ORG);
      const w = at(ORG, 'whatsapp');
      await w('Hi');
      const country = await w('ரெண்டு கிலோ நாட்டு கோழி கறி கட்');
      expect(country.draft.lines).toEqual([expect.objectContaining({ name: 'Country Chicken', quantity: 2, cut: 'Curry cut' })]);
      const w2 = at(ORG, 'whatsapp');
      await w2('Hi');
      const broiler = await w2('1 kg broiler curry cut');
      expect(broiler.draft.lines).toEqual([expect.objectContaining({ name: 'Broiler Chicken', quantity: 1, cut: 'Curry cut' })]);
      expect(curry.available).toBe(true);
    });

    it('T-F. short numeric answers at every step: product, quantity, payment, pickup (4 = 4 PM, 8 = asked), review', async () => {
      await liveCatalogue();
      for (const ch of ['whatsapp', 'voice'] as const) {
        const say = at(ORG, ch);
        if (ch === 'whatsapp') await say('Hi');
        const product = await say('7'); // nothing chosen yet: kept, and the product is asked
        expect(product.draft.lines, ch).toEqual([]);
        expect(names(await say('Eggs')), ch).toEqual(['7 Eggs']);
        const pay = await say('2'); // the payment question is pending: never a new quantity
        expect(names(pay), ch).toEqual(['7 Eggs']);
        expect(pay.draft.payment, ch).toBeUndefined();
        expect((await say('UPI shop la pay pandren')).draft.payment, ch).toBe('upi_at_shop');
        const eight = await say('8'); // 8 AM and 8 PM are both inside 07:00–21:00: asked, not guessed
        expect(eight.draft.pickupAt, ch).toBeFalsy();
        expect(eight.response, ch).toMatch(/AM.*PM/);
        expect(names(eight), ch).toEqual(['7 Eggs']);
        const pm = await say('evening');
        expect(new Date(pm.draft.pickupAt).toISOString(), ch).toBe(new Date(NOON.getTime() + 8 * 3600_000).toISOString());
        expect(pm.state, ch).toBe('awaiting_confirmation');
        const corrected = await say('6'); // at the review: a quantity correction, re-reviewed, not placed
        expect(names(corrected), ch).toEqual(['6 Eggs']);
        expect(corrected.order, ch).toBeUndefined();
        const four = at(ORG, ch);
        if (ch === 'whatsapp') await four('Hi');
        await four('7 eggs');
        await four('UPI');
        const r = await four('4');
        expect(names(r), ch).toEqual(['7 Eggs']);
        expect(new Date(r.draft.pickupAt).toISOString(), ch).toBe(new Date(NOON.getTime() + 4 * 3600_000).toISOString());
        expect((await four('eve 4 pm')).draft.pickupAt, ch).toBe(r.draft.pickupAt);
      }
    });

    it('T-G. review → "No" → edit → yes places ONE order for the edited cart; a stale review can never confirm a changed cart; repeated yes = same order', async () => {
      await liveCatalogue();
      const p = phone();
      const say = (m: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: p, message: m, customerName: 'Priya', now: NOON });
      await say('Hi');
      await say('6 eggs, cash, 5 pm');
      expect((await say('No')).order).toBeUndefined();
      const edited = await say('4 eggs');
      expect(edited.state).toBe('awaiting_confirmation');
      // The cart changes behind the review (e.g. a second device / channel) — the old review's yes must not place it.
      const store = (engine as any).store;
      const key = engine.sessionKey({ organizationId: ORG, channel: 'whatsapp', phone: p });
      const s = await store.get(key);
      s.lines[0].quantity = 9;
      await store.save(s);
      const stale = await say('yes');
      expect(stale.order).toBeUndefined();
      expect(stale.response).toMatch(/9 pcs Eggs|₹72/);
      const placed = await say('yes');
      expect(placed.order.status).toBe('created');
      expect(placed.order.total).toBe(72);
      const eggs = await item('Eggs');
      expect(await placedItems(placed.order.id)).toEqual([{ menuItemId: eggs.id, qty: 9, unitPrice: 8, lineTotal: 72 }]);
      const again = await say('yes');
      expect(again.order?.id ?? placed.order.id).toBe(placed.order.id);
      expect(await ordersFor(p)).toBe(1);
      // A change that keeps the same total (the pickup time) also needs a new review: the yes is bound to the version.
      const p2 = phone();
      const say2 = (m: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: p2, message: m, customerName: 'Priya', now: NOON });
      await say2('Hi');
      expect((await say2('6 eggs, cash, 5 pm')).state).toBe('awaiting_confirmation');
      const key2 = engine.sessionKey({ organizationId: ORG, channel: 'whatsapp', phone: p2 });
      const s2 = await store.get(key2);
      s2.pickupAt = new Date(new Date(s2.pickupAt).getTime() + 3600_000).toISOString(); // 6 PM, same ₹48
      await store.save(s2);
      const staleTime = await say2('yes');
      expect(staleTime.order).toBeUndefined();
      expect(staleTime.response).toMatch(/6 PM|6 mani/);
      expect((await say2('yes')).order.status).toBe('created');
      // Goodbye at a review never places it.
      const g = at(ORG, 'whatsapp');
      await g('Hi');
      await g('6 eggs, cash, 5 pm');
      const bye = await g('சரி Good Night');
      expect(bye.order).toBeUndefined();
      expect(bye.state).toBe('collecting');
    });

    it('T-K. offer boundaries follow the configured minimum: below → no discount, at → applied, above → applied; records add up', async () => {
      await resetOrg(OTHER);
      await seed.seedDemoInventory(prisma, { organizationId: OTHER });
      await prisma.offerCampaign.deleteMany({ where: { organizationId: OTHER } });
      await prisma.offerCampaign.create({ data: { organizationId: OTHER, name: 'Min 96 test', code: 'GRMIN96', amount: 50, minOrderValue: 96, validDays: 7, active: true } });
      try {
        for (const [eggs, subtotal, discount] of [[11, 88, 0], [12, 96, 50], [13, 104, 50]]) {
          const say = at(OTHER, 'whatsapp');
          await say('Hi');
          const review = await say(`${eggs} eggs, cash, 6 pm`);
          expect(review.response, `${eggs}`).toContain(`₹${subtotal}`);
          const o = await say('yes');
          const row = await prisma.order.findUnique({ where: { id: o.order.id } });
          expect([Number(row.subtotal), Number(row.discount), Number(row.total)], `${eggs} eggs`).toEqual([subtotal, discount, subtotal - discount]);
          expect(o.order.total).toBe(subtotal - discount);
          expect(Number(row.total)).toBeGreaterThanOrEqual(0);
        }
      } finally {
        await prisma.offerClaim.deleteMany({ where: { organizationId: OTHER } });
        await prisma.order.deleteMany({ where: { organizationId: OTHER } });
        await prisma.offerCampaign.deleteMany({ where: { organizationId: OTHER } });
      }
    });

    it('T-L. WhatsApp, voice and the dashboard test chat apply the same rules: same cart, product ids, state, pickup, total', async () => {
      await liveCatalogue();
      const script = ['Hi', 'Chicken leg piece', 'ரெண்டு kilo', '6 eggs', 'egg வேண்டாம்', 'cash', '4', 'பண்ணு'];
      const runs: any[][] = [];
      for (const ch of ['whatsapp', 'voice', 'test'] as const) {
        const p = phone();
        if (ch === 'voice') await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c-${p}` });
        const out: any[] = [];
        for (const m of script) out.push(await engine.generate({ organizationId: ORG, channel: ch, phone: p, message: m, customerName: 'Priya', now: NOON, metadata: ch === 'voice' ? { callId: `c-${p}`, sttLanguage: 'ta-IN' } : undefined }));
        runs.push(out);
      }
      script.forEach((m, i) => {
        for (const r of runs.slice(1)) {
          expect(r[i].draft.lines, m).toEqual(runs[0][i].draft.lines);
          expect(r[i].state, m).toBe(runs[0][i].state);
          expect(r[i].draft.pickupAt, m).toBe(runs[0][i].draft.pickupAt);
          expect(r[i].draft.payment, m).toBe(runs[0][i].draft.payment);
        }
      });
      const drum = await item('Chicken Drumsticks');
      for (const r of runs) {
        const last = r[r.length - 1];
        expect(last.order?.status).toBe('created');
        expect(last.order.total).toBe(600);
        expect(await placedItems(last.order.id)).toEqual([{ menuItemId: drum.id, qty: 2, unitPrice: 300, lineTotal: 600 }]);
      }
    });

    // ---------------------------------------------------------------------------------------- round 8 (live call 14 Oct)
    it('T-M. "not wings leg" removes only Wings; an old call draft is set aside silently; "மூணு கிலோ" eggs → "3 Eggs?"; noise re-asks without the model', async () => {
      await liveCatalogue();
      for (const ch of ['whatsapp', 'voice'] as const) {
        const say = at(ORG, ch);
        if (ch === 'whatsapp') await say('Hi');
        await say('wings venum leg piece um venum');
        await say('2 kg');
        const not = await say('not wings leg');
        expect(names(not), ch).toEqual(['2 Chicken Drumsticks']); // it removed BOTH before
        expect(not.response, ch).toMatch(/Removed Chicken Wings|Chicken Wings (eduthutten|எடுத்துட்டேன்)/);
        expect(not.response, ch).not.toMatch(/Drumsticks (eduthutten|எடுத்துட்டேன்)|Removed Chicken Wings, Chicken Drumsticks/);
        const soon = await say('with in 30 mins');
        expect(soon.response, ch).not.toMatch(/30 minutes to cut|30 nimisham aagum|30 நிமிஷம் ஆகும்/); // asked for exactly the prep time
        expect(soon.draft.pickupAt, ch).toBeTruthy();
        // "not wings, leg piece" with only Wings in the cart: Wings go, Drumsticks come in.
        const swap = at(ORG, ch);
        if (ch === 'whatsapp') await swap('Hi');
        await swap('1 kg wings');
        expect(names(await swap('not wings, leg piece')), ch).toEqual(['? Chicken Drumsticks']);
        // "eggs and leg piece venam": both go.
        const both = at(ORG, ch);
        if (ch === 'whatsapp') await both('Hi');
        await both('6 eggs');
        await both('1 kg leg piece');
        await both('1 kg wings');
        expect(names(await both('eggs and leg piece venam')), ch).toEqual(['1 Chicken Wings']);
      }
      // The call: a cart left by an EARLIER call is not announced to a caller asking for something else.
      const p = phone();
      const v = (m: string) => engine.generate({ organizationId: ORG, channel: 'voice', phone: p, message: m, now: NOON, metadata: { callId: `c-${p}`, sttLanguage: 'ta-IN' } });
      await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c1-${p}` });
      await v('6 eggs');
      await engine.openVoiceSession({ organizationId: ORG, phone: p, openingText: 'opening', callId: `c2-${p}` });
      const country = await v('Country Chicken.');
      expect(country.response).not.toMatch(/தனியா வெச்சுட்டேன்|set .* aside/);
      expect(country.response).toMatch(/Country Chicken இன்னைக்கு இல்ல/);
      expect(country.draft.lines).toEqual([]);
      const kilo = await v('egg வந்து மூணு கிலோ.');
      expect(kilo.response).toMatch(/3 Eggs போடலாமா/);
      expect(names(kilo)).toEqual(['? Eggs']);
      const again = await v('மூணு மூணு மூணு kg.');
      expect(again.response).toMatch(/3 Eggs போடலாமா/);
      // Garbled speech while we wait: the same question again, rules only — even with a model configured.
      const llm = (engine as any).llm;
      llm.run.mockClear();
      const saved = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-not-used';
      try {
        const noise = await v('நீ நீ.');
        expect(noise.path).toBe('rules');
        expect(noise.response).toMatch(/புரியல.*3 Eggs போடலாமா/);
        expect(llm.run).not.toHaveBeenCalled();
      } finally {
        if (saved === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = saved;
      }
      expect(names(await v('சரி'))).toEqual(['3 Eggs']);
      // "இல்ல" to the suggestion: the count is asked, nothing set.
      const q = phone();
      const w = (m: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: q, message: m, customerName: 'Priya', now: NOON });
      await w('Hi');
      await w('eggs 2 kg');
      const no = await w('illa');
      expect(names(no)).toEqual(['? Eggs']);
      expect(no.response).toMatch(/Eggs ethana venum/);
    });

    it('Tamil and Tanglish: the same answers from the same data', async () => {
      const tl = await wa(phone())('boneless irukka?');
      expect(tl.response).toContain('Boneless Chicken irukku ✅ — ₹360/kg');
      const ta = await wa(phone())('போன்லெஸ் இருக்கா?');
      expect(ta.response).toContain('Boneless Chicken இருக்கு ✅ — ₹360/kg');
    });
  });
});
