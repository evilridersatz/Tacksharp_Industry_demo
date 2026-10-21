import crypto from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Verifies Meta's X-Hub-Signature-256 header (WhatsApp + Lead Ads webhooks).
 * Enforced only when META_APP_SECRET is set, so local testing with curl still works.
 */
export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined) {
  if (!config.whatsapp.appSecret) return;
  if (!rawBody || !header?.startsWith('sha256=')) {
    log.warn('meta.signature_missing', {});
    throw new UnauthorizedException('Missing signature');
  }
  const expected = crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const received = header.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    log.warn('meta.signature_invalid', {});
    throw new UnauthorizedException('Invalid signature');
  }
}
