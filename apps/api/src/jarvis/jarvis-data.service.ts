import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { errorMessage, log } from '../common/logger.js';
import { istDayStart, type JarvisConfig } from './jarvis-config.js';

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v)) || 0;
const round = (v: number, d = 0) => Math.round(v * 10 ** d) / 10 ** d;

export type Period = { orders: number; revenue: number; cancelled: number; byChannel: Record<string, number>; calls: number; callMinutes: number; failedCalls: number; newCustomers: number };
export type Snapshot = {
  at: string;
  today: Period;
  yesterday: Period;
  last7: Period;
  /** Orders placed today up to now, and on the same weekday last week up to the same time. */
  sameTimeLastWeek: number;
  topItems: Array<{ name: string; qty: number; unit: string; revenue: number }>;
  topCustomers: Array<{ name: string; phone: string; orders: number; spend: number }>;
  stock: { tracked: number; low: Array<{ name: string; qty: number; unit: string; level: 'low' | 'out' }> };
  pendingOrders: Array<{ orderNumber: string; minutes: number; total: number }>;
  unpaidToday: { count: number; amount: number };
  handoffs: Array<{ minutes: number; channel: string; reason: string | null }>;
  instagramWaiting: Array<{ minutes: number; channel: string }>;
  failedCallsLastHour: number;
  overdue: { count: number; amount: number };
  feedback: { rated: number; average: number | null; complaintsOpen: number };
  /** The last 7 India-time days, oldest first (orders not cancelled): for the owner's sales chart. */
  days: Array<{ date: string; orders: number; revenue: number }>;
};

/**
 * Read-only numbers for Jarvis from this organization's own records (orders, calls, conversations, stock, invoices).
 * Every section is independent: a table an industry does not use just reads as zero, and one failing query never
 * blanks the rest.
 */
@Injectable()
export class JarvisDataService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly liveCache = new Map<string, { at: number; live: boolean }>();

  /**
   * Filters that keep demo / seed records (customers, orders and stock marked isDemo) out of a live workspace's
   * numbers, so Jarvis reports only real business. A demo workspace keeps them (they are all it has).
   */
  async realOnly(organizationId: string) {
    const hit = this.liveCache.get(organizationId);
    let live = hit && Date.now() - hit.at < 60_000 ? hit.live : undefined;
    if (live === undefined) {
      const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { isDemo: true } }).catch(() => null);
      live = !org?.isDemo;
      this.liveCache.set(organizationId, { at: Date.now(), live });
    }
    if (!live) return { order: {}, customer: {}, call: {}, conv: {}, menu: {} };
    return {
      order: { isDemo: false },
      customer: { isDemo: false },
      call: { customer: { isDemo: false } },
      conv: { OR: [{ customerId: null }, { Customer: { isDemo: false } }] },
      menu: { isDemo: false, stockIsDemo: false },
    };
  }

  private async safe<T>(what: string, organizationId: string, f: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await f();
    } catch (e) {
      log.warn('jarvis.data_failed', { organizationId, what, error: errorMessage(e) });
      return fallback;
    }
  }

  async period(organizationId: string, from: Date, to: Date): Promise<Period> {
    const where = { organizationId, createdAt: { gte: from, lt: to } };
    const R = await this.realOnly(organizationId);
    const [orders, cancelled, byChannel, calls, failedCalls, newCustomers] = await Promise.all([
      this.safe('orders', organizationId, () => this.prisma.order.aggregate({ where: { ...where, ...R.order, status: { not: 'cancelled' } }, _count: true, _sum: { total: true } }), { _count: 0, _sum: { total: null } } as never),
      this.safe('cancelled', organizationId, () => this.prisma.order.count({ where: { ...where, ...R.order, status: 'cancelled' } }), 0),
      this.safe('channels', organizationId, () => this.prisma.order.groupBy({ by: ['channel'], where: { ...where, ...R.order, status: { not: 'cancelled' } }, _count: true }), [] as never),
      this.safe('calls', organizationId, () => this.prisma.call.aggregate({ where: { ...where, ...R.call }, _count: true, _sum: { durationSec: true } }), { _count: 0, _sum: { durationSec: null } } as never),
      this.safe('failedCalls', organizationId, () => this.prisma.call.count({ where: { ...where, ...R.call, status: { in: ['failed', 'no_answer', 'busy'] } } }), 0),
      this.safe('customers', organizationId, () => this.prisma.customer.count({ where: { ...where, ...R.customer } }), 0),
    ]);
    const o = orders as { _count: number; _sum: { total: unknown } };
    const c = calls as { _count: number; _sum: { durationSec: number | null } };
    return {
      orders: o._count,
      revenue: round(n(o._sum.total)),
      cancelled,
      byChannel: Object.fromEntries((byChannel as Array<{ channel: string; _count: number }>).map((r) => [r.channel, r._count])),
      calls: c._count,
      callMinutes: round(n(c._sum.durationSec) / 60, 1),
      failedCalls,
      newCustomers,
    };
  }

  async snapshot(organizationId: string, cfg: JarvisConfig, now = new Date()): Promise<Snapshot> {
    const R = await this.realOnly(organizationId);
    const today = istDayStart(now);
    const yesterday = istDayStart(now, 1);
    const week = istDayStart(now, 7);
    const month = istDayStart(now, 30);
    const weekAgoNow = new Date(now.getTime() - 7 * 86_400_000);
    const pendingMin = cfg.monitors.pending_orders.threshold;

    const [pToday, pYesterday, p7, sameTimeLastWeek, items, customers, stockRows, pending, unpaid, handoffs, insta, failedHour, overdueRows, rated, complaints] = await Promise.all([
      this.period(organizationId, today, now),
      this.period(organizationId, yesterday, today),
      this.period(organizationId, week, now),
      this.safe('lastWeek', organizationId, () => this.prisma.order.count({ where: { organizationId, ...R.order, status: { not: 'cancelled' }, createdAt: { gte: istDayStart(weekAgoNow), lt: weekAgoNow } } }), 0),
      this.safe('topItems', organizationId, () => this.prisma.orderItem.groupBy({ by: ['name', 'unit'], where: { order: { organizationId, ...R.order, status: { not: 'cancelled' }, createdAt: { gte: week } } }, _sum: { quantity: true, lineTotal: true }, orderBy: { _sum: { lineTotal: 'desc' } }, take: 5 }), [] as never),
      this.safe('topCustomers', organizationId, () => this.prisma.order.groupBy({ by: ['customerId'], where: { organizationId, ...R.order, status: { not: 'cancelled' }, createdAt: { gte: month } }, _sum: { total: true }, _count: true, orderBy: { _sum: { total: 'desc' } }, take: 5 }), [] as never),
      this.safe('stock', organizationId, () => this.prisma.menuItem.findMany({ where: { organizationId, ...R.menu, stockQty: { not: null } }, select: { name: true, unit: true, stockQty: true, lowStockThreshold: true, available: true } }), []),
      this.safe('pending', organizationId, () => this.prisma.order.findMany({ where: { organizationId, ...R.order, status: 'pending', createdAt: { lt: new Date(now.getTime() - pendingMin * 60_000), gte: yesterday } }, select: { orderNumber: true, createdAt: true, total: true }, orderBy: { createdAt: 'asc' }, take: 10 }), []),
      this.safe('unpaid', organizationId, () => this.prisma.order.aggregate({ where: { organizationId, ...R.order, createdAt: { gte: today }, status: { not: 'cancelled' }, paymentStatus: { not: 'paid' } }, _count: true, _sum: { total: true } }), { _count: 0, _sum: { total: null } } as never),
      this.safe('handoffs', organizationId, () => this.prisma.conversation.findMany({ where: { organizationId, ...R.conv, status: 'human_handoff', inboxStatus: 'open', handoffAt: { not: null } }, select: { handoffAt: true, channel: true, handoffReason: true }, orderBy: { handoffAt: 'asc' }, take: 20 }), []),
      this.safe('instagram', organizationId, () => this.prisma.conversation.findMany({ where: { organizationId, ...R.conv, channel: { in: ['instagram', 'instagram_comment'] }, inboxStatus: 'open', lastCustomerAt: { not: null, gte: week } }, select: { lastCustomerAt: true, channel: true, id: true }, orderBy: { lastCustomerAt: 'asc' }, take: 50 }), []),
      this.safe('failedHour', organizationId, () => this.prisma.call.count({ where: { organizationId, ...R.call, createdAt: { gte: new Date(now.getTime() - 3_600_000) }, status: { in: ['failed', 'no_answer', 'busy'] } } }), 0),
      this.safe('overdue', organizationId, () => this.prisma.invoice.findMany({ where: { organizationId, status: { in: ['issued', 'partially_paid'] }, dueDate: { lt: now } }, select: { total: true, amountPaid: true } }), []),
      this.safe('feedback', organizationId, () => this.prisma.order.aggregate({ where: { organizationId, ...R.order, feedbackAt: { gte: week }, feedbackRating: { not: null } }, _count: { feedbackRating: true }, _avg: { feedbackRating: true } }), { _count: { feedbackRating: 0 }, _avg: { feedbackRating: null } } as never),
      this.safe('complaints', organizationId, () => this.prisma.order.count({ where: { organizationId, ...R.order, complaintStatus: 'open' } }), 0),
    ]);

    // Instagram: a conversation is waiting when the customer wrote last (no team / AI message after it).
    const instaWaiting: Snapshot['instagramWaiting'] = [];
    for (const c of insta as Array<{ id: string; lastCustomerAt: Date | null; channel: string }>) {
      const lastReply = await this.safe('instaReply', organizationId, () => this.prisma.message.findFirst({ where: { conversationId: c.id, role: { not: 'user' }, createdAt: { gte: c.lastCustomerAt! } }, select: { id: true } }), { id: 'unknown' });
      if (!lastReply) instaWaiting.push({ channel: c.channel, minutes: Math.round((now.getTime() - c.lastCustomerAt!.getTime()) / 60_000) });
    }

    const custIds = (customers as Array<{ customerId: string }>).map((c) => c.customerId);
    const names = custIds.length ? await this.safe('names', organizationId, () => this.prisma.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, name: true, phone: true } }), []) : [];
    const nameOf = new Map(names.map((c) => [c.id, c]));
    const mask = (p: string | null | undefined) => (p && p.length > 4 ? `••••${p.slice(-4)}` : '');
    const overdue = overdueRows as Array<{ total: unknown; amountPaid: unknown }>;
    const u = unpaid as { _count: number; _sum: { total: unknown } };
    const r = rated as { _count: { feedbackRating: number }; _avg: { feedbackRating: number | null } };

    // Sales per India-time day for the last 7 days (one query, bucketed here).
    const dayRows = await this.safe('days', organizationId, () => this.prisma.order.findMany({ where: { organizationId, ...R.order, status: { not: 'cancelled' }, createdAt: { gte: istDayStart(now, 6) } }, select: { createdAt: true, total: true } }), []);
    const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const days = Array.from({ length: 7 }, (_, i) => ({ date: ist(istDayStart(now, 6 - i)), orders: 0, revenue: 0 }));
    for (const o of dayRows) { const d = days.find((x) => x.date === ist(o.createdAt)); if (d) { d.orders += 1; d.revenue += n(o.total); } }
    return {
      at: now.toISOString(),
      days: days.map((d) => ({ ...d, revenue: round(d.revenue) })),
      today: pToday,
      yesterday: pYesterday,
      last7: p7,
      sameTimeLastWeek,
      topItems: (items as Array<{ name: string; unit: string; _sum: { quantity: unknown; lineTotal: unknown } }>).map((i) => ({ name: i.name, unit: i.unit, qty: round(n(i._sum.quantity), 2), revenue: round(n(i._sum.lineTotal)) })),
      topCustomers: (customers as Array<{ customerId: string; _sum: { total: unknown }; _count: number }>).map((c) => ({ name: nameOf.get(c.customerId)?.name ?? 'Customer', phone: mask(nameOf.get(c.customerId)?.phone), orders: c._count, spend: round(n(c._sum.total)) })),
      stock: {
        tracked: stockRows.length,
        low: stockRows
          .filter((s) => !s.available || n(s.stockQty) <= 0 || (s.lowStockThreshold !== null && n(s.stockQty) <= n(s.lowStockThreshold)))
          .map((s) => ({ name: s.name, unit: s.unit, qty: round(n(s.stockQty), 2), level: (!s.available || n(s.stockQty) <= 0 ? 'out' : 'low') as 'low' | 'out' })),
      },
      pendingOrders: pending.map((p) => ({ orderNumber: p.orderNumber, total: round(n(p.total)), minutes: Math.round((now.getTime() - p.createdAt.getTime()) / 60_000) })),
      unpaidToday: { count: u._count, amount: round(n(u._sum.total)) },
      handoffs: handoffs.map((h) => ({ channel: h.channel, reason: h.handoffReason, minutes: Math.round((now.getTime() - h.handoffAt!.getTime()) / 60_000) })),
      instagramWaiting: instaWaiting,
      failedCallsLastHour: failedHour,
      overdue: { count: overdue.length, amount: round(overdue.reduce((a, o) => a + n(o.total) - n(o.amountPaid), 0)) },
      feedback: { rated: r._count.feedbackRating, average: r._avg.feedbackRating === null ? null : round(r._avg.feedbackRating, 1), complaintsOpen: complaints },
    };
  }

  /**
   * Usage per day from what the platform already records: voice-agent minutes (Sarvam calls, phone and dashboard),
   * video presenter minutes and OpenAI tokens (usage events), WhatsApp messages sent. Cost = units × the business's
   * own rates (zero until entered).
   */
  async usage(organizationId: string, days: number, cfg: JarvisConfig, now = new Date()) {
    const R = await this.realOnly(organizationId);
    const from = istDayStart(now, days - 1);
    const dayOf = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const [calls, events, sent] = await Promise.all([
      this.safe('usageCalls', organizationId, () => this.prisma.call.findMany({ where: { organizationId, ...R.call, createdAt: { gte: from }, provider: 'sarvam', durationSec: { not: null } }, select: { createdAt: true, durationSec: true, outcome: true } }), []),
      this.safe('usageEvents', organizationId, () => this.prisma.integrationEvent.findMany({ where: { organizationId, createdAt: { gte: from }, OR: [{ provider: 'openai', kind: 'chat' }, { provider: 'simli', kind: 'video' }], units: { not: null } }, select: { createdAt: true, provider: true, units: true } }), []),
      this.safe('usageWhatsApp', organizationId, () => this.prisma.message.findMany({ where: { organizationId, createdAt: { gte: from }, role: 'assistant', conversation: { channel: 'whatsapp', ...R.conv } }, select: { createdAt: true } }), []),
    ]);
    type Day = { date: string; phoneMin: number; dashboardMin: number; videoMin: number; tokens: number; whatsapp: number; cost: number };
    const map = new Map<string, Day>();
    for (let i = days - 1; i >= 0; i--) {
      const d = dayOf(istDayStart(now, i));
      map.set(d, { date: d, phoneMin: 0, dashboardMin: 0, videoMin: 0, tokens: 0, whatsapp: 0, cost: 0 });
    }
    for (const c of calls) {
      const d = map.get(dayOf(c.createdAt));
      if (!d) continue;
      if (c.outcome === 'web_call') d.dashboardMin += n(c.durationSec) / 60;
      else d.phoneMin += n(c.durationSec) / 60;
    }
    for (const e of events) {
      const d = map.get(dayOf(e.createdAt));
      if (!d) continue;
      if (e.provider === 'openai') d.tokens += n(e.units);
      else d.videoMin += n(e.units) / 60;
    }
    for (const m of sent) {
      const d = map.get(dayOf(m.createdAt));
      if (d) d.whatsapp += 1;
    }
    const r = cfg.rates;
    const daysOut = [...map.values()].map((d) => {
      const cost = (d.phoneMin + d.dashboardMin) * r.sarvamAgentPerMin + d.videoMin * r.simliPerMin + (d.tokens / 1000) * r.openaiPer1kTokens + d.whatsapp * r.whatsappPerMsg;
      return { ...d, phoneMin: round(d.phoneMin, 1), dashboardMin: round(d.dashboardMin, 1), videoMin: round(d.videoMin, 1), cost: round(cost, 2) };
    });
    const sum = (k: keyof Omit<Day, 'date'>) => round(daysOut.reduce((a, d) => a + d[k], 0), k === 'cost' ? 2 : 1);
    return {
      days: daysOut,
      totals: { phoneMin: sum('phoneMin'), dashboardMin: sum('dashboardMin'), videoMin: sum('videoMin'), tokens: sum('tokens'), whatsapp: sum('whatsapp'), cost: sum('cost') },
      ratesSet: Object.values(r).some((v) => v > 0),
    };
  }

  /** "ERP" check from the platform's own data: stock to reorder, money to collect, orders to act on. */
  async erp(organizationId: string, cfg: JarvisConfig, now = new Date()) {
    const R = await this.realOnly(organizationId);
    const s = await this.snapshot(organizationId, cfg, now);
    const [statusRows, stockValue] = await Promise.all([
      this.safe('erpStatus', organizationId, () => this.prisma.order.groupBy({ by: ['status'], where: { organizationId, ...R.order, createdAt: { gte: istDayStart(now) } }, _count: true }), [] as never),
      this.safe('erpStockValue', organizationId, () => this.prisma.menuItem.findMany({ where: { organizationId, ...R.menu, stockQty: { not: null }, stockIsDemo: false }, select: { stockQty: true, price: true } }), []),
    ]);
    return {
      ordersByStatus: Object.fromEntries((statusRows as Array<{ status: string; _count: number }>).map((r) => [r.status, r._count])),
      stock: { tracked: s.stock.tracked, reorder: s.stock.low, valueAtPrice: round(stockValue.reduce((a, i) => a + n(i.stockQty) * n(i.price), 0)) },
      receivables: { overdueInvoices: s.overdue, unpaidOrdersToday: s.unpaidToday },
      pendingOrders: s.pendingOrders,
      complaintsOpen: s.feedback.complaintsOpen,
    };
  }
}
