/**
 * GR Chicken DEMO data for follow-ups: 10 synthetic customers and 10 demo orders under org_gr_chicken.
 * Safe to re-run (same ids, no duplicates); never touches a real (non-demo) customer or order.
 *
 *   npm run seed:gr-chicken-demo -w apps/api        (run npm run seed:gr-chicken first)
 *
 * Phone numbers are 91 00000 1xxxx: Indian mobile numbers never start with 0, so these cannot belong to
 * anyone. Every customer and order is marked isDemo, and demo customers are never contacted for real:
 * follow-ups for them are always simulated, even with DRY_RUN=false.
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { Prisma, PrismaClient } from '@prisma/client';
import { alertLevel, stockStatus } from '../src/restaurant/inventory.js';

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: process.env.DB_NAME ?? 'tacksharp',
  }),
});

export const DEMO_ORG = process.env.GR_ORGANIZATION_ID ?? 'org_gr_chicken';
const MIN = 60_000;

type Line = { product: string; qty: number; cut?: string };
type Spec = {
  n: number;
  name: string;
  language: 'tanglish' | 'tamil' | 'english';
  messaging: boolean;
  calling: boolean;
  optedOut?: boolean;
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | 'completed' | 'cancelled';
  placedMinAgo: number;
  /** Pickup relative to now (negative = in the past). */
  pickupMin: number;
  /** Collected (= delivered) this many minutes ago. */
  collectedMinAgo?: number;
  payment: 'cash_at_shop' | 'upi_at_shop' | 'paid_online';
  paid?: boolean;
  lines: Line[];
  scenario: 'whatsapp_5' | 'whatsapp_complaint' | 'call_happy' | 'call_complaint' | 'no_answer' | 'stop';
  feedback?: { rating: number; channel: 'whatsapp' | 'voice'; comment?: string; complaint?: 'open' | 'resolved' };
  /** Follow-up history to show on the dashboard. */
  followUps: Array<{ kind: 'order_confirmation' | 'status_update' | 'feedback_request' | 'feedback_call'; status: string; minFromNow: number; attempts?: number; error?: string; result?: Record<string, unknown> }>;
};

const SPECS: Spec[] = [
  { n: 1, name: 'Arun Kumar (Demo)', language: 'tanglish', messaging: true, calling: true, status: 'pending', placedMinAgo: 15, pickupMin: 120, payment: 'cash_at_shop', scenario: 'call_happy', lines: [{ product: 'Broiler Chicken', qty: 2, cut: 'Curry cut' }], followUps: [{ kind: 'order_confirmation', status: 'sent', minFromNow: -14 }] },
  { n: 2, name: 'Priya Raman (Demo)', language: 'tamil', messaging: true, calling: true, status: 'confirmed', placedMinAgo: 50, pickupMin: 70, payment: 'upi_at_shop', scenario: 'whatsapp_5', lines: [{ product: 'Country Chicken', qty: 1.5, cut: 'Biryani cut' }], followUps: [{ kind: 'order_confirmation', status: 'delivered', minFromNow: -49 }, { kind: 'status_update', status: 'read', minFromNow: -40 }] },
  { n: 3, name: 'Karthik S (Demo)', language: 'tanglish', messaging: true, calling: false, status: 'preparing', placedMinAgo: 90, pickupMin: 25, payment: 'cash_at_shop', scenario: 'whatsapp_5', lines: [{ product: 'Boneless Chicken', qty: 1 }, { product: 'Country Eggs', qty: 12 }], followUps: [{ kind: 'status_update', status: 'delivered', minFromNow: -80 }] },
  { n: 4, name: 'Meena Lakshmi (Demo)', language: 'tamil', messaging: true, calling: true, status: 'ready', placedMinAgo: 120, pickupMin: 5, payment: 'paid_online', scenario: 'call_happy', lines: [{ product: 'Broiler Chicken', qty: 3, cut: 'Fry cut' }], followUps: [{ kind: 'status_update', status: 'read', minFromNow: -110 }] },
  {
    n: 5, name: 'Suresh Babu (Demo)', language: 'tanglish', messaging: true, calling: true, status: 'completed', placedMinAgo: 360, pickupMin: -200, collectedMinAgo: 190, payment: 'upi_at_shop', paid: true, scenario: 'whatsapp_5',
    lines: [{ product: 'Broiler Chicken', qty: 2, cut: 'Curry cut' }, { product: 'Chicken Liver', qty: 0.5 }],
    feedback: { rating: 5, channel: 'whatsapp' },
    followUps: [{ kind: 'feedback_request', status: 'completed', minFromNow: -160, result: { rating: 5, reply: '5', simulated: true } }, { kind: 'feedback_call', status: 'skipped', minFromNow: -70, error: 'Feedback already received via whatsapp' }],
  },
  {
    n: 6, name: 'Divya N (Demo)', language: 'tanglish', messaging: true, calling: true, status: 'completed', placedMinAgo: 330, pickupMin: -180, collectedMinAgo: 170, payment: 'cash_at_shop', paid: true, scenario: 'call_complaint',
    lines: [{ product: 'Skinless Chicken', qty: 1, cut: 'Curry cut' }],
    feedback: { rating: 2, channel: 'voice', comment: 'Chicken fresh-ah illa, smell vandhuchu. Rendu dhaan.', complaint: 'open' },
    followUps: [{ kind: 'feedback_request', status: 'read', minFromNow: -140 }, { kind: 'feedback_call', status: 'completed', minFromNow: -50, result: { rating: 2, complaint: true, simulated: true, transcript: ['வணக்கம், GR Chicken-ல இருந்து பேசுறோம்…', 'Chicken fresh-ah illa, smell vandhuchu. Rendu dhaan.', 'மன்னிச்சுக்கோங்க. எங்க manager இன்னைக்கே உங்களுக்கு call பண்ணுவாங்க.'] } }],
  },
  {
    n: 7, name: 'Vignesh R (Demo)', language: 'english', messaging: true, calling: true, status: 'completed', placedMinAgo: 150, pickupMin: -70, collectedMinAgo: 60, payment: 'cash_at_shop', paid: true, scenario: 'call_happy',
    lines: [{ product: 'Country Chicken', qty: 1, cut: 'Curry cut' }, { product: 'Boneless Chicken', qty: 0.5 }],
    followUps: [{ kind: 'feedback_request', status: 'delivered', minFromNow: -30 }, { kind: 'feedback_call', status: 'scheduled', minFromNow: 60 }],
  },
  {
    n: 8, name: 'Lakshmi P (Demo)', language: 'tamil', messaging: true, calling: true, status: 'completed', placedMinAgo: 480, pickupMin: -300, collectedMinAgo: 290, payment: 'cash_at_shop', paid: true, scenario: 'no_answer',
    lines: [{ product: 'Broiler Chicken', qty: 1, cut: 'Whole' }],
    followUps: [{ kind: 'feedback_request', status: 'delivered', minFromNow: -260 }, { kind: 'feedback_call', status: 'no_answer', minFromNow: -50, attempts: 2, error: 'No answer after 2 attempts' }],
  },
  {
    n: 9, name: 'Ramesh K (Demo)', language: 'tanglish', messaging: true, calling: false, status: 'completed', placedMinAgo: 70, pickupMin: -25, collectedMinAgo: 20, payment: 'upi_at_shop', paid: true, scenario: 'whatsapp_5',
    lines: [{ product: 'Broiler Chicken', qty: 1.5, cut: 'Biryani cut' }],
    followUps: [{ kind: 'feedback_request', status: 'scheduled', minFromNow: 10 }, { kind: 'feedback_call', status: 'scheduled', minFromNow: 100 }],
  },
  {
    n: 10, name: 'Anitha M (Demo)', language: 'english', messaging: false, calling: false, optedOut: true, status: 'cancelled', placedMinAgo: 600, pickupMin: -480, payment: 'cash_at_shop', scenario: 'stop',
    lines: [{ product: 'Chicken Wings', qty: 1 }],
    followUps: [{ kind: 'order_confirmation', status: 'sent', minFromNow: -598 }, { kind: 'feedback_request', status: 'cancelled', minFromNow: -400, error: 'Customer replied STOP' }],
  },
];

const pad = (n: number) => String(n).padStart(2, '0');
export const demoPhone = (n: number) => `9100000100${pad(n)}`;

/**
 * Demo stock for the products created by `npm run seed:gr-chicken`, matched by organization + product name.
 * Sample numbers only (stockIsDemo = true, shown as "demo stock" to customers and staff): one product is low
 * (Boneless Chicken, below its alert level) and one is out (Chicken Liver). Products not in this list, and any
 * product whose stock staff have entered (stockIsDemo = false), are never touched.
 */
export const DEMO_STOCK: Array<{ name: string; qty: number; lowAt: number }> = [
  { name: 'Broiler Chicken', qty: 18, lowAt: 5 },
  { name: 'Country Chicken', qty: 8, lowAt: 3 },
  { name: 'Skinless Chicken', qty: 6, lowAt: 3 },
  { name: 'Chicken Wings', qty: 4, lowAt: 2 },
  { name: 'Boneless Chicken', qty: 1.5, lowAt: 2 },
  { name: 'Chicken Liver', qty: 0, lowAt: 1 },
  { name: 'Country Eggs', qty: 120, lowAt: 24 },
];

export async function seedDemoStock(client: PrismaClient = prisma) {
  const result: Array<{ name: string; qty: number; unit: string; status: string }> = [];
  const skipped: string[] = [];
  for (const d of DEMO_STOCK) {
    const item = await client.menuItem.findUnique({ where: { organizationId_name: { organizationId: DEMO_ORG, name: d.name } } });
    if (!item) {
      skipped.push(`${d.name}: no such product (run npm run seed:gr-chicken)`);
      continue;
    }
    if (item.stockQty !== null && !item.stockIsDemo) {
      skipped.push(`${d.name}: real stock entered by staff — left unchanged`);
      continue;
    }
    const qty = new Prisma.Decimal(d.qty.toFixed(3));
    const lowAt = new Prisma.Decimal(d.lowAt.toFixed(3));
    const status = stockStatus({ stockQty: qty, lowStockThreshold: lowAt, minQty: item.minQty });
    const unchanged = item.stockQty !== null && qty.equals(item.stockQty) && item.lowStockThreshold !== null && lowAt.equals(item.lowStockThreshold);
    if (!unchanged) {
      await client.$transaction([
        // The alert level matches the demo numbers, so seeding never sends a stock alert by itself.
        client.menuItem.update({ where: { id: item.id }, data: { stockQty: qty, lowStockThreshold: lowAt, stockIsDemo: true, stockUpdatedAt: new Date(), stockAlertLevel: alertLevel(status) } }),
        client.inventoryMovement.create({ data: { organizationId: DEMO_ORG, menuItemId: item.id, delta: qty.minus(item.stockQty ?? 0), balanceAfter: qty, reason: 'demo_seed', actor: 'seed:gr-chicken-demo' } }),
      ]);
    }
    result.push({ name: d.name, qty: d.qty, unit: item.unit === 'piece' ? 'piece' : 'kg', status });
  }
  return { stock: result, skipped };
}

export async function seedDemo(client: PrismaClient = prisma, now = new Date()) {
  const org = await client.organization.findUnique({ where: { id: DEMO_ORG } });
  if (!org || org.vertical !== 'restaurant') throw new Error(`Organization ${DEMO_ORG} not found or not a restaurant. Run npm run seed:gr-chicken first.`);
  const shop = await client.outlet.findFirst({ where: { organizationId: DEMO_ORG, active: true }, orderBy: { sortOrder: 'asc' } });
  if (!shop) throw new Error('No active shop for GR Chicken. Run npm run seed:gr-chicken first.');
  const products = await client.menuItem.findMany({ where: { organizationId: DEMO_ORG } });
  const at = (minFromNow: number) => new Date(now.getTime() + minFromNow * MIN);
  let customers = 0;
  let orders = 0;
  const skipped: string[] = [];

  for (const spec of SPECS) {
    const phone = demoPhone(spec.n);
    const existing = await client.customer.findFirst({ where: { organizationId: DEMO_ORG, phone } });
    if (existing && !existing.isDemo) {
      skipped.push(`${phone}: a real customer has this number, left untouched`);
      continue;
    }
    const customerData = {
      name: spec.name,
      language: spec.language,
      source: 'demo',
      messagingConsent: spec.messaging,
      callingConsent: spec.calling,
      optedOutAt: spec.optedOut ? at(-500) : null,
      isDemo: true,
      lastInboundAt: spec.status === 'completed' || spec.status === 'ready' ? at(-(spec.collectedMinAgo ?? 30)) : at(-spec.placedMinAgo),
    };
    const customer = existing
      ? await client.customer.update({ where: { id: existing.id }, data: customerData })
      : await client.customer.create({ data: { organizationId: DEMO_ORG, phone, ...customerData } });
    customers++;

    const id = `demo_order_${pad(spec.n)}`;
    const prior = await client.order.findUnique({ where: { id } });
    if (prior && (!prior.isDemo || prior.organizationId !== DEMO_ORG)) {
      skipped.push(`${id}: exists and is not demo data, left untouched`);
      continue;
    }
    const lines = spec.lines.map((l) => {
      const p = products.find((x) => x.name === l.product);
      if (!p) throw new Error(`Product "${l.product}" not found in the GR Chicken menu. Run npm run seed:gr-chicken first.`);
      const unitPrice = Number(p.price);
      return { menuItemId: p.id, name: p.name, cut: l.cut ?? null, unit: p.unit, unitPrice, quantity: l.qty, lineTotal: Math.round(unitPrice * l.qty * 100) / 100 };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const conversation = await client.conversation.upsert({
      where: { organizationId_channel_externalId: { organizationId: DEMO_ORG, channel: 'whatsapp', externalId: phone } },
      create: { id: `demo_conv_${pad(spec.n)}`, organizationId: DEMO_ORG, customerId: customer.id, channel: 'whatsapp', externalId: phone, status: spec.feedback?.complaint === 'open' ? 'human_handoff' : 'active', updatedAt: at(-(spec.collectedMinAgo ?? spec.placedMinAgo)) },
      update: { customerId: customer.id, status: spec.feedback?.complaint === 'open' ? 'human_handoff' : 'active' },
    });
    const orderData = {
      organizationId: DEMO_ORG,
      orderNumber: `GR-DEMO${pad(spec.n)}`,
      customerId: customer.id,
      conversationId: conversation.id,
      outletId: shop.id,
      channel: 'demo',
      status: spec.status,
      pickupAt: at(spec.pickupMin),
      subtotal: new Prisma.Decimal(subtotal.toFixed(2)),
      discount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(subtotal.toFixed(2)),
      paymentMethod: spec.payment,
      paymentStatus: spec.paid ? 'paid' : spec.payment === 'paid_online' ? 'customer_says_paid' : 'unpaid',
      posStatus: 'not_integrated',
      idempotencyKey: `demo-seed:${pad(spec.n)}`,
      customerName: spec.name,
      customerPhone: phone,
      language: spec.language,
      isDemo: true,
      demoScenario: spec.scenario,
      collectedAt: spec.collectedMinAgo !== undefined ? at(-spec.collectedMinAgo) : null,
      feedbackRating: spec.feedback?.rating ?? null,
      feedbackComment: spec.feedback?.comment ?? null,
      feedbackAt: spec.feedback ? at(-(spec.collectedMinAgo ?? 0) + 60) : null,
      feedbackChannel: spec.feedback?.channel ?? null,
      complaintStatus: spec.feedback?.complaint ?? null,
      complaintNote: spec.feedback?.complaint ? spec.feedback.comment ?? null : null,
      followUpStatus: spec.followUps.some((f) => f.status === 'scheduled') ? 'scheduled' : spec.followUps.length ? (spec.status === 'cancelled' ? 'skipped' : 'done') : null,
      lastContactAt: (() => {
        const past = spec.followUps.filter((f) => f.minFromNow <= 0 && !['scheduled', 'cancelled', 'skipped'].includes(f.status));
        return past.length ? at(Math.max(...past.map((f) => f.minFromNow))) : null;
      })(),
      nextFollowUpAt: (() => {
        const next = spec.followUps.filter((f) => f.status === 'scheduled');
        return next.length ? at(Math.min(...next.map((f) => f.minFromNow))) : null;
      })(),
      createdAt: at(-spec.placedMinAgo),
    };
    await client.order.upsert({ where: { id }, create: { id, ...orderData }, update: orderData });
    await client.orderItem.deleteMany({ where: { orderId: id } });
    await client.orderItem.createMany({
      data: lines.map((l) => ({ orderId: id, menuItemId: l.menuItemId, name: l.name, cut: l.cut, unit: l.unit, unitPrice: new Prisma.Decimal(l.unitPrice.toFixed(2)), quantity: new Prisma.Decimal(l.quantity.toFixed(3)), lineTotal: new Prisma.Decimal(l.lineTotal.toFixed(2)) })),
    });
    // History is rebuilt on every run so it matches the current times (demo orders only).
    await client.orderEvent.deleteMany({ where: { orderId: id } });
    await client.orderEvent.create({ data: { organizationId: DEMO_ORG, orderId: id, type: 'created', toStatus: 'pending', actor: 'system', note: 'Demo order (seed). Not a real customer.', createdAt: at(-spec.placedMinAgo) } });
    if (spec.feedback?.complaint) {
      await client.orderEvent.create({ data: { organizationId: DEMO_ORG, orderId: id, type: 'complaint', actor: 'ai', note: `Complaint escalated to staff via ${spec.feedback.channel}: ${spec.feedback.rating}/5 (demo)` } });
    }

    for (const f of spec.followUps) {
      const dedupeKey = `demo-seed:${pad(spec.n)}:${f.kind}`;
      const channel = f.kind === 'feedback_call' ? 'voice' : 'whatsapp';
      let callId: string | null = null;
      if (channel === 'voice' && ['completed', 'no_answer'].includes(f.status)) {
        callId = `demo_call_${pad(spec.n)}`;
        const callData = {
          organizationId: DEMO_ORG,
          customerId: customer.id,
          direction: 'outbound',
          status: f.status === 'completed' ? 'completed' : 'no_answer',
          outcome: f.status === 'completed' ? (spec.feedback?.complaint ? 'human_requested' : 'connected') : 'no_answer',
          toNumber: phone,
          fromNumber: 'dry-run',
          attempt: f.attempts ?? 1,
          language: spec.language === 'english' ? 'en-IN' : 'ta-IN',
          answeredAt: f.status === 'completed' ? at(f.minFromNow) : null,
          endedAt: at(f.minFromNow + 1),
          durationSec: f.status === 'completed' ? 28 : null,
          providerCallId: `dryrun-call-demo-${pad(spec.n)}`,
          summary: f.status === 'completed' ? `[SIMULATED] Feedback call for GR-DEMO${pad(spec.n)}: ${spec.feedback?.rating ?? '-'}/5${spec.feedback?.complaint ? ', complaint escalated' : ''}` : `[SIMULATED] Feedback call for GR-DEMO${pad(spec.n)}: no answer`,
          createdAt: at(f.minFromNow),
        };
        await client.call.upsert({ where: { id: callId }, create: { id: callId, ...callData }, update: callData });
      }
      const data = {
        orderId: id,
        customerId: customer.id,
        kind: f.kind,
        channel,
        status: f.status,
        scheduledAt: at(f.minFromNow),
        attempts: f.attempts ?? (f.status === 'scheduled' ? 0 : 1),
        maxAttempts: channel === 'voice' ? 2 : 3,
        dryRun: true,
        providerMessageId: channel === 'whatsapp' && !['scheduled', 'cancelled', 'skipped'].includes(f.status) ? `dryrun-wamid-demo-${pad(spec.n)}-${f.kind}` : null,
        callId,
        lastError: f.error ?? null,
        result: (f.result ?? { simulated: true }) as never,
        completedAt: ['completed', 'skipped', 'cancelled', 'no_answer'].includes(f.status) ? at(f.minFromNow) : null,
      };
      await client.orderFollowUp.upsert({
        where: { organizationId_dedupeKey: { organizationId: DEMO_ORG, dedupeKey } },
        create: { organizationId: DEMO_ORG, dedupeKey, ...data },
        update: data,
      });
    }
    orders++;
  }
  const stock = await seedDemoStock(client);
  return { customers, orders, skipped: [...skipped, ...stock.skipped], stock: stock.stock };
}

// Run when executed directly (not when imported by tests).
if (process.argv[1] && /seed-gr-chicken-demo\.ts$/.test(process.argv[1])) {
  seedDemo()
    .then((r) => {
      console.log(`GR Chicken demo data: ${r.customers} demo customers, ${r.orders} demo orders (org ${DEMO_ORG}).`);
      for (const s of r.stock) console.log(`Demo stock: ${s.name} ${s.qty} ${s.unit === 'piece' ? 'pcs' : 'kg'} (${s.status})`);
      for (const s of r.skipped) console.log(`Skipped: ${s}`);
      console.log('All demo records are marked isDemo and use 91 00000 1xxxx numbers that cannot belong to anyone. Follow-ups for them are always simulated.');
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
