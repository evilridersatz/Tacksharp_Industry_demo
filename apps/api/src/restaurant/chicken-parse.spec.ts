import { describe, expect, it } from 'vitest';
import { classify, findOrderNumber, findPhone, formatQty, parseItems, parsePayment, parsePickup, type Product } from './chicken-parse.js';
import { filterUnverifiedPrices } from './ordering-engine.service.js';
import { readCallReply } from './ready-notice.service.js';
import { isOpen, newOrderNumber, TRANSITIONS } from './orders.service.js';

const P: Product[] = [
  { id: 'broiler', name: 'Broiler Chicken', unit: 'kg', aliases: ['broiler', 'chicken', 'kozhi', 'கோழி'], cutOptions: ['Curry cut', 'Biryani cut', 'Fry cut', 'Whole'], available: true },
  { id: 'skinless', name: 'Skinless Chicken', unit: 'kg', aliases: ['skinless', 'skin illama'], cutOptions: ['Curry cut', 'Biryani cut'], available: true },
  { id: 'country', name: 'Country Chicken', unit: 'kg', aliases: ['country', 'nattu kozhi', 'நாட்டு கோழி'], cutOptions: ['Curry cut', 'Biryani cut', 'Whole'], available: true },
  { id: 'boneless', name: 'Boneless Chicken', unit: 'kg', aliases: ['boneless', 'போன்லெஸ்'], cutOptions: [], available: true },
  { id: 'eggs', name: 'Country Eggs', unit: 'piece', aliases: ['eggs', 'muttai', 'முட்டை'], cutOptions: [], available: true },
];
const items = (t: string) => parseItems(t, P).items.map((i) => [i.itemId, i.quantity ?? null, i.cut ?? null]);
const now = new Date('2026-10-11T10:00:00+05:30');
const shop = { opensAt: '07:00', closesAt: '21:00' };
const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
const pickup = (t: string) => {
  const r = parsePickup(t, now, shop);
  return r.kind === 'at' ? ist(r.at) : r.kind;
};

describe('products, kg and cuts (Tanglish, Tamil, English)', () => {
  it('reads one-line orders', () => {
    expect(items('rendu kilo broiler curry cut')).toEqual([['broiler', 2, 'Curry cut']]);
    expect(items('2kg chicken biryani cut')).toEqual([['broiler', 2, 'Biryani cut']]);
    expect(items('oru kilo broiler fry cut')).toEqual([['broiler', 1, 'Fry cut']]);
    expect(items('1 1/2 kg country whole')).toEqual([['country', 1.5, 'Whole']]);
  });

  it('gives each product its own quantity and cut', () => {
    expect(items('1.5 kg nattu kozhi biryani cut and arai kilo boneless')).toEqual([['country', 1.5, 'Biryani cut'], ['boneless', 0.5, null]]);
    expect(items('அரை கிலோ போன்லெஸ், ரெண்டு கிலோ கோழி கறி கட்')).toEqual([['boneless', 0.5, null], ['broiler', 2, 'Curry cut']]);
  });

  it('understands grams, halves, quarters and pieces', () => {
    expect(items('500 gm boneless')).toEqual([['boneless', 0.5, null]]);
    expect(items('750g skinless curry')).toEqual([['skinless', 0.75, 'Curry cut']]);
    expect(items('kaal kilo boneless')).toEqual([['boneless', 0.25, null]]);
    expect(items('onnarai kilo country curry cut')).toEqual([['country', 1.5, 'Curry cut']]);
    expect(items('12 muttai')).toEqual([['eggs', 12, null]]);
  });

  it('prefers the longest name and maps cut words to the product\'s own cuts', () => {
    expect(items('2 kg country chicken')).toEqual([['country', 2, null]]);
    expect(items('broiler small pieces')).toEqual([['broiler', null, 'Curry cut']]);
    expect(items('broiler periya piece')).toEqual([['broiler', null, 'Biryani cut']]);
    expect(items('broiler muzhusa')).toEqual([['broiler', null, 'Whole']]);
    expect(items('skinless fry cut')).toEqual([['skinless', null, null]]); // skinless has no fry cut
  });

  it('keeps product-less amounts and cuts for the product being discussed', () => {
    expect(parseItems('3 kg', P).loose).toEqual({ quantity: 3 });
    expect(parseItems('curry cut', P).loose).toEqual({ cut: 'curry' });
    expect(parseItems('கறி கட்', P).loose).toEqual({ cut: 'curry' });
  });

  it('never reads clock times, durations or phone numbers as kg', () => {
    expect(parseItems('6 mani varen', P).loose).toEqual({});
    expect(parseItems('30 nimishathula', P).loose).toEqual({});
    expect(parseItems('9876543210', P).loose).toEqual({});
  });
});

describe('payment', () => {
  it('cash, UPI, already paid online', () => {
    expect(parsePayment('cash la tharen')).toBe('cash_at_shop');
    expect(parsePayment('காசு')).toBe('cash_at_shop');
    expect(parsePayment('gpay')).toBe('upi_at_shop');
    expect(parsePayment('phonepe pannuren')).toBe('upi_at_shop');
    expect(parsePayment('already paid online')).toBe('paid_online');
    expect(parsePayment('gpay pannitten')).toBe('paid_online');
    expect(parsePayment('ஏற்கனவே online-ல பே பண்ணிட்டேன்')).toBe('paid_online');
    expect(parsePayment('2 kg broiler')).toBeUndefined();
  });
});

describe('pickup time (IST)', () => {
  it('relative times in Tanglish and Tamil', () => {
    expect(pickup('30 nimishathula varen')).toBe('2026-10-11 10:30');
    expect(pickup('oru mani nerathula')).toBe('2026-10-11 11:00');
    expect(pickup('ஒரு மணி நேரத்துல வரேன்')).toBe('2026-10-11 11:00');
    expect(pickup('ippo varen')).toBe('2026-10-11 10:00');
  });

  it('clock times resolve to the next time inside shop hours', () => {
    expect(pickup('saayangaalam 6 mani')).toBe('2026-10-11 18:00');
    expect(pickup('6 mani')).toBe('2026-10-11 18:00'); // 6 AM is before the shop opens
    expect(pickup('naalaikku kaalaila 10 manikku varen')).toBe('2026-10-12 10:00');
    expect(pickup('tomorrow 11 am')).toBe('2026-10-12 11:00');
    expect(pickup('9 am')).toBe('2026-10-12 09:00'); // already past today
    expect(pickup('cash')).toBe('none');
  });
});

describe('intents', () => {
  it('only explicit words confirm', () => {
    for (const t of ['sari', 'Sari', 'yes', 'ok', 'confirm pannunga', 'சரி', 'ஆமா']) expect(classify(t)).toBe('confirm');
    for (const t of ['sari 3 kg', 'maybe', 'yes but curry cut']) expect(classify(t)).not.toBe('confirm');
    expect(classify('venam')).toBe('decline');
  });

  it('recognises the common requests', () => {
    expect(classify('Hi')).toBe('greeting');
    expect(classify('வணக்கம்')).toBe('greeting');
    expect(classify('offer claim pannanum (GR50)', 'GR50')).toBe('offer');
    expect(classify('rate enna')).toBe('menu');
    expect(classify('order ready ah?')).toBe('order_status');
    expect(classify('staff kitta pesanum')).toBe('human');
    expect(classify('boneless venam')).toBe('remove');
  });
});

describe('helpers', () => {
  it('formats quantities', () => {
    expect(formatQty(2, 'kg')).toBe('2 kg');
    expect(formatQty(1.5, 'kg')).toBe('1.5 kg');
    expect(formatQty(0.5, 'kg')).toBe('500 g');
    expect(formatQty(12, 'piece')).toBe('12 pcs');
  });

  it('phones and order numbers', () => {
    expect(findPhone('Ravi +91 98765 43210')).toBe('9876543210');
    expect(findOrderNumber('GRATEFUL')).toBeUndefined();
    for (let i = 0; i < 100; i++) {
      const n = newOrderNumber();
      expect(findOrderNumber(`status ${n}`)).toBe(n);
    }
  });

  it('shop hours in IST', () => {
    expect(isOpen(shop, new Date('2026-10-11T12:00:00+05:30'))).toBe(true);
    expect(isOpen(shop, new Date('2026-10-11T22:00:00+05:30'))).toBe(false);
  });

  it('collected and cancelled orders cannot move', () => {
    expect(TRANSITIONS.completed).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
    expect(TRANSITIONS.ready).toContain('completed');
  });

  it('reads the reply on the order-ready call', () => {
    expect(readCallReply('சரி, பத்து நிமிஷத்துல வரேன்')).toBe('coming');
    expect(readCallReply('ok sari varen')).toBe('coming');
    expect(readCallReply('நாளைக்கு வரேன்')).toBe('later');
    expect(readCallReply('venam cancel pannunga')).toBe('cancel');
    expect(readCallReply('')).toBe('unclear');
  });

  it('drops model sentences with prices that are not in the catalogue', () => {
    const prices = new Set([220, 50]);
    expect(filterUnverifiedPrices('Broiler is ₹220 per kg. Mutton is ₹750!', prices)).toBe('Broiler is ₹220 per kg.');
    expect(filterUnverifiedPrices('Our chicken is cut fresh every morning.', prices)).toBe('Our chicken is cut fresh every morning.');
  });
});

describe('several products in one sentence', () => {
  it('does not give one amount to two products', () => {
    expect(items('broiler 2 kg country 1 kg')).toEqual([['broiler', 2, null], ['country', 1, null]]);
    expect(items('2 kg broiler 1 kg country')).toEqual([['broiler', 2, null], ['country', 1, null]]);
  });
});
