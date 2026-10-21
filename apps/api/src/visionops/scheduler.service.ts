import { Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { errorMessage, log } from '../common/logger.js';
import { createRedisConnection } from '../queues/queues.js';
import { MonitoringEngine } from './engine.service.js';
import { DemoFeedService, type FeedSummary } from './demo-feed.service.js';
import { DemoActivityService, type ActivitySummary } from '../demo-live/demo-activity.service.js';

const TICK_MS = 60_000;
const LOCK_KEY = 'lock:visionops:scheduler';
const RETENTION_EVERY_MS = 60 * 60_000;
const DEMO_RETENTION_DAYS = 3;
const HEARTBEAT_RETENTION_DAYS = 30;

export { schedulerEnabled } from '../common/scheduler-env.js';
import { schedulerEnabled } from '../common/scheduler-env.js';

export type TickResult = { at: string; orgs: number; feed: Record<string, FeedSummary | null>; cloudSites: number; agentsOffline: number; escalated: number; delivered: number; retention?: { healthEvents: number; heartbeats: number; demoActivity?: number }; activity?: Record<string, ActivitySummary | null> };

/**
 * Every minute: VisionOps live demo feed (demo CCTV workspaces that switched it on) → cloud checks for cloud-mode
 * sites → sweep (silent agents, stale cloud sites, escalations, due notifications) → the live demo activity of the
 * other demo workspaces → hourly retention (raw checks, and live-demo records older than 3 days).
 */
@Injectable()
export class VisionOpsScheduler implements OnModuleInit, OnModuleDestroy {
  readonly state = schedulerEnabled();
  lastTick: TickResult | null = null;
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running = false;
  private redis?: Redis;
  private lastRetention = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly engine: MonitoringEngine,
    private readonly feed: DemoFeedService,
    @Optional() private readonly activity?: DemoActivityService,
  ) {}

  onModuleInit() {
    log.info('visionops.scheduler', { on: this.state.on, reason: this.state.reason, demoFeed: process.env.VISIONOPS_DEMO_FEED !== 'off' });
    if (!this.state.on) return;
    const run = () => void this.runOnce().catch((e) => log.warn('visionops.scheduler_tick_failed', { error: errorMessage(e) }));
    this.first = setTimeout(run, 5_000);
    this.first.unref();
    this.timer = setInterval(run, TICK_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    await this.redis?.quit().catch(() => undefined);
  }

  /** One process per minute. Redis unreachable: run anyway (every step is idempotent), and say so once per tick. */
  private async acquire(): Promise<boolean> {
    try {
      this.redis ??= createRedisConnection('visionops-scheduler');
      const r = await Promise.race([this.redis.set(LOCK_KEY, String(process.pid), 'PX', TICK_MS - 5_000, 'NX'), new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 2_000))]);
      if (r === 'timeout') { log.warn('visionops.scheduler_lock_unavailable', { reason: 'redis timeout' }); return true; }
      return r === 'OK';
    } catch (error) {
      log.warn('visionops.scheduler_lock_unavailable', { error: errorMessage(error) });
      return true;
    }
  }

  async runOnce(now = new Date(), opts: { lock?: boolean } = {}): Promise<TickResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      if (opts.lock !== false && !(await this.acquire())) return null;
      const orgs = (await this.prisma.monitoringSite.findMany({ select: { organizationId: true }, distinct: ['organizationId'] })).map((o) => o.organizationId);
      const result: TickResult = { at: now.toISOString(), orgs: orgs.length, feed: {}, cloudSites: 0, agentsOffline: 0, escalated: 0, delivered: 0 };
      const live = process.env.VISIONOPS_DEMO_FEED === 'off' ? [] : await this.feed.liveOrgs();
      for (const org of orgs) await this.org(org, now, live.includes(org), result);
      if (this.activity && process.env.DEMO_LIVE_FEED !== 'off') {
        result.activity = {};
        for (const org of await this.activity.liveOrgs()) {
          try { result.activity[org] = await this.activity.tick(org, now); } catch (error) { log.warn('demo_live.tick_failed', { org, error: errorMessage(error) }); }
        }
      }
      if (now.getTime() - this.lastRetention >= RETENTION_EVERY_MS) {
        this.lastRetention = now.getTime();
        result.retention = await this.retention(orgs, now);
        if (this.activity) {
          let n = 0;
          for (const o of await this.prisma.organization.findMany({ where: { isDemo: true }, select: { id: true } })) n += await this.activity.prune(o.id, now).catch(() => 0);
          result.retention.demoActivity = n;
        }
      }
      this.lastTick = result;
      return result;
    } finally {
      this.running = false;
    }
  }

  /** The same steps for one workspace ("Run checks now" on the dashboard). */
  async runOrg(org: string, now = new Date()) {
    const live = process.env.VISIONOPS_DEMO_FEED === 'off' ? false : (await this.feed.liveOrgs()).includes(org);
    const result: TickResult = { at: now.toISOString(), orgs: 1, feed: {}, cloudSites: 0, agentsOffline: 0, escalated: 0, delivered: 0 };
    return this.org(org, now, live, result);
  }

  private async org(org: string, now: Date, liveDemo: boolean, acc: TickResult): Promise<TickResult> {
    if (liveDemo) {
      try { acc.feed[org] = await this.feed.tick(org, now); } catch (error) { log.warn('visionops.demo_feed_failed', { org, error: errorMessage(error) }); }
    }
    const cloud = await this.prisma.monitoringSite.findMany({ where: { organizationId: org, monitoringMode: 'cloud', isDemo: false }, select: { id: true, code: true } });
    for (const s of cloud) {
      try { await this.engine.runCloudChecks(org, s.id, now); acc.cloudSites++; } catch (error) { log.warn('visionops.cloud_checks_failed', { org, site: s.code, error: errorMessage(error) }); }
    }
    try {
      const sw = await this.engine.sweep(org, now, { includeDemoAgents: liveDemo });
      acc.agentsOffline += sw.agentsOffline;
      acc.escalated += sw.escalated;
      acc.delivered += sw.delivered;
    } catch (error) {
      log.warn('visionops.sweep_failed', { org, error: errorMessage(error) });
    }
    return acc;
  }

  /** Raw checks and heartbeats past retention are deleted in batches. Incidents, timelines and notifications stay. */
  async retention(orgs: string[], now = new Date()) {
    let healthEvents = 0;
    let heartbeats = 0;
    for (const org of orgs) {
      const [o, s] = await Promise.all([this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } }), this.settings.get(org)]);
      const days = o?.isDemo ? Math.min(DEMO_RETENTION_DAYS, s.monitoring.retentionDays ?? 90) : (s.monitoring.retentionDays ?? 90);
      const evCutoff = new Date(now.getTime() - days * 86_400_000);
      const hbCutoff = new Date(now.getTime() - Math.min(days, HEARTBEAT_RETENTION_DAYS) * 86_400_000);
      for (let i = 0; i < 40; i++) {
        const n = await this.prisma.$executeRaw`DELETE FROM HealthEvent WHERE organizationId = ${org} AND observedAt < ${evCutoff} LIMIT 5000`;
        healthEvents += n;
        if (n < 5000) break;
      }
      for (let i = 0; i < 40; i++) {
        const n = await this.prisma.$executeRaw`DELETE FROM AgentHeartbeat WHERE organizationId = ${org} AND receivedAt < ${hbCutoff} LIMIT 5000`;
        heartbeats += n;
        if (n < 5000) break;
      }
    }
    if (healthEvents || heartbeats) log.info('visionops.retention', { healthEvents, heartbeats });
    return { healthEvents, heartbeats };
  }
}
