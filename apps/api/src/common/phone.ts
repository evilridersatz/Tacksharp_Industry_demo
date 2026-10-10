import { config } from './config.js';

/**
 * Normalize any Indian/international phone format to digits-only E.164
 * without '+', e.g. "919876543210".
 *
 * This is the ONE format stored in the database. WhatsApp sends "919876543210",
 * Plivo uses "919876543210", Meta Lead forms send "+91 98765 43210".
 * Without this, the same person becomes three different customers.
 */
export function normalizePhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return undefined;

  digits = digits.replace(/^00/, '');

  // 0XXXXXXXXXX (Indian trunk prefix)
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  // Bare 10-digit national number
  if (digits.length === 10) {
    digits = `${config.defaultCountryCode}${digits}`;
  }
  if (digits.length < 10 || digits.length > 15) {
    return undefined;
  }
  return digits;
}

/** Plivo and Meta accept digits-only international numbers. */
export function toDialNumber(normalized: string): string {
  return normalized;
}
