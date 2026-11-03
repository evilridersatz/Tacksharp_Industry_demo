import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { BillingService } from './billing.service.js';

/** The organization's own plan, usage and invoices (read-only). Organization from the session. */
@Controller('billing')
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  @Get()
  summary(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.integrationsView);
    return this.svc.summary(u.org);
  }
}

/** Tacksharp staff only (User.isPlatformAdmin re-checked in the database on every call). */
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(private readonly svc: BillingService) {}

  private async admin(u: SessionClaims) {
    await this.svc.requireAdmin(u.sub);
    return { sub: u.sub };
  }

  @Get()
  async overview(@CurrentUser() u: SessionClaims) {
    await this.admin(u);
    return this.svc.overview();
  }

  @Get('organizations/:orgId')
  async organization(@CurrentUser() u: SessionClaims, @Param('orgId') orgId: string) {
    await this.admin(u);
    return this.svc.organizationBilling(orgId);
  }

  @Put('organizations/:orgId/subscription')
  async setSubscription(@CurrentUser() u: SessionClaims, @Param('orgId') orgId: string, @Body() body: Record<string, unknown>) {
    return this.svc.setSubscription(await this.admin(u), orgId, body ?? {});
  }

  @Post('organizations/:orgId/renew')
  @HttpCode(200)
  async renew(@CurrentUser() u: SessionClaims, @Param('orgId') orgId: string) {
    return this.svc.renew(await this.admin(u), orgId);
  }

  @Post('organizations/:orgId/invoices')
  async issue(@CurrentUser() u: SessionClaims, @Param('orgId') orgId: string) {
    return this.svc.issueInvoice(await this.admin(u), orgId);
  }

  @Post('invoices/:id/paid')
  @HttpCode(200)
  async paid(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { reference?: unknown; paidAt?: unknown }) {
    return this.svc.markPaid(await this.admin(u), id, body ?? {});
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  async void(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    return this.svc.voidInvoice(await this.admin(u), id, body ?? {});
  }

  @Post('contracts')
  async contract(@CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    return this.svc.createContract(await this.admin(u), body ?? {});
  }
}
