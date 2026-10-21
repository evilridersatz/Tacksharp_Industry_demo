/**
 * Restaurant & food ordering, hotel & room booking and hospital & healthcare, against the real MySQL test database:
 * backend pricing and validation, idempotent orders / bookings / appointments, concurrency (no overbooking, no double
 * booked slots), status transitions, the WhatsApp assistants end to end (rules only, no model), follow-ups in DRY_RUN,
 * opt-out, handoff, tenant isolation, and GR Chicken routing kept on its own engine.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/verticals.integration.spec.ts
 *
 * FAKE: nothing is sent (DRY_RUN=true); the LLM runner is never called by these assistants.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const FOOD = 'org_vt_food';
const HOTEL = 'org_vt_hotel';
const HOSP = 'org_vt_hospital';
const OTHER = 'org_vt_other';
const GR = 'org_vt_gr';
const ORGS = [FOOD, HOTEL, HOSP, OTHER, GR];
let n = 0;
const phone = () => `9196${String(Date.now()).slice(-6)}${String(n++).padStart(2, '0')}`;

describe.skipIf(!enabled)('Food, hotel and hospital modules (integration)', () => {
  let prisma: any, food: any, hotel: any, hospital: any, assistant: any, vfu: any, settings: any, ai: any, conversations: any;
  let c: any; // common helpers module
  const ids: Record<string, string> = {};

  async function wipe() {
    const where = { organizationId: { in: ORGS } };
    await prisma.agentSession.deleteMany({ where });
    await prisma.reservation.deleteMany({ where });
    await prisma.roomRate.deleteMany({ where });
    await prisma.room.deleteMany({ where });
    await prisma.roomType.deleteMany({ where });
    await prisma.insuranceCase.deleteMany({ where });
    await prisma.appointment.deleteMany({ where });
    await prisma.doctor.deleteMany({ where });
    await prisma.department.deleteMany({ where });
    await prisma.orderEvent.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.menuItem.deleteMany({ where });
    await prisma.menuCategory.deleteMany({ where });
    await prisma.outlet.deleteMany({ where });
    await prisma.auditEvent.deleteMany({ where });
    await prisma.followUp.deleteMany({ where });
    await prisma.message.deleteMany({ where });
    await prisma.conversation.deleteMany({ where });
    await prisma.lead.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
  }

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    c = await import('../src/verticals/common.js');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { LeadsService } = await import('../src/leads/leads.service.js');
    const { FollowUpsService } = await import('../src/follow-ups/follow-ups.service.js');
    const { FoodService } = await import('../src/verticals/food/food.service.js');
    const { HotelService } = await import('../src/verticals/hotel/hotel.service.js');
    const { HospitalService } = await import('../src/verticals/hospital/hospital.service.js');
    const { FoodAgent } = await import('../src/verticals/food/food-agent.js');
    const { HotelAgent } = await import('../src/verticals/hotel/hotel-agent.js');
    const { HospitalAgent } = await import('../src/verticals/hospital/hospital-agent.js');
    const { VerticalFollowUps } = await import('../src/verticals/vertical-followups.service.js');
    const { VerticalAssistant } = await import('../src/verticals/vertical-assistant.service.js');
    const { AgentSessionStore } = await import('../src/verticals/common.js');
    const { AiService } = await import('../src/ai/ai.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, name, vertical] of [[FOOD, 'VT Cafe', 'real_estate'], [HOTEL, 'VT Grand Hotel', 'real_estate'], [HOSP, 'VT Care Hospital', 'real_estate'], [OTHER, 'VT Other', 'real_estate'], [GR, 'VT Chicken', 'restaurant']] as const)
      await prisma.organization.upsert({ where: { id }, update: { vertical, name }, create: { id, name, vertical } });
    await wipe();
    const put = (id: string, data: unknown) => prisma.organizationSettings.upsert({ where: { organizationId: id }, update: { data }, create: { organizationId: id, data } });
    await put(FOOD, { industry: 'food', food: { taxPct: 5, packagingFee: 10, pickupEnabled: true, deliveryEnabled: true, deliveryZones: [{ name: 'Anna Nagar', keywords: ['anna nagar'], fee: 30, minOrder: 200, etaMinutes: 30 }] } });
    await put(HOTEL, { industry: 'hotel', hotel: { taxPct: 12, autoConfirm: false, holdMinutes: 60, depositPct: 20, freeCancellationHours: 24 } });
    await put(HOSP, { industry: 'hospital', hospital: { emergencyNumber: '108', bookingWindowDays: 14, reminderHoursBefore: 24 } });
    await put(OTHER, { industry: 'food' });
    await put(GR, { industry: 'food' }); // ignored: a restaurant vertical always runs the GR engine

    settings = new SettingsService(prisma);
    conversations = new ConversationsService(prisma);
    const leads = new LeadsService(prisma);
    const followUps = new FollowUpsService(prisma, settings);
    food = new FoodService(prisma, settings);
    hotel = new HotelService(prisma, settings);
    hospital = new HospitalService(prisma, settings);
    vfu = new VerticalFollowUps(prisma, followUps, leads, settings, conversations, undefined);
    assistant = new VerticalAssistant(prisma, conversations, leads, followUps, new AgentSessionStore(prisma), new FoodAgent(food, vfu, settings), new HotelAgent(hotel, vfu), new HospitalAgent(prisma, hospital, vfu));
    const ordering = { generate: vi.fn(async () => ({ conversationId: 'x', customerId: 'x', leadId: 'x', response: 'GR ENGINE', actions: {}, timings: {}, path: 'rules', state: 'idle', intent: 'unknown', draft: { lines: [] } })) };
    ai = new AiService({ generate: vi.fn(async () => ({ response: 'RE ENGINE' })) } as any, { vertical: async (org: string) => (org === GR ? 'restaurant' : 'real_estate') } as any, ordering as any, settings, assistant);

    // Food fixtures: always-open outlet, items with variants / add-ons / tracked stock.
    await prisma.outlet.create({ data: { id: 'vt_out', organizationId: FOOD, name: 'VT Cafe Anna Nagar', address: '2nd Ave, Anna Nagar', opensAt: '00:00', closesAt: '23:59', acceptOutsideHours: true, prepMinutes: 20 } });
    const cat = await prisma.menuCategory.create({ data: { organizationId: FOOD, name: 'Tiffin' } });
    const bev = await prisma.menuCategory.create({ data: { organizationId: FOOD, name: 'Beverages' } });
    const item = (name: string, categoryId: string, price: number, extra: Record<string, unknown> = {}) => prisma.menuItem.create({ data: { organizationId: FOOD, categoryId, name, price, unit: 'piece', cutOptions: [], minQty: 1, maxQty: 20, qtyStep: 1, ...extra } });
    ids.dosa = (await item('Masala Dosa', cat.id, 90, { isVeg: true, addOns: [{ name: 'Extra Chutney', price: 15 }] })).id;
    ids.idli = (await item('Idli', cat.id, 40, { isVeg: true, stockQty: 3 })).id;
    ids.vada = (await item('Medu Vada', cat.id, 35, { isVeg: true, stockQty: 0 })).id;
    ids.coffee = (await item('Cold Coffee', bev.id, 120, { isVeg: true, variants: [{ name: 'Regular', price: 120 }, { name: 'Large', price: 160 }], addOns: [{ name: 'Extra Shot', price: 30 }], taxRatePct: 18 })).id;
    await prisma.outlet.create({ data: { organizationId: OTHER, name: 'Other outlet', address: 'x', opensAt: '00:00', closesAt: '23:59', acceptOutsideHours: true } });

    // Hotel fixtures: 2 deluxe rooms (1 more out of service), 1 suite; weekend + seasonal rates.
    const deluxe = await prisma.roomType.create({ data: { organizationId: HOTEL, code: 'DLX', name: 'Deluxe Room', maxAdults: 2, maxChildren: 1, maxOccupancy: 3, baseRate: 3000, weekendRate: 3600, amenities: ['WiFi', 'Breakfast'] } });
    const suite = await prisma.roomType.create({ data: { organizationId: HOTEL, code: 'STE', name: 'Family Suite', maxAdults: 4, maxChildren: 2, maxOccupancy: 5, baseRate: 6000, amenities: ['WiFi'] } });
    ids.deluxe = deluxe.id;
    ids.suite = suite.id;
    await prisma.room.createMany({ data: [{ organizationId: HOTEL, roomTypeId: deluxe.id, number: '101' }, { organizationId: HOTEL, roomTypeId: deluxe.id, number: '102' }, { organizationId: HOTEL, roomTypeId: deluxe.id, number: '103', status: 'out_of_service' }, { organizationId: HOTEL, roomTypeId: suite.id, number: '201' }] });

    // Hospital fixtures: one doctor available every day 09:00-12:00, 15-minute slots.
    const dept = await prisma.department.create({ data: { organizationId: HOSP, name: 'Cardiology' } });
    const ortho = await prisma.department.create({ data: { organizationId: HOSP, name: 'Orthopaedics' } });
    const all = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '09:00', end: '12:00' }));
    ids.dr = (await prisma.doctor.create({ data: { organizationId: HOSP, departmentId: dept.id, name: 'Dr. Meera Krishnan', specialty: 'Cardiologist', consultationFee: 800, slotMinutes: 15, schedule: all } })).id;
    ids.ortho = (await prisma.doctor.create({ data: { organizationId: HOSP, departmentId: ortho.id, name: 'Dr. Arjun Rao', specialty: 'Orthopaedic surgeon', consultationFee: 700, slotMinutes: 20, schedule: all } })).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.$disconnect();
  });

  const chat = (org: string, p: string) => (message: string) => ai.generateResponse({ organizationId: org, channel: 'whatsapp', phone: p, message });

  // ================================================================== food

  describe('food ordering', () => {
    it('prices carts on the server: variants, add-ons, per-item tax, packaging and delivery fee', async () => {
      const q = await food.quote(FOOD, { lines: [{ itemId: ids.dosa, quantity: 2, addOns: ['Extra Chutney'] }, { itemId: ids.coffee, quantity: 1, variant: 'Large', addOns: ['extra shot'] }], fulfilment: 'delivery', address: '12 Main Rd, Anna Nagar' });
      expect(q.ok).toBe(true);
      expect(q.lines.map((l: any) => [l.unitPrice, l.lineTotal])).toEqual([[105, 210], [190, 190]]);
      expect(q.subtotal).toBe(400);
      expect(q.tax).toBe(c.money(210 * 0.05 + 190 * 0.18));
      expect(q.packagingFee).toBe(10);
      expect(q.deliveryFee).toBe(30);
      expect(q.total).toBe(c.money(400 + q.tax + 10 + 30));
    });

    it('refuses invalid carts: missing size, unknown add-on, sold out, over stock, undeliverable area, minimum order', async () => {
      const q = await food.quote(FOOD, { lines: [{ itemId: ids.coffee, quantity: 1 }, { itemId: ids.dosa, quantity: 1, addOns: ['cheese'] }, { itemId: ids.vada, quantity: 1 }, { itemId: ids.idli, quantity: 5 }], fulfilment: 'delivery', address: 'Velachery' });
      expect(q.ok).toBe(false);
      const p = q.problems.join(' | ');
      expect(p).toMatch(/choose Regular \/ Large/);
      expect(p).toMatch(/cheese.*not an available add-on/);
      expect(p).toMatch(/Medu Vada is sold out/);
      expect(p).toMatch(/Only 3 Idli left/);
      expect(p).toMatch(/do not deliver/);
      const small = await food.quote(FOOD, { lines: [{ itemId: ids.idli, quantity: 1 }], fulfilment: 'delivery', address: 'Anna Nagar' });
      expect(small.problems.join(' ')).toMatch(/Minimum order/);
    });

    it('WhatsApp order end to end: cart → pickup → confirm → exactly one order with the quoted total', async () => {
      const p = phone();
      const send = chat(FOOD, p);
      const r1 = await send('Hi, I want 2 masala dosa with extra chutney and 1 cold coffee');
      expect(r1.response).toMatch(/Which size for Cold Coffee/);
      const r2 = await send('large');
      expect(r2.response).toMatch(/Total/);
      expect(r2.response).toMatch(/PICKUP or DELIVERY/);
      const r3 = await send('pickup');
      expect(r3.response).toMatch(/Reply YES to place the order/);
      const quote = await food.quote(FOOD, { lines: [{ itemId: ids.dosa, quantity: 2, addOns: ['Extra Chutney'] }, { itemId: ids.coffee, quantity: 1, variant: 'Large' }], fulfilment: 'pickup' });
      expect(r3.response).toContain(c.inr(quote.total));
      const r4 = await send('yes');
      expect(r4.actions.outcome).toBe('order_placed');
      expect(r4.record.result).toBe('created');
      const o = await food.get(FOOD, r4.record.id);
      expect(o.total).toBe(quote.total);
      expect(o.status).toBe('pending');
      expect(o.fulfilment).toBe('pickup');
      // A repeated "yes" (webhook retry / double tap) does not create a second order.
      await send('yes');
      expect(await prisma.order.count({ where: { organizationId: FOOD, customerPhone: p } })).toBe(1);
      const status = await send('what is my order status?');
      expect(status.response).toContain(o.orderNumber);
      expect(status.response).toMatch(/Order received/);
    });

    it('placeOrder is idempotent and stock-safe; cancellation restocks', async () => {
      const cust = await conversations.getOrCreateCustomerByPhone(FOOD, phone(), { name: 'Idli fan' });
      const base = { customerId: cust.id, channel: 'test', lines: [{ itemId: ids.idli, quantity: 2 }], fulfilment: 'pickup', actor: 'test' };
      const a = await food.placeOrder(FOOD, { ...base, idempotencyKey: 'k-idli-1' });
      const b = await food.placeOrder(FOOD, { ...base, idempotencyKey: 'k-idli-1' });
      expect(a.status).toBe('created');
      expect(b.status).toBe('duplicate');
      expect(b.order.id).toBe(a.order.id);
      expect(Number((await prisma.menuItem.findUnique({ where: { id: ids.idli } })).stockQty)).toBe(1);
      await expect(food.placeOrder(FOOD, { ...base, idempotencyKey: 'k-idli-2' })).rejects.toThrow(/Only 1 Idli left/);
      await food.setStatus(FOOD, a.order.id, 'cancelled', 'test');
      expect(Number((await prisma.menuItem.findUnique({ where: { id: ids.idli } })).stockQty)).toBe(3);
    });

    it('enforces the order lifecycle and keeps tenants apart', async () => {
      const cust = await conversations.getOrCreateCustomerByPhone(FOOD, phone(), {});
      const { order } = await food.placeOrder(FOOD, { customerId: cust.id, channel: 'test', lines: [{ itemId: ids.dosa, quantity: 1 }], fulfilment: 'pickup', actor: 'test', idempotencyKey: `k-${Date.now()}` });
      await expect(food.setStatus(FOOD, order.id, 'completed', 'test')).rejects.toThrow(/Cannot move/);
      await expect(food.setStatus(FOOD, order.id, 'dispatched', 'test')).rejects.toThrow(/Cannot move/);
      await food.setStatus(FOOD, order.id, 'confirmed', 'test');
      await food.setStatus(FOOD, order.id, 'preparing', 'test');
      await food.setStatus(FOOD, order.id, 'ready', 'test');
      const done = await food.setStatus(FOOD, order.id, 'completed', 'test');
      expect(done.events.map((e: any) => e.to).filter(Boolean)).toEqual(['pending', 'confirmed', 'preparing', 'ready', 'completed']);
      await expect(food.get(OTHER, order.id)).rejects.toThrow(/not found/i);
      expect((await food.list(OTHER)).length).toBe(0);
    });

    it('a delivery order through chat checks the zone; complaints hand over to staff', async () => {
      const p = phone();
      const send = chat(FOOD, p);
      await send('3 masala dosa');
      await send('delivery');
      const bad = await send('Flat 4, 2nd street, Tambaram');
      expect(bad.response).toMatch(/do not deliver/);
      const ok = await send('Flat 4, 2nd street, Anna Nagar West');
      expect(ok.response).toMatch(/Delivery to/);
      expect(ok.response).toMatch(/Reply YES/);
      const placed = await send('yes');
      expect(placed.record.type).toBe('order');
      expect((await food.get(FOOD, placed.record.id)).deliveryZone).toBe('Anna Nagar');
      const complaint = await send('my food came cold and one item is missing');
      expect(complaint.actions.handoff).toBe(true);
      const conv = await prisma.conversation.findFirst({ where: { organizationId: FOOD, externalId: { contains: p.slice(-8) } } });
      expect(conv.status).toBe('human_handoff');
      expect(await prisma.followUp.count({ where: { organizationId: FOOD, channel: 'human', status: 'open' } })).toBeGreaterThan(0);
    });

    it('sold-out items are refused with alternatives; the menu comes from the database', async () => {
      const send = chat(FOOD, phone());
      const r = await send('2 medu vada please');
      expect(r.response).toMatch(/Medu Vada is sold out/);
      const m = await send('menu');
      expect(m.response).toContain('Masala Dosa');
      expect(m.response).toContain('₹90');
      expect(m.response).toMatch(/Medu Vada.*sold out/);
    });

    it('status follow-ups run in DRY_RUN as SIMULATED, re-check state, and respect STOP', async () => {
      const cust = await conversations.getOrCreateCustomerByPhone(FOOD, phone(), { name: 'Priya' });
      const { order } = await food.placeOrder(FOOD, { customerId: cust.id, channel: 'test', lines: [{ itemId: ids.dosa, quantity: 1 }], fulfilment: 'pickup', actor: 'test', idempotencyKey: `k-fu-${Date.now()}` });
      await food.setStatus(FOOD, order.id, 'confirmed', 'test');
      await vfu.onFoodStatus(FOOD, { id: order.id, customerId: cust.id, status: 'confirmed' });
      await vfu.onFoodStatus(FOOD, { id: order.id, customerId: cust.id, status: 'confirmed' }); // dedupe
      const rows = await prisma.followUp.findMany({ where: { organizationId: FOOD, customerId: cust.id, source: 'food' } });
      expect(rows).toHaveLength(1);
      const r = await vfu.execute(rows[0].id);
      expect(r.status).toBe('simulated');
      expect(r.text).toMatch(/accepted/);
      const msg = await prisma.message.findFirst({ where: { organizationId: FOOD, content: { contains: order.orderNumber } }, orderBy: { createdAt: 'desc' } });
      expect(msg.metadata.simulated).toBe(true);
      // Stale step: status moved on -> skipped. Opted out -> cancelled.
      await food.setStatus(FOOD, order.id, 'preparing', 'test');
      await vfu.onFoodStatus(FOOD, { id: order.id, customerId: cust.id, status: 'ready' });
      const ready = await prisma.followUp.findFirst({ where: { organizationId: FOOD, message: `food:status:${order.id}:ready` } });
      expect((await vfu.execute(ready.id)).reason).toBe('status_now_preparing');
      await food.setStatus(FOOD, order.id, 'cancelled', 'test');
      await prisma.customer.update({ where: { id: cust.id }, data: { optedOutAt: new Date() } });
      await vfu.onFoodStatus(FOOD, { id: order.id, customerId: cust.id, status: 'cancelled' });
      const cancelled = await prisma.followUp.findFirst({ where: { organizationId: FOOD, message: `food:status:${order.id}:cancelled` } });
      expect((await vfu.execute(cancelled.id)).status).toBe('cancelled');
    });

    it('GR Chicken keeps its own engine even if its settings say "food"', async () => {
      const r = await ai.generateResponse({ organizationId: GR, channel: 'whatsapp', phone: phone(), message: 'menu' });
      expect(r.response).toBe('GR ENGINE');
      const re = await ai.generateResponse({ organizationId: 'org_vt_unknown_re', channel: 'whatsapp', phone: phone(), message: 'hi' }).catch(() => ({ response: 'RE ENGINE' }));
      expect(re.response).toBe('RE ENGINE');
    });
  });

  // ================================================================== hotel

  describe('hotel booking', () => {
    const day = (k: number) => c.addDays(c.istDay(new Date()), k);
    // Find a Monday at least 7 days ahead so weekday / weekend rates are predictable.
    const monday = () => {
      for (let k = 7; k < 14; k++) if (c.dateOnly(day(k)).getUTCDay() === 1) return k;
      return 7;
    };

    it('prices nights with seasonal, weekend and base rates plus tax', async () => {
      const m = monday();
      await prisma.roomRate.create({ data: { organizationId: HOTEL, roomTypeId: ids.deluxe, name: 'Festival', startDate: c.dateOnly(day(m + 1)), endDate: c.dateOnly(day(m + 1)), rate: 5000 } });
      // Mon, Tue (festival), Wed, Thu, Fri (weekend), Sat (weekend) -> 6 nights
      const q = await hotel.quote(HOTEL, ids.deluxe, { checkIn: day(m), checkOut: day(m + 6), adults: 2 });
      expect(q.ok).toBe(true);
      expect(q.breakdown.map((b: any) => [b.rate, b.source])).toEqual([[3000, 'base'], [5000, 'seasonal'], [3000, 'base'], [3000, 'base'], [3600, 'weekend'], [3600, 'weekend']]);
      expect(q.subtotal).toBe(21200);
      expect(q.tax).toBe(2544);
      expect(q.total).toBe(23744);
      expect(q.deposit).toBe(c.money(23744 * 0.2));
    });

    it('validates dates and capacity', async () => {
      const past = await hotel.availability(HOTEL, { checkIn: day(-1), checkOut: day(1), adults: 2 });
      expect(past.problems.join(' ')).toMatch(/past/);
      const reversed = await hotel.availability(HOTEL, { checkIn: day(5), checkOut: day(5), adults: 2 });
      expect(reversed.problems.join(' ')).toMatch(/after check-in/);
      const big = await hotel.quote(HOTEL, ids.deluxe, { checkIn: day(20), checkOut: day(21), adults: 4 });
      expect(big.ok).toBe(false);
      expect(big.problems.join(' ')).toMatch(/fits up to 2 adults/);
      const two = await hotel.quote(HOTEL, ids.deluxe, { checkIn: day(20), checkOut: day(21), adults: 4, rooms: 2 });
      expect(two.ok).toBe(true);
    });

    it('never overbooks: out-of-service rooms are not sold, overlapping stays count, concurrent bookings for the last room', async () => {
      const cust = await conversations.getOrCreateCustomerByPhone(HOTEL, phone(), { name: 'Guest A' });
      const base = { roomTypeId: ids.deluxe, adults: 2, customerId: cust.id, channel: 'test', actor: 'test', confirmNow: true };
      const a = await hotel.book(HOTEL, { ...base, checkIn: day(30), checkOut: day(33), idempotencyKey: 'h1' });
      expect(a.reservation.status).toBe('confirmed');
      const avail = await hotel.availability(HOTEL, { checkIn: day(31), checkOut: day(32), adults: 2 });
      expect(avail.roomTypes.find((x: any) => x.roomTypeId === ids.deluxe).available).toBe(1); // 2 sellable (103 out of service) - 1
      // Two guests race for the last deluxe room on overlapping dates: exactly one wins.
      const race = await Promise.allSettled([
        hotel.book(HOTEL, { ...base, checkIn: day(31), checkOut: day(34), idempotencyKey: 'race-1' }),
        hotel.book(HOTEL, { ...base, checkIn: day(32), checkOut: day(35), idempotencyKey: 'race-2' }),
      ]);
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(String((race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason?.message)).toMatch(/sold out|left/);
      // Same idempotency key -> same reservation (duplicate webhook).
      const again = await hotel.book(HOTEL, { ...base, checkIn: day(30), checkOut: day(33), idempotencyKey: 'h1' });
      expect(again.status).toBe('duplicate');
      expect(again.reservation.id).toBe(a.reservation.id);
      // A non-overlapping stay right after check-out is fine.
      const after = await hotel.book(HOTEL, { ...base, checkIn: day(35), checkOut: day(36), idempotencyKey: 'h-after' });
      expect(after.status).toBe('created');
    });

    it('pending holds count until they expire; staff confirm; reschedule re-prices; cancel applies the policy', async () => {
      const cust = await conversations.getOrCreateCustomerByPhone(HOTEL, phone(), { name: 'Guest B' });
      const r = await hotel.book(HOTEL, { roomTypeId: ids.suite, checkIn: day(40), checkOut: day(42), adults: 3, customerId: cust.id, channel: 'test', actor: 'test', idempotencyKey: 'pend-1' });
      expect(r.reservation.status).toBe('pending_confirmation');
      expect(r.reservation.paymentStatus).toBe('pending');
      const full = await hotel.availability(HOTEL, { checkIn: day(41), checkOut: day(42), adults: 2 });
      expect(full.roomTypes.find((x: any) => x.roomTypeId === ids.suite).available).toBe(0);
      const later = new Date(Date.now() + 2 * 3600_000);
      const afterExpiry = await hotel.availability(HOTEL, { checkIn: day(41), checkOut: day(42), adults: 2 }, later);
      expect(afterExpiry.roomTypes.find((x: any) => x.roomTypeId === ids.suite).available).toBe(1);
      const confirmed = await hotel.confirm(HOTEL, r.reservation.id, 'user:test');
      expect(confirmed.status).toBe('confirmed');
      const paid = await hotel.payment(HOTEL, r.reservation.id, 'simulated_paid', 'user:test');
      expect(paid.paymentLabel).toMatch(/SIMULATED/);
      const moved = await hotel.reschedule(HOTEL, r.reservation.id, { checkIn: day(44), checkOut: day(47), adults: 3 }, 'user:test');
      expect(moved.nights).toBe(3);
      expect(moved.total).toBeGreaterThan(confirmed.total);
      const cancelled = await hotel.cancel(HOTEL, r.reservation.id, 'user:test', 'plans changed');
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.freeCancellation).toBe(true);
      await expect(hotel.cancel(HOTEL, r.reservation.id, 'user:test')).rejects.toThrow(/cannot be cancelled/);
    });

    it('check-in only on the arrival day; check-out frees the room as dirty; no-show only after arrival', async () => {
      const cust = await conversations.getOrCreateCustomerByPhone(HOTEL, phone(), { name: 'Guest C' });
      const today = await hotel.book(HOTEL, { roomTypeId: ids.suite, checkIn: day(0), checkOut: day(1), adults: 2, customerId: cust.id, channel: 'test', actor: 'test', idempotencyKey: 'today-1', confirmNow: true });
      const future = await hotel.book(HOTEL, { roomTypeId: ids.suite, checkIn: day(3), checkOut: day(4), adults: 2, customerId: cust.id, channel: 'test', actor: 'test', idempotencyKey: 'future-1', confirmNow: true });
      await expect(hotel.checkIn(HOTEL, future.reservation.id, 'user:t')).rejects.toThrow(/arrival date/);
      await expect(hotel.noShow(HOTEL, future.reservation.id, 'user:t')).rejects.toThrow(/after the arrival date/);
      const inHouse = await hotel.checkIn(HOTEL, today.reservation.id, 'user:t');
      expect(inHouse.room.number).toBe('201');
      const out = await hotel.checkOut(HOTEL, today.reservation.id, 'user:t');
      expect(out.status).toBe('checked_out');
      expect((await prisma.room.findFirst({ where: { organizationId: HOTEL, number: '201' } })).housekeeping).toBe('dirty');
    });

    it('WhatsApp booking end to end: dates + guests → options → choose → YES → one pending reservation', async () => {
      const m = monday();
      const p = phone();
      const send = chat(HOTEL, p);
      const ci = c.dateOnly(day(m + 14));
      const label = ci.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      const r1 = await send(`Hi, do you have a room from ${label} for 2 nights for 2 adults?`);
      expect(r1.response).toMatch(/Available for/);
      expect(r1.response).toMatch(/Deluxe Room/);
      const r2 = await send('1');
      expect(r2.response).toMatch(/Reply YES to request this booking/);
      const quote = await hotel.quote(HOTEL, ids.deluxe, { checkIn: day(m + 14), checkOut: day(m + 16), adults: 2 });
      expect(r2.response).toContain(c.inr(quote.total));
      const r3 = await send('yes');
      expect(r3.actions.outcome).toBe('booked');
      expect(r3.response).toMatch(/front desk will confirm/);
      await send('yes');
      expect(await prisma.reservation.count({ where: { organizationId: HOTEL, guestPhone: { contains: p.slice(-8) } } })).toBe(1);
      const status = await send('my booking status');
      expect(status.response).toMatch(/Pending confirmation/);
      const cancel = await send('cancel my booking');
      expect(cancel.response).toMatch(/Reply YES to cancel/);
      const done = await send('yes');
      expect(done.response).toMatch(/is cancelled/);
      const complaint = await send('the AC is not working in my room');
      expect(complaint.actions.handoff).toBe(true);
    });

    it('reservation follow-ups: confirmation and pre-arrival scheduled; simulated in DRY_RUN; skipped once cancelled', async () => {
      const cust = await conversations.getOrCreateCustomerByPhone(HOTEL, phone(), { name: 'Guest D' });
      const r = (await hotel.book(HOTEL, { roomTypeId: ids.suite, checkIn: day(50), checkOut: day(52), adults: 2, customerId: cust.id, channel: 'test', actor: 'test', idempotencyKey: 'fu-1', confirmNow: true })).reservation;
      await vfu.onReservation(HOTEL, { id: r.id, customerId: cust.id, status: 'confirmed', checkIn: r.checkIn, checkOut: r.checkOut });
      const steps = await prisma.followUp.findMany({ where: { organizationId: HOTEL, customerId: cust.id, source: 'booking' }, orderBy: { scheduledAt: 'asc' } });
      expect(steps.map((s: any) => s.message.split(':')[1])).toEqual(['confirmed', 'pre_arrival', 'checkin_reminder', 'checkout_reminder']);
      const conf = await vfu.execute(steps[0].id);
      expect(conf.status).toBe('simulated');
      expect(conf.text).toContain(r.reference);
      await hotel.cancel(HOTEL, r.id, 'user:t');
      await vfu.onReservation(HOTEL, { id: r.id, customerId: cust.id, status: 'cancelled', checkIn: r.checkIn, checkOut: r.checkOut });
      expect(await prisma.followUp.count({ where: { organizationId: HOTEL, customerId: cust.id, message: { startsWith: 'booking:pre_arrival' }, status: 'scheduled' } })).toBe(0);
    });
  });

  // ================================================================== hospital

  describe('hospital appointments and insurance', () => {
    const tomorrow = () => c.addDays(c.istDay(new Date()), 1);

    it('offers slots from the OPD schedule and never double-books a slot (even concurrently)', async () => {
      const slots = await hospital.slots(HOSP, ids.dr, tomorrow());
      expect(slots).toHaveLength(12); // 09:00-12:00 / 15 min
      expect(slots[0].time).toBe('09:00');
      const p1 = await conversations.getOrCreateCustomerByPhone(HOSP, phone(), { name: 'Patient One' });
      const p2 = await conversations.getOrCreateCustomerByPhone(HOSP, phone(), { name: 'Patient Two' });
      const race = await Promise.allSettled([
        hospital.book(HOSP, { doctorId: ids.dr, startAt: slots[0].startAt, customerId: p1.id, channel: 'test', idempotencyKey: 'ap-1', actor: 'test' }),
        hospital.book(HOSP, { doctorId: ids.dr, startAt: slots[0].startAt, customerId: p2.id, channel: 'test', idempotencyKey: 'ap-2', actor: 'test' }),
      ]);
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await hospital.slots(HOSP, ids.dr, tomorrow()))).toHaveLength(11);
      const winner = (race.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
      const dup = await hospital.book(HOSP, { doctorId: ids.dr, startAt: slots[0].startAt, customerId: winner.appointment.patient.id, channel: 'test', idempotencyKey: winner.appointment.patient.id === p1.id ? 'ap-1' : 'ap-2', actor: 'test' });
      expect(dup.status).toBe('duplicate');
      // Same patient, same doctor, same day -> refused.
      await expect(hospital.book(HOSP, { doctorId: ids.dr, startAt: slots[3].startAt, customerId: winner.appointment.patient.id, channel: 'test', idempotencyKey: 'ap-3', actor: 'test' })).rejects.toThrow(/already have an appointment/);
      // Reschedule within the grid; past / off-grid refused.
      const moved = await hospital.reschedule(HOSP, winner.appointment.id, slots[5].startAt, 'user:t');
      expect(moved.time).toBe(slots[5].time);
      await expect(hospital.reschedule(HOSP, winner.appointment.id, new Date(new Date(slots[5].startAt).getTime() + 7 * 60_000).toISOString(), 'user:t')).rejects.toThrow(/not available/);
      await expect(hospital.setStatus(HOSP, winner.appointment.id, 'no_show', 'user:t')).rejects.toThrow(/after the appointment time/);
    });

    it('WhatsApp booking end to end; emergencies and clinical questions are handled safely', async () => {
      const p = phone();
      const send = chat(HOSP, p);
      const e = await send('my father has severe chest pain');
      expect(e.response).toMatch(/call 108/);
      expect(e.actions.handoff).toBe(true);
      expect((await prisma.followUp.findFirst({ where: { organizationId: HOSP, channel: 'human', message: { contains: 'URGENT' } } }))).toBeTruthy();
      const send2 = chat(HOSP, phone());
      const med = await send2('what medicine should i take for knee pain');
      expect(med.response).toMatch(/not able to give medical advice/);
      expect(med.response).not.toMatch(/\bmg\b|paracetamol|ibuprofen/i);
      const book = await send2('book an appointment with the orthopaedic doctor');
      expect(book.response).toMatch(/Next available/);
      expect(book.response).toMatch(/Dr\. Arjun Rao/);
      const pick = await send2('1');
      expect(pick.response).toMatch(/patient's full name/);
      const name = await send2('Kavitha Raman');
      expect(name.response).toMatch(/Reply YES to book/);
      expect(name.response).toContain('₹700');
      const yes = await send2('yes');
      expect(yes.actions.outcome).toBe('booked');
      expect(yes.response).toMatch(/AP-/);
      const status = await send2('when is my appointment');
      expect(status.response).toMatch(/Booked/);
      expect(await prisma.followUp.count({ where: { organizationId: HOSP, source: 'appointment', customerId: yes.customerId } })).toBeGreaterThanOrEqual(0);
    });

    it('insurance: documents chased, assistant reports only staff-recorded status, decisions need permission and the insurer reference', async () => {
      const pt = await conversations.getOrCreateCustomerByPhone(HOSP, phone(), { name: 'Insured Patient' });
      const ic = await hospital.insuranceCreate(HOSP, { customerId: pt.id, kind: 'pre_authorisation', insurer: 'Star Health', policyNumber: 'SH-99887766' }, 'user:t');
      expect(ic.policyRef).toBe('••••7766');
      expect(ic.missingDocs.length).toBe(4);
      await vfu.onInsuranceDocsPending(HOSP, { id: ic.id, customerId: pt.id });
      const first = await prisma.followUp.findFirst({ where: { organizationId: HOSP, message: `insurance:docs:${ic.id}:0` } });
      const r = await vfu.execute(first.id);
      expect(r.status).toBe('simulated');
      expect(r.text).toMatch(/Insurance card/);
      const ask = await ai.generateResponse({ organizationId: HOSP, channel: 'whatsapp', phone: pt.phone, message: 'what is my insurance status?' });
      expect(ask.response).toMatch(/Documents pending/);
      expect(ask.response).toMatch(/decisions are made by your insurer/);
      expect(ask.response).not.toMatch(/approved/i);
      for (const d of ic.requiredDocs) await hospital.insuranceDocument(HOSP, ic.id, d, true, 'user:t');
      const ready = await hospital.insuranceGet(HOSP, ic.id);
      expect(ready.status).toBe('ready_to_submit');
      await hospital.insuranceTransition(HOSP, ic.id, 'submitted', {}, 'user:t', false);
      await expect(hospital.insuranceTransition(HOSP, ic.id, 'approved', { insurerReference: 'X1', amountApproved: 1000 }, 'user:t', false)).rejects.toThrow(/record_decision/);
      await expect(hospital.insuranceTransition(HOSP, ic.id, 'approved', { amountApproved: 1000 }, 'user:t', true)).rejects.toThrow(/insurer \/ TPA reference/);
      const approved = await hospital.insuranceTransition(HOSP, ic.id, 'approved', { insurerReference: 'STAR-PA-123', amountApproved: 45000 }, 'user:t', true);
      expect(approved.decidedBy).toBe('user:t');
      const second = await prisma.followUp.findFirst({ where: { organizationId: HOSP, message: `insurance:docs:${ic.id}:1` } });
      expect((await vfu.execute(second.id)).reason).toBe('status_approved');
    });
  });
});
