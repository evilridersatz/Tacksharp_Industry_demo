import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone.js';
import { normalizeLocation, normalizePropertyType, parseBhk, parseIndianBudget } from './parsers.js';
import { nextAllowedCallTime } from './time.js';
import { nextLeadStatus } from '../leads/leads.service.js';
import { KeyedMutex } from './keyed-mutex.js';

describe('phone normalization', () => {
  it.each([
    ['+91 98765 43210', '919876543210'],
    ['919876543210', '919876543210'],
    ['09876543210', '919876543210'],
    ['9876543210', '919876543210'],
    ['+91-98765-43210', '919876543210'],
    ['0091 98765 43210', '919876543210'],
  ])('%s -> %s', (input, expected) => expect(normalizePhone(input)).toBe(expected));

  it.each([[''], ['123'], [null], [undefined]])('rejects %s', (input) =>
    expect(normalizePhone(input as string)).toBeUndefined(),
  );
});

describe('budget parsing (rupees)', () => {
  it.each([
    ['80 lakhs', 8_000_000],
    ['80L', 8_000_000],
    ['80l', 8_000_000],
    ['80 lakh', 8_000_000],
    ['8000000', 8_000_000],
    ['8 million', 8_000_000],
    ['1.2 cr', 12_000_000],
    ['1 crore', 10_000_000],
    ['80 லட்சம்', 8_000_000],
    ['eighty lakhs', 8_000_000],
    ['Budget eighty lakhs kulla venum', 8_000_000],
    ['80-90 lakhs', 9_000_000],
    ['85 lakh to 1 crore', 10_000_000],
    ['budget 80', 8_000_000],
    ['Rs. 75,00,000', 7_500_000],
  ])('%s -> %d', (input, expected) => expect(parseIndianBudget(input)).toBe(expected));

  it('numbers', () => {
    expect(parseIndianBudget(80)).toBe(8_000_000);
    expect(parseIndianBudget(9_500_000)).toBe(9_500_000);
    expect(parseIndianBudget('no idea')).toBeUndefined();
  });
});

describe('BHK / type / location', () => {
  it.each([['2BHK', 2], ['2 bhk', 2], ['2 bedroom', 2], ['two bedroom', 2], ['rendu BHK', 2], [3, 3]])(
    'bhk %s -> %d',
    (input, expected) => expect(parseBhk(input as string)).toBe(expected),
  );
  it('property types', () => {
    expect(normalizePropertyType('flat')).toBe('Apartment');
    expect(normalizePropertyType('villa')).toBe('Villa');
    expect(normalizePropertyType('independent house')).toBe('House');
  });
  it('locations', () => {
    expect(normalizeLocation('Porur la')).toBe('Porur');
    expect(normalizeLocation('porur, Chennai')).toBe('Porur');
    expect(normalizeLocation('Porur-ல')).toBe('Porur');
  });
});

describe('lead status transitions', () => {
  it.each([
    ['new', 'contacted', 'contacted'],
    ['qualified', 'contacted', 'qualified'], // never goes backward
    ['site_visit', 'qualified', 'site_visit'],
    ['contacted', 'qualified', 'qualified'],
    ['qualified', 'human_handoff', 'human_handoff'],
    ['qualified', 'not_interested', 'not_interested'],
    ['site_visit', 'callback', 'site_visit'], // a booked visit is not downgraded by a callback
    ['callback', 'contacted', 'callback'],
    ['callback', 'qualified', 'qualified'], // re-engaged
    ['not_interested', 'property_interested', 'property_interested'],
    ['won', 'not_interested', 'won'],
    ['lost', 'qualified', 'lost'],
  ])('%s + %s -> %s', (current, next, expected) =>
    expect(nextLeadStatus(current, next as never)).toBe(expected),
  );
});

describe('call window (IST)', () => {
  it('inside window returns same time', () => {
    const t = new Date('2026-10-02T06:00:00Z'); // 11:30 IST
    expect(nextAllowedCallTime(t, 9, 21)).toEqual(t);
  });
  it('late night moves to next 9 AM IST', () => {
    expect(nextAllowedCallTime(new Date('2026-10-02T17:00:00Z'), 9, 21).toISOString()).toBe('2026-10-03T03:30:00.000Z');
  });
  it('early morning moves to same-day 9 AM IST', () => {
    expect(nextAllowedCallTime(new Date('2026-10-02T01:00:00Z'), 9, 21).toISOString()).toBe('2026-10-02T03:30:00.000Z');
  });
});

describe('KeyedMutex', () => {
  it('serializes per key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const slow = mutex.run('a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('first');
    });
    const fast = mutex.run('a', async () => order.push('second'));
    await Promise.all([slow, fast]);
    expect(order).toEqual(['first', 'second']);
  });
});
