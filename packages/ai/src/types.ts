/**
 * Shared types between the agent package and the API.
 *
 * SAFETY MODEL: the language model can only (1) phrase a reply, (2) save a fact the customer
 * stated, (3) search verified inventory, and (4) PROPOSE a site visit. It cannot book a visit,
 * change a lead's status, hand off, schedule a callback, mark a customer not-interested or end a
 * call. Those are decided by the application from the customer's current utterance and the
 * server-side conversation state (see apps/api/src/conversation and ai/conversation-engine).
 *
 * Tools never talk to the database themselves. The API injects these callbacks into the run
 * context, so the organization / customer are always taken from the context, never from
 * LLM-generated arguments.
 */

export type Channel = 'whatsapp' | 'voice' | 'web';

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'property_interested'
  | 'site_visit'
  | 'callback'
  | 'human_handoff'
  | 'not_interested'
  | 'won'
  | 'lost';

/** Statuses the application sets on the AI's behalf (never the model directly). */
export type AiSettableLeadStatus = 'qualified' | 'property_interested';

export type CallOutcome =
  | 'interested'
  | 'not_interested'
  | 'callback_requested'
  | 'human_requested'
  | 'qualified'
  | 'site_visit_requested'
  | 'site_visit_booked'
  | 'wrong_number'
  | 'connected'
  /** Restaurant: the customer confirmed an order on the call (created by the order service, not the model). */
  | 'order_placed';

export type CustomerMemoryUpdate = {
  name?: string;
  language?: string;
  location?: string;
  /** Number in rupees OR raw text such as "80 lakhs", "1.2 cr", "80L". Parsed by the backend. */
  budget?: number | string;
  /** Number OR raw text such as "2BHK", "2 bedroom". Parsed by the backend. */
  bhk?: number | string;
  propertyType?: string;
  purchaseTimeline?: string;
  objection?: string;
  interestedPropertyId?: string;
};

export type PropertySearchQuery = {
  location?: string;
  bhk?: number;
  propertyType?: string;
  maxBudget?: number;
};

export type CallContext = {
  direction: 'outbound' | 'inbound';
  callId: string;
  /** Why we are calling, in plain words, e.g. "Meta lead enquiry for 2 BHK in Porur". */
  reason: string;
};

/** Side effects of a turn, set by the application and read by the voice / WhatsApp layer. */
export type TurnActions = {
  endCall?: boolean;
  outcome?: CallOutcome;
  handoff?: boolean;
  callbackAt?: string;
  notInterested?: boolean;
  siteVisitBooked?: boolean;
  /** Id of an already-booked visit the customer confirmed (reply to the day-before message). */
  visitConfirmed?: string;
};

export type TacksharpAgentContext = {
  organizationId: string;
  organizationName: string;
  channel: Channel;
  phone?: string;
  /** Human-readable current date/time in IST, injected into instructions. */
  nowText: string;
  /** ISO timestamp with +05:30 offset. */
  nowIso: string;
  /** Pre-rendered compact turn brief (state, known facts, next question, verified properties, pending visit). */
  brief: string;
  /** How to write the reply: language + channel style, rendered by the application. */
  styleLine: string;
  actions: TurnActions;
  /** Set by propose_site_visit: the application's own wording, used instead of the model's text. */
  replyOverride?: string;

  updateCustomerMemory: (update: CustomerMemoryUpdate) => Promise<unknown>;
  searchProperties: (query: PropertySearchQuery) => Promise<unknown>;
  /** Validates and stores a PENDING proposal. It never books. Returns the confirmation question to ask. */
  proposeSiteVisit: (input: { propertyId: string; scheduledAt: string }) => Promise<{ ok: boolean; reply: string }>;
};
