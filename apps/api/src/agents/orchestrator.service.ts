import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { errorMessage, log } from '../common/logger.js';
import { SettingsService } from '../settings/settings.service.js';
import { DEFAULT_SETTINGS } from '../settings/tenant-settings.js';
import { ApprovalsService } from '../governance/approvals.service.js';
import { WorkTasksService } from '../governance/work-tasks.service.js';
import { InventoryService } from '../operations/inventory.service.js';
import { TextileEvents } from '../textile/textile-events.js';
import { FinanceService } from '../finance/finance.service.js';
import { FinanceEvents } from '../finance/finance-events.js';
import { buildFinanceKinds } from './finance-kinds.js';
import { buildMarketingKinds } from './marketing-kinds.js';
import { buildQualityKinds } from './quality-kinds.js';
import { QualityService } from '../industry/quality.service.js';
import { MarketingService } from '../marketing/marketing.service.js';
import { CollectionsService } from '../finance/collections.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { agentQueue, type AgentTaskJobData } from '../queues/queues.js';
import { AGENTS, MAX_HANDOFF_DEPTH } from './registry.js';
import { buildTaskKinds } from './task-kinds.js';
import { AGENT_NAMES, type AgentContext, type AgentName, type HandlerOutcome, type TaskKind, type ToolName, type Trigger } from './agent-types.js';

export type SubmitSpec = {
  kind: string;
  input?: unknown;
  trigger: Trigger;
  /** Same key (per business) = same task. Events use a deterministic key; the dashboard sends a click id. */
  idempotencyKey: string;
  requestedBy: string;
  parentTaskId?: string;
};

class PermanentError extends Error {}
const isPermanent = (e: unknown) => e instanceof PermanentError || (e instanceof HttpException && e.getStatus() < 500);

/**
 * Tacksharp AI Orchestrator. One entry point for agent work:
 *   submit -> routed by task kind to its agent -> recorded (AgentTask, idempotent) -> run with a timeout,
 *   server-checked tool permissions and an execution history -> COMPLETED / NEEDS_APPROVAL / FAILED (retried with
 *   back-off first) -> handoffs become child tasks for the next agent (bounded depth, so no loops).
 * Business events (order confirmed / cancelled / dispatched) arrive from TextileEvents.
 */
@Injectable()
export class Orchestrator implements OnModuleInit {
  private readonly kinds = new Map<string, TaskKind>();
  private queue: Queue<AgentTaskJobData> | null = agentQueue;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly workTasks: WorkTasksService,
    private readonly approvals: ApprovalsService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly textileEvents?: TextileEvents,
    @Optional() private readonly finance?: FinanceService,
    @Optional() private readonly financeEvents?: FinanceEvents,
    @Optional() private readonly marketing?: MarketingService,
    @Optional() private readonly collections?: CollectionsService,
    @Optional() private readonly followUps?: FollowUpsService,
    @Optional() private readonly quality?: QualityService,
  ) {
    for (const k of buildTaskKinds({ prisma, inventory, workTasks })) this.registerKind(k);
    if (finance) for (const k of buildFinanceKinds({ prisma, finance, workTasks, settings, collections, followUps })) this.registerKind(k);
    if (marketing) for (const k of buildMarketingKinds({ prisma, marketing })) this.registerKind(k);
    if (quality) for (const k of buildQualityKinds({ quality, workTasks })) this.registerKind(k);
    // An approved agent request resumes the waiting task, which then runs with `approved: true`.
    approvals.registerExecutor('agent.task', async (a) => {
      const taskId = (a.payload as { taskId?: string }).taskId ?? a.taskId;
      if (!taskId) throw new Error('Approval has no task');
      await this.resumeApproved(a.organizationId, taskId, a.id);
      return { taskId, status: (await this.prisma.agentTask.findUnique({ where: { id: taskId } }))?.status };
    });
  }

  onModuleInit() {
    this.wireEvents();
  }

  /** Tests and workers: null = no queue (runs only when `run` is called). */
  useQueue(q: Queue<AgentTaskJobData> | null) {
    this.queue = q;
  }

  registerKind(k: TaskKind) {
    if (!AGENTS[k.agent]) throw new Error(`Unknown agent ${k.agent}`);
    this.kinds.set(k.kind, k);
  }

  listKinds() {
    return [...this.kinds.values()].map((k) => ({ kind: k.kind, agent: k.agent, label: k.label, description: k.description, userRunnable: k.userRunnable }));
  }

  /** Order events -> Operations. Wired once per process. */
  private wired = false;
  wireEvents() {
    if (this.wired || !this.textileEvents) return;
    this.wired = true;
    this.textileEvents.onBeforeOrderStatus(async (e) => {
      if (e.to === 'ready_to_dispatch' || e.to === 'dispatched') {
        await this.inventory.assertReady(e.organizationId, e.orderId); // Operations: stock reserved
        await this.finance?.assertDispatchAllowed(e.organizationId, e.orderId); // Finance: dispatch payment rule
      }
    });
    this.textileEvents.onOrderStatus(async (e) => {
      const kind = e.to === 'confirmed' ? 'operations.reserve_order' : e.to === 'cancelled' ? 'operations.release_order' : e.to === 'dispatched' ? 'operations.dispatch_order' : null;
      if (kind) await this.submit(e.organizationId, { kind, input: { orderId: e.orderId }, trigger: 'event', idempotencyKey: `order:${e.orderId}:${e.to}`, requestedBy: e.actor }, { runNow: true });
      if (e.to === 'confirmed' && this.finance) {
        const s = this.settings ? await this.settings.get(e.organizationId) : DEFAULT_SETTINGS;
        if (s.finance?.autoDraftInvoice ?? true) {
          await this.submit(e.organizationId, { kind: 'finance.invoice_draft', input: { orderId: e.orderId }, trigger: 'event', idempotencyKey: `order:${e.orderId}:invoice_draft`, requestedBy: e.actor }, { runNow: true });
        }
      }
    });
    this.financeEvents?.onPaymentVerified(async (e) => {
      await this.submit(e.organizationId, { kind: 'finance.payment_verified', input: { paymentId: e.paymentId }, trigger: 'event', idempotencyKey: `payment:${e.paymentId}:verified`, requestedBy: e.actor }, { runNow: true });
    });
  }

  // ------------------------------------------------------------------ submit / run

  async submit(organizationId: string, spec: SubmitSpec, opts: { runNow?: boolean } = {}) {
    const def = this.kinds.get(spec.kind);
    if (!def) throw new BadRequestException(`Unknown task kind ${spec.kind}`);
    const input = def.parse(spec.input ?? {}); // untrusted input validated before anything is stored
    let depth = 0;
    if (spec.parentTaskId) {
      const parent = await this.prisma.agentTask.findFirst({ where: { id: spec.parentTaskId, organizationId } });
      if (!parent) throw new NotFoundException('Parent task not found');
      depth = parent.depth + 1;
      if (depth > MAX_HANDOFF_DEPTH) throw new PermanentError(`Handoff chain too deep (${depth} > ${MAX_HANDOFF_DEPTH}): stopped to prevent agent loops`);
    }
    const entity = def.entity?.(input as never);
    let task;
    let duplicate = false;
    try {
      task = await this.prisma.agentTask.create({
        data: {
          organizationId, agent: def.agent, kind: def.kind, trigger: spec.trigger, idempotencyKey: spec.idempotencyKey.slice(0, 191),
          entityType: entity?.type ?? null, entityId: entity?.id ?? null, input: input as never, requestedBy: spec.requestedBy.slice(0, 191),
          parentTaskId: spec.parentTaskId ?? null, depth, maxAttempts: def.maxAttempts ?? 3, timeoutMs: def.timeoutMs ?? 30_000,
        },
      });
      await this.event(organizationId, task.id, 'created', `${def.label} (${spec.trigger})`, { requestedBy: spec.requestedBy });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      task = await this.prisma.agentTask.findFirst({ where: { organizationId, idempotencyKey: spec.idempotencyKey.slice(0, 191) } });
      if (!task) throw e;
      duplicate = true; // the same event / click again: no second run
    }
    if (!duplicate) {
      if (opts.runNow) await this.run(organizationId, task.id);
      else await this.enqueue(organizationId, task.id);
    }
    return { task: await this.getTask(organizationId, task.id), duplicate };
  }

  private async enqueue(organizationId: string, taskId: string, delayMs = 0) {
    if (!this.queue) return;
    const attempts = (await this.prisma.agentTask.findUnique({ where: { id: taskId }, select: { attempts: true } }))?.attempts ?? 0;
    await this.queue
      .add('run', { organizationId, taskId }, { jobId: `${taskId}-${attempts}`, delay: delayMs })
      .catch((e) => log.error('agent.enqueue_failed', { taskId, error: errorMessage(e) }));
  }

  private async paused(organizationId: string, agent: string) {
    const s = this.settings ? await this.settings.get(organizationId) : DEFAULT_SETTINGS;
    return (s.agents?.paused ?? []).includes(agent as AgentName);
  }

  /** Run a PENDING task once (atomic claim: two workers can never run the same task). */
  async run(organizationId: string, taskId: string) {
    const t = await this.prisma.agentTask.findFirst({ where: { id: taskId, organizationId } });
    if (!t) throw new NotFoundException('Task not found');
    if (t.status !== 'PENDING') return t;
    if (await this.paused(organizationId, t.agent)) {
      const last = await this.prisma.agentTaskEvent.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } });
      if (last?.type !== 'paused') await this.event(organizationId, taskId, 'paused', `${AGENTS[t.agent as AgentName].label} is paused; the task waits`);
      return t;
    }
    const def = this.kinds.get(t.kind);
    const claimed = await this.prisma.agentTask.updateMany({
      where: { id: taskId, organizationId, status: 'PENDING', OR: [{ runAfter: null }, { runAfter: { lte: new Date() } }] },
      data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date(), error: null },
    });
    if (claimed.count === 0) return this.prisma.agentTask.findUnique({ where: { id: taskId } });
    const task = (await this.prisma.agentTask.findUnique({ where: { id: taskId } }))!;
    await this.event(organizationId, taskId, 'started', `Attempt ${task.attempts} of ${task.maxAttempts}`);
    if (!def) return this.fail(organizationId, task.id, `No handler registered for ${task.kind}`, true);

    const agent = task.agent as AgentName;
    const allowed = new Set<ToolName>(AGENTS[agent].tools);
    const ctx: AgentContext = {
      organizationId,
      taskId,
      agent,
      actor: `agent:${agent}`,
      approved: Boolean(task.approvalId) && (await this.prisma.approval.count({ where: { id: task.approvalId!, status: { in: ['approved', 'executed'] } } })) > 0,
      tool: async (tool, fn, note) => {
        if (!allowed.has(tool)) {
          await this.event(organizationId, taskId, 'tool_denied', `${AGENTS[agent].label} may not use ${tool}`);
          throw new PermanentError(`Permission denied: ${agent} agent cannot use tool ${tool}`);
        }
        await this.event(organizationId, taskId, 'tool', note ?? tool, { tool });
        return fn();
      },
      note: (message, data) => this.event(organizationId, taskId, 'note', message, data),
    };

    let outcome: HandlerOutcome;
    try {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${task.timeoutMs} ms`)), task.timeoutMs);
      });
      try {
        outcome = await Promise.race([def.run(ctx, task.input as never), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return this.failOrRetry(organizationId, task.id, e);
    }

    if (outcome.status === 'needs_approval') {
      const r = await this.approvals.request(organizationId, {
        action: 'agent.task', entityType: outcome.entity.type, entityId: outcome.entity.id, reason: outcome.reason,
        payload: { taskId, kind: task.kind, proposed: outcome.action, ...outcome.payload }, requiredPermission: outcome.requiredPermission,
        requestedBy: `agent:${agent}`, taskId,
      });
      await this.prisma.agentTask.update({ where: { id: taskId }, data: { status: 'NEEDS_APPROVAL', approvalId: r.approval.id } });
      await this.event(organizationId, taskId, 'needs_approval', outcome.reason, { approvalId: r.approval.id, permission: outcome.requiredPermission });
      return this.prisma.agentTask.findUnique({ where: { id: taskId } });
    }

    await this.prisma.agentTask.update({ where: { id: taskId }, data: { status: 'COMPLETED', result: outcome.result as never, finishedAt: new Date() } });
    await this.event(organizationId, taskId, 'completed', outcome.summary.slice(0, 480));
    for (const h of outcome.handoffs ?? []) {
      const next = this.kinds.get(h.kind);
      try {
        const child = await this.submit(organizationId, { kind: h.kind, input: h.input, trigger: 'handoff', idempotencyKey: `${task.idempotencyKey}>${h.kind}`.slice(0, 191), requestedBy: `agent:${agent}`, parentTaskId: taskId }, { runNow: true });
        await this.event(organizationId, taskId, 'handoff', `Handed to ${next ? AGENTS[next.agent].label : h.kind}: ${h.reason}`.slice(0, 480), { childTaskId: child.task.id, kind: h.kind });
      } catch (e) {
        await this.event(organizationId, taskId, 'handoff_failed', `Handoff to ${h.kind} failed: ${errorMessage(e)}`.slice(0, 480));
      }
    }
    return this.prisma.agentTask.findUnique({ where: { id: taskId } });
  }

  private async failOrRetry(organizationId: string, taskId: string, e: unknown) {
    const t = (await this.prisma.agentTask.findUnique({ where: { id: taskId } }))!;
    const message = errorMessage(e).slice(0, 2000);
    if (!isPermanent(e) && t.attempts < t.maxAttempts) {
      const delay = 30_000 * 2 ** (t.attempts - 1);
      await this.prisma.agentTask.update({ where: { id: taskId }, data: { status: 'PENDING', error: message, runAfter: new Date(Date.now() + delay) } });
      await this.event(organizationId, taskId, 'retry', `Failed: ${message}`.slice(0, 480) + ` - retrying in ${Math.round(delay / 1000)} s`);
      await this.enqueue(organizationId, taskId, delay);
      return this.prisma.agentTask.findUnique({ where: { id: taskId } });
    }
    return this.fail(organizationId, taskId, message, isPermanent(e));
  }

  private async fail(organizationId: string, taskId: string, message: string, permanent: boolean) {
    await this.prisma.agentTask.update({ where: { id: taskId }, data: { status: 'FAILED', error: message, finishedAt: new Date() } });
    await this.event(organizationId, taskId, 'failed', `${permanent ? '' : 'Gave up after retries: '}${message}`.slice(0, 480));
    log.error('agent.task_failed', { organizationId, taskId, error: message });
    return this.prisma.agentTask.findUnique({ where: { id: taskId } });
  }

  private async resumeApproved(organizationId: string, taskId: string, approvalId: string) {
    const r = await this.prisma.agentTask.updateMany({ where: { id: taskId, organizationId, status: 'NEEDS_APPROVAL', approvalId }, data: { status: 'PENDING', runAfter: null } });
    if (r.count === 0) throw new ConflictException('The task is no longer waiting for this approval');
    await this.event(organizationId, taskId, 'approved', 'Approved; running');
    const t = await this.run(organizationId, taskId);
    if (t?.status === 'FAILED') throw new Error(t.error ?? 'Task failed after approval');
  }

  /** A rejected / cancelled / expired approval ends its waiting task (CANCELLED with the reason). */
  async settleRejectedApprovals(organizationId: string) {
    const waiting = await this.prisma.agentTask.findMany({ where: { organizationId, status: 'NEEDS_APPROVAL' }, select: { id: true, approvalId: true } });
    for (const w of waiting) {
      const a = w.approvalId ? await this.prisma.approval.findUnique({ where: { id: w.approvalId } }) : null;
      if (a && ['rejected', 'cancelled', 'expired'].includes(a.status)) {
        await this.prisma.agentTask.updateMany({ where: { id: w.id, status: 'NEEDS_APPROVAL' }, data: { status: 'CANCELLED', finishedAt: new Date(), error: `Approval ${a.status}${a.decisionNote ? `: ${a.decisionNote}` : ''}` } });
        await this.event(organizationId, w.id, 'cancelled', `Approval ${a.status}`);
      }
    }
  }

  private event(organizationId: string, taskId: string, type: string, message: string, data?: Record<string, unknown>) {
    return this.prisma.agentTaskEvent
      .create({ data: { organizationId, taskId, type, message: message.slice(0, 500), data: (data ?? undefined) as never } })
      .then(() => undefined)
      .catch((e) => log.error('agent.event_failed', { taskId, type, error: errorMessage(e) }));
  }

  // ------------------------------------------------------------------ controls

  async cancel(organizationId: string, taskId: string, by: string) {
    const t = await this.getTask(organizationId, taskId);
    if (!['PENDING', 'NEEDS_APPROVAL', 'FAILED'].includes(t.status)) throw new ConflictException(`A ${t.status.toLowerCase()} task cannot be cancelled`);
    const r = await this.prisma.agentTask.updateMany({ where: { id: taskId, organizationId, status: t.status }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    if (r.count === 0) throw new ConflictException('The task changed meanwhile');
    if (t.approvalId) await this.approvals.cancel(organizationId, t.approvalId, by).catch(() => undefined);
    await this.event(organizationId, taskId, 'cancelled', `Cancelled by ${by.startsWith('user:') ? 'a team member' : by}`);
    return this.getTask(organizationId, taskId);
  }

  /** Safe retry: only a FAILED task; it runs the same input again (every stock / task write is idempotent). */
  async retry(organizationId: string, taskId: string, by: string) {
    const r = await this.prisma.agentTask.updateMany({ where: { id: taskId, organizationId, status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, error: null, runAfter: null, finishedAt: null } });
    if (r.count === 0) throw new ConflictException('Only a failed task can be retried');
    await this.event(organizationId, taskId, 'manual_retry', `Retried by ${by.startsWith('user:') ? 'a team member' : by}`);
    await this.run(organizationId, taskId);
    return this.getTask(organizationId, taskId);
  }

  async setPaused(organizationId: string, agent: AgentName, paused: boolean) {
    if (!AGENT_NAMES.includes(agent)) throw new BadRequestException('Unknown agent');
    if (!this.settings) throw new BadRequestException('Settings are not available');
    const s = await this.settings.get(organizationId);
    const set = new Set(s.agents?.paused ?? []);
    if (paused) set.add(agent);
    else set.delete(agent);
    await this.settings.update(organizationId, { agents: { paused: [...set] } });
    if (!paused) {
      const waiting = await this.prisma.agentTask.findMany({ where: { organizationId, agent, status: 'PENDING' }, select: { id: true }, take: 200 });
      for (const w of waiting) await this.run(organizationId, w.id);
    }
    return this.agentsOverview(organizationId);
  }

  // ------------------------------------------------------------------ reads

  async getTask(organizationId: string, taskId: string) {
    const t = await this.prisma.agentTask.findFirst({
      where: { id: taskId, organizationId },
      include: { events: { orderBy: { createdAt: 'asc' } }, children: { select: { id: true, agent: true, kind: true, status: true } }, parent: { select: { id: true, agent: true, kind: true, status: true } } },
    });
    if (!t) throw new NotFoundException('Task not found');
    return t;
  }

  async listTasks(organizationId: string, q: { agent?: string; status?: string; entityType?: string; entityId?: string } = {}) {
    await this.settleRejectedApprovals(organizationId);
    return this.prisma.agentTask.findMany({
      where: {
        organizationId,
        ...(q.agent ? { agent: q.agent } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.entityId ? { entityId: q.entityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async agentsOverview(organizationId: string) {
    const s = this.settings ? await this.settings.get(organizationId) : DEFAULT_SETTINGS;
    const since = new Date(Date.now() - 30 * 86_400_000);
    const counts = await this.prisma.agentTask.groupBy({ by: ['agent', 'status'], where: { organizationId, createdAt: { gte: since } }, _count: { _all: true } });
    const ai = await this.prisma.contentRevision.aggregate({ where: { organizationId, source: 'ai', createdAt: { gte: since } }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true } });
    const lastError = await this.prisma.agentTask.findMany({ where: { organizationId, status: 'FAILED' }, orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, agent: true, kind: true, error: true, updatedAt: true } });
    return AGENT_NAMES.map((name) => {
      const c = (status: string) => counts.find((x) => x.agent === name && x.status === status)?._count._all ?? 0;
      const def = AGENTS[name];
      return {
        ...def,
        paused: (s.agents?.paused ?? []).includes(name),
        kinds: this.listKinds().filter((k) => k.agent === name),
        last30Days: { completed: c('COMPLETED'), failed: c('FAILED'), running: c('RUNNING'), pending: c('PENDING'), needsApproval: c('NEEDS_APPROVAL'), cancelled: c('CANCELLED') },
        recentErrors: lastError.filter((e) => e.agent === name).slice(0, 5),
        // Agent tasks use rules and records only (no model calls), so their AI cost is zero. The customer chat / call
        // assistant's model usage is a separate cost and is not counted here.
        aiCost: name === 'marketing'
          ? { taskModelCalls: ai._count._all, inputTokens: ai._sum.inputTokens ?? 0, outputTokens: ai._sum.outputTokens ?? 0, note: `Marketing drafts (30 days): ${ai._count._all} model call(s), ${ai._sum.inputTokens ?? 0} input / ${ai._sum.outputTokens ?? 0} output tokens. Cost in ₹ is not computed (no per-token rate configured). Customer chat / call model usage is in the API logs, not here.` }
          : { taskModelCalls: 0, note: 'This agent makes no AI model calls.' },
      };
    });
  }
}
