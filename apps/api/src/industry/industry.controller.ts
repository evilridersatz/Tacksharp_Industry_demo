import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { IndustryService } from './industry.service.js';
import { QualityService } from './quality.service.js';

/** Multi-industry experience. Organization always from the session; nothing here reads another tenant. */
@Controller('industry')
export class IndustryController {
  constructor(private readonly industry: IndustryService) {}

  @Get('workspace')
  workspace(@Org() org: string) {
    return this.industry.workspace(org);
  }

  @Get('dashboard')
  dashboard(@Org() org: string, @Query('days') days?: string) {
    return this.industry.dashboard(org, Number(days) || 30);
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
