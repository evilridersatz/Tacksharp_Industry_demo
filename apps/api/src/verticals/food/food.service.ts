import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { log } from '../../common/logger.js';
import { DEFAULT_SETTINGS, type TenantSettings } from '../../settings/tenant-settings.js';
import { IST_MS, money, n, reference } from '../common.js';

export type Priced = { name: string; price: number };
export type FoodCartLine = { itemId: string; quantity: number; variant?: string | null; addOns?: string[] };
export type FoodQuoteLine = { itemId: string; name: string; variant: string | null; addOns: Priced[]; unitPrice: number; quantity: number; lineTotal: number; taxRatePct: number };
export type FoodQuote = {
  ok: boolean;
  problems: string[];
  lines: FoodQuoteLine[];
  subtotal: number;
  tax: number;
  packagingFee: number;
  deliveryFee: number;
  total: number;
  fulfilment: 'pickup' | 'delivery';
  zone: { name: string; fee: number; minOrder: number; etaMinutes: number } | null;
  readyInMinutes: number;
  outlet: { id: string; name: string; open: boolean; opensAt: string; closesAt: string } | null;
};
export type FoodItemView = {
  id: string; name: string; category: string; description: string | null; price: number; variants: Priced[]; addOns: Priced[];
  available: boolean; soldOut: boolean; stockQty: number | null; isVeg: boolean | null; taxRatePct: number | null; aliases: string[];
};

/** Food order lifecycle (Order.status). GR Chicken orders keep their own rules in restaurant/orders.service.ts. */
export const FOOD_STATUS_LABEL: Record<string, string> = {
  pending: 'Order received',
  confirmed: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready for pickup',
  dispatched: 'Out for delivery',
  completed: 'Delivered / collected',
  cancelled: 'Cancelled',
  needs_attention: 'Needs attention',
};
const NEXT: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled', 'needs_attention'],
  confirmed: ['preparing', 'cancelled', 'needs_attention'],
  preparing: ['ready', 'dispatched', 'cancelled', 'needs_attention'],
  ready: ['completed', 'dispatched', 'cancelled', 'needs_attention'],
  dispatched: ['completed', 'needs_attention'],
  needs_attention: ['confirmed', 'preparing', 'ready', 'dispatched', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
export const foodNextStatuses = (status: string, fulfilment: string) =>
  (NEXT[status] ?? []).filter((s) => !(s === 'dispatched' && fulfilment !== 'delivery'));

const MAX_QTY = 20;
const MAX_LINES = 15;

const priced = (raw: unknown): Priced[] =>
  (Array.isArray(raw) ? raw : [])
    .map((x) => ({ name: String((x as { name?: unknown })?.name ?? '').trim(), price: money(Number((x as { price?: unknown })?.price)) }))
    .filter((x) => x.name && Number.isFinite(x.price) && x.price >= 0);

export function istHhmm(d: Date) {
  return new Date(d.getTime() + IST_MS).toISOString().slice(11, 16);
}
function isOpenAt(o: { opensAt: string; closesAt: string; acceptOutsideHours: boolean }, at: Date) {
  if (o.acceptOutsideHours) return true;
  const t = istHhmm(at);
  return o.opensAt <= o.closesAt ? t >= o.opensAt && t < o.closesAt : t >= o.opensAt || t < o.closesAt;
}

/**
 * Restaurant & food ordering (cafes, cloud kitchens, takeaway). The server is the only source of prices, tax, fees,
 * availability and order state; the assistant and the dashboard both go through here.
 */
@Injectable()
export class FoodService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  private async cfg(org: string): Promise<TenantSettings['food']> {
    return (await this.settings?.get(org))?.food ?? DEFAULT_SETTINGS.food;
  }

  view(i: Prisma.MenuItemGetPayload<{ include: { category: true } }>): FoodItemView {
    const stockQty = i.stockQty === null ? null : n(i.stockQty);
    return {
      id: i.id, name: i.name, category: i.category.name, description: i.description, price: n(i.price), variants: priced(i.variants), addOns: priced(i.addOns),
      available: i.available, soldOut: !i.available || (stockQty !== null && stockQty <= 0), stockQty, isVeg: i.isVeg, taxRatePct: i.taxRatePct === null ? null : n(i.taxRatePct),
      aliases: (i.aliases ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean),
    };
  }

  async menu(org: string) {
    const [items, outlets, cfg] = await Promise.all([
      this.prisma.menuItem.findMany({ where: { organizationId: org }, include: { category: true }, orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.outlet.findMany({ where: { organizationId: org, active: true }, orderBy: { sortOrder: 'asc' } }),
      this.cfg(org),
    ]);
    const views = items.map((i) => this.view(i));
    const categories = [...new Set(views.map((v) => v.category))].map((name) => ({ name, items: views.filter((v) => v.category === name) }));
    return {
      categories,
      outlets: outlets.map((o) => ({ id: o.id, name: o.name, address: o.address, area: o.area, phone: o.phone, opensAt: o.opensAt, closesAt: o.closesAt, prepMinutes: o.prepMinutes, open: isOpenAt(o, new Date()) })),
      config: { taxPct: cfg.taxPct, packagingFee: cfg.packagingFee, pickupEnabled: cfg.pickupEnabled, deliveryEnabled: cfg.deliveryEnabled, deliveryZones: cfg.deliveryZones },
    };
  }

  /** The delivery zone the customer's address / area falls in (keyword match), or null. */
  zoneFor(cfg: TenantSettings['food'], address: string | null | undefined) {
    const a = ` ${(address ?? '').toLowerCase()} `;
    if (!a.trim()) return null;
    return cfg.deliveryZones.find((z) => z.keywords.some((k) => k && a.includes(k))) ?? null;
  }

  /** Authoritative price for a cart. Never throws for customer mistakes: they come back as `problems`. */
  async quote(org: string, input: { lines: FoodCartLine[]; fulfilment?: 'pickup' | 'delivery'; address?: string | null; outletId?: string | null; now?: Date }): Promise<FoodQuote> {
    const cfg = await this.cfg(org);
    const now = input.now ?? new Date();
    const problems: string[] = [];
    const fulfilment = input.fulfilment ?? (cfg.pickupEnabled ? 'pickup' : 'delivery');
    const raw = (input.lines ?? []).slice(0, MAX_LINES + 1);
    if (raw.length > MAX_LINES) problems.push(`At most ${MAX_LINES} different items per order.`);
    const ids = [...new Set(raw.map((l) => l.itemId))];
    const items = await this.prisma.menuItem.findMany({ where: { organizationId: org, id: { in: ids } }, include: { category: true } });
    const byId = new Map(items.map((i) => [i.id, this.view(i)]));
    const lines: FoodQuoteLine[] = [];
    for (const l of raw.slice(0, MAX_LINES)) {
      const item = byId.get(l.itemId);
      if (!item) {
        problems.push('An item in the cart is not on the menu.');
        continue;
      }
      const qty = Math.round(Number(l.quantity));
      if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) {
        problems.push(`${item.name}: quantity must be between 1 and ${MAX_QTY}.`);
        continue;
      }
      if (item.soldOut) problems.push(`${item.name} is sold out right now.`);
      else if (item.stockQty !== null && qty > item.stockQty) problems.push(`Only ${item.stockQty} ${item.name} left.`);
      let unit = item.price;
      let variant: string | null = null;
      if (item.variants.length) {
        const v = item.variants.find((x) => x.name.toLowerCase() === String(l.variant ?? '').toLowerCase());
        if (!v) {
          problems.push(`${item.name}: please choose ${item.variants.map((x) => x.name).join(' / ')}.`);
          continue;
        }
        unit = v.price;
        variant = v.name;
      }
      const addOns: Priced[] = [];
      for (const a of [...new Set((l.addOns ?? []).map((x) => x.toLowerCase()))]) {
        const found = item.addOns.find((x) => x.name.toLowerCase() === a);
        if (!found) problems.push(`${item.name}: "${a}" is not an available add-on.`);
        else addOns.push(found);
      }
      const unitPrice = money(unit + addOns.reduce((s, a) => s + a.price, 0));
      lines.push({ itemId: item.id, name: item.name, variant, addOns, unitPrice, quantity: qty, lineTotal: money(unitPrice * qty), taxRatePct: item.taxRatePct ?? cfg.taxPct });
    }
    if (!raw.length) problems.push('The cart is empty.');
    const subtotal = money(lines.reduce((s, l) => s + l.lineTotal, 0));
    const tax = money(lines.reduce((s, l) => s + (l.lineTotal * l.taxRatePct) / 100, 0));
    const outletRow = input.outletId
      ? await this.prisma.outlet.findFirst({ where: { id: input.outletId, organizationId: org, active: true } })
      : await this.prisma.outlet.findFirst({ where: { organizationId: org, active: true }, orderBy: { sortOrder: 'asc' } });
    if (!outletRow) problems.push('No branch is set up to take orders.');
    const open = outletRow ? isOpenAt(outletRow, now) : false;
    if (outletRow && !open) problems.push(`${outletRow.name} is closed now (open ${outletRow.opensAt}–${outletRow.closesAt}).`);
    let zone: FoodQuote['zone'] = null;
    let deliveryFee = 0;
    if (fulfilment === 'delivery') {
      if (!cfg.deliveryEnabled) problems.push('Delivery is not available; pickup only.');
      else if (input.address !== undefined) {
        const z = this.zoneFor(cfg, input.address);
        if (!z) problems.push('Sorry, we do not deliver to that area yet.');
        else {
          zone = { name: z.name, fee: z.fee, minOrder: z.minOrder, etaMinutes: z.etaMinutes };
          deliveryFee = z.fee;
          if (subtotal < z.minOrder) problems.push(`Minimum order for delivery to ${z.name} is ₹${z.minOrder}.`);
        }
      }
    } else if (!cfg.pickupEnabled) problems.push('Pickup is not available; delivery only.');
    const packagingFee = lines.length ? cfg.packagingFee : 0;
    const prep = outletRow?.prepMinutes ?? 30;
    return {
      ok: problems.length === 0 && lines.length > 0,
      problems,
      lines,
      subtotal,
      tax,
      packagingFee,
      deliveryFee,
      total: money(subtotal + tax + packagingFee + deliveryFee),
      fulfilment,
      zone,
      readyInMinutes: prep + (zone ? zone.etaMinutes : 0),
      outlet: outletRow ? { id: outletRow.id, name: outletRow.name, open, opensAt: outletRow.opensAt, closesAt: outletRow.closesAt } : null,
    };
  }

  /**
   * Create the order exactly once: the same idempotency key (webhook retry, double "confirm", double click) returns the
   * existing order. Prices are re-quoted here; a cart that is no longer valid is refused with the reasons.
   */
  async placeOrder(org: string, input: {
    customerId: string; conversationId?: string | null; channel: string; lines: FoodCartLine[]; fulfilment: 'pickup' | 'delivery'; address?: string | null;
    idempotencyKey: string; customerName?: string | null; customerPhone?: string | null; notes?: string | null; paymentMethod?: string; actor: string; isDemo?: boolean;
  }): Promise<{ status: 'created' | 'duplicate'; order: Awaited<ReturnType<FoodService['get']>> }> {
    const key = String(input.idempotencyKey ?? '').slice(0, 191);
    if (!key) throw new BadRequestException('idempotencyKey is required');
    const existing = await this.prisma.order.findUnique({ where: { organizationId_idempotencyKey: { organizationId: org, idempotencyKey: key } } });
    if (existing) return { status: 'duplicate', order: await this.get(org, existing.id) };
    const q = await this.quote(org, { lines: input.lines, fulfilment: input.fulfilment, address: input.fulfilment === 'delivery' ? input.address ?? '' : undefined });
    if (!q.ok) throw new BadRequestException(q.problems.join(' '));
    if (input.fulfilment === 'delivery' && !String(input.address ?? '').trim()) throw new BadRequestException('A delivery address is required.');
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        // Tracked stock is decremented atomically; a concurrent order that took the last portion makes this fail.
        for (const l of q.lines) {
          const item = await tx.menuItem.findUnique({ where: { id: l.itemId }, select: { stockQty: true, name: true } });
          if (item?.stockQty !== null && item?.stockQty !== undefined) {
            const r = await tx.menuItem.updateMany({ where: { id: l.itemId, stockQty: { gte: l.quantity } }, data: { stockQty: { decrement: l.quantity }, stockUpdatedAt: new Date() } });
            if (r.count === 0) throw new ConflictException(`${item.name} just sold out.`);
          }
        }
        const o = await tx.order.create({
          data: {
            organizationId: org, orderNumber: reference('FD'), customerId: input.customerId, conversationId: input.conversationId ?? null, outletId: q.outlet!.id, channel: input.channel,
            status: 'pending', pickupAt: new Date(Date.now() + q.readyInMinutes * 60_000), subtotal: q.subtotal, discount: 0, total: q.total,
            paymentMethod: input.paymentMethod ?? (input.fulfilment === 'delivery' ? 'pay_on_delivery' : 'pay_at_counter'), paymentStatus: 'unpaid',
            idempotencyKey: key, customerName: input.customerName ?? null, customerPhone: input.customerPhone ?? null, notes: input.notes?.slice(0, 1000) ?? null,
            isDemo: input.isDemo ?? false, fulfilment: input.fulfilment, deliveryAddress: input.fulfilment === 'delivery' ? String(input.address).slice(0, 500) : null,
            deliveryZone: q.zone?.name ?? null, deliveryFee: q.deliveryFee + q.packagingFee, taxAmount: q.tax,
            items: { create: q.lines.map((l) => ({ menuItemId: l.itemId, name: l.name, unit: 'piece', unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal, variant: l.variant, addOns: l.addOns as never })) },
            events: { create: { organizationId: org, type: 'created', toStatus: 'pending', actor: input.actor, note: `${input.channel} order, ${input.fulfilment}` } },
          },
        });
        return o.id;
      });
      log.info('food.order_created', { organizationId: org, orderId: id });
      return { status: 'created', order: await this.get(org, id) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.prisma.order.findUnique({ where: { organizationId_idempotencyKey: { organizationId: org, idempotencyKey: key } } });
        if (raced) return { status: 'duplicate', order: await this.get(org, raced.id) };
      }
      throw e;
    }
  }

  async get(org: string, id: string) {
    const o = await this.prisma.order.findFirst({ where: { id, organizationId: org }, include: { items: true, events: { orderBy: { createdAt: 'asc' } }, outlet: true, customer: true } });
    if (!o) throw new NotFoundException('Order not found');
    return this.orderView(o);
  }

  orderView(o: Prisma.OrderGetPayload<{ include: { items: true; events: true; outlet: true; customer: true } }>) {
    return {
      id: o.id, orderNumber: o.orderNumber, status: o.status, statusLabel: FOOD_STATUS_LABEL[o.status] ?? o.status, next: foodNextStatuses(o.status, o.fulfilment),
      channel: o.channel, fulfilment: o.fulfilment, deliveryAddress: o.deliveryAddress, deliveryZone: o.deliveryZone,
      subtotal: n(o.subtotal), taxAmount: n(o.taxAmount), fees: n(o.deliveryFee), total: n(o.total), paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus,
      readyBy: o.pickupAt.toISOString(), createdAt: o.createdAt.toISOString(), dispatchedAt: o.dispatchedAt?.toISOString() ?? null, collectedAt: o.collectedAt?.toISOString() ?? null,
      customer: { id: o.customerId, name: o.customerName ?? o.customer?.name ?? null, phone: o.customerPhone ?? o.customer?.phone ?? null },
      outlet: o.outlet ? { id: o.outlet.id, name: o.outlet.name } : null,
      items: o.items.map((i) => ({ id: i.id, name: i.name, variant: i.variant, addOns: priced(i.addOns), unitPrice: n(i.unitPrice), quantity: n(i.quantity), lineTotal: n(i.lineTotal) })),
      events: o.events.map((e) => ({ type: e.type, from: e.fromStatus, to: e.toStatus, actor: e.actor, note: e.note, at: e.createdAt.toISOString() })),
      feedbackRating: o.feedbackRating, feedbackComment: o.feedbackComment, complaintStatus: o.complaintStatus, notes: o.notes, isDemo: o.isDemo,
    };
  }

  async list(org: string, q: { status?: string; q?: string; take?: number } = {}) {
    const where: Prisma.OrderWhereInput = { organizationId: org };
    if (q.status === 'open') where.status = { in: ['pending', 'confirmed', 'preparing', 'ready', 'dispatched', 'needs_attention'] };
    else if (q.status && FOOD_STATUS_LABEL[q.status]) where.status = q.status;
    if (q.q?.trim()) where.OR = [{ orderNumber: { contains: q.q.trim() } }, { customerName: { contains: q.q.trim() } }, { customerPhone: { contains: q.q.replace(/\D/g, '') || '§' } }];
    const rows = await this.prisma.order.findMany({ where, include: { items: true, events: { orderBy: { createdAt: 'asc' } }, outlet: true, customer: true }, orderBy: { createdAt: 'desc' }, take: Math.min(q.take ?? 100, 300) });
    return rows.map((o) => this.orderView(o));
  }

  /** Staff (or the system) moves an order along its lifecycle. Invalid transitions are refused. */
  async setStatus(org: string, id: string, to: string, actor: string, note?: string) {
    const o = await this.prisma.order.findFirst({ where: { id, organizationId: org }, include: { items: true } });
    if (!o) throw new NotFoundException('Order not found');
    if (!foodNextStatuses(o.status, o.fulfilment).includes(to)) throw new BadRequestException(`Cannot move an order from "${FOOD_STATUS_LABEL[o.status] ?? o.status}" to "${FOOD_STATUS_LABEL[to] ?? to}".`);
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.order.updateMany({ where: { id, organizationId: org, status: o.status }, data: { status: to, ...(to === 'dispatched' ? { dispatchedAt: new Date() } : {}), ...(to === 'completed' ? { collectedAt: new Date() } : {}) } });
      if (u.count === 0) throw new ConflictException('The order changed meanwhile; refresh and try again.');
      if (to === 'cancelled') {
        for (const i of o.items) {
          const item = await tx.menuItem.findUnique({ where: { id: i.menuItemId }, select: { stockQty: true } });
          if (item?.stockQty !== null && item?.stockQty !== undefined) await tx.menuItem.update({ where: { id: i.menuItemId }, data: { stockQty: { increment: i.quantity } } });
        }
      }
      await tx.orderEvent.create({ data: { organizationId: org, orderId: id, type: 'status_changed', fromStatus: o.status, toStatus: to, actor, note: note?.slice(0, 500) ?? null } });
    });
    return this.get(org, id);
  }

  /** Latest orders of a customer (status enquiries). */
  async customerOrders(org: string, customerId: string, take = 3) {
    const rows = await this.prisma.order.findMany({ where: { organizationId: org, customerId }, include: { items: true, events: true, outlet: true, customer: true }, orderBy: { createdAt: 'desc' }, take });
    return rows.map((o) => this.orderView(o));
  }

  async byNumber(org: string, orderNumber: string) {
    const o = await this.prisma.order.findFirst({ where: { organizationId: org, orderNumber: orderNumber.toUpperCase() }, include: { items: true, events: true, outlet: true, customer: true } });
    return o ? this.orderView(o) : null;
  }

  /** Dashboard edit of a menu item: availability, price, stock, variants and add-ons (validated). */
  async updateItem(org: string, id: string, patch: { available?: boolean; price?: number; stockQty?: number | null; variants?: Priced[]; addOns?: Priced[]; description?: string | null }) {
    const item = await this.prisma.menuItem.findFirst({ where: { id, organizationId: org } });
    if (!item) throw new NotFoundException('Menu item not found');
    const data: Prisma.MenuItemUpdateInput = {};
    if (typeof patch.available === 'boolean') data.available = patch.available;
    if (patch.price !== undefined) {
      const p = Number(patch.price);
      if (!Number.isFinite(p) || p < 0 || p > 100_000) throw new BadRequestException('Price must be between 0 and 100000.');
      data.price = money(p);
    }
    if (patch.stockQty !== undefined) {
      if (patch.stockQty === null) data.stockQty = null;
      else {
        const s = Math.round(Number(patch.stockQty));
        if (!Number.isFinite(s) || s < 0 || s > 100_000) throw new BadRequestException('Stock must be 0 or more.');
        data.stockQty = s;
        data.stockUpdatedAt = new Date();
      }
    }
    if (patch.variants !== undefined) data.variants = priced(patch.variants) as never;
    if (patch.addOns !== undefined) data.addOns = priced(patch.addOns) as never;
    if (patch.description !== undefined) data.description = patch.description?.slice(0, 1000) ?? null;
    await this.prisma.menuItem.update({ where: { id }, data });
    const fresh = await this.prisma.menuItem.findUnique({ where: { id }, include: { category: true } });
    return this.view(fresh!);
  }

  /** Record a 1-5 rating (feedback agent / dashboard). A 1-2 rating opens a complaint for staff. */
  async recordFeedback(org: string, id: string, rating: number, comment: string | null, channel: string) {
    const r = Math.round(Number(rating));
    if (!(r >= 1 && r <= 5)) throw new BadRequestException('Rating must be 1-5.');
    const o = await this.prisma.order.findFirst({ where: { id, organizationId: org } });
    if (!o) throw new NotFoundException('Order not found');
    await this.prisma.order.update({ where: { id }, data: { feedbackRating: r, feedbackComment: comment?.slice(0, 1000) ?? null, feedbackAt: new Date(), feedbackChannel: channel, ...(r <= 2 ? { complaintStatus: 'open' } : {}) } });
    return this.get(org, id);
  }
}
