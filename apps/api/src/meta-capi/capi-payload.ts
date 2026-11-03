import { createHash } from 'node:crypto';

/** SHA-256 hex of a normalised value, as Meta requires for customer information parameters. */
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Phone: digits only with country code, no leading zeros (Meta's normalisation). Indian 10-digit numbers get 91. */
export function normPhone(phone: string | null | undefined): string | null {
  let d = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) d = `91${d}`;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export function normEmail(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** Where the conversion happened, in Meta's action_source vocabulary. */
export function actionSourceFor(channel: string | null | undefined): string {
  const c = (channel ?? '').toLowerCase();
  if (/whatsapp|chat|web|instagram|messenger/.test(c)) return 'chat';
  if (/phone|voice|call/.test(c)) return 'phone_call';
  if (/walk|store|counter|pos/.test(c)) return 'physical_store';
  return 'system_generated';
}

export type CapiEventRow = {
  eventId: string;
  eventName: string;
  eventTime: Date;
  actionSource: string;
  value: { toString(): string } | null;
  currency: string | null;
  orderRef: string | null;
};

/** One server event. Only hashed customer data leaves the server; nothing is stored unhashed for Meta. */
export function buildEvent(e: CapiEventRow, c: { id: string; phone: string | null; email: string | null }) {
  const ph = normPhone(c.phone);
  const em = normEmail(c.email);
  const user_data: Record<string, string[]> = { external_id: [sha256(c.id)], country: [sha256('in')] };
  if (ph) user_data.ph = [sha256(ph)];
  if (em) user_data.em = [sha256(em)];
  const custom_data: Record<string, unknown> = {};
  if (e.value !== null) {
    custom_data.value = Number(e.value.toString());
    custom_data.currency = e.currency ?? 'INR';
  }
  if (e.orderRef) custom_data.order_id = e.orderRef;
  return {
    event_name: e.eventName,
    event_time: Math.floor(e.eventTime.getTime() / 1000),
    event_id: e.eventId,
    action_source: e.actionSource,
    user_data,
    ...(Object.keys(custom_data).length ? { custom_data } : {}),
  };
}

/** The connection-test event (sent only with a test event code). */
export function testEvent() {
  return buildEvent(
    { eventId: `tacksharp-test-${Date.now()}`, eventName: 'Lead', eventTime: new Date(), actionSource: 'system_generated', value: null, currency: null, orderRef: null },
    { id: 'tacksharp-connection-test', phone: null, email: null },
  );
}
