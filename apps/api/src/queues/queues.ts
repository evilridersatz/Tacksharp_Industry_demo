import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';

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
  connection.on('error', (error) => {
    if (!down) log.error('redis.error', { connection: name, error: error.message });
    down = true;
  });
  connection.on('ready', () => {
    if (down) log.info('redis.reconnected', { connection: name });
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
};

export const FOLLOW_UP_QUEUE = 'follow-up';
export const WHATSAPP_QUEUE = 'whatsapp-message';

export const followUpQueue = new Queue<FollowUpJobData>(FOLLOW_UP_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 1000,
    // Failed jobs are kept 14 days: this is the dead-letter list, visible in /health.
    removeOnFail: { age: 14 * 24 * 3600 },
  },
});

export const whatsappQueue = new Queue<WhatsAppMessageJobData>(WHATSAPP_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    // Keep a day of job ids so Meta's duplicate webhook deliveries are dropped.
    removeOnComplete: { age: 24 * 3600, count: 20000 },
    removeOnFail: { age: 14 * 24 * 3600 },
  },
});

export const queueRedis = connection;
