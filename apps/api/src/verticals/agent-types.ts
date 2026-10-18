import type { Customer } from '@prisma/client';

export type Style = 'en' | 'tl';
export type AgentChannel = 'whatsapp' | 'voice' | 'web';

export type AgentCtx = {
  org: string;
  orgName: string;
  isDemo: boolean;
  customer: Customer;
  leadId: string;
  conversationId: string;
  channel: AgentChannel;
  text: string;
  style: Style;
  voice: boolean;
  now: Date;
};

export type AgentOut<S> = {
  reply: string;
  state: S;
  intent: string;
  handoff?: { reason: string; urgent?: boolean };
  endCall?: boolean;
  outcome?: 'order_placed' | 'booked' | 'human_requested' | 'cancelled';
  record?: { type: 'order' | 'reservation' | 'appointment' | 'insurance_case'; id: string; reference: string; status: string; result: 'created' | 'duplicate' | 'updated' };
};

/** Pick the reply for the conversation's style (English or Tanglish). */
export const t = (style: Style, en: string, tl?: string) => (style === 'tl' && tl ? tl : en);

/** Voice replies drop emoji / bullets and list separators so text-to-speech reads them naturally. */
export const spoken = (text: string) =>
  text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/^\s*[•\-*]\s*/gm, '')
    .replace(/\n+/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.\s*\./g, '.')
    .trim();

/** Replace a state object's contents in place (the turn's reply closures keep the same reference). */
export function resetState<S extends object>(s: S, fresh: S, keep: Partial<S> = {}) {
  for (const k of Object.keys(s)) delete (s as Record<string, unknown>)[k];
  Object.assign(s, fresh, keep);
}
