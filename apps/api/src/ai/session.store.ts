import { BeforeApplicationShutdown, Injectable, OnModuleDestroy } from '@nestjs/common';
import { queueRedis } from '../queues/queues.js';
import { errorMessage, log } from '../common/logger.js';
import { SESSION_TTL_SEC, type Session } from '../conversation/session.js';

type RedisLike = { get(key: string): Promise<string | null>; set(...args: any[]): Promise<unknown>; del(key: string): Promise<unknown> };

const MAX_SESSIONS = 5000;

/**
 * Call-scoped / thread-scoped conversation state.
 *  - memory first (the API runs as one process, see deploy/ecosystem.config.cjs), so a turn pays no round trip;
 *  - Redis is the durable copy, so an API restart in the middle of a call does not lose a pending
 *    visit proposal (and a pending proposal can never be "re-invented" from chat history);
 *  - background writes are tracked per session so hang-up / tests can wait for them.
 */
@Injectable()
export class SessionStore implements OnModuleDestroy, BeforeApplicationShutdown {
  private readonly mem = new Map<string, { session: Session; touched: number }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly redisWrites = new Map<string, Promise<unknown>>();
  private redis: RedisLike | null = queueRedis;
  private sweeper?: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
    this.sweeper.unref();
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** On SIGTERM / deploy: let queued database writes and Redis session copies finish (bounded) before closing. */
  async beforeApplicationShutdown() {
    const keys = new Set([...this.pending.keys(), ...this.redisWrites.keys()]);
    await Promise.all([...keys].map((key) => this.settle(key, 8000)));
  }

  /** Tests can run without Redis (memory only). */
  useRedis(redis: RedisLike | null) {
    this.redis = redis;
  }

  async get(key: string): Promise<Session | undefined> {
    const hit = this.mem.get(key);
    if (hit) {
      hit.touched = Date.now();
      return hit.session;
    }
    if (!this.redis) return undefined;
    try {
      const raw = await this.redis.get(`session:${key}`);
      if (!raw) return undefined;
      const session = JSON.parse(raw) as Session;
      if (session.v !== 1) return undefined;
      this.mem.set(key, { session, touched: Date.now() });
      return session;
    } catch (error) {
      log.warn('session.load_failed', { error: errorMessage(error) });
      return undefined;
    }
  }

  /** Memory is updated synchronously; the Redis copy is written in the background (see settle). */
  save(session: Session): void {
    session.updatedAt = new Date().toISOString();
    this.mem.set(session.key, { session, touched: Date.now() });
    if (this.mem.size > MAX_SESSIONS) this.evictOldest();
    if (this.redis) {
      const json = JSON.stringify(session);
      const redis = this.redis;
      const key = session.key;
      const previous = this.redisWrites.get(key) ?? Promise.resolve();
      // Redis writes of one session stay in order, independent of the (slower) database jobs.
      const next = previous
        .then(() => redis.set(`session:${key}`, json, 'EX', SESSION_TTL_SEC[session.channel]))
        .catch((error) => log.warn('session.save_failed', { error: errorMessage(error) }));
      this.redisWrites.set(key, next);
      void next.finally(() => {
        if (this.redisWrites.get(key) === next) this.redisWrites.delete(key);
      });
    }
  }

  async delete(key: string): Promise<void> {
    this.mem.delete(key);
    if (this.redis) await this.redis.del(`session:${key}`).catch(() => undefined);
  }

  /** Attach already-running background work (e.g. the Redis write) to a session so it can be awaited later. */
  track(key: string, work: Promise<unknown>) {
    this.chain(key, () => work);
  }

  /**
   * Queue background work (DB writes) for a session. Jobs of one session run one after another in the
   * order they were queued (user message before assistant message, turn N before turn N+1); a failing job
   * is logged and never blocks the ones behind it.
   */
  chain(key: string, job: () => Promise<unknown>) {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.then(job).catch((error) => log.warn('session.background_failed', { error: errorMessage(error) }));
    this.pending.set(key, next);
    void next.finally(() => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    });
  }

  /** Resolves when every background write for this session has finished (bounded wait). */
  async settle(key: string, timeoutMs = 5000): Promise<void> {
    const work = [this.pending.get(key), this.redisWrites.get(key)].filter(Boolean) as Promise<unknown>[];
    if (!work.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(work), new Promise((r) => { timer = setTimeout(r, timeoutMs); timer.unref(); })]);
    if (timer) clearTimeout(timer);
  }

  private evictOldest() {
    const oldest = [...this.mem.entries()].sort((a, b) => a[1].touched - b[1].touched).slice(0, Math.ceil(MAX_SESSIONS / 10));
    for (const [key] of oldest) this.mem.delete(key);
  }

  private sweep() {
    const now = Date.now();
    for (const [key, v] of this.mem) {
      if (now - v.touched > SESSION_TTL_SEC[v.session.channel] * 1000) this.mem.delete(key);
    }
  }
}
