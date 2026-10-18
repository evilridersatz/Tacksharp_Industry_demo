import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export type MoveType = 'receive' | 'adjust' | 'reserve' | 'release' | 'dispatch';
export type Move = {
  productId: string;
  location?: string;
  type: MoveType;
  /** Positive, except `adjust` which is signed (+ found, - damaged / miscounted). */
  quantity: number;
  orderId?: string;
  lot?: string;
  reference?: string;
  reason?: string;
  actor: string;
  idempotencyKey: string;
};

export class StockShortError extends ConflictException {
  constructor(readonly short: Array<{ productId: string; name?: string; needed: number; available: number; reason?: string }>) {
    super(`Not enough stock: ${short.map((s) => `${s.name ?? s.productId} needs ${s.needed}, available ${s.available}${s.reason ? ` (${s.reason})` : ''}`).join('; ')}`);
  }
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Counted stock. Every change is a StockMovement written in the same database transaction as the balance change,
 * keyed by an idempotency key (a retried task or double click never moves stock twice), and guarded by a
 * conditional UPDATE so two parallel reservations can never take the same metres (no negative stock unless the
 * product explicitly allows it). A product without a balance row is "not tracked": nothing is claimed about it.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  private async product(organizationId: string, productId: string) {
    const p = await this.prisma.textileProduct.findFirst({ where: { id: productId, organizationId } });
    if (!p) throw new NotFoundException('Product not found');
    return p;
  }

  async track(organizationId: string, productId: string, input: { lowStockAt?: number | null; location?: string; allowNegative?: boolean }) {
    await this.product(organizationId, productId);
    const location = (input.location?.trim() || 'main').slice(0, 60);
    const low = input.lowStockAt === undefined || input.lowStockAt === null || (input.lowStockAt as unknown) === '' ? null : Number(input.lowStockAt);
    if (low !== null && (!Number.isFinite(low) || low < 0)) throw new BadRequestException('Low-stock level must be 0 or more');
    return this.prisma.inventoryBalance.upsert({
      where: { productId_location: { productId, location } },
      create: { organizationId, productId, location, lowStockAt: low, allowNegative: Boolean(input.allowNegative) },
      update: { lowStockAt: low, ...(input.allowNegative !== undefined ? { allowNegative: Boolean(input.allowNegative) } : {}) },
    });
  }

  /** Apply moves all-or-nothing. Returns the movements (existing ones for keys already applied). */
  async apply(organizationId: string, moves: Move[]) {
    for (const m of moves) {
      if (!Number.isFinite(m.quantity) || m.quantity === 0 || (m.type !== 'adjust' && m.quantity < 0)) throw new BadRequestException('Quantity must be a positive number');
      if (Math.abs(m.quantity) > 100_000_000) throw new BadRequestException('Quantity too large');
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const out = [];
          for (const m of moves) {
            const existing = await tx.stockMovement.findUnique({ where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: m.idempotencyKey } } });
            if (existing) {
              out.push({ ...existing, duplicate: true });
              continue;
            }
            const location = m.location ?? 'main';
            const q = new Prisma.Decimal(round2(m.quantity));
            let affected = 0;
            const where = Prisma.sql`organizationId = ${organizationId} AND productId = ${m.productId} AND location = ${location}`;
            switch (m.type) {
              case 'receive':
                affected = await tx.$executeRaw`UPDATE InventoryBalance SET onHand = onHand + ${q}, updatedAt = NOW(3) WHERE ${where}`;
                break;
              case 'adjust':
                affected = await tx.$executeRaw`UPDATE InventoryBalance SET onHand = onHand + ${q}, updatedAt = NOW(3) WHERE ${where} AND (allowNegative OR onHand + ${q} >= reserved)`;
                break;
              case 'reserve':
                affected = await tx.$executeRaw`UPDATE InventoryBalance SET reserved = reserved + ${q}, updatedAt = NOW(3) WHERE ${where} AND (allowNegative OR onHand - reserved >= ${q})`;
                break;
              case 'release':
                affected = await tx.$executeRaw`UPDATE InventoryBalance SET reserved = reserved - ${q}, updatedAt = NOW(3) WHERE ${where} AND reserved >= ${q}`;
                break;
              case 'dispatch':
                affected = await tx.$executeRaw`UPDATE InventoryBalance SET reserved = reserved - ${q}, onHand = onHand - ${q}, updatedAt = NOW(3) WHERE ${where} AND reserved >= ${q} AND (allowNegative OR onHand >= ${q})`;
                break;
            }
            const bal = await tx.inventoryBalance.findUnique({ where: { productId_location: { productId: m.productId, location } } });
            if (!bal || bal.organizationId !== organizationId) throw new ConflictException('This product is not stock-tracked yet (set it up under Operations → Inventory)');
            if (affected === 0) {
              const available = round2(n(bal.onHand) - n(bal.reserved));
              if (m.type === 'reserve') throw new StockShortError([{ productId: m.productId, needed: round2(m.quantity), available }]);
              throw new ConflictException(
                m.type === 'adjust' ? `Stock cannot go below what is reserved (${n(bal.reserved)})` : `Not enough reserved stock to ${m.type} (${n(bal.reserved)} reserved)`,
              );
            }
            const mv = await tx.stockMovement.create({
              data: {
                organizationId, productId: m.productId, location, type: m.type, quantity: q, onHandAfter: bal.onHand, reservedAfter: bal.reserved,
                orderId: m.orderId ?? null, lot: m.lot?.slice(0, 120) ?? null, reference: m.reference?.slice(0, 191) ?? null, reason: m.reason?.slice(0, 2000) ?? null,
                actor: m.actor.slice(0, 191), idempotencyKey: m.idempotencyKey.slice(0, 191),
              },
            });
            out.push({ ...mv, duplicate: false });
          }
          return out;
        });
      } catch (e) {
        // A parallel request wrote the same idempotency key first: the transaction rolled back; re-read and return it.
        if ((e as { code?: string }).code === 'P2002' && attempt === 0) continue;
        throw e;
      }
    }
  }

  async balances(organizationId: string) {
    const [products, rows] = await Promise.all([
      this.prisma.textileProduct.findMany({ where: { organizationId, active: true }, orderBy: { name: 'asc' }, take: 1000 }),
      this.prisma.inventoryBalance.findMany({ where: { organizationId } }),
    ]);
    return products.map((p) => {
      const b = rows.filter((r) => r.productId === p.id);
      const onHand = round2(b.reduce((a, r) => a + n(r.onHand), 0));
      const reserved = round2(b.reduce((a, r) => a + n(r.reserved), 0));
      const lowStockAt = b.find((r) => r.lowStockAt !== null)?.lowStockAt;
      const available = round2(onHand - reserved);
      return {
        productId: p.id, sku: p.sku, name: p.name, unit: p.priceUnit, fabricCategory: p.fabricCategory, colour: p.colour, leadTimeDays: p.leadTimeDays,
        tracked: b.length > 0, locations: b.map((r) => ({ location: r.location, onHand: n(r.onHand), reserved: n(r.reserved) })),
        onHand, reserved, available, lowStockAt: lowStockAt === undefined || lowStockAt === null ? null : n(lowStockAt),
        low: b.length > 0 && lowStockAt !== undefined && lowStockAt !== null && available <= n(lowStockAt),
      };
    });
  }

  /** Available quantity per tracked product (untracked products are absent). Used by Sales so it never over-promises. */
  async availability(organizationId: string, productIds: string[]) {
    if (!productIds.length) return new Map<string, { available: number; lowStockAt: number | null }>();
    const rows = await this.prisma.inventoryBalance.findMany({ where: { organizationId, productId: { in: productIds } } });
    const m = new Map<string, { available: number; lowStockAt: number | null }>();
    for (const r of rows) {
      const cur = m.get(r.productId) ?? { available: 0, lowStockAt: null };
      cur.available = round2(cur.available + n(r.onHand) - n(r.reserved));
      if (r.lowStockAt !== null) cur.lowStockAt = n(r.lowStockAt);
      m.set(r.productId, cur);
    }
    return m;
  }

  movements(organizationId: string, q: { productId?: string; orderId?: string } = {}) {
    return this.prisma.stockMovement.findMany({
      where: { organizationId, ...(q.productId ? { productId: q.productId } : {}), ...(q.orderId ? { orderId: q.orderId } : {}) },
      include: { product: { select: { name: true, sku: true, priceUnit: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  /**
   * Per product of an order: needed vs reserved / dispatched for THIS order. Lines whose unit differs from the
   * catalogue stock unit are flagged, never silently compared (500 metres is not 500 kg).
   */
  async orderStock(organizationId: string, orderId: string) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id: orderId, organizationId }, include: { items: true } });
    if (!order) throw new NotFoundException('Order not found');
    const productIds = [...new Set(order.items.map((i) => i.productId).filter((x): x is string => Boolean(x)))];
    const [products, balances, moves] = await Promise.all([
      this.prisma.textileProduct.findMany({ where: { organizationId, id: { in: productIds } } }),
      this.prisma.inventoryBalance.findMany({ where: { organizationId, productId: { in: productIds } } }),
      this.prisma.stockMovement.findMany({ where: { organizationId, orderId } }),
    ]);
    const lines = productIds.map((pid) => {
      const p = products.find((x) => x.id === pid);
      const items = order.items.filter((i) => i.productId === pid);
      const needed = round2(items.reduce((a, i) => a + n(i.quantity), 0));
      const unitMismatch = items.some((i) => p && i.unit !== p.priceUnit);
      const sum = (t: MoveType) => moves.filter((m) => m.productId === pid && m.type === t).reduce((a, m) => a + n(m.quantity), 0);
      const reserved = round2(sum('reserve') - sum('release') - sum('dispatch'));
      const dispatched = round2(sum('dispatch'));
      const bal = balances.filter((b) => b.productId === pid);
      const available = round2(bal.reduce((a, b) => a + n(b.onHand) - n(b.reserved), 0));
      return { productId: pid, name: p?.name ?? 'Unknown', unit: p?.priceUnit ?? items[0]?.unit, tracked: bal.length > 0, needed, reserved, dispatched, available, unitMismatch };
    });
    const tracked = lines.filter((l) => l.tracked);
    const untrackedItems = order.items.filter((i) => !i.productId).length;
    return {
      order: { id: order.id, number: order.number, status: order.status, paymentStatus: order.paymentStatus, expectedDelivery: order.expectedDelivery },
      lines,
      untrackedItems,
      fullyReserved: tracked.every((l) => !l.unitMismatch && l.reserved + l.dispatched >= l.needed),
      fullyDispatched: tracked.every((l) => l.dispatched >= l.needed),
    };
  }

  /** Reserve every tracked line of an order, all or nothing. Lines already reserved are not reserved twice. */
  async reserveOrder(organizationId: string, orderId: string, actor: string) {
    const st = await this.orderStock(organizationId, orderId);
    const short: Array<{ productId: string; name: string; needed: number; available: number; reason?: string }> = [];
    const moves: Move[] = [];
    for (const l of st.lines.filter((x) => x.tracked)) {
      if (l.unitMismatch) {
        short.push({ productId: l.productId, name: l.name, needed: l.needed, available: l.available, reason: `order unit differs from stock unit (${l.unit})` });
        continue;
      }
      const missing = round2(l.needed - l.reserved - l.dispatched);
      if (missing <= 0) continue;
      if (missing > l.available) short.push({ productId: l.productId, name: l.name, needed: missing, available: l.available });
      moves.push({ productId: l.productId, type: 'reserve', quantity: missing, orderId, actor, idempotencyKey: `reserve:${orderId}:${l.productId}:${round2(l.reserved + l.dispatched)}`, reason: `Order ${st.order.number}` });
    }
    if (short.length) throw new StockShortError(short);
    try {
      const applied = moves.length ? await this.apply(organizationId, moves) : [];
      return { ...(await this.orderStock(organizationId, orderId)), applied: applied.length };
    } catch (e) {
      if (e instanceof StockShortError) {
        // Another order took the stock between the check and the write: report with names.
        throw new StockShortError(e.short.map((s) => ({ ...s, name: st.lines.find((l) => l.productId === s.productId)?.name })));
      }
      throw e;
    }
  }

  async releaseOrder(organizationId: string, orderId: string, actor: string) {
    const st = await this.orderStock(organizationId, orderId);
    const moves: Move[] = st.lines
      .filter((l) => l.tracked && l.reserved > 0)
      .map((l) => ({ productId: l.productId, type: 'release' as const, quantity: l.reserved, orderId, actor, idempotencyKey: `release:${orderId}:${l.productId}`, reason: `Order ${st.order.number} cancelled` }));
    if (moves.length) await this.apply(organizationId, moves);
    return this.orderStock(organizationId, orderId);
  }

  async dispatchOrder(organizationId: string, orderId: string, actor: string) {
    const st = await this.orderStock(organizationId, orderId);
    const moves: Move[] = st.lines
      .filter((l) => l.tracked && l.reserved > 0)
      .map((l) => ({ productId: l.productId, type: 'dispatch' as const, quantity: l.reserved, orderId, actor, idempotencyKey: `dispatch:${orderId}:${l.productId}`, reason: `Order ${st.order.number} dispatched` }));
    if (moves.length) await this.apply(organizationId, moves);
    return this.orderStock(organizationId, orderId);
  }

  /** An order may be marked ready / dispatched only when every stock-tracked line is reserved for it. */
  async assertReady(organizationId: string, orderId: string) {
    const st = await this.orderStock(organizationId, orderId);
    if (st.fullyReserved) return st;
    const missing = st.lines.filter((l) => l.tracked && (l.unitMismatch || l.reserved + l.dispatched < l.needed));
    throw new ConflictException(
      `Stock is not reserved for ${st.order.number}: ${missing.map((l) => (l.unitMismatch ? `${l.name} (unit differs from stock unit)` : `${l.name} ${l.reserved + l.dispatched}/${l.needed} ${l.unit}`)).join(', ')}. Reserve it under Operations first.`,
    );
  }
}
