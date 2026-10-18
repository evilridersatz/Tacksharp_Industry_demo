import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { errorMessage, log } from '../common/logger.js';
import { can } from './permissions.js';

export type ApprovalRequest = {
  action: string;
  entityType: string;
  entityId: string;
  reason: string;
  /** The exact proposed change. An approval only ever authorises THIS payload (matched by hash). */
  payload: Record<string, unknown>;
  requiredPermission: string;
  /** user:<id> | agent:<name> */
  requestedBy: string;
  /** Role of a requesting user; a user who already holds the permission approves by acting (recorded). */
  requesterRole?: string;
  taskId?: string;
  expiresInHours?: number;
};

type ApprovalRow = Awaited<ReturnType<PrismaService['approval']['findFirst']>> & {};
export type Executor = (approval: NonNullable<ApprovalRow>, decidedBy: string) => Promise<unknown>;

/** Stable JSON (sorted keys) so the same proposal always hashes the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const payloadHash = (payload: unknown) => createHash('sha256').update(stable(payload)).digest('hex');

/**
 * Central approvals. A restricted action (exceptional discount, stock correction, an agent action that binds the
 * business) is recorded with the exact proposal, the permission it needs, who asked and why. Only a person holding
 * that permission can approve; on approval the registered executor carries out exactly that proposal and the
 * result is stored. Rejected / cancelled / expired requests never execute.
 */
@Injectable()
export class ApprovalsService {
  private readonly executors = new Map<string, Executor>();

  constructor(private readonly prisma: PrismaService) {}

  registerExecutor(action: string, fn: Executor) {
    this.executors.set(action, fn);
  }

  async request(organizationId: string, req: ApprovalRequest) {
    const hash = payloadHash(req.payload);
    const expiresAt = new Date(Date.now() + (req.expiresInHours ?? 24 * 7) * 3_600_000);
    const base = {
      organizationId, action: req.action, entityType: req.entityType, entityId: req.entityId, requestedBy: req.requestedBy.slice(0, 191),
      reason: req.reason.slice(0, 4000), payload: req.payload as never, payloadHash: hash, requiredPermission: req.requiredPermission, expiresAt, taskId: req.taskId ?? null,
    };
    // A person who already holds the permission approves by doing it: recorded as approved by them.
    if (req.requestedBy.startsWith('user:') && can(req.requesterRole, req.requiredPermission)) {
      const approval = await this.prisma.approval.create({ data: { ...base, status: 'approved', decidedBy: req.requestedBy, decidedAt: new Date(), decisionNote: 'Requester holds the permission' } });
      return { approval, approved: true as const };
    }
    const openKey = createHash('sha256').update(`${organizationId}|${req.action}|${req.entityType}|${req.entityId}|${hash}`).digest('hex');
    try {
      const approval = await this.prisma.approval.create({ data: { ...base, status: 'pending', openKey } });
      log.info('approval.requested', { organizationId, action: req.action, entityId: req.entityId, approvalId: approval.id });
      return { approval, approved: false as const };
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const existing = await this.prisma.approval.findFirst({ where: { openKey } });
      if (!existing) throw e;
      return { approval: existing, approved: false as const }; // the same request is already waiting
    }
  }

  /** An approved, not yet used approval for exactly this proposal (null if none / expired / for another proposal). */
  findApproved(organizationId: string, action: string, entityId: string, payload: Record<string, unknown>) {
    return this.prisma.approval.findFirst({
      where: { organizationId, action, entityId, payloadHash: payloadHash(payload), status: 'approved', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { decidedAt: 'desc' },
    });
  }

  async markExecuted(organizationId: string, id: string, result: unknown) {
    await this.prisma.approval.updateMany({ where: { id, organizationId, status: 'approved' }, data: { status: 'executed', executedAt: new Date(), executionResult: (result ?? {}) as never } });
  }

  async list(organizationId: string, status?: string) {
    await this.expireOld(organizationId);
    return this.prisma.approval.findMany({ where: { organizationId, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async get(organizationId: string, id: string) {
    const a = await this.prisma.approval.findFirst({ where: { id, organizationId } });
    if (!a) throw new NotFoundException('Approval not found');
    return a;
  }

  private async expireOld(organizationId: string) {
    await this.prisma.approval.updateMany({ where: { organizationId, status: 'pending', expiresAt: { lt: new Date() } }, data: { status: 'expired', openKey: null } });
  }

  /**
   * Approve or reject. Server-side: the decider must hold the request's permission. Approve runs the executor with
   * the stored payload; its outcome is recorded (executed / failed) - an approval never reports success it did not have.
   */
  async decide(organizationId: string, id: string, decision: 'approve' | 'reject', user: { sub: string; role?: string }, note?: string) {
    await this.expireOld(organizationId);
    const a = await this.get(organizationId, id);
    if (a.status !== 'pending') throw new ConflictException(`This request is already ${a.status}`);
    if (!can(user.role, a.requiredPermission)) throw new ForbiddenException(`You need the "${a.requiredPermission}" permission to decide this.`);
    if (decision === 'reject' && !note?.trim()) throw new BadRequestException('Give a reason for rejecting');
    const decidedBy = `user:${user.sub}`;
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const claimed = await this.prisma.approval.updateMany({
      where: { id, organizationId, status: 'pending' },
      data: { status, openKey: null, decidedBy, decidedAt: new Date(), decisionNote: note?.trim().slice(0, 2000) || null },
    });
    if (claimed.count === 0) throw new ConflictException('Someone else decided this request just now');
    log.info('approval.decided', { organizationId, approvalId: id, action: a.action, status });
    const decided = await this.get(organizationId, id);
    const executor = this.executors.get(a.action);
    if (decision === 'reject' || !executor) return decided;
    try {
      const result = await executor(decided, decidedBy);
      await this.prisma.approval.updateMany({ where: { id, status: { in: ['approved', 'executed'] } }, data: { status: 'executed', executedAt: new Date(), executionResult: (result ?? {}) as never } });
    } catch (e) {
      log.error('approval.execute_failed', { organizationId, approvalId: id, action: a.action, error: errorMessage(e) });
      await this.prisma.approval.update({ where: { id }, data: { status: 'failed', executionResult: { error: errorMessage(e).slice(0, 500) } as never } });
    }
    return this.get(organizationId, id);
  }

  async cancel(organizationId: string, id: string, by: string) {
    const r = await this.prisma.approval.updateMany({ where: { id, organizationId, status: 'pending' }, data: { status: 'cancelled', openKey: null, decidedBy: by.slice(0, 191), decidedAt: new Date() } });
    if (r.count === 0) throw new ConflictException('Only a pending request can be cancelled');
    return this.get(organizationId, id);
  }
}
