import { Injectable } from '@nestjs/common';
import { queueRedis } from '../queues/queues.js';
import { errorMessage, log } from '../common/logger.js';
import type { WhenDraft } from '../conversation/when.js';
import type { PaymentChoice } from './chicken-parse.js';

/** A product line while the customer is still deciding (quantity / cut may be missing). */
export type DraftLine = { itemId: string; quantity?: number; cut?: string };

/** Server-side ordering state for one WhatsApp thread. The order lives here, never in the model's memory. */
export type OrderSession = {
  v: 2;
  key: string;
  organizationId: string;
  channel: 'whatsapp' | 'test';
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
  pending?: { nonce: string; total: number; expiresAt: number };
  lastOrderNumber?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  updatedAt: string;
};

const TTL_SEC = 3 * 24 * 3600;
type RedisLike = { get(key: string): Promise<string | null>; set(...args: any[]): Promise<unknown>; del(key: string): Promise<unknown> };

/** Memory first (single API process), Redis as the durable copy so a restart does not lose a half-taken order. */
@Injectable()
export class OrderSessionStore {
  private readonly mem = new Map<string, OrderSession>();
  private redis: RedisLike | null = queueRedis;

  useRedis(redis: RedisLike | null) {
    this.redis = redis;
  }

  async get(key: string): Promise<OrderSession | undefined> {
    const hit = this.mem.get(key);
    if (hit) return hit;
    if (!this.redis) return undefined;
    try {
      const raw = await this.redis.get(`order-session:${key}`);
      if (!raw) return undefined;
      const s = JSON.parse(raw) as OrderSession;
      if (s.v !== 2) return undefined;
      this.mem.set(key, s);
      return s;
    } catch (error) {
      log.warn('order_session.load_failed', { error: errorMessage(error) });
      return undefined;
    }
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
