import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { Public } from '../auth/decorators.js';
import { followUpQueue, queueRedis, whatsappQueue } from '../queues/queues.js';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/** GET /health — API, database, Redis and queue backlog. No secrets, no customer data. */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    const check = async (fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await withTimeout(fn(), 3000);
        return { ok: true, ms: Date.now() - t };
      } catch (error) {
        return { ok: false, ms: Date.now() - t, error: error instanceof Error ? error.message : 'error' };
      }
    };
    const [database, redis] = await Promise.all([
      check(() => this.prisma.$queryRaw`SELECT 1`),
      check(() => queueRedis.ping()),
    ]);
    let queues: Record<string, unknown> = {};
    if (redis.ok) {
      try {
        const [f, w] = await withTimeout(
          Promise.all([
            followUpQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
            whatsappQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
          ]),
          3000,
        );
        queues = { followUp: f, whatsapp: w };
      } catch {
        queues = { error: 'unavailable' };
      }
    }
    const ok = database.ok && redis.ok;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      api: { ok: true, uptimeSec: Math.round(process.uptime()) },
      database,
      redis,
      queues,
      ms: Date.now() - started,
    };
  }
}
