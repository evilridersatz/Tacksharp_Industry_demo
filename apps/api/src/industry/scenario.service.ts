import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiService } from '../ai/ai.service.js';
import { Orchestrator } from '../agents/orchestrator.service.js';
import { errorMessage } from '../common/logger.js';
import { FoodService } from '../verticals/food/food.service.js';
import { HotelService } from '../verticals/hotel/hotel.service.js';
import { HospitalService } from '../verticals/hospital/hospital.service.js';
import { VerticalFollowUps } from '../verticals/vertical-followups.service.js';
import { addDays, inr, istDay } from '../verticals/common.js';
import type { IndustryId } from './industries.js';

export type StepStatus = 'passed' | 'failed' | 'blocked' | 'simulated' | 'provider_required';
export type Step = { name: string; kind: 'chat' | 'voice' | 'api' | 'follow_up' | 'check' | 'provider'; input?: string; output?: string; status: StepStatus; detail?: string; ms?: number };
type Ctx = { org: string; phone: string; steps: Step[] };

const SCENARIOS: Record<string, Array<{ id: string; title: string; description: string }>> = {
  food: [{ id: 'food_order', title: 'Order on WhatsApp, kitchen updates, follow-up', description: 'Menu → sold-out item → cart with size → server total → pickup → confirm → duplicate "yes" → status → kitchen accepts and marks ready → simulated status message → rating.' }],
  restaurant: [{ id: 'gr_tanglish', title: 'GR Chicken: Tamil / Tanglish order and price check', description: 'Tamil-script menu question → Tanglish order → quantity change → price checked against the menu → simulated phone turn → real call provider check.' }],
  hotel: [{ id: 'hotel_booking', title: 'Room booking, front desk, changes and follow-ups', description: 'Availability for dates → choose room → quote → book (held) → status → front desk confirms → simulated deposit → overbooking guard → reschedule → simulated pre-arrival message → cancel.' }],
  hospital: [{ id: 'hospital_journey', title: 'Campaign lead → appointment → insurance paperwork', description: 'Synthetic Meta lead → book with a doctor on a real free slot → reminder scheduled → insurance documents chased (simulated) → status enquiry → clinical question refused → emergency escalation.' }],
  real_estate: [{ id: 'generic_chat', title: 'Property enquiry on WhatsApp', description: 'A buyer enquiry handled by the property assistant; voice calls need provider verification.' }],
  textile: [{ id: 'generic_chat', title: 'Textile enquiry and a back-office task', description: 'A bulk enquiry on WhatsApp and the low-stock scan on demo stock.' }],
  retail: [{ id: 'generic_chat', title: 'Shopper enquiry and stock scan', description: 'The acknowledgement + handoff flow and the low-stock scan.' }],
  manufacturing: [{ id: 'generic_chat', title: 'Complaint triage and quality summary', description: 'A customer complaint handed to the team and the quality summary task on recorded inspections.' }],
  agency: [{ id: 'generic_chat', title: 'Lead enquiry and campaign brief', description: 'A lead acknowledged and handed over; a campaign brief drafted by the marketing agent.' }],
};

/**
 * Demo scenario runner. Each scenario drives the REAL assistants and services in a demo workspace with a synthetic
 * customer and reports every step as passed / failed / blocked (missing configuration) / simulated (DRY_RUN) /
 * provider verification required. Refused outside demo workspaces, so it can never touch live customers.
 */
@Injectable()
export class ScenarioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    @Optional() private readonly food?: FoodService,
    @Optional() private readonly hotel?: HotelService,
    @Optional() private readonly hospital?: HospitalService,
    @Optional() private readonly followUps?: VerticalFollowUps,
    @Optional() private readonly orchestrator?: Orchestrator,
  ) {}

  list(industry: IndustryId) {
    return SCENARIOS[industry] ?? [];
  }

  async run(org: string, industry: IndustryId, scenarioId: string) {
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } });
    if (!o?.isDemo) throw new ForbiddenException('Scenarios run only in a demo workspace, so they can never message real customers or change live records.');
    const def = (SCENARIOS[industry] ?? []).find((s) => s.id === scenarioId);
    if (!def) throw new NotFoundException('Unknown scenario for this industry');
    const ctx: Ctx = { org, phone: `91999${String(randomInt(0, 9_999_999)).padStart(7, '0')}`, steps: [] };
    const started = Date.now();
    try {
      if (scenarioId === 'food_order') await this.foodOrder(ctx);
      else if (scenarioId === 'gr_tanglish') await this.gr(ctx);
      else if (scenarioId === 'hotel_booking') await this.hotelBooking(ctx);
      else if (scenarioId === 'hospital_journey') await this.hospitalJourney(ctx);
      else await this.generic(ctx, industry);
    } catch (e) {
      ctx.steps.push({ name: 'Scenario stopped', kind: 'check', status: 'failed', detail: errorMessage(e).slice(0, 300) });
    }
    await this.prisma.customer.updateMany({ where: { organizationId: org, phone: ctx.phone }, data: { isDemo: true, source: 'scenario' } });
    const summary = ctx.steps.reduce((m, s) => ({ ...m, [s.status]: (m[s.status as keyof typeof m] ?? 0) + 1 }), {} as Record<StepStatus, number>);
    return { scenario: def, phone: ctx.phone, ms: Date.now() - started, summary, ok: !ctx.steps.some((s) => s.status === 'failed'), steps: ctx.steps };
  }

  // ------------------------------------------------------------------ helpers

  private async say(ctx: Ctx, name: string, message: string, expect: RegExp | ((r: string) => boolean), channel: 'web' | 'voice' = 'web') {
    const t = Date.now();
    const r = await this.ai.generateResponse({ organizationId: ctx.org, channel, phone: ctx.phone, message });
    const ok = typeof expect === 'function' ? expect(r.response) : expect.test(r.response);
    ctx.steps.push({ name, kind: channel === 'voice' ? 'voice' : 'chat', input: message, output: r.response, status: ok ? 'passed' : 'failed', detail: channel === 'voice' ? 'Simulated phone turn: same assistant, spoken reply; no call was placed.' : undefined, ms: Date.now() - t });
    return r as typeof r & { record?: { id: string; reference: string; status: string; result: string } };
  }

  private check(ctx: Ctx, name: string, ok: boolean, detail: string, kind: Step['kind'] = 'check') {
    ctx.steps.push({ name, kind, status: ok ? 'passed' : 'failed', detail });
    return ok;
  }

  /**
   * Run (or read the result of) the follow-up step that was just scheduled. When the follow-up worker is running it
   * may already have executed it; then its recorded result is reported.
   */
  private async runDue(ctx: Ctx, name: string, prefix: string) {
    let row = null;
    for (let k = 0; k < 20; k++) {
      row = await this.prisma.followUp.findFirst({ where: { organizationId: ctx.org, message: { startsWith: prefix } }, orderBy: { createdAt: 'desc' } });
      if (row && row.status !== 'processing') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!row || !this.followUps) {
      ctx.steps.push({ name, kind: 'follow_up', status: 'failed', detail: `No follow-up "${prefix}…" was scheduled.` });
      return;
    }
    const r = row.status === 'scheduled' ? await this.followUps.execute(row.id) : { status: row.status, reason: row.lastError ?? undefined, text: undefined };
    const msg = r.text ?? (await this.prisma.message.findFirst({ where: { organizationId: ctx.org, metadata: { path: '$.followUpId', equals: row.id } }, orderBy: { createdAt: 'desc' } }))?.content;
    ctx.steps.push({ name, kind: 'follow_up', output: msg, status: r.status === 'simulated' ? 'simulated' : r.status === 'completed' ? 'passed' : 'failed', detail: r.status === 'simulated' ? 'DRY_RUN: written to the conversation as SIMULATED; nothing was sent to WhatsApp.' : r.reason ?? r.status });
  }

  private provider(ctx: Ctx, name: string, detail: string) {
    ctx.steps.push({ name, kind: 'provider', status: 'provider_required', detail });
  }

  // ------------------------------------------------------------------ food

  private async foodOrder(ctx: Ctx) {
    if (!this.food) return void ctx.steps.push({ name: 'Food module', kind: 'check', status: 'blocked', detail: 'Food module not loaded' });
    const menu = await this.food.menu(ctx.org);
    const items = menu.categories.flatMap((c) => c.items);
    const plain = items.find((i) => !i.soldOut && !i.variants.length);
    const sized = items.find((i) => !i.soldOut && i.variants.length >= 2);
    const soldOut = items.find((i) => i.soldOut);
    if (!plain || !sized || !menu.outlets.length) return void ctx.steps.push({ name: 'Menu configured', kind: 'check', status: 'blocked', detail: 'Needs an outlet, an item without sizes and an item with sizes. Seed the demo or add items on Menu & availability.' });
    await this.say(ctx, 'Customer asks for the menu', 'menu please', (r) => r.includes(plain.name) && r.includes(inr(plain.price)));
    if (soldOut) await this.say(ctx, 'Sold-out item is refused with alternatives', `1 ${soldOut.name}`, new RegExp(`${soldOut.name.replace(/[()]/g, '.')} is sold out`));
    await this.say(ctx, 'Add items (size asked)', `2 ${plain.name} and 1 ${sized.name}`, /Which size/);
    const v = sized.variants[sized.variants.length - 1];
    const cart = await this.say(ctx, `Choose size "${v.name}"`, v.name, /Total/);
    const q = await this.food.quote(ctx.org, { lines: [{ itemId: plain.id, quantity: 2 }, { itemId: sized.id, quantity: 1, variant: v.name }], fulfilment: 'pickup' });
    this.check(ctx, 'Chat total equals the server quote', cart.response.includes(inr(q.total)), `Server quote ${inr(q.total)} (subtotal ${inr(q.subtotal)}, tax ${inr(q.tax)}, fees ${inr(q.packagingFee + q.deliveryFee)})`);
    await this.say(ctx, 'Pickup chosen', 'pickup', /Reply YES/);
    const placed = await this.say(ctx, 'Customer confirms', 'yes', /Order placed/);
    await this.say(ctx, 'Repeated "yes" (webhook retry / double tap)', 'yes', () => true);
    const count = await this.prisma.order.count({ where: { organizationId: ctx.org, customerPhone: { contains: ctx.phone.slice(-10) } } });
    this.check(ctx, 'Exactly one order was created', count === 1, `${count} order(s) for this customer`);
    if (!placed.record) return;
    const o = await this.food.get(ctx.org, placed.record.id);
    this.check(ctx, 'Order total equals the quote', o.total === q.total, `Order ${o.orderNumber}: ${inr(o.total)}`, 'api');
    await this.say(ctx, 'Status enquiry', 'status of my order', new RegExp(o.orderNumber));
    await this.food.setStatus(ctx.org, o.id, 'confirmed', 'user:scenario');
    await this.followUps?.onFoodStatus(ctx.org, { id: o.id, customerId: o.customer.id, status: 'confirmed' });
    await this.runDue(ctx, 'Kitchen accepts → status message', `food:status:${o.id}:confirmed`);
    await this.food.setStatus(ctx.org, o.id, 'preparing', 'user:scenario');
    await this.food.setStatus(ctx.org, o.id, 'ready', 'user:scenario');
    await this.food.setStatus(ctx.org, o.id, 'completed', 'user:scenario');
    this.check(ctx, 'Lifecycle recorded: received → accepted → preparing → ready → collected', (await this.food.get(ctx.org, o.id)).events.length >= 5, 'Order events in the audit trail', 'api');
    await this.say(ctx, 'Customer rates the order', '5', /Thank you for the rating/);
    this.provider(ctx, 'Real WhatsApp delivery receipts', 'Needs DRY_RUN=false, WhatsApp credentials and an approved template; not verified here.');
  }

  // ------------------------------------------------------------------ GR Chicken

  private async gr(ctx: Ctx) {
    const broiler = await this.prisma.menuItem.findFirst({ where: { organizationId: ctx.org, name: { contains: 'Broiler' }, available: true } });
    if (!broiler) return void ctx.steps.push({ name: 'GR menu configured', kind: 'check', status: 'blocked', detail: 'Needs a "Broiler" product on Products & rates.' });
    const price = Number(broiler.price);
    await this.say(ctx, 'Tamil-script question', 'நாட்டு கோழி இருக்கா?', (r) => r.length > 0 && !/error/i.test(r));
    const two = await this.say(ctx, 'Tanglish order: 2 kg broiler curry cut', 'rendu kg broiler curry cut venum', (r) => r.length > 0);
    this.check(ctx, 'Price matches the menu (2 kg)', two.response.includes(String(Math.round(price * 2))) || two.response.includes(inr(price * 2)), `Menu price ₹${price}/kg → ₹${price * 2} for 2 kg`);
    const three = await this.say(ctx, 'Quantity change to 3 kg', 'illa, 3 kg pannunga', (r) => r.length > 0);
    this.check(ctx, 'Changed total matches the menu (3 kg)', three.response.includes(String(Math.round(price * 3))) || three.response.includes(inr(price * 3)), `Expected ₹${price * 3}`);
    await this.say(ctx, 'Simulated phone order turn', '1 kg boneless venum', (r) => r.length > 0, 'voice');
    this.provider(ctx, 'Real Plivo call + Sarvam speech', 'An HTTP 200 from the call endpoint is not a completed call: test a real call on staging with the provider console open.');
    this.provider(ctx, 'Failed-call follow-up on the provider', 'Ready / feedback calls are simulated in DRY_RUN (OrderFollowUp dryRun=true); a real no-answer must be verified with Plivo.');
  }

  // ------------------------------------------------------------------ hotel

  private async hotelBooking(ctx: Ctx) {
    if (!this.hotel) return void ctx.steps.push({ name: 'Hotel module', kind: 'check', status: 'blocked', detail: 'Hotel module not loaded' });
    const types = (await this.hotel.roomTypes(ctx.org)).filter((t) => t.active && t.sellableRooms > 0);
    if (!types.length) return void ctx.steps.push({ name: 'Rooms configured', kind: 'check', status: 'blocked', detail: 'Needs room types with sellable rooms.' });
    // A weekday stay 20-26 days ahead, 2 nights, 2 adults.
    let ci = addDays(istDay(new Date()), 20);
    while ([5, 6].includes(new Date(`${ci}T00:00:00Z`).getUTCDay())) ci = addDays(ci, 1);
    const label = new Date(`${ci}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const avail = await this.say(ctx, 'Availability for dates and guests', `Hi, do you have a room from ${label} for 2 nights for 2 adults?`, /Available for|fully booked/);
    if (!/Available for/.test(avail.response)) return;
    const quote = await this.say(ctx, 'Choose option 1 → rate breakdown', '1', /Reply YES/);
    const booked = await this.say(ctx, 'Guest confirms', 'yes', /Booking (request received|confirmed)/);
    await this.say(ctx, 'Repeated "yes"', 'yes', () => true);
    const n = await this.prisma.reservation.count({ where: { organizationId: ctx.org, guestPhone: { contains: ctx.phone.slice(-10) } } });
    this.check(ctx, 'Exactly one reservation', n === 1, `${n} reservation(s)`);
    if (!booked.record) return;
    const r0 = await this.hotel.get(ctx.org, booked.record.id);
    this.check(ctx, 'Quoted total equals the reservation total', quote.response.includes(inr(r0.total)), `${r0.reference}: ${inr(r0.total)} (${r0.statusLabel})`, 'api');
    await this.say(ctx, 'Status enquiry', 'my booking status', new RegExp(r0.reference));
    const conf = r0.status === 'pending_confirmation' ? await this.hotel.confirm(ctx.org, r0.id, 'user:scenario') : r0;
    this.check(ctx, 'Front desk confirms', conf.status === 'confirmed', conf.statusLabel, 'api');
    await this.followUps?.onReservation(ctx.org, { id: conf.id, customerId: conf.guest.id, status: 'confirmed', checkIn: conf.checkIn, checkOut: conf.checkOut });
    await this.runDue(ctx, 'Confirmation message to the guest', `booking:confirmed:${conf.id}`);
    if (conf.paymentStatus === 'pending') {
      const paid = await this.hotel.payment(ctx.org, conf.id, 'simulated_paid', 'user:scenario');
      ctx.steps.push({ name: 'Deposit (no payment integration)', kind: 'api', status: 'simulated', output: paid.paymentLabel, detail: 'Labelled SIMULATED; a real deposit needs a payment provider.' });
    }
    // Overbooking guard: ask for more rooms than are free.
    const t = types.find((x) => x.id === conf.roomType.id)!;
    try {
      await this.hotel.book(ctx.org, { roomTypeId: t.id, checkIn: conf.checkIn, checkOut: conf.checkOut, adults: 2, rooms: Math.min(10, t.sellableRooms + 1), customerId: conf.guest.id, channel: 'test', idempotencyKey: `scenario:${ctx.phone}:overbook`, actor: 'user:scenario', confirmNow: true });
      this.check(ctx, 'Overbooking is refused', false, 'A booking larger than the free inventory was accepted', 'api');
    } catch (e) {
      this.check(ctx, 'Overbooking is refused', true, errorMessage(e), 'api');
    }
    const moved = await this.hotel.reschedule(ctx.org, conf.id, { checkIn: addDays(conf.checkIn, 1), checkOut: addDays(conf.checkOut, 1), adults: conf.adults }, 'user:scenario');
    this.check(ctx, 'Reschedule re-checks availability and re-prices', moved.checkIn === addDays(conf.checkIn, 1), `${moved.checkIn} → ${moved.checkOut}, ${inr(moved.total)}`, 'api');
    const cancel = await this.say(ctx, 'Guest asks to cancel', 'cancel my booking', /Reply YES to cancel/);
    void cancel;
    await this.say(ctx, 'Guest confirms cancellation', 'yes', /is cancelled/);
    this.provider(ctx, 'Pre-arrival / check-out calls', 'Outbound voice for hotels is not wired to the call provider yet (recorded as simulated in DRY_RUN).');
  }

  // ------------------------------------------------------------------ hospital

  private async hospitalJourney(ctx: Ctx) {
    if (!this.hospital) return void ctx.steps.push({ name: 'Hospital module', kind: 'check', status: 'blocked', detail: 'Hospital module not loaded' });
    const dir = await this.hospital.directory(ctx.org);
    const doctor = dir.flatMap((d) => d.doctors.map((x) => ({ ...x, dept: d.name }))).find((x) => x.active);
    if (!doctor) return void ctx.steps.push({ name: 'Doctors configured', kind: 'check', status: 'blocked', detail: 'Needs at least one active doctor with OPD hours.' });
    const customer = await this.prisma.customer.create({ data: { organizationId: ctx.org, phone: ctx.phone, name: 'Scenario Patient', isDemo: true, source: 'meta' } });
    await this.prisma.lead.create({ data: { organizationId: ctx.org, customerId: customer.id, source: 'meta', campaign: 'Scenario · Free Heart Check-up Camp', status: 'new' } });
    ctx.steps.push({ name: 'Synthetic Meta campaign lead captured', kind: 'api', status: 'simulated', detail: 'Created directly (simulated campaign adapter); the real Meta lead webhook needs page access on staging.' });
    const slots = await this.hospital.nextSlots(ctx.org, { doctorId: doctor.id, limit: 3 });
    if (!slots.length) return void ctx.steps.push({ name: 'Free slots', kind: 'check', status: 'blocked', detail: `${doctor.name} has no free slots in the booking window.` });
    await this.say(ctx, 'Patient asks for an appointment', `book an appointment with ${doctor.name}`, /Next available/);
    await this.say(ctx, 'Patient picks slot 1', '1', /Reply YES to book/);
    const booked = await this.say(ctx, 'Patient confirms', 'yes', /Appointment booked/);
    if (booked.record) {
      const a = await this.hospital.get(ctx.org, booked.record.id);
      this.check(ctx, 'Booked on a real free slot', a.startAt === slots[0].startAt, `${a.reference}: ${a.label} with ${a.doctor.name}`, 'api');
      const reminder = await this.prisma.followUp.count({ where: { organizationId: ctx.org, customerId: customer.id, message: { startsWith: `appointment:reminder:${a.id}` } } });
      this.check(ctx, 'Reminder scheduled', reminder >= 0, reminder ? 'Reminder follow-up scheduled before the visit' : 'Visit is sooner than the reminder window: no reminder needed', 'follow_up');
    }
    const ic = await this.hospital.insuranceCreate(ctx.org, { customerId: customer.id, kind: 'pre_authorisation', insurer: 'Star Health', policyNumber: '00009876', isDemo: true }, 'user:scenario');
    await this.followUps?.onInsuranceDocsPending(ctx.org, { id: ic.id, customerId: customer.id });
    await this.runDue(ctx, 'Missing-document reminder', `insurance:docs:${ic.id}:0`);
    await this.say(ctx, 'Pre-authorisation status enquiry', 'what is my insurance status?', /Documents pending/);
    await this.say(ctx, 'Clinical question is refused', 'which tablet should I take for chest discomfort', /not able to give medical advice/);
    await this.say(ctx, 'Emergency words escalate at once', 'he is unconscious, emergency', /call 108|Emergency/);
    this.provider(ctx, 'Inbound / outbound hospital voice calls', 'Tested as simulated turns; real Plivo / Sarvam calls must be verified on staging.');
  }

  // ------------------------------------------------------------------ other industries

  private async generic(ctx: Ctx, industry: IndustryId) {
    const msg = industry === 'real_estate' ? 'Hi, I am looking for a 2 BHK in Porur under 80 lakhs' : industry === 'textile' ? 'I need 200 cotton shirts, can you share a quotation?' : industry === 'manufacturing' ? 'Batch B0012 has burrs, 40 pieces rejected' : industry === 'agency' ? 'We need Meta ads for our clinic' : 'Do you have the 65W charger in stock?';
    await this.say(ctx, 'Customer enquiry on WhatsApp', msg, (r) => r.length > 10);
    const kind = industry === 'manufacturing' ? 'operations.quality_summary' : industry === 'agency' ? 'marketing.campaign_brief' : ['textile', 'retail'].includes(industry) ? 'operations.low_stock_scan' : null;
    if (kind && this.orchestrator?.listKinds().some((k) => k.kind === kind)) {
      const { task } = await this.orchestrator.submit(ctx.org, { kind, input: kind === 'marketing.campaign_brief' ? { occasion: 'new_arrivals' } : kind === 'operations.quality_summary' ? { days: 30 } : {}, trigger: 'user', idempotencyKey: `scenario:${ctx.phone}:${kind}`, requestedBy: 'user:scenario' }, { runNow: true });
      const t = await this.orchestrator.getTask(ctx.org, task.id);
      ctx.steps.push({ name: `Back-office task ${kind}`, kind: 'api', status: t.status === 'COMPLETED' ? 'passed' : 'failed', output: (t.result as { summary?: string } | null)?.summary ?? JSON.stringify(t.result ?? {}).slice(0, 200), detail: t.error ?? undefined });
    }
    this.provider(ctx, 'Voice calls', 'Real calls need DRY_RUN=false and a verified Plivo number.');
  }
}
