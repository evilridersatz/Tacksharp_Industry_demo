/**
 * Rejected / failed webhook deliveries since this API process started (bad or missing signature, unknown number),
 * for the platform console. In memory and bounded: the authoritative record is the log (same event names). Never
 * holds payloads, phone numbers or secrets.
 */
export type WebhookFailure = { at: string; source: 'whatsapp' | 'plivo' | 'meta_leads' | 'plivo_test_call' | 'sarvam'; reason: string; path: string };

const MAX = 200;
const ring: WebhookFailure[] = [];
const totals = new Map<string, number>();
const since = new Date().toISOString();

export function recordWebhookFailure(source: WebhookFailure['source'], reason: string, path: string) {
  ring.push({ at: new Date().toISOString(), source, reason: reason.slice(0, 80), path: path.split('?')[0].slice(0, 80) });
  if (ring.length > MAX) ring.shift();
  const k = `${source}:${reason}`;
  totals.set(k, (totals.get(k) ?? 0) + 1);
}

export function webhookFailures() {
  return { since, recent: [...ring].reverse().slice(0, 50), totals: Object.fromEntries(totals) };
}
