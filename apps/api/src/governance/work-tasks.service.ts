import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

export type WorkTaskInput = {
  agent: 'marketing' | 'sales' | 'finance' | 'operations';
  kind: 'exception' | 'procurement' | 'production' | 'dispatch' | 'sample' | 'reconciliation' | 'review';
  title: string;
  detail?: string;
  priority?: 'normal' | 'high';
  assignee?: string;
  dueAt?: Date;
  entityType?: string;
  entityId?: string;
  /** Same key (per business) = same task: repeated events never create a second copy. */
  dedupeKey?: string;
  createdBy: string;
};

const NEXT: Record<string, string[]> = { open: ['in_progress', 'done', 'cancelled'], in_progress: ['open', 'done', 'cancelled'], done: [], cancelled: [] };

/** The stored (hashed, tenant-scoped) form of a dedupe key: use it to find a task created with that key. */
export const workTaskKey = (organizationId: string, key: string) => createHash('sha256').update(`${organizationId}|${key}`).digest('hex');

/** Jobs for people (operations exceptions, procurement, dispatch prep, sales reviews). */
@Injectable()
export class WorkTasksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, t: WorkTaskInput) {
    const dedupeKey = t.dedupeKey ? workTaskKey(organizationId, t.dedupeKey) : null;
    try {
      const task = await this.prisma.workTask.create({
        data: {
          organizationId, agent: t.agent, kind: t.kind, title: t.title.slice(0, 300), detail: t.detail?.slice(0, 8000) ?? null,
          priority: t.priority ?? 'normal', assignee: t.assignee ?? null, dueAt: t.dueAt ?? null, entityType: t.entityType ?? null, entityId: t.entityId ?? null,
          dedupeKey, createdBy: t.createdBy.slice(0, 191),
        },
      });
      return { task, created: true };
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002' || !dedupeKey) throw e;
      const task = await this.prisma.workTask.findFirst({ where: { dedupeKey, organizationId } });
      if (!task) throw e;
      return { task, created: false };
    }
  }

  list(organizationId: string, q: { agent?: string; status?: string; entityType?: string; entityId?: string } = {}) {
    return this.prisma.workTask.findMany({
      where: {
        organizationId,
        ...(q.agent ? { agent: q.agent } : {}),
        ...(q.status === 'active' ? { status: { in: ['open', 'in_progress'] } } : q.status ? { status: q.status } : {}),
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.entityId ? { entityId: q.entityId } : {}),
      },
      orderBy: [{ status: 'asc' }, { priority: 'asc' }, { createdAt: 'desc' }],
      take: 300,
    });
  }

  async update(organizationId: string, id: string, input: { status?: string; assignee?: string | null; resolution?: string; dueAt?: string | null }) {
    const t = await this.prisma.workTask.findFirst({ where: { id, organizationId } });
    if (!t) throw new NotFoundException('Task not found');
    const data: Record<string, unknown> = {};
    if (input.status !== undefined && input.status !== t.status) {
      if (!(NEXT[t.status] ?? []).includes(input.status)) throw new BadRequestException(`A ${t.status} task cannot move to ${input.status}`);
      if (input.status === 'done' && t.kind === 'exception' && !input.resolution?.trim()) throw new BadRequestException('Record the decision before closing an exception');
      data.status = input.status;
      if (input.status === 'done' || input.status === 'cancelled') data.completedAt = new Date();
    }
    if (input.assignee !== undefined) data.assignee = input.assignee?.trim().slice(0, 191) || null;
    if (input.resolution !== undefined) data.resolution = input.resolution.trim().slice(0, 4000) || null;
    if (input.dueAt !== undefined) {
      const d = input.dueAt ? new Date(input.dueAt) : null;
      if (d && Number.isNaN(d.getTime())) throw new BadRequestException('Invalid due date');
      data.dueAt = d;
    }
    const r = await this.prisma.workTask.updateMany({ where: { id, organizationId, status: t.status }, data });
    if (r.count === 0) throw new ConflictException('The task changed meanwhile; reload and try again');
    return this.prisma.workTask.findFirst({ where: { id } });
  }
}
