import { Injectable } from '@nestjs/common';
import { retryTransient } from '../common/retry.js';
import { isHotLead } from '../settings/tenant-settings.js';
import { randomUUID } from 'node:crypto';
import type { CallContext, Channel, TacksharpAgentContext, Toolset, TurnActions, CallOutcome } from 'ai/agents/real-estate-agent.js';

import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { PropertiesService } from '../properties/properties.service.js';
import { SiteVisitsService } from '../site-visits/site-visits.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { config } from '../common/config.js';
import { nowInIst } from '../common/time.js';
import { formatRupeesShort, parseIndianBudget } from '../common/parsers.js';
import { shapeChatReply } from '../whatsapp/message-templates.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { errorMessage, log, timer } from '../common/logger.js';

import { SessionStore } from './session.store.js';
import { LlmRunner, type AiUsageMetrics } from './llm-runner.service.js';
import { asksLocation, asksPrice, classifyIntent, commonQuestion, isLineCheck, isBareNo, isExplicitAffirmation, isExplicitNegation, isPropertyRejection, leadingAffirmation, parseCallbackTime, refersToShownProperty, type Intent } from '../conversation/intent.js';
import { extractSlots, qualificationState, type Slots } from '../conversation/slots.js';
import { detectLanguage, initialLanguage, updateLanguage, turnLanguage, replyStyle, callLanguageCode, type Lang, type TurnLanguage } from '../conversation/language.js';
import { describeWhen, mentionsWhen, mergeWhen, parseWhen, resolveWhen } from '../conversation/when.js';
import { findNamedProperty, matchPresented } from '../conversation/property-match.js';
import { norm } from '../conversation/text.js';
import * as say from '../conversation/replies.js';
import {
  PROPOSAL_TTL_MS,
  TERMINAL_STATES,
  activeProposal,
  criteriaSignature,
  newSession,
  pushRecent,
  sessionKey,
  type PresentedProperty,
  type Session,
  type VisitProposal,
} from '../conversation/session.js';

export type GenerateResponseInput = {
  organizationId?: string;
  channel: Channel;
  phone: string;
  message: string;
  customerName?: string;
  callContext?: CallContext;
  /** Lead the call/thread belongs to (verified against the customer before use). */
  leadId?: string;
  /** Message metadata stored with the user message (e.g. WhatsApp message id, STT language). */
  metadata?: Record<string, unknown>;
  /** Transcript gate verdict from the voice layer. 'weak' transcripts never drive destructive actions, bookings or language. */
  quality?: 'ok' | 'weak';
};

export type GenerateResponseResult = {
  conversationId: string;
  customerId: string;
  leadId: string;
  response: string;
  actions: TurnActions;
  timings: Record<string, number>;
  /** Present when the model actually ran (absent for rule-handled turns). */
  aiUsage?: AiUsageMetrics;
  failed?: boolean;
  /** Which path produced the reply: deterministic rules or the language model. */
  path?: 'rules' | 'llm';
  state?: string;
  intent?: string;
  /** Voice code for the Call record, only when the language is established (ta-IN / en-IN). */
  language?: string;
  /** Booking result of this turn, if any. */
  booking?: 'booked' | 'duplicate' | 'rejected';
  /** Set when the model proposed a visit this turn: the system's own question is then the reply, whatever the model wrote. */
  proposedReply?: string;
  /** Per-turn language decision (the reply follows the customer's current utterance). */
  languageInfo?: { current: string; previous: string; reply: string; changed: boolean; reason: string };
  /** Why this turn needed the model (only on model turns). */
  llmFallbackReason?: LlmFallbackReason;
  /** The reply was replaced because it repeated the previous one word for word. */
  deduped?: boolean;
};

const FALLBACK_REPLY = {
  whatsapp: 'Sorry, oru chinna technical issue. Namma team ungalai seekiram contact pannuvaanga 🙏',
  voice: 'Sorry, ஒரு சின்ன technical problem. நம்ம team உங்களுக்கு திரும்ப call பண்ணுவாங்க.',
  web: 'Sorry, something went wrong. Please try again.',
} as const;

/** Said when a written reply fails and NO follow-up task could be created, so it promises nothing. */
const FALLBACK_NO_PROMISE = 'Sorry, oru chinna technical issue. Konjam neram kazhichu message pannunga 🙏';

const HISTORY_CHARS = 280;
const VOICE_MAX_CHARS = 240;

type Plan =
  | { kind: 'say'; text: string; end?: boolean; noAck?: boolean }
  | { kind: 'llm'; toolset: Toolset; reask?: boolean; reason: LlmFallbackReason };

/** Why a turn was handed to the language model (logged on every model turn). */
export type LlmFallbackReason = 'UNKNOWN_QUESTION' | 'FREE_FORM_PROPERTY_QUESTION' | 'AMBIGUOUS_INTENT' | 'CONFIRMATION_SIDE_QUESTION' | 'QUALIFICATION_FREE_FORM';

type Turn = {
  input: GenerateResponseInput;
  session: Session;
  now: Date;
  /** The rules reply was a repeat of the last one and was replaced. */
  deduped?: boolean;
  turn: number;
  text: string;
  quality: 'ok' | 'weak';
  /** A weak transcript (e.g. STT labelled it te-IN) kept because it carries a day / time. Never enough to book on. */
  keptForTime?: boolean;
  /** The caller is checking the line ("Hello?", "sound இல்லையா?"): the same question again is right, not a repeat. */
  lineCheck?: boolean;
  /** A property from the whole inventory named in this utterance (not one already read out). */
  namedProperty?: PresentedProperty;
  /** Day / time heard in this utterance (also merged into session.draft outside the confirmation step). */
  visitHeard?: import('../conversation/when.js').WhenDraft;
  intent: Intent;
  /** Facts that are NEW or CHANGED this turn. */
  captured: Slots;
  /** Everything the customer stated this turn, even if it was already on file ("Porur la 2 BHK iruka?" when the form said the same). */
  stated: Slots;
  /** The customer's booked visit we asked them to confirm by WhatsApp the day before (chat channels only). */
  dayBeforeVisit?: Awaited<ReturnType<ConversationEngine['visitAwaitingConfirmation']>>;
  unknownLocation?: string;
  /** The customer changed or turned down the area in this turn ("Porur வேண்டாம், Velachery வேணும்", "vera area"). */
  areaChange?: { rejected: string[]; from?: string; to?: string };
  /** The customer turned down the property on offer ("அது வேண்டாம்", "not this one"). */
  propertyRejected?: boolean;
  actions: TurnActions;
  booking?: 'booked' | 'duplicate' | 'rejected';
  /** Set when the model proposed a visit this turn: the system's own question is then the reply, whatever the model wrote. */
  proposedReply?: string;
  llmFallbackReason?: LlmFallbackReason;
  /** Sentences removed from a model reply (unverified property / price, a question about something we already know). */
  replyDrops?: string[];
  aiRequests?: number;
  language?: TurnLanguage;
};

@Injectable()
export class ConversationEngine {
  /** One turn at a time per call / thread (a retried webhook waits for the first to finish). */
  private readonly mutex = new KeyedMutex();
  private readonly locationCache = new Map<string, { at: number; list: string[] }>();
  private readonly nameCache = new Map<string, { at: number; list: string[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly leads: LeadsService,
    private readonly properties: PropertiesService,
    private readonly siteVisits: SiteVisitsService,
    private readonly followUps: FollowUpsService,
    private readonly store: SessionStore,
    private readonly llm: LlmRunner,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------

  generate(input: GenerateResponseInput): Promise<GenerateResponseResult> {
    const organizationId = input.organizationId ?? config.defaultOrganizationId;
    const key = sessionKey({ channel: input.channel, organizationId, phone: input.phone, callId: input.callContext?.callId });
    return this.mutex.run(key, () => this.runTurn(input, organizationId, key));
  }

  /** Create the call-scoped session when the call is answered, so turn 1 needs no lookups. */
  async openCallSession(params: {
    organizationId: string;
    callId: string;
    phone: string;
    leadId?: string;
    customerName?: string;
    openingText?: string;
    direction?: 'inbound' | 'outbound';
  }) {
    const key = sessionKey({ channel: 'voice', organizationId: params.organizationId, phone: params.phone, callId: params.callId });
    const existing = await this.store.get(key);
    if (existing) return existing;
    const session = await this.createSession(
      { organizationId: params.organizationId, channel: 'voice', phone: params.phone, message: '', customerName: params.customerName, leadId: params.leadId, callContext: { direction: 'outbound', callId: params.callId, reason: '' } },
      params.organizationId,
      key,
      new Date(),
    );
    session.direction = params.direction ?? 'outbound';
    // The opening line is spoken in Tamil: a customer whose saved language is English (they type English on WhatsApp)
    // still gets Tamil replies to a neutral first answer ("yes"), consistent with what they just heard.
    if (params.openingText && /[\u0B80-\u0BFF]/u.test(params.openingText) && session.language.effective === 'english') {
      session.language = { ...session.language, effective: 'tanglish' };
    }
    if (params.openingText) {
      pushRecent(session, 'assistant', params.openingText);
      session.lastAssistant = params.openingText;
    }
    this.store.save(session);
    return session;
  }

  /** Run non-critical work (DB writes) off the reply path; hang-up and tests wait with settle(). */
  background(key: string, work: () => Promise<unknown>) {
    this.store.chain(key, work);
  }

  settle(key: string, timeoutMs?: number) {
    return this.store.settle(key, timeoutMs);
  }

  voiceSessionKey(organizationId: string, callId: string, phone: string) {
    return sessionKey({ channel: 'voice', organizationId, phone, callId });
  }

  /**
   * The reply of the last turn never reached the customer (TTS failed). A confirmation question in it does not count
   * as asked, so a later "yes" cannot book a visit the customer never heard; and it may be said again (no dedupe).
   */
  /**
   * Replies the rules will most likely give to the customer's first answer on an outbound call (details on file ->
   * "Porur, 2 BHK, 1 crore — is that right?"), in Tamil and English. Synthesizing them while the opening line plays
   * takes ~2 s of live TTS off the first turn (real call 2026-10-09: 1.9 s).
   */
  likelyFirstReplies(session: Session): string[] {
    if (session.channel !== 'voice' || !qualificationState(session.slots).complete) return [];
    const turn = session.turn + 1;
    // One language only: the one this customer is expected to answer in (their saved language; Tamil by default).
    // Synthesizing both on every answered call was a wasted Sarvam request competing with the opening line.
    const style = this.style(session) === 'en' ? 'en' : 'ta';
    return [`${say.ack(style, turn)} ${say.confirmRequirement(style, session.slots)}`];
  }

  async markReplyNotHeard(key: string) {
    const session = await this.store.get(key);
    if (!session) return;
    // Only a confirmation question that was cut off matters for safety (a later "yes" must not book it). An
    // ordinary interruption is normal conversation, not a warning.
    const unheardQuestion = session.proposal?.status === 'pending' && session.proposal.askedTurn === session.turn;
    if (unheardQuestion) session.proposal!.askedTurn = -1;
    session.lastAssistant = undefined;
    this.store.save(session);
    if (unheardQuestion) log.warn('engine.confirmation_not_heard', { callId: session.callId, turn: session.turn });
    else log.info('engine.reply_interrupted', { callId: session.callId, turn: session.turn });
  }

  async closeSession(key: string) {
    await this.store.settle(key);
    await this.store.delete(key);
  }

  // ---------------------------------------------------------------------------------------------
  // One turn
  // ---------------------------------------------------------------------------------------------

  private async runTurn(input: GenerateResponseInput, organizationId: string, key: string): Promise<GenerateResponseResult> {
    const t = timer();
    const now = new Date();
    const session = (await this.store.get(key)) ?? (await this.createSession(input, organizationId, key, now));
    t.lap('session');

    // A WhatsApp/web thread keeps going after an exchange ended; a voice call does not.
    if (session.channel !== 'voice' && TERMINAL_STATES.has(session.state)) {
      session.state = session.presented.length ? 'PROPERTY_DISCUSSION' : 'QUALIFICATION';
      session.closing = false;
    }

    session.turn += 1;
    const text = input.message.trim();
    let quality = input.quality ?? 'ok';
    const stateBefore = session.state;

    // 1. Language: the CURRENT utterance decides the reply language whenever it carries real evidence (Tamil script,
    //    Tanglish words, or a real English sentence); neutral turns ("60 lakhs", "Porur", "ok") keep the previous one.
    //    The same session, slots and booking state continue across every switch. Saving a language on the customer
    //    record still needs consistent evidence (updateLanguage). The STT label is never used.
    // Before the customer has said anything in a known language, "previous" is only a default guess: not a switch.
    const hadEvidence = Boolean(session.languageSeen || session.language.stored);
    const lang = turnLanguage(text, session.language.effective, quality);
    if (!hadEvidence && lang.changed) lang.changed = false;
    if (lang.current !== 'neutral') session.languageSeen = true;
    const lu = updateLanguage(session.language, detectLanguage(text), quality);
    session.language = { ...lu.state, effective: lang.reply };
    // A day / time is never thrown away because the STT language label was off ("Tomorrow 11 AM." labelled te-IN):
    // the words drive the visit flow. The label was already kept out of language learning above, and a kept-weak
    // transcript can never confirm a booking (handleConfirmation).
    let keptForTime = false;
    if (quality === 'weak' && mentionsWhen(text, now)) {
      quality = 'ok';
      keptForTime = true;
      log.info('engine.weak_transcript_kept', { reason: 'date_time', callId: session.callId });
    }
    if (lu.persist) {
      const persisted = lu.persist;
      this.background(key, () => this.conversations.updateCustomerMemory({ organizationId, customerId: session.customerId, update: { language: persisted } }));
    }

    // 2. Intent of the CURRENT utterance only.
    const proposal = activeProposal(session, now);
    const awaitingConfirm = session.state === 'VISIT_CONFIRMATION' && Boolean(proposal);
    if (quality === 'ok') session.unclearTurns = 0;
    // Did WE just ask a yes/no question? Then a bare "no" / "வேண்டாம்" answers that question; it is not
    // "not interested" (which would mark the customer do-not-contact). Strong refusals still count.
    const dayBeforeVisit =
      session.channel !== 'voice' && session.state !== 'VISIT_CONFIRMATION' && quality === 'ok' && text.split(/\s+/).length <= 12
        ? await this.visitAwaitingConfirmation(session, now).catch(() => undefined)
        : undefined;
    // While a property is on offer, a bare "வேண்டாம்" turns down THAT property; it is not "stop calling me".
    const offeringProperty = session.presented.length > 0 && (session.state === 'PROPERTY_DISCUSSION' || session.state === 'VISIT_PROPOSAL');
    const answeringOurQuestion = awaitingConfirm || Boolean(session.awaitingRequirementConfirm) || Boolean(dayBeforeVisit) || offeringProperty;
    let intent = classifyIntent(text, { closing: session.closing, awaitingVisitConfirmation: answeringOurQuestion }).intent;
    // Irreversible intents need a clean transcript; a garbled one is asked again instead.
    if (quality === 'weak' && (intent === 'NOT_INTERESTED' || intent === 'WRONG_NUMBER')) intent = 'UNKNOWN';

    // 3. Rules-first slot filling.
    const controlIntent = intent === 'NOT_INTERESTED' || intent === 'WRONG_NUMBER' || intent === 'HUMAN_REQUEST' || intent === 'CALLBACK_REQUEST' || intent === 'GOODBYE';
    const known = await this.knownLocations(organizationId);
    const extraction: ReturnType<typeof extractSlots> = controlIntent ? { slots: {} as Slots } : extractSlots(text, { knownLocations: known, expecting: session.askedSlot });
    const before = { ...session.slots };
    // A property named from the whole inventory ("Anna Nagar Residency") is a request for THAT property, not an area
    // filter: its area becomes the location (no "X வேண்டாம்", nothing recorded as turned down).
    const namedProperty =
      quality === 'ok' && !controlIntent
        ? await this.namedInventoryProperty(organizationId, text, session, known).catch(() => undefined)
        : undefined;
    if (namedProperty) {
      extraction.slots.location = namedProperty.location.split(',')[0].trim();
      delete extraction.rejectedLocations;
      delete extraction.wantsOtherArea;
      delete extraction.unknownLocation;
    }
    const captured = this.mergeSlots(session, extraction.slots);
    const areaChange = quality === 'ok' && !namedProperty ? this.applyAreaChange(session, before, captured, extraction) : undefined;
    const propertyRejected =
      quality === 'ok' && !areaChange && offeringProperty && Object.keys(captured).length === 0 &&
      (isPropertyRejection(text) || (intent === 'UNKNOWN' && /^(?:no |illa |இல்ல )?(?:வேண்டாம்|வேணாம்|vendam|venam|venda|vendaam|venaam)(?:ங்க| nga)?$/u.test(text.trim().toLowerCase().replace(/[.!,]/g, ''))));
    if (Object.keys(captured).length > 0 && !areaChange && !namedProperty) this.invalidateOnNewCriteria(session, captured);
    // A visit day/time is kept from ANY utterance, whatever step the call is in ("Tomorrow." while we asked which
    // property). The visit flow then asks only for what is still missing. The confirmation step reads its own.
    let visitHeard: ReturnType<typeof parseWhen> | undefined;
    if (quality === 'ok' && !controlIntent) {
      const heard = parseWhen(text, now);
      if (heard.date || heard.hour !== undefined || heard.ambiguousHour !== undefined) {
        visitHeard = heard;
        if (session.state !== 'VISIT_CONFIRMATION') session.draft = mergeWhen(session.draft, heard);
      }
    }
    t.lap('rules');

    const turn: Turn = { input, session, now, turn: session.turn, text, quality, keptForTime, visitHeard, namedProperty, intent, captured, stated: extraction.slots, dayBeforeVisit, language: lang, unknownLocation: extraction.unknownLocation, areaChange, propertyRejected, actions: {} };

    // 4. Decide: deterministic reply, or a (tool-limited) model call.
    let plan: Plan;
    try {
      plan = await this.plan(turn, known);
    } catch (error) {
      // Never turn an exception into a business action: say sorry and ask again.
      log.error('engine.plan_failed', { channel: session.channel, state: session.state, error: errorMessage(error) });
      plan = { kind: 'say', text: say.unclear(this.style(session)) };
    }
    t.lap('plan');

    let response = '';
    let failed = false;
    let aiUsage: AiUsageMetrics | undefined;
    let path: 'rules' | 'llm' = 'rules';

    if (plan.kind === 'say') {
      response = plan.text;
      if (plan.end && session.channel === 'voice') turn.actions.endCall = true;
    } else {
      path = 'llm';
      const run = await this.runModel(turn, plan);
      aiUsage = run.usage;
      response = run.text;
      failed = run.failed;
      if (run.end) turn.actions.endCall = true;
    }
    t.lap('reply');
    if (session.channel !== 'voice') response = shapeChatReply(response);

    // Never say the same thing twice in a row (unless the customer asked us to repeat it): move the conversation on.
    let deduped = false;
    // A turn that gave us new facts is answered on those facts, even if the answer reads the same (a new budget that
    // matches the same property): swapping it for "anything else?" ignored the customer (WhatsApp, 2026-10-09).
    // A day / time heard this turn is a new fact too ("நாளைக்கு 9 மணி" after we asked the area): never swapped away.
    const newFacts = Object.keys(turn.captured).length > 0 || mentionsWhen(text, now);
    if (intent !== 'REPEAT_REQUEST' && !turn.lineCheck && !newFacts && !turn.booking && !turn.actions.endCall && session.lastAssistant && similarReply(response, session.lastAssistant)) {
      for (const alt of [this.alternativeReply(turn), say.anythingElse(this.style(session))]) {
        if (alt && !similarReply(alt, session.lastAssistant)) {
          response = session.channel !== 'voice' ? shapeChatReply(alt) : alt;
          deduped = true;
          break;
        }
      }
    }
    turn.aiRequests = aiUsage?.requests ?? 0;
    turn.deduped = deduped;

    // Voice: a rule reply that has to be synthesized starts with a pre-recorded acknowledgement ("சரிங்க.", "சூப்பர்."),
    // which plays the moment the turn is decided while the rest is synthesized in parallel. Real call 2026-10-10:
    // the confirmation and booking lines took 1.3-1.6 s of Sarvam time before the customer heard anything.
    if (session.channel === 'voice' && path === 'rules' && intent !== 'REPEAT_REQUEST' && !(plan.kind === 'say' && plan.noAck)) {
      response = withSpokenAck(response, this.style(session), turn.booking === 'booked' ? 'booked' : turn.turn);
    }

    // 5. Bookkeeping that must not delay the reply.
    pushRecent(session, 'user', text);
    pushRecent(session, 'assistant', response);
    session.lastAssistant = response;
    if (turn.actions.outcome) session.outcome = turn.actions.outcome;
    this.persistTurn(turn, response, failed, path);
    this.checkHotLead(session);
    this.store.save(session);

    const timings = t.done();
    // Only report a language once real evidence exists; a default guess must not be recorded as the customer's language.
    const language = session.language.votes.length > 0 || session.language.stored ? callLanguageCode(session.language.effective) : undefined;
    log.info('ai.turn', {
      channel: session.channel,
      callId: session.callId,
      conversationId: session.conversationId,
      turn: turn.turn,
      stateBefore,
      state: session.state,
      stateAfter: session.state,
      intent,
      quality,
      path,
      lang: session.language.effective,
      currentLanguage: lang.current,
      previousLanguage: lang.previous,
      languageChanged: lang.changed,
      languageSwitchReason: lang.reason,
      llmFallbackReason: turn.llmFallbackReason,
      // Visit day / time are part of the canonical state too (session.draft): logged with the slots, so a turn like
      // "எனக்கு 13th October." no longer shows captured=[] while the date was in fact kept.
      captured: [...Object.keys(captured), ...(turn.visitHeard?.date ? ['visitDate'] : []), ...(turn.visitHeard?.hour !== undefined ? ['visitTime'] : [])],
      capturedSlots: captured,
      visitDraft: session.draft ? { date: session.draft.date, hour: session.draft.hour, minute: session.draft.minute } : undefined,
      deduped,
      replyDrops: turn.replyDrops,
      ...(config.logTranscripts ? { transcript: maskForLog(text), response: maskForLog(response) } : {}),
      booking: turn.booking,
      actions: turn.actions,
      failed,
      ...timings,
      aiRequests: aiUsage?.requests ?? 0,
      aiInputTokens: aiUsage?.inputTokens,
      aiOutputTokens: aiUsage?.outputTokens,
      aiToolCalls: aiUsage?.toolCalls?.length ?? 0,
      aiToolMs: aiUsage?.toolMs,
      aiPureMs: aiUsage?.pureAiMs,
      aiFirstToolCallMs: aiUsage?.firstToolCallMs,
    });

    return {
      conversationId: session.conversationId,
      customerId: session.customerId,
      leadId: session.leadId,
      response,
      actions: turn.actions,
      timings,
      aiUsage,
      failed,
      path,
      state: session.state,
      intent,
      language,
      booking: turn.booking,
      languageInfo: { current: lang.current, previous: lang.previous, reply: lang.reply, changed: lang.changed, reason: lang.reason },
      llmFallbackReason: turn.llmFallbackReason,
      deduped,
    };
  }

  /** Something to say instead of repeating the previous sentence: the next useful step for the current state. */
  private alternativeReply(turn: Turn): string {
    const { session } = turn;
    const style = this.style(session);
    const pending = activeProposal(session, turn.now);
    if (session.state === 'VISIT_CONFIRMATION' && pending) {
      pending.askedTurn = turn.turn; // still the system's own explicit confirmation question
      return session.channel === 'voice' ? say.confirmQuestionSpokenShort(style, pending.propertyName, new Date(pending.scheduledAt), turn.now) : say.confirmQuestionShort(style, pending.propertyName, new Date(pending.scheduledAt));
    }
    const focus = session.presented.find((x) => x.id === session.focusPropertyId) ?? session.presented[0];
    if (session.state === 'VISIT_PROPOSAL') {
      // Property not chosen yet: ask which one in other words (not "which day?").
      if (!session.focusPropertyId && session.presented.length > 1) return say.askWhichPropertyAgain(style, session.presented);
      // Ask only for what is still missing of the day/time.
      const r = resolveWhen(session.draft ?? {});
      const missing = 'at' in r ? 'both' : r.missing;
      const asked = say.askVisitWhen(style, missing, session.draft?.ambiguousHour);
      return session.lastAssistant && similarReply(asked, session.lastAssistant) && focus ? say.pickedAsk(style, focus.name, missing, session.draft?.ambiguousHour) : asked;
    }
    const q = qualificationState(session.slots);
    if (!q.complete) return say.askSlotAgain(style, q.next!);
    if (focus) {
      session.offeredVisit = true;
      return say.nextStepAfterOptions(style, focus.name);
    }
    return say.anythingElse(style);
  }

  // ---------------------------------------------------------------------------------------------
  // Decision cascade
  // ---------------------------------------------------------------------------------------------

  private async plan(turn: Turn, knownLocations: string[]): Promise<Plan> {
    const { session, intent, text, quality } = turn;
    const style = this.style(session);

    // A. Customer-driven endings. Executed by code, only on a clear utterance.
    if (intent === 'NOT_INTERESTED' || intent === 'WRONG_NUMBER') {
      const wrong = intent === 'WRONG_NUMBER';
      await this.markNotInterested(session, wrong ? 'wrong number' : 'customer said not interested');
      session.state = 'NOT_INTERESTED';
      session.closing = true;
      turn.actions.notInterested = true;
      turn.actions.outcome = wrong ? 'wrong_number' : 'not_interested';
      this.supersedePending(session, 'superseded');
      return { kind: 'say', text: say.notInterested(style, wrong), end: true };
    }
    if (intent === 'CANCELLATION_REQUEST') {
      await this.requestHandoff(session, 'Customer requested appointment cancellation; manual review required');
      session.state = 'HANDOFF';
      session.closing = true;
      turn.actions.handoff = true;
      turn.actions.outcome = 'human_requested';
      this.supersedePending(session, 'superseded');
      return { kind: 'say', text: say.cancellationRequested(style), end: true };
    }
    if (intent === 'HUMAN_REQUEST') {
      await this.requestHandoff(session, 'Customer asked for a human');
      session.state = 'HANDOFF';
      session.closing = true;
      turn.actions.handoff = true;
      turn.actions.outcome = 'human_requested';
      this.supersedePending(session, 'superseded');
      return { kind: 'say', text: say.handoff(style), end: true };
    }
    if (intent === 'CALLBACK_REQUEST') {
      const at = parseCallbackTime(text, turn.now);
      await this.scheduleCallback(session, at, text);
      session.state = 'CALLBACK';
      session.closing = true;
      turn.actions.outcome = 'callback_requested';
      if (at) turn.actions.callbackAt = at.toISOString();
      this.supersedePending(session, 'superseded');
      return { kind: 'say', text: say.callback(style, at), end: true };
    }
    if (intent === 'GOODBYE') {
      session.state = 'COMPLETED';
      session.closing = true;
      this.supersedePending(session, 'superseded');
      if (!turn.actions.outcome) turn.actions.outcome = this.bestOutcome(session);
      return { kind: 'say', text: say.goodbye(style), end: true };
    }

    // A1. Everyday side questions ("நீங்க AI-ஆ?", "நீங்க போறீங்களா?"): answered by rules, then the question we were
    // waiting on is asked again. Before the confirmation step, so "ஆ சரி. நீங்க போறீங்களா?" is never read as a yes.
    const common = commonQuestion(text);
    if (common === 'ai' || common === 'accompany') {
      return { kind: 'say', text: `${say.commonAnswer(style, common)} ${this.pendingQuestion(turn)}`, noAck: true };
    }
    // A0. Line check: "Hello?", "கேக்குதா?", "sound இல்லையா?", "பேசவே மாட்டேங்குது" (real call 2026-10-10: the caller
    // could not hear us). Say we are here and ask the pending question again - never "சூப்பர்", never the model.
    if (session.channel === 'voice' && isLineCheck(text) && Object.keys(turn.captured).length === 0) {
      turn.lineCheck = true;
      if (session.state === 'GREETING') return { kind: 'say', text: say.lineCheckOpening(style, session.organizationName), noAck: true };
      return { kind: 'say', text: `${say.lineCheck(style)} ${this.pendingQuestion(turn)}`, noAck: true };
    }

    // A2. A property named from the inventory ("Anna Nagar Residency"): offer THAT property, whatever the BHK / budget
    // on file; with a day / time in the same breath, go on to the visit.
    if (turn.namedProperty && !session.presented.some((p) => p.id === turn.namedProperty!.id)) {
      const p = turn.namedProperty;
      this.supersedePending(session, 'superseded');
      session.presented = [p];
      session.focusPropertyId = p.id;
      session.awaitingRequirementConfirm = false;
      session.awaitingAdjust = false;
      session.requirementChecked = true;
      session.searchedFor = criteriaSignature(session.slots);
      this.advanceLead(session, 'property_interested');
      const when = parseWhen(text, turn.now);
      if (intent === 'VISIT_INTEREST' || when.date || when.hour !== undefined) {
        session.state = 'VISIT_PROPOSAL';
        const resolved = resolveWhen(session.draft ?? {});
        if ('at' in resolved) return this.createProposal(turn, p, resolved.at);
        return { kind: 'say', text: say.pickedAsk(style, p.name, resolved.missing, session.draft?.ambiguousHour) };
      }
      session.state = 'PROPERTY_DISCUSSION';
      session.offeredVisit = true;
      return { kind: 'say', text: `${say.propertyIntro(style, p)} ${say.shallWeSeeShort(style)}` };
    }

    // "எந்த location?" about the options on the table: answered from inventory (was a 3 s model turn, 2026-10-10).
    if (session.presented.length > 0 && asksLocation(text) && Object.keys(turn.captured).length === 0) {
      const where = say.locationAnswer(style, session.presented, session.focusPropertyId);
      const next = session.presented.length === 1 && !session.focusPropertyId && session.state === 'PROPERTY_DISCUSSION'
        ? say.shallWeSeeShort(style)
        : this.pendingQuestion(turn);
      return { kind: 'say', text: `${where} ${next}` };
    }

    // B. Pending visit: only an explicit yes in the very next turn books.
    const proposal = activeProposal(session, turn.now);
    if (session.state === 'VISIT_CONFIRMATION' && proposal && proposal.createdTurn < turn.turn) {
      const decision = await this.handleConfirmation(turn, proposal);
      if (decision) return decision;
    } else if (session.state === 'VISIT_CONFIRMATION' && !proposal) {
      // Expired / superseded: fall back to discussing the property.
      session.state = session.presented.length ? 'PROPERTY_DISCUSSION' : 'QUALIFICATION';
    }

    // C. Repeat request: say the last line again, no model.
    if (intent === 'REPEAT_REQUEST' && session.lastAssistant) return { kind: 'say', text: session.lastAssistant };

    // C0. Area change. The old area's options and any visit proposal were already dropped in applyAreaChange, so the
    // visit flow can never continue with Porur after "Porur வேண்டாம், Velachery வேணும்".
    if (turn.areaChange) {
      const { to, rejected } = turn.areaChange;
      // "Porur வேண்டாம்" is said back only when the customer actually turned Porur down; naming another area is
      // just a switch (real call 2026-10-10: "சரிங்க, Porur வேண்டாம்." to a customer who never said that).
      const from = rejected.length ? turn.areaChange.from : undefined;
      if (!to) {
        this.markAsked(session, 'location');
        return { kind: 'say', text: say.askOtherArea(style, from, this.areaOptions(session, knownLocations)) };
      }
      if (qualificationState(session.slots).complete) return this.searchAndPresent(turn, from ? say.areaDropped(style, from) : undefined);
      const next = qualificationState(session.slots).next!;
      this.markAsked(session, next);
      return { kind: 'say', text: `${say.areaSwitched(style, from, to)} ${say.askSlot(style, next, session.slots)}` };
    }

    // C1. "அது வேண்டாம்" / "not this one": drop that property, offer the next real one (or another area / budget).
    if (turn.propertyRejected) {
      const focus = session.presented.find((p) => p.id === session.focusPropertyId) ?? session.presented[0];
      if (focus) session.rejectedPropertyIds = [...new Set([...(session.rejectedPropertyIds ?? []), focus.id])];
      this.supersedePending(session, 'superseded');
      session.presented = session.presented.filter((p) => !(session.rejectedPropertyIds ?? []).includes(p.id));
      session.focusPropertyId = undefined;
      session.draft = undefined;
      session.state = session.presented.length ? 'PROPERTY_DISCUSSION' : 'QUALIFICATION';
      const next = session.presented[0];
      session.offeredVisit = Boolean(next);
      if (next) session.focusPropertyId = next.id;
      return { kind: 'say', text: say.propertyDeclined(style, next) };
    }

    // C2. We asked "when can we call you?" after a "no" to "can we talk now?".
    if (session.awaitingCallbackTime) {
      session.awaitingCallbackTime = false;
      const talkNow = intent === 'TALK_CONSENT' || isExplicitAffirmation(text, turn.now).yes;
      if (!talkNow) {
        const at = parseCallbackTime(text, turn.now);
        await this.scheduleCallback(session, at, text || 'no time given');
        session.state = 'CALLBACK';
        session.closing = true;
        turn.actions.outcome = 'callback_requested';
        if (at) turn.actions.callbackAt = at.toISOString();
        return { kind: 'say', text: say.callback(style, at), end: true };
      }
    }

    // C3. A bare "no" / "illa" answers OUR last question; it never opts the customer out (only clear refusals do).
    const bareNo = quality === 'ok' && isBareNo(text);
    if (bareNo && session.state === 'GREETING' && session.direction !== 'inbound') {
      // "Can we talk now?" -> "No": ask when to call, keep the lead.
      session.awaitingCallbackTime = true;
      return { kind: 'say', text: say.whenToCall(style) };
    }
    if (bareNo && ((session.state === 'PROPERTY_DISCUSSION' && session.offeredVisit) || session.state === 'VISIT_PROPOSAL')) {
      session.offeredVisit = false;
      session.state = session.presented.length ? 'PROPERTY_DISCUSSION' : 'QUALIFICATION';
      session.draft = undefined;
      return { kind: 'say', text: say.declinedVisit(style) };
    }

    // D. Greeting -> qualification (a "பேசலாம்" is consent to talk, nothing more).
    if (session.state === 'GREETING') session.state = 'QUALIFICATION';

    // E. Site visit conversation.
    const when = parseWhen(text, turn.now);
    const whenCue = Boolean(when.date || when.hour !== undefined || when.ambiguousHour !== undefined);
    const yes = quality === 'ok' && isExplicitAffirmation(text, turn.now).yes;

    // E0. A reply to our day-before "please confirm your visit" WhatsApp (chat only: a "yes" at the start of a phone
    // call is never read as a confirmation). Yes marks that already-booked visit confirmed; no, or a new day/time,
    // sends the same property back through the normal propose -> explicit yes -> book flow.
    if (turn.dayBeforeVisit && (yes || whenCue || isExplicitNegation(text))) {
      const pending = turn.dayBeforeVisit;
      {
        const answered = await this.answerDayBeforeConfirmation(turn, pending, yes ? 'yes' : whenCue ? 'move' : 'no');
        if (answered) return answered;
      }
    }

    // E1. Price of a property we read out: answered from verified inventory, never by the model.
    if (session.presented.length > 0 && quality === 'ok' && asksPrice(text)) {
      const p = matchPresented(text, session.presented) ?? session.presented.find((x) => x.id === session.focusPropertyId) ?? session.presented[0];
      const pending = activeProposal(session, turn.now);
      if (pending && session.state === 'VISIT_CONFIRMATION') {
        pending.askedTurn = turn.turn; // the system's own confirmation question is asked again in this turn
        return { kind: 'say', text: `${say.priceOf(style, p)} ${this.confirmQ(turn, pending.propertyName, new Date(pending.scheduledAt))}` };
      }
      session.focusPropertyId = p.id;
      session.offeredVisit = true;
      return { kind: 'say', text: `${say.priceOf(style, p)} ${say.nextStepAfterOptions(style, p.name)}` };
    }

    // E2. "First one", "Green Valley", "that one", "same property": the customer picked a property we read out.
    if (session.presented.length > 0 && session.state !== 'VISIT_CONFIRMATION' && quality === 'ok') {
      const question = /[?？]/.test(text);
      const short = text.split(/\s+/).length <= 6;
      const pointed = refersToShownProperty(text);
      const named = matchPresented(text, session.presented);
      const picked = named ?? (pointed ? session.presented.find((x) => x.id === session.focusPropertyId) ?? (session.presented.length === 1 ? session.presented[0] : undefined) : undefined);
      if (picked) session.focusPropertyId = picked.id;
      if (picked && !question && (short || pointed) && intent !== 'VISIT_INTEREST' && !whenCue) {
        session.state = 'VISIT_PROPOSAL';
        session.offeredVisit = false;
        this.advanceLead(session, 'property_interested');
        // Day / time already given earlier ("Tomorrow." before the property was chosen): use it, ask only the rest.
        const resolved = resolveWhen(session.draft ?? {});
        if ('at' in resolved) return this.createProposal(turn, picked, resolved.at);
        return { kind: 'say', text: say.pickedAsk(style, picked.name, resolved.missing, session.draft?.ambiguousHour) };
      }
      if (!picked && pointed && session.presented.length > 1 && !whenCue) {
        return { kind: 'say', text: say.askWhichProperty(style, session.presented) };
      }
    }

    const visitFlow =
      intent === 'VISIT_INTEREST' ||
      // "Would you like to see one with a site visit?" -> "yes": start collecting day and time (nothing is booked).
      (session.state === 'PROPERTY_DISCUSSION' && Boolean(session.offeredVisit) && yes && session.presented.length > 0) ||
      session.state === 'VISIT_PROPOSAL' ||
      (session.state === 'VISIT_CONFIRMATION' && whenCue) ||
      (session.state === 'PROPERTY_DISCUSSION' && whenCue && session.presented.length > 0);
    if (visitFlow) {
      const visit = await this.visitFlow(turn, knownLocations);
      if (visit) return visit;
    }

    // F. Qualification and property search (rules first). A bare "yes" / "பேசலாம்" / "hello" is consent to talk, not a search request.
    const hasFacts = Object.keys(turn.captured).length > 0;
    const bareAck = !hasFacts && (intent === 'TALK_CONSENT' || intent === 'GREETING_ACK' || intent === 'ACK' || yes);

    // After a completed conversation or human handoff, a short "Hi"/"Yes" must not restart
    // property search or repeat old bookings.
    if (bareAck && session.channel !== 'voice' && (session.state === 'COMPLETED' || session.state === 'HANDOFF')) {
      return { kind: 'say', text: say.anythingElse(style), noAck: true };
    }

    const q = qualificationState(session.slots);
    if (turn.unknownLocation && !turn.captured.location && !session.slots.location) {
      return { kind: 'say', text: say.unknownArea(style, turn.unknownLocation, knownLocations) };
    }

    // F0. A day / time before any property is on the table ("Tomorrow 11 AM", "நாளைக்கு காலை ஒம்பது மணி"): it is
    // already kept in the draft (process). Acknowledge it and carry on by rules: search if the requirement is known,
    // else ask the next detail. Picking a property later goes straight to the confirmation question. No model.
    const statedNow = Object.keys(turn.stated).length > 0;
    if (whenCue && !hasFacts && !statedNow && session.presented.length === 0 && !turn.unknownLocation && session.draft) {
      const noted = say.whenNoted(style, session.draft, turn.now);
      if (q.complete) {
        session.awaitingRequirementConfirm = false;
        return this.searchAndPresent(turn, noted);
      }
      session.state = 'QUALIFICATION';
      const again = session.askedSlot === q.next;
      this.markAsked(session, q.next!);
      return { kind: 'say', text: `${noted} ${again ? say.askSlotAgain(style, q.next!) : say.askSlot(style, q.next!, session.slots)}` };
    }

    // F0b. "என்ன properties இருக்கு?": read the options (or search, or ask what is missing). No model.
    if (commonQuestion(text) === 'whatProperties' && !hasFacts && !statedNow) {
      if (session.presented.length > 0) {
        session.state = 'PROPERTY_DISCUSSION';
        session.offeredVisit = true;
        const list = session.channel === 'voice' ? say.presentProperties(style, session.presented, 2) : say.presentPropertyLines(style, session.presented, 2);
        return { kind: 'say', text: list };
      }
      if (q.complete) {
        session.awaitingRequirementConfirm = false;
        return this.searchAndPresent(turn);
      }
      session.state = 'QUALIFICATION';
      this.markAsked(session, q.next!);
      return { kind: 'say', text: `${say.ack(style, turn.turn)} ${say.askSlot(style, q.next!, session.slots)}` };
    }

    // We said nothing matches and asked to change area / budget: a "yes" gets the areas we really have.
    if (session.awaitingAdjust) {
      if (hasFacts || statedNow) {
        session.awaitingAdjust = false;
      } else if (bareAck || yes || (quality === 'ok' && leadingAffirmation(text, turn.now))) {
        session.awaitingAdjust = false;
        this.markAsked(session, 'location');
        return { kind: 'say', text: say.askOtherArea(style, undefined, this.areaOptions(session, knownLocations)) };
      } else if (quality === 'ok' && (isExplicitNegation(text) || isBareNo(text))) {
        session.awaitingAdjust = false;
        return { kind: 'say', text: say.anythingElse(style) };
      }
    }

    if (session.awaitingRequirementConfirm) {
      if (hasFacts) {
        session.awaitingRequirementConfirm = false; // they corrected something: carry on with the new details
      } else if ((yes || (quality === 'ok' && (leadingAffirmation(text, turn.now) || sameAsBefore(text)))) && q.complete) {
        session.awaitingRequirementConfirm = false;
        return this.searchAndPresent(turn);
      } else if (isExplicitNegation(text) && quality === 'ok') {
        session.awaitingRequirementConfirm = false;
        session.slots = {};
        session.searchedFor = undefined;
        this.markAsked(session, 'location');
        return { kind: 'say', text: say.startOver(style) };
      }
    }

    // Criteria not searched yet (or changed) and the customer talked about their requirement: search now, by rules.
    // Restating what the enquiry form already said ("Porur la 2 BHK iruka?") is a request to search, not "no new facts".
    const changedCriteria = criteriaSignature(session.slots) !== session.searchedFor;
    const statedRequirement = Object.keys(turn.stated).length > 0;
    if (q.complete && changedCriteria && (hasFacts || statedRequirement)) return this.searchAndPresent(turn);
    // The customer repeated a requirement we already searched ("இல்லை, 60 லட்சம்" when it is already 60 lakhs):
    // confirm it and move on, by rules.
    if (q.complete && !changedCriteria && statedRequirement && !hasFacts && session.searchedFor) {
      if (session.presented.length) session.offeredVisit = true;
      return { kind: 'say', text: say.stillLooking(style, session.slots, session.presented[0]) };
    }

    if (q.complete && session.presented.length === 0 && bareAck) {
      // Details are already on file (enquiry form): confirm them in one question instead of searching on a bare "yes".
      // Once per conversation: the read-back was repeated after every "ஆமா" (real call 2026-10-10 loop).
      if (session.requirementChecked && !session.awaitingRequirementConfirm) return this.searchAndPresent(turn);
      session.state = 'QUALIFICATION';
      session.awaitingRequirementConfirm = true;
      session.requirementChecked = true;
      return { kind: 'say', text: `${say.ack(style, turn.turn)} ${say.confirmRequirement(style, session.slots)}` };
    }
    if (!q.complete && statedRequirement && !hasFacts) {
      // They repeated what we already have ("Porur la 2 BHK venum" again): ask the missing detail in other words.
      session.state = 'QUALIFICATION';
      this.markAsked(session, q.next!);
      return { kind: 'say', text: `${say.ack(style, turn.turn)} ${say.askSlotAgain(style, q.next!)}` };
    }
    if (!q.complete && (hasFacts || bareAck)) {
      session.state = 'QUALIFICATION';
      const next = q.next!;
      this.markAsked(session, next);
      const lead = hasFacts ? say.noted(style, turn.turn, turn.captured) : say.ack(style, turn.turn);
      return { kind: 'say', text: `${lead} ${say.askSlot(style, next, session.slots)}` };
    }
    // Chat: a "Hi" from a customer who already has a visit booked (on a call, or earlier in chat) is answered with
    // that visit, not with the old options again (WhatsApp 2026-10-10: "Hi" right after a phone booking was offered
    // Porur Heights).
    if (
      session.channel !== 'voice' &&
      !activeProposal(session, turn.now) &&
      /\b(?:what|show|list|check|my|upcoming)\b.{0,40}\b(?:booking|bookings|appointment|appointments|site visit|visits)\b|\b(?:booking|appointment|site visit)\s+(?:status|details)\b/i.test(text)
    ) {
      const booked = await this.upcomingBookedVisits(session, turn.now).catch(() => []);
      if (booked.length) {
        session.state = 'COMPLETED';
        session.offeredVisit = false;
        // Lead with a booking made in the last 30 minutes (the customer is writing right after booking it), else the
        // earliest; the others follow in time order.
        const newest = booked.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
        const ordered = turn.now.getTime() - newest.createdAt.getTime() < 30 * 60_000 ? [newest, ...booked.filter((v) => v.id !== newest.id)] : booked;
        return { kind: 'say', text: say.upcomingVisits(style, ordered.map((v) => ({ propertyName: v.Property.name, at: v.scheduledAt }))) };
      }
    }
    if (bareAck && session.state === 'PROPERTY_DISCUSSION' && session.presented.length > 0) {
      // An acknowledgement after the options were read out: move forward, never read the same options again.
      session.offeredVisit = true;
      const p = session.presented.find((x) => x.id === session.focusPropertyId) ?? session.presented[0];
      return { kind: 'say', text: say.nextStepAfterOptions(style, p.name) };
    }
    if (bareNo) {
      // "No" with nothing else, outside any yes/no question of ours: acknowledge and ask the next useful thing.
      return { kind: 'say', text: q.complete ? say.anythingElse(style) : `${say.ack(style, turn.turn)} ${say.askSlotAgain(style, q.next!)}` };
    }

    // A garbled fragment with no intent and no facts in it is asked again by rules (twice at most): the model could only guess.
    if (quality === 'weak' && intent === 'UNKNOWN' && !hasFacts && !statedRequirement && !turn.unknownLocation && session.unclearTurns < 2) {
      session.unclearTurns += 1;
      return { kind: 'say', text: say.unclear(style) };
    }

    // G. Everything else is free-form: let the model phrase it, with the smallest possible toolset.
    // Voice: at most ONE model request. Searches are done by rules (criteria changes are detected above), so the
    // voice model only gets propose_site_visit, which ends the run at the tool.
    const question = /[?？]/.test(text) || /\b(what|how|why|when|where|which|who|is there|are there|can|could|enna|eppadi|evlo|yen|edhu|enga)\b|என்ன|எப்படி|ஏன்|எங்க|எது|எவ்வளவு|எவ்ளோ/iu.test(text);
    if (session.state === 'QUALIFICATION') {
      const stuck = session.askedSlot && (session.askedCount[session.askedSlot] ?? 0) >= 2;
      const toolset: Toolset = session.channel !== 'voice' || stuck ? 'memory' : 'none';
      return { kind: 'llm', toolset, reason: question ? 'UNKNOWN_QUESTION' : 'QUALIFICATION_FREE_FORM' };
    }
    if (session.state === 'VISIT_CONFIRMATION') return { kind: 'llm', toolset: 'none', reask: true, reason: 'CONFIRMATION_SIDE_QUESTION' };
    const reason: LlmFallbackReason = session.presented.length && question ? 'FREE_FORM_PROPERTY_QUESTION' : question ? 'UNKNOWN_QUESTION' : 'AMBIGUOUS_INTENT';
    return { kind: 'llm', toolset: session.channel === 'voice' ? 'proposal' : 'discussion_memory', reason };
  }

  /** Customer answered the confirmation question (or did something else). Returns undefined to continue the cascade. */
  private async handleConfirmation(turn: Turn, proposal: VisitProposal): Promise<Plan | undefined> {
    const { session, text, quality } = turn;
    const style = this.style(session);
    const askedNow = proposal.askedTurn === turn.turn - 1;
    const aff = isExplicitAffirmation(text, turn.now);

    if (aff.yes && askedNow) {
      if (quality !== 'ok' || turn.keptForTime) {
        proposal.askedTurn = turn.turn; // garbled "yes": ask again (a clear yes to THIS question may follow), never book
        return { kind: 'say', text: say.reAskConfirm(style) };
      }
      return this.bookNow(turn, proposal);
    }
    if (aff.yes && !askedNow) {
      // A "yes" that does not answer our last question must never book.
      proposal.askedTurn = turn.turn;
      return { kind: 'say', text: say.reAskConfirm(style) };
    }
    if (isExplicitNegation(text)) {
      proposal.status = 'declined';
      session.state = 'VISIT_PROPOSAL';
      session.draft = undefined;
      return { kind: 'say', text: say.declinedVisit(style) };
    }
    return undefined; // a new date/time, a question, small talk ... handled below
  }

  private async bookNow(turn: Turn, proposal: VisitProposal): Promise<Plan> {
    const { session } = turn;
    const style = this.style(session);
    session.state = 'BOOKING';
    const evidence = `AI visit confirmed by customer (${session.channel}${session.callId ? ` ${session.callId}` : ''} turn ${turn.turn}): "${turn.text.slice(0, 60)}"`;
    const result = await this.siteVisits.bookConfirmedVisit({
      organizationId: session.organizationId,
      customerId: session.customerId,
      leadId: session.leadId,
      propertyId: proposal.propertyId,
      scheduledAt: proposal.scheduledAt,
      presentedPropertyIds: session.presented.map((p) => p.id),
      evidence,
      now: turn.now,
    });

    if (result.ok) {
      proposal.status = 'booked';
      proposal.siteVisitId = result.siteVisit.id;
      session.state = 'COMPLETED';
      session.closing = true;
      session.draft = undefined;
      turn.booking = result.duplicate ? 'duplicate' : 'booked';
      turn.actions.siteVisitBooked = true;
      turn.actions.outcome = 'site_visit_booked';
      // The customer now has a visit: stop the automatic sequence (callbacks they asked for stay).
      await this.followUps
        .cancelPending({ organizationId: session.organizationId, customerId: session.customerId, reason: 'Site visit booked', sources: ['sequence', 'retry'] })
        .catch((e) => log.error('engine.cancel_followups_failed', { error: errorMessage(e) }));
      const at = result.siteVisit.scheduledAt;
      if (!result.duplicate) {
        // Team alert now, day-before confirmation, reminder with location, after-visit follow-up. Off the reply path:
        // the booking itself is already committed; a scheduling hiccup is logged, never shown to the customer.
        const visit = { id: result.siteVisit.id, organizationId: session.organizationId, leadId: session.leadId, customerId: session.customerId, scheduledAt: at };
        this.background(session.key, () => retryTransient(() => this.followUps.scheduleVisitFollowThrough(visit), 'visit.follow_through'));
      }
      return { kind: 'say', text: result.duplicate ? say.alreadyBooked(style, proposal.propertyName, at) : (session.channel === 'voice' ? say.bookedSpoken(style, proposal.propertyName, at, turn.now) : say.booked(style, proposal.propertyName, at)), end: true };
    }

    turn.booking = 'rejected';
    log.warn('engine.booking_rejected', { code: result.code, callId: session.callId, leadId: session.leadId });
    proposal.status = 'superseded';
    if (['past', 'too_soon', 'too_far', 'outside_hours', 'invalid'].includes(result.code)) {
      session.state = 'VISIT_PROPOSAL';
      session.draft = undefined;
      return { kind: 'say', text: say.visitInvalid(style, result.code) };
    }
    if (result.code === 'property_unavailable' || result.code === 'property_not_found' || result.code === 'property_not_presented') {
      session.state = 'PROPERTY_DISCUSSION';
      return { kind: 'say', text: say.visitInvalid(style, 'unavailable') };
    }
    // Anything else (database/lock failure, closed lead ...): do NOT improvise a booking. Tell the truth and ask a human to follow up.
    session.state = 'HANDOFF';
    session.closing = true;
    turn.actions.outcome = 'site_visit_requested';
    await this.requestHandoff(session, `Customer confirmed a site visit but booking failed (${result.code}). Please follow up.`).catch(() => undefined);
    return { kind: 'say', text: say.bookingFailed(style), end: true };
  }

  /** The customer's next visit that we asked them (by WhatsApp, the day before) to confirm and that is still unconfirmed. */
  /** The area was already said in this call (by the customer this turn, or in an earlier line, e.g. the read-back). */
  private areaAlreadySaid(turn: Turn): boolean {
    if (turn.stated.location) return true;
    const area = turn.session.presented[0]?.location.split(',')[0].trim().toLowerCase();
    if (!area) return true;
    return turn.session.recent.some((m) => m.content.toLowerCase().includes(area));
  }

  /** All of the customer's upcoming booked (or confirmed) visits, in time order (cancelled / moved / past excluded). */
  private async upcomingBookedVisits(s: Session, now: Date) {
    return this.prisma.siteVisit.findMany({
      where: { organizationId: s.organizationId, customerId: s.customerId, status: { in: ['scheduled', 'confirmed'] }, scheduledAt: { gt: now } },
      include: { Property: true },
      orderBy: { scheduledAt: 'asc' },
      take: 20,
    });
  }

  async visitAwaitingConfirmation(s: Session, now: Date) {
    const visits = await this.prisma.siteVisit.findMany({
      where: { organizationId: s.organizationId, customerId: s.customerId, status: 'scheduled', scheduledAt: { gt: now, lt: new Date(now.getTime() + 48 * 3600_000) } },
      include: { Property: true },
      orderBy: { scheduledAt: 'asc' },
      take: 3,
    });
    for (const v of visits) {
      const asked = await this.prisma.followUp.count({ where: { organizationId: s.organizationId, message: `visit:confirm:${v.id}`, status: 'completed' } });
      if (asked) return v;
    }
    return undefined;
  }

  private async answerDayBeforeConfirmation(
    turn: Turn,
    visit: { id: string; propertyId: string; scheduledAt: Date; Property: { id: string; name: string; location: string; type: string; bhk: number; price: unknown } },
    answer: 'yes' | 'no' | 'move',
  ): Promise<Plan | undefined> {
    const { session } = turn;
    const style = this.style(session);
    if (answer === 'yes') {
      try {
        await this.siteVisits.updateStatus({ organizationId: session.organizationId, siteVisitId: visit.id, status: 'confirmed' });
      } catch (error) {
        log.error('engine.visit_confirm_failed', { siteVisitId: visit.id, error: errorMessage(error) });
        return undefined; // never claim a confirmation that was not saved
      }
      turn.actions.visitConfirmed = visit.id;
      const site = (await this.followUps.settingsFor(session.organizationId)).visits.sites[visit.propertyId];
      return { kind: 'say', text: say.visitConfirmedByCustomer(style, visit.Property.name, visit.scheduledAt, site) };
    }
    // Not coming at that time: same property, new slot, through the normal safe flow (nothing changes until they say yes).
    const p = visit.Property;
    const price = Number(p.price);
    session.presented = [{ id: p.id, name: p.name, location: p.location, type: p.type, bhk: p.bhk, price, priceText: formatRupeesShort(price) }];
    session.focusPropertyId = p.id;
    session.state = 'VISIT_PROPOSAL';
    session.draft = undefined;
    if (answer === 'move') return undefined; // the visit flow below reads the new day/time
    return { kind: 'say', text: say.visitChangeAsk(style, p.name) };
  }

  /** Hot lead (buying soon + a matching property shown): one alert to the sales team per lead. */
  private checkHotLead(s: Session) {
    if (s.hotAlerted || !s.slots.timeline || s.presented.length === 0) return;
    const { organizationId, leadId, customerId, key } = s;
    const timeline = s.slots.timeline;
    s.hotAlerted = true;
    this.background(key, async () => {
      const settings = await this.followUps.settingsFor(organizationId);
      if (!isHotLead(settings, { timeline, matchingPropertyShown: true })) return;
      log.info('engine.hot_lead', { leadId, timeline });
      await this.followUps.scheduleHotLeadAlert({ organizationId, leadId, customerId });
    });
  }

  /** The customer wants to visit: find the property, collect date + time, then PROPOSE (never book). */
  private async visitFlow(turn: Turn, knownLocations: string[]): Promise<Plan | undefined> {
    const { session, text } = turn;
    const style = this.style(session);

    // Search first: property search only happens once there is enough to search on.
    if (session.presented.length === 0) {
      const q = qualificationState(session.slots);
      if (!q.complete) {
        session.state = 'QUALIFICATION';
        this.markAsked(session, q.next!);
        return { kind: 'say', text: `${session.draft && mentionsWhen(text, turn.now) ? say.whenNoted(style, session.draft, turn.now) : say.ack(style, turn.turn)} ${say.askSlot(style, q.next!, session.slots)}` };
      }
      return this.searchAndPresent(turn, session.draft && mentionsWhen(text, turn.now) ? say.whenNoted(style, session.draft, turn.now) : undefined);
    }

    const matched = matchPresented(text, session.presented) ?? session.presented.find((p) => p.id === session.focusPropertyId) ?? (session.presented.length === 1 ? session.presented[0] : undefined);
    if (!matched) {
      session.state = 'VISIT_PROPOSAL';
      // The day/time was already kept (process); say so, then ask which property - never "which day?" again.
      const heard = parseWhen(text, turn.now);
      if (heard.date && session.draft?.date) return { kind: 'say', text: say.whichPropertyForDay(style, session.presented, say.dayLabel(style, session.draft.date, turn.now)) };
      return { kind: 'say', text: say.askWhichProperty(style, session.presented) };
    }
    session.focusPropertyId = matched.id;
    if (session.state !== 'VISIT_CONFIRMATION') session.state = 'VISIT_PROPOSAL';
    this.advanceLead(session, 'property_interested');

    const draft = mergeWhen(session.draft, parseWhen(text, turn.now));
    session.draft = draft;
    session.visitMisses = 'at' in resolveWhen(draft) ? 0 : session.visitMisses;
    const resolved = resolveWhen(draft);
    if (!('at' in resolved)) {
      const misses = (session.visitMisses ?? 0) + 1;
      session.visitMisses = misses;
      // Rules could not read the date/time twice in a row although the customer said something: let the model try.
      if (misses >= 2 && text.split(/\s+/).length >= 3 && !(draft.date || draft.hour !== undefined)) {
        return { kind: 'llm', toolset: 'proposal', reason: 'AMBIGUOUS_INTENT' };
      }
      return { kind: 'say', text: say.askVisitWhen(style, resolved.missing, draft.ambiguousHour) };
    }

    return this.createProposal(turn, matched, resolved.at);
  }

  private async createProposal(turn: Turn, property: PresentedProperty, at: Date): Promise<Plan> {
    const { session } = turn;
    const style = this.style(session);
    const check = await this.siteVisits.validateSiteVisitBooking({
      organizationId: session.organizationId,
      customerId: session.customerId,
      leadId: session.leadId,
      propertyId: property.id,
      scheduledAt: at,
      presentedPropertyIds: session.presented.map((p) => p.id),
      now: turn.now,
    });
    if (!check.ok) {
      if (['past', 'too_soon', 'too_far', 'outside_hours', 'invalid'].includes(check.code)) {
        if (session.draft) session.draft = { ...session.draft, date: undefined, hour: undefined, minute: undefined, fromPartOfDay: undefined };
        session.state = 'VISIT_PROPOSAL';
        return { kind: 'say', text: say.visitInvalid(style, check.code) };
      }
      session.state = 'PROPERTY_DISCUSSION';
      return { kind: 'say', text: say.visitInvalid(style, 'unavailable') };
    }

    const iso = describeIso(at);
    const existing = session.proposal;
    if (existing && existing.status === 'pending' && existing.propertyId === property.id && existing.scheduledAt === iso) {
      existing.askedTurn = turn.turn;
    } else {
      if (existing && existing.status === 'pending') existing.status = 'superseded';
      session.proposal = {
        id: randomUUID(),
        propertyId: property.id,
        propertyName: property.name,
        scheduledAt: iso,
        createdTurn: turn.turn,
        askedTurn: turn.turn,
        createdAt: turn.now.toISOString(),
        expiresAt: new Date(turn.now.getTime() + PROPOSAL_TTL_MS[session.channel]).toISOString(),
        status: 'pending',
      };
    }
    session.state = 'VISIT_CONFIRMATION';
    session.draft = undefined;
    session.offeredVisit = false;
    turn.actions.outcome = 'site_visit_requested';
    return { kind: 'say', text: this.confirmQ(turn, property.name, at) };
  }

  private async searchAndPresent(turn: Turn, leadOverride?: string): Promise<Plan> {
    const { session } = turn;
    const style = this.style(session);
    session.state = 'PROPERTY_SEARCH';
    const s = session.slots;
    const found = await this.properties.searchForAgent({ organizationId: session.organizationId, location: s.location, bhk: s.bhk, propertyType: s.propertyType, maxBudget: s.budget });
    // A property the customer already turned down is never offered again in this conversation.
    const rejectedIds = new Set(session.rejectedPropertyIds ?? []);
    const result = rejectedIds.size
      ? {
          ...found,
          properties: found.properties.filter((p) => !rejectedIds.has(p.id)),
          ...('aboveBudgetAlternatives' in found && found.aboveBudgetAlternatives
            ? { aboveBudgetAlternatives: found.aboveBudgetAlternatives.filter((p) => !rejectedIds.has(p.id)) }
            : {}),
        }
      : found;
    session.searchedFor = criteriaSignature(s);
    session.focusPropertyId = undefined;
    session.proposal = session.proposal?.status === 'pending' ? { ...session.proposal, status: 'superseded' } : session.proposal;
    this.advanceLead(session, 'qualified');
    if (!turn.actions.outcome) turn.actions.outcome = 'qualified';

    const toPresented = (p: { id: string; name: string; location: string; type: string; bhk: number; price: number; priceText: string }): PresentedProperty => ({
      id: p.id, name: p.name, location: p.location, type: p.type, bhk: p.bhk, price: p.price, priceText: p.priceText,
    });
    const max = 2; // voice reads two, chat shows two lines + one question (3 lines)
    if (result.properties.length > 0) {
      session.presented = result.properties.slice(0, 5).map(toPresented);
      session.state = 'PROPERTY_DISCUSSION';
      session.offeredVisit = true;
      // Voice: the customer just gave the budget -> every option is within it; say the names only (no read-back).
      const text = session.channel === 'voice'
        ? say.presentProperties(style, session.presented, max, { withPrice: !turn.captured.budget, withArea: !this.areaAlreadySaid(turn) })
        : say.presentPropertyLines(style, session.presented, max);
      // Voice: no read-back of what the customer just said (the list itself shows we understood; every word is TTS
      // time). A one-word acknowledgement plays from cache instantly while the list is synthesized.
      const lead = leadOverride ? `${leadOverride} ` : Object.keys(turn.captured).length ? `${say.ack(style, turn.turn)} ` : '';
      return { kind: 'say', text: session.channel === 'voice' ? `${lead}${text}` : text };
    }
    let alt = 'aboveBudgetAlternatives' in result && result.aboveBudgetAlternatives?.[0] ? toPresented(result.aboveBudgetAlternatives[0]) : undefined;
    let altKind: 'above_budget' | 'same_area' | 'other_area' = 'above_budget';
    // Never a dead end (real call 2026-10-10: "இல்லங்க. Budget இல்ல area மாத்தலாமா?" -> "ஆமா" -> the read-back again,
    // in a loop). Offer the nearest REAL option: the same area in any size / price, else the same size and budget in
    // another area. Only when the inventory has neither do we ask what to change.
    if (!alt) {
      const usable = (list: Array<Parameters<typeof toPresented>[0]>) => list.filter((p) => !rejectedIds.has(p.id)).map(toPresented);
      if (s.location) {
        const sameArea = await this.properties.searchForAgent({ organizationId: session.organizationId, location: s.location });
        alt = usable(sameArea.properties)[0];
        altKind = 'same_area';
      }
      if (!alt && (s.bhk || s.budget || s.propertyType)) {
        const elsewhere = await this.properties.searchForAgent({ organizationId: session.organizationId, bhk: s.bhk, propertyType: s.propertyType, maxBudget: s.budget });
        const no = new Set((session.rejectedLocations ?? []).map((x) => x.toLowerCase()));
        alt = usable(elsewhere.properties).find((p) => !no.has(p.location.split(',')[0].trim().toLowerCase()));
        altKind = 'other_area';
      }
    }
    session.presented = alt ? [alt] : [];
    session.state = 'PROPERTY_DISCUSSION';
    session.offeredVisit = Boolean(alt); // the "would you like to see it?" question was asked about the alternative
    session.awaitingAdjust = !alt;
    const line = alt ? say.noMatchOffer(style, s, alt, altKind) : say.noMatch(style, s.location, undefined, s);
    return { kind: 'say', text: `${leadOverride ? `${leadOverride} ` : ''}${line}` };
  }

  // ---------------------------------------------------------------------------------------------
  // Model call (only when rules cannot answer)
  // ---------------------------------------------------------------------------------------------

  private async runModel(turn: Turn, plan: Extract<Plan, { kind: 'llm' }>): Promise<{ text: string; failed: boolean; usage: AiUsageMetrics; end: boolean }> {
    const { session } = turn;
    const style = this.style(session);
    const now = nowInIst(turn.now);
    const callReason = turn.input.callContext?.reason;

    const context: TacksharpAgentContext = {
      organizationId: session.organizationId,
      organizationName: session.organizationName,
      channel: session.channel,
      phone: turn.input.phone,
      nowText: now.text,
      nowIso: now.iso,
      brief: this.renderBrief(session, callReason, plan.reask),
      styleLine: this.styleLine(session),
      actions: turn.actions,
      updateCustomerMemory: (update) => this.modelMemory(turn, update),
      searchProperties: (query) => this.modelSearch(turn, query),
      proposeSiteVisit: (input) => this.modelPropose(turn, input),
    };

    turn.llmFallbackReason = plan.reason;
    // session.recent does not contain the current message yet (it is appended after the reply is decided).
    // Voice keeps only the last two exchanges: the brief already carries every fact the model needs.
    const recent = session.channel === 'voice' ? session.recent.slice(-4) : session.recent;
    const history = recent.map((m) => ({ ...m, content: m.content.slice(0, HISTORY_CHARS) }));
    const [run, inventory] = await Promise.all([
      this.llm.run({ channel: session.channel, toolset: plan.toolset, context, history, message: turn.text, maxTurns: session.channel === 'voice' ? 2 : undefined }),
      this.inventoryNames(session.organizationId).catch(() => [] as string[]),
    ]);

    if (run.failed || (!run.text && !context.replyOverride && !turn.proposedReply)) {
      const failures = (session.llmFailures ?? 0) + 1;
      session.llmFailures = failures;
      if (session.channel === 'voice' && failures < 2) {
        // First hiccup: ask again instead of dropping the call.
        return { text: say.unclear(style), failed: false, usage: run.usage, end: false };
      }
      if (session.channel === 'voice') {
        await this.requestHandoff(session, 'AI assistant had technical trouble during the call. Please follow up.').catch(() => undefined);
        session.state = 'HANDOFF';
        session.closing = true;
        turn.actions.handoff = true;
        turn.actions.outcome = 'human_requested';
        return { text: FALLBACK_REPLY.voice, failed: true, usage: run.usage, end: true };
      }
      // Written channels: "our team will contact you" is only said when a task for the team really exists.
      const backed = await this.followUps
        .createHumanTask({ organizationId: session.organizationId, leadId: session.leadId, customerId: session.customerId, reason: `AI could not reply on ${session.channel} (technical error). Please reply to the customer manually.` })
        .then(() => true)
        .catch((e) => {
          log.error('engine.failure_task_failed', { error: errorMessage(e) });
          return false;
        });
      return { text: backed ? FALLBACK_REPLY[session.channel] : FALLBACK_NO_PROMISE, failed: true, usage: run.usage, end: false };
    }
    session.llmFailures = 0;

    let text = context.replyOverride ?? turn.proposedReply ?? this.finalizeModelText(run.text, session, turn, plan, inventory);
    // Everything the model said was unverifiable or off-topic: say the next useful thing from rules instead.
    if (!text) text = this.alternativeReply(turn);
    return { text, failed: false, usage: run.usage, end: false };
  }

  /** Tidy the model's sentence and remove anything it is not allowed to claim. */
  private finalizeModelText(raw: string, session: Session, turn: Turn, plan: Extract<Plan, { kind: 'llm' }>, inventory: string[] = []): string {
    const style = this.style(session);
    let text = raw.replace(/\*\*/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    const drops: string[] = [];
    const shown = new Set(session.presented.map((p) => norm(p.name)));
    const unshown = inventory.map((n) => norm(n)).filter((n) => n && !shown.has(n));
    const allowedAmounts = [...session.presented.map((p) => p.price), session.slots.budget].filter((v): v is number => typeof v === 'number' && v > 0);
    const sentences = text
      .split(/(?<=[.?!।])\s+/)
      .filter(Boolean)
      .filter((sentence) => {
        const ns = norm(sentence);
        // A property we never showed in this conversation (the model must only use VERIFIED PROPERTIES).
        if (unshown.some((name) => ` ${ns} `.includes(` ${name} `))) return drops.push('unverified_property'), false;
        // A price that is neither a shown property's price nor the customer's own budget.
        for (const m of sentence.matchAll(MONEY_RE)) {
          const v = parseIndianBudget(m[0]);
          if (v && !allowedAmounts.some((a) => Math.abs(a - v) / a < 0.02)) return drops.push('unverified_price'), false;
        }
        // Asking for something the customer already told us.
        if (asksKnownSlot(sentence, session.slots)) return drops.push('asks_known_slot'), false;
        return true;
      });

    const bookedClaim = /(book(ed)?|confirm(ed)?|schedul(ed|e)d?|arranged|fixed|reserved)\b.*\b(visit|slot|appointment)|\b(visit|slot)\b.*\b(book(ed)?|confirm(ed)?|schedul(ed)|done)\b|(visit|விசிட்).*(book|பண்ணிட்டேன்|ஆயிடுச்சு|பண்ணியாச்சு|confirm)|(book|கன்பார்ம்|confirm).*(பண்ணிட்டேன்|ஆயிடுச்சு|பண்ணியாச்சு|pannitten|aayiduchu)/iu;
    const teamClaim = /(sales )?team.*(call|contact|reach)|call (you )?back|will call you|கூப்பிடுவாங்க|call பண்ணுவாங்க|contact பண்ணுவாங்க|உங்களை call பண்றேன்|call panren/iu;
    const sendClaim = /(whatsapp|வாட்ஸ்அப்|வாட்சப்).{0,40}(share|send|அனுப்ப|ஷேர்|anupp)|(share|send|அனுப்ப|ஷேர்|anupp)\S*.{0,40}(whatsapp|வாட்ஸ்அப்|வாட்சப்)|\b(i will|i'll|we will|we'll) (send|share)\b|(share|send) (pannren|panren|பண்றேன்|பண்ணுறேன்)|அனுப்புறேன்|அனுப்பறேன்|அனுப்புவேன்/iu;
    const kept = sentences.filter((s) => {
      if (/[?？]\s*$/.test(s)) return true; // a question is never a claim
      if (bookedClaim.test(s) && !turn.booking) return false;
      if (teamClaim.test(s) && !turn.actions.handoff && !turn.actions.outcome) return false;
      // Nothing in a model turn sends a WhatsApp message: "I'll share options on WhatsApp" is an empty promise
      // (real call 2026-10-09 said exactly this to a customer who had just confirmed their requirement).
      if (sendClaim.test(s)) return drops.push('unbacked_send_promise'), false;
      return true;
    });
    text = kept.join(' ');
    if (drops.length) turn.replyDrops = drops;

    // One question at a time: stop after the first question.
    const qIndex = text.search(/[?？]/);
    if (qIndex >= 0) text = text.slice(0, qIndex + 1);

    // Voice: two short sentences.
    if (session.channel === 'voice') {
      const parts = text.split(/(?<=[.?!।])\s+/).filter(Boolean).slice(0, 2);
      text = parts.join(' ');
      if (text.length > VOICE_MAX_CHARS) text = text.slice(0, VOICE_MAX_CHARS).replace(/\s+\S*$/, '');
    } else {
      text = shapeChatReply(text);
    }
    if (!text.trim()) return '';

    // A pending visit must end with the system's own confirmation question, so a later "yes" answers THAT question.
    if (plan.reask) {
      const p = activeProposal(session, turn.now);
      if (p) {
        p.askedTurn = turn.turn;
        const withoutQuestion = text.replace(/[^.!।]*[?？]\s*$/u, '').trim();
        return `${withoutQuestion ? `${withoutQuestion} ` : ''}${this.confirmQ(turn, p.propertyName, new Date(p.scheduledAt))}`;
      }
    }
    return text;
  }

  // Model tool callbacks -------------------------------------------------------------------------

  private async modelMemory(turn: Turn, update: Parameters<TacksharpAgentContext['updateCustomerMemory']>[0]) {
    const { session } = turn;
    // The model may save facts, never a language or a property of interest (those are decided by code).
    const result = await this.conversations.updateCustomerMemory({
      organizationId: session.organizationId,
      customerId: session.customerId,
      update: { ...update, language: undefined, interestedPropertyId: undefined },
    });
    if (result.updated) {
      // Keep the session in step with what was actually stored (the values are already normalized).
      const saved = ('saved' in result ? result.saved : {}) as Record<string, unknown>;
      const fresh: Slots = {};
      if (typeof saved.location === 'string') fresh.location = saved.location;
      if (typeof saved.budget === 'number' && saved.budget > 0) fresh.budget = saved.budget;
      if (typeof saved.bhk === 'number') fresh.bhk = saved.bhk;
      if (typeof saved.propertyType === 'string') fresh.propertyType = saved.propertyType;
      if (typeof saved.purchaseTimeline === 'string') fresh.timeline = saved.purchaseTimeline;
      Object.assign(turn.captured, this.mergeSlots(session, fresh));
      if (typeof saved.name === 'string') session.customerName = saved.name;
      await this.leads.syncLeadFromCustomer(session.organizationId, session.customerId);
    }
    return result;
  }

  private async modelSearch(turn: Turn, query: { location?: string; bhk?: number; propertyType?: string; maxBudget?: number }) {
    const { session } = turn;
    const result = await this.properties.searchForAgent({ organizationId: session.organizationId, ...query });
    const rows = result.properties.length ? result.properties : ('aboveBudgetAlternatives' in result ? result.aboveBudgetAlternatives ?? [] : []);
    // Whatever the model is told about must be proposable later, and nothing else.
    session.presented = rows.slice(0, 5).map((p) => ({ id: p.id, name: p.name, location: p.location, type: p.type, bhk: p.bhk, price: p.price, priceText: p.priceText }));
    session.focusPropertyId = undefined;
    return result;
  }

  private async modelPropose(turn: Turn, input: { propertyId: string; scheduledAt: string }): Promise<{ ok: boolean; reply: string }> {
    const { session } = turn;
    const style = this.style(session);
    const property = session.presented.find((p) => p.id === input.propertyId);
    const at = new Date(input.scheduledAt);
    if (!property || Number.isNaN(at.getTime())) {
      const reply = property ? say.visitInvalid(style, 'invalid') : say.askWhichProperty(style, session.presented.length ? session.presented : []);
      turn.proposedReply = reply;
      return { ok: false, reply };
    }
    const plan = await this.createProposal(turn, property, at);
    const reply = plan.kind === 'say' ? plan.text : say.noClaim(style);
    turn.proposedReply = reply;
    return { ok: session.state === 'VISIT_CONFIRMATION', reply };
  }

  // ---------------------------------------------------------------------------------------------
  // Brief, style, helpers
  // ---------------------------------------------------------------------------------------------

  private renderBrief(s: Session, callReason?: string, reask?: boolean): string {
    const sl = s.slots;
    const known =
      [
        s.customerName && `Name: ${s.customerName}`,
        sl.location && `Area: ${sl.location}`,
        sl.budget && `Budget: up to ${formatRupeesShort(sl.budget)}`,
        sl.bhk && `BHK: ${sl.bhk}`,
        sl.propertyType && `Type: ${sl.propertyType}`,
        sl.timeline && `Timeline: ${sl.timeline}`,
      ]
        .filter(Boolean)
        .join('; ') || 'nothing yet';
    const q = qualificationState(sl);
    const lines = [`STATE: ${s.state}`, `KNOWN: ${known}`];
    lines.push(q.complete ? 'NEXT QUESTION: none, qualification is complete.' : `NEXT QUESTION (ask only this, one question): ${q.next}`);
    lines.push(
      s.presented.length
        ? `VERIFIED PROPERTIES (mention only these):\n${s.presented.slice(0, 5).map((p, i) => `${i + 1}) id=${p.id} | ${p.name} | ${p.location} | ${p.bhk ? `${p.bhk} BHK` : p.type} | ${p.priceText}`).join('\n')}`
        : 'VERIFIED PROPERTIES: none shown yet. Do not mention any property.',
    );
    const p = activeProposal(s);
    if (p) {
      lines.push(`PENDING VISIT: ${p.propertyName} on ${describeWhen(new Date(p.scheduledAt), 'en')}. Only the system can book it, after the customer says yes.${reask ? ' Answer the customer briefly WITHOUT asking any question; the system will ask the confirmation.' : ''}`);
    }
    if (callReason) lines.push(`WHY WE CALLED: ${callReason}`);
    return lines.join('\n');
  }

  private styleLine(s: Session): string {
    const l = s.language.effective;
    if (s.channel === 'voice') {
      return l === 'english'
        ? 'Simple Indian English. No markdown, emoji or symbols.'
        : 'Spoken Chennai Tamil in TAMIL SCRIPT, like a Chennai sales executive on the phone (பாக்குறீங்க, எவ்ளோ, சொல்லுங்க, correct-ஆ?, problem இல்லங்க), never written Tamil (not பார்க்கிறீர்கள், எவ்வளவு, மற்றும்). English words (BHK, budget, site visit, place and project names) stay in English letters. No markdown, emoji or symbols.';
    }
    if (l === 'english') return 'Plain, friendly English.';
    return l === 'tamil'
      ? 'Spoken Chennai Tamil in Tamil script (பாக்குறீங்க, எவ்ளோ, சொல்லுங்க), never formal written Tamil; English words kept in English.'
      : 'Chennai Tanglish in English letters (like "Unga budget evlo?", "Porur-la paakureenga, correct-aa?"), short and friendly.';
  }

  private style(s: Session) {
    return replyStyle(s.language.effective as Lang, s.channel);
  }

  /** The system's own confirmation question: short spoken form on the phone, full date in chat. */
  private confirmQ(turn: Turn, propertyName: string, at: Date): string {
    const style = this.style(turn.session);
    return turn.session.channel === 'voice' ? say.confirmQuestionSpoken(style, propertyName, at, turn.now) : say.confirmQuestion(style, propertyName, at);
  }

  /** The question we were waiting on, asked again after answering a side question (by rules). */
  private pendingQuestion(turn: Turn): string {
    const { session } = turn;
    const style = this.style(session);
    const pending = activeProposal(session, turn.now);
    if (session.state === 'VISIT_CONFIRMATION' && pending) {
      pending.askedTurn = turn.turn; // a "yes" next turn answers THIS question
      return this.confirmQ(turn, pending.propertyName, new Date(pending.scheduledAt));
    }
    if (session.awaitingRequirementConfirm) return say.confirmRequirement(style, session.slots);
    if (session.awaitingAdjust) return say.adjustQuestion(style);
    const focus = session.presented.find((x) => x.id === session.focusPropertyId);
    if (session.state === 'VISIT_PROPOSAL' && focus) {
      const r = resolveWhen(session.draft ?? {});
      return say.askVisitWhen(style, 'at' in r ? 'both' : r.missing, session.draft?.ambiguousHour);
    }
    if (session.presented.length > 1) return say.askWhichPropertyAgain(style, session.presented);
    if (session.presented.length === 1) return say.shallWeSee(style, session.presented[0].name);
    if (session.state === 'GREETING') return say.canWeTalk(style);
    const q = qualificationState(session.slots);
    if (!q.complete) {
      this.markAsked(session, q.next!);
      return say.askSlot(style, q.next!, session.slots);
    }
    if (session.requirementChecked) return say.adjustQuestion(style);
    session.awaitingRequirementConfirm = true;
    session.requirementChecked = true;
    return say.confirmRequirement(style, session.slots);
  }

  /** Whole-inventory property named in the utterance (cached inventory, 5 min). */
  private async namedInventoryProperty(organizationId: string, text: string, session: Session, known: string[]): Promise<PresentedProperty | undefined> {
    let hit = this.inventoryCache.get(organizationId);
    if (!hit || Date.now() - hit.at > 5 * 60_000) {
      const rows = await this.prisma.property.findMany({ where: { organizationId, status: 'available' }, take: 300 });
      hit = {
        at: Date.now(),
        list: rows.map((p) => ({ id: p.id, name: p.name, location: p.location, type: p.type, bhk: p.bhk, price: Number(p.price), priceText: formatRupeesShort(Number(p.price)) })),
      };
      this.inventoryCache.set(organizationId, hit);
    }
    const rejected = new Set(session.rejectedPropertyIds ?? []);
    return findNamedProperty(text, hit.list.filter((p) => !rejected.has(p.id)), known);
  }

  private markAsked(s: Session, slot: NonNullable<Session['askedSlot']>) {
    s.askedCount[slot] = (s.askedSlot === slot ? s.askedCount[slot] ?? 0 : 0) + 1;
    s.askedSlot = slot;
  }

  /** Merge newly stated facts; returns only what actually changed. */
  private mergeSlots(s: Session, incoming: Slots): Slots {
    const changed: Slots = {};
    for (const key of Object.keys(incoming) as Array<keyof Slots>) {
      const value = incoming[key];
      if (value !== undefined && s.slots[key] !== value) {
        (s.slots as Record<string, unknown>)[key] = value;
        (changed as Record<string, unknown>)[key] = value;
      }
    }
    if (s.askedSlot && (s.askedSlot === 'bhk' ? changed.bhk || changed.propertyType : changed[s.askedSlot])) {
      s.askedSlot = undefined;
    }
    return changed;
  }

  /**
   * "Porur வேண்டாம்" / "Porur venda Velachery venum" / "vera area" / a new area while a Porur visit is being arranged.
   * The new value wins immediately, and everything tied to the old area goes: the options read out, the property in
   * focus, a pending visit proposal and a half-given visit time. Returns what changed, or undefined.
   */
  private applyAreaChange(s: Session, before: Slots, captured: Slots, extraction: ReturnType<typeof extractSlots>): Turn['areaChange'] {
    const rejected = extraction.rejectedLocations ?? [];
    const wantsOther = Boolean(extraction.wantsOtherArea);
    const switched = Boolean(captured.location && before.location && captured.location !== before.location);
    const droppedCurrent = Boolean(before.location && rejected.includes(before.location) && !extraction.slots.location);
    // "vera area" while a location is set, or the current area turned down: clear it until a new one is named.
    if ((droppedCurrent || (wantsOther && !extraction.slots.location)) && s.slots.location) delete s.slots.location;
    if (!switched && !droppedCurrent && !(wantsOther && !extraction.slots.location) && !(rejected.length && extraction.slots.location)) return undefined;
    s.rejectedLocations = [...new Set([...(s.rejectedLocations ?? []), ...rejected, ...(droppedCurrent || (wantsOther && before.location) ? [before.location!] : [])])];
    this.resetForNewSearch(s);
    const from = rejected[0] ?? (before.location && before.location !== s.slots.location ? before.location : undefined);
    return { rejected, from, to: s.slots.location };
  }

  /** Budget / BHK / type changed while a visit was being arranged: search again instead of asking for a time. */
  private invalidateOnNewCriteria(s: Session, captured: Slots) {
    if (!(captured.location || captured.budget || captured.bhk || captured.propertyType)) return;
    if (s.state === 'VISIT_PROPOSAL' || s.state === 'VISIT_CONFIRMATION' || s.state === 'PROPERTY_DISCUSSION') this.resetForNewSearch(s);
  }

  private resetForNewSearch(s: Session) {
    this.supersedePending(s, 'superseded');
    s.presented = [];
    s.focusPropertyId = undefined;
    s.offeredVisit = false;
    s.draft = undefined;
    s.visitMisses = 0;
    s.awaitingRequirementConfirm = false;
    s.searchedFor = undefined;
    if (s.state !== 'GREETING') s.state = 'QUALIFICATION';
  }

  /** Areas we actually have inventory in, minus the ones the customer turned down. */
  private areaOptions(s: Session, knownLocations: string[]): string[] {
    const no = new Set((s.rejectedLocations ?? []).map((x) => x.toLowerCase()));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of knownLocations) {
      const name = l.split(',')[0].trim();
      const key = name.toLowerCase();
      if (!name || no.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out.slice(0, 4);
  }

  private supersedePending(s: Session, status: VisitProposal['status']) {
    if (s.proposal?.status === 'pending') s.proposal.status = status;
  }

  private bestOutcome(s: Session): CallOutcome {
    if (s.outcome) return s.outcome as CallOutcome;
    return qualificationState(s.slots).complete ? 'qualified' : 'connected';
  }

  private advanceLead(s: Session, status: 'qualified' | 'property_interested') {
    this.background(s.key, () => this.leads.advanceLeadStatus({ organizationId: s.organizationId, leadId: s.leadId, status }));
  }

  /** Persist slots and messages after the reply is decided: none of it is on the customer's wait. */
  private persistTurn(turn: Turn, response: string, failed: boolean, path: 'rules' | 'llm') {
    const { session } = turn;
    const captured = turn.captured;
    this.background(session.key, async () => {
      if (turn.text) {
        await retryTransient(
          () =>
            this.conversations.addMessage({
              organizationId: session.organizationId,
              conversationId: session.conversationId,
              role: 'user',
              content: turn.text,
              metadata: { ...(turn.input.metadata ?? {}), intent: turn.intent, quality: turn.quality, state: session.state, language: turn.language?.current, callId: session.callId } as never,
            }),
          'message.user',
        );
      }
      await retryTransient(
        () =>
          this.conversations.addMessage({
            organizationId: session.organizationId,
            conversationId: session.conversationId,
            role: 'assistant',
            content: response,
            metadata: {
              actions: turn.actions,
              failed,
              path,
              state: session.state,
              callId: session.callId,
              intent: turn.intent,
              language: session.language.effective,
              languageChanged: turn.language?.changed,
              llmFallbackReason: turn.llmFallbackReason,
              aiRequests: turn.aiRequests ?? 0,
              ms: Date.now() - turn.now.getTime(),
              booking: turn.booking,
              deduped: turn.deduped || undefined,
            } as never,
          }),
        'message.assistant',
      );
    });
    if (Object.keys(captured).length > 0) {
      this.background(session.key, async () => {
        const update = {
          location: captured.location,
          budget: captured.budget,
          bhk: captured.bhk,
          propertyType: captured.propertyType,
          purchaseTimeline: captured.timeline,
        };
        const result = await retryTransient(() => this.conversations.updateCustomerMemory({ organizationId: session.organizationId, customerId: session.customerId, update }), 'customer.memory');
        if (result.updated) await retryTransient(() => this.leads.syncLeadFromCustomer(session.organizationId, session.customerId), 'lead.sync');
      });
    }
  }

  // Business effects executed by code (same behaviour as the previous tool callbacks) --------------

  private async markNotInterested(s: Session, reason: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: s.customerId } });
    await Promise.all([
      retryTransient(
        () =>
          this.prisma.customer.update({
            where: { id: s.customerId },
            data: { doNotContact: true, objections: `${customer?.objections ?? ''}\n${reason}`.trim().slice(-2000) },
          }),
        'customer.dnc',
      ),
      retryTransient(() => this.followUps.cancelPending({ organizationId: s.organizationId, customerId: s.customerId, reason: 'Customer not interested' }), 'followups.cancel'),
      this.leads.advanceLeadStatus({ organizationId: s.organizationId, leadId: s.leadId, status: 'not_interested' }),
    ]);
  }

  private async requestHandoff(s: Session, reason: string) {
    await Promise.all([
      retryTransient(() => this.followUps.createHumanTask({ organizationId: s.organizationId, leadId: s.leadId, customerId: s.customerId, reason: `Handoff: ${reason}` }), 'handoff.task'),
      retryTransient(() => this.followUps.cancelPending({ organizationId: s.organizationId, customerId: s.customerId, reason: 'Human handoff requested' }), 'followups.cancel'),
      this.leads.advanceLeadStatus({ organizationId: s.organizationId, leadId: s.leadId, status: 'human_handoff' }),
    ]);
  }

  private async scheduleCallback(s: Session, at: Date | undefined, note: string) {
    await retryTransient(() => this.prisma.customer.update({ where: { id: s.customerId }, data: { callbackAt: at ?? null } }), 'customer.callback');
    await this.followUps.scheduleCallback({ organizationId: s.organizationId, leadId: s.leadId, customerId: s.customerId, callbackAt: at, note: note.slice(0, 200) });
    await this.leads.advanceLeadStatus({ organizationId: s.organizationId, leadId: s.leadId, status: 'callback' });
  }

  // Session creation & lookups ---------------------------------------------------------------------

  private async createSession(input: GenerateResponseInput, organizationId: string, key: string, now: Date): Promise<Session> {
    const channel = input.channel;
    const customer = await this.conversations.getOrCreateCustomerByPhone(organizationId, input.phone, { name: input.customerName, source: channel });
    const [conversation, lead, organization] = await Promise.all([
      this.conversations.getOrCreateConversation({ organizationId, channel, externalId: customer.phone ?? input.phone, customerId: customer.id }),
      this.pickLead(organizationId, customer.id, channel, input.leadId),
      this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    ]);

    // Voice history is THIS call only (the opening line is added by openCallSession); a thread keeps its recent messages.
    let recent: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (channel !== 'voice') {
      const rows = await this.conversations.getRecentMessages(conversation.id, 8);
      recent = rows.map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.content.slice(0, 400) }));
    }

    const slots: Slots = {
      location: customer.location ?? undefined,
      budget: customer.budget ? Number(customer.budget) : undefined,
      bhk: customer.bhk ?? undefined,
      propertyType: customer.propertyType ?? undefined,
      timeline: customer.purchaseTimeline ?? undefined,
    };
    for (const k of Object.keys(slots) as Array<keyof Slots>) if (slots[k] === undefined) delete slots[k];

    return newSession({
      key,
      channel,
      organizationId,
      organizationName: organization?.name ?? config.defaultOrganizationName,
      customerId: customer.id,
      leadId: lead.id,
      conversationId: conversation.id,
      callId: input.callContext?.callId,
      customerName: customer.name ?? undefined,
      slots,
      language: initialLanguage(customer.language, channel),
      recent,
      now,
    });
  }

  private async pickLead(organizationId: string, customerId: string, channel: string, leadId?: string) {
    if (leadId) {
      const lead = await this.prisma.lead.findFirst({ where: { id: leadId, organizationId, customerId } });
      if (lead) return lead;
    }
    return this.leads.ensureActiveLead(organizationId, customerId, channel);
  }

  /** Every property name of the business (to catch the model naming one it was never shown). */
  private async inventoryNames(organizationId: string): Promise<string[]> {
    const hit = this.nameCache.get(organizationId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list;
    const rows = await this.prisma.property.findMany({ where: { organizationId }, select: { name: true }, take: 500 });
    const list = rows.map((r) => r.name);
    this.nameCache.set(organizationId, { at: Date.now(), list });
    return list;
  }

  private readonly inventoryCache = new Map<string, { at: number; list: PresentedProperty[] }>();

  /** Forget cached inventory / areas (after properties change; tests). */
  clearInventoryCache(organizationId?: string) {
    if (organizationId) {
      this.inventoryCache.delete(organizationId);
      this.locationCache.delete(organizationId);
    } else {
      this.inventoryCache.clear();
      this.locationCache.clear();
    }
  }

  private async knownLocations(organizationId: string): Promise<string[]> {
    const hit = this.locationCache.get(organizationId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list;
    const rows = await this.prisma.property.findMany({ where: { organizationId, status: 'available' }, select: { location: true }, distinct: ['location'], take: 200 });
    const list = [...new Set(rows.map((r) => r.location.split(',')[0].trim()).filter(Boolean))];
    this.locationCache.set(organizationId, { at: Date.now(), list });
    return list;
  }
}

/** ISO-8601 with +05:30 for an instant. */
function describeIso(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  return ist.toISOString().replace(/\.\d{3}Z$/, '+05:30');
}

/** Money mentioned in a reply: "72 lakhs", "1.2 crore", "₹72,00,000", "72 லட்சம்". */
const MONEY_RE = /₹\s?[\d,]+(?:\.\d+)?(?:\s*(?:lakhs?|lacs?|crores?|cr|l)\b)?|\b\d+(?:\.\d+)?\s*(?:lakhs?|lacs?|crores?|cr)\b|\d+(?:\.\d+)?\s*(?:லட்சம்|லட்சத்து|கோடி)/giu;

/** A question asking for a slot we already have ("Which area?" when the area is known). */
function asksKnownSlot(sentence: string, slots: Slots): boolean {
  if (!/[?？]\s*$/.test(sentence)) return false;
  const s = sentence.toLowerCase();
  if (slots.location && /(which|what)\s+(area|location|locality|place)|where (are|do) you|எந்த\s*(area|இடம்|ஏரியா|இடத்துல)|(entha|endha)\s+(area|idam|idathula)/iu.test(s)) return true;
  if (slots.budget && /budget/i.test(s) && /(what|how much|evlo|evvalavu|எவ்வளவு|எவ்ளோ|range)/iu.test(s)) return true;
  if (slots.bhk && /(how many|எத்தனை|ethanai|evlo)\s*bhk|bhk\s*(venum|வேணும்|do you need)/iu.test(s)) return true;
  return false;
}

/** Same reply as last time? (exact after normalising, or nearly the same words) */
export function similarReply(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // "Okay. What is your budget?" vs "Got it. What is your budget?": the same question with a different opener.
  // Only when everything before the question is a short opener (or identical): two different property lists that
  // both end with "want to visit?" are NOT a repeat.
  const split = (x: string) => {
    const parts = x.split(/(?<=[.!।])\s+/).filter(Boolean);
    const last = parts.at(-1) ?? '';
    return /[?？]\s*$/.test(last) ? { q: norm(last), rest: norm(parts.slice(0, -1).join(' ')) } : undefined;
  };
  const sa = split(a);
  const sb = split(b);
  if (sa && sb && sa.q === sb.q) {
    // An opener is an ack word, optionally with a short recap ("Okay. Porur, 2 BHK."); a property list is longer.
    const words = (r: string) => r.split(' ').filter(Boolean).length;
    const [lo, hi] = [words(sa.rest), words(sb.rest)].sort((x, y) => x - y);
    if (sa.rest === sb.rest || (lo <= 2 && hi <= 5)) return true;
  }
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((x) => tb.has(x)).length;
  return inter / new Set([...ta, ...tb]).size >= 0.85;
}

/** Logs keep the words (needed to debug real calls) but never a phone or account number. */
export function maskForLog(text: string): string {
  return text.replace(/\+?\d[\d\s-]{6,}\d/g, (m) => `***${m.replace(/\D/g, '').slice(-2)}`).slice(0, 240);
}

/** Answer to "இப்பவும் அதே தானா?" (is it still the same?): "அதே தான்", "same", "adhe dhaan". Details check only. */
function sameAsBefore(text: string): boolean {
  return /^(?:ஆமா[,]?\s*)?(?:அதே\s*தான்|அதேதான்|அதே|same(?:\s+only)?|adhe(?:\s*(?:dhaan|thaan|than))?|athe(?:\s*(?:dhaan|thaan|than))?|yes\s+same)(?:ங்க|nga)?[.!]?$/iu.test(text.trim());
}

/**
 * Puts a cached acknowledgement in front of a voice reply, unless the reply already starts with one, is itself a fixed
 * (pre-synthesized) line, or is an apology / re-prompt. Booking gets "சூப்பர்."; otherwise "சரிங்க." / "ஓகே." alternate.
 */
export function withSpokenAck(text: string, style: 'ta' | 'tl' | 'en', turn: number | 'booked'): string {
  // "சரிங்க, Porur-ல ..." started with an acknowledgement that was not its own (cached) sentence, so nothing played
  // for 2.2 s (real call 2026-10-10). Make it a sentence: it then plays from cache at once.
  const reply = text.trim().replace(/^(சரிங்க|ஓகே|Okay),\s+/u, '$1. ');
  if (!reply) return reply;
  const first = reply.split(/(?<=[.!?？])\s+/)[0] ?? '';
  const acks = [...say.ACK_LINES.ta, ...say.ACK_LINES.en];
  if (acks.some((a) => first === a || first.startsWith(a.replace(/\.$/, '')))) return reply;
  if (/^(sorry|ஹலோ|hello|மன்னிக்கணும்|ஆமாங்க|yes,)/iu.test(first)) return reply;
  if (say.isStaticVoiceLine(reply)) return reply;
  // A short reply is one quick TTS request anyway: an acknowledgement in front would only add a second one.
  if (reply.length <= 32) return reply;
  const lines = style === 'en' ? say.ACK_LINES.en : say.ACK_LINES.ta;
  const ack = turn === 'booked' ? lines[2] : lines[turn % 2];
  return `${ack} ${reply}`;
}
