import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SettingsService } from '../../settings/settings.service.js';
import { DEFAULT_SETTINGS } from '../../settings/tenant-settings.js';
import { inr, prettyTime } from '../common.js';
import { findReference, isGreeting, isNo, isThanks, isYes, lower, numWord, wantsHuman } from '../parse.js';
import { resetState, t, type AgentCtx, type AgentOut } from '../agent-types.js';
import { FOOD_STATUS_LABEL, FoodService, type FoodCartLine, type FoodItemView, type FoodQuote } from './food.service.js';
import { VerticalFollowUps } from '../vertical-followups.service.js';

export type FoodState = {
  v: 1;
  step: 'browsing' | 'ask_variant' | 'ask_fulfilment' | 'ask_address' | 'confirm' | 'confirm_cancel' | 'handoff';
  cart: FoodCartLine[];
  /** Items waiting for a size choice (asked one at a time). */
  pendingVariants?: Array<{ itemId: string; quantity: number; addOns: string[] }>;
  fulfilment?: 'pickup' | 'delivery';
  address?: string;
  cancelOrderId?: string;
  lastOrderId?: string;
};
export const newFoodState = (): FoodState => ({ v: 1, step: 'browsing', cart: [] });

const COMPLAINT = /\b(complain|complaint|worst|stale|wrong (order|item)|missing|not received|never arrived|refund|delay(ed)?|hair in|not good|terrible|disappointed|spilled|(came|was|is|arrived|food) (very )?cold|too late|very late|bad (food|taste|service))\b/;
const STATUS = /\b(status|where is my order|track|tracking|order eppo|eppo varum|ready ah|ready aa|is it ready|how long)\b/;
const MENU = /\b(menu|what do you have|what's available|whats available|items|list|dishes|enna irukku|ena iruku|options)\b/;
const CANCEL_ORDER = /\b(cancel (my |the )?order|order cancel|cancel pannunga|cancel it)\b/;
const REMOVE = /\b(remove|delete|no more|drop|vendam|venam|cancel)\b/;
const TOTAL = /\b(total|bill|how much|evlo|evvalavu|amount|price)\b/;
const HOURS = /\b(timing|timings|hours|open|close|closing|opening|time)\b/;
const WHERE = /\b(where|location|address|branch|kadai enga)\b/;
const DELIVERY_Q = /\b(do you deliver|delivery available|deliver to|delivery charge|delivery fee|areas)\b/;
const PICKUP = /\b(pickup|pick up|take ?away|parcel|collect|i will come|naan varen|self pick)\b/;
const DELIVERY = /\b(delivery|deliver|home delivery|send it|door delivery)\b/;

/** Matches menu items (name or alias) in a message with their quantity, variant and add-ons. */
export function parseFoodItems(text: string, items: FoodItemView[]) {
  let rest = lower(text);
  const found: Array<{ item: FoodItemView; quantity: number; variant?: string; addOns: string[] }> = [];
  const names = items
    .flatMap((i) => [i.name.toLowerCase(), ...i.aliases].map((n) => ({ n: n.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(), i })))
    .filter((x) => x.n.length >= 3)
    .sort((a, b) => b.n.length - a.n.length);
  for (const { n, i } of names) {
    const re = new RegExp(`(?:\\b(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|oru|rendu|moonu|naalu)\\s+(?:x\\s*)?)?(${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})s?\\b(?:\\s*x\\s*(\\d+))?`, 'i');
    const m = rest.match(re);
    if (!m) continue;
    const quantity = (m[3] ? Number(m[3]) : m[1] ? numWord(m[1]) : 1) ?? 1;
    const ctx = rest.slice(Math.max(0, (m.index ?? 0) - 25), (m.index ?? 0) + m[0].length + 40);
    const variant = i.variants.find((v) => new RegExp(`\\b${v.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(ctx))?.name;
    const addOns = i.addOns.filter((a) => new RegExp(`\\b${a.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(ctx)).map((a) => a.name);
    if (!found.some((f) => f.item.id === i.id)) found.push({ item: i, quantity, variant, addOns });
    rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice((m.index ?? 0) + m[0].length);
  }
  return found;
}

const keyOf = (l: FoodCartLine) => `${l.itemId}|${(l.variant ?? '').toLowerCase()}|${[...(l.addOns ?? [])].map((a) => a.toLowerCase()).sort().join(',')}`;

/**
 * Restaurant & food ordering assistant (WhatsApp, voice, test chat). Rules-first: every price, availability and order
 * state comes from FoodService; the assistant never states a number it did not get from there.
 */
@Injectable()
export class FoodAgent {
  constructor(
    private readonly food: FoodService,
    private readonly followUps: VerticalFollowUps,
    private readonly settings: SettingsService,
  ) {}

  private cartText(q: FoodQuote, style: 'en' | 'tl') {
    const lines = q.lines.map((l) => `• ${l.quantity} × ${l.name}${l.variant ? ` (${l.variant})` : ''}${l.addOns.length ? ` + ${l.addOns.map((a) => a.name).join(', ')}` : ''} — ${inr(l.lineTotal)}`);
    const fees = [q.tax ? `Tax ${inr(q.tax)}` : '', q.packagingFee ? `Packing ${inr(q.packagingFee)}` : '', q.deliveryFee ? `Delivery ${inr(q.deliveryFee)}` : ''].filter(Boolean).join(' · ');
    return `${lines.join('\n')}\n${t(style, 'Subtotal', 'Subtotal')} ${inr(q.subtotal)}${fees ? ` · ${fees}` : ''}\n*${t(style, 'Total', 'Total')} ${inr(q.total)}*`;
  }

  private menuText(menu: Awaited<ReturnType<FoodService['menu']>>, category?: string) {
    const cats = category ? menu.categories.filter((c) => c.name.toLowerCase() === category) : menu.categories;
    return cats
      .map((c) => `*${c.name}*\n${c.items.map((i) => `• ${i.name}${i.isVeg === true ? ' 🟢' : i.isVeg === false ? ' 🔴' : ''} — ${i.variants.length ? i.variants.map((v) => `${v.name} ${inr(v.price)}`).join(' / ') : inr(i.price)}${i.soldOut ? ' (sold out)' : ''}`).join('\n')}`)
      .join('\n\n');
  }

  async turn(ctx: AgentCtx, state: FoodState): Promise<AgentOut<FoodState>> {
    const s: FoodState = { ...newFoodState(), ...state, cart: [...(state.cart ?? [])] };
    const text = ctx.text;
    const lt = lower(text);
    const st = ctx.style;
    const cfg = (await this.settings.get(ctx.org)).food ?? DEFAULT_SETTINGS.food;
    const menu = await this.food.menu(ctx.org);
    const items = menu.categories.flatMap((c) => c.items);
    const out = (reply: string, intent: string, extra: Partial<AgentOut<FoodState>> = {}): AgentOut<FoodState> => ({ reply, state: s, intent, ...extra });

    // 1. A person: complaints and explicit requests go to staff with the conversation.
    if (COMPLAINT.test(lt) || wantsHuman(text)) {
      s.step = 'handoff';
      const complaint = COMPLAINT.test(lt);
      return out(
        complaint
          ? t(st, 'I am sorry about that. I have passed this to our restaurant team right away; a team member will reply here shortly.', 'Sorry for the trouble. Ungal message-a restaurant team-ku anuppiten; seekiram inga reply pannuvaanga.')
          : t(st, 'Sure — a team member will reply to you here shortly.', 'Seri, engal team member seekiram inga reply pannuvaanga.'),
        complaint ? 'complaint' : 'human',
        { handoff: { reason: complaint ? `Complaint: "${text.slice(0, 200)}"` : 'Customer asked for a person' }, outcome: 'human_requested' },
      );
    }
    if (s.step === 'handoff' && !isGreeting(text) && !MENU.test(lt) && !parseFoodItems(text, items).length) {
      return out(t(st, 'Noted — our team has your message and will reply here.', 'Noted, engal team inga reply pannuvaanga.'), 'handoff_waiting');
    }
    if (s.step === 'handoff') s.step = 'browsing';

    // 2. Order status.
    const ref = findReference(text, 'FD');
    if (ref || STATUS.test(lt)) {
      const o = ref ? await this.food.byNumber(ctx.org, `FD-${ref}`) : (await this.food.customerOrders(ctx.org, ctx.customer.id, 1))[0];
      if (!o || o.customer.id !== ctx.customer.id) return out(t(st, 'I could not find an order for this number. Please share the order number (like FD-XXXXXX).', 'Indha number-ku order kidaikkala. Order number (FD-XXXXXX) anuppunga.'), 'status_not_found');
      const eta = ['pending', 'confirmed', 'preparing'].includes(o.status) ? ` ${t(st, 'Expected around', 'Expected')} ${prettyTime(new Date(o.readyBy))}.` : '';
      return out(`${t(st, 'Order', 'Order')} ${o.orderNumber}: *${FOOD_STATUS_LABEL[o.status] ?? o.status}* (${inr(o.total)}, ${o.fulfilment}).${eta}`, 'order_status');
    }

    // 3. Cancel a placed order (only before the kitchen accepts it; afterwards staff decide).
    if (s.step === 'confirm_cancel') {
      const id = s.cancelOrderId;
      s.step = 'browsing';
      s.cancelOrderId = undefined;
      if (id && isYes(text)) {
        const o = await this.food.get(ctx.org, id);
        if (o.status !== 'pending') {
          s.step = 'handoff';
          return out(t(st, 'The kitchen has already accepted this order, so I have asked our team to help with the cancellation.', 'Kitchen already accept pannitaanga; cancel-ku team-a help panna sonnen.'), 'cancel_handoff', { handoff: { reason: `Cancel request after acceptance: ${o.orderNumber}` } });
        }
        const c = await this.food.setStatus(ctx.org, id, 'cancelled', 'ai:customer_request', 'Customer cancelled on chat before acceptance');
        await this.followUps.onFoodStatus(ctx.org, { id, customerId: ctx.customer.id, status: 'cancelled' });
        return out(t(st, `Order ${c.orderNumber} is cancelled.`, `Order ${c.orderNumber} cancel aagiduchu.`), 'order_cancelled', { outcome: 'cancelled', record: { type: 'order', id, reference: c.orderNumber, status: 'cancelled', result: 'updated' } });
      }
      return out(t(st, 'Okay, your order stays as it is.', 'Seri, order appadiye irukku.'), 'cancel_aborted');
    }
    if (CANCEL_ORDER.test(lt) && !s.cart.length) {
      const o = (await this.food.customerOrders(ctx.org, ctx.customer.id, 1))[0];
      if (!o || ['completed', 'cancelled'].includes(o.status)) return out(t(st, 'You have no open order to cancel.', 'Cancel panna open order illa.'), 'cancel_none');
      if (o.status !== 'pending') {
        s.step = 'handoff';
        return out(t(st, `Order ${o.orderNumber} is already ${FOOD_STATUS_LABEL[o.status].toLowerCase()}, so our team will help with the cancellation. A team member will reply here.`, `Order ${o.orderNumber} already ${FOOD_STATUS_LABEL[o.status].toLowerCase()}; team inga reply pannuvaanga.`), 'cancel_handoff', { handoff: { reason: `Cancel request: ${o.orderNumber} (${o.status})` } });
      }
      s.step = 'confirm_cancel';
      s.cancelOrderId = o.id;
      return out(t(st, `Cancel order ${o.orderNumber} (${inr(o.total)})? Reply YES to cancel.`, `Order ${o.orderNumber} (${inr(o.total)}) cancel pannanuma? YES nu reply pannunga.`), 'cancel_confirm');
    }

    // 4. Rating after an order (feedback agent).
    const rating = lt.trim().match(/^\s*([1-5])\s*(?:\/\s*5)?\s*(?:stars?)?\s*$/);
    if (rating && s.lastOrderId && s.step === 'browsing' && !s.cart.length) {
      const o = await this.food.get(ctx.org, s.lastOrderId);
      if (o.status === 'completed' && o.feedbackRating === null) {
        await this.food.recordFeedback(ctx.org, o.id, Number(rating[1]), null, ctx.channel);
        if (Number(rating[1]) <= 2) {
          s.step = 'handoff';
          return out(t(st, 'Thank you for telling us. I am sorry it was not good — our manager will reach out to you here.', 'Sollunadhuku nandri. Sorry — engal manager inga contact pannuvaanga.'), 'feedback_low', { handoff: { reason: `Low rating ${rating[1]}/5 for ${o.orderNumber}` } });
        }
        return out(t(st, 'Thank you for the rating! 🙏', 'Rating-ku nandri! 🙏'), 'feedback');
      }
    }

    // 5. Variant choice pending.
    if (s.step === 'ask_variant' && s.pendingVariants?.length) {
      const pending = s.pendingVariants[0];
      const item = items.find((i) => i.id === pending.itemId);
      const v = item?.variants.find((x) => lt.includes(` ${x.name.toLowerCase()} `)) ?? (item ? item.variants[(numWord(lt.trim()) ?? 0) - 1] : undefined);
      if (item && v) {
        this.add(s, { itemId: item.id, quantity: pending.quantity, variant: v.name, addOns: pending.addOns });
        s.pendingVariants = s.pendingVariants.slice(1);
        const note = t(st, `Added ${item.name} (${v.name}).`, `${item.name} (${v.name}) add pannitten.`);
        if (s.pendingVariants.length) return this.askVariant(s, items, st, note);
        s.step = 'browsing';
        return this.afterCart(ctx, s, cfg, note);
      }
      if (item && !parseFoodItems(text, items).length) return this.askVariant(s, items, st, '');
      s.step = 'browsing';
      s.pendingVariants = [];
    }

    // 6. Fulfilment / address.
    if (s.step === 'ask_fulfilment' || (s.cart.length && (PICKUP.test(lt) || (DELIVERY.test(lt) && !DELIVERY_Q.test(lt))))) {
      if (PICKUP.test(lt)) {
        s.fulfilment = 'pickup';
        s.address = undefined;
        return this.toConfirm(ctx, s);
      }
      if (DELIVERY.test(lt)) {
        if (!cfg.deliveryEnabled) return out(t(st, 'Sorry, we are pickup only right now. Shall I make it pickup?', 'Sorry, ippo pickup mattum dhaan. Pickup-ah pannalama?'), 'delivery_unavailable');
        s.fulfilment = 'delivery';
        s.step = 'ask_address';
        return out(t(st, `Please share the delivery address with area name. We deliver to: ${cfg.deliveryZones.map((z) => z.name).join(', ')}.`, `Delivery address (area name-oda) anuppunga. Delivery areas: ${cfg.deliveryZones.map((z) => z.name).join(', ')}.`), 'ask_address');
      }
    }
    if (s.step === 'ask_address') {
      if (lt.trim().length < 8) return out(t(st, 'Please send the full address with the area name.', 'Full address area name-oda anuppunga.'), 'ask_address');
      const q = await this.food.quote(ctx.org, { lines: s.cart, fulfilment: 'delivery', address: text });
      const blocking = q.problems.filter((p) => /deliver|Minimum/.test(p));
      if (blocking.length) return out(`${blocking.join(' ')} ${t(st, 'You can send another address or reply PICKUP.', 'Vera address anuppunga, illa PICKUP nu reply pannunga.')}`, 'address_rejected');
      s.address = text.trim().slice(0, 300);
      return this.toConfirm(ctx, s);
    }

    // 7. Confirmation.
    if (s.step === 'confirm') {
      if (isYes(text)) return this.place(ctx, s);
      if (isNo(text) && !parseFoodItems(text, items).length) {
        s.step = 'browsing';
        return out(t(st, 'No problem — tell me what to change (add, remove or change quantity), or say CLEAR to start over.', 'Seri — enna maathanum sollunga (add / remove / quantity), illa CLEAR nu sollunga.'), 'confirm_declined');
      }
    }

    if (/\b(clear|start over|empty cart|reset)\b/.test(lt)) {
      resetState(s, newFoodState(), { lastOrderId: s.lastOrderId });
      return out(t(st, 'Cart cleared. What would you like to order?', 'Cart clear pannitten. Enna order pannalam?'), 'cart_cleared');
    }

    // 8. Items: add / remove / change quantity.
    const mentions = parseFoodItems(text, items);
    if (!mentions.length && s.cart.length && /\b(confirm|checkout|check out|place (the )?order|that's all|thats all|that is all|done|bas|podhum|order pannunga)\b/.test(lt)) {
      if (!s.fulfilment && cfg.pickupEnabled && cfg.deliveryEnabled) {
        s.step = 'ask_fulfilment';
        return out(t(st, 'Pickup or delivery?', 'Pickup-ah delivery-ah?'), 'ask_fulfilment');
      }
      s.fulfilment ??= cfg.deliveryEnabled && !cfg.pickupEnabled ? 'delivery' : 'pickup';
      return this.toConfirm(ctx, s);
    }
    if (mentions.length) {
      if (REMOVE.test(lt) && !/\badd\b/.test(lt)) {
        const removed: string[] = [];
        for (const m of mentions) {
          const before = s.cart.length;
          s.cart = s.cart.filter((l) => l.itemId !== m.item.id);
          if (s.cart.length < before) removed.push(m.item.name);
        }
        if (s.step === 'confirm') s.step = 'browsing';
        return this.afterCart(ctx, s, cfg, removed.length ? t(st, `Removed ${removed.join(', ')}.`, `${removed.join(', ')} remove pannitten.`) : t(st, 'That item is not in your cart.', 'Adhu cart-la illa.'));
      }
      const changeTo = lt.match(/\b(?:make it|change (?:it )?to|update to|only)\s+(\d+)\b/);
      const notes: string[] = [];
      const needSize: Array<{ itemId: string; quantity: number; addOns: string[] }> = [];
      for (const m of mentions) {
        if (m.item.soldOut) {
          const alt = items.filter((i) => i.category === m.item.category && !i.soldOut && i.id !== m.item.id).slice(0, 3).map((i) => i.name);
          notes.push(t(st, `Sorry, ${m.item.name} is sold out${alt.length ? `; try ${alt.join(', ')}` : ''}.`, `Sorry, ${m.item.name} sold out${alt.length ? `; ${alt.join(', ')} try pannunga` : ''}.`));
          continue;
        }
        const qty = changeTo ? Number(changeTo[1]) : m.quantity;
        const existing = s.cart.find((l) => l.itemId === m.item.id);
        if (changeTo && existing) {
          existing.quantity = qty;
          continue;
        }
        if (m.item.variants.length && !m.variant) {
          needSize.push({ itemId: m.item.id, quantity: qty, addOns: m.addOns });
          continue;
        }
        this.add(s, { itemId: m.item.id, quantity: qty, variant: m.variant ?? null, addOns: m.addOns });
      }
      if (needSize.length) {
        s.pendingVariants = needSize;
        return this.askVariant(s, items, st, notes.join(' '));
      }
      if (s.step === 'confirm') s.step = 'browsing';
      return this.afterCart(ctx, s, cfg, notes.join(' '));
    }

    // 9. Questions answered from configuration.
    if (MENU.test(lt) || menu.categories.some((c) => lt.includes(` ${c.name.toLowerCase()} `))) {
      const cat = menu.categories.find((c) => lt.includes(` ${c.name.toLowerCase()} `))?.name.toLowerCase();
      return out(`${this.menuText(menu, cat)}\n\n${t(st, 'Send items with quantity, e.g. "2 masala dosa, 1 filter coffee".', 'Item + quantity anuppunga, e.g. "2 masala dosa, 1 filter coffee".')}`, 'menu');
    }
    if (TOTAL.test(lt) && s.cart.length) {
      const q = await this.food.quote(ctx.org, { lines: s.cart, fulfilment: s.fulfilment ?? 'pickup', address: s.fulfilment === 'delivery' ? s.address ?? '' : undefined });
      return out(this.cartText(q, st), 'cart_total');
    }
    const faq = cfg.faqs.find((f) => lower(f.q).split(' ').filter((w) => w.length > 3).some((w) => lt.includes(` ${w} `)));
    if (DELIVERY_Q.test(lt)) {
      return out(cfg.deliveryEnabled ? t(st, `Yes, we deliver to ${cfg.deliveryZones.map((z) => `${z.name} (${inr(z.fee)}, min ${inr(z.minOrder)}, ~${z.etaMinutes} min)`).join(', ')}.`, `Aama, delivery areas: ${cfg.deliveryZones.map((z) => `${z.name} (${inr(z.fee)})`).join(', ')}.`) : t(st, 'We are pickup only right now.', 'Ippo pickup mattum dhaan.'), 'faq_delivery');
    }
    if (HOURS.test(lt) || WHERE.test(lt)) {
      const o = menu.outlets[0];
      if (o) return out(`${o.name}: ${o.address}. ${t(st, 'Open', 'Open')} ${o.opensAt}–${o.closesAt}${o.open ? '' : t(st, ' (closed now)', ' (ippo closed)')}.${o.phone ? ` ☎ ${o.phone}` : ''}`, 'faq_hours');
    }
    if (faq) return out(faq.a, 'faq');
    if (/\b(veg|vegetarian|non veg|nonveg|jain)\b/.test(lt)) {
      const veg = items.filter((i) => i.isVeg && !i.soldOut).slice(0, 12).map((i) => i.name);
      return out(t(st, `Vegetarian options: ${veg.join(', ')}.`, `Veg options: ${veg.join(', ')}.`), 'faq_veg');
    }

    if (s.lastOrderId && !s.cart.length && isYes(text)) {
      const o = await this.food.get(ctx.org, s.lastOrderId);
      return out(t(st, `Your order ${o.orderNumber} is already placed (${FOOD_STATUS_LABEL[o.status] ?? o.status}). Ask "status" anytime.`, `Ungal order ${o.orderNumber} already place aagiduchu (${FOOD_STATUS_LABEL[o.status] ?? o.status}).`), 'already_placed');
    }
    if (isThanks(text)) return out(t(st, `Thank you for choosing ${ctx.orgName}! 🙏`, `${ctx.orgName}-a choose pannadhuku nandri! 🙏`), 'goodbye', { endCall: ctx.voice });
    if (isGreeting(text) || !s.cart.length) {
      const top = items.filter((i) => !i.soldOut).slice(0, 4).map((i) => i.name).join(', ');
      return out(
        t(st, `Welcome to ${ctx.orgName}! 😊 Reply MENU to see the menu, or order directly, e.g. "2 ${items[0]?.name ?? 'items'}". Popular: ${top}.`, `${ctx.orgName}-ku welcome! 😊 MENU nu reply pannunga, illa direct-ah order pannunga, e.g. "2 ${items[0]?.name ?? 'items'}". Popular: ${top}.`),
        isGreeting(text) ? 'greeting' : 'unknown',
      );
    }
    return out(t(st, 'I can help with the menu, your cart, delivery or pickup, and order status. You can add items like "1 cold coffee large", or reply CONFIRM to review your order.', 'Menu, cart, delivery / pickup, order status — idhula help pannuven. "1 cold coffee large" maadhiri add pannunga, illa CONFIRM nu reply pannunga.'), 'unknown');
  }

  private askVariant(s: FoodState, items: FoodItemView[], st: 'en' | 'tl', note: string): AgentOut<FoodState> {
    s.step = 'ask_variant';
    const item = items.find((i) => i.id === s.pendingVariants![0].itemId)!;
    const options = item.variants.map((x, k) => `${k + 1}. ${x.name} ${inr(x.price)}`).join(' / ');
    return { reply: `${note ? `${note}\n` : ''}${t(st, `Which size for ${item.name}? ${options}`, `${item.name}-ku endha size? ${options}`)}`, state: s, intent: 'ask_variant' };
  }

  private add(s: FoodState, line: FoodCartLine) {
    const k = keyOf(line);
    const existing = s.cart.find((l) => keyOf(l) === k);
    if (existing) existing.quantity = Math.min(20, existing.quantity + line.quantity);
    else s.cart.push({ ...line, addOns: line.addOns ?? [] });
  }

  /** After a cart change: show the server total and ask the next missing thing. */
  private async afterCart(ctx: AgentCtx, s: FoodState, cfg: typeof DEFAULT_SETTINGS.food, note: string): Promise<AgentOut<FoodState>> {
    const st = ctx.style;
    if (!s.cart.length) {
      s.step = 'browsing';
      return { reply: `${note ? `${note} ` : ''}${t(st, 'Your cart is empty. What would you like?', 'Cart empty. Enna venum?')}`.trim(), state: s, intent: 'cart_empty' };
    }
    const q = await this.food.quote(ctx.org, { lines: s.cart, fulfilment: s.fulfilment ?? 'pickup', address: s.fulfilment === 'delivery' ? s.address ?? '' : undefined });
    const problems = q.problems;
    const lead = note ? `${note}\n` : '';
    const issues = problems.length ? `\n⚠️ ${problems.join(' ')}` : '';
    if (!s.fulfilment) {
      const both = cfg.pickupEnabled && cfg.deliveryEnabled;
      if (both) {
        s.step = 'ask_fulfilment';
        return { reply: `${lead}${this.cartText(q, st)}${issues}\n\n${t(st, 'Anything else? When done, reply PICKUP or DELIVERY.', 'Vera edhavadhu venuma? Mudinjadhum PICKUP illa DELIVERY nu reply pannunga.')}`, state: s, intent: 'cart_updated' };
      }
      s.fulfilment = cfg.deliveryEnabled ? 'delivery' : 'pickup';
    }
    s.step = 'browsing';
    return { reply: `${lead}${this.cartText(q, st)}${issues}\n\n${t(st, 'Anything else? Reply CONFIRM to review and place the order.', 'Vera edhavadhu? Order place panna CONFIRM nu reply pannunga.')}`, state: s, intent: 'cart_updated' };
  }

  private async toConfirm(ctx: AgentCtx, s: FoodState): Promise<AgentOut<FoodState>> {
    const st = ctx.style;
    if (!s.cart.length) {
      s.step = 'browsing';
      return { reply: t(st, 'Your cart is empty. What would you like to order?', 'Cart empty. Enna order pannalam?'), state: s, intent: 'cart_empty' };
    }
    if (s.fulfilment === 'delivery' && !s.address) {
      s.step = 'ask_address';
      return { reply: t(st, 'Please share the delivery address with the area name.', 'Delivery address area name-oda anuppunga.'), state: s, intent: 'ask_address' };
    }
    const q = await this.food.quote(ctx.org, { lines: s.cart, fulfilment: s.fulfilment ?? 'pickup', address: s.fulfilment === 'delivery' ? s.address ?? '' : undefined });
    if (!q.ok) {
      s.step = 'browsing';
      return { reply: `${this.cartText(q, st)}\n⚠️ ${q.problems.join(' ')}`, state: s, intent: 'quote_problem' };
    }
    s.step = 'confirm';
    const how = q.fulfilment === 'delivery' ? `${t(st, 'Delivery to', 'Delivery to')} ${s.address} (${q.zone?.name}, ~${q.readyInMinutes} min)` : `${t(st, 'Pickup at', 'Pickup at')} ${q.outlet?.name} (${t(st, 'ready in', 'ready aagum')} ~${q.readyInMinutes} min)`;
    return { reply: `${t(st, 'Please confirm your order:', 'Order confirm pannunga:')}\n${this.cartText(q, st)}\n${how}\n${t(st, 'Payment', 'Payment')}: ${q.fulfilment === 'delivery' ? t(st, 'pay on delivery', 'delivery-la pay') : t(st, 'pay at the counter', 'counter-la pay')}\n\n${t(st, 'Reply YES to place the order.', 'Order place panna YES nu reply pannunga.')}`, state: s, intent: 'confirm_order' };
  }

  private async place(ctx: AgentCtx, s: FoodState): Promise<AgentOut<FoodState>> {
    const st = ctx.style;
    const cartHash = createHash('sha256').update(JSON.stringify({ c: s.cart.map(keyOf).sort(), q: s.cart.map((l) => l.quantity), f: s.fulfilment, a: s.address ?? '' })).digest('hex').slice(0, 16);
    try {
      const r = await this.food.placeOrder(ctx.org, {
        customerId: ctx.customer.id, conversationId: ctx.conversationId, channel: ctx.channel === 'web' ? 'test' : ctx.channel, lines: s.cart, fulfilment: s.fulfilment ?? 'pickup',
        address: s.address ?? null, idempotencyKey: `chat:${ctx.conversationId}:${cartHash}`, customerName: ctx.customer.name, customerPhone: ctx.customer.phone, actor: 'ai', isDemo: ctx.isDemo || ctx.customer.isDemo,
      });
      const o = r.order;
      if (r.status === 'created') await this.followUps.onFoodOrder(ctx.org, { id: o.id, customerId: ctx.customer.id, channel: o.channel, status: o.status });
      resetState(s, newFoodState(), { lastOrderId: o.id });
      const when = o.fulfilment === 'delivery' ? t(st, 'Expected delivery around', 'Delivery around') : t(st, 'Ready for pickup around', 'Pickup ready around');
      return {
        reply: `✅ ${t(st, 'Order placed!', 'Order place aagiduchu!')} *${o.orderNumber}*\n${t(st, 'Total', 'Total')} ${inr(o.total)} · ${when} ${prettyTime(new Date(o.readyBy))}.\n${t(st, 'The kitchen will confirm it shortly. Ask "status" anytime.', 'Kitchen seekiram confirm pannuvaanga. Eppo venaalum "status" nu kelunga.')}`,
        state: s, intent: 'order_placed', outcome: 'order_placed', record: { type: 'order', id: o.id, reference: o.orderNumber, status: o.status, result: r.status },
      };
    } catch (e) {
      s.step = 'browsing';
      return { reply: `${t(st, 'I could not place the order:', 'Order place panna mudiyala:')} ${e instanceof Error ? e.message : String(e)}`, state: s, intent: 'order_failed' };
    }
  }
}
