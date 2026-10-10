/**
 * Conversation session: everything the application (not the model) knows about where a
 * call / WhatsApp thread is. It is the single source of truth for the state machine, the
 * pending visit proposal and the slots, and it is scoped to ONE call (voice) or ONE thread
 * (WhatsApp / web). History from earlier calls is never part of it.
 */
import type { Slots, SlotName } from './slots.js';
import type { LanguageState } from './language.js';
import type { WhenDraft } from './when.js';

export type Channel = 'voice' | 'whatsapp' | 'web';

/**
 * GREETING -> QUALIFICATION -> PROPERTY_DISCUSSION -> VISIT_PROPOSAL -> VISIT_CONFIRMATION -> BOOKING -> COMPLETED
 * with side exits HANDOFF / CALLBACK / NOT_INTERESTED. PROPERTY_SEARCH is transient (inside one turn).
 */
export type ConvState =
  | 'GREETING'
  | 'QUALIFICATION'
  | 'PROPERTY_SEARCH'
  | 'PROPERTY_DISCUSSION'
  | 'VISIT_PROPOSAL'
  | 'VISIT_CONFIRMATION'
  | 'BOOKING'
  | 'COMPLETED'
  | 'HANDOFF'
  | 'CALLBACK'
  | 'NOT_INTERESTED';

export const TERMINAL_STATES: ReadonlySet<ConvState> = new Set(['COMPLETED', 'HANDOFF', 'CALLBACK', 'NOT_INTERESTED']);

export type PresentedProperty = {
  id: string;
  name: string;
  location: string;
  type: string;
  bhk: number;
  price: number;
  priceText: string;
};

export type VisitProposal = {
  /** Idempotency key for the booking this proposal can turn into. */
  id: string;
  propertyId: string;
  propertyName: string;
  /** ISO-8601 with +05:30. */
  scheduledAt: string;
  /** Turn number in which the proposal was made. A confirmation must come in a LATER turn. */
  createdTurn: number;
  /** Turn in which the confirmation question was last spoken. A "yes" only counts in the very next turn. */
  askedTurn: number;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'declined' | 'expired' | 'booked' | 'superseded';
  siteVisitId?: string;
};

export type SessionMessage = { role: 'user' | 'assistant'; content: string };

export type Session = {
  v: 1;
  key: string;
  channel: Channel;
  organizationId: string;
  organizationName: string;
  customerId: string;
  leadId: string;
  conversationId: string;
  callId?: string;
  customerName?: string;
  createdAt: string;
  updatedAt: string;
  turn: number;
  state: ConvState;
  slots: Slots;
  /** Signature of the criteria used by the last search; a new search runs only when it changes. */
  searchedFor?: string;
  presented: PresentedProperty[];
  /** A hot-lead alert was already considered for this session. */
  hotAlerted?: boolean;
  focusPropertyId?: string;
  draft?: WhenDraft;
  proposal?: VisitProposal;
  language: LanguageState;
  /** Consecutive turns whose (weak) transcript held nothing usable; asked again by rules instead of guessing with the model. */
  unclearTurns: number;
  /** The slot we last asked about (so a bare "80" is read as a budget) and how often. */
  askedSlot?: SlotName;
  askedCount: Partial<Record<SlotName, number>>;
  /** Last messages of THIS session only (what the model sees as history). */
  recent: SessionMessage[];
  lastAssistant?: string;
  outcome?: string;
  /** true once the call/thread is finished (booking done, handoff, callback, not interested). */
  closing?: boolean;
  /** We asked "is this what you are looking for?" about details already on file; a "yes" now starts the search. */
  awaitingRequirementConfirm?: boolean;
  /** The enquiry details were already read back once in this conversation: never again (real call 2026-10-10 loop). */
  requirementChecked?: boolean;
  /** We said nothing matches and asked to change area / budget: the next "yes" gets real options, not the read-back. */
  awaitingAdjust?: boolean;
  /** We asked "when can we call?" after a "no" to "can we talk now?". */
  /** Properties the customer turned down in this conversation ("அது வேண்டாம்"): never offered again. */
  rejectedPropertyIds?: string[];
  /** Areas the customer turned down ("Porur வேண்டாம்"): not suggested again. */
  rejectedLocations?: string[];
  /** The customer has said something with real language evidence in this conversation (for languageChanged). */
  languageSeen?: boolean;
  awaitingCallbackTime?: boolean;
  /** inbound = the customer called us; outbound = we called them (the opening asked for consent to talk). */
  direction?: 'inbound' | 'outbound';
  /** Properties were presented with the question "would you like a site visit?": a "yes" starts the visit flow (still no booking). */
  offeredVisit?: boolean;
  /** Consecutive turns in which a visit was wanted but the rules could not read a date/time. */
  visitMisses?: number;
  /** Consecutive failed model calls (the first one is retried by asking again; the second hands off to a human). */
  llmFailures?: number;
};

export const SESSION_TTL_SEC: Record<Channel, number> = { voice: 3 * 3600, whatsapp: 48 * 3600, web: 6 * 3600 };

/** Visit proposals expire: voice within minutes, WhatsApp within a day. */
export const PROPOSAL_TTL_MS: Record<Channel, number> = { voice: 15 * 60_000, whatsapp: 24 * 3600_000, web: 3600_000 };

export const RECENT_LIMIT: Record<Channel, number> = { voice: 6, whatsapp: 8, web: 8 };

export function sessionKey(input: { channel: Channel; organizationId: string; phone: string; callId?: string }): string {
  if (input.channel === 'voice' && input.callId) return `call:${input.callId}`;
  return `${input.channel}:${input.organizationId}:${input.phone.replace(/\D/g, '')}`;
}

export function newSession(init: {
  key: string;
  channel: Channel;
  organizationId: string;
  organizationName: string;
  customerId: string;
  leadId: string;
  conversationId: string;
  callId?: string;
  customerName?: string;
  slots: Slots;
  language: LanguageState;
  recent?: SessionMessage[];
  state?: ConvState;
  now?: Date;
}): Session {
  const at = (init.now ?? new Date()).toISOString();
  return {
    v: 1,
    key: init.key,
    channel: init.channel,
    organizationId: init.organizationId,
    organizationName: init.organizationName,
    customerId: init.customerId,
    leadId: init.leadId,
    conversationId: init.conversationId,
    callId: init.callId,
    customerName: init.customerName,
    createdAt: at,
    updatedAt: at,
    turn: 0,
    state: init.state ?? (init.channel === 'voice' ? 'GREETING' : 'QUALIFICATION'),
    slots: init.slots,
    presented: [],
    language: init.language,
    unclearTurns: 0,
    askedCount: {},
    recent: init.recent ?? [],
  };
}

export function pushRecent(session: Session, role: 'user' | 'assistant', content: string) {
  session.recent.push({ role, content: content.slice(0, 400) });
  const limit = RECENT_LIMIT[session.channel];
  if (session.recent.length > limit) session.recent.splice(0, session.recent.length - limit);
}

export function criteriaSignature(s: Slots): string {
  return [s.location ?? '', s.bhk ?? '', s.propertyType ?? '', s.budget ?? ''].join('|');
}

/** Is there a proposal that can still be confirmed in this turn? */
export function activeProposal(session: Session, now: Date = new Date()): VisitProposal | undefined {
  const p = session.proposal;
  if (!p || p.status !== 'pending') return undefined;
  if (new Date(p.expiresAt).getTime() <= now.getTime()) return undefined;
  return p;
}
