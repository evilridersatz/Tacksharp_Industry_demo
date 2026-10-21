import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import { CatalogService } from './catalog.service.js';
import { StockAlertService } from './stock-alerts.service.js';
import { MAX_STOCK, stockStatus } from './inventory.js';

export type InventoryRow = {
  id: string;
  name: string;
  unit: 'kg' | 'piece';
  price: number;
  available: boolean;
  stockQty: number | null;
  lowStockThreshold: number | null;
  stockIsDemo: boolean;
  stockStatus: ReturnType<typeof stockStatus>;
  stockUpdatedAt: Date | null;
  isDemo: boolean;
};

/**
 * Stock on hand per product, for the dashboard and staff. Every read and write is scoped by the session's
 * organization; a product id from another organization is "not found".
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly alerts: StockAlertService,
  ) {}

  async list(organizationId: string): Promise<InventoryRow[]> {
    const items = await this.prisma.menuItem.findMany({ where: { organizationId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    return items.map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit === 'piece' ? 'piece' : 'kg',
      price: Number(i.price),
      available: i.available,
      stockQty: i.stockQty === null ? null : Number(i.stockQty),
      lowStockThreshold: i.lowStockThreshold === null ? null : Number(i.lowStockThreshold),
      stockIsDemo: i.stockIsDemo,
      stockStatus: stockStatus(i),
      stockUpdatedAt: i.stockUpdatedAt,
      isDemo: i.isDemo,
    }));
  }

  async movements(organizationId: string, itemId: string, limit = 50) {
    await this.mustOwn(organizationId, itemId);
    return this.prisma.inventoryMovement.findMany({ where: { organizationId, menuItemId: itemId }, orderBy: { createdAt: 'desc' }, take: Math.min(200, limit) });
  }

  /** The organization's latest stock movements across all products (dashboard). */
  async recentMovements(organizationId: string, limit = 30) {
    const rows = await this.prisma.inventoryMovement.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
      include: { menuItem: { select: { name: true, unit: true } } },
    });
    return rows.map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      product: m.menuItem.name,
      unit: m.menuItem.unit === 'piece' ? 'piece' : 'kg',
      delta: Number(m.delta),
      balanceAfter: Number(m.balanceAfter),
      reason: m.reason,
      actor: m.actor,
      orderId: m.orderId,
    }));
  }

  /**
   * Staff update. Body (all optional, validated here):
   *   stockQty           counted stock to set (>= 0), or null to stop tracking stock for this product
   *   adjustBy           add (+, received) or remove (−, wastage) — refused if it would go below zero
   *   lowStockThreshold  alert level (>= 0), or null for no alert
   * A staff-entered quantity is real counted stock: stockIsDemo becomes false.
   */
  async update(organizationId: string, itemId: string, body: Record<string, unknown>, actor: string): Promise<InventoryRow> {
    const item = await this.mustOwn(organizationId, itemId);
    const unit = item.unit === 'piece' ? 'piece' : 'kg';
    const parse = (v: unknown, label: string, { allowNegative = false } = {}) => {
      const num = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof num !== 'number' || !Number.isFinite(num)) throw new BadRequestException(`${label} must be a number.`);
      if (!allowNegative && num < 0) throw new BadRequestException(`${label} cannot be negative.`);
      if (Math.abs(num) > MAX_STOCK) throw new BadRequestException(`${label} is too large (max ${MAX_STOCK}).`);
      if (unit === 'piece' && !Number.isInteger(num)) throw new BadRequestException(`${label} must be a whole number of pieces.`);
      if (Math.round(num * 1000) !== num * 1000) throw new BadRequestException(`${label} can have at most 3 decimals.`);
      return new Prisma.Decimal(num.toFixed(3));
    };
    const hasSet = body.stockQty !== undefined;
    const hasAdjust = body.adjustBy !== undefined;
    const hasThreshold = body.lowStockThreshold !== undefined;
    if (!hasSet && !hasAdjust && !hasThreshold) throw new BadRequestException('Nothing to update: send stockQty, adjustBy or lowStockThreshold.');
    if (hasSet && hasAdjust) throw new BadRequestException('Send either stockQty or adjustBy, not both.');
    const threshold = hasThreshold ? (body.lowStockThreshold === null ? null : parse(body.lowStockThreshold, 'Low-stock level')) : undefined;
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Lock the product row for this change (no lost update against an order reserving stock at the same time).
      const rows = await tx.$queryRaw<Array<{ stockQty: Prisma.Decimal | null }>>`SELECT stockQty FROM MenuItem WHERE id = ${item.id} AND organizationId = ${organizationId} FOR UPDATE`;
      const before = rows[0]?.stockQty ?? null;
      let after: Prisma.Decimal | null | undefined;
      let reason = '';
      if (hasSet) {
        after = body.stockQty === null ? null : parse(body.stockQty, 'Stock');
        reason = 'staff_set';
      } else if (hasAdjust) {
        const delta = parse(body.adjustBy, 'Adjustment', { allowNegative: true });
        if (before === null) throw new BadRequestException('Stock is not tracked for this product yet: set a quantity first.');
        const next = new Prisma.Decimal(before).plus(delta);
        if (next.lt(0)) throw new BadRequestException(`Only ${Number(before)} ${unit === 'piece' ? 'pcs' : 'kg'} in stock: cannot remove ${Number(delta.neg())}.`);
        after = next;
        reason = 'staff_adjust';
      }
      await tx.menuItem.update({
        where: { id: item.id },
        data: {
          ...(after !== undefined ? { stockQty: after, stockIsDemo: false, stockUpdatedAt: now, ...(after === null ? { stockAlertLevel: null } : {}) } : {}),
          ...(threshold !== undefined ? { lowStockThreshold: threshold } : {}),
        },
      });
      if (after !== undefined && after !== null) {
        await tx.inventoryMovement.create({
          data: { organizationId, menuItemId: item.id, delta: after.minus(before ?? 0), balanceAfter: after, reason, actor },
        });
      }
    });
    this.catalog.invalidate(organizationId);
    log.info('inventory.updated', { organizationId, itemId: item.id, actor, fields: Object.keys(body) });
    this.alerts.checkInBackground(organizationId, [item.id]);
    return (await this.list(organizationId)).find((r) => r.id === item.id)!;
  }

  private async mustOwn(organizationId: string, itemId: string) {
    const item = await this.prisma.menuItem.findFirst({ where: { id: itemId, organizationId } });
    if (!item) throw new NotFoundException('Product not found');
    return item;
  }
}
