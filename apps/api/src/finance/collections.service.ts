import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApprovalsService } from '../governance/approvals.service.js';
import { WorkTasksService } from '../governance/work-tasks.service.js';
import { PERMISSIONS } from '../governance/permissions.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { errorMessage, log } from '../common/logger.js';
import { parseImportFile } from '../marketing/import-file.js';
import { FinanceEvents } from './finance-events.js';
import { daysOverdue, referenceKey } from './finance.service.js';

type User = { sub: string; role?: string };
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const DAY = 86_400_000;
const OPEN_INVOICE = ['issued', 'partially_paid'];
export const NOTE_TYPES = ['contact', 'promise', 'dispute', 'outcome'] as const;
export const EXPENSE_CATEGORIES = ['purchase', 'freight', 'salaries', 'rent', 'utilities', 'marketing', 'other'] as const;
/** At most one reminder per invoice in this many days (sent or waiting). */
export const REMINDER_GAP_DAYS = 3;
const who = (u: User) => `user:${u.sub}`;

/** The reminder text the approver sees and the customer receives (re-rendered at send time with the then-current balance). */
export function reminderText(p: { customerName: string | null; invoiceNumber: string; outstanding: number; dueDate: Date | null; orgName: string }) {
  const first = (p.customerName ?? '').trim().split(/\s+/)[0] || 'there';
  const due = p.dueDate ? ` (due ${p.dueDate.toISOString().slice(0, 10)})` : '';
  return `Hi ${first}, a gentle reminder from ${p.orgName}: ₹${p.outstanding} is pending on invoice ${p.invoiceNumber}${due}. If you have already paid, please share the UTR / reference so we can match it. Thank you!`;
}

/**
 * Collections and money-out for Finance:
 *  - contact notes, payment PROMISES (kept / broken), DISPUTES (pause reminders, open a review task), outcomes;
 *  - payment REMINDERS: prepared by Finance, sent only after a person with finance.send_reminder approves the exact text,
 *    through the follow-up queue (opt-out, 24 h window and approved template enforced there; DRY_RUN never sends).
 *    Every reminder is re-checked when approved and again when sent: paid / cancelled / disputed invoices are skipped;
 *  - bank statement MATCHING: read-only. Statement lines are matched to recorded payments; unmatched money,
 *    mismatched amounts and recorded payments missing from the statement become reconciliation tasks. It never verifies;
 *  - EXPENSES (voided, never deleted) and gross margin where product cost is recorded.
 */
@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly workTasks: WorkTasksService,
    @Optional() private readonly followUps?: FollowUpsService,
    @Optional() events?: FinanceEvents,
  ) {
    approvals.registerExecutor('finance.reminder_send', async (a, by) => {
      const p = a.payload as { noteId?: string; invoiceId?: string };
      if (!p.noteId || !p.invoiceId) throw new Error('Approval has no reminder');
      return this.queueApprovedReminder(a.organizationId, p.noteId, by);
    });
    // A verified payment that clears the invoice stops its reminders and closes its collection tasks.
    events?.onPaymentVerified(async (e) => this.stopIfSettled(e.organizationId, e.invoiceId, `payment verified (${e.paymentId})`));
  }

  private audit(organizationId: string, actor: string, invoiceId: string, action: string, data?: Record<string, unknown>) {
    return this.prisma.auditEvent.create({ data: { organizationId, actor: actor.slice(0, 191), entityType: 'invoice', entityId: invoiceId, action, data: (data ?? undefined) as never } });
  }

  private async invoice(organizationId: string, invoiceId: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, organizationId }, include: { customer: true, order: { select: { id: true, number: true, leadId: true } } } });
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  // ================================================================== notes, promises, disputes

  async notes(organizationId: string, invoiceId: string) {
    await this.invoice(organizationId, invoiceId);
    await this.markBrokenPromises(organizationId);
    const rows = await this.prisma.collectionNote.findMany({ where: { organizationId, invoiceId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((r) => ({ ...r, promisedAmount: r.promisedAmount === null ? null : n(r.promisedAmount) }));
  }

  async addNote(organizationId: string, invoiceId: string, input: { type?: string; note?: string; promisedAmount?: number; promisedDate?: string }, user: User) {
    const inv = await this.invoice(organizationId, invoiceId);
    const type = String(input.type ?? '');
    if (!(NOTE_TYPES as readonly string[]).includes(type)) throw new BadRequestException(`Type must be one of ${NOTE_TYPES.join(', ')}`);
    const note = String(input.note ?? '').trim().slice(0, 2000) || null;
    const data: Prisma.CollectionNoteUncheckedCreateInput = { organizationId, invoiceId, customerId: inv.customerId, type, note, createdBy: who(user), status: type === 'promise' || type === 'dispute' ? 'open' : 'recorded' };
    if (type === 'promise') {
      const outstanding = r2(n(inv.total) - n(inv.amountPaid));
      const amount = Number(input.promisedAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Enter the amount the customer promised');
      if (amount > outstanding + 0.005) throw new BadRequestException(`The promise (₹${amount}) is more than the ₹${outstanding} outstanding`);
      const date = new Date(String(input.promisedDate ?? ''));
      if (Number.isNaN(date.getTime())) throw new BadRequestException('Enter the date the customer promised to pay');
      data.promisedAmount = new Prisma.Decimal(amount.toFixed(2));
      data.promisedDate = date;
    } else if (!note) throw new BadRequestException('Write what happened');
    const row = await this.prisma.collectionNote.create({ data });
    await this.audit(organizationId, who(user), invoiceId, `collection:${type}`, { noteId: row.id, promisedAmount: data.promisedAmount ? n(data.promisedAmount) : undefined });
    if (type === 'dispute') {
      // A disputed invoice gets no reminders until the dispute is resolved; a person reviews it.
      await this.cancelPendingReminders(organizationId, invoiceId, 'invoice disputed', who(user));
      await this.workTasks.create(organizationId, { agent: 'finance', kind: 'review', priority: 'high', title: `Dispute on ${inv.number}: ${String(note).slice(0, 120)}`, detail: 'Reminders are paused until this dispute is marked resolved.', entityType: 'invoice', entityId: invoiceId, dedupeKey: `dispute:${row.id}`, createdBy: who(user) });
    }
    return row;
  }

  /** promise → kept / broken; dispute → resolved. */
  async setNoteStatus(organizationId: string, id: string, status: string, user: User, note?: string) {
    const row = await this.prisma.collectionNote.findFirst({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('Note not found');
    const allowed: Record<string, string[]> = { promise: ['kept', 'broken'], dispute: ['resolved'] };
    if (!allowed[row.type]?.includes(status) || row.status !== 'open') throw new BadRequestException(`A ${row.status} ${row.type} cannot become ${status}`);
    await this.prisma.collectionNote.update({ where: { id }, data: { status, resolvedAt: new Date(), note: note?.trim() ? `${row.note ?? ''}\n${status}: ${note.trim()}`.trim().slice(0, 2000) : row.note } });
    await this.audit(organizationId, who(user), row.invoiceId, `collection:${row.type}_${status}`, { noteId: id });
    return this.prisma.collectionNote.findUnique({ where: { id } });
  }

  /** Promises whose date passed while the invoice still has the promised amount outstanding. */
  async markBrokenPromises(organizationId: string) {
    const due = await this.prisma.collectionNote.findMany({ where: { organizationId, type: 'promise', status: 'open', promisedDate: { lt: new Date(Date.now() - DAY) } }, include: { invoice: { select: { total: true, amountPaid: true, status: true } } } });
    for (const p of due) {
      const settled = p.invoice.status === 'paid' || n(p.invoice.total) - n(p.invoice.amountPaid) <= 0.005;
      await this.prisma.collectionNote.updateMany({ where: { id: p.id, status: 'open' }, data: { status: settled ? 'kept' : 'broken', resolvedAt: new Date() } });
    }
    return due.length;
  }

  /** An open promise that is not yet due: no reminder, no new collection task. */
  async openPromise(organizationId: string, invoiceId: string) {
    return this.prisma.collectionNote.findFirst({ where: { organizationId, invoiceId, type: 'promise', status: 'open', promisedDate: { gte: new Date(Date.now() - DAY) } } });
  }

  // ================================================================== reminders

  /** Why a reminder cannot be sent now (null = eligible). Checked on request, on approval and on sending. */
  async reminderBlocker(organizationId: string, invoiceId: string, opts: { exceptNoteId?: string } = {}): Promise<string | null> {
    const inv = await this.invoice(organizationId, invoiceId);
    if (!OPEN_INVOICE.includes(inv.status)) return `invoice is ${inv.status}`;
    const outstanding = r2(n(inv.total) - n(inv.amountPaid));
    if (outstanding <= 0.005) return 'nothing outstanding';
    if (daysOverdue(inv.dueDate) <= 0) return 'not overdue yet';
    if (inv.customer.optedOutAt || inv.customer.doNotContact) return 'customer opted out of messages';
    if (!inv.customer.phone) return 'customer has no phone number';
    if (!inv.order?.leadId) return 'order has no lead / WhatsApp conversation to send through';
    if (await this.prisma.collectionNote.count({ where: { organizationId, invoiceId, type: 'dispute', status: 'open' } })) return 'invoice is disputed';
    const promise = await this.openPromise(organizationId, invoiceId);
    if (promise) return `customer promised ₹${n(promise.promisedAmount)} by ${promise.promisedDate?.toISOString().slice(0, 10)}`;
    const recent = await this.prisma.collectionNote.count({
      where: { organizationId, invoiceId, type: 'reminder', id: opts.exceptNoteId ? { not: opts.exceptNoteId } : undefined, OR: [{ status: { in: ['pending_approval', 'queued'] } }, { status: 'sent', updatedAt: { gte: new Date(Date.now() - REMINDER_GAP_DAYS * DAY) } }] },
    });
    if (recent) return `a reminder is already waiting or was sent in the last ${REMINDER_GAP_DAYS} days`;
    const pendingPayments = await this.prisma.payment.count({ where: { organizationId, invoiceId, status: 'pending_verification' } });
    if (pendingPayments) return 'a payment for this invoice is waiting for verification';
    return null;
  }

  /** Prepare a reminder; it waits for someone with finance.send_reminder (who approves by requesting it themselves). */
  async requestReminder(organizationId: string, invoiceId: string, user: User, opts: { requestedBy?: string } = {}) {
    // An agent (requestedBy agent:finance) never approves its own request: it always waits for a person.
    const requester = opts.requestedBy ?? who(user);
    const requesterRole = opts.requestedBy ? undefined : user.role;
    const blocker = await this.reminderBlocker(organizationId, invoiceId);
    if (blocker) throw new BadRequestException(`No reminder: ${blocker}`);
    const inv = await this.invoice(organizationId, invoiceId);
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    const outstanding = r2(n(inv.total) - n(inv.amountPaid));
    const text = reminderText({ customerName: inv.customer.name, invoiceNumber: inv.number, outstanding, dueDate: inv.dueDate, orgName: org?.name ?? 'us' });
    const note = await this.prisma.collectionNote.create({ data: { organizationId, invoiceId, customerId: inv.customerId, type: 'reminder', note: text, status: 'pending_approval', createdBy: requester } });
    const r = await this.approvals.request(organizationId, {
      action: 'finance.reminder_send', entityType: 'invoice', entityId: invoiceId, reason: `Payment reminder for ${inv.number}: ₹${outstanding} outstanding, ${daysOverdue(inv.dueDate)} day(s) overdue`,
      payload: { noteId: note.id, invoiceId, outstanding, text }, requiredPermission: PERMISSIONS.sendReminder, requestedBy: requester, requesterRole,
    });
    await this.prisma.collectionNote.update({ where: { id: note.id }, data: { approvalId: r.approval.id } });
    await this.audit(organizationId, requester, invoiceId, 'reminder_requested', { noteId: note.id, approvalId: r.approval.id });
    if (r.approved) {
      const result = await this.queueApprovedReminder(organizationId, note.id, requester);
      await this.approvals.markExecuted(organizationId, r.approval.id, result);
    }
    return this.prisma.collectionNote.findUnique({ where: { id: note.id } });
  }

  private async queueApprovedReminder(organizationId: string, noteId: string, by: string) {
    const note = await this.prisma.collectionNote.findFirst({ where: { id: noteId, organizationId, type: 'reminder' } });
    if (!note || note.status !== 'pending_approval') throw new ConflictException('The reminder is no longer waiting for approval');
    const blocker = await this.reminderBlocker(organizationId, note.invoiceId, { exceptNoteId: noteId });
    if (blocker) {
      await this.prisma.collectionNote.update({ where: { id: noteId }, data: { status: 'skipped', note: `${note.note}\n(not sent: ${blocker})`.slice(0, 2000) } });
      return { noteId, queued: false, reason: blocker };
    }
    if (!this.followUps) throw new Error('Follow-up queue not available');
    const inv = await this.invoice(organizationId, note.invoiceId);
    const f = await this.followUps.create({ organizationId, leadId: inv.order!.leadId!, customerId: inv.customerId, channel: 'whatsapp', action: 'message', source: 'invoice', message: `invoice:reminder:${inv.id}:${noteId}`, scheduledAt: new Date() });
    await this.prisma.collectionNote.update({ where: { id: noteId }, data: { status: 'queued', followUpId: f.id } });
    await this.audit(organizationId, by, inv.id, 'reminder_queued', { noteId, followUpId: f.id });
    return { noteId, queued: true, followUpId: f.id };
  }

  private async cancelPendingReminders(organizationId: string, invoiceId: string, reason: string, by: string) {
    const waiting = await this.prisma.collectionNote.findMany({ where: { organizationId, invoiceId, type: 'reminder', status: { in: ['pending_approval', 'queued'] } } });
    for (const w of waiting) {
      if (w.status === 'pending_approval' && w.approvalId) await this.approvals.cancel(organizationId, w.approvalId, by).catch(() => undefined);
      if (w.followUpId) await this.prisma.followUp.updateMany({ where: { id: w.followUpId, status: 'scheduled' }, data: { status: 'cancelled', cancellationReason: reason } });
      await this.prisma.collectionNote.update({ where: { id: w.id }, data: { status: 'cancelled', note: `${w.note ?? ''}\n(cancelled: ${reason})`.slice(0, 2000) } });
    }
    return waiting.length;
  }

  /** Paid / cancelled invoice: stop reminders, close its open collection tasks. */
  async stopIfSettled(organizationId: string, invoiceId: string, reason: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, organizationId }, select: { status: true, total: true, amountPaid: true } });
    if (!inv) return 0;
    const settled = inv.status === 'paid' || inv.status === 'cancelled' || n(inv.total) - n(inv.amountPaid) <= 0.005;
    if (!settled) return 0;
    const cancelled = await this.cancelPendingReminders(organizationId, invoiceId, reason, 'agent:finance');
    await this.prisma.workTask.updateMany({ where: { organizationId, agent: 'finance', kind: 'review', entityType: 'invoice', entityId: invoiceId, status: { in: ['open', 'in_progress'] } }, data: { status: 'done', completedAt: new Date(), resolution: `Closed automatically: ${reason}` } });
    await this.prisma.collectionNote.updateMany({ where: { organizationId, invoiceId, type: 'promise', status: 'open' }, data: { status: 'kept', resolvedAt: new Date() } });
    return cancelled;
  }

  /** Called by the follow-up worker after the WhatsApp step ran. */
  async reminderResult(organizationId: string, noteId: string, result: { status: 'sent' | 'skipped' | 'failed'; detail?: string }) {
    const note = await this.prisma.collectionNote.findFirst({ where: { id: noteId, organizationId } });
    if (!note) return;
    await this.prisma.collectionNote.update({ where: { id: noteId }, data: { status: result.status, note: result.detail ? `${note.note ?? ''}\n(${result.status}: ${result.detail})`.slice(0, 2000) : note.note } });
    await this.audit(organizationId, 'agent:finance', note.invoiceId, `reminder_${result.status}`, { noteId, detail: result.detail });
  }

  // ================================================================== bank statement matching (read-only)

  /**
   * Match a bank statement export (CSV / XLSX with date, amount and reference / narration columns) against payments
   * recorded in Tacksharp. Nothing is verified here: a match only tells the verifier the money is in the bank.
   */
  async matchStatement(organizationId: string, file: { originalname?: string; buffer?: Buffer } | undefined, user: User) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose the bank statement (CSV or .xlsx).');
    let table;
    try {
      table = parseImportFile(file.originalname ?? 'statement.csv', file.buffer);
    } catch (e) {
      throw new BadRequestException(`Could not read the statement: ${errorMessage(e).slice(0, 160)}`);
    }
    const head = table.header.map((h) => h.toLowerCase().trim());
    const col = (...names: string[]) => head.findIndex((h) => names.some((x) => h === x || h.includes(x)));
    const iDate = col('date', 'txn date', 'value date');
    const iAmount = col('credit', 'deposit', 'amount');
    const iRef = col('utr', 'reference', 'ref', 'narration', 'description', 'particulars', 'remarks');
    if (iAmount < 0 || iRef < 0) throw new BadRequestException('The statement needs an amount (credit) column and a reference / narration column.');
    const lines = table.rows
      .map((r, i) => ({ row: i + 2, date: iDate >= 0 ? new Date(r[iDate]) : null, amount: r2(Number(String(r[iAmount] ?? '').replace(/[^0-9.\-]/g, ''))), raw: String(r[iRef] ?? '').slice(0, 300) }))
      .filter((l) => Number.isFinite(l.amount) && l.amount > 0);
    const payments = await this.prisma.payment.findMany({ where: { organizationId, status: { in: ['pending_verification', 'verified'] }, referenceKey: { not: null } }, include: { invoice: { select: { number: true } } } });
    const byKey = new Map(payments.map((p) => [p.referenceKey!, p]));
    const used = new Set<string>();
    const matched: unknown[] = [], mismatched: unknown[] = [], unmatched: unknown[] = [];
    for (const l of lines) {
      // A UTR appears inside the narration ("UPI/452188771234/RAMESH"): any recorded reference found in it matches.
      const text = l.raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const tokens = new Set([referenceKey(l.raw), ...l.raw.split(/[^A-Za-z0-9]+/).map((t) => referenceKey(t))].filter(Boolean) as string[]);
      const p = [...tokens].map((k) => byKey.get(k)).find(Boolean) ?? payments.find((x) => x.referenceKey!.length >= 8 && text.includes(x.referenceKey!) && !used.has(x.id));
      if (!p) { unmatched.push({ row: l.row, amount: l.amount, reference: l.raw }); continue; }
      used.add(p.id);
      const row = { row: l.row, amount: l.amount, reference: l.raw, paymentId: p.id, recordedAmount: n(p.amount), paymentStatus: p.status, invoice: p.invoice?.number ?? null };
      if (Math.abs(n(p.amount) - l.amount) > 0.005) mismatched.push(row);
      else matched.push(row);
    }
    const dates = lines.map((l) => l.date?.getTime()).filter((t): t is number => Number.isFinite(t));
    const from = dates.length ? new Date(Math.min(...dates)) : null;
    const to = dates.length ? new Date(Math.max(...dates) + DAY) : null;
    const missing = payments
      .filter((p) => !used.has(p.id) && p.method !== 'cash' && (!from || !to || (p.paidAt >= from && p.paidAt <= to)))
      .map((p) => ({ paymentId: p.id, amount: n(p.amount), reference: p.reference ?? p.transactionId, status: p.status, invoice: p.invoice?.number ?? null, paidAt: p.paidAt }));
    // Exceptions a person must look at (deduplicated per payment / statement line).
    const stamp = from ? from.toISOString().slice(0, 10) : 'nodate';
    for (const m of mismatched as Array<{ paymentId: string; amount: number; recordedAmount: number; invoice: string | null }>)
      await this.workTasks.create(organizationId, { agent: 'finance', kind: 'reconciliation', priority: 'high', title: `Amount mismatch: bank ₹${m.amount} vs recorded ₹${m.recordedAmount}${m.invoice ? ` (${m.invoice})` : ''}`, detail: 'The bank statement amount differs from the payment recorded in Tacksharp. Do not verify until it is explained.', entityType: 'payment', entityId: m.paymentId, dedupeKey: `stmt:mismatch:${m.paymentId}`, createdBy: who(user) });
    for (const m of missing.filter((x) => x.status === 'verified'))
      await this.workTasks.create(organizationId, { agent: 'finance', kind: 'reconciliation', priority: 'high', title: `Verified payment ₹${m.amount} (${m.reference ?? 'no ref'}) not found in the bank statement`, detail: 'A payment marked verified does not appear in the statement for its date range. Check the evidence; reverse through the approval queue if it was wrong.', entityType: 'payment', entityId: m.paymentId, dedupeKey: `stmt:missing:${m.paymentId}:${stamp}`, createdBy: who(user) });
    log.info('finance.statement_matched', { organizationId, lines: lines.length, matched: matched.length, mismatched: mismatched.length, unmatched: unmatched.length, missing: missing.length });
    return {
      lines: lines.length, matched, mismatched, unmatchedStatementLines: unmatched, recordedNotInStatement: missing, period: { from, to },
      note: 'Read-only: nothing was verified. Matches help the verifier; unmatched bank credits may be payments nobody recorded yet.',
    };
  }

  // ================================================================== expenses

  async expenses(organizationId: string, q: { from?: string; to?: string; category?: string } = {}) {
    const where: Prisma.ExpenseWhereInput = { organizationId };
    if (q.category) where.category = q.category;
    if (q.from || q.to) where.spentOn = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
    const rows = await this.prisma.expense.findMany({ where, orderBy: { spentOn: 'desc' }, take: 500 });
    return rows.map((r) => ({ ...r, amount: n(r.amount) }));
  }

  async recordExpense(organizationId: string, input: { spentOn?: string; category?: string; amount?: number; vendor?: string; reference?: string; notes?: string; confirmDuplicate?: boolean }, user: User) {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw new BadRequestException('Enter the amount spent');
    const category = String(input.category ?? '');
    if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) throw new BadRequestException(`Category must be one of ${EXPENSE_CATEGORIES.join(', ')}`);
    const spentOn = new Date(String(input.spentOn ?? ''));
    if (Number.isNaN(spentOn.getTime()) || spentOn.getTime() > Date.now() + DAY) throw new BadRequestException('Enter the date (not in the future)');
    const key = referenceKey(input.reference);
    if (key && !input.confirmDuplicate) {
      const dup = await this.prisma.expense.findFirst({ where: { organizationId, referenceKey: key, status: 'recorded' } });
      if (dup) throw new ConflictException(`An expense with reference ${input.reference} is already recorded (₹${n(dup.amount)} on ${dup.spentOn.toISOString().slice(0, 10)}). Confirm to record it again.`);
    }
    const e = await this.prisma.expense.create({
      data: { organizationId, spentOn, category, amount: new Prisma.Decimal(amount.toFixed(2)), vendor: input.vendor?.trim().slice(0, 191) || null, reference: input.reference?.trim().slice(0, 191) || null, referenceKey: key, notes: input.notes?.trim().slice(0, 2000) || null, recordedBy: who(user) },
    });
    await this.prisma.auditEvent.create({ data: { organizationId, actor: who(user), entityType: 'expense', entityId: e.id, action: 'expense_recorded', data: { amount: r2(amount), category } } });
    return { ...e, amount: n(e.amount) };
  }

  async voidExpense(organizationId: string, id: string, reason: string | undefined, user: User) {
    if (!reason?.trim()) throw new BadRequestException('Give the reason');
    const r = await this.prisma.expense.updateMany({ where: { id, organizationId, status: 'recorded' }, data: { status: 'void', voidReason: reason.trim().slice(0, 2000) } });
    if (!r.count) throw new BadRequestException('Only a recorded expense can be voided');
    await this.prisma.auditEvent.create({ data: { organizationId, actor: who(user), entityType: 'expense', entityId: id, action: 'expense_voided', data: { reason: reason.trim().slice(0, 300) } } });
    return { ok: true };
  }

  /**
   * Revenue (issued invoices), cash collected (verified payments), expenses and gross margin for a period.
   * Gross margin only covers invoice lines whose product has a recorded unit cost; coverage is shown. No profit figure
   * is given unless every invoiced line is costed (and even then it is an estimate, not accounting profit).
   */
  async profitability(organizationId: string, days = 30) {
    const since = new Date(Date.now() - Math.min(365, Math.max(1, days)) * DAY);
    const [invoices, collected, expenses] = await Promise.all([
      this.prisma.invoice.findMany({ where: { organizationId, invoiceDate: { gte: since }, status: { in: ['issued', 'partially_paid', 'paid'] } }, include: { items: true } }),
      this.prisma.payment.aggregate({ where: { organizationId, status: 'verified', verifiedAt: { gte: since } }, _sum: { amount: true } }),
      this.prisma.expense.groupBy({ by: ['category'], where: { organizationId, status: 'recorded', spentOn: { gte: since } }, _sum: { amount: true } }),
    ]);
    const productIds = [...new Set(invoices.flatMap((i) => i.items.map((l) => l.productId).filter((x): x is string => !!x)))];
    const costs = new Map((await this.prisma.textileProduct.findMany({ where: { organizationId, id: { in: productIds } }, select: { id: true, unitCost: true } })).map((p) => [p.id, p.unitCost === null ? null : n(p.unitCost)]));
    let lineRevenue = 0, costedRevenue = 0, cost = 0;
    for (const l of invoices.flatMap((i) => i.items)) {
      lineRevenue += n(l.lineTotal);
      const c = l.productId ? costs.get(l.productId) : null;
      if (c !== null && c !== undefined) { costedRevenue += n(l.lineTotal); cost += c * n(l.quantity); }
    }
    const expenseTotal = r2(expenses.reduce((a, e) => a + n(e._sum.amount), 0));
    const coverage = lineRevenue > 0 ? Math.round((costedRevenue / lineRevenue) * 1000) / 10 : 0;
    const grossMargin = costedRevenue > 0 ? r2(costedRevenue - cost) : null;
    return {
      days,
      revenueInvoiced: r2(invoices.reduce((a, i) => a + n(i.total), 0)),
      cashCollectedVerified: r2(n(collected._sum.amount)),
      expenses: { total: expenseTotal, byCategory: Object.fromEntries(expenses.map((e) => [e.category, r2(n(e._sum.amount))])) },
      grossMargin: { amount: grossMargin, costedRevenue: r2(costedRevenue), cost: r2(cost), coveragePct: coverage, marginPct: grossMargin !== null && costedRevenue > 0 ? Math.round((grossMargin / costedRevenue) * 1000) / 10 : null },
      operatingEstimate: coverage >= 99.95 && grossMargin !== null ? r2(grossMargin - expenseTotal) : null,
      notes: [
        'Revenue = issued invoices dated in the period (before tax lines are separated: invoice totals). Cash collected = payments VERIFIED in the period. They are different numbers.',
        coverage < 99.95 ? `Gross margin covers only ${coverage}% of invoiced line value (products without a unit cost are excluded). Add unit costs in the catalogue for a complete figure.` : 'Gross margin uses current unit costs from the catalogue.',
        'Not accounting profit: no ledger or accounting system is connected.',
      ],
    };
  }

  /** Unit costs (internal): only Finance sees and sets them; they drive gross margin. */
  async unitCosts(organizationId: string) {
    const rows = await this.prisma.textileProduct.findMany({ where: { organizationId }, select: { id: true, sku: true, name: true, priceUnit: true, price: true, priceApproved: true, unitCost: true, active: true }, orderBy: [{ active: 'desc' }, { name: 'asc' }], take: 500 });
    return rows.map((r) => ({ ...r, price: r.price === null ? null : n(r.price), unitCost: r.unitCost === null ? null : n(r.unitCost) }));
  }

  async setUnitCost(organizationId: string, productId: string, value: number | null | undefined, user: User) {
    const p = await this.prisma.textileProduct.findFirst({ where: { id: productId, organizationId } });
    if (!p) throw new NotFoundException('Product not found');
    let cost: Prisma.Decimal | null = null;
    if (value !== null && value !== undefined && String(value) !== '') {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > 10_000_000) throw new BadRequestException('Enter the cost per unit in rupees (or leave empty)');
      cost = new Prisma.Decimal(v.toFixed(2));
    }
    await this.prisma.textileProduct.update({ where: { id: productId }, data: { unitCost: cost } });
    await this.prisma.auditEvent.create({ data: { organizationId, actor: who(user), entityType: 'product', entityId: productId, action: 'unit_cost_set', data: { from: p.unitCost === null ? null : n(p.unitCost), to: cost === null ? null : n(cost) } } });
    return { productId, unitCost: cost === null ? null : n(cost) };
  }

  logFailure(where: string, e: unknown) {
    log.error(`finance.collections_${where}_failed`, { error: errorMessage(e) });
  }
}
