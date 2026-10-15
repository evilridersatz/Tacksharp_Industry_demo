/**
 * Reading customer feedback deterministically (WhatsApp replies and call transcripts), in English,
 * Tanglish and Tamil script. Pure functions, unit-tested.
 */

const lower = (t: string) => ` ${(t ?? '').toLowerCase().normalize('NFC').replace(/[.,!?;:"'()*]/g, ' ').replace(/\s+/g, ' ').trim()} `;

/** STOP / unsubscribe in any of the three languages. Must be the whole message (or nearly), so "don't stop" is not an opt-out. */
export function isStop(text: string): boolean {
  const t = lower(text).trim();
  return /^(stop|stop all|unsubscribe|opt out|optout|cancel messages|no more messages|stop messages|stop pannunga|message vendam|messages vendam|anuppa vendam|நிறுத்து|நிறுத்துங்க|ஸ்டாப்|மெசேஜ் வேண்டாம்)$/.test(t);
}

export function isStart(text: string): boolean {
  const t = lower(text).trim();
  return /^(start|unstop|subscribe|resume|ஸ்டார்ட்)$/.test(t);
}

const WORD_RATING: Array<[RegExp, number]> = [
  [/ (one|oru|onnu|ஒன்னு|ஒன்று|ஒரு) /, 1],
  [/ (two|rendu|randu|ரெண்டு|இரண்டு) /, 2],
  [/ (three|moonu|munu|மூணு|மூன்று) /, 3],
  [/ (four|naalu|nalu|நாலு|நான்கு) /, 4],
  [/ (five|anju|ainthu|அஞ்சு|ஐந்து) /, 5],
];

/**
 * A 1-5 rating. WhatsApp: the reply is the number ("5", "4 stars", "5/5", "⭐⭐⭐⭐"). Calls: the number may be inside a
 * sentence ("romba nalla irundhuchu, anju kudukuren"), so `inSentence` also accepts number words anywhere.
 */
export function readRating(text: string, inSentence = false): number | undefined {
  const raw = (text ?? '').trim();
  const stars = (raw.match(/⭐|★/g) ?? []).length;
  if (stars >= 1 && stars <= 5 && raw.replace(/⭐|★|\s/g, '') === '') return stars;
  const t = lower(raw);
  const strict = t.trim().match(/^([1-5])(?:\s*(?:\/\s*5|stars?|star|out of 5|mark|marks))?$/);
  if (strict) return Number(strict[1]);
  if (!inSentence) return undefined;
  const digit = t.match(/ ([1-5])(?:\s*(?:\/\s*5|stars?|out of 5))? /);
  if (digit) return Number(digit[1]);
  for (const [re, n] of WORD_RATING) if (re.test(t)) return n;
  // Clear sentiment without a number (calls): very good = 5, bad = 2.
  if (/ (romba nalla|super|excellent|very good|semma|சூப்பர்|ரொம்ப நல்லா|ரொம்ப நல்ல) /.test(t)) return 5;
  if (/ (nalla irundhuchu|nalla irunthuchu|good|nice|fine|நல்லா இருந்துச்சு|நல்லா இருந்தது|நல்லா) /.test(t)) return 4;
  return undefined;
}

/** Words that mean something went wrong, whatever the rating. */
export function isComplaint(text: string): boolean {
  const t = lower(text);
  return /( complaint| bad | worst| not fresh| smell| stale| late | wrong | missing| refund| problem| issue| rude| dirty| fresh ah illa| fresh-ah illa| nalla illa| nalla illai| mosam| kevalam| naathu| naatham| sariyilla| sari illa| கெட்டு| நாத்தம்| மோசம்| சரியில்ல| நல்லா இல்ல| பிரச்சனை| கம்ப்ளைன்ட்)/.test(t);
}

/** Outcome of a feedback (from WhatsApp or a call): escalate when the rating is 1-2 or the words are a complaint. */
export function assessFeedback(text: string, inSentence: boolean): { rating?: number; complaint: boolean } {
  const rating = readRating(text, inSentence);
  const complaint = isComplaint(text) || (rating !== undefined && rating <= 2);
  return { rating, complaint };
}
