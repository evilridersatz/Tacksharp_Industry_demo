import { BadRequestException, Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { log } from '../common/logger.js';
import { schedulerEnabled } from '../common/scheduler-env.js';
import { DemoActivityService } from './demo-activity.service.js';

/**
 * Live demo switch for any demo workspace (shown in the demo banner). VisionOps uses its own feed (monitoring.liveDemo);
 * every other industry uses the activity feed (demoLive). Real workspaces get a 400: their data comes from customers.
 */
@Controller('demo/live')
export class DemoLiveController {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly activity: DemoActivityService) {}

  @Get()
  async status(@Org() org: string) {
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } });
    if (!o?.isDemo) return { available: false, enabled: false, since: null, lastActivityAt: null, scheduler: schedulerEnabled() };
    const s = await this.settings.get(org);
    const cctv = s.industry === 'cctv';
    const live = cctv ? s.monitoring.liveDemo : s.demoLive;
    const last = cctv
      ? (await this.prisma.monitoringAgent.aggregate({ where: { organizationId: org }, _max: { lastHeartbeatAt: true } }))._max.lastHeartbeatAt
      : (await this.prisma.message.findFirst({ where: { organizationId: org, id: { startsWith: 'dl_' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }))?.createdAt;
    return { available: process.env.DEMO_LIVE_FEED !== 'off', enabled: Boolean(live?.enabled), since: live?.since ?? null, lastActivityAt: last?.toISOString() ?? null, scheduler: schedulerEnabled() };
  }

  @Post()
  async toggle(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() b: { enabled?: unknown }) {
    if (!['admin', 'manager'].includes(String(u.role))) throw new ForbiddenException('Only an admin or manager can switch the live demo.');
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } });
    if (!o?.isDemo) throw new BadRequestException('The live demo feed is only available in demo workspaces. Real workspaces show what your customers and devices actually do.');
    if (process.env.DEMO_LIVE_FEED === 'off') throw new BadRequestException('The live demo feed is disabled on this server (DEMO_LIVE_FEED=off).');
    const enabled = b?.enabled === true;
    const now = new Date();
    const state = { enabled, since: enabled ? now.toISOString() : null };
    const s = await this.settings.get(org);
    const cctv = s.industry === 'cctv';
    await this.settings.update(org, (cctv ? { monitoring: { liveDemo: state } } : { demoLive: state }) as never);
    log.info('demo_live.toggled', { org, enabled, by: u.sub, cctv });
    const first = enabled && !cctv ? await this.activity.tick(org, now) : null;
    return { ...state, scheduler: schedulerEnabled(), first };
  }
}
