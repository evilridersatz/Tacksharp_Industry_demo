import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { istDayStart } from '../jarvis/jarvis-config.js';
import { OfficeSetupService } from './office-setup.service.js';
import { OFFICE_APPROVAL_ACTION } from './tools/registry.js';
import { OPEN } from './engine/task-state.js';

const n = (v: unknown) => Number(v ?? 0) || 0;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** The office floor, usage and performance, the memory center, the audit trail and retention. */
@Injectable()
export class OfficeInsightsService {
  constructor(private readonly prisma: PrismaService, private readonly setup: OfficeSetupService) {}

  // ---------------------------------------------------------------------------------------------- floor
  async floor(organizationId: string) {
    const [agents, cfg] = await Promise.all([this.setup.agents(organizationId), this.setup.config(organizationId)]);
    const currentIds = agents.map((a) => a.currentTaskId).filter((x): x is string => Boolean(x));
    const [current, open, approvals, spend, running, messages] = await Promise.all([
      currentIds.length ? this.prisma.officeTask.findMany({ where: { id: { in: currentIds }, organizationId }, select: { id: true, title: true, status: true } }) : [],
      this.prisma.officeTask.groupBy({ by: ['role', 'status'], where: { organizationId, status: { in: [...OPEN] } }, _count: true }),
      this.prisma.approval.count({ where: { organizationId, action: OFFICE_APPROVAL_ACTION, status: 'pending' } }),
      this.prisma.officeUsageRecord.aggregate({ where: { organizationId, at: { gte: istDayStart(new Date()) } }, _sum: { costUsd: true } }),
      this.prisma.officePlan.count({ where: { organizationId, status: 'running' } }),
      // Recent agent-to-agent messages: the animated floor shows them as envelopes carried between desks.
      this.prisma.officeMessage.findMany({ where: { organizationId, createdAt: { gte: new Date(Date.now() - 15 * 60_000) } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, fromRole: true, toRole: true, act: true, createdAt: true } }),
    ]);
    const taskOf = new Map(current.map((t) => [t.id, t]));
    const openBy = new Map<string, Record<string, number>>();
    for (const g of open as Array<{ role: string; status: string; _count: number }>) openBy.set(g.role, { ...(openBy.get(g.role) ?? {}), [g.status]: g._count });
    const departments = new Map<string, { key: string; name: string; agents: unknown[] }>();
    for (const a of agents) {
      const key = a.department?.key ?? 'other';
      if (!departments.has(key)) departments.set(key, { key, name: a.department?.name ?? 'Other', agents: [] });
      const t = a.currentTaskId ? taskOf.get(a.currentTaskId) : undefined;
      departments.get(key)!.agents.push({ id: a.id, role: a.role, name: a.name, status: a.paused ? 'paused' : !a.enabled ? 'off' : a.status, breaker: a.breaker, enabled: a.enabled, purpose: a.purpose, currentTask: t ? { id: t.id, title: t.title } : null, open: openBy.get(a.role) ?? {} });
    }
    return { mode: cfg.mode, paused: cfg.paused, runningPlans: running, pendingApprovals: approvals, spendTodayUsd: r4(n(spend._sum.costUsd)), maxUsdPerDay: cfg.maxUsdPerDay, inrPerUsd: cfg.inrPerUsd, departments: [...departments.values()], messages: messages.reverse() };
  }

  // ---------------------------------------------------------------------------------------------- usage
  async usage(organizationId: string, days: number) {
    const from = istDayStart(new Date(), days - 1);
    const dayOf = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const [records, tasks, plans, cfg] = await Promise.all([
      this.prisma.officeUsageRecord.findMany({ where: { organizationId, at: { gte: from } }, select: { at: true, agentRole: true, model: true, tokensIn: true, tokensOut: true, costUsd: true } }),
      this.prisma.officeTask.groupBy({ by: ['role', 'status'], where: { organizationId, createdAt: { gte: from } }, _count: true }),
      this.prisma.officePlan.findMany({ where: { organizationId, createdAt: { gte: from }, status: { in: ['completed', 'failed'] } }, select: { costUsd: true, status: true, startedAt: true, finishedAt: true, estimate: true } }),
      this.setup.config(organizationId),
    ]);
    const byDay = new Map<string, { date: string; usd: number; tokensIn: number; tokensOut: number; calls: number }>();
    for (let i = days - 1; i >= 0; i--) { const d = dayOf(istDayStart(new Date(), i)); byDay.set(d, { date: d, usd: 0, tokensIn: 0, tokensOut: 0, calls: 0 }); }
    const byAgent = new Map<string, { role: string; usd: number; tokens: number; calls: number; completed: number; needsReview: number; failed: number }>();
    for (const r of records) {
      const d = byDay.get(dayOf(r.at));
      if (d) { d.usd += n(r.costUsd); d.tokensIn += r.tokensIn; d.tokensOut += r.tokensOut; d.calls += 1; }
      const a = byAgent.get(r.agentRole) ?? { role: r.agentRole, usd: 0, tokens: 0, calls: 0, completed: 0, needsReview: 0, failed: 0 };
      a.usd += n(r.costUsd); a.tokens += r.tokensIn + r.tokensOut; a.calls += 1;
      byAgent.set(r.agentRole, a);
    }
    for (const t of tasks as Array<{ role: string; status: string; _count: number }>) {
      const a = byAgent.get(t.role) ?? { role: t.role, usd: 0, tokens: 0, calls: 0, completed: 0, needsReview: 0, failed: 0 };
      if (t.status === 'completed') a.completed += t._count;
      else if (t.status === 'needs_review') a.needsReview += t._count;
      else if (t.status === 'dead_letter' || t.status === 'failed') a.failed += t._count;
      byAgent.set(t.role, a);
    }
    const finished = plans.filter((p) => p.finishedAt && p.startedAt);
    const totalUsd = records.reduce((a, r) => a + n(r.costUsd), 0);
    return {
      days: [...byDay.values()].map((d) => ({ ...d, usd: r4(d.usd) })),
      agents: [...byAgent.values()].map((a) => ({ ...a, usd: r4(a.usd) })).sort((x, y) => y.usd - x.usd),
      totals: { usd: r4(totalUsd), calls: records.length, tokens: records.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0) },
      plans: {
        finished: finished.length,
        completed: plans.filter((p) => p.status === 'completed').length,
        avgUsd: finished.length ? r4(finished.reduce((a, p) => a + n(p.costUsd), 0) / finished.length) : null,
        avgEstimateUsd: finished.length ? r4(finished.reduce((a, p) => a + n((p.estimate as { usd?: number } | null)?.usd), 0) / finished.length) : null,
        avgMinutes: finished.length ? Math.round(finished.reduce((a, p) => a + (p.finishedAt!.getTime() - p.startedAt!.getTime()), 0) / finished.length / 60_000) : null,
      },
      inrPerUsd: cfg.inrPerUsd,
      priceSource: 'Model prices from a third-party summary (MorphLLM, 31 Oct 2026); confirm on OpenAI’s pricing page before billing.',
    };
  }

  // ---------------------------------------------------------------------------------------------- memory
  memories(organizationId: string, status?: string) {
    return this.prisma.officeMemory.findMany({ where: { organizationId, ...(status ? { status } : {}) }, orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }], take: 300 });
  }

  /** A person's fact is verified at once (they are the source). */
  async addMemory(organizationId: string, body: Record<string, unknown>, actor: string) {
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) : '';
    if (text.length < 3) throw new BadRequestException('Write the fact to remember');
    const scope = body.scope === 'department' ? 'department' : 'organization';
    const days = Number(body.expiresInDays);
    const m = await this.prisma.officeMemory.create({
      data: { organizationId, scope, scopeKey: typeof body.scopeKey === 'string' ? body.scopeKey.slice(0, 40) : null, text, source: typeof body.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 300) : 'Entered by a person', author: actor.slice(0, 191), status: 'verified', pinned: body.pinned === true, expiresAt: Number.isFinite(days) && days > 0 ? new Date(Date.now() + Math.min(days, 3650) * 86_400_000) : null },
    });
    await this.setup.audit(organizationId, actor, 'memory.added', `memory:${m.id}`, { scope });
    return m;
  }

  /** Verify / reject a proposal, pin, or edit (an edit bumps the version and keeps provenance). */
  async updateMemory(organizationId: string, id: string, body: Record<string, unknown>, actor: string) {
    const m = await this.prisma.officeMemory.findFirst({ where: { id, organizationId } });
    if (!m) throw new NotFoundException('Memory item not found');
    const data: Record<string, unknown> = {};
    if (body.status === 'verified' || body.status === 'rejected') data.status = body.status;
    if (typeof body.pinned === 'boolean') data.pinned = body.pinned;
    if (typeof body.text === 'string' && body.text.trim() && body.text.trim() !== m.text) { data.text = body.text.trim().slice(0, 1000); data.version = m.version + 1; }
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to change');
    const next = await this.prisma.officeMemory.update({ where: { id }, data });
    await this.setup.audit(organizationId, actor, 'memory.updated', `memory:${id}`, { ...data, text: data.text ? '(edited)' : undefined });
    return next;
  }

  async deleteMemory(organizationId: string, id: string, actor: string) {
    const r = await this.prisma.officeMemory.deleteMany({ where: { id, organizationId } });
    if (!r.count) throw new NotFoundException('Memory item not found');
    await this.setup.audit(organizationId, actor, 'memory.deleted', `memory:${id}`, {});
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------- audit
  audit(organizationId: string, q: { target?: string; take?: number }) {
    return this.prisma.officeAuditLog.findMany({ where: { organizationId, ...(q.target ? { target: q.target } : {}) }, orderBy: { at: 'desc' }, take: Math.min(500, q.take ?? 200) });
  }

  // ---------------------------------------------------------------------------------------------- retention
  /** Daily: delete old messages, executions, tool calls of finished tasks, consumed events and old audit rows. */
  async retention(now = new Date()) {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });
    let removed = 0;
    for (const { id } of orgs) {
      const cfg = await this.setup.config(id);
      const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
      const r = await Promise.all([
        this.prisma.officeMessage.deleteMany({ where: { organizationId: id, createdAt: { lt: ago(cfg.retentionDays.messages) } } }),
        this.prisma.officeExecution.deleteMany({ where: { organizationId: id, startedAt: { lt: ago(cfg.retentionDays.executions) } } }),
        this.prisma.officeToolCall.deleteMany({ where: { organizationId: id, createdAt: { lt: ago(cfg.retentionDays.executions) }, status: { notIn: ['running', 'approval_required', 'unknown'] } } }),
        this.prisma.officeAuditLog.deleteMany({ where: { organizationId: id, at: { lt: ago(cfg.retentionDays.audit) } } }),
        this.prisma.officeEvent.deleteMany({ where: { organizationId: id, consumedAt: { lt: ago(30) } } }),
        this.prisma.officeMemory.deleteMany({ where: { organizationId: id, expiresAt: { lt: now } } }),
      ]);
      removed += r.reduce((a, x) => a + x.count, 0);
    }
    return { removed };
  }
}
