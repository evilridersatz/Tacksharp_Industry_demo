import { Injectable } from '@nestjs/common';
import { errorMessage, log } from '../common/logger.js';

export type PaymentVerifiedEvent = { organizationId: string; paymentId: string; invoiceId: string; orderId: string; actor: string };
type Listener = (e: PaymentVerifiedEvent) => Promise<unknown>;

/** Finance events for the Orchestrator. Listeners run after the change is saved; their failures never undo it. */
@Injectable()
export class FinanceEvents {
  private readonly verified: Listener[] = [];

  onPaymentVerified(fn: Listener) {
    this.verified.push(fn);
  }

  async paymentVerified(e: PaymentVerifiedEvent) {
    for (const fn of this.verified) {
      await fn(e).catch((err) => log.error('finance.event_listener_failed', { paymentId: e.paymentId, error: errorMessage(err) }));
    }
  }
}
