import { Injectable } from '@nestjs/common';
import { queueRedis } from '../queues/queues.js';
import { errorMessage, log } from '../common/logger.js';
import type { WhenDraft } from '../conversation/when.js';
import type { PaymentChoice } from './chicken-parse.js';

/** A product line while the customer is still deciding (quantity / cut may be missing). */
export type DraftLine = { itemId: string; quantity?: number; cut?: string };

/** Server-side ordering state for one WhatsApp thread or phone line. The order lives here, never in the model's memory. */
export type OrderSession = {
  v: 2;
  key: string;
  organizationId: string;
  channel: 'whatsapp' | 'test' | 'voice';
  phone: string;
  name?: string;
  customerId?: string;
  conversationId?: string;
  /** tamil | tanglish | english — replies follow the customer. */
  lang: 'tamil' | 'tanglish' | 'english';
  lines: DraftLine[];
  /** The product being talked about: "3 kg" / "curry cut" without a product name applies to it. */
  focusItemId?: string;
  payment?: PaymentChoice;
  pickupAt?: string;
  pickupDraft?: WhenDraft;
  outletId?: string;
  claimId?: string;
  offerAmount?: number;
  greeted: boolean;
  step: 'collecting' | 'awaiting_confirmation';
  /** The summary the customer is being asked to confirm. Any change drops it. */
  /** cartHash: the exact cart / payment / pickup the customer was shown. A yes only places THAT version. */
  pending?: { nonce: string; total: number; expiresAt: number; cartHash?: string };
  /**
   * An unplaced draft from the customer's other channel or an earlier call / chat. Never used silently: it is offered,
   * and only restored when the customer continues it (or answers with payment / pickup only). A new product request
   * sets it aside.
   */
  held?: {
    lines: DraftLine[];
    payment?: PaymentChoice;
    pickupAt?: string;
    pickupDraft?: WhenDraft;
    outletId?: string;
    focusItemId?: string;
    from: 'whatsapp' | 'voice' | 'earlier';
    offered?: boolean;
  };
  lastOrderNumber?: string;
  /** A product the customer asked about ("do you have liver?") but has not ordered: a following "2 kg" is for it. */
  interestItemId?: string;
  /** "3 kilo" eggs: eggs are counted, so we asked "3 eggs?" — a yes sets this amount on this product. */
  suggestQty?: { itemId: string; quantity: number };
  /** The last reply that only re-asked for a missing detail, and how often it came out the same in a row. */
  lastPromptOnly?: string;
  promptRepeats?: number;
  /** Voice: an order was placed during the current call (a following "no" / "thanks" then ends the call). */
  orderedOnCall?: string;
  /** Draft details were carried over from the customer's other channel (WhatsApp <-> phone) when this one started. */
  carriedFrom?: 'whatsapp' | 'voice';
  /** Voice: consecutive short Tamil turns (Tamil script, speech-to-text said ta-IN) while the call is not in Tamil. */
  tamilEvidence?: number;
  /** An amount said before any product ("ஒரு கிலோ"): applied to the next product the customer names. */
  pendingQty?: { quantity: number; unit?: 'kg' | 'piece' | 'bare' };
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  updatedAt: string;
};

const TTL_SEC = 3 * 24 * 3600;
type RedisLike = {
  get(key: string): Promise<string | null>;
  set(...args: any[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  scan?(...args: any[]): Promise<[string, string[]]>;
  eval?(...args: any[]): Promise<unknown>;
};
const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 8_000;
/** Deletes the lock only if we still own it (a lock that expired and was taken by another instance is left alone). */
const UNLOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Memory first (single API process), Redis as the durable copy so a restart does not lose a half-taken order. */
@Injectable()
export class OrderSessionStore {
  private readonly mem = new Map<string, OrderSession>();
  private redis: RedisLike | null = queueRedis;

  useRedis(redis: RedisLike | null) {
    this.redis = redis;
  }

  /**
   * Redis is the shared copy: with more than one API instance (or a call on one and a WhatsApp message on another)
   * this process's memory can be older than what another instance saved, so Redis is read first. Memory is the
   * fallback when Redis is not configured or does not answer.
   */
  async get(key: string): Promise<OrderSession | undefined> {
    if (!this.redis) return this.mem.get(key);
    try {
      const raw = await this.redis.get(`order-session:${key}`);
      if (!raw) return this.mem.get(key);
      const s = JSON.parse(raw) as OrderSession;
      if (s.v !== 2) return this.mem.get(key);
      const local = this.mem.get(key);
      // Newest wins (a save whose Redis write failed exists only in memory).
      const best = local && local.updatedAt > s.updatedAt ? local : s;
      this.mem.set(key, best);
      return best;
    } catch (error) {
      log.warn('order_session.load_failed', { error: errorMessage(error) });
      return this.mem.get(key);
    }
  }

  /**
   * One turn at a time per customer ACROSS instances (the in-process mutex only covers one process): a short Redis
   * lock around the turn. If the lock cannot be taken within a few seconds (another turn is stuck) the turn runs
   * anyway rather than leaving the customer unanswered; the lock expires on its own after 30 s.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.redis) return fn();
    const lockKey = `order-session-lock:${key}`;
    const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
    let owned = false;
    const deadline = Date.now() + LOCK_WAIT_MS;
    try {
      while (!owned && Date.now() < deadline) {
        owned = (await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
        if (!owned) await new Promise((r) => setTimeout(r, 40));
      }
      if (!owned) log.warn('order_session.lock_timeout', { waitedMs: LOCK_WAIT_MS });
    } catch (error) {
      log.warn('order_session.lock_failed', { error: errorMessage(error) });
    }
    try {
      return await fn();
    } finally {
      if (owned) await this.redis.eval?.(UNLOCK_LUA, 1, lockKey, token)?.catch?.(() => undefined);
    }
  }

  /** Session keys are `${org}:${channel}:${phone}`: the same customer on another channel of the same organization. */
  static keyFor(organizationId: string, channel: OrderSession['channel'], phone: string) {
    return `${organizationId}:${channel}:${phone}`;
  }

  /**
   * Sessions of one organization updated in the last `withinMs` (dashboard: carts being built). Reads the durable
   * Redis copies (bounded scan) and this process's memory; the newest copy of each wins.
   */
  async listForOrganization(organizationId: string, withinMs = 24 * 3600_000, max = 200): Promise<OrderSession[]> {
    const byKey = new Map<string, OrderSession>();
    if (this.redis?.scan) {
      try {
        let cursor = '0';
        let rounds = 0;
        do {
          const [next, keys] = await this.redis.scan(cursor, 'MATCH', `order-session:${organizationId}:*`, 'COUNT', 200);
          cursor = next;
          for (const k of keys) {
            const raw = await this.redis.get(k);
            if (!raw) continue;
            const s = JSON.parse(raw) as OrderSession;
            if (s.v === 2 && s.organizationId === organizationId) byKey.set(s.key, s);
          }
        } while (cursor !== '0' && ++rounds < 50 && byKey.size < max);
      } catch (error) {
        log.warn('order_session.list_failed', { error: errorMessage(error) });
      }
    }
    for (const s of this.mem.values()) {
      const other = byKey.get(s.key);
      if (s.organizationId === organizationId && (!other || other.updatedAt <= s.updatedAt)) byKey.set(s.key, s);
    }
    const since = new Date(Date.now() - withinMs).toISOString();
    return [...byKey.values()].filter((s) => s.updatedAt >= since).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, max);
  }

  async save(s: OrderSession): Promise<void> {
    s.updatedAt = new Date().toISOString();
    this.mem.set(s.key, s);
    if (this.mem.size > 5000) {
      const oldest = [...this.mem.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, 500);
      for (const o of oldest) this.mem.delete(o.key);
    }
    if (!this.redis) return;
    try {
      await this.redis.set(`order-session:${s.key}`, JSON.stringify(s), 'EX', TTL_SEC);
    } catch (error) {
      log.warn('order_session.save_failed', { error: errorMessage(error) });
    }
  }
}
