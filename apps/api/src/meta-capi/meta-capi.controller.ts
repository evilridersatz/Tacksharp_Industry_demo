import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { MetaCapiService } from './meta-capi.service.js';

/** Meta Conversions API event log (settings → integrations → Meta Conversions API). Organization from the session. */
@Controller('meta-capi')
export class MetaCapiController {
  constructor(private readonly svc: MetaCapiService) {}

  @Get('events')
  events(@CurrentUser() u: SessionClaims, @Query('status') status?: string) {
    requirePermission(u, PERMISSIONS.integrationsView);
    return this.svc.list(u.org, status);
  }

  @Post('events/:id/retry')
  @HttpCode(200)
  retry(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.svc.retry(u.org, id);
  }
}
