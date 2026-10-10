import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import type { OutletView } from './catalog.service.js';

export const MAX_QTY_PER_ITEM = 20;
export const MAX_LINES = 15;

export type CartLine = { itemId: string; quantity: number };

export type QuoteInput = {
  organizationId: string;
  lines: CartLine[];
  outletId?: string;
  fulfilment?: 'pickup' | 'delivery';
  deliveryArea?: string;
  now?: Date;
};

export type QuoteLine = { itemId: string; name: string; unitPrice: number; quantity: number; lineTotal: number };

export type Quote = {
  ok: boolean;
  /** Customer-facing reasons the order cannot be placed as it is. */
  problems: string[];
  lines: QuoteLine[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  outlet?: OutletView & { openNow: boolean };
  isDemo: boolean;
};

export const ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Which status a staff member may move an order to from each status. */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['out_for_delivery', 'completed', 'cancelled'],
  out_for_delivery: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const ORDER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 6 characters with at least one digit (so ordinary words are never mistaken for an order number). */
export function newOrderNumber(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ORDER_ALPHABET[randomInt(ORDER_ALPHABET.length)];
  if (!/\d/.test(s)) s = s.slice(0, 5) + String(2 + randomInt(8));
  return `GR-${s}`;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Is the outlet open at this moment (IST)? Handles hours that run past midnight. */
export function isOpen(outlet: { opensAt: string; closesAt: string }, now = new Date()): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const open = toMinutes(outlet.opensAt);
  const close = toMinutes(outlet.closesAt);
  if (open === close) return true;
  return open < close ? minutes >= open && minutes < close : minutes >= open || minutes < close;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (d: Prisma.Decimal | number) => Number(d);

/**
 * Orders: pricing, validation and creation. The single source of truth for prices and totals:
 * everything is read from the database here, never taken from a chat message or the model.
 */
@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Price and validate a cart against the current menu and outlet rules. */
  async quote(input: QuoteInput, tx: Prisma.TransactionClient = this.prisma): Promise<Quote> {
    const problems: string[] = [];
    const merged = new Map<string, number>();
    for (const l of input.lines) merged.set(l.itemId, (merged.get(l.itemId) ?? 0) + l.quantity);

    if (!merged.size) problems.push('Your cart is empty.');
    if (merged.size > MAX_LINES) problems.push(`Please keep an order to ${MAX_LINES} different items or fewer.`);

    const items = await tx.menuItem.findMany({ where: { organizationId: input.organizationId, id: { in: [...merged.keys()] } } });
    const byId = new Map(items.map((i) => [i.id, i]));
    const lines: QuoteLine[] = [];
    let isDemo = false;
    for (const [itemId, quantity] of merged) {
      const item = byId.get(itemId);
      if (!item) {
        problems.push('An item in your cart is no longer on the menu.');
        continue;
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        problems.push(`Quantity for ${item.name} must be at least 1.`);
        continue;
      }
      if (quantity > MAX_QTY_PER_ITEM) problems.push(`For more than ${MAX_QTY_PER_ITEM} × ${item.name}, please talk to our staff (bulk order).`);
      if (!item.available) problems.push(`${item.name} is not available right now.`);
      isDemo ||= item.isDemo;
      const unitPrice = money(item.price);
      lines.push({ itemId, name: item.name, unitPrice, quantity, lineTotal: round2(unitPrice * quantity) });
    }
    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));

    let outlet: Quote['outlet'];
    let deliveryFee = 0;
    if (input.outletId) {
      const o = await tx.outlet.findFirst({ where: { id: input.outletId, organizationId: input.organizationId } });
      if (!o || !o.active) problems.push('That outlet is not taking orders right now.');
      else {
        const serviceAreas = Array.isArray(o.serviceAreas) ? (o.serviceAreas as unknown[]).map((a) => String(a).toLowerCase().trim()) : [];
        const openNow = isOpen(o, input.now);
        outlet = {
          id: o.id, name: o.name, address: o.address, area: o.area, phone: o.phone, serviceAreas,
          opensAt: o.opensAt, closesAt: o.closesAt, acceptsPickup: o.acceptsPickup, acceptsDelivery: o.acceptsDelivery,
          deliveryFee: money(o.deliveryFee), minOrderValue: money(o.minOrderValue), acceptOutsideHours: o.acceptOutsideHours,
          active: o.active, isDemo: o.isDemo, openNow,
        };
        isDemo ||= o.isDemo;
        if (!openNow && !o.acceptOutsideHours) problems.push(`${o.name} is closed now (open ${o.opensAt}–${o.closesAt}).`);
        if (subtotal > 0 && subtotal < money(o.minOrderValue)) problems.push(`Minimum order at ${o.name} is ₹${money(o.minOrderValue)}.`);
        if (input.fulfilment === 'pickup' && !o.acceptsPickup) problems.push(`${o.name} does not offer pickup.`);
        if (input.fulfilment === 'delivery') {
          if (!o.acceptsDelivery) problems.push(`${o.name} does not deliver.`);
          else if (!input.deliveryArea) problems.push('Please share your delivery area.');
          else if (!serviceAreas.includes(input.deliveryArea.toLowerCase().trim())) problems.push(`${o.name} does not deliver to ${input.deliveryArea}.`);
          else deliveryFee = money(o.deliveryFee);
        }
      }
    }
    return { ok: problems.length === 0, problems, lines, subtotal, deliveryFee, total: round2(subtotal + deliveryFee), outlet, isDemo };
  }

  /**
   * Create the order exactly once. The cart is re-priced inside the transaction; if anything is no
   * longer valid nothing is written. Retrying with the same idempotencyKey returns the first order.
   */
  async createOrder(input: {
    organizationId: string;
    idempotencyKey: string;
    customerId: string;
    conversationId?: string;
    channel: string;
    lines: CartLine[];
    outletId: string;
    fulfilment: 'pickup' | 'delivery';
    deliveryAddress?: string;
    deliveryArea?: string;
    customerName?: string;
    customerPhone?: string;
    /** Total the customer saw and said yes to. If the price changed since, we do not charge the new one silently. */
    expectedTotal: number;
    now?: Date;
  }): Promise<{ status: 'created' | 'duplicate'; order: Awaited<ReturnType<OrdersService['getOrder']>> } | { status: 'rejected'; problems: string[]; quote?: Quote }> {
    const existing = await this.prisma.order.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) return { status: 'duplicate', order: await this.getOrder(input.organizationId, existing.id) };

    if (input.fulfilment === 'delivery' && !input.deliveryAddress?.trim()) return { status: 'rejected', problems: ['Please share the delivery address.'] };
    const customer = await this.prisma.customer.findFirst({ where: { id: input.customerId, organizationId: input.organizationId } });
    if (!customer) return { status: 'rejected', problems: ['Customer not found.'] };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const quote = await this.quote(
            { organizationId: input.organizationId, lines: input.lines, outletId: input.outletId, fulfilment: input.fulfilment, deliveryArea: input.deliveryArea, now: input.now },
            tx,
          );
          if (!quote.ok) return { status: 'rejected' as const, problems: quote.problems, quote };
          if (Math.abs(quote.total - input.expectedTotal) > 0.005) {
            return { status: 'rejected' as const, problems: [`The total changed to ₹${quote.total} since you confirmed (prices were updated).`], quote };
          }
          const order = await tx.order.create({
            data: {
              organizationId: input.organizationId,
              orderNumber: newOrderNumber(),
              customerId: customer.id,
              conversationId: input.conversationId,
              outletId: input.outletId,
              channel: input.channel,
              fulfilment: input.fulfilment,
              deliveryAddress: input.fulfilment === 'delivery' ? input.deliveryAddress?.trim().slice(0, 500) : null,
              deliveryArea: input.fulfilment === 'delivery' ? input.deliveryArea : null,
              status: 'pending',
              subtotal: new Prisma.Decimal(quote.subtotal.toFixed(2)),
              deliveryFee: new Prisma.Decimal(quote.deliveryFee.toFixed(2)),
              total: new Prisma.Decimal(quote.total.toFixed(2)),
              paymentMethod: input.fulfilment === 'delivery' ? 'cash_on_delivery' : 'pay_at_outlet',
              paymentStatus: 'unpaid',
              posStatus: 'not_integrated',
              idempotencyKey: input.idempotencyKey,
              customerName: input.customerName ?? customer.name,
              customerPhone: input.customerPhone ?? customer.phone,
              isDemo: quote.isDemo,
              items: {
                create: quote.lines.map((l) => ({
                  menuItemId: l.itemId,
                  name: l.name,
                  unitPrice: new Prisma.Decimal(l.unitPrice.toFixed(2)),
                  quantity: l.quantity,
                  lineTotal: new Prisma.Decimal(l.lineTotal.toFixed(2)),
                })),
              },
              events: {
                create: {
                  organizationId: input.organizationId,
                  type: 'created',
                  toStatus: 'pending',
                  actor: 'ai',
                  note: `Placed via ${input.channel} after the customer confirmed ₹${quote.total}. Not sent to any POS: staff must confirm.`,
                },
              },
            },
          });
          return { status: 'created' as const, orderId: order.id };
        });
        if (result.status === 'rejected') return result;
        log.info('order.created', { organizationId: input.organizationId, orderId: result.orderId, channel: input.channel });
        return { status: 'created', order: await this.getOrder(input.organizationId, result.orderId) };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // Either the same confirmation raced us (idempotency key) or an order number collided (retry with a new one).
          const raced = await this.prisma.order.findUnique({
            where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } },
          });
          if (raced) return { status: 'duplicate', order: await this.getOrder(input.organizationId, raced.id) };
          continue;
        }
        throw error;
      }
    }
    throw new Error('Could not allocate an order number');
  }

  async getOrder(organizationId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: {
        items: { orderBy: { name: 'asc' } },
        outlet: { select: { id: true, name: true, area: true, phone: true, isDemo: true } },
        customer: { select: { id: true, name: true, phone: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return serializeOrder(order);
  }

  async findByNumber(organizationId: string, orderNumber: string, customerId?: string) {
    const order = await this.prisma.order.findFirst({ where: { organizationId, orderNumber, ...(customerId ? { customerId } : {}) } });
    return order ? this.getOrder(organizationId, order.id) : null;
  }

  async latestForCustomer(organizationId: string, customerId: string) {
    const order = await this.prisma.order.findFirst({ where: { organizationId, customerId }, orderBy: { createdAt: 'desc' } });
    return order ? this.getOrder(organizationId, order.id) : null;
  }

  async list(organizationId: string, filter: { status?: string; q?: string; outletId?: string; limit?: number }) {
    const q = filter.q?.trim();
    const where: Prisma.OrderWhereInput = {
      organizationId,
      ...(filter.status && ORDER_STATUSES.includes(filter.status as OrderStatus) ? { status: filter.status } : {}),
      ...(filter.status === 'active' ? { status: { in: ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery'] } } : {}),
      ...(filter.outletId ? { outletId: filter.outletId } : {}),
      ...(q
        ? {
            OR: [
              { orderNumber: { contains: q.toUpperCase() } },
              { customerName: { contains: q } },
              { customerPhone: { contains: q.replace(/\D/g, '') || q } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 100, 200),
      include: {
        items: { orderBy: { name: 'asc' } },
        outlet: { select: { id: true, name: true, area: true, phone: true, isDemo: true } },
        customer: { select: { id: true, name: true, phone: true } },
      },
    });
    return rows.map((o) => serializeOrder({ ...o, events: [] }));
  }

  /** Staff status change with transition rules and an audit event. Viewers cannot change orders. */
  async updateStatus(organizationId: string, orderId: string, input: { status?: unknown; note?: unknown; paymentStatus?: unknown }, user: { sub: string; role: string }) {
    if (user.role === 'viewer') throw new ForbiddenException('Your role can only view orders.');
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId } });
    if (!order) throw new NotFoundException('Order not found');
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : undefined;
    const actor = `user:${user.sub}`;

    if (input.paymentStatus !== undefined) {
      if (input.paymentStatus !== 'paid' && input.paymentStatus !== 'unpaid') throw new BadRequestException('paymentStatus must be paid or unpaid.');
      if (input.paymentStatus !== order.paymentStatus) {
        await this.prisma.$transaction([
          this.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: input.paymentStatus } }),
          this.prisma.orderEvent.create({
            data: { organizationId, orderId: order.id, type: 'payment_changed', actor, note: `Payment marked ${input.paymentStatus} by staff${note ? `: ${note}` : ''}` },
          }),
        ]);
      }
    }

    if (input.status !== undefined) {
      const to = input.status as OrderStatus;
      if (!ORDER_STATUSES.includes(to)) throw new BadRequestException('Unknown status.');
      const from = order.status as OrderStatus;
      if (from !== to) {
        if (!TRANSITIONS[from]?.includes(to)) throw new BadRequestException(`An order that is ${from.replace(/_/g, ' ')} cannot be moved to ${to.replace(/_/g, ' ')}.`);
        if (to === 'out_for_delivery' && order.fulfilment !== 'delivery') throw new BadRequestException('Only delivery orders can go out for delivery.');
        // Compare-and-set so two staff clicking at once cannot both apply a transition.
        const swapped = await this.prisma.order.updateMany({ where: { id: order.id, organizationId, status: from }, data: { status: to } });
        if (swapped.count !== 1) throw new BadRequestException('The order was just changed by someone else. Refresh and try again.');
        await this.prisma.orderEvent.create({ data: { organizationId, orderId: order.id, type: 'status_changed', fromStatus: from, toStatus: to, actor, note } });
        log.info('order.status_changed', { organizationId, orderId: order.id, from, to, actor });
      }
    }
    return this.getOrder(organizationId, order.id);
  }
}

type OrderWithRelations = Prisma.OrderGetPayload<{
  include: {
    items: true;
    outlet: { select: { id: true; name: true; area: true; phone: true; isDemo: true } };
    customer: { select: { id: true; name: true; phone: true } };
    events: true;
  };
}>;

export function serializeOrder(o: OrderWithRelations) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    channel: o.channel,
    fulfilment: o.fulfilment,
    deliveryAddress: o.deliveryAddress,
    deliveryArea: o.deliveryArea,
    subtotal: money(o.subtotal),
    deliveryFee: money(o.deliveryFee),
    total: money(o.total),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    posStatus: o.posStatus,
    isDemo: o.isDemo,
    customerName: o.customerName ?? o.customer.name,
    customerPhone: o.customerPhone ?? o.customer.phone,
    customerId: o.customerId,
    conversationId: o.conversationId,
    outlet: o.outlet,
    items: o.items.map((i) => ({ id: i.id, menuItemId: i.menuItemId, name: i.name, unitPrice: money(i.unitPrice), quantity: i.quantity, lineTotal: money(i.lineTotal) })),
    events: o.events.map((e) => ({ id: e.id, type: e.type, fromStatus: e.fromStatus, toStatus: e.toStatus, actor: e.actor, note: e.note, createdAt: e.createdAt })),
    allowedNext: TRANSITIONS[o.status as OrderStatus]?.filter((s) => s !== 'out_for_delivery' || o.fulfilment === 'delivery') ?? [],
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export type OrderView = ReturnType<typeof serializeOrder>;
