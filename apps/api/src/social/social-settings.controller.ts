import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { SocialAiService } from './social-ai.service.js';

/** Which agent answers Instagram / Messenger (none = the team answers). */
@Controller('social/ai')
export class SocialSettingsController {
  constructor(private readonly ai: SocialAiService) {}

  @Get()
  get(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.integrationsView);
    return this.ai.settings(u.org);
  }

  @Put()
  set(@CurrentUser() u: SessionClaims, @Body() body: { agentId?: unknown }) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.ai.setAgent({ sub: u.sub, org: u.org }, body?.agentId ?? null);
  }
}
