import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ApprovalsService } from '../../governance/approvals.service.js';
import { errorMessage, log } from '../../common/logger.js';
import type { OfficeMode } from '../office-config.js';
import { RateLimiter, callKey, policyFor, validateArgs, withTimeout, type PermissionMode, type ToolContext, type ToolDef } from './contract.js';

export const OFFICE_APPROVAL_ACTION = 'office.tool';
export const OFFICE_APPROVE_PERMISSION = 'office.approve';

export type CallResult =
  | { status: 'ok'; result: unknown; reused?: boolean }
  | { status: 'error'; error: string }
  | { status: 'denied'; error: string }
  | { status: 'approval_required'; approvalId: string; message: string };

export type CallOptions = {
  mode: OfficeMode;
  /** The agent configuration's tools: name → mode. A tool not listed is not available to the agent. */
  allowed: Record<string, PermissionMode>;
  /** Breaker level "constrained": only reads. */
  readOnly?: boolean;
  /** Calls of each tool already made in this task (per-task caps). */
  counts: Map<string, number>;
};

/**
 * Every agent tool call goes through here: the tool must be in the agent's configuration, the arguments must match the
 * schema, the per-task and per-minute limits must allow it, and the approval policy decides whether it runs now or
 * waits for a person. Each call is stored with an idempotency key (task + tool + arguments), so a task retried after a
 * crash gets the stored result instead of doing the action twice; a sensitive call whose outcome is unknown (crash
 * between "send" and "record") is never repeated automatically.
 */
export class OfficeToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  private readonly limiter = new RateLimiter();

  constructor(private readonly prisma: PrismaService, private readonly approvals: ApprovalsService, defs: ToolDef[]) {
    for (const t of defs) this.tools.set(t.name, t);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()];
  }

  /** The tools an agent may be offered (its configuration, minus writes when constrained). */
  offered(opts: Pick<CallOptions, 'allowed' | 'readOnly'>) {
    return this.list().filter((t) => opts.allowed[t.name] && opts.allowed[t.name] !== 'denied' && (!opts.readOnly || t.risk === 'read'));
  }

  async call(ctx: ToolContext, name: string, rawArgs: unknown, opts: CallOptions): Promise<CallResult> {
    const tool = this.tools.get(name);
    if (!tool || !opts.allowed[name]) return this.refuse(ctx, name, rawArgs, `The tool "${name}" is not available to the ${ctx.role} agent.`);
    if (opts.readOnly && tool.risk !== 'read') return this.refuse(ctx, name, rawArgs, 'The office engine paused your write tools (circuit breaker). Finish with what you have.');
    const policy = policyFor(tool, opts.mode, opts.allowed[name]);
    if (policy === 'denied') return this.refuse(ctx, name, rawArgs, `The tool "${name}" is switched off for this agent.`);
    const v = validateArgs(tool.schema, rawArgs ?? {});
    if (!v.ok) return { status: 'error', error: `Invalid arguments: ${v.errors.join('; ')}` };
    const args = v.value;
    const used = opts.counts.get(name) ?? 0;
    if (used >= tool.perTask) return { status: 'error', error: `Limit reached: ${tool.perTask} calls of ${name} per task.` };
    opts.counts.set(name, used + 1);
    const key = callKey(ctx.taskId, name, args);

    // Same call made before in this task (a retry after a crash, or the model repeating itself).
    const prior = await this.prisma.officeToolCall.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
    if (prior) {
      if (prior.status === 'ok') return { status: 'ok', result: prior.result, reused: true };
      if (prior.status === 'approval_required') {
        const pending = await this.prisma.approval.findFirst({ where: { organizationId: ctx.organizationId, action: OFFICE_APPROVAL_ACTION, entityId: ctx.taskId, status: 'pending' }, select: { id: true } });
        if (pending) return { status: 'approval_required', approvalId: pending.id, message: 'This action is already waiting for a person’s approval.' };
      }
      if (prior.status === 'running' && tool.risk === 'sensitive') {
        await this.prisma.officeToolCall.update({ where: { id: prior.id }, data: { status: 'unknown' } });
        return { status: 'error', error: 'This action may already have happened (the worker stopped mid-call). It will not be repeated; a person must check it.' };
      }
      if (prior.status === 'rejected') return { status: 'denied', error: 'A person rejected this exact action. Do not ask again; continue without it.' };
      if (prior.status === 'unknown') return { status: 'error', error: 'This action’s outcome is unknown and will not be repeated; a person must check it.' };
    }

    if (policy === 'approval' && !ctx.approvedBy) return this.requestApproval(ctx, tool, args, key, prior?.id);

    if (!this.limiter.allow(`${ctx.organizationId}:${name}`, tool.perMinute)) return { status: 'error', error: `Rate limit: ${name} is limited to ${tool.perMinute} calls a minute. Try fewer calls.` };

    // Claim before acting: a crash after this point leaves a "running" row, so the action is never blindly repeated.
    const row = prior
      ? await this.prisma.officeToolCall.update({ where: { id: prior.id }, data: { status: 'running', args: args as never } })
      : await this.prisma.officeToolCall.create({ data: { organizationId: ctx.organizationId, taskId: ctx.taskId, agentRole: ctx.role, tool: name, idempotencyKey: key, args: args as never, status: 'running' } });
    const started = Date.now();
    try {
      const out = await withTimeout(tool.run(ctx, args), tool.timeoutMs, name);
      await this.prisma.officeToolCall.update({ where: { id: row.id }, data: { status: 'ok', result: (out.result ?? null) as never, evidence: (out.evidence ?? undefined) as never, ms: Date.now() - started } });
      await this.audit(ctx, 'tool.ok', name, { tool: name, ms: Date.now() - started, approvedBy: ctx.approvedBy });
      return { status: 'ok', result: out.result };
    } catch (e) {
      const msg = errorMessage(e).slice(0, 500);
      // A sensitive call that failed with an error is known not to have happened only for our own pre-checks; a
      // provider error stays "error" (visible), never silently retried by the model with the same key.
      await this.prisma.officeToolCall.update({ where: { id: row.id }, data: { status: 'error', result: { error: msg } as never, ms: Date.now() - started } });
      await this.audit(ctx, 'tool.error', name, { tool: name, error: msg });
      log.warn('office.tool_failed', { organizationId: ctx.organizationId, taskId: ctx.taskId, tool: name, error: msg });
      return { status: 'error', error: msg };
    }
  }

  /** Run exactly the approved call (the approval's stored payload), as the person who approved it. */
  async runApproved(ctx: ToolContext & { approvedBy: string }, name: string, args: Record<string, unknown>, opts: CallOptions): Promise<CallResult> {
    return this.call(ctx, name, args, { ...opts, counts: new Map() });
  }

  private async requestApproval(ctx: ToolContext, tool: ToolDef, args: Record<string, unknown>, key: string, priorId?: string): Promise<CallResult> {
    const payload = { taskId: ctx.taskId, tool: tool.name, args, key };
    const { approval } = await this.approvals.request(ctx.organizationId, {
      action: OFFICE_APPROVAL_ACTION, entityType: 'office_task', entityId: ctx.taskId, payload, requiredPermission: OFFICE_APPROVE_PERMISSION,
      requestedBy: `agent:${ctx.role}`, reason: `${ctx.role} agent wants to run ${tool.name}: ${tool.description}`, expiresInHours: 48,
    });
    if (priorId) await this.prisma.officeToolCall.update({ where: { id: priorId }, data: { status: 'approval_required' } });
    else await this.prisma.officeToolCall.create({ data: { organizationId: ctx.organizationId, taskId: ctx.taskId, agentRole: ctx.role, tool: tool.name, idempotencyKey: key, args: args as never, status: 'approval_required' } }).catch(() => undefined);
    await this.audit(ctx, 'tool.approval_requested', tool.name, { tool: tool.name, approvalId: approval.id });
    return { status: 'approval_required', approvalId: approval.id, message: 'Waiting for a person’s approval. Stop here: report status "blocked" with what you prepared.' };
  }

  private async refuse(ctx: ToolContext, name: string, args: unknown, why: string): Promise<CallResult> {
    await this.audit(ctx, 'tool.denied', name, { tool: name, why, args: typeof args === 'object' ? Object.keys(args ?? {}) : null });
    return { status: 'denied', error: why };
  }

  private audit(ctx: ToolContext, action: string, target: string, data: Record<string, unknown>) {
    return this.prisma.officeAuditLog.create({ data: { organizationId: ctx.organizationId, actor: `agent:${ctx.role}`, action, target: `task:${ctx.taskId}`, data: { ...data, target } as never } }).catch(() => undefined);
  }
}
