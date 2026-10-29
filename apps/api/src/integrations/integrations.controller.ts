import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser, Public } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';
import { checkPlivoSignature } from '../voice/plivo-signature.js';
import { IntegrationsService } from './integrations.service.js';

/**
 * Settings → Integrations / AI Providers. Organization from the session only; secrets are accepted on save and never
 * returned. Documented in INTEGRATIONS.md.
 */
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  @Get()
  list(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.integrationsView);
    return this.svc.list(u.org);
  }

  // ---- Plivo number routing (specific routes before /:provider)
  @Post('plivo/numbers')
  @HttpCode(200)
  mapNumber(@CurrentUser() u: SessionClaims, @Body() body: { number?: unknown }) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.svc.mapPlivoNumber(u, body?.number);
  }

  @Delete('plivo/numbers/:number')
  unmapNumber(@CurrentUser() u: SessionClaims, @Param('number') number: string) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.svc.unmapPlivoNumber(u, number);
  }

  @Post('whatsapp/route')
  @HttpCode(200)
  routeWhatsapp(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.svc.mapWhatsappNumber(u);
  }

  // ---- Plivo test-call callbacks (public; Plivo signature checked with THIS organization's saved token)
  @Public()
  @Post('plivo/test-call/answer')
  async testCallAnswer(@Query('org') org: string, @Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    await this.verifyPlivo(org, req, raw ?? {});
    res.status(200).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Speak voice="WOMAN" language="en-IN">This is a test call from Tacksharp. Your Plivo connection is working. Goodbye.</Speak><Hangup/></Response>');
  }

  @Public()
  @Post('plivo/test-call/hangup')
  @HttpCode(200)
  async testCallHangup(@Query('org') org: string, @Query('ev') ev: string, @Req() req: Request, @Body() raw: Record<string, string> | undefined) {
    await this.verifyPlivo(org, req, raw ?? {});
    await this.svc.recordTestCallHangup(org, String(ev ?? ''), raw ?? {});
    return { ok: true };
  }

  private async verifyPlivo(org: string, req: Request, body: Record<string, string>) {
    const token = org ? await this.svc.plivoTokenOf(String(org)) : null;
    // Always enforced for these callbacks, whatever PLIVO_VALIDATE_SIGNATURE says.
    const check = checkPlivoSignature(req, body, { enabled: true, authToken: token ?? '', publicBaseUrl: config.publicBaseUrl });
    if (!check.ok) {
      log.warn('integrations.test_call_signature_invalid', { reason: check.reason });
      throw new ForbiddenException('Invalid Plivo signature');
    }
  }

  // ---- per provider
  @Get(':provider')
  get(@CurrentUser() u: SessionClaims, @Param('provider') provider: string) {
    requirePermission(u, PERMISSIONS.integrationsView);
    return this.svc.get(u.org, provider);
  }

  @Get(':provider/usage')
  async usage(@CurrentUser() u: SessionClaims, @Param('provider') provider: string) {
    requirePermission(u, PERMISSIONS.integrationsView);
    return (await this.svc.get(u.org, provider)).usage;
  }

  @Put(':provider')
  save(@CurrentUser() u: SessionClaims, @Param('provider') provider: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Send the fields as a JSON object.');
    return this.svc.save(u, provider, body);
  }

  @Post(':provider/test/:op')
  @HttpCode(200)
  test(@CurrentUser() u: SessionClaims, @Param('provider') provider: string, @Param('op') op: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.svc.test(u, provider, op, body ?? {});
  }

  @Post(':provider/enable')
  @HttpCode(200)
  enable(@CurrentUser() u: SessionClaims, @Param('provider') provider: string, @Body() body: { enabled?: unknown }) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false.');
    return this.svc.setEnabled(u, provider, body.enabled);
  }

  @Delete(':provider')
  remove(@CurrentUser() u: SessionClaims, @Param('provider') provider: string, @Query('confirm') confirm?: string) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    if (confirm !== 'yes') throw new BadRequestException('Add ?confirm=yes: deleting removes the saved credentials for this organization.');
    return this.svc.remove(u, provider);
  }
}
