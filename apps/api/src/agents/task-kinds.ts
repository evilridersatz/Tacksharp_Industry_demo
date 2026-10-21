import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { InventoryService } from '../operations/inventory.service.js';
import { StockShortError } from '../operations/inventory.service.js';
import type { WorkTasksService } from '../governance/work-tasks.service.js';
import type { TaskKind } from './agent-types.js';

type Deps = { prisma: PrismaService; inventory: InventoryService; workTasks: WorkTasksService };

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const obj = (raw: unknown) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const id = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !/^[\w-]{6,64}$/.test(v)) throw new BadRequestException(`${name} is required`);
  return v;
};
const LIVE_ORDER = ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered'];

/**
 * Every task an agent can run. Each one uses only shared business records (orders, catalogue, stock, leads) through
 * typed tools - never the chat history - and returns what it actually did.
 */
export function buildTaskKinds({ prisma, inventory, workTasks }: Deps): TaskKind[] {
  const orderInput = (raw: unknown) => ({ orderId: id(obj(raw).orderId, 'orderId') });
  const orderEntity = (i: { orderId: string }) => ({ type: 'order', id: i.orderId });

  const reserveOrder: TaskKind<{ orderId: string }> = {
    kind: 'operations.reserve_order',
    agent: 'operations',
    label: 'Reserve stock for an order',
    description: 'All-or-nothing reservation of counted stock for a confirmed order; a shortage raises an exception and hands over to Sales.',
    userRunnable: true,
    parse: orderInput,
    entity: orderEntity,
    async run(ctx, { orderId }) {
      const before = await ctx.tool('orders.read', () => inventory.orderStock(ctx.organizationId, orderId));
      if (!['confirmed', 'processing', 'ready_to_dispatch'].includes(before.order.status)) {
        return { status: 'completed', summary: `${before.order.number} is ${before.order.status}; nothing to reserve`, result: { outcome: 'not_applicable', orderStatus: before.order.status } };
      }
      const tracked = before.lines.filter((l) => l.tracked);
      if (!tracked.length) {
        return {
          status: 'completed',
          summary: `${before.order.number}: no stock-tracked items, nothing reserved`,
          result: { outcome: 'not_tracked', note: 'None of the items has counted stock, so availability is not confirmed by Operations.', untrackedItems: before.lines.length + before.untrackedItems },
        };
      }
      try {
        const st = await ctx.tool('inventory.reserve', () => inventory.reserveOrder(ctx.organizationId, orderId, ctx.actor), `Reserve stock for ${before.order.number}`);
        return { status: 'completed', summary: `${st.order.number}: stock reserved`, result: { outcome: 'reserved', lines: st.lines } };
      } catch (e) {
        if (!(e instanceof StockShortError)) throw e;
        const short = e.short;
        const lines = short.map((s) => `${s.name ?? s.productId}: needs ${s.needed}, available ${s.available}${s.reason ? ` (${s.reason})` : ''}`).join('\n');
        const ex = await ctx.tool('worktask.create', () =>
          workTasks.create(ctx.organizationId, {
            agent: 'operations', kind: 'exception', priority: 'high', title: `Stock short for ${before.order.number}`,
            detail: `Nothing was reserved (all-or-nothing).\n${lines}\nDecide: wait for replenishment, offer an alternative product, or revise the delivery date. Then reserve again from Operations.`,
            entityType: 'order', entityId: orderId, dedupeKey: `shortage:${orderId}`, createdBy: ctx.actor,
          }),
        );
        for (const s of short.filter((x) => !x.reason)) {
          await ctx.tool('worktask.create', () =>
            workTasks.create(ctx.organizationId, {
              agent: 'operations', kind: 'procurement', title: `Replenish ${s.name ?? s.productId}: ${Math.max(0, s.needed - s.available)} more needed for ${before.order.number}`,
              entityType: 'product', entityId: s.productId, dedupeKey: `procure:${orderId}:${s.productId}`, createdBy: ctx.actor,
            }),
          );
        }
        return {
          status: 'completed',
          summary: `${before.order.number}: stock short - exception raised, Sales informed`,
          result: { outcome: 'shortage', short, exceptionTaskId: ex.task.id },
          handoffs: [{ kind: 'sales.stock_shortage_review', input: { orderId, short }, reason: 'Stock is short: the customer must not be promised the original quantity or date', entity: { type: 'order', id: orderId } }],
        };
      }
    },
  };

  const releaseOrder: TaskKind<{ orderId: string }> = {
    kind: 'operations.release_order',
    agent: 'operations',
    label: 'Release reserved stock',
    description: 'Returns stock reserved for a cancelled order.',
    userRunnable: false,
    parse: orderInput,
    entity: orderEntity,
    async run(ctx, { orderId }) {
      const st = await ctx.tool('inventory.release', () => inventory.releaseOrder(ctx.organizationId, orderId, ctx.actor), 'Release reservation');
      return { status: 'completed', summary: `${st.order.number}: reservation released`, result: { outcome: 'released', lines: st.lines } };
    },
  };

  const dispatchOrder: TaskKind<{ orderId: string }> = {
    kind: 'operations.dispatch_order',
    agent: 'operations',
    label: 'Deduct dispatched stock',
    description: 'Moves the reserved quantity out of stock when the order is dispatched.',
    userRunnable: false,
    parse: orderInput,
    entity: orderEntity,
    async run(ctx, { orderId }) {
      const st = await ctx.tool('inventory.dispatch', () => inventory.dispatchOrder(ctx.organizationId, orderId, ctx.actor), 'Deduct dispatched stock');
      return { status: 'completed', summary: `${st.order.number}: dispatched stock deducted`, result: { outcome: 'dispatched', lines: st.lines } };
    },
  };

  const lowStockScan: TaskKind<Record<string, never>> = {
    kind: 'operations.low_stock_scan',
    agent: 'operations',
    label: 'Low-stock scan',
    description: 'Finds tracked products at or below their low-stock level and opens one procurement task each.',
    userRunnable: true,
    parse: () => ({}),
    async run(ctx) {
      const rows = await ctx.tool('inventory.read', () => inventory.balances(ctx.organizationId));
      const low = rows.filter((r) => r.low);
      const day = new Date().toISOString().slice(0, 10);
      let created = 0;
      for (const r of low) {
        const open = await prisma.workTask.count({ where: { organizationId: ctx.organizationId, kind: 'procurement', entityType: 'product', entityId: r.productId, status: { in: ['open', 'in_progress'] } } });
        if (open) continue;
        const t = await ctx.tool('worktask.create', () =>
          workTasks.create(ctx.organizationId, {
            agent: 'operations', kind: 'procurement', title: `Low stock: ${r.name} (${r.available} ${r.unit} available, alert at ${r.lowStockAt})`,
            entityType: 'product', entityId: r.productId, dedupeKey: `lowstock:${r.productId}:${day}`, createdBy: ctx.actor,
          }),
        );
        if (t.created) created++;
      }
      return { status: 'completed', summary: `${low.length} low-stock product(s), ${created} new procurement task(s)`, result: { low: low.map((r) => ({ productId: r.productId, name: r.name, available: r.available, lowStockAt: r.lowStockAt })), created } };
    },
  };

  const fulfilmentCheck: TaskKind<{ orderId: string }> = {
    kind: 'operations.fulfilment_check',
    agent: 'operations',
    label: 'Order fulfilment check',
    description: 'Reports whether an order can move to dispatch: stock reserved, payment status as recorded, delivery date.',
    userRunnable: true,
    parse: orderInput,
    entity: orderEntity,
    async run(ctx, { orderId }) {
      const st = await ctx.tool('orders.read', () => inventory.orderStock(ctx.organizationId, orderId));
      const blockers: string[] = [];
      for (const l of st.lines.filter((x) => x.tracked)) {
        if (l.unitMismatch) blockers.push(`${l.name}: order unit differs from stock unit`);
        else if (l.reserved + l.dispatched < l.needed) blockers.push(`${l.name}: ${l.reserved + l.dispatched}/${l.needed} ${l.unit} reserved`);
      }
      const untracked = st.lines.filter((l) => !l.tracked).length + st.untrackedItems;
      const delayed = st.order.expectedDelivery && new Date(st.order.expectedDelivery) < new Date() && !['dispatched', 'delivered', 'cancelled'].includes(st.order.status);
      return {
        status: 'completed',
        summary: blockers.length ? `${st.order.number}: not ready (${blockers.length} blocker(s))` : `${st.order.number}: stock ready`,
        result: {
          ready: blockers.length === 0,
          blockers,
          untrackedItems: untracked,
          paymentStatus: st.order.paymentStatus,
          paymentNote: 'Payment status as recorded by your team; not verified by Finance yet.',
          delayed: Boolean(delayed),
        },
      };
    },
  };

  const availabilityCheck: TaskKind<{ productId: string; quantity: number }> = {
    kind: 'sales.availability_check',
    agent: 'sales',
    label: 'Stock availability check',
    description: 'Can we promise this quantity? Answers only from counted stock; untracked products are "unknown".',
    userRunnable: true,
    parse(raw) {
      const o = obj(raw);
      const quantity = Number(o.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive number');
      return { productId: id(o.productId, 'productId'), quantity };
    },
    entity: (i) => ({ type: 'product', id: i.productId }),
    async run(ctx, { productId, quantity }) {
      const p = await ctx.tool('catalogue.read', () => prisma.textileProduct.findFirst({ where: { id: productId, organizationId: ctx.organizationId } }));
      if (!p) throw new BadRequestException('Product not found');
      const a = (await ctx.tool('inventory.read', () => inventory.availability(ctx.organizationId, [productId]))).get(productId);
      if (!a) {
        return { status: 'completed', summary: `${p.name}: stock not tracked - do not promise availability`, result: { tracked: false, canPromise: false, note: 'No counted stock for this product. Confirm with Operations before promising.' } };
      }
      const enough = a.available >= quantity;
      return {
        status: 'completed',
        summary: `${p.name}: ${a.available} ${p.priceUnit} available - ${enough ? 'enough' : 'NOT enough'} for ${quantity}`,
        result: { tracked: true, available: a.available, requested: quantity, unit: p.priceUnit, canPromise: enough, leadTimeDays: p.leadTimeDays },
      };
    },
  };

  const shortageReview: TaskKind<{ orderId: string; short: unknown[] }> = {
    kind: 'sales.stock_shortage_review',
    agent: 'sales',
    label: 'Stock-shortage review',
    description: 'Asks the salesperson to agree an alternative with the customer; nothing is promised until it is decided.',
    userRunnable: false,
    parse: (raw) => ({ orderId: id(obj(raw).orderId, 'orderId'), short: Array.isArray(obj(raw).short) ? (obj(raw).short as unknown[]).slice(0, 50) : [] }),
    entity: orderEntity,
    async run(ctx, { orderId, short }) {
      const order = await ctx.tool('orders.read', () => prisma.salesOrder.findFirst({ where: { id: orderId, organizationId: ctx.organizationId }, include: { customer: { select: { name: true, phone: true } } } }));
      if (!order) throw new BadRequestException('Order not found');
      const t = await ctx.tool('worktask.create', () =>
        workTasks.create(ctx.organizationId, {
          agent: 'sales', kind: 'review', priority: 'high', title: `Agree a way forward with ${order.customer?.name ?? 'the customer'} on ${order.number} (stock short)`,
          detail: `Do not promise the original quantity or date.\nShort: ${JSON.stringify(short)}\nOptions to agree with the owner: wait for replenishment with a revised date, an alternative product, or a partial order. Record the decision here.`,
          entityType: 'order', entityId: orderId, dedupeKey: `shortage_review:${orderId}`, createdBy: ctx.actor,
        }),
      );
      return { status: 'completed', summary: `${order.number}: salesperson asked to agree an alternative`, result: { reviewTaskId: t.task.id, created: t.created } };
    },
  };

  const sourceReport: TaskKind<{ days: number }> = {
    kind: 'marketing.source_report',
    agent: 'marketing',
    label: 'Enquiries by source',
    description: 'Leads, quotations and confirmed orders by lead source / campaign. Order value is recorded, not verified revenue; no ad spend.',
    userRunnable: true,
    parse: (raw) => ({ days: Math.min(365, Math.max(1, Number(obj(raw).days) || 30)) }),
    async run(ctx, { days }) {
      const since = new Date(Date.now() - days * 86_400_000);
      const leads = await ctx.tool('leads.read', () => prisma.lead.findMany({ where: { organizationId: ctx.organizationId, createdAt: { gte: since } }, select: { id: true, source: true, campaign: true } }));
      const ids = leads.map((l) => l.id);
      const [quotes, orders] = await Promise.all([
        ctx.tool('quotations.read', () => prisma.quotation.findMany({ where: { organizationId: ctx.organizationId, leadId: { in: ids } }, select: { leadId: true, status: true } })),
        ctx.tool('orders.read', () => prisma.salesOrder.findMany({ where: { organizationId: ctx.organizationId, leadId: { in: ids }, status: { in: LIVE_ORDER } }, select: { leadId: true, total: true } })),
      ]);
      const groups = new Map<string, { source: string; campaign: string; leads: number; quotations: number; orders: number; recordedOrderValue: number }>();
      for (const l of leads) {
        const key = `${l.source ?? 'unknown'}|${l.campaign ?? '—'}`;
        const g = groups.get(key) ?? { source: l.source ?? 'unknown', campaign: l.campaign ?? '—', leads: 0, quotations: 0, orders: 0, recordedOrderValue: 0 };
        g.leads++;
        g.quotations += quotes.filter((q) => q.leadId === l.id).length;
        const os = orders.filter((o) => o.leadId === l.id);
        g.orders += os.length;
        g.recordedOrderValue = Math.round((g.recordedOrderValue + os.reduce((a, o) => a + n(o.total), 0)) * 100) / 100;
        groups.set(key, g);
      }
      const rows = [...groups.values()].sort((a, b) => b.leads - a.leads);
      return {
        status: 'completed',
        summary: `${leads.length} lead(s) from ${rows.length} source/campaign group(s) in ${days} days`,
        result: { days, rows, adSpend: null, note: 'Attribution uses the source / campaign stored on each lead. Ad spend is not available (Meta ads_read not connected), so no ROI is computed.' },
      };
    },
  };

  return [reserveOrder, releaseOrder, dispatchOrder, lowStockScan, fulfilmentCheck, availabilityCheck, shortageReview, sourceReport] as unknown as TaskKind[];
}
