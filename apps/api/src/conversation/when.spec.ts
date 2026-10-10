import { describe, expect, it } from 'vitest';
import { describeWhen, istDate, istParts, mergeWhen, parseWhen, resolveWhen } from './when.js';

// Thursday 8 October 2026, 13:30 IST
const NOW = istDate(2026, 10, 8, 13, 30);

const at = (text: string, base?: ReturnType<typeof parseWhen>) => {
  const r = resolveWhen(mergeWhen(base, parseWhen(text, NOW)));
  return 'at' in r ? istParts(r.at) : r;
};

describe('parseWhen / resolveWhen (IST)', () => {
  it('weekday + clock time in Tanglish and Tamil', () => {
    expect(at('Saturday 11 மணிக்கு')).toMatchObject({ day: 10, month: 10, hour: 11, minute: 0, weekday: 6 });
    expect(at('சனிக்கிழமை காலை 11 மணிக்கு')).toMatchObject({ day: 10, hour: 11 });
    expect(at('saturday 11 mani')).toMatchObject({ day: 10, hour: 11 });
  });
  it('tomorrow + part of day uses 10 / 15 / 18', () => {
    expect(at('நாளைக்கு evening')).toMatchObject({ day: 9, hour: 18 });
    expect(at('naalaikku morning')).toMatchObject({ day: 9, hour: 10 });
    expect(at('tomorrow afternoon')).toMatchObject({ day: 9, hour: 15 });
  });
  it('am/pm and 24h', () => {
    expect(at('tomorrow 5 pm')).toMatchObject({ day: 9, hour: 17 });
    expect(at('tomorrow 11am')).toMatchObject({ day: 9, hour: 11 });
    expect(at('tomorrow 17:30')).toMatchObject({ day: 9, hour: 17, minute: 30 });
  });
  it('small hours without am/pm mean the afternoon; 8 is ambiguous', () => {
    expect(at('tomorrow 5 மணிக்கு')).toMatchObject({ hour: 17 });
    expect(at('tomorrow 8 மணிக்கு')).toEqual({ missing: 'ampm' });
  });
  it('explicit dates', () => {
    expect(at('October 18 at 11 am')).toMatchObject({ month: 10, day: 18, hour: 11 });
    expect(at('18th oct 4 pm')).toMatchObject({ month: 10, day: 18, hour: 16 });
    expect(at('18 ஆம் தேதி காலை')).toMatchObject({ day: 18, hour: 10 });
  });
  it('same weekday means next week; a date in the past rolls to next year', () => {
    expect(at('Thursday 11 am')).toMatchObject({ day: 15, month: 10 });
    expect(at('5 oct 11 am')).toMatchObject({ year: 2027, month: 10, day: 5 });
  });
  it('reports what is missing and merges across turns', () => {
    expect(at('saturday')).toEqual({ missing: 'time' });
    expect(at('11 மணிக்கு')).toEqual({ missing: 'date' });
    expect(at('hello')).toEqual({ missing: 'both' });
    const first = parseWhen('saturday', NOW);
    expect(at('காலை 11 மணிக்கு', first)).toMatchObject({ day: 10, hour: 11 });
  });
  it('does not read budgets, BHK or phone digits as times', () => {
    expect(parseWhen('80 lakhs budget', NOW)).toEqual({});
    expect(parseWhen('2 bhk porur', NOW)).toEqual({});
  });
  it('describes in English, Tamil and Tanglish', () => {
    const d = istDate(2026, 10, 10, 11, 0);
    expect(describeWhen(d, 'en')).toBe('Saturday, 10 October at 11 AM');
    expect(describeWhen(d, 'ta')).toBe('சனிக்கிழமை 10 October காலைல 11 மணி');
    expect(describeWhen(istDate(2026, 10, 9, 17, 30), 'tl')).toBe('Friday 9 October evening 5:30 mani');
  });
});
