import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export type DefectEntry = { category: string; count: number };
export const DEFECT_SEVERITIES = ['minor', 'major', 'critical'] as const;
const DAY = 86_400_000;
const r1 = (v: number) => Math.round(v * 10) / 10;

export function parseDefects(raw: unknown): DefectEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const merged = new Map<string, number>();
  for (const d of list.slice(0, 30)) {
    const o = (d && typeof d === 'object' ? d : {}) as { category?: unknown; count?: unknown };
    const category = String(o.category ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    const count = Math.round(Number(o.count));
    if (!category || !Number.isFinite(count) || count <= 0) continue;
    merged.set(category, (merged.get(category) ?? 0) + Math.min(count, 1_000_000));
  }
  return [...merged.entries()].map(([category, count]) => ({ category, count }));
}

/**
 * Manufacturing & quality control: inspections entered by people (no camera, sensor or CV model is connected). Rates
 * are computed from recorded quantities only: defect rate = defects / units inspected, rejection rate = rejected /
 * inspected.
 */
@Injectable()
export class QualityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, q: { status?: string; q?: string; take?: number } = {}) {
    const where: Prisma.QualityInspectionWhereInput = { organizationId };
    if (q.status === 'open' || q.status === 'resolved') where.status = q.status;
    if (q.q?.trim()) where.OR = [{ batchCode: { contains: q.q.trim() } }, { productName: { contains: q.q.trim() } }, { line: { contains: q.q.trim() } }];
    const rows = await this.prisma.qualityInspection.findMany({ where, orderBy: { inspectedAt: 'desc' }, take: Math.min(q.take ?? 200, 500) });
    return rows.map((r) => this.view(r));
  }

  view(r: Prisma.QualityInspectionGetPayload<object>) {
    const defects = parseDefects(r.defects);
    const defectCount = defects.reduce((a, d) => a + d.count, 0);
    return {
      id: r.id, batchCode: r.batchCode, productName: r.productName, line: r.line, inspector: r.inspector, inspectedAt: r.inspectedAt.toISOString(),
      inspectedQty: r.inspectedQty, rejectedQty: r.rejectedQty, defects, defectCount,
      rejectionRate: r.inspectedQty ? r1((r.rejectedQty / r.inspectedQty) * 100) : 0,
      status: r.status, severity: r.severity, notes: r.notes, resolution: r.resolution, resolvedAt: r.resolvedAt?.toISOString() ?? null, isDemo: r.isDemo,
    };
  }

  async create(organizationId: string, input: { batchCode?: string; productName?: string; line?: string; inspector?: string; inspectedAt?: string; inspectedQty?: number; rejectedQty?: number; defects?: unknown; severity?: string; notes?: string }, actor: string) {
    const batchCode = String(input.batchCode ?? '').trim().slice(0, 80);
    const productName = String(input.productName ?? '').trim().slice(0, 150);
    if (!batchCode) throw new BadRequestException('Enter the batch / lot code');
    if (!productName) throw new BadRequestException('Enter the product');
    const inspectedQty = Math.round(Number(input.inspectedQty));
    const rejectedQty = Math.round(Number(input.rejectedQty ?? 0));
    if (!Number.isFinite(inspectedQty) || inspectedQty <= 0 || inspectedQty > 10_000_000) throw new BadRequestException('Enter how many units were inspected');
    if (!Number.isFinite(rejectedQty) || rejectedQty < 0 || rejectedQty > inspectedQty) throw new BadRequestException('Rejected units must be between 0 and the units inspected');
    const inspectedAt = input.inspectedAt ? new Date(input.inspectedAt) : new Date();
    if (Number.isNaN(inspectedAt.getTime()) || inspectedAt.getTime() > Date.now() + DAY) throw new BadRequestException('Inspection date cannot be in the future');
    const severity = (DEFECT_SEVERITIES as readonly string[]).includes(String(input.severity)) ? String(input.severity) : 'minor';
    const defects = parseDefects(input.defects);
    try {
      const r = await this.prisma.qualityInspection.create({
        data: {
          organizationId, batchCode, productName, line: input.line?.trim().slice(0, 80) || null, inspector: input.inspector?.trim().slice(0, 120) || null, inspectedAt,
          inspectedQty, rejectedQty, defects: defects as never, severity, notes: input.notes?.trim().slice(0, 4000) || null,
          // A clean batch needs no follow-up.
          status: rejectedQty === 0 && defects.length === 0 ? 'resolved' : 'open', resolvedAt: rejectedQty === 0 && defects.length === 0 ? inspectedAt : null, createdBy: actor.slice(0, 191),
        },
      });
      await this.prisma.auditEvent.create({ data: { organizationId, actor: actor.slice(0, 191), entityType: 'quality_inspection', entityId: r.id, action: 'created', data: { batchCode, inspectedQty, rejectedQty } } });
      return this.view(r);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(`Batch ${batchCode} is already recorded`);
      throw e;
    }
  }

  async resolve(organizationId: string, id: string, resolution: string | undefined, actor: string) {
    const text = resolution?.trim();
    if (!text) throw new BadRequestException('Describe the corrective action / resolution');
    const r = await this.prisma.qualityInspection.updateMany({ where: { id, organizationId, status: 'open' }, data: { status: 'resolved', resolution: text.slice(0, 4000), resolvedAt: new Date() } });
    if (!r.count) {
      if (!(await this.prisma.qualityInspection.count({ where: { id, organizationId } }))) throw new NotFoundException('Inspection not found');
      throw new ConflictException('This inspection is already resolved');
    }
    await this.prisma.auditEvent.create({ data: { organizationId, actor: actor.slice(0, 191), entityType: 'quality_inspection', entityId: id, action: 'resolved', data: { resolution: text.slice(0, 300) } } });
    return this.view((await this.prisma.qualityInspection.findUnique({ where: { id } }))!);
  }

  /** Aggregates for dashboards and agents. Every number is a sum over the returned inspections. */
  async stats(organizationId: string, days = 30) {
    const since = new Date(Date.now() - Math.min(365, Math.max(1, days)) * DAY);
    const rows = (await this.prisma.qualityInspection.findMany({ where: { organizationId, inspectedAt: { gte: since } }, orderBy: { inspectedAt: 'asc' } })).map((r) => this.view(r));
    const inspected = rows.reduce((a, r) => a + r.inspectedQty, 0);
    const rejected = rows.reduce((a, r) => a + r.rejectedQty, 0);
    const defects = rows.reduce((a, r) => a + r.defectCount, 0);
    const byCategory = new Map<string, number>();
    for (const r of rows) for (const d of r.defects) byCategory.set(d.category, (byCategory.get(d.category) ?? 0) + d.count);
    const byLine = new Map<string, { inspected: number; rejected: number }>();
    for (const r of rows) {
      const k = r.line ?? 'unassigned';
      const v = byLine.get(k) ?? { inspected: 0, rejected: 0 };
      v.inspected += r.inspectedQty; v.rejected += r.rejectedQty;
      byLine.set(k, v);
    }
    const resolvedWithIssue = rows.filter((r) => r.status === 'resolved' && r.resolvedAt && (r.rejectedQty > 0 || r.defectCount > 0));
    const avgResolutionHours = resolvedWithIssue.length ? r1(resolvedWithIssue.reduce((a, r) => a + (new Date(r.resolvedAt!).getTime() - new Date(r.inspectedAt).getTime()) / 3_600_000, 0) / resolvedWithIssue.length) : null;
    return {
      days, since, inspections: rows.length, unitsInspected: inspected, unitsRejected: rejected, defects,
      defectRate: inspected ? r1((defects / inspected) * 100) : null,
      rejectionRate: inspected ? r1((rejected / inspected) * 100) : null,
      open: rows.filter((r) => r.status === 'open').length,
      avgResolutionHours,
      byCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
      byLine: [...byLine.entries()].map(([line, v]) => ({ line, ...v, rejectionRate: v.inspected ? r1((v.rejected / v.inspected) * 100) : 0 })),
      rows,
    };
  }
}
