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
import { CatalogService, type Catalog, type OutletView } from './catalog.service.js';
import { MAX_QTY_PER_ITEM, OrdersService, isOpen, type OrderView, type Quote } from './orders.service.js';
import { OrderSessionStore, type OrderSession } from './order-session.store.js';
import {
  classifyIntent,
  findCategory,
  findOrderNumber,
  findPhone,
  isQuestion,
  normalize,
  parseFulfilment,
  parseItemRequests,
  pickOutlet,
  type RestaurantIntent,
} from './order-parse.js';

export type RestaurantTurnInput = {
  organizationId: string;
  channel: 'whatsapp' | 'web';
  /** WhatsApp sender (digits). */
  phone?: string;
  /** Website chat: browser-generated session id. */
  sessionId?: string;
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
  intent: RestaurantIntent;
  aiUsage?: AiUsageMetrics;
  failed?: boolean;
  /** Set on the turn that created the order (or found the already-created one). */
  order?: { status: 'created' | 'duplicate'; id: string; orderNumber: string; total: number };
  cart: Array<{ name: string; quantity: number; unitPrice: number; lineTotal: number }>;
};

const CONFIRM_TTL_MS = 30 * 60_000;
const rupees = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;
const PAYMENT_TEXT = { delivery: 'Cash on delivery', pickup: 'Pay at the outlet' } as const;

/**
 * GR Chicken / restaurant ordering conversation.
 *
 * Every business decision is made here in code: what is in the cart, the price of each item, the
 * total, whether the order is valid, whether the customer explicitly confirmed, and creating the
 * order exactly once. The language model is only asked to phrase an answer to a free-form question
 * the rules do not cover, and its reply is filtered for prices that are not on the menu.
 */
@Injectable()
export class OrderingEngine {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly catalog: CatalogService,
    private readonly orders: OrdersService,
    private readonly store: OrderSessionStore,
    private readonly llm: LlmRunner,
  ) {}

  generate(input: RestaurantTurnInput): Promise<RestaurantTurnResult> {
    const key = this.sessionKey(input);
    return this.mutex.run(key, () => this.turn(input, key));
  }

  sessionKey(input: Pick<RestaurantTurnInput, 'organizationId' | 'channel' | 'phone' | 'sessionId'>) {
    const id = input.channel === 'web' ? `web:${input.sessionId}` : normalizePhone(input.phone) ?? input.phone;
    return `${input.organizationId}:${input.channel}:${id}`;
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

    const catalog = await this.catalog.get(s.organizationId);
    const intent = classifyIntent(text);
    let reply: string;
    let path: 'rules' | 'llm' = 'rules';
    let aiUsage: AiUsageMetrics | undefined;
    let failed = false;
    let orderResult: RestaurantTurnResult['order'];

    try {
      const handled = await this.handle(s, text, intent, catalog, now);
      if (handled.kind === 'llm') {
        const run = await this.answerWithModel(s, text, catalog, now);
        reply = run.text;
        path = run.path;
        aiUsage = run.usage;
      } else {
        reply = handled.text;
        orderResult = handled.order;
      }
    } catch (error) {
      failed = true;
      log.error('restaurant.turn_failed', { organizationId: s.organizationId, error: errorMessage(error) });
      reply = 'Sorry, something went wrong on our side. Your cart is safe — please try again, or type "talk to staff".';
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

    const cartQuote = s.cart.length ? await this.orders.quote({ organizationId: s.organizationId, lines: s.cart }) : undefined;
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
      cart: cartQuote?.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })) ?? [],
    };
  }

  // -----------------------------------------------------------------------------------------------
  // Decision logic
  // -----------------------------------------------------------------------------------------------

  private async handle(
    s: OrderSession,
    text: string,
    intent: RestaurantIntent,
    catalog: Catalog,
    now: Date,
  ): Promise<{ kind: 'say'; text: string; order?: RestaurantTurnResult['order'] } | { kind: 'llm' }> {
    const parserItems = catalog.items.map((i) => ({ id: i.id, name: i.name, categoryId: i.categoryId, categoryName: i.categoryName, aliases: i.aliases, available: i.available }));
    const parsed = parseItemRequests(text, parserItems);
    const unknownVariants = parsed.filter((r) => r.unknownVariant).map((r) => r.unknownVariant!);
    const asking = isQuestion(text);
    // A question ("do you have chicken 65?") names items but must not add them to the cart.
    const requests = asking ? [] : parsed.filter((r) => !r.unknownVariant);
    const activeOutlets = catalog.outlets.filter((o) => o.active);
    const say = (t: string, order?: RestaurantTurnResult['order']) => ({ kind: 'say' as const, text: t, order });

    // 1. The confirmation step: only an explicit yes places the order.
    if (s.step === 'awaiting_confirmation' && s.pending) {
      if (intent === 'confirm' && !requests.length) {
        if (Date.now() > s.pending.expiresAt) {
          s.pending = undefined;
          return say(await this.advance(s, catalog, now, 'That summary has expired, so here it is again with current prices:'));
        }
        return this.placeOrder(s, now);
      }
      if (intent === 'decline' && !requests.length) {
        s.pending = undefined;
        s.step = 'browsing';
        return say('Okay, I have not placed the order. Your cart is still saved — add or remove items, type "checkout" when ready, or "clear cart" to start over.');
      }
      if (!requests.length && intent !== 'remove' && intent !== 'clear_cart' && intent !== 'cart' && intent !== 'menu' && intent !== 'category') {
        return say(`${await this.summaryText(s, now)}\n\nPlease reply *YES* to place this order or *NO* to change it.`);
      }
      // Anything that changes the cart falls through and drops the pending confirmation.
    }

    // 1b. Questions about dishes: answer from the menu, never add anything.
    if (asking && parsed.length) {
      const lines: string[] = [];
      for (const r of parsed) {
        const item = catalog.items.find((i) => i.id === r.itemId)!;
        if (r.unknownVariant) lines.push(`Sorry, we don't have ${r.unknownVariant} on our menu. We do have ${item.name} — ${rupees(item.price)}${item.available ? '' : ' (not available right now)'}.`);
        else lines.push(item.available ? `Yes! ${item.name} is ${rupees(item.price)}.` : `${item.name} (${rupees(item.price)}) is not available right now.`);
      }
      const orderable = parsed.filter((r) => !r.unknownVariant && catalog.items.find((i) => i.id === r.itemId)?.available);
      if (orderable.length) lines.push(`To add it, type the quantity, e.g. "1 ${catalog.items.find((i) => i.id === orderable[0].itemId)!.name}".`);
      return say(lines.join('\n'));
    }
    if (unknownVariants.length && !requests.length) {
      return say(`Sorry, we don't have ${unknownVariants.join(', ')} on our menu. Type *menu* to see what we have.`);
    }

    // 2. Details we asked for in the checkout flow.
    if (!requests.length) {
      const detail = await this.answerCheckoutQuestion(s, text, intent, catalog, now);
      if (detail) return say(detail);
    }

    // 3. Cart changes.
    if (intent === 'clear_cart') {
      this.resetCart(s);
      return say('Your cart is now empty. Type "menu" to see what we have.');
    }
    if (intent === 'remove' && requests.length) {
      const removed: string[] = [];
      for (const r of requests) {
        const line = s.cart.find((l) => l.itemId === r.itemId);
        if (!line) continue;
        const explicitQty = /\d|\b(one|two|three|four|five)\b/.test(normalize(text));
        line.quantity = explicitQty ? line.quantity - r.quantity : 0;
        removed.push(catalog.items.find((i) => i.id === r.itemId)?.name ?? 'item');
      }
      s.cart = s.cart.filter((l) => l.quantity > 0);
      this.cartChanged(s);
      if (!removed.length) return say(`That item is not in your cart.\n\n${await this.cartText(s)}`);
      return say(`Removed ${removed.join(', ')}.\n\n${s.cart.length ? await this.cartText(s) : 'Your cart is empty now.'}`);
    }
    if (requests.length) {
      const added: string[] = [];
      const unavailable: string[] = [];
      const capped: string[] = [];
      for (const r of requests) {
        const item = catalog.items.find((i) => i.id === r.itemId)!;
        if (!item.available) {
          unavailable.push(item.name);
          continue;
        }
        const line = s.cart.find((l) => l.itemId === r.itemId);
        const next = (line?.quantity ?? 0) + r.quantity;
        if (next > MAX_QTY_PER_ITEM) {
          capped.push(item.name);
          continue;
        }
        if (line) line.quantity = next;
        else s.cart.push({ itemId: item.id, quantity: r.quantity });
        added.push(`${r.quantity} × ${item.name}`);
      }
      if (added.length) this.cartChanged(s);
      const parts: string[] = [];
      if (added.length) parts.push(`Added ${added.join(', ')} ✅`);
      if (unavailable.length) parts.push(`Sorry, ${unavailable.join(', ')} ${unavailable.length > 1 ? 'are' : 'is'} not available right now.`);
      if (capped.length) parts.push(`For more than ${MAX_QTY_PER_ITEM} × ${capped.join(', ')} please type "talk to staff" (bulk order).`);
      if (unknownVariants.length) parts.push(`Sorry, we don't have ${unknownVariants.join(', ')} on our menu.`);
      if (s.cart.length) parts.push(await this.cartText(s), 'Anything else? Type *checkout* when you are done.');
      return say(parts.join('\n\n'));
    }

    // 4. Everything else.
    switch (intent) {
      case 'greeting':
        return say(
          `Hi${s.name ? ` ${s.name}` : ''}! 👋 Welcome to ${await this.orgName(s.organizationId)}. I can show you the menu and take your order.\n\n` +
            `Type *menu* to see what's available, or just tell me what you'd like, e.g. "2 chicken biryani".` +
            (s.cart.length ? `\n\n${await this.cartText(s)}` : ''),
        );
      case 'menu': {
        const category = findCategory(text, catalog.categories);
        return say(this.menuText(catalog, category?.id));
      }
      case 'cart':
        return say(s.cart.length ? `${await this.cartText(s)}\n\nType *checkout* to order or keep adding items.` : 'Your cart is empty. Type *menu* to see what we have.');
      case 'checkout':
      case 'confirm':
        if (!s.cart.length) {
          if (intent === 'confirm' && s.lastOrderNumber) return say(`Your order ${s.lastOrderNumber} is already placed — no new order was created. Type "order status" to check it, or tell me what else you'd like.`);
          return say('Your cart is empty. Tell me what you would like, e.g. "1 grill chicken full", or type *menu*.');
        }
        return say(await this.advance(s, catalog, now));
      case 'decline':
        return say(s.cart.length ? 'No problem. Your cart is saved — type *checkout* when ready or "clear cart" to empty it.' : 'No problem! Type *menu* whenever you are hungry.');
      case 'hours':
      case 'outlets':
        return say(this.outletsText(activeOutlets, now));
      case 'order_status':
        return say(await this.orderStatusText(s, text));
      case 'human':
        return say(await this.handoff(s));
      case 'thanks':
        return say(s.lastOrderNumber ? `You're welcome! Your order ${s.lastOrderNumber} is with our team. 😊` : "You're welcome! 😊");
      default: {
        const category = findCategory(text, catalog.categories);
        if (category) return say(this.menuText(catalog, category.id));
        return { kind: 'llm' };
      }
    }
  }

  /** Answers to the questions we ask during checkout (outlet, pickup/delivery, area, address, contact). */
  private async answerCheckoutQuestion(s: OrderSession, text: string, intent: RestaurantIntent, catalog: Catalog, now: Date): Promise<string | undefined> {
    const active = catalog.outlets.filter((o) => o.active);
    const generic = ['menu', 'cart', 'clear_cart', 'order_status', 'human', 'hours', 'greeting', 'thanks', 'decline'].includes(intent);

    if (s.step === 'need_outlet') {
      const outlet = pickOutlet(text, active);
      if (outlet) {
        s.outletId = outlet.id;
        if (s.fulfilment === 'pickup' && !outlet.acceptsPickup) s.fulfilment = undefined;
        if (s.fulfilment === 'delivery' && !outlet.acceptsDelivery) s.fulfilment = undefined;
        return this.advance(s, catalog, now);
      }
      if (!generic) return `Please choose an outlet by number:\n${this.outletList(active, now)}`;
    }
    if (s.step === 'need_fulfilment') {
      const f = parseFulfilment(text);
      if (f) {
        s.fulfilment = f;
        return this.advance(s, catalog, now);
      }
      if (!generic) return 'Would you like *pickup* or *delivery*?';
    }
    if (s.step === 'need_area') {
      const outlet = active.find((o) => o.id === s.outletId);
      if (parseFulfilment(text) === 'pickup') {
        s.fulfilment = 'pickup';
        return this.advance(s, catalog, now);
      }
      if (outlet && !generic) {
        const t = normalize(text);
        const area = outlet.serviceAreas.find((a) => ` ${t} `.includes(` ${normalize(a)} `));
        if (area) {
          s.deliveryArea = area;
          return this.advance(s, catalog, now);
        }
        return `Sorry, ${outlet.name} delivers only to: ${outlet.serviceAreas.map(titleCase).join(', ')}.\nReply with one of these areas, or type *pickup* to collect from the outlet.`;
      }
    }
    if (s.step === 'need_address' && !generic) {
      const address = text.trim();
      if (address.length >= 10 && /[a-z]/i.test(address)) {
        s.deliveryAddress = address.slice(0, 300);
        return this.advance(s, catalog, now);
      }
      return 'Please send the full delivery address (door no, street, landmark).';
    }
    if (s.step === 'need_contact' && !generic) {
      const phone = findPhone(text);
      if (phone) {
        const name = text.replace(/(?:\+?91)?[\s-]*[6-9](?:[\s-]*\d){9}/, '').replace(/\b(my|name|is|number|phone|mobile|and|i am|im)\b/gi, ' ').replace(/[^\p{L}\s.]/gu, ' ').replace(/\s+/g, ' ').trim();
        await this.attachPhone(s, phone, name.length >= 2 ? name.slice(0, 60) : undefined);
        if (s.contactFor === 'handoff') {
          s.contactFor = undefined;
          s.step = 'browsing';
          return 'Thank you! Our staff will contact you shortly on this number.';
        }
        return this.advance(s, catalog, now);
      }
      return 'Please share your name and 10-digit mobile number so the outlet can reach you about this order.';
    }
    return undefined;
  }

  /** Move checkout forward: ask for the next missing detail, or show the summary to confirm. */
  private async advance(s: OrderSession, catalog: Catalog, now: Date, lead?: string): Promise<string> {
    s.pending = undefined;
    const active = catalog.outlets.filter((o) => o.active);
    if (!s.cart.length) {
      s.step = 'browsing';
      return 'Your cart is empty. Type *menu* to see what we have.';
    }
    if (!active.length) {
      s.step = 'browsing';
      return 'Sorry, no outlet is taking orders right now. Please type "talk to staff".';
    }
    let outlet = active.find((o) => o.id === s.outletId);
    if (!outlet && active.length === 1) {
      outlet = active[0];
      s.outletId = outlet.id;
    }
    if (!outlet) {
      s.step = 'need_outlet';
      return `Which outlet should prepare your order?\n${this.outletList(active, now)}\n\nReply with the number.`;
    }
    if (!s.fulfilment) {
      if (outlet.acceptsPickup && !outlet.acceptsDelivery) s.fulfilment = 'pickup';
      else if (outlet.acceptsDelivery && !outlet.acceptsPickup) s.fulfilment = 'delivery';
      else {
        s.step = 'need_fulfilment';
        return `${outlet.name} — would you like *pickup* or *delivery*?${outlet.acceptsDelivery ? ` (Delivery fee ${rupees(outlet.deliveryFee)})` : ''}`;
      }
    }
    if (s.fulfilment === 'delivery') {
      if (!s.deliveryArea) {
        s.step = 'need_area';
        return `Which area should we deliver to? ${outlet.name} delivers to: ${outlet.serviceAreas.map(titleCase).join(', ')}.`;
      }
      if (!s.deliveryAddress) {
        s.step = 'need_address';
        return `Please send the full delivery address in ${titleCase(s.deliveryArea)} (door no, street, landmark).`;
      }
    }
    if (!s.phone) {
      s.step = 'need_contact';
      s.contactFor = 'checkout';
      return 'Almost done! Please share your name and 10-digit mobile number so the outlet can reach you about this order.';
    }

    const quote = await this.quote(s, now);
    if (!quote.ok) {
      s.step = 'browsing';
      // An outlet-level problem: let the customer choose again.
      if (quote.problems.some((p) => /closed|does not deliver|does not offer|not taking/.test(p))) {
        if (active.length > 1) s.outletId = undefined;
        s.deliveryArea = undefined;
        s.fulfilment = undefined;
      }
      return `I can't place this order yet:\n• ${quote.problems.join('\n• ')}\n\n${await this.cartText(s)}`;
    }
    s.step = 'awaiting_confirmation';
    s.pending = { nonce: randomUUID(), total: quote.total, expiresAt: Date.now() + CONFIRM_TTL_MS };
    return `${lead ? `${lead}\n\n` : ''}${this.renderSummary(s, quote)}\n\nReply *YES* to place this order or *NO* to change it.`;
  }

  private async placeOrder(s: OrderSession, now: Date): Promise<{ kind: 'say'; text: string; order?: RestaurantTurnResult['order'] }> {
    const pending = s.pending!;
    if (!s.customerId || !s.outletId || !s.fulfilment) {
      return { kind: 'say', text: await this.advance(s, await this.catalog.get(s.organizationId), now) };
    }
    const result = await this.orders.createOrder({
      organizationId: s.organizationId,
      idempotencyKey: `${s.key}:${pending.nonce}`,
      customerId: s.customerId,
      conversationId: s.conversationId,
      channel: s.channel,
      lines: s.cart,
      outletId: s.outletId,
      fulfilment: s.fulfilment,
      deliveryAddress: s.deliveryAddress,
      deliveryArea: s.deliveryArea,
      customerName: s.name,
      customerPhone: s.phone,
      expectedTotal: pending.total,
      now,
    });
    if (result.status === 'rejected') {
      s.pending = undefined;
      s.step = 'browsing';
      this.catalog.invalidate(s.organizationId);
      return { kind: 'say', text: `Sorry, I couldn't place the order:\n• ${result.problems.join('\n• ')}\n\nType *checkout* to see the updated summary.` };
    }
    const order = result.order;
    s.lastOrderNumber = order.orderNumber;
    this.resetCart(s);
    return { kind: 'say', text: this.confirmationText(order), order: { status: result.status, id: order.id, orderNumber: order.orderNumber, total: order.total } };
  }

  // -----------------------------------------------------------------------------------------------
  // Replies (all prices from the database)
  // -----------------------------------------------------------------------------------------------

  private confirmationText(order: OrderView): string {
    const lines = [
      `✅ Order *${order.orderNumber}* received — ${rupees(order.total)}`,
      ...order.items.map((i) => `• ${i.quantity} × ${i.name} — ${rupees(i.lineTotal)}`),
      order.deliveryFee ? `• Delivery fee — ${rupees(order.deliveryFee)}` : '',
      `${order.fulfilment === 'delivery' ? `Delivery to: ${order.deliveryAddress}` : `Pickup from: ${order.outlet.name}`}`,
      `Payment: ${PAYMENT_TEXT[order.fulfilment as 'pickup' | 'delivery']} (nothing has been charged).`,
      '',
      `Status: *waiting for ${order.outlet.name} to confirm*. Our staff will confirm shortly; you can ask "order status" any time.`,
    ].filter((l) => l !== '');
    if (order.isDemo) lines.push('', '⚠️ Demo: this order uses demo menu data and has NOT been sent to a real restaurant.');
    return lines.join('\n');
  }

  private renderSummary(s: OrderSession, q: Quote): string {
    const o = q.outlet!;
    const rows = q.lines.map((l) => `• ${l.quantity} × ${l.name} — ${rupees(l.lineTotal)}`);
    return [
      '*Your order*',
      ...rows,
      `Subtotal: ${rupees(q.subtotal)}`,
      s.fulfilment === 'delivery' ? `Delivery fee: ${rupees(q.deliveryFee)}` : '',
      `*Total: ${rupees(q.total)}*`,
      s.fulfilment === 'delivery' ? `Delivery to: ${s.deliveryAddress} (${titleCase(s.deliveryArea!)}) from ${o.name}` : `Pickup from: ${o.name}, ${o.address}`,
      `Payment: ${PAYMENT_TEXT[s.fulfilment!]}`,
      !o.openNow ? `Note: ${o.name} is open ${o.opensAt}–${o.closesAt}; staff will confirm your order.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async summaryText(s: OrderSession, now: Date): Promise<string> {
    const q = await this.quote(s, now);
    return q.outlet ? this.renderSummary(s, q) : this.cartText(s);
  }

  private async cartText(s: OrderSession): Promise<string> {
    if (!s.cart.length) return 'Your cart is empty.';
    const q = await this.orders.quote({ organizationId: s.organizationId, lines: s.cart });
    return ['🛒 *Your cart*', ...q.lines.map((l) => `• ${l.quantity} × ${l.name} — ${rupees(l.lineTotal)}`), `Subtotal: ${rupees(q.subtotal)}`].join('\n');
  }

  private menuText(catalog: Catalog, categoryId?: string): string {
    const cats = categoryId ? catalog.categories.filter((c) => c.id === categoryId) : catalog.categories;
    const blocks = cats
      .map((c) => {
        const items = catalog.items.filter((i) => i.categoryId === c.id && i.available);
        if (!items.length) return '';
        return [`*${c.name}*`, ...items.map((i) => `• ${i.name} — ${rupees(i.price)}`)].join('\n');
      })
      .filter(Boolean);
    if (!blocks.length) return 'The menu is being updated right now. Please type "talk to staff".';
    const demo = catalog.items.some((i) => i.isDemo) ? '\n\n(Demo menu: items and prices are sample data.)' : '';
    return `${blocks.join('\n\n')}\n\nTo order, type the items with quantities, e.g. "2 chicken biryani and 1 lime soda".${demo}`;
  }

  private outletList(outlets: OutletView[], now: Date): string {
    return outlets
      .map((o, i) => `${i + 1}. ${o.name}${o.area ? ` (${o.area})` : ''} — ${o.opensAt}–${o.closesAt}${isOpen(o, now) ? '' : ' · closed now'}${o.acceptsDelivery ? ' · delivery' : ''}${o.acceptsPickup ? ' · pickup' : ''}`)
      .join('\n');
  }

  private outletsText(outlets: OutletView[], now: Date): string {
    if (!outlets.length) return 'No outlet is taking orders right now.';
    const demo = outlets.some((o) => o.isDemo) ? '\n\n(Demo outlets: sample data.)' : '';
    return `Our outlets:\n${outlets
      .map((o, i) => `${i + 1}. *${o.name}* — ${o.address}\n   Open ${o.opensAt}–${o.closesAt}${isOpen(o, now) ? ' (open now)' : ' (closed now)'}${o.phone ? ` · ${o.phone}` : ''}${
          o.acceptsDelivery && o.serviceAreas.length ? `\n   Delivers to: ${o.serviceAreas.map(titleCase).join(', ')}` : ''
        }`)
      .join('\n')}${demo}`;
  }

  private async orderStatusText(s: OrderSession, text: string): Promise<string> {
    const number = findOrderNumber(text);
    // A customer may only look up their own orders.
    if (!s.customerId) return 'I can check orders placed in this chat. For an earlier order, type "talk to staff" and our team will help.';
    const order = number ? await this.orders.findByNumber(s.organizationId, number, s.customerId) : await this.orders.latestForCustomer(s.organizationId, s.customerId);
    if (!order) return number ? `I couldn't find order ${number} for this number.` : "I couldn't find an order from you yet.";
    const label: Record<string, string> = {
      pending: 'waiting for the outlet to confirm',
      confirmed: 'confirmed by the outlet',
      preparing: 'being prepared 🍗',
      ready: order.fulfilment === 'pickup' ? 'ready for pickup' : 'ready, waiting for the delivery partner',
      out_for_delivery: 'out for delivery 🛵',
      completed: 'completed',
      cancelled: 'cancelled',
    };
    return `Order *${order.orderNumber}* (${rupees(order.total)}) is ${label[order.status] ?? order.status}. Payment: ${order.paymentStatus === 'paid' ? 'paid' : 'not paid yet'}.`;
  }

  private async handoff(s: OrderSession): Promise<string> {
    await this.prisma.conversation.update({ where: { id: s.conversationId! }, data: { status: 'human_handoff', updatedAt: new Date() } });
    log.info('restaurant.handoff', { organizationId: s.organizationId, conversationId: s.conversationId });
    if (!s.phone) {
      s.step = 'need_contact';
      s.contactFor = 'handoff';
      return 'Sure — please share your name and 10-digit mobile number and our staff will contact you.';
    }
    return 'Sure — I have flagged this chat for our staff. Someone from the outlet will reply to you here.';
  }

  // -----------------------------------------------------------------------------------------------
  // Model fallback (phrasing only)
  // -----------------------------------------------------------------------------------------------

  private async answerWithModel(s: OrderSession, text: string, catalog: Catalog, now: Date): Promise<{ text: string; path: 'rules' | 'llm'; usage?: AiUsageMetrics }> {
    const fallback =
      `I can help you order from our menu. Type *menu* to see items and prices, or tell me what you'd like, e.g. "2 chicken biryani".` +
      `\nFor anything else, type "talk to staff".`;
    if (!llmConfigured()) return { text: fallback, path: 'rules' };

    const prices = new Set(catalog.items.map((i) => i.price));
    const brief = [
      'VERIFIED MENU (only these items and prices exist):',
      ...catalog.categories.map((c) => `${c.name}: ${catalog.items.filter((i) => i.categoryId === c.id && i.available).map((i) => `${i.name} ₹${i.price}${i.isVeg ? ' (veg)' : ''}${i.description ? ` - ${i.description}` : ''}`).join('; ')}`),
      'OUTLETS:',
      ...catalog.outlets.filter((o) => o.active).map((o) => `${o.name}, ${o.address}, open ${o.opensAt}-${o.closesAt}${o.acceptsDelivery ? `, delivers to ${o.serviceAreas.join(', ')} (fee ₹${o.deliveryFee})` : ', pickup only'}`),
      `CUSTOMER CART: ${s.cart.length ? s.cart.map((l) => `${l.quantity} x ${catalog.items.find((i) => i.id === l.itemId)?.name}`).join(', ') : 'empty'}`,
    ].join('\n');
    const context: RestaurantAgentContext = { organizationName: await this.orgName(s.organizationId), channel: s.channel, nowText: nowInIst(now).text, brief };
    const run = await this.llm.run({
      channel: s.channel,
      toolset: 'none',
      context: context as unknown as TacksharpAgentContext,
      history: s.history.slice(-6),
      message: text,
      maxTurns: 1,
      agent: getRestaurantAgent(s.channel),
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
      v: 1,
      key,
      organizationId: input.organizationId,
      channel: input.channel,
      phone: input.channel === 'whatsapp' ? normalizePhone(input.phone) : undefined,
      name: input.customerName?.trim() || undefined,
      cart: [],
      step: 'browsing',
      history: [],
      updatedAt: new Date().toISOString(),
    };
  }

  /** WhatsApp: the customer is known from the number. Web: anonymous until they share a number at checkout. */
  private async ensureThread(s: OrderSession, input: RestaurantTurnInput) {
    if (s.channel === 'whatsapp' && s.phone && !s.customerId) {
      const c = await this.conversations.getOrCreateCustomerByPhone(s.organizationId, s.phone, { name: s.name, source: 'whatsapp' });
      s.customerId = c.id;
      s.name ??= c.name ?? undefined;
    }
    if (!s.conversationId) {
      const conv = await this.conversations.getOrCreateConversation({
        organizationId: s.organizationId,
        channel: s.channel,
        externalId: s.channel === 'web' ? `web:${input.sessionId}` : s.phone!,
        customerId: s.customerId,
      });
      s.conversationId = conv.id;
    }
  }

  private async attachPhone(s: OrderSession, phone: string, name?: string) {
    const normalized = normalizePhone(phone);
    if (!normalized) return;
    const customer = await this.conversations.getOrCreateCustomerByPhone(s.organizationId, normalized, { name, source: s.channel });
    s.phone = normalized;
    s.customerId = customer.id;
    s.name = name ?? customer.name ?? s.name;
    await this.prisma.conversation.updateMany({ where: { id: s.conversationId, organizationId: s.organizationId }, data: { customerId: customer.id, updatedAt: new Date() } });
  }

  private quote(s: OrderSession, now: Date) {
    return this.orders.quote({ organizationId: s.organizationId, lines: s.cart, outletId: s.outletId, fulfilment: s.fulfilment, deliveryArea: s.deliveryArea, now });
  }

  private cartChanged(s: OrderSession) {
    s.pending = undefined;
    if (s.step === 'awaiting_confirmation') s.step = 'browsing';
  }

  private resetCart(s: OrderSession) {
    s.cart = [];
    s.pending = undefined;
    s.step = 'browsing';
    s.deliveryAddress = undefined;
  }

  private readonly orgNames = new Map<string, string>();
  private async orgName(organizationId: string) {
    const hit = this.orgNames.get(organizationId);
    if (hit) return hit;
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    const name = org?.name ?? 'our restaurant';
    this.orgNames.set(organizationId, name);
    return name;
  }
}

function titleCase(s: string) {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** Drop any sentence of a model reply that names a rupee amount which is not a menu price. */
export function filterUnverifiedPrices(text: string, prices: Set<number>): string {
  const sentences = text.split(/(?<=[.!?\n])\s*/);
  const kept = sentences.filter((sentence) => {
    const amounts = [...sentence.matchAll(/(?:₹|rs\.?|inr|rupees?)\s*([\d,]+(?:\.\d+)?)/gi)].map((m) => Number(m[1].replace(/,/g, '')));
    return amounts.every((a) => prices.has(a));
  });
  return kept.join(' ').replace(/\s+\n/g, '\n').trim();
}
