import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import { formatQty } from './chicken-parse.js';
import { outletView, type OutletView } from './catalog.service.js';
import { InsufficientStockError, releaseStockForOrder, reserveStockForOrder, stockStatus, stockText } from './inventory.js';
import { StockAlertService } from './stock-alerts.service.js';

export const MAX_LINES = 10;
/** Furthest ahead a pickup can be booked. */
export const MAX_PICKUP_DAYS = 3;

export type CartLine = { itemId: string; quantity: number; cut?: string };

export type QuoteInput = {
  organizationId: string;
  lines: CartLine[];
  outletId?: string;
  pickupAt?: Date;
  /** Offer to apply (validated here: open, not expired, this customer's). */
  claimId?: string;
  customerId?: string;
  now?: Date;
};

export type QuoteLine = { itemId: string; name: string; cut: string | null; unit: string; unitPrice: number; quantity: number; lineTotal: number };

export type Quote = {
  ok: boolean;
  /** Customer-facing reasons the order cannot be placed as it is (English; the engine words them per language). */
  problems: string[];
  lines: QuoteLine[];
  subtotal: number;
  discount: number;
  /** Why the offer was not applied (order still valid, just without the discount). */
  offerNote?: string;
  total: number;
  outlet?: OutletView & { openAtPickup: boolean };
  isDemo: boolean;
  /** Products in the quote whose stock is not recorded (NULL): the shop confirms them. */
  unknownStock?: string[];
};

export const ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Which status staff may move an order to from each status. completed = the customer collected it. */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const OPEN_CLAIM_STATUSES = ['pending_send', 'sent', 'send_failed', 'started'];

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

/** Is the shop open at this moment (IST)? Handles hours that run past midnight. */
export function isOpen(outlet: { opensAt: string; closesAt: string }, at = new Date()): boolean {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const open = toMinutes(outlet.opensAt);
  const close = toMinutes(outlet.closesAt);
  if (open === close) return true;
  return open < close ? minutes >= open && minutes < close : minutes >= open || minutes < close;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: Prisma.Decimal | number) => Number(d);
/** Float-safe "is q a multiple of step". */
const onStep = (q: number, step: number) => Math.abs(Math.round(q / step) * step - q) < 1e-6;

/**
 * Pickup orders: pricing, validation and creation. The single source of truth for prices, the offer
 * discount and totals: everything is read from the database here, never from a chat message or the model.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    /** Low-stock alerts after stock changes (optional: absent in some tests and scripts). */
    @Optional() private readonly stockAlerts?: StockAlertService,
  ) {}

  async quote(input: QuoteInput, tx: Prisma.TransactionClient = this.prisma): Promise<Quote> {
    const problems: string[] = [];
    const now = input.now ?? new Date();
    if (!input.lines.length) problems.push('Your order is empty.');
    if (input.lines.length > MAX_LINES) problems.push(`Please keep an order to ${MAX_LINES} products or fewer.`);

    const items = await tx.menuItem.findMany({ where: { organizationId: input.organizationId, id: { in: input.lines.map((l) => l.itemId) } } });
    const byId = new Map(items.map((i) => [i.id, i]));
    const lines: QuoteLine[] = [];
    let isDemo = false;
    for (const l of input.lines) {
      const item = byId.get(l.itemId);
      if (!item) {
        problems.push('A product in your order is no longer sold.');
        continue;
      }
      const unit = item.unit === 'piece' ? 'piece' : 'kg';
      const min = num(item.minQty);
      const max = num(item.maxQty);
      const step = num(item.qtyStep);
      const cuts = Array.isArray(item.cutOptions) ? (item.cutOptions as unknown[]).map(String) : [];
      const stock = stockStatus(item);
      if (!item.available || stock === 'out') problems.push(`${item.name} is not available today.`);
      else if (item.stockQty !== null && Number.isFinite(l.quantity) && l.quantity > Number(item.stockQty)) {
        // Tracked stock: never promise more than the shop has.
        problems.push(`Only ${stockText(Number(item.stockQty), item.unit)} of ${item.name} left today.`);
      }
      if (!Number.isFinite(l.quantity) || l.quantity <= 0) problems.push(`How much ${item.name} do you need?`);
      else if (l.quantity < min) problems.push(`Minimum for ${item.name} is ${formatQty(min, unit)}.`);
      else if (l.quantity > max) problems.push(`For more than ${formatQty(max, unit)} of ${item.name}, please talk to our staff (bulk order).`);
      else if (step > 0 && !onStep(l.quantity, step)) problems.push(`${item.name} is sold in steps of ${formatQty(step, unit)}.`);
      if (cuts.length && !l.cut) problems.push(`Which cut for ${item.name}?`);
      if (l.cut && cuts.length && !cuts.includes(l.cut)) problems.push(`${item.name} is not available as ${l.cut}.`);
      isDemo ||= item.isDemo;
      const unitPrice = num(item.price);
      const quantity = Number.isFinite(l.quantity) ? l.quantity : 0;
      lines.push({ itemId: item.id, name: item.name, cut: cuts.length ? l.cut ?? null : null, unit, unitPrice, quantity, lineTotal: round2(unitPrice * quantity) });
    }
    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));

    let outlet: Quote['outlet'];
    if (input.outletId) {
      const o = await tx.outlet.findFirst({ where: { id: input.outletId, organizationId: input.organizationId } });
      if (!o || !o.active) problems.push('That shop is not taking orders right now.');
      else {
        const view = outletView(o);
        const openAtPickup = input.pickupAt ? isOpen(o, input.pickupAt) : true;
        outlet = { ...view, openAtPickup };
        isDemo ||= o.isDemo;
        if (subtotal > 0 && subtotal < view.minOrderValue) problems.push(`Minimum order at ${o.name} is ₹${view.minOrderValue}.`);
        if (input.pickupAt) {
          const earliest = now.getTime() + o.prepMinutes * 60_000 - 60_000;
          if (input.pickupAt.getTime() < earliest) problems.push(`We need about ${o.prepMinutes} minutes to cut and pack. Please choose a later pickup time.`);
          if (input.pickupAt.getTime() > now.getTime() + MAX_PICKUP_DAYS * 86_400_000) problems.push(`Pickup can be booked up to ${MAX_PICKUP_DAYS} days ahead.`);
          if (!openAtPickup && !o.acceptOutsideHours) problems.push(`${o.name} is open ${o.opensAt}–${o.closesAt}. Please choose a time when the shop is open.`);
        }
      }
    }

    let discount = 0;
    let offerNote: string | undefined;
    if (input.claimId) {
      const claim = await tx.offerClaim.findFirst({ where: { id: input.claimId, organizationId: input.organizationId }, include: { campaign: true } });
      if (!claim || (input.customerId && claim.customerId !== input.customerId)) offerNote = 'offer_not_found';
      else if (!OPEN_CLAIM_STATUSES.includes(claim.status)) offerNote = 'offer_already_used';
      else if (claim.expiresAt.getTime() < now.getTime()) offerNote = 'offer_expired';
      else if (!claim.campaign.active) offerNote = 'offer_ended';
      else if (subtotal < num(claim.campaign.minOrderValue)) offerNote = `offer_min:${num(claim.campaign.minOrderValue)}`;
      // The offer takes money off an order; it never makes the order free. With no minimum configured (the seeded ₹50
      // offer has 0), a ₹48 egg order became "₹48 offer, ₹0 to pay". The order must be above the offer amount; the
      // claim stays open for a bigger order. A campaign minimum, when set higher, still applies as before.
      else if (subtotal <= num(claim.amount)) offerNote = `offer_min:${num(claim.amount)}`;
      else discount = Math.min(num(claim.amount), subtotal);
    }
    return { ok: problems.length === 0, problems, lines, subtotal, discount: round2(discount), offerNote, total: round2(subtotal - discount), outlet, isDemo, unknownStock: items.filter((i) => i.stockQty === null).map((i) => i.id) };
  }

  /**
   * Create the order exactly once. Everything is re-priced inside the transaction; if anything is no
   * longer valid nothing is written. The offer is marked claimed in the same transaction, so it can
   * only ever discount one order. Retrying with the same idempotencyKey returns the first order.
   */
  async createOrder(input: {
    organizationId: string;
    idempotencyKey: string;
    customerId: string;
    conversationId?: string;
    channel: string;
    lines: CartLine[];
    outletId: string;
    pickupAt: Date;
    paymentMethod: 'cash_at_shop' | 'upi_at_shop' | 'paid_online';
    claimId?: string;
    customerName?: string;
    customerPhone?: string;
    language?: string;
    /** Total the customer saw and said yes to. If it changed since, we do not charge the new one silently. */
    expectedTotal: number;
    now?: Date;
  }): Promise<{ status: 'created' | 'duplicate'; order: OrderView } | { status: 'rejected'; problems: string[]; quote?: Quote }> {
    const existing = await this.prisma.order.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) return { status: 'duplicate', order: await this.getOrder(input.organizationId, existing.id) };

    const customer = await this.prisma.customer.findFirst({ where: { id: input.customerId, organizationId: input.organizationId } });
    if (!customer) return { status: 'rejected', problems: ['Customer not found.'] };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const quote = await this.quote(
            { organizationId: input.organizationId, lines: input.lines, outletId: input.outletId, pickupAt: input.pickupAt, claimId: input.claimId, customerId: customer.id, now: input.now },
            tx,
          );
          if (!quote.ok) return { status: 'rejected' as const, problems: quote.problems, quote };
          if (Math.abs(quote.total - input.expectedTotal) > 0.005) {
            return { status: 'rejected' as const, problems: [`The total changed to ₹${quote.total} since you confirmed.`], quote };
          }
          const order = await tx.order.create({
            data: {
              organizationId: input.organizationId,
              orderNumber: newOrderNumber(),
              customerId: customer.id,
              conversationId: input.conversationId,
              outletId: input.outletId,
              channel: input.channel,
              status: 'pending',
              pickupAt: input.pickupAt,
              subtotal: new Prisma.Decimal(quote.subtotal.toFixed(2)),
              discount: new Prisma.Decimal(quote.discount.toFixed(2)),
              total: new Prisma.Decimal(quote.total.toFixed(2)),
              paymentMethod: input.paymentMethod,
              paymentStatus: input.paymentMethod === 'paid_online' ? 'customer_says_paid' : 'unpaid',
              posStatus: 'not_integrated',
              idempotencyKey: input.idempotencyKey,
              customerName: input.customerName ?? customer.name,
              customerPhone: input.customerPhone ?? customer.phone,
              language: input.language,
              isDemo: quote.isDemo,
              items: {
                create: quote.lines.map((l) => ({
                  menuItemId: l.itemId,
                  name: l.name,
                  cut: l.cut,
                  unit: l.unit,
                  unitPrice: new Prisma.Decimal(l.unitPrice.toFixed(2)),
                  quantity: new Prisma.Decimal(l.quantity.toFixed(3)),
                  lineTotal: new Prisma.Decimal(l.lineTotal.toFixed(2)),
                })),
              },
              events: {
                create: {
                  organizationId: input.organizationId,
                  type: 'created',
                  toStatus: 'pending',
                  actor: 'ai',
                  note: `Placed via ${input.channel} after the customer confirmed ₹${quote.total}${quote.discount ? ` (offer −₹${quote.discount})` : ''}. Not sent to any POS: staff must confirm.`,
                },
              },
            },
          });
          // The customer confirmed: take the stock now (conditional update, never below zero, once per order).
          const reserved = await reserveStockForOrder(tx, { organizationId: input.organizationId, orderId: order.id, lines: quote.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })), now: input.now });
          if (quote.discount > 0 && input.claimId) {
            // Compare-and-set: a claim that was claimed in parallel aborts this order.
            const swapped = await tx.offerClaim.updateMany({
              where: { id: input.claimId, organizationId: input.organizationId, status: { in: OPEN_CLAIM_STATUSES }, orderId: null },
              data: { status: 'claimed', orderId: order.id },
            });
            if (swapped.count !== 1) throw new OfferRaceError();
          }
          return { status: 'created' as const, orderId: order.id, reserved };
        });
        if (result.status === 'rejected') return result;
        log.info('order.created', { organizationId: input.organizationId, orderId: result.orderId, channel: input.channel, stockReserved: result.reserved.length });
        this.stockAlerts?.checkInBackground(input.organizationId, result.reserved);
        return { status: 'created', order: await this.getOrder(input.organizationId, result.orderId) };
      } catch (error) {
        if (error instanceof InsufficientStockError) {
          // Another order took the stock between the summary and this "yes": nothing was created or taken.
          return { status: 'rejected', problems: [`Only ${stockText(error.remaining, error.unit)} of ${error.itemName} left today.`] };
        }
        if (error instanceof OfferRaceError) {
          const raced = await this.prisma.order.findUnique({ where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } } });
          if (raced) return { status: 'duplicate', order: await this.getOrder(input.organizationId, raced.id) };
          return { status: 'rejected', problems: ['This offer has already been used.'] };
        }
        // Two confirmations for the last stock at the same moment: MySQL resolves the lock conflict by aborting one
        // transaction (nothing of it was written). Try again; the conditional stock update then decides cleanly.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 2) {
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
          continue;
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const raced = await this.prisma.order.findUnique({ where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } } });
          if (raced) return { status: 'duplicate', order: await this.getOrder(input.organizationId, raced.id) };
          continue; // order number collision: try a new one
        }
        throw error;
      }
    }
    throw new Error('Could not allocate an order number');
  }

  async getOrder(organizationId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId }, include: ORDER_INCLUDE });
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

  async list(organizationId: string, filter: { status?: string; q?: string; outletId?: string; limit?: number; day?: string }) {
    const q = filter.q?.trim();
    const active = ['pending', 'confirmed', 'preparing', 'ready'];
    const where: Prisma.OrderWhereInput = {
      organizationId,
      ...(filter.status && ORDER_STATUSES.includes(filter.status as OrderStatus) ? { status: filter.status } : {}),
      ...(filter.status === 'active' ? { status: { in: active } } : {}),
      ...(filter.outletId ? { outletId: filter.outletId } : {}),
      ...(q
        ? { OR: [{ orderNumber: { contains: q.toUpperCase() } }, { customerName: { contains: q } }, { customerPhone: { contains: q.replace(/\D/g, '') || q } }] }
        : {}),
    };
    const rows = await this.prisma.order.findMany({
      where,
      // Active orders by pickup time (what to cut next); history newest first.
      orderBy: filter.status === 'active' ? { pickupAt: 'asc' } : { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 100, 200),
      include: { ...ORDER_INCLUDE, events: false },
    });
    return rows.map((o) => serializeOrder({ ...o, events: [] }));
  }

  /** Staff status / payment change with transition rules and an audit event. Viewers cannot change orders. */
  async updateStatus(organizationId: string, orderId: string, input: { status?: unknown; note?: unknown; paymentStatus?: unknown }, user: { sub: string; role: string }) {
    if (user.role === 'viewer') throw new ForbiddenException('Your role can only view orders.');
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId } });
    if (!order) throw new NotFoundException('Order not found');
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : undefined;
    const actor = `user:${user.sub}`;
    let changedTo: OrderStatus | undefined;

    if (input.paymentStatus !== undefined) {
      if (input.paymentStatus !== 'paid' && input.paymentStatus !== 'unpaid') throw new BadRequestException('paymentStatus must be paid or unpaid.');
      if (input.paymentStatus !== order.paymentStatus) {
        await this.prisma.$transaction([
          this.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: input.paymentStatus } }),
          this.prisma.orderEvent.create({ data: { organizationId, orderId: order.id, type: 'payment_changed', actor, note: `Payment marked ${input.paymentStatus} by staff${note ? `: ${note}` : ''}` } }),
        ]);
      }
    }

    if (input.status !== undefined) {
      const to = input.status as OrderStatus;
      if (!ORDER_STATUSES.includes(to)) throw new BadRequestException('Unknown status.');
      const from = order.status as OrderStatus;
      if (from !== to) {
        if (!TRANSITIONS[from]?.includes(to)) throw new BadRequestException(`An order that is ${from} cannot be moved to ${to}.`);
        const swapped = await this.prisma.order.updateMany({
          where: { id: order.id, organizationId, status: from },
          data: { status: to, ...(to === 'ready' ? { readyNotice: 'pending', readyNoticeAt: new Date() } : {}), ...(to === 'completed' ? { collectedAt: new Date() } : {}) },
        });
        if (swapped.count !== 1) throw new BadRequestException('The order was just changed by someone else. Refresh and try again.');
        await this.prisma.orderEvent.create({ data: { organizationId, orderId: order.id, type: 'status_changed', fromStatus: from, toStatus: to, actor, note } });
        // A cancelled order gives the offer back so the customer can use it on a new order.
        if (to === 'cancelled') {
          await this.prisma.offerClaim.updateMany({ where: { organizationId, orderId: order.id, status: 'claimed' }, data: { status: 'started', orderId: null } });
          // ...and its reserved stock back to the shelf (once, however often this is repeated).
          const released = await releaseStockForOrder(this.prisma, { organizationId, orderId: order.id, actor });
          this.stockAlerts?.checkInBackground(organizationId, released);
        }
        changedTo = to;
        log.info('order.status_changed', { organizationId, orderId: order.id, from, to, actor });
      }
    }
    return { order: await this.getOrder(organizationId, order.id), changedTo };
  }

  /** Ready-notice bookkeeping (call / WhatsApp result), always audited. */
  async recordReadyNotice(organizationId: string, orderId: string, update: { readyNotice: string; readyCallId?: string; note?: string }) {
    await this.prisma.order.updateMany({
      where: { id: orderId, organizationId },
      data: { readyNotice: update.readyNotice, readyNoticeAt: new Date(), ...(update.readyCallId ? { readyCallId: update.readyCallId } : {}), ...(update.note ? { readyNoticeNote: update.note.slice(0, 1000) } : {}) },
    });
    await this.prisma.orderEvent.create({ data: { organizationId, orderId, type: 'ready_notice', actor: 'system', note: `${update.readyNotice}${update.note ? `: ${update.note}` : ''}`.slice(0, 1000) } });
  }
}

class OfferRaceError extends Error {}

const ORDER_INCLUDE = {
  items: { orderBy: { name: 'asc' as const } },
  outlet: { select: { id: true, name: true, area: true, phone: true, address: true, isDemo: true } },
  customer: { select: { id: true, name: true, phone: true } },
  events: { orderBy: { createdAt: 'asc' as const } },
  offerClaim: { select: { id: true, source: true, websiteOrderRef: true, amount: true } },
} satisfies Prisma.OrderInclude;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export function serializeOrder(o: OrderWithRelations) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    channel: o.channel,
    pickupAt: o.pickupAt,
    subtotal: num(o.subtotal),
    discount: num(o.discount),
    total: num(o.total),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    posStatus: o.posStatus,
    isDemo: o.isDemo,
    language: o.language,
    readyNotice: o.readyNotice,
    readyNoticeAt: o.readyNoticeAt,
    readyNoticeNote: o.readyNoticeNote,
    readyCallId: o.readyCallId,
    collectedAt: o.collectedAt,
    feedbackRating: o.feedbackRating,
    feedbackComment: o.feedbackComment,
    feedbackAt: o.feedbackAt,
    feedbackChannel: o.feedbackChannel,
    complaintStatus: o.complaintStatus,
    complaintNote: o.complaintNote,
    followUpStatus: o.followUpStatus,
    lastContactAt: o.lastContactAt,
    nextFollowUpAt: o.nextFollowUpAt,
    customerName: o.customerName ?? o.customer.name,
    customerPhone: o.customerPhone ?? o.customer.phone,
    customerId: o.customerId,
    conversationId: o.conversationId,
    outlet: o.outlet,
    offer: o.offerClaim ? { id: o.offerClaim.id, source: o.offerClaim.source, websiteOrderRef: o.offerClaim.websiteOrderRef, amount: num(o.offerClaim.amount) } : null,
    items: o.items.map((i) => ({ id: i.id, menuItemId: i.menuItemId, name: i.name, cut: i.cut, unit: i.unit, unitPrice: num(i.unitPrice), quantity: num(i.quantity), lineTotal: num(i.lineTotal) })),
    events: o.events.map((e) => ({ id: e.id, type: e.type, fromStatus: e.fromStatus, toStatus: e.toStatus, actor: e.actor, note: e.note, createdAt: e.createdAt })),
    allowedNext: TRANSITIONS[o.status as OrderStatus] ?? [],
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export type OrderView = ReturnType<typeof serializeOrder>;
