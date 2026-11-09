import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { schedulerEnabled } from '../common/scheduler-env.js';
import { errorMessage, log } from '../common/logger.js';
import { createRedisConnection } from '../queues/queues.js';
import { istClock } from './jarvis-config.js';
import { JarvisService } from './jarvis.service.js';

const TICK_MS = 60_000;
const LOCK_KEY = 'lock:jarvis:scheduler';

/**
 * Every minute (one API process at a time, Redis lock): each live organization's digest at its chosen India time, and
 * its monitors every N minutes. Same switch as the other periodic work (TACKSHARP_SCHEDULER / RUN_WORKERS). Nothing
 * here contacts customers: results are stored for the Jarvis pages and announced to open dashboards.
 */
@Injectable()
export class JarvisScheduler implements OnModuleInit, OnModuleDestroy {
  readonly state = schedulerEnabled();
  private timer?: NodeJS.Timeout;
  private running = false;
  private redis?: Redis;
  /** Last digest date and monitor run per organization (in memory; the lock keeps one process ticking). */
  private readonly lastDigest = new Map<string, string>();
  private readonly lastMonitor = new Map<string, number>();

  constructor(private readonly prisma: PrismaService, private readonly jarvis: JarvisService) {}

  onModuleInit() {
    log.info('jarvis.scheduler', { on: this.state.on, reason: this.state.reason });
    if (!this.state.on || process.env.JARVIS_SCHEDULER === 'off') return;
    this.timer = setInterval(() => void this.tick().catch((e) => log.warn('jarvis.tick_failed', { error: errorMessage(e) })), TICK_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.redis?.quit().catch(() => undefined);
  }

  private async acquire(): Promise<boolean> {
    try {
      this.redis ??= createRedisConnection('jarvis-scheduler');
      const r = await Promise.race([this.redis.set(LOCK_KEY, String(process.pid), 'PX', TICK_MS - 5_000, 'NX'), new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 2_000))]);
      return r === 'OK' || r === 'timeout';
    } catch {
      return true;
    }
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.acquire())) return;
      const orgs = await this.prisma.organization.findMany({ where: { status: { not: 'suspended' } }, select: { id: true } });
      const clock = istClock(now);
      for (const { id } of orgs) {
        try {
          const cfg = await this.jarvis.config(id);
          const due = clock.hour * 60 + clock.minute >= cfg.digest.hour * 60 + cfg.digest.minute;
          if (cfg.digest.on && due && this.lastDigest.get(id) !== clock.date) {
            const done = (await this.jarvis.digests(id)).some((d) => d.date === clock.date && d.source === 'scheduled');
            if (!done) await this.jarvis.buildDigest(id, 'scheduled', now);
            this.lastDigest.set(id, clock.date);
          }
          if ((now.getTime() - (this.lastMonitor.get(id) ?? 0)) >= cfg.monitorEveryMin * 60_000 - 5_000 && Object.values(cfg.monitors).some((m) => m.on)) {
            this.lastMonitor.set(id, now.getTime());
            await this.jarvis.runMonitors(id, now);
          }
        } catch (e) {
          log.warn('jarvis.org_failed', { organizationId: id, error: errorMessage(e) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
