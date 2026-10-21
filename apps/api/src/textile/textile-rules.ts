/**
 * Textile sales: pure, deterministic rules (no database, no model). Money is computed in integer paise so a
 * quotation total is never off by a rounding error; every status change goes through an explicit transition table.
 */

export type QuoteStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'accepted' | 'rejected' | 'expired';
export type OrderStatus = 'pending_confirmation' | 'confirmed' | 'processing' | 'ready_to_dispatch' | 'dispatched' | 'delivered' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'partial' | 'paid';

export const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ['pending_approval', 'approved', 'rejected'],
  pending_approval: ['approved', 'draft', 'rejected'],
  approved: ['sent', 'draft'],
  sent: ['accepted', 'rejected', 'expired'],
  accepted: [],
  rejected: [],
  expired: ['draft'],
};

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_confirmation: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['ready_to_dispatch', 'cancelled'],
  ready_to_dispatch: ['dispatched', 'cancelled'],
  dispatched: ['delivered'],
  delivered: [],
  cancelled: [],
};

export const PAYMENT_STATUSES: PaymentStatus[] = ['unpaid', 'partial', 'paid'];

export function canMove<S extends string>(table: Record<S, S[]>, from: S, to: S): boolean {
  return from === to || (table[from] ?? []).includes(to);
}

const toPaise = (v: number) => Math.round(v * 100);
const fromPaise = (p: number) => Math.round(p) / 100;

export type QuoteLineInput = { quantity: number; unitPrice: number };
export type QuoteTotals = { lines: number[]; subtotal: number; discount: number; taxPercent: number; tax: number; shipping: number; total: number };

/**
 * subtotal = Σ round(quantity × unitPrice); discount is capped at the subtotal; tax = taxPercent of (subtotal −
 * discount), rounded to the paisa; total = subtotal − discount + tax + shipping. All amounts ≥ 0.
 */
export function computeQuote(lines: QuoteLineInput[], opts: { discount?: number; taxPercent?: number; shipping?: number } = {}): QuoteTotals {
  for (const l of lines) {
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) throw new Error('Quantity must be more than 0');
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) throw new Error('Unit price must be 0 or more');
  }
  const linePaise = lines.map((l) => Math.round((Math.round(l.quantity * 100) * toPaise(l.unitPrice)) / 100));
  const subtotal = linePaise.reduce((a, b) => a + b, 0);
  const discount = Math.min(subtotal, Math.max(0, toPaise(opts.discount ?? 0)));
  const taxPercent = Math.min(100, Math.max(0, opts.taxPercent ?? 0));
  const tax = Math.round(((subtotal - discount) * Math.round(taxPercent * 100)) / 10_000);
  const shipping = Math.max(0, toPaise(opts.shipping ?? 0));
  return {
    lines: linePaise.map(fromPaise),
    subtotal: fromPaise(subtotal),
    discount: fromPaise(discount),
    taxPercent,
    tax: fromPaise(tax),
    shipping: fromPaise(shipping),
    total: fromPaise(subtotal - discount + tax + shipping),
  };
}

/** "Q-2026-0007" / "SO-2026-0012": prefix, year, 4-digit sequence. */
export function documentNumber(prefix: 'Q' | 'SO' | 'INV', year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

/** "₹1,25,000.50" style (Indian grouping). */
export function formatInr(amount: number, currency = 'INR'): string {
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${amount.toLocaleString('en-IN', { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** A 1-5 rating in a feedback reply ("5", "4/5", "5 stars", "⭐⭐⭐⭐", "நாலு"). undefined when none. */
export function parseRating(text: string): number | undefined {
  const t = (text ?? '').trim().toLowerCase();
  const stars = (t.match(/⭐|★/g) ?? []).length;
  if (stars >= 1 && stars <= 5) return stars;
  const m = t.match(/(?:^|\D)([1-5])(?:\s*(?:\/\s*5|out of 5|stars?|star))?(?:\D|$)/);
  if (m && t.replace(/[^0-9]/g, '').length <= 2) return Number(m[1]);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, 'ஒன்று': 1, 'ஒண்ணு': 1, 'ரெண்டு': 2, 'இரண்டு': 2, 'மூணு': 3, 'மூன்று': 3, 'நாலு': 4, 'நான்கு': 4, 'அஞ்சு': 5, 'ஐந்து': 5 };
  for (const [w, n] of Object.entries(words)) if (new RegExp(`(?:^|\\s)${w}(?:\\s|$)`, 'u').test(t)) return n;
  return undefined;
}
