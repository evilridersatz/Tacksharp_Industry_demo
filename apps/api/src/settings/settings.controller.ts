import { Body, Controller, ForbiddenException, Get, Put } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { SettingsService } from './settings.service.js';
import { DEFAULT_SETTINGS } from './tenant-settings.js';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async get(@Org() organizationId: string) {
    return { settings: await this.settings.get(organizationId), defaults: DEFAULT_SETTINGS };
  }

  /** Only admins change automation; the organization always comes from the session, never the body. */
  @Put()
  async update(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: unknown) {
    if (user.role !== 'admin') throw new ForbiddenException('Only an admin can change settings.');
    return { settings: await this.settings.update(organizationId, body) };
  }
}
