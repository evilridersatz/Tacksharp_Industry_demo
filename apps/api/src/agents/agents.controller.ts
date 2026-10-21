import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { config } from '../common/config.js';
import { ApprovalsService } from '../governance/approvals.service.js';
import { adSpendStatus, metaPermissions } from '../marketing/meta-permissions.js';
import { WorkTasksService } from '../governance/work-tasks.service.js';
import { PERMISSIONS, can, requirePermission } from '../governance/permissions.js';
import { Orchestrator } from './orchestrator.service.js';
import type { AgentName } from './agent-types.js';

const who = (u: SessionClaims) => `user:${u.sub}`;
const clientKey = (v: unknown) => {
  if (typeof v !== 'string' || !/^[\w-]{8,64}$/.test(v)) throw new BadRequestException('clientKey (8-64 letters, digits, - or _) is required so a double click never runs a task twice');
  return v;
};

/** Agent Centre API. Organization always from the session; every restricted action checked here, on the server. */
@Controller('agents')
export class AgentsController {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly approvals: ApprovalsService,
    private readonly workTasks: WorkTasksService,
  ) {}

  @Get()
  overview(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.orchestrator.agentsOverview(org);
  }

  @Get('integrations')
  async integrations(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    const meta = adSpendStatus(await metaPermissions());
    const llm = Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL);
    // Configured = credentials present in .env. That is not proof the service works: say so.
    const set = (...v: string[]) => v.every((x) => Boolean(x));
    return [
      { name: 'WhatsApp Cloud API', status: set(config.whatsapp.accessToken, config.whatsapp.phoneNumberId) ? 'configured' : 'not_configured', note: 'Credentials present; live delivery is verified only by real sends.' },
      { name: 'Plivo voice', status: set(config.plivo.authId, config.plivo.authToken, config.plivo.fromNumber) ? 'configured' : 'not_configured', note: 'Outbound / inbound AI calls.' },
      { name: 'Sarvam speech', status: set(config.sarvam.apiKey) ? 'configured' : 'not_configured', note: 'Speech-to-text and text-to-speech for calls.' },
      { name: 'AI model (OpenAI / compatible)', status: llm ? 'configured' : 'not_configured', note: llm ? 'Conversation assistant and Marketing drafts (grounded in approved catalogue facts). Other agent tasks make no model calls.' : 'Not configured: Marketing drafts use templates.' },
      { name: 'Meta Lead Ads', status: set(config.meta.pageAccessToken) ? 'configured' : 'not_configured', note: 'Leads arrive with source / campaign for attribution.' },
      { name: 'Meta Marketing API (ad spend)', status: meta.status, note: meta.note },
      { name: 'Social publishing (Instagram / Facebook)', status: 'not_connected', note: 'Approved posts are published by a person and marked published; nothing is posted automatically.' },
      { name: 'Payment gateway / bank feed', status: 'not_connected', note: 'No provider adapter is configured. Payments are verified manually by a person with the verify-payment permission, with evidence.' },
      { name: 'Accounting (Tally / BUSY / Zoho Books)', status: 'not_connected', note: 'No accounting system is connected.' },
    ];
  }

  @Get('kinds')
  kinds(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.orchestrator.listKinds();
  }

  @Get('tasks')
  tasks(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('agent') agent?: string, @Query('status') status?: string, @Query('entityType') entityType?: string, @Query('entityId') entityId?: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.orchestrator.listTasks(org, { agent, status, entityType, entityId });
  }

  @Get('tasks/:id')
  task(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.orchestrator.getTask(org, id);
  }

  @Post('tasks')
  async submit(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { kind?: string; input?: unknown; clientKey?: string }) {
    requirePermission(u, PERMISSIONS.agentsRun);
    const kind = this.orchestrator.listKinds().find((k) => k.kind === body?.kind);
    if (!kind) throw new BadRequestException('Unknown task');
    if (!kind.userRunnable) throw new ForbiddenException('This task runs only from business events');
    return this.orchestrator.submit(org, { kind: kind.kind, input: body.input, trigger: 'user', idempotencyKey: `user:${clientKey(body.clientKey)}`, requestedBy: who(u) }, { runNow: true });
  }

  @Post('tasks/:id/cancel')
  cancel(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.orchestrator.cancel(org, id, who(u));
  }

  @Post('tasks/:id/retry')
  retry(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.orchestrator.retry(org, id, who(u));
  }

  @Post(':agent/pause')
  pause(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('agent') agent: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.orchestrator.setPaused(org, agent as AgentName, true);
  }

  @Post(':agent/resume')
  resume(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('agent') agent: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.orchestrator.setPaused(org, agent as AgentName, false);
  }

  // approvals
  @Get('approvals/list')
  approvalsList(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('status') status?: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.approvals.list(org, status);
  }

  @Post('approvals/:id/approve')
  async approve(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { note?: string }) {
    const a = await this.approvals.decide(org, id, 'approve', u, body?.note);
    await this.orchestrator.settleRejectedApprovals(org);
    return a;
  }

  @Post('approvals/:id/reject')
  async reject(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { note?: string }) {
    const a = await this.approvals.decide(org, id, 'reject', u, body?.note);
    await this.orchestrator.settleRejectedApprovals(org);
    return a;
  }

  @Post('approvals/:id/cancel')
  async cancelApproval(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    const a = await this.approvals.get(org, id);
    // The requester or a person who could approve it may withdraw a request.
    if (a.requestedBy !== who(u) && !can(u.role, a.requiredPermission)) throw new ForbiddenException('Only the requester or an approver can cancel this request');
    const r = await this.approvals.cancel(org, id, who(u));
    await this.orchestrator.settleRejectedApprovals(org);
    return r;
  }

  // people's work tasks raised by agents
  @Get('work-tasks/list')
  workTaskList(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('agent') agent?: string, @Query('status') status?: string, @Query('entityType') entityType?: string, @Query('entityId') entityId?: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.workTasks.list(org, { agent, status, entityType, entityId });
  }

  @Patch('work-tasks/:id')
  updateWorkTask(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status?: string; assignee?: string | null; resolution?: string; dueAt?: string | null }) {
    requirePermission(u, PERMISSIONS.agentsRun);
    return this.workTasks.update(org, id, body ?? {});
  }
}
