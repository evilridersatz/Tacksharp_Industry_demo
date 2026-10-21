import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { DEFAULT_SETTINGS } from '../settings/tenant-settings.js';
import { errorMessage, log } from '../common/logger.js';
import { ApprovalsService } from '../governance/approvals.service.js';
import { WorkTasksService } from '../governance/work-tasks.service.js';
import { PERMISSIONS, can } from '../governance/permissions.js';
import { computeQuote, documentNumber } from '../textile/textile-rules.js';
import { FinanceEvents } from './finance-events.js';

type Tx = Prisma.TransactionClient;
type User = { sub: string; role?: string };

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const DAY = 86_400_000;
const INVOICEABLE_ORDER = ['confirmed', 'processing', 'ready_to_dispatch', 'dispatched', 'delivered'];
const OPEN_INVOICE = ['issued', 'partially_paid'];
const METHODS = ['upi', 'bank_transfer', 'cash', 'cheque', 'card', 'gateway', 'other'];
const INVOICE_NEXT: Record<string, string[]> = { draft: ['approved', 'cancelled'], approved: ['draft', 'issued', 'cancelled'], issued: ['cancelled'], partially_paid: ['cancelled'], paid: ['cancelled'], cancelled: [] };

/** "UTR 4521-88/77" and "utr452188 77" are the same transaction: letters and digits only, upper case. */
export const referenceKey = (ref?: string | null) => {
  const k = (ref ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return k.length >= 4 ? k.slice(0, 120) : null;
};

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const daysOverdue = (dueDate: Date | null, now = new Date()) => (dueDate ? Math.max(0, Math.floor((startOfDay(now).getTime() - startOfDay(dueDate).getTime()) / DAY)) : 0);

/**
 * Finance for textile orders.
 *  - An invoice is created from a confirmed order: lines copied, totals recomputed on the server with the
 *    QUOTATION's agreed discount / tax / shipping (tax is never assumed; a manual order needs it entered).
 *    One live invoice per order. The order and quotation are never changed by invoicing.
 *  - A payment is RECORDED as pending_verification. Only a person with finance.verify_payment, stating the evidence
 *    they checked, verifies it (or, later, a trusted provider adapter). Verification re-checks duplicates and
 *    overpayment under a row lock, then updates the invoice and the order's payment status in the same transaction.
 *  - Reversal of a verified payment goes through an approval. Nothing here moves money.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly workTasks: WorkTasksService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly events?: FinanceEvents,
  ) {
    approvals.registerExecutor('payment.reverse', async (a, by) => {
      const p = a.payload as { paymentId: string; reason: string };
      return this.applyReversal(a.organizationId, p.paymentId, by, p.reason, a.id);
    });
  }

  private settingsFor(organizationId: string) {
    return this.settings ? this.settings.get(organizationId) : Promise.resolve(DEFAULT_SETTINGS);
  }

  private audit(db: Tx | PrismaService, organizationId: string, actor: string, entityType: string, entityId: string, action: string, data?: Record<string, unknown>) {
    return db.auditEvent.create({ data: { organizationId, actor: actor.slice(0, 191), entityType, entityId, action, data: (data ?? undefined) as never } });
  }

  private async nextNumber(organizationId: string) {
    const year = new Date().getFullYear();
    const count = await this.prisma.invoice.count({ where: { organizationId, number: { startsWith: `INV-${year}-` } } });
    return { year, seq: count + 1 };
  }

  // ------------------------------------------------------------------ invoices

  /** Draft invoice for a confirmed order. A second request for the same order returns the existing invoice. */
  async createInvoice(organizationId: string, orderId: string, actor: string, input: { taxPercent?: number | null; dueDays?: number; notes?: string } = {}) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id: orderId, organizationId }, include: { items: true, quotation: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (!INVOICEABLE_ORDER.includes(order.status)) throw new BadRequestException(`An invoice can be made only for a confirmed order (${order.number} is ${order.status.replace(/_/g, ' ')})`);
    const existing = await this.prisma.invoice.findFirst({ where: { organizationId, orderId, activeKey: { not: null } } });
    if (existing) return { invoice: existing, duplicate: true };
    if (!order.items.length) throw new BadRequestException('The order has no lines');

    let taxPercent: number;
    let taxSource: 'quotation' | 'entered';
    if (order.quotation) {
      taxPercent = n(order.quotation.taxPercent);
      taxSource = 'quotation';
    } else {
      if (input.taxPercent === undefined || input.taxPercent === null || !Number.isFinite(Number(input.taxPercent))) {
        throw new BadRequestException(`${order.number} has no quotation terms: enter the tax % to charge (Tacksharp does not assume a tax rate)`);
      }
      taxPercent = Number(input.taxPercent);
      if (taxPercent < 0 || taxPercent > 100) throw new BadRequestException('Tax % must be between 0 and 100');
      taxSource = 'entered';
    }
    const discount = order.quotation ? n(order.quotation.discount) : 0;
    const shipping = order.quotation ? n(order.quotation.shipping) : 0;
    const totals = computeQuote(order.items.map((i) => ({ quantity: n(i.quantity), unitPrice: n(i.unitPrice) })), { discount, taxPercent, shipping });
    if (taxSource === 'quotation' && Math.abs(totals.total - n(order.total)) > 0.01) {
      throw new ConflictException(`Recomputed total ₹${totals.total} differs from the order total ₹${n(order.total)}; check ${order.number} before invoicing`);
    }
    const s = await this.settingsFor(organizationId);
    const dueDays = input.dueDays !== undefined ? Math.min(365, Math.max(0, Math.round(Number(input.dueDays) || 0))) : s.finance?.paymentTermsDays ?? 15;

    for (let attempt = 0; attempt < 5; attempt++) {
      const { year, seq } = await this.nextNumber(organizationId);
      try {
        const invoice = await this.prisma.$transaction(async (tx) => {
          const inv = await tx.invoice.create({
            data: {
              organizationId, number: documentNumber('INV', year, seq + attempt), orderId, customerId: order.customerId, status: 'draft', activeKey: `${organizationId}:${orderId}`,
              currency: order.currency, subtotal: totals.subtotal, discount: totals.discount, taxPercent: totals.taxPercent, tax: totals.tax, shipping: totals.shipping, total: totals.total,
              taxSource, notes: input.notes?.trim().slice(0, 4000) || `Order ${order.number}${order.quotation ? `, quotation ${order.quotation.number}` : ''}. Payment due ${dueDays} days from the invoice date.`,
              createdBy: actor.slice(0, 191),
              items: { create: order.items.map((i, k) => ({ productId: i.productId, sku: i.sku, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, lineTotal: totals.lines[k] })) },
            },
          });
          await this.audit(tx, organizationId, actor, 'invoice', inv.id, 'created', { order: order.number, total: totals.total, taxPercent, taxSource, dueDays });
          return inv;
        });
        return { invoice, duplicate: false };
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        const again = await this.prisma.invoice.findFirst({ where: { organizationId, orderId, activeKey: { not: null } } });
        if (again) return { invoice: again, duplicate: true }; // a parallel request created it
        // otherwise the number collided: try the next one
      }
    }
    throw new ConflictException('Could not allocate an invoice number, try again');
  }

  async setInvoiceStatus(organizationId: string, id: string, to: string, user: User, input: { reason?: string; dueDate?: string } = {}) {
    const inv = await this.prisma.invoice.findFirst({ where: { id, organizationId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (!(INVOICE_NEXT[inv.status] ?? []).includes(to)) {
      throw new BadRequestException(['partially_paid', 'paid'].includes(to) ? 'Paid / part paid follow verified payments; record and verify a payment instead' : `An invoice cannot move from ${inv.status.replace(/_/g, ' ')} to ${to.replace(/_/g, ' ')}`);
    }
    if (!can(user.role, PERMISSIONS.approveInvoice)) throw new ForbiddenException(`You need the "${PERMISSIONS.approveInvoice}" permission`);
    const actor = `user:${user.sub}`;
    const data: Record<string, unknown> = { status: to };
    if (to === 'cancelled') {
      if (!input.reason?.trim()) throw new BadRequestException('Give the reason for cancelling');
      const verified = await this.prisma.payment.count({ where: { organizationId, invoiceId: id, status: 'verified' } });
      if (verified) throw new ConflictException('This invoice has verified payments; reverse them (with approval) before cancelling');
      Object.assign(data, { activeKey: null, cancelledAt: new Date(), cancelReason: input.reason.trim().slice(0, 2000) });
    }
    if (to === 'issued') {
      const s = await this.settingsFor(organizationId);
      const invoiceDate = new Date();
      let due = input.dueDate ? new Date(input.dueDate) : new Date(startOfDay(invoiceDate).getTime() + (s.finance?.paymentTermsDays ?? 15) * DAY);
      if (Number.isNaN(due.getTime()) || due < startOfDay(invoiceDate)) throw new BadRequestException('Due date must be today or later');
      Object.assign(data, { invoiceDate, dueDate: due, issuedAt: invoiceDate });
    }
    const r = await this.prisma.invoice.updateMany({ where: { id, organizationId, status: inv.status }, data });
    if (r.count === 0) throw new ConflictException('The invoice changed meanwhile; reload and try again');
    await this.audit(this.prisma, organizationId, actor, 'invoice', id, `status:${to}`, { from: inv.status, ...(input.reason ? { reason: input.reason } : {}) });
    if (to === 'issued' && n(inv.amountPaid) > 0) await this.prisma.$transaction((tx) => this.recompute(tx, organizationId, id, actor)); // advance already verified
    return this.getInvoice(organizationId, id);
  }

  listInvoices(organizationId: string, q: { status?: string; orderId?: string } = {}) {
    return this.prisma.invoice.findMany({
      where: { organizationId, ...(q.status ? { status: q.status } : {}), ...(q.orderId ? { orderId: q.orderId } : {}) },
      include: { customer: { select: { id: true, name: true, phone: true } }, order: { select: { id: true, number: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    }).then((rows) => rows.map((i) => this.decorate(i)));
  }

  async getInvoice(organizationId: string, id: string) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      include: { items: true, payments: { orderBy: { createdAt: 'asc' } }, customer: { select: { id: true, name: true, phone: true } }, order: { select: { id: true, number: true, status: true, leadId: true } } },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    const audit = await this.prisma.auditEvent.findMany({ where: { organizationId, entityType: 'invoice', entityId: id }, orderBy: { createdAt: 'asc' } });
    return { ...this.decorate(inv), audit };
  }

  /** Outstanding + overdue derived from the stored numbers and the real due date (never stored, never stale). */
  private decorate<T extends { status: string; total: unknown; amountPaid: unknown; dueDate: Date | null }>(i: T) {
    const outstanding = ['cancelled', 'draft', 'approved'].includes(i.status) ? 0 : r2(n(i.total) - n(i.amountPaid));
    const late = OPEN_INVOICE.includes(i.status) && outstanding > 0 ? daysOverdue(i.dueDate) : 0;
    return { ...i, outstanding, daysOverdue: late, overdue: late > 0 };
  }

  // ------------------------------------------------------------------ payments

  async recordPayment(
    organizationId: string,
    input: { invoiceId?: string; amount?: number; method?: string; reference?: string; transactionId?: string; paidAt?: string; source?: string; notes?: string },
    actor: string,
  ) {
    const inv = input.invoiceId ? await this.prisma.invoice.findFirst({ where: { id: input.invoiceId, organizationId } }) : null;
    if (!inv) throw new BadRequestException('Choose the invoice this payment is for');
    if (inv.status === 'cancelled' || inv.status === 'draft') throw new BadRequestException(`Invoice ${inv.number} is ${inv.status}; payments are recorded against approved or issued invoices`);
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw new BadRequestException('Enter the amount received');
    const method = String(input.method ?? '');
    if (!METHODS.includes(method)) throw new BadRequestException(`Method must be one of ${METHODS.join(', ')}`);
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + DAY) throw new BadRequestException('Payment date cannot be in the future');
    if (method !== 'cash' && !input.reference?.trim() && !input.transactionId?.trim()) throw new BadRequestException('Enter the UTR / cheque / transaction reference');
    const source = input.source === 'customer_claim' ? 'customer_claim' : 'staff_entry';
    const key = referenceKey(input.transactionId || input.reference);

    const payment = await this.prisma.payment.create({
      data: {
        organizationId, invoiceId: inv.id, orderId: inv.orderId, customerId: inv.customerId, amount: r2(amount), currency: inv.currency, method,
        reference: input.reference?.trim().slice(0, 191) || null, transactionId: input.transactionId?.trim().slice(0, 191) || null, referenceKey: key,
        paidAt, status: 'pending_verification', source, enteredBy: actor.slice(0, 191), notes: input.notes?.trim().slice(0, 2000) || null,
      },
    });
    await this.audit(this.prisma, organizationId, actor, 'invoice', inv.id, 'payment_recorded', { paymentId: payment.id, amount: r2(amount), method, source, status: 'pending_verification' });
    const flags = await this.reconcileChecks(organizationId, payment.id, actor);
    return { payment, flags };
  }

  /**
   * Flags that need a person: the same reference already used, or more than is outstanding. Recorded as
   * reconciliation exception tasks (Finance), never resolved automatically.
   */
  private async reconcileChecks(organizationId: string, paymentId: string, actor: string) {
    const p = (await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { invoice: true } }))!;
    const flags: string[] = [];
    if (p.referenceKey) {
      const same = await this.prisma.payment.findMany({ where: { organizationId, referenceKey: p.referenceKey, id: { not: p.id }, status: { in: ['pending_verification', 'verified'] } }, select: { id: true, amount: true, status: true, invoiceId: true } });
      if (same.length) {
        flags.push('duplicate_reference');
        await this.exception(organizationId, `dup:${p.id}`, `Possible duplicate payment: reference ${p.reference ?? p.transactionId} already recorded`, `Payment of ₹${n(p.amount)} on ${p.invoice?.number} uses a reference already recorded ${same.length} time(s) (${same.map((s) => `${s.status} ₹${n(s.amount)}`).join(', ')}). Verify against the bank statement before accepting.`, p, actor);
      }
    }
    if (p.invoice) {
      const pendingOthers = await this.prisma.payment.aggregate({ where: { organizationId, invoiceId: p.invoice.id, status: 'pending_verification', id: { not: p.id } }, _sum: { amount: true } });
      const outstanding = r2(n(p.invoice.total) - n(p.invoice.amountPaid) - n(pendingOthers._sum.amount));
      if (n(p.amount) > outstanding + 0.005) {
        flags.push('exceeds_outstanding');
        await this.exception(organizationId, `over:${p.id}`, `Payment ₹${n(p.amount)} is more than the ₹${Math.max(0, outstanding)} outstanding on ${p.invoice.number}`, 'Check the amount, or whether it belongs to another invoice. Overpayments are not verified automatically.', p, actor);
      }
    }
    return flags;
  }

  private exception(organizationId: string, key: string, title: string, detail: string, p: { id: string; invoiceId: string | null }, actor: string) {
    return this.workTasks.create(organizationId, { agent: 'finance', kind: 'reconciliation', priority: 'high', title, detail, entityType: 'invoice', entityId: p.invoiceId ?? undefined, dedupeKey: key, createdBy: actor });
  }

  listPayments(organizationId: string, q: { status?: string; invoiceId?: string } = {}) {
    return this.prisma.payment.findMany({
      where: { organizationId, ...(q.status ? { status: q.status } : {}), ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}) },
      include: { invoice: { select: { id: true, number: true, total: true, amountPaid: true, status: true } }, customer: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  /** Lock the invoice row so two verifications / reversals on one invoice are applied one after the other. */
  private async lockInvoice(tx: Tx, invoiceId: string) {
    await tx.$queryRaw`SELECT id FROM Invoice WHERE id = ${invoiceId} FOR UPDATE`;
  }

  /** Recompute paid amount / status of the invoice and the order's payment status from VERIFIED payments only. */
  private async recompute(tx: Tx, organizationId: string, invoiceId: string, actor: string) {
    const inv = (await tx.invoice.findUnique({ where: { id: invoiceId } }))!;
    const agg = await tx.payment.aggregate({ where: { invoiceId, status: 'verified' }, _sum: { amount: true } });
    const paid = r2(n(agg._sum.amount));
    let status = inv.status;
    if (['issued', 'partially_paid', 'paid'].includes(inv.status)) status = paid >= n(inv.total) - 0.005 ? 'paid' : paid > 0 ? 'partially_paid' : 'issued';
    await tx.invoice.update({ where: { id: invoiceId }, data: { amountPaid: paid, status } });
    if (status !== inv.status) await this.audit(tx, organizationId, actor, 'invoice', invoiceId, `status:${status}`, { from: inv.status, source: 'verified payments', amountPaid: paid });
    const order = await tx.salesOrder.findUnique({ where: { id: inv.orderId } });
    const orderPay = paid <= 0 ? 'unpaid' : paid >= n(inv.total) - 0.005 ? 'paid' : 'partial';
    if (order && order.paymentStatus !== orderPay) {
      await tx.salesOrder.update({ where: { id: order.id }, data: { paymentStatus: orderPay } });
      await this.audit(tx, organizationId, actor, 'order', order.id, 'payment_status', { from: order.paymentStatus, to: orderPay, source: `verified payments on ${inv.number}` });
    }
    return { amountPaid: paid, invoiceStatus: status, orderPaymentStatus: orderPay };
  }

  /**
   * Manual verification by an authorised person who states what they checked. Duplicate references and
   * overpayment are re-checked under the invoice lock; a failing check leaves the payment pending and raises an
   * exception instead.
   */
  async verifyPayment(organizationId: string, id: string, user: User, evidence?: string) {
    if (!can(user.role, PERMISSIONS.verifyPayment)) throw new ForbiddenException(`You need the "${PERMISSIONS.verifyPayment}" permission to verify payments`);
    const ev = evidence?.trim() ?? '';
    if (ev.length < 15 || !/\s/.test(ev)) throw new BadRequestException('Describe the evidence you checked (e.g. "HDFC statement 14 Oct, credit ₹50,000, UTR …"). A customer screenshot or reference alone is not proof.');
    const actor = `user:${user.sub}`;
    const p0 = await this.prisma.payment.findFirst({ where: { id, organizationId } });
    if (!p0) throw new NotFoundException('Payment not found');
    if (p0.status !== 'pending_verification') throw new ConflictException(`This payment is already ${p0.status.replace(/_/g, ' ')}`);
    if (!p0.invoiceId) throw new BadRequestException('Link the payment to an invoice first');

    let problem: { key: string; title: string; detail: string } | null = null;
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockInvoice(tx, p0.invoiceId!);
      const inv = (await tx.invoice.findUnique({ where: { id: p0.invoiceId! } }))!;
      if (inv.status === 'cancelled' || inv.status === 'draft') throw new ConflictException(`Invoice ${inv.number} is ${inv.status}`);
      if (p0.currency !== inv.currency) throw new ConflictException(`Currency ${p0.currency} does not match the invoice (${inv.currency})`);
      if (p0.referenceKey) {
        const dup = await tx.payment.findFirst({ where: { organizationId, referenceKey: p0.referenceKey, status: 'verified', id: { not: id } } });
        if (dup) {
          problem = { key: `dupv:${id}`, title: `Not verified: reference ${p0.reference ?? p0.transactionId} is already a verified payment`, detail: `A verified payment (₹${n(dup.amount)}) already uses this reference. The same transaction cannot be counted twice.` };
          return null;
        }
      }
      const outstanding = r2(n(inv.total) - n(inv.amountPaid));
      if (n(p0.amount) > outstanding + 0.005) {
        problem = { key: `overv:${id}`, title: `Not verified: ₹${n(p0.amount)} is more than the ₹${outstanding} outstanding on ${inv.number}`, detail: 'Overpayments are not verified automatically. Split it, correct the amount, or link it to another invoice.' };
        return null;
      }
      const claimed = await tx.payment.updateMany({ where: { id, organizationId, status: 'pending_verification' }, data: { status: 'verified', verificationSource: 'manual', evidence: ev.slice(0, 4000), verifiedBy: actor, verifiedAt: new Date() } });
      if (claimed.count === 0) throw new ConflictException('Someone else changed this payment just now');
      await this.audit(tx, organizationId, actor, 'payment', id, 'verified', { amount: n(p0.amount), invoice: inv.number, evidence: ev.slice(0, 300), source: 'manual' });
      await this.audit(tx, organizationId, actor, 'invoice', inv.id, 'payment_verified', { paymentId: id, amount: n(p0.amount) });
      return this.recompute(tx, organizationId, inv.id, actor);
    });
    if (problem) {
      const pr = problem as { key: string; title: string; detail: string };
      await this.exception(organizationId, pr.key, pr.title, pr.detail, p0, actor);
      throw new ConflictException(`${pr.title}. A reconciliation exception was created.`);
    }
    const inv = (await this.prisma.invoice.findUnique({ where: { id: p0.invoiceId } }))!;
    await this.events?.paymentVerified({ organizationId, paymentId: id, invoiceId: inv.id, orderId: inv.orderId, actor });
    return { payment: await this.prisma.payment.findUnique({ where: { id } }), ...result! };
  }

  async rejectPayment(organizationId: string, id: string, user: User, reason?: string) {
    if (!can(user.role, PERMISSIONS.verifyPayment)) throw new ForbiddenException(`You need the "${PERMISSIONS.verifyPayment}" permission`);
    if (!reason?.trim()) throw new BadRequestException('Give the reason (not on the bank statement, wrong amount, ...)');
    const r = await this.prisma.payment.updateMany({ where: { id, organizationId, status: 'pending_verification' }, data: { status: 'rejected', rejectedReason: reason.trim().slice(0, 2000) } });
    if (r.count === 0) throw new ConflictException('Only a payment waiting for verification can be rejected');
    const p = (await this.prisma.payment.findUnique({ where: { id } }))!;
    await this.audit(this.prisma, organizationId, `user:${user.sub}`, 'payment', id, 'rejected', { reason: reason.trim().slice(0, 300) });
    if (p.invoiceId) await this.audit(this.prisma, organizationId, `user:${user.sub}`, 'invoice', p.invoiceId, 'payment_rejected', { paymentId: id, amount: n(p.amount) });
    return p;
  }

  /** Reversing a verified payment is a financial correction: always through an approval (recorded even for holders). */
  async requestReversal(organizationId: string, id: string, user: User, reason?: string) {
    if (!reason?.trim()) throw new BadRequestException('Give the reason for the reversal (bounced cheque, chargeback, entered on the wrong invoice, ...)');
    const p = await this.prisma.payment.findFirst({ where: { id, organizationId }, include: { invoice: true } });
    if (!p) throw new NotFoundException('Payment not found');
    if (p.status !== 'verified') throw new ConflictException('Only a verified payment can be reversed');
    const r = await this.approvals.request(organizationId, {
      action: 'payment.reverse', entityType: 'invoice', entityId: p.invoiceId ?? p.id, requiredPermission: PERMISSIONS.reversePayment,
      reason: `Reverse ₹${n(p.amount)} on ${p.invoice?.number ?? 'payment'}: ${reason.trim()}`, payload: { paymentId: id, amount: n(p.amount), reason: reason.trim().slice(0, 500) },
      requestedBy: `user:${user.sub}`, requesterRole: user.role,
    });
    if (!r.approved) return { approval: r.approval, applied: false };
    const res = await this.applyReversal(organizationId, id, `user:${user.sub}`, reason.trim(), r.approval.id);
    await this.approvals.markExecuted(organizationId, r.approval.id, res);
    return { approval: r.approval, applied: true, ...res };
  }

  private async applyReversal(organizationId: string, id: string, actor: string, reason: string, approvalId: string) {
    const p0 = await this.prisma.payment.findFirst({ where: { id, organizationId } });
    if (!p0) throw new NotFoundException('Payment not found');
    return this.prisma.$transaction(async (tx) => {
      if (p0.invoiceId) await this.lockInvoice(tx, p0.invoiceId);
      const r = await tx.payment.updateMany({ where: { id, organizationId, status: 'verified' }, data: { status: 'reversed', reversedBy: actor.slice(0, 191), reversedAt: new Date(), reversalReason: reason.slice(0, 2000) } });
      if (r.count === 0) throw new ConflictException('The payment is no longer verified');
      await this.audit(tx, organizationId, actor, 'payment', id, 'reversed', { reason: reason.slice(0, 300), approvalId, note: 'Record correction only; no money was moved by Tacksharp.' });
      return p0.invoiceId ? this.recompute(tx, organizationId, p0.invoiceId, actor) : {};
    });
  }

  // ------------------------------------------------------------------ fulfilment policy

  /** Settings → finance.dispatchPaymentRule, checked on the server before ready-to-dispatch / dispatched. */
  async assertDispatchAllowed(organizationId: string, orderId: string) {
    const rule = (await this.settingsFor(organizationId)).finance?.dispatchPaymentRule ?? 'none';
    if (rule === 'none') return { rule, allowed: true };
    const inv = await this.prisma.invoice.findFirst({ where: { organizationId, orderId, activeKey: { not: null } } });
    const paid = inv ? n(inv.amountPaid) : 0;
    const ok = rule === 'full' ? Boolean(inv) && paid >= n(inv!.total) - 0.005 : paid > 0;
    if (!ok) {
      throw new ConflictException(
        rule === 'full'
          ? `Dispatch needs the invoice fully paid (verified payments). ${inv ? `${inv.number}: ₹${paid} of ₹${n(inv.total)} verified.` : 'No invoice yet.'}`
          : `Dispatch needs at least one verified payment. ${inv ? `${inv.number} has none verified yet.` : 'No invoice yet.'}`,
      );
    }
    return { rule, allowed: true };
  }

  // ------------------------------------------------------------------ receivables + overview

  async receivables(organizationId: string) {
    const open = await this.prisma.invoice.findMany({ where: { organizationId, status: { in: OPEN_INVOICE } }, include: { customer: { select: { id: true, name: true, phone: true } }, order: { select: { number: true } } }, orderBy: { dueDate: 'asc' } });
    const rows = open.map((i) => this.decorate(i)).filter((i) => i.outstanding > 0);
    const bucket = (d: number) => (d === 0 ? 'current' : d <= 30 ? '1_30' : d <= 60 ? '31_60' : d <= 90 ? '61_90' : 'over_90');
    const aging: Record<string, number> = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, over_90: 0 };
    const customers = new Map<string, { customerId: string; name: string | null; phone: string | null; invoices: number; outstanding: number; overdue: number }>();
    for (const i of rows) {
      aging[bucket(i.daysOverdue)] = r2(aging[bucket(i.daysOverdue)] + i.outstanding);
      const c = customers.get(i.customerId) ?? { customerId: i.customerId, name: i.customer?.name ?? null, phone: i.customer?.phone ?? null, invoices: 0, outstanding: 0, overdue: 0 };
      c.invoices++;
      c.outstanding = r2(c.outstanding + i.outstanding);
      if (i.overdue) c.overdue = r2(c.overdue + i.outstanding);
      customers.set(i.customerId, c);
    }
    return { invoices: rows, aging, customers: [...customers.values()].sort((a, b) => b.outstanding - a.outstanding), asOf: new Date() };
  }

  async overview(organizationId: string, days = 30) {
    const since = new Date(Date.now() - Math.min(365, Math.max(1, days)) * DAY);
    const [orders, invoiced, collected, open, pending, exceptions, expenses] = await Promise.all([
      this.prisma.salesOrder.aggregate({ where: { organizationId, createdAt: { gte: since }, status: { in: INVOICEABLE_ORDER } }, _sum: { total: true }, _count: { _all: true } }),
      this.prisma.invoice.aggregate({ where: { organizationId, invoiceDate: { gte: since }, status: { in: ['issued', 'partially_paid', 'paid'] } }, _sum: { total: true }, _count: { _all: true } }),
      this.prisma.payment.aggregate({ where: { organizationId, status: 'verified', verifiedAt: { gte: since } }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.invoice.findMany({ where: { organizationId, status: { in: OPEN_INVOICE } }, select: { total: true, amountPaid: true, dueDate: true, status: true } }),
      this.prisma.payment.aggregate({ where: { organizationId, status: 'pending_verification' }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.workTask.count({ where: { organizationId, agent: 'finance', kind: 'reconciliation', status: { in: ['open', 'in_progress'] } } }),
      this.prisma.expense.aggregate({ where: { organizationId, status: 'recorded', spentOn: { gte: since } }, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const decorated = open.map((i) => this.decorate(i));
    const overdue = decorated.filter((i) => i.overdue);
    return {
      days,
      orderValue: { amount: r2(n(orders._sum.total)), count: orders._count._all },
      invoiced: { amount: r2(n(invoiced._sum.total)), count: invoiced._count._all },
      collectedVerified: { amount: r2(n(collected._sum.amount)), count: collected._count._all },
      outstanding: { amount: r2(decorated.reduce((a, i) => a + i.outstanding, 0)), count: decorated.filter((i) => i.outstanding > 0).length },
      overdue: { amount: r2(overdue.reduce((a, i) => a + i.outstanding, 0)), count: overdue.length },
      awaitingVerification: { amount: r2(n(pending._sum.amount)), count: pending._count._all },
      reconciliationExceptions: exceptions,
      expenses: { amount: r2(n(expenses._sum.amount)), count: expenses._count._all },
      grossMargin: null,
      notes: {
        orderValue: 'Confirmed orders created in the period (agreed value, not money received).',
        invoiced: 'Issued invoices dated in the period.',
        collectedVerified: 'Payments VERIFIED in the period (by an authorised person with evidence). Unverified claims are excluded. This is cash collected, not profit.',
        outstanding: 'Issued invoices not fully paid, now.',
        expenses: 'Expenses recorded by Finance in the period (not an accounting ledger).',
        grossMargin: 'See Profitability: calculated only for invoice lines whose product has a unit cost; coverage is shown.',
        gateway: 'No payment gateway or bank feed is connected; verification is manual.',
      },
    };
  }

  async exportInvoicesCsv(organizationId: string) {
    const rows = await this.listInvoices(organizationId);
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s; // also blocks spreadsheet formula injection
    };
    const header = ['number', 'status', 'order', 'customer', 'invoice_date', 'due_date', 'currency', 'subtotal', 'discount', 'tax_percent', 'tax', 'shipping', 'total', 'paid_verified', 'outstanding', 'days_overdue'];
    const lines = rows.map((i) => [i.number, i.status, i.order?.number, i.customer?.name, i.invoiceDate, i.dueDate, i.currency, n(i.subtotal), n(i.discount), n(i.taxPercent), n(i.tax), n(i.shipping), n(i.total), n(i.amountPaid), i.outstanding, i.daysOverdue].map(esc).join(','));
    return [header.join(','), ...lines].join('\n') + '\n';
  }

  /** Read-only hook used by agents: one invoice for an order (or null). */
  activeInvoiceForOrder(organizationId: string, orderId: string) {
    return this.prisma.invoice.findFirst({ where: { organizationId, orderId, activeKey: { not: null } } });
  }

  logFailure(where: string, e: unknown) {
    log.error(`finance.${where}_failed`, { error: errorMessage(e) });
  }
}
