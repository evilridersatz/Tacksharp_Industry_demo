import { Injectable, Optional, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { UnrecoverableError, Worker } from 'bullmq';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import { ErrorThrottle, dependencyOf, describeError } from '../common/errors.js';
import {
  closeRedisConnections,
  agentQueue,
  marketingQueue,
  MARKETING_QUEUE,
  type CampaignJobData,
  followUpQueue,
  whatsappQueue,
  orderFollowUpQueue,
  AGENT_QUEUE,
  FOLLOW_UP_QUEUE,
  WHATSAPP_QUEUE,
  ORDER_FOLLOW_UP_QUEUE,
  type OrderFollowUpJobData,
  createRedisConnection,
  type AgentTaskJobData,
  type FollowUpJobData,
  type WhatsAppMessageJobData,
} from '../queues/queues.js';
import { FollowUpProcessor } from './follow-up.processor.js';
import { WhatsAppMessageProcessor } from './whatsapp-message.processor.js';
import { OrderFollowUpService } from '../restaurant/order-followup.service.js';
import { InboundMessageService } from '../whatsapp/inbound-messages.service.js';
import { Orchestrator } from '../agents/orchestrator.service.js';
import { MonitoringEngine } from '../visionops/engine.service.js';
import { MarketingService } from '../marketing/marketing.service.js';

/**
 * Runs the BullMQ workers inside the API process (RUN_WORKERS=true, default).
 * One process to start in VS Code and on a single Lightsail server.
 * Later: run a second copy with RUN_WORKERS=true and the API with RUN_WORKERS=false.
 */
@Injectable()
export class WorkersService implements OnModuleInit, OnApplicationShutdown {
  private workers: Worker[] = [];
  /** Connection errors repeat every reconnect attempt: logged once a minute per distinct error, with the dependency. */
  private readonly throttle = new ErrorThrottle(60_000);

  constructor(
    private readonly followUps: FollowUpProcessor,
    private readonly whatsapp: WhatsAppMessageProcessor,
    private readonly orderFollowUps: OrderFollowUpService,
    private readonly inbound: InboundMessageService,
    private readonly orchestrator: Orchestrator,
    private readonly marketing: MarketingService,
    @Optional() private readonly monitoring?: MonitoringEngine,
  ) {}

  onModuleInit() {
    if (!config.runWorkers) {
      log.info('workers.disabled', {});
      return;
    }

    const whatsappWorker = new Worker<WhatsAppMessageJobData>(
      WHATSAPP_QUEUE,
      (job) => this.whatsapp.process(job),
      // Rate limit: never more than 20 reply jobs a second towards Meta, even when a backlog drains after an outage.
      // lockDuration > the longest AI turn (45 s): BullMQ must not think a working job "stalled" and hand it to a
      // second worker (one of the duplicate-reply causes). The database claim is the final guard either way.
      { connection: createRedisConnection('worker-whatsapp'), concurrency: 10, limiter: { max: 20, duration: 1000 }, lockDuration: 120_000, maxStalledCount: 1 },
    );

    const followUpWorker = new Worker<FollowUpJobData>(
      FOLLOW_UP_QUEUE,
      (job) => this.followUps.process(job.data.followUpId),
      { connection: createRedisConnection('worker-followup'), concurrency: 5 },
    );

    whatsappWorker.on('failed', (job, error) => {
      const final = !job || job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError;
      log.error(final ? 'deadletter.whatsapp' : 'worker.whatsapp_retry', {
        jobId: job?.id,
        attempts: job?.attemptsMade,
        dependency: dependencyOf(error),
        deliveryUnknown: (error as { ambiguous?: boolean }).ambiguous === true || undefined,
        error: describeError(error),
      });
    });
    followUpWorker.on('failed', async (job, error) => {
      log.error('worker.followup_failed', { jobId: job?.id, attempts: job?.attemptsMade, dependency: dependencyOf(error), error: describeError(error) });
      if (job && (job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError)) {
        log.error('deadletter.followup', { jobId: job.id, followUpId: job.data.followUpId, error: errorMessage(error) });
        await this.followUps.markFailed(job.data.followUpId, errorMessage(error));
      }
    });
    // GR Chicken order follow-ups. A thrown error = temporary failure: BullMQ retries with back-off; the service
    // itself marks the row failed after its max attempts and never sends a message twice.
    const orderFollowUpWorker = new Worker<OrderFollowUpJobData>(
      ORDER_FOLLOW_UP_QUEUE,
      (job) => this.orderFollowUps.process(job.data.followUpId),
      { connection: createRedisConnection('worker-order-followup'), concurrency: 5, limiter: { max: 10, duration: 1000 } },
    );
    orderFollowUpWorker.on('failed', (job, error) => log.warn('worker.order_followup_retry', { jobId: job?.id, attempts: job?.attemptsMade, dependency: dependencyOf(error), error: describeError(error) }));

    // AI agent tasks: the task row decides (status / attempts / retry time); a job only triggers a run.
    const agentWorker = new Worker<AgentTaskJobData>(
      AGENT_QUEUE,
      (job) => this.orchestrator.run(job.data.organizationId, job.data.taskId),
      { connection: createRedisConnection('worker-agent'), concurrency: 5 },
    );
    agentWorker.on('failed', (job, error) => log.error('worker.agent_failed', { jobId: job?.id, taskId: job?.data.taskId, error: errorMessage(error) }));

    // Approved marketing campaigns: one recipient per job, rate-limited well under Meta's messaging throughput.
    const marketingWorker = new Worker<CampaignJobData>(
      MARKETING_QUEUE,
      (job) => this.marketing.processRecipient(job.data),
      { connection: createRedisConnection('worker-marketing'), concurrency: 2, limiter: { max: 10, duration: 1000 } },
    );
    marketingWorker.on('failed', (job, error) => log.error('worker.marketing_failed', { jobId: job?.id, campaignId: job?.data.campaignId, error: errorMessage(error) }));

    // A worker 'error' is the worker's own Redis connection failing (e.g. "connect ETIMEDOUT" while Redis is
    // unreachable); BullMQ re-emits it on every reconnect attempt. Named and logged once a minute.
    for (const [name, worker] of [['whatsapp', whatsappWorker], ['followup', followUpWorker], ['order_followup', orderFollowUpWorker], ['agent', agentWorker], ['marketing', marketingWorker]] as const) {
      worker.on('error', (error) => this.throttle.report('worker.error', error, { worker: name }, 'redis'));
    }

    this.workers = [whatsappWorker, followUpWorker, orderFollowUpWorker, agentWorker, marketingWorker];
    // Inbound messages persisted but never queued (queue add failed) or whose job was lost: queue them again with
    // the same job id. The claim in the database still guarantees one reply.
    this.sweeper = setInterval(() => void this.requeueStuckInbound().catch((e) => log.warn('whatsapp.requeue_failed', { error: describeError(e) })), 60_000);
    this.sweeper.unref();
    // VisionOps periodic work (sweep, cloud checks, retention, live demo feed) runs in VisionOpsScheduler.
    log.info('workers.started', { queues: [WHATSAPP_QUEUE, FOLLOW_UP_QUEUE, ORDER_FOLLOW_UP_QUEUE, AGENT_QUEUE, MARKETING_QUEUE] });
  }

  private sweeper?: NodeJS.Timeout;

  async requeueStuckInbound() {
    for (const row of await this.inbound.stuck()) {
      // Bounded: a message that keeps getting stuck is failed (visible on the dashboard), not retried forever.
      if (row.attempts >= 5) {
        await this.inbound.markFailed(row.id, 'Gave up after repeated attempts');
        continue;
      }
      const p = (row.payload ?? {}) as { phoneNumberId?: string; text?: string | null; audioId?: string | null; customerName?: string | null; timestamp?: string | null };
      await whatsappQueue.add(
        'incoming-message',
        { organizationId: row.organizationId, phoneNumberId: p.phoneNumberId ?? '', from: row.fromPhone, messageId: row.providerMessageId, messageType: row.messageType, text: p.text ?? undefined, audioId: p.audioId ?? undefined, customerName: p.customerName ?? undefined, timestamp: p.timestamp ?? undefined },
        { jobId: `whatsapp-${row.providerMessageId}` },
      );
      await this.inbound.noteRequeued(row.id);
      log.info('whatsapp.inbound_requeued', { inboundId: row.id, messageId: row.providerMessageId, status: row.status });
    }
  }

  /** Graceful shutdown: stop taking new jobs, let active ones finish, then close Redis. */
  async onApplicationShutdown(signal?: string) {
    if (this.sweeper) clearInterval(this.sweeper);
    log.info('workers.stopping', { signal });
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.allSettled([followUpQueue.close(), whatsappQueue.close(), orderFollowUpQueue.close(), agentQueue.close(), marketingQueue.close()]);
    await closeRedisConnections();
    log.info('workers.stopped', {});
  }
}
