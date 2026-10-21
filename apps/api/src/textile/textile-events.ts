import { Injectable } from '@nestjs/common';
import { errorMessage, log } from '../common/logger.js';

export type OrderStatusEvent = { organizationId: string; orderId: string; orderNumber: string; from: string; to: string; actor: string };
type Listener = (e: OrderStatusEvent) => Promise<unknown>;

/**
 * Business events from textile sales, consumed by the AI Orchestrator (Operations reserves stock on confirmation,
 * releases it on cancellation, deducts it on dispatch). `before` listeners may refuse a change (throw); `after`
 * listeners run once the change is saved and never undo it - their failures are recorded on the agent task.
 */
@Injectable()
export class TextileEvents {
  private readonly before: Listener[] = [];
  private readonly after: Listener[] = [];

  onBeforeOrderStatus(fn: Listener) {
    this.before.push(fn);
  }
  onOrderStatus(fn: Listener) {
    this.after.push(fn);
  }

  async beforeOrderStatus(e: OrderStatusEvent) {
    for (const fn of this.before) await fn(e);
  }

  async orderStatus(e: OrderStatusEvent) {
    for (const fn of this.after) {
      await fn(e).catch((err) => log.error('textile.event_listener_failed', { orderId: e.orderId, to: e.to, error: errorMessage(err) }));
    }
  }
}
