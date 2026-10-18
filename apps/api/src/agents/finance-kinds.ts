import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { WorkTasksService } from '../governance/work-tasks.service.js';
import type { FinanceService } from '../finance/finance.service.js';
import { daysOverdue } from '../finance/finance.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { CollectionsService } from '../finance/collections.service.js';
import type { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { DEFAULT_SETTINGS } from '../settings/tenant-settings.js';
import type { TaskKind } from './agent-types.js';

type Deps = { prisma: PrismaService; finance: FinanceService; workTasks: WorkTasksService; settings?: SettingsService; collections?: CollectionsService; followUps?: FollowUpsService };

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const obj = (raw: unknown) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const id = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !/^[\w-]{6,64}$/.test(v)) throw new BadRequestException(`${name} is required`);
  return v;
};

/**
 * Finance agent tasks. Task inputs and results carry record ids and amounts already on the records - never
 * bank details or evidence text (those stay on the Payment row).
 */
export function buildFinanceKinds({ prisma, finance, workTasks, settings, collections, followUps }: Deps): TaskKind[] {
  const invoiceDraft: TaskKind<{ orderId: string }> = {
    kind: 'finance.invoice_draft',
    agent: 'finance',
    label: 'Draft an invoice',
    description: 'Drafts the invoice for a confirmed order from its lines and the quotation terms. A person approves and issues it.',
    userRunnable: true,
    parse: (raw) => ({ orderId: id(obj(raw).orderId, 'orderId') }),
    entity: (i) => ({ type: 'order', id: i.orderId }),
    async run(ctx, { orderId }) {
      const order = await ctx.tool('orders.read', () => prisma.salesOrder.findFirst({ where: { id: orderId, organizationId: ctx.organizationId }, select: { number: true, status: true, quotationId: true } }));
      if (!order) throw new BadRequestException('Order not found');
      if (!order.quotationId) {
        // No agreed tax terms to copy: a person must enter the tax %; the agent does not guess.
        return { status: 'completed', summary: `${order.number}: no quotation terms - invoice needs the tax % entered by Finance`, result: { outcome: 'needs_tax_input' } };
      }
      const r = await ctx.tool('invoices.write', () => finance.createInvoice(ctx.organizationId, orderId, ctx.actor), `Draft invoice for ${order.number}`);
      return {
        status: 'completed',
        summary: r.duplicate ? `${order.number}: invoice ${r.invoice.number} already exists` : `${order.number}: draft invoice ${r.invoice.number} (₹${n(r.invoice.total)}) - waiting for approval`,
        result: { outcome: r.duplicate ? 'exists' : 'drafted', invoiceId: r.invoice.id, number: r.invoice.number, status: r.invoice.status, total: n(r.invoice.total) },
      };
    },
  };

  const paymentVerified: TaskKind<{ paymentId: string }> = {
    kind: 'finance.payment_verified',
    agent: 'finance',
    label: 'Payment verified → fulfilment',
    description: 'After a verified payment: confirms invoice / order payment status, applies the dispatch payment rule and hands the order to Operations.',
    userRunnable: false,
    parse: (raw) => ({ paymentId: id(obj(raw).paymentId, 'paymentId') }),
    entity: (i) => ({ type: 'payment', id: i.paymentId }),
    async run(ctx, { paymentId }) {
      const p = await ctx.tool('payments.read', () => prisma.payment.findFirst({ where: { id: paymentId, organizationId: ctx.organizationId }, include: { invoice: true, customer: { select: { optedOutAt: true, doNotContact: true } }, order: { select: { id: true, number: true, status: true, paymentStatus: true, leadId: true } } } }));
      if (!p || !p.invoice || !p.order) throw new BadRequestException('Payment, invoice or order not found');
      if (p.status !== 'verified') {
        return { status: 'completed', summary: `Payment is ${p.status}; nothing to do`, result: { outcome: 'not_verified', paymentStatus: p.status } };
      }
      const s = settings ? await settings.get(ctx.organizationId) : DEFAULT_SETTINGS;
      const rule = s.finance?.dispatchPaymentRule ?? 'none';
      const paid = n(p.invoice.amountPaid), total = n(p.invoice.total);
      const eligible = rule === 'none' || (rule === 'any_verified' ? paid > 0 : paid >= total - 0.005);
      // Customer receipt: only for a VERIFIED payment, through the follow-up queue (opt-out, 24 h window, approved
      // template and DRY_RUN are enforced there). Idempotent: one receipt per payment.
      let customerUpdate: string;
      if (!s.textile.notifyOrderStatus) customerUpdate = 'not sent: order / payment updates are switched off in Settings';
      else if (!p.order.leadId) customerUpdate = 'not sent: the order has no WhatsApp conversation (no lead)';
      else if (p.customer?.optedOutAt || p.customer?.doNotContact) customerUpdate = 'not sent: customer opted out';
      else if (!followUps) customerUpdate = 'not sent: follow-up queue not available';
      else {
        const exists = await prisma.followUp.count({ where: { organizationId: ctx.organizationId, source: 'payment', message: `payment:received:${paymentId}` } });
        if (!exists) await ctx.tool('worktask.create', () => followUps.create({ organizationId: ctx.organizationId, leadId: p.order!.leadId!, customerId: p.customerId, channel: 'whatsapp', action: 'message', source: 'payment', message: `payment:received:${paymentId}`, scheduledAt: new Date() }), 'Queue the payment receipt for the customer');
        customerUpdate = exists ? 'already queued' : 'queued (subject to opt-out, WhatsApp window / template; DRY_RUN = not sent)';
      }
      return {
        status: 'completed',
        summary: `${p.invoice.number}: ₹${paid} of ₹${total} verified; dispatch ${eligible ? 'allowed' : 'not yet allowed'} (rule: ${rule})`,
        result: {
          invoice: p.invoice.number, invoiceStatus: p.invoice.status, orderPaymentStatus: p.order.paymentStatus, verifiedPaid: paid, total, dispatchRule: rule, eligibleForDispatch: eligible,
          customerUpdate,
        },
        handoffs: eligible ? [{ kind: 'operations.fulfilment_check', input: { orderId: p.order.id }, reason: `Payment verified on ${p.invoice.number}; check the order can move to dispatch`, entity: { type: 'order', id: p.order.id } }] : [],
      };
    },
  };

  const overdueScan: TaskKind<Record<string, never>> = {
    kind: 'finance.overdue_scan',
    agent: 'finance',
    label: 'Overdue invoice scan',
    description: 'Finds issued invoices past their due date with a balance and opens one collection follow-up task each (no message is sent).',
    userRunnable: true,
    parse: () => ({}),
    async run(ctx) {
      const open = await ctx.tool('invoices.read', () => prisma.invoice.findMany({ where: { organizationId: ctx.organizationId, status: { in: ['issued', 'partially_paid'] } }, include: { customer: { select: { name: true } } } }));
      const overdue = open.map((i) => ({ i, late: daysOverdue(i.dueDate), due: r2(n(i.total) - n(i.amountPaid)) })).filter((x) => x.late > 0 && x.due > 0);
      let created = 0;
      let remindersRequested = 0;
      const skipped: Array<{ number: string; reason: string }> = [];
      if (collections) await collections.markBrokenPromises(ctx.organizationId);
      for (const { i, late, due } of overdue) {
        // A customer who promised a date that has not passed is left alone until then.
        const promise = collections ? await collections.openPromise(ctx.organizationId, i.id) : null;
        if (promise) {
          skipped.push({ number: i.number, reason: `promised ₹${n(promise.promisedAmount)} by ${promise.promisedDate?.toISOString().slice(0, 10)}` });
          continue;
        }
        const already = await prisma.workTask.count({ where: { organizationId: ctx.organizationId, agent: 'finance', kind: 'review', entityType: 'invoice', entityId: i.id, status: { in: ['open', 'in_progress'] } } });
        const t = already ? { created: false } : await ctx.tool('worktask.create', () =>
          workTasks.create(ctx.organizationId, {
            agent: 'finance', kind: 'review', priority: late > 30 ? 'high' : 'normal',
            title: `Collect ₹${due} from ${i.customer?.name ?? 'customer'} - ${i.number} is ${late} day(s) overdue`,
            detail: 'Review before contacting: check for disputes or unverified payments first. Record any payment promise or dispute on the invoice. A reminder is only sent after approval.',
            entityType: 'invoice', entityId: i.id, dedupeKey: `overdue:${i.id}:${new Date().toISOString().slice(0, 10)}`, createdBy: ctx.actor,
          }),
        );
        if (t.created) created++;
        // Prepare a reminder for approval (a person with finance.send_reminder decides; nothing is sent here).
        if (collections) {
          const blocker = await collections.reminderBlocker(ctx.organizationId, i.id);
          if (blocker) skipped.push({ number: i.number, reason: blocker });
          else {
            await ctx.tool('invoices.write', () => collections.requestReminder(ctx.organizationId, i.id, { sub: 'agent' }, { requestedBy: ctx.actor }), `Prepare a reminder for ${i.number} (needs approval)`);
            remindersRequested++;
          }
        }
      }
      return {
        status: 'completed',
        summary: `${overdue.length} overdue invoice(s), ${created} new follow-up task(s), ${remindersRequested} reminder(s) waiting for approval`,
        result: { overdue: overdue.map((x) => ({ invoiceId: x.i.id, number: x.i.number, daysOverdue: x.late, outstanding: x.due })), created, remindersRequested, skipped },
      };
    },
  };

  const receivables: TaskKind<Record<string, never>> = {
    kind: 'finance.receivables_snapshot',
    agent: 'finance',
    label: 'Receivables snapshot',
    description: 'Outstanding and overdue balances from issued invoices and VERIFIED payments, plus payments still waiting for verification.',
    userRunnable: true,
    parse: () => ({}),
    async run(ctx) {
      const r = await ctx.tool('invoices.read', () => finance.receivables(ctx.organizationId));
      const pending = await ctx.tool('payments.read', () => prisma.payment.aggregate({ where: { organizationId: ctx.organizationId, status: 'pending_verification' }, _sum: { amount: true }, _count: { _all: true } }));
      const outstanding = r2(r.invoices.reduce((a, i) => a + i.outstanding, 0));
      const overdue = r2(r.invoices.filter((i) => i.overdue).reduce((a, i) => a + i.outstanding, 0));
      return {
        status: 'completed',
        summary: `₹${outstanding} outstanding on ${r.invoices.length} invoice(s), ₹${overdue} overdue`,
        result: { outstanding, overdue, aging: r.aging, invoices: r.invoices.length, awaitingVerification: { count: pending._count._all, amount: r2(n(pending._sum.amount)) }, verified: true, note: 'Balances use verified payments only. Payments awaiting verification are listed separately and not counted as collected.' },
      };
    },
  };

  return [invoiceDraft, paymentVerified, overdueScan, receivables] as unknown as TaskKind[];
}
