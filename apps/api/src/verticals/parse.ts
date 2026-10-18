import { addDays, dateOnly, istDay } from './common.js';

/** Small, deterministic parsers shared by the food, hotel and hospital assistants (English + common Tanglish). */

export const lower = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}:/.\-\s]/gu, ' ').replace(/\s+/g, ' ').trim()} `;

const WORD_NUM: Record<string, number> = {
  one: 1, a: 1, an: 1, single: 1, two: 2, couple: 2, pair: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  oru: 1, onnu: 1, rendu: 2, irandu: 2, moonu: 3, munu: 3, naalu: 4, nalu: 4, anju: 5, aaru: 6, ezhu: 7,
};
export const numWord = (w: string) => (/^\d+$/.test(w) ? Number(w) : WORD_NUM[w]);

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DOW: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

function ymd(y: number, m: number, d: number) {
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = dateOnly(s);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}

/** All calendar dates mentioned, in order (IST). A date without a year that already passed means next year. */
export function findDates(text: string, now = new Date()): string[] {
  const today = istDay(now);
  const [ty] = today.split('-').map(Number);
  const t = lower(text);
  const found: Array<{ at: number; day: string }> = [];
  const push = (at: number, day: string | null) => day && found.push({ at, day });
  const withYear = (m: number, d: number, y?: number) => {
    if (y) return ymd(y < 100 ? 2000 + y : y, m, d);
    const cur = ymd(ty, m, d);
    return cur && cur >= today ? cur : ymd(ty + 1, m, d);
  };
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) push(m.index!, ymd(Number(m[1]), Number(m[2]), Number(m[3])));
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/g)) if (!/^\d{4}$/.test(m[1])) push(m.index!, withYear(Number(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined));
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?\b/g)) push(m.index!, withYear(MONTHS[m[2]], Number(m[1]), m[3] ? Number(m[3]) : undefined));
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/g)) push(m.index!, withYear(MONTHS[m[1]], Number(m[2]), m[3] ? Number(m[3]) : undefined));
  // "15 to 17 nov": the first day borrows the month of the second.
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|-|till|until)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)/g)) push(m.index!, withYear(MONTHS[m[3]], Number(m[1])));
  for (const m of t.matchAll(/\b(day after tomorrow|naalai marunaal|tomorrow|tmrw|tmr|naalaikku|naalai|nalaiku|today|tonight|innaikku|inniku)\b/g)) {
    const k = m[1];
    push(m.index!, k === 'day after tomorrow' || k === 'naalai marunaal' ? addDays(today, 2) : /tom|tmr|naal|nalai/.test(k) ? addDays(today, 1) : today);
  }
  for (const m of t.matchAll(/\b(next\s+|this\s+|coming\s+)?(sun|mon|tues?|wed|thur?s?|fri|sat)(?:day|nesday|urday|sday)?\b/g)) {
    const target = DOW[m[2]] ?? DOW[`${m[2]}day`];
    if (target === undefined) continue;
    const cur = dateOnly(today).getUTCDay();
    let delta = (target - cur + 7) % 7;
    if (m[1]?.trim() === 'next' && delta === 0) delta = 7;
    push(m.index!, addDays(today, delta));
  }
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const f of found) if (!out.includes(f.day)) out.push(f.day);
  return out;
}

/** "2 nights", "for three nights" */
export function findNights(text: string): number | undefined {
  const m = lower(text).match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|oru|rendu|moonu)\s*(?:night|nite)s?\b/);
  return m ? numWord(m[1]) : undefined;
}

/** Guests: "2 adults and 1 child", "family of 4", "3 people", "couple". */
export function findGuests(text: string): { adults?: number; children?: number } {
  const t = lower(text);
  const out: { adults?: number; children?: number } = {};
  const a = t.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:adults?|grown ?ups?|pax|periyavanga)\b/);
  const c = t.match(/\b(\d+|one|two|three|four|five|six|a|no)\s*(?:child|children|kids?|kid|kuzhandhai(?:gal)?|pasanga)\b/);
  if (a) out.adults = numWord(a[1]);
  if (c) out.children = c[1] === 'no' ? 0 : numWord(c[1]);
  if (out.adults === undefined) {
    const p = t.match(/\b(?:family of|group of|for|we are|we're)\s*(\d+|two|three|four|five|six|seven|eight)\s*(?:people|persons?|guests?|members?|of us|pax)?\b/) ?? t.match(/\b(\d+|two|three|four|five|six)\s*(?:people|persons?|guests?|members|pax)\b/);
    if (p && !/\bnights?\b/.test(t.slice((p.index ?? 0), (p.index ?? 0) + p[0].length + 8))) out.adults = Math.max(1, (numWord(p[1]) ?? 0) - (out.children ?? 0));
    else if (/\b(couple|me and my (wife|husband)|husband and wife|wife and me)\b/.test(t)) out.adults = 2;
    else if (/\b(just me|only me|myself|solo|single person)\b/.test(t)) out.adults = 1;
  }
  return out;
}

export function findRooms(text: string): number | undefined {
  const m = lower(text).match(/\b(\d+|one|two|three|four|five|a|oru|rendu)\s*rooms?\b/);
  return m ? numWord(m[1]) : undefined;
}

/** Hospital times: "10am", "10:30", "4 pm"; part of day. Returns IST "HH:mm" when found. */
export function findTime(text: string): string | undefined {
  const t = lower(text);
  const m1 = t.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/);
  const m2 = t.match(/\b(\d{1,2})\s*(am|pm|mani)\b/);
  let h: number, min: number, ap: string;
  if (m1) [h, min, ap] = [Number(m1[1]), Number(m1[2]), m1[3] ?? ''];
  else if (m2) [h, min, ap] = [Number(m2[1]), 0, m2[2]];
  else return undefined;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (ap === 'mani' && h >= 1 && h <= 7) h += 12; // "4 mani" in a clinic context means afternoon
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
export function partOfDay(text: string): 'morning' | 'afternoon' | 'evening' | undefined {
  const t = lower(text);
  if (/\b(morning|kaalai|kalai|kaalaila|forenoon)\b/.test(t)) return 'morning';
  if (/\b(afternoon|madhiyam|mathiyam|noon)\b/.test(t)) return 'afternoon';
  if (/\b(evening|night|saayangalam|sayangalam|maalai)\b/.test(t)) return 'evening';
  return undefined;
}

/** "1", "option 2", "the second one", "first" */
export function pickIndex(text: string, max: number): number | undefined {
  const t = lower(text).trim();
  const m = t.match(/^(?:option\s*|slot\s*|no\.?\s*|number\s*|#)?(\d)\b/) ?? t.match(/\b(?:option|slot|number)\s*(\d)\b/);
  if (m) {
    const i = Number(m[1]);
    return i >= 1 && i <= max ? i - 1 : undefined;
  }
  const words = ['first', 'second', 'third', 'fourth', 'fifth'];
  const w = words.findIndex((x) => new RegExp(`\\b${x}\\b`).test(t));
  return w >= 0 && w < max ? w : undefined;
}

export const isYes = (s: string) => /\b(yes|yeah|yep|yup|ok|okay|okk|sure|confirm|confirmed|go ahead|proceed|done|correct|book it|place (the )?order|aama|aamam|seri|sari|ok pannunga|confirm pannunga|book pannunga|podunga)\b|ஆமா|சரி/.test(lower(s));
export const isNo = (s: string) => /\b(no|nope|nah|not now|cancel that|dont|don't|wait|illa|venam|vendam|vendaam)\b|இல்ல|வேண்டாம்/.test(lower(s));
export const wantsHuman = (s: string) => /\b(human|agent|staff|manager|person|representative|call me|speak to|talk to|someone)\b|ஆள்/.test(lower(s));
export const isGreeting = (s: string) => /^\s*(hi+|hello|hey|vanakkam|good (morning|afternoon|evening)|hai)\b/.test(lower(s).trim()) || /வணக்கம்/.test(s);
export const isThanks = (s: string) => /\b(thanks|thank you|thx|nandri|bye|goodbye)\b|நன்றி/.test(lower(s));
export const findReference = (s: string, prefix: string) => s.toUpperCase().match(new RegExp(`\\b${prefix}-?([23456789A-HJ-NP-Z]{6})\\b`))?.[1];
