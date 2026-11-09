import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { ApprovalsService } from '../governance/approvals.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OfficeEngine } from './engine/office-engine.service.js';
import { OfficeSetupService } from './office-setup.service.js';
import { OfficeInsightsService } from './office-insights.service.js';
import { OfficeWorkflowsService } from './workflows/office-workflows.service.js';
import { OFFICE_APPROVAL_ACTION } from './tools/registry.js';
import { ROLE_TEMPLATES } from './agents/roles.js';

const who = (u: SessionClaims) => `user:${u.sub}`;
const id = (v: string) => String(v ?? '').slice(0, 191);

/**
 * AI Office API. The organization always comes from the session (never from the request), and every route checks a
 * permission on the server: office.view (read), office.run (instruct, start, retry), office.manage (settings, agents,
 * workflows, memory), office.approve (decide on agents' sensitive actions).
 */
@Controller('office')
export class OfficeController {
  constructor(
    private readonly engine: OfficeEngine,
    private readonly setup: OfficeSetupService,
    private readonly insights: OfficeInsightsService,
    private readonly workflows: OfficeWorkflowsService,
    private readonly approvals: ApprovalsService,
    private readonly prisma: PrismaService,
  ) {}

  // ------------------------------------------------------------------------------------------- overview
  @Get('floor')
  floor(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.officeView);
    return this.insights.floor(u.org);
  }

  @Get('settings')
  settings(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.officeView);
    return this.setup.config(u.org);
  }

  @Put('settings')
  saveSettings(@CurrentUser() u: SessionClaims, @Body() body: unknown) {
    requirePermission(u, PERMISSIONS.officeManage);
    return this.setup.saveConfig(u.org, body, who(u));
  }

  // ------------------------------------------------------------------------------------------- plans
  @Post('plans')
  @HttpCode(200)
  plan(@CurrentUser() u: SessionClaims, @Body() body: { instruction?: unknown; idempotencyKey?: unknown; mode?: unknown }) {
    requirePermission(u, PERMISSIONS.officeRun);
    return this.engine.createPlan(u.org, who(u), { instruction: body?.instruction, idempotencyKey: body?.idempotencyKey, mode: typeof body?.mode === 'string' ? body.mode : undefined });
  }

  @Get('plans')
  async plans(@CurrentUser() u: SessionClaims, @Query('status') status?: string) {
    requirePermission(u, PERMISSIONS.officeView);
    return { items: await this.engine.plans(u.org, { status: status?.slice(0, 20) }) };
  }

  @Get('plans/:id')
  planView(@CurrentUser() u: SessionClaims, @Param('id') planId: string) {
    requirePermission(u, PERMISSIONS.officeView);
    return this.engine.planView(u.org, id(planId));
  }

  @Post('plans/:id/run')
  @HttpCode(200)
  run(@CurrentUser() u: SessionClaims, @Param('id') planId: string) {
    requirePermission(u, PERMISSIONS.officeRun);
    return this.engine.startPlan(u.org, id(planId), who(u));
  }

  @Post('plans/:id/:action')
  @HttpCode(200)
  planAction(@CurrentUser() u: SessionClaims, @Param('id') planId: string, @Param('action') action: string) {
    requirePermission(u, PERMISSIONS.officeRun);
    if (action === 'cancel') return this.engine.cancelPlan(u.org, id(planId), who(u));
    if (action === 'pause') return this.engine.pausePlan(u.org, id(planId), who(u));
    if (action === 'resume') return this.engine.resumePlan(u.org, id(planId), who(u));
    throw new BadRequestException('Action must be run, cancel, pause or resume');
  }

  // ------------------------------------------------------------------------------------------- tasks
  @Get('tasks')
  async tasks(@CurrentUser() u: SessionClaims, @Query('status') status?: string, @Query('role') role?: string, @Query('planId') planId?: string) {
    requirePermission(u, PERMISSIONS.officeView);
    return { items: await this.engine.tasks(u.org, { status: status?.slice(0, 20), role: role?.slice(0, 30), planId: planId ? id(planId) : undefined }) };
  }

  @Get('tasks/:id')
  task(@CurrentUser() u: SessionClaims, @Param('id') taskId: string) {
    requirePermission(u, PERMISSIONS.officeView);
    return this.engine.taskView(u.org, id(taskId));
  }

  @Post('tasks/:id/:decision')
  @HttpCode(200)
  review(@CurrentUser() u: SessionClaims, @Param('id') taskId: string, @Param('decision') decision: string, @Body() body: { note?: unknown }) {
    requirePermission(u, PERMISSIONS.officeRun);
    if (!['accept', 'retry', 'cancel'].includes(decision)) throw new BadRequestException('Decision must be accept, retry or cancel');
    return this.engine.review(u.org, id(taskId), decision as 'accept' | 'retry' | 'cancel', who(u), typeof body?.note === 'string' ? body.note : undefined);
  }

  // ------------------------------------------------------------------------------------------- approvals
  @Get('approvals')
  async approvalsList(@CurrentUser() u: SessionClaims, @Query('status') status?: string) {
    requirePermission(u, PERMISSIONS.officeView);
    const rows = (await this.approvals.list(u.org, status?.slice(0, 20) || undefined)).filter((a) => a.action === OFFICE_APPROVAL_ACTION);
    const taskIds = [...new Set(rows.map((a) => a.entityId))];
    const tasks = taskIds.length ? await this.engine.tasks(u.org, {}).then((all) => new Map(all.filter((t) => taskIds.includes(t.id)).map((t) => [t.id, t]))) : new Map();
    // Who a proposed message goes to (first name and the last digits only), so the approver knows what they approve.
    const customerIds = [...new Set(rows.map((a) => String(((a.payload ?? {}) as { args?: { customerId?: string } }).args?.customerId ?? '')).filter(Boolean))];
    const customers = customerIds.length ? await this.prisma.customer.findMany({ where: { organizationId: u.org, id: { in: customerIds } }, select: { id: true, name: true, phone: true } }) : [];
    const cust = new Map(customers.map((c) => [c.id, { name: (c.name ?? 'Customer').split(/\s+/)[0], phone: c.phone ? `••••${c.phone.slice(-4)}` : null }]));
    return {
      items: rows.map((a) => {
        const t = tasks.get(a.entityId);
        const cid = String(((a.payload ?? {}) as { args?: { customerId?: string } }).args?.customerId ?? '');
        return { ...a, task: t ? { id: a.entityId, title: t.title, role: t.role, planId: t.planId } : null, customer: cust.get(cid) ?? null };
      }),
    };
  }

  @Post('approvals/:id/:decision')
  @HttpCode(200)
  async decide(@CurrentUser() u: SessionClaims, @Param('id') approvalId: string, @Param('decision') decision: string, @Body() body: { note?: string }) {
    requirePermission(u, PERMISSIONS.officeApprove);
    if (decision !== 'approve' && decision !== 'reject') throw new BadRequestException('Decision must be approve or reject');
    const a = await this.approvals.get(u.org, id(approvalId));
    if (a.action !== OFFICE_APPROVAL_ACTION) throw new BadRequestException('This is not an AI Office approval');
    const decided = await this.approvals.decide(u.org, a.id, decision, u, body?.note);
    await this.engine.afterDecision(u.org, a.id);
    return decided;
  }

  // ------------------------------------------------------------------------------------------- agents
  @Get('agents')
  async agents(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.officeView);
    return { items: await this.setup.agents(u.org), templates: Object.values(ROLE_TEMPLATES).map((t) => ({ role: t.role, name: t.name, purpose: t.purpose, tools: t.tools, canMessage: t.canMessage })) };
  }

  @Get('agents/:id/versions')
  async versions(@CurrentUser() u: SessionClaims, @Param('id') agentId: string) {
    requirePermission(u, PERMISSIONS.officeView);
    return { items: await this.setup.versions(u.org, id(agentId)) };
  }

  @Put('agents/:id')
  configure(@CurrentUser() u: SessionClaims, @Param('id') agentId: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.officeManage);
    return this.setup.configure(u.org, id(agentId), body ?? {}, who(u));
  }

  @Post('agents/:id/:action')
  @HttpCode(200)
  agentAction(@CurrentUser() u: SessionClaims, @Param('id') agentId: string, @Param('action') action: string, @Body() body: { version?: unknown }) {
    requirePermission(u, PERMISSIONS.officeManage);
    if (action === 'pause') return this.setup.setAgentState(u.org, id(agentId), { paused: true }, who(u));
    if (action === 'resume') return this.setup.setAgentState(u.org, id(agentId), { paused: false }, who(u));
    if (action === 'enable') return this.setup.setAgentState(u.org, id(agentId), { enabled: true }, who(u));
    if (action === 'disable') return this.setup.setAgentState(u.org, id(agentId), { enabled: false }, who(u));
    if (action === 'activate') return this.setup.activate(u.org, id(agentId), Math.round(Number(body?.version)), who(u));
    throw new BadRequestException('Action must be pause, resume, enable, disable or activate');
  }

  // ------------------------------------------------------------------------------------------- workflows
  @Get('workflows')
  async workflowList(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.officeView);
    return { items: await this.workflows.list(u.org), ...this.workflows.catalog() };
  }

  @Post('workflows')
  createWorkflow(@CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.officeManage);
    return this.workflows.create(u.org, body ?? {}, who(u));
  }

  @Put('workflows/:id')
  updateWorkflow(@CurrentUser() u: SessionClaims, @Param('id') wfId: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.officeManage);
    return this.workflows.update(u.org, id(wfId), body ?? {}, who(u));
  }

  @Delete('workflows/:id')
  deleteWorkflow(@CurrentUser() u: SessionClaims, @Param('id') wfId: string) {
    requirePermission(u, PERMISSIONS.officeManage);
    return this.workflows.remove(u.org, id(wfId), who(u));
  }

  @Post('workflows/:id/run')
  @HttpCode(200)
  async runWorkflow(@CurrentUser() u: SessionClaims, @Param('id') wfId: string) {
    requirePermission(u, PERMISSIONS.officeRun);
    const plan = await this.workflows.runNow(u.org, id(wfId), who(u));
    if (!plan) throw new BadRequestException('This workflow already ran this minute, or the run failed (see its history).');
    return plan;
  }

  // ------------------------------------------------------------------------------------------- memory
  @Get('memory')
  async memory(@CurrentUser() u: SessionClaims, @Query('status') status?: string) {
    requirePermission(u, PERMISSIONS.officeView);
    return { items: await this.insights.memories(u.org, ['proposed', 'verified', 'rejected'].includes(String(status)) ? status : undefined) };
  }

  @Post('memory')
  addMemory(@CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.officeManage);
    return this.insights.addMemory(u.org, body ?? {}, who(u));
  }

  @Put('memory/:id')
  updateMemory(@CurrentUser() u: SessionClaims, @Param('id') memId: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.officeManage);
    return this.insights.updateMemory(u.org, id(memId), body ?? {}, who(u));
  }

  @Delete('memory/:id')
  deleteMemory(@CurrentUser() u: SessionClaims, @Param('id') memId: string) {
    requirePermission(u, PERMISSIONS.officeManage);
    return this.insights.deleteMemory(u.org, id(memId), who(u));
  }

  // ------------------------------------------------------------------------------------------- usage & audit
  @Get('usage')
  usage(@CurrentUser() u: SessionClaims, @Query('days') days?: string) {
    requirePermission(u, PERMISSIONS.officeView);
    const d = [1, 7, 30].includes(Number(days)) ? Number(days) : 7;
    return this.insights.usage(u.org, d);
  }

  @Get('audit')
  async audit(@CurrentUser() u: SessionClaims, @Query('target') target?: string) {
    requirePermission(u, PERMISSIONS.officeView);
    return { items: await this.insights.audit(u.org, { target: target?.slice(0, 191) }) };
  }
}
