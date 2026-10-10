import { describe, expect, it } from 'vitest';
import { classifyIntent, findOrderNumber, findPhone, isQuestion, parseFulfilment, parseItemRequests, pickOutlet, type CatalogItem } from './order-parse.js';
import { filterUnverifiedPrices } from './ordering-engine.service.js';
import { isOpen, newOrderNumber, TRANSITIONS } from './orders.service.js';

const item = (id: string, name: string, aliases: string[] = []): CatalogItem => ({ id, name, aliases, categoryId: 'c', categoryName: 'C', available: true });
const MENU = [
  item('biryani', 'Chicken Biryani', ['biryani', 'briyani']),
  item('c65', 'Chicken 65', ['c65', '65']),
  item('soda', 'Lime Soda', ['lemon soda', 'soda']),
  item('parotta', 'Parotta', ['porotta']),
  item('grill_full', 'Grill Chicken Full', ['full grill']),
  item('grill_half', 'Grill Chicken Half', ['half grill']),
  item('egg_rice', 'Egg Fried Rice'),
  item('rice', 'Chicken Fried Rice', ['fried rice']),
];
const parse = (t: string) => parseItemRequests(t, MENU).map((r) => [r.itemId, r.quantity, r.unknownVariant ?? null]);

describe('parseItemRequests', () => {
  it('reads quantities before and after items', () => {
    expect(parse('2 chicken biryani and one lime soda')).toEqual([['biryani', 2, null], ['soda', 1, null]]);
    expect(parse('biryani x3')).toEqual([['biryani', 3, null]]);
    expect(parse('parotta 4')).toEqual([['parotta', 4, null]]);
    expect(parse('rendu biryani')).toEqual([['biryani', 2, null]]);
    expect(parse('I want 2 plates of biryani please')).toEqual([['biryani', 2, null]]);
  });

  it('defaults to one and does not confuse "Chicken 65" with a quantity', () => {
    expect(parse('chicken 65')).toEqual([['c65', 1, null]]);
    expect(parse('2 chicken 65')).toEqual([['c65', 2, null]]);
    expect(parse('3 65')).toEqual([['c65', 3, null]]);
  });

  it('prefers the longest phrase and keeps neighbouring quantities with their items', () => {
    expect(parse('1 grill chicken full and 2 half grill')).toEqual([['grill_full', 1, null], ['grill_half', 2, null]]);
    expect(parse('biryani 2 parotta')).toEqual([['biryani', 1, null], ['parotta', 2, null]]);
    expect(parse('egg fried rice')).toEqual([['egg_rice', 1, null]]);
  });

  it('flags a dish we do not sell instead of substituting a similar one', () => {
    expect(parse('mutton biryani')).toEqual([['biryani', 1, 'mutton biryani']]);
    expect(parse('2 veg fried rice')).toEqual([['rice', 2, 'veg fried rice']]);
  });

  it('adds up repeated mentions and ignores unrelated text', () => {
    expect(parse('biryani and another biryani')).toEqual([['biryani', 2, null]]);
    expect(parse('what time do you close')).toEqual([]);
  });
});

describe('intents and details', () => {
  it('only treats explicit words as a confirmation', () => {
    for (const t of ['yes', 'YES', 'ok', 'confirm', 'place order', 'yes please']) expect(classifyIntent(t)).toBe('confirm');
    for (const t of ['maybe', 'yes but change it', 'is it spicy']) expect(classifyIntent(t)).not.toBe('confirm');
    expect(classifyIntent('no')).toBe('decline');
  });

  it('recognises the common requests', () => {
    expect(classifyIntent('show menu')).toBe('menu');
    expect(classifyIntent('checkout')).toBe('checkout');
    expect(classifyIntent('where is my order')).toBe('order_status');
    expect(classifyIntent('status of GR-AB12CD')).toBe('order_status');
    expect(classifyIntent('talk to staff')).toBe('human');
    expect(classifyIntent('clear cart')).toBe('clear_cart');
    expect(classifyIntent('GR Chicken hi')).not.toBe('order_status');
  });

  it('separates questions from orders', () => {
    expect(isQuestion('do you have mutton biryani?')).toBe(true);
    expect(isQuestion('how much is grill chicken')).toBe(true);
    expect(isQuestion('can you add 2 biryani?')).toBe(false);
    expect(isQuestion('2 biryani')).toBe(false);
  });

  it('parses fulfilment, phone, order number and outlet choice', () => {
    expect(parseFulfilment('takeaway')).toBe('pickup');
    expect(parseFulfilment('home delivery please')).toBe('delivery');
    expect(findPhone('Ravi +91 98765 43210')).toBe('9876543210');
    expect(findPhone('call 12345')).toBeUndefined();
    expect(findOrderNumber('status GR-7K2Q9X?')).toBe('GR-7K2Q9X');
    expect(findOrderNumber('GRATEFUL')).toBeUndefined();
    const outlets = [{ id: 'a', name: 'GR Chicken Anna Nagar', area: 'Anna Nagar' }, { id: 'v', name: 'GR Chicken Velachery', area: 'Velachery' }];
    expect(pickOutlet('2', outlets)?.id).toBe('v');
    expect(pickOutlet('anna nagar branch', outlets)?.id).toBe('a');
    expect(pickOutlet('whatever', outlets)).toBeUndefined();
  });
});

describe('orders helpers', () => {
  it('order numbers always contain a digit and are found again by the parser', () => {
    for (let i = 0; i < 200; i++) {
      const n = newOrderNumber();
      expect(n).toMatch(/^GR-[A-Z0-9]{6}$/);
      expect(findOrderNumber(`status ${n}`)).toBe(n);
    }
  });

  it('opening hours are checked in IST, including past midnight', () => {
    const at = (hhmm: string) => new Date(`2026-10-11T${hhmm}:00+05:30`);
    expect(isOpen({ opensAt: '11:00', closesAt: '23:00' }, at('12:00'))).toBe(true);
    expect(isOpen({ opensAt: '11:00', closesAt: '23:00' }, at('02:00'))).toBe(false);
    expect(isOpen({ opensAt: '18:00', closesAt: '02:00' }, at('01:00'))).toBe(true);
    expect(isOpen({ opensAt: '18:00', closesAt: '02:00' }, at('10:00'))).toBe(false);
  });

  it('terminal statuses cannot move', () => {
    expect(TRANSITIONS.completed).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
    expect(TRANSITIONS.pending).toContain('confirmed');
  });

  it('drops model sentences with prices that are not on the menu', () => {
    const prices = new Set([220, 50]);
    expect(filterUnverifiedPrices('Chicken Biryani is ₹220. Mutton biryani is ₹350!', prices)).toBe('Chicken Biryani is ₹220.');
    expect(filterUnverifiedPrices('We have a 20% off deal for Rs 199 today.', prices)).toBe('');
    expect(filterUnverifiedPrices('Our biryani is made with seeraga samba rice.', prices)).toBe('Our biryani is made with seeraga samba rice.');
  });
});
