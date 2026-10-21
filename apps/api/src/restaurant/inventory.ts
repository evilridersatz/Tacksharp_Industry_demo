import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Stock rules shared by the catalogue, the ordering engine, order creation and the dashboard.
 *
 * A product's stock is known when `stockQty` is set (kg or pieces, the product's own unit). NULL means UNKNOWN:
 * never treated as zero ("out of stock") and never as available. Customers are told the price and that the shop
 * will confirm the stock; an order can still be placed, and its summary says the stock is to be confirmed.
 *
 * Stock is taken (reserved) only when an order is created — the step where the customer has confirmed the
 * server's summary — and given back when that order is cancelled. Mentioning a product or building a draft never
 * touches stock. Both directions are recorded in InventoryMovement with a unique dedupe key, so a repeated webhook,
 * retry or double click can never take or return the same order's stock twice.
 */

export type StockStatus = 'unknown' | 'in_stock' | 'low' | 'out';

export const MAX_STOCK = 100_000;

const n = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));

export function stockStatus(item: { stockQty: Prisma.Decimal | number | null; lowStockThreshold: Prisma.Decimal | number | null; minQty: Prisma.Decimal | number }): StockStatus {
  const qty = n(item.stockQty);
  if (qty === null) return 'unknown';
  // Less than the smallest quantity anyone can order is the same as none.
  if (qty <= 0 || qty < (n(item.minQty) ?? 0)) return 'out';
  const threshold = n(item.lowStockThreshold);
  if (threshold !== null && qty <= threshold) return 'low';
  return 'in_stock';
}

/** Alert severity for a status: an alert is sent only when this goes up (none → low → out). */
export function alertLevel(status: StockStatus): 'low' | 'out' | null {
  return status === 'out' ? 'out' : status === 'low' ? 'low' : null;
}

export class InsufficientStockError extends Error {
  constructor(readonly itemName: string, readonly remaining: number, readonly unit: string) {
    super(`Insufficient stock for ${itemName}`);
    this.name = 'InsufficientStockError';
  }
}

/**
 * Inside the order-creation transaction: take each tracked product's quantity with a conditional update
 * (`stockQty >= quantity`), so two orders can never oversell the last kilo and stock never goes negative.
 * Throws InsufficientStockError (the transaction rolls back, nothing is taken) when a product ran out.
 */
export async function reserveStockForOrder(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; orderId: string; lines: Array<{ itemId: string; quantity: number }>; now?: Date },
): Promise<string[]> {
  const perItem = new Map<string, number>();
  for (const l of input.lines) perItem.set(l.itemId, (perItem.get(l.itemId) ?? 0) + l.quantity);
  const touched: string[] = [];
  for (const [itemId, quantity] of perItem) {
    const item = await tx.menuItem.findFirst({ where: { id: itemId, organizationId: input.organizationId }, select: { name: true, unit: true, stockQty: true } });
    if (!item || item.stockQty === null) continue; // stock unknown: nothing recorded to take
    const qty = new Prisma.Decimal(quantity.toFixed(3));
    const taken = await tx.menuItem.updateMany({
      where: { id: itemId, organizationId: input.organizationId, stockQty: { gte: qty } },
      data: { stockQty: { decrement: qty }, stockUpdatedAt: input.now ?? new Date() },
    });
    if (taken.count !== 1) {
      const now = await tx.menuItem.findFirst({ where: { id: itemId, organizationId: input.organizationId }, select: { stockQty: true } });
      throw new InsufficientStockError(item.name, Math.max(0, Number(now?.stockQty ?? 0)), item.unit === 'piece' ? 'piece' : 'kg');
    }
    const after = await tx.menuItem.findFirstOrThrow({ where: { id: itemId, organizationId: input.organizationId }, select: { stockQty: true } });
    // Unique per order + product: a second attempt for the same order fails the whole transaction.
    await tx.inventoryMovement.create({
      data: { organizationId: input.organizationId, menuItemId: itemId, orderId: input.orderId, delta: qty.neg(), balanceAfter: after.stockQty ?? 0, reason: 'order_reserved', actor: 'order', dedupeKey: `order:${input.orderId}:${itemId}` },
    });
    touched.push(itemId);
  }
  return touched;
}

/**
 * A cancelled order gives its stock back, once: the release is recorded with its own unique key before the stock
 * is increased, so cancelling twice (or a retried request) returns nothing the second time.
 */
export async function releaseStockForOrder(db: PrismaClient, input: { organizationId: string; orderId: string; actor: string }): Promise<string[]> {
  const reserved = await db.inventoryMovement.findMany({ where: { organizationId: input.organizationId, orderId: input.orderId, reason: 'order_reserved' } });
  const released: string[] = [];
  for (const m of reserved) {
    try {
      await db.$transaction(async (tx) => {
        const back = new Prisma.Decimal(m.delta).neg();
        // Only products that are still tracked get stock back (staff may have switched tracking off since).
        const updated = await tx.menuItem.updateMany({ where: { id: m.menuItemId, organizationId: input.organizationId, stockQty: { not: null } }, data: { stockQty: { increment: back }, stockUpdatedAt: new Date() } });
        const after = await tx.menuItem.findFirst({ where: { id: m.menuItemId, organizationId: input.organizationId }, select: { stockQty: true } });
        await tx.inventoryMovement.create({
          data: {
            organizationId: input.organizationId,
            menuItemId: m.menuItemId,
            orderId: input.orderId,
            delta: updated.count ? back : new Prisma.Decimal(0),
            balanceAfter: after?.stockQty ?? 0,
            reason: 'order_cancelled',
            actor: input.actor,
            dedupeKey: `cancel:${input.orderId}:${m.menuItemId}`,
          },
        });
      });
      released.push(m.menuItemId);
    } catch (error) {
      // Already released (unique dedupe key): nothing to do.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
  }
  return released;
}

/** "18 kg", "1.5 kg", "500 g", "120 pcs" — for replies and alerts. */
export function stockText(qty: number, unit: string): string {
  if (unit === 'piece') return `${Math.floor(qty)} pcs`;
  if (qty > 0 && qty < 1) return `${Math.round(qty * 1000)} g`;
  return `${Number.isInteger(qty) ? qty : Number(qty.toFixed(2))} kg`;
}
