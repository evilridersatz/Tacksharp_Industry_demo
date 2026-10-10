import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getRestaurantAgent, llmConfigured, type RestaurantAgentContext } from 'ai/agents/restaurant-agent.js';
import type { TacksharpAgentContext } from 'ai/agents/real-estate-agent.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { LlmRunner, type AiUsageMetrics } from '../ai/llm-runner.service.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { normalizePhone } from '../common/phone.js';
import { nowInIst } from '../common/time.js';
import { errorMessage, log } from '../common/logger.js';
import { describeWhen } from '../conversation/when.js';
import { detectLanguage } from '../conversation/language.js';
import { firstName } from '../whatsapp/message-templates.js';
import { CatalogService, type Catalog, type MenuItemView, type OutletView } from './catalog.service.js';
import { OrdersService, type Quote } from './orders.service.js';
import { OffersService } from './offers.service.js';
import { OrderSessionStore, type OrderSession } from './order-session.store.js';
import { classify, clean, findCut, findOrderNumber, formatQty, mentionsCut, parseItems, parsePayment, parsePickup, pickOutlet, CUT_SYNONYMS, type Intent } from './chicken-parse.js';
import { menuBlock, say, type Style } from './replies.js';

export type RestaurantTurnInput = {
  organizationId: string;
  /** whatsapp = real customer; test = the dashboard's test chat (same flow, nothing is sent on WhatsApp). */
  channel: 'whatsapp' | 'test';
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
  state: OrderSession['step'];
  intent: Intent;
  aiUsage?: AiUsageMetrics;
  failed?: boolean;
  /** Set on the turn that created the order (or found the already-created one). */
  order?: { status: 'created' | 'duplicate'; id: string; orderNumber: string; total: number };
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
const style = (lang: OrderSession['lang']): Style => (lang === 'english' ? 'en' : lang === 'tamil' ? 'ta' : 'tl');

/**
 * GR Chicken offer-claim / pickup-order conversation on WhatsApp.
 *
 * Everything that matters is decided in code: which products, how much, which cut, the price, the
 * offer discount, the total, whether the customer explicitly confirmed, and creating the order once.
 * The language model is only asked to phrase an answer to a free-form question the rules do not
 * cover, and its reply is filtered for prices that are not in the catalogue.
 */
@Injectable()
export class OrderingEngine {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly catalog: CatalogService,
    private readonly orders: OrdersService,
    private readonly offers: OffersService,
    private readonly store: OrderSessionStore,
    private readonly llm: LlmRunner,
  ) {}

  generate(input: RestaurantTurnInput): Promise<RestaurantTurnResult> {
    const key = this.sessionKey(input);
    return this.mutex.run(key, () => this.turn(input, key));
  }

  sessionKey(input: Pick<RestaurantTurnInput, 'organizationId' | 'channel' | 'phone'>) {
    return `${input.organizationId}:${input.channel}:${normalizePhone(input.phone) ?? input.phone}`;
  }

  private async turn(input: RestaurantTurnInput, key: string): Promise<RestaurantTurnResult> {
    const started = Date.now();
    const now = input.now ?? new Date();
    const text = input.message.trim().slice(0, 1000);
    const s = (await this.store.get(key)) ?? this.newSession(input, key);
    await this.ensureThread(s, input);
    await this.conversations.addMessage({
      organizationId: s.organizationId,
      conversationId: s.conversationId!,
      role: 'user',
      content: text || '(empty message)',
      metadata: (input.metadata ?? undefined) as never,
    });

    const detected = detectLanguage(text);
    // One or two words ("Hi", "ok", "cash") say little about the language: keep the current one (default Tanglish).
    if ((detected.words >= 3 || detected.lang === 'tamil') && (detected.lang === 'tamil' || detected.lang === 'tanglish' || detected.lang === 'english')) s.lang = detected.lang;

    const catalog = await this.catalog.get(s.organizationId);
    const campaign = await this.offers.activeCampaign(s.organizationId);
    const intent = classify(text, campaign?.code);
    let reply: string;
    let path: 'rules' | 'llm' = 'rules';
    let aiUsage: AiUsageMetrics | undefined;
    let failed = false;
    let orderResult: RestaurantTurnResult['order'];

    try {
      const handled = await this.handle(s, text, intent, catalog, now);
      if (handled.kind === 'llm') {
        const run = await this.answerWithModel(s, text, catalog, now);
        reply = run.text + (handled.then ? `\n\n${handled.then}` : '');
        path = run.path;
        aiUsage = run.usage;
      } else {
        reply = handled.text;
        orderResult = handled.order;
      }
    } catch (error) {
      failed = true;
      log.error('restaurant.turn_failed', { organizationId: s.organizationId, error: errorMessage(error) });
      reply = say.error(style(s.lang));
    }

    s.history = [...s.history, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: reply }].slice(-8);
    await this.store.save(s);
    await this.conversations.addMessage({
      organizationId: s.organizationId,
      conversationId: s.conversationId!,
      role: 'assistant',
      content: reply,
      metadata: { path, intent, step: s.step, ...(orderResult ? { orderId: orderResult.id, orderNumber: orderResult.orderNumber } : {}) } as never,
    });

    return {
      conversationId: s.conversationId!,
      customerId: s.customerId ?? '',
      leadId: '',
      response: reply,
      actions: {},
      timings: { totalMs: Date.now() - started },
      path,
      state: s.step,
      intent,
      aiUsage,
      failed,
      order: orderResult,
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
  ): Promise<{ kind: 'say'; text: string; order?: RestaurantTurnResult['order'] } | { kind: 'llm'; then?: string }> {
    const st = style(s.lang);
    const out = (t: string, order?: RestaurantTurnResult['order']) => ({ kind: 'say' as const, text: t, order });

    // Offer: the first message of a thread (or "offer" / the link code) opens or creates the customer's offer.
    let offerIntro = '';
    if (!s.greeted || intent === 'offer') {
      const first = !s.greeted;
      s.greeted = true;
      if (s.customerId && !s.claimId) {
        const r = await this.offers.startFromChat(s.organizationId, s.customerId, s.phone);
        if (r.claim) {
          s.claimId = r.claim.id;
          s.offerAmount = Number(r.claim.amount);
          offerIntro = say.offerGreeting(st, { name: firstName(s.name) || undefined, business: await this.orgName(s.organizationId), amount: s.offerAmount, menu: menuBlock(catalog, st) });
        } else if (r.alreadyUsed && intent === 'offer') {
          offerIntro = `${say.offerAlreadyUsed(st)}\n\n${say.plainGreeting(st, { name: firstName(s.name) || undefined, business: await this.orgName(s.organizationId), menu: menuBlock(catalog, st) })}`;
        }
      }
      if (!offerIntro && first) {
        offerIntro = say.plainGreeting(st, { name: firstName(s.name) || undefined, business: await this.orgName(s.organizationId), menu: menuBlock(catalog, st) });
      }
    }

    // What the message says about the order.
    const products = this.catalog.products(catalog);
    const parsed = parseItems(text, products);
    const payment = parsePayment(text);
    const outlets = catalog.outlets.filter((o) => o.active);
    const shop = outlets.find((o) => o.id === s.outletId) ?? outlets[0];
    const pickup = shop ? parsePickup(text, now, shop, s.pickupDraft) : ({ kind: 'none' } as const);
    const outletPick = outlets.length > 1 && !s.outletId ? pickOutlet(text, outlets) : undefined;
    // "2" while we are asking which shop picks shop 2; it is not "2 kg".
    if (outletPick && /^\d{1,2}$/.test(clean(text))) parsed.loose.quantity = undefined;
    const removing = intent === 'remove' && mentionsCut(text) !== 'whole';
    const hasSlots = parsed.items.length > 0 || parsed.loose.quantity !== undefined || parsed.loose.cut !== undefined || !!payment || pickup.kind !== 'none' || !!outletPick;

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
        return out(`${await this.summaryText(s, catalog, now)}\n\n${say.confirmReminder(st)}`);
      }
    }

    if (intent === 'clear') {
      this.reset(s);
      return out(say.cleared(st));
    }
    if (removing && parsed.items.length) {
      const names = parsed.items.map((m) => catalog.items.find((i) => i.id === m.itemId)!.name);
      s.lines = s.lines.filter((l) => !parsed.items.some((m) => m.itemId === l.itemId));
      this.changed(s);
      return out(`${say.removed(st, names)}\n\n${await this.advance(s, catalog, now, [])}`);
    }

    // 2. Apply everything the message said, in any order.
    if (hasSlots) {
      const noted: string[] = [];
      const notes: string[] = [];
      const unavailable: string[] = [];
      for (const m of parsed.items) {
        const item = catalog.items.find((i) => i.id === m.itemId)!;
        if (!item.available) {
          unavailable.push(item.name);
          continue;
        }
        let line = s.lines.find((l) => l.itemId === item.id);
        if (!line) {
          line = { itemId: item.id };
          s.lines.push(line);
        }
        if (m.quantity !== undefined) line.quantity = item.unit === 'piece' ? Math.round(m.quantity) : m.quantity;
        if (m.cut) line.cut = m.cut;
        else if (mentionsCut(text) && item.cutOptions.length && !line.cut) notes.push(say.cutNotOffered(st, item.name, item.cutOptions));
        s.focusItemId = item.id;
        noted.push(`${line.quantity !== undefined ? `${formatQty(line.quantity, item.unit)} ` : ''}${item.name}${line.cut ? ` ${line.cut}` : ''}`);
      }
      if (unavailable.length) notes.push(say.unavailable(st, unavailable));
      if (parsed.loose.quantity !== undefined || parsed.loose.cut) {
        const target = this.looseTarget(s, catalog, parsed.loose);
        if (target) {
          const item = catalog.items.find((i) => i.id === target.itemId)!;
          if (parsed.loose.quantity !== undefined) target.quantity = item.unit === 'piece' ? Math.round(parsed.loose.quantity) : parsed.loose.quantity;
          if (parsed.loose.cut) {
            const cut = this.cutFor(item, parsed.loose.cut);
            if (cut) target.cut = cut;
            else if (item.cutOptions.length) notes.push(say.cutNotOffered(st, item.name, item.cutOptions));
          }
          noted.push(`${target.quantity !== undefined ? `${formatQty(target.quantity, item.unit)} ` : ''}${item.name}${target.cut ? ` ${target.cut}` : ''}`);
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
        const earliest = new Date(Math.ceil((now.getTime() + prep * 60_000) / 300_000) * 300_000);
        const at = pickup.at.getTime() < earliest.getTime() ? earliest : pickup.at;
        if (at !== pickup.at) notes.push(say.readyBy(st, prep));
        s.pickupAt = at.toISOString();
        s.pickupDraft = undefined;
        noted.push(describeWhen(at, st));
      } else if (pickup.kind === 'partial') {
        s.pickupDraft = pickup.draft;
      }
      this.changed(s);
      const lead = [offerIntro, noted.length && !offerIntro ? say.noted(st, noted) : '', ...notes].filter(Boolean).join('\n\n');
      return out([lead, await this.advance(s, catalog, now, [])].filter(Boolean).join('\n\n'));
    }

    if (offerIntro) return out(offerIntro);

    // 3. Questions and requests that do not change the order.
    const resume = s.lines.length || s.payment || s.pickupAt ? await this.advance(s, catalog, now, []) : '';
    switch (intent) {
      case 'menu':
        return out([menuBlock(catalog, st), resume].filter(Boolean).join('\n\n'));
      case 'outlets':
        return out([say.outlets(st, this.outletList(outlets)), resume].filter(Boolean).join('\n\n'));
      case 'order_status':
        return out(await this.statusText(s, text));
      case 'human':
        return out(await this.handoff(s));
      case 'thanks':
        return out(say.thanks(st));
      case 'greeting':
      case 'offer':
        return out(resume || say.plainGreeting(st, { name: firstName(s.name) || undefined, business: await this.orgName(s.organizationId), menu: menuBlock(catalog, st) }));
      case 'confirm':
        if (s.lastOrderNumber && !s.lines.length) return out(say.alreadyPlaced(st, s.lastOrderNumber));
        return out(resume || say.help(st));
      case 'decline':
        return out(s.lines.length ? say.notPlaced(st) : say.thanks(st));
      case 'remove':
        return out(resume || say.help(st));
      default:
        return { kind: 'llm', then: resume || undefined };
    }
  }

  /** The line a product-less "3 kg" / "curry cut" belongs to. */
  private looseTarget(s: OrderSession, catalog: Catalog, loose: { quantity?: number; cut?: string }) {
    const focus = s.lines.find((l) => l.itemId === s.focusItemId);
    if (focus) return focus;
    const missing = s.lines.filter((l) => (loose.quantity !== undefined && l.quantity === undefined) || (loose.cut && !l.cut && catalog.items.find((i) => i.id === l.itemId)?.cutOptions.length));
    return missing[0] ?? (s.lines.length === 1 ? s.lines[0] : undefined);
  }

  private cutFor(item: MenuItemView, key: string): string | undefined {
    const words = CUT_SYNONYMS.find((c) => c.key === key)?.words ?? [key];
    return findCut(words[0], item.cutOptions) ?? item.cutOptions.find((o) => clean(o).includes(key));
  }

  /** Ask for the next missing detail, or show the summary to confirm. */
  private async advance(s: OrderSession, catalog: Catalog, now: Date, _lead: string[]): Promise<string> {
    const st = style(s.lang);
    s.pending = undefined;
    s.step = 'collecting';
    const outlets = catalog.outlets.filter((o) => o.active);

    if (!s.lines.length) return say.askProduct(st);
    for (const l of s.lines) {
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
    if (!s.payment) return say.askPayment(st);
    if (!outlets.length) return say.handoff(st);
    let shop: OutletView | undefined = outlets.find((o) => o.id === s.outletId);
    if (!shop && outlets.length === 1) {
      shop = outlets[0];
      s.outletId = shop.id;
    }
    if (!shop) return say.askOutlet(st, this.outletList(outlets));
    if (!s.pickupAt) return s.pickupDraft?.date ? say.askPickupTime(st) : say.askPickup(st, shop.name, `${shop.opensAt}–${shop.closesAt}`);

    const quote = await this.quote(s, now);
    if (!quote.ok) {
      // A pickup-time problem: ask for the time again; anything else is listed for the customer to fix.
      if (quote.problems.some((p) => /pickup|minutes to cut|open .*–|days ahead/.test(p))) s.pickupAt = undefined;
      return say.problems(st, quote.problems.map((p) => this.wordProblem(p, st)));
    }
    s.step = 'awaiting_confirmation';
    s.pending = { nonce: randomUUID(), total: quote.total, expiresAt: Date.now() + CONFIRM_TTL_MS };
    return this.renderSummary(s, quote);
  }

  private renderSummary(s: OrderSession, q: Quote) {
    const st = style(s.lang);
    return say.summary(st, {
      lines: q.lines,
      subtotal: q.subtotal,
      discount: q.discount,
      total: q.total,
      payment: say.paymentLabel(st, s.payment!),
      pickupAt: new Date(s.pickupAt!),
      shop: q.outlet?.name ?? '',
      offerNote: s.claimId && q.offerNote ? say.offerNotApplied(st, q.offerNote) : undefined,
    });
  }

  private async summaryText(s: OrderSession, catalog: Catalog, now: Date) {
    const q = await this.quote(s, now);
    return q.ok ? this.renderSummary(s, q) : this.advance(s, catalog, now, []);
  }

  private async placeOrder(s: OrderSession, catalog: Catalog, now: Date): Promise<{ kind: 'say'; text: string; order?: RestaurantTurnResult['order'] }> {
    const st = style(s.lang);
    const pending = s.pending!;
    if (!s.customerId || !s.outletId || !s.payment || !s.pickupAt || s.lines.some((l) => l.quantity === undefined)) {
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
    s.lastOrderNumber = order.orderNumber;
    if (order.offer) {
      s.claimId = undefined;
      s.offerAmount = undefined;
    }
    this.reset(s);
    return {
      kind: 'say',
      text: say.placed(st, { orderNumber: order.orderNumber, total: order.total, pickupAt: new Date(order.pickupAt), shop: order.outlet.name, demo: order.isDemo }),
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
    const st = style(s.lang);
    if (!s.customerId) return say.noOrder(st);
    const number = findOrderNumber(text);
    // A customer only ever sees their own orders.
    const order = number ? await this.orders.findByNumber(s.organizationId, number, s.customerId) : await this.orders.latestForCustomer(s.organizationId, s.customerId);
    if (!order) return say.noOrder(st);
    return say.status(st, { orderNumber: order.orderNumber, status: order.status, pickupAt: new Date(order.pickupAt) });
  }

  private async handoff(s: OrderSession): Promise<string> {
    await this.prisma.conversation.update({ where: { id: s.conversationId! }, data: { status: 'human_handoff', updatedAt: new Date() } });
    log.info('restaurant.handoff', { organizationId: s.organizationId, conversationId: s.conversationId });
    return say.handoff(style(s.lang));
  }

  // -----------------------------------------------------------------------------------------------
  // Model fallback (phrasing only)
  // -----------------------------------------------------------------------------------------------

  private async answerWithModel(s: OrderSession, text: string, catalog: Catalog, now: Date): Promise<{ text: string; path: 'rules' | 'llm'; usage?: AiUsageMetrics }> {
    const fallback = say.help(style(s.lang));
    if (!llmConfigured()) return { text: fallback, path: 'rules' };
    const prices = new Set(catalog.items.map((i) => i.price));
    if (s.offerAmount) prices.add(s.offerAmount);
    const brief = [
      'VERIFIED PRODUCTS (only these exist; prices per kg unless "per piece"):',
      ...catalog.items.filter((i) => i.available).map((i) => `${i.name} ₹${i.price} per ${i.unit === 'piece' ? 'piece' : 'kg'}${i.cutOptions.length ? `, cuts: ${i.cutOptions.join(', ')}` : ''}${i.description ? ` - ${i.description}` : ''}`),
      'SHOPS (pickup only, no delivery):',
      ...catalog.outlets.filter((o) => o.active).map((o) => `${o.name}, ${o.address}, open ${o.opensAt}-${o.closesAt}`),
      s.offerAmount ? `OFFER: ₹${s.offerAmount} off this order.` : 'OFFER: none for this customer.',
      `CUSTOMER'S ORDER SO FAR: ${s.lines.length ? s.lines.map((l) => `${l.quantity ?? '?'} ${catalog.items.find((i) => i.id === l.itemId)?.name} ${l.cut ?? ''}`).join(', ') : 'nothing yet'}`,
    ].join('\n');
    const context: RestaurantAgentContext = { organizationName: await this.orgName(s.organizationId), channel: 'whatsapp', nowText: nowInIst(now).text, brief };
    const run = await this.llm.run({
      channel: 'whatsapp',
      toolset: 'none',
      context: context as unknown as TacksharpAgentContext,
      history: s.history.slice(-6),
      message: text,
      maxTurns: 1,
      agent: getRestaurantAgent('whatsapp'),
    });
    if (run.failed || !run.text) return { text: fallback, path: 'rules', usage: run.usage };
    const safe = filterUnverifiedPrices(run.text, prices);
    return { text: safe || fallback, path: safe ? 'llm' : 'rules', usage: run.usage };
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
      lang: 'tanglish',
      lines: [],
      greeted: false,
      step: 'collecting',
      history: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private async ensureThread(s: OrderSession, input: RestaurantTurnInput) {
    if (!s.customerId) {
      const c = await this.conversations.getOrCreateCustomerByPhone(s.organizationId, s.phone, { name: s.name, source: s.channel === 'test' ? 'test' : 'whatsapp' });
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
    s.lines = [];
    s.focusItemId = undefined;
    s.payment = undefined;
    s.pickupAt = undefined;
    s.pickupDraft = undefined;
    s.pending = undefined;
    s.step = 'collecting';
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
