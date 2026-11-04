/**
 * After Sarvam reports the outcome of a call WE placed (post-call webhook), the module that asked for the call can
 * act on it (e.g. a feedback call -> the rating on the order). A plain in-process list: the telephony module does
 * not depend on the modules that listen (no circular imports).
 */
export type OutboundResult = {
  organizationId: string;
  requestId: string;
  idempotencyKey: string;
  status: string;
  callId: string | null;
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
};
type Listener = (r: OutboundResult) => Promise<void>;
const listeners: Listener[] = [];
export function onOutboundResult(fn: Listener) { if (!listeners.includes(fn)) listeners.push(fn); }
export async function emitOutboundResult(r: OutboundResult) { for (const fn of listeners) await fn(r); }
