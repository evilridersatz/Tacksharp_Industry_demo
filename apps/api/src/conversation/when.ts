/**
 * Deterministic date/time reading for site-visit requests in English, Tamil script and Tanglish.
 * All arithmetic is in IST (UTC+05:30), independent of the server's own timezone.
 * "Saturday 11 மணிக்கு", "நாளைக்கு evening", "tomorrow 5 pm", "18 ஆம் தேதி காலை" ...
 */
import { norm } from './text.js';

/** norm() but keeps the colon/dot inside clock times (17:30, 5.30pm). */
function normWhen(text: string): string {
  return norm((text ?? '').replace(/(\d)[:.](\d)/g, '$1\u00a7$2')).replace(/\u00a7/g, ':');
}

const IST_MIN = 330;

export type IstParts = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

export function istParts(date: Date): IstParts {
  const d = new Date(date.getTime() + IST_MIN * 60_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** Build the instant for an IST wall-clock time. */
export function istDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - IST_MIN * 60_000);
}

export function addIstDays(date: Date, days: number): IstParts {
  const p = istParts(date);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), weekday: base.getUTCDay(), hour: 0, minute: 0 };
}

const WEEKDAYS: Array<[number, string[]]> = [
  [0, ['sunday', 'sun', 'ஞாயிறு', 'ஞாயிற்றுக்கிழமை', 'gnayiru', 'gnayitru', 'nyayiru', 'ஞாயிறன்று']],
  [1, ['monday', 'mon', 'திங்கள்', 'திங்கட்கிழமை', 'thingal', 'thingalkilamai']],
  [2, ['tuesday', 'tue', 'tues', 'செவ்வாய்', 'செவ்வாய்க்கிழமை', 'sevvai', 'sevvaai']],
  [3, ['wednesday', 'wed', 'புதன்', 'புதன்கிழமை', 'budhan', 'puthan']],
  [4, ['thursday', 'thu', 'thur', 'thurs', 'வியாழன்', 'வியாழக்கிழமை', 'viyazhan', 'vyazhan']],
  [5, ['friday', 'fri', 'வெள்ளி', 'வெள்ளிக்கிழமை', 'velli', 'vellikilamai']],
  [6, ['saturday', 'sat', 'சனி', 'சனிக்கிழமை', 'சனிக்கிழமையன்று', 'sani', 'sanikilamai']],
];

const TODAY = ['today', 'இன்னைக்கு', 'இன்று', 'இன்னிக்கு', 'innaikku', 'innikku', 'indru'];
const TOMORROW = ['tomorrow', 'tmrw', 'tmr', 'tomo', 'tommorow', 'tommorrow', 'tomorow', 'tomorrw', 'நாளை', 'நாளைக்கு', 'நாளைக்', 'naalaikku', 'nalaikku', 'naalaiku', 'nalaiku', 'naalaikki', 'naalaiki', 'naalai', 'nalai', 'naaliku', 'naalikku'];
const DAY_AFTER = ['நாளன்னைக்கு', 'நாளை மறுநாள்', 'மறுநாள்', 'naalanaikku', 'naalaiyanaikku', 'day after tomorrow'];

const MONTHS: Array<[number, string[]]> = [
  [1, ['january', 'jan', 'ஜனவரி']], [2, ['february', 'feb', 'பிப்ரவரி']], [3, ['march', 'mar', 'மார்ச்']],
  [4, ['april', 'apr', 'ஏப்ரல்']], [5, ['may', 'மே']], [6, ['june', 'jun', 'ஜூன்']],
  [7, ['july', 'jul', 'ஜூலை']], [8, ['august', 'aug', 'ஆகஸ்ட்']], [9, ['september', 'sep', 'sept', 'செப்டம்பர்']],
  [10, ['october', 'oct', 'அக்டோபர்']], [11, ['november', 'nov', 'நவம்பர்']], [12, ['december', 'dec', 'டிசம்பர்']],
];

const MORNING = ['morning', 'காலை', 'காலைல', 'காலையில', 'kaalai', 'kalai', 'kaalaila', 'am'];
const AFTERNOON = ['afternoon', 'மதியம்', 'மத்தியானம்', 'madhiyam', 'mathiyam', 'madhyanam'];
const EVENING = ['evening', 'eve', 'சாயங்காலம்', 'மாலை', 'மாலையில்', 'saayangaalam', 'sayangalam', 'sayankalam', 'saayankaalam', 'maalai', 'eveningla'];
const NIGHT = ['night', 'இரவு', 'ராத்திரி', 'நைட்', 'நைட்டு', 'iravu', 'raathiri', 'nightla'];
const MANI = ['மணி', 'மணிக்கு', 'மணிக்', 'mani', 'manikku', "o'clock", 'oclock', 'clock'];

export type WhenDraft = {
  /** Calendar date (IST) if one was named. */
  date?: { year: number; month: number; day: number };
  /** Hour/minute (24h IST) if a time was named or implied by part of day. */
  hour?: number;
  minute?: number;
  /** True when the time came only from "morning/evening" (default 10:00 / 15:00 / 18:00). */
  fromPartOfDay?: boolean;
  /** An hour like "8" that could be AM or PM and no part of day was given. */
  ambiguousHour?: number;
  /** Something that looks like a date/time was said but could not be resolved reliably. */
  unresolved?: boolean;
  /** The date came from a weekday name only ("Tuesday"), not a calendar date. */
  fromWeekday?: boolean;
};

const has = (n: string, list: string[]) => list.some((w) => ` ${n} `.includes(` ${w} `));

function weekdayOf(n: string): number | undefined {
  for (const [idx, names] of WEEKDAYS) {
    // Tamil words are often suffixed (சனிக்கிழமை, சனியன்று) so allow a Tamil-script prefix match.
    for (const w of names) {
      if (` ${n} `.includes(` ${w} `)) return idx;
      if (/[஀-௿]/u.test(w) && n.split(' ').some((t) => t.startsWith(w) && w.length >= 3)) return idx;
    }
  }
  return undefined;
}

function monthOf(token: string): number | undefined {
  for (const [idx, names] of MONTHS) if (names.includes(token)) return idx;
  return undefined;
}

let lastDateViaWeekday = false;
/** Reads the date part: today / tomorrow / weekday / "10 October" / "18 ஆம் தேதி". */
function readDate(n: string, now: Date): WhenDraft['date'] | undefined {
  const base = istParts(now);
  const toDate = (p: { year: number; month: number; day: number }) => ({ year: p.year, month: p.month, day: p.day });

  if (has(n, DAY_AFTER)) return toDate(addIstDays(now, 2));
  if (has(n, TOMORROW)) return toDate(addIstDays(now, 1));
  if (has(n, TODAY)) return toDate(addIstDays(now, 0));

  // Explicit "10 october", "october 10", "10th oct", "10 ஆம் தேதி"
  const t = n.split(' ');
  for (let i = 0; i < t.length; i++) {
    const m = monthOf(t[i]);
    if (m) {
      const before = Number((t[i - 1] ?? '').replace(/(st|nd|rd|th)$/, ''));
      const after = Number((t[i + 1] ?? '').replace(/(st|nd|rd|th)$/, ''));
      const day = Number.isInteger(before) && before >= 1 && before <= 31 ? before : Number.isInteger(after) && after >= 1 && after <= 31 ? after : undefined;
      if (day) {
        let year = base.year;
        if (istDate(year, m, day, 23, 59).getTime() < now.getTime()) year += 1;
        return { year, month: m, day };
      }
    }
  }
  const dateWord = n.match(/(\d{1,2})\s*(?:ஆம்|ம்|ஆம)?\s*(?:தேதி|date|tareekh|thedhi|theti)/u) ?? n.match(/(?:^|\s)(\d{1,2})(?:st|nd|rd|th)(?:\s|$)/);
  if (dateWord) {
    const day = Number(dateWord[1]);
    if (day >= 1 && day <= 31) {
      let { year, month } = base;
      if (day < base.day) {
        month += 1;
        if (month > 12) { month = 1; year += 1; }
      }
      return { year, month, day };
    }
  }

  const wd = weekdayOf(n);
  if (wd !== undefined) {
    let delta = (wd - base.weekday + 7) % 7;
    if (delta === 0) delta = 7; // the same weekday means next week; the confirmation question shows the full date
    lastDateViaWeekday = true;
    return toDate(addIstDays(now, delta));
  }
  if (/\b(this )?weekend\b/.test(n)) {
    const delta = (6 - base.weekday + 7) % 7 || 7;
    return toDate(addIstDays(now, delta));
  }
  return undefined;
}

/** Spoken hour words: "பதினோரு மணி", "pathinoru mani", "rendu mani". */
const HOUR_WORDS: Record<string, number> = {
  'ஒரு': 1, 'ஒன்னு': 1, 'ரெண்டு': 2, 'இரண்டு': 2, 'மூணு': 3, 'மூன்று': 3, 'நாலு': 4, 'நான்கு': 4, 'அஞ்சு': 5, 'ஐந்து': 5, 'ஆறு': 6, 'ஏழு': 7,
  'எட்டு': 8, 'ஒன்பது': 9, 'ஒம்பது': 9, 'பத்து': 10, 'பதினொன்று': 11, 'பதினோரு': 11, 'பதினொரு': 11, 'பன்னிரண்டு': 12, 'பன்னெண்டு': 12, 'பன்னண்டு': 12,
  oru: 1, onnu: 1, rendu: 2, moonu: 3, naalu: 4, anju: 5, aaru: 6, ezhu: 7, ettu: 8, onbadhu: 9, ombadhu: 9, pathu: 10, padhu: 10,
  pathinoru: 11, padhinoru: 11, pathinonnu: 11, pannendu: 12, panirendu: 12, pannirendu: 12,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Hour in visiting-hours terms: 1-7 can only mean afternoon/evening; 8 alone is ambiguous. */
function visitHour(h: number, pm: boolean, morning: boolean): Pick<WhenDraft, 'hour' | 'minute' | 'ambiguousHour'> {
  if (pm && h < 12) h += 12;
  else if (!pm && !morning) {
    if (h <= 7) h += 12;
    else if (h === 8) return { ambiguousHour: 8 };
  }
  return { hour: h, minute: 0 };
}

/** Reads the time: "5 pm", "11:30", "11 மணிக்கு", or part of day. */
function readTime(n: string, hasDate = false): Pick<WhenDraft, 'hour' | 'minute' | 'fromPartOfDay' | 'ambiguousHour'> {
  const morning = has(n, MORNING.filter((w) => w !== 'am'));
  const afternoon = has(n, AFTERNOON);
  const evening = has(n, EVENING);
  const night = has(n, NIGHT);
  const pm = evening || night || afternoon;

  // 5:30 pm / 17:30 / 5.30pm
  let m = n.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (h <= 23 && min <= 59) {
      if (m[3] === 'pm' && h < 12) h += 12;
      else if (m[3] === 'am' && h === 12) h = 0;
      else if (!m[3] && h <= 7) h += 12;
      else if (!m[3] && pm && h < 12) h += 12;
      return { hour: h, minute: min };
    }
  }
  // 5 pm / 11am
  m = n.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (m) {
    let h = Number(m[1]);
    if (h >= 1 && h <= 12) {
      if (m[2] === 'pm' && h < 12) h += 12;
      if (m[2] === 'am' && h === 12) h = 0;
      return { hour: h, minute: 0 };
    }
  }
  // 11 மணிக்கு / 5 mani / 11 o'clock
  const maniAlt = MANI.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  m = n.match(new RegExp(`(?:^|\\s)(\\d{1,2})\\s*(?:${maniAlt})`, 'u'));
  if (m) {
    let h = Number(m[1]);
    if (h >= 1 && h <= 12) {
      if (pm && h < 12) h += 12;
      else if (!pm && !morning) {
        if (h <= 7) h += 12; // 1-7 can only mean the afternoon/evening in visiting hours
        else if (h === 8) return { ambiguousHour: 8 };
      }
      return { hour: h, minute: 0 };
    }
  }
  // "பதினோரு மணி" / "pathinoru mani" / "eleven o'clock"
  const toks = n.split(' ');
  for (let i = 0; i + 1 < toks.length; i++) {
    const h = HOUR_WORDS[toks[i]];
    if (h !== undefined && MANI.includes(toks[i + 1])) return visitHour(h, pm, morning);
  }
  // "morning 11", "tomorrow 11", "Saturday 4", "13 Oct 11": a lone 1-12 next to a day or part of day is the hour.
  // Numbers that are the day of the month, a budget, a BHK count or an ordinal are not.
  if (hasDate || morning || pm) {
    const candidates = toks
      .map((t, i) => ({ t, i }))
      .filter(({ t, i }) => {
        if (!/^\d{1,2}$/.test(t)) return false;
        const v = Number(t);
        if (v < 1 || v > 12) return false;
        const prev = toks[i - 1] ?? '';
        const next = toks[i + 1] ?? '';
        // The day of "13 Oct" / "Oct 13" (readDate prefers the number before the month).
        if (monthOf(next)) return false;
        if (monthOf(prev)) {
          const dayBefore = Number((toks[i - 2] ?? '').replace(/(st|nd|rd|th)$/, ''));
          if (!(Number.isInteger(dayBefore) && dayBefore >= 1 && dayBefore <= 31)) return false;
        }
        if (/^(lakhs?|lacs?|l|cr|crores?|kodi|கோடி|லட்சம்|bhk|bed|bedroom|bedrooms|br|ஆம்|ம்|தேதி|date|th|st|nd|rd|days?|naal|நாள்)$/u.test(next)) return false;
        return true;
      });
    if (candidates.length === 1) return visitHour(Number(candidates[0].t), pm, morning);
  }
  // Part of day only
  if (morning) return { hour: 10, minute: 0, fromPartOfDay: true };
  if (afternoon) return { hour: 15, minute: 0, fromPartOfDay: true };
  if (evening) return { hour: 18, minute: 0, fromPartOfDay: true };
  if (night) return { hour: 19, minute: 0, fromPartOfDay: true };
  return {};
}

/** True if the utterance carries any date/time cue at all (used to refuse "yes" as a confirmation). */
export function hasWhenCue(text: string, now: Date = new Date()): boolean {
  const w = parseWhen(text, now);
  return Boolean(w.date || w.hour !== undefined || w.ambiguousHour !== undefined);
}

export function parseWhen(text: string, now: Date = new Date()): WhenDraft {
  const n = normWhen(text);
  if (!n) return {};
  const draft: WhenDraft = {};
  lastDateViaWeekday = false;
  const date = readDate(n, now);
  if (date) draft.date = date;
  if (date && lastDateViaWeekday) draft.fromWeekday = true;
  Object.assign(draft, readTime(n, Boolean(date)));
  return draft;
}

/** Merge a new reading over an earlier partial one (customer gives the day first, the time later). */
export function mergeWhen(previous: WhenDraft | undefined, next: WhenDraft): WhenDraft {
  const merged: WhenDraft = { ...(previous ?? {}) };
  // A weekday name never replaces a calendar date it agrees with ("13 October" then "Tuesday": still 13 October,
  // not the Tuesday a week later). A different weekday is a new day the customer chose; the confirmation question
  // reads the exact date back and a booking still needs an explicit yes.
  const sameWeekday = (a: NonNullable<WhenDraft['date']>, b: NonNullable<WhenDraft['date']>) =>
    new Date(Date.UTC(a.year, a.month - 1, a.day)).getUTCDay() === new Date(Date.UTC(b.year, b.month - 1, b.day)).getUTCDay();
  if (next.date && !(next.fromWeekday && previous?.date && !previous.fromWeekday && sameWeekday(previous.date, next.date))) {
    merged.date = next.date;
    merged.fromWeekday = next.fromWeekday;
  }
  if (next.hour !== undefined) {
    merged.hour = next.hour;
    merged.minute = next.minute ?? 0;
    merged.fromPartOfDay = next.fromPartOfDay;
    delete merged.ambiguousHour;
  } else if (next.ambiguousHour !== undefined) {
    merged.ambiguousHour = next.ambiguousHour;
  }
  return merged;
}

/** A complete draft becomes an instant; otherwise reports what is still missing. */
export function resolveWhen(draft: WhenDraft): { at: Date } | { missing: 'date' | 'time' | 'both' | 'ampm' } {
  const hasDate = Boolean(draft.date);
  const hasTime = draft.hour !== undefined;
  if (!hasDate && !hasTime) return { missing: draft.ambiguousHour !== undefined ? 'ampm' : 'both' };
  if (draft.ambiguousHour !== undefined && !hasTime) return { missing: 'ampm' };
  if (!hasDate) return { missing: 'date' };
  if (!hasTime) return { missing: 'time' };
  const { year, month, day } = draft.date!;
  return { at: istDate(year, month, day, draft.hour!, draft.minute ?? 0) };
}

const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_TA = ['ஞாயிற்றுக்கிழமை', 'திங்கட்கிழமை', 'செவ்வாய்க்கிழமை', 'புதன்கிழமை', 'வியாழக்கிழமை', 'வெள்ளிக்கிழமை', 'சனிக்கிழமை'];
const MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Human wording of an instant for the confirmation question and the booked message. */
export function describeWhen(at: Date, style: 'en' | 'ta' | 'tl'): string {
  const p = istParts(at);
  const date = `${p.day} ${MONTH_EN[p.month - 1]}`;
  const minutes = String(p.minute).padStart(2, '0');
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  if (style === 'en') {
    const ap = p.hour < 12 ? 'AM' : 'PM';
    return `${DAY_EN[p.weekday]}, ${date} at ${h12}${p.minute ? `:${minutes}` : ''} ${ap}`;
  }
  // Spoken Chennai Tamil: காலைல / மதியம் / சாயங்காலம் / நைட் (not the written காலை / மாலை / இரவு).
  const part = p.hour < 12 ? 'காலைல' : p.hour < 16 ? 'மதியம்' : p.hour < 19 ? 'சாயங்காலம்' : 'நைட்';
  const time = p.minute ? `${h12}:${minutes}` : `${h12}`;
  if (style === 'tl') {
    const partTl = p.hour < 12 ? 'morning' : p.hour < 16 ? 'afternoon' : p.hour < 19 ? 'evening' : 'night';
    return `${DAY_EN[p.weekday]} ${date} ${partTl} ${time} mani`;
  }
  return `${DAY_TA[p.weekday]} ${date} ${part} ${time} மணி`;
}

/** True when the text names a day or a time ("Tomorrow", "11 AM", "நாளைக்கு காலை ஒம்பது மணி"). */
export function mentionsWhen(text: string, now: Date = new Date()): boolean {
  const w = parseWhen(text, now);
  return Boolean(w.date || w.hour !== undefined || w.ambiguousHour !== undefined);
}

/**
 * Short spoken day + time for the phone (every word is TTS time): "நாளைக்கு 9 மணி", "tomorrow at 9 AM". Beyond
 * tomorrow the exact date stays ("திங்கக்கிழமை 19 October மதியம் 2 மணி"): a visit is never confirmed on a weekday alone. Morning hours carry no காலைல: visits are in business hours, so 9 / 10 / 11 can only be morning.
 * WhatsApp keeps the full describeWhen (a written record with the date).
 */
export function spokenWhen(at: Date, style: 'en' | 'ta' | 'tl', now: Date = new Date()): string {
  const p = istParts(at);
  const today = istParts(now);
  const diff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const time = p.minute ? `${h12}:${String(p.minute).padStart(2, '0')}` : `${h12}`;
  if (style === 'en') {
    const day = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : `${p.day} ${MONTH_EN[p.month - 1]}`;
    return `${day} at ${time} ${p.hour < 12 ? 'AM' : 'PM'}`;
  }
  if (style === 'tl') {
    const day = diff === 0 ? 'innaikku' : diff === 1 ? 'naalaikku' : `${p.day} ${MONTH_EN[p.month - 1]}`;
    const part = p.hour < 12 ? '' : p.hour < 15 ? 'madhiyam ' : 'saayangaalam ';
    return `${day} ${part}${time} mani`;
  }
  // Beyond tomorrow: the calendar date only (exact, and shorter than "செவ்வாய்க்கிழமை 13 October").
  const day = diff === 0 ? 'இன்னைக்கு' : diff === 1 ? 'நாளைக்கு' : `${p.day} ${MONTH_EN[p.month - 1]}`;
  // 3 PM is "சாயங்காலம் 3" on the phone ("three o'clock evening" was read back as மதியம், real call 2026-10-10).
  const part = p.hour < 12 ? '' : p.hour < 15 ? 'மதியம் ' : p.hour < 19 ? 'சாயங்காலம் ' : 'நைட் ';
  return `${day} ${part}${time} மணி`;
}

