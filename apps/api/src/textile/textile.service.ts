import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { WhatsAppSenderService, WhatsAppWindowClosedError } from '../whatsapp/whatsapp-sender.service.js';
import { DEFAULT_SETTINGS } from '../settings/tenant-settings.js';
import { errorMessage, log } from '../common/logger.js';
import {
  ORDER_TRANSITIONS,
  PAYMENT_STATUSES,
  QUOTE_TRANSITIONS,
  canMove,
  computeQuote,
  documentNumber,
  parseRating,
  type OrderStatus,
  type PaymentStatus,
  type QuoteStatus,
} from './textile-rules.js';
import { langOf, quotationMessage } from './textile-messages.js';
import { TextileEvents } from './textile-events.js';
import { ApprovalsService } from '../governance/approvals.service.js';
import { PERMISSIONS } from '../governance/permissions.js';

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const STOCK = ['in_stock', 'low', 'out_of_stock', 'unknown'];
const UNITS = ['metre', 'piece', 'kg', 'set', 'yard', 'roll'];

const REQUIREMENT_TEXT = ['buyerType', 'productInterest', 'fabricCategory', 'colour', 'quantityUnit', 'destination', 'neededBy', 'assignedTo', 'notes'] as const;

export type ProductInput = {
  sku?: string; name?: string; fabricCategory?: string; composition?: string | null; gsm?: number | null; width?: string | null;
  colour?: string | null; design?: string | null; sizes?: string | null; moq?: number | null; priceUnit?: string; currency?: string;
  price?: number | null; priceApproved?: boolean; stockStatus?: string; imageUrls?: string[]; catalogueUrl?: string | null;
  leadTimeDays?: number | null; active?: boolean;
};

export type QuotationInput = {
  customerId?: string; leadId?: string;
  items: Array<{ productId?: string; description?: string; quantity: number; unit?: string; unitPrice?: number }>;
  discount?: number; taxPercent?: number; shipping?: number; validDays?: number;
  paymentTerms?: string; deliveryTerms?: string; salesperson?: string; notes?: string; origin?: 'manual' | 'ai_request';
};

/** Only http(s) links; anything else is dropped. */
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}
const text = (v: unknown, max = 191) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * Textile catalogue, quotations, orders and feedback. Every query is scoped by organizationId; every price / status
 * change writes an AuditEvent. Nothing here invents a price, stock level or payment: they are entered by the business.
 */
@Injectable()
export class TextileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly followUps: FollowUpsService,
    private readonly leads: LeadsService,
    private readonly conversations: ConversationsService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly whatsapp?: WhatsAppSenderService,
    @Optional() private readonly approvals?: ApprovalsService,
    @Optional() private readonly events?: TextileEvents,
  ) {
    // An approved exceptional discount is executed exactly as proposed (the hash of the numbers must still match).
    approvals?.registerExecutor('quotation.discount', (a, by) => this.setQuotationStatus(a.organizationId, a.entityId, 'approved', by));
  }

  private settingsFor(organizationId: string) {
    return this.settings ? this.settings.get(organizationId) : Promise.resolve(DEFAULT_SETTINGS);
  }

  audit(organizationId: string, actor: string, entityType: string, entityId: string, action: string, data?: Record<string, unknown>) {
    return this.prisma.auditEvent
      .create({ data: { organizationId, actor: actor.slice(0, 191), entityType, entityId, action, data: (data ?? undefined) as never } })
      .catch((e: unknown) => log.error('textile.audit_failed', { entityType, entityId, action, error: errorMessage(e) }));
  }

  // ------------------------------------------------------------------ catalogue

  listProducts(organizationId: string, q: { search?: string; category?: string; active?: boolean } = {}) {
    const search = q.search?.trim();
    return this.prisma.textileProduct.findMany({
      where: {
        organizationId,
        ...(q.category ? { fabricCategory: q.category } : {}),
        ...(q.active === undefined ? {} : { active: q.active }),
        ...(search ? { OR: [{ name: { contains: search } }, { sku: { contains: search } }, { colour: { contains: search } }, { design: { contains: search } }, { fabricCategory: { contains: search } }] } : {}),
      },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      take: 500,
    });
  }

  private productData(input: ProductInput, creating: boolean) {
    const d: Record<string, unknown> = {};
    const req = (k: 'sku' | 'name' | 'fabricCategory') => {
      const v = text(input[k]);
      if (creating && !v) throw new BadRequestException(`${k} is required`);
      if (v) d[k] = v;
    };
    req('sku'); req('name'); req('fabricCategory');
    for (const k of ['composition', 'width', 'colour', 'design', 'sizes'] as const) if (input[k] !== undefined) d[k] = text(input[k]) ?? null;
    for (const k of ['gsm', 'moq', 'leadTimeDays'] as const) {
      if (input[k] === undefined) continue;
      if (input[k] === null) { d[k] = null; continue; }
      const n = Number(input[k]);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new BadRequestException(`${k} must be a whole number`);
      d[k] = n;
    }
    if (input.priceUnit !== undefined) {
      if (!UNITS.includes(input.priceUnit)) throw new BadRequestException(`priceUnit must be one of ${UNITS.join(', ')}`);
      d.priceUnit = input.priceUnit;
    }
    if (input.currency !== undefined) d.currency = /^[A-Z]{3}$/.test(input.currency) ? input.currency : 'INR';
    if (input.price !== undefined) {
      if (input.price === null) d.price = null;
      else {
        const p = Number(input.price);
        if (!Number.isFinite(p) || p < 0 || p > 10_000_000) throw new BadRequestException('price must be a positive amount');
        d.price = p;
      }
    }
    if (input.priceApproved !== undefined) d.priceApproved = Boolean(input.priceApproved);
    if (input.stockStatus !== undefined) {
      if (!STOCK.includes(input.stockStatus)) throw new BadRequestException(`stockStatus must be one of ${STOCK.join(', ')}`);
      d.stockStatus = input.stockStatus;
    }
    if (input.imageUrls !== undefined) d.imageUrls = (Array.isArray(input.imageUrls) ? input.imageUrls : []).map(safeUrl).filter(Boolean).slice(0, 10);
    if (input.catalogueUrl !== undefined) d.catalogueUrl = safeUrl(input.catalogueUrl) ?? null;
    if (input.active !== undefined) d.active = Boolean(input.active);
    return d;
  }

  async createProduct(organizationId: string, input: ProductInput, actor: string) {
    const data = this.productData(input, true);
    if (data.priceApproved && (data.price === undefined || data.price === null)) throw new BadRequestException('An approved price needs a price');
    try {
      const p = await this.prisma.textileProduct.create({ data: { ...(data as Record<string, unknown>), organizationId } as never });
      await this.audit(organizationId, actor, 'product', p.id, 'created', { sku: p.sku, price: num(p.price), priceApproved: p.priceApproved });
      return p;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('A product with this SKU already exists');
      throw e;
    }
  }

  async updateProduct(organizationId: string, id: string, input: ProductInput, actor: string) {
    const before = await this.prisma.textileProduct.findFirst({ where: { id, organizationId } });
    if (!before) throw new NotFoundException('Product not found');
    const data = this.productData(input, false);
    const price = data.price === undefined ? before.price : data.price;
    const approved = data.priceApproved === undefined ? before.priceApproved : data.priceApproved;
    if (approved && (price === null || price === undefined)) throw new BadRequestException('An approved price needs a price');
    // Changing the price withdraws the approval unless approval is given in the same change.
    if (data.price !== undefined && Number(data.price ?? -1) !== num(before.price) && data.priceApproved === undefined) data.priceApproved = false;
    const p = await this.prisma.textileProduct.update({ where: { id }, data: data as never });
    const priceChanged = num(before.price) !== num(p.price) || before.priceApproved !== p.priceApproved;
    await this.audit(organizationId, actor, 'product', id, priceChanged ? 'price_changed' : 'updated', priceChanged ? { from: num(before.price), to: num(p.price), approved: p.priceApproved } : { fields: Object.keys(data) });
    return p;
  }

  // ------------------------------------------------------------------ quotations

  private async nextNumber(organizationId: string, prefix: 'Q' | 'SO') {
    const year = new Date().getFullYear();
    const like = `${prefix}-${year}-`;
    const count = prefix === 'Q'
      ? await this.prisma.quotation.count({ where: { organizationId, number: { startsWith: like } } })
      : await this.prisma.salesOrder.count({ where: { organizationId, number: { startsWith: like } } });
    return { year, seq: count + 1 };
  }

  /** Resolve the customer (and lead) the document belongs to, inside this organization only. */
  private async owner(organizationId: string, input: { customerId?: string; leadId?: string }) {
    if (input.leadId) {
      const lead = await this.prisma.lead.findFirst({ where: { id: input.leadId, organizationId }, select: { id: true, customerId: true } });
      if (!lead) throw new NotFoundException('Lead not found');
      return { customerId: lead.customerId, leadId: lead.id };
    }
    if (!input.customerId) throw new BadRequestException('customerId or leadId is required');
    const c = await this.prisma.customer.findFirst({ where: { id: input.customerId, organizationId }, select: { id: true } });
    if (!c) throw new NotFoundException('Customer not found');
    const lead = await this.prisma.lead.findFirst({ where: { customerId: c.id, organizationId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return { customerId: c.id, leadId: lead?.id };
  }

  private async lines(organizationId: string, items: QuotationInput['items'], allowUnpriced: boolean) {
    if (!Array.isArray(items) || items.length === 0) {
      if (allowUnpriced) return [];
      throw new BadRequestException('At least one item is required');
    }
    if (items.length > 50) throw new BadRequestException('At most 50 items');
    const ids = items.map((i) => i.productId).filter((x): x is string => Boolean(x));
    const products = ids.length ? await this.prisma.textileProduct.findMany({ where: { organizationId, id: { in: ids } } }) : [];
    return items.map((i) => {
      const p = i.productId ? products.find((x) => x.id === i.productId) : undefined;
      if (i.productId && !p) throw new BadRequestException('Unknown product in items');
      const quantity = Number(i.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('Each item needs a quantity');
      // A price is either entered by the salesperson or taken from an APPROVED catalogue price - never guessed.
      let unitPrice = i.unitPrice === undefined || i.unitPrice === null ? undefined : Number(i.unitPrice);
      if (unitPrice === undefined && p?.priceApproved && p.price !== null) unitPrice = num(p.price);
      if (unitPrice === undefined) {
        if (allowUnpriced) unitPrice = 0;
        else throw new BadRequestException(`Enter a price for ${p?.name ?? i.description ?? 'the item'} (no approved catalogue price)`);
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new BadRequestException('Unit price must be 0 or more');
      return {
        productId: p?.id ?? null,
        sku: p?.sku ?? null,
        description: (text(i.description) ?? p?.name ?? 'Item').slice(0, 191),
        quantity,
        unit: i.unit && UNITS.includes(i.unit) ? i.unit : p?.priceUnit ?? 'metre',
        unitPrice,
      };
    });
  }

  async createQuotation(organizationId: string, input: QuotationInput, actor: string) {
    const who = await this.owner(organizationId, input);
    const aiRequest = input.origin === 'ai_request';
    const items = await this.lines(organizationId, input.items, aiRequest);
    const totals = computeQuote(items.length ? items : [], { discount: input.discount, taxPercent: input.taxPercent, shipping: input.shipping });
    const validUntil = input.validDays ? new Date(Date.now() + Math.min(90, Math.max(1, input.validDays)) * 86_400_000) : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { year, seq } = await this.nextNumber(organizationId, 'Q');
      try {
        const q = await this.prisma.quotation.create({
          data: {
            organizationId,
            customerId: who.customerId,
            leadId: who.leadId ?? null,
            number: documentNumber('Q', year, seq + attempt),
            status: aiRequest ? 'pending_approval' : 'draft',
            origin: aiRequest ? 'ai_request' : 'manual',
            subtotal: totals.subtotal, discount: totals.discount, taxPercent: totals.taxPercent, tax: totals.tax, shipping: totals.shipping, total: totals.total,
            validUntil,
            paymentTerms: text(input.paymentTerms), deliveryTerms: text(input.deliveryTerms), salesperson: text(input.salesperson), notes: text(input.notes, 4000),
            items: { create: items.map((it, i) => ({ ...it, lineTotal: totals.lines[i] })) },
          },
          include: { items: true },
        });
        await this.audit(organizationId, actor, 'quotation', q.id, 'created', { number: q.number, total: totals.total, origin: q.origin });
        if (who.leadId) await this.leads.advanceLeadStatus({ organizationId, leadId: who.leadId, status: 'quotation_requested' }).catch(() => undefined);
        return q;
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e; // number taken by a parallel request: next number
      }
    }
    throw new ConflictException('Could not allocate a quotation number, try again');
  }

  async updateQuotation(organizationId: string, id: string, input: Partial<QuotationInput>, actor: string) {
    const q = await this.prisma.quotation.findFirst({ where: { id, organizationId }, include: { items: true } });
    if (!q) throw new NotFoundException('Quotation not found');
    if (!['draft', 'pending_approval'].includes(q.status)) throw new BadRequestException('Only a draft or pending quotation can be edited');
    const items = input.items ? await this.lines(organizationId, input.items, false) : q.items.map((i) => ({ productId: i.productId, sku: i.sku, description: i.description, quantity: num(i.quantity), unit: i.unit, unitPrice: num(i.unitPrice) }));
    const totals = computeQuote(items, {
      discount: input.discount ?? num(q.discount),
      taxPercent: input.taxPercent ?? num(q.taxPercent),
      shipping: input.shipping ?? num(q.shipping),
    });
    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.items) await tx.quotationItem.deleteMany({ where: { quotationId: q.id } });
      return tx.quotation.update({
        where: { id: q.id },
        data: {
          subtotal: totals.subtotal, discount: totals.discount, taxPercent: totals.taxPercent, tax: totals.tax, shipping: totals.shipping, total: totals.total,
          ...(input.validDays ? { validUntil: new Date(Date.now() + Math.min(90, Math.max(1, input.validDays)) * 86_400_000) } : {}),
          ...(input.paymentTerms !== undefined ? { paymentTerms: text(input.paymentTerms) ?? null } : {}),
          ...(input.deliveryTerms !== undefined ? { deliveryTerms: text(input.deliveryTerms) ?? null } : {}),
          ...(input.salesperson !== undefined ? { salesperson: text(input.salesperson) ?? null } : {}),
          ...(input.notes !== undefined ? { notes: text(input.notes, 4000) ?? null } : {}),
          ...(input.items ? { items: { create: items.map((it, i) => ({ ...it, lineTotal: totals.lines[i] })) } } : {}),
        },
        include: { items: true },
      });
    });
    await this.audit(organizationId, actor, 'quotation', q.id, 'edited', { totalFrom: num(q.total), totalTo: totals.total });
    return updated;
  }

  listQuotations(organizationId: string, status?: string) {
    return this.prisma.quotation.findMany({
      where: { organizationId, ...(status ? { status } : {}) },
      include: { customer: { select: { id: true, name: true, phone: true } }, items: true, order: { select: { id: true, number: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  async getQuotation(organizationId: string, id: string) {
    const q = await this.prisma.quotation.findFirst({ where: { id, organizationId }, include: { customer: true, items: true, order: true } });
    if (!q) throw new NotFoundException('Quotation not found');
    const audit = await this.prisma.auditEvent.findMany({ where: { organizationId, entityType: 'quotation', entityId: id }, orderBy: { createdAt: 'asc' } });
    return { ...q, audit };
  }

  /**
   * A discount above the business's limit (Settings → textile.maxDiscountPct) needs a person with
   * sales.approve_discount. Enforced here, on the server, for every caller. Returns the approval used, or throws 409
   * after recording the request. An approval covers exactly these numbers: editing the quotation needs a new one.
   */
  private async discountApproval(organizationId: string, q: { id: string; number: string; subtotal: unknown; discount: unknown; total: unknown }, actor: string, role?: string) {
    if (!this.approvals) return undefined;
    const subtotal = num(q.subtotal), discount = num(q.discount);
    if (discount <= 0 || subtotal <= 0) return undefined;
    const limit = (await this.settingsFor(organizationId)).textile.maxDiscountPct ?? 10;
    const pct = Math.round((discount / subtotal) * 1000) / 10;
    if (pct <= limit) return undefined;
    const payload = { quotationId: q.id, number: q.number, subtotal, discount, discountPct: pct, total: num(q.total) };
    const existing = await this.approvals.findApproved(organizationId, 'quotation.discount', q.id, payload);
    if (existing) return existing.id;
    const r = await this.approvals.request(organizationId, {
      action: 'quotation.discount', entityType: 'quotation', entityId: q.id, payload, requiredPermission: PERMISSIONS.approveDiscount,
      reason: `${q.number}: discount ${pct}% is above the ${limit}% limit`, requestedBy: actor, requesterRole: role,
    });
    if (r.approved) return r.approval.id;
    throw new ConflictException({ message: `${q.number}: a ${pct}% discount is above your ${limit}% limit, so it needs approval from someone with "${PERMISSIONS.approveDiscount}". The request is in the approval queue.`, approvalId: r.approval.id });
  }

  async setQuotationStatus(organizationId: string, id: string, status: QuoteStatus, actor: string, role?: string) {
    const q = await this.prisma.quotation.findFirst({ where: { id, organizationId }, include: { items: true } });
    if (!q) throw new NotFoundException('Quotation not found');
    if (!(status in QUOTE_TRANSITIONS)) throw new BadRequestException('Unknown status');
    if (status === 'sent') throw new BadRequestException('Use "send" to send a quotation (it is marked sent only when the message really goes out)');
    if (!canMove(QUOTE_TRANSITIONS, q.status as QuoteStatus, status)) throw new BadRequestException(`Cannot move a quotation from ${q.status} to ${status}`);
    if (status === 'approved' && (q.items.length === 0 || num(q.total) <= 0 || q.items.some((i) => num(i.unitPrice) <= 0))) {
      throw new BadRequestException('Every item needs a price before the quotation can be approved');
    }
    const approvalId = status === 'approved' ? await this.discountApproval(organizationId, q, actor, role) : undefined;
    const updated = await this.prisma.quotation.update({
      where: { id },
      data: { status, ...(['accepted', 'rejected'].includes(status) ? { decidedAt: new Date() } : {}) },
    });
    await this.audit(organizationId, actor, 'quotation', id, `status:${status}`, { from: q.status, ...(approvalId ? { approvalId } : {}) });
    if (approvalId) await this.approvals?.markExecuted(organizationId, approvalId, { quotation: q.number, status });
    if (status === 'accepted' && q.leadId) await this.leads.advanceLeadStatus({ organizationId, leadId: q.leadId, status: 'negotiation' }).catch(() => undefined);
    return updated;
  }

  /**
   * Send an APPROVED quotation on WhatsApp. It is marked "sent" only after WhatsApp accepted the message; a closed
   * 24h window (no approved template for quotations) is reported, not hidden.
   */
  async sendQuotation(organizationId: string, id: string, actor: string) {
    const q = await this.prisma.quotation.findFirst({ where: { id, organizationId }, include: { items: true, customer: true } });
    if (!q) throw new NotFoundException('Quotation not found');
    if (q.status !== 'approved') throw new BadRequestException('Only an approved quotation can be sent');
    if (!q.customer.phone) throw new BadRequestException('The customer has no phone number');
    if (q.customer.doNotContact) throw new BadRequestException('The customer opted out of messages');
    if (!this.whatsapp) throw new BadRequestException('WhatsApp is not configured');
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    const message = quotationMessage(
      { number: q.number, currency: q.currency, total: num(q.total), validUntil: q.validUntil, paymentTerms: q.paymentTerms, deliveryTerms: q.deliveryTerms, items: q.items.map((i) => ({ description: i.description, quantity: num(i.quantity), unit: i.unit, unitPrice: num(i.unitPrice) })) },
      q.customer.name, org?.name ?? 'our team', langOf(q.customer.language),
    );
    const windowOpen = await this.conversations.isWhatsAppWindowOpen(organizationId, q.customerId);
    if (!windowOpen) {
      throw new ConflictException('The customer has not messaged in the last 24 hours, so WhatsApp only allows an approved template. Ask them to message you, or call them, then send.');
    }
    let messageId: string | undefined;
    try {
      messageId = await this.whatsapp.sendText(q.customer.phone, message);
    } catch (e) {
      if (e instanceof WhatsAppWindowClosedError) throw new ConflictException('WhatsApp window closed');
      await this.audit(organizationId, actor, 'quotation', id, 'send_failed', { error: errorMessage(e).slice(0, 200) });
      throw new ConflictException(`WhatsApp did not accept the message: ${errorMessage(e).slice(0, 160)}`);
    }
    const conversation = await this.conversations.getOrCreateConversation({ organizationId, channel: 'whatsapp', externalId: q.customer.phone, customerId: q.customerId });
    await this.conversations.addMessage({ organizationId, conversationId: conversation.id, role: 'assistant', content: message, externalId: messageId, metadata: { quotationId: q.id } as never });
    const sent = await this.prisma.quotation.update({ where: { id }, data: { status: 'sent', sentAt: new Date() } });
    await this.audit(organizationId, actor, 'quotation', id, 'sent', { messageId });
    if (q.leadId) await this.leads.advanceLeadStatus({ organizationId, leadId: q.leadId, status: 'quotation_sent' }).catch(() => undefined);
    const s = await this.settingsFor(organizationId);
    if (s.textile.quoteReminderDays > 0 && q.leadId) {
      await this.followUps.create({
        organizationId, leadId: q.leadId, customerId: q.customerId, channel: 'whatsapp', action: 'message', source: 'quote',
        message: `quote:reminder:${q.id}`, scheduledAt: new Date(Date.now() + s.textile.quoteReminderDays * 86_400_000),
      }).catch((e) => log.error('textile.quote_reminder_failed', { quotationId: q.id, error: errorMessage(e) }));
    }
    return sent;
  }

  /** Accepted quotation -> order, exactly once (unique quotationId); a second call returns the same order. */
  async convertToOrder(organizationId: string, id: string, actor: string, extra: { expectedDelivery?: string; shippingAddress?: string } = {}) {
    const q = await this.prisma.quotation.findFirst({ where: { id, organizationId }, include: { items: true, order: true } });
    if (!q) throw new NotFoundException('Quotation not found');
    if (q.order) return { order: q.order, duplicate: true };
    if (q.status !== 'accepted') throw new BadRequestException('Only an accepted quotation can become an order');
    for (let attempt = 0; attempt < 5; attempt++) {
      const { year, seq } = await this.nextNumber(organizationId, 'SO');
      try {
        const order = await this.prisma.salesOrder.create({
          data: {
            organizationId, customerId: q.customerId, leadId: q.leadId, quotationId: q.id,
            number: documentNumber('SO', year, seq + attempt),
            status: 'pending_confirmation', currency: q.currency, total: q.total, salesperson: q.salesperson,
            expectedDelivery: extra.expectedDelivery && !Number.isNaN(Date.parse(extra.expectedDelivery)) ? new Date(extra.expectedDelivery) : null,
            shippingAddress: text(extra.shippingAddress, 2000),
            items: { create: q.items.map((i) => ({ productId: i.productId, sku: i.sku, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, lineTotal: i.lineTotal })) },
          },
          include: { items: true },
        });
        await this.audit(organizationId, actor, 'order', order.id, 'created_from_quotation', { quotation: q.number, total: num(order.total) });
        return { order, duplicate: false };
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        const existing = await this.prisma.salesOrder.findFirst({ where: { organizationId, quotationId: q.id } });
        if (existing) return { order: existing, duplicate: true }; // a parallel convert won
      }
    }
    throw new ConflictException('Could not allocate an order number, try again');
  }

  // ------------------------------------------------------------------ orders

  listOrders(organizationId: string, status?: string) {
    return this.prisma.salesOrder.findMany({
      where: { organizationId, ...(status ? { status } : {}) },
      include: { customer: { select: { id: true, name: true, phone: true } }, items: true, quotation: { select: { id: true, number: true } }, feedback: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  async getOrder(organizationId: string, id: string) {
    const o = await this.prisma.salesOrder.findFirst({ where: { id, organizationId }, include: { customer: true, items: true, quotation: true, feedback: true } });
    if (!o) throw new NotFoundException('Order not found');
    const audit = await this.prisma.auditEvent.findMany({ where: { organizationId, entityType: 'order', entityId: id }, orderBy: { createdAt: 'asc' } });
    return { ...o, audit };
  }

  async setOrderStatus(organizationId: string, id: string, status: OrderStatus, actor: string) {
    const o = await this.prisma.salesOrder.findFirst({ where: { id, organizationId } });
    if (!o) throw new NotFoundException('Order not found');
    if (!(status in ORDER_TRANSITIONS)) throw new BadRequestException('Unknown status');
    if (!canMove(ORDER_TRANSITIONS, o.status as OrderStatus, status)) throw new BadRequestException(`Cannot move an order from ${o.status} to ${status}`);
    if (o.status === status) return o;
    const event = { organizationId, orderId: o.id, orderNumber: o.number, from: o.status, to: status, actor };
    await this.events?.beforeOrderStatus(event); // e.g. Operations: no dispatch before the stock is reserved
    // Compare-and-swap: a parallel change wins once, never twice.
    const swapped = await this.prisma.salesOrder.updateMany({
      where: { id, organizationId, status: o.status },
      data: { status, ...(status === 'delivered' ? { deliveredAt: new Date() } : {}) },
    });
    if (swapped.count === 0) throw new ConflictException('The order changed meanwhile; reload and try again');
    await this.audit(organizationId, actor, 'order', id, `status:${status}`, { from: o.status });
    const s = await this.settingsFor(organizationId);
    if (o.leadId) {
      if (status === 'confirmed') {
        const earlier = await this.prisma.salesOrder.count({ where: { organizationId, customerId: o.customerId, id: { not: o.id }, status: { in: ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered'] } } });
        await this.leads.advanceLeadStatus({ organizationId, leadId: o.leadId, status: earlier ? 'repeat_customer' : 'order_confirmed' }).catch(() => undefined);
      }
      // Customer updates go through the follow-up queue (retried, opt-out checked, recorded in the conversation).
      if (s.textile.notifyOrderStatus && ['confirmed', 'dispatched', 'delivered'].includes(status)) {
        await this.followUps.create({ organizationId, leadId: o.leadId, customerId: o.customerId, channel: 'whatsapp', action: 'message', source: 'order', message: `order:status:${o.id}:${status}`, scheduledAt: new Date() })
          .catch((e) => log.error('textile.order_notify_failed', { orderId: o.id, error: errorMessage(e) }));
      }
      if (status === 'delivered' && s.textile.feedbackAfterHours > 0) {
        await this.followUps.create({ organizationId, leadId: o.leadId, customerId: o.customerId, channel: 'whatsapp', action: 'message', source: 'feedback', message: `feedback:request:${o.id}`, scheduledAt: new Date(Date.now() + s.textile.feedbackAfterHours * 3_600_000) })
          .catch((e) => log.error('textile.feedback_schedule_failed', { orderId: o.id, error: errorMessage(e) }));
      }
    }
    await this.events?.orderStatus(event); // Operations reserves / releases / deducts stock (recorded as agent tasks)
    return { ...o, status };
  }

  async setPaymentStatus(organizationId: string, id: string, paymentStatus: PaymentStatus, actor: string) {
    if (!PAYMENT_STATUSES.includes(paymentStatus)) throw new BadRequestException('paymentStatus must be unpaid, partial or paid');
    const o = await this.prisma.salesOrder.findFirst({ where: { id, organizationId } });
    if (!o) throw new NotFoundException('Order not found');
    // Once an invoice is approved / issued, payment status follows VERIFIED payments only (Finance); not set by hand.
    const inv = await this.prisma.invoice.findFirst({ where: { organizationId, orderId: id, activeKey: { not: null }, status: { not: 'draft' } }, select: { number: true } }).catch(() => null);
    if (inv) throw new ConflictException(`Payment status of ${o.number} follows verified payments on invoice ${inv.number}. Record and verify the payment under Finance.`);
    if (o.paymentStatus === paymentStatus) return o;
    const updated = await this.prisma.salesOrder.update({ where: { id }, data: { paymentStatus } });
    await this.audit(organizationId, actor, 'order', id, 'payment_status', { from: o.paymentStatus, to: paymentStatus, note: 'manually recorded' });
    return updated;
  }

  // ------------------------------------------------------------------ feedback

  listFeedback(organizationId: string, status?: string) {
    return this.prisma.feedback.findMany({
      where: { organizationId, ...(status ? { status } : {}) },
      include: { customer: { select: { id: true, name: true, phone: true } }, order: { select: { id: true, number: true } } },
      orderBy: { requestedAt: 'desc' },
      take: 300,
    });
  }

  /** One feedback request per order (unique orderId): a second request for the same order returns undefined. */
  async openFeedbackRequest(organizationId: string, orderId: string, customerId: string) {
    try {
      return await this.prisma.feedback.create({ data: { organizationId, customerId, orderId, status: 'requested' } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return undefined;
      throw e;
    }
  }

  /** The customer's reply to a feedback request. Ratings 1-3 or no rating with a complaint need a person. */
  async captureFeedback(organizationId: string, customerId: string, reply: string) {
    const open = await this.prisma.feedback.findFirst({ where: { organizationId, customerId, status: 'requested' }, orderBy: { requestedAt: 'desc' }, include: { order: true } });
    if (!open) return undefined;
    const rating = parseRating(reply);
    const complaint = /(problem|issue|bad|poor|damage|defect|late|wrong|complain|மோசம்|சரியில்ல|பிரச்சனை|problem-?ஆ)/iu.test(reply);
    if (rating === undefined && !complaint) return undefined;
    const needsAction = (rating !== undefined && rating <= 3) || (rating === undefined && complaint);
    const updated = await this.prisma.feedback.update({
      where: { id: open.id },
      data: { rating: rating ?? null, comment: reply.slice(0, 2000), status: needsAction ? 'needs_action' : 'received', receivedAt: new Date() },
    });
    if (needsAction && open.order?.leadId) {
      await this.followUps.createHumanTask({ organizationId, leadId: open.order.leadId, customerId, reason: `Negative feedback on order ${open.order.number}${rating ? ` (rating ${rating}/5)` : ''}: ${reply.slice(0, 200)}` });
    }
    await this.audit(organizationId, 'customer', 'feedback', open.id, needsAction ? 'negative_received' : 'received', { rating });
    return updated;
  }

  async resolveFeedback(organizationId: string, id: string, input: { resolution?: string; owner?: string }, actor: string) {
    const f = await this.prisma.feedback.findFirst({ where: { id, organizationId } });
    if (!f) throw new NotFoundException('Feedback not found');
    if (f.status !== 'needs_action') throw new BadRequestException('Only feedback that needs action can be resolved');
    if (!text(input.resolution, 2000)) throw new BadRequestException('Describe what was done');
    const updated = await this.prisma.feedback.update({ where: { id }, data: { status: 'resolved', resolution: text(input.resolution, 2000), owner: text(input.owner) ?? actor, resolvedAt: new Date() } });
    await this.audit(organizationId, actor, 'feedback', id, 'resolved', {});
    return updated;
  }

  // ------------------------------------------------------------------ buyer requirement (AI + salesperson)

  /**
   * Only these fields can be written - the body never chooses organizationId / leadId / ids. Text is trimmed and
   * capped; quantity and target price must be positive numbers; null or an empty string clears a field.
   */
  async saveRequirement(organizationId: string, leadId: string, data: Record<string, unknown>) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, organizationId }, select: { id: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    const clean: Record<string, unknown> = {};
    const input = data && typeof data === 'object' ? data : {};
    // undefined = leave as is; null or "" = clear.
    for (const k of REQUIREMENT_TEXT) {
      const v = input[k];
      if (v === undefined) continue;
      if (v !== null && typeof v !== 'string') throw new BadRequestException(`${k} must be text`);
      clean[k] = v && v.trim() ? v.trim().slice(0, k === 'notes' ? 4000 : 191) : null;
    }
    for (const k of ['quantity', 'targetPrice'] as const) {
      const v = input[k];
      if (v === undefined) continue;
      if (v === null || v === '') { clean[k] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) throw new BadRequestException(`${k} must be a positive number`);
      clean[k] = n;
    }
    return this.prisma.textileRequirement.upsert({ where: { leadId }, create: { organizationId, leadId, ...clean } as never, update: clean as never });
  }

  /** Everything textile about one lead, for the lead page: the buyer requirement, its quotations and orders. */
  async forLead(organizationId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, organizationId }, select: { id: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    const [requirement, quotations, orders] = await Promise.all([
      this.prisma.textileRequirement.findFirst({ where: { leadId, organizationId } }),
      this.prisma.quotation.findMany({ where: { organizationId, leadId }, include: { items: true, order: { select: { id: true, number: true, status: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.salesOrder.findMany({ where: { organizationId, leadId }, include: { feedback: true }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return { requirement, quotations, orders };
  }

  private async salesExtras(organizationId: string, since: Date) {
    const [qualified, created, awaiting] = await Promise.all([
      this.prisma.lead.count({ where: { organizationId, createdAt: { gte: since }, status: { notIn: ['new', 'contacted', 'not_interested', 'lost'] } } }),
      this.prisma.quotation.count({ where: { organizationId, createdAt: { gte: since } } }),
      this.prisma.quotation.count({ where: { organizationId, status: 'sent' } }),
    ]);
    return { qualifiedEnquiries: qualified, quotationsCreated: created, quotationsAwaitingResponse: awaiting };
  }

  /** Counted stock and fulfilment (Operations agent). Untracked products are not counted as in stock. */
  private async operationsExtras(organizationId: string) {
    const [balances, open, procurement] = await Promise.all([
      this.prisma.inventoryBalance.findMany({ where: { organizationId }, select: { productId: true, onHand: true, reserved: true, lowStockAt: true } }),
      this.prisma.salesOrder.findMany({ where: { organizationId, status: { in: ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched'] } }, select: { status: true, expectedDelivery: true } }),
      this.prisma.workTask.count({ where: { organizationId, agent: 'operations', kind: 'procurement', status: { in: ['open', 'in_progress'] } } }),
    ]);
    const now = new Date();
    const avail = (b: (typeof balances)[number]) => num(b.onHand) - num(b.reserved);
    return {
      trackedProducts: new Set(balances.map((b) => b.productId)).size,
      lowStock: balances.filter((b) => b.lowStockAt !== null && avail(b) > 0 && avail(b) <= num(b.lowStockAt)).length,
      outOfStock: balances.filter((b) => avail(b) <= 0).length,
      reservedUnits: Math.round(balances.reduce((a, b) => a + num(b.reserved), 0) * 100) / 100,
      ordersAwaitingFulfilment: open.filter((o) => o.status !== 'dispatched').length,
      dispatched: open.filter((o) => o.status === 'dispatched').length,
      delayedOrders: open.filter((o) => o.expectedDelivery && o.expectedDelivery < now).length,
      openProcurementTasks: procurement,
    };
  }

  /** Invoices and VERIFIED collections (Finance). Unverified payment claims are never counted as collected. */
  private async financeExtras(organizationId: string, since: Date) {
    const [invoiced, collected, open, pending, exceptions] = await Promise.all([
      this.prisma.invoice.aggregate({ where: { organizationId, invoiceDate: { gte: since }, status: { in: ['issued', 'partially_paid', 'paid'] } }, _sum: { total: true } }),
      this.prisma.payment.aggregate({ where: { organizationId, status: 'verified', verifiedAt: { gte: since } }, _sum: { amount: true } }),
      this.prisma.invoice.findMany({ where: { organizationId, status: { in: ['issued', 'partially_paid'] } }, select: { total: true, amountPaid: true, dueDate: true } }),
      this.prisma.payment.count({ where: { organizationId, status: 'pending_verification' } }),
      this.prisma.workTask.count({ where: { organizationId, agent: 'finance', kind: 'reconciliation', status: { in: ['open', 'in_progress'] } } }),
    ]);
    const today = new Date(new Date().toDateString());
    const due = open.map((i) => ({ amt: num(i.total) - num(i.amountPaid), late: Boolean(i.dueDate && i.dueDate < today) })).filter((x) => x.amt > 0.005);
    const r = (v: number) => Math.round(v * 100) / 100;
    return {
      invoiced: r(num(invoiced._sum.total)),
      collectedVerified: r(num(collected._sum.amount)),
      outstanding: r(due.reduce((a, x) => a + x.amt, 0)),
      overdue: r(due.filter((x) => x.late).reduce((a, x) => a + x.amt, 0)),
      overdueInvoices: due.filter((x) => x.late).length,
      paymentsAwaitingVerification: pending,
      reconciliationExceptions: exceptions,
    };
  }

  private async agentExtras(organizationId: string, since: Date) {
    const [completed, failed, pendingApprovals, openTeamTasks, aiDrafts] = await Promise.all([
      this.prisma.agentTask.count({ where: { organizationId, status: 'COMPLETED', createdAt: { gte: since } } }),
      this.prisma.agentTask.count({ where: { organizationId, status: 'FAILED', createdAt: { gte: since } } }),
      this.prisma.approval.count({ where: { organizationId, status: 'pending' } }),
      this.prisma.workTask.count({ where: { organizationId, status: { in: ['open', 'in_progress'] } } }),
      this.prisma.contentRevision.count({ where: { organizationId, source: 'ai', createdAt: { gte: since } } }),
    ]);
    // modelCalls = recorded model calls by agents (Marketing drafts). Conversation-assistant calls are in the logs only.
    return { tasksCompleted: completed, tasksFailed: failed, pendingApprovals, openTeamTasks, modelCalls: aiDrafts };
  }

  /** Campaign-attributed enquiries (a reply to a delivered campaign message) and what followed, in the period. */
  private async marketingExtras(organizationId: string, since: Date) {
    const recipients = await this.prisma.campaignRecipient.findMany({ where: { organizationId, leadId: { not: null }, repliedAt: { gte: since } }, select: { leadId: true } });
    const leadIds = [...new Set(recipients.map((r) => r.leadId!))];
    const [quotations, orders, campaignsSent] = await Promise.all([
      leadIds.length ? this.prisma.quotation.count({ where: { organizationId, leadId: { in: leadIds } } }) : 0,
      leadIds.length ? this.prisma.salesOrder.findMany({ where: { organizationId, leadId: { in: leadIds }, status: { in: ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered'] } }, select: { id: true, total: true } }) : [],
      this.prisma.marketingCampaign.count({ where: { organizationId, startedAt: { gte: since }, simulated: false } }),
    ]);
    const verified = orders.length ? await this.prisma.payment.aggregate({ where: { organizationId, orderId: { in: orders.map((o) => o.id) }, status: 'verified' }, _sum: { amount: true } }) : null;
    return { campaignsSent, attributedEnquiries: leadIds.length, attributedQuotations: quotations, attributedOrders: orders.length, attributedVerifiedCollections: Math.round(num(verified?._sum.amount ?? 0) * 100) / 100 };
  }

  // ------------------------------------------------------------------ overview

  /**
   * Metrics with their definitions. Revenue = total of orders confirmed or later (not cash received unless the
   * payment status says paid, which is manually recorded). Meta ad spend is reported unavailable: no Marketing API
   * access is configured; cost per lead is the Settings estimate.
   */
  async overview(organizationId: string, days = 30) {
    const since = new Date(Date.now() - Math.min(365, Math.max(1, days)) * 86_400_000);
    const live = ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered'];
    const [leads, quotesSent, quotesAccepted, orders, calls, feedback, products, openTasks, s] = await Promise.all([
      this.prisma.lead.count({ where: { organizationId, createdAt: { gte: since } } }),
      this.prisma.quotation.count({ where: { organizationId, sentAt: { gte: since } } }),
      this.prisma.quotation.count({ where: { organizationId, status: 'accepted', decidedAt: { gte: since } } }),
      this.prisma.salesOrder.findMany({ where: { organizationId, createdAt: { gte: since } }, select: { status: true, total: true, paymentStatus: true, leadId: true, quotationId: true } }),
      this.prisma.call.findMany({ where: { organizationId, createdAt: { gte: since }, direction: 'outbound' }, select: { answeredAt: true, durationSec: true, status: true } }),
      this.prisma.feedback.findMany({ where: { organizationId, requestedAt: { gte: since } }, select: { status: true, rating: true } }),
      this.prisma.textileProduct.count({ where: { organizationId, active: true } }),
      this.prisma.followUp.count({ where: { organizationId, channel: 'human', status: 'open' } }),
      this.settingsFor(organizationId),
    ]);
    const confirmed = orders.filter((o) => live.includes(o.status));
    const revenue = confirmed.reduce((a, o) => a + num(o.total), 0);
    const paid = confirmed.filter((o) => o.paymentStatus === 'paid').reduce((a, o) => a + num(o.total), 0);
    const answered = calls.filter((c) => c.answeredAt);
    const durations = answered.map((c) => c.durationSec ?? 0).filter((d) => d > 0);
    const ratings = feedback.map((f) => f.rating).filter((r): r is number => typeof r === 'number');
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
    const leadsWithOrder = new Set(confirmed.map((o) => o.leadId).filter(Boolean)).size;
    return {
      days,
      since,
      catalogue: { activeProducts: products },
      leads: { total: leads },
      quotations: { sent: quotesSent, accepted: quotesAccepted, acceptRatePct: pct(quotesAccepted, quotesSent) },
      orders: {
        confirmed: confirmed.length,
        pendingConfirmation: orders.filter((o) => o.status === 'pending_confirmation').length,
        cancelled: orders.filter((o) => o.status === 'cancelled').length,
        recordedRevenue: Math.round(revenue * 100) / 100,
        paidRevenue: Math.round(paid * 100) / 100,
        leadToOrderPct: pct(leadsWithOrder, leads),
        quoteToOrderPct: pct(confirmed.filter((o) => o.quotationId).length, quotesSent),
      },
      calls: {
        attempted: calls.length,
        answered: answered.length,
        notAnswered: calls.length - answered.length,
        answerRatePct: pct(answered.length, calls.length),
        avgDurationSec: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      },
      feedback: {
        requested: feedback.length,
        received: feedback.filter((f) => f.status !== 'requested').length,
        avgRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
        needsAction: feedback.filter((f) => f.status === 'needs_action').length,
      },
      tasks: { openHandoffs: openTasks },
      sales: await this.salesExtras(organizationId, since),
      operations: await this.operationsExtras(organizationId),
      agents: await this.agentExtras(organizationId, since),
      marketing: await this.marketingExtras(organizationId, since),
      finance: await this.financeExtras(organizationId, since),
      meta: { spendAvailable: false, reason: 'Meta Marketing API (ads_read) is not connected; ad spend and campaign ROI are not shown.', costPerLeadEstimateInr: s.roi.costPerLeadInr },
      definitions: {
        recordedRevenue: 'Sum of order totals with status confirmed or later in the period (recorded value, not cash).',
        paidRevenue: 'Same orders with payment status "paid" (manually recorded by the team).',
        answerRatePct: 'Outbound AI calls answered (Plivo answer event) / outbound calls attempted in the period. Ringing is not answered.',
        leadToOrderPct: 'Distinct leads with a confirmed order / leads created in the period.',
        quoteToOrderPct: 'Confirmed orders created from a quotation / quotations sent in the period.',
      },
    };
  }
}
