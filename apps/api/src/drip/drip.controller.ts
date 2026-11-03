import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { DripService } from './drip.service.js';

/** Drip automation. Organization from the session only; marketing.view to read, marketing.manage to change. */
@Controller('drips')
export class DripController {
  constructor(private readonly svc: DripService) {}

  private actor(u: SessionClaims) {
    return { sub: u.sub, org: u.org };
  }

  @Get()
  list(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.marketingView);
    return this.svc.list(u.org);
  }

  @Get('preset')
  preset(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.marketingView);
    return this.svc.presets(u.org);
  }

  @Get('customer/:customerId')
  forCustomer(@CurrentUser() u: SessionClaims, @Param('customerId') customerId: string) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.svc.forCustomer(u.org, customerId);
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

  @Post(':id/enroll')
  @HttpCode(200)
  enroll(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.marketingManage);
    return this.svc.enroll(this.actor(u), id, body ?? {});
  }

  @Post('enrollments/:id/stop')
  @HttpCode(200)
  stop(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.marketingManage);
    return this.svc.stopEnrollment(this.actor(u), id);
  }
}
