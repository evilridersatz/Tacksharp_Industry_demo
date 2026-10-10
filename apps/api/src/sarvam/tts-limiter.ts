/**
 * Concurrency gate for Sarvam TTS.
 *
 * Live call audio always goes first; background work (warming the cache of fixed lines at startup) only runs
 * when no live request is waiting, one at a time, so a deploy never fires a burst of requests that earns
 * HTTP 429s for the calls in progress.
 */
export type TtsPriority = 'live' | 'background';

export class TtsLimiter {
  private active = 0;
  private readonly liveQueue: Array<() => void> = [];
  private readonly backgroundQueue: Array<() => void> = [];
  private backgroundActive = 0;

  constructor(private readonly max: number) {}

  async run<T>(priority: TtsPriority, work: () => Promise<T>): Promise<T> {
    await this.acquire(priority);
    try {
      return await work();
    } finally {
      this.release(priority);
    }
  }

  get stats() {
    return { active: this.active, waitingLive: this.liveQueue.length, waitingBackground: this.backgroundQueue.length };
  }

  private canStart(priority: TtsPriority) {
    if (this.active >= this.max) return false;
    if (priority === 'background') return this.liveQueue.length === 0 && this.backgroundActive === 0;
    return true;
  }

  private acquire(priority: TtsPriority): Promise<void> {
    if (this.canStart(priority) && (priority === 'live' ? this.liveQueue.length === 0 : true)) {
      this.take(priority);
      return Promise.resolve();
    }
    return new Promise((resolve) => (priority === 'live' ? this.liveQueue : this.backgroundQueue).push(() => {
      this.take(priority);
      resolve();
    }));
  }

  private take(priority: TtsPriority) {
    this.active++;
    if (priority === 'background') this.backgroundActive++;
  }

  private release(priority: TtsPriority) {
    this.active--;
    if (priority === 'background') this.backgroundActive--;
    // Live requests first; background only when nothing live is waiting.
    while (this.active < this.max && this.liveQueue.length) this.liveQueue.shift()!();
    if (this.canStart('background') && this.backgroundQueue.length) this.backgroundQueue.shift()!();
  }
}

/** Retry policy: 429 / 5xx / network errors are worth one or two more tries; 4xx (bad input) are not. */
export function retryableTtsStatus(status: number) {
  return status === 429 || status >= 500;
}

/** Wait before retry `attempt` (1-based): Retry-After when Sarvam sends it (capped), else short jittered back-off. */
export function ttsBackoffMs(attempt: number, retryAfterHeader?: string | null, capMs = 1500): number {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(capMs, retryAfter * 1000);
  return Math.min(capMs, 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150));
}
