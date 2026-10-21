/**
 * Adapter boundary for payment providers / bank feeds (Razorpay, Cashfree, a bank statement API...).
 *
 * NONE IS CONNECTED. Payments are verified only by the manual workflow (an authorised person, with evidence).
 * A future adapter must, before anything is marked verified:
 *   1. verify the webhook signature with the provider's secret (kept server-side, never logged);
 *   2. fetch / confirm the transaction from the provider (not from the customer's message);
 *   3. match amount, currency and reference to the invoice;
 * and then call FinanceService.verifyFromProvider (to be added with the first real adapter).
 */
export type ProviderTransaction = {
  provider: string;
  transactionId: string;
  amount: number;
  currency: string;
  reference?: string;
  paidAt: Date;
  status: 'captured' | 'failed' | 'refunded';
};

export interface PaymentProviderAdapter {
  readonly name: string;
  /** True only when credentials are configured on the server. */
  isConfigured(): boolean;
  /** Verify a webhook's signature against the raw body. Must never trust an unsigned payload. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  /** Read the transaction from the provider itself. */
  fetchTransaction(transactionId: string): Promise<ProviderTransaction | null>;
}

/** The providers configured in this deployment. Empty: no gateway or bank integration exists yet. */
export const PAYMENT_PROVIDERS: PaymentProviderAdapter[] = [];
