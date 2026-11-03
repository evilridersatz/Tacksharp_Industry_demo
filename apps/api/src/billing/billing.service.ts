import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertPlanAllows, planUsage } from './entitlements.js';
import { CYCLES, PLANS, PLAN_CODES, RESOURCES, STATUSES, addCycle, effectiveLimits, invoiceAmounts, invoiceNumber, validateOverride, type Cycle, type Limits, type Resource } from './plans.js';

type Actor = { sub: string };
const DUE_DAYS = 15;
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/;

/**
 * Enterprise subscriptions: plans with entitlements, one subscription per organization (set by a Tacksharp platform
 * admin), enterprise contracts that group organizations, and Tacksharp's own invoices.
 *
 * Organizations WITHOUT a subscription row keep working exactly as before (no limits), so existing tenants such as GR
 * Chicken are never blocked by this feature. No payment gateway is connected: invoices are issued and their payment is
 * recorded by a platform admin with its reference; nothing is ever charged automatically or marked paid on its own.
 */
@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  usage(org: string) {
    return planUsage(this.prisma, org);
  }

  assertWithin(org: string, resource: Resource) {
    return assertPlanAllows(this.prisma, org, resource);
  }

  // -------------------------------------------------------------------------------------------- organization view
  async summary(org: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { organizationId: org }, include: { contract: { select: { name: true } } } });
    const usage = await this.usage(org);
    const invoices = await this.prisma.platformInvoice.findMany({ where: { organizationId: org }, orderBy: { issuedAt: 'desc' }, take: 24 });
    if (!sub) return { subscription: null, limits: null, usage, invoices: invoices.map(inv), note: 'No plan is assigned to this workspace yet: there are no limits. Tacksharp sets the plan when your subscription starts.' };
    return {
      subscription: view(sub),
      limits: effectiveLimits(sub.planCode, sub.limitsOverride),
      usage,
      invoices: invoices.map(inv),
      note: 'Invoices are issued by Tacksharp. Pay by bank transfer or UPI with the invoice number as reference; Tacksharp records the payment. Nothing is charged automatically.',
    };
  }

  // -------------------------------------------------------------------------------------------- platform admin
  async requireAdmin(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true, disabledAt: true } });
    if (!u?.isPlatformAdmin || u.disabledAt) throw new ForbiddenException('Platform administration is restricted to Tacksharp staff.');
  }

  /** All subscriptions, renewals due in 7 days or overdue, and unpaid invoices past their due date. */
  async overview() {
    await this.refreshPastDue();
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 86_400_000);
    const [subs, overdue, contracts] = await Promise.all([
      this.prisma.subscription.findMany({ include: { organization: { select: { name: true, status: true } }, contract: { select: { id: true, name: true } } }, orderBy: { currentPeriodEnd: 'asc' } }),
      this.prisma.platformInvoice.findMany({ where: { status: 'issued', dueAt: { lt: now } }, include: { organization: { select: { name: true } } }, orderBy: { dueAt: 'asc' } }),
      this.prisma.billingContract.findMany({ include: { _count: { select: { subscriptions: true } } }, orderBy: { name: 'asc' } }),
    ]);
    const outstanding = await this.prisma.platformInvoice.aggregate({ where: { status: 'issued' }, _sum: { total: true }, _count: { _all: true } });
    return {
      subscriptions: subs.map((s) => ({ ...view(s), organizationName: s.organization.name, organizationStatus: s.organization.status })),
      renewalsDue: subs.filter((s) => ['active', 'past_due', 'trial'].includes(s.status) && s.currentPeriodEnd <= soon).map((s) => ({ organizationId: s.organizationId, organizationName: s.organization.name, currentPeriodEnd: s.currentPeriodEnd, autoRenew: s.autoRenew })),
      overdueInvoices: overdue.map((i) => ({ ...inv(i), organizationName: i.organization.name })),
      outstanding: { count: outstanding._count._all, total: Number(outstanding._sum.total ?? 0) },
      contracts: contracts.map((c) => ({ id: c.id, name: c.name, billingEmail: c.billingEmail, gstin: c.gstin, organizations: c._count.subscriptions })),
      plans: PLAN_CODES.map((code) => ({ code, name: PLANS[code].name, limits: PLANS[code].limits })),
    };
  }

  async organizationBilling(orgId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } });
    if (!org) throw new NotFoundException('Organization not found.');
    return { organization: org, ...(await this.summary(orgId)), plans: PLAN_CODES.map((code) => ({ code, name: PLANS[code].name, limits: PLANS[code].limits })), contracts: await this.prisma.billingContract.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }) };
  }

  /** Create or change an organization's subscription. Lowering a plan never deletes anything: limits apply to new items. */
  async setSubscription(actor: Actor, orgId: string, body: Record<string, unknown>) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) throw new NotFoundException('Organization not found.');
    const existing = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    const errors: Record<string, string> = {};
    const planCode = body.planCode !== undefined ? String(body.planCode) : existing?.planCode;
    if (!planCode || !(PLAN_CODES as string[]).includes(planCode)) errors.planCode = `Choose a plan: ${PLAN_CODES.join(', ')}.`;
    const status = body.status !== undefined ? String(body.status) : (existing?.status ?? 'active');
    if (!(STATUSES as readonly string[]).includes(status)) errors.status = `Status: ${STATUSES.join(', ')}.`;
    const cycle = (body.billingCycle !== undefined ? String(body.billingCycle) : (existing?.billingCycle ?? 'monthly')) as Cycle;
    if (!(cycle in CYCLES)) errors.billingCycle = 'Billing cycle: monthly, quarterly or yearly.';
    const price = body.price !== undefined ? Number(body.price) : Number(existing?.price ?? 0);
    if (!Number.isFinite(price) || price < 0 || price > 100_000_000) errors.price = 'Price: ₹0 to ₹10 crore per cycle.';
    const taxRatePct = body.taxRatePct !== undefined ? Number(body.taxRatePct) : Number(existing?.taxRatePct ?? 18);
    if (!Number.isFinite(taxRatePct) || taxRatePct < 0 || taxRatePct > 50) errors.taxRatePct = 'Tax rate: 0-50 %.';
    const ov = body.limitsOverride !== undefined ? validateOverride(body.limitsOverride) : { value: (existing?.limitsOverride ?? null) as Partial<Limits> | null };
    if (ov.error) errors.limitsOverride = ov.error;
    const start = body.currentPeriodStart ? new Date(String(body.currentPeriodStart)) : (existing?.currentPeriodStart ?? new Date());
    if (Number.isNaN(start.getTime())) errors.currentPeriodStart = 'A valid start date.';
    const trialEndsAt = body.trialEndsAt === null || body.trialEndsAt === '' ? null : body.trialEndsAt ? new Date(String(body.trialEndsAt)) : (existing?.trialEndsAt ?? null);
    if (trialEndsAt && Number.isNaN(trialEndsAt.getTime())) errors.trialEndsAt = 'A valid date.';
    if (status === 'trial' && !trialEndsAt) errors.trialEndsAt = 'A trial needs an end date.';
    let contractId = body.contractId !== undefined ? (body.contractId ? String(body.contractId) : null) : (existing?.contractId ?? null);
    if (contractId && !(await this.prisma.billingContract.findUnique({ where: { id: contractId } }))) errors.contractId = 'Unknown contract.';
    if (Object.keys(errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please correct the subscription.', errors });
    const restart = !existing || body.currentPeriodStart !== undefined || (body.billingCycle !== undefined && body.billingCycle !== existing.billingCycle);
    const data = {
      planCode: planCode!,
      status,
      billingCycle: cycle,
      price: new Prisma.Decimal(price.toFixed(2)),
      taxRatePct: new Prisma.Decimal(taxRatePct.toFixed(2)),
      limitsOverride: ov.value === null ? Prisma.DbNull : (ov.value as Prisma.InputJsonValue),
      trialEndsAt,
      autoRenew: body.autoRenew !== undefined ? body.autoRenew !== false : (existing?.autoRenew ?? true),
      contractId: contractId ?? null,
      notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) || null : (existing?.notes ?? null),
      ...(restart ? { currentPeriodStart: start, currentPeriodEnd: addCycle(start, cycle) } : {}),
    };
    const sub = existing
      ? await this.prisma.subscription.update({ where: { id: existing.id }, data })
      : await this.prisma.subscription.create({ data: { ...data, organizationId: orgId, currentPeriodStart: start, currentPeriodEnd: addCycle(start, cycle), createdBy: actor.sub } });
    contractId = sub.contractId;
    await this.audit(orgId, actor, 'subscription', sub.id, existing ? 'subscription.updated' : 'subscription.created', { planCode: sub.planCode, status: sub.status, billingCycle: sub.billingCycle, price: Number(sub.price), contractId });
    return this.organizationBilling(orgId);
  }

  /** Issues the invoice for the subscription's current period (once per period). */
  async issueInvoice(actor: Actor, orgId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    if (!sub) throw new BadRequestException('Assign a plan first.');
    if (sub.status === 'cancelled') throw new BadRequestException('The subscription is cancelled.');
    if (Number(sub.price) <= 0) throw new BadRequestException('Set the agreed price before issuing an invoice.');
    const a = invoiceAmounts(Number(sub.price), Number(sub.taxRatePct));
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.platformInvoice.findFirst({ where: { number: { startsWith: `TS-${year}-` } }, orderBy: { number: 'desc' }, select: { number: true } });
      const seq = (last ? Number(last.number.slice(-5)) : 0) + 1;
      try {
        const created = await this.prisma.platformInvoice.create({
          data: {
            number: invoiceNumber(year, seq + attempt),
            organizationId: orgId,
            subscriptionId: sub.id,
            description: `${PLANS[sub.planCode as keyof typeof PLANS]?.name ?? sub.planCode} plan (${sub.billingCycle}), ${fmtDay(sub.currentPeriodStart)} to ${fmtDay(sub.currentPeriodEnd)}`,
            periodStart: sub.currentPeriodStart,
            periodEnd: sub.currentPeriodEnd,
            subtotal: a.subtotal,
            taxRatePct: sub.taxRatePct,
            tax: a.tax,
            total: a.total,
            status: 'issued',
            dueAt: new Date(Date.now() + DUE_DAYS * 86_400_000),
            createdBy: actor.sub,
          },
        });
        await this.audit(orgId, actor, 'platform_invoice', created.id, 'invoice.issued', { number: created.number, total: a.total });
        return inv(created);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '');
          if (!target.includes('number')) throw new ConflictException('An invoice for this period was already issued.');
          continue; // number taken by a concurrent issue: try the next one
        }
        throw e;
      }
    }
    throw new ConflictException('Could not allocate an invoice number; try again.');
  }

  async markPaid(actor: Actor, invoiceId: string, body: { reference?: unknown; paidAt?: unknown }) {
    const i = await this.prisma.platformInvoice.findUnique({ where: { id: invoiceId } });
    if (!i) throw new NotFoundException('Invoice not found.');
    if (i.status !== 'issued') throw new BadRequestException(`This invoice is ${i.status}.`);
    const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
    if (reference.length < 3 || reference.length > 120) throw new BadRequestException({ statusCode: 400, message: 'Enter the payment reference (bank / UPI transaction id).', errors: { reference: 'Required (3-120 characters).' } });
    const paidAt = body.paidAt ? new Date(String(body.paidAt)) : new Date();
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 60_000) throw new BadRequestException('Payment date cannot be in the future.');
    const r = await this.prisma.platformInvoice.updateMany({ where: { id: i.id, status: 'issued' }, data: { status: 'paid', paidAt, paymentReference: reference } });
    if (!r.count) throw new ConflictException('This invoice was changed by someone else.');
    await this.audit(i.organizationId, actor, 'platform_invoice', i.id, 'invoice.paid', { number: i.number });
    await this.refreshPastDue(i.organizationId);
    return inv((await this.prisma.platformInvoice.findUnique({ where: { id: i.id } }))!);
  }

  async voidInvoice(actor: Actor, invoiceId: string, body: { reason?: unknown }) {
    const i = await this.prisma.platformInvoice.findUnique({ where: { id: invoiceId } });
    if (!i) throw new NotFoundException('Invoice not found.');
    if (i.status !== 'issued') throw new BadRequestException(`Only an unpaid invoice can be voided (this one is ${i.status}).`);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3) throw new BadRequestException('Give the reason for voiding it.');
    await this.prisma.platformInvoice.update({ where: { id: i.id }, data: { status: 'void', voidReason: reason.slice(0, 300) } });
    await this.audit(i.organizationId, actor, 'platform_invoice', i.id, 'invoice.voided', { number: i.number });
    await this.refreshPastDue(i.organizationId);
    return inv((await this.prisma.platformInvoice.findUnique({ where: { id: i.id } }))!);
  }

  /** Moves an ended period forward by one cycle (auto-renewing, not cancelled). Never charges anything. */
  async renew(actor: Actor, orgId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    if (!sub) throw new NotFoundException('No subscription.');
    if (sub.status === 'cancelled') throw new BadRequestException('A cancelled subscription is not renewed.');
    if (sub.currentPeriodEnd.getTime() > Date.now() + 7 * 86_400_000) throw new BadRequestException('The current period ends more than 7 days from now.');
    const start = sub.currentPeriodEnd;
    const updated = await this.prisma.subscription.updateMany({ where: { id: sub.id, currentPeriodEnd: sub.currentPeriodEnd }, data: { currentPeriodStart: start, currentPeriodEnd: addCycle(start, sub.billingCycle as Cycle), ...(sub.status === 'trial' ? { status: 'active' } : {}) } });
    if (!updated.count) throw new ConflictException('Already renewed.');
    await this.audit(orgId, actor, 'subscription', sub.id, 'subscription.renewed', { from: start });
    return this.organizationBilling(orgId);
  }

  async createContract(actor: Actor, body: Record<string, unknown>) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const errors: Record<string, string> = {};
    if (!name || name.length > 160) errors.name = 'Contract name (up to 160 characters).';
    const email = typeof body.billingEmail === 'string' ? body.billingEmail.trim().toLowerCase() : '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.billingEmail = 'A valid email.';
    const gstin = typeof body.gstin === 'string' ? body.gstin.trim().toUpperCase() : '';
    if (gstin && !GSTIN.test(gstin)) errors.gstin = 'GSTIN: 15 characters (e.g. 33ABCDE1234F1Z5).';
    if (Object.keys(errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please correct the contract.', errors });
    const c = await this.prisma.billingContract.create({ data: { name, billingEmail: email || null, gstin: gstin || null, billingAddress: typeof body.billingAddress === 'string' ? body.billingAddress.trim().slice(0, 500) || null : null, notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) || null : null, createdBy: actor.sub } });
    return c;
  }

  /** past_due while an issued invoice is past its due date; back to active once none is. */
  async refreshPastDue(orgId?: string) {
    const now = new Date();
    const subs = await this.prisma.subscription.findMany({ where: { ...(orgId ? { organizationId: orgId } : {}), status: { in: ['active', 'past_due'] } }, select: { id: true, organizationId: true, status: true } });
    for (const s of subs) {
      const overdue = await this.prisma.platformInvoice.count({ where: { organizationId: s.organizationId, status: 'issued', dueAt: { lt: now } } });
      const next = overdue ? 'past_due' : 'active';
      if (next !== s.status) await this.prisma.subscription.update({ where: { id: s.id }, data: { status: next } });
    }
  }

  private audit(org: string, actor: Actor, entityType: string, entityId: string, action: string, data: Record<string, unknown>) {
    return this.prisma.auditEvent.create({ data: { organizationId: org, actor: `platform:${actor.sub}`, entityType, entityId, action, data: data as Prisma.InputJsonValue } }).catch(() => undefined);
  }
}

const fmtDay = (d: Date) => d.toISOString().slice(0, 10);

function view(s: Prisma.SubscriptionGetPayload<{ include?: { contract?: { select: { name: true } } } }> & { contract?: { name?: string; id?: string } | null }) {
  return {
    id: s.id, organizationId: s.organizationId, planCode: s.planCode, planName: PLANS[s.planCode as keyof typeof PLANS]?.name ?? s.planCode, status: s.status, billingCycle: s.billingCycle,
    price: Number(s.price), taxRatePct: Number(s.taxRatePct), limitsOverride: s.limitsOverride, trialEndsAt: s.trialEndsAt, currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd,
    autoRenew: s.autoRenew, contractId: s.contractId, contractName: s.contract?.name ?? null, notes: s.notes,
  };
}

function inv(i: Prisma.PlatformInvoiceGetPayload<object>) {
  return {
    id: i.id, number: i.number, description: i.description, periodStart: i.periodStart, periodEnd: i.periodEnd, subtotal: Number(i.subtotal), taxRatePct: Number(i.taxRatePct), tax: Number(i.tax), total: Number(i.total),
    status: i.status, issuedAt: i.issuedAt, dueAt: i.dueAt, paidAt: i.paidAt, paymentReference: i.paymentReference, voidReason: i.voidReason, overdue: i.status === 'issued' && i.dueAt < new Date(),
  };
}

export { RESOURCES };
