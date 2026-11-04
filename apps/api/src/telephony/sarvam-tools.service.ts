import { Injectable, Optional } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { CatalogService, type Catalog } from '../restaurant/catalog.service.js';
import { OrdersService, type CartLine } from '../restaurant/orders.service.js';
import { OrderFollowUpService } from '../restaurant/order-followup.service.js';
import { formatQty, parseItems, parsePickup, pickOutlet, orderableOutlets } from '../restaurant/chicken-parse.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';
import { webhookSecret } from './webhook-token.js';
import { publishLive } from '../common/live-events.js';

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

/**
 * Where quoted carts are kept for `order`. The voice agent's language model has to copy the cart reference from
 * quote_order into place_order; a long signed token is easily mangled on the way (live 2026-11-04: place_order
 * answered, nothing was saved). So quote_order returns a SHORT code, the signed cart stays here (Redis, with a
 * memory fallback), and the caller's last quote is kept by phone number as a further fallback.
 */
export type CartStore = { set(key: string, value: string, ttlMs: number): Promise<void>; get(key: string): Promise<string | null> };
export function memoryCartStore(): CartStore {
  const m = new Map<string, { v: string; exp: number }>();
  return {
    async set(k, v, ttl) { m.set(k, { v, exp: Date.now() + ttl }); if (m.size > 5000) m.delete(m.keys().next().value!); },
    async get(k) { const e = m.get(k); return e && e.exp > Date.now() ? e.v : null; },
  };
}
/** Redis first (shared by every API process), memory as a fallback; a Redis hiccup never blocks a live call. */
export function redisCartStore(): CartStore {
  const mem = memoryCartStore();
  const redis = async () => (await import('../queues/queues.js')).queueRedis;
  const quick = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error('redis timeout')), 800))]);
  return {
    async set(k, v, ttl) { await mem.set(k, v, ttl); try { await quick((await redis()).set(k, v, 'PX', ttl)); } catch { /* memory copy kept */ } },
    async get(k) { try { const v = await quick((await redis()).get(k)); if (v) return v; } catch { /* fall back */ } return mem.get(k); },
  };
}
/** One store for the whole process: the dashboard binds a live call to its customer number here too. */
let shared: CartStore | null = null;
export const sharedCartStore = () => (shared ??= redisCartStore());
export const callPhoneKey = (org: string, interactionId: string) => `sarvam:callphone:${org}:${interactionId}`;
const callCartKey = (org: string, interactionId: string) => `sarvam:callcart:${org}:${interactionId}`;
/** Live dashboard calls of an organization ([{ iid, phone, at }]) and each call's caller turns, pushed by the browser. */
export const activeCallsKey = (org: string) => `sarvam:active:${org}`;
export const callLinesKey = (org: string, interactionId: string) => `sarvam:calllines:${org}:${interactionId}`;
export type ActiveCall = { iid: string; phone: string; at: number };
/** A dashboard call counts as live while the browser keeps pushing its words (each push refreshes it). */
export const ACTIVE_CALL_MS = 3 * 60_000;
export async function readActiveCalls(store: CartStore, org: string): Promise<ActiveCall[]> {
  try {
    const list = JSON.parse((await store.get(activeCallsKey(org))) ?? '[]') as ActiveCall[];
    return Array.isArray(list) ? list.filter((c) => c && c.iid && Date.now() - c.at < ACTIVE_CALL_MS) : [];
  } catch { return []; }
}
const CART_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const cartCode = () => Array.from({ length: 6 }, () => CART_CODE_CHARS[Math.floor(Math.random() * CART_CODE_CHARS.length)]).join('');
const cartKey = (org: string, code: string) => `sarvam:cart:${org}:${code}`;
const lastCartKey = (org: string, phone: string) => `sarvam:lastcart:${org}:${phone}`;
/** The agent's accounts of one phone call, in order (see heard). */
const accountsKey = (org: string, id: string) => `sarvam:accounts:${org}:${id}`;
/**
 * Carts being built on a Sarvam call right now (phone call or the dashboard assistant's voice / video call), for the
 * dashboard's live view: the priced summary from quote_order, removed when the order is placed, gone after 30 min.
 */
const liveCartsKey = (org: string) => `sarvam:livecarts:${org}`;
export type LiveCallCart = {
  key: string;
  channel: 'voice' | 'assistant';
  phone: string;
  customerName: string | null;
  lines: Array<{ name: string; unit: string; quantity: number; cut: string | null; lineTotal: number }>;
  total: number;
  pickupAt: string | null;
  updatedAt: string;
};
export async function readLiveCallCarts(store: CartStore, org: string): Promise<LiveCallCart[]> {
  try {
    const list = JSON.parse((await store.get(liveCartsKey(org))) ?? '[]') as LiveCallCart[];
    return list.filter((c) => Date.now() - new Date(c.updatedAt).getTime() < CART_TTL_MS);
  } catch { return []; }
}
async function writeLiveCallCart(store: CartStore, org: string, key: string, cart: LiveCallCart | null) {
  const rest = (await readLiveCallCarts(store, org)).filter((c) => c.key !== key);
  await store.set(liveCartsKey(org), JSON.stringify(cart ? [cart, ...rest].slice(0, 50) : rest), CART_TTL_MS);
}

/** A clear yes from the caller, as the agent passes it (English, Tanglish, Tamil, or a boolean). */
export function saidYes(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return false;
  if (/\b(no|nope|not|don'?t|cancel|illa|illai|vendam|vendaam|venam)\b|இல்ல|வேண்டாம்|வேணாம்/.test(s)) return false;
  return /^(true|1)$/.test(s) || /\b(yes|yeah|yep|y|ok|okay|confirm|confirmed|sure|done|correct|place|aam|aama|aamaa|ama|amaa|sari|seri|sariya|seriya|haan|ha|podunga|podu)\b|ஆம்|ஆமா|சரி|போடுங்க/.test(s);
}
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
/**
 * A body value as text. A value the Sarvam console did not fill in arrives as its placeholder ("@confirmed",
 * "{{cart_token}}", "<the caller phone ...>": seen live 2026-11-04): that is treated as missing, never as data.
 */
export const isPlaceholder = (s: string) => /^@\S/.test(s) || /^\{\{.*\}\}$/.test(s) || /^<.*>$/.test(s);
const str = (v: unknown, max = 500) => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  return isPlaceholder(s) ? '' : s.slice(0, max);
};

/** Body fields that are never the caller's order words (ids, numbers, flags, transcript, other tools' answers). */
const NOT_ORDER_WORDS = new Set(['interaction_id', 'call_id', 'attempt_id', 'caller_phone', 'user_phone_number', 'user_identifier', 'phone', 'transcript', 'call_transcript', 'cart_token', 'confirmed', 'send_whatsapp', 'customer_name', 'language', 'key', 'tool_key', 'call_length', 'pickup_time', 'pickup', 'shop', 'outlet', 'order_number', 'reason']);
/**
 * The order / product words the agent passed, whatever the tool's fields are called in the Sarvam console
 * ("items", "product", "products": [{ "name": .., "quantity": .. }], ...): every other text or number in the body,
 * in order, placeholders skipped.
 */
export function bodyWords(body: Record<string, unknown>, max = 600): string {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || out.join(' ').length > max) return;
    if (typeof v === 'string') { const t = v.trim(); if (t && !isPlaceholder(t)) out.push(t); }
    else if (typeof v === 'number') out.push(String(v));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (depth > 0 || !NOT_ORDER_WORDS.has(k)) walk(x, depth + 1);
  };
  walk(body, 0);
  return out.join(' ').slice(0, max);
}
/** Field names only (never values): shows in the log what shape the Sarvam console sends. */
const bodyKeys = (body: Record<string, unknown>) => Object.keys(body).filter((k) => k !== 'key' && k !== 'tool_key').slice(0, 15).join(',');

/**
 * What the CALLER said, newest last, from Sarvam's built-in "Call Transcript" variable (a string with "user:" /
 * "agent:" style lines, or a list of { role, content }). The order is then read by OUR parser from the caller's own
 * words, so the tools work even when the agent passes no arguments of its own.
 */
export function callerLines(body: Record<string, unknown>): string[] {
  const raw = body.transcript ?? body.call_transcript ?? body.conversation ?? body.messages;
  const turns = transcriptTurns(raw);
  if (turns.length) return turns.filter((t) => t.who === 'user').map((t) => t.text);
  // No speaker labels at all: on phone calls Sarvam fills this field with the agent's own one-line account of the
  // order ("Customer wants 1 kg broiler curry cut at 6 pm. Phone 98..."). That sentence IS the order: it is read as
  // the caller's words (phone numbers removed so they are never taken as a quantity).
  const summary = agentSummary(body);
  return summary ? [summary] : [];
}

/** The unlabelled one-sentence order account Sarvam passes as the transcript on phone calls ('' when not that). */
export function agentSummary(body: Record<string, unknown>): string {
  const raw = body.transcript ?? body.call_transcript;
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s || isPlaceholder(s) || /^[[{]/.test(s) || transcriptTurns(s).length) return '';
  return s.replace(/\+?\d[\d\s-]{8,}\d/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

/**
 * The layout of a transcript we could not read, never its words: letters become "a", digits "0", so the log shows
 * the format ("[00:00] Aaaa: aaaa\\n...") and nothing the caller said.
 */
export function transcriptShape(t: unknown): { type: string; length: number; shape: string } {
  const raw = typeof t === 'string' ? t : t === undefined ? '' : JSON.stringify(t);
  const shape = raw.slice(0, 160).replace(/\p{L}/gu, 'a').replace(/\p{M}/gu, '').replace(/\d/g, '0').replace(/a{3,}/g, 'aaa').replace(/\n/g, '\\n');
  return { type: Array.isArray(t) ? 'array' : typeof t, length: raw.length, shape };
}

const USER_ROLE = /^(user|customer|caller|human|client|you|speaker[ _-]?1)$/i;
const AGENT_ROLE = /^(agent|assistant|bot|ai|system|model|speaker[ _-]?0)$/i;
const ROLE_WORD = '(user|customer|caller|human|client|agent|assistant|bot|ai)';

/**
 * Every turn of a call transcript, whatever shape Sarvam's "Call Transcript" variable has: an array of
 * { role, content } (or speaker / text ...), the same as a JSON string, an object holding such an array, or text with
 * "User: ..." / "[00:12] user: ..." / "<user> ..." lines, or all turns on one line ("user: .. agent: .. user: ..").
 */
export function transcriptTurns(t: unknown, depth = 0): Array<{ who: 'user' | 'agent'; text: string }> {
  if (depth > 3 || t === null || t === undefined) return [];
  const roleOf = (who: unknown): 'user' | 'agent' | null => {
    const w = String(who ?? '').trim().replace(/[^\w -]/g, '');
    return USER_ROLE.test(w) ? 'user' : AGENT_ROLE.test(w) ? 'agent' : null;
  };
  if (Array.isArray(t)) {
    const out: Array<{ who: 'user' | 'agent'; text: string }> = [];
    for (const x of t) {
      if (typeof x === 'string') { out.push(...transcriptTurns(x, depth + 1)); continue; }
      const o = (x ?? {}) as Record<string, unknown>;
      const who = roleOf(o.role ?? o.speaker ?? o.from ?? o.sender ?? o.type ?? o.author);
      const raw = o.content ?? o.text ?? o.message ?? o.transcript ?? o.utterance;
      const text = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((r) => (typeof r === 'string' ? r : String((r as { text?: unknown })?.text ?? ''))).join(' ') : '').trim();
      if (who && text) out.push({ who, text });
    }
    return out;
  }
  if (typeof t === 'object') {
    const o = t as Record<string, unknown>;
    return transcriptTurns(o.messages ?? o.transcript ?? o.turns ?? o.conversation ?? o.items ?? o.data, depth + 1);
  }
  if (typeof t !== 'string') return [];
  const s = t.trim();
  if (!s || isPlaceholder(s)) return [];
  if (/^[[{]/.test(s)) {
    try { return transcriptTurns(JSON.parse(s), depth + 1); } catch { /* not JSON: read as text */ }
  }
  // Text: split before every role label ("user:", "[user]", "<user>", "USER -"), on any line or within one line.
  const label = new RegExp(`(?:^|\\n|\\s)(?:\\[[^\\]]{0,20}\\]\\s*)?(?:\\d{1,2}:\\d{2}(?::\\d{2})?\\s*)?[\\[<(]?${ROLE_WORD}[\\]>)]?\\s*(?:\\([^)]{0,20}\\))?\\s*[:>\\-–]\\s*`, 'gi');
  const marks = [...s.matchAll(label)];
  const out: Array<{ who: 'user' | 'agent'; text: string }> = [];
  marks.forEach((m, i) => {
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index ?? s.length : s.length;
    const who = roleOf(m[1]);
    const text = s.slice(from, to).trim();
    if (who && text) out.push({ who, text });
  });
  return out;
}

@Injectable()
export class SarvamToolsService {
  /** Quoted carts (see CartStore). Tests use the memory store. */
  carts: CartStore = sharedCartStore();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly orders: OrdersService,
    private readonly conversations: ConversationsService,
    @Optional() private readonly followUps?: OrderFollowUpService,
  ) {}

  /** The caller's number: the "User Identifier" Sarvam fills in, else the number the dashboard bound to this call. */
  /**
   * Which dashboard live call this request belongs to: the Interaction ID Sarvam passed, else the ONLY live dashboard
   * call of this organization right now (the browser registers it and pushes the caller's words). With two calls at
   * once nothing is guessed.
   */
  private async liveCall(organizationId: string, body: Record<string, unknown>): Promise<ActiveCall | undefined> {
    const active = await readActiveCalls(this.carts, organizationId);
    const id = str(body.interaction_id ?? body.call_id, 120);
    if (id) return active.find((c) => c.iid === id) ?? this.standIn(active, body) ?? { iid: id, phone: '', at: Date.now() };
    return active.length === 1 ? active[0] : undefined;
  }

  /**
   * A dashboard call whose Sarvam id the browser never received registers under a stand-in id ("web-..."). A tool
   * call with an unknown Sarvam id belongs to it only when it is the only such call and the request carries no caller
   * number of its own (a real phone call always has one), so a phone caller is never mixed up with it.
   */
  private standIn(active: ActiveCall[], body: Record<string, unknown>): ActiveCall | undefined {
    if (normalizePhone(str(body.caller_phone ?? body.user_phone_number ?? body.user_identifier ?? body.phone, 30))) return undefined;
    const waiting = active.filter((c) => c.iid.startsWith('web-'));
    return waiting.length === 1 ? waiting[0] : undefined;
  }

  /** True when this request comes from a call the dashboard assistant is running (not a real phone call). */
  private async fromDashboard(organizationId: string, body: Record<string, unknown>): Promise<boolean> {
    const active = await readActiveCalls(this.carts, organizationId);
    const id = str(body.interaction_id ?? body.call_id, 120);
    return id ? active.some((c) => c.iid === id) || Boolean(this.standIn(active, body)) : active.length === 1;
  }

  /** The caller's number: Sarvam's "User Identifier", else the number bound to this call by the dashboard. */
  private async callerPhone(organizationId: string, body: Record<string, unknown>): Promise<string | undefined> {
    const direct = normalizePhone(str(body.caller_phone ?? body.user_phone_number ?? body.user_identifier ?? body.phone, 30));
    if (direct) return direct;
    const call = await this.liveCall(organizationId, body);
    if (!call) return undefined;
    return normalizePhone(call.phone || ((await this.carts.get(callPhoneKey(organizationId, call.iid))) ?? '')) || undefined;
  }

  /** What the caller said: Sarvam's "Call Transcript" when it is passed, else the words the dashboard pushed. */
  private async heard(organizationId: string, body: Record<string, unknown>, until?: (lines: string[]) => boolean): Promise<string[]> {
    // Phone calls: each tool call carries the agent's own short account of what the caller just said ("broiler curry
    // cut", then "2 kg", then "pickup at 7 pm"). The accounts of one call are kept in order, so a later answer joins
    // the product it belongs to (the same way spoken turns do).
    const summary = agentSummary(body);
    if (summary) {
      const id = str(body.interaction_id ?? body.call_id, 120) || normalizePhone(str(body.caller_phone ?? body.user_identifier, 30)) || '';
      if (!id) return [summary];
      const key = accountsKey(organizationId, id);
      let list: string[] = [];
      try { list = JSON.parse((await this.carts.get(key)) ?? '[]') as string[]; } catch { list = []; }
      if (list[list.length - 1] !== summary) list.push(summary);
      list = list.slice(-12);
      await this.carts.set(key, JSON.stringify(list), CART_TTL_MS).catch(() => undefined);
      return list;
    }
    const fromBody = callerLines(body);
    if (fromBody.length) return fromBody;
    const call = await this.liveCall(organizationId, body);
    if (!call) return [];
    const read = async () => {
      try {
        const lines = JSON.parse((await this.carts.get(callLinesKey(organizationId, call.iid))) ?? '[]') as Array<{ role: string; content: string }>;
        return callerLines({ transcript: lines });
      } catch { return []; }
    };
    // The agent can ask a moment before the browser has pushed the caller's latest words: wait up to ~1.5 s for them.
    let lines = await read();
    for (let i = 0; until && !until(lines) && i < 3; i++) {
      await new Promise((r) => setTimeout(r, this.waitMs));
      lines = await read();
    }
    return lines;
  }

  /** Pause between re-reads of a live call's words (tests set 0). */
  waitMs = 500;

  /** The call reference for carts: Sarvam's Interaction ID, else the live dashboard call's. */
  private async callRef(organizationId: string, body: Record<string, unknown>): Promise<string> {
    return str(body.interaction_id ?? body.call_id, 120) || (await this.liveCall(organizationId, body))?.iid || '';
  }

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
    const open = orderableOutlets(c.outlets);
    return open.length ? open.map((o, i) => `${i + 1}. ${o.name}${o.area ? ` (${o.area})` : ''}: open ${o.opensAt} to ${o.closesAt}, ${o.prepMinutes} minutes to prepare`).join('; ') : 'No shop is taking orders right now.';
  }

  /** On-start hook: who is calling and what the business offers right now. */
  async context(organizationId: string, body: Record<string, unknown>): Promise<ToolResult> {
    const org = await this.org(organizationId);
    if (!org) return { ok: false, error: 'unknown_organization' };
    const phone = await this.callerPhone(organizationId, body);
    const customer = phone ? await this.prisma.customer.findFirst({ where: { organizationId, phone }, select: { name: true, language: true } }) : null;
    const c = await this.catalog.get(organizationId, true);
    const m = this.menuLines(c);
    publishLive(organizationId, { type: 'call.started', channel: (await this.fromDashboard(organizationId, body)) ? 'assistant' : 'voice', customer: customer?.name ?? undefined });
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
    const said = str(body.item_name ?? body.item ?? body.query, 200) || bodyWords(body, 200) || ((await this.heard(organizationId, body)).slice(-1)[0] ?? '').slice(0, 200);
    if (!said) {
      log.warn('sarvam_tools.item_no_words', { organizationId, bodyKeys: bodyKeys(body) });
      return { ok: false, found: false, message: 'Ask which product the caller wants.' };
    }
    const c = await this.catalog.get(organizationId, true);
    const { items } = parseItems(said, this.catalog.products(c));
    const hit = items[0] ? c.items.find((i) => i.id === items[0].itemId) : undefined;
    if (!hit) {
      log.warn('sarvam_tools.item_not_matched', { organizationId, asked: said.slice(0, 80), bodyKeys: bodyKeys(body) });
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
    // The order in the caller's words: what the agent passed, else the caller's own latest turns from the transcript.
    const c = await this.catalog.get(organizationId, true);
    // From the newest caller turn that names a product, plus the turns after it (quantity, cut, time answers).
    const products = this.catalog.products(c);
    const all = (await this.heard(organizationId, body, (ls) => ls.some((l) => parseItems(l, products).items.length > 0))).slice(-12);
    let from = -1;
    for (let i = all.length - 1; i >= 0 && from < 0; i--) if (parseItems(all[i], this.catalog.products(c)).items.length) from = i;
    const heard = from >= 0 ? all.slice(from) : all.slice(-3);
    const said = str(body.items_text ?? body.items ?? body.order_text, 600) || (from >= 0 ? heard.join('. ').slice(0, 600) : '') || bodyWords(body);
    if (!said) {
      // No customer words in the log line: only how many caller turns were available, to tell "no words" from "no product".
      log.info('sarvam_tools.transcript_shape', { organizationId, ...transcriptShape(body.transcript ?? body.call_transcript) });
      log.warn('sarvam_tools.quote_no_items', { organizationId, callerTurns: all.length, transcriptInBody: callerLines(body).length > 0, liveCall: Boolean(await this.liveCall(organizationId, body)), bodyKeys: bodyKeys(body) });
      return { ok: false, needs: 'items', message: 'Ask what the caller wants to order and how much.' };
    }
    const { items, loose } = parseItems(said, this.catalog.products(c));
    if (!items.length) {
      log.warn('sarvam_tools.quote_not_matched', { organizationId, asked: said.slice(0, 80), bodyKeys: bodyKeys(body) });
      return { ok: false, needs: 'items', message: `I could not find those products on our menu. Available: ${this.menuLines(c).text}` };
    }
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
    const open = orderableOutlets(c.outlets);
    const outlet = open.length === 1 ? open[0] : pickOutlet(str(body.shop ?? body.outlet, 120) || heard.join(' '), open);
    if (!outlet) questions.push(open.length ? `Which shop: ${open.map((o) => o.name).join(' or ')}?` : 'No shop is taking orders right now.');
    let pickupAt: Date | undefined;
    const when = str(body.pickup_time ?? body.pickup, 120);
    if (outlet) {
      // The time the agent passed, else the newest caller turn that names a time.
      const candidates = when ? [when] : [...heard].reverse();
      for (const c of candidates) {
        const r = parsePickup(c, now, outlet);
        if (r.kind === 'at') { pickupAt = r.at; break; }
      }
      if (!pickupAt) questions.push(when ? 'Please confirm the pickup time (for example "6 PM today" or "in 1 hour").' : 'When will the caller pick it up?');
    }
    if (questions.length) {
      // The question is the menu's wording (no caller words): logged so we can see what is still missing.
      log.info('sarvam_tools.quote_details', { organizationId, questions: questions.join(' ').slice(0, 200) });
      const ask = questions.join(' ');
      // Same question in every field an agent may read: a console that saves only "message" still asks it.
      return { ok: false, needs: 'details', questions_text: ask, message: `Not an error: ask the caller this, then call quote_order again with the answer: ${ask}`, next_step: 'ask_caller' };
    }

    const q = await this.orders.quote({ organizationId, lines, outletId: outlet!.id, pickupAt, now });
    if (!q.ok) {
      log.info('sarvam_tools.quote_changes', { organizationId, problems: q.problems.join(' ').slice(0, 200) });
      return { ok: false, needs: 'changes', problems_text: q.problems.join(' '), message: `Not an error: tell the caller this and ask what to change, then call quote_order again: ${q.problems.join(' ')}`, next_step: 'ask_caller' };
    }
    const summary = q.lines.map((l) => `${formatQty(l.quantity, l.unit)} ${l.name}${l.cut ? ` ${l.cut}` : ''} = ${rupees(l.lineTotal)}`).join('; ');
    const pickupText = pickupAt!.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const signed = signCart({ o: organizationId, l: lines, out: outlet!.id, p: pickupAt!.toISOString(), t: q.total, x: Date.now() + CART_TTL_MS }, secret);
    const cart = cartCode();
    await this.carts.set(cartKey(organizationId, cart), signed, CART_TTL_MS);
    const quotePhone = await this.callerPhone(organizationId, body);
    if (quotePhone) await this.carts.set(lastCartKey(organizationId, quotePhone), signed, CART_TTL_MS);
    const callId = await this.callRef(organizationId, body);
    if (callId) await this.carts.set(callCartKey(organizationId, callId), signed, CART_TTL_MS);
    const liveKey = callId || quotePhone || cart;
    const channel = (await this.fromDashboard(organizationId, body)) ? 'assistant' : 'voice';
    const known = quotePhone ? await this.prisma.customer.findFirst({ where: { organizationId, phone: quotePhone }, select: { name: true } }) : null;
    await writeLiveCallCart(this.carts, organizationId, liveKey, {
      key: liveKey, channel, phone: quotePhone ?? '', customerName: known?.name ?? null,
      lines: q.lines.map((l) => ({ name: l.name, unit: l.unit, quantity: l.quantity, cut: l.cut ?? null, lineTotal: l.lineTotal })),
      total: q.total, pickupAt: pickupAt!.toISOString(), updatedAt: new Date().toISOString(),
    }).catch(() => undefined);
    publishLive(organizationId, { type: 'cart.updated', channel, total: q.total, customer: known?.name ?? undefined });
    return {
      ok: true,
      summary_text: `${summary}. Total ${rupees(q.total)}. Pickup at ${outlet!.name}, ${pickupText}. Payment at the shop.`,
      total: q.total,
      cart_token: cart,
      confirm_question: 'Read the summary and the total to the caller and ask them to confirm before placing the order.',
      // The same in "message" (the field every console template shows): the agent reads it and asks for the yes.
      message: `Priced. Read this to the caller and ask them to confirm: ${q.lines.map((l) => `${formatQty(l.quantity, l.unit)} ${l.name}${l.cut ? ` ${l.cut}` : ''} = ${rupees(l.lineTotal)}`).join('; ')}. Total ${rupees(q.total)}. Pickup at ${outlet!.name}, ${pickupText}. Payment at the shop. After a clear yes, call place_order with cart_token ${cart}.`,
      next_step: 'confirm_with_caller',
    };
  }

  /** Place the confirmed cart once. Never says "confirmed" unless the order row exists. */
  async order(organizationId: string, body: Record<string, unknown>): Promise<ToolResult> {
    const secret = webhookSecret();
    if (!secret) return { ok: false, error: 'not_configured' };
    const phone = await this.callerPhone(organizationId, body);
    const raw = str(body.cart_token, 4000).trim();
    const callId = await this.callRef(organizationId, body);
    const refuse = (error: string, message: string) => {
      log.warn('sarvam_tools.order_refused', { organizationId, error, tokenLength: raw.length, confirmed: str(body.confirmed, 30), hasPhone: Boolean(phone) });
      return { ok: false, error, message };
    };
    // The cart the caller confirmed: the short code from quote_order, a full signed token, or (when the model lost the
    // code) the caller's own latest quote. Always one this server priced and signed for this organization.
    let cart = readCart(raw, secret);
    let via = cart ? 'token' : '';
    if (!cart && /^[A-Za-z0-9-]{4,16}$/.test(raw)) {
      const code = raw.toUpperCase().replace(/^CART-?/, '');
      const signed = await this.carts.get(cartKey(organizationId, code));
      cart = signed ? readCart(signed, secret) : null;
      via = cart ? 'code' : '';
    }
    if (!cart && callId) {
      const signed = await this.carts.get(callCartKey(organizationId, callId));
      cart = signed ? readCart(signed, secret) : null;
      via = cart ? 'this_call' : '';
    }
    if (!cart && phone) {
      const signed = await this.carts.get(lastCartKey(organizationId, phone));
      cart = signed ? readCart(signed, secret) : null;
      via = cart ? 'last_quote' : '';
    }
    if (!cart || cart.o !== organizationId) return refuse('cart_invalid', 'No priced order yet: call quote_order first, read the total to the caller, and call place_order only after they say yes.');
    // The yes: what the agent passed, else the caller's own last words on the call (a "no" there always wins).
    const lastSaid = (await this.heard(organizationId, body, (ls) => ls.length > 0 && saidYes(ls[ls.length - 1]))).slice(-2);
    const explicit = str(body.confirmed, 60);
    const summary = agentSummary(body);
    // With the agent's own account as the only record (phone calls), place_order is called only after the caller's
    // yes (the agent instructions); the account must not say "no / not / cancel".
    const negative = (t: string) => /\b(no|nope|not|don'?t|cancel|cancelled|declined|refused|illa|illai|vendam|vendaam|venam)\b|இல்ல|வேண்டாம்|வேணாம்/i.test(t);
    const yes = explicit ? saidYes(explicit) : summary ? !negative(summary) : lastSaid.length > 0 && saidYes(lastSaid[lastSaid.length - 1]);
    if (!yes) return refuse('not_confirmed', 'Read the total and ask the caller to confirm; call place_order after they say yes.');
    if (!phone) return refuse('no_phone', 'The caller phone number is needed to place the order.');
    const callRef = callId || str(body.attempt_id, 120) || cart.p;
    const idempotencyKey = `sarvam:${createHmac('sha256', secret).update(`${callRef}|${body.cart_token}`).digest('hex').slice(0, 40)}`;
    try {
      const customer = await this.conversations.getOrCreateCustomerByPhone(organizationId, phone, { source: 'voice_inbound', name: str(body.customer_name, 80) || undefined });
      const r = await this.orders.createOrder({
        organizationId, idempotencyKey, customerId: customer.id, channel: (await this.fromDashboard(organizationId, body)) ? 'assistant' : 'voice', lines: cart.l, outletId: cart.out, pickupAt: new Date(cart.p),
        paymentMethod: 'cash_at_shop', customerPhone: phone, customerName: str(body.customer_name, 80) || undefined, language: str(body.language, 20) || undefined, expectedTotal: cart.t,
      });
      if (r.status === 'rejected') return refuse('rejected', `The order could not be placed: ${r.problems.join(' ')}`);
      // The caller agreed on the call to receive the confirmation on WhatsApp: recorded as messaging consent.
      const wantsWhatsApp = saidYes(body.send_whatsapp);
      if (wantsWhatsApp && r.status === 'created') {
        await this.prisma.customer.updateMany({ where: { id: customer.id, organizationId, optedOutAt: null }, data: { messagingConsent: true } });
        await this.followUps?.onOrderCreated(organizationId, r.order.id, 'voice').catch((e) => log.warn('sarvam_tools.followup_failed', { error: errorMessage(e) }));
      }
      log.info('sarvam_tools.order', { organizationId, orderId: r.order.id, status: r.status, cartVia: via });
      for (const k of new Set([callId, phone].filter(Boolean))) await writeLiveCallCart(this.carts, organizationId, k, null).catch(() => undefined);
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
    const phone = await this.callerPhone(organizationId, body);
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
    const phone = await this.callerPhone(organizationId, body);
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
  // Sarvam's built-in call-context variables, picked with "@" in the tool body (docs: HTTPS tool).
  const PHONE = 'User Identifier';
  const CALL = { interaction_id: '@Interaction ID', transcript: '@Call Transcript' };
  const instructions = [
    `You are the phone assistant of ${input.businessName}, a fresh chicken shop in Tamil Nadu. Customers call to ask prices, check what is available and order for pickup.`,
    VOICE_LANGUAGE_POLICY.rule,
    'Facts come ONLY from the tools. At the start you receive menu_text, unavailable_today and shops_text: use them. For any price or availability question call get_item. Never say a price, product, discount, offer, delivery or availability that a tool did not return. If a product is not on the menu, say so and offer what is available.',
    'Orders: collect the products, quantity (kg or pieces), cut, shop (if more than one) and pickup time, then call quote_order (it reads the order from what the caller said). If it returns questions_text or problems_text, ask exactly that and call quote_order again after the answer. If it returns summary_text, read it with the total and ask the caller to confirm. Only after the caller clearly says yes, call place_order. Say the order is placed ONLY when place_order returns an order_number; read the order number. If place_order does not return one, do not say the order is placed: offer a staff call back.',
    'Pickup only, payment at the shop. No home delivery. Never take card or UPI details on the call.',
    'For order status call order_status. If the caller is upset, asks for a person, or wants something the tools cannot do (bulk, catering, complaints), call request_callback and tell them staff will call back.',
    'Keep answers short: one or two sentences, spoken naturally. Say prices as "220 rupees per kilo".',
  ].join('\n\n');
  const tool = (name: string, description: string, path: string, body: Record<string, string>, save: string[]) => ({ name, description, method: 'POST', url: url(path), headers, body, saveReplyIntoVariables: save });
  return {
    language: VOICE_LANGUAGE_POLICY,
    instructions,
    onStartHook: { method: 'POST', url: url('context'), headers, body: { caller_phone: `@${PHONE}`, interaction_id: CALL.interaction_id }, saveReplyIntoVariables: ['business_name', 'customer_name', 'menu_text', 'unavailable_today', 'shops_text', 'delivery', 'language_rule'] },
    tools: [
      tool('get_menu', 'Current menu with prices and what is not available today.', 'menu', {}, ['menu_text', 'unavailable_today', 'shops_text']),
      tool('get_item', 'Price and availability of one product the caller named.', 'item', { transcript: CALL.transcript }, ['found', 'price_text', 'availability_text', 'cuts', 'message']),
      tool('quote_order', 'Price the order. Nothing is saved.', 'quote', { caller_phone: `@${PHONE}`, ...CALL }, ['ok', 'summary_text', 'total', 'cart_token', 'questions_text', 'problems_text', 'message']),
      tool('place_order', 'Place the confirmed order (only after the caller said yes).', 'order', { caller_phone: `@${PHONE}`, ...CALL }, ['ok', 'order_number', 'message']),
      tool('order_status', 'Status of the caller’s latest order.', 'status', { caller_phone: `@${PHONE}`, interaction_id: CALL.interaction_id }, ['found', 'message']),
      tool('request_callback', 'Ask staff to call the customer back.', 'handoff', { caller_phone: `@${PHONE}`, ...CALL }, ['message']),
    ],
    postCallWebhook: input.webhookUrl,
    notes: [
      'Sarvam documents API tools with @variables and on-start hooks, but not their exact console field names for every option: match each item above to the console field with the same meaning.',
      'Sarvam does not document the variable that holds the caller number; choose it from the variable list in the console.',
      'Remove Hindi from "Languages allowed" and set the starting language to Tamil. This is a Sarvam console setting: our server cannot change it.',
    ],
  };
}
