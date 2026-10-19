/**
 * Synthetic DEMO workspaces, one per industry, that show every workflow end to end:
 *   textile · retail · GR Chicken (meat shop) · restaurant & food ordering · hotel & room booking ·
 *   hospital & healthcare · real estate · manufacturing & quality · marketing agency
 *
 *   DEMO_SEED_CONFIRM=yes DEMO_SEED_DATABASE=<the DB_NAME you mean> DEMO_USER_PASSWORD='<12+ chars>' \
 *     npm run seed:industry-demos -w apps/api
 *   optional: DEMO_USER_EMAIL=demo@tacksharp.demo   DEMO_GRANT_EMAILS=owner@example.com,manager@example.com
 *             DEMO_SEED_RESET=yes   (one-off: delete the demo workspaces' records first, e.g. after an older seed)
 *
 * Safety:
 *   - explicit command only: nothing runs at startup, build or deploy;
 *   - refuses unless DEMO_SEED_CONFIRM=yes and DEMO_SEED_DATABASE equals the database it is connected to;
 *   - writes ONLY to its own fixed organizations (org_demo_*), each flagged Organization.isDemo = true, and refuses if one
 *     of those ids exists as a NON-demo organization (it never touches a live business or GR Chicken's live org);
 *   - stable ids + upserts and a seeded random generator: re-running updates the same rows (no duplicates) and never
 *     touches records users created in the demo workspaces;
 *   - every synthetic record is labelled (isDemo where the model has the flag, "seed:demo" as actor / creator, DEMO-
 *     references); simulated messages / calls / payments are labelled SIMULATED and never presented as provider receipts;
 *   - no password is hardcoded or printed: the demo user's password comes from DEMO_USER_PASSWORD.
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { Prisma, PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password.js';

const DB_NAME = process.env.DB_NAME ?? 'tacksharp';
if (process.env.DEMO_SEED_CONFIRM !== 'yes') {
  console.error('Refusing to run: set DEMO_SEED_CONFIRM=yes to create / update the demo workspaces (org_demo_*).');
  process.exit(1);
}
if (process.env.DEMO_SEED_DATABASE !== DB_NAME) {
  console.error(`Refusing to run: set DEMO_SEED_DATABASE=${DB_NAME} to confirm that "${DB_NAME}" on ${process.env.DB_HOST ?? 'localhost'} is the staging / test database you mean.`);
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: DB_NAME,
  }),
});

export const DEMO_ORGS = {
  textile: { id: 'org_demo_textile', name: 'Demo · Kaveri Silks & Textiles', vertical: 'real_estate', industry: 'textile', ws: 1 },
  restaurant: { id: 'org_demo_restaurant', name: 'Demo · GR Chicken (sample shop)', vertical: 'restaurant', industry: 'real_estate', ws: 2 },
  real_estate: { id: 'org_demo_real_estate', name: 'Demo · Chennai Homes Realty', vertical: 'real_estate', industry: 'real_estate', ws: 3 },
  retail: { id: 'org_demo_retail', name: 'Demo · UrbanCart Store', vertical: 'real_estate', industry: 'retail', ws: 4 },
  manufacturing: { id: 'org_demo_manufacturing', name: 'Demo · Precision Components', vertical: 'real_estate', industry: 'manufacturing', ws: 5 },
  agency: { id: 'org_demo_agency', name: 'Demo · BrightLeaf Marketing', vertical: 'real_estate', industry: 'agency', ws: 6 },
  food: { id: 'org_demo_food', name: 'Demo · Spice Route Kitchen', vertical: 'real_estate', industry: 'food', ws: 7 },
  hotel: { id: 'org_demo_hotel', name: 'Demo · Marina Bay Residency', vertical: 'real_estate', industry: 'hotel', ws: 8 },
  hospital: { id: 'org_demo_hospital', name: 'Demo · Sunrise Multispeciality Hospital', vertical: 'real_estate', industry: 'hospital', ws: 9 },
  cctv: { id: 'org_demo_cctv', name: 'Demo · SecureEye CCTV Services', vertical: 'real_estate', industry: 'cctv', ws: 0 },
} as const;
type Key = keyof typeof DEMO_ORGS;

const DAY = 86_400_000;
const IST = 330 * 60_000;
const NOW = Date.now();
const dec = (v: number) => new Prisma.Decimal(v.toFixed(2));
const NAMES = ['Ravi Kumar', 'Meena S', 'Karthik R', 'Lakshmi N', 'Senthil M', 'Priya V', 'Arun P', 'Divya K', 'Gopal R', 'Revathi K', 'Suresh B', 'Anitha P', 'Bala S', 'Nandhini V', 'Mohammed F', 'Deepa N', 'Vignesh T', 'Kavitha R', 'Rajesh I', 'Sangeetha M', 'Hari K', 'Janani S', 'Prakash R', 'Yamuna D', 'Dinesh K', 'Shalini G', 'Ashwin V', 'Bhuvana R', 'Farhan A', 'Ishwarya M', 'Joseph P', 'Keerthana S', 'Lokesh B', 'Mahalakshmi T', 'Naveen C', 'Oviya R', 'Pandian K', 'Ramya J', 'Sathya N', 'Tamilselvi E'];
/** Synthetic numbers in a reserved demo range per workspace (never real customers). */
const phoneFor = (ws: number, i: number) => `910000${ws}${String(i).padStart(5, '0')}`;
const istDay = (t: number) => new Date(t + IST).toISOString().slice(0, 10);
const dayOnly = (d: string) => new Date(`${d}T00:00:00.000Z`);
const addDays = (d: string, k: number) => new Date(dayOnly(d).getTime() + k * DAY).toISOString().slice(0, 10);
const istAt = (d: string, hhmm: string) => new Date(dayOnly(d).getTime() + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60_000 - IST);
const TODAY = istDay(NOW);

/** Deterministic random numbers per workspace: the same run produces the same rows. */
function rng(seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return {
    rnd,
    pick: <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)],
    int: (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1)),
    ago: (maxDays: number, minDays = 0) => new Date(NOW - (minDays + rnd() * (maxDays - minDays)) * DAY),
  };
}

const counts: Record<string, Record<string, number>> = {};
/** Upsert by stable id; the update writes the same data (refreshes relative dates), never other rows. */
async function put<T = Record<string, unknown>>(model: string, org: string, id: string, data: Record<string, unknown>): Promise<T & { id: string }> {
  const m = (prisma as unknown as Record<string, { upsert: (a: unknown) => Promise<T & { id: string }> }>)[model];
  const row = await m.upsert({ where: { id }, create: { id, ...data }, update: data });
  const c = (counts[org] ??= {});
  c[model] = (c[model] ?? 0) + 1;
  return row;
}
const sid = (org: string, kind: string, i: number | string) => `${org.replace('org_demo_', 'dm_')}_${kind}_${i}`;

async function assertSafe() {
  const ids = Object.values(DEMO_ORGS).map((o) => o.id);
  const live = await prisma.organization.findMany({ where: { id: { in: ids }, isDemo: false }, select: { id: true } });
  if (live.length) {
    console.error(`Refusing to run: ${live.map((o) => o.id).join(', ')} exist and are NOT demo workspaces.`);
    process.exit(1);
  }
}

/** Optional one-off reset (DEMO_SEED_RESET=yes): delete a demo workspace's records, children first. */
async function reset(orgId: string) {
  const exists = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!exists) return;
  if (!exists.isDemo) throw new Error(`${orgId} is not a demo workspace`);
  const where = { organizationId: orgId };
  for (const model of ['incidentTimelineEvent', 'notificationAttempt', 'downtimeIncident', 'healthEvent', 'agentHeartbeat', 'monitoringAgent', 'cameraDevice', 'recorderDevice', 'siteTechnician', 'serviceContract', 'siteUptimeSnapshot', 'monitoringSite', 'monitoringCustomer', 'agentSession', 'reservation', 'roomRate', 'room', 'roomType', 'insuranceCase', 'appointment', 'doctor', 'department', 'payment', 'invoice', 'feedback', 'salesOrder', 'quotation', 'orderFollowUp', 'orderEvent', 'offerClaim', 'order', 'siteVisit', 'call', 'inventoryMovement', 'stockMovement', 'inventoryBalance', 'menuItem', 'menuCategory', 'outlet', 'campaignRecipient', 'marketingCampaign', 'workTask', 'auditEvent', 'followUp', 'message', 'conversation', 'lead', 'qualityInspection', 'textileProduct', 'property']) {
    await (prisma as unknown as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>)[model].deleteMany({ where });
  }
  await prisma.customer.deleteMany({ where });
}

async function org(key: Key, extra: Record<string, unknown> = {}) {
  const o = DEMO_ORGS[key];
  await prisma.organization.upsert({ where: { id: o.id }, create: { id: o.id, name: o.name, vertical: o.vertical, isDemo: true }, update: { name: o.name, vertical: o.vertical, isDemo: true } });
  const settings = {
    industry: o.industry, textile: { quoteReminderDays: 2, feedbackAfterHours: 24, notifyOrderStatus: true, maxDiscountPct: 10 }, agents: { paused: [] },
    finance: { paymentTermsDays: 15, dispatchPaymentRule: 'none', autoDraftInvoice: true }, roi: { costPerLeadInr: 400, voiceCostPerMinuteInr: 0, whatsappCostPerMessageInr: 0.8 }, ...extra,
  };
  await prisma.organizationSettings.upsert({ where: { organizationId: o.id }, create: { organizationId: o.id, data: settings as never }, update: { data: settings as never } });
  return o.id;
}

type R = ReturnType<typeof rng>;
async function customers(r: R, orgId: string, ws: number, count: number, extra: (i: number) => Record<string, unknown> = () => ({})) {
  const out: Array<{ id: string; phone: string; name: string }> = [];
  for (let i = 0; i < count; i++) {
    const c = await put<{ phone: string; name: string }>('customer', orgId, sid(orgId, 'cus', i), { organizationId: orgId, phone: phoneFor(ws, i), name: NAMES[i % NAMES.length], isDemo: true, messagingConsent: r.rnd() > 0.2, callingConsent: r.rnd() > 0.5, language: r.pick(['english', 'tamil', 'tanglish']), createdAt: r.ago(60, 20), ...extra(i) });
    out.push(c);
  }
  return out;
}

async function leadsFor(r: R, orgId: string, list: Array<{ id: string }>, opts: { sources: string[]; statuses: string[]; extra?: (i: number) => Record<string, unknown> }) {
  const out: Array<{ id: string; customerId: string; status: string }> = [];
  for (let i = 0; i < list.length; i++) {
    const lead = await put<{ customerId: string; status: string; createdAt: Date }>('lead', orgId, sid(orgId, 'lead', i), { organizationId: orgId, customerId: list[i].id, source: r.pick(opts.sources), status: r.pick(opts.statuses), createdAt: r.ago(30), ...(opts.extra?.(i) ?? {}) });
    out.push(lead);
    // Workflow transitions in the audit trail for the first leads (who moved them and when).
    if (i < 8 && lead.status !== 'new') await audit(orgId, `lead_${i}`, 'lead', lead.id, `status:${lead.status}`, new Date(lead.createdAt.getTime() + 3_600_000), { to: lead.status }, i % 2 ? 'ai' : 'user:demo-staff');
  }
  return out;
}

/** Follow-up tasks in every state (pending, scheduled, completed, failed, escalated to a person, simulated, cancelled). */
async function followUps(r: R, orgId: string, leads: Array<{ id: string; customerId: string }>, steps: Array<{ source: string; message: string; channel?: string }>) {
  const states = ['scheduled', 'scheduled', 'completed', 'completed', 'simulated', 'failed', 'cancelled', 'skipped'];
  let i = 0;
  for (const l of leads.slice(0, 20)) {
    const st = steps[i % steps.length];
    const status = states[i % states.length];
    const future = status === 'scheduled';
    await put('followUp', orgId, sid(orgId, 'fu', i), {
      organizationId: orgId, leadId: l.id, customerId: l.customerId, channel: st.channel ?? 'whatsapp', action: st.channel === 'voice' ? 'call' : 'message', source: st.source, message: st.message, status,
      scheduledAt: future ? new Date(NOW + (1 + r.rnd() * 48) * 3_600_000) : r.ago(20, 0.5), attempts: future ? 0 : status === 'failed' ? 3 : 1,
      lastError: status === 'failed' ? 'Demo: WhatsApp window closed and no approved template' : status === 'simulated' ? 'DRY_RUN: message not sent (simulated)' : status === 'cancelled' ? null : status === 'skipped' ? 'customer_replied' : null,
      cancellationReason: status === 'cancelled' ? 'opted_out' : null, completedAt: future ? null : r.ago(20, 0.5),
    });
    i++;
  }
  // Human handoffs (escalations) waiting for staff.
  for (const [k, l] of leads.slice(20, 23).entries()) {
    await put('followUp', orgId, sid(orgId, 'handoff', k), { organizationId: orgId, leadId: l.id, customerId: l.customerId, channel: 'human', action: 'handoff', source: 'task', status: k === 2 ? 'completed' : 'open', message: ['Handoff: Customer asked for a person', 'Handoff: Complaint — "order arrived late"', 'Handoff: Asked about a bulk discount'][k], scheduledAt: r.ago(3), completedAt: k === 2 ? r.ago(1) : null });
  }
}

/** Example conversation histories (synthetic, labelled). */
async function conversation(orgId: string, key: string, customer: { id: string; phone: string }, status: string, turns: Array<[('user' | 'assistant'), string]>, startAgoHours: number, channel = 'whatsapp') {
  const convId = sid(orgId, 'conv', key);
  const start = NOW - startAgoHours * 3_600_000;
  await put('conversation', orgId, convId, { organizationId: orgId, customerId: customer.id, channel, externalId: customer.phone, status, createdAt: new Date(start), updatedAt: new Date(start + turns.length * 60_000) });
  for (const [i, [role, content]] of turns.entries()) {
    await put('message', orgId, `${convId}_m${i}`, { organizationId: orgId, conversationId: convId, role, content, createdAt: new Date(start + i * 60_000), metadata: { demo: true, ...(role === 'assistant' ? { simulated: true, path: 'rules' } : {}) } as never });
  }
}

async function audit(orgId: string, key: string, entityType: string, entityId: string, action: string, at: Date, data: Record<string, unknown> = {}, actor = 'seed:demo') {
  await put('auditEvent', orgId, sid(orgId, 'audit', key), { organizationId: orgId, actor, entityType, entityId, action, data: data as never, createdAt: at });
}

async function campaign(r: R, orgId: string, name: string, list: Array<{ id: string }>, leads: Array<{ id: string; customerId: string }>) {
  const c = await put('marketingCampaign', orgId, sid(orgId, 'camp', 0), { organizationId: orgId, name, status: 'completed', templateName: 'demo_offer', templateLanguage: 'en', startedAt: r.ago(20, 10), completedAt: r.ago(10, 5), simulated: true, createdBy: 'seed:demo' });
  for (const [i, cu] of list.slice(0, 20).entries()) {
    const delivered = r.rnd() > 0.1, replied = delivered && r.rnd() > 0.65;
    const lead = replied ? leads.find((l) => l.customerId === cu.id) : undefined;
    await put('campaignRecipient', orgId, sid(orgId, 'rcpt', i), { organizationId: orgId, campaignId: c.id, customerId: cu.id, status: replied ? 'replied' : delivered ? 'simulated' : 'failed', providerMessageId: null, sentAt: r.ago(18, 12), deliveredAt: null, repliedAt: replied ? r.ago(10, 8) : null, leadId: lead?.id ?? null, reason: delivered ? null : 'Demo: number not on WhatsApp' });
  }
}

// ================================================================================================ textile / retail

async function salesWorkspace(key: 'textile' | 'retail') {
  const r = rng(key === 'textile' ? 101 : 104);
  const ws = DEMO_ORGS[key].ws;
  const orgId = await org(key);
  const catalogue = key === 'textile'
    ? [['TX-SH-01', 'Cotton Formal Shirt', 'shirts', 'white', '100% cotton', 650, 'piece'], ['TX-SH-02', 'Linen Casual Shirt', 'shirts', 'sky blue', 'linen blend', 890, 'piece'], ['TX-TR-01', 'Poly-Viscose Trousers', 'trousers', 'charcoal', '65/35 PV', 780, 'piece'], ['TX-TR-02', 'Cotton Chinos', 'trousers', 'khaki', 'cotton twill', 950, 'piece'], ['TX-SA-01', 'Kanchipuram Silk Saree', 'sarees', 'maroon', 'pure silk', 12500, 'piece'], ['TX-SA-02', 'Chettinad Cotton Saree', 'sarees', 'mustard', 'cotton', 1450, 'piece'], ['TX-SA-03', 'Soft Silk Saree', 'sarees', 'peacock green', 'art silk', 3200, 'piece'], ['TX-FB-01', 'Poplin Fabric', 'fabrics', 'white', '100% cotton', 120, 'metre'], ['TX-FB-02', 'Rayon Print Fabric', 'fabrics', 'floral', 'rayon', 160, 'metre'], ['TX-FB-03', 'Denim Fabric 10 oz', 'fabrics', 'indigo', 'cotton denim', 260, 'metre'], ['TX-KU-01', 'Cotton Kurta', 'kurtas', 'beige', 'cotton', 720, 'piece'], ['TX-DH-01', 'Silk Border Dhoti', 'dhotis', 'cream', 'cotton silk', 540, 'piece']] as const
    : [['RT-EA-01', 'Wireless Earbuds', 'audio', 'black', null, 1999, 'piece'], ['RT-EA-02', 'Neckband Headphones', 'audio', 'blue', null, 1299, 'piece'], ['RT-PB-01', '20000 mAh Power Bank', 'mobile accessories', 'grey', null, 1799, 'piece'], ['RT-CH-01', '65W Fast Charger', 'mobile accessories', 'white', null, 1499, 'piece'], ['RT-SW-01', 'Smart Watch', 'wearables', 'black', null, 3499, 'piece'], ['RT-KB-01', 'Steel Water Bottle 1L', 'home & kitchen', 'silver', null, 549, 'piece'], ['RT-KB-02', 'Non-stick Tawa', 'home & kitchen', 'black', null, 899, 'piece'], ['RT-LP-01', 'Laptop Backpack', 'bags', 'navy', null, 1599, 'piece'], ['RT-LP-02', 'Desk Lamp LED', 'home & kitchen', 'white', null, 999, 'piece'], ['RT-FT-01', 'Yoga Mat', 'fitness', 'purple', null, 799, 'piece']] as const;
  const products: Array<{ id: string; sku: string; name: string; priceUnit: string; price: Prisma.Decimal }> = [];
  for (const [i, [sku, name, category, colour, composition, price, unit]] of catalogue.entries()) {
    const p = await put<{ sku: string; name: string; priceUnit: string; price: Prisma.Decimal }>('textileProduct', orgId, sid(orgId, 'prod', i), { organizationId: orgId, sku, name, fabricCategory: category, colour, composition, priceUnit: unit, price: dec(price), priceApproved: true, stockStatus: r.pick(['in_stock', 'in_stock', 'low']), sizes: category === 'shirts' || category === 'kurtas' ? 'S,M,L,XL' : null, moq: key === 'textile' && unit === 'metre' ? 100 : null });
    const onHand = i === 2 ? 4 : unit === 'metre' ? r.int(80, 900) : r.int(2, 120);
    await put('inventoryBalance', orgId, sid(orgId, 'bal', i), { organizationId: orgId, productId: p.id, onHand: dec(onHand), lowStockAt: dec(unit === 'metre' ? 150 : 15) });
    await put('stockMovement', orgId, sid(orgId, 'mv', i), { organizationId: orgId, productId: p.id, type: 'receive', quantity: dec(onHand), onHandAfter: dec(onHand), reservedAfter: dec(0), reference: `DEMO-GRN-${sku}`, actor: 'seed:demo', idempotencyKey: `demo:grn:${sku}` });
    products.push(p);
  }
  const list = await customers(r, orgId, ws, 28, () => ({ tags: [r.pick(key === 'textile' ? ['saree_buyer', 'wholesale', 'uniforms'] : ['gadgets', 'home', 'fitness'])] }));
  const leads = await leadsFor(r, orgId, list, { sources: ['whatsapp', 'meta', 'walk_in', 'website', 'referral'], statuses: key === 'textile' ? ['new', 'contacted', 'qualified', 'catalogue_shared', 'quotation_sent', 'order_confirmed', 'repeat_customer', 'lost'] : ['new', 'contacted', 'catalogue_shared', 'order_confirmed', 'repeat_customer', 'lost'] });
  let qn = 1, on = 1;
  for (let i = 0; i < 18; i++) {
    const lead = leads[i];
    const lines = Array.from({ length: r.int(1, 3) }, () => r.pick(products));
    const items = lines.map((p) => {
      const qty = p.priceUnit === 'metre' ? r.int(100, 600) : r.int(1, key === 'textile' ? 60 : 4);
      return { productId: p.id, sku: p.sku, description: p.name, quantity: dec(qty), unit: p.priceUnit, unitPrice: p.price, lineTotal: dec(qty * Number(p.price)) };
    });
    const subtotal = items.reduce((a, x) => a + Number(x.lineTotal), 0);
    const total = Math.round(subtotal * 1.05 * 100) / 100;
    const created = r.ago(28, 1);
    const qStatus = key === 'retail' ? 'accepted' : r.pick(['draft', 'sent', 'sent', 'accepted', 'accepted', 'accepted', 'rejected', 'expired']);
    const q = await put('quotation', orgId, sid(orgId, 'quo', i), { organizationId: orgId, customerId: lead.customerId, leadId: lead.id, number: `DEMO-Q-${String(qn++).padStart(4, '0')}`, status: qStatus, subtotal: dec(subtotal), taxPercent: dec(5), tax: dec(subtotal * 0.05), total: dec(total), origin: r.pick(['manual', 'ai_request']), createdAt: created, sentAt: qStatus === 'draft' ? null : created });
    for (const [k, it] of items.entries()) await put('quotationItem', orgId, `${q.id}_i${k}`, { quotationId: q.id, ...it });
    if (qStatus !== 'accepted') continue;
    const status = r.pick(['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered', 'delivered', 'cancelled']);
    const order = await put('salesOrder', orgId, sid(orgId, 'so', i), { organizationId: orgId, customerId: lead.customerId, leadId: lead.id, quotationId: q.id, number: `DEMO-SO-${String(on++).padStart(4, '0')}`, status, paymentStatus: status === 'delivered' ? 'paid' : r.pick(['unpaid', 'partial']), total: dec(total), createdAt: new Date(created.getTime() + DAY), deliveredAt: status === 'delivered' ? new Date(created.getTime() + 5 * DAY) : null, courier: ['dispatched', 'delivered'].includes(status) ? 'ST Courier' : null, trackingRef: ['dispatched', 'delivered'].includes(status) ? `DEMO${r.int(100000, 999999)}` : null });
    for (const [k, it] of items.entries()) await put('salesOrderItem', orgId, `${order.id}_i${k}`, { orderId: order.id, ...it });
    await audit(orgId, `so_${i}`, 'order', order.id, `status:${status}`, new Date(created.getTime() + 2 * DAY), { to: status });
    if (status === 'delivered') await put('feedback', orgId, sid(orgId, 'fb', i), { organizationId: orgId, customerId: lead.customerId, orderId: order.id, status: r.pick(['received', 'received', 'resolved']), rating: r.int(2, 5), comment: r.pick(['Good quality', 'Delivered on time', 'Colour slightly different', 'Excellent finish']) });
  }
  await followUps(r, orgId, leads, key === 'textile' ? [{ source: 'quote', message: 'quote:reminder:demo' }, { source: 'order', message: 'order:status:demo:dispatched' }, { source: 'feedback', message: 'feedback:request:demo' }] : [{ source: 'order', message: 'order:status:demo:dispatched' }, { source: 'feedback', message: 'feedback:request:demo' }]);
  await campaign(r, orgId, key === 'textile' ? 'Demo · Diwali silk collection (simulated)' : 'Demo · Festive gadget sale (simulated)', list, leads);
  await conversation(orgId, 'c1', list[0], 'active', key === 'textile'
    ? [['user', 'Hi, I need 200 cotton shirts in three sizes for our school staff. Can you share a quotation?'], ['assistant', 'Thank you! Noted: Cotton Formal Shirt, 200 pieces, sizes S / M / L. Approved price ₹650 per piece. I have created a quotation request; our sales team will send the quotation shortly.'], ['user', 'Can you do it in light blue?'], ['assistant', 'Light blue is available in Linen Casual Shirt (₹890). I have added your colour preference to the request for the salesperson.']]
    : [['user', 'Do you have the 65W charger in stock?'], ['assistant', 'Thanks for asking! Our team will check and reply here shortly.'], ['user', 'ok']], 30);
  await conversation(orgId, 'c2', list[1], 'human_handoff', [['user', 'I want to talk to a person about a bulk order'], ['assistant', 'Sure — a team member will reply to you here shortly.']], 6);
  return orgId;
}

// ================================================================================================ GR Chicken (meat shop)

async function grWorkspace() {
  const r = rng(102);
  const orgId = await org('restaurant');
  const outlet = await put('outlet', orgId, sid(orgId, 'outlet', 0), { organizationId: orgId, name: 'GR Chicken Demo Shop · Porur', address: 'DEMO address, Porur, Chennai', area: 'Porur', isDemo: true, opensAt: '07:00', closesAt: '21:00', prepMinutes: 30, acceptOutsideHours: true });
  const CURRY = 'Curry cut', BIRYANI = 'Biryani cut', FRY = 'Fry cut', WHOLE = 'Whole';
  const menu: Array<[string, Array<{ name: string; price: number; unit?: string; cuts?: string[]; aliases: string; minQty?: number; maxQty?: number; qtyStep?: number }>]> = [
    ['Chicken', [
      { name: 'Broiler Chicken', price: 220, cuts: [CURRY, BIRYANI, FRY, WHOLE], aliases: 'broiler, broiler chicken, chicken, kozhi, koli, கோழி, பிராய்லர்' },
      { name: 'Skinless Chicken', price: 260, cuts: [CURRY, BIRYANI, FRY], aliases: 'skinless, skin less, without skin, skin illama' },
      { name: 'Country Chicken', price: 450, cuts: [CURRY, BIRYANI, WHOLE], aliases: 'country, country chicken, nattu kozhi, naatu kozhi, நாட்டு கோழி' },
      { name: 'Boneless Chicken', price: 380, aliases: 'boneless, bone less', minQty: 0.25 },
    ]],
    ['Parts', [{ name: 'Chicken Wings', price: 240, aliases: 'wings, wing', minQty: 0.25 }, { name: 'Chicken Liver', price: 160, aliases: 'liver, eeral, ஈரல்', minQty: 0.25 }]],
    ['Eggs', [{ name: 'Country Eggs', price: 12, unit: 'piece', aliases: 'eggs, egg, muttai, முட்டை', minQty: 1, maxQty: 60, qtyStep: 1 }]],
  ];
  const items: Array<{ id: string; name: string; price: Prisma.Decimal; unit: string; cutOptions: unknown }> = [];
  let sort = 0;
  for (const [ci, [cat, list]] of menu.entries()) {
    const c = await put('menuCategory', orgId, sid(orgId, 'cat', ci), { organizationId: orgId, name: cat, sortOrder: ci });
    for (const it of list) {
      items.push(await put('menuItem', orgId, sid(orgId, 'item', sort), { organizationId: orgId, categoryId: c.id, name: it.name, price: dec(it.price), unit: it.unit ?? 'kg', cutOptions: it.cuts ?? [], aliases: it.aliases, minQty: dec(it.minQty ?? 0.5), maxQty: dec(it.maxQty ?? 10), qtyStep: dec(it.qtyStep ?? 0.25), isDemo: true, sortOrder: sort, available: true, stockQty: it.unit === 'piece' ? dec(240) : dec(r.int(8, 40)), lowStockThreshold: dec(it.unit === 'piece' ? 30 : 5), stockIsDemo: true, description: 'DEMO price — not verified GR Chicken data' }));
      sort++;
    }
  }
  const list = await customers(r, orgId, DEMO_ORGS.restaurant.ws, 26);
  const leads = await leadsFor(r, orgId, list, { sources: ['whatsapp', 'website', 'voice'], statuses: ['new', 'contacted', 'won'] });
  for (let i = 0; i < 64; i++) {
    const created = i < 6 ? new Date(NOW - r.rnd() * 5 * 3_600_000) : r.ago(30, 0.3);
    const hourIst = r.pick([7, 8, 9, 10, 11, 17, 18, 18, 19, 20]);
    const at = new Date(Math.floor((created.getTime() + IST) / DAY) * DAY - IST + hourIst * 3_600_000 + r.int(0, 59) * 60_000);
    const when = at.getTime() > NOW ? new Date(NOW - r.int(5, 50) * 60_000) : at;
    const lines = Array.from({ length: r.int(1, 2) }, () => r.pick(items));
    const orderLines = lines.map((m) => {
      const q = m.unit === 'piece' ? r.int(6, 30) : r.pick([0.5, 1, 1, 1.5, 2, 2.5]);
      const cuts = (m.cutOptions as string[]) ?? [];
      return { menuItemId: m.id, name: m.name, cut: cuts.length ? r.pick(cuts) : null, unit: m.unit, unitPrice: m.price, quantity: dec(q), lineTotal: dec(q * Number(m.price)) };
    });
    const subtotal = orderLines.reduce((a, l) => a + Number(l.lineTotal), 0);
    const recent = NOW - when.getTime() < 6 * 3_600_000;
    const status = recent ? r.pick(['pending', 'confirmed', 'preparing', 'ready']) : r.pick(['completed', 'completed', 'completed', 'completed', 'cancelled']);
    const rated = status === 'completed' && r.rnd() > 0.5;
    const rating = rated ? r.pick([5, 5, 4, 4, 3, 2]) : null;
    const customer = r.pick(list);
    const o = await put('order', orgId, sid(orgId, 'order', i), {
      organizationId: orgId, orderNumber: `DEMO-GR-${String(i + 1).padStart(4, '0')}`, customerId: customer.id, outletId: outlet.id, channel: r.pick(['whatsapp', 'whatsapp', 'voice']), status, pickupAt: new Date(when.getTime() + 45 * 60_000),
      subtotal: dec(subtotal), total: dec(subtotal), paymentMethod: r.pick(['cash_at_shop', 'upi_at_shop']), idempotencyKey: `demo-gr-order-${i}`, isDemo: true, createdAt: when, customerName: customer.name, customerPhone: customer.phone, language: r.pick(['tanglish', 'tamil', 'english']),
      collectedAt: status === 'completed' ? new Date(when.getTime() + 60 * 60_000) : null, fulfilment: 'pickup', demoScenario: 'demo',
      feedbackRating: rating, feedbackAt: rated ? new Date(when.getTime() + 3 * 3_600_000) : null, feedbackChannel: rated ? r.pick(['whatsapp', 'voice']) : null, complaintStatus: rated && rating! <= 2 ? 'open' : null, complaintNote: rated && rating! <= 2 ? 'Demo complaint: pieces were small' : null,
      readyNotice: ['ready', 'completed'].includes(status) ? r.pick(['whatsapp_sent', 'answered', 'no_answer']) : null, readyNoticeNote: ['ready', 'completed'].includes(status) ? 'SIMULATED (DRY_RUN): no message / call was placed' : null,
    });
    for (const [k, l] of orderLines.entries()) await put('orderItem', orgId, `${o.id}_i${k}`, { orderId: o.id, ...l });
    await put('orderEvent', orgId, `${o.id}_e0`, { organizationId: orgId, orderId: o.id, type: 'created', toStatus: 'pending', actor: 'ai', note: 'Demo order', createdAt: when });
    if (status !== 'pending') await put('orderEvent', orgId, `${o.id}_e1`, { organizationId: orgId, orderId: o.id, type: 'status_changed', fromStatus: 'pending', toStatus: status, actor: 'seed:demo', createdAt: new Date(when.getTime() + 15 * 60_000) });
    if (i % 3 === 0 && status === 'completed') {
      const fstatus = r.pick(['completed', 'no_answer', 'failed', 'skipped']);
      await put('orderFollowUp', orgId, sid(orgId, 'ofu', i), { organizationId: orgId, orderId: o.id, customerId: customer.id, kind: r.pick(['feedback_request', 'feedback_call']), channel: r.pick(['whatsapp', 'voice']), status: fstatus, scheduledAt: new Date(when.getTime() + 3 * 3_600_000), attempts: fstatus === 'no_answer' ? 2 : 1, dedupeKey: `demo:feedback:${o.id}`, dryRun: true, result: { simulated: true, note: 'DRY_RUN: no provider was contacted' } as never, lastError: fstatus === 'failed' ? 'Demo: call could not be connected (simulated)' : null });
    }
  }
  await followUps(r, orgId, leads, [{ source: 'sequence', message: 'missed_call' }]);
  await conversation(orgId, 'c1', list[0], 'closed', [['user', 'Rendu kg broiler curry cut venum'], ['assistant', '2 kg Broiler Chicken (Curry cut) — ₹440. Eppo pickup pannuveenga?'], ['user', '6 mani ku'], ['assistant', 'Seri. Payment cash-ah UPI-ah?'], ['user', 'UPI'], ['assistant', 'Order confirm pannalama? 2 kg Broiler Chicken (Curry cut), pickup 6:00 PM, total ₹440 — YES nu reply pannunga.'], ['user', 'yes'], ['assistant', '✅ Order DEMO-GR-0001 confirm aagiduchu. 6:00 PM ku ready-a irukkum.']], 50);
  await conversation(orgId, 'c2', list[1], 'human_handoff', [['user', 'ennaku staff kitta pesanum'], ['assistant', 'Seri, engal staff seekiram inga reply pannuvaanga.']], 3);
  await conversation(orgId, 'c3', list[2], 'active', [['user', 'நாட்டு கோழி இருக்கா?'], ['assistant', 'Country Chicken இருக்கு — ₹450 / kg (Curry cut, Biryani cut, Whole). எவ்வளவு வேணும்?']], 1);
  return orgId;
}

// ================================================================================================ restaurant & food ordering

async function foodWorkspace() {
  const r = rng(107);
  const orgId = await org('food', {
    food: {
      taxPct: 5, packagingFee: 15, pickupEnabled: true, deliveryEnabled: true,
      deliveryZones: [{ name: 'Anna Nagar', keywords: ['anna nagar', 'annanagar'], fee: 30, minOrder: 199, etaMinutes: 30 }, { name: 'Kilpauk', keywords: ['kilpauk'], fee: 40, minOrder: 249, etaMinutes: 40 }, { name: 'Aminjikarai', keywords: ['aminjikarai', 'amijikarai'], fee: 35, minOrder: 199, etaMinutes: 35 }],
      faqs: [{ q: 'Do you have parking?', a: 'Yes, free parking for 10 cars at the Anna Nagar branch.' }, { q: 'Is the food Jain friendly?', a: 'Our tiffin items can be made without onion and garlic on request; mention it in your order.' }],
    },
  });
  const anna = await put('outlet', orgId, sid(orgId, 'outlet', 0), { organizationId: orgId, name: 'Spice Route · Anna Nagar', address: 'DEMO · 2nd Avenue, Anna Nagar, Chennai', area: 'Anna Nagar', phone: '9100007-00000', isDemo: true, opensAt: '07:00', closesAt: '23:00', prepMinutes: 20, acceptOutsideHours: true, sortOrder: 0 });
  await put('outlet', orgId, sid(orgId, 'outlet', 1), { organizationId: orgId, name: 'Spice Route · T. Nagar (cloud kitchen)', address: 'DEMO · Usman Road, T. Nagar, Chennai', area: 'T. Nagar', isDemo: true, opensAt: '11:00', closesAt: '23:00', prepMinutes: 25, sortOrder: 1 });
  type It = { name: string; price: number; veg: boolean; variants?: Array<{ name: string; price: number }>; addOns?: Array<{ name: string; price: number }>; tax?: number; stock?: number | null; available?: boolean; aliases?: string };
  const menu: Array<[string, It[]]> = [
    ['South Indian', [
      { name: 'Masala Dosa', price: 90, veg: true, addOns: [{ name: 'Extra Chutney', price: 15 }, { name: 'Ghee Roast', price: 30 }], aliases: 'dosa, masala dosai' },
      { name: 'Idli (2 pcs)', price: 45, veg: true, aliases: 'idli, idly', stock: 60 },
      { name: 'Medu Vada', price: 40, veg: true, stock: 0, aliases: 'vada, vadai' },
      { name: 'Ghee Pongal', price: 85, veg: true, aliases: 'pongal' },
      { name: 'Filter Coffee', price: 35, veg: true, variants: [{ name: 'Regular', price: 35 }, { name: 'Large', price: 50 }], aliases: 'coffee, kaapi' },
    ]],
    ['Biryani', [
      { name: 'Chicken Biryani', price: 249, veg: false, variants: [{ name: 'Half', price: 179 }, { name: 'Full', price: 249 }], addOns: [{ name: 'Extra Raita', price: 20 }, { name: 'Boiled Egg', price: 15 }], aliases: 'biryani, chicken biriyani' },
      { name: 'Veg Biryani', price: 189, veg: true, variants: [{ name: 'Half', price: 139 }, { name: 'Full', price: 189 }], aliases: 'veg biriyani' },
      { name: 'Mutton Biryani', price: 349, veg: false, available: false, aliases: 'mutton biriyani' },
    ]],
    ['Chinese', [
      { name: 'Veg Fried Rice', price: 160, veg: true, aliases: 'fried rice' },
      { name: 'Chilli Chicken', price: 220, veg: false, variants: [{ name: 'Dry', price: 220 }, { name: 'Gravy', price: 230 }], aliases: 'chilli chicken' },
      { name: 'Gobi Manchurian', price: 150, veg: true, aliases: 'gobi, manchurian' },
    ]],
    ['Desserts & Beverages', [
      { name: 'Cold Coffee', price: 120, veg: true, variants: [{ name: 'Regular', price: 120 }, { name: 'Large', price: 160 }], addOns: [{ name: 'Extra Shot', price: 30 }, { name: 'Ice Cream', price: 40 }], tax: 18 },
      { name: 'Rose Milk', price: 69, veg: true },
      { name: 'Gulab Jamun (2 pcs)', price: 60, veg: true, aliases: 'gulab jamun, jamun', stock: 40 },
    ]],
  ];
  const items: Array<{ id: string; name: string; price: Prisma.Decimal; variants: unknown; addOns: unknown; available: boolean }> = [];
  let sort = 0;
  for (const [ci, [cat, list]] of menu.entries()) {
    const c = await put('menuCategory', orgId, sid(orgId, 'cat', ci), { organizationId: orgId, name: cat, sortOrder: ci });
    for (const it of list) {
      items.push(await put('menuItem', orgId, sid(orgId, 'item', sort), {
        organizationId: orgId, categoryId: c.id, name: it.name, price: dec(it.price), unit: 'piece', cutOptions: [], minQty: dec(1), maxQty: dec(20), qtyStep: dec(1), available: it.available ?? true,
        variants: (it.variants ?? null) as never, addOns: (it.addOns ?? null) as never, taxRatePct: it.tax === undefined ? null : dec(it.tax), isVeg: it.veg, aliases: it.aliases ?? null,
        stockQty: it.stock === undefined || it.stock === null ? null : dec(it.stock), lowStockThreshold: it.stock !== undefined && it.stock !== null ? dec(10) : null, stockIsDemo: it.stock !== undefined, isDemo: true, sortOrder: sort, description: 'DEMO menu item (sample price)',
      }));
      sort++;
    }
  }
  const list = await customers(r, orgId, DEMO_ORGS.food.ws, 30);
  const leads = await leadsFor(r, orgId, list, { sources: ['whatsapp', 'whatsapp', 'voice', 'meta', 'website'], statuses: ['new', 'contacted', 'won', 'won'] });
  const sellable = items.filter((i) => i.available && i.name !== 'Medu Vada');
  for (let i = 0; i < 62; i++) {
    const created = i < 8 ? new Date(NOW - r.rnd() * 5 * 3_600_000) : r.ago(30, 0.3);
    const hourIst = r.pick([8, 9, 12, 13, 13, 14, 19, 20, 20, 21]);
    const at = new Date(Math.floor((created.getTime() + IST) / DAY) * DAY - IST + hourIst * 3_600_000 + r.int(0, 59) * 60_000);
    const when = at.getTime() > NOW ? new Date(NOW - r.int(5, 50) * 60_000) : at;
    const delivery = r.rnd() > 0.45;
    const zone = r.pick([['Anna Nagar', 30], ['Kilpauk', 40], ['Aminjikarai', 35]] as const);
    const lines = Array.from({ length: r.int(1, 3) }, () => r.pick(sellable)).map((m) => {
      const vs = (m.variants as Array<{ name: string; price: number }> | null) ?? [];
      const as = (m.addOns as Array<{ name: string; price: number }> | null) ?? [];
      const v = vs.length ? r.pick(vs) : null;
      const a = as.length && r.rnd() > 0.6 ? [r.pick(as)] : [];
      const q = r.int(1, 3);
      const unit = (v ? v.price : Number(m.price)) + a.reduce((s, x) => s + x.price, 0);
      return { menuItemId: m.id, name: m.name, unit: 'piece', variant: v?.name ?? null, addOns: a as never, unitPrice: dec(unit), quantity: dec(q), lineTotal: dec(unit * q) };
    });
    const subtotal = lines.reduce((a, l) => a + Number(l.lineTotal), 0);
    const tax = Math.round(subtotal * 0.05 * 100) / 100;
    const fees = 15 + (delivery ? zone[1] : 0);
    const recent = NOW - when.getTime() < 6 * 3_600_000;
    const status = recent ? r.pick(delivery ? ['pending', 'confirmed', 'preparing', 'dispatched', 'needs_attention'] : ['pending', 'confirmed', 'preparing', 'ready']) : r.pick(['completed', 'completed', 'completed', 'completed', 'cancelled']);
    const rated = status === 'completed' && r.rnd() > 0.45;
    const rating = rated ? r.pick([5, 5, 4, 4, 4, 3, 2, 1]) : null;
    const customer = r.pick(list);
    const o = await put('order', orgId, sid(orgId, 'order', i), {
      organizationId: orgId, orderNumber: `DEMO-FD-${String(i + 1).padStart(4, '0')}`, customerId: customer.id, outletId: anna.id, channel: r.pick(['whatsapp', 'whatsapp', 'voice', 'dashboard']), status,
      pickupAt: new Date(when.getTime() + (delivery ? 50 : 20) * 60_000), subtotal: dec(subtotal), discount: dec(0), total: dec(subtotal + tax + fees), taxAmount: dec(tax), deliveryFee: dec(fees),
      fulfilment: delivery ? 'delivery' : 'pickup', deliveryAddress: delivery ? `DEMO · ${r.int(1, 40)}, ${r.pick(['2nd Street', 'Main Road', 'Cross Street'])}, ${zone[0]}` : null, deliveryZone: delivery ? zone[0] : null,
      paymentMethod: delivery ? 'pay_on_delivery' : 'pay_at_counter', paymentStatus: status === 'completed' ? 'paid' : 'unpaid', idempotencyKey: `demo-food-order-${i}`, isDemo: true, createdAt: when, customerName: customer.name, customerPhone: customer.phone,
      dispatchedAt: ['dispatched', 'completed'].includes(status) && delivery ? new Date(when.getTime() + 30 * 60_000) : null, collectedAt: status === 'completed' ? new Date(when.getTime() + 55 * 60_000) : null,
      feedbackRating: rating, feedbackAt: rated ? new Date(when.getTime() + 3 * 3_600_000) : null, feedbackChannel: rated ? 'whatsapp' : null, complaintStatus: rated && rating! <= 2 ? 'open' : null,
      complaintNote: rated && rating! <= 2 ? r.pick(['Demo complaint: food arrived cold', 'Demo complaint: an item was missing']) : null, notes: status === 'needs_attention' ? 'Demo: rider could not find the address — call the customer' : null,
    });
    for (const [k, l] of lines.entries()) await put('orderItem', orgId, `${o.id}_i${k}`, { orderId: o.id, ...l });
    const flow = delivery ? ['pending', 'confirmed', 'preparing', 'dispatched', 'completed'] : ['pending', 'confirmed', 'preparing', 'ready', 'completed'];
    const path = status === 'cancelled' ? ['pending', 'cancelled'] : status === 'needs_attention' ? ['pending', 'confirmed', 'preparing', 'dispatched', 'needs_attention'] : flow.slice(0, Math.max(1, flow.indexOf(status) + 1));
    const channel = (o as unknown as { channel: string }).channel;
    for (const [k, st] of path.entries()) await put('orderEvent', orgId, `${o.id}_e${k}`, { organizationId: orgId, orderId: o.id, type: k === 0 ? 'created' : 'status_changed', fromStatus: k === 0 ? null : path[k - 1], toStatus: st, actor: k === 0 ? (channel === 'dashboard' ? 'user:demo' : 'ai') : 'user:demo-kitchen', createdAt: new Date(when.getTime() + k * 10 * 60_000) });
  }
  const orderLeads = leads.map((l, i) => ({ ...l, i }));
  await followUps(r, orgId, orderLeads, [{ source: 'food', message: `food:status:${sid(orgId, 'order', 0)}:confirmed` }, { source: 'food', message: `food:feedback:${sid(orgId, 'order', 9)}` }, { source: 'food', message: `food:ack:${sid(orgId, 'order', 3)}` }]);
  await conversation(orgId, 'c1', list[0], 'closed', [
    ['user', 'Hi, 2 masala dosa and 1 cold coffee'], ['assistant', 'Which size for Cold Coffee? 1. Regular ₹120 / 2. Large ₹160'], ['user', 'large'],
    ['assistant', 'Added Cold Coffee (Large).\n• 2 × Masala Dosa — ₹180\n• 1 × Cold Coffee (Large) — ₹160\nSubtotal ₹340 · Tax ₹37.80 · Packing ₹15\n*Total ₹392.80*\n\nAnything else? When done, reply PICKUP or DELIVERY.'],
    ['user', 'delivery'], ['assistant', 'Please share the delivery address with area name. We deliver to: Anna Nagar, Kilpauk, Aminjikarai.'], ['user', '14, 3rd Main Road, Anna Nagar'],
    ['assistant', 'Please confirm your order: … Total ₹422.80 · Delivery to 14, 3rd Main Road, Anna Nagar (~50 min). Reply YES to place the order.'], ['user', 'yes'], ['assistant', '✅ Order placed! *DEMO-FD-0001* Total ₹422.80 · Expected delivery around 8:40 PM.'],
  ], 30);
  await conversation(orgId, 'c2', list[1], 'human_handoff', [['user', 'My food came cold and the raita is missing'], ['assistant', 'I am sorry about that. I have passed this to our restaurant team right away; a team member will reply here shortly.']], 4);
  await conversation(orgId, 'c3', list[2], 'active', [['user', '2 medu vada'], ['assistant', 'Sorry, Medu Vada is sold out; try Masala Dosa, Idli (2 pcs), Ghee Pongal.'], ['user', 'ok 2 idli then'], ['assistant', '• 2 × Idli (2 pcs) — ₹90 … Anything else? When done, reply PICKUP or DELIVERY.']], 2);
  await conversation(orgId, 'c4', list[3], 'closed', [['user', 'status of my order?'], ['assistant', 'Order DEMO-FD-0004: *Out for delivery* (₹356.50, delivery).']], 20, 'voice');
  return orgId;
}

// ================================================================================================ hotel & room booking

async function hotelWorkspace() {
  const r = rng(108);
  const orgId = await org('hotel', {
    hotel: {
      checkInTime: '14:00', checkOutTime: '11:00', taxPct: 12, autoConfirm: false, holdMinutes: 180, depositPct: 20, freeCancellationHours: 48,
      cancellationPolicy: 'Free cancellation up to 48 hours before check-in; after that the first night is charged.', maxNights: 21,
      faqs: [{ q: 'Is breakfast included?', a: 'Breakfast is included with Deluxe, Executive and Family rooms; Standard rooms can add it for ₹350 per guest.' }, { q: 'Do you have parking?', a: 'Yes, free covered parking for guests.' }, { q: 'Is there airport pickup?', a: 'Airport pickup is available for ₹1,200 one way; request it here and the front desk will confirm.' }],
    },
  });
  const types = [
    { code: 'STD', name: 'Standard Room', bed: 'Queen', size: 220, maxAdults: 2, maxChildren: 1, maxOcc: 2, base: 2800, weekend: 3200, rooms: 8, amenities: ['WiFi', 'AC', 'TV', 'Tea / coffee maker'] },
    { code: 'DLX', name: 'Deluxe Room', bed: 'King', size: 300, maxAdults: 2, maxChildren: 1, maxOcc: 3, base: 3900, weekend: 4500, rooms: 8, amenities: ['WiFi', 'AC', 'Breakfast', 'City view', 'Mini fridge'] },
    { code: 'EXE', name: 'Executive Suite', bed: 'King', size: 450, maxAdults: 2, maxChildren: 2, maxOcc: 4, base: 6500, weekend: 7400, rooms: 4, amenities: ['WiFi', 'AC', 'Breakfast', 'Sea view', 'Living area', 'Bathtub'] },
    { code: 'FAM', name: 'Family Suite', bed: '2 Queens', size: 520, maxAdults: 4, maxChildren: 2, maxOcc: 6, base: 7800, weekend: 8800, rooms: 3, amenities: ['WiFi', 'AC', 'Breakfast', 'Two bedrooms', 'Kitchenette'] },
  ];
  const typeRows: Array<{ id: string; code: string; name: string; base: number; weekend: number; rooms: string[] }> = [];
  let roomNo = 0;
  for (const [ti, t] of types.entries()) {
    const row = await put('roomType', orgId, sid(orgId, 'rt', ti), { organizationId: orgId, code: t.code, name: t.name, description: `DEMO room type: ${t.name}, ${t.size} sq ft, ${t.bed} bed.`, bedType: t.bed, sizeSqft: t.size, maxAdults: t.maxAdults, maxChildren: t.maxChildren, maxOccupancy: t.maxOcc, baseRate: dec(t.base), weekendRate: dec(t.weekend), amenities: t.amenities as never, active: true, isDemo: true, sortOrder: ti });
    const rooms: string[] = [];
    for (let k = 0; k < t.rooms; k++) {
      const floor = String(ti + 1);
      const number = `${floor}${String(k + 1).padStart(2, '0')}`;
      const outOfService = t.code === 'STD' && k === 7;
      const rr = await put('room', orgId, sid(orgId, 'room', roomNo++), { organizationId: orgId, roomTypeId: row.id, number, floor, status: outOfService ? 'out_of_service' : 'available', housekeeping: r.pick(['clean', 'clean', 'clean', 'dirty', 'inspecting']), notes: outOfService ? 'DEMO: AC compressor replacement' : null, isDemo: true });
      rooms.push(rr.id);
    }
    typeRows.push({ id: row.id, code: t.code, name: t.name, base: t.base, weekend: t.weekend, rooms });
  }
  const year = Number(TODAY.slice(0, 4));
  const seasons = [['Christmas & New Year', `${year}-12-22`, `${year + 1}-01-02`, 1.35], ['Pongal', `${year + 1}-01-13`, `${year + 1}-01-17`, 1.25], ['Diwali weekend', `${year}-11-07`, `${year}-11-09`, 1.2]] as const;
  for (const [ti, t] of typeRows.entries()) for (const [si, [name, a, b, f]] of seasons.entries()) await put('roomRate', orgId, sid(orgId, `rate_${ti}`, si), { organizationId: orgId, roomTypeId: t.id, name, startDate: dayOnly(a), endDate: dayOnly(b), rate: dec(Math.round((t.base * f) / 100) * 100), isDemo: true });

  const list = await customers(r, orgId, DEMO_ORGS.hotel.ws, 40, (i) => ({ source: r.pick(['whatsapp', 'website', 'voice', 'meta']), email: `guest${i}@example.invalid` }));
  const leads = await leadsFor(r, orgId, list, { sources: ['whatsapp', 'website', 'meta', 'voice', 'walk_in'], statuses: ['new', 'contacted', 'won', 'won', 'lost'] });
  const nightly = (t: (typeof typeRows)[number], ci: string, nights: number) => Array.from({ length: nights }, (_, k) => {
    const d = addDays(ci, k);
    const dow = dayOnly(d).getUTCDay();
    const season = seasons.find(([, a, b]) => a <= d && d <= b);
    return season ? { date: d, rate: Math.round((t.base * season[3]) / 100) * 100, source: 'seasonal', label: season[0] } : dow === 5 || dow === 6 ? { date: d, rate: t.weekend, source: 'weekend' } : { date: d, rate: t.base, source: 'base' };
  });
  // Stays spread from 25 days ago to 30 days ahead, kept inside each room type's inventory per night.
  const occupancy = new Map<string, number>();
  const fits = (t: (typeof typeRows)[number], ci: string, nights: number, rooms: number) => {
    const sell = t.code === 'STD' ? t.rooms.length - 1 : t.rooms.length;
    for (let k = 0; k < nights; k++) if ((occupancy.get(`${t.id}|${addDays(ci, k)}`) ?? 0) + rooms > sell) return false;
    return true;
  };
  let created = 0;
  for (let i = 0; i < 70 && created < 52; i++) {
    const t = r.pick(typeRows);
    const offset = r.int(-25, 30);
    const ci = addDays(TODAY, offset);
    const nights = r.pick([1, 1, 2, 2, 2, 3, 4]);
    const co = addDays(ci, nights);
    const rooms = t.code === 'STD' && r.rnd() > 0.8 ? 2 : 1;
    let status: string;
    if (co <= TODAY) status = r.pick(['checked_out', 'checked_out', 'checked_out', 'checked_out', 'no_show', 'cancelled']);
    else if (ci <= TODAY) status = 'checked_in';
    else status = r.pick(['confirmed', 'confirmed', 'confirmed', 'pending_confirmation', 'cancelled']);
    const holds = ['confirmed', 'checked_in', 'checked_out', 'pending_confirmation'].includes(status);
    if (holds && !fits(t, ci, nights, rooms)) continue;
    if (holds) for (let k = 0; k < nights; k++) occupancy.set(`${t.id}|${addDays(ci, k)}`, (occupancy.get(`${t.id}|${addDays(ci, k)}`) ?? 0) + rooms);
    const breakdown = nightly(t, ci, nights);
    const subtotal = breakdown.reduce((a, b) => a + b.rate, 0) * rooms;
    const tax = Math.round(subtotal * 0.12 * 100) / 100;
    const total = subtotal + tax;
    const guest = list[created % list.length];
    const adults = r.int(1, Math.min(2, 2) * rooms);
    const createdAt = new Date(Math.min(NOW - 3_600_000, dayOnly(ci).getTime() - r.int(2, 20) * DAY));
    const deposit = Math.round(total * 0.2 * 100) / 100;
    const pay = status === 'cancelled' ? 'pending' : status === 'pending_confirmation' ? 'pending' : r.pick(['paid_verified', 'simulated_paid', 'simulated_paid', 'pending', 'simulated_failed']);
    const roomId = ['checked_in', 'checked_out'].includes(status) ? t.rooms[created % t.rooms.length] : null;
    const id = sid(orgId, 'res', created);
    await put('reservation', orgId, id, {
      organizationId: orgId, reference: `DEMO-HB-${String(created + 1).padStart(4, '0')}`, customerId: guest.id, leadId: leads[created % leads.length].id, roomTypeId: t.id, roomId,
      checkIn: dayOnly(ci), checkOut: dayOnly(co), nights, rooms, adults, children: r.rnd() > 0.8 ? 1 : 0, status, holdExpiresAt: status === 'pending_confirmation' ? new Date(NOW + r.int(1, 3) * 3_600_000) : null,
      subtotal: dec(subtotal), taxAmount: dec(tax), total: dec(total), rateBreakdown: breakdown as never, depositAmount: dec(deposit), paymentStatus: pay, channel: r.pick(['whatsapp', 'whatsapp', 'voice', 'dashboard', 'website']),
      guestName: guest.name, guestPhone: guest.phone, specialRequests: r.rnd() > 0.7 ? r.pick(['Early check-in if possible', 'High floor please', 'Extra pillow', 'Airport pickup at 6 AM']) : null, idempotencyKey: `demo-res-${created}`,
      cancellationReason: status === 'cancelled' ? 'Demo: guest changed travel plans — free cancellation' : null, cancelledAt: status === 'cancelled' ? new Date(createdAt.getTime() + DAY) : null,
      checkedInAt: ['checked_in', 'checked_out'].includes(status) ? istAt(ci, '14:20') : null, checkedOutAt: status === 'checked_out' ? istAt(co, '10:40') : null,
      feedbackRating: status === 'checked_out' && r.rnd() > 0.4 ? r.pick([5, 5, 4, 4, 3, 2]) : null, feedbackComment: status === 'checked_out' && r.rnd() > 0.6 ? r.pick(['Lovely sea view', 'Breakfast was great', 'AC was noisy', 'Quick check-in']) : null,
      isDemo: true, createdBy: 'seed:demo', createdAt,
    });
    if (roomId && status === 'checked_in') await prisma.room.update({ where: { id: roomId }, data: { status: 'occupied' } });
    const trail = status === 'checked_out' ? ['created', 'confirmed', 'checked_in', 'checked_out'] : status === 'checked_in' ? ['created', 'confirmed', 'checked_in'] : status === 'confirmed' ? ['created', 'confirmed'] : status === 'no_show' ? ['created', 'confirmed', 'no_show'] : status === 'cancelled' ? ['created', 'cancelled'] : ['created'];
    for (const [k, a] of trail.entries()) await audit(orgId, `res_${created}_${k}`, 'reservation', id, a, new Date(createdAt.getTime() + k * 3_600_000), a === 'payment' ? { simulated: true } : {}, k === 0 ? 'ai' : 'user:demo-front-desk');
    if (pay.startsWith('simulated')) await audit(orgId, `res_${created}_pay`, 'reservation', id, 'payment', new Date(createdAt.getTime() + 2 * 3_600_000), { outcome: pay, simulated: true });
    created++;
  }
  await followUps(r, orgId, leads, [{ source: 'booking', message: `booking:pre_arrival:${sid(orgId, 'res', 1)}` }, { source: 'booking', message: `booking:confirmed:${sid(orgId, 'res', 2)}` }, { source: 'booking', message: `booking:feedback:${sid(orgId, 'res', 0)}` }, { source: 'booking', message: `booking:checkout_reminder:${sid(orgId, 'res', 3)}`, channel: 'voice' }]);
  await conversation(orgId, 'c1', list[0], 'closed', [
    ['user', 'Hi, do you have a room from 15 Nov for 2 nights for 2 adults?'],
    ['assistant', 'Available for Sat 15 Nov → Mon 17 Nov (2 nights), 2 adults:\n1. *Standard Room* — ₹6,720 incl. tax (5 left)\n2. *Deluxe Room* — ₹9,408 incl. tax (6 left)\n3. *Executive Suite* — ₹15,568 incl. tax (3 left)\n\nReply with the number to choose a room.'],
    ['user', '2'], ['assistant', '*Deluxe Room* · Sat 15 Nov → Mon 17 Nov (2 nights) · 1 room · 2 adults\nNightly: Sat 15 Nov ₹4,500 (weekend), Sun 16 Nov ₹3,900\nRoom charges ₹8,400 + tax ₹1,008 = *₹9,408*\nDeposit: ₹1,881.60\n…\nReply YES to request this booking; our front desk confirms it shortly and the room is held for you meanwhile.'],
    ['user', 'yes'], ['assistant', '📝 Booking request received: *DEMO-HB-0001* — our front desk will confirm it shortly. Your room is held until 4:30 PM.\nA deposit of ₹1,881.60 is required; our team will share payment details (online payment is not connected).'],
  ], 72);
  await conversation(orgId, 'c2', list[1], 'human_handoff', [['user', 'The AC in room 214 is not working'], ['assistant', 'I am sorry about this. I have alerted our front desk; a team member will contact you right away.']], 5);
  await conversation(orgId, 'c3', list[2], 'active', [['user', 'Is breakfast included?'], ['assistant', 'Breakfast is included with Deluxe, Executive and Family rooms; Standard rooms can add it for ₹350 per guest.'], ['user', 'cancel my booking'], ['assistant', 'Cancel reservation DEMO-HB-0003 (Deluxe Room, …)? Policy: Free cancellation up to 48 hours before check-in. Reply YES to cancel.']], 8);
  return orgId;
}

// ================================================================================================ hospital & healthcare

async function hospitalWorkspace() {
  const r = rng(109);
  const orgId = await org('hospital', {
    hospital: {
      emergencyNumber: '108', bookingWindowDays: 14, reminderHoursBefore: 24,
      faqs: [{ q: 'Where is the hospital located?', a: 'DEMO · Sunrise Multispeciality Hospital, 100 Feet Road, Vadapalani, Chennai. Parking available in the basement.' }, { q: 'What are OPD timings?', a: 'OPD runs Monday to Saturday, 9:00 AM – 1:00 PM and 4:00 PM – 8:00 PM; doctor timings vary.' }, { q: 'Do you accept cashless insurance?', a: 'Yes, we work with most major insurers and TPAs. Our insurance desk will help with pre-authorisation.' }],
    },
  });
  const depts = ['General Medicine', 'Cardiology', 'Orthopaedics', 'Paediatrics', 'Obstetrics & Gynaecology', 'Dermatology', 'ENT'];
  const deptRows: Array<{ id: string; name: string }> = [];
  for (const [i, d] of depts.entries()) deptRows.push(await put('department', orgId, sid(orgId, 'dept', i), { organizationId: orgId, name: d, description: `DEMO department: ${d}`, active: true, isDemo: true, sortOrder: i }));
  const wk = (days: number[], blocks: Array<[string, string]>) => days.flatMap((day) => blocks.map(([start, end]) => ({ day, start, end })));
  const doctors = [
    ['Dr. S. Ramanathan', 0, 'MBBS, MD (General Medicine)', 'Physician', 500, 15, wk([1, 2, 3, 4, 5, 6], [['09:00', '13:00']])],
    ['Dr. Anjali Menon', 0, 'MBBS, MD', 'Diabetologist', 600, 15, wk([1, 3, 5], [['16:00', '20:00']])],
    ['Dr. Meera Krishnan', 1, 'MBBS, MD, DM (Cardiology)', 'Cardiologist', 900, 20, wk([1, 2, 4, 6], [['10:00', '13:00']])],
    ['Dr. Vikram Iyer', 1, 'MBBS, DNB (Cardiology)', 'Interventional cardiologist', 1000, 20, wk([3, 5], [['16:00', '19:00']])],
    ['Dr. Arjun Rao', 2, 'MBBS, MS (Ortho)', 'Orthopaedic surgeon', 800, 20, wk([1, 2, 3, 4, 5], [['09:30', '12:30']])],
    ['Dr. Fathima Begum', 3, 'MBBS, MD (Paediatrics)', 'Paediatrician', 600, 15, wk([1, 2, 3, 4, 5, 6], [['10:00', '13:00'], ['17:00', '19:00']])],
    ['Dr. Lakshmi Narayanan', 4, 'MBBS, MS (OG)', 'Obstetrician & gynaecologist', 800, 20, wk([1, 3, 5, 6], [['10:00', '13:00']])],
    ['Dr. Karthik Subramanian', 5, 'MBBS, MD (Dermatology)', 'Dermatologist', 700, 15, wk([2, 4, 6], [['16:00', '19:00']])],
    ['Dr. Priya Raghavan', 6, 'MBBS, MS (ENT)', 'ENT surgeon', 600, 15, wk([1, 2, 4, 5], [['09:00', '12:00']])],
  ] as const;
  const docRows: Array<{ id: string; name: string; departmentId: string; slot: number; schedule: Array<{ day: number; start: string; end: string }> }> = [];
  for (const [i, [name, d, q, spec, fee, slot, schedule]] of doctors.entries()) {
    const row = await put('doctor', orgId, sid(orgId, 'doc', i), { organizationId: orgId, departmentId: deptRows[d].id, name, qualification: q, specialty: spec, languages: r.pick(['English, Tamil', 'English, Tamil, Hindi', 'English, Tamil, Malayalam']), consultationFee: dec(fee), slotMinutes: slot, schedule: schedule as never, leaveDates: (i === 4 ? [addDays(TODAY, 3)] : []) as never, active: true, isDemo: true });
    docRows.push({ id: row.id, name, departmentId: deptRows[d].id, slot, schedule: schedule as unknown as Array<{ day: number; start: string; end: string }> });
  }
  const list = await customers(r, orgId, DEMO_ORGS.hospital.ws, 40, (i) => ({ source: i < 14 ? 'meta' : r.pick(['whatsapp', 'voice', 'walk_in', 'website']) }));
  const leads = await leadsFor(r, orgId, list, { sources: ['meta', 'meta', 'whatsapp', 'website', 'voice', 'referral'], statuses: ['new', 'contacted', 'contacted', 'won', 'won', 'lost'], extra: (i) => (i < 14 ? { source: 'meta', campaign: r.pick(['Free Heart Check-up Camp', 'Knee Pain Clinic', 'Child Vaccination Week']) } : {}) });
  // Appointments: past 25 days and the next 10, on each doctor's real grid, never overlapping.
  const taken = new Set<string>();
  let made = 0;
  for (let k = -25; k <= 10 && made < 84; k++) {
    const day = addDays(TODAY, k);
    const dow = dayOnly(day).getUTCDay();
    for (const d of docRows) {
      const blocks = d.schedule.filter((b) => b.day === dow);
      if (!blocks.length || r.rnd() > 0.55) continue;
      const b = r.pick(blocks);
      const slots = Math.floor(((Number(b.end.slice(0, 2)) * 60 + Number(b.end.slice(3))) - (Number(b.start.slice(0, 2)) * 60 + Number(b.start.slice(3)))) / d.slot);
      for (let x = 0; x < r.int(1, 3) && made < 84; x++) {
        const s = r.int(0, slots - 1);
        const start = new Date(istAt(day, b.start).getTime() + s * d.slot * 60_000);
        const key = `${d.id}|${start.toISOString()}`;
        if (taken.has(key)) continue;
        taken.add(key);
        const past = start.getTime() < NOW;
        const isToday = day === TODAY;
        const status = isToday ? (past ? r.pick(['completed', 'checked_in', 'no_show']) : r.pick(['booked', 'confirmed'])) : past ? r.pick(['completed', 'completed', 'completed', 'completed', 'no_show', 'cancelled']) : r.pick(['booked', 'booked', 'confirmed', 'cancelled']);
        const patient = list[made % list.length];
        const id = sid(orgId, 'appt', made);
        const createdAt = new Date(Math.min(NOW - 600_000, start.getTime() - r.int(1, 7) * DAY));
        await put('appointment', orgId, id, {
          organizationId: orgId, reference: `DEMO-AP-${String(made + 1).padStart(4, '0')}`, customerId: patient.id, leadId: leads[made % leads.length].id, doctorId: d.id, departmentId: d.departmentId,
          startAt: start, endAt: new Date(start.getTime() + d.slot * 60_000), status, visitType: r.rnd() > 0.7 ? 'follow_up' : 'new', reasonNote: r.rnd() > 0.5 ? r.pick(['Routine check-up', 'Follow-up visit', 'Wants consultation', 'Second opinion']) : null,
          channel: r.pick(['whatsapp', 'whatsapp', 'voice', 'dashboard', 'website']), patientName: patient.name, patientPhone: patient.phone, idempotencyKey: `demo-appt-${made}`,
          cancellationReason: status === 'cancelled' ? 'Demo: patient rescheduled to another week' : null, feedbackRating: status === 'completed' && r.rnd() > 0.5 ? r.pick([5, 5, 4, 4, 3, 2]) : null, isDemo: true, createdBy: 'seed:demo', createdAt,
        });
        const trail = status === 'completed' ? ['booked', 'confirmed', 'checked_in', 'completed'] : status === 'checked_in' ? ['booked', 'confirmed', 'checked_in'] : status === 'no_show' ? ['booked', 'no_show'] : status === 'cancelled' ? ['booked', 'cancelled'] : status === 'confirmed' ? ['booked', 'confirmed'] : ['booked'];
        for (const [z, a] of trail.entries()) await audit(orgId, `appt_${made}_${z}`, 'appointment', id, a, new Date(createdAt.getTime() + z * 3_600_000), {}, z === 0 ? 'ai' : 'user:demo-reception');
        made++;
      }
    }
  }
  const kinds = ['eligibility', 'pre_authorisation', 'pre_authorisation', 'claim', 'claim', 'reimbursement'];
  const statusFor = ['documents_pending', 'documents_pending', 'ready_to_submit', 'submitted', 'query_raised', 'approved', 'partially_approved', 'rejected', 'settled', 'closed', 'submitted', 'documents_pending', 'approved', 'settled'];
  const insurers = [['Star Health', 'Medi Assist'], ['HDFC ERGO', 'Paramount TPA'], ['Niva Bupa', null], ['ICICI Lombard', 'MD India'], ['Care Health', null]] as const;
  for (let i = 0; i < 14; i++) {
    const kind = kinds[i % kinds.length];
    const status = statusFor[i];
    const req = kind === 'eligibility' ? ['Insurance card', 'Photo ID'] : kind === 'pre_authorisation' ? ['Insurance card', 'Photo ID', "Doctor's pre-authorisation form", 'Investigation reports'] : kind === 'claim' ? ['Insurance card', 'Photo ID', 'Discharge summary', 'Final bill', 'Investigation reports'] : ['Claim form', 'Photo ID', 'Discharge summary', 'Original bills', 'Payment receipts', 'Cancelled cheque'];
    const received = status === 'documents_pending' ? req.slice(0, r.int(0, req.length - 1)) : req;
    const [insurer, tpa] = r.pick(insurers);
    const requested = kind === 'eligibility' ? null : r.int(15, 180) * 1000;
    const approved = ['approved', 'settled'].includes(status) && requested ? requested : status === 'partially_approved' && requested ? Math.round(requested * 0.7) : null;
    const id = sid(orgId, 'ins', i);
    await put('insuranceCase', orgId, id, {
      organizationId: orgId, reference: `DEMO-IN-${String(i + 1).padStart(4, '0')}`, customerId: list[i + 2].id, appointmentId: null, kind, insurer, tpa, policyRef: `••••${String(1000 + i * 137).slice(-4)}`, status,
      requiredDocs: req as never, receivedDocs: received as never, amountRequested: requested === null ? null : dec(requested), amountApproved: approved === null ? null : dec(approved),
      insurerReference: ['approved', 'partially_approved', 'rejected', 'settled'].includes(status) ? `DEMO-${insurer.split(' ')[0].toUpperCase()}-${r.int(10000, 99999)}` : null,
      decisionNote: status === 'rejected' ? 'DEMO: insurer letter says the condition is excluded in the first policy year (recorded by staff).' : status === 'query_raised' ? 'DEMO: insurer asked for the previous consultation notes.' : null,
      decidedBy: ['approved', 'partially_approved', 'rejected', 'settled'].includes(status) ? 'user:demo-insurance-desk' : null, lastFollowUpAt: status === 'documents_pending' ? r.ago(3) : null, isDemo: true, createdBy: 'seed:demo', createdAt: r.ago(20, 2),
    });
    await audit(orgId, `ins_${i}_0`, 'insurance_case', id, 'created', r.ago(20, 10), { kind });
    if (status !== 'documents_pending') await audit(orgId, `ins_${i}_1`, 'insurance_case', id, status, r.ago(9, 1), {}, 'user:demo-insurance-desk');
  }
  await followUps(r, orgId, leads, [{ source: 'appointment', message: `appointment:reminder:${sid(orgId, 'appt', 5)}:0` }, { source: 'insurance', message: `insurance:docs:${sid(orgId, 'ins', 0)}:0` }, { source: 'appointment', message: `appointment:no_show:${sid(orgId, 'appt', 3)}` }, { source: 'sequence', message: 'first_contact' }]);
  await conversation(orgId, 'c1', list[0], 'closed', [
    ['user', 'I want to book an appointment with a cardiologist'], ['assistant', 'Next available:\n1. Dr. Meera Krishnan — Tue 21 Oct, 10:00 am\n2. Dr. Meera Krishnan — Tue 21 Oct, 10:20 am\n3. Dr. Vikram Iyer — Wed 22 Oct, 4:00 pm\nReply with the number, or ask for another day / time.'],
    ['user', '1'], ['assistant', 'Please confirm:\nDr. Meera Krishnan (Cardiology)\nTue 21 Oct, 10:00 am\nPatient: Ravi Kumar\nConsultation fee: ₹900 (pay at the hospital)\n\nReply YES to book.'], ['user', 'yes'],
    ['assistant', '✅ Appointment booked: *DEMO-AP-0001*\nDr. Meera Krishnan (Cardiology) — Tue 21 Oct, 10:00 am\nPlease arrive 15 minutes early with any previous reports and your ID / insurance card. We will send a reminder.'],
  ], 96);
  await conversation(orgId, 'c2', list[1], 'human_handoff', [['user', 'My father has severe chest pain'], ['assistant', '⚠️ If this is an emergency, please call 108 or come to our Emergency department immediately. I have alerted our team to call you back now.']], 2);
  await conversation(orgId, 'c3', list[2], 'active', [['user', 'what medicine should I take for knee pain?'], ['assistant', 'I am not able to give medical advice, medicines or interpret reports — a doctor will guide you. I can book a consultation for you: which doctor or department would you like, and when?'], ['user', 'what is my insurance status'], ['assistant', 'DEMO-IN-0001 — Pre-authorisation (Star Health): *Documents pending*.\nStill needed: Investigation reports. Share them at the insurance desk or send clear photos here; our team will verify.\nStatus as recorded by our insurance desk; decisions are made by your insurer / TPA.']], 10);
  return orgId;
}

// ================================================================================================ real estate

async function realEstateWorkspace() {
  const r = rng(103);
  const orgId = await org('real_estate');
  const props = [['Green Valley Residency', 'Porur, Chennai', 'apartment', 2, 7800000], ['Lakeview Towers', 'Velachery, Chennai', 'apartment', 3, 12500000], ['OMR Smart Homes', 'OMR, Chennai', 'apartment', 2, 6900000], ['Tambaram Garden Villas', 'Tambaram, Chennai', 'villa', 3, 9800000], ['Anna Nagar Signature', 'Anna Nagar, Chennai', 'apartment', 3, 21000000], ['Guduvanchery Plots Phase 2', 'Guduvanchery, Chennai', 'plot', 0, 3500000]] as const;
  const properties: Array<{ id: string }> = [];
  for (const [i, [name, location, type, bhk, price]] of props.entries()) properties.push(await put('property', orgId, sid(orgId, 'prop', i), { organizationId: orgId, name, location, type, bhk, price: dec(price) }));
  const areas = ['Porur', 'Velachery', 'OMR', 'Tambaram', 'Anna Nagar', 'Guduvanchery'];
  const list = await customers(r, orgId, DEMO_ORGS.real_estate.ws, 28, (i) => ({ location: areas[i % areas.length] }));
  const leads = await leadsFor(r, orgId, list, { sources: ['meta', 'meta', 'website', 'magicbricks', 'referral', 'walk_in'], statuses: ['new', 'contacted', 'qualified', 'property_interested', 'site_visit', 'won', 'not_interested', 'lost'], extra: (i) => ({ location: areas[i % areas.length], budget: dec(r.pick([4000000, 6500000, 8000000, 12000000, 18000000, 25000000])), bhk: r.pick([2, 2, 3, 3, 4]), propertyType: r.pick(['apartment', 'villa', 'plot']) }) });
  const visitLeads = [...new Map(leads.filter((x) => ['site_visit', 'property_interested', 'won'].includes(x.status)).concat(leads.slice(0, 4)).map((l) => [l.id, l])).values()];
  for (const [i, l] of visitLeads.entries()) {
    const past = r.rnd() > 0.4;
    await put('siteVisit', orgId, sid(orgId, 'visit', i), { organizationId: orgId, leadId: l.id, customerId: l.customerId, propertyId: r.pick(properties).id, scheduledAt: past ? r.ago(20, 1) : new Date(NOW + r.rnd() * 7 * DAY), status: past ? r.pick(['completed', 'completed', 'no_show', 'cancelled']) : 'scheduled', updatedAt: new Date() });
  }
  await followUps(r, orgId, leads, [{ source: 'sequence', message: 'first_contact' }, { source: 'sequence', message: 'reminder' }, { source: 'retry', message: 'call', channel: 'voice' }, { source: 'visit', message: 'visit:reminder:demo' }]);
  for (const [i, l] of leads.slice(0, 20).entries()) await put('call', orgId, sid(orgId, 'call', i), { organizationId: orgId, customerId: l.customerId, leadId: l.id, toNumber: list.find((c) => c.id === l.customerId)!.phone, fromNumber: 'demo', direction: i % 5 === 0 ? 'inbound' : 'outbound', status: i % 7 === 0 ? 'failed' : 'completed', outcome: r.pick(['interested', 'callback', 'not_interested', 'site_visit_booked', 'no_answer']), durationSec: r.int(30, 240), createdAt: r.ago(25) });
  await conversation(orgId, 'c1', list[0], 'active', [['user', 'Looking for a 2 BHK in Porur under 80 lakhs'], ['assistant', 'Green Valley Residency in Porur has 2 BHK apartments from ₹78 L. Would you like to visit this weekend?'], ['user', 'Saturday 11 am'], ['assistant', 'Booked: Green Valley Residency, Saturday 11:00 AM. We will send the location the day before.']], 48);
  await conversation(orgId, 'c2', list[1], 'human_handoff', [['user', 'I want to speak to the sales manager about pricing'], ['assistant', 'Sure — a team member will call you shortly.']], 6);
  return orgId;
}

// ================================================================================================ manufacturing

async function manufacturingWorkspace() {
  const r = rng(105);
  const orgId = await org('manufacturing');
  const products = ['Rubber Gasket 40mm', 'Brass Fitting 1/2"', 'Aluminium Bracket A2', 'Steel Shaft 12mm'];
  const lines = ['Line 1', 'Line 2', 'Line 3'];
  const cats = ['surface scratch', 'dimension out of tolerance', 'crack', 'burr', 'porosity', 'colour mismatch'];
  const open: Array<{ id: string; batch: string; product: string; rate: number }> = [];
  for (let i = 0; i < 46; i++) {
    const inspected = r.int(200, 1200);
    const line = r.pick(lines);
    const rate = line === 'Line 3' ? 0.02 + r.rnd() * 0.07 : r.rnd() * 0.035;
    const rejected = Math.round(inspected * rate);
    const defects = rejected ? Array.from(new Set(Array.from({ length: r.int(1, 3) }, () => r.pick(cats)))).map((c) => ({ category: c, count: Math.max(1, Math.round(rejected / r.int(1, 3))) })) : [];
    const inspectedAt = r.ago(30, 0.2);
    const isOpen = rejected > 0 && r.rnd() > 0.55;
    const product = r.pick(products);
    const row = await put('qualityInspection', orgId, sid(orgId, 'qi', i), {
      organizationId: orgId, batchCode: `DEMO-B${String(i + 1).padStart(4, '0')}`, productName: product, line, inspector: r.pick(['QC Anand', 'QC Priya', 'QC Ramesh']), inspectedAt, inspectedQty: inspected, rejectedQty: rejected, defects: defects as never,
      status: rejected === 0 || !isOpen ? 'resolved' : 'open', severity: rate > 0.06 ? 'major' : 'minor', resolvedAt: rejected === 0 ? inspectedAt : !isOpen ? new Date(inspectedAt.getTime() + r.int(4, 72) * 3_600_000) : null,
      resolution: rejected && !isOpen ? r.pick(['Die re-polished', 'Operator retrained', 'Supplier lot replaced', 'Fixture recalibrated']) : null, isDemo: true, createdBy: 'seed:demo',
    });
    if (isOpen && rate > 0.05) open.push({ id: row.id, batch: `DEMO-B${String(i + 1).padStart(4, '0')}`, product, rate: Math.round(rate * 1000) / 10 });
  }
  for (const [k, o] of open.entries()) {
    await put('workTask', orgId, sid(orgId, 'wt', k), {
      organizationId: orgId, agent: 'operations', kind: 'exception', priority: o.rate > 7 ? 'high' : 'normal', title: `Quality alert: batch ${o.batch} (${o.product}) rejection ${o.rate}%`,
      detail: 'DEMO corrective action raised by the quality alert scan. Record the fix on the inspection when done.', status: k % 3 === 0 ? 'in_progress' : 'open', assignee: k % 2 ? 'QC Priya' : 'Maintenance Raju',
      entityType: 'quality_inspection', entityId: o.id, dedupeKey: `demo:${orgId}:quality_alert:${o.id}`, createdBy: 'agent:operations',
    });
  }
  const list = await customers(r, orgId, DEMO_ORGS.manufacturing.ws, 10);
  const leads = await leadsFor(r, orgId, list, { sources: ['whatsapp', 'website'], statuses: ['new', 'contacted', 'human_handoff'] });
  await followUps(r, orgId, leads, [{ source: 'manual', message: 'complaint_update' }]);
  await conversation(orgId, 'c1', list[0], 'human_handoff', [['user', 'Batch B0012 brackets have burrs, 40 pieces rejected at our end'], ['assistant', 'Thank you for contacting Demo · Precision Components. A member of our team will reply to you here shortly.']], 20);
  return orgId;
}

// ================================================================================================ agency

async function agencyWorkspace() {
  const r = rng(106);
  const orgId = await org('agency');
  const list = await customers(r, orgId, DEMO_ORGS.agency.ws, 26, () => ({ tags: [r.pick(['boutique', 'clinic', 'restaurant', 'real_estate'])] }));
  const leads = await leadsFor(r, orgId, list, { sources: ['meta', 'google', 'website', 'referral', 'linkedin'], statuses: ['new', 'contacted', 'contacted', 'qualified', 'qualified', 'won', 'lost'], extra: (i) => ({ campaign: r.pick(['Diwali Boutique Promo', 'Clinic Lead Gen', 'Restaurant Footfall', null]), notes: ['Wants Instagram + Meta lead ads for a boutique', 'Clinic: needs a WhatsApp booking flow', 'Restaurant: weekend footfall campaign', 'Monthly SEO + Google Ads retainer', 'Landing page and lead-form setup', 'Festive offer campaign for a jewellery store'][i % 6] }) });
  await followUps(r, orgId, leads, [{ source: 'manual', message: 'proposal_followup' }, { source: 'sequence', message: 'reminder' }]);
  await campaign(r, orgId, 'Demo · Client re-engagement (simulated)', list, leads);
  await conversation(orgId, 'c1', list[0], 'human_handoff', [['user', 'We need Meta ads for our clinic, what are your packages?'], ['assistant', 'Thank you for contacting Demo · BrightLeaf Marketing. A member of our team will reply to you here shortly.']], 30);
  return orgId;
}


// ---------------------------------------------------------------------------------------------
// CCTV monitoring (Tacksharp VisionOps): a CCTV installer / AMC provider with 3 customers, 5 sites, 50 cameras,
// 5 NVR / DVR. Every record is synthetic; WhatsApp previews are SIMULATED; agents are a static snapshot (the sweep
// never ages seeded demo agents). No camera credentials or RTSP URLs exist anywhere.
// ---------------------------------------------------------------------------------------------
async function cctvWorkspace() {
  const r = rng(1010);
  const o = await org('cctv', {
    monitoring: {
      failureThreshold: 3, debounceSeconds: 180, restoreSuccesses: 3, staleAfterMinutes: 10, correlationWindowMinutes: 30, ackDeadlineMinutes: 15, escalationStepMinutes: 30,
      quietHours: { enabled: true, start: '22:00', end: '07:00' }, notifyCustomerOnResolution: true, voiceEscalation: false, alertTemplate: '', whatsappCostInr: 0.12,
    },
  });
  const ago = (min: number) => new Date(NOW - min * 60_000);
  const custs = [
    { key: 'wh', name: 'Chennai Warehousing Pvt Ltd', industry: 'warehouse', region: 'Chennai West', contactName: 'Mr. Venkatesh', notify: true },
    { key: 'fm', name: 'FreshMart Supermarkets', industry: 'retail', region: 'Chennai Central', contactName: 'Ms. Anitha', notify: true },
    { key: 'lt', name: 'Lotus Multispeciality Clinic', industry: 'hospital', region: 'Chennai South', contactName: 'Dr. Ramesh', notify: false },
  ];
  const C: Record<string, string> = {};
  for (const [i, c] of custs.entries()) C[c.key] = (await put('monitoringCustomer', o, sid(o, 'cust', c.key), { organizationId: o, name: c.name, industry: c.industry, region: c.region, contactName: c.contactName, contactPhone: phoneFor(0, 900 + i), notifyOnResolution: c.notify, isDemo: true })).id;

  // site, customer, cameras, recorder vendor / method / capabilities, mode
  const SITES = [
    { k: 1, code: 'CHN-WH-01', name: 'Chennai Warehouse (Ambattur)', cust: 'wh', city: 'Chennai', region: 'Chennai West', lat: 13.1143, lng: 80.1548, cams: [9, 20], vendor: 'Hikvision', model: 'DS-7616NI-K2', kind: 'nvr', method: 'vendor_api', caps: { reachability: true, recording: true, storage: true, stream: true }, mode: 'local_agent' },
    { k: 2, code: 'CHN-WH-02', name: 'Sriperumbudur Godown', cust: 'wh', city: 'Sriperumbudur', region: 'Chennai West', lat: 12.9675, lng: 79.9419, cams: [1, 8], vendor: 'CP Plus', model: 'CP-UVR-0801E1', kind: 'dvr', method: 'agent_tcp', caps: { reachability: true, recording: false, storage: false, stream: false }, mode: 'local_agent' },
    { k: 3, code: 'FM-ANN-01', name: 'FreshMart Anna Nagar', cust: 'fm', city: 'Chennai', region: 'Chennai Central', lat: 13.085, lng: 80.2101, cams: [21, 30], vendor: 'Dahua', model: 'DHI-NVR4210', kind: 'nvr', method: 'agent_onvif', caps: { reachability: true, recording: false, storage: true, stream: true }, mode: 'local_agent' },
    { k: 4, code: 'FM-VEL-02', name: 'FreshMart Velachery', cust: 'fm', city: 'Chennai', region: 'Chennai South', lat: 12.9815, lng: 80.218, cams: [31, 40], vendor: 'Hikvision', model: 'DS-7608NI-K1', kind: 'nvr', method: 'vendor_api', caps: { reachability: true, recording: true, storage: true, stream: true }, mode: 'local_agent' },
    { k: 5, code: 'LOT-OMR-01', name: 'Lotus Clinic OMR', cust: 'lt', city: 'Chennai', region: 'Chennai South', lat: 12.9121, lng: 80.2279, cams: [41, 50], vendor: 'Uniview', model: 'NVR301-08S3', kind: 'nvr', method: 'cloud_tcp', caps: { reachability: true, recording: false, storage: false, stream: false }, mode: 'cloud' },
  ] as const;
  const LOC = ['Main gate', 'Loading bay', 'Dock door', 'Billing counter', 'Cash room', 'Aisle', 'Storeroom', 'Parking', 'Reception', 'Lift lobby', 'Rear exit', 'Corridor'];
  const site: Record<number, { id: string; name: string; code: string; nvr: string; nvrCode: string; cams: Array<{ id: string; code: string; critical: boolean }>; customerId: string }> = {};
  for (const s0 of SITES) {
    const st = await put('monitoringSite', o, sid(o, 'site', s0.k), { organizationId: o, customerId: C[s0.cust], code: s0.code, name: s0.name, address: `DEMO address, ${s0.city}`, city: s0.city, region: s0.region, latitude: new Prisma.Decimal(s0.lat), longitude: new Prisma.Decimal(s0.lng), monitoringMode: s0.mode, internetStatus: s0.k === 2 ? 'suspected_outage' : s0.k === 4 ? 'backup_link' : 'online', lastHealthyCheckAt: s0.k === 2 ? ago(47) : ago(1), isDemo: true });
    const nvrStatus = s0.k === 3 ? 'offline' : s0.k === 2 ? 'unknown' : 'online';
    const nvr = await put('recorderDevice', o, sid(o, 'nvr', s0.k), {
      organizationId: o, siteId: st.id, code: `NVR-0${s0.k}`, name: `${s0.vendor} ${s0.kind.toUpperCase()}`, kind: s0.kind, manufacturer: s0.vendor, model: s0.model, channels: 16, networkAddress: s0.mode === 'cloud' ? `203.0.113.${40 + s0.k}:8000` : `192.168.${s0.k}.10`, monitoringMethod: s0.method,
      capabilities: { reachability: true, storage: s0.caps.storage, recording: s0.caps.recording }, status: nvrStatus, storageStatus: s0.k === 4 ? 'warning' : s0.caps.storage ? 'ok' : 'unsupported', storageDetail: s0.k === 4 ? 'DEMO: HDD 2 reports 3 reallocated sectors; 92% used' : null,
      recordingStatus: s0.caps.recording ? 'verified' : 'unsupported', consecutiveFailures: s0.k === 3 ? 9 : 0, consecutiveSuccesses: s0.k === 3 || s0.k === 2 ? 0 : 40, failingSince: s0.k === 3 ? ago(52) : null, lastSeenAt: s0.k === 3 ? ago(52) : s0.k === 2 ? ago(47) : ago(1), lastCheckAt: s0.k === 2 ? ago(47) : ago(1), isDemo: true,
    });
    const cams = [];
    for (let n = s0.cams[0]; n <= s0.cams[1]; n++) {
      const code = `CAM-${String(n).padStart(3, '0')}`;
      const i = n - s0.cams[0];
      const critical = i === 0 || LOC[i % LOC.length] === 'Cash room' || LOC[i % LOC.length] === 'Billing counter';
      // Current state per scenario
      let status = 'online', streamStatus = s0.caps.stream ? 'ok' : 'unsupported', recordingStatus = s0.caps.recording ? 'verified' : 'unsupported', failingSince: Date | null = null, lastSeenAt = ago(1), fails = 0, okRun = 30;
      if (s0.k === 3) { status = 'offline'; failingSince = ago(52); lastSeenAt = ago(52); fails = 9; okRun = 0; streamStatus = 'unavailable'; }
      if (s0.k === 2) { status = 'unknown'; lastSeenAt = ago(47); okRun = 0; }
      if (code === 'CAM-014') { status = 'offline'; failingSince = ago(38); lastSeenAt = ago(38); fails = 12; okRun = 0; streamStatus = 'unavailable'; }
      if (code === 'CAM-017') { status = 'online'; okRun = 2; }
      if (code === 'CAM-034') { status = 'degraded'; fails = 1; okRun = 0; }
      if (code === 'CAM-036') { recordingStatus = 'failing'; }
      const cam = await put('cameraDevice', o, sid(o, 'cam', n), {
        organizationId: o, siteId: st.id, recorderId: nvr.id, code, name: `${LOC[i % LOC.length]} ${Math.floor(i / LOC.length) + 1}`, location: LOC[i % LOC.length], manufacturer: s0.vendor, model: s0.vendor === 'Hikvision' ? 'DS-2CD1043G2' : s0.vendor === 'CP Plus' ? 'CP-USC-TA24L2' : s0.vendor === 'Dahua' ? 'IPC-HFW1230S' : 'IPC2124LB',
        channelNo: i + 1, networkAddress: s0.mode === 'cloud' ? `203.0.113.${100 + n}:554` : `192.168.${s0.k}.${20 + i}`, monitoringMethod: s0.method, capabilities: s0.caps, critical,
        status, streamStatus, recordingStatus, consecutiveFailures: fails, consecutiveSuccesses: okRun, failingSince, lastSeenAt, lastCheckAt: s0.k === 2 ? ago(47) : ago(1), lastRecordingVerifiedAt: s0.caps.recording ? (code === 'CAM-036' ? ago(95) : ago(4)) : null, isDemo: true,
      });
      cams.push({ id: cam.id, code, critical });
    }
    site[s0.k] = { id: st.id, name: s0.name, code: s0.code, nvr: nvr.id, nvrCode: `NVR-0${s0.k}`, cams, customerId: C[s0.cust] };
  }

  // Technicians (synthetic numbers), supervisor and manager for escalations.
  const TECH = [
    { key: 'ravi', name: 'Ravi (technician)', site: 1, role: 'technician', onCall: false },
    { key: 'mani', name: 'Mani (technician)', site: 2, role: 'technician', onCall: false },
    { key: 'arun', name: 'Arun (technician)', site: 3, role: 'technician', onCall: true },
    { key: 'bala', name: 'Bala (technician)', site: 4, role: 'technician', onCall: false },
    { key: 'senthil', name: 'Senthil (technician)', site: 5, role: 'technician', onCall: false },
    { key: 'dinesh', name: 'Dinesh (on-call technician)', site: 0, role: 'technician', onCall: true },
    { key: 'priya', name: 'Priya (supervisor)', site: 0, role: 'supervisor', onCall: true },
    { key: 'kumar', name: 'Kumar (service manager)', site: 0, role: 'manager', onCall: true },
  ];
  const T: Record<string, { id: string; name: string; phone: string }> = {};
  for (const [i, t] of TECH.entries()) {
    const row = await put('siteTechnician', o, sid(o, 'tech', t.key), { organizationId: o, siteId: t.site ? site[t.site].id : null, name: t.name, phone: phoneFor(0, 800 + i), role: t.role, onCall: t.onCall, shift: { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00' }, whatsappConsent: true, active: true, isDemo: true });
    T[t.key] = { id: row.id, name: t.name, phone: phoneFor(0, 800 + i) };
  }

  // Service / AMC contracts (one expiring soon).
  const today = TODAY;
  await put('serviceContract', o, sid(o, 'amc', 'wh'), { organizationId: o, customerId: C.wh, reference: 'DEMO-AMC-2026-011', kind: 'amc', planCode: 'pro', startDate: dayOnly(addDays(today, -200)), endDate: dayOnly(addDays(today, 165)), slaHours: 8, responseMinutes: 60, cameraLimit: 25, monthlyFee: dec(20 * 45), notes: 'DEMO contract: quarterly preventive maintenance.', isDemo: true });
  await put('serviceContract', o, sid(o, 'amc', 'fm'), { organizationId: o, customerId: C.fm, reference: 'DEMO-AMC-2026-014', kind: 'amc', planCode: 'sla', startDate: dayOnly(addDays(today, -340)), endDate: dayOnly(addDays(today, 20)), slaHours: 4, responseMinutes: 30, cameraLimit: 20, monthlyFee: dec(20 * 60), notes: 'DEMO contract: renewal due this month.', isDemo: true });
  await put('serviceContract', o, sid(o, 'amc', 'lt'), { organizationId: o, customerId: C.lt, reference: 'DEMO-MON-2026-003', kind: 'monitoring_only', planCode: 'basic', startDate: dayOnly(addDays(today, -60)), endDate: dayOnly(addDays(today, 305)), slaHours: 24, responseMinutes: 120, cameraLimit: 10, monthlyFee: dec(10 * 30), isDemo: true });
  await put('serviceContract', o, sid(o, 'amc', 'fm-vel'), { organizationId: o, customerId: C.fm, siteId: site[4].id, reference: 'DEMO-WAR-2026-007', kind: 'warranty', planCode: 'sla', startDate: dayOnly(addDays(today, -90)), endDate: dayOnly(addDays(today, 275)), slaHours: 4, responseMinutes: 30, notes: 'DEMO: installer warranty for the Velachery NVR upgrade.', isDemo: true });

  // Local agents (static snapshot) + heartbeats.
  const AG = [
    { k: 1, backup: false, last: 1, link: 'primary', status: 'online' },
    { k: 2, backup: false, last: 47, link: 'primary', status: 'offline' },
    { k: 3, backup: true, last: 1, link: 'primary', status: 'online' },
    { k: 4, backup: true, last: 1, link: 'backup_4g', status: 'online' },
  ];
  const agent: Record<number, string> = {};
  for (const a of AG) {
    const row = await put('monitoringAgent', o, sid(o, 'agent', a.k), { organizationId: o, siteId: site[a.k].id, code: `AGT-0${a.k}`, name: `${site[a.k].name} agent (demo)`, tokenHash: 'demo-no-token', tokenPrefix: `vo_demo0${a.k}cctv`, status: a.status, version: '0.9.0-demo', hostLabel: a.k === 4 ? 'NUC + 4G dongle (demo)' : 'Site PC (demo)', hasBackupLink: a.backup, lastHeartbeatAt: ago(a.last), lastEventAt: ago(a.last), lastSyncAt: ago(a.last), queuedEvents: 0, isDemo: true });
    agent[a.k] = row.id;
    for (let h = 0; h < 12; h++) await put('agentHeartbeat', o, sid(o, `hb${a.k}`, h), { organizationId: o, agentId: row.id, sentAt: ago(a.last + h * 5), receivedAt: ago(a.last + h * 5), queueDepth: 0, version: '0.9.0-demo', uptimeSec: 86_400 * 9 - h * 300, link: a.link, isDemo: true });
  }

  // Health events: recent checks for every camera (+ the failure runs behind current incidents).
  let ev = 0;
  const event = (siteK: number, deviceType: string, deviceId: string | null, check: string, ok: boolean, at: Date, extra: Record<string, unknown> = {}) =>
    put('healthEvent', o, sid(o, 'ev', ++ev), { organizationId: o, siteId: site[siteK].id, agentId: agent[siteK] ?? null, deviceType, deviceId, check, ok, observedAt: at, receivedAt: (extra.receivedAt as Date) ?? at, latencyMs: ok ? r.int(3, 40) : null, detail: (extra.detail as string) ?? (ok ? null : 'DEMO: no response (timeout)'), source: siteK === 5 ? 'cloud' : 'demo', externalId: `demo:${ev}`, replayed: Boolean(extra.replayed), isDemo: true });
  for (const k of [1, 3, 4, 5]) for (const c of site[k].cams) for (const m of [1, 6, 11]) {
    const down = k === 3 || c.code === 'CAM-014';
    if (!down) await event(k, 'camera', c.id, 'reachability', !(c.code === 'CAM-034' && m === 1), ago(m));
  }
  for (const m of [38, 37, 36, 30, 20, 10, 1]) await event(1, 'camera', site[1].cams.find((c) => c.code === 'CAM-014')!.id, 'reachability', false, ago(m));
  for (const m of [52, 51, 50, 40, 20, 1]) await event(3, 'recorder', site[3].nvr, 'reachability', false, ago(m));
  for (const m of [92, 91, 90, 60, 30]) await event(4, 'camera', site[4].cams.find((c) => c.code === 'CAM-036')!.id, 'recording', false, ago(m), { detail: 'DEMO: recorder reports no recording on channel 6 (schedule disabled?)' });
  for (const m of [26, 25, 24]) await event(4, 'site', site[4].id, 'internet', false, ago(m), { detail: 'DEMO: primary broadband down; reporting over 4G backup' });
  for (const m of [120, 60, 1]) await event(4, 'recorder', site[4].nvr, 'storage', false, ago(m), { detail: 'DEMO: HDD 2 reallocated sectors; 92% used' });
  // Sriperumbudur: last events before the agent went silent (47 min ago), some replayed earlier in the week after an outage.
  for (const c of site[2].cams) await event(2, 'camera', c.id, 'reachability', true, ago(48));
  for (const m of [3 * 1440 + 60, 3 * 1440 + 50, 3 * 1440 + 40]) await event(2, 'camera', site[2].cams[0].id, 'reachability', true, ago(m), { replayed: true, receivedAt: ago(3 * 1440 + 5) });

  // Incidents: 30 days of resolved history + the current ones, numbered in detection order.
  type Inc = { siteK: number; type: string; deviceId: string | null; deviceCode: string | null; category: string; severity: string; status: string; start: number; ackAfter?: number; resolveAfter?: number; affected?: string[]; tech?: string; rootCause?: string; reopen?: number; mergedInto?: number; evidence?: number; escLevel?: number; title?: string };
  const CAT: Record<string, string> = { camera_unreachable: 'Camera unreachable', recorder_unreachable: 'DVR/NVR unreachable', recording_not_confirmed: 'Recording not confirmed', stream_unavailable: 'Video stream unavailable', network_lost: 'Site network connectivity lost', internet_outage: 'Site internet outage (local monitoring continues)', agent_offline: 'Monitoring agent not reporting', storage_warning: 'Recorder storage / disk warning' };
  const CAUSES: Record<string, string[]> = {
    camera_unreachable: ['Loose RJ45 at the PoE switch', 'PoE port failure: moved to a spare port', 'Camera power adapter replaced', 'Cable cut during civil work, re-crimped', 'Camera rebooted after a power fluctuation'],
    recorder_unreachable: ['NVR hung after a power cut; restarted by the site team', 'Router replaced by the ISP; NVR re-addressed', 'UPS battery failure at the rack'],
    network_lost: ['Main switch power adapter failure'],
    internet_outage: ['ISP fibre cut in the area', 'Broadband router reboot'],
    agent_offline: ['Site internet outage: the local agent kept monitoring and synced its queued events', 'Agent PC switched off by staff over the weekend'],
    storage_warning: ['Disk replaced under warranty'],
    recording_not_confirmed: ['Recording schedule restored after a firmware update'],
  };
  const hist: Inc[] = [];
  const cats = ['camera_unreachable', 'camera_unreachable', 'camera_unreachable', 'camera_unreachable', 'recorder_unreachable', 'internet_outage', 'agent_offline', 'storage_warning', 'recording_not_confirmed'];
  for (let i = 0; i < 40; i++) {
    const k = r.pick([1, 1, 2, 3, 3, 4, 4, 5]);
    let cat = r.pick(cats);
    if ((cat === 'storage_warning' || cat === 'recording_not_confirmed') && !SITES[k - 1].caps.recording) cat = 'camera_unreachable';
    if (cat === 'agent_offline' && k === 5) cat = 'camera_unreachable';
    const cam = r.pick(site[k].cams);
    const start = r.int(2 * 1440, 30 * 1440);
    const dur = cat === 'camera_unreachable' ? r.int(12, 180) : cat === 'recorder_unreachable' ? r.int(25, 240) : cat === 'agent_offline' || cat === 'internet_outage' ? r.int(20, 300) : r.int(60, 900);
    const isCam = cat === 'camera_unreachable' || cat === 'recording_not_confirmed';
    hist.push({
      siteK: k, type: isCam ? 'camera' : cat === 'agent_offline' ? 'agent' : cat === 'internet_outage' ? 'site' : 'recorder', deviceId: isCam ? cam.id : cat === 'agent_offline' ? agent[k] ?? null : cat === 'internet_outage' ? site[k].id : site[k].nvr,
      deviceCode: isCam ? cam.code : cat === 'agent_offline' ? `AGT-0${k}` : cat === 'internet_outage' ? null : site[k].nvrCode, category: cat,
      severity: cat === 'recorder_unreachable' ? 'critical' : cat === 'agent_offline' || cat === 'recording_not_confirmed' || (isCam && cam.critical) ? 'high' : 'medium',
      status: r.rnd() < 0.7 ? 'CLOSED' : 'RESOLVED', start, ackAfter: r.int(2, 35), resolveAfter: dur, affected: cat === 'recorder_unreachable' || cat === 'agent_offline' ? site[k].cams.map((c) => c.code) : undefined,
      tech: ['ravi', 'mani', 'arun', 'bala', 'senthil'][k - 1], rootCause: r.pick(CAUSES[cat]),
    });
  }
  const cam = (code: string) => { for (const k of [1, 2, 3, 4, 5]) { const c = site[k].cams.find((x) => x.code === code); if (c) return { ...c, siteK: k }; } throw new Error(code); };
  const now: Inc[] = [
    { siteK: 1, type: 'camera', deviceId: cam('CAM-011').id, deviceCode: 'CAM-011', category: 'camera_unreachable', severity: 'medium', status: 'RESOLVED', start: 300, ackAfter: 4, resolveAfter: 95, tech: 'ravi', rootCause: 'Intermittent PoE port; moved to port 14', reopen: 1, evidence: 3 },
    { siteK: 5, type: 'camera', deviceId: cam('CAM-044').id, deviceCode: 'CAM-044', category: 'camera_unreachable', severity: 'medium', status: 'RESOLVED', start: 180, ackAfter: 7, resolveAfter: 64, tech: 'senthil', rootCause: 'Camera adapter replaced', evidence: 3 },
    { siteK: 3, type: 'camera', deviceId: cam('CAM-024').id, deviceCode: 'CAM-024', category: 'camera_unreachable', severity: 'medium', status: 'CLOSED', start: 55, resolveAfter: 3, mergedInto: 1 },
    { siteK: 3, type: 'recorder', deviceId: site[3].nvr, deviceCode: 'NVR-03', category: 'recorder_unreachable', severity: 'critical', status: 'ASSIGNED', start: 52, ackAfter: 5, affected: site[3].cams.map((c) => c.code), tech: 'arun' },
    { siteK: 2, type: 'agent', deviceId: agent[2], deviceCode: 'AGT-02', category: 'agent_offline', severity: 'high', status: 'OPEN', start: 37, affected: site[2].cams.map((c) => c.code), escLevel: 1 },
    { siteK: 1, type: 'camera', deviceId: cam('CAM-014').id, deviceCode: 'CAM-014', category: 'camera_unreachable', severity: 'medium', status: 'IN_PROGRESS', start: 38, ackAfter: 6, tech: 'ravi' },
    { siteK: 4, type: 'site', deviceId: site[4].id, deviceCode: null, category: 'internet_outage', severity: 'medium', status: 'ACKNOWLEDGED', start: 26, ackAfter: 9, tech: 'bala' },
    { siteK: 4, type: 'camera', deviceId: cam('CAM-036').id, deviceCode: 'CAM-036', category: 'recording_not_confirmed', severity: 'high', status: 'OPEN', start: 92 },
    { siteK: 4, type: 'recorder', deviceId: site[4].nvr, deviceCode: 'NVR-04', category: 'storage_warning', severity: 'medium', status: 'ACKNOWLEDGED', start: 600, ackAfter: 22, tech: 'bala' },
    { siteK: 1, type: 'camera', deviceId: cam('CAM-017').id, deviceCode: 'CAM-017', category: 'camera_unreachable', severity: 'medium', status: 'RESTORATION_CHECK', start: 24, ackAfter: 3, tech: 'ravi', evidence: 2 },
  ];
  const all = [...hist, ...now].sort((a, b) => b.start - a.start);
  const incId: Record<number, string> = {};
  const numberOf: Record<number, string> = {};
  let tl = 0, na = 0;
  const timeline = (incidentId: string, at: Date, type: string, message: string, actor = 'system', data?: unknown) => put('incidentTimelineEvent', o, sid(o, 'tl', ++tl), { organizationId: o, incidentId, at, type, message, actor, ...(data ? { data } : {}) });
  const note = (incidentId: string, t: { id: string; name: string; phone: string } | { name: string; phone: string; id?: undefined }, type: string, purpose: string, body: string, at: Date) =>
    put('notificationAttempt', o, sid(o, 'na', ++na), { organizationId: o, incidentId, technicianId: t.id ?? null, recipientType: type, recipientName: t.name, recipientPhone: t.phone, channel: 'whatsapp', purpose, body, idempotencyKey: `demo:${na}`, status: 'simulated', scheduledFor: at, sentAt: at, costEstimate: dec(0.12), simulated: true, lastError: 'SIMULATED: demo workspace (synthetic number is never contacted)', isDemo: true });
  const nowIdx = (x: Inc) => now.indexOf(x);
  for (const [n, x] of all.entries()) {
    const number = `INC-${1001 + n}`;
    const first = ago(x.start);
    const ack = x.ackAfter !== undefined ? ago(x.start - x.ackAfter) : null;
    const resolved = x.resolveAfter !== undefined ? ago(x.start - x.resolveAfter) : null;
    const s0 = site[x.siteK];
    const tech = x.tech ? T[x.tech] : undefined;
    const active = !['RESOLVED', 'CLOSED'].includes(x.status);
    const openKey = active ? `${x.type}:${x.deviceId ?? '-'}:${x.category}` : null;
    const evidence = x.evidence ? Array.from({ length: x.evidence }, (_, j) => ({ at: ago(Math.max(0, (resolved ? x.start - x.resolveAfter! : 3) + (x.evidence! - j))).toISOString(), check: x.category === 'agent_offline' ? 'heartbeat' : 'reachability', ok: true, eventId: `demo:evidence:${n}:${j}`, source: 'demo' })) : null;
    const merged = x.mergedInto !== undefined;
    const row = await put('downtimeIncident', o, sid(o, 'inc', n), {
      organizationId: o, number, siteId: s0.id, customerId: s0.customerId, deviceType: x.type, deviceId: x.deviceId, deviceCode: x.deviceCode, category: x.category, severity: x.severity, status: x.status,
      title: `${CAT[x.category]}${x.deviceCode ? `: ${x.deviceCode}` : ''} at ${s0.name}`.slice(0, 190), affectedCount: x.affected?.length ?? 1, affectedDevices: x.affected ?? (x.deviceCode ? [x.deviceCode] : []),
      firstDetectedAt: first, lastCheckedAt: resolved ?? ago(1), acknowledgedAt: ack, acknowledgedBy: ack ? `technician:${tech?.name ?? 'NOC'}` : null, assignedTechnicianId: tech && x.status !== 'OPEN' ? tech.id : null, assignedAt: tech && ack && !['OPEN', 'ACKNOWLEDGED'].includes(x.status) ? ack : null,
      inProgressAt: x.status === 'IN_PROGRESS' ? ago(x.start - (x.ackAfter ?? 0) - 10) : null, restorationCheckAt: x.status === 'RESTORATION_CHECK' ? ago(3) : null, resolvedAt: merged ? ago(52) : resolved, closedAt: x.status === 'CLOSED' ? (merged ? ago(52) : resolved) : null,
      resolvedBy: merged ? 'correlation' : resolved ? 'verification' : null, rootCause: merged ? 'Merged into the NVR-03 recorder incident: the same root cause.' : resolved ? x.rootCause : null, resolutionNote: resolved && !merged ? `DEMO: ${x.rootCause}.` : null,
      restorationEvidence: evidence ?? undefined, reopenCount: x.reopen ?? 0, lastReopenedAt: x.reopen ? ago(x.start - 40) : null, escalationLevel: x.escLevel ?? 0, nextEscalationAt: null, openKey, correlationKey: `${x.type}:${x.deviceId ?? '-'}:${x.category}`, isDemo: true,
    });
    incId[n] = row.id;
    numberOf[n] = number;
    // Timeline + WhatsApp previews (all SIMULATED).
    await timeline(row.id, first, 'detected', `${CAT[x.category]} confirmed after 3 failed checks (debounce 180 s).`, 'system', { severity: x.severity, rule: 'deterministic', demo: true });
    if (merged) { await timeline(row.id, ago(52), 'correlated', 'Merged into the NVR-03 recorder incident: the same root cause.'); continue; }
    const alertTo = tech ?? T.dinesh;
    const dur = Math.max(3, Math.round(3 + (x.category === 'agent_offline' ? 10 : 0)));
    const alert = x.category === 'agent_offline'
      ? `The monitoring agent at ${s0.name} has not reported for ${dur} minutes. Camera states are UNKNOWN (not confirmed offline). Incident ${number} is open (${x.severity}). Please reply "ACK ${number}" to acknowledge and check the device or network connection. Reply "HELP ${number}" for first checks.`
      : `${x.type === 'recorder' ? 'Recorder' : x.type === 'camera' ? 'Camera' : 'Monitoring'} ${x.deviceCode ?? ''} at ${s0.name} — ${CAT[x.category]} for ${dur} minutes.${x.affected ? ` ${x.affected.length} cameras affected.` : ''} Incident ${number} is open (${x.severity}). Please reply "ACK ${number}" to acknowledge. Reply "HELP ${number}" for first checks.`.replace(/\s+/g, ' ');
    await note(row.id, alertTo, 'technician', 'alert', alert, new Date(first.getTime() + 60_000));
    await timeline(row.id, new Date(first.getTime() + 60_000), 'notified', `Alert for ${alertTo.name}. Escalates if not acknowledged in 15 min.`);
    if (x.escLevel) {
      const esc = `Escalation L1: ${number} (${CAT[x.category]}${x.deviceCode ? `, ${x.deviceCode}` : ''}) at ${s0.name} has not been acknowledged for 16 minutes. Please acknowledge or assign it: reply "ACK ${number}".`;
      await note(row.id, T.priya, 'supervisor', 'escalation', esc, new Date(first.getTime() + 16 * 60_000));
      await timeline(row.id, new Date(first.getTime() + 16 * 60_000), 'escalated', `Not acknowledged in time: escalated to supervisor (${T.priya.name}), level 1.`, 'system', { level: 1 });
    }
    if (ack) {
      await timeline(row.id, ack, 'acknowledged', `Acknowledged by ${alertTo.name} (whatsapp).`, `technician:${alertTo.name}`);
      await note(row.id, alertTo, 'technician', 'reply', `${number} acknowledged. Assigned to ${alertTo.name}. Status: investigating. Reply "HELP ${number}" for first checks.`, ack);
      if (tech && !['ACKNOWLEDGED'].includes(x.status)) await timeline(row.id, ack, 'assigned', `Assigned to ${tech.name} (technician).`, `technician:${tech.name}`);
    }
    if (x.status === 'IN_PROGRESS') await timeline(row.id, ago(x.start - (x.ackAfter ?? 0) - 10), 'in_progress', 'Work started: reached site, checking the PoE switch.', `technician:${tech?.name}`);
    if (x.reopen) {
      await timeline(row.id, ago(x.start - 30), 'resolved', 'Restoration verified by 3 consecutive successful checks.', 'system');
      await timeline(row.id, ago(x.start - 40), 'reopened', 'The fault came back 10 min after resolution (inside the 30-minute correlation window): incident reopened.', 'system');
    }
    if (evidence) await timeline(row.id, new Date(evidence[0].at), 'restoration_check', `${x.deviceCode ?? 'Device'} responded again. Restoration check started: 3 consecutive successful checks needed.`, 'system', { evidence: evidence[0] });
    if (resolved) {
      await timeline(row.id, resolved, 'resolved', `Restoration verified by ${evidence?.length ?? 3} consecutive successful checks. Root cause: ${x.rootCause}`, 'system');
      await note(row.id, alertTo, 'technician', 'restored', `${x.deviceCode ?? 'The site'} is responding again. Restoration of ${number} was verified by 3 consecutive successful checks. Incident duration: ${x.resolveAfter} minutes.`, resolved);
      const c = custs.find((c0) => C[c0.key] === s0.customerId)!;
      if (c.notify && x.type !== 'agent') {
        await note(row.id, { name: c.contactName, phone: phoneFor(0, 900 + custs.indexOf(c)) }, 'customer', 'customer_report', `Service update from your CCTV monitoring team: ${number} at ${s0.name} (${CAT[x.category]}${x.deviceCode ? `, ${x.deviceCode}` : ''}) is resolved. Downtime: ${x.resolveAfter} minutes. Cause: ${x.rootCause}. Restoration was verified by fresh monitoring checks.`, resolved);
        await timeline(row.id, resolved, 'customer_notified', `Resolution summary for ${c.name} (${c.contactName}).`);
      }
      if (x.status === 'CLOSED') await timeline(row.id, new Date(resolved.getTime() + 3_600_000), 'closed', 'Closed after customer confirmation.', 'user:Demo NOC');
    }
    if (nowIdx(x) === 3) { // the NVR incident absorbed CAM-024
      const camIdx = all.findIndex((y) => y.mergedInto !== undefined);
      if (camIdx >= 0) await timeline(row.id, ago(52), 'correlated', `${numberOf[camIdx] ?? 'CAM-024 incident'} (CAM-024) merged into this incident.`);
    }
  }

  // Daily uptime snapshots (same rule as the dashboard: down camera-minutes from incidents; unknown excluded).
  const rows = await prisma.downtimeIncident.findMany({ where: { organizationId: o, resolvedBy: { not: 'correlation' }, category: { in: ['camera_unreachable', 'recorder_unreachable', 'network_lost', 'stream_unavailable', 'agent_offline', 'status_unknown'] } } });
  for (let d = 1; d <= 30; d++) {
    const day = addDays(today, -d);
    const ds = dayOnly(day).getTime() - IST, de = ds + DAY;
    for (const k of [1, 2, 3, 4, 5]) {
      const camsN = site[k].cams.length;
      let down = 0, unknown = 0, incidents = 0;
      for (const x of rows.filter((y) => y.siteId === site[k].id)) {
        const st = x.firstDetectedAt.getTime(), en = (x.resolvedAt ?? new Date(NOW)).getTime();
        if (st >= ds && st < de) incidents++;
        const ov = Math.min(en, de) - Math.max(st, ds);
        if (ov <= 0) continue;
        const m = Math.round(ov / 60_000) * (['camera_unreachable', 'stream_unavailable'].includes(x.category) ? 1 : Math.max(1, x.affectedCount));
        if (['agent_offline', 'status_unknown'].includes(x.category)) unknown += m; else down += m;
      }
      const total = camsN * 1440, measured = total - Math.min(unknown, total);
      await prisma.siteUptimeSnapshot.upsert({ where: { siteId_day: { siteId: site[k].id, day: dayOnly(day) } }, create: { organizationId: o, siteId: site[k].id, day: dayOnly(day), cameraMinutesTotal: total, cameraMinutesDown: down, cameraMinutesUnknown: unknown, uptimePct: new Prisma.Decimal(measured ? (((measured - Math.min(down, measured)) / measured) * 100).toFixed(3) : '100'), incidents, isDemo: true }, update: { cameraMinutesTotal: total, cameraMinutesDown: down, cameraMinutesUnknown: unknown, uptimePct: new Prisma.Decimal(measured ? (((measured - Math.min(down, measured)) / measured) * 100).toFixed(3) : '100'), incidents } });
      (counts[o] ??= {}).siteUptimeSnapshot = ((counts[o] ??= {}).siteUptimeSnapshot ?? 0) + 1;
    }
  }
  return o;
}

async function main() {
  await assertSafe();
  const demoIds = Object.values(DEMO_ORGS).map((o) => o.id);
  if (process.env.DEMO_SEED_RESET === 'yes') {
    for (const id of demoIds) await reset(id);
    console.log('Reset: demo workspaces emptied before seeding.');
  }
  const created: Record<Key, string> = {
    textile: await salesWorkspace('textile'),
    retail: await salesWorkspace('retail'),
    restaurant: await grWorkspace(),
    food: await foodWorkspace(),
    hotel: await hotelWorkspace(),
    hospital: await hospitalWorkspace(),
    real_estate: await realEstateWorkspace(),
    manufacturing: await manufacturingWorkspace(),
    agency: await agencyWorkspace(),
    cctv: await cctvWorkspace(),
  };
  const ids: string[] = Object.values(created);

  // Demo user with access to every demo workspace (password from the environment; never printed).
  const email = (process.env.DEMO_USER_EMAIL ?? 'demo@tacksharp.demo').trim().toLowerCase();
  const password = process.env.DEMO_USER_PASSWORD ?? '';
  if (password.length >= 12) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && !ids.includes(existing.organizationId)) throw new Error(`${email} belongs to a real organization; choose another DEMO_USER_EMAIL.`);
    const user = await prisma.user.upsert({ where: { email }, create: { email, name: 'Demo user', role: 'admin', organizationId: created.textile, passwordHash: await hashPassword(password) }, update: { passwordHash: await hashPassword(password), organizationId: created.textile } });
    for (const id of ids) await prisma.organizationMembership.upsert({ where: { userId_organizationId: { userId: user.id, organizationId: id } }, create: { userId: user.id, organizationId: id, role: 'admin' }, update: {} });
    console.log(`Demo user ${email}: access to ${ids.length} demo workspaces.`);
  } else {
    console.log('DEMO_USER_PASSWORD not set (12+ characters): no demo user created or changed.');
  }
  for (const e of (process.env.DEMO_GRANT_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const u = await prisma.user.findUnique({ where: { email: e } });
    if (!u) {
      console.log(`skip ${e}: no such user`);
      continue;
    }
    for (const id of ids) await prisma.organizationMembership.upsert({ where: { userId_organizationId: { userId: u.id, organizationId: id } }, create: { userId: u.id, organizationId: id, role: 'admin' }, update: {} });
    console.log(`${e}: can now switch into the demo workspaces.`);
  }
  console.log('Synthetic records written (upserts by stable id) per workspace:');
  for (const [k, id] of Object.entries(created)) console.log(`  ${id.padEnd(24)} ${Object.entries(counts[id] ?? {}).map(([m, c]) => `${m}=${c}`).join(' ')}`);
  console.log('Demo workspaces ready:', ids.join(', '));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
