import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { ApprovalsService } from '../governance/approvals.service.js';
import { WorkTasksService } from '../governance/work-tasks.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Orchestrator } from '../agents/orchestrator.service.js';
import { InventoryService } from './inventory.service.js';
import { FulfilmentService } from './fulfilment.service.js';

const who = (u: SessionClaims) => `user:${u.sub}`;
const clientKey = (v: unknown) => {
  if (typeof v !== 'string' || !/^[\w-]{8,64}$/.test(v)) throw new BadRequestException('clientKey is required (prevents double submission)');
  return v;
};
const qty = (v: unknown, signed = false) => {
  const q = Number(v);
  if (!Number.isFinite(q) || q === 0 || (!signed && q < 0)) throw new BadRequestException(signed ? 'Enter a non-zero quantity (+ or -)' : 'Enter a positive quantity');
  return q;
};
const OPEN_ORDERS = ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched'];

/** Operations: counted stock, movements, fulfilment. Organization from the session; permissions checked here. */
@Controller('operations')
export class OperationsController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly approvals: ApprovalsService,
    private readonly workTasks: WorkTasksService,
    private readonly orchestrator: Orchestrator,
    private readonly prisma: PrismaService,
    private readonly fulfilmentSvc: FulfilmentService,
  ) {
    // Stock corrections run only after approval, exactly as proposed, once (key = approval id).
    approvals.registerExecutor('inventory.adjust', async (a, by) => {
      const p = a.payload as { productId: string; delta: number; reason: string };
      const [m] = await this.inventory.apply(a.organizationId, [{ productId: p.productId, type: 'adjust', quantity: p.delta, reason: `${p.reason} (approval ${a.id})`, actor: by, idempotencyKey: `adjust:${a.id}` }]);
      return { movementId: m.id, onHandAfter: Number(m.onHandAfter) };
    });
  }

  @Get('overview')
  async overview(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    const [rows, orders, tasks] = await Promise.all([
      this.inventory.balances(org),
      this.prisma.salesOrder.findMany({ where: { organizationId: org, status: { in: OPEN_ORDERS } }, select: { id: true, status: true, expectedDelivery: true } }),
      this.prisma.workTask.groupBy({ by: ['kind'], where: { organizationId: org, agent: 'operations', status: { in: ['open', 'in_progress'] } }, _count: { _all: true } }),
    ]);
    const tracked = rows.filter((r) => r.tracked);
    const now = new Date();
    return {
      products: { tracked: tracked.length, untracked: rows.length - tracked.length, low: tracked.filter((r) => r.low).length, outOfStock: tracked.filter((r) => r.available <= 0).length },
      reservedUnits: tracked.reduce((a, r) => a + r.reserved, 0),
      orders: {
        awaitingFulfilment: orders.filter((o) => o.status !== 'dispatched').length,
        dispatched: orders.filter((o) => o.status === 'dispatched').length,
        delayed: orders.filter((o) => o.expectedDelivery && o.expectedDelivery < now).length,
      },
      openTasks: Object.fromEntries(tasks.map((t) => [t.kind, t._count._all])),
      note: 'Products without counted stock are "not tracked": nothing about their availability is claimed.',
    };
  }

  @Get('inventory')
  list(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.inventory.balances(org);
  }

  @Post('inventory/:productId/track')
  track(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('productId') productId: string, @Body() body: { lowStockAt?: number | null; location?: string }) {
    requirePermission(u, PERMISSIONS.receiveStock);
    return this.inventory.track(org, productId, body ?? {});
  }

  /** Goods received (with a reference such as a GRN / supplier invoice number). */
  @Post('inventory/:productId/receive')
  async receive(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('productId') productId: string, @Body() body: { quantity?: number; reference?: string; lot?: string; clientKey?: string }) {
    requirePermission(u, PERMISSIONS.receiveStock);
    if (!body?.reference?.trim()) throw new BadRequestException('Enter the receipt reference (GRN / supplier invoice / challan number)');
    const [m] = await this.inventory.apply(org, [{ productId, type: 'receive', quantity: qty(body.quantity), reference: body.reference.trim(), lot: body.lot?.trim() || undefined, actor: who(u), idempotencyKey: `receive:${clientKey(body.clientKey)}` }]);
    return m;
  }

  /** A stock correction always goes through an approval (executed only once approved). */
  @Post('inventory/:productId/adjust')
  async adjust(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('productId') productId: string, @Body() body: { delta?: number; reason?: string; clientKey?: string }) {
    requirePermission(u, PERMISSIONS.agentsRun);
    const reason = body?.reason?.trim();
    if (!reason) throw new BadRequestException('Give the reason for the correction (count difference, damage, ...)');
    const p = await this.prisma.textileProduct.findFirst({ where: { id: productId, organizationId: org } });
    if (!p) throw new BadRequestException('Product not found');
    const delta = qty(body.delta, true);
    const r = await this.approvals.request(org, {
      action: 'inventory.adjust', entityType: 'product', entityId: productId, reason: `${p.name}: ${delta > 0 ? '+' : ''}${delta} ${p.priceUnit} - ${reason}`,
      payload: { productId, delta, reason, request: clientKey(body.clientKey) }, requiredPermission: PERMISSIONS.adjustStock, requestedBy: who(u), requesterRole: u.role,
    });
    if (!r.approved) return { approval: r.approval, applied: false, message: 'Sent for approval' };
    // The requester holds the permission: apply now, still recorded as an approval.
    const [m] = await this.inventory.apply(org, [{ productId, type: 'adjust', quantity: delta, reason: `${reason} (approval ${r.approval.id})`, actor: who(u), idempotencyKey: `adjust:${r.approval.id}` }]);
    await this.approvals.markExecuted(org, r.approval.id, { movementId: m.id });
    return { approval: r.approval, applied: true, movement: m };
  }

  @Get('movements')
  movements(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('productId') productId?: string, @Query('orderId') orderId?: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.inventory.movements(org, { productId, orderId });
  }

  @Get('fulfilment')
  async fulfilment(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    const orders = await this.prisma.salesOrder.findMany({
      where: { organizationId: org, status: { in: OPEN_ORDERS } },
      include: { customer: { select: { name: true, phone: true } } },
      // The newest 100 open orders (so a just-confirmed order is never hidden behind a backlog), shown oldest first.
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    orders.reverse();
    const now = new Date();
    return Promise.all(
      orders.map(async (o) => {
        const st = await this.inventory.orderStock(org, o.id);
        return {
          id: o.id, number: o.number, status: o.status, paymentStatus: o.paymentStatus, total: o.total, customer: o.customer, expectedDelivery: o.expectedDelivery,
          delayed: Boolean(o.expectedDelivery && o.expectedDelivery < now && o.status !== 'dispatched'),
          stock: { fullyReserved: st.fullyReserved, lines: st.lines, untrackedItems: st.untrackedItems },
        };
      }),
    );
  }

  @Post('orders/:id/reserve')
  reserve(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { clientKey?: string }) {
    requirePermission(u, PERMISSIONS.agentsRun);
    return this.orchestrator.submit(org, { kind: 'operations.reserve_order', input: { orderId: id }, trigger: 'user', idempotencyKey: `user:${clientKey(body?.clientKey)}`, requestedBy: who(u) }, { runNow: true });
  }

  /** Dispatch with courier / tracking. The normal status rules apply (stock must be reserved first). */
  @Post('orders/:id/dispatch')
  dispatch(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { courier?: string; trackingRef?: string }) {
    requirePermission(u, PERMISSIONS.dispatchOrder);
    return this.fulfilmentSvc.dispatch(org, id, body ?? {}, u);
  }

  @Get('orders/:id/shortage')
  shortage(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.fulfilmentSvc.shortage(org, id);
  }

  /** The owner's decision on a stock shortage + the exact customer message (approval: sales.decide_shortage). */
  @Post('orders/:id/shortage-decision')
  shortageDecision(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { decision?: string; newDate?: string; customerMessage?: string; note?: string }) {
    requirePermission(u, PERMISSIONS.agentsRun);
    return this.fulfilmentSvc.requestDecision(org, id, body ?? {}, u);
  }

  @Get('tasks')
  tasks(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('status') status?: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.workTasks.list(org, { agent: 'operations', status: status ?? 'active' });
  }
}
