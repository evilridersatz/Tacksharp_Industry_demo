import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, Org, Public } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, can, requirePermission } from '../governance/permissions.js';
import { latencyStats } from '../common/latency.js';
import { TelephonyService, type PlaceCallBody } from './telephony.service.js';

@Controller('telephony')
export class TelephonyController {
  constructor(private readonly svc: TelephonyService) {}

  /** Providers, verified capabilities, the organization's default and Sarvam inbound webhook URLs. */
  @Get()
  overview(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    // Webhook URLs carry a secret token: only people who manage agents see them.
    return this.svc.overview(org, can(u.role, PERMISSIONS.agentsManage));
  }

  @Put('settings')
  setProvider(@CurrentUser() u: SessionClaims, @Body() body: { provider?: unknown }) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.svc.setDefaultProvider({ sub: u.sub, org: u.org }, body?.provider);
  }

  /** Launch checklist for one agent (plain English, from real configuration). */
  @Get('agents/:id/readiness')
  readiness(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.svc.agentReadiness(org, id);
  }

  /** Place one outbound call with a custom agent (every gate in TelephonyService.placeCall). */
  @Post('calls')
  @HttpCode(200)
  place(@CurrentUser() u: SessionClaims, @Body() body: PlaceCallBody) {
    requirePermission(u, PERMISSIONS.customersContact);
    return this.svc.placeCall({ sub: u.sub, org: u.org }, body ?? {});
  }

  @Get('calls')
  list(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.svc.list(org);
  }

  @Get('calls/:id')
  status(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.svc.status(org, id);
  }

  /** Per-stage latency of our engine's call turns (P50 / P95), measured, not estimated. */
  @Get('latency')
  latency(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return { ourEngine: latencyStats(), sarvam: 'Hosted by Sarvam: per-turn stages are not observable from our server. Outbound request acceptance time is recorded per call (Integrations → usage).' };
  }

  /** Sarvam post-call webhook (outbound attempts and inbound interactions). Token-verified; duplicates ignored. */
  @Public()
  @Post('sarvam/webhook')
  @HttpCode(200)
  async sarvamWebhook(@Query() query: Record<string, unknown>, @Req() req: Request, @Body() body: unknown) {
    const r = await this.svc.sarvam.handleWebhook({ query, body, headers: req.headers as Record<string, unknown> });
    if (r.reason === 'invalid_token') throw new ForbiddenException('Invalid webhook token');
    return { ok: r.accepted, duplicate: r.duplicate ?? false };
  }
}
