import { Injectable } from '@nestjs/common';
import { queueRedis } from '../queues/queues.js';
import { errorMessage, log } from '../common/logger.js';
import type { CartLine } from './orders.service.js';

export type OrderStep =
  | 'browsing'
  | 'need_outlet'
  | 'need_fulfilment'
  | 'need_area'
  | 'need_address'
  | 'need_contact'
  | 'awaiting_confirmation';

/** Server-side ordering state for one chat thread. The cart lives here, never in the model's memory. */
export type OrderSession = {
  v: 1;
  key: string;
  organizationId: string;
  channel: 'whatsapp' | 'web';
  phone?: string;
  name?: string;
  customerId?: string;
  conversationId?: string;
  cart: CartLine[];
  outletId?: string;
  fulfilment?: 'pickup' | 'delivery';
  deliveryArea?: string;
  deliveryAddress?: string;
  step: OrderStep;
  /** The summary the customer is being asked to confirm. A changed cart drops it. */
  pending?: { nonce: string; total: number; expiresAt: number };
  lastOrderNumber?: string;
  /** Why we asked a web visitor for their number. */
  contactFor?: 'checkout' | 'handoff';
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  updatedAt: string;
};

const TTL_SEC = 24 * 3600;
type RedisLike = { get(key: string): Promise<string | null>; set(...args: any[]): Promise<unknown>; del(key: string): Promise<unknown> };

/** Memory first (single API process), Redis as the durable copy so a restart does not lose a cart. */
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
      if (s.v !== 1) return undefined;
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
