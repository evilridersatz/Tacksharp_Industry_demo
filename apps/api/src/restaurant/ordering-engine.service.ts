import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { getRestaurantAgent, llmConfigured, type RestaurantAgentContext } from 'ai/agents/restaurant-agent.js';
import type { TacksharpAgentContext } from 'ai/agents/real-estate-agent.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { LlmRunner, type AiUsageMetrics } from '../ai/llm-runner.service.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { normalizePhone } from '../common/phone.js';
import { nowInIst } from '../common/time.js';
import { errorMessage, log } from '../common/logger.js';
import { describeWhen, istDate, istParts } from '../conversation/when.js';
import { detectLanguage } from '../conversation/language.js';
import { firstName } from '../whatsapp/message-templates.js';
import { CatalogService, type Catalog, type MenuItemView, type OutletView } from './catalog.service.js';
import { OrdersService, type Quote } from './orders.service.js';
import { OffersService } from './offers.service.js';
import { FeedbackService } from './feedback.service.js';
import { OrderFollowUpService } from './order-followup.service.js';
import { OrderSessionStore, type OrderSession } from './order-session.store.js';
import { isOpen } from './orders.service.js';
import { bareNumber, findMentions, mentionPolarities, unitOnly, asksAvailability, asksTotal, asksWhenToCome, excludesChicken, isAdditive, isDoneWords, mentionsComing, onlyThese, refersToIt, questionKind, classify, clean, filterAvailabilityClaims, findCut, findOrderNumber, formatQty, mentionsCut, parseItems, parsePayment, parsePickup, pickOutlet, CUT_SYNONYMS, type Intent } from './chicken-parse.js';
import { menuBlock, orderHint, say, spoken, toSpeech, type StockLine, type Style, type VoiceStyle } from './replies.js';
import { stockText } from './inventory.js';
import { mask } from '../whatsapp/whatsapp-sender.service.js';

export type RestaurantTurnInput = {
  organizationId: string;
  /**
   * whatsapp = real customer; voice = a phone call (spoken replies; the call layer plays them);
   * test = the dashboard's test chat (same flow, nothing is sent on WhatsApp).
   */
  channel: 'whatsapp' | 'test' | 'voice';
  phone: string;
  message: string;
  customerName?: string;
  metadata?: Record<string, unknown>;
  now?: Date;
};

export type RestaurantTurnResult = {
  conversationId: string;
  customerId: string;
  leadId: string;
  response: string;
  actions: Record<string, never>;
  timings: Record<string, number>;
  path: 'rules' | 'llm';
  /** Why the model was or was not used (see LlmStatus). */
  llm?: string;
  language?: string;
  languageInfo?: { current: string; previous: string; reply: string; changed: boolean; reason: string };
  state: OrderSession['step'];
  intent: Intent;
  aiUsage?: AiUsageMetrics;
  failed?: boolean;
  /** Set on the turn that created the order (or found the already-created one). */
  order?: { status: 'created' | 'duplicate'; id: string; orderNumber: string; total: number };
  /**
   * Voice only: the customer clearly ended the conversation (said goodbye, said "no" / "thanks" after their order
   * was placed, or asked for staff). Nothing else ends a call.
   */
  endCall?: boolean;
  endReason?: 'customer_goodbye' | 'done_after_order' | 'handoff';
  /** What has been collected so far (for the test chat panel). */
  draft: {
    lines: Array<{ name: string; quantity?: number; unit: string; cut?: string }>;
    payment?: string;
    pickupAt?: string;
    outlet?: string;
    offer?: number;
  };
};

const CONFIRM_TTL_MS = 30 * 60_000;
/** A draft untouched this long is from an earlier conversation: it is held and offered, not continued silently. */
const HOLD_AFTER_MS = 3 * 3600_000;
/** "continue", "same order", "அதே order": the customer wants the earlier (held) draft back. */
const CONTINUE_WORDS = /\b(continue|same order|old order|previous order|earlier order|adhe order|athe order|adhaiye|pazhaya order|munnadi order|resume)\b|அதே|அதையே|பழைய|முன்னாடி order/;
const style = (lang: OrderSession['lang']): Style => (lang === 'english' ? 'en' : lang === 'tamil' ? 'ta' : 'tl');
/** On the phone, Tamil and Tanglish are both spoken Tamil (the TTS voice reads Tamil script). */
const voiceStyle = (lang: OrderSession['lang']): VoiceStyle => (lang === 'english' ? 'en' : 'ta');
/** The reply style for this session: on the phone Tanglish is spoken as Tamil (the TTS voice reads Tamil script). */
const stFor = (s: Pick<OrderSession, 'channel' | 'lang'>): Style => (s.channel === 'voice' ? voiceStyle(s.lang) : style(s.lang));
/** Channels that are the same real customer (the dashboard test chat is not). */
const CUSTOMER_CHANNELS = ['whatsapp', 'voice'] as const;

/**
 * GR Chicken offer-claim / pickup-order conversation on WhatsApp.
 *
 * Everything that matters is decided in code: which products, how much, which cut, the price, the
 * offer discount, the total, whether the customer explicitly confirmed, and creating the order once.
 * The language model is only asked to phrase an answer to a free-form question the rules do not
 * cover, and its reply is filtered for prices that are not in the catalogue.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;
/** The shop this session collects from (the chosen one, else the first active one). */
const shopFor = (catalog: Catalog, s: Pick<OrderSession, 'outletId'>) => {
  const outlets = catalog.outlets.filter((o) => o.active);
  return outlets.find((o) => o.id === s.outletId) ?? outlets[0];
};
/** Something besides the removal itself (a product, an amount, payment or a time) — then it is not a bare "remove that". */
const hasSlotsBesidesRemoval = (parsed: { items: unknown[]; loose: { quantity?: number } }, payment: unknown, pickup: { kind: string }) =>
  parsed.items.length > 0 || parsed.loose.quantity !== undefined || !!payment || pickup.kind === 'at';
/** English words speech-to-text writes in Tamil script ("ok", "hello", "yes", "bye", "thanks"): no language evidence. */
const NEUTRAL_TAMIL_SCRIPT = /^(?:ஓகே|ஓக்கே|ஹலோ|ஹல்லோ|ஹாய்|எஸ்|யெஸ்|நோ|பை|தேங்க்ஸ்|தேங்க் யூ)[\s.!?]*$/u;
/**
 * Why the model was or was not used on a turn — logged and stored with the reply, so "aiRequests: 0" can be read:
 * not_needed = the rules answered (a known intent); not_configured = no OPENAI_API_KEY / OPENAI_BASE_URL, the help
 * reply was used; failed / empty / filtered_out = the model was asked and its answer could not be used.
 */
type LlmStatus = 'not_needed' | 'not_configured' | 'used' | 'filtered' | 'filtered_out' | 'failed' | 'empty';

@Injectable()
export class OrderingEngine {
  private readonly mutex = new KeyedMutex();
  /** A short note for the start of this turn's reply (e.g. "your earlier order was set aside"). */
  private readonly prefixes = new WeakMap<OrderSession, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly catalog: CatalogService,
    private readonly orders: OrdersService,
    private readonly offers: OffersService,
    private readonly feedback: FeedbackService,
    private readonly followUps: OrderFollowUpService,
    private readonly store: OrderSessionStore,
    private readonly llm: LlmRunner,
  ) {}

  generate(input: RestaurantTurnInput): Promise<RestaurantTurnResult> {
    const key = this.sessionKey(input);
    return this.mutex.run(key, () => this.store.withLock(key, () => this.turn(input, key)));
  }

  sessionKey(input: Pick<RestaurantTurnInput, 'organizationId' | 'channel' | 'phone'>) {
    return `${input.organizationId}:${input.channel}:${normalizePhone(input.phone) ?? input.phone}`;
  }

  private async turn(input: RestaurantTurnInput, key: string): Promise<RestaurantTurnResult> {
    const started = Date.now();
    const now = input.now ?? new Date();
    const text = input.message.trim().slice(0, 1000);
    const existing = await this.store.get(key);
    const s = existing ?? this.newSession(input, key);
    await this.ensureThread(s, input);
    if (!existing) await this.carryOver(s);
    // A chat picked up hours later is a new conversation: its old unplaced draft is held and offered, not reused.
    else if (s.channel !== 'voice' && s.lines.length && Date.now() - new Date(s.updatedAt).getTime() > HOLD_AFTER_MS) this.holdDraft(s, 'earlier');
    await this.conversations.addMessage({
      organizationId: s.organizationId,
      conversationId: s.conversationId!,
      role: 'user',
      content: text || '(empty message)',
      metadata: (input.metadata ?? undefined) as never,
    });

    const detected = detectLanguage(text);
    const previousLang = s.lang;
    // One or two words ("Hi", "ok", "cash") say little about the language: keep the current one (default Tanglish).
    // Typed Tamil script is clear evidence on WhatsApp. On a call one short transcript is not (speech-to-text writes
    // "ok" as "ஓகே"), so a call switches on a sentence of three or more words — or on two short Tamil turns in a row
    // that speech-to-text also heard as Tamil (ta-IN). Without that, a Tamil caller answering in short phrases
    // ("ரெண்டு கிலோ", "ஆமா") stayed in English for the whole call and heard an English voice (reported live call).
    const sttLanguage = typeof input.metadata?.sttLanguage === 'string' ? input.metadata.sttLanguage : undefined;
    let clearSentence = detected.words >= 3 || (detected.lang === 'tamil' && s.channel !== 'voice');
    if (s.channel === 'voice' && s.lang === 'english') {
      const shortTamil = !clearSentence && detected.lang === 'tamil' && sttLanguage?.startsWith('ta') && !NEUTRAL_TAMIL_SCRIPT.test(text.trim());
      s.tamilEvidence = shortTamil ? (s.tamilEvidence ?? 0) + 1 : 0;
      // Two Tamil words heard as ta-IN ("ரெண்டு கிலோ") switch at once; a single word needs a second turn.
      if (shortTamil && (detected.words >= 2 || s.tamilEvidence >= 2)) clearSentence = true;
    } else s.tamilEvidence = 0;
    if (clearSentence && (detected.lang === 'tamil' || detected.lang === 'tanglish' || detected.lang === 'english')) {
      // Remembered on the customer (shared by WhatsApp and phone). Only from a clear sentence, never guessed.
      if (detected.words >= 3 && s.customerId && s.channel !== 'test' && detected.lang !== s.lang) {
        await this.prisma.customer.updateMany({ where: { id: s.customerId, organizationId: s.organizationId }, data: { language: detected.lang } }).catch(() => undefined);
      }
      s.lang = detected.lang;
    }

    // A database hiccup while loading the menu must not crash the turn (on a call that would end the call):
    // the customer is asked to try again and nothing is decided.
    let catalog: Catalog = { categories: [], items: [], outlets: [] };
    let intent: Intent = 'unknown';
    let reply: string;
    let path: 'rules' | 'llm' = 'rules';
    let llm: LlmStatus = 'not_needed';
    let llmError: string | undefined;
    let failure: string | undefined;
    let aiUsage: AiUsageMetrics | undefined;
    let failed = false;
    let orderResult: RestaurantTurnResult['order'];
    let end: Pick<RestaurantTurnResult, 'endCall' | 'endReason'> = {};

    try {
      catalog = await this.catalog.get(s.organizationId);
      const campaign = await this.offers.activeCampaign(s.organizationId);
      intent = classify(text, campaign?.code);
      // Feedback replies ("5"), STOP / START and complaint details are handled before the ordering chat.
      const fb = s.customerId ? await this.feedback.handleInbound(s.organizationId, s.customerId, text, { conversationId: s.conversationId, channel: s.channel === 'voice' ? 'voice' : 'whatsapp' }) : undefined;
      const handled = fb ? { kind: 'say' as const, text: fb.reply, order: undefined } : await this.handle(s, text, intent, catalog, now);
      const prefix = this.prefixes.get(s);
      this.prefixes.delete(s);
      if (prefix && handled.kind === 'say') handled.text = `${prefix}\n\n${handled.text}`;
      let onlyPrompt = false;
      if (handled.kind === 'llm') {
        const run = await this.answerWithModel(s, text, catalog, now);
        // No usable model answer but a question is pending: say we did not understand and ask THAT question once,
        // instead of the generic how-to-order text followed by the same question.
        reply = run.path === 'rules' && handled.then ? say.notUnderstood(stFor(s), handled.then) : run.text + (handled.then ? `\n\n${handled.then}` : '');
        path = run.path;
        aiUsage = run.usage;
        llm = run.llm;
        llmError = run.llmError;
        // No model answer: the reply is just the standard help / the pending question again.
        onlyPrompt = run.path === 'rules';
      } else {
        reply = handled.text;
        orderResult = handled.order;
        onlyPrompt = Boolean((handled as { promptOnly?: boolean }).promptOnly);
        if (handled.end) end = { endCall: s.channel === 'voice', endReason: handled.end };
      }
      reply = this.avoidRepeat(s, reply, onlyPrompt, catalog);
      // Logs: a message that carried order details (product, amount, payment) is not "unknown".
      if (intent === 'unknown') {
        const p = parseItems(text, this.catalog.products(catalog));
        if (p.items.length || p.loose.quantity !== undefined || p.loose.cut || parsePayment(text)) intent = 'order_details';
      }
    } catch (error) {
      failed = true;
      failure = errorMessage(error).slice(0, 200);
      log.error('restaurant.turn_failed', { organizationId: s.organizationId, channel: s.channel, error: failure });
      reply = s.channel === 'voice' ? spoken.error(voiceStyle(s.lang)) : say.error(stFor(s));
    }
    if (s.channel === 'voice') reply = toSpeech(reply, voiceStyle(s.lang));

    // One structured line per turn: which path answered, why the model was (not) used, what the cart holds.
    // No message text, no phone number.
    log.info('restaurant.turn', {
      organizationId: s.organizationId,
      conversationId: s.conversationId,
      channel: s.channel,
      lang: s.lang,
      intent,
      path,
      llm,
      ...(llmError ? { llmError } : {}),
      ...(failure ? { failure } : {}),
      step: s.step,
      cartLines: s.lines.length,
      cartPriced: s.lines.filter((l) => l.quantity !== undefined).length,
      ...(orderResult ? { order: orderResult.status, orderNumber: orderResult.orderNumber } : {}),
      ...(end.endReason ? { endReason: end.endReason } : {}),
      ms: Date.now() - started,
    });
    s.history = [...s.history, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: reply }].slice(-8);
    await this.store.save(s);
    await this.conversations.addMessage({
      organizationId: s.organizationId,
      conversationId: s.conversationId!,
      role: 'assistant',
      content: reply,
      metadata: {
        path,
        intent,
        llm,
        ...(llmError ? { llmError } : {}),
        ...(failure ? { failure } : {}),
        step: s.step,
        ...(typeof input.metadata?.callId === 'string' ? { callId: input.metadata.callId } : {}),
        ...(end.endReason ? { endReason: end.endReason } : {}),
        ...(orderResult ? { orderId: orderResult.id, orderNumber: orderResult.orderNumber } : {}),
      } as never,
    });

    return {
      conversationId: s.conversationId!,
      customerId: s.customerId ?? '',
      leadId: '',
      response: reply,
      actions: {},
      timings: { totalMs: Date.now() - started },
      path,
      llm,
      // The call speaks the session's language (not each transcript's): reported so TTS / fillers follow it.
      language: s.lang === 'english' ? 'en-IN' : 'ta-IN',
      languageInfo: { current: s.lang, previous: previousLang, reply: s.lang, changed: s.lang !== previousLang, reason: s.lang !== previousLang ? `detected ${detected.lang} (${detected.words} words)` : 'kept' },
      state: s.step,
      intent,
      aiUsage,
      failed,
      order: orderResult,
      ...end,
      draft: this.draftView(s, catalog),
    };
  }

  // -----------------------------------------------------------------------------------------------
  // Decision logic
  // -----------------------------------------------------------------------------------------------

  private async handle(
    s: OrderSession,
    text: string,
    intent: Intent,
    catalog: Catalog,
    now: Date,
  ): Promise<{ kind: 'say'; text: string; order?: RestaurantTurnResult['order']; end?: RestaurantTurnResult['endReason']; promptOnly?: boolean } | { kind: 'llm'; then?: string }> {
    const st = stFor(s);
    const vs = voiceStyle(s.lang);
    const voice = s.channel === 'voice';
    const out = (t: string, order?: RestaurantTurnResult['order'], end?: RestaurantTurnResult['endReason']) => ({ kind: 'say' as const, text: t, order, end });
    /** A reply that only asks again for what is missing (no answer, no change): watched for repetition in turn(). */
    const promptOnly = (t: string) => ({ kind: 'say' as const, text: t, promptOnly: true });

    // Goodbye ends the conversation. A summary that was waiting for a yes is NOT placed, and the customer is told so.
    // "That's all" means "I'm done choosing" while an order is being built, and "bye" only when there is none.
    if (intent === 'goodbye' && s.lines.length && isDoneWords(text)) intent = 'done';
    if (intent === 'goodbye') {
      // Items chosen but no order placed: the customer is told it was NOT placed (never left to assume it was).
      const notPlaced = (s.step === 'awaiting_confirmation' && !!s.pending) || s.lines.length > 0;
      s.pending = undefined;
      s.step = 'collecting';
      return out(notPlaced ? say.byeNotPlaced(st) : say.bye(st), undefined, 'customer_goodbye');
    }
    // "Remove eggs", "egg வேண்டாம்", "Chicken மட்டும் போதும்": a cart edit by product name. Decided from the words around
    // each product in THIS message and the current cart — before "done" ("போதும்"), "change" or the review step can read
    // it as something else, and never from a stale pending question.
    if (s.lines.length && catalog.items.length) {
      const edit = await this.editByName(s, text, catalog, now);
      if (edit) return edit;
    }
    // "Order place pannunga", "place the order", "அவ்வளவுதான்": at the summary it is the yes; before that it moves
    // on to the next missing detail (payment / time / summary) instead of "sorry, didn't get that".
    if (intent === 'done') {
      // "நாலு போதும்" ("four is enough"), "egg மட்டும்தான், அவ்வளவுதான்": the amount / product in it is applied first
      // (and a review is shown again), never dropped because the message also says "enough".
      const carries = parseItems(text, this.catalog.products(catalog));
      if (carries.items.some((m) => m.quantity !== undefined) || carries.loose.quantity !== undefined || (onlyThese(text) && carries.items.length)) intent = 'unknown';
    }
    if (intent === 'done') {
      if (s.step === 'awaiting_confirmation' && s.pending && Date.now() <= s.pending.expiresAt) return this.placeOrder(s, catalog, now);
      if (!s.lines.length) return promptOnly(say.askProduct(st));
      return out(`${say.doneChoosing(st)} ${await this.advance(s, catalog, now, [])}`);
    }

    // No products configured for this organization (or none could be read): stock cannot be verified. Say so and
    // hand the conversation to staff — never "not available", and never let the model guess from an empty list.
    if (!catalog.items.length && !['order_status', 'human', 'thanks', 'decline'].includes(intent)) {
      log.warn('restaurant.catalog_unverified', { organizationId: s.organizationId, channel: s.channel });
      await this.prisma.conversation.updateMany({ where: { id: s.conversationId!, organizationId: s.organizationId }, data: { status: 'human_handoff', updatedAt: new Date() } });
      return out(voice ? spoken.menu(vs, []) : say.menuUnverified(st));
    }
    const availableNames = (except: string[] = []) => catalog.items.filter((i) => i.available && !except.includes(i.name)).map((i) => i.name);
    const availabilityQuestion = asksAvailability(text);

    // Offer: the first message of a thread (or "offer" / the link code) opens or creates the customer's offer.
    // On a call the opening line was already spoken by the call layer, so there is no written greeting or menu.
    let offerIntro = '';
    let offerChecked = false;
    if (!s.greeted || intent === 'offer') {
      const first = !s.greeted;
      s.greeted = true;
      if (s.customerId && !s.claimId) {
        offerChecked = true;
        // Offers are claimed on WhatsApp. A call only uses an offer the customer already has; it never creates one.
        const r = voice ? { claim: (await this.offers.openClaim(s.organizationId, s.customerId)) ?? undefined, alreadyUsed: false } : await this.offers.startFromChat(s.organizationId, s.customerId, s.phone);
        if (r.claim) {
          s.claimId = r.claim.id;
          s.offerAmount = Number(r.claim.amount);
          offerIntro = voice
            ? spoken.offer(vs, s.offerAmount)
            : say.offerGreeting(st, { name: firstName(s.name) || undefined, business: await this.orgName(s.organizationId), amount: s.offerAmount, menu: menuBlock(catalog, st), hint: orderHint(catalog) });
        } else if (r.alreadyUsed && intent === 'offer') {
          offerIntro = voice
            ? say.offerAlreadyUsed(st)
            : `${say.offerAlreadyUsed(st)}\n\n${say.plainGreeting(st, { name: firstName(s.name) || undefined, business: await this.orgName(s.organizationId), menu: menuBlock(catalog, st), hint: orderHint(catalog) })}`;
        }
      } else if (voice && intent === 'offer' && s.offerAmount) {
        offerIntro = spoken.offer(vs, s.offerAmount);
      }
      if (!offerIntro && first && !voice) {
        offerIntro = say.plainGreeting(st, { name: firstName(s.name) || undefined, business: await this.orgName(s.organizationId), menu: menuBlock(catalog, st), hint: orderHint(catalog) });
      }
    }

    // What the message says about the order.
    const products = this.catalog.products(catalog);
    const parsed = parseItems(text, products);

    // An unplaced draft from the other channel / an earlier call or chat. It is never applied silently: a new product
    // request sets it aside (and says so); "continue" / yes-to-the-offer restores it; a message that only answers its
    // next question (payment, pickup time) continues it; anything else gets ONE offer.
    if (s.held && !s.lines.length) {
      const h = s.held;
      const newRequest = parsed.items.length > 0 || parsed.loose.quantity !== undefined;
      const continues = CONTINUE_WORDS.test(clean(text)) || (h.offered && intent === 'confirm');
      const detailsOnly = !newRequest && (!!parsePayment(text) || (shopFor(catalog, s) ? parsePickup(text, now, shopFor(catalog, s)!, h.pickupDraft).kind !== 'none' : false));
      if (continues || detailsOnly) {
        this.restoreHeld(s, catalog);
        if (continues && !newRequest && !detailsOnly) return out([offerIntro, say.heldResumed(st), await this.advance(s, catalog, now, [])].filter(Boolean).join('\n\n'));
      } else if (newRequest) {
        log.info('restaurant.held_draft_set_aside', { organizationId: s.organizationId, channel: s.channel, from: h.from, lines: h.lines.length });
        s.held = undefined;
        // Said only when the draft came from the customer's OTHER channel (they may expect it); an old draft from an
        // earlier call / chat is just stale — mentioning it to a caller who asked for something else is noise.
        if (h.from !== 'earlier') this.prefixes.set(s, say.heldSetAside(st));
      } else if (h.offered && intent === 'decline') {
        s.held = undefined;
        return out(say.askProduct(st));
      } else if (!h.offered) {
        h.offered = true;
        const items = h.lines.map((l) => {
          const item = catalog.items.find((i) => i.id === l.itemId);
          return item ? `${l.quantity !== undefined ? `${formatQty(l.quantity, item.unit)} ` : ''}${item.name}${l.cut ? ` ${l.cut}` : ''}` : '';
        }).filter(Boolean).join(', ');
        if (items) return out([offerIntro, say.heldOffer(st, items)].filter(Boolean).join('\n\n'));
      }
    }
    const payment = parsePayment(text);
    const outlets = catalog.outlets.filter((o) => o.active);
    const shop = outlets.find((o) => o.id === s.outletId) ?? outlets[0];
    let pickup: ReturnType<typeof parsePickup> = shop ? parsePickup(text, now, shop, s.pickupDraft) : { kind: 'none' };
    const outletPick = outlets.length > 1 && !s.outletId ? pickOutlet(text, outlets) : undefined;
    // The question we are waiting on decides what a bare number answers: "4" after "when will you collect?" is
    // 4 o'clock (resolved inside the shop's hours, next occurrence), never 4 eggs; after "how many?" it is 4.
    const slot = this.nextSlot(s, catalog);
    const hourAnswer = bareNumber(text);
    const pickShop0 = (catalog.outlets.find((o) => o.id === s.outletId) ?? shop) as OutletView | undefined;
    if (slot === 'pickup' && hourAnswer !== undefined && !parsed.items.length && pickShop0 && !outletPick && !s.pickupDraft?.date && !s.pickupDraft?.fromPartOfDay) {
      parsed.loose.quantity = undefined;
      parsed.loose.qtyUnit = undefined;
      // A bare hour is read through the shop's hours: "4" can only be 4 PM at a 07:00–21:00 shop, so it is 4 PM;
      // "8" could be 8 AM or 8 PM, so we ASK. The reading must still be ahead today — no silent jump to tomorrow.
      const day = istParts(now);
      const readings = [hourAnswer % 12, (hourAnswer % 12) + 12]
        .map((h) => istDate(day.year, day.month, day.day, h, 0))
        .filter((at) => pickShop0.acceptOutsideHours || isOpen(pickShop0, at));
      if (readings.length === 1 && readings[0].getTime() > now.getTime()) pickup = { kind: 'at', at: readings[0] };
      else {
        s.pending = undefined;
        s.step = 'collecting';
        if (readings.length === 2) {
          s.pickupDraft = { ambiguousHour: hourAnswer };
          return out(say.askAmPm(st, hourAnswer));
        }
        return out(say.hourNotToday(st, hourAnswer, pickShop0.name, `${pickShop0.opensAt}–${pickShop0.closesAt}`));
      }
    } else if (slot === 'payment' && hourAnswer !== undefined && !parsed.items.length && !payment) {
      // "2" while we asked how they will pay: not a new quantity (a correction says so: "only 2", "2 podhum").
      return promptOnly(voice ? spoken.askPayment(vs) : say.askPayment(st));
    } else if (slot === 'pickup' && s.pickupDraft?.ambiguousHour !== undefined && !s.pickupDraft.date && pickShop0 && !parsed.items.length) {
      // The answer to "8 AM or 8 PM?".
      const t = clean(text);
      const pm = /\b(pm|evening|eve|night|saayangaalam|sayangalam|saayankaalam|raathiri|rathiri|iravu|afternoon|madhiyam)\b|மாலை|சாயங்காலம்|இரவு|ராத்திரி|மதியம்/.test(t);
      const am = /\b(am|morning|kaalai|kalai|kaalaila)\b|காலை/.test(t);
      if (pm !== am) {
        const h = s.pickupDraft.ambiguousHour % 12 + (pm ? 12 : 0);
        const day = istParts(now);
        const at = istDate(day.year, day.month, day.day, h, 0);
        s.pickupDraft = undefined;
        if (at.getTime() > now.getTime()) pickup = { kind: 'at', at };
        else return out(say.hourNotToday(st, h % 12 || 12, pickShop0.name, `${pickShop0.opensAt}–${pickShop0.closesAt}`));
        parsed.loose.quantity = undefined;
        parsed.loose.qtyUnit = undefined;
      }
    }
    // "2" while we are asking which shop picks shop 2; it is not "2 kg".
    if (outletPick && /^\d{1,2}$/.test(clean(text))) parsed.loose.quantity = undefined;
    // "4" when the pickup time is the only thing still missing (every product has its amount) is a TIME, not 4 eggs.
    if (pickup.kind === 'at' && !parsed.items.length && parsed.loose.qtyUnit === 'bare' && !s.pickupAt && s.lines.length && s.lines.every((l) => l.quantity !== undefined)) {
      parsed.loose.quantity = undefined;
      parsed.loose.qtyUnit = undefined;
    }
    // "nattukozhi muttai", "நாட்டுக்கோழி முட்டை இருக்கா": country-chicken EGGS, not Country Chicken meat. If the egg
    // product does not say it is that kind, say which eggs the shop has and ask — nothing is added, and Country Chicken
    // meat is not mentioned.
    const kindEgg = parsed.items.find((m) => m.variant && !this.eggCovers(catalog, m.itemId, m.variant));
    if (kindEgg) {
      const egg = catalog.items.find((i) => i.id === kindEgg.itemId)!;
      const kindItem = products.find((p) => clean(`${p.name} ${p.aliases.join(' ')}`).split(' ').includes(kindEgg.variant!.split(' ')[0]));
      s.pending = undefined;
      s.step = 'collecting';
      if (!egg.available) return out([offerIntro, say.unavailable(st, [egg.name]), say.alternatives(st, availableNames([egg.name]))].filter(Boolean).join('\n\n'));
      s.interestItemId = egg.id;
      s.pendingQty = kindEgg.quantity !== undefined ? { quantity: kindEgg.quantity, unit: kindEgg.qtyUnit } : undefined;
      const price = egg.unit === 'piece' ? `₹${egg.price}/pc` : `₹${egg.price}/kg`;
      return out([offerIntro, say.eggKindNotListed(st, kindItem?.name ?? kindEgg.variant!, egg.name, price)].filter(Boolean).join('\n\n'));
    }
    // "என்னங்க bro, kg-ல" while we asked "how many kg of X?": the unit is agreed — ask the amount once, nothing else.
    const unitSaid = unitOnly(text);
    if (unitSaid && slot === 'qty' && !parsed.items.length && !payment && pickup.kind === 'none') {
      const focusItem = catalog.items.find((i) => i.id === (s.lines.find((l) => l.itemId === s.focusItemId && l.quantity === undefined) ?? s.lines.find((l) => l.quantity === undefined))?.itemId);
      if (focusItem) {
        s.focusItemId = focusItem.id;
        return out(unitSaid === focusItem.unit ? say.askQty(st, focusItem.name, focusItem.unit) : say.wrongUnit(st, focusItem.name, focusItem.unit));
      }
    }
    const removing = intent === 'remove' && mentionsCut(text) !== 'whole';
    const hasSlots = parsed.items.length > 0 || parsed.loose.quantity !== undefined || parsed.loose.cut !== undefined || !!payment || pickup.kind !== 'none' || !!outletPick;

    // 0. A question about what is in stock / how much is answered first, from the database, and changes nothing in
    //    the order ("which chicken is available?" is not an order for broiler). Only a message that also carries
    //    order details (a quantity, a cut, payment, a pickup time) goes on to the order rules below.
    const question = questionKind(text);
    const looseCutApplies = parsed.loose.cut !== undefined && (s.lines.length > 0 || parsed.items.length > 0);
    const orderDetails = parsed.items.some((m) => m.quantity !== undefined || m.cut) || parsed.loose.quantity !== undefined || looseCutApplies || !!payment || pickup.kind === 'at' || !!outletPick;
    // Delivery, shop address, order status, staff and offers have their own answers even when phrased "…irukka?".
    const ownAnswer = ['delivery', 'outlets', 'order_status', 'human', 'goodbye', 'offer', 'clear'].includes(intent);
    // "Evlo aagum?" with something in the cart: the cart total (database prices), not the menu.
    if (asksTotal(text) && !parsed.items.length && !orderDetails && s.lines.some((l) => l.quantity !== undefined)) {
      return out([this.cartText(s, catalog, st), await this.advance(s, catalog, now, [])].filter(Boolean).join('\n\n'));
    }
    // "Ethana manikku varanum?" — a question about WHEN to come: answer it (hours + earliest ready time); it is not
    // a pickup time, and answering it with "when will you come?" again was the reported repeated question.
    if (asksWhenToCome(text) && !orderDetails && !ownAnswer && shop) {
      const at = this.earliestPickup(catalog.outlets.find((o) => o.id === s.outletId) ?? shop, now);
      return out(say.whenToCome(st, (catalog.outlets.find((o) => o.id === s.outletId) ?? shop).name, `${shop.opensAt}–${shop.closesAt}`, describeWhen(at, st)));
    }
    // "Boneless price enna?": the price of THAT product from the database. Asking a price never adds to the cart.
    if (intent === 'menu' && parsed.items.length && parsed.items.every((m) => m.quantity === undefined && !m.cut) && !payment && pickup.kind !== 'at' && !outletPick) {
      return out([await this.answerStockQuestion(s, 'availability', parsed.items, catalog, now), offerIntro].filter(Boolean).join('\n\n'));
    }
    if (question && !orderDetails && !ownAnswer) {
      // First message of a chat: answer, then the offer / welcome (the question comes first).
      return out([await this.answerStockQuestion(s, question, parsed.items, catalog, now), offerIntro].filter(Boolean).join('\n\n'));
    }

    // "change பண்ணனும்" / "மாற்றணும்" with nothing else: leave the review, ask what to change (never repeat the review,
    // never place). A change that names what to change ("change to 4 eggs") goes through the order rules below.
    if (intent === 'change' && !hasSlots && !removing) {
      s.pending = undefined;
      s.step = 'collecting';
      return out(s.lines.length ? say.whatToChange(st) : say.askProduct(st));
    }

    // 1. The confirmation step: only an explicit yes places the order.
    if (s.step === 'awaiting_confirmation' && s.pending) {
      if (intent === 'confirm' && !hasSlots) {
        if (Date.now() > s.pending.expiresAt) {
          s.pending = undefined;
          return out(await this.advance(s, catalog, now, []));
        }
        return this.placeOrder(s, catalog, now);
      }
      if (intent === 'decline' && !hasSlots) {
        s.pending = undefined;
        s.step = 'collecting';
        return out(say.notPlaced(st));
      }
      if (!hasSlots && !removing && intent !== 'clear' && intent !== 'menu' && intent !== 'human' && intent !== 'order_status') {
        return out(`${await this.summaryText(s, catalog, now)}\n\n${s.channel === 'voice' ? '' : say.confirmReminder(st)}`.trim());
      }
    }

    if (intent === 'clear') {
      this.reset(s);
      return out(say.cleared(st));
    }
    // "No chicken", "எனக்கு chicken வேணாம்": every chicken product goes, eggs stay. Never removes eggs, never adds anything.
    if (excludesChicken(text) && !parsed.items.some((m) => !m.generic)) {
      const isChicken = (id: string) => this.isChicken(catalog, id);
      const dropped = s.lines.filter((l) => isChicken(l.itemId)).map((l) => catalog.items.find((i) => i.id === l.itemId)!.name);
      s.lines = s.lines.filter((l) => !isChicken(l.itemId));
      if (s.pendingQty) s.pendingQty = undefined;
      if (s.interestItemId && isChicken(s.interestItemId)) s.interestItemId = undefined;
      if (s.focusItemId && isChicken(s.focusItemId)) s.focusItemId = undefined;
      this.changed(s);
      return out([dropped.length ? say.removed(st, dropped) : say.noChicken(st), s.lines.length ? await this.advance(s, catalog, now, []) : say.askProduct(st)].join('\n\n'));
    }
    if (removing && !parsed.items.length && !hasSlotsBesidesRemoval(parsed, payment, pickup)) {
      // "Adha remove pannunga", "illa, adha vendaam": the product just talked about. Never guess between two lines.
      if (!s.lines.length) return out(say.cartEmpty(st));
      const focus = s.lines.find((l) => l.itemId === s.focusItemId);
      const target = refersToIt(text) ? focus ?? (s.lines.length === 1 ? s.lines[0] : undefined) : s.lines.length === 1 ? s.lines[0] : undefined;
      if (!target) return promptOnly(say.whichToRemove(st, s.lines.map((l) => catalog.items.find((i) => i.id === l.itemId)?.name ?? '').filter(Boolean)));
      const name = catalog.items.find((i) => i.id === target.itemId)?.name ?? '';
      s.lines = s.lines.filter((l) => l !== target);
      s.focusItemId = undefined;
      this.changed(s);
      return out(`${say.removed(st, [name])}\n\n${s.lines.length ? await this.advance(s, catalog, now, []) : say.askProduct(st)}`);
    }
    if (removing && parsed.items.length) {
      // Only what is actually in the cart is "removed"; a product that was never added is acknowledged, not removed
      // (it was: "Chicken curry cut வேண்டாம்" with only eggs → "Chicken Curry Cut removed").
      const name = (id: string) => catalog.items.find((i) => i.id === id)!.name;
      const inCart = parsed.items.filter((m) => s.lines.some((l) => l.itemId === m.itemId)).map((m) => name(m.itemId));
      const notIn = parsed.items.filter((m) => !s.lines.some((l) => l.itemId === m.itemId)).map((m) => name(m.itemId));
      s.lines = s.lines.filter((l) => !parsed.items.some((m) => m.itemId === l.itemId));
      if (s.interestItemId && parsed.items.some((m) => m.itemId === s.interestItemId)) s.interestItemId = undefined;
      if (s.focusItemId && parsed.items.some((m) => m.itemId === s.focusItemId)) s.focusItemId = undefined;
      this.changed(s);
      const said = [inCart.length ? say.removed(st, inCart) : '', notIn.length ? say.notInCart(st, notIn) : ''].filter(Boolean).join(' ');
      return out(`${said}\n\n${s.lines.length ? await this.advance(s, catalog, now, []) : say.askProduct(st)}`);
    }

    // 2. Apply everything the message said, in any order.
    if (hasSlots) {
      s.suggestQty = undefined; // a new answer replaces a pending "3 eggs?" suggestion
      const noted: string[] = [];
      const itemNoted: string[] = [];
      const notes: string[] = [];
      const unavailable: string[] = [];
      let insteadOf: MenuItemView | undefined;
      /** A quantity was refused and the note already asks the next question: do not ask again after it. */
      let asked = false;
      // "Innum oru kilo add pannunga": added to what is already there, not a replacement.
      const additive = isAdditive(text);
      const lineText = (line: { quantity?: number; cut?: string }, item: MenuItemView) =>
        `${line.quantity !== undefined ? `${formatQty(line.quantity, item.unit)} ` : ''}${item.name}${line.cut ? ` ${line.cut}` : ''}${line.quantity !== undefined ? ` — ₹${round2(item.price * line.quantity)}` : ''}`;
      const setQty = (line: { quantity?: number }, item: MenuItemView, raw: number, unit?: 'kg' | 'piece' | 'bare') => {
        const r = this.acceptQty(item, raw, unit, st, catalog);
        if (r.note) {
          notes.push(r.note);
          asked = true;
          s.focusItemId = item.id;
          if (r.suggest !== undefined) s.suggestQty = { itemId: item.id, quantity: r.suggest };
        } else line.quantity = r.qty;
      };
      for (const m of parsed.items) {
        const item = catalog.items.find((i) => i.id === m.itemId)!;
        // Availability is the catalogue's word: staff mark products available / not available on the dashboard.
        if (!item.available) {
          // "1 kg chicken" when the shop's default chicken is off today: the amount is kept and the customer picks one
          // of the chicken products that ARE available (the next product named gets it).
          if (m.generic && m.quantity !== undefined && parsed.items.length === 1) s.pendingQty = { quantity: m.quantity, unit: m.qtyUnit };
          // "Broiler curry cut" while Broiler is off: the cut product (Chicken Curry Cut) is OFFERED — added only after
          // a yes, with the amount they said. Never substituted silently.
          const alt = m.cutProduct ? catalog.items.find((i) => i.id === m.cutProduct && i.available) : undefined;
          if (alt && parsed.items.length === 1) {
            insteadOf = alt;
            s.interestItemId = alt.id;
            s.pendingQty = m.quantity !== undefined ? { quantity: m.quantity, unit: m.qtyUnit } : undefined;
          }
          unavailable.push(item.name);
          continue;
        }
        if (availabilityQuestion && m.quantity === undefined && !s.lines.some((l) => l.itemId === item.id)) notes.push(item.stockQty === null ? say.stockUnknown(st, item.name, item.price, item.unit) : say.inStock(st, item.name, item.price, item.unit));
        let line = s.lines.find((l) => l.itemId === item.id);
        const was = line ? { quantity: line.quantity, cut: line.cut } : undefined;
        if (!line) {
          line = { itemId: item.id };
          s.lines.push(line);
        }
        s.focusItemId = item.id;
        // "ஒரு கிலோ" first, product next ("…boneless"): the amount said before is for this product.
        if (m.quantity === undefined && line.quantity === undefined && s.pendingQty && parsed.items.length === 1) {
          setQty(line, item, s.pendingQty.quantity, s.pendingQty.unit);
          s.pendingQty = undefined;
        } else if (m.quantity !== undefined) setQty(line, item, additive && line.quantity !== undefined ? line.quantity + m.quantity : m.quantity, m.qtyUnit);
        if (m.cut) line.cut = m.cut;
        else if (mentionsCut(text) && item.cutOptions.length && !line.cut) notes.push(say.cutNotOffered(st, item.name, item.cutOptions));
        // Naming a product already in the cart, with nothing new ("leg piece" again while we ask its amount): no
        // "Got it X" before the same question — the question alone.
        if (was && was.quantity === line.quantity && was.cut === line.cut) continue;
        itemNoted.push(lineText(line, item));
      }
      // Every product asked for is unavailable and nothing else was said: say so, offer what IS available, show what
      // is still in the cart — and do NOT re-show (or leave armed) the old review: a "yes" now must not place the
      // previous cart as if it answered this request.
      if (unavailable.length && unavailable.length === parsed.items.length && parsed.loose.quantity === undefined && !parsed.loose.cut && !payment && pickup.kind === 'none' && !outletPick) {
        s.pending = undefined;
        s.step = 'collecting';
        const cartNow = s.lines
          .map((l) => {
            const item = catalog.items.find((i) => i.id === l.itemId);
            return item ? `${l.quantity !== undefined ? `${formatQty(l.quantity, item.unit)} ` : ''}${item.name}${l.cut ? ` ${l.cut}` : ''}` : '';
          })
          .filter(Boolean)
          .join(', ');
        const price = (i: MenuItemView) => (i.unit === 'piece' ? `₹${i.price}/pc` : `₹${i.price}/kg`);
        return out(
          [
            offerIntro,
            [say.unavailable(st, unavailable), insteadOf ? say.offerInstead(st, insteadOf.name, price(insteadOf)) : say.alternatives(st, availableNames(unavailable))].filter(Boolean).join(' '),
            cartNow ? say.cartStill(st, cartNow) : '',
            insteadOf ? '' : say.askProduct(st),
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
      }
      // "Egg mattum venum", "எனக்கு eggs தான் வேணும்": the named products and nothing else.
      if (onlyThese(text) && parsed.items.length && !removing) {
        const others = s.lines.filter((l) => !parsed.items.some((m) => m.itemId === l.itemId));
        if (others.length) {
          notes.push(say.removed(st, others.map((l) => catalog.items.find((i) => i.id === l.itemId)?.name ?? '').filter(Boolean)));
          s.lines = s.lines.filter((l) => parsed.items.some((m) => m.itemId === l.itemId));
        }
      }
      if (unavailable.length) notes.push([say.unavailable(st, unavailable), say.alternatives(st, availableNames(unavailable))].filter(Boolean).join(' '));
      if (intent === 'delivery') notes.push(say.pickupOnly(st, this.shopNames(outlets)));
      // "what are your prices today": the question is answered even though "today" also reads as a pickup day.
      if (intent === 'menu') notes.push(voice ? spoken.menu(vs, catalog.items) : menuBlock(catalog, st));
      if (parsed.loose.quantity !== undefined || parsed.loose.cut) {
        const target = this.looseTarget(s, catalog, parsed.loose);
        if (!target && parsed.loose.quantity !== undefined && !parsed.items.length) {
          // An amount with no product ("எனக்கு ஒரு கிலோ சிக்கன் வேணும்" when no product is plain "chicken"): keep it and
          // ask which product, instead of dropping it and asking for everything again.
          s.pendingQty = { quantity: parsed.loose.quantity, unit: parsed.loose.qtyUnit };
          const amount = parsed.loose.qtyUnit === 'piece' ? String(parsed.loose.quantity) : formatQty(parsed.loose.quantity, 'kg');
          notes.push(say.whichProductFor(st, amount, availableNames()));
          asked = true;
        }
        if (target) {
          const item = catalog.items.find((i) => i.id === target.itemId)!;
          if (parsed.loose.quantity !== undefined) setQty(target, item, additive && target.quantity !== undefined ? target.quantity + parsed.loose.quantity : parsed.loose.quantity, parsed.loose.qtyUnit);
          if (parsed.loose.cut) {
            const cut = this.cutFor(item, parsed.loose.cut);
            if (cut) target.cut = cut;
            else if (item.cutOptions.length) notes.push(say.cutNotOffered(st, item.name, item.cutOptions));
          }
          itemNoted.push(lineText(target, item));
        }
      }
      if (payment) {
        s.payment = payment;
        noted.push(say.paymentLabel(st, payment));
      }
      if (outletPick) s.outletId = outletPick.id;
      if (pickup.kind === 'at') {
        // Earlier than the shop can cut and pack ("ippo varen", "10 nimishathula"): ready at the earliest time instead.
        const prep = (catalog.outlets.find((o) => o.id === s.outletId) ?? shop)?.prepMinutes ?? 30;
        const earliest = this.earliestPickup({ prepMinutes: prep }, now);
        const at = pickup.at.getTime() < earliest.getTime() ? earliest : pickup.at;
        const pickShop = catalog.outlets.find((o) => o.id === s.outletId) ?? shop;
        if (pickShop && !pickShop.acceptOutsideHours && !isOpen(pickShop, at)) {
          // "1 hr" at 12:33 AM = 1:33 AM: the shop is closed then. Say so and ask again — the time is NOT taken
          // (it was: "Got it 1:33 AM" followed by "the shop is open 07:00–21:00").
          s.pickupAt = undefined;
          s.pending = undefined;
          s.step = 'collecting';
          notes.push(say.outsideHours(st, pickShop.name, `${pickShop.opensAt}–${pickShop.closesAt}`, describeWhen(at, st)));
          asked = true;
        } else {
          // Only when they asked for clearly earlier than we can be ready ("ippo varen"), not "within 30 mins".
          if (at !== pickup.at && earliest.getTime() - pickup.at.getTime() > 5 * 60_000) notes.push(say.readyBy(st, prep));
          s.pickupAt = at.toISOString();
          s.pickupDraft = undefined;
          noted.push(describeWhen(at, st));
        }
      } else if (pickup.kind === 'partial') {
        // A day or part of day without an hour ("evening", "நாளைக்கு"): the old time no longer holds; ask the hour.
        s.pickupDraft = pickup.draft;
        s.pickupAt = undefined;
      }
      this.changed(s);
      // Two or more priced products: show the whole cart with its running total instead of only what changed.
      const priced = s.lines.filter((l) => l.quantity !== undefined);
      const showCart = itemNoted.length > 0 && priced.length >= 2 && !asked;
      const cart = showCart
        ? say.cart(
            st,
            priced.map((l) => {
              const item = catalog.items.find((i) => i.id === l.itemId)!;
              return { name: `${item.name}${l.cut ? ` ${l.cut}` : ''}`, qty: formatQty(l.quantity!, item.unit), total: round2(item.price * l.quantity!) };
            }),
            round2(priced.reduce((sum, l) => sum + catalog.items.find((i) => i.id === l.itemId)!.price * l.quantity!, 0)),
          )
        : '';
      const said = [...(showCart || asked ? [] : itemNoted), ...noted];
      const lead = [offerIntro, said.length && !offerIntro ? say.noted(st, said) : '', cart, ...notes].filter(Boolean).join('\n\n');
      return out([lead, asked ? '' : await this.advance(s, catalog, now, [])].filter(Boolean).join('\n\n'));
    }

    if (offerIntro) {
      // The first message may also be a question ("Hi, home delivery irukka?"): answer it with the greeting.
      const answer =
        intent === 'delivery'
          ? say.pickupOnly(st, this.shopNames(outlets))
          : intent === 'outlets'
            ? say.outlets(st, this.outletList(outlets))
            : intent === 'order_status'
              ? await this.statusText(s, text)
              : availabilityQuestion && !parsed.items.length && intent !== 'menu'
                ? say.notInList(st, availableNames())
                : '';
      // Details the customer already gave on their other channel: pick up where they left off.
      const carried = s.carriedFrom && (s.lines.length || s.payment || s.pickupAt) ? await this.advance(s, catalog, now, []) : '';
      return out([offerIntro, answer, carried].filter(Boolean).join('\n\n'));
    }

    // "Pickup-ku varren" with no time while the time is still needed: one focused question with the earliest option,
    // not the generic help text plus the same question again.
    if (mentionsComing(text) && !s.pickupAt && s.lines.length && shop && intent !== 'delivery') {
      return promptOnly(say.askPickupTimeOnly(st, describeWhen(this.earliestPickup(catalog.outlets.find((o) => o.id === s.outletId) ?? shop, now), st)));
    }

    // 3. Questions and requests that do not change the order.
    // advance() may arm the summary for a yes (step = awaiting_confirmation). A reply that does NOT show that summary
    // must not leave it armed — otherwise "No" → "order not placed", and the next "yes" placed it anyway.
    // "சரி" after "3 Eggs போடலாமா?" (they said 3 kilo of eggs): that count goes on the line.
    if (s.suggestQty) {
      const sq = s.suggestQty;
      const line = s.lines.find((l) => l.itemId === sq.itemId);
      const item = catalog.items.find((i) => i.id === sq.itemId);
      if (!line || !item || intent === 'decline') s.suggestQty = undefined;
      // Unclear speech while we wait for that yes / no: ask the same question again (the suggestion stays).
      else if (intent !== 'confirm' && voice && clean(text).split(' ').filter(Boolean).length <= 3) return out(say.notUnderstood(st, say.confirmPieces(st, item.name, sq.quantity)));
      else s.suggestQty = undefined;
      if (intent === 'decline' && line && item) return out(say.askQty(st, item.name, item.unit));
      if (intent === 'confirm' && line && item) {
        const r = this.acceptQty(item, sq.quantity, 'bare', st, catalog);
        if (r.note) return out(r.note);
        line.quantity = r.qty;
        this.changed(s);
        return out([say.noted(st, [`${formatQty(line.quantity!, item.unit)} ${item.name}`]), await this.advance(s, catalog, now, [])].join('\n\n'));
      }
    }
    // "Ok" / "yes" after "we have regular Eggs — OK?": add that product (with the amount already said, if any).
    if (intent === 'confirm' && s.interestItemId && !s.lines.some((l) => l.itemId === s.interestItemId)) {
      const item = catalog.items.find((i) => i.id === s.interestItemId && i.available);
      s.interestItemId = undefined;
      if (item) {
        const line: OrderSession['lines'][number] = { itemId: item.id };
        s.lines.push(line);
        s.focusItemId = item.id;
        const notes: string[] = [];
        if (s.pendingQty) {
          const r = this.acceptQty(item, s.pendingQty.quantity, s.pendingQty.unit, st, catalog);
          s.pendingQty = undefined;
          if (r.note) return out(r.note);
          line.quantity = r.qty;
        }
        this.changed(s);
        return out([say.noted(st, [item.name]), ...notes, await this.advance(s, catalog, now, [])].filter(Boolean).join('\n\n'));
      }
    }
    const before = { step: s.step, pending: s.pending };
    const resume = s.lines.length || s.payment || s.pickupAt ? await this.advance(s, catalog, now, []) : '';
    const unshown = <T,>(reply: T): T => {
      s.step = before.step;
      s.pending = before.pending;
      return reply;
    };
    const help = voice ? spoken.help(vs, orderHint(catalog)) : say.help(st, orderHint(catalog));
    // On a call, "no" / "thanks" right after the order was placed (we asked "anything else?") is the end of the call.
    const doneAfterOrder = voice && !!s.orderedOnCall && !s.lines.length;
    switch (intent) {
      case 'menu':
        return out([voice ? spoken.menu(vs, catalog.items) : menuBlock(catalog, st) || say.nothingToday(st), resume].filter(Boolean).join('\n\n'));
      case 'order_start':
        // "order pannanum" / "ஆர்டர் பண்ணணும்": show what can be ordered and ask which (no generic help text).
        return out([voice ? spoken.menu(vs, catalog.items) : menuBlock(catalog, st) || say.nothingToday(st), resume || say.askProduct(st)].filter(Boolean).join('\n\n'));
      case 'outlets':
        return out([say.outlets(st, this.outletList(outlets)), resume].filter(Boolean).join('\n\n'));
      case 'delivery':
        return out([say.pickupOnly(st, this.shopNames(outlets)), resume].filter(Boolean).join('\n\n'));
      case 'order_status':
        return unshown(out(await this.statusText(s, text)));
      case 'human':
        return unshown(out(await this.handoff(s), undefined, voice ? 'handoff' : undefined));
      case 'thanks':
        return doneAfterOrder ? out(say.bye(st), undefined, 'done_after_order') : voice ? promptOnly(resume || help) : unshown(out(say.thanks(st)));
      case 'greeting':
      case 'offer':
        if (voice) return offerChecked && intent === 'offer' ? out([spoken.noOffer(vs), resume || help].join(' ')) : promptOnly(resume || help);
        if (resume) return promptOnly(resume);
        return out(say.plainGreeting(st, { name: firstName(s.name) || undefined, business: await this.orgName(s.organizationId), menu: menuBlock(catalog, st), hint: orderHint(catalog) }));
      case 'confirm':
        if (s.lastOrderNumber && !s.lines.length) return unshown(out(say.alreadyPlaced(st, s.lastOrderNumber)));
        return promptOnly(resume || help);
      case 'decline':
        // An explicit "no": nothing is waiting for a yes afterwards.
        s.pending = undefined;
        s.step = 'collecting';
        if (doneAfterOrder) return out(say.bye(st), undefined, 'done_after_order');
        return s.lines.length ? out(say.notPlaced(st)) : voice ? promptOnly(help) : out(say.thanks(st));
      case 'remove':
        return promptOnly(resume || help);
      default:
        // "mutton irukka?", "leg piece irukka?": not a product we know. Whether the shop has it is unknown, so the
        // rules say so; the model is never asked about availability.
        if (availabilityQuestion) return out([say.notInList(st, availableNames()), resume].filter(Boolean).join('\n\n'));
        // On a call, a short unclear transcript ("நீ நீ", a cough read as words) while we wait for an answer is
        // speech-to-text noise: ask that question again, never a model answer that wanders to other steps.
        if (voice && resume && clean(text).split(' ').filter(Boolean).length <= 3) return out(say.notUnderstood(st, resume));
        return { kind: 'llm', then: resume || undefined };
    }
  }

  /** The egg product itself is that kind ("Country Eggs" / alias "nattu muttai" for "nattukozhi muttai"). */
  private eggCovers(catalog: Catalog, eggId: string, variant: string): boolean {
    const egg = catalog.items.find((i) => i.id === eggId);
    if (!egg) return false;
    const own = clean(`${egg.name} ${egg.aliases.join(' ')}`).split(' ').filter((w) => w.length > 2 && !/^(egg|eggs|muttai|முட்டை|chicken|kozhi|கோழி)$/.test(w));
    return variant.split(' ').some((v) => own.some((w) => v.startsWith(w) || w.startsWith(v)));
  }

  /** Chicken meat (not eggs): a kg product, or anything named / filed as chicken. */
  private isChicken(catalog: Catalog, id: string): boolean {
    const item = catalog.items.find((i) => i.id === id);
    return !!item && !/\begg|முட்டை/i.test(`${item.name} ${item.categoryName}`) && (item.unit === 'kg' || /chicken|கோழி/i.test(`${item.name} ${item.categoryName}`));
  }

  /**
   * Removing / keeping products by name. Each product mention is read with the words around it (mentionPolarities):
   * "ஆறு egg வேண்டாம்" removes Eggs; "Chicken மட்டும் போதும்" keeps the chicken lines and removes the rest; "No
   * chicken" removes chicken (eggs stay). Only lines really in the cart are named as removed. A product asked both to
   * stay and to go is not guessed: one short question. A correction ("6 eggs venam, 4 podhum") is left to the
   * quantity rules. Returns undefined when the message is not such an edit.
   */
  private async editByName(s: OrderSession, text: string, catalog: Catalog, now: Date): Promise<{ kind: 'say'; text: string; promptOnly?: boolean } | undefined> {
    const products = this.catalog.products(catalog);
    const { toks, mentions } = findMentions(text, products);
    if (!mentions.length) return undefined;
    const pol = mentionPolarities(toks, mentions);
    if (!pol.some((p) => p !== 'none')) return undefined;
    const parsed = parseItems(text, products);
    // An amount with no product next to it is a quantity correction, not a removal.
    if (parsed.loose.quantity !== undefined) return undefined;
    const st = stFor(s);
    const inCart = (id: string) => s.lines.some((l) => l.itemId === id);
    const chickenLines = s.lines.filter((l) => this.isChicken(catalog, l.itemId)).map((l) => l.itemId);
    const remove = new Set<string>();
    const keep = new Set<string>();
    const notIn: string[] = [];
    let keepAsked = false;
    let noChicken = false;
    for (const [i, m] of mentions.entries()) {
      if (m.variant) return undefined; // "nattukozhi muttai" questions are answered elsewhere
      const ids = m.generic ? chickenLines : [m.p.id];
      if (pol[i] === 'remove') {
        if (m.generic && !chickenLines.length) noChicken = true;
        for (const id of ids) (inCart(id) ? remove.add(id) : notIn.push(m.p.name));
      } else if (pol[i] === 'only') {
        // "Egg mattum 4": a product with its amount — the quantity rules apply it (and drop the others).
        if (!m.generic && parsed.items.some((x) => x.itemId === m.p.id && x.quantity !== undefined)) return undefined;
        keepAsked = true;
        for (const id of ids) if (inCart(id)) keep.add(id);
      } else if (!m.generic && remove.has(m.p.id) && parsed.items.some((x) => x.itemId === m.p.id && x.quantity !== undefined)) {
        return undefined; // "6 eggs venam … 4 eggs": a correction
      }
    }
    // "Chicken only" while the cart has no chicken: nothing to keep — not an edit we can do safely here.
    if (keepAsked && keep.size) for (const l of s.lines) if (!keep.has(l.itemId)) remove.add(l.itemId);
    const clash = [...remove].filter((id) => keep.has(id));
    const name = (id: string) => catalog.items.find((i) => i.id === id)?.name ?? '';
    if (clash.length) return { kind: 'say', text: say.whichToRemove(st, clash.map(name)), promptOnly: true };
    if (!remove.size && !notIn.length && !noChicken) return undefined;

    const removedNames = s.lines.filter((l) => remove.has(l.itemId)).map((l) => name(l.itemId));
    s.lines = s.lines.filter((l) => !remove.has(l.itemId));
    if (s.focusItemId && remove.has(s.focusItemId)) s.focusItemId = undefined;
    if (s.interestItemId && (remove.has(s.interestItemId) || (noChicken && this.isChicken(catalog, s.interestItemId)))) s.interestItemId = undefined;
    if (noChicken || removedNames.length) s.pendingQty = undefined;
    // "not wings, leg piece": the product named WITHOUT an edit word is what they want instead — added if it is not in
    // the cart yet (with its amount, if said), never removed.
    const added: string[] = [];
    for (const [i, m] of mentions.entries()) {
      if (pol[i] !== 'none' || m.generic || m.variant || remove.has(m.p.id) || inCart(m.p.id)) continue;
      const item = catalog.items.find((x) => x.id === m.p.id && x.available);
      if (!item) continue;
      const line: OrderSession['lines'][number] = { itemId: item.id };
      const said = parsed.items.find((x) => x.itemId === item.id);
      if (said?.quantity !== undefined) {
        const r = this.acceptQty(item, said.quantity, said.qtyUnit, st, catalog);
        if (!r.note) line.quantity = r.qty;
      }
      s.lines.push(line);
      s.focusItemId = item.id;
      added.push(`${line.quantity !== undefined ? `${formatQty(line.quantity, item.unit)} ` : ''}${item.name}`);
    }
    // Payment said in the same message ("eggs venam, cash") is kept.
    const payment = parsePayment(text);
    if (payment) s.payment = payment;
    this.changed(s);
    const said = [
      removedNames.length ? say.removed(st, removedNames) : '',
      added.length ? say.noted(st, added) : '',
      notIn.length ? say.notInCart(st, [...new Set(notIn)]) : '',
      noChicken && !removedNames.length ? say.noChicken(st) : '',
    ].filter(Boolean);
    // The updated review (re-priced from the database, discount re-checked) — never placed without a new yes.
    return { kind: 'say', text: [said.join(' '), s.lines.length ? await this.advance(s, catalog, now, []) : say.askProduct(st)].join('\n\n') };
  }

  /**
   * Which question the conversation is waiting on (what advance() would ask next), without changing anything.
   * A short answer ("4") is read as an answer to THIS question.
   */
  private nextSlot(s: OrderSession, catalog: Catalog): 'product' | 'qty' | 'cut' | 'payment' | 'outlet' | 'pickup' | 'review' {
    if (s.step === 'awaiting_confirmation' && s.pending) return 'review';
    if (!s.lines.length) return 'product';
    const focused = s.lines.find((l) => l.itemId === s.focusItemId);
    for (const l of focused ? [focused, ...s.lines.filter((x) => x !== focused)] : s.lines) {
      const item = catalog.items.find((i) => i.id === l.itemId);
      if (!item) continue;
      if (l.quantity === undefined) return 'qty';
      if (item.cutOptions.length && !l.cut) return 'cut';
    }
    if (!s.payment) return 'payment';
    const outlets = catalog.outlets.filter((o) => o.active);
    if (outlets.length > 1 && !s.outletId) return 'outlet';
    return s.pickupAt ? 'review' : 'pickup';
  }

  /**
   * The same "please tell me …" reply must not come out turn after turn (the reported loop: seven turns, each
   * answered with the same chicken question). Second time: say we did not understand and show the choices. Third
   * time and after: offer the shop staff instead of asking again. Any real progress resets it.
   */
  private avoidRepeat(s: OrderSession, reply: string, onlyPrompt: boolean, catalog: Catalog): string {
    if (!onlyPrompt) {
      s.lastPromptOnly = undefined;
      s.promptRepeats = 0;
      return reply;
    }
    if (reply !== s.lastPromptOnly) {
      s.lastPromptOnly = reply;
      s.promptRepeats = 0;
      return reply;
    }
    s.promptRepeats = (s.promptRepeats ?? 0) + 1;
    const st = stFor(s);
    if (s.promptRepeats >= 2) return s.channel === 'voice' ? spoken.handoffOffer(voiceStyle(s.lang)) : say.offerStaff(st);
    const choices = s.lines.length ? reply : say.availableList(st, this.stockLines(catalog.items.filter((i) => i.available)));
    return say.notUnderstood(st, choices);
  }

  /**
   * Check a quantity the customer said for a product before it goes into the cart: the unit must match how the
   * product is sold, it must be within its minimum / maximum / step, and never more than the recorded stock.
   * A refused quantity is not stored; the note says why and asks again (offering what is left, or other products).
   */
  private acceptQty(item: MenuItemView, raw: number, unit: 'kg' | 'piece' | 'bare' | undefined, st: Style, catalog: Catalog): { qty?: number; note?: string; suggest?: number } {
    if (unit && unit !== 'bare' && unit !== item.unit) {
      // "மூணு கிலோ" eggs: offer the number as a count (once confirmed it is set) instead of repeating the rule.
      if (item.unit === 'piece' && Number.isInteger(raw) && raw >= item.minQty && raw <= item.maxQty) return { note: say.confirmPieces(st, item.name, raw), suggest: raw };
      return { note: say.wrongUnit(st, item.name, item.unit) };
    }
    const qty = item.unit === 'piece' ? Math.round(raw) : raw;
    const q = (n: number) => formatQty(n, item.unit);
    const rule = (en: string, tl: string, ta: string) => ({ note: say.badQty(st, item.name, st === 'en' ? en : st === 'tl' ? tl : ta) });
    if (!Number.isFinite(qty) || qty <= 0) return { note: say.askQty(st, item.name, item.unit) };
    if (qty < item.minQty) return rule(`the minimum is ${q(item.minQty)}`, `minimum ${q(item.minQty)}`, `குறைந்தது ${q(item.minQty)}`);
    if (qty > item.maxQty) return rule(`up to ${q(item.maxQty)} per order (for more, say "staff")`, `${q(item.maxQty)} varai thaan (adhukku mela-na "staff" nu sollunga)`, `${q(item.maxQty)} வரை தான் (அதுக்கு மேல "staff"-னு சொல்லுங்க)`);
    if (item.qtyStep > 0 && Math.abs(Math.round(qty / item.qtyStep) * item.qtyStep - qty) > 1e-6) return rule(`sold in steps of ${q(item.qtyStep)}`, `${q(item.qtyStep)} step-la thaan`, `${q(item.qtyStep)} அளவுகளில் தான்`);
    if (item.stockQty !== null && qty > item.stockQty) {
      const others = catalog.items.filter((i) => i.available && i.id !== item.id && i.stockQty !== null && i.stockQty > 0).map((i) => i.name);
      return { note: item.stockQty >= item.minQty ? say.onlyHave(st, item.name, stockText(item.stockQty, item.unit), others) : [say.outOfStock(st, [item.name]), say.alternatives(st, others)].filter(Boolean).join(' ') };
    }
    return { qty };
  }

  /** The earliest time the shop can have an order cut and packed (prep time, rounded up to 5 minutes). */
  private earliestPickup(shop: { prepMinutes?: number }, now: Date): Date {
    return new Date(Math.ceil((now.getTime() + (shop.prepMinutes ?? 30) * 60_000) / 300_000) * 300_000);
  }

  /** The cart with each priced line and the total, from the catalogue (database) prices. */
  private cartText(s: OrderSession, catalog: Catalog, st: Style): string {
    const priced = s.lines.filter((l) => l.quantity !== undefined).map((l) => ({ l, item: catalog.items.find((i) => i.id === l.itemId) })).filter((x) => x.item);
    return say.cart(
      st,
      priced.map(({ l, item }) => ({ name: `${item!.name}${l.cut ? ` ${l.cut}` : ''}`, qty: formatQty(l.quantity!, item!.unit), total: round2(item!.price * l.quantity!) })),
      round2(priced.reduce((sum, { l, item }) => sum + item!.price * l.quantity!, 0)),
    );
  }

  /** Products as replies need them (catalogue price, stock when known). */
  private stockLines(items: MenuItemView[]): StockLine[] {
    return items.map((i) => ({ name: i.name, price: i.price, unit: i.unit, stockQty: i.stockQty, stockIsDemo: i.stockIsDemo }));
  }

  /**
   * Stock / availability questions, answered from the catalogue (database) with the stock on hand when tracked.
   * Nothing in the order changes. If the customer already has a draft, the next missing detail follows the answer.
   */
  private async answerStockQuestion(
    s: OrderSession,
    kind: 'stock_qty' | 'list_available' | 'availability',
    mentions: Array<{ itemId: string; generic: boolean }>,
    catalog: Catalog,
    now: Date,
  ): Promise<string> {
    const st = stFor(s);
    const sellable = catalog.items.filter((i) => i.available);
    const specific = mentions.filter((m) => !m.generic).map((m) => catalog.items.find((i) => i.id === m.itemId)!).filter(Boolean);
    const resume = s.lines.length || s.payment || s.pickupAt ? await this.advance(s, catalog, now, []) : '';
    const parts: string[] = [];

    if (kind === 'stock_qty' && !specific.length) {
      const tracked = sellable.filter((i) => i.stockQty !== null);
      const unknown = sellable.filter((i) => i.stockQty === null).map((i) => i.name);
      const out = catalog.items.filter((i) => i.listed && !i.available).map((i) => i.name);
      parts.push(sellable.length ? say.stockSummary(st, this.stockLines(tracked), out, unknown) : `${say.outOfStock(st, out.length ? out : catalog.items.map((i) => i.name))} ${say.noSuitableStock(st)}`);
    } else if (specific.length) {
      // "Do you have chicken liver?", "how much country chicken is left?"
      for (const item of specific) {
        if (item.available) {
          parts.push(say.itemInStock(st, this.stockLines([item])[0]));
          if (specific.length === 1 && !s.lines.some((l) => l.itemId === item.id)) s.interestItemId = item.id;
        } else {
          const others = sellable.filter((i) => !specific.some((x) => x.id === i.id));
          parts.push([say.outOfStock(st, [item.name]), others.length ? say.alternatives(st, others.map((o) => o.name)) : say.noSuitableStock(st)].join(' '));
        }
      }
      if (!resume && s.interestItemId) {
        const item = catalog.items.find((i) => i.id === s.interestItemId)!;
        parts.push(s.channel === 'voice' ? spoken.askQty(voiceStyle(s.lang), item.name, item.unit) : say.askQty(st, item.name, item.unit));
      }
    } else if (kind === 'availability' && !mentions.length) {
      // Something that is not a product of this shop ("mutton irukka?"): unknown, not "unavailable".
      parts.push(say.notInList(st, sellable.map((i) => i.name)));
    } else {
      // "Which chicken is available?", "chicken irukka?", "என்ன இருக்கு?"
      parts.push(sellable.length ? say.availableList(st, this.stockLines(sellable), !resume) : `${say.nothingToday(st)} ${say.noSuitableStock(st)}`);
    }
    if (resume) parts.push(resume);
    return parts.filter(Boolean).join('\n\n');
  }

  private shopNames(outlets: OutletView[]) {
    return outlets.map((o) => o.name).join(', ');
  }

  /** The line a product-less "3 kg" / "curry cut" belongs to. */
  private looseTarget(s: OrderSession, catalog: Catalog, loose: { quantity?: number; cut?: string }) {
    const focus = s.lines.find((l) => l.itemId === s.focusItemId);
    if (focus) return focus;
    // "Do you have liver?" → "yes …" → "1 kg": the quantity is for the product they just asked about.
    if (s.interestItemId && catalog.items.find((i) => i.id === s.interestItemId)?.available) {
      const line: OrderSession['lines'][number] = { itemId: s.interestItemId };
      s.lines.push(line);
      s.focusItemId = line.itemId;
      s.interestItemId = undefined;
      return line;
    }
    const missing = s.lines.filter((l) => (loose.quantity !== undefined && l.quantity === undefined) || (loose.cut && !l.cut && catalog.items.find((i) => i.id === l.itemId)?.cutOptions.length));
    return missing[0] ?? (s.lines.length === 1 ? s.lines[0] : undefined);
  }

  private cutFor(item: MenuItemView, key: string): string | undefined {
    const words = CUT_SYNONYMS.find((c) => c.key === key)?.words ?? [key];
    return findCut(words[0], item.cutOptions) ?? item.cutOptions.find((o) => clean(o).includes(key));
  }

  /** Ask for the next missing detail, or show the summary to confirm. */
  private async advance(s: OrderSession, catalog: Catalog, now: Date, _lead: string[]): Promise<string> {
    const st = stFor(s);
    s.pending = undefined;
    s.step = 'collecting';
    const outlets = catalog.outlets.filter((o) => o.active);

    if (!s.lines.length) return say.askProduct(st);
    // The product in focus (just selected) is asked about first: "how many eggs?" → "curry cut" → "how many kg of
    // Chicken Curry Cut?", not "how many eggs?" again; the next amount then goes to the product just asked about.
    const focused = s.lines.find((l) => l.itemId === s.focusItemId);
    for (const l of focused ? [focused, ...s.lines.filter((x) => x !== focused)] : s.lines) {
      const item = catalog.items.find((i) => i.id === l.itemId)!;
      if (l.quantity === undefined) {
        s.focusItemId = item.id;
        return say.askQty(st, item.name, item.unit);
      }
      if (item.cutOptions.length && !l.cut) {
        s.focusItemId = item.id;
        return say.askCut(st, item.name, item.cutOptions);
      }
    }
    const vs = voiceStyle(s.lang);
    const voice = s.channel === 'voice';
    if (!s.payment) return voice ? spoken.askPayment(vs) : say.askPayment(st);
    if (!outlets.length) return voice ? spoken.handoff(vs) : say.handoff(st);
    let shop: OutletView | undefined = outlets.find((o) => o.id === s.outletId);
    if (!shop && outlets.length === 1) {
      shop = outlets[0];
      s.outletId = shop.id;
    }
    if (!shop) return voice ? spoken.askOutlet(vs, outlets.map((o) => o.name)) : say.askOutlet(st, this.outletList(outlets));
    if (!s.pickupAt) {
      if (s.pickupDraft?.date || s.pickupDraft?.fromPartOfDay) return say.askPickupTime(st);
      return voice ? spoken.askPickup(vs, shop.name, shop.opensAt, shop.closesAt) : say.askPickup(st, shop.name, `${shop.opensAt}–${shop.closesAt}`);
    }

    const quote = await this.quote(s, now);
    if (!quote.ok) {
      // A pickup-time problem: ask for the time again; anything else is listed for the customer to fix.
      if (quote.problems.some((p) => /pickup|minutes to cut|open .*–|days ahead/.test(p))) s.pickupAt = undefined;
      return say.problems(st, quote.problems.map((p) => this.wordProblem(p, st)));
    }
    s.step = 'awaiting_confirmation';
    s.pending = { nonce: randomUUID(), total: quote.total, expiresAt: Date.now() + CONFIRM_TTL_MS, cartHash: this.cartHash(s) };
    return this.renderSummary(s, quote);
  }

  private renderSummary(s: OrderSession, q: Quote) {
    const st = stFor(s);
    if (s.channel === 'voice') {
      const vs = voiceStyle(s.lang);
      return spoken.summary(vs, { lines: q.lines, discount: q.discount, total: q.total, payment: say.paymentLabel(vs, s.payment!), pickupAt: new Date(s.pickupAt!), shop: q.outlet?.name ?? '' });
    }
    return say.summary(st, {
      lines: q.lines,
      subtotal: q.subtotal,
      discount: q.discount,
      total: q.total,
      payment: say.paymentLabel(st, s.payment!),
      pickupAt: new Date(s.pickupAt!),
      shop: q.outlet?.name ?? '',
      offerNote: s.claimId && q.offerNote ? say.offerNotApplied(st, q.offerNote) : undefined,
      unconfirmed: q.lines.filter((l) => q.unknownStock?.includes(l.itemId)).map((l) => l.name),
    });
  }

  private async summaryText(s: OrderSession, catalog: Catalog, now: Date) {
    const q = await this.quote(s, now);
    return q.ok ? this.renderSummary(s, q) : this.advance(s, catalog, now, []);
  }

  private async placeOrder(s: OrderSession, catalog: Catalog, now: Date): Promise<{ kind: 'say'; text: string; order?: RestaurantTurnResult['order'] }> {
    const st = stFor(s);
    const pending = s.pending!;
    if (!s.customerId || !s.outletId || !s.payment || !s.pickupAt || s.lines.some((l) => l.quantity === undefined)) {
      return { kind: 'say', text: await this.advance(s, catalog, now, []) };
    }
    // The yes is for the cart the customer was SHOWN. If anything changed since that review, show the new one.
    if (pending.cartHash && pending.cartHash !== this.cartHash(s)) {
      log.warn('restaurant.confirm_stale_review', { organizationId: s.organizationId, channel: s.channel });
      return { kind: 'say', text: await this.advance(s, catalog, now, []) };
    }
    const result = await this.orders.createOrder({
      organizationId: s.organizationId,
      idempotencyKey: `${s.key}:${pending.nonce}`,
      customerId: s.customerId,
      conversationId: s.conversationId,
      channel: s.channel,
      lines: s.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity!, cut: l.cut })),
      outletId: s.outletId,
      pickupAt: new Date(s.pickupAt),
      paymentMethod: s.payment,
      claimId: s.claimId,
      customerName: s.name,
      customerPhone: s.phone,
      language: s.lang,
      expectedTotal: pending.total,
      now,
    });
    if (result.status === 'rejected') {
      s.pending = undefined;
      s.step = 'collecting';
      this.catalog.invalidate(s.organizationId);
      return { kind: 'say', text: `${say.couldNotPlace(st, result.problems.map((p) => this.wordProblem(p, st)))}\n\n${await this.advance(s, await this.catalog.get(s.organizationId), now, [])}` };
    }
    const order = result.order;
    // The customer ordered on WhatsApp: order messages (confirmation, ready, feedback) are expected. Calls still
    // need calling consent, recorded separately by staff.
    await this.prisma.customer.updateMany({ where: { id: s.customerId, organizationId: s.organizationId, optedOutAt: null }, data: { messagingConsent: true } });
    if (result.status === 'created') await this.followUps.onOrderCreated(s.organizationId, order.id, s.channel).catch((e) => log.warn('followup.schedule_failed', { error: errorMessage(e) }));
    s.lastOrderNumber = order.orderNumber;
    if (s.channel === 'voice') s.orderedOnCall = order.orderNumber;
    if (order.offer) {
      s.claimId = undefined;
      s.offerAmount = undefined;
    }
    this.reset(s);
    // The same draft may still sit on the customer's other channel: clear it so an old summary there can never
    // be confirmed into a second order.
    await this.clearOtherDrafts(s, order.offer ? true : false);
    const placed = { orderNumber: order.orderNumber, total: order.total, pickupAt: new Date(order.pickupAt), shop: order.outlet.name, demo: order.isDemo };
    return {
      kind: 'say',
      text: s.channel === 'voice' ? spoken.placed(voiceStyle(s.lang), { ...placed, now }) : say.placed(st, placed),
      order: { status: result.status, id: order.id, orderNumber: order.orderNumber, total: order.total },
    };
  }

  /** Problems come from OrdersService in English; Tamil/Tanglish customers get the important ones in their language. */
  private wordProblem(p: string, st: Style): string {
    if (st === 'en') return p;
    const m = p.match(/^We need about (\d+) minutes/);
    if (m) return st === 'tl' ? `Cut panni pack panna ${m[1]} nimisham aagum — konjam late-ah varra maadhiri time sollunga.` : `Cut பண்ணி pack பண்ண ${m[1]} நிமிஷம் ஆகும் — கொஞ்சம் late-ஆ வர்ற மாதிரி நேரம் சொல்லுங்க.`;
    const open = p.match(/^(.*) is open (\S+)–(\S+)\./);
    if (open) return st === 'tl' ? `${open[1]} ${open[2]}–${open[3]} varai thaan open. Andha nerathukulla oru time sollunga.` : `${open[1]} ${open[2]}–${open[3]} வரை தான் open. அந்த நேரத்துக்குள்ள ஒரு நேரம் சொல்லுங்க.`;
    const min = p.match(/^Minimum for (.*) is (.*)\.$/);
    if (min) return st === 'tl' ? `${min[1]} minimum ${min[2]}.` : `${min[1]} குறைந்தது ${min[2]}.`;
    return p;
  }

  private outletList(outlets: OutletView[]) {
    return outlets.map((o, i) => `${i + 1}. ${o.name}${o.area ? ` (${o.area})` : ''} — ${o.opensAt}–${o.closesAt}${o.phone ? ` · ${o.phone}` : ''}\n   ${o.address}`).join('\n');
  }

  private async statusText(s: OrderSession, text: string): Promise<string> {
    const st = stFor(s);
    if (!s.customerId) return say.noOrder(st);
    const number = findOrderNumber(text);
    // A customer only ever sees their own orders.
    const order = number ? await this.orders.findByNumber(s.organizationId, number, s.customerId) : await this.orders.latestForCustomer(s.organizationId, s.customerId);
    if (!order) return say.noOrder(st);
    return say.status(st, { orderNumber: order.orderNumber, status: order.status, pickupAt: new Date(order.pickupAt) });
  }

  private async handoff(s: OrderSession): Promise<string> {
    await this.prisma.conversation.update({ where: { id: s.conversationId! }, data: { status: 'human_handoff', updatedAt: new Date() } });
    log.info('restaurant.handoff', { organizationId: s.organizationId, conversationId: s.conversationId, channel: s.channel });
    return s.channel === 'voice' ? spoken.handoff(voiceStyle(s.lang)) : say.handoff(stFor(s));
  }

  // -----------------------------------------------------------------------------------------------
  // Model fallback (phrasing only)
  // -----------------------------------------------------------------------------------------------

  private async answerWithModel(s: OrderSession, text: string, catalog: Catalog, now: Date): Promise<{ text: string; path: 'rules' | 'llm'; usage?: AiUsageMetrics; llm: LlmStatus; llmError?: string }> {
    const fallback = s.channel === 'voice' ? spoken.help(voiceStyle(s.lang), orderHint(catalog)) : say.help(stFor(s), orderHint(catalog));
    if (!llmConfigured()) return { text: fallback, path: 'rules', llm: 'not_configured' };
    const agentChannel = s.channel === 'voice' ? 'voice' : 'whatsapp';
    const prices = new Set(catalog.items.map((i) => i.price));
    if (s.offerAmount) prices.add(s.offerAmount);
    const brief = [
      'VERIFIED PRODUCTS from the shop\'s catalogue (prices per kg unless "per piece"). Availability is decided by the shop, not by you: never say any product is unavailable, out of stock or not sold; if asked about something not listed, say the shop staff will confirm.',
      ...catalog.items.map((i) => `${i.name} ₹${i.price} per ${i.unit === 'piece' ? 'piece' : 'kg'}${i.cutOptions.length ? `, cuts: ${i.cutOptions.join(', ')}` : ''}${i.description ? ` - ${i.description}` : ''} [${!i.available ? 'marked not available today by the shop' : i.stockQty === null ? 'stock not confirmed - the shop confirms with the order' : 'in stock today'}]`),
      'SHOPS (pickup only, no delivery):',
      ...catalog.outlets.filter((o) => o.active).map((o) => `${o.name}, ${o.address}, open ${o.opensAt}-${o.closesAt}`),
      s.offerAmount ? `OFFER: ₹${s.offerAmount} off this order.` : 'OFFER: none for this customer.',
      `CUSTOMER'S ORDER SO FAR: ${s.lines.length ? s.lines.map((l) => `${l.quantity ?? '?'} ${catalog.items.find((i) => i.id === l.itemId)?.name} ${l.cut ?? ''}`).join(', ') : 'nothing yet'}`,
    ].join('\n');
    const context: RestaurantAgentContext = { organizationName: await this.orgName(s.organizationId), channel: agentChannel, nowText: nowInIst(now).text, brief };
    const run = await this.llm.run({
      channel: agentChannel,
      toolset: 'none',
      context: context as unknown as TacksharpAgentContext,
      history: s.history.slice(-6),
      message: text,
      maxTurns: 1,
      agent: getRestaurantAgent(agentChannel),
    });
    if (run.failed || !run.text) return { text: fallback, path: 'rules', usage: run.usage, llm: run.failed ? 'failed' : 'empty', llmError: run.error?.slice(0, 200) };
    // The model may phrase, never decide: invented prices and any "not available / out of stock" claim are removed.
    const safe = filterAvailabilityClaims(filterUnverifiedPrices(run.text, prices));
    if (safe !== run.text.trim()) log.info('restaurant.llm_reply_filtered', { organizationId: s.organizationId, removedChars: run.text.length - safe.length });
    return { text: safe || fallback, path: safe ? 'llm' : 'rules', usage: run.usage, llm: safe ? (safe !== run.text.trim() ? 'filtered' : 'used') : 'filtered_out' };
  }

  /**
   * Carts customers are building right now (dashboard), priced from the current catalogue. Phone numbers are
   * masked; nothing here changes a session.
   */
  async activeCarts(organizationId: string) {
    const [sessions, catalog] = await Promise.all([this.store.listForOrganization(organizationId), this.catalog.get(organizationId)]);
    return sessions
      .filter((s) => s.lines.length > 0)
      .map((s) => {
        const lines = s.lines.map((l) => {
          const item = catalog.items.find((i) => i.id === l.itemId);
          return { name: item?.name ?? 'Removed product', unit: item?.unit ?? 'kg', quantity: l.quantity ?? null, cut: l.cut ?? null, lineTotal: item && l.quantity !== undefined ? round2(item.price * l.quantity) : null, stockKnown: item ? item.stockQty !== null : false };
        });
        return {
          key: s.key.replace(/:[^:]+$/, ':' + mask(s.phone)),
          channel: s.channel,
          customerName: s.name ?? null,
          phone: mask(s.phone),
          conversationId: s.conversationId ?? null,
          step: s.step,
          awaitingConfirmation: s.step === 'awaiting_confirmation' && !!s.pending,
          lines,
          total: round2(lines.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0)),
          payment: s.payment ?? null,
          pickupAt: s.pickupAt ?? null,
          language: s.lang,
          updatedAt: s.updatedAt,
        };
      });
  }

  // -----------------------------------------------------------------------------------------------
  // Phone calls
  // -----------------------------------------------------------------------------------------------

  /**
   * A call was answered: create (or resume) the customer's phone session and save the opening line the call layer
   * is about to speak. Per-call state is reset; a half-finished draft (this line, or the customer's WhatsApp chat)
   * is kept so they can finish it on the phone, but any summary must be confirmed again on this call.
   */
  async openVoiceSession(input: { organizationId: string; phone: string; customerName?: string; openingText: string; callId: string }) {
    const turnInput: RestaurantTurnInput = { organizationId: input.organizationId, channel: 'voice', phone: input.phone, message: '', customerName: input.customerName };
    const key = this.sessionKey(turnInput);
    return this.mutex.run(key, async () => {
      const existing = await this.store.get(key);
      const s = existing ?? this.newSession(turnInput, key);
      await this.ensureThread(s, turnInput);
      if (!existing) await this.carryOver(s);
      // A new call: the cart left by an EARLIER call is held and offered, never continued silently.
      else if (s.lines.length) this.holdDraft(s, 'earlier');
      s.greeted = true;
      s.orderedOnCall = undefined;
      s.pending = undefined;
      s.step = 'collecting';
      s.history = [...s.history, { role: 'assistant' as const, content: input.openingText }].slice(-8);
      await this.store.save(s);
      await this.conversations.addMessage({
        organizationId: s.organizationId,
        conversationId: s.conversationId!,
        role: 'assistant',
        content: input.openingText,
        metadata: { callId: input.callId, opening: true } as never,
      });
      return { key, conversationId: s.conversationId!, customerId: s.customerId!, lang: s.lang, carriedFrom: s.carriedFrom };
    });
  }

  /** Words the speech-to-text should expect on this business's calls: its own products, cuts and shops. */
  async voiceKeyterms(organizationId: string): Promise<string[]> {
    const catalog = await this.catalog.get(organizationId);
    const terms = new Set<string>(['kg', 'kilo', 'curry cut', 'biryani cut', 'fry cut', 'GPay', 'UPI', 'cash']);
    for (const i of catalog.items) {
      terms.add(i.name);
      for (const c of i.cutOptions) terms.add(c);
    }
    for (const o of catalog.outlets) {
      terms.add(o.name);
      if (o.area) terms.add(o.area);
    }
    return [...terms].filter((t) => t && t.length <= 64).slice(0, 50);
  }

  // -----------------------------------------------------------------------------------------------
  // One customer across WhatsApp and phone
  // -----------------------------------------------------------------------------------------------

  /**
   * A new WhatsApp or phone session starts with the details the same customer already gave on their other channel
   * (same organization, same phone number): products, kg, cut, payment, pickup time, shop and their offer. Never a
   * pending confirmation: a summary is always confirmed again on the channel the order is placed from.
   */
  private async carryOver(s: OrderSession) {
    if (!(CUSTOMER_CHANNELS as readonly string[]).includes(s.channel)) return;
    for (const other of CUSTOMER_CHANNELS) {
      if (other === s.channel) continue;
      const o = await this.store.get(OrderSessionStore.keyFor(s.organizationId, other, s.phone));
      if (!o || o.organizationId !== s.organizationId) continue;
      if (Date.now() - new Date(o.updatedAt).getTime() > 24 * 3600_000) continue;
      if (!o.lines.length && !o.payment && !o.pickupAt && !o.claimId) continue;
      // The draft is HELD, not put in the cart: it is offered on the first turn and only restored when the customer
      // continues it. (A call asking for chicken used to answer with the WhatsApp eggs order and its review.)
      if (o.lines.length) {
        const pickupAt = o.pickupAt && new Date(o.pickupAt).getTime() > Date.now() ? o.pickupAt : undefined;
        s.held = { lines: o.lines.map((l) => ({ ...l })), focusItemId: o.focusItemId, payment: o.payment, pickupAt, pickupDraft: pickupAt ? undefined : o.pickupDraft, outletId: o.outletId, from: other };
      }
      s.claimId ??= o.claimId;
      s.offerAmount ??= o.offerAmount;
      s.lastOrderNumber ??= o.lastOrderNumber;
      s.carriedFrom = other;
      log.info('restaurant.draft_carried_over', { organizationId: s.organizationId, from: other, to: s.channel, lines: s.lines.length });
      return;
    }
  }

  /** Fingerprint of everything a review shows: lines, payment, pickup time, shop, offer claim. */
  private cartHash(s: OrderSession): string {
    const lines = [...s.lines].map((l) => `${l.itemId}|${l.quantity ?? ''}|${l.cut ?? ''}`).sort();
    return createHash('sha1').update(JSON.stringify([lines, s.payment ?? '', s.pickupAt ?? '', s.outletId ?? '', s.claimId ?? ''])).digest('hex').slice(0, 16);
  }

  /** Move the current cart / payment / pickup into the held draft (offered later, never reused silently). */
  private holdDraft(s: OrderSession, from: NonNullable<OrderSession['held']>['from']) {
    s.held = { lines: s.lines.map((l) => ({ ...l })), focusItemId: s.focusItemId, payment: s.payment, pickupAt: s.pickupAt && new Date(s.pickupAt).getTime() > Date.now() ? s.pickupAt : undefined, pickupDraft: s.pickupDraft, outletId: s.outletId, from };
    s.lines = [];
    s.focusItemId = undefined;
    s.payment = undefined;
    s.pickupAt = undefined;
    s.pickupDraft = undefined;
    s.pendingQty = undefined;
    s.interestItemId = undefined;
    s.pending = undefined;
    s.step = 'collecting';
    log.info('restaurant.draft_held', { organizationId: s.organizationId, channel: s.channel, from, lines: s.held.lines.length });
  }

  /** The customer continues the held draft: it becomes the cart again (still needs a fresh review and yes). */
  private restoreHeld(s: OrderSession, catalog: Catalog) {
    const h = s.held!;
    s.held = undefined;
    s.lines = h.lines.filter((l) => catalog.items.some((i) => i.id === l.itemId)).map((l) => ({ ...l }));
    s.focusItemId = h.focusItemId;
    s.payment ??= h.payment;
    s.pickupAt ??= h.pickupAt && new Date(h.pickupAt).getTime() > Date.now() ? h.pickupAt : undefined;
    s.pickupDraft ??= s.pickupAt ? undefined : h.pickupDraft;
    s.outletId ??= h.outletId;
    s.carriedFrom = h.from === 'earlier' ? s.carriedFrom : h.from;
    log.info('restaurant.held_draft_restored', { organizationId: s.organizationId, channel: s.channel, from: h.from, lines: s.lines.length });
  }

  /** After an order is placed, the customer's other channel must not hold the same draft or a confirmable summary. */
  private async clearOtherDrafts(s: OrderSession, offerUsed: boolean) {
    if (!(CUSTOMER_CHANNELS as readonly string[]).includes(s.channel)) return;
    for (const other of CUSTOMER_CHANNELS) {
      if (other === s.channel) continue;
      const key = OrderSessionStore.keyFor(s.organizationId, other, s.phone);
      // Never inside the other session's lock from here (a turn there may be waiting on this one): a plain update.
      const o = await this.store.get(key);
      if (!o) continue;
      this.reset(o);
      o.lastOrderNumber = s.lastOrderNumber;
      if (offerUsed) {
        o.claimId = undefined;
        o.offerAmount = undefined;
      }
      await this.store.save(o);
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Session / customer plumbing
  // -----------------------------------------------------------------------------------------------

  private newSession(input: RestaurantTurnInput, key: string): OrderSession {
    return {
      v: 2,
      key,
      organizationId: input.organizationId,
      channel: input.channel,
      phone: normalizePhone(input.phone) ?? input.phone,
      name: input.customerName?.trim() || undefined,
      // A phone caller hears Tamil first (the TTS voice reads Tamil script); WhatsApp starts in Tanglish.
      lang: input.channel === 'voice' ? 'tamil' : 'tanglish',
      lines: [],
      // The call layer speaks the opening line itself: no written greeting or menu on a call.
      greeted: input.channel === 'voice',
      step: 'collecting',
      history: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private async ensureThread(s: OrderSession, input: RestaurantTurnInput) {
    if (!s.customerId) {
      const c = await this.conversations.getOrCreateCustomerByPhone(s.organizationId, s.phone, { name: s.name, source: s.channel === 'test' ? 'test' : s.channel === 'voice' ? 'voice' : 'whatsapp' });
      s.customerId = c.id;
      s.name ??= c.name ?? undefined;
      if (c.language === 'tamil' || c.language === 'english' || c.language === 'tanglish') s.lang = c.language;
    }
    if (!s.conversationId) {
      const conv = await this.conversations.getOrCreateConversation({ organizationId: s.organizationId, channel: input.channel, externalId: s.phone, customerId: s.customerId });
      s.conversationId = conv.id;
    }
  }

  private quote(s: OrderSession, now: Date) {
    return this.orders.quote({
      organizationId: s.organizationId,
      lines: s.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity ?? NaN, cut: l.cut })),
      outletId: s.outletId,
      pickupAt: s.pickupAt ? new Date(s.pickupAt) : undefined,
      claimId: s.claimId,
      customerId: s.customerId,
      now,
    });
  }

  private changed(s: OrderSession) {
    s.pending = undefined;
    s.step = 'collecting';
  }

  private reset(s: OrderSession) {
    s.pendingQty = undefined;
    s.lines = [];
    s.focusItemId = undefined;
    s.payment = undefined;
    s.pickupAt = undefined;
    s.pickupDraft = undefined;
    s.pending = undefined;
    s.step = 'collecting';
    s.held = undefined;
  }

  private draftView(s: OrderSession, catalog: Catalog): RestaurantTurnResult['draft'] {
    return {
      lines: s.lines.map((l) => {
        const item = catalog.items.find((i) => i.id === l.itemId);
        return { name: item?.name ?? '?', quantity: l.quantity, unit: item?.unit ?? 'kg', cut: l.cut };
      }),
      payment: s.payment,
      pickupAt: s.pickupAt,
      outlet: catalog.outlets.find((o) => o.id === s.outletId)?.name,
      offer: s.offerAmount,
    };
  }

  private readonly orgNames = new Map<string, string>();
  private async orgName(organizationId: string) {
    const hit = this.orgNames.get(organizationId);
    if (hit) return hit;
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    const name = org?.name ?? 'GR Chicken';
    this.orgNames.set(organizationId, name);
    return name;
  }
}

/** Drop any sentence of a model reply that names a rupee amount which is not a catalogue price or the offer. */
export function filterUnverifiedPrices(text: string, prices: Set<number>): string {
  const sentences = text.split(/(?<=[.!?\n])\s*/);
  const kept = sentences.filter((sentence) => {
    const amounts = [...sentence.matchAll(/(?:₹|rs\.?|inr|rupees?|ரூபாய்)\s*([\d,]+(?:\.\d+)?)/gi)].map((m) => Number(m[1].replace(/,/g, '')));
    return amounts.every((a) => prices.has(a));
  });
  return kept.join(' ').replace(/\s+\n/g, '\n').trim();
}
