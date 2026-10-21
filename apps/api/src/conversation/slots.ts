/**
 * Rules-first slot filling: location, budget, BHK, property type, timeline.
 * Runs in microseconds BEFORE the model, so the common "I want 2BHK in Porur, 80 lakhs" turn
 * needs no tool call and no extra model round trip, and the values are normalized deterministically.
 */
import { parseIndianBudget } from '../common/parsers.js';
import { hasPhrase, norm } from './text.js';

export type Slots = {
  location?: string;
  budget?: number;
  bhk?: number;
  propertyType?: string;
  timeline?: string;
};
export type SlotName = keyof Slots;
export type SlotExtraction = {
  slots: Slots;
  unknownLocation?: string;
  /** Places the customer explicitly turned down in this utterance ("Porur வேண்டாம்", "not Porur", "Porur-ku badhila"). */
  rejectedLocations?: string[];
  /** "vera area" / "other area" / "வேற இடம்": wants a different area, none named yet. */
  wantsOtherArea?: boolean;
};

/** Canonical name -> spellings (Latin, Tanglish, Tamil script). */
const LOCATION_ALIASES: Array<[string, string[]]> = [
  ['Porur', ['porur', 'போரூர்', 'போரூரில்', 'போரூர'] ],
  ['OMR', ['omr', 'ஓஎம்ஆர்', 'ஓ எம் ஆர்', 'old mahabalipuram road', 'rajiv gandhi salai']],
  ['Tambaram', ['tambaram', 'thambaram', 'தாம்பரம்']],
  ['Velachery', ['velachery', 'velacheri', 'வேளச்சேரி']],
  ['Guduvanchery', ['guduvanchery', 'kootuvanchery', 'kudduvancheri', 'கூடுவாஞ்சேரி', 'குடுவாஞ்சேரி']],
  ['Adyar', ['adyar', 'அடையாறு']],
  ['Anna Nagar', ['anna nagar', 'அண்ணா நகர்']],
  ['T Nagar', ['t nagar', 'தி நகர்', 'thyagaraya nagar']],
  ['Sholinganallur', ['sholinganallur', 'சோழிங்கநல்லூர்']],
  ['Pallavaram', ['pallavaram', 'பல்லாவரம்']],
  ['Chromepet', ['chromepet', 'குரோம்பேட்டை']],
  ['Madipakkam', ['madipakkam', 'மடிப்பாக்கம்']],
  ['Medavakkam', ['medavakkam', 'மேடவாக்கம்']],
  ['Perungudi', ['perungudi', 'பெருங்குடி']],
  ['Thoraipakkam', ['thoraipakkam', 'துரைப்பாக்கம்']],
  ['Navalur', ['navalur', 'நாவலூர்']],
  ['Siruseri', ['siruseri', 'சிறுசேரி']],
  ['Kelambakkam', ['kelambakkam', 'கேளம்பாக்கம்']],
  ['Poonamallee', ['poonamallee', 'பூந்தமல்லி']],
  ['Avadi', ['avadi', 'ஆவடி']],
  ['Ambattur', ['ambattur', 'அம்பத்தூர்']],
  ['Vadapalani', ['vadapalani', 'வடபழனி']],
  ['Guindy', ['guindy', 'கிண்டி']],
  ['Mylapore', ['mylapore', 'மயிலாப்பூர்']],
  ['Nungambakkam', ['nungambakkam', 'நுங்கம்பாக்கம்']],
  ['Perambur', ['perambur', 'பெரம்பூர்']],
  ['Thiruvanmiyur', ['thiruvanmiyur', 'திருவான்மியூர்']],
];

const SUFFIXES = ['la', 'le', 'il', 'ku', 'kku', 'side', 'area', 'pakkam', 'ல', 'இல்', 'ல்', 'க்கு', 'ஏரியா', 'பக்கம்', 'லயும்', 'ல்ல'];

function tokenMatches(token: string, alias: string): boolean {
  if (token === alias) return true;
  const latin = /^[a-z]/.test(alias);
  if (token.startsWith(alias)) {
    const rest = token.slice(alias.length);
    if (latin && alias.length < 4) return SUFFIXES.includes(rest); // OMR/T-style short names need a real suffix
    if (!latin && alias.length < 3) return false;
    return rest === '' || SUFFIXES.includes(rest) || /^[-]/.test(rest) || !latin; // Tamil agglutination: போரூர்லயும்
  }
  return false;
}

export function findLocation(text: string, knownLocations: readonly string[] = []): string | undefined {
  const n = norm(text);
  if (!n) return undefined;
  const toks = n.split(' ');
  const table: Array<[string, string[]]> = [...LOCATION_ALIASES];
  for (const known of knownLocations) {
    const first = known.split(',')[0].trim();
    if (first && !table.some(([c]) => c.toLowerCase() === first.toLowerCase())) table.push([first, [first.toLowerCase()]]);
  }
  for (const [canonical, aliases] of table) {
    for (const alias of aliases.map(norm)) {
      if (alias.includes(' ') ? hasPhrase(n, alias) : toks.some((t) => tokenMatches(t, alias))) return canonical;
    }
  }
  return undefined;
}

/** Every known place mentioned, in the order spoken, with the token position where it starts. */
function locationMentions(text: string, knownLocations: readonly string[] = []): Array<{ canonical: string; at: number; end: number }> {
  const n = norm(text);
  if (!n) return [];
  const toks = n.split(' ');
  const table: Array<[string, string[]]> = [...LOCATION_ALIASES];
  for (const known of knownLocations) {
    const first = known.split(',')[0].trim();
    if (first && !table.some(([c]) => c.toLowerCase() === first.toLowerCase())) table.push([first, [first.toLowerCase()]]);
  }
  const found: Array<{ canonical: string; at: number; end: number }> = [];
  for (const [canonical, aliases] of table) {
    for (const alias of aliases.map(norm)) {
      const words = alias.split(' ');
      for (let i = 0; i + words.length <= toks.length; i++) {
        const hit = words.length === 1 ? tokenMatches(toks[i], alias) : words.every((w, k) => toks[i + k] === w);
        if (hit && !found.some((f) => f.at === i)) found.push({ canonical, at: i, end: i + words.length - 1 });
      }
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Words that turn the place just before them down: "Porur venda", "Porur-ல வேண்டாம்". */
const NEG_AFTER = new Set(['venda', 'vendaam', 'vendam', 'venam', 'venaam', 'vena', 'வேண்டாம்', 'வேணாம்', 'வேணா', 'வேண்டா', 'வேண்டாங்க', 'வேணாங்க', 'vendanga', 'venanga']);
/** "illa" negates a place only when another place is given instead ("Porur la illa, Velachery la"). */
const SOFT_NEG_AFTER = new Set(['illa', 'illai', 'இல்ல', 'இல்லை', 'not']);
/** Words before a place that turn it down: "not Porur", "instead of Porur", "except Porur". */
const NEG_BEFORE = ['not', 'except', 'apart from', 'other than', 'instead of'];
/** "Porur-ku badhila Velachery" / "Porur-க்கு பதிலா Velachery": the first is replaced. */
const INSTEAD_AFTER = new Set(['badhila', 'bathila', 'badhilaa', 'pathila', 'பதிலா', 'பதிலாக', 'பதில்']);
const PLACE_SUFFIX_TOKENS = new Set(['la', 'le', 'il', 'ku', 'kku', 'side', 'area', 'pakkam', 'ல', 'இல்', 'க்கு', 'ஏரியா', 'பக்கம்', 'ல்ல', 'லயும்', 'property', 'properties', 'ப்ராப்பர்ட்டி']);

const OTHER_AREA = [
  'other area', 'another area', 'different area', 'some other area', 'other location', 'another location', 'other place', 'another place',
  'vera area', 'vera edam', 'vera idam', 'vera idathula', 'vera location', 'vera place', 'vera side', 'vera areala', 'vera area la',
  'வேற area', 'வேற ஏரியா', 'வேற இடம்', 'வேற இடத்துல', 'வேற location', 'வேற place', 'வேற பக்கம்',
];

export function wantsOtherArea(text: string): boolean {
  const n = norm(text);
  return OTHER_AREA.some((p) => hasPhrase(n, norm(p)));
}

/**
 * Where the customer wants to look, honouring corrections in the same breath:
 *   "எனக்கு Porur-ல வேண்டாம், Velachery-ல வேணும்" -> Velachery (Porur rejected)
 *   "Porur venda Velachery venum" / "Porur-ku badhila Velachery" / "not Porur, Velachery" -> Velachery
 *   "Porur venda" -> no location, Porur rejected
 */
export function resolveLocation(text: string, knownLocations: readonly string[] = []): { location?: string; rejected: string[] } {
  const mentions = locationMentions(text, knownLocations);
  if (mentions.length === 0) return { rejected: [] };
  const toks = norm(text).split(' ');
  const rejected = new Set<string>();
  for (const m of mentions) {
    // Look past place suffixes ("Porur la", "Porur-ல") at the next two words.
    let j = m.end + 1;
    while (j < toks.length && PLACE_SUFFIX_TOKENS.has(toks[j])) j++;
    const next = toks.slice(j, j + 2);
    const before = toks.slice(Math.max(0, m.at - 2), m.at).join(' ');
    const others = mentions.some((o) => o.canonical !== m.canonical);
    if (next.some((t) => NEG_AFTER.has(t) || INSTEAD_AFTER.has(t))) rejected.add(m.canonical);
    else if (others && next.some((t) => SOFT_NEG_AFTER.has(t))) rejected.add(m.canonical);
    else if (NEG_BEFORE.some((w) => ` ${before} `.endsWith(` ${w} `))) rejected.add(m.canonical);
  }
  const wanted = mentions.find((m) => !rejected.has(m.canonical));
  return { location: wanted?.canonical, rejected: [...rejected].filter((r) => r !== wanted?.canonical) };
}

/** "Chromepet la venum" with a place we have no alias for: lets the caller ask for confirmation instead of guessing. */
function guessUnknownLocation(text: string): string | undefined {
  const m = text.match(/\b([A-Za-z][A-Za-z.\- ]{2,24}?)\s*(?:la|le|side|area|pakkam)\b/i);
  const word = m?.[1]?.trim();
  if (!word) return undefined;
  const stop = new Set(['the', 'this', 'that', 'my', 'your', 'our', 'any', 'some', 'near', 'in', 'at', 'on', 'for', 'budget', 'bhk', 'flat', 'villa', 'plot', 'house', 'apartment', 'other', 'another', 'different', 'vera', 'same', 'nearby', 'near by', 'enga', 'entha', 'endha', 'which', 'adhe', 'athe']);
  if (word.split(/\s+/).some((w) => stop.has(w.toLowerCase()))) return undefined;
  return word.replace(/\b\w/g, (c) => c.toUpperCase());
}

const TAMIL_NUMBER_WORDS: Record<string, number> = {
  'ஒன்று': 1, 'ஒரு': 1, 'ஒன்னு': 1, 'ஒண்ணு': 1, 'இரண்டு': 2, 'ரெண்டு': 2, 'மூன்று': 3, 'மூணு': 3, 'நான்கு': 4, 'நாலு': 4,
  'ஐந்து': 5, 'அஞ்சு': 5, 'ஆறு': 6, 'ஏழு': 7, 'எட்டு': 8, 'ஒன்பது': 9, 'ஒம்பது': 9, 'பத்து': 10, 'இருபது': 20, 'முப்பது': 30,
  'நாற்பது': 40, 'நாப்பது': 40, 'ஐம்பது': 50, 'அம்பது': 50, 'அறுபது': 60, 'எழுபது': 70, 'எழுவது': 70, 'எண்பது': 80, 'தொண்ணூறு': 90, 'நூறு': 100,
  'seventy': 70, 'eighty': 80, 'ninety': 90,
};
const EN_NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  oru: 1, orey: 1, onnu: 1, rendu: 2, moonu: 3, naalu: 4, anju: 5, aaru: 6, ezhu: 7, ettu: 8, onbadhu: 9, pathu: 10, irubadhu: 20, muppadhu: 30, naarpadhu: 40, aimbadhu: 50, arubadhu: 60, ezhubadhu: 70, enbadhu: 80, thonnooru: 90, nooru: 100 };

function numberToken(t: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return TAMIL_NUMBER_WORDS[t] ?? EN_NUMBER_WORDS[t];
}

const UNIT_TOKENS = /^(lakhs?|lacs?|lakh|lak|l|cr|crs?|crores?|கோடி|லட்சம்|லட்ச|லட்சத்துக்குள்ள|லட்சத்தில|latcham|kodi|million|mn)$/u;

/** norm() that keeps decimals ("1.2") and strips digit-group commas ("80,00,000"). */
function normNumeric(text: string): string {
  const spaced = (text ?? '')
    .replace(/(\d),(?=\d)/g, '$1')
    // "80L", "80lakhs", "1.2cr", "1cr" -> "80 L", "1.2 cr"
    .replace(/(\d)(lakhs?|lacs?|lakh|l|cr|crores?)\b/gi, '$1 $2');
  return norm(spaced.replace(/(\d)\.(\d)/g, '$1\u00a7$2')).replace(/\u00a7/g, '.');
}

export function findBudget(text: string, expecting?: SlotName): number | undefined {
  const toks = normNumeric(text).split(' ').filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    if (!UNIT_TOKENS.test(toks[i])) continue;
    // "1.2 cr" / "80 lakhs": the nearest digit token is the value.
    // "eighty five lakhs" / "எண்பது லட்சம்": up to three number words are summed.
    let value: number | undefined;
    const nearest = toks[i - 1];
    if (nearest !== undefined && /^\d+(\.\d+)?$/.test(nearest)) {
      value = Number(nearest);
    } else {
      const parts: number[] = [];
      for (let j = i - 1; j >= 0 && parts.length < 3; j--) {
        const v = numberToken(toks[j]);
        if (v === undefined || /^\d/.test(toks[j])) break;
        parts.unshift(v);
      }
      if (parts.length) value = parts.reduce((a, b) => a + b, 0);
    }
    if (value !== undefined) {
      const unit = toks[i].startsWith('cr') || toks[i] === 'கோடி' || toks[i] === 'kodi' ? 'crore' : toks[i].startsWith('m') ? 'million' : 'lakhs';
      const parsed = parseIndianBudget(`${value} ${unit}`);
      if (parsed) return parsed;
    }
  }
  // A bare number is a budget only when we just asked for the budget ("80" -> 80 lakhs).
  if (expecting === 'budget') {
    const m = normNumeric(text).match(/(?:^|\s)(\d{2,8}(?:\.\d+)?)(?:\s|$)/);
    if (m) return parseIndianBudget(Number(m[1]));
  }
  return undefined;
}

const BHK_WORDS = '(?:bhk|bhk\'?s|bed(?:room)?s?|br|பிஹெச்கே|பிஎச்கே|பீஎச்கே|பி எச் கே|பீ எச் கே|பி ஹெச் கே)';
export function findBhk(text: string, expecting?: SlotName): number | undefined {
  const n = norm(text);
  const digit = n.match(new RegExp(`(?:^|\\s)(\\d)\\s*${BHK_WORDS}(?:\\s|$)`, 'u'));
  if (digit) return Number(digit[1]);
  const toks = n.split(' ');
  for (let i = 0; i < toks.length; i++) {
    const v = numberToken(toks[i]);
    if (v !== undefined && v >= 1 && v <= 6 && new RegExp(`^${BHK_WORDS}$`, 'u').test(toks.slice(i + 1, i + 5).join(' ').split(' ')[0] ?? '')) return v;
    if (v !== undefined && v >= 1 && v <= 6 && /^(பி|பீ)\b/u.test(toks.slice(i + 1).join(' ')) && /எச்|ஹெச்/u.test(toks.slice(i + 1, i + 3).join(' '))) return v;
  }
  if (expecting === 'bhk') {
    const bare = n.match(/(?:^|\s)([1-6])(?:\s|$)/);
    if (bare) return Number(bare[1]);
    for (const t of toks) {
      const v = numberToken(t);
      if (v !== undefined && v >= 1 && v <= 6) return v;
    }
  }
  return undefined;
}

const TYPE_WORDS: Array<[string, string[]]> = [
  ['Apartment', ['apartment', 'apartments', 'flat', 'flats', 'அப்பார்ட்மெண்ட்', 'அபார்ட்மெண்ட்', 'அப்பார்ட்மென்ட்', 'ஃப்ளாட்', 'ஃபிளாட்']],
  ['Villa', ['villa', 'villas', 'வில்லா']],
  ['Plot', ['plot', 'plots', 'land', 'நிலம்', 'ப்ளாட்', 'பிளாட்', 'manai', 'மனை']],
  ['House', ['house', 'independent house', 'individual house', 'veedu', 'வீடு']],
  ['Commercial', ['commercial', 'shop', 'office', 'கமர்ஷியல்']],
];
export function findPropertyType(text: string): string | undefined {
  const n = norm(text);
  const toks = n.split(' ');
  for (const [canonical, words] of TYPE_WORDS) {
    for (const w of words) {
      if (w.includes(' ') ? hasPhrase(n, w) : toks.some((t) => t === w || (/[஀-௿]/u.test(w) && t.startsWith(w)))) return canonical;
    }
  }
  return undefined;
}

export function findTimeline(text: string): string | undefined {
  const n = norm(text);
  let m = n.match(/\b(?:within|in|next|after)\s+(\d+\s+)?(day|days|week|weeks|month|months|year|years)\b/);
  if (m) return `${m[0]}`.trim();
  m = n.match(/(\d+)\s*(மாசத்துல|மாசம்|மாதம்|மாதத்துக்குள்ள|months?)/u);
  if (m) return `within ${m[1]} months`;
  if (/\b(immediately|urgent|urgently|asap|right away|this month)\b/.test(n) || /உடனே|இந்த மாசம்|udane|udanae/u.test(n)) return 'immediately';
  if (/\b(this year)\b/.test(n) || /இந்த வருஷம்/u.test(n)) return 'this year';
  if (/\b(next year)\b/.test(n) || /அடுத்த வருஷம்/u.test(n)) return 'next year';
  return undefined;
}

export function extractSlots(text: string, opts: { knownLocations?: readonly string[]; expecting?: SlotName } = {}): SlotExtraction {
  const slots: Slots = {};
  const { location, rejected } = resolveLocation(text, opts.knownLocations);
  if (location) slots.location = location;
  const budget = findBudget(text, opts.expecting);
  if (budget) slots.budget = budget;
  const bhk = findBhk(text, opts.expecting);
  if (bhk) slots.bhk = bhk;
  const propertyType = findPropertyType(text);
  if (propertyType) slots.propertyType = propertyType;
  const timeline = findTimeline(text);
  if (timeline) slots.timeline = timeline;
  const otherArea = wantsOtherArea(text);
  const unknownLocation = location || rejected.length || otherArea ? undefined : guessUnknownLocation(text);
  return { slots, unknownLocation, ...(rejected.length ? { rejectedLocations: rejected } : {}), ...(otherArea ? { wantsOtherArea: true } : {}) };
}

/** Plots have no BHK; every other type needs BHK or type for a meaningful search. */
export function qualificationState(s: Slots) {
  const missing: SlotName[] = [];
  if (!s.location) missing.push('location');
  if (!s.budget) missing.push('budget');
  if (!s.bhk && !s.propertyType) missing.push('bhk');
  return { complete: missing.length === 0, missing, next: missing[0] as SlotName | undefined };
}

export function slotsEqual(a: Slots, b: Slots): boolean {
  return a.location === b.location && a.budget === b.budget && a.bhk === b.bhk && a.propertyType === b.propertyType;
}
