import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import { Orchestrator } from '../agents/orchestrator.service.js';
import { AiService } from '../ai/ai.service.js';
import { QualityService } from './quality.service.js';
import { cctvDashboard, foodDashboard, hospitalDashboard, hotelDashboard } from './vertical-dashboards.js';
import { MonitoringService } from '../visionops/monitoring.service.js';
import { dataInventory } from './data-inventory.js';
import { AGENT_CATALOGUE, INDUSTRY_LABEL, SETTABLE_INDUSTRIES, catalogueFor, effectiveIndustry, type CatalogueAgent, type IndustryId } from './industries.js';

const DAY = 86_400_000;
const IST = 330 * 60_000;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const LIVE_SALES = ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered'];
const QUALIFIED_EXCLUDED = ['new', 'contacted', 'not_interested', 'lost'];

export type Kpi = { key: string; label: string; value: number | null; format: 'number' | 'inr' | 'pct' | 'hours'; hint?: string; tone?: 'brand' | 'sky' | 'violet' | 'amber' | 'rose' | 'slate' };
export type Chart = { key: string; title: string; kind: 'line' | 'bar' | 'donut' | 'funnel'; unit: string; labels: string[]; series: Array<{ name: string; values: number[] }>; source: string; empty?: string };
export type Dashboard = { industry: IndustryId; label: string; days: number; demo: boolean; generatedAt: string; kpis: Kpi[]; charts: Chart[]; notes: string[] };

/** IST calendar-day buckets for the last `days` days (oldest first). */
function dayBuckets(days: number) {
  const todayIst = Math.floor((Date.now() + IST) / DAY);
  const keys = Array.from({ length: days }, (_, i) => todayIst - (days - 1 - i));
  const labels = keys.map((k) => new Date(k * DAY).toISOString().slice(5, 10).split('-').reverse().join('/'));
  const index = (d: Date) => keys.indexOf(Math.floor((d.getTime() + IST) / DAY));
  return { keys, labels, index };
}
function series(days: number, rows: Array<{ at: Date; value?: number }>) {
  const b = dayBuckets(days);
  const values = new Array(days).fill(0);
  for (const r of rows) {
    const i = b.index(r.at);
    if (i >= 0) values[i] = r2(values[i] + (r.value ?? 1));
  }
  return { labels: b.labels, values };
}
const top = (m: Map<string, number>, k = 8) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
const tally = <T>(rows: T[], key: (r: T) => string | null | undefined, value: (r: T) => number = () => 1) => {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) || 'unknown';
    m.set(k, r2((m.get(k) ?? 0) + value(r)));
  }
  return m;
};
const bar = (key: string, title: string, unit: string, m: Map<string, number> | Array<[string, number]>, source: string, name = title, empty?: string): Chart => {
  const entries = Array.isArray(m) ? m : top(m);
  return { key, title, kind: 'bar', unit, labels: entries.map((e) => e[0]), series: [{ name, values: entries.map((e) => e[1]) }], source, ...(entries.length ? {} : { empty: empty ?? 'No records in this period.' }) };
};
const donut = (key: string, title: string, m: Map<string, number>, source: string): Chart => {
  const entries = [...m.entries()].filter((e) => e[1] > 0);
  return { key, title, kind: 'donut', unit: 'count', labels: entries.map((e) => e[0]), series: [{ name: title, values: entries.map((e) => e[1]) }], source, ...(entries.length ? {} : { empty: 'No records in this period.' }) };
};

/**
 * One place for the multi-industry experience on the server: the workspace's effective industry, dashboards computed
 * only from that organization's records, the industry agent catalogue with real status / metrics, and a playground
 * that runs only in demo workspaces (synthetic customers, nothing sent).
 */
@Injectable()
export class IndustryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly quality: QualityService,
    @Optional() private readonly orchestrator?: Orchestrator,
    @Optional() private readonly ai?: AiService,
    @Optional() private readonly monitoring?: MonitoringService,
  ) {}

  async workspace(organizationId: string) {
    const [org, s] = await Promise.all([this.prisma.organization.findUnique({ where: { id: organizationId } }), this.settings.get(organizationId)]);
    if (!org) throw new NotFoundException('Organization not found');
    const industry = effectiveIndustry(org.vertical, s.industry);
    return {
      organizationId: org.id, name: org.name, vertical: org.vertical, isDemo: org.isDemo, industry, label: INDUSTRY_LABEL[industry],
      // A restaurant runs the ordering engine: its industry cannot be changed from Settings.
      canChangeIndustry: org.vertical !== 'restaurant', settableIndustries: org.vertical === 'restaurant' ? [] : SETTABLE_INDUSTRIES,
      integrations: this.integrations(),
    };
  }

  integrations() {
    const set = (...v: string[]) => v.every((x) => Boolean(x));
    return {
      whatsapp: set(config.whatsapp.accessToken, config.whatsapp.phoneNumberId),
      voice: set(config.plivo.authId, config.plivo.authToken, config.plivo.fromNumber),
      ai: Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL),
      dryRun: process.env.DRY_RUN !== 'false',
    };
  }

  // ================================================================== dashboards

  async dashboard(organizationId: string, daysParam?: number): Promise<Dashboard> {
    const days = Math.min(90, Math.max(7, Math.round(daysParam || 30)));
    const ws = await this.workspace(organizationId);
    const since = new Date(Date.now() - days * DAY);
    const base = { industry: ws.industry, label: ws.label, days, demo: ws.isDemo, generatedAt: new Date().toISOString() };
    const notes = ws.isDemo ? ['Demo workspace: every number below comes from synthetic sample records.'] : [];
    const built =
      ws.industry === 'restaurant' ? await this.restaurant(organizationId, days, since)
      : ws.industry === 'real_estate' ? await this.realEstate(organizationId, days, since)
      : ws.industry === 'manufacturing' ? await this.manufacturing(organizationId, days)
      : ws.industry === 'agency' ? await this.agency(organizationId, days, since)
      : ws.industry === 'food' ? await foodDashboard(this.prisma, organizationId, days, since)
      : ws.industry === 'hotel' ? await hotelDashboard(this.prisma, organizationId, days, since)
      : ws.industry === 'hospital' ? await hospitalDashboard(this.prisma, organizationId, days, since)
      : ws.industry === 'cctv' && this.monitoring ? cctvDashboard((await this.monitoring.overview(organizationId, { days })) as never)
      : await this.sales(organizationId, days, since, ws.industry === 'retail');
    return { ...base, kpis: built.kpis, charts: built.charts, notes: [...notes, ...built.notes] };
  }

  /** Textile and retail share the catalogue / order records; retail hides the quotation workflow. */
  private async sales(org: string, days: number, since: Date, retail: boolean) {
    const [orders, quotations, leads, balances, followUps, recipients] = await Promise.all([
      this.prisma.salesOrder.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { id: true, status: true, total: true, createdAt: true, customerId: true, items: { select: { productId: true, description: true, quantity: true, lineTotal: true } } } }),
      this.prisma.quotation.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { status: true, createdAt: true } }),
      this.prisma.lead.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { source: true, status: true, createdAt: true } }),
      this.prisma.inventoryBalance.findMany({ where: { organizationId: org }, select: { onHand: true, reserved: true, lowStockAt: true, product: { select: { name: true } } } }),
      this.prisma.followUp.findMany({ where: { organizationId: org, scheduledAt: { gte: since } }, select: { status: true, scheduledAt: true } }),
      this.prisma.campaignRecipient.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { status: true, sentAt: true, deliveredAt: true, repliedAt: true, campaign: { select: { simulated: true } } } }),
    ]);
    const live = orders.filter((o) => LIVE_SALES.includes(o.status));
    const productIds = [...new Set(live.flatMap((o) => o.items.map((i) => i.productId).filter((x): x is string => !!x)))];
    const products = new Map((await this.prisma.textileProduct.findMany({ where: { organizationId: org, id: { in: productIds } }, select: { id: true, name: true, fabricCategory: true } })).map((p) => [p.id, p]));
    const allLive = await this.prisma.salesOrder.groupBy({ by: ['customerId'], where: { organizationId: org, status: { in: LIVE_SALES } }, _count: { _all: true } });
    const repeat = allLive.filter((c) => c._count._all >= 2).length;
    const sent = recipients.filter((r) => r.sentAt).length;
    const delivered = recipients.filter((r) => r.deliveredAt).length;
    const replied = recipients.filter((r) => r.repliedAt).length;
    const simulated = recipients.filter((r) => r.status === 'simulated').length;
    const avail = (b: (typeof balances)[number]) => n(b.onHand) - n(b.reserved);
    const alerts = balances.filter((b) => avail(b) <= 0 || (b.lowStockAt !== null && avail(b) <= n(b.lowStockAt))).length;
    const due = await this.prisma.followUp.count({ where: { organizationId: org, status: 'scheduled', scheduledAt: { lte: new Date(Date.now() + DAY) } } });
    const fromQuotes = live.length; // orders in the period (conversion uses quotations created in the same period)
    const accepted = quotations.filter((q) => q.status === 'accepted').length;
    const kpis: Kpi[] = [
      { key: 'sales', label: 'Sales (confirmed orders)', value: r2(live.reduce((a, o) => a + n(o.total), 0)), format: 'inr', hint: 'Agreed order value, not cash received', tone: 'brand' },
      { key: 'orders', label: 'Sales orders', value: live.length, format: 'number', tone: 'sky' },
      ...(retail ? [] : [
        { key: 'pending_quotes', label: 'Pending quotations', value: quotations.filter((q) => ['draft', 'approved', 'sent'].includes(q.status)).length, format: 'number' as const, tone: 'amber' as const },
        { key: 'quote_conversion', label: 'Quotation conversion', value: quotations.length ? r1((accepted / quotations.length) * 100) : null, format: 'pct' as const, hint: 'Accepted ÷ quotations created in the period' },
      ]),
      { key: 'enquiries', label: 'Customer enquiries', value: leads.length, format: 'number', tone: 'violet' },
      { key: 'repeat', label: 'Repeat customers', value: repeat, format: 'number', hint: 'Customers with 2+ confirmed orders (all time)' },
      { key: 'inventory_alerts', label: 'Inventory alerts', value: alerts, format: 'number', tone: alerts ? 'rose' : 'slate', hint: 'Counted stock at or below its alert level' },
      { key: 'followups_due', label: 'Follow-ups due (24 h)', value: due, format: 'number' },
      { key: 'campaign_response', label: 'Campaign response', value: delivered ? r1((replied / delivered) * 100) : null, format: 'pct', hint: simulated ? `${simulated} simulated (DRY_RUN) messages excluded` : 'Replies ÷ delivered campaign messages' },
    ];
    const trend = series(days, live.map((o) => ({ at: o.createdAt, value: n(o.total) })));
    const statuses = tally(orders, (o) => o.status);
    const itemName = (i: { productId: string | null; description: string }) => (i.productId ? products.get(i.productId)?.name : null) ?? i.description;
    const topProducts = tally(live.flatMap((o) => o.items), itemName, (i) => n(i.lineTotal));
    const categories = tally(live.flatMap((o) => o.items), (i) => (i.productId ? products.get(i.productId)?.fabricCategory : null) ?? 'custom item', (i) => n(i.lineTotal));
    const funnelLabels = retail ? ['Enquiries', 'Confirmed orders'] : ['Enquiries', 'Quotations', 'Accepted', 'Confirmed orders'];
    const funnelValues = retail ? [leads.length, fromQuotes] : [leads.length, quotations.length, accepted, fromQuotes];
    const stock = balances.map((b) => [b.product.name, r2(avail(b))] as [string, number]).sort((a, b) => a[1] - b[1]).slice(0, 10);
    const charts: Chart[] = [
      { key: 'sales_trend', title: 'Sales by day', kind: 'line', unit: '₹', labels: trend.labels, series: [{ name: 'Confirmed order value', values: trend.values }], source: 'Sales orders (confirmed and later)', ...(live.length ? {} : { empty: 'No confirmed orders in this period.' }) },
      donut('orders_status', 'Orders by status', statuses, 'Sales orders created in the period'),
      bar('top_products', retail ? 'Top-selling products' : 'Top-selling products', '₹', topProducts, 'Order lines (confirmed orders)', 'Value'),
      bar('categories', 'Category performance', '₹', categories, 'Order lines × catalogue category', 'Value'),
      { key: 'funnel', title: retail ? 'Enquiry to order' : 'Enquiry → quotation → order', kind: 'funnel', unit: 'count', labels: funnelLabels, series: [{ name: 'Count', values: funnelValues }], source: 'Leads, quotations and orders created in the period' },
      bar('sources', 'Customer acquisition sources', 'leads', tally(leads, (l) => l.source), 'Leads created in the period', 'Leads'),
      bar('stock', 'Lowest stock (available units)', 'units', stock, 'Counted stock: on hand − reserved', 'Available', 'No products have counted stock yet.'),
      bar('campaigns', 'Campaign engagement', 'messages', [['Sent', sent], ['Delivered', delivered], ['Replied', replied], ['Simulated', simulated]], 'Campaign recipients in the period', 'Messages', sent + simulated ? undefined : 'No campaign messages in this period.'),
      bar('followups', 'Follow-up performance', 'follow-ups', tally(followUps, (f) => f.status), 'Follow-ups scheduled in the period', 'Follow-ups'),
    ];
    return { kpis, charts, notes: ['Sales are agreed order values; cash collected is under Finance (verified payments only).'] };
  }

  private async restaurant(org: string, days: number, since: Date) {
    const startToday = new Date(Math.floor((Date.now() + IST) / DAY) * DAY - IST);
    const [orders, items, calls, convs, claims] = await Promise.all([
      this.prisma.order.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { id: true, status: true, total: true, createdAt: true, customerId: true, feedbackRating: true, complaintStatus: true } }),
      this.prisma.orderItem.findMany({ where: { order: { organizationId: org, createdAt: { gte: since }, status: { not: 'cancelled' } } }, select: { name: true, quantity: true, lineTotal: true, menuItem: { select: { category: { select: { name: true } } } } } }),
      this.prisma.call.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { outcome: true, status: true } }),
      this.prisma.conversation.findMany({ where: { organizationId: org, channel: 'whatsapp', createdAt: { gte: since } }, select: { status: true } }),
      this.prisma.offerClaim.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { status: true } }),
    ]);
    const valid = orders.filter((o) => o.status !== 'cancelled');
    const today = valid.filter((o) => o.createdAt >= startToday);
    const perCustomer = tally(valid, (o) => o.customerId);
    const customers = perCustomer.size;
    const repeaters = [...perCustomer.values()].filter((c) => c >= 2).length;
    // Restaurant feedback is stored on the order (rating 1-5, complaint status) by the feedback flow.
    const rated = orders.filter((o) => o.feedbackRating !== null);
    const hours = new Array(24).fill(0);
    for (const o of valid) hours[new Date(o.createdAt.getTime() + IST).getUTCHours()]++;
    const kpis: Kpi[] = [
      { key: 'today_revenue', label: "Today's revenue", value: r2(today.reduce((a, o) => a + n(o.total), 0)), format: 'inr', hint: 'Orders placed today (IST), not cancelled', tone: 'brand' },
      { key: 'orders', label: 'Total orders', value: valid.length, format: 'number', tone: 'sky' },
      { key: 'aov', label: 'Average order value', value: valid.length ? r2(valid.reduce((a, o) => a + n(o.total), 0) / valid.length) : null, format: 'inr' },
      { key: 'in_progress', label: 'Pending & in progress', value: orders.filter((o) => ['pending', 'confirmed', 'preparing', 'ready'].includes(o.status)).length, format: 'number', tone: 'amber' },
      { key: 'completed', label: 'Completed', value: orders.filter((o) => o.status === 'completed').length, format: 'number' },
      { key: 'cancelled', label: 'Cancelled', value: orders.filter((o) => o.status === 'cancelled').length, format: 'number', tone: 'rose' },
      { key: 'repeat_rate', label: 'Repeat customer rate', value: customers ? r1((repeaters / customers) * 100) : null, format: 'pct', hint: 'Customers with 2+ orders in the period' },
      { key: 'feedback', label: 'Feedback score', value: rated.length ? r1(rated.reduce((a, o) => a + n(o.feedbackRating), 0) / rated.length) : null, format: 'number', hint: `Average of ${rated.length} rating(s), 1–5` },
      { key: 'complaints', label: 'Complaints to handle', value: orders.filter((o) => o.complaintStatus === 'open').length, format: 'number', tone: 'rose' },
    ];
    const vol = series(days, valid.map((o) => ({ at: o.createdAt })));
    const rev = series(days, valid.map((o) => ({ at: o.createdAt, value: n(o.total) })));
    const charts: Chart[] = [
      { key: 'volume', title: 'Orders per day', kind: 'line', unit: 'orders', labels: vol.labels, series: [{ name: 'Orders', values: vol.values }], source: 'Orders (not cancelled)', ...(valid.length ? {} : { empty: 'No orders in this period.' }) },
      { key: 'revenue', title: 'Revenue per day', kind: 'line', unit: '₹', labels: rev.labels, series: [{ name: 'Revenue', values: rev.values }], source: 'Order totals (not cancelled)', ...(valid.length ? {} : { empty: 'No orders in this period.' }) },
      donut('status', 'Orders by status', tally(orders, (o) => o.status), 'Orders in the period'),
      bar('popular', 'Popular menu items', 'qty', tally(items, (i) => i.name, (i) => n(i.quantity)), 'Order lines (quantity)', 'Quantity'),
      bar('categories', 'Category-wise sales', '₹', tally(items, (i) => i.menuItem?.category?.name, (i) => n(i.lineTotal)), 'Order lines × menu category', 'Sales'),
      { key: 'peak', title: 'Peak ordering hours (IST)', kind: 'bar', unit: 'orders', labels: hours.map((_, h) => `${h}:00`), series: [{ name: 'Orders', values: hours }], source: 'Order time (IST)', ...(valid.length ? {} : { empty: 'No orders in this period.' }) },
      bar('offers', 'Offer claims', 'claims', tally(claims, (c) => c.status), 'Offer claims in the period', 'Claims'),
      bar('whatsapp', 'WhatsApp conversations', 'conversations', tally(convs, (c) => c.status), 'Conversations started in the period', 'Conversations'),
      bar('voice', 'Voice agent outcomes', 'calls', tally(calls, (c) => c.outcome ?? c.status), 'Calls in the period', 'Calls'),
    ];
    return { kpis, charts, notes: ['Revenue is order value recorded by the ordering system (pickup, paid at the shop).'] };
  }

  private async realEstate(org: string, days: number, since: Date) {
    const [leads, visits, convs, followUps, calls] = await Promise.all([
      this.prisma.lead.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { status: true, source: true, location: true, budget: true, createdAt: true } }),
      this.prisma.siteVisit.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { status: true } }),
      this.prisma.conversation.count({ where: { organizationId: org, createdAt: { gte: since } } }),
      this.prisma.followUp.findMany({ where: { organizationId: org, scheduledAt: { gte: since } }, select: { status: true } }),
      this.prisma.call.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { outcome: true, status: true } }),
    ]);
    const qualified = leads.filter((l) => !QUALIFIED_EXCLUDED.includes(l.status));
    const completed = visits.filter((v) => v.status === 'completed').length;
    const budgets = new Map<string, number>([['< 50L', 0], ['50L–1Cr', 0], ['1–2Cr', 0], ['> 2Cr', 0], ['Not stated', 0]]);
    for (const l of leads) {
      const b = n(l.budget);
      const k = !b ? 'Not stated' : b < 5e6 ? '< 50L' : b < 1e7 ? '50L–1Cr' : b < 2e7 ? '1–2Cr' : '> 2Cr';
      budgets.set(k, (budgets.get(k) ?? 0) + 1);
    }
    const kpis: Kpi[] = [
      { key: 'leads', label: 'Total leads', value: leads.length, format: 'number', tone: 'brand' },
      { key: 'qualified', label: 'Qualified leads', value: qualified.length, format: 'number', tone: 'sky' },
      { key: 'enquiries', label: 'Property enquiries (conversations)', value: convs, format: 'number', tone: 'violet' },
      { key: 'visits', label: 'Site visits scheduled', value: visits.length, format: 'number', tone: 'amber' },
      { key: 'visit_completion', label: 'Site visit completion', value: visits.length ? r1((completed / visits.length) * 100) : null, format: 'pct' },
      { key: 'conversion', label: 'Lead → visit', value: leads.length ? r1((visits.length / leads.length) * 100) : null, format: 'pct' },
    ];
    const trend = series(days, leads.map((l) => ({ at: l.createdAt })));
    const charts: Chart[] = [
      { key: 'leads_trend', title: 'Leads per day', kind: 'line', unit: 'leads', labels: trend.labels, series: [{ name: 'Leads', values: trend.values }], source: 'Leads created', ...(leads.length ? {} : { empty: 'No leads in this period.' }) },
      { key: 'funnel', title: 'Lead conversion funnel', kind: 'funnel', unit: 'count', labels: ['Leads', 'Qualified', 'Visits scheduled', 'Visits completed'], series: [{ name: 'Count', values: [leads.length, qualified.length, visits.length, completed] }], source: 'Leads and site visits in the period' },
      bar('sources', 'Lead sources', 'leads', tally(leads, (l) => l.source), 'Leads created', 'Leads'),
      bar('locations', 'Demand by location', 'leads', tally(leads, (l) => l.location), 'Location stated by the lead', 'Leads'),
      bar('budget', 'Budget distribution', 'leads', [...budgets.entries()], 'Budget stated by the lead', 'Leads'),
      bar('followups', 'Follow-up performance', 'follow-ups', tally(followUps, (f) => f.status), 'Follow-ups in the period', 'Follow-ups'),
      bar('pipeline', 'Sales pipeline', 'leads', tally(leads, (l) => l.status), 'Lead status now', 'Leads'),
      bar('calls', 'Voice call outcomes', 'calls', tally(calls, (c) => c.outcome ?? c.status), 'AI calls in the period', 'Calls'),
    ];
    return { kpis, charts, notes: [] as string[] };
  }

  private async manufacturing(org: string, days: number) {
    const s = await this.quality.stats(org, days);
    const daily = dayBuckets(days);
    const insp = new Array(days).fill(0), rej = new Array(days).fill(0);
    for (const r of s.rows) {
      const i = daily.index(new Date(r.inspectedAt));
      if (i >= 0) { insp[i] += r.inspectedQty; rej[i] += r.rejectedQty; }
    }
    const rate = insp.map((v, i) => (v ? r1((rej[i] / v) * 100) : 0));
    const kpis: Kpi[] = [
      { key: 'inspections', label: 'Inspections', value: s.inspections, format: 'number', tone: 'brand' },
      { key: 'units', label: 'Units inspected', value: s.unitsInspected, format: 'number', tone: 'sky' },
      { key: 'defect_rate', label: 'Defect rate', value: s.defectRate, format: 'pct', hint: 'Defects ÷ units inspected', tone: 'amber' },
      { key: 'rejection_rate', label: 'Rejection rate', value: s.rejectionRate, format: 'pct', hint: 'Rejected ÷ units inspected', tone: 'rose' },
      { key: 'open', label: 'Open quality issues', value: s.open, format: 'number' },
      { key: 'resolution', label: 'Avg. resolution time', value: s.avgResolutionHours, format: 'hours', hint: 'Inspection → resolution, issues only' },
    ];
    const charts: Chart[] = [
      { key: 'rejection_trend', title: 'Rejection rate by day', kind: 'line', unit: '%', labels: daily.labels, series: [{ name: 'Rejection %', values: rate }], source: 'Recorded inspections', ...(s.inspections ? {} : { empty: 'No inspections recorded in this period.' }) },
      bar('defects', 'Defects by category', 'defects', s.byCategory.map((c) => [c.category, c.count] as [string, number]).slice(0, 8), 'Defect counts on inspections', 'Defects'),
      bar('lines', 'Rejection rate by line', '%', s.byLine.map((l) => [l.line, l.rejectionRate] as [string, number]), 'Rejected ÷ inspected per line', 'Rejection %'),
      donut('status', 'Inspections by status', tally(s.rows, (r) => r.status), 'Recorded inspections'),
      bar('products', 'Rejected units by product', 'units', tally(s.rows, (r) => r.productName, (r) => r.rejectedQty), 'Recorded inspections', 'Rejected'),
    ];
    return { kpis, charts, notes: ['Quality data is entered by people. No camera, sensor or computer-vision model is connected.'] };
  }

  private async agency(org: string, days: number, since: Date) {
    const [leads, recipients, followUps, campaigns] = await Promise.all([
      this.prisma.lead.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { status: true, source: true, campaign: true, createdAt: true } }),
      this.prisma.campaignRecipient.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { status: true, sentAt: true, deliveredAt: true, repliedAt: true, leadId: true } }),
      this.prisma.followUp.findMany({ where: { organizationId: org, scheduledAt: { gte: since } }, select: { status: true } }),
      this.prisma.marketingCampaign.count({ where: { organizationId: org, startedAt: { gte: since }, simulated: false } }),
    ]);
    const won = leads.filter((l) => l.status === 'won' || l.status === 'order_confirmed').length;
    const done = followUps.filter((f) => f.status === 'completed').length;
    const delivered = recipients.filter((r) => r.deliveredAt).length;
    const replied = recipients.filter((r) => r.repliedAt).length;
    const kpis: Kpi[] = [
      { key: 'leads', label: 'Leads processed', value: leads.length, format: 'number', tone: 'brand' },
      { key: 'campaigns', label: 'Campaigns sent (live)', value: campaigns, format: 'number', tone: 'sky', hint: 'Simulated (DRY_RUN) campaigns excluded' },
      { key: 'responses', label: 'Campaign responses', value: replied, format: 'number', tone: 'violet' },
      { key: 'response_rate', label: 'Response rate', value: delivered ? r1((replied / delivered) * 100) : null, format: 'pct' },
      { key: 'followup_completion', label: 'Follow-up completion', value: followUps.length ? r1((done / followUps.length) * 100) : null, format: 'pct' },
      { key: 'conversion', label: 'Lead conversion', value: leads.length ? r1((won / leads.length) * 100) : null, format: 'pct', hint: 'Leads marked won ÷ leads' },
    ];
    const trend = series(days, leads.map((l) => ({ at: l.createdAt })));
    const charts: Chart[] = [
      { key: 'leads_trend', title: 'Leads per day', kind: 'line', unit: 'leads', labels: trend.labels, series: [{ name: 'Leads', values: trend.values }], source: 'Leads created', ...(leads.length ? {} : { empty: 'No leads in this period.' }) },
      bar('sources', 'Leads by source', 'leads', tally(leads, (l) => l.source), 'Leads created', 'Leads'),
      bar('campaign_leads', 'Leads by campaign', 'leads', tally(leads.filter((l) => l.campaign), (l) => l.campaign), 'Campaign stored on the lead', 'Leads'),
      bar('pipeline', 'Lead pipeline', 'leads', tally(leads, (l) => l.status), 'Lead status now', 'Leads'),
      bar('engagement', 'Campaign engagement', 'messages', [['Sent', recipients.filter((r) => r.sentAt).length], ['Delivered', delivered], ['Replied', replied]], 'Campaign recipients', 'Messages'),
      bar('followups', 'Follow-up status', 'follow-ups', tally(followUps, (f) => f.status), 'Follow-ups in the period', 'Follow-ups'),
    ];
    return { kpis, charts, notes: ['Ad spend and ROI are shown only when Meta / Google ad reporting is connected (it is not).'] };
  }

  // ================================================================== agent catalogue

  async catalogue(organizationId: string) {
    const ws = await this.workspace(organizationId);
    const s = await this.settings.get(organizationId);
    const since = new Date(Date.now() - 30 * DAY);
    const agents = catalogueFor(ws.industry);
    const kinds = agents.flatMap((a) => (a.runtime.type === 'task' ? [a.runtime.kind] : []));
    const [taskStats, convCount, handoffs, followUpStats, orderFollowUps] = await Promise.all([
      kinds.length ? this.prisma.agentTask.groupBy({ by: ['kind', 'status'], where: { organizationId, kind: { in: kinds }, createdAt: { gte: since } }, _count: { _all: true }, _max: { createdAt: true } }) : [],
      this.prisma.conversation.count({ where: { organizationId, createdAt: { gte: since } } }),
      this.prisma.conversation.count({ where: { organizationId, status: 'human_handoff', updatedAt: { gte: since } } }),
      this.prisma.followUp.groupBy({ by: ['source', 'status'], where: { organizationId, scheduledAt: { gte: since } }, _count: { _all: true } }),
      ws.industry === 'restaurant' ? this.prisma.orderFollowUp.groupBy({ by: ['status'], where: { organizationId, createdAt: { gte: since } }, _count: { _all: true } }) : [],
    ]);
    const lastConv = await this.prisma.conversation.findFirst({ where: { organizationId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } });
    const known = new Set(this.orchestrator?.listKinds().map((k) => k.kind) ?? []);
    return {
      industry: ws.industry, label: ws.label, demo: ws.isDemo, integrations: ws.integrations,
      agents: agents.map((a) => {
        const st = this.agentStatus(a, ws, s.agents?.paused ?? [], known);
        let metrics: Array<{ label: string; value: number }> = [];
        let lastActivity: string | null = null;
        if (a.runtime.type === 'conversation') {
          metrics = [{ label: 'Conversations (30 d, whole assistant)', value: convCount }, { label: 'Human handoffs (30 d)', value: handoffs }];
          lastActivity = lastConv?.updatedAt.toISOString() ?? null;
        } else if (a.runtime.type === 'task') {
          const kind = a.runtime.kind;
          const rows = taskStats.filter((t) => t.kind === kind);
          metrics = [{ label: 'Runs completed (30 d)', value: rows.filter((r) => r.status === 'COMPLETED').reduce((x, r) => x + r._count._all, 0) }, { label: 'Failed (30 d)', value: rows.filter((r) => r.status === 'FAILED').reduce((x, r) => x + r._count._all, 0) }];
          const last = rows.map((r) => r._max.createdAt).filter(Boolean).sort().at(-1);
          lastActivity = last ? new Date(last).toISOString() : null;
        } else if (a.runtime.type === 'workflow') {
          const src = a.runtime.source;
          if (src === 'order_followup') metrics = orderFollowUps.map((r) => ({ label: `Order follow-ups ${r.status} (30 d)`, value: r._count._all }));
          else {
            const rows = followUpStats.filter((r) => r.source === src);
            if (rows.length) metrics = rows.map((r) => ({ label: `${r.status} (30 d)`, value: r._count._all }));
          }
        }
        return { ...a, status: st.status, statusNote: st.note, metrics, lastActivity, playground: this.playgroundMode(a) };
      }),
    };
  }

  private agentStatus(a: CatalogueAgent, ws: Awaited<ReturnType<IndustryService['workspace']>>, paused: string[], known: Set<string>): { status: 'active' | 'demo' | 'paused' | 'needs_setup' | 'unavailable'; note: string } {
    const rt = a.runtime;
    if (rt.type === 'unavailable') return { status: 'unavailable', note: rt.reason };
    if (rt.type === 'task') {
      if (!known.has(rt.kind)) return { status: 'unavailable', note: 'This task is not available in this deployment.' };
      if (paused.includes(rt.agent)) return { status: 'paused', note: `The ${rt.agent} agent is paused in the Agent Centre.` };
      return ws.isDemo ? { status: 'demo', note: 'Demo workspace: runs on sample records.' } : { status: 'active', note: 'Runs on demand and on business events (Agent Centre).' };
    }
    if (rt.type === 'conversation') {
      if (ws.isDemo) return { status: 'demo', note: 'Demo workspace: test it in the playground; nothing is sent.' };
      const needVoice = a.channels.length === 1 && a.channels[0] === 'voice';
      const ok = needVoice ? ws.integrations.voice : ws.integrations.whatsapp || ws.integrations.voice;
      if (!ok) return { status: 'needs_setup', note: needVoice ? 'Voice (Plivo) is not configured.' : 'WhatsApp is not configured.' };
      return { status: 'active', note: ws.integrations.dryRun ? 'Configured. DRY_RUN is on: replies are not sent to customers.' : 'Live.' };
    }
    return ws.isDemo ? { status: 'demo', note: 'Demo workspace: sample records.' } : { status: 'active', note: rt.type === 'workflow' ? rt.note : 'Reporting view from your records.' };
  }

  private playgroundMode(a: CatalogueAgent): 'conversation' | 'task' | 'none' {
    if (a.runtime.type === 'conversation') return 'conversation';
    if (a.runtime.type === 'task' && PLAYGROUND_INPUT[a.runtime.kind] !== undefined) return 'task';
    return 'none';
  }

  // ================================================================== playground (demo workspaces only)

  /**
   * Test an agent safely. Runs ONLY in a demo workspace: conversation agents use the real engine with a synthetic,
   * demo-flagged customer through the dashboard test channel (no WhatsApp / call is placed); task agents run their real
   * task kind on the demo records. A live workspace is refused (use its own Test chat page instead).
   */
  async playground(organizationId: string, userId: string, input: { agentId?: string; message?: string; session?: string }) {
    const ws = await this.workspace(organizationId);
    if (!ws.isDemo) throw new ForbiddenException('The playground runs only in a demo workspace, so it can never message real customers or change live records. Switch to a demo workspace.');
    const agent = catalogueFor(ws.industry).find((a) => a.id === input.agentId);
    if (!agent) throw new NotFoundException('This agent is not part of this workspace\'s industry');
    const started = Date.now();
    if (agent.runtime.type === 'conversation') {
      const message = String(input.message ?? '').trim().slice(0, 1000);
      if (!message) throw new BadRequestException('Type a customer message');
      if (!this.ai) throw new BadRequestException('Conversation engine not available');
      // A stable synthetic number per user + agent + session: the conversation continues until "new chat".
      const digest = createHash('sha256').update(`${organizationId}|${userId}|${agent.id}|${input.session ?? ''}`).digest('hex');
      const phone = `91999${parseInt(digest.slice(0, 10), 16).toString().padStart(7, '0').slice(0, 7)}`;
      await this.prisma.customer.upsert({ where: { organizationId_phone: { organizationId, phone } }, create: { organizationId, phone, name: 'Playground tester', isDemo: true, source: 'playground' }, update: {} });
      try {
        const r = await this.ai.generateResponse({ organizationId, channel: 'web', phone, message, customerName: 'Playground tester', metadata: { playground: true, agentId: agent.id } });
        const escalated = Boolean(r.actions?.handoff) || r.actions?.outcome === 'human_requested';
        return {
          mode: 'conversation', agentId: agent.id, reply: r.response, path: r.path ?? 'rules', state: r.state ?? null, intent: r.intent ?? null, escalated,
          actions: r.actions, dataSources: agent.tools, latencyMs: Date.now() - started, sent: false,
          note: 'Demo playground: dashboard test channel, synthetic customer; nothing was sent to WhatsApp or a phone.',
        };
      } catch (e) {
        log.warn('industry.playground_failed', { organizationId, agentId: agent.id, error: errorMessage(e) });
        return { mode: 'conversation', agentId: agent.id, error: errorMessage(e).slice(0, 300), latencyMs: Date.now() - started, sent: false };
      }
    }
    if (agent.runtime.type === 'task') {
      const kind = agent.runtime.kind;
      if (PLAYGROUND_INPUT[kind] === undefined || !this.orchestrator) throw new BadRequestException('This agent runs from its own page (it needs a specific record).');
      const inputFor = await PLAYGROUND_INPUT[kind](this.prisma, organizationId);
      if (!inputFor) throw new BadRequestException('There is no record for this agent to work on yet in this workspace.');
      const { task } = await this.orchestrator.submit(organizationId, { kind, input: inputFor, trigger: 'user', idempotencyKey: `playground:${randomUUID()}`, requestedBy: `user:${userId}` }, { runNow: true });
      const detail = await this.orchestrator.getTask(organizationId, task.id);
      return {
        mode: 'task', agentId: agent.id, kind, status: detail.status, result: detail.result, error: detail.error,
        toolCalls: detail.events.filter((e) => e.type === 'tool' || e.type === 'tool_denied').map((e) => ({ tool: (e.data as { tool?: string } | null)?.tool ?? e.message, note: e.message })),
        events: detail.events.map((e) => ({ type: e.type, message: e.message })), latencyMs: Date.now() - started, sent: false,
      };
    }
    throw new BadRequestException('This agent has no runnable test (it is a workflow, a dashboard or not built).');
  }

  /** Record counts per entity for this workspace and the API that returns each (Demo data page, API sweep). */
  async data(organizationId: string) {
    const ws = await this.workspace(organizationId);
    return { ...(await dataInventory(this.prisma, organizationId, ws.industry)), name: ws.name, isDemo: ws.isDemo, label: ws.label };
  }

  /** For tests / admin views. */
  allAgents() {
    return AGENT_CATALOGUE;
  }
}

/** Safe default inputs for task agents in the playground (null = nothing to run on). */
const PLAYGROUND_INPUT: Record<string, (prisma: PrismaService, org: string) => Promise<Record<string, unknown> | null>> = {
  'operations.low_stock_scan': async () => ({}),
  'operations.quality_summary': async () => ({ days: 30 }),
  'operations.quality_alert_scan': async () => ({ days: 30, thresholdPct: 5 }),
  'marketing.campaign_brief': async () => ({ occasion: 'new_arrivals' }),
  'marketing.content_plan': async () => ({ days: 4, channels: ['instagram'] }),
  'marketing.campaign_report': async (prisma, org) => {
    const c = await prisma.marketingCampaign.findFirst({ where: { organizationId: org }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return c ? { campaignId: c.id } : null;
  },
};
