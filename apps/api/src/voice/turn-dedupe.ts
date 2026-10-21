import crypto from 'node:crypto';
import { errorMessage, log } from '../common/logger.js';

/** The few Redis calls used here (ioredis-compatible). */
export type DedupeRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

const PENDING = '__pending__';

/**
 * One AI turn per recorded utterance, across API restarts and instances.
 *
 * Plivo re-posts a turn webhook it thinks timed out. The first delivery of a recording (keyed by its RecordUrl, which
 * is unique per utterance) runs the turn; any repeat — on this process, after a restart, or on another instance —
 * gets the SAME reply back and nothing is saved twice. A new utterance with identical words has a new recording, so
 * it is a new turn (a customer may say the same thing twice on purpose).
 *
 * Redis down: the turn still runs (fail-open, logged); the in-memory check in VoiceService still covers retries
 * reaching this process.
 */
export class TurnDedupe {
  constructor(
    private redis: DedupeRedis | null,
    private readonly ttlSec = 15 * 60,
    private readonly waitMs = 20_000,
  ) {}

  useRedis(redis: DedupeRedis | null) {
    this.redis = redis;
  }

  static key(callId: string, recordUrl: string) {
    return `voice-turn:${callId}:${crypto.createHash('sha1').update(recordUrl).digest('hex').slice(0, 24)}`;
  }

  /**
   * Runs `work` for the first delivery of this recording; a repeat returns the stored reply. A repeat that arrives
   * while the first is still running waits for it (up to waitMs), then gets `whileRunning()` (listen again — never a
   * second AI turn).
   */
  async run(callId: string, recordUrl: string, work: () => Promise<string>, whileRunning: () => string): Promise<{ xml: string; duplicate: boolean }> {
    if (!this.redis) return { xml: await work(), duplicate: false };
    const key = TurnDedupe.key(callId, recordUrl);
    let claimed: unknown;
    try {
      claimed = await this.redis.set(key, PENDING, 'EX', this.ttlSec, 'NX');
    } catch (error) {
      log.warn('voice.turn_dedupe_unavailable', { callId, error: errorMessage(error).slice(0, 120) });
      return { xml: await work(), duplicate: false };
    }
    if (claimed === 'OK') {
      try {
        const xml = await work();
        await this.redis.set(key, xml, 'EX', this.ttlSec).catch(() => undefined);
        return { xml, duplicate: false };
      } catch (error) {
        await this.redis.del(key).catch(() => undefined); // a failed turn may be retried for real
        throw error;
      }
    }
    const deadline = Date.now() + this.waitMs;
    let delay = 100;
    for (;;) {
      const stored = await this.redis.get(key).catch(() => null);
      if (stored && stored !== PENDING) {
        log.info('voice.turn_duplicate_shared', { callId });
        return { xml: stored, duplicate: true };
      }
      if (stored === null) return { xml: await work(), duplicate: false }; // the first attempt failed and released it
      if (Date.now() > deadline) {
        log.warn('voice.turn_duplicate_timeout', { callId });
        return { xml: whileRunning(), duplicate: true };
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 500);
    }
  }
}
