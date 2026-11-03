import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OutreachService } from '../automation/outreach.service.js';
import { DripService } from '../drip/drip.service.js';
import { InboxService } from '../inbox/inbox.service.js';
import { runInProviderScope } from '../integrations/provider-scope.js';
import { customerLockKey, withLock } from '../common/redis-lock.js';
import { queueRedis } from '../queues/queues.js';
import { config } from '../common/config.js';
import { describeError } from '../common/errors.js';
import { log } from '../common/logger.js';
import { branchPath, countSteps, evaluate, nextPath, stepAt, validateGraph, type Facts, type Graph, type Path, type Step } from './workflow-graph.js';

type Actor = { sub: string; org: string };
type LogEntry = { stepId: string; type: string; result: string; detail?: string; at: string };
type Ctx = { channel?: string | null; orderTotal?: number | null; conversationId?: string | null; waited?: string | null; inflight?: string | null; excerpt?: string };
type RunRow = Prisma.WorkflowRunGetPayload<object>;

const RETRY_MINUTES = [5, 15, 60];
const LEASE_MS = 10 * 60_000;
const STEPS_PER_TICK = 25;
const LOG_MAX = 100;
const BACKFILL_MS = 24 * 3600_000;
const key = (p: Path) => p.join('.');

/**
 * Visual Workflow Studio engine.
 *
 * Triggers are read from the database every minute for ACTIVE workflows, only for records created / changed after the
 * workflow was activated (never history), and each record starts a given workflow once ("<trigger>:<id>" is unique per
 * workflow). A run executes the graph snapshot it started with, so editing a workflow never changes a run in flight.
 * Steps: condition (facts from the database), wait, WhatsApp message / AI call (OutreachService: consent, 24 h window /
 * approved template, live gate; opted-out customers are skipped), set CRM stage, add tag, hand to the team (AI off,
 * round-robin), create a task, enrol in a drip sequence. A WhatsApp step marked in flight before sending is never sent
 * twice after a crash; temporary failures retry after 5 / 15 / 60 minutes. Pausing a workflow holds its runs.
 * Test runs (studio) use real facts but send / change nothing and skip waits.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outreach: OutreachService,
    @Optional() private readonly drips?: DripService,
    @Optional() private readonly inbox?: InboxService,
  ) {}

  // -------------------------------------------------------------------------------------------- CRUD
  async list(org: string) {
    const [rows, counts] = await Promise.all([
      this.prisma.workflow.findMany({ where: { organizationId: org }, orderBy: { createdAt: 'desc' } }),
      this.prisma.workflowRun.groupBy({ by: ['workflowId', 'status'], where: { organizationId: org, test: false }, _count: { _all: true } }),
    ]);
    return rows.map((w) => ({
      ...w,
      stepCount: countSteps((w.graph as unknown as Graph).steps ?? []),
      runs: Object.fromEntries(counts.filter((c) => c.workflowId === w.id).map((c) => [c.status, c._count._all])),
    }));
  }

  async detail(org: string, id: string) {
    const w = await this.find(org, id);
    const runs = await this.prisma.workflowRun.findMany({ where: { workflowId: w.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    const names = new Map((await this.prisma.customer.findMany({ where: { id: { in: runs.map((r) => r.customerId).filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    return {
      ...w,
      runs: runs.map((r) => ({ id: r.id, version: r.version, status: r.status, test: r.test, triggerKey: r.triggerKey, customer: r.customerId ? { id: r.customerId, name: names.get(r.customerId) ?? null } : null, resumeAt: r.resumeAt, lastError: r.lastError, log: (r.log as LogEntry[] | null) ?? [], createdAt: r.createdAt, completedAt: r.completedAt })),
    };
  }

  async create(actor: Actor, body: Record<string, unknown>) {
    const name = this.name(body.name);
    const graph = await this.checkGraph(actor.org, body.graph);
    try {
      const w = await this.prisma.workflow.create({ data: { organizationId: actor.org, name, description: this.desc(body.description), graph: graph as unknown as Prisma.InputJsonValue, createdBy: actor.sub } });
      await this.audit(actor, w.id, 'workflow.created', { steps: countSteps(graph.steps), trigger: graph.trigger.type });
      return w;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ message: 'A workflow with this name already exists', errors: { name: 'Name already used' } });
      throw e;
    }
  }

  async update(actor: Actor, id: string, body: Record<string, unknown>) {
    const w = await this.find(actor.org, id);
    const data: Prisma.WorkflowUpdateInput = {};
    if (body.name !== undefined) data.name = this.name(body.name);
    if (body.description !== undefined) data.description = this.desc(body.description);
    if (body.graph !== undefined) {
      const graph = await this.checkGraph(actor.org, body.graph);
      data.graph = graph as unknown as Prisma.InputJsonValue;
      data.version = { increment: 1 };
    }
    try {
      const updated = await this.prisma.workflow.update({ where: { id: w.id }, data });
      await this.audit(actor, w.id, 'workflow.updated', { fields: Object.keys(data), version: updated.version });
      return updated;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ message: 'A workflow with this name already exists', errors: { name: 'Name already used' } });
      throw e;
    }
  }

  /** Activation starts from now: records created while it was a draft or paused do not start runs. */
  async setStatus(actor: Actor, id: string, status: 'active' | 'paused') {
    const w = await this.find(actor.org, id);
    if (w.status === status) return w;
    if (status === 'active') await this.checkGraph(actor.org, w.graph);
    const updated = await this.prisma.workflow.update({ where: { id: w.id }, data: { status, ...(status === 'active' ? { activatedAt: new Date() } : {}) } });
    await this.audit(actor, w.id, status === 'active' ? 'workflow.activated' : 'workflow.paused', {});
    return updated;
  }

  async stopRun(actor: Actor, runId: string) {
    const r = await this.prisma.workflowRun.findFirst({ where: { id: runId, organizationId: actor.org } });
    if (!r) throw new NotFoundException('Run not found');
    if (!['running', 'waiting'].includes(r.status)) return r;
    const out = await this.prisma.workflowRun.update({ where: { id: r.id }, data: { status: 'stopped', resumeAt: null, log: appendLog(r.log, { stepId: '-', type: 'stop', result: 'stopped', detail: 'Stopped by a person' }) } });
    await this.audit(actor, r.workflowId, 'workflow.run_stopped', { runId: r.id });
    return out;
  }

  /** Studio test: the CURRENT graph against one real customer; nothing is sent or changed; waits are skipped. */
  async testRun(actor: Actor, id: string, body: { customerId?: unknown }) {
    const w = await this.find(actor.org, id);
    const graph = await this.checkGraph(actor.org, w.graph);
    const customerId = typeof body.customerId === 'string' ? body.customerId : '';
    const c = await this.prisma.customer.findFirst({ where: { id: customerId, organizationId: actor.org }, select: { id: true } });
    if (!c) throw new BadRequestException({ message: 'Choose a customer of this workspace', errors: { customerId: 'Choose a customer' } });
    const run = await this.prisma.workflowRun.create({
      data: { organizationId: actor.org, workflowId: w.id, version: w.version, graph: graph as unknown as Prisma.InputJsonValue, triggerKey: `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, customerId: c.id, context: {}, cursor: [0], status: 'running', resumeAt: new Date(), test: true },
    });
    await this.execute(run.id, new Date(), true);
    return this.prisma.workflowRun.findUnique({ where: { id: run.id } });
  }

  // -------------------------------------------------------------------------------------------- engine
  async tick(now = new Date()) {
    const started = await this.collect(now);
    const due = await this.prisma.workflowRun.findMany({
      where: { status: { in: ['running', 'waiting'] }, test: false, resumeAt: { lte: now }, workflow: { status: 'active' } },
      orderBy: { resumeAt: 'asc' },
      take: 100,
      select: { id: true, organizationId: true, customerId: true },
    });
    let executed = 0;
    for (const r of due) {
      try {
        await runInProviderScope(r.organizationId, () =>
          r.customerId ? withLock(queueRedis, customerLockKey(r.customerId), () => this.execute(r.id, now), { ttlMs: 60_000, waitMs: 30_000 }) : this.execute(r.id, now),
        );
        executed++;
      } catch (e) {
        log.warn('workflow.run_failed', { runId: r.id, error: describeError(e) });
      }
    }
    return { started, executed };
  }

  /** New trigger records for every active workflow (bounded, newest first, once per record). */
  async collect(now = new Date()) {
    const workflows = await this.prisma.workflow.findMany({ where: { status: 'active', activatedAt: { not: null } } });
    let total = 0;
    for (const w of workflows) {
      const graph = w.graph as unknown as Graph;
      const since = new Date(Math.max(w.activatedAt!.getTime(), now.getTime() - BACKFILL_MS));
      const org = w.organizationId;
      const t = graph.trigger;
      const rows: Array<{ triggerKey: string; customerId: string | null; context: Ctx }> = [];
      if (t.type === 'lead_created') {
        for (const l of await this.prisma.lead.findMany({ where: { organizationId: org, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 500, select: { id: true, customerId: true, source: true } }))
          rows.push({ triggerKey: `lead:${l.id}`, customerId: l.customerId, context: { channel: l.source } });
      } else if (t.type === 'order_completed') {
        for (const o of await this.prisma.order.findMany({ where: { organizationId: org, status: 'completed', updatedAt: { gte: since } }, orderBy: { updatedAt: 'desc' }, take: 500, select: { id: true, customerId: true, channel: true, total: true } }))
          rows.push({ triggerKey: `order:${o.id}`, customerId: o.customerId, context: { channel: o.channel, orderTotal: Number(o.total) } });
      } else if (t.type === 'stage_reached' && t.stage) {
        for (const c of await this.prisma.customer.findMany({ where: { organizationId: org, stage: t.stage, updatedAt: { gte: since } }, orderBy: { updatedAt: 'desc' }, take: 500, select: { id: true } }))
          rows.push({ triggerKey: `stage:${t.stage}:${c.id}`, customerId: c.id, context: {} });
      } else if (t.type === 'needs_human') {
        for (const c of await this.prisma.conversation.findMany({ where: { organizationId: org, handoffAt: { gte: since }, OR: [{ status: 'human_handoff' }, { aiEnabled: false }] }, orderBy: { handoffAt: 'desc' }, take: 500, select: { id: true, customerId: true, channel: true, handoffAt: true } }))
          rows.push({ triggerKey: `handoff:${c.id}:${c.handoffAt!.getTime()}`, customerId: c.customerId, context: { channel: c.channel, conversationId: c.id } });
      } else if (t.type === 'message_keyword' && t.keywords?.length) {
        const msgs = await this.prisma.message.findMany({
          where: { organizationId: org, role: 'user', createdAt: { gte: since }, OR: t.keywords.map((k) => ({ content: { contains: k } })) },
          orderBy: { createdAt: 'desc' },
          take: 500,
          select: { id: true, content: true, conversationId: true, Conversation: { select: { customerId: true, channel: true } } },
        });
        for (const m of msgs) {
          const text = m.content.toLowerCase();
          if (!t.keywords.some((k) => text.includes(k))) continue; // case-insensitive re-check
          rows.push({ triggerKey: `msg:${m.id}`, customerId: m.Conversation?.customerId ?? null, context: { channel: m.Conversation?.channel, conversationId: m.conversationId, excerpt: m.content.slice(0, 120) } });
        }
      }
      if (!rows.length) continue;
      const r = await this.prisma.workflowRun.createMany({
        data: rows.map((x) => ({ organizationId: org, workflowId: w.id, version: w.version, graph: w.graph as Prisma.InputJsonValue, triggerKey: x.triggerKey, customerId: x.customerId, context: x.context as Prisma.InputJsonValue, cursor: [0], status: 'running', resumeAt: now })),
        skipDuplicates: true,
      });
      if (r.count) log.info('workflow.started', { workflowId: w.id, runs: r.count });
      total += r.count;
    }
    return total;
  }

  /** Runs steps of one run until it waits, finishes, or uses its per-tick budget. */
  async execute(runId: string, now = new Date(), test = false): Promise<string> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId }, include: { workflow: { select: { name: true, status: true } } } });
    if (!run || !['running', 'waiting'].includes(run.status)) return 'not_runnable';
    if (!test && (run.workflow.status !== 'active' || !run.resumeAt || run.resumeAt > now)) return 'not_due';
    const claimed = await this.prisma.workflowRun.updateMany({ where: { id: run.id, updatedAt: run.updatedAt, status: { in: ['running', 'waiting'] } }, data: { resumeAt: new Date(now.getTime() + LEASE_MS) } });
    if (!claimed.count) return 'already_claimed';

    const graph = run.graph as unknown as Graph;
    const ctx = ((run.context ?? {}) as Ctx);
    let cursor = (run.cursor as Path | null) ?? [0];
    let logs = ((run.log as LogEntry[] | null) ?? []).slice();
    const add = (s: Step, result: string, detail?: string) => (logs = [...logs, { stepId: s.id, type: s.type, result, ...(detail ? { detail: detail.slice(0, 300) } : {}), at: new Date().toISOString() }].slice(-LOG_MAX));
    const save = (data: Partial<Prisma.WorkflowRunUncheckedUpdateInput>) =>
      this.prisma.workflowRun.update({ where: { id: run.id }, data: { cursor: cursor as unknown as Prisma.InputJsonValue, context: ctx as Prisma.InputJsonValue, log: logs as unknown as Prisma.InputJsonValue, ...data } });

    try {
      for (let n = 0; n < STEPS_PER_TICK; n++) {
        const step = stepAt(graph.steps, cursor);
        if (!step) {
          await save({ status: 'completed', completedAt: new Date(), resumeAt: null, cursor: Prisma.DbNull as never });
          return 'completed';
        }
        const here = key(cursor);
        let next: Path | null = null;
        switch (step.type) {
          case 'condition': {
            const yes = evaluate(step, await this.facts(run.organizationId, run.customerId, ctx));
            add(step, yes ? 'yes' : 'no', `${step.field} ${step.op}${step.value !== undefined ? ` ${step.value}` : ''}`);
            next = branchPath(graph.steps, cursor, yes ? 'yes' : 'no');
            break;
          }
          case 'wait': {
            if (test) { add(step, 'skipped', `Test run: waiting ${step.minutes} min skipped`); next = nextPath(graph.steps, cursor); break; }
            if (ctx.waited !== here) {
              ctx.waited = here;
              const at = new Date(now.getTime() + step.minutes * 60_000 * config.followUp.timeScale);
              add(step, 'waiting', `until ${at.toISOString()}`);
              await save({ status: 'waiting', resumeAt: at, attempts: 0 });
              return 'waiting';
            }
            ctx.waited = null;
            add(step, 'done');
            next = nextPath(graph.steps, cursor);
            break;
          }
          case 'send_whatsapp':
          case 'ai_call': {
            if (!run.customerId) { add(step, 'skipped', 'No customer for this record'); next = nextPath(graph.steps, cursor); break; }
            if (test) {
              const p = await this.outreach.preview(run.organizationId, run.customerId, step.type === 'ai_call' ? 'call' : 'whatsapp', step.type === 'send_whatsapp' ? step : {});
              add(step, p.wouldSend ? 'would_send' : 'would_skip', [p.reason, p.content].filter(Boolean).join(': '));
              next = nextPath(graph.steps, cursor);
              break;
            }
            if (step.type === 'send_whatsapp' && ctx.inflight === here) {
              // A previous attempt stopped while sending: delivery unknown, so it is not sent again.
              ctx.inflight = null;
              add(step, 'failed', 'Interrupted while sending: delivery unknown, not repeated');
              next = nextPath(graph.steps, cursor);
              break;
            }
            if (step.type === 'send_whatsapp') { ctx.inflight = here; await save({}); }
            const r = step.type === 'send_whatsapp'
              ? await this.outreach.whatsApp(run.organizationId, run.customerId, step, { workflow: { workflowId: run.workflowId, runId: run.id, stepId: step.id } })
              : await this.outreach.call(run.organizationId, run.customerId, 'workflow', `${run.id}-${step.id}`);
            ctx.inflight = null;
            if (r.retryable) {
              const attempts = run.attempts + 1;
              if (r.countsAsAttempt && attempts > RETRY_MINUTES.length) {
                add(step, 'failed', `Gave up after ${attempts} attempts: ${r.reason}`);
                next = nextPath(graph.steps, cursor);
                break;
              }
              const at = r.retryAt ?? new Date(now.getTime() + RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1] * 60_000);
              add(step, 'retry', `${r.reason}; next try ${at.toISOString()}`);
              await save({ status: 'running', resumeAt: at, attempts: r.countsAsAttempt ? attempts : run.attempts, lastError: r.reason.slice(0, 500) });
              return 'retry';
            }
            add(step, r.status, r.reason);
            next = nextPath(graph.steps, cursor);
            break;
          }
          case 'set_stage':
          case 'add_tag':
          case 'assign_team':
          case 'create_task':
          case 'enroll_drip': {
            const res = run.customerId ? await this.action(run, step, ctx, test) : { result: 'skipped', detail: 'No customer for this record' };
            add(step, res.result, res.detail);
            next = nextPath(graph.steps, cursor);
            break;
          }
        }
        if (!next) {
          await save({ status: 'completed', completedAt: new Date(), resumeAt: null, attempts: 0 });
          return 'completed';
        }
        cursor = next;
        await save({ status: 'running', attempts: 0 });
      }
      await save({ status: 'running', resumeAt: now });
      return 'budget';
    } catch (e) {
      const attempts = run.attempts + 1;
      const failed = test || attempts >= RETRY_MINUTES.length;
      await save({ status: failed ? 'failed' : 'running', attempts, lastError: describeError(e).slice(0, 500), resumeAt: failed ? null : new Date(now.getTime() + RETRY_MINUTES[attempts - 1] * 60_000) });
      log.warn('workflow.step_error', { runId: run.id, error: describeError(e) });
      return failed ? 'failed' : 'retry';
    }
  }

  private async action(run: RunRow & { workflow: { name: string } }, step: Step, ctx: Ctx, test: boolean): Promise<{ result: string; detail?: string }> {
    const org = run.organizationId;
    const customerId = run.customerId!;
    const c = await this.prisma.customer.findFirst({ where: { id: customerId, organizationId: org }, select: { id: true, name: true, stage: true, tags: true } });
    if (!c) return { result: 'skipped', detail: 'Customer not found' };
    const actor = { sub: `workflow:${run.workflowId}`, org };
    switch (step.type) {
      case 'set_stage': {
        if (test) return { result: 'would_change', detail: `Stage ${c.stage ?? 'new'} → ${step.stage}` };
        await this.prisma.customer.update({ where: { id: c.id }, data: { stage: step.stage === 'new' ? null : step.stage } });
        await this.prisma.auditEvent.create({ data: { organizationId: org, actor: actor.sub, entityType: 'customer', entityId: c.id, action: 'workflow.stage_set', data: { from: c.stage, to: step.stage, runId: run.id } } }).catch(() => undefined);
        return { result: 'done', detail: `Stage → ${step.stage}` };
      }
      case 'add_tag': {
        const tags = Array.isArray(c.tags) ? (c.tags as string[]) : [];
        if (tags.includes(step.tag)) return { result: 'done', detail: `Already tagged "${step.tag}"` };
        if (test) return { result: 'would_change', detail: `Add tag "${step.tag}"` };
        await this.prisma.customer.update({ where: { id: c.id }, data: { tags: [...tags, step.tag].slice(0, 50) } });
        return { result: 'done', detail: `Tagged "${step.tag}"` };
      }
      case 'assign_team': {
        const conv = await this.prisma.conversation.findFirst({ where: { organizationId: org, customerId: c.id, ...(ctx.conversationId ? { id: ctx.conversationId } : {}) }, orderBy: { updatedAt: 'desc' } });
        if (!conv) return { result: 'skipped', detail: 'The customer has no conversation to hand over' };
        if (test) return { result: 'would_change', detail: 'AI off, open for the team, assigned round-robin' };
        await this.prisma.conversation.update({ where: { id: conv.id }, data: { aiEnabled: false, inboxStatus: 'open', priority: conv.priority === 'urgent' ? 'urgent' : 'high', handoffAt: conv.handoffAt ?? new Date(), handoffReason: step.reason ?? `Workflow: ${run.workflow.name}` } });
        let who = 'unassigned (nobody can take conversations yet)';
        if (!conv.assigneeId && this.inbox) {
          const d = await this.inbox.assignRoundRobin(null, org, conv.id).catch(() => null);
          if (d?.assignee) who = d.assignee.name;
        } else if (conv.assigneeId) who = 'kept the current assignee';
        return { result: 'done', detail: `Handed to the team (${who})` };
      }
      case 'create_task': {
        if (test) return { result: 'would_change', detail: `Task "${step.title}"` };
        const dueAt = step.dueInDays !== undefined ? new Date(Date.now() + step.dueInDays * 86_400_000) : null;
        const t = await this.prisma.workTask.create({ data: { organizationId: org, agent: 'workflow', kind: 'review', title: step.title, detail: `Customer: ${c.name ?? c.id} · workflow "${run.workflow.name}"`, status: 'open', priority: 'normal', dueAt, entityType: 'customer', entityId: c.id, createdBy: actor.sub } });
        return { result: 'done', detail: `Task created (${t.id.slice(-6)})` };
      }
      case 'enroll_drip': {
        if (!this.drips) return { result: 'skipped', detail: 'Drip module unavailable' };
        if (test) return { result: 'would_change', detail: 'Enrol in the drip sequence (opt-out / already enrolled are skipped there)' };
        const r = await this.drips.enroll(actor, step.sequenceId, { customerIds: [c.id] });
        return r.enrolled ? { result: 'done', detail: `Enrolled${r.sequenceActive ? '' : ' (sequence not active yet)'}` } : { result: 'skipped', detail: `Not enrolled: ${Object.entries(r.skipped).filter(([, v]) => v).map(([k]) => k.replace('_', ' ')).join(', ') || 'no match'}` };
      }
      default:
        return { result: 'skipped' };
    }
  }

  private async facts(org: string, customerId: string | null, ctx: Ctx): Promise<Facts> {
    const c = customerId ? await this.prisma.customer.findFirst({ where: { id: customerId, organizationId: org }, select: { stage: true, tags: true, language: true, source: true, email: true, messagingConsent: true } }) : null;
    return {
      customer: { stage: c?.stage ?? null, tags: Array.isArray(c?.tags) ? (c!.tags as string[]) : [], language: c?.language ?? null, source: c?.source ?? null, email: c?.email ?? null, messagingConsent: Boolean(c?.messagingConsent) },
      order: ctx.orderTotal !== undefined && ctx.orderTotal !== null ? { total: ctx.orderTotal } : null,
      trigger: { channel: ctx.channel ?? null },
    };
  }

  // -------------------------------------------------------------------------------------------- helpers
  private async checkGraph(org: string, raw: unknown): Promise<Graph> {
    const { graph, errors } = validateGraph(raw);
    // Drip sequences must belong to this organization.
    const dripIds: Array<[string, string]> = [];
    const walk = (list: Step[]) => list.forEach((s) => (s.type === 'enroll_drip' && s.sequenceId ? dripIds.push([s.id, s.sequenceId]) : s.type === 'condition' ? (walk(s.yes), walk(s.no)) : undefined));
    walk(graph.steps);
    if (dripIds.length) {
      const ok = new Set((await this.prisma.dripSequence.findMany({ where: { organizationId: org, id: { in: dripIds.map(([, id]) => id) } }, select: { id: true } })).map((d) => d.id));
      for (const [stepId, seq] of dripIds) if (!ok.has(seq)) errors[stepId] ??= 'That drip sequence does not exist in this workspace';
    }
    if (Object.keys(errors).length) throw new BadRequestException({ message: 'Please fix the highlighted steps', errors });
    return graph;
  }

  private name(v: unknown) {
    const name = typeof v === 'string' ? v.trim() : '';
    if (!name || name.length > 120) throw new BadRequestException({ message: 'Name is required (up to 120 characters)', errors: { name: 'Name is required' } });
    return name;
  }

  private desc(v: unknown) {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null;
  }

  private async find(org: string, id: string) {
    const w = await this.prisma.workflow.findFirst({ where: { id, organizationId: org } });
    if (!w) throw new NotFoundException('Workflow not found');
    return w;
  }

  private audit(actor: Actor, entityId: string, action: string, data: Record<string, unknown>) {
    return this.prisma.auditEvent.create({ data: { organizationId: actor.org, actor: `user:${actor.sub}`, entityType: 'workflow', entityId, action, data: data as Prisma.InputJsonValue } }).catch(() => undefined);
  }
}

function appendLog(raw: Prisma.JsonValue | null, e: Omit<LogEntry, 'at'>): Prisma.InputJsonValue {
  return [...((raw as LogEntry[] | null) ?? []), { ...e, at: new Date().toISOString() }].slice(-LOG_MAX) as unknown as Prisma.InputJsonValue;
}
