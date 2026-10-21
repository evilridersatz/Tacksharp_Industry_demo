import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';
import { describeError } from '../common/errors.js';

const connections: Redis[] = [];

/** Redis connection with reconnect back-off, connect timeout and logging. */
export function createRedisConnection(name = 'redis') {
  const connection = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    tls: config.redis.tls ? {} : undefined,
    maxRetriesPerRequest: null, // required by BullMQ workers
    connectTimeout: 10_000,
    retryStrategy: (times) => Math.min(times * 500, 10_000), // keep reconnecting, back off up to 10 s
  });
  let down = false;
  let downSince = 0;
  connection.on('error', (error) => {
    if (!down) {
      downSince = Date.now();
      log.error('redis.error', { connection: name, dependency: 'redis', host: config.redis.host, port: config.redis.port, error: describeError(error) });
    }
    down = true;
  });
  connection.on('ready', () => {
    if (down) log.info('redis.reconnected', { connection: name, dependency: 'redis', downMs: Date.now() - downSince });
    down = false;
  });
  connections.push(connection);
  return connection;
}

export async function closeRedisConnections() {
  await Promise.allSettled(connections.map((c) => c.quit()));
}

const connection = createRedisConnection('queues');

export type FollowUpJobData = { followUpId: string };

export type WhatsAppMessageJobData = {
  organizationId: string;
  phoneNumberId: string;
  from: string;
  messageId: string;
  messageType: string;
  text?: string;
  /** Media id for audio / voice notes; transcribed with Sarvam before the AI runs. */
  audioId?: string;
  customerName?: string;
  timestamp?: string;
  /** Set after the AI produced a reply, so a retry re-sends instead of re-running the AI. */
  generatedReply?: string;
  conversationId?: string;
  /** Set once WhatsApp accepted the reply: a retry of this job never sends it again. */
  sentMessageId?: string;
};

export type OrderFollowUpJobData = { followUpId: string };
export type AgentTaskJobData = { organizationId: string; taskId: string };
export type CampaignJobData = { campaignId: string; recipientId: string };

export const FOLLOW_UP_QUEUE = 'follow-up';
export const ORDER_FOLLOW_UP_QUEUE = 'restaurant-follow-up';
export const AGENT_QUEUE = 'agent-task';
export const MARKETING_QUEUE = 'marketing-campaign';
export const WHATSAPP_QUEUE = 'whatsapp-message';

export const followUpQueue = new Queue<FollowUpJobData>(FOLLOW_UP_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000, jitter: 0.3 },
    removeOnComplete: 1000,
    // Failed jobs are kept 14 days: this is the dead-letter list, visible in /health.
    removeOnFail: { age: 14 * 24 * 3600 },
  },
});

export const whatsappQueue = new Queue<WhatsAppMessageJobData>(WHATSAPP_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000, jitter: 0.3 },
    // Keep a day of job ids so Meta's duplicate webhook deliveries are dropped.
    removeOnComplete: { age: 24 * 3600, count: 20000 },
    removeOnFail: { age: 14 * 24 * 3600 },
  },
});

/**
 * GR Chicken order follow-ups (confirmation, updates, feedback request, feedback call). One job per follow-up
 * attempt (jobId = row id + attempt), so re-adding the same job never runs it twice. The row's own status is
 * the source of truth: a job for a finished follow-up does nothing.
 */
export const orderFollowUpQueue = new Queue<OrderFollowUpJobData>(ORDER_FOLLOW_UP_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 20_000, jitter: 0.3 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
    removeOnFail: { age: 14 * 24 * 3600 },
  },
});

/** AI agent tasks. The task row is the source of truth (status, attempts); a job only says "run this task now". */
export const agentQueue = new Queue<AgentTaskJobData>(AGENT_QUEUE, {
  connection,
  defaultJobOptions: { attempts: 1, removeOnComplete: 1000, removeOnFail: { age: 14 * 24 * 3600 } },
});

/**
 * Marketing campaign messages: one job per approved recipient (jobId = campaign + recipient, so a re-add never sends
 * twice). The recipient row is the source of truth; the worker re-checks consent and the campaign state before sending.
 */
export const marketingQueue = new Queue<CampaignJobData>(MARKETING_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000, jitter: 0.3 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 20000 },
    removeOnFail: { age: 14 * 24 * 3600 },
  },
});

export const queueRedis = connection;
