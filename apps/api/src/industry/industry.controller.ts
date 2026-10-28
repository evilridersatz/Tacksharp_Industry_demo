import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { IndustryService } from './industry.service.js';
import { QualityService } from './quality.service.js';
import { ScenarioService } from './scenario.service.js';

/** Multi-industry experience. Organization always from the session; nothing here reads another tenant. */
@Controller('industry')
export class IndustryController {
  constructor(
    private readonly industry: IndustryService,
    private readonly scenarios: ScenarioService,
  ) {}

  @Get('scenarios')
  async scenarioList(@Org() org: string) {
    const ws = await this.industry.workspace(org);
    return { industry: ws.industry, demo: ws.isDemo, scenarios: this.scenarios.list(ws.industry) };
  }

  /** Demo workspaces only (refused otherwise). Drives the real assistants and services with a synthetic customer. */
  @Post('scenarios/run')
  async scenarioRun(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { scenarioId?: string }) {
    requirePermission(u, PERMISSIONS.agentsRun);
    const ws = await this.industry.workspace(org);
    return this.scenarios.run(org, ws.industry, String(body?.scenarioId ?? ''));
  }

  @Get('workspace')
  async workspace(@Org() org: string, @CurrentUser() u?: SessionClaims) {
    // The role is the one the auth guard resolved from the database for this request (not the token's copy).
    return { ...(await this.industry.workspace(org)), role: u?.role ?? null };
  }

  @Get('dashboard')
  dashboard(@Org() org: string, @Query('days') days?: string) {
    return this.industry.dashboard(org, Number(days) || 30);
  }

  @Get('data')
  data(@Org() org: string) {
    return this.industry.data(org);
  }

  @Get('agents')
  agents(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.industry.catalogue(org);
  }

  @Post('playground')
  playground(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { agentId?: string; message?: string; session?: string }) {
    requirePermission(u, PERMISSIONS.agentsRun);
    return this.industry.playground(org, u.sub, body ?? {});
  }
}

/** Manufacturing & quality control records. */
@Controller('quality')
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  @Get('inspections')
  list(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('status') status?: string, @Query('q') q?: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.quality.list(org, { status, q });
  }

  @Post('inspections')
  create(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: Parameters<QualityService['create']>[1]) {
    requirePermission(u, PERMISSIONS.manageOpsTasks);
    return this.quality.create(org, body ?? {}, `user:${u.sub}`);
  }

  @Post('inspections/:id/resolve')
  resolve(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { resolution?: string }) {
    requirePermission(u, PERMISSIONS.manageOpsTasks);
    return this.quality.resolve(org, id, body?.resolution, `user:${u.sub}`);
  }

  @Get('stats')
  stats(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('days') days?: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.quality.stats(org, Number(days) || 30).then(({ rows: _rows, ...rest }) => rest);
  }
}
