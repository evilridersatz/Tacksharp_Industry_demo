/**
 * Deterministic normalizers. The LLM passes values the way the customer said them;
 * these turn them into consistent numbers so accuracy doesn't depend on the model.
 */

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100,
  // Tamil (romanized)
  onnu: 1, rendu: 2, moonu: 3, naalu: 4, anju: 5,
  irupathu: 20, muppathu: 30, naarpathu: 40, aimbathu: 50, arubathu: 60,
  ezhupathu: 70, enbathu: 80, thonnooru: 90, nooru: 100,
};

function wordsToNumber(text: string): number | undefined {
  // "eighty five" -> 85, "seventy" -> 70
  const tokens = text.toLowerCase().split(/[\s-]+/);
  let total = 0;
  let found = false;
  for (const token of tokens) {
    const value = WORD_NUMBERS[token];
    if (value !== undefined) {
      total += value;
      found = true;
    }
  }
  return found ? total : undefined;
}

const UNIT_PATTERNS: Array<[RegExp, number]> = [
  [/^(crores?|cr|கோடி|kodi)/, 10_000_000],
  [/^(lakhs?|lacs?|லட்சம்|latcham|l)\b/, 100_000],
  [/^(lakhs?|lacs?|லட்சம்|latcham)/, 100_000],
  [/^(million|mn)\b/, 1_000_000],
  [/^(thousand|k)\b/, 1_000],
];

function unitAfter(rest: string): number | undefined {
  const t = rest.trimStart();
  for (const [pattern, multiplier] of UNIT_PATTERNS) {
    if (pattern.test(t)) return multiplier;
  }
  return undefined;
}

/**
 * "80 lakhs" | "80L" | "8000000" | "8 million" | "1.2 cr" | "1 crore" | "80 லட்சம்" |
 * "eighty lakhs" | "80-90 lakhs" | "85 lakh to 1 crore"  -> rupees (upper bound of a range)
 */
export function parseIndianBudget(input: number | string | null | undefined): number | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return undefined;
    if (input < 1000) return Math.round(input * 100_000); // "budget 80" => 80 lakhs
    return Math.round(input);
  }

  const text = input.toLowerCase().replace(/,/g, '').replace(/₹|rs\.?|inr/g, ' ').trim();
  if (!text) return undefined;

  const matches = [...text.matchAll(/\d+(?:\.\d+)?/g)];
  const values: Array<{ value: number; unit?: number }> = matches.map((m) => ({
    value: Number(m[0]),
    unit: unitAfter(text.slice((m.index ?? 0) + m[0].length)),
  }));

  if (values.length === 0) {
    const word = wordsToNumber(text);
    if (word === undefined) return undefined;
    values.push({ value: word, unit: unitAfter(text.replace(/^[a-z\s-]*?(?=(crore|cr|lakh|lac|million|thousand|கோடி|லட்சம்))/, '')) });
  }

  // "80-90 lakhs": a number without its own unit borrows the next number's unit.
  for (let i = values.length - 2; i >= 0; i--) {
    if (values[i].unit === undefined) values[i].unit = values[i + 1].unit;
  }

  const rupees = values.map(({ value, unit }) => {
    if (unit) return value * unit;
    return value < 1000 ? value * 100_000 : value;
  });
  const best = Math.max(...rupees);
  return best > 0 ? Math.round(best) : undefined;
}

/** "2BHK" | "2 bhk" | "2 bedroom" | "two bedroom" | "rendu BHK" | 2 -> 2 */
export function parseBhk(input: number | string | null | undefined): number | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === 'number') {
    return Number.isInteger(input) && input > 0 && input < 10 ? input : undefined;
  }
  const text = input.toLowerCase();
  const digit = text.match(/(\d+)\s*(bhk|bed|br\b|room)?/);
  if (digit) {
    const value = Number(digit[1]);
    return value > 0 && value < 10 ? value : undefined;
  }
  const word = wordsToNumber(text);
  return word && word > 0 && word < 10 ? word : undefined;
}

const PROPERTY_TYPES: Record<string, string> = {
  apartment: 'Apartment', apartments: 'Apartment', flat: 'Apartment', flats: 'Apartment',
  villa: 'Villa', villas: 'Villa',
  plot: 'Plot', plots: 'Plot', land: 'Plot', site: 'Plot', manai: 'Plot',
  house: 'House', houses: 'House', independent: 'House', veedu: 'House',
  commercial: 'Commercial', office: 'Commercial', shop: 'Commercial',
};

export function normalizePropertyType(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const text = input.trim().toLowerCase();
  for (const [key, value] of Object.entries(PROPERTY_TYPES)) {
    if (text === key || text.includes(key)) return value;
  }
  return input.trim();
}

/** Cleans "Porur la", "porur area", "Porur, Chennai" -> "Porur" */
export function normalizeLocation(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const cleaned = input
    .replace(/,?\s*chennai$/i, '')
    .replace(/\b(la|le|il|area|side|pakkam)\b$/i, '')
    .replace(/-?(ல|இல்)$/u, '')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function formatRupeesShort(value: number | string | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 10_000_000) return `${+(n / 10_000_000).toFixed(2)} crore`;
  if (n >= 100_000) return `${+(n / 100_000).toFixed(1)} lakhs`;
  return `${n}`;
}
