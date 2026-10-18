import { describe, expect, it } from 'vitest';
import { ORDER_TRANSITIONS, QUOTE_TRANSITIONS, canMove, computeQuote, documentNumber, formatInr, parseRating } from './textile-rules.js';
import { confirmsOrder, extractTextileFacts, needsSalesperson, wantsCatalogue, wantsQuotation } from './textile-intent.js';

describe('textile: quotation maths (integer paise, no rounding drift)', () => {
  it('subtotal, discount, tax on the discounted amount, shipping', () => {
    const t = computeQuote([{ quantity: 500, unitPrice: 182.5 }, { quantity: 120.5, unitPrice: 99.99 }], { discount: 2500, taxPercent: 5, shipping: 750 });
    expect(t.lines).toEqual([91250, 12048.8]);
    expect(t.subtotal).toBe(103298.8);
    expect(t.discount).toBe(2500);
    expect(t.tax).toBe(5039.94); // 5% of 100798.80
    expect(t.total).toBe(106588.74);
  });
  it('discount never exceeds the subtotal; nothing goes negative', () => {
    const t = computeQuote([{ quantity: 10, unitPrice: 100 }], { discount: 5000, taxPercent: 12, shipping: -50 });
    expect(t).toMatchObject({ subtotal: 1000, discount: 1000, tax: 0, shipping: 0, total: 0 });
  });
  it('0.1 + 0.2 style inputs stay exact', () => {
    expect(computeQuote([{ quantity: 3, unitPrice: 0.1 }, { quantity: 1, unitPrice: 0.2 }]).total).toBe(0.5);
  });
  it('rejects zero / negative quantities and negative prices', () => {
    expect(() => computeQuote([{ quantity: 0, unitPrice: 10 }])).toThrow();
    expect(() => computeQuote([{ quantity: 5, unitPrice: -1 }])).toThrow();
  });
  it('document numbers and Indian currency format', () => {
    expect(documentNumber('Q', 2026, 7)).toBe('Q-2026-0007');
    expect(documentNumber('SO', 2026, 123)).toBe('SO-2026-0123');
    expect(formatInr(125000.5)).toBe('₹1,25,000.50');
    expect(formatInr(91250)).toBe('₹91,250');
  });
});

describe('textile: status transitions', () => {
  it('quotations: sent only after approval; accepted / rejected are final', () => {
    expect(canMove(QUOTE_TRANSITIONS, 'draft', 'sent')).toBe(false);
    expect(canMove(QUOTE_TRANSITIONS, 'approved', 'sent')).toBe(true);
    expect(canMove(QUOTE_TRANSITIONS, 'sent', 'accepted')).toBe(true);
    expect(canMove(QUOTE_TRANSITIONS, 'accepted', 'draft')).toBe(false);
  });
  it('orders: step by step; delivered and cancelled are final; dispatched cannot be cancelled', () => {
    expect(canMove(ORDER_TRANSITIONS, 'pending_confirmation', 'delivered')).toBe(false);
    expect(canMove(ORDER_TRANSITIONS, 'confirmed', 'processing')).toBe(true);
    expect(canMove(ORDER_TRANSITIONS, 'dispatched', 'cancelled')).toBe(false);
    expect(canMove(ORDER_TRANSITIONS, 'delivered', 'processing')).toBe(false);
  });
});

describe('textile: feedback ratings', () => {
  it('reads 1-5 ratings in several forms; ignores other numbers', () => {
    for (const [t, r] of [['5', 5], ['4/5', 4], ['3 stars', 3], ['⭐⭐⭐⭐', 4], ['நாலு', 4], ['two', 2]] as const) expect(parseRating(t), t).toBe(r);
    for (const t of ['500 metres', 'order 2026', 'ok']) expect(parseRating(t), t).toBeUndefined();
  });
});

describe('textile: understanding enquiries', () => {
  it('fabric, product, colour, quantity + unit, target price, destination, buyer type', () => {
    expect(extractTextileFacts('Need cotton shirting, 500 metres, white, deliver to Tiruppur. Rate ₹180 per metre. We are wholesalers')).toMatchObject({
      fabric: 'cotton', product: 'shirting', colour: 'white', quantity: 500, unit: 'metre', targetPrice: 180, destination: 'Tiruppur', buyerType: 'wholesaler',
    });
    expect(extractTextileFacts('silk saree 200 pcs')).toMatchObject({ fabric: 'silk', product: 'saree', quantity: 200, unit: 'piece' });
    expect(extractTextileFacts('எனக்கு பட்டு புடவை 100 sarees வேணும்')).toMatchObject({ fabric: 'silk', product: 'saree', quantity: 100, unit: 'piece' });
    expect(extractTextileFacts('2k mtrs rayon')).toMatchObject({ fabric: 'rayon', quantity: 2000, unit: 'metre' });
    expect(extractTextileFacts('rate 250 per metre')).toMatchObject({ targetPrice: 250 });
    expect(extractTextileFacts('rate 250 per metre').quantity).toBeUndefined(); // the price is not a quantity
  });
  it('requests that change the flow', () => {
    expect(wantsCatalogue('send me the catalogue')).toBe(true);
    expect(wantsCatalogue('photos anuppunga')).toBe(true);
    expect(wantsQuotation('please send quotation')).toBe(true);
    expect(needsSalesperson('can you give some discount for bulk')).toBe(true);
    expect(needsSalesperson('need 30 days credit')).toBe(true);
    expect(needsSalesperson('print our own design')).toBe(true);
    expect(needsSalesperson('cotton 500 metres')).toBe(false);
    expect(confirmsOrder('ok confirm')).toBe(true);
    expect(confirmsOrder('go ahead')).toBe(true);
    expect(confirmsOrder('what colours?')).toBe(false);
  });
});
