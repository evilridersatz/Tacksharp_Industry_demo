import crypto from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { recordWebhookFailure } from './webhook-failures.js';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Verifies Meta's X-Hub-Signature-256 header (WhatsApp + Lead Ads webhooks).
 * Enforced only when META_APP_SECRET is set, so local testing with curl still works.
 */
export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined, extraSecrets: string[] = []) {
  // The deployment's app secret, plus the app secret of the organization that owns the number (its own WhatsApp app).
  const secrets = [config.whatsapp.appSecret, ...extraSecrets].filter((s): s is string => Boolean(s));
  if (!secrets.length) return;
  if (!rawBody || !header?.startsWith('sha256=')) {
    log.warn('meta.signature_missing', {});
    recordWebhookFailure('whatsapp', 'signature_missing', '/webhooks/whatsapp');
    throw new UnauthorizedException('Missing signature');
  }
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  for (const secret of secrets) {
    const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
    if (expected.length === received.length && crypto.timingSafeEqual(expected, received)) return;
  }
  log.warn('meta.signature_invalid', {});
  recordWebhookFailure('whatsapp', 'signature_invalid', '/webhooks/whatsapp');
  throw new UnauthorizedException('Invalid signature');
}
