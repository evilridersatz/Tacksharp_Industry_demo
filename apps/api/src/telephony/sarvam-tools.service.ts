import { Injectable, Optional } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { CatalogService, type Catalog } from '../restaurant/catalog.service.js';
import { OrdersService, type CartLine } from '../restaurant/orders.service.js';
import { OrderFollowUpService } from '../restaurant/order-followup.service.js';
import { formatQty, parseItems, parsePickup, pickOutlet } from '../restaurant/chicken-parse.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';
import { webhookSecret } from './webhook-token.js';

/**
 * Tools the Sarvam-hosted voice agent calls DURING a call (Sarvam "API tool": agent variables in the request body,
 * response fields saved back into agent variables). They make the agent's answers come from this organization's live
 * database instead of model knowledge:
 *   context  (on-start hook) caller's name, shop hours, shops, the current menu with prices
 *   menu     current menu: available items with price per unit, and what is not available today
 *   item     one product: exists? price? available? cuts?   unknown product -> "not on our menu" (never invented)
 *   quote    the customer's order in their own words (Tamil / Tanglish / English) -> priced by the authoritative
 *            order service (stock, minimums, cuts, shop hours) -> a signed cart the agent reads back
 *   order    places the confirmed signed cart exactly once (idempotent per call), returns the order number, and
 *            schedules the WhatsApp confirmation through the existing follow-up machinery (consent + 24 h rules)
 *   status   latest order of the caller
 *   handoff  asks staff to call the customer back (a task on the dashboard)
 *
 * Authentication: header `x-tacksharp-tool-key` = HMAC(TELEPHONY_WEBHOOK_SECRET, "tools|<organizationId>") and the
 * organization in `x-tacksharp-org` (or ?org=). Without the secret every tool refuses (fail closed). Every query is
 * scoped to that organization.
 */
export type ToolResult = Record<string, string | number | boolean | null | Array<Record<string, unknown>>>;

export function toolKey(organizationId: string, secret = webhookSecret()): string | null {
  if (!secret) return null;
  return createHmac('sha256', secret).update(`tools|${organizationId}`).digest('hex');
}

export function verifyToolKey(organizationId: string, key: unknown, secret = webhookSecret()): boolean {
  const expected = toolKey(organizationId, secret);
  if (!expected || typeof key !== 'string' || key.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(key), Buffer.from(expected));
}

type CartPayload = { o: string; l: CartLine[]; out: string; p: string; t: number; x: number };
const CART_TTL_MS = 30 * 60_000;
const b64 = (s: string) => Buffer.from(s).toString('base64url');

function signCart(payload: CartPayload, secret: string): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(`cart|${body}`).digest('base64url');
  return `${body}.${mac}`;
}
function readCart(token: string, secret: string): CartPayload | null {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(`cart|${body}`).digest('base64url');
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CartPayload;
    return p.x > Date.now() ? p : null;
  } catch {
    return null;
  }
}

const rupees = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;
const per = (unit: string) => (unit === 'piece' ? 'per piece' : 'per kg');
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');

@Injectable()
export class SarvamToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly orders: OrdersService,
    private readonly conversations: ConversationsService,
    @Optional() private readonly followUps?: OrderFollowUpService,
  ) {}

  private async org(organizationId: string) {
    return this.prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true, vertical: true, status: true } });
  }

  private menuLines(c: Catalog) {
    // `available` = staff switched it on AND enough stock: the single field every channel reads.
    const available = c.items.filter((i) => i.available);
    const unavailable = c.items.filter((i) => !i.available);
    const line = (i: Catalog['items'][number]) => `${i.name}: ${rupees(i.price)} ${per(i.unit)}${i.cutOptions.length ? ` (cuts: ${i.cutOptions.join(', ')})` : ''}`;
    return {
      available,
      unavailable,
      text: available.length ? available.map(line).join('; ') : 'No products are available right now.',
      unavailableText: unavailable.length ? unavailable.map((i) => i.name).join(', ') : 'none',
    };
  }

  private shopsText(c: Catalog) {
    const open = c.outlets.filter((o) => o.active);
    return open.length ? open.map((o, i) => `${i + 1}. ${o.name}${o.area ? ` (${o.area})` : ''}: open ${o.opensAt} to ${o.closesAt}, ${o.prepMinutes} minutes to prepare`).join('; ') : 'No shop is taking orders right now.';
  }

  /** On-start hook: who is calling and what the business offers right now. */
  async context(organizationId: string, body: Record<string, unknown>): Promise<ToolResult> {
    const org = await this.org(organizationId);
    if (!org) return { ok: false, error: 'unknown_organization' };
    const phone = normalizePhone(str(body.caller_phone ?? body.user_phone_number ?? body.phone));
    const customer = phone ? await this.prisma.customer.findFirst({ where: { organizationId, phone }, select: { name: true, language: true } }) : null;
    const c = await this.catalog.get(organizationId, true);
    const m = this.menuLines(c);
    return {
      ok: true,
      business_name: org.name,
      customer_name: customer?.name ?? '',
      customer_language: customer?.language === 'english' ? 'English' : customer?.language ? 'Tamil' : '',
      menu_text: m.text,
      unavailable_today: m.unavailableText,
      shops_text: this.shopsText(c),
      delivery: 'Pickup from the shop only. Home delivery is not offered.',
      language_rule: 'Speak only Tamil or English. Never Hindi. Tamil written in English letters (Tanglish) means the caller speaks Tamil.',
    };
  }

  async menu(organizationId: string): Promise<ToolResult> {
    const c = await this.catalog.get(organizationId, true);
    const m = this.menuLines(c);
    return {
      ok: true,
      menu_text: m.text,
      unavailable_today: m.unavailableText,
      items: m.available.map((i) => ({ name: i.name, price: i.price, unit: i.unit, cuts: i.cutOptions.join(', ') })),
      shops_text: this.shopsText(c),
    };
  }

  /** One product, by what the caller said ("broiler", "naatu kozhi", "நாட்டுக்கோழி"). Unknown -> not on the menu. */
  async item(organizationId: string, body: Record<string, unknown>): Promise<ToolResult> {
    const said = str(body.item_name ?? body.item ?? body.query, 200);
    if (!said) return { ok: false, found: false, message: 'Ask which product the caller wants.' };
    const c = await this.catalog.get(organizationId, true);
    const { items } = parseItems(said, this.catalog.products(c));
    const hit = items[0] ? c.items.find((i) => i.id === items[0].itemId) : undefined;
    if (!hit) {
      return { ok: true, found: false, message: `"${said}" is not on our menu. Available: ${this.menuLines(c).text}` };
    }
    return {
      ok: true,
      found: true,
      name: hit.name,
      price: hit.price,
      unit: hit.unit,
      price_text: `${hit.name} is ${rupees(hit.price)} ${per(hit.unit)}.`,
      available: hit.available,
      availability_text: hit.available ? `${hit.name} is available today.` : `${hit.name} is not available today.`,
      cuts: hit.cutOptions.join(', '),
    };
  }

  /**
   * Price the caller's order with the authoritative order service. Nothing is saved. Returns a signed cart (valid 30
   * minutes) that `order` accepts unchanged, so the price the caller confirmed is the price that is charged.
   */
  async quote(organizationId: string, body: Record<string, unknown>, now = new Date()): Promise<ToolResult> {
    const secret = webhookSecret();
    if (!secret) return { ok: false, error: 'not_configured' };
    const said = str(body.items_text ?? body.items ?? body.order_text, 600);
    if (!said) return { ok: false, needs: 'items', message: 'Ask what the caller wants to order and how much.' };
    const c = await this.catalog.get(organizationId, true);
    const { items, loose } = parseItems(said, this.catalog.products(c));
    if (!items.length) return { ok: false, needs: 'items', message: `I could not find those products on our menu. Available: ${this.menuLines(c).text}` };
    const lines: CartLine[] = [];
    const questions: string[] = [];
    for (const it of items) {
      const p = c.items.find((i) => i.id === it.itemId)!;
      const quantity = it.quantity ?? (items.length === 1 ? loose.quantity : undefined);
      const cut = it.cut ?? (items.length === 1 && loose.cut && p.cutOptions.includes(loose.cut) ? loose.cut : undefined);
      if (quantity === undefined) questions.push(`How much ${p.name} (${p.unit === 'piece' ? 'pieces' : 'kg'})?`);
      if (p.cutOptions.length && !cut) questions.push(`Which cut for ${p.name}: ${p.cutOptions.join(', ')}?`);
      lines.push({ itemId: p.id, quantity: quantity ?? 0, ...(cut ? { cut } : {}) });
    }
    const open = c.outlets.filter((o) => o.active);
    const outlet = open.length === 1 ? open[0] : pickOutlet(str(body.shop ?? body.outlet, 120), open);
    if (!outlet) questions.push(open.length ? `Which shop: ${open.map((o) => o.name).join(' or ')}?` : 'No shop is taking orders right now.');
    let pickupAt: Date | undefined;
    const when = str(body.pickup_time ?? body.pickup, 120);
    if (outlet) {
      if (!when) questions.push('When will the caller pick it up?');
      else {
        const r = parsePickup(when, now, outlet);
        if (r.kind === 'at') pickupAt = r.at;
        else questions.push('Please confirm the pickup time (for example "6 PM today" or "in 1 hour").');
      }
    }
    if (questions.length) return { ok: false, needs: 'details', questions_text: questions.join(' ') };

    const q = await this.orders.quote({ organizationId, lines, outletId: outlet!.id, pickupAt, now });
    if (!q.ok) return { ok: false, needs: 'changes', problems_text: q.problems.join(' ') };
    const summary = q.lines.map((l) => `${formatQty(l.quantity, l.unit)} ${l.name}${l.cut ? ` ${l.cut}` : ''} = ${rupees(l.lineTotal)}`).join('; ');
    const pickupText = pickupAt!.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const cart = signCart({ o: organizationId, l: lines, out: outlet!.id, p: pickupAt!.toISOString(), t: q.total, x: Date.now() + CART_TTL_MS }, secret);
    return {
      ok: true,
      summary_text: `${summary}. Total ${rupees(q.total)}. Pickup at ${outlet!.name}, ${pickupText}. Payment at the shop.`,
      total: q.total,
      cart_token: cart,
      confirm_question: 'Read the summary and the total to the caller and ask them to confirm before placing the order.',
    };
  }

  /** Place the confirmed cart once. Never says "confirmed" unless the order row exists. */
  async order(organizationId: string, body: Record<string, unknown>): Promise<ToolResult> {
    const secret = webhookSecret();
    if (!secret) return { ok: false, error: 'not_configured' };
    const cart = readCart(str(body.cart_token, 4000), secret);
    if (!cart || cart.o !== organizationId) return { ok: false, error: 'cart_invalid', message: 'The order summary expired or is not valid. Price the order again before placing it.' };
    if (!/^(yes|y|true|confirmed|ok|aam|aama|sari|seri|ஆம்|சரி)$/i.test(str(body.confirmed, 20))) return { ok: false, error: 'not_confirmed', message: 'Ask the caller to confirm the order first.' };
    const phone = normalizePhone(str(body.caller_phone ?? body.user_phone_number ?? body.phone, 30));
    if (!phone) return { ok: false, error: 'no_phone', message: 'The caller phone number is needed to place the order.' };
    const callRef = str(body.call_id ?? body.attempt_id ?? body.interaction_id, 120) || cart.p;
    const idempotencyKey = `sarvam:${createHmac('sha256', secret).update(`${callRef}|${body.cart_token}`).digest('hex').slice(0, 40)}`;
    try {
      const customer = await this.conversations.getOrCreateCustomerByPhone(organizationId, phone, { source: 'voice_inbound', name: str(body.customer_name, 80) || undefined });
      const r = await this.orders.createOrder({
        organizationId, idempotencyKey, customerId: customer.id, channel: 'voice', lines: cart.l, outletId: cart.out, pickupAt: new Date(cart.p),
        paymentMethod: 'cash_at_shop', customerPhone: phone, customerName: str(body.customer_name, 80) || undefined, language: str(body.language, 20) || undefined, expectedTotal: cart.t,
      });
      if (r.status === 'rejected') return { ok: false, error: 'rejected', message: `The order could not be placed: ${r.problems.join(' ')}` };
      // The caller agreed on the call to receive the confirmation on WhatsApp: recorded as messaging consent.
      const wantsWhatsApp = /^(yes|y|true|aam|aama|sari|seri|ஆம்|சரி)$/i.test(str(body.send_whatsapp, 20));
      if (wantsWhatsApp && r.status === 'created') {
        await this.prisma.customer.updateMany({ where: { id: customer.id, organizationId, optedOutAt: null }, data: { messagingConsent: true } });
        await this.followUps?.onOrderCreated(organizationId, r.order.id, 'voice').catch((e) => log.warn('sarvam_tools.followup_failed', { error: errorMessage(e) }));
      }
      log.info('sarvam_tools.order', { organizationId, orderId: r.order.id, status: r.status });
      return {
        ok: true,
        order_number: r.order.orderNumber,
        total: r.order.total,
        message: `Order ${r.order.orderNumber} is placed. Total ${rupees(r.order.total)}, pay at the shop.${wantsWhatsApp ? ' A WhatsApp confirmation will follow.' : ''}`,
        duplicate: r.status === 'duplicate',
      };
    } catch (e) {
      log.error('sarvam_tools.order_failed', { organizationId, error: errorMessage(e) });
      return { ok: false, error: 'failed', message: 'The order could not be saved. Do not confirm it; offer a staff callback.' };
    }
  }

  async status(organizationId: string, body: Record<string, unknown>): Promise<ToolResult> {
    const phone = normalizePhone(str(body.caller_phone ?? body.user_phone_number ?? body.phone, 30));
    const num = str(body.order_number, 40).toUpperCase();
    const customer = phone ? await this.prisma.customer.findFirst({ where: { organizationId, phone }, select: { id: true } }) : null;
    // Only the caller's own orders: an order number alone (said by anyone) never reveals an order.
    if (!customer) return { ok: true, found: false, message: 'No order found for this caller.' };
    const order = await this.prisma.order.findFirst({
      where: { organizationId, customerId: customer.id, ...(num ? { orderNumber: num } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { orderNumber: true, status: true, total: true, pickupAt: true },
    });
    if (!order) return { ok: true, found: false, message: 'No order found for this caller.' };
    return { ok: true, found: true, order_number: order.orderNumber, status: order.status, message: `Order ${order.orderNumber} is ${order.status}.` };
  }

  async handoff(organizationId: string, body: Record<string, unknown>): Promise<ToolResult> {
    const phone = normalizePhone(str(body.caller_phone ?? body.user_phone_number ?? body.phone, 30));
    if (!phone) return { ok: false, error: 'no_phone' };
    const customer = await this.conversations.getOrCreateCustomerByPhone(organizationId, phone, { source: 'voice_inbound' });
    const reason = str(body.reason, 300) || 'Caller asked for a person.';
    const day = new Date().toISOString().slice(0, 10);
    await this.prisma.workTask.upsert({
      where: { dedupeKey: `voice_handoff:${organizationId}:${customer.id}:${day}` },
      update: { detail: `Voice agent handoff: ${reason}`, status: 'open' },
      create: {
        organizationId, agent: 'voice', kind: 'exception', priority: 'high', status: 'open', createdBy: 'agent:voice',
        title: `Call back ${customer.name ?? `+${phone}`}`.slice(0, 300), detail: `Voice agent handoff: ${reason}`,
        entityType: 'customer', entityId: customer.id, dedupeKey: `voice_handoff:${organizationId}:${customer.id}:${day}`,
      },
    });
    await this.prisma.auditEvent.create({ data: { organizationId, actor: 'voice_agent', entityType: 'customer', entityId: customer.id, action: 'voice.handoff_requested', data: { reason } } });
    return { ok: true, message: 'A staff member will call the customer back.' };
  }
}

/** The language policy for every Tamil Nadu voice agent: Tamil and English only, Tanglish understood as Tamil. */
export const VOICE_LANGUAGE_POLICY = {
  startingLanguage: 'Tamil (ta-IN)',
  allowedLanguages: ['Tamil (ta-IN)', 'English (en-IN)'],
  neverAllowed: ['Hindi (hi-IN)', 'every other language'],
  autoDetect: 'On: switch to English only when the caller speaks English for a full sentence.',
  rule: 'Speak only Tamil or English. Never speak Hindi, even if the caller says a Hindi word or the speech recogniser guesses Hindi. Tanglish (Tamil in English letters, mixed with English words) means the caller speaks Tamil: answer in simple spoken Tamil with common English food words (kg, curry cut, pickup). If unsure, use Tamil.',
} as const;

/**
 * Everything an operator pastes into the Sarvam console for one organization's voice agent: language settings,
 * instructions that force every fact through our tools, the API tools (URL, headers, body with Sarvam @variables,
 * fields to save) and the on-start hook. Sarvam exposes these settings only in its console (no documented API),
 * so this pack is the source of truth and the console must match it.
 */
export function sarvamConfigPack(input: { organizationId: string; businessName: string; baseUrl: string; revealKey: boolean; webhookUrl: string | null }) {
  const key = toolKey(input.organizationId);
  const headers = {
    'x-tacksharp-org': input.organizationId,
    'x-tacksharp-tool-key': key ? (input.revealKey ? key : `${key.slice(0, 6)}…(hidden; reveal to copy)`) : 'NOT CONFIGURED: set TELEPHONY_WEBHOOK_SECRET on the server first',
    'content-type': 'application/json',
  };
  const url = (t: string) => `${input.baseUrl}/telephony/sarvam/tools/${t}`;
  const PHONE = '<the caller phone number variable of your Sarvam workspace>';
  const instructions = [
    `You are the phone assistant of ${input.businessName}, a fresh chicken shop in Tamil Nadu. Customers call to ask prices, check what is available and order for pickup.`,
    VOICE_LANGUAGE_POLICY.rule,
    'Facts come ONLY from the tools. At the start you receive menu_text, unavailable_today and shops_text: use them. For any price or availability question call get_item. Never say a price, product, discount, offer, delivery or availability that a tool did not return. If a product is not on the menu, say so and offer what is available.',
    'Orders: collect the products, quantity (kg or pieces), cut, shop (if more than one) and pickup time, then call quote_order. If it returns questions_text or problems_text, ask exactly that. If it returns summary_text, read it with the total and ask the caller to confirm. Only after a clear yes, ask if they want the confirmation on WhatsApp, then call place_order with confirmed=yes. Say the order is placed ONLY when place_order returns an order_number; read the order number.',
    'Pickup only, payment at the shop. No home delivery. Never take card or UPI details on the call.',
    'For order status call order_status. If the caller is upset, asks for a person, or wants something the tools cannot do (bulk, catering, complaints), call request_callback and tell them staff will call back.',
    'Keep answers short: one or two sentences, spoken naturally. Say prices as "220 rupees per kilo".',
  ].join('\n\n');
  const tool = (name: string, description: string, path: string, body: Record<string, string>, save: string[]) => ({ name, description, method: 'POST', url: url(path), headers, body, saveReplyIntoVariables: save });
  return {
    language: VOICE_LANGUAGE_POLICY,
    instructions,
    onStartHook: { method: 'POST', url: url('context'), headers, body: { caller_phone: `@${PHONE}` }, saveReplyIntoVariables: ['business_name', 'customer_name', 'menu_text', 'unavailable_today', 'shops_text', 'delivery', 'language_rule'] },
    tools: [
      tool('get_menu', 'Current menu with prices and what is not available today.', 'menu', {}, ['menu_text', 'unavailable_today', 'shops_text']),
      tool('get_item', 'Price and availability of one product the caller named.', 'item', { item_name: '@item_name' }, ['found', 'price_text', 'availability_text', 'cuts', 'message']),
      tool('quote_order', 'Price the order. Nothing is saved.', 'quote', { items_text: '@items_text', shop: '@shop', pickup_time: '@pickup_time' }, ['ok', 'summary_text', 'total', 'cart_token', 'questions_text', 'problems_text', 'message']),
      tool('place_order', 'Place the confirmed order (only after the caller said yes).', 'order', { cart_token: '@cart_token', confirmed: '@confirmed', send_whatsapp: '@send_whatsapp', caller_phone: `@${PHONE}`, customer_name: '@customer_name' }, ['ok', 'order_number', 'message']),
      tool('order_status', 'Status of the caller’s latest order.', 'status', { caller_phone: `@${PHONE}`, order_number: '@order_number' }, ['found', 'message']),
      tool('request_callback', 'Ask staff to call the customer back.', 'handoff', { caller_phone: `@${PHONE}`, reason: '@reason' }, ['message']),
    ],
    postCallWebhook: input.webhookUrl,
    notes: [
      'Sarvam documents API tools with @variables and on-start hooks, but not their exact console field names for every option: match each item above to the console field with the same meaning.',
      'Sarvam does not document the variable that holds the caller number; choose it from the variable list in the console.',
      'Remove Hindi from "Languages allowed" and set the starting language to Tamil. This is a Sarvam console setting: our server cannot change it.',
    ],
  };
}
