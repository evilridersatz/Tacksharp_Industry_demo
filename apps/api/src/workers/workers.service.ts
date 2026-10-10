import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import {
  closeRedisConnections,
  followUpQueue,
  whatsappQueue,
  FOLLOW_UP_QUEUE,
  WHATSAPP_QUEUE,
  createRedisConnection,
  type FollowUpJobData,
  type WhatsAppMessageJobData,
} from '../queues/queues.js';
import { FollowUpProcessor } from './follow-up.processor.js';
import { WhatsAppMessageProcessor } from './whatsapp-message.processor.js';

/**
 * Runs the BullMQ workers inside the API process (RUN_WORKERS=true, default).
 * One process to start in VS Code and on a single Lightsail server.
 * Later: run a second copy with RUN_WORKERS=true and the API with RUN_WORKERS=false.
 */
@Injectable()
export class WorkersService implements OnModuleInit, OnApplicationShutdown {
  private workers: Worker[] = [];

  constructor(
    private readonly followUps: FollowUpProcessor,
    private readonly whatsapp: WhatsAppMessageProcessor,
  ) {}

  onModuleInit() {
    if (!config.runWorkers) {
      log.info('workers.disabled', {});
      return;
    }

    const whatsappWorker = new Worker<WhatsAppMessageJobData>(
      WHATSAPP_QUEUE,
      (job) => this.whatsapp.process(job),
      { connection: createRedisConnection('worker-whatsapp'), concurrency: 10 },
    );

    const followUpWorker = new Worker<FollowUpJobData>(
      FOLLOW_UP_QUEUE,
      (job) => this.followUps.process(job.data.followUpId),
      { connection: createRedisConnection('worker-followup'), concurrency: 5 },
    );

    whatsappWorker.on('failed', (job, error) => {
      const final = !job || job.attemptsMade >= (job.opts.attempts ?? 1) || error.name === 'UnrecoverableError';
      log.error(final ? 'deadletter.whatsapp' : 'worker.whatsapp_retry', {
        jobId: job?.id,
        attempts: job?.attemptsMade,
        error: errorMessage(error),
      });
    });
    followUpWorker.on('failed', async (job, error) => {
      log.error('worker.followup_failed', { jobId: job?.id, attempts: job?.attemptsMade, error: errorMessage(error) });
      if (job && (job.attemptsMade >= (job.opts.attempts ?? 1) || error.name === 'UnrecoverableError')) {
        log.error('deadletter.followup', { jobId: job.id, followUpId: job.data.followUpId, error: errorMessage(error) });
        await this.followUps.markFailed(job.data.followUpId, errorMessage(error));
      }
    });
    for (const worker of [whatsappWorker, followUpWorker]) {
      worker.on('error', (error) => log.error('worker.error', { error: errorMessage(error) }));
    }

    this.workers = [whatsappWorker, followUpWorker];
    log.info('workers.started', { queues: [WHATSAPP_QUEUE, FOLLOW_UP_QUEUE] });
  }

  /** Graceful shutdown: stop taking new jobs, let active ones finish, then close Redis. */
  async onApplicationShutdown(signal?: string) {
    log.info('workers.stopping', { signal });
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.allSettled([followUpQueue.close(), whatsappQueue.close()]);
    await closeRedisConnections();
    log.info('workers.stopped', {});
  }
}
