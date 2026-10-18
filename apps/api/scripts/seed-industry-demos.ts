/**
 * Isolated DEMO workspaces, one per industry, for demonstrations of the multi-industry platform.
 *
 *   DEMO_SEED_CONFIRM=yes DEMO_USER_PASSWORD='<12+ chars>' npm run seed:industry-demos -w apps/api
 *   optional: DEMO_USER_EMAIL=demo@tacksharp.demo   DEMO_GRANT_EMAILS=owner@example.com,manager@example.com
 *
 * Safety:
 *   - writes ONLY to its own fixed organizations (org_demo_*), each flagged Organization.isDemo = true;
 *   - refuses to run if one of those ids exists as a NON-demo organization (it never touches a live business, and never
 *     touches GR Chicken's org_gr_chicken);
 *   - every customer / order / menu item / inspection it creates is flagged isDemo where the model has the flag, and
 *     demo customers are never contacted (liveGate); campaigns are recorded, never sent;
 *   - re-running replaces the demo data (stable ids and deterministic values), nothing else;
 *   - no password is hardcoded or printed: the demo user's password comes from DEMO_USER_PASSWORD.
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { Prisma, PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password.js';

if (process.env.DEMO_SEED_CONFIRM !== 'yes') {
  console.error('Refusing to run: set DEMO_SEED_CONFIRM=yes to create / replace the demo workspaces (org_demo_*).');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: process.env.DB_NAME ?? 'tacksharp',
  }),
});

export const DEMO_ORGS = {
  textile: { id: 'org_demo_textile', name: 'Demo · Kaveri Silks & Textiles', vertical: 'real_estate', industry: 'textile' },
  restaurant: { id: 'org_demo_restaurant', name: 'Demo · Spice Route Kitchen', vertical: 'restaurant', industry: 'real_estate' },
  real_estate: { id: 'org_demo_real_estate', name: 'Demo · Chennai Homes Realty', vertical: 'real_estate', industry: 'real_estate' },
  retail: { id: 'org_demo_retail', name: 'Demo · UrbanCart Store', vertical: 'real_estate', industry: 'retail' },
  manufacturing: { id: 'org_demo_manufacturing', name: 'Demo · Precision Components', vertical: 'real_estate', industry: 'manufacturing' },
  agency: { id: 'org_demo_agency', name: 'Demo · BrightLeaf Marketing', vertical: 'real_estate', industry: 'agency' },
} as const;

const DAY = 86_400_000;
const now = Date.now();
let seed = 20261018;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const ago = (maxDays: number, minDays = 0) => new Date(now - (minDays + rnd() * (maxDays - minDays)) * DAY);
const dec = (v: number) => new Prisma.Decimal(v.toFixed(2));
const NAMES = ['Ravi Kumar', 'Meena S', 'Karthik R', 'Lakshmi N', 'Senthil M', 'Priya V', 'Arun P', 'Divya K', 'Gopal R', 'Revathi K', 'Suresh B', 'Anitha P', 'Bala S', 'Nandhini V', 'Mohammed F', 'Deepa N', 'Vignesh T', 'Kavitha R', 'Rajesh I', 'Sangeetha M', 'Hari K', 'Janani S', 'Prakash R', 'Yamuna D', 'Dinesh K', 'Shalini G', 'Ashwin V', 'Bhuvana R'];
/** Synthetic numbers in a reserved demo range per workspace (never real customers). */
const phoneFor = (ws: number, i: number) => `910000${ws}${String(i).padStart(5, '0')}`;

async function assertSafe() {
  const ids = Object.values(DEMO_ORGS).map((o) => o.id);
  const live = await prisma.organization.findMany({ where: { id: { in: ids }, isDemo: false }, select: { id: true } });
  if (live.length) {
    console.error(`Refusing to run: ${live.map((o) => o.id).join(', ')} exist and are NOT demo workspaces.`);
    process.exit(1);
  }
}

/** Remove a demo workspace's records (children first where relations restrict deletes), then the organization. */
async function wipe(orgId: string) {
  const exists = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!exists) return;
  if (!exists.isDemo) throw new Error(`${orgId} is not a demo workspace`);
  const where = { organizationId: orgId };
  await prisma.payment.deleteMany({ where });
  await prisma.invoice.deleteMany({ where });
  await prisma.feedback.deleteMany({ where });
  await prisma.salesOrder.deleteMany({ where });
  await prisma.quotation.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.siteVisit.deleteMany({ where });
  await prisma.inventoryMovement.deleteMany({ where });
  await prisma.menuItem.deleteMany({ where });
  await prisma.menuCategory.deleteMany({ where });
  await prisma.organization.delete({ where: { id: orgId } });
}

async function org(key: keyof typeof DEMO_ORGS) {
  const o = DEMO_ORGS[key];
  await wipe(o.id);
  await prisma.organization.create({ data: { id: o.id, name: o.name, vertical: o.vertical, isDemo: true } });
  const settings = {
    industry: o.industry, textile: { quoteReminderDays: 2, feedbackAfterHours: 24, notifyOrderStatus: true, maxDiscountPct: 10 }, agents: { paused: [] },
    finance: { paymentTermsDays: 15, dispatchPaymentRule: 'none', autoDraftInvoice: true }, roi: { costPerLeadInr: 400, voiceCostPerMinuteInr: 0, whatsappCostPerMessageInr: 0.8 },
  };
  await prisma.organizationSettings.create({ data: { organizationId: o.id, data: settings as never } });
  return o.id;
}

async function customers(orgId: string, ws: number, count: number, extra: (i: number) => Partial<Prisma.CustomerUncheckedCreateInput> = () => ({})) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(await prisma.customer.create({ data: { organizationId: orgId, phone: phoneFor(ws, i), name: NAMES[i % NAMES.length], isDemo: true, messagingConsent: rnd() > 0.25, language: pick(['english', 'tamil', 'tanglish']), createdAt: ago(60, 20), ...extra(i) } }));
  }
  return out;
}

async function leadsFor(orgId: string, list: Array<{ id: string }>, opts: { sources: string[]; statuses: string[]; extra?: (i: number) => Partial<Prisma.LeadUncheckedCreateInput> }) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    out.push(await prisma.lead.create({ data: { organizationId: orgId, customerId: list[i].id, source: pick(opts.sources), status: pick(opts.statuses), createdAt: ago(30), ...(opts.extra?.(i) ?? {}) } }));
  }
  return out;
}

async function followUpsFor(orgId: string, leads: Array<{ id: string; customerId: string }>, source: string) {
  for (const l of leads.slice(0, 18)) {
    const done = rnd() > 0.35;
    await prisma.followUp.create({ data: { organizationId: orgId, leadId: l.id, customerId: l.customerId, channel: 'whatsapp', action: 'message', source, message: 'demo', status: done ? pick(['completed', 'completed', 'skipped']) : 'scheduled', scheduledAt: done ? ago(25) : new Date(now + rnd() * 2 * DAY) } });
  }
}

async function campaign(orgId: string, name: string, list: Array<{ id: string }>, leads: Array<{ id: string; customerId: string }>) {
  const c = await prisma.marketingCampaign.create({ data: { organizationId: orgId, name, status: 'completed', templateName: 'demo_offer', templateLanguage: 'en', startedAt: ago(20, 10), completedAt: ago(10, 5), simulated: false, createdBy: 'seed:demo' } });
  for (const cu of list.slice(0, 20)) {
    const delivered = rnd() > 0.1, replied = delivered && rnd() > 0.65;
    const lead = replied ? leads.find((l) => l.customerId === cu.id) : undefined;
    await prisma.campaignRecipient.create({ data: { organizationId: orgId, campaignId: c.id, customerId: cu.id, status: replied ? 'replied' : delivered ? 'delivered' : 'failed', providerMessageId: `demo-${c.id}-${cu.id}`, sentAt: ago(18, 12), deliveredAt: delivered ? ago(12, 10) : null, repliedAt: replied ? ago(10, 8) : null, leadId: lead?.id ?? null } });
  }
}

// ------------------------------------------------------------------------------------------------ sales (textile / retail)

async function salesWorkspace(key: 'textile' | 'retail', ws: number) {
  const orgId = await org(key);
  const catalogue = key === 'textile'
    ? [['TX-SH-01', 'Cotton Formal Shirt', 'shirts', 'white', '100% cotton', 650, 'piece'], ['TX-SH-02', 'Linen Casual Shirt', 'shirts', 'sky blue', 'linen blend', 890, 'piece'], ['TX-TR-01', 'Poly-Viscose Trousers', 'trousers', 'charcoal', '65/35 PV', 780, 'piece'], ['TX-TR-02', 'Cotton Chinos', 'trousers', 'khaki', 'cotton twill', 950, 'piece'], ['TX-SA-01', 'Kanchipuram Silk Saree', 'sarees', 'maroon', 'pure silk', 12500, 'piece'], ['TX-SA-02', 'Chettinad Cotton Saree', 'sarees', 'mustard', 'cotton', 1450, 'piece'], ['TX-SA-03', 'Soft Silk Saree', 'sarees', 'peacock green', 'art silk', 3200, 'piece'], ['TX-FB-01', 'Poplin Fabric', 'fabrics', 'white', '100% cotton', 120, 'metre'], ['TX-FB-02', 'Rayon Print Fabric', 'fabrics', 'floral', 'rayon', 160, 'metre'], ['TX-FB-03', 'Denim Fabric 10 oz', 'fabrics', 'indigo', 'cotton denim', 260, 'metre'], ['TX-KU-01', 'Cotton Kurta', 'kurtas', 'beige', 'cotton', 720, 'piece'], ['TX-DH-01', 'Silk Border Dhoti', 'dhotis', 'cream', 'cotton silk', 540, 'piece']] as const
    : [['RT-EA-01', 'Wireless Earbuds', 'audio', 'black', null, 1999, 'piece'], ['RT-EA-02', 'Neckband Headphones', 'audio', 'blue', null, 1299, 'piece'], ['RT-PB-01', '20000 mAh Power Bank', 'mobile accessories', 'grey', null, 1799, 'piece'], ['RT-CH-01', '65W Fast Charger', 'mobile accessories', 'white', null, 1499, 'piece'], ['RT-SW-01', 'Smart Watch', 'wearables', 'black', null, 3499, 'piece'], ['RT-KB-01', 'Steel Water Bottle 1L', 'home & kitchen', 'silver', null, 549, 'piece'], ['RT-KB-02', 'Non-stick Tawa', 'home & kitchen', 'black', null, 899, 'piece'], ['RT-LP-01', 'Laptop Backpack', 'bags', 'navy', null, 1599, 'piece'], ['RT-LP-02', 'Desk Lamp LED', 'home & kitchen', 'white', null, 999, 'piece'], ['RT-FT-01', 'Yoga Mat', 'fitness', 'purple', null, 799, 'piece']] as const;
  const products: Prisma.TextileProductGetPayload<object>[] = [];
  for (const [sku, name, category, colour, composition, price, unit] of catalogue) {
    const p = await prisma.textileProduct.create({
      data: { organizationId: orgId, sku, name, fabricCategory: category, colour, composition, priceUnit: unit, price: dec(price), priceApproved: true, stockStatus: pick(['in_stock', 'in_stock', 'low']), sizes: category === 'shirts' || category === 'kurtas' ? 'S,M,L,XL' : null, moq: key === 'textile' && unit === 'metre' ? 100 : null },
    });
    const onHand = unit === 'metre' ? int(80, 900) : int(2, 120);
    await prisma.inventoryBalance.create({ data: { organizationId: orgId, productId: p.id, onHand: dec(onHand), lowStockAt: dec(unit === 'metre' ? 150 : 15) } });
    await prisma.stockMovement.create({ data: { organizationId: orgId, productId: p.id, type: 'receive', quantity: dec(onHand), onHandAfter: dec(onHand), reservedAfter: dec(0), reference: `DEMO-GRN-${sku}`, actor: 'seed:demo', idempotencyKey: `demo:grn:${p.id}` } });
    products.push(p);
  }
  const list = await customers(orgId, ws, 28, () => ({ tags: [pick(key === 'textile' ? ['saree_buyer', 'wholesale', 'uniforms'] : ['gadgets', 'home', 'fitness'])] as never }));
  const leads = await leadsFor(orgId, list, { sources: ['whatsapp', 'meta', 'walk_in', 'website', 'referral'], statuses: ['new', 'contacted', 'qualified', 'quotation_sent', 'order_confirmed', 'repeat_customer', 'lost'] });
  let qn = 1, on = 1;
  for (let i = 0; i < 18; i++) {
    const lead = leads[i];
    const lines = Array.from({ length: int(1, 3) }, () => pick(products));
    const items = lines.map((p) => {
      const qty = p.priceUnit === 'metre' ? int(100, 600) : int(1, key === 'textile' ? 60 : 4);
      return { productId: p.id, sku: p.sku, description: p.name, quantity: dec(qty), unit: p.priceUnit, unitPrice: p.price!, lineTotal: dec(qty * Number(p.price)) };
    });
    const subtotal = items.reduce((a, x) => a + Number(x.lineTotal), 0);
    const total = Math.round(subtotal * 1.05 * 100) / 100;
    const created = ago(28, 1);
    const qStatus = key === 'retail' ? 'accepted' : pick(['draft', 'sent', 'sent', 'accepted', 'accepted', 'accepted', 'rejected', 'expired']);
    const q = await prisma.quotation.create({ data: { organizationId: orgId, customerId: lead.customerId, leadId: lead.id, number: `DEMO-Q-${String(qn++).padStart(4, '0')}`, status: qStatus, subtotal: dec(subtotal), taxPercent: dec(5), tax: dec(subtotal * 0.05), total: dec(total), origin: pick(['manual', 'ai_request']), createdAt: created, sentAt: qStatus === 'draft' ? null : created, items: { create: items.map(({ productId, sku, description, quantity, unit, unitPrice, lineTotal }) => ({ productId, sku, description, quantity, unit, unitPrice, lineTotal })) } } });
    if (qStatus !== 'accepted') continue;
    const status = pick(['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered', 'delivered', 'cancelled']);
    const order = await prisma.salesOrder.create({ data: { organizationId: orgId, customerId: lead.customerId, leadId: lead.id, quotationId: q.id, number: `DEMO-SO-${String(on++).padStart(4, '0')}`, status, paymentStatus: status === 'delivered' ? 'paid' : pick(['unpaid', 'partial']), total: dec(total), createdAt: new Date(created.getTime() + DAY), deliveredAt: status === 'delivered' ? new Date(created.getTime() + 5 * DAY) : null, courier: ['dispatched', 'delivered'].includes(status) ? 'ST Courier' : null, trackingRef: ['dispatched', 'delivered'].includes(status) ? `DEMO${int(100000, 999999)}` : null, items: { create: items.map(({ productId, sku, description, quantity, unit, unitPrice, lineTotal }) => ({ productId, sku, description, quantity, unit, unitPrice, lineTotal })) } } });
    if (status === 'delivered') await prisma.feedback.create({ data: { organizationId: orgId, customerId: lead.customerId, orderId: order.id, status: pick(['received', 'received', 'resolved']), rating: int(3, 5), comment: pick(['Good quality', 'Delivered on time', 'Colour slightly different', 'Excellent finish']) } });
  }
  await followUpsFor(orgId, leads, key === 'textile' ? 'quote' : 'order');
  await campaign(orgId, key === 'textile' ? 'Demo · Diwali silk collection' : 'Demo · Festive gadget sale', list, leads);
  return orgId;
}

// ------------------------------------------------------------------------------------------------ restaurant

async function restaurantWorkspace(ws: number) {
  const orgId = await org('restaurant');
  const outlet = await prisma.outlet.create({ data: { organizationId: orgId, name: 'Demo outlet · Anna Nagar', address: 'Sample address, Anna Nagar, Chennai', isDemo: true, opensAt: '11:00', closesAt: '23:00' } });
  const menu: Array<[string, Array<[string, number]>]> = [
    ['Biryani', [['Chicken Biryani', 249], ['Chicken 65 Biryani', 279], ['Egg Biryani', 189]]],
    ['Grills', [['Grilled Chicken (Half)', 299], ['Grilled Chicken (Full)', 549], ['Tandoori Chicken (Half)', 319]]],
    ['Fried Chicken', [['Fried Chicken (4 pc)', 259], ['Chicken 65', 219], ['Pepper Chicken', 239]]],
    ['Combos', [['Biryani + 65 Combo', 349], ['Family Grill Combo', 899]]],
    ['Beverages', [['Rose Milk', 69], ['Fresh Lime Soda', 59], ['Buttermilk', 39]]],
  ];
  const items: Prisma.MenuItemGetPayload<object>[] = [];
  let sort = 0;
  for (const [cat, list] of menu) {
    const c = await prisma.menuCategory.create({ data: { organizationId: orgId, name: cat } });
    for (const [name, price] of list) items.push(await prisma.menuItem.create({ data: { organizationId: orgId, categoryId: c.id, name, price: dec(price), unit: 'piece', cutOptions: [], isDemo: true, sortOrder: sort++, description: 'Demo menu item (sample price)' } }));
  }
  const list = await customers(orgId, ws, 24);
  for (let i = 0; i < 70; i++) {
    const created = i < 6 ? new Date(now - rnd() * 6 * 3_600_000) : ago(30, 0.3);
    // Lunch and dinner peaks (IST).
    const hourIst = pick([12, 13, 13, 14, 19, 20, 20, 21, 17, 11]);
    const at = new Date(Math.floor((created.getTime() + 330 * 60_000) / DAY) * DAY - 330 * 60_000 + hourIst * 3_600_000 + int(0, 59) * 60_000);
    const when = at.getTime() > now ? new Date(now - int(5, 50) * 60_000) : at;
    const lines = Array.from({ length: int(1, 3) }, () => pick(items));
    const orderLines = lines.map((m) => { const q = int(1, 3); return { menuItemId: m.id, name: m.name, unitPrice: m.price, quantity: dec(q), lineTotal: dec(q * Number(m.price)) }; });
    const subtotal = orderLines.reduce((a, l) => a + Number(l.lineTotal), 0);
    const recent = now - when.getTime() < 6 * 3_600_000;
    const status = recent ? pick(['pending', 'confirmed', 'preparing', 'ready', 'completed']) : pick(['completed', 'completed', 'completed', 'completed', 'cancelled']);
    const rated = status === 'completed' && rnd() > 0.5;
    const rating = rated ? pick([5, 5, 4, 4, 3, 2]) : null;
    await prisma.order.create({
      data: {
        organizationId: orgId, orderNumber: `DEMO-${String(i + 1).padStart(4, '0')}`, customerId: pick(list).id, outletId: outlet.id, channel: pick(['whatsapp', 'whatsapp', 'voice']), status, pickupAt: new Date(when.getTime() + 45 * 60_000),
        subtotal: dec(subtotal), total: dec(subtotal), paymentMethod: pick(['cash', 'upi']), idempotencyKey: `demo-order-${i}`, isDemo: true, createdAt: when,
        ...(rated ? { feedbackRating: rating, feedbackAt: new Date(when.getTime() + 3 * 3_600_000), feedbackChannel: 'whatsapp', complaintStatus: rating! <= 2 ? 'open' : null, complaintNote: rating! <= 2 ? 'Demo complaint: food was cold' : null } : {}),
        items: { create: orderLines },
      },
    });
  }
  for (const cu of list.slice(0, 14)) await prisma.conversation.create({ data: { id: `demo-conv-${orgId}-${cu.id}`, organizationId: orgId, channel: 'whatsapp', externalId: cu.phone!, customerId: cu.id, status: pick(['active', 'active', 'closed', 'human_handoff']), updatedAt: ago(5), createdAt: ago(30) } });
  return orgId;
}

// ------------------------------------------------------------------------------------------------ real estate

async function realEstateWorkspace(ws: number) {
  const orgId = await org('real_estate');
  const props = [['Green Valley Residency', 'Porur, Chennai', 'apartment', 2, 7800000], ['Lakeview Towers', 'Velachery, Chennai', 'apartment', 3, 12500000], ['OMR Smart Homes', 'OMR, Chennai', 'apartment', 2, 6900000], ['Tambaram Garden Villas', 'Tambaram, Chennai', 'villa', 3, 9800000], ['Anna Nagar Signature', 'Anna Nagar, Chennai', 'apartment', 3, 21000000], ['Guduvanchery Plots Phase 2', 'Guduvanchery, Chennai', 'plot', 0, 3500000]] as const;
  const properties = [];
  for (const [name, location, type, bhk, price] of props) properties.push(await prisma.property.create({ data: { organizationId: orgId, name, location, type, bhk, price: dec(price) } }));
  const areas = ['Porur', 'Velachery', 'OMR', 'Tambaram', 'Anna Nagar', 'Guduvanchery'];
  const list = await customers(orgId, ws, 28, (i) => ({ location: areas[i % areas.length] }));
  const leads = await leadsFor(orgId, list, { sources: ['meta', 'meta', 'website', 'magicbricks', 'referral', 'walk_in'], statuses: ['new', 'contacted', 'qualified', 'property_interested', 'site_visit', 'won', 'not_interested', 'lost'], extra: (i) => ({ location: areas[i % areas.length], budget: dec(pick([4000000, 6500000, 8000000, 12000000, 18000000, 25000000])), bhk: pick([2, 2, 3, 3, 4]), propertyType: pick(['apartment', 'villa', 'plot']) }) });
  const visitLeads = [...new Map(leads.filter((x) => ['site_visit', 'property_interested', 'won'].includes(x.status)).concat(leads.slice(0, 4)).map((l) => [l.id, l])).values()];
  for (const l of visitLeads) {
    const past = rnd() > 0.4;
    await prisma.siteVisit.create({ data: { id: `demo-visit-${l.id}`, organizationId: orgId, leadId: l.id, customerId: l.customerId, propertyId: pick(properties).id, scheduledAt: past ? ago(20, 1) : new Date(now + rnd() * 7 * DAY), status: past ? pick(['completed', 'completed', 'no_show', 'cancelled']) : 'scheduled', updatedAt: new Date() } });
  }
  await followUpsFor(orgId, leads, 'sequence');
  for (const l of leads.slice(0, 20)) await prisma.call.create({ data: { organizationId: orgId, customerId: l.customerId, leadId: l.id, toNumber: list.find((c) => c.id === l.customerId)!.phone!, fromNumber: 'demo', direction: 'outbound', status: 'completed', outcome: pick(['interested', 'callback', 'not_interested', 'site_visit_booked', 'no_answer']), durationSec: int(30, 240), createdAt: ago(25) } });
  for (const cu of list.slice(0, 16)) await prisma.conversation.create({ data: { id: `demo-conv-${orgId}-${cu.id}`, organizationId: orgId, channel: 'whatsapp', externalId: cu.phone!, customerId: cu.id, status: pick(['active', 'closed', 'human_handoff']), updatedAt: ago(4), createdAt: ago(30) } });
  return orgId;
}

// ------------------------------------------------------------------------------------------------ manufacturing

async function manufacturingWorkspace() {
  const orgId = await org('manufacturing');
  const products = ['Rubber Gasket 40mm', 'Brass Fitting 1/2"', 'Aluminium Bracket A2', 'Steel Shaft 12mm'];
  const lines = ['Line 1', 'Line 2', 'Line 3'];
  const cats = ['surface scratch', 'dimension out of tolerance', 'crack', 'burr', 'porosity', 'colour mismatch'];
  for (let i = 0; i < 46; i++) {
    const inspected = int(200, 1200);
    const line = pick(lines);
    // Line 3 runs worse in the demo, so the trend charts have something to show.
    const rate = line === 'Line 3' ? 0.02 + rnd() * 0.07 : rnd() * 0.035;
    const rejected = Math.round(inspected * rate);
    const defects = rejected ? Array.from(new Set(Array.from({ length: int(1, 3) }, () => pick(cats)))).map((c) => ({ category: c, count: Math.max(1, Math.round(rejected / int(1, 3))) })) : [];
    const inspectedAt = ago(30, 0.2);
    const open = rejected > 0 && rnd() > 0.55;
    await prisma.qualityInspection.create({
      data: {
        organizationId: orgId, batchCode: `DEMO-B${String(i + 1).padStart(4, '0')}`, productName: pick(products), line, inspector: pick(['QC Anand', 'QC Priya', 'QC Ramesh']), inspectedAt, inspectedQty: inspected, rejectedQty: rejected, defects: defects as never,
        status: rejected === 0 || !open ? 'resolved' : 'open', severity: rate > 0.06 ? 'major' : 'minor', resolvedAt: rejected === 0 ? inspectedAt : !open ? new Date(inspectedAt.getTime() + int(4, 72) * 3_600_000) : null,
        resolution: rejected && !open ? pick(['Die re-polished', 'Operator retrained', 'Supplier lot replaced', 'Fixture recalibrated']) : null, isDemo: true, createdBy: 'seed:demo',
      },
    });
  }
  return orgId;
}

// ------------------------------------------------------------------------------------------------ agency

async function agencyWorkspace(ws: number) {
  const orgId = await org('agency');
  const list = await customers(orgId, ws, 26, () => ({ tags: [pick(['boutique', 'clinic', 'restaurant', 'real_estate'])] as never }));
  const leads = await leadsFor(orgId, list, { sources: ['meta', 'google', 'website', 'referral', 'linkedin'], statuses: ['new', 'contacted', 'contacted', 'qualified', 'qualified', 'won', 'lost'], extra: (i) => ({ campaign: pick(['Diwali Boutique Promo', 'Clinic Lead Gen', 'Restaurant Footfall', null as unknown as string]), notes: ['Wants Instagram + Meta lead ads for a boutique', 'Clinic: needs a WhatsApp booking flow', 'Restaurant: weekend footfall campaign', 'Monthly SEO + Google Ads retainer', 'Landing page and lead-form setup', 'Festive offer campaign for a jewellery store'][i % 6] }) });
  await followUpsFor(orgId, leads, 'manual');
  await campaign(orgId, 'Demo · Client re-engagement', list, leads);
  return orgId;
}

async function main() {
  await assertSafe();
  const demoIds = Object.values(DEMO_ORGS).map((o) => o.id);
  // Re-running replaces the demo organizations: keep who could open them (demo users and memberships of real staff).
  const keptUsers = await prisma.user.findMany({ where: { organizationId: { in: demoIds } } });
  const keptMemberships = await prisma.organizationMembership.findMany({ where: { organizationId: { in: demoIds } } });
  const created = {
    textile: await salesWorkspace('textile', 1),
    retail: await salesWorkspace('retail', 4),
    restaurant: await restaurantWorkspace(2),
    real_estate: await realEstateWorkspace(3),
    manufacturing: await manufacturingWorkspace(),
    agency: await agencyWorkspace(6),
  };
  const ids: string[] = Object.values(created);
  for (const u of keptUsers) await prisma.user.create({ data: { ...u, updatedAt: undefined } });
  for (const m of keptMemberships) {
    if (await prisma.user.findUnique({ where: { id: m.userId } })) await prisma.organizationMembership.upsert({ where: { userId_organizationId: { userId: m.userId, organizationId: m.organizationId } }, create: { userId: m.userId, organizationId: m.organizationId, role: m.role }, update: {} });
  }

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
    console.log('DEMO_USER_PASSWORD not set (12+ characters): no demo user created.');
  }
  // Existing staff who should be able to open the demo workspaces (memberships into demo orgs only).
  for (const e of (process.env.DEMO_GRANT_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const u = await prisma.user.findUnique({ where: { email: e } });
    if (!u) { console.log(`skip ${e}: no such user`); continue; }
    for (const id of ids) await prisma.organizationMembership.upsert({ where: { userId_organizationId: { userId: u.id, organizationId: id } }, create: { userId: u.id, organizationId: id, role: 'admin' }, update: {} });
    console.log(`${e}: can now switch into the demo workspaces.`);
  }
  console.log('Demo workspaces ready:', ids.join(', '));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
