import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { DemoSessionsService } from './demo-sessions.service.js';

/** Shared-number live demos of the logged-in workspace (organization from the session, never from the request). */
@Controller('demo-sessions')
export class DemoSessionsController {
  constructor(private readonly svc: DemoSessionsService) {}

  @Get()
  list(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.svc.list(org);
  }

  /** Integration status; ?probe=1 runs read-only provider checks (no message sent, no call placed). */
  @Get('status')
  status(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('probe') probe?: string) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.svc.status(org, probe === '1' || probe === 'true');
  }

  @Post()
  start(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.customersContact);
    return this.svc.start(org, u, body ?? {});
  }

  @Post(':id/end')
  end(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.customersContact);
    return this.svc.end(org, u, id);
  }
}
