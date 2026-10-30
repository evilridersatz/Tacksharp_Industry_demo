import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sarvam does not document a webhook signature, so the webhook URL we give it carries an HMAC token over
 * (provider, organization, scope). The secret (TELEPHONY_WEBHOOK_SECRET, >= 32 chars) never leaves the server; a
 * request without a valid token is rejected before anything is read from its body. Without the secret, Sarvam
 * calls are refused (fail closed).
 */
export function webhookSecret(): string | null {
  const s = process.env.TELEPHONY_WEBHOOK_SECRET ?? '';
  return s.length >= 32 ? s : null;
}

export function webhookToken(organizationId: string, scope: string, secret = webhookSecret()): string | null {
  if (!secret) return null;
  return createHmac('sha256', secret).update(`sarvam|${organizationId}|${scope}`).digest('hex');
}

export function verifyWebhookToken(organizationId: string, scope: string, token: unknown, secret = webhookSecret()): boolean {
  const expected = webhookToken(organizationId, scope, secret);
  if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
