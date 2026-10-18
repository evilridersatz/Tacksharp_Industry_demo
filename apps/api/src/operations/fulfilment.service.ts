import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApprovalsService } from '../governance/approvals.service.js';
import { PERMISSIONS } from '../governance/permissions.js';
import { workTaskKey } from '../governance/work-tasks.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { TextileService } from '../textile/textile.service.js';
import { errorMessage, log } from '../common/logger.js';
import { InventoryService } from './inventory.service.js';

type User = { sub: string; role?: string };
const who = (u: User) => `user:${u.sub}`;
export const SHORTAGE_DECISIONS = ['revised_date', 'alternative', 'partial', 'cancel'] as const;
type Decision = (typeof SHORTAGE_DECISIONS)[number];

/**
 * Fulfilment decisions a person owns:
 *  - DISPATCH with courier / transporter and tracking (LR) number; the order moves to dispatched through the normal
 *    status change (Operations still blocks it until stock is reserved; stock is deducted by the Operations agent);
 *  - a STOCK-SHORTAGE DECISION (revised date, alternative product, partial order or cancellation) with the exact
 *    customer message. It needs sales.decide_shortage; once approved the order is updated, the shortage review task is
 *    closed and the approved message is queued for the customer (opt-out / window / template / DRY_RUN apply).
 */
@Injectable()
export class FulfilmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly textile: TextileService,
    private readonly inventory: InventoryService,
    @Optional() private readonly followUps?: FollowUpsService,
  ) {
    approvals.registerExecutor('sales.shortage_decision', async (a, by) => this.applyDecision(a.organizationId, a.payload as DecisionPayload, by, a.id));
  }

  private async order(organizationId: string, id: string) {
    const o = await this.prisma.salesOrder.findFirst({ where: { id, organizationId }, include: { customer: { select: { name: true, optedOutAt: true, doNotContact: true } } } });
    if (!o) throw new NotFoundException('Order not found');
    return o;
  }

  // ------------------------------------------------------------------ dispatch

  async dispatch(organizationId: string, id: string, input: { courier?: string; trackingRef?: string }, user: User) {
    const o = await this.order(organizationId, id);
    const courier = String(input.courier ?? '').trim().slice(0, 120);
    const trackingRef = String(input.trackingRef ?? '').trim().slice(0, 120);
    if (!courier) throw new BadRequestException('Enter the courier / transporter (or "own vehicle" / "customer pickup")');
    const before = { courier: o.courier, trackingRef: o.trackingRef, dispatchedAt: o.dispatchedAt };
    await this.prisma.salesOrder.update({ where: { id }, data: { courier, trackingRef: trackingRef || null, dispatchedAt: new Date() } });
    try {
      // Same path as the Orders page: transition rules, stock check (Operations), customer update, stock deduction.
      await this.textile.setOrderStatus(organizationId, id, 'dispatched', who(user));
    } catch (e) {
      await this.prisma.salesOrder.update({ where: { id }, data: before }); // not dispatched: no dispatch details either
      throw e;
    }
    await this.prisma.auditEvent.create({ data: { organizationId, actor: who(user), entityType: 'order', entityId: id, action: 'dispatch_details', data: { courier, trackingRef: trackingRef || null } } });
    return this.prisma.salesOrder.findUnique({ where: { id } });
  }

  // ------------------------------------------------------------------ stock shortage decision

  async shortage(organizationId: string, id: string) {
    const o = await this.order(organizationId, id);
    const stock = await this.inventory.orderStock(organizationId, id);
    const review = await this.prisma.workTask.findFirst({ where: { organizationId, entityType: 'order', entityId: id, dedupeKey: workTaskKey(organizationId, `shortage_review:${id}`) } });
    const decisions = await this.prisma.auditEvent.findMany({ where: { organizationId, entityType: 'order', entityId: id, action: 'shortage_decision' }, orderBy: { createdAt: 'desc' } });
    return { order: { id: o.id, number: o.number, status: o.status, expectedDelivery: o.expectedDelivery }, stock, reviewTask: review, decisions };
  }

  async requestDecision(organizationId: string, id: string, input: { decision?: string; newDate?: string; customerMessage?: string; note?: string }, user: User) {
    const o = await this.order(organizationId, id);
    if (['delivered', 'cancelled', 'dispatched'].includes(o.status)) throw new BadRequestException(`A ${o.status} order needs no shortage decision`);
    const decision = String(input.decision ?? '') as Decision;
    if (!SHORTAGE_DECISIONS.includes(decision)) throw new BadRequestException(`Decision must be one of ${SHORTAGE_DECISIONS.join(', ')}`);
    let newDate: string | null = null;
    if (decision === 'revised_date') {
      const d = new Date(String(input.newDate ?? ''));
      if (Number.isNaN(d.getTime()) || d.getTime() < Date.now()) throw new BadRequestException('Choose the revised delivery date (in the future)');
      newDate = d.toISOString();
    }
    const customerMessage = String(input.customerMessage ?? '').trim().slice(0, 500);
    if (customerMessage.length < 10) throw new BadRequestException('Write the message the customer will receive (it is sent exactly as approved)');
    const payload: DecisionPayload = { orderId: id, decision, newDate, customerMessage, note: String(input.note ?? '').trim().slice(0, 1000) || null };
    const r = await this.approvals.request(organizationId, {
      action: 'sales.shortage_decision', entityType: 'order', entityId: id, reason: `${o.number}: ${decision.replace('_', ' ')}${newDate ? ` → ${newDate.slice(0, 10)}` : ''}. Customer message: "${customerMessage.slice(0, 200)}"`,
      payload: payload as never, requiredPermission: PERMISSIONS.decideShortage, requestedBy: who(user), requesterRole: user.role,
    });
    if (!r.approved) return { approval: r.approval, applied: false };
    const result = await this.applyDecision(organizationId, payload, who(user), r.approval.id);
    await this.approvals.markExecuted(organizationId, r.approval.id, result);
    return { approval: r.approval, applied: true, result };
  }

  private async applyDecision(organizationId: string, p: DecisionPayload, by: string, approvalId: string) {
    const o = await this.order(organizationId, p.orderId);
    if (['delivered', 'cancelled', 'dispatched'].includes(o.status)) throw new ConflictException(`The order is already ${o.status}; the decision was not applied`);
    if (p.decision === 'revised_date' && p.newDate) await this.prisma.salesOrder.update({ where: { id: o.id }, data: { expectedDelivery: new Date(p.newDate) } });
    if (p.decision === 'cancel') await this.textile.setOrderStatus(organizationId, o.id, 'cancelled', by); // releases reserved stock (Operations)
    await this.prisma.auditEvent.create({ data: { organizationId, actor: by.slice(0, 191), entityType: 'order', entityId: o.id, action: 'shortage_decision', data: { ...p, approvalId } as never } });
    await this.prisma.workTask.updateMany({ where: { organizationId, entityType: 'order', entityId: o.id, dedupeKey: workTaskKey(organizationId, `shortage_review:${o.id}`), status: { in: ['open', 'in_progress'] } }, data: { status: 'done', completedAt: new Date(), resolution: `Decided: ${p.decision}${p.newDate ? ` (${p.newDate.slice(0, 10)})` : ''}` } });
    let customerUpdate = 'not sent: the order has no WhatsApp conversation (no lead)';
    if (o.customer?.optedOutAt || o.customer?.doNotContact) customerUpdate = 'not sent: customer opted out';
    else if (o.leadId && this.followUps) {
      await this.followUps.create({ organizationId, leadId: o.leadId, customerId: o.customerId, channel: 'whatsapp', action: 'message', source: 'order', message: `order:status:${o.id}:revised`, scheduledAt: new Date() })
        .then(() => (customerUpdate = 'queued (opt-out, WhatsApp window / template and DRY_RUN apply)'))
        .catch((e) => { customerUpdate = `not queued: ${errorMessage(e).slice(0, 120)}`; log.error('fulfilment.decision_notify_failed', { orderId: o.id, error: errorMessage(e) }); });
    }
    return { orderId: o.id, decision: p.decision, newDate: p.newDate, customerUpdate };
  }
}

type DecisionPayload = { orderId: string; decision: Decision; newDate: string | null; customerMessage: string; note: string | null };
