import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { WorkflowsService } from './workflows.service.js';

/** Visual Workflow Studio. Organization from the session; marketing.view to read, marketing.manage to change / test. */
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly svc: WorkflowsService) {}

  private actor(u: SessionClaims) {
    return { sub: u.sub, org: u.org };
  }

  @Get()
  list(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.marketingView);
    return this.svc.list(u.org);
  }

  @Get(':id')
  detail(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.marketingView);
    return this.svc.detail(u.org, id);
  }

  @Post()
  create(@CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.marketingManage);
    return this.svc.create(this.actor(u), body ?? {});
  }

  @Patch(':id')
  update(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.marketingManage);
    return this.svc.update(this.actor(u), id, body ?? {});
  }

  @Post(':id/activate')
  @HttpCode(200)
  activate(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.marketingManage);
    return this.svc.setStatus(this.actor(u), id, 'active');
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.marketingManage);
    return this.svc.setStatus(this.actor(u), id, 'paused');
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.marketingManage);
    return this.svc.testRun(this.actor(u), id, body ?? {});
  }

  @Post('runs/:runId/stop')
  @HttpCode(200)
  stop(@CurrentUser() u: SessionClaims, @Param('runId') runId: string) {
    requirePermission(u, PERMISSIONS.marketingManage);
    return this.svc.stopRun(this.actor(u), runId);
  }
}
