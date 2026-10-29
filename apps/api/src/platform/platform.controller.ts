import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PlatformService } from './platform.service.js';

/**
 * Tacksharp platform administration. Every handler re-checks User.isPlatformAdmin in the database first: the flag
 * cannot be granted through signup or by an organization admin (only `npm run platform:admin` on the server).
 * Documented in INTEGRATIONS.md → Platform API.
 */
@Controller('platform')
export class PlatformController {
  constructor(private readonly svc: PlatformService) {}

  private async admin(u: SessionClaims) {
    await this.svc.requireAdmin(u.sub);
    return { sub: u.sub };
  }

  @Get('overview')
  async overview(@CurrentUser() u: SessionClaims) {
    await this.admin(u);
    return this.svc.overview();
  }

  @Get('health')
  async health(@CurrentUser() u: SessionClaims) {
    await this.admin(u);
    return this.svc.health();
  }

  @Get('organizations')
  async organizations(@CurrentUser() u: SessionClaims, @Query() q: { search?: string; status?: string; page?: string }) {
    await this.admin(u);
    return this.svc.organizations(q);
  }

  @Get('organizations/:id')
  async organization(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    await this.admin(u);
    return this.svc.organization(id);
  }

  @Post('organizations/:id/activate')
  @HttpCode(200)
  async activate(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { confirmName?: unknown }) {
    return this.svc.activate(await this.admin(u), id, body ?? {});
  }

  @Post('organizations/:id/suspend')
  @HttpCode(200)
  async suspend(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { confirmName?: unknown; reason?: unknown }) {
    return this.svc.suspend(await this.admin(u), id, body ?? {});
  }

  @Put('organizations/:id/industries')
  async industries(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { allowed?: unknown }) {
    return this.svc.setIndustries(await this.admin(u), id, body ?? {});
  }

  @Post('organizations/:id/users/:userId/disable')
  @HttpCode(200)
  async disableUser(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Param('userId') userId: string, @Body() body: { disabled?: unknown }) {
    if (typeof body?.disabled !== 'boolean') throw new BadRequestException('disabled must be true or false.');
    return this.svc.setUserDisabled(await this.admin(u), id, userId, body.disabled);
  }

  @Post('organizations/:id/users/:userId/reset-link')
  @HttpCode(200)
  async resetLink(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Param('userId') userId: string) {
    return this.svc.resetLink(await this.admin(u), id, userId);
  }

  @Post('organizations/:id/invitations')
  @HttpCode(200)
  async invite(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { email?: unknown; role?: unknown }) {
    return this.svc.invite(await this.admin(u), id, body ?? {});
  }

  @Get('audit')
  async audit(@CurrentUser() u: SessionClaims, @Query() q: { organizationId?: string; action?: string; page?: string }) {
    await this.admin(u);
    return this.svc.auditEvents(q);
  }

  @Get('usage')
  async usage(@CurrentUser() u: SessionClaims) {
    await this.admin(u);
    return this.svc.usage();
  }

  @Get('failures')
  async failures(@CurrentUser() u: SessionClaims) {
    await this.admin(u);
    return this.svc.failures();
  }
}
