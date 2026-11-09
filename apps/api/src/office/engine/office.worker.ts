import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service.js';
import { config } from '../../common/config.js';
import { schedulerEnabled } from '../../common/scheduler-env.js';
import { errorMessage, log } from '../../common/logger.js';
import { registerLiveTap } from '../../common/live-events.js';
import { runInProviderScope } from '../../integrations/provider-scope.js';
import { OFFICE_QUEUE, createRedisConnection, officeQueue, type OfficeTaskJobData } from '../../queues/queues.js';
import { fromLive, publishBusinessEvent } from '../events/business-events.js';
import { OfficeWorkflowsService } from '../workflows/office-workflows.service.js';
import { OfficeInsightsService } from '../office-insights.service.js';
import { OfficeEngine } from './office-engine.service.js';

const TICK_MS = 60_000;
const LOCK_KEY = 'lock:office:scheduler';

/**
 * Runs the office: the BullMQ worker for office tasks (wherever RUN_WORKERS is on), and, once a minute in one process
 * (Redis lock), the recovery sweep, event / schedule workflows and the daily retention clean-up. Business events are
 * recorded in every process from the live bus (each process records only what it published itself).
 */
@Injectable()
export class OfficeWorker implements OnModuleInit, OnApplicationShutdown {
  private worker?: Worker<OfficeTaskJobData>;
  private timer?: NodeJS.Timeout;
  private redis?: Redis;
  private running = false;
  private lastRetention = '';
  private untap?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: OfficeEngine,
    private readonly workflows: OfficeWorkflowsService,
    private readonly insights: OfficeInsightsService,
  ) {}

  onModuleInit() {
    // Products → versioned business events (durable). Cheap: one insert, ignored when the same event repeats.
    this.untap = registerLiveTap((org, e) => {
      const ev = fromLive(e);
      if (ev) void publishBusinessEvent(this.prisma, org, ev);
    });
    if (config.runWorkers && process.env.OFFICE_WORKER !== 'off') {
      this.worker = new Worker<OfficeTaskJobData>(
        OFFICE_QUEUE,
        (job) => runInProviderScope(job.data.organizationId, () => this.engine.runTask(job.data.organizationId, job.data.taskId)),
        // A step can take a few minutes (several model turns + tools); the task row's lease is the real guard.
        { connection: createRedisConnection('worker-office'), concurrency: 4, lockDuration: 5 * 60_000, maxStalledCount: 1 },
      );
      this.worker.on('failed', (job, error) => log.error('worker.office_failed', { jobId: job?.id, taskId: job?.data.taskId, error: errorMessage(error) }));
      this.worker.on('error', (error) => log.warn('worker.office_error', { error: errorMessage(error) }));
    }
    const s = schedulerEnabled();
    log.info('office.scheduler', { on: s.on, reason: s.reason, worker: Boolean(this.worker) });
    if (!s.on || process.env.OFFICE_SCHEDULER === 'off') return;
    this.timer = setInterval(() => void this.tick().catch((e) => log.warn('office.tick_failed', { error: errorMessage(e) })), TICK_MS);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    this.untap?.();
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close().catch(() => undefined);
    await officeQueue.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }

  private async acquire(): Promise<boolean> {
    try {
      this.redis ??= createRedisConnection('office-scheduler');
      const r = await Promise.race([this.redis.set(LOCK_KEY, String(process.pid), 'PX', TICK_MS - 5_000, 'NX'), new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 2_000))]);
      return r === 'OK';
    } catch {
      return false; // no Redis = no lock: skip rather than risk two processes running workflows twice
    }
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.acquire())) return;
      const swept = await this.engine.sweep(now);
      const wf = await this.workflows.tick(now);
      if (swept.recovered || swept.requeued || wf.started) log.info('office.tick', { ...swept, ...wf });
      const day = now.toISOString().slice(0, 10);
      if (this.lastRetention !== day && now.getUTCHours() === 21) { // 02:30 India time
        this.lastRetention = day;
        const r = await this.insights.retention(now);
        log.info('office.retention', r);
      }
    } finally {
      this.running = false;
    }
  }
}
