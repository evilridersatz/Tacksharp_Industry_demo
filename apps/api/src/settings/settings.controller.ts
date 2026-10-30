import { BadRequestException, Body, Controller, ForbiddenException, Get, Optional, Patch, Put } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { SettingsService } from './settings.service.js';
import { DEFAULT_SETTINGS } from './tenant-settings.js';
import { TenancyService } from '../tenancy/tenancy.service.js';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly tenancy?: TenancyService,
  ) {}

  /** Business profile shown on Home and in setup (name, business phone). Read by any member. */
  @Get('profile')
  async profile(@Org() organizationId: string) {
    const org = await this.prisma!.organization.findUnique({ where: { id: organizationId }, select: { name: true, contactPhone: true, status: true, isDemo: true } });
    return org;
  }

  /** Admins update the business name and phone. Validated; audited (field names only). */
  @Patch('profile')
  async updateProfile(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: { name?: unknown; contactPhone?: unknown }) {
    if (user.role !== 'admin') throw new ForbiddenException('Only an admin can change the business profile.');
    const data: { name?: string; contactPhone?: string | null } = {};
    const fields: Record<string, string> = {};
    if (body?.name !== undefined) {
      const n = typeof body.name === 'string' ? body.name.trim() : '';
      if (n.length < 2 || n.length > 120) fields.name = 'Between 2 and 120 characters.'; else data.name = n;
    }
    if (body?.contactPhone !== undefined) {
      const p = typeof body.contactPhone === 'string' ? body.contactPhone.replace(/[\s()+-]/g, '') : '';
      if (p && !/^\d{8,15}$/.test(p)) fields.contactPhone = 'Digits with country code, 8 to 15 long.'; else data.contactPhone = p || null;
    }
    if (Object.keys(fields).length) throw new BadRequestException({ statusCode: 400, message: 'Please correct the highlighted fields.', fields });
    const org = await this.prisma!.organization.update({ where: { id: organizationId }, data, select: { name: true, contactPhone: true, status: true, isDemo: true } });
    await this.prisma!.auditEvent.create({ data: { organizationId, actor: `user:${user.sub}`, entityType: 'organization', entityId: organizationId, action: 'profile.updated', data: { fields: Object.keys(data) } } });
    return org;
  }

  @Get()
  async get(@Org() organizationId: string) {
    return { settings: await this.settings.get(organizationId), defaults: DEFAULT_SETTINGS };
  }

  /** Only admins change automation; the organization always comes from the session, never the body. */
  @Put()
  async update(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: unknown) {
    if (user.role !== 'admin') throw new ForbiddenException('Only an admin can change settings.');
    const requested = (body as { industry?: unknown } | null)?.industry;
    if (requested === 'chicken_shop') return this.becomeChickenShop(organizationId, user);
    const before = await this.settings.get(organizationId);
    if (this.prisma && requested !== undefined && requested !== before.industry) {
      // A restaurant (GR Chicken) runs the ordering engine: its industry is fixed by the organization, never by a click.
      const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { vertical: true, allowedIndustries: true } });
      if (org?.vertical === 'restaurant') throw new BadRequestException('This is a restaurant workspace: its industry is fixed. Use the workspace switcher to open another industry.');
      // Industries a platform admin assigned to this organization (null = any).
      const allowed = Array.isArray(org?.allowedIndustries) ? (org!.allowedIndustries as unknown[]).map(String) : null;
      if (allowed && !allowed.includes(String(requested))) throw new ForbiddenException(`Your plan includes: ${allowed.join(', ')}. Ask Tacksharp to enable another industry.`);
    }
    // The live demo feed is switched only by POST /monitoring/live-demo (demo workspaces); a settings save never changes it.
    const mon = (body as { monitoring?: Record<string, unknown> } | null)?.monitoring;
    if (mon && typeof mon === 'object') delete mon.liveDemo;
    if (body && typeof body === 'object') delete (body as Record<string, unknown>).demoLive;
    const settings = await this.settings.update(organizationId, body);
    if (this.prisma && settings.industry !== before.industry) {
      await this.prisma.auditEvent.create({ data: { organizationId, actor: `user:${user.sub}`, entityType: 'organization', entityId: organizationId, action: 'industry_changed', data: { from: before.industry, to: settings.industry } } });
    }
    return { settings };
  }

  /**
   * "GR Chicken / Chicken Shop" for a NEW self-service workspace: switches it to the restaurant ordering engine. Not
   * for demo workspaces, pre-existing organizations or a workspace that already has customers, leads or orders (its
   * conversations would change engine mid-way); those ask Tacksharp. Recorded in the audit log.
   */
  private async becomeChickenShop(organizationId: string, user: SessionClaims) {
    if (!this.prisma) throw new BadRequestException('Not available.');
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { vertical: true, selfServe: true, isDemo: true, allowedIndustries: true } });
    if (!org) throw new BadRequestException('Organization not found.');
    if (org.vertical === 'restaurant') return { settings: await this.settings.get(organizationId) };
    if (org.isDemo || !org.selfServe) throw new BadRequestException('Ask Tacksharp to set this workspace up as a chicken shop.');
    const allowed = Array.isArray(org.allowedIndustries) ? (org.allowedIndustries as unknown[]).map(String) : null;
    if (allowed && !allowed.includes('restaurant') && !allowed.includes('chicken_shop')) throw new ForbiddenException(`Your plan includes: ${allowed.join(', ')}. Ask Tacksharp to enable another industry.`);
    const [customers, leads, orders] = await Promise.all([
      this.prisma.customer.count({ where: { organizationId } }),
      this.prisma.lead.count({ where: { organizationId } }),
      this.prisma.order.count({ where: { organizationId } }),
    ]);
    if (customers + leads + orders > 0) throw new BadRequestException('This workspace already has customers or orders. Ask Tacksharp to move it to the chicken-shop setup.');
    const before = await this.settings.get(organizationId);
    await this.prisma.organization.update({ where: { id: organizationId }, data: { vertical: 'restaurant' } });
    const settings = await this.settings.update(organizationId, { industry: 'food' });
    this.tenancy?.clearCache();
    await this.prisma.auditEvent.create({ data: { organizationId, actor: `user:${user.sub}`, entityType: 'organization', entityId: organizationId, action: 'industry_changed', data: { from: before.industry, to: 'chicken_shop' } } });
    return { settings, industry: 'restaurant' };
  }
}
