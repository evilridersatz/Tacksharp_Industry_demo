import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { JarvisService } from './jarvis.service.js';

/**
 * Jarvis (Assistant → extra features). Organization always from the session. Reading needs the same right as the
 * reports (customers.view); changing Jarvis settings needs agents.manage. Nothing here contacts a customer.
 */
@Controller('jarvis')
export class JarvisController {
  constructor(private readonly jarvis: JarvisService) {}

  @Get('overview')
  overview(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.jarvis.overview(u.org);
  }

  @Get('digests')
  async digests(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.customersView);
    return { items: await this.jarvis.digests(u.org) };
  }

  @Post('digest')
  @HttpCode(200)
  digestNow(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.jarvis.buildDigest(u.org, 'manual');
  }

  @Get('alerts')
  async alerts(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.customersView);
    return { items: await this.jarvis.alerts(u.org) };
  }

  @Post('monitors/run')
  @HttpCode(200)
  runMonitors(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.jarvis.runMonitors(u.org);
  }

  @Post('alerts/:id/resolve')
  @HttpCode(200)
  resolve(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.jarvis.resolveAlert(u.org, String(id).slice(0, 300));
  }

  @Get('settings')
  settings(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.jarvis.config(u.org);
  }

  @Put('settings')
  save(@CurrentUser() u: SessionClaims, @Body() body: unknown) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.jarvis.saveConfig(u.org, body);
  }

  @Post('ask')
  @HttpCode(200)
  ask(@CurrentUser() u: SessionClaims, @Body() body: { question?: unknown }) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.jarvis.ask(u.org, body?.question);
  }

  @Get('usage')
  usage(@CurrentUser() u: SessionClaims, @Query('days') days?: string) {
    requirePermission(u, PERMISSIONS.integrationsView);
    const d = [1, 7, 30].includes(Number(days)) ? Number(days) : 7;
    return this.jarvis.usage(u.org, d);
  }

  @Get('checks')
  checks(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.jarvis.checks(u.org);
  }
}
