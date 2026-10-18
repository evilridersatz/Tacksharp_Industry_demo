import { BadRequestException, Body, Controller, ForbiddenException, Get, Optional, Put } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { SettingsService } from './settings.service.js';
import { DEFAULT_SETTINGS } from './tenant-settings.js';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  @Get()
  async get(@Org() organizationId: string) {
    return { settings: await this.settings.get(organizationId), defaults: DEFAULT_SETTINGS };
  }

  /** Only admins change automation; the organization always comes from the session, never the body. */
  @Put()
  async update(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: unknown) {
    if (user.role !== 'admin') throw new ForbiddenException('Only an admin can change settings.');
    const requested = (body as { industry?: unknown } | null)?.industry;
    const before = await this.settings.get(organizationId);
    if (this.prisma && requested !== undefined && requested !== before.industry) {
      // A restaurant (GR Chicken) runs the ordering engine: its industry is fixed by the organization, never by a click.
      const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { vertical: true } });
      if (org?.vertical === 'restaurant') throw new BadRequestException('This is a restaurant workspace: its industry is fixed. Use the workspace switcher to open another industry.');
    }
    const settings = await this.settings.update(organizationId, body);
    if (this.prisma && settings.industry !== before.industry) {
      await this.prisma.auditEvent.create({ data: { organizationId, actor: `user:${user.sub}`, entityType: 'organization', entityId: organizationId, action: 'industry_changed', data: { from: before.industry, to: settings.industry } } });
    }
    return { settings };
  }
}
