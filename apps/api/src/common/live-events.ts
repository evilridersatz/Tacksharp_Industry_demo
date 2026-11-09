import { EventEmitter } from 'node:events';
import { errorMessage, log } from './logger.js';

/**
 * Live dashboard events: "something changed for this organization" (a new order from WhatsApp, a phone call or the
 * dashboard assistant, a status change, a cart being built, a message in or out, a call starting or ending).
 *
 * Every API process publishes to Redis (channel live:<organizationId>); the process that serves the dashboard's
 * event stream (GET /live/events) subscribes and forwards them to the open dashboards of that organization only.
 * WhatsApp and Sarvam webhooks may land on a different process than the dashboard, so Redis is the bus; in a single
 * process (or when Redis is down) the local emitter still delivers. Events carry only what the dashboard shows in a
 * notice (order number, channel, total, customer first name): every page reloads its data through the normal,
 * authenticated API.
 */
export type LiveEvent = {
  type: 'order.created' | 'order.updated' | 'cart.updated' | 'message' | 'call.started' | 'call.ended' | 'change' | 'alert' | 'office.plan' | 'office.task' | 'office.agent' | 'office.approval';
  /** Jarvis alert / AI Office headline (no customer data). */
  title?: string;
  /** AI Office: the plan / task the event is about (pages reload them through the normal API). */
  planId?: string;
  taskId?: string;
  role?: string;
  orderId?: string;
  orderNumber?: string;
  channel?: string;
  status?: string;
  total?: number;
  customer?: string;
  at?: string;
};

const PREFIX = 'live:';
const local = new EventEmitter();
local.setMaxListeners(0);
/** Ids of events this process published and already delivered locally (so the Redis copy is not delivered twice). */
const mine = new Set<string>();
let subscribed: Promise<void> | null = null;

const quick = <T>(p: Promise<T>, ms = 800) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error('redis timeout')), ms))]);
const firstName = (n: unknown) => (typeof n === 'string' ? n.trim().split(/\s+/)[0]?.slice(0, 30) : undefined) || undefined;

/**
 * Taps see every event published in this process (the AI Office turns some into durable, versioned business events).
 * A tap must be quick and must not throw; it never sees events from other processes, so nothing is recorded twice.
 */
const taps: Array<(organizationId: string, event: LiveEvent) => void> = [];
export function registerLiveTap(fn: (organizationId: string, event: LiveEvent) => void): () => void {
  taps.push(fn);
  return () => { const i = taps.indexOf(fn); if (i >= 0) taps.splice(i, 1); };
}

/** Fire and forget: never throws, never delays the caller by more than a moment. */
export function publishLive(organizationId: string, event: LiveEvent): void {
  if (!organizationId) return;
  for (const t of taps) { try { t(organizationId, event); } catch { /* a tap never breaks the publisher */ } }
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { ...event, customer: firstName(event.customer), at: event.at ?? new Date().toISOString() };
  local.emit(organizationId, payload);
  if (process.env.LIVE_EVENTS_REDIS === 'false') return;
  mine.add(id);
  setTimeout(() => mine.delete(id), 30_000).unref?.();
  void (async () => {
    try {
      const { queueRedis } = await import('../queues/queues.js');
      await quick(queueRedis.publish(PREFIX + organizationId, JSON.stringify({ id, organizationId, event: payload })));
    } catch {
      /* Redis down: local delivery above still happened; dashboards also poll */
    }
  })();
}

/** One Redis subscriber per process, started when the first dashboard connects. */
function ensureSubscribed() {
  if (subscribed || process.env.LIVE_EVENTS_REDIS === 'false') return;
  subscribed = (async () => {
    try {
      const { createRedisConnection } = await import('../queues/queues.js');
      const sub = createRedisConnection('live-events');
      sub.on('pmessage', (_pattern: string, _channel: string, raw: string) => {
        try {
          const m = JSON.parse(raw) as { id: string; organizationId: string; event: LiveEvent };
          if (mine.has(m.id)) return; // published here: already delivered locally
          local.emit(m.organizationId, m.event);
        } catch { /* ignore malformed */ }
      });
      await sub.psubscribe(PREFIX + '*');
    } catch (e) {
      subscribed = null;
      log.warn('live.subscribe_failed', { error: errorMessage(e) });
    }
  })();
}

/** Listen to one organization's events. Returns the unsubscribe function. */
export function onLive(organizationId: string, fn: (e: LiveEvent) => void): () => void {
  ensureSubscribed();
  local.on(organizationId, fn);
  return () => local.off(organizationId, fn);
}
