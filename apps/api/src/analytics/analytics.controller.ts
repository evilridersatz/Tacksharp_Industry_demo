import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { AnalyticsService } from './analytics.service.js';

/** Advanced analytics (read-only). Organization from the session; anyone who can view customers can read it. */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get('advanced')
  advanced(@CurrentUser() u: SessionClaims, @Query('days') days?: string) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.svc.advanced(u.org, days);
  }

  @Get('advanced/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async export(@CurrentUser() u: SessionClaims, @Query('days') days: string | undefined, @Res({ passthrough: true }) res: Response) {
    requirePermission(u, PERMISSIONS.customersView);
    const r = await this.svc.csv(u.org, days);
    res.setHeader('Content-Disposition', `attachment; filename="tacksharp-analytics-${r.days}d.csv"`);
    return r.csv;
  }
}
