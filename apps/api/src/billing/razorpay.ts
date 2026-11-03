import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay Payment Links for Tacksharp's OWN invoices (platform account, from the environment; never a tenant's keys).
 * API per https://razorpay.com/docs/api/payments/payment-links/create-standard : POST /v1/payment_links with HTTP basic
 * auth (key id : key secret), amount in paise (minimum 100), reference_id at most 40 characters and unique per link.
 * Webhooks are signed with X-Razorpay-Signature = hex HMAC-SHA256 of the raw body with the webhook secret.
 */
export type RazorpayConfig = { keyId: string; keySecret: string; webhookSecret: string; base: string };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function razorpayConfig(env: NodeJS.ProcessEnv = process.env): RazorpayConfig | null {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim() ?? '';
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret, webhookSecret, base: (env.RAZORPAY_API_BASE || 'https://api.razorpay.com').replace(/\/$/, '') };
}

export const toPaise = (rupees: number) => Math.round(rupees * 100);

export type LinkRequest = { amountPaise: number; referenceId: string; description: string; expireBy: number; customer?: { name?: string; email?: string }; notes: Record<string, string> };
export type LinkResult = { ok: true; id: string; shortUrl: string; status: string } | { ok: false; message: string; ambiguous: boolean };

export async function createPaymentLink(fetchImpl: FetchLike, cfg: RazorpayConfig, r: LinkRequest): Promise<LinkResult> {
  if (r.referenceId.length > 40) return { ok: false, message: 'reference_id longer than 40 characters', ambiguous: false };
  if (!Number.isInteger(r.amountPaise) || r.amountPaise < 100) return { ok: false, message: 'Amount must be at least ₹1.', ambiguous: false };
  const body = {
    amount: r.amountPaise,
    currency: 'INR',
    accept_partial: false,
    reference_id: r.referenceId,
    description: r.description.slice(0, 2048),
    expire_by: r.expireBy,
    ...(r.customer?.email || r.customer?.name ? { customer: { ...(r.customer.name ? { name: r.customer.name } : {}), ...(r.customer.email ? { email: r.customer.email } : {}) } } : {}),
    // Tacksharp shares the link itself; Razorpay sends no SMS / email on its own.
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: Object.fromEntries(Object.entries(r.notes).slice(0, 15).map(([k, v]) => [k, String(v).slice(0, 255)])),
  };
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.base}/v1/payment_links`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // The request may or may not have reached Razorpay: never retried automatically (the reference id is unique anyway).
    return { ok: false, message: `Razorpay could not be reached (${e instanceof Error ? e.name : 'error'}). Check the Razorpay dashboard before trying again.`, ambiguous: true };
  }
  const j = (await res.json().catch(() => ({}))) as { id?: string; short_url?: string; status?: string; error?: { description?: string; code?: string } };
  if (res.ok && j.id && j.short_url) return { ok: true, id: j.id, shortUrl: j.short_url, status: j.status ?? 'created' };
  return { ok: false, message: `Razorpay refused the payment link: ${(j.error?.description ?? `HTTP ${res.status}`).slice(0, 200)}`, ambiguous: res.status >= 500 };
}

/** Constant-time check of X-Razorpay-Signature over the exact raw body. */
export function validRazorpaySignature(rawBody: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!rawBody || !header || !secret || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const received = Buffer.from(header, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
