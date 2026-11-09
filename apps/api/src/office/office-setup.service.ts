import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import { publishLive } from '../common/live-events.js';
import { DEFAULT_OFFICE, OFFICE_MODELS, sanitizeOffice, type OfficeConfig } from './office-config.js';
import { ROLE_TEMPLATES, ROLES, isRole, type Role } from './agents/roles.js';
import { MANDATORY_APPROVAL, type PermissionMode } from './tools/contract.js';

export type AgentRuntime = {
  id: string;
  role: Role;
  name: string;
  enabled: boolean;
  paused: boolean;
  breaker: string;
  version: number;
  model: string;
  instructions: string | null;
  canMessage: Role[];
  budgets: { maxStepsPerTask: number; maxToolCallsPerTask: number; maxTokensPerTask: number };
  tools: Record<string, PermissionMode>;
};

const clampInt = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};

/**
 * Office setup: settings (OrganizationSettings.data.office), the departments and agents created from the role
 * templates, and versioned agent configurations. Creating the office is idempotent (safe to call on every visit).
 */
@Injectable()
export class OfficeSetupService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------------------------- settings
  async config(organizationId: string): Promise<OfficeConfig> {
    const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId } }).catch(() => null);
    return sanitizeOffice((row?.data as Record<string, unknown> | undefined)?.office, DEFAULT_OFFICE);
  }

  async saveConfig(organizationId: string, patch: unknown, actor: string): Promise<OfficeConfig> {
    const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId } });
    const data = (row?.data as Record<string, unknown> | undefined) ?? {};
    const before = sanitizeOffice(data.office, DEFAULT_OFFICE);
    const next = sanitizeOffice(patch, before);
    await this.prisma.organizationSettings.upsert({ where: { organizationId }, create: { organizationId, data: { office: next } as never }, update: { data: { ...data, office: next } as never } });
    await this.audit(organizationId, actor, 'office.settings_saved', 'settings', { mode: next.mode, paused: next.paused, model: next.model, budgets: next.budgets });
    if (before.paused !== next.paused) publishLive(organizationId, { type: 'office.agent', status: next.paused ? 'paused' : 'resumed', title: next.paused ? 'AI Office paused' : 'AI Office resumed' });
    log.info('office.settings_saved', { organizationId, mode: next.mode, paused: next.paused });
    return next;
  }

  // ---------------------------------------------------------------------------------------------- office
  /** Departments + one agent per role + configuration v1 + tool permissions, from the templates (idempotent). */
  async ensureOffice(organizationId: string, actor = 'engine') {
    const existing = await this.prisma.officeAgent.findMany({ where: { organizationId }, select: { role: true } });
    if (existing.length >= ROLES.length) return;
    const have = new Set(existing.map((a) => a.role));
    const cfg = await this.config(organizationId);
    for (const role of ROLES) {
      if (have.has(role)) continue;
      const t = ROLE_TEMPLATES[role];
      const dept = await this.prisma.officeDepartment.upsert({
        where: { organizationId_key: { organizationId, key: t.department.key } },
        create: { organizationId, key: t.department.key, name: t.department.name, sort: t.department.sort },
        update: {},
      });
      try {
        await this.prisma.$transaction(async (tx) => {
          const agent = await tx.officeAgent.create({ data: { organizationId, departmentId: dept.id, role, name: t.name, enabled: t.enabledByDefault, activeVersion: 1 } });
          const conf = await tx.officeAgentConfiguration.create({ data: { organizationId, agentId: agent.id, version: 1, model: cfg.model, canMessage: t.canMessage as never, budgets: t.budgets as never, createdBy: actor.slice(0, 191), note: 'Created from the role template' } });
          await tx.officeToolPermission.createMany({ data: t.tools.map((tool) => ({ agentConfigId: conf.id, tool, mode: MANDATORY_APPROVAL.includes(tool) ? 'approval' : 'auto' })) });
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e; // created by a parallel request
      }
    }
    log.info('office.created', { organizationId });
  }

  async runtime(organizationId: string, role: Role): Promise<AgentRuntime> {
    await this.ensureOffice(organizationId);
    const a = await this.prisma.officeAgent.findUnique({ where: { organizationId_role: { organizationId, role } } });
    if (!a) throw new NotFoundException(`No ${role} agent`);
    return this.runtimeOf(a);
  }

  async runtimeById(organizationId: string, agentId: string): Promise<AgentRuntime> {
    const a = await this.prisma.officeAgent.findFirst({ where: { id: agentId, organizationId } });
    if (!a) throw new NotFoundException('Agent not found');
    return this.runtimeOf(a);
  }

  private async runtimeOf(a: { id: string; organizationId: string; role: string; name: string; enabled: boolean; paused: boolean; breaker: string; activeVersion: number }): Promise<AgentRuntime> {
    const c = await this.prisma.officeAgentConfiguration.findUnique({ where: { agentId_version: { agentId: a.id, version: a.activeVersion } }, include: { tools: true } });
    if (!c) throw new NotFoundException('Agent configuration missing');
    const role = a.role as Role;
    const t = ROLE_TEMPLATES[role];
    // The template is the ceiling: a configuration can only use tools the role lists, and mandatory approvals stay.
    const tools: Record<string, PermissionMode> = {};
    for (const p of c.tools) if (t.tools.includes(p.tool)) tools[p.tool] = MANDATORY_APPROVAL.includes(p.tool) && p.mode === 'auto' ? 'approval' : (p.mode as PermissionMode);
    const b = (c.budgets ?? {}) as Record<string, unknown>;
    return {
      id: a.id, role, name: a.name, enabled: a.enabled, paused: a.paused, breaker: a.breaker, version: c.version,
      model: (OFFICE_MODELS as readonly string[]).includes(c.model) ? c.model : DEFAULT_OFFICE.model,
      instructions: c.instructions,
      canMessage: (Array.isArray(c.canMessage) ? c.canMessage : []).filter(isRole).filter((r) => t.canMessage.includes(r)),
      budgets: {
        maxStepsPerTask: clampInt(b.maxStepsPerTask, t.budgets.maxStepsPerTask, 1, 20),
        maxToolCallsPerTask: clampInt(b.maxToolCallsPerTask, t.budgets.maxToolCallsPerTask, 0, 50),
        maxTokensPerTask: clampInt(b.maxTokensPerTask, t.budgets.maxTokensPerTask, 2_000, 400_000),
      },
      tools,
    };
  }

  async enabledRoles(organizationId: string): Promise<Role[]> {
    await this.ensureOffice(organizationId);
    const rows = await this.prisma.officeAgent.findMany({ where: { organizationId, enabled: true, paused: false }, select: { role: true } });
    return rows.map((r) => r.role).filter(isRole);
  }

  // ---------------------------------------------------------------------------------------------- agents
  async agents(organizationId: string) {
    await this.ensureOffice(organizationId);
    const rows = await this.prisma.officeAgent.findMany({ where: { organizationId }, include: { department: true }, orderBy: [{ department: { sort: 'asc' } }, { name: 'asc' }] });
    return Promise.all(rows.map(async (a) => {
      const r = await this.runtimeOf(a);
      const t = ROLE_TEMPLATES[r.role];
      return { ...r, status: a.status, currentTaskId: a.currentTaskId, department: a.department ? { key: a.department.key, name: a.department.name } : null, purpose: t.purpose, availableTools: t.tools, templateCanMessage: t.canMessage, updatedAt: a.updatedAt };
    }));
  }

  async versions(organizationId: string, agentId: string) {
    await this.runtimeById(organizationId, agentId);
    return this.prisma.officeAgentConfiguration.findMany({ where: { agentId, organizationId }, include: { tools: true }, orderBy: { version: 'desc' }, take: 50 });
  }

  /** A change writes the next configuration version (never edits one), then activates it. */
  async configure(organizationId: string, agentId: string, body: Record<string, unknown>, actor: string) {
    const cur = await this.runtimeById(organizationId, agentId);
    const t = ROLE_TEMPLATES[cur.role];
    const model = body.model === undefined ? cur.model : String(body.model);
    if (!(OFFICE_MODELS as readonly string[]).includes(model)) throw new BadRequestException(`Model must be one of ${OFFICE_MODELS.join(', ')}`);
    const instructions = body.instructions === undefined ? cur.instructions : body.instructions === null ? null : String(body.instructions).trim().slice(0, 1500) || null;
    const canMessage = body.canMessage === undefined ? cur.canMessage : Array.isArray(body.canMessage) ? body.canMessage.filter(isRole).filter((r) => t.canMessage.includes(r)) : cur.canMessage;
    const b = (body.budgets && typeof body.budgets === 'object' ? body.budgets : {}) as Record<string, unknown>;
    const budgets = {
      maxStepsPerTask: clampInt(b.maxStepsPerTask, cur.budgets.maxStepsPerTask, 1, 20),
      maxToolCallsPerTask: clampInt(b.maxToolCallsPerTask, cur.budgets.maxToolCallsPerTask, 0, 50),
      maxTokensPerTask: clampInt(b.maxTokensPerTask, cur.budgets.maxTokensPerTask, 2_000, 400_000),
    };
    const toolsIn = (body.tools && typeof body.tools === 'object' ? body.tools : cur.tools) as Record<string, unknown>;
    const tools: Record<string, PermissionMode> = {};
    for (const name of t.tools) {
      const m = String(toolsIn[name] ?? cur.tools[name] ?? 'denied');
      const mode: PermissionMode = m === 'auto' || m === 'approval' ? m : 'denied';
      tools[name] = MANDATORY_APPROVAL.includes(name) && mode === 'auto' ? 'approval' : mode;
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : null;
    const version = await this.prisma.$transaction(async (tx) => {
      const last = await tx.officeAgentConfiguration.findFirst({ where: { agentId }, orderBy: { version: 'desc' }, select: { version: true } });
      const v = (last?.version ?? 0) + 1;
      const conf = await tx.officeAgentConfiguration.create({ data: { organizationId, agentId, version: v, model, instructions, canMessage: canMessage as never, budgets: budgets as never, createdBy: actor.slice(0, 191), note } });
      await tx.officeToolPermission.createMany({ data: Object.entries(tools).map(([tool, mode]) => ({ agentConfigId: conf.id, tool, mode })) });
      await tx.officeAgent.update({ where: { id: agentId }, data: { activeVersion: v } });
      return v;
    });
    await this.audit(organizationId, actor, 'agent.configured', `agent:${cur.role}`, { version, model, tools, canMessage, budgets });
    return this.runtimeById(organizationId, agentId);
  }

  /** Roll back = activate an earlier version (history is kept). */
  async activate(organizationId: string, agentId: string, version: number, actor: string) {
    const cur = await this.runtimeById(organizationId, agentId);
    const exists = await this.prisma.officeAgentConfiguration.count({ where: { agentId, version } });
    if (!exists) throw new NotFoundException('No such version');
    await this.prisma.officeAgent.update({ where: { id: agentId }, data: { activeVersion: version } });
    await this.audit(organizationId, actor, 'agent.version_activated', `agent:${cur.role}`, { version });
    return this.runtimeById(organizationId, agentId);
  }

  async setAgentState(organizationId: string, agentId: string, change: { paused?: boolean; enabled?: boolean }, actor: string) {
    const cur = await this.runtimeById(organizationId, agentId);
    if (change.enabled === false && cur.role === 'ceo') throw new BadRequestException('The CEO plans every instruction and cannot be switched off. Pause the whole office instead.');
    const data: Record<string, unknown> = {};
    if (change.paused !== undefined) {
      data.paused = change.paused;
      data.status = change.paused ? 'paused' : 'idle';
      if (!change.paused) data.breaker = 'healthy'; // a person resuming also resets the breaker
    }
    if (change.enabled !== undefined) data.enabled = change.enabled;
    await this.prisma.officeAgent.update({ where: { id: agentId }, data });
    await this.audit(organizationId, actor, change.paused !== undefined ? (change.paused ? 'agent.paused' : 'agent.resumed') : change.enabled ? 'agent.enabled' : 'agent.disabled', `agent:${cur.role}`, change);
    publishLive(organizationId, { type: 'office.agent', status: change.paused ? 'paused' : 'idle', title: `${cur.name} ${change.paused ? 'paused' : change.paused === false ? 'resumed' : change.enabled ? 'switched on' : 'switched off'}` });
    return this.runtimeById(organizationId, agentId);
  }

  audit(organizationId: string, actor: string, action: string, target: string | null, data: Record<string, unknown>) {
    return this.prisma.officeAuditLog.create({ data: { organizationId, actor: actor.slice(0, 191), action, target, data: data as never } }).catch(() => undefined);
  }
}
