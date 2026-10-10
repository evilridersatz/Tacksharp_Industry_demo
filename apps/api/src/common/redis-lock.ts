import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { log } from './logger.js';

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Per-key mutual exclusion across processes (SET NX PX + safe release).
 * Used so "customer replied" and "follow-up worker sends" for the same customer
 * never interleave: one finishes completely before the other starts.
 */
export async function withLock<T>(
  redis: Redis,
  key: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; waitMs?: number } = {},
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 30_000;
  const waitMs = opts.waitMs ?? 15_000;
  const token = randomUUID();
  const lockKey = `lock:${key}`;
  const deadline = Date.now() + waitMs;
  let delay = 25;
  while ((await redis.set(lockKey, token, 'PX', ttlMs, 'NX')) !== 'OK') {
    if (Date.now() > deadline) {
      log.warn('lock.timeout', { key });
      throw new Error(`Timed out waiting for lock ${key}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 250);
  }
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE, 1, lockKey, token).catch(() => undefined);
  }
}

export const customerLockKey = (customerId: string) => `customer:${customerId}`;
