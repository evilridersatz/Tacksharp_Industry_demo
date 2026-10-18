import type { PrismaService } from '../prisma/prisma.service.js';
import type { IndustryId } from './industries.js';

/**
 * "What data is in this workspace, and which API returns it?" — record counts per entity (with a status breakdown) for
 * the current organization only, plus the read API for each. Used by the Demo data page and the API sweep.
 */
type Spec = {
  key: string;
  label: string;
  model: string;
  table: string;
  api: string;
  /** Different read API for some industries (GR Chicken uses /restaurant/*). */
  apiFor?: Partial<Record<IndustryId, string>>;
  industries: 'all' | IndustryId[];
  status?: string;
  demoField?: boolean;
  sample: Record<string, true>;
};

const SALES: IndustryId[] = ['textile', 'retail'];
const SPECS: Spec[] = [
  { key: 'customers', label: 'Customers / patients / guests', model: 'customer', table: 'Customer', api: '/leads', apiFor: { restaurant: '/restaurant/customers', hospital: '/hospital/patients' }, industries: 'all', demoField: true, sample: { name: true, phone: true, source: true, language: true } },
  { key: 'leads', label: 'Leads & enquiries', model: 'lead', table: 'Lead', api: '/leads', industries: 'all', status: 'status', sample: { status: true, source: true, campaign: true, createdAt: true } },
  { key: 'conversations', label: 'Conversations', model: 'conversation', table: 'Conversation', api: '/conversations', apiFor: { restaurant: '/restaurant/conversations' }, industries: 'all', status: 'status', sample: { channel: true, status: true, updatedAt: true } },
  { key: 'messages', label: 'Messages', model: 'message', table: 'Message', api: '/conversations/:id/messages', industries: 'all', status: 'role', sample: { role: true, content: true, createdAt: true } },
  { key: 'follow_ups', label: 'Follow-up tasks (WhatsApp / voice / human)', model: 'followUp', table: 'FollowUp', api: '/follow-ups', industries: 'all', status: 'status', sample: { channel: true, source: true, message: true, status: true, scheduledAt: true } },
  { key: 'audit', label: 'Workflow audit trail', model: 'auditEvent', table: 'AuditEvent', api: '/(record detail pages)', industries: 'all', status: 'entityType', sample: { entityType: true, action: true, actor: true, createdAt: true } },
  { key: 'agent_tasks', label: 'Agent task runs', model: 'agentTask', table: 'AgentTask', api: '/agents/tasks', industries: ['textile', 'retail', 'manufacturing', 'agency'], status: 'status', sample: { kind: true, agent: true, status: true, createdAt: true } },
  { key: 'work_tasks', label: 'Team tasks', model: 'workTask', table: 'WorkTask', api: '/agents/work-tasks/list', industries: ['textile', 'retail', 'manufacturing', 'agency'], status: 'status', sample: { title: true, kind: true, status: true, priority: true } },
  // GR Chicken + food
  { key: 'outlets', label: 'Branches / outlets', model: 'outlet', table: 'Outlet', api: '/food/menu', apiFor: { restaurant: '/restaurant/menu' }, industries: ['restaurant', 'food'], demoField: true, sample: { name: true, area: true, opensAt: true, closesAt: true } },
  { key: 'menu_categories', label: 'Menu categories', model: 'menuCategory', table: 'MenuCategory', api: '/food/menu', apiFor: { restaurant: '/restaurant/menu' }, industries: ['restaurant', 'food'], sample: { name: true, sortOrder: true } },
  { key: 'menu_items', label: 'Menu items', model: 'menuItem', table: 'MenuItem', api: '/food/menu', apiFor: { restaurant: '/restaurant/menu' }, industries: ['restaurant', 'food'], status: 'available', demoField: true, sample: { name: true, price: true, unit: true, available: true, stockQty: true } },
  { key: 'orders', label: 'Orders', model: 'order', table: 'Order', api: '/food/orders', apiFor: { restaurant: '/restaurant/orders' }, industries: ['restaurant', 'food'], status: 'status', demoField: true, sample: { orderNumber: true, status: true, total: true, fulfilment: true, channel: true, createdAt: true } },
  { key: 'order_events', label: 'Order status history', model: 'orderEvent', table: 'OrderEvent', api: '/food/orders/:id', apiFor: { restaurant: '/restaurant/orders/:id' }, industries: ['restaurant', 'food'], status: 'type', sample: { type: true, fromStatus: true, toStatus: true, actor: true } },
  { key: 'order_followups', label: 'GR order follow-ups', model: 'orderFollowUp', table: 'OrderFollowUp', api: '/restaurant/followups', industries: ['restaurant'], status: 'status', sample: { kind: true, channel: true, status: true, dryRun: true } },
  { key: 'offer_claims', label: 'Offer claims', model: 'offerClaim', table: 'OfferClaim', api: '/restaurant/offers', industries: ['restaurant'], status: 'status', sample: { source: true, status: true, amount: true } },
  // hotel
  { key: 'room_types', label: 'Room types', model: 'roomType', table: 'RoomType', api: '/hotel/room-types', industries: ['hotel'], demoField: true, sample: { code: true, name: true, baseRate: true, weekendRate: true, maxOccupancy: true } },
  { key: 'rooms', label: 'Rooms (inventory)', model: 'room', table: 'Room', api: '/hotel/room-types', industries: ['hotel'], status: 'status', demoField: true, sample: { number: true, floor: true, status: true, housekeeping: true } },
  { key: 'room_rates', label: 'Seasonal rates', model: 'roomRate', table: 'RoomRate', api: '/hotel/room-types', industries: ['hotel'], demoField: true, sample: { name: true, startDate: true, endDate: true, rate: true } },
  { key: 'reservations', label: 'Reservations', model: 'reservation', table: 'Reservation', api: '/hotel/reservations', industries: ['hotel'], status: 'status', demoField: true, sample: { reference: true, status: true, checkIn: true, checkOut: true, total: true, paymentStatus: true } },
  // hospital
  { key: 'departments', label: 'Departments', model: 'department', table: 'Department', api: '/hospital/directory', industries: ['hospital'], demoField: true, sample: { name: true, active: true } },
  { key: 'doctors', label: 'Doctors', model: 'doctor', table: 'Doctor', api: '/hospital/directory', industries: ['hospital'], demoField: true, sample: { name: true, specialty: true, consultationFee: true, slotMinutes: true } },
  { key: 'appointments', label: 'Appointments', model: 'appointment', table: 'Appointment', api: '/hospital/appointments', industries: ['hospital'], status: 'status', demoField: true, sample: { reference: true, status: true, startAt: true, channel: true } },
  { key: 'insurance_cases', label: 'Insurance cases', model: 'insuranceCase', table: 'InsuranceCase', api: '/hospital/insurance', industries: ['hospital'], status: 'status', demoField: true, sample: { reference: true, kind: true, insurer: true, status: true } },
  // textile / retail
  { key: 'products', label: 'Catalogue products', model: 'textileProduct', table: 'TextileProduct', api: '/textile/products', industries: SALES, sample: { sku: true, name: true, fabricCategory: true, price: true } },
  { key: 'quotations', label: 'Quotations', model: 'quotation', table: 'Quotation', api: '/textile/quotations', industries: ['textile'], status: 'status', sample: { number: true, status: true, total: true } },
  { key: 'sales_orders', label: 'Sales orders', model: 'salesOrder', table: 'SalesOrder', api: '/textile/orders', industries: SALES, status: 'status', sample: { number: true, status: true, total: true } },
  { key: 'feedback', label: 'Customer feedback', model: 'feedback', table: 'Feedback', api: '/textile/feedback', industries: SALES, status: 'status', sample: { rating: true, status: true } },
  { key: 'invoices', label: 'Invoices', model: 'invoice', table: 'Invoice', api: '/finance/invoices', industries: SALES, status: 'status', sample: { number: true, status: true, total: true } },
  { key: 'campaigns', label: 'Marketing campaigns', model: 'marketingCampaign', table: 'MarketingCampaign', api: '/marketing/campaigns', industries: ['textile', 'retail', 'agency'], status: 'status', sample: { name: true, status: true, simulated: true } },
  { key: 'campaign_recipients', label: 'Campaign recipients', model: 'campaignRecipient', table: 'CampaignRecipient', api: '/marketing/campaigns/:id', industries: ['textile', 'retail', 'agency'], status: 'status', sample: { status: true, sentAt: true } },
  // real estate
  { key: 'properties', label: 'Properties / projects', model: 'property', table: 'Property', api: '/properties/search', industries: ['real_estate'], sample: { name: true, location: true } },
  { key: 'site_visits', label: 'Site visits', model: 'siteVisit', table: 'SiteVisit', api: '/site-visits', industries: ['real_estate'], status: 'status', sample: { status: true, scheduledAt: true } },
  { key: 'calls', label: 'AI calls', model: 'call', table: 'Call', api: '/voice/calls', industries: ['real_estate', 'restaurant'], status: 'status', sample: { direction: true, status: true, outcome: true } },
  // manufacturing
  { key: 'inspections', label: 'Quality inspections', model: 'qualityInspection', table: 'QualityInspection', api: '/quality/inspections', industries: ['manufacturing'], status: 'status', demoField: true, sample: { batchCode: true, productName: true, inspectedQty: true, rejectedQty: true, status: true } },
];

const serial = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v && typeof v === 'object' && 'toNumber' in (v as object) ? Number(v) : typeof v === 'string' && v.length > 120 ? `${v.slice(0, 117)}…` : v);

export async function dataInventory(prisma: PrismaService, org: string, industry: IndustryId) {
  const specs = SPECS.filter((s) => s.industries === 'all' || s.industries.includes(industry));
  const db = prisma as unknown as Record<string, { count: (a: unknown) => Promise<number>; groupBy: (a: unknown) => Promise<Array<Record<string, unknown>>>; findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> }>;
  const entities = [];
  for (const s of specs) {
    const where = { organizationId: org };
    const [total, groups, demo, sample] = await Promise.all([
      db[s.model].count({ where }),
      s.status ? db[s.model].groupBy({ by: [s.status], where, _count: { _all: true } }) : Promise.resolve([]),
      s.demoField ? db[s.model].count({ where: { ...where, isDemo: true } }) : Promise.resolve(null),
      db[s.model].findMany({ where, select: { id: true, ...s.sample }, take: 3, orderBy: { id: 'asc' } }),
    ]);
    entities.push({
      key: s.key, label: s.label, table: s.table, api: s.apiFor?.[industry] ?? s.api, total, demo,
      byStatus: (groups as Array<Record<string, unknown>>).map((g) => ({ value: String(g[s.status!]), count: (g._count as { _all: number })._all })).sort((a, b) => b.count - a.count),
      sample: sample.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, serial(v)]))),
    });
  }
  return { industry, organizationId: org, generatedAt: new Date().toISOString(), entities };
}
