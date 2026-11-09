import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ApprovalsService } from '../../governance/approvals.service.js';
import { errorMessage, log } from '../../common/logger.js';
import { publishLive } from '../../common/live-events.js';
import { istDayStart } from '../../jarvis/jarvis-config.js';
import { officeQueue, type OfficeTaskJobData } from '../../queues/queues.js';
import type { OfficeConfig } from '../office-config.js';
import { OfficeSetupService, type AgentRuntime } from '../office-setup.service.js';
import { ROLE_TEMPLATES, agentInstructions, isRole, type Role } from '../agents/roles.js';
import { PlanError, ceoInstructions, ordered, parsePlan, type Plan } from '../agents/planner.js';
import { NoModelError, OpenAIModelPort, type ModelPort, type StepTool, type Usage } from '../agents/model-port.js';
import { parseStepOutput, untracedNumbers, type StepOutput } from '../agents/step-output.js';
import { route } from '../messaging/mailbox.js';
import { OfficeToolbox } from '../tools/toolbox.service.js';
import { OFFICE_APPROVAL_ACTION, type CallResult } from '../tools/registry.js';
import { untrusted, type ToolContext } from '../tools/contract.js';
import { budgetCheck, costUsd, estimatePlan, stepAllowance } from './budget.js';
import { STEERING_NOTE, nextLevel } from './breaker.js';
import { OPEN, TERMINAL, afterFailure, assertTransition, planStatusFrom, readyToQueue, type TaskStatus } from './task-state.js';

type TaskRow = NonNullable<Awaited<ReturnType<PrismaService['officeTask']['findFirst']>>>;
type PlanRow = NonNullable<Awaited<ReturnType<PrismaService['officePlan']['findFirst']>>>;
type Ctx = { approved?: Array<{ tool: string; status: string; result: unknown; approvedBy?: string }>; feedback?: string[]; children?: Array<{ role: string; status: string; summary: string; outcome?: unknown }>; inbox?: Array<{ from: string; act: string; body: string }>; stopReason?: string };

const LEASE_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 120_000;
const n = (v: unknown) => Number(v ?? 0) || 0;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const asCtx = (v: unknown): Ctx => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Ctx) : {});
class Permanent extends Error {}

/**
 * The AI Office engine: a state machine in MySQL, driven by a BullMQ queue. Models propose (a plan, tool calls, a
 * final JSON); this code decides every state change, checks budgets before each model call, runs tools only through
 * the registry, verifies outcomes against the database, delivers messages under hop / depth / loop limits, and writes
 * an audit row for everything. Recovery: a task whose worker died (lease expired) is retried once, and a sensitive
 * tool call whose outcome is unknown is never repeated.
 */
@Injectable()
export class OfficeEngine {
  private queue: Queue<OfficeTaskJobData> | null = officeQueue;
  model: ModelPort = new OpenAIModelPort();

  constructor(
    private readonly prisma: PrismaService,
    private readonly setup: OfficeSetupService,
    private readonly approvals: ApprovalsService,
    private readonly toolbox: OfficeToolbox,
  ) {
    // An approved office tool call runs exactly the stored proposal, as the person who approved it.
    approvals.registerExecutor(OFFICE_APPROVAL_ACTION, async (a, decidedBy) => this.executeApproved(a.organizationId, a.id, a.payload as Record<string, unknown>, decidedBy));
  }

  /** Tests: null = no queue (tasks run when `runTask` / `drain` is called). */
  useQueue(q: Queue<OfficeTaskJobData> | null) {
    this.queue = q;
  }

  // ================================================================================================ plans

  /** The CEO plans an instruction: a validated plan with a cost estimate (status draft). */
  async createPlan(organizationId: string, actor: string, input: { instruction: unknown; idempotencyKey?: unknown; source?: 'owner' | 'workflow'; workflowRunId?: string; mode?: string }) {
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim().slice(0, 4000) : '';
    if (instruction.length < 5) throw new BadRequestException('Write an instruction for the office, for example “Review today’s pending orders and prepare my report”.');
    const idem = (typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim() ? input.idempotencyKey.trim() : `plan:${sha(`${instruction}|${Date.now()}`)}`).slice(0, 191);
    const existing = await this.prisma.officePlan.findUnique({ where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: idem } } });
    if (existing) return this.planView(organizationId, existing.id);
    const cfg = await this.setup.config(organizationId);
    if (cfg.paused) throw new ConflictException('The AI Office is paused. Resume it in AI Office → Settings first.');
    await this.assertDailyBudget(organizationId, cfg);
    const roles = await this.setup.enabledRoles(organizationId);
    const ceo = await this.setup.runtime(organizationId, 'ceo');
    if (!roles.includes('ceo')) throw new ConflictException('The CEO agent is paused.');

    let plan: Plan | null = null;
    let problems: string[] = [];
    const usage: Usage[] = [];
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      const prompt = [`<instruction>${instruction.replace(/<\/?instruction>/gi, '')}</instruction>`, ...(problems.length ? [`Your previous plan was rejected: ${problems.join('; ')}. Return a corrected plan.`] : [])].join('\n');
      const r = await this.model.run({ organizationId, model: ceo.model, instructions: ceoInstructions(roles), input: prompt, tools: [], maxTurns: 1, maxOutputTokens: 1500, timeoutMs: 60_000, shouldStop: () => false }).catch((e) => {
        if (e instanceof NoModelError) throw new ConflictException(e.message);
        throw e;
      });
      usage.push(r.usage);
      try {
        plan = parsePlan(r.text, roles);
      } catch (e) {
        if (!(e instanceof PlanError)) throw e;
        problems = e.problems;
      }
    }
    const tokensIn = usage.reduce((a, u) => a + u.tokensIn, 0);
    const tokensOut = usage.reduce((a, u) => a + u.tokensOut, 0);
    const cost = usage.reduce((a, u) => a + costUsd(ceo.model, u.tokensIn, u.tokensOut, u.cachedIn), 0);
    if (!plan) {
      await this.recordUsage(organizationId, null, null, 'ceo', ceo.model, usage);
      await this.setup.audit(organizationId, actor, 'plan.rejected', null, { problems });
      throw new UnprocessableEntityException({ message: 'The CEO could not make a valid plan. Try a clearer instruction.', problems });
    }
    const mode = ['manual', 'supervised', 'autonomous'].includes(String(input.mode)) ? String(input.mode) : cfg.mode;
    const estimate = estimatePlan(cfg.model, plan.tasks.length, cfg.inrPerUsd);
    const row = await this.prisma.officePlan.create({
      data: {
        organizationId, instruction, mode, status: 'draft', summary: plan.summary, plan: { ...plan, tasks: ordered(plan.tasks) } as never, estimate: estimate as never, budgets: cfg.budgets as never,
        tokensIn, tokensOut, costUsd: cost, steps: usage.length, idempotencyKey: idem, source: input.source ?? 'owner', workflowRunId: input.workflowRunId ?? null, createdBy: actor.slice(0, 191),
      },
    });
    await this.recordUsage(organizationId, row.id, null, 'ceo', ceo.model, usage);
    await this.setup.audit(organizationId, actor, 'plan.created', `plan:${row.id}`, { tasks: plan.tasks.length, mode, estimateUsd: estimate.usd });
    publishLive(organizationId, { type: 'office.plan', status: 'draft', planId: row.id, title: 'The CEO prepared a plan' });
    // Autonomous mode starts on its own, but only inside the plan budget.
    if (mode === 'autonomous' && estimate.usd <= cfg.budgets.maxUsd) return this.startPlan(organizationId, row.id, 'engine:autonomous');
    return this.planView(organizationId, row.id);
  }

  /** Approve and start: tasks and dependencies are written in one transaction; ready tasks are queued. */
  async startPlan(organizationId: string, planId: string, actor: string) {
    const plan = await this.getPlan(organizationId, planId);
    if (plan.status !== 'draft') throw new ConflictException(`This plan is already ${plan.status}`);
    const cfg = await this.setup.config(organizationId);
    if (cfg.paused) throw new ConflictException('The AI Office is paused.');
    await this.assertDailyBudget(organizationId, cfg);
    const p = plan.plan as unknown as Plan;
    const agents = new Map<string, AgentRuntime>();
    for (const t of p.tasks) if (!agents.has(t.role)) agents.set(t.role, await this.setup.runtime(organizationId, t.role));
    for (const a of agents.values()) if (!a.enabled || a.paused) throw new ConflictException(`The ${a.name} agent is ${a.paused ? 'paused' : 'switched off'}; switch it on or plan again.`);
    const deadline = new Date(Date.now() + (n((plan.budgets as Record<string, unknown>).deadlineMinutes) || cfg.budgets.deadlineMinutes) * 60_000);
    const queued: string[] = [];
    const claimed = await this.prisma.$transaction(async (tx) => {
      const r = await tx.officePlan.updateMany({ where: { id: planId, organizationId, status: 'draft' }, data: { status: 'running', approvedBy: actor.slice(0, 191), startedAt: new Date(), deadline } });
      if (!r.count) return false;
      const ids = new Map<string, string>();
      for (const t of p.tasks) {
        const status: TaskStatus = t.dependsOn.length ? 'blocked' : 'queued';
        const row = await tx.officeTask.create({
          data: {
            organizationId, planId, agentId: agents.get(t.role)!.id, role: t.role, key: t.key, title: t.title, instructions: t.instructions, status, priority: t.priority,
            idempotencyKey: `${planId}:${t.key}`, depth: 0, maxAttempts: 2, deadline, tools: ROLE_TEMPLATES[t.role].tools as never, createdBy: actor.slice(0, 191),
          },
        });
        ids.set(t.key, row.id);
        if (status === 'queued') queued.push(row.id);
      }
      for (const t of p.tasks) for (const d of t.dependsOn) await tx.officeTaskDependency.create({ data: { taskId: ids.get(t.key)!, dependsOnId: ids.get(d)! } });
      return true;
    });
    if (!claimed) throw new ConflictException('Someone started this plan just now');
    await this.setup.audit(organizationId, actor, 'plan.started', `plan:${planId}`, { tasks: p.tasks.length });
    publishLive(organizationId, { type: 'office.plan', status: 'running', planId, title: 'The office started working on your plan' });
    for (const id of queued) await this.enqueue(organizationId, id);
    return this.planView(organizationId, planId);
  }

  async cancelPlan(organizationId: string, planId: string, actor: string) {
    const plan = await this.getPlan(organizationId, planId);
    if (!['draft', 'running', 'paused'].includes(plan.status)) throw new ConflictException(`A ${plan.status} plan cannot be cancelled`);
    const open = await this.prisma.officeTask.findMany({ where: { organizationId, planId, status: { in: [...OPEN] } }, select: { id: true, status: true } });
    for (const t of open) await this.transition(organizationId, t.id, t.status, 'cancelled', { error: 'Cancelled by a person' }).catch(() => undefined);
    await this.cancelPendingApprovals(organizationId, open.map((t) => t.id), actor);
    await this.prisma.officePlan.update({ where: { id: planId }, data: { status: 'cancelled', finishedAt: new Date() } });
    await this.setup.audit(organizationId, actor, 'plan.cancelled', `plan:${planId}`, { openTasks: open.length });
    publishLive(organizationId, { type: 'office.plan', status: 'cancelled', planId, title: 'Plan cancelled' });
    return this.planView(organizationId, planId);
  }

  /** Pause stops every open task of the plan where it is (running ones finish their current step first). */
  async pausePlan(organizationId: string, planId: string, actor: string, reason = 'Paused by a person') {
    const plan = await this.getPlan(organizationId, planId);
    if (plan.status !== 'running') throw new ConflictException(`A ${plan.status} plan cannot be paused`);
    const open = await this.prisma.officeTask.findMany({ where: { organizationId, planId, status: { in: ['blocked', 'queued'] } }, select: { id: true, status: true } });
    for (const t of open) await this.transition(organizationId, t.id, t.status, 'paused', { error: reason }).catch(() => undefined);
    await this.prisma.officePlan.update({ where: { id: planId }, data: { status: 'paused' } });
    await this.setup.audit(organizationId, actor, 'plan.paused', `plan:${planId}`, { reason });
    publishLive(organizationId, { type: 'office.plan', status: 'paused', planId, title: `Plan paused: ${reason}` });
    return this.planView(organizationId, planId);
  }

  async resumePlan(organizationId: string, planId: string, actor: string) {
    const plan = await this.getPlan(organizationId, planId);
    if (plan.status !== 'paused') throw new ConflictException(`A ${plan.status} plan cannot be resumed`);
    const cfg = await this.setup.config(organizationId);
    if (cfg.paused) throw new ConflictException('The AI Office is paused.');
    const extend = new Date(Date.now() + cfg.budgets.deadlineMinutes * 60_000);
    // Resuming takes the current settings' budgets when they are higher (the usual reason to resume after a budget stop).
    const pb = { ...cfg.budgets, ...((plan.budgets ?? {}) as Partial<OfficeConfig['budgets']>) };
    const budgets = Object.fromEntries(Object.entries(cfg.budgets).map(([k, v]) => [k, Math.max(Number(v), Number((pb as Record<string, number>)[k] ?? 0))]));
    await this.prisma.officePlan.update({ where: { id: planId }, data: { status: 'running', budgets: budgets as never, deadline: plan.deadline && plan.deadline > new Date() ? plan.deadline : extend } });
    await this.prisma.officeTask.updateMany({ where: { organizationId, planId, status: { in: [...OPEN] } }, data: { deadline: extend } });
    const paused = await this.prisma.officeTask.findMany({ where: { organizationId, planId, status: 'paused' }, include: { dependsOn: { include: { dependsOn: { select: { status: true } } } } } });
    for (const t of paused) {
      const ready = readyToQueue(t.dependsOn.map((d) => d.dependsOn.status));
      await this.transition(organizationId, t.id, 'paused', ready ? 'queued' : 'blocked', { error: null });
      if (ready) await this.enqueue(organizationId, t.id);
    }
    await this.setup.audit(organizationId, actor, 'plan.resumed', `plan:${planId}`, {});
    publishLive(organizationId, { type: 'office.plan', status: 'running', planId, title: 'Plan resumed' });
    return this.planView(organizationId, planId);
  }

  // ================================================================================================ tasks

  /** Worker entry: run one step of a queued task. Safe to call twice: only one claim succeeds. */
  async runTask(organizationId: string, taskId: string): Promise<void> {
    const task = await this.prisma.officeTask.findFirst({ where: { id: taskId, organizationId } });
    if (!task || task.status !== 'queued') return;
    if (task.runAfter && task.runAfter.getTime() > Date.now() + 1000) return this.enqueue(organizationId, task.id, task.runAfter.getTime() - Date.now());
    const cfg = await this.setup.config(organizationId);
    const plan = task.planId ? await this.prisma.officePlan.findFirst({ where: { id: task.planId, organizationId } }) : null;
    const agent = await this.setup.runtimeById(organizationId, task.agentId);

    // Kill switches, deadline and budgets are checked by code before any model call.
    // Office paused: the task stays queued and continues after "Resume office" (the sweep re-queues it).
    if (cfg.paused) return;
    if (plan && plan.status !== 'running') return this.stop(organizationId, task, `The plan is ${plan.status}`);
    if (!agent.enabled || agent.paused || agent.breaker === 'stopped') {
      const why = `The ${agent.name} agent is ${agent.breaker === 'stopped' ? 'stopped by its circuit breaker' : agent.paused ? 'paused' : 'switched off'}`;
      if (plan) await this.pausePlan(organizationId, plan.id, 'engine', why).catch(() => undefined); // visible; "Resume" continues
      return this.stop(organizationId, task, why);
    }
    if (task.deadline && task.deadline.getTime() < Date.now()) {
      if (plan) await this.pausePlan(organizationId, plan.id, 'engine', 'The plan passed its deadline').catch(() => undefined);
      return this.stop(organizationId, task, 'The plan passed its deadline');
    }
    const budget = await this.planBudget(organizationId, plan, cfg, agent.model);
    if (!budget.ok) {
      if (plan) await this.pausePlan(organizationId, plan.id, 'engine', budget.reason).catch(() => undefined);
      return this.stop(organizationId, task, budget.reason);
    }
    const running = await this.prisma.officeTask.count({ where: { organizationId, status: 'running' } });
    if (running >= cfg.concurrency) return this.enqueue(organizationId, task.id, 10_000);

    // Claim (one worker wins) with a lease: past the lease the task is presumed abandoned and recovered.
    const claim = await this.prisma.officeTask.updateMany({
      where: { id: task.id, organizationId, status: 'queued' },
      data: { status: 'running', attempts: { increment: 1 }, leaseUntil: new Date(Date.now() + LEASE_MS), startedAt: task.startedAt ?? new Date(), runAfter: null },
    });
    if (!claim.count) return;
    const attempt = task.attempts + 1;
    const exec = await this.prisma.officeExecution.create({ data: { organizationId, taskId: task.id, attempt, model: agent.model } });
    await this.prisma.officeAgent.update({ where: { id: agent.id }, data: { status: 'working', currentTaskId: task.id } });
    publishLive(organizationId, { type: 'office.task', status: 'running', taskId: task.id, planId: task.planId ?? undefined, role: task.role, title: `${agent.name}: ${task.title}` });
    await this.audit(organizationId, `agent:${task.role}`, 'task.started', task.id, { attempt });

    let step: { out: StepOutput; parsed: boolean; usage: Usage; approvalId?: string; toolCalls: number; turnsExhausted: boolean; repeated: number; idle: boolean; stopReason?: string } | null = null;
    try {
      step = await this.step(organizationId, task, plan, agent, cfg);
      const cost = costUsd(agent.model, step.usage.tokensIn, step.usage.tokensOut, step.usage.cachedIn);
      await this.prisma.officeExecution.update({ where: { id: exec.id }, data: { steps: step.usage.requests, toolCalls: step.toolCalls, tokensIn: step.usage.tokensIn, tokensOut: step.usage.tokensOut, costUsd: cost, trace: { summary: step.out.summary, status: step.out.status, parsed: step.parsed, stop: step.stopReason ?? null } as never } });
      await this.recordUsage(organizationId, task.planId, task.id, task.role, agent.model, [step.usage]);

      if (step.approvalId) {
        await this.finishExec(exec.id, 'waiting_approval');
        await this.transition(organizationId, task.id, 'running', 'waiting_approval', { result: { summary: step.out.summary, outcome: step.out.outcome } as never, leaseUntil: null });
        publishLive(organizationId, { type: 'office.approval', status: 'pending', taskId: task.id, planId: task.planId ?? undefined, role: task.role, title: `${agent.name} needs your approval` });
      } else if (step.stopReason) {
        await this.finishExec(exec.id, 'stopped', 'budget', step.stopReason);
        await this.transition(organizationId, task.id, 'running', 'needs_review', { error: step.stopReason, result: { summary: step.out.summary, outcome: step.out.outcome } as never, leaseUntil: null });
      } else if (step.turnsExhausted || !step.parsed) {
        throw new Error(step.turnsExhausted ? `The ${agent.name} agent used all ${agent.budgets.maxStepsPerTask} steps without finishing` : `The ${agent.name} agent did not answer in the agreed format`);
      } else if (step.out.status === 'blocked') {
        await this.finishExec(exec.id, 'done');
        await this.transition(organizationId, task.id, 'running', 'needs_review', { error: `Blocked: ${step.out.summary}`, result: { summary: step.out.summary, outcome: step.out.outcome } as never, leaseUntil: null });
      } else {
        await this.finishExec(exec.id, 'done');
        const result = { result: { summary: step.out.summary, outcome: step.out.outcome } as never, leaseUntil: null };
        const delegated = await this.deliver(organizationId, task, agent, cfg, step.out);
        if (delegated === 'escalated') {
          await this.transition(organizationId, task.id, 'running', 'needs_review', { ...result, error: 'Stopped by the hop / delegation limit and escalated to a person' });
        } else if (delegated > 0) {
          await this.transition(organizationId, task.id, 'running', 'waiting_tool', result);
        } else {
          await this.transition(organizationId, task.id, 'running', 'verifying', result);
          await this.verify(organizationId, task.id);
        }
      }
    } catch (e) {
      const msg = errorMessage(e).slice(0, 1000);
      const permanent = e instanceof Permanent || e instanceof NoModelError || e instanceof ConflictException;
      await this.finishExec(exec.id, 'failed', permanent ? 'permanent' : 'error', msg);
      log.warn('office.task_failed', { organizationId, taskId: task.id, attempt, error: msg });
      await this.fail(organizationId, task.id, attempt, task.maxAttempts, permanent, msg);
    } finally {
      const fresh = await this.prisma.officeTask.findFirst({ where: { id: task.id }, select: { status: true } });
      await this.prisma.officeAgent.updateMany({ where: { id: agent.id, currentTaskId: task.id }, data: { status: fresh?.status === 'waiting_approval' ? 'waiting' : 'idle', currentTaskId: null } });
      await this.breaker(organizationId, agent, task.id, step);
      if (fresh && (TERMINAL as readonly string[]).includes(fresh.status) && task.planId) await this.finishPlanIfDone(organizationId, task.planId);
    }
  }

  /** One bounded model run: the agent's tools go through the registry; the step stops at an approval or a budget. */
  private async step(organizationId: string, task: TaskRow, plan: PlanRow | null, agent: AgentRuntime, cfg: OfficeConfig) {
    const ctx = asCtx(task.context);
    const tc: ToolContext = { organizationId, taskId: task.id, planId: task.planId, role: task.role };
    const counts = new Map<string, number>();
    const seen = new Map<string, number>();
    let toolCalls = 0;
    let approvalId: string | undefined;
    let stopReason: string | undefined;
    let repeated = 0;
    const offered = this.toolbox.registry.offered({ allowed: agent.tools, readOnly: agent.breaker === 'constrained' });
    const tools: StepTool[] = offered.map((def) => ({
      name: def.name,
      description: def.description,
      schema: def.schema,
      invoke: async (args: unknown) => {
        if (approvalId || stopReason) return JSON.stringify({ error: 'The step is stopping.' });
        if (toolCalls >= agent.budgets.maxToolCallsPerTask) { stopReason = `Tool-call limit for this task reached (${agent.budgets.maxToolCallsPerTask})`; return JSON.stringify({ error: stopReason }); }
        toolCalls += 1;
        const sig = `${def.name}:${JSON.stringify(args)}`;
        seen.set(sig, (seen.get(sig) ?? 0) + 1);
        if ((seen.get(sig) ?? 0) > 1) repeated += 1;
        const r: CallResult = await this.toolbox.registry.call(tc, def.name, args, { mode: plan?.mode === 'manual' || plan?.mode === 'supervised' || plan?.mode === 'autonomous' ? (plan.mode as OfficeConfig['mode']) : cfg.mode, allowed: agent.tools, readOnly: agent.breaker === 'constrained', counts });
        await this.prisma.officePlan.updateMany({ where: { id: task.planId ?? '' }, data: { toolCalls: { increment: 1 } } });
        if (r.status === 'approval_required') { approvalId = r.approvalId; return JSON.stringify({ waitingForApproval: true, message: r.message }); }
        if (r.status === 'ok') return JSON.stringify({ ok: true, result: r.result }).slice(0, 12_000);
        return JSON.stringify({ ok: false, error: r.error });
      },
    }));

    const deps = await this.prisma.officeTaskDependency.findMany({ where: { taskId: task.id }, include: { dependsOn: { select: { key: true, role: true, title: true, result: true, verification: true } } } });
    const parent = task.parentTaskId ? await this.prisma.officeTask.findFirst({ where: { id: task.parentTaskId, organizationId }, select: { role: true, title: true } }) : null;
    const input = [
      plan ? `Owner's instruction (the goal of the whole plan): ${untrusted(plan.instruction, 1500)}` : null,
      plan?.summary ? `Plan: ${plan.summary}` : null,
      `Your task (${task.key}): ${task.title}\n${task.instructions}`,
      parent ? `This task was delegated to you by the ${parent.role} agent (task: ${parent.title}).` : null,
      deps.length ? `Results of the tasks yours depends on:\n${deps.map((d) => `- ${d.dependsOn.key} (${d.dependsOn.role}): ${JSON.stringify(d.dependsOn.result ?? {}).slice(0, 1500)}`).join('\n')}` : null,
      ctx.children?.length ? `Answers from colleagues you asked:\n${ctx.children.map((c) => `- ${c.role} (${c.status}): ${c.summary} ${JSON.stringify(c.outcome ?? {}).slice(0, 800)}`).join('\n')}` : null,
      ctx.approved?.length ? `Decisions on actions you asked approval for (already carried out by the engine where approved — do not ask again):\n${ctx.approved.map((a) => `- ${a.tool}: ${a.status} ${JSON.stringify(a.result ?? {}).slice(0, 600)}`).join('\n')}` : null,
      ctx.feedback?.length ? `Quality review of your previous attempt (fix this):\n${ctx.feedback.map((f) => `- ${f}`).join('\n')}` : null,
      ctx.inbox?.length ? `Messages for you:\n${ctx.inbox.map((m) => `- from ${m.from} (${m.act}): ${untrusted(m.body, 600)}`).join('\n')}` : null,
      task.role === 'reporting' ? 'Put the full report text in outcome.report. Do not write costs: the engine adds measured costs itself.' : null,
    ].filter(Boolean).join('\n\n');

    const res = await this.model.run({
      organizationId, model: agent.model,
      instructions: agentInstructions(agent.role, agent.instructions, agent.breaker === 'steering' ? STEERING_NOTE : null),
      input, tools, maxTurns: agent.budgets.maxStepsPerTask, maxOutputTokens: task.role === 'reporting' ? 1800 : 1000, timeoutMs: STEP_TIMEOUT_MS,
      shouldStop: () => Boolean(approvalId || stopReason),
    });
    if (res.usage.tokensIn + res.usage.tokensOut > agent.budgets.maxTokensPerTask) stopReason ??= `Token limit for this task passed (${res.usage.tokensIn + res.usage.tokensOut} > ${agent.budgets.maxTokensPerTask})`;
    const parsed = parseStepOutput(res.text);
    return { out: parsed.value, parsed: parsed.ok || Boolean(approvalId), usage: res.usage, approvalId, toolCalls, turnsExhausted: res.turnsExhausted && !approvalId, repeated, idle: toolCalls === 0 && !parsed.ok, stopReason };
  }

  // ================================================================================================ verify

  /**
   * A task is completed only after its outcome is checked against real state: every write tool call it made is
   * re-checked by that tool's verifier; reports must trace every number to their sources; work with nothing a machine
   * can check goes to the QA agent. Anything that cannot be verified ends in needs_review, never in completed.
   */
  async verify(organizationId: string, taskId: string) {
    const task = await this.prisma.officeTask.findFirst({ where: { id: taskId, organizationId } });
    if (!task || task.status !== 'verifying') return;
    const calls = await this.prisma.officeToolCall.findMany({ where: { organizationId, taskId }, orderBy: { createdAt: 'asc' } });
    const checks: Array<{ tool: string; ok: boolean; detail: string }> = [];
    for (const c of calls) {
      if (c.status === 'unknown') checks.push({ tool: c.tool, ok: false, detail: 'Outcome unknown (worker stopped mid-call): a person must check' });
      const def = this.toolbox.registry.get(c.tool);
      if (c.status !== 'ok' || !def?.verify || !c.evidence) continue;
      const v = await def.verify(organizationId, c.evidence as Record<string, unknown>).catch((e) => ({ ok: false as const, detail: `Check failed: ${errorMessage(e)}` }));
      checks.push({ tool: c.tool, ok: v.ok, detail: v.detail });
    }
    const result = (task.result ?? {}) as { summary?: string; outcome?: Record<string, unknown> };
    let verdict: { ok: boolean; how: string; detail: string };
    if (checks.length) {
      const bad = checks.filter((c) => !c.ok);
      verdict = { ok: !bad.length, how: 'database', detail: bad.length ? bad.map((b) => `${b.tool}: ${b.detail}`).join('; ') : `${checks.length} action(s) confirmed in the database` };
    } else if (task.role === 'reporting') {
      const report = String(result.outcome?.report ?? result.summary ?? '');
      const sources = [calls.filter((c) => c.status === 'ok').map((c) => c.result), await this.planResults(organizationId, task.planId, task.id)];
      const missing = report.length < 20 ? ['(no report text)'] : untracedNumbers(report, sources);
      verdict = { ok: !missing.length, how: 'trace', detail: missing.length ? `Numbers not found in the data: ${missing.slice(0, 8).join(', ')}` : 'Every number traced to the snapshot or task results' };
    } else {
      verdict = await this.qaReview(organizationId, task, calls);
    }
    await this.prisma.officeTask.update({ where: { id: task.id }, data: { verification: { ...verdict, checks } as never } });
    if (verdict.ok) {
      await this.transition(organizationId, task.id, 'verifying', 'completed', { verifiedAt: new Date(), finishedAt: new Date(), error: null });
      await this.audit(organizationId, 'engine', 'task.completed', task.id, { how: verdict.how });
      publishLive(organizationId, { type: 'office.task', status: 'completed', taskId: task.id, planId: task.planId ?? undefined, role: task.role, title: `${task.title}: done` });
      await this.afterTerminal(organizationId, task.id);
    } else if (task.reviews < 1 && verdict.how !== 'database') {
      const ctx = asCtx(task.context);
      await this.transition(organizationId, task.id, 'verifying', 'queued', { reviews: { increment: 1 }, context: { ...ctx, feedback: [...(ctx.feedback ?? []), verdict.detail] } as never, error: `Sent back once: ${verdict.detail}`.slice(0, 1000) });
      await this.audit(organizationId, 'agent:qa', 'task.sent_back', task.id, { detail: verdict.detail });
      await this.enqueue(organizationId, task.id);
    } else {
      await this.transition(organizationId, task.id, 'verifying', 'needs_review', { error: `Not verified: ${verdict.detail}`.slice(0, 1000) });
      await this.audit(organizationId, 'engine', 'task.needs_review', task.id, { detail: verdict.detail });
      publishLive(organizationId, { type: 'office.task', status: 'needs_review', taskId: task.id, planId: task.planId ?? undefined, role: task.role, title: `${task.title}: needs your review` });
    }
  }

  private async qaReview(organizationId: string, task: TaskRow, calls: Array<{ tool: string; status: string; result: unknown }>): Promise<{ ok: boolean; how: string; detail: string }> {
    const qa = await this.setup.runtime(organizationId, 'qa');
    if (!qa.enabled || qa.paused) return { ok: false, how: 'none', detail: 'No automatic check exists for this work and the QA agent is off' };
    const r = await this.model.run({
      organizationId, model: qa.model, maxTurns: 1, maxOutputTokens: 400, timeoutMs: 60_000, tools: [], shouldStop: () => false,
      instructions: agentInstructions('qa', qa.instructions) + '\nFor this review reply with ONLY JSON: {"pass":true|false,"reason":"one sentence"}.',
      input: [`Task given to the ${task.role} agent: ${task.title}\n${task.instructions}`, `Its answer: ${JSON.stringify(task.result ?? {}).slice(0, 3000)}`, `Tool calls it made (evidence): ${JSON.stringify(calls.map((c) => ({ tool: c.tool, status: c.status, result: c.result }))).slice(0, 6000)}`].join('\n\n'),
    });
    await this.recordUsage(organizationId, task.planId, task.id, 'qa', qa.model, [r.usage]);
    try {
      const j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)) as { pass?: unknown; reason?: unknown };
      return { ok: j.pass === true, how: 'qa', detail: `QA: ${String(j.reason ?? '').slice(0, 500) || (j.pass === true ? 'passed' : 'failed')}` };
    } catch {
      return { ok: false, how: 'qa', detail: 'QA did not give a readable verdict' };
    }
  }

  /** A person closes a task that needs review: accept (completed) or send back (queued, one more attempt). */
  async review(organizationId: string, taskId: string, decision: 'accept' | 'retry' | 'cancel', actor: string, note?: string) {
    const task = await this.getTask(organizationId, taskId);
    if (decision === 'accept') {
      if (!['needs_review'].includes(task.status)) throw new ConflictException('Only a task that needs review can be accepted');
      await this.transition(organizationId, task.id, task.status, 'completed', { verifiedAt: new Date(), finishedAt: new Date(), verification: { ok: true, how: 'person', detail: `Accepted by ${actor}${note ? `: ${note.slice(0, 300)}` : ''}` } as never });
    } else if (decision === 'retry') {
      if (!['needs_review', 'failed', 'dead_letter'].includes(task.status)) throw new ConflictException(`A ${task.status} task cannot be retried`);
      const ctx = asCtx(task.context);
      await this.transition(organizationId, task.id, task.status, 'queued', { attempts: 0, error: null, context: { ...ctx, feedback: note ? [...(ctx.feedback ?? []), `From a person: ${note.slice(0, 500)}`] : ctx.feedback } as never });
      if (task.planId) await this.prisma.officePlan.updateMany({ where: { id: task.planId, status: { in: ['completed', 'failed'] } }, data: { status: 'running', finishedAt: null } });
      await this.enqueue(organizationId, task.id);
    } else {
      if ((TERMINAL as readonly string[]).includes(task.status)) throw new ConflictException(`The task is already ${task.status}`);
      await this.transition(organizationId, task.id, task.status, 'cancelled', { error: `Cancelled by a person${note ? `: ${note.slice(0, 300)}` : ''}`, finishedAt: new Date() });
      await this.cancelPendingApprovals(organizationId, [task.id], actor);
    }
    await this.audit(organizationId, actor, `task.review_${decision}`, task.id, { note: note?.slice(0, 300) });
    if (decision !== 'retry') await this.afterTerminal(organizationId, task.id);
    return this.taskView(organizationId, task.id);
  }

  // ================================================================================================ messages

  /** Route the agent's outgoing messages. Returns how many delegated tasks were created, or 'escalated'. */
  private async deliver(organizationId: string, task: TaskRow, agent: AgentRuntime, cfg: OfficeConfig, out: StepOutput): Promise<number | 'escalated'> {
    if (!out.messages.length) return 0;
    const correlationId = task.planId ?? task.id;
    const hops = await this.prisma.officeMessage.count({ where: { organizationId, correlationId } });
    const enabled = await this.setup.enabledRoles(organizationId);
    const ancestry = await this.ancestry(organizationId, task);
    const routed = route(out.messages, { from: agent.role, canMessage: agent.canMessage, enabled, hops, hopCap: cfg.hopCap, depth: task.depth, maxDepth: cfg.maxDepth, ancestry });
    let created = 0;
    let escalated = false;
    for (const r of routed) {
      if (r.kind === 'refuse') {
        await this.audit(organizationId, 'engine', 'message.refused', task.id, { to: r.message.to, act: r.message.act, reason: r.reason });
        if (r.escalate) {
          escalated = true;
          publishLive(organizationId, { type: 'office.task', status: 'needs_review', taskId: task.id, planId: task.planId ?? undefined, role: task.role, title: `Stopped and escalated: ${r.reason}` });
        }
        continue;
      }
      if (r.kind === 'deliver') {
        await this.prisma.officeMessage.create({ data: { organizationId, correlationId, taskId: task.id, fromRole: agent.role, toRole: r.message.to, act: r.message.act, body: r.message.body, hops: hops + 1, deliveredAt: new Date() } });
        continue;
      }
      const recipient = await this.setup.runtime(organizationId, r.message.to);
      const child = await this.prisma.officeTask.upsert({
        where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: `${task.id}:${sha(`${r.message.to}|${r.message.body}`).slice(0, 32)}` } },
        create: {
          organizationId, planId: task.planId, agentId: recipient.id, role: r.message.to, key: `${task.key}>${r.message.to}`.slice(0, 40), title: `${r.message.act === 'query' ? 'Question' : 'Request'} from ${agent.name}`.slice(0, 300),
          instructions: r.message.body, status: 'queued', priority: task.priority, idempotencyKey: `${task.id}:${sha(`${r.message.to}|${r.message.body}`).slice(0, 32)}`,
          parentTaskId: task.id, depth: task.depth + 1, deadline: task.deadline, tools: ROLE_TEMPLATES[r.message.to].tools as never, createdBy: `agent:${agent.role}`,
        },
        update: {},
      });
      if ((TERMINAL as readonly string[]).includes(child.status) || child.status === 'needs_review') continue; // already answered
      await this.prisma.officeMessage.create({ data: { organizationId, correlationId, taskId: child.id, fromRole: agent.role, toRole: r.message.to, act: r.message.act, body: r.message.body, hops: hops + 1, deliveredAt: new Date() } });
      await this.audit(organizationId, `agent:${agent.role}`, 'task.delegated', task.id, { to: r.message.to, childTaskId: child.id });
      if (child.status === 'queued') await this.enqueue(organizationId, child.id);
      created += 1;
    }
    return escalated ? 'escalated' : created;
  }

  private async ancestry(organizationId: string, task: TaskRow): Promise<Role[]> {
    const roles: Role[] = [];
    let cur: { role: string; parentTaskId: string | null } | null = task;
    for (let i = 0; cur && i < 10; i++) {
      if (isRole(cur.role)) roles.push(cur.role);
      cur = cur.parentTaskId ? await this.prisma.officeTask.findFirst({ where: { id: cur.parentTaskId, organizationId }, select: { role: true, parentTaskId: true } }) : null;
    }
    return roles;
  }

  // ================================================================================================ approvals

  /** Approval executor: runs the approved call and puts the task back in the queue with the outcome. */
  private async executeApproved(organizationId: string, approvalId: string, payload: Record<string, unknown>, decidedBy: string) {
    const taskId = String(payload.taskId ?? '');
    const toolName = String(payload.tool ?? '');
    const args = (payload.args ?? {}) as Record<string, unknown>;
    const task = await this.getTask(organizationId, taskId);
    const agent = await this.setup.runtimeById(organizationId, task.agentId);
    const plan = task.planId ? await this.prisma.officePlan.findFirst({ where: { id: task.planId } }) : null;
    const cfg = await this.setup.config(organizationId);
    if (cfg.paused) throw new Error('The AI Office is paused: nothing was carried out');
    if (!['waiting_approval', 'paused', 'needs_review'].includes(task.status)) throw new Error(`The task is ${task.status}: nothing was carried out`);
    const r = await this.toolbox.registry.runApproved({ organizationId, taskId, planId: task.planId, role: task.role, approvedBy: decidedBy }, toolName, args, { mode: (plan?.mode as OfficeConfig['mode']) ?? cfg.mode, allowed: agent.tools, counts: new Map() });
    const ctx = asCtx(task.context);
    const entry = { tool: toolName, status: r.status === 'ok' ? 'approved and done' : `approved but failed: ${'error' in r ? r.error : r.status}`, result: r.status === 'ok' ? r.result : null, approvedBy: decidedBy };
    await this.prisma.officeTask.update({ where: { id: taskId }, data: { context: { ...ctx, approved: [...(ctx.approved ?? []), entry] } as never } });
    await this.audit(organizationId, decidedBy, 'approval.executed', taskId, { approvalId, tool: toolName, status: r.status });
    if (task.status === 'waiting_approval' && !(await this.pendingApprovals(organizationId, taskId))) await this.requeueAfterApproval(organizationId, taskId);
    if (r.status !== 'ok') throw new Error('error' in r ? r.error : `The action did not run (${r.status})`);
    return { taskId, tool: toolName, result: r.result };
  }

  /** After any decision (approve / reject / expiry): a task with no pending approvals continues. */
  async afterDecision(organizationId: string, approvalId: string) {
    const a = await this.prisma.approval.findFirst({ where: { id: approvalId, organizationId, action: OFFICE_APPROVAL_ACTION } });
    if (!a || a.status === 'pending') return;
    const p = (a.payload ?? {}) as { taskId?: string; key?: string; tool?: string };
    if (!p.taskId) return;
    if (['rejected', 'expired', 'cancelled'].includes(a.status)) {
      if (p.key) await this.prisma.officeToolCall.updateMany({ where: { organizationId, idempotencyKey: p.key, status: 'approval_required' }, data: { status: 'rejected', result: { note: a.decisionNote ?? a.status } as never } });
      const task = await this.prisma.officeTask.findFirst({ where: { id: p.taskId, organizationId } });
      if (task) {
        const ctx = asCtx(task.context);
        if (!(ctx.approved ?? []).some((x) => x.tool === p.tool && x.status.startsWith(a.status))) {
          await this.prisma.officeTask.update({ where: { id: task.id }, data: { context: { ...ctx, approved: [...(ctx.approved ?? []), { tool: String(p.tool), status: `${a.status}${a.decisionNote ? `: ${a.decisionNote}` : ''}`, result: null }] } as never } });
        }
      }
    }
    publishLive(organizationId, { type: 'office.approval', status: a.status, taskId: p.taskId, title: `Approval ${a.status}` });
    const task = await this.prisma.officeTask.findFirst({ where: { id: p.taskId, organizationId }, select: { status: true } });
    if (task?.status === 'waiting_approval' && !(await this.pendingApprovals(organizationId, p.taskId))) await this.requeueAfterApproval(organizationId, p.taskId);
  }

  private async requeueAfterApproval(organizationId: string, taskId: string) {
    const ok = await this.transition(organizationId, taskId, 'waiting_approval', 'queued', {}).then(() => true).catch(() => false);
    if (ok) await this.enqueue(organizationId, taskId);
  }

  private pendingApprovals(organizationId: string, taskId: string) {
    return this.prisma.approval.count({ where: { organizationId, action: OFFICE_APPROVAL_ACTION, entityId: taskId, status: 'pending' } });
  }

  private async cancelPendingApprovals(organizationId: string, taskIds: string[], actor: string) {
    if (!taskIds.length) return;
    const rows = await this.prisma.approval.findMany({ where: { organizationId, action: OFFICE_APPROVAL_ACTION, entityId: { in: taskIds }, status: 'pending' }, select: { id: true } });
    for (const r of rows) await this.approvals.cancel(organizationId, r.id, actor).catch(() => undefined);
  }

  // ================================================================================================ lifecycle

  private async stop(organizationId: string, task: TaskRow, reason: string) {
    await this.transition(organizationId, task.id, 'queued', 'paused', { error: reason.slice(0, 1000) }).catch(() => undefined);
    await this.audit(organizationId, 'engine', 'task.stopped', task.id, { reason });
  }

  private async fail(organizationId: string, taskId: string, attempts: number, maxAttempts: number, permanent: boolean, msg: string) {
    const t = await this.prisma.officeTask.findFirst({ where: { id: taskId, organizationId }, select: { status: true } });
    if (!t || (TERMINAL as readonly string[]).includes(t.status)) return;
    if (t.status !== 'failed') await this.transition(organizationId, taskId, t.status, 'failed', { error: msg, leaseUntil: null }).catch(() => undefined);
    const next = afterFailure(attempts, maxAttempts, permanent);
    if (next.status === 'queued') {
      await this.transition(organizationId, taskId, 'failed', 'queued', { runAfter: new Date(Date.now() + next.delayMs) });
      await this.enqueue(organizationId, taskId, next.delayMs);
    } else {
      await this.transition(organizationId, taskId, 'failed', 'dead_letter', { finishedAt: new Date() });
      await this.audit(organizationId, 'engine', 'task.dead_letter', taskId, { error: msg });
      publishLive(organizationId, { type: 'office.task', status: 'dead_letter', taskId, title: 'A task failed and needs a person' });
      await this.afterTerminal(organizationId, taskId);
    }
  }

  /** Completed: release dependents and answer the delegating parent. Any terminal: maybe finish the plan. */
  private async afterTerminal(organizationId: string, taskId: string) {
    const task = await this.prisma.officeTask.findFirst({ where: { id: taskId, organizationId } });
    if (!task) return;
    if (task.status === 'completed') {
      const dependents = await this.prisma.officeTaskDependency.findMany({ where: { dependsOnId: taskId }, select: { taskId: true } });
      for (const d of dependents) {
        const t = await this.prisma.officeTask.findFirst({ where: { id: d.taskId, organizationId }, include: { dependsOn: { include: { dependsOn: { select: { status: true } } } } } });
        if (t?.status === 'blocked' && readyToQueue(t.dependsOn.map((x) => x.dependsOn.status))) {
          await this.transition(organizationId, t.id, 'blocked', 'queued', {});
          await this.enqueue(organizationId, t.id);
        }
      }
    }
    if (task.parentTaskId) {
      const res = (task.result ?? {}) as { summary?: string; outcome?: unknown };
      await this.prisma.officeMessage.create({ data: { organizationId, correlationId: task.planId ?? task.parentTaskId, inReplyTo: null, taskId: task.parentTaskId, fromRole: task.role, toRole: (await this.prisma.officeTask.findFirst({ where: { id: task.parentTaskId }, select: { role: true } }))?.role ?? 'ceo', act: task.status === 'completed' ? 'done' : 'refuse', body: (res.summary ?? task.error ?? task.status).slice(0, 2000), hops: 0, deliveredAt: new Date() } });
      const siblings = await this.prisma.officeTask.findMany({ where: { organizationId, parentTaskId: task.parentTaskId }, select: { role: true, status: true, result: true, error: true } });
      const parent = await this.prisma.officeTask.findFirst({ where: { id: task.parentTaskId, organizationId } });
      if (parent?.status === 'waiting_tool' && siblings.every((s) => (TERMINAL as readonly string[]).includes(s.status) || s.status === 'needs_review')) {
        const ctx = asCtx(parent.context);
        const children = siblings.map((s) => ({ role: s.role, status: s.status, summary: String((s.result as { summary?: string } | null)?.summary ?? s.error ?? ''), outcome: (s.result as { outcome?: unknown } | null)?.outcome }));
        await this.transition(organizationId, parent.id, 'waiting_tool', 'queued', { context: { ...ctx, children } as never });
        await this.enqueue(organizationId, parent.id);
      }
    }
    if (task.planId) await this.finishPlanIfDone(organizationId, task.planId);
  }

  async finishPlanIfDone(organizationId: string, planId: string) {
    const plan = await this.prisma.officePlan.findFirst({ where: { id: planId, organizationId } });
    if (!plan || plan.status !== 'running') return;
    const tasks = await this.prisma.officeTask.findMany({ where: { organizationId, planId }, select: { status: true, role: true, result: true, title: true, error: true, verification: true } });
    const status = planStatusFrom(tasks.map((t) => t.status));
    if (status === 'running') return;
    const usage = await this.prisma.officeUsageRecord.aggregate({ where: { organizationId, planId }, _sum: { tokensIn: true, tokensOut: true, costUsd: true }, _count: true });
    const cfg = await this.setup.config(organizationId);
    const usd = n(usage._sum.costUsd);
    const rep = tasks.find((t) => t.role === 'reporting' && t.status === 'completed');
    const reportText = String(((rep?.result ?? {}) as { outcome?: { report?: unknown }; summary?: string }).outcome?.report ?? (rep?.result as { summary?: string } | null)?.summary ?? '');
    const cost = `Measured cost: US$${usd.toFixed(4)}${cfg.inrPerUsd > 0 ? ` (≈ ₹${(usd * cfg.inrPerUsd).toFixed(2)})` : ''}, ${n(usage._sum.tokensIn).toLocaleString('en-IN')} input and ${n(usage._sum.tokensOut).toLocaleString('en-IN')} output tokens in ${usage._count} model calls.`;
    const exceptions = tasks.filter((t) => t.status !== 'completed').map((t) => `${t.title}: ${t.status}${t.error ? ` (${t.error.slice(0, 160)})` : ''}`);
    const report = [reportText || 'No report was written.', exceptions.length ? `Exceptions:\n${exceptions.map((e) => `- ${e}`).join('\n')}` : null, cost].filter(Boolean).join('\n\n');
    const r = await this.prisma.officePlan.updateMany({ where: { id: planId, status: 'running' }, data: { status, finishedAt: new Date(), report, reportData: { usd, tokensIn: n(usage._sum.tokensIn), tokensOut: n(usage._sum.tokensOut), calls: usage._count, exceptions } as never } });
    if (!r.count) return;
    await this.audit(organizationId, 'engine', `plan.${status}`, `plan:${planId}`, { usd });
    publishLive(organizationId, { type: 'office.plan', status, planId, title: status === 'completed' ? 'Your plan is done: the report is ready' : `Plan ${status}` });
  }

  /** The circuit breaker: one level per finished execution. */
  private async breaker(organizationId: string, agent: AgentRuntime, taskId: string, step: { repeated: number; idle: boolean } | null) {
    const since = new Date(Date.now() - 10 * 60_000);
    const [recent, spend] = await Promise.all([
      this.prisma.officeExecution.findMany({ where: { organizationId, task: { agentId: agent.id } }, orderBy: { startedAt: 'desc' }, take: 5, select: { status: true } }),
      this.prisma.officeUsageRecord.aggregate({ where: { organizationId, agentRole: agent.role, at: { gte: since } }, _sum: { costUsd: true } }),
    ]);
    const signals = { repeatedCalls: step?.repeated ?? 0, recentFailures: recent.filter((r) => r.status === 'failed').length, usdLast10Min: n(spend._sum.costUsd), idleSteps: step?.idle ? 3 : 0 };
    const fresh = await this.prisma.officeAgent.findFirst({ where: { id: agent.id }, select: { breaker: true } });
    const next = nextLevel(fresh?.breaker ?? 'healthy', signals);
    if (!next.changed) return;
    await this.prisma.officeAgent.update({ where: { id: agent.id }, data: { breaker: next.level, ...(next.level === 'stopped' ? { paused: true, status: 'paused' } : {}) } });
    await this.audit(organizationId, 'engine', 'agent.breaker', `agent:${agent.role}`, { level: next.level, reasons: next.reasons, taskId });
    if (next.level === 'stopped' || next.level === 'constrained') publishLive(organizationId, { type: 'office.agent', status: next.level, role: agent.role, title: `${agent.name}: circuit breaker ${next.level} (${next.reasons.join(', ')})` });
  }

  /** Every minute: recover tasks whose worker died, re-queue lost jobs, continue tasks whose approvals were decided elsewhere. */
  async sweep(now = new Date()) {
    const expired = await this.prisma.officeTask.findMany({ where: { status: 'running', leaseUntil: { lt: now } }, select: { id: true, organizationId: true, attempts: true, maxAttempts: true }, take: 50 });
    for (const t of expired) {
      await this.audit(t.organizationId, 'engine', 'task.recovered', t.id, { reason: 'lease expired' });
      await this.prisma.officeExecution.updateMany({ where: { taskId: t.id, status: 'running' }, data: { status: 'failed', errorClass: 'lease_expired', finishedAt: now } });
      await this.fail(t.organizationId, t.id, t.attempts, t.maxAttempts, false, 'The worker stopped during this task; retried');
    }
    const lost = await this.prisma.officeTask.findMany({ where: { status: 'queued', updatedAt: { lt: new Date(now.getTime() - 2 * 60_000) }, OR: [{ runAfter: null }, { runAfter: { lt: now } }] }, select: { id: true, organizationId: true }, take: 100 });
    for (const t of lost) await this.enqueue(t.organizationId, t.id);
    const waiting = await this.prisma.officeTask.findMany({ where: { status: 'waiting_approval' }, select: { id: true, organizationId: true }, take: 100 });
    for (const t of waiting) {
      if (await this.pendingApprovals(t.organizationId, t.id)) continue;
      const last = await this.prisma.approval.findFirst({ where: { organizationId: t.organizationId, action: OFFICE_APPROVAL_ACTION, entityId: t.id }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      if (last) await this.afterDecision(t.organizationId, last.id);
      else await this.requeueAfterApproval(t.organizationId, t.id);
    }
    return { recovered: expired.length, requeued: lost.length };
  }

  /** Tests and "run now" without a worker: run queued tasks of one organization until none is left (bounded). */
  async drain(organizationId: string, maxSteps = 50) {
    let ran = 0;
    for (; ran < maxSteps; ran++) {
      const next = await this.prisma.officeTask.findFirst({ where: { organizationId, status: 'queued', OR: [{ runAfter: null }, { runAfter: { lte: new Date(Date.now() + 1000) } }] }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
      if (!next) break;
      await this.runTask(organizationId, next.id);
    }
    return ran;
  }

  // ================================================================================================ helpers

  async transition(organizationId: string, taskId: string, from: string, to: TaskStatus, data: Record<string, unknown>) {
    assertTransition(from, to);
    const r = await this.prisma.officeTask.updateMany({ where: { id: taskId, organizationId, status: from }, data: { ...data, status: to } as never });
    if (!r.count) throw new ConflictException(`The task changed meanwhile (expected ${from})`);
    await this.audit(organizationId, 'engine', 'task.status', taskId, { from, to });
  }

  private async finishExec(id: string, status: string, errorClass?: string, error?: string) {
    await this.prisma.officeExecution.update({ where: { id }, data: { status, finishedAt: new Date(), ...(errorClass ? { errorClass } : {}), ...(error ? { error: error.slice(0, 2000) } : {}) } });
  }

  async enqueue(organizationId: string, taskId: string, delayMs = 0) {
    if (!this.queue) return;
    try {
      await this.queue.add('run', { organizationId, taskId }, { delay: Math.max(0, Math.round(delayMs)) });
    } catch (e) {
      log.warn('office.enqueue_failed', { organizationId, taskId, error: errorMessage(e) }); // the sweep re-queues it
    }
  }

  private async recordUsage(organizationId: string, planId: string | null, taskId: string | null, role: string, model: string, usage: Usage[]) {
    for (const u of usage) {
      if (!u.tokensIn && !u.tokensOut) continue;
      const usd = costUsd(model, u.tokensIn, u.tokensOut, u.cachedIn);
      await this.prisma.officeUsageRecord.create({ data: { organizationId, planId, taskId, agentRole: role, model, tokensIn: u.tokensIn, tokensOut: u.tokensOut, cachedIn: u.cachedIn, costUsd: usd } });
      if (planId && taskId) await this.prisma.officePlan.updateMany({ where: { id: planId }, data: { tokensIn: { increment: u.tokensIn }, tokensOut: { increment: u.tokensOut }, costUsd: { increment: usd }, steps: { increment: Math.max(1, u.requests) } } });
      void this.prisma.integrationEvent.create({ data: { organizationId, provider: 'openai', kind: 'chat', ok: true, units: u.tokensIn + u.tokensOut, unitType: 'tokens', source: 'organization', message: `office.${role}` } }).catch(() => undefined);
    }
  }

  private async planBudget(organizationId: string, plan: PlanRow | null, cfg: OfficeConfig, model: string) {
    const day = await this.daySpend(organizationId);
    if (day + stepAllowance(model).usd > cfg.maxUsdPerDay) return { ok: false as const, reason: `Daily AI Office budget reached (US$${day.toFixed(3)} of US$${cfg.maxUsdPerDay})` };
    if (!plan) return { ok: true as const };
    const b = { ...cfg.budgets, ...((plan.budgets ?? {}) as Partial<OfficeConfig['budgets']>) };
    return budgetCheck({ usd: n(plan.costUsd), tokens: plan.tokensIn + plan.tokensOut, steps: plan.steps, toolCalls: plan.toolCalls }, b, stepAllowance(model));
  }

  async daySpend(organizationId: string) {
    const r = await this.prisma.officeUsageRecord.aggregate({ where: { organizationId, at: { gte: istDayStart(new Date()) } }, _sum: { costUsd: true } });
    return n(r._sum.costUsd);
  }

  private async assertDailyBudget(organizationId: string, cfg: OfficeConfig) {
    const day = await this.daySpend(organizationId);
    if (day >= cfg.maxUsdPerDay) throw new ConflictException(`Today’s AI Office budget is used up (US$${day.toFixed(3)} of US$${cfg.maxUsdPerDay}). Raise it in Settings or try tomorrow.`);
  }

  private async planResults(organizationId: string, planId: string | null, exceptTaskId: string) {
    if (!planId) return [];
    const rows = await this.prisma.officeTask.findMany({ where: { organizationId, planId, id: { not: exceptTaskId } }, select: { result: true, verification: true } });
    return rows;
  }

  private audit(organizationId: string, actor: string, action: string, taskId: string, data: Record<string, unknown>) {
    return this.setup.audit(organizationId, actor, action, taskId.startsWith('plan:') || taskId.startsWith('agent:') ? taskId : `task:${taskId}`, data);
  }

  async getPlan(organizationId: string, id: string) {
    const p = await this.prisma.officePlan.findFirst({ where: { id, organizationId } });
    if (!p) throw new NotFoundException('Plan not found');
    return p;
  }

  async getTask(organizationId: string, id: string) {
    const t = await this.prisma.officeTask.findFirst({ where: { id, organizationId } });
    if (!t) throw new NotFoundException('Task not found');
    return t;
  }

  // ================================================================================================ views

  async planView(organizationId: string, planId: string) {
    const plan = await this.getPlan(organizationId, planId);
    const tasks = await this.prisma.officeTask.findMany({ where: { organizationId, planId }, orderBy: [{ depth: 'asc' }, { createdAt: 'asc' }], include: { dependsOn: { include: { dependsOn: { select: { key: true } } } } } });
    const cfg = await this.setup.config(organizationId);
    return {
      ...plan, costUsd: n(plan.costUsd), inrPerUsd: cfg.inrPerUsd,
      tasks: tasks.map((t) => ({ id: t.id, key: t.key, role: t.role, title: t.title, status: t.status, depth: t.depth, parentTaskId: t.parentTaskId, attempts: t.attempts, error: t.error, result: t.result, verification: t.verification, dependsOn: t.dependsOn.map((d) => d.dependsOn.key), updatedAt: t.updatedAt })),
    };
  }

  async plans(organizationId: string, q: { status?: string; take?: number } = {}) {
    const rows = await this.prisma.officePlan.findMany({ where: { organizationId, ...(q.status ? { status: q.status } : {}) }, orderBy: { createdAt: 'desc' }, take: Math.min(100, q.take ?? 30), select: { id: true, instruction: true, summary: true, status: true, mode: true, source: true, costUsd: true, estimate: true, createdAt: true, finishedAt: true, _count: { select: { tasks: true } } } });
    return rows.map((r) => ({ ...r, costUsd: n(r.costUsd) }));
  }

  async tasks(organizationId: string, q: { status?: string; role?: string; planId?: string } = {}) {
    const where: Record<string, unknown> = { organizationId };
    if (q.status === 'open') where.status = { in: [...OPEN] };
    else if (q.status) where.status = q.status;
    if (q.role && isRole(q.role)) where.role = q.role;
    if (q.planId) where.planId = q.planId;
    return this.prisma.officeTask.findMany({ where, orderBy: [{ updatedAt: 'desc' }], take: 200, select: { id: true, planId: true, key: true, role: true, title: true, status: true, priority: true, attempts: true, depth: true, parentTaskId: true, error: true, createdAt: true, updatedAt: true, verifiedAt: true } });
  }

  async taskView(organizationId: string, taskId: string) {
    const t = await this.getTask(organizationId, taskId);
    const [executions, toolCalls, messages, approvals, usage] = await Promise.all([
      this.prisma.officeExecution.findMany({ where: { organizationId, taskId }, orderBy: { attempt: 'asc' } }),
      this.prisma.officeToolCall.findMany({ where: { organizationId, taskId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.officeMessage.findMany({ where: { organizationId, OR: [{ taskId }, ...(t.parentTaskId ? [{ taskId: t.parentTaskId }] : [])] }, orderBy: { createdAt: 'asc' }, take: 100 }),
      this.prisma.approval.findMany({ where: { organizationId, action: OFFICE_APPROVAL_ACTION, entityId: taskId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.officeUsageRecord.aggregate({ where: { organizationId, taskId }, _sum: { costUsd: true, tokensIn: true, tokensOut: true } }),
    ]);
    return {
      ...t,
      executions: executions.map((e) => ({ ...e, costUsd: n(e.costUsd) })),
      toolCalls: toolCalls.map((c) => ({ id: c.id, tool: c.tool, status: c.status, args: c.args, result: c.result, evidence: c.evidence, ms: c.ms, createdAt: c.createdAt })),
      messages,
      approvals: approvals.map((a) => ({ id: a.id, status: a.status, payload: a.payload, decidedBy: a.decidedBy, decidedAt: a.decidedAt, decisionNote: a.decisionNote, createdAt: a.createdAt, expiresAt: a.expiresAt })),
      usage: { usd: n(usage._sum.costUsd), tokensIn: n(usage._sum.tokensIn), tokensOut: n(usage._sum.tokensOut) },
      children: await this.prisma.officeTask.findMany({ where: { organizationId, parentTaskId: taskId }, select: { id: true, role: true, title: true, status: true } }),
    };
  }
}
