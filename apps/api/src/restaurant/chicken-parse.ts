/**
 * Deterministic reading of GR Chicken WhatsApp messages in Tanglish, Tamil script and English:
 * which product, how many kg, which cut, how they pay, when they will collect.
 *
 * "rendu kilo broiler curry cut, gpay, saayangaalam 6 mani varen"
 * "1.5 kg country chicken biryani cut"   "அரை கிலோ boneless"   "500 gm liver"
 *
 * Pure functions, no I/O. Nothing here sets a price; the engine validates everything against the
 * catalogue and the order is only placed after the customer confirms the server's summary.
 */
import { norm } from '../conversation/text.js';
import { istParts, istDate, mergeWhen, parseWhen, type WhenDraft } from '../conversation/when.js';

export type Product = {
  id: string;
  name: string;
  unit: 'kg' | 'piece';
  aliases: string[];
  cutOptions: string[];
  available: boolean;
};

export type ItemMention = {
  itemId: string;
  /** kg (unit = kg) or pieces (unit = piece). Undefined = not said yet. */
  quantity?: number;
  /** The unit the customer said with the quantity (kg/grams → kg, pieces/eggs → piece, a bare number → bare). */
  qtyUnit?: 'kg' | 'piece' | 'bare';
  /** One of the product's cutOptions. */
  cut?: string;
  matched: string;
  /**
   * Matched only through a generic word ("chicken", "kozhi", "சிக்கன்") that the shop maps to its default product.
   * Fine for an order ("1 kg chicken"); never treated as choosing that product in a question ("which chicken
   * is available?").
   */
  generic: boolean;
  /**
   * "nattukozhi muttai", "நாட்டுக்கோழி முட்டை", "kaadai muttai": eggs OF another product (country chicken eggs). The
   * words before the egg word, as said. Never read as an order for that product's meat.
   */
  variant?: string;
  /**
   * "broiler curry cut", "நாட்டு கோழி கறி கட்": the customer named a KIND of chicken and a cut. The cut words also name
   * a product of their own (e.g. Chicken Curry Cut); that product's id is kept here so it can be OFFERED if the kind
   * is not available — never substituted silently.
   */
  cutProduct?: string;
};

/** Egg words: a product named right before one of these is the kind of egg, not a second product. */
export const EGG_WORDS = new Set(['egg', 'eggs', 'muttai', 'முட்டை', 'முட்டைகள்']);

/** Words that mean "chicken" in general, not a particular product. */
export const GENERIC_PRODUCT_WORDS = new Set(['chicken', 'chickens', 'kozhi', 'koli', 'kozhi kari', 'கோழி', 'கோழிக்கறி']);

/**
 * Tamil-script spellings of the English words customers (and speech-to-text) use: "கண்ட்ரி சிக்கன்" is
 * "country chicken". Rewritten before parsing so one vocabulary serves Tamil, Tanglish and English, on WhatsApp
 * and on calls. Word-level only.
 */
const LOANWORDS: Record<string, string> = {
  சிக்கன்: 'chicken', சிக்கென்: 'chicken', கண்ட்ரி: 'country', கன்ட்ரி: 'country', பிராய்லர்: 'broiler', ப்ராய்லர்: 'broiler', பிராயிலர்: 'broiler',
  போன்லெஸ்: 'boneless', ஸ்கின்லெஸ்: 'skinless', லிவர்: 'liver', விங்ஸ்: 'wings', விங்: 'wing', எக்: 'egg', எக்ஸ்: 'eggs',
  ஸ்டாக்: 'stock', கர்ரி: 'curry', ஃப்ரை: 'fry', ப்ரை: 'fry', கட்: 'cut', ஹோல்: 'whole', அவைலபிள்: 'available', அவைலபில்: 'available',
  பிரைஸ்: 'price', ப்ரைஸ்: 'price', கிலோஸ்: 'kilos', லெக்: 'leg', லெக்ஸ்: 'legs', பீஸ்: 'piece', பீஸ்கள்: 'pieces', பீசு: 'piece',
  // Speech-to-text (Saaras, ta-IN / codemix) writes these English words in Tamil script on calls.
  ட்ரம்ஸ்டிக்: 'drumstick', ட்ரம்ஸ்டிக்ஸ்: 'drumsticks', டிரம்ஸ்டிக்: 'drumstick', டிரம்ஸ்டிக்ஸ்: 'drumsticks', ப்ரெஸ்ட்: 'breast', பிரெஸ்ட்: 'breast', ப்ரெஸ்ட்டு: 'breast',
  கேஜி: 'kg', கேஜிஸ்: 'kg', கிராம்ஸ்: 'grams', ஒன்: 'one', டூ: 'two', த்ரீ: 'three', ஃபோர்: 'four', ஃபைவ்: 'five', டஜன்: 'dozen',
  மெனு: 'menu', ஆர்டர்: 'order', ஓகே: 'ok', ஓக்கே: 'ok', யெஸ்: 'yes', எஸ்: 'yes', ப்ளீஸ்: 'please', ஹலோ: 'hello', ஹல்லோ: 'hello', கன்பார்ம்: 'confirm',
};
const LOANWORD_RE = new RegExp(`(^|\\s)(${Object.keys(LOANWORDS).sort((a, b) => b.length - a.length).join('|')})(?=\\s|$)`, 'g');
export function romanizeLoanwords(text: string): string {
  return text.replace(LOANWORD_RE, (_m, pre: string, word: string) => `${pre}${LOANWORDS[word]}`);
}

/** Quantity / cut said without naming a product ("3 kg", "curry cut") — applied to the product being discussed. */
export type Loose = { quantity?: number; qtyUnit?: 'kg' | 'piece' | 'bare'; cut?: string };

export type PaymentChoice = 'cash_at_shop' | 'upi_at_shop' | 'paid_online';

export type Intent =
  | 'confirm'
  | 'decline'
  | 'greeting'
  | 'offer'
  | 'menu'
  | 'order_status'
  | 'human'
  | 'thanks'
  | 'remove'
  | 'clear'
  | 'outlets'
  | 'delivery'
  | 'goodbye'
  /** "order pannanum", "ஆர்டர் பண்ணணும்", "I want to order": wants to order, nothing named yet. */
  | 'order_start'
  /** "Order place pannunga", "place the order", "அவ்வளவுதான்", "that's all": finished choosing — summary / place. */
  | 'done'
  /** "change பண்ணனும்", "மாற்றணும்", "I want to change": edit the order (at the review: not a yes, not a cancel). */
  | 'change'
  /** Logged only: the message carried order details (product / amount / payment) without a keyword intent. */
  | 'order_details'
  | 'unknown';

const pad = (t: string) => ` ${t} `;
const hasAny = (t: string, words: string[]) => words.some((w) => pad(t).includes(pad(w)));

/** norm() keeps Tamil; we also keep decimal points and fractions inside numbers ("1.5", "1 1/2"). */
export function clean(text: string): string {
  const protectedText = (text ?? '')
    // Clock times stay one token ("19:56", "7:05"): split by punctuation removal, "19:56" became "19 56" and the
    // parser read "19" as 19 kg whenever the minutes were above 50.
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, '$1¤$2')
    .replace(/(\d)[.,](\d)/g, '$1§$2')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1¶$2')
    .replace(/(\d)\s*(kg|kgs|kilo|kilos|g|gm|gms|gram|grams|kilogram|kilograms)\b/gi, '$1 $2');
  return romanizeLoanwords(norm(protectedText)).replace(/§/g, '.').replace(/¶/g, '/').replace(/¤/g, ':');
}

// ---------------------------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------------------------

const KG_WORDS = ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'கிலோ', 'கிலோவு', 'கிலோவும்', 'kilova'];
const GRAM_WORDS = ['g', 'gm', 'gms', 'gram', 'grams', 'கிராம்'];
const PIECE_WORDS = ['piece', 'pieces', 'pcs', 'pc', 'nos', 'egg', 'eggs', 'muttai', 'முட்டை'];

/** Number words (Tanglish / Tamil / English), including halves: arai = ½, kaal = ¼, mukkal = ¾, onnarai = 1½. */
const NUMBER_WORDS: Record<string, number> = {
  oru: 1, onnu: 1, one: 1, a: 1, an: 1, ஒரு: 1, ஒன்னு: 1, ஒன்று: 1,
  rendu: 2, randu: 2, irandu: 2, two: 2, ரெண்டு: 2, இரண்டு: 2,
  moonu: 3, munu: 3, three: 3, மூணு: 3, மூன்று: 3,
  naalu: 4, nalu: 4, four: 4, நாலு: 4, நான்கு: 4,
  anju: 5, ainthu: 5, five: 5, அஞ்சு: 5, ஐந்து: 5,
  aaru: 6, six: 6, ஆறு: 6, ezhu: 7, seven: 7, ஏழு: 7, ettu: 8, eight: 8, எட்டு: 8, pathu: 10, ten: 10, பத்து: 10,
  dozen: 12, dosen: 12,
  onbadhu: 9, ombadhu: 9, nine: 9, ஒன்பது: 9, ஒம்பது: 9, pannendu: 12, twelve: 12, பன்னிரண்டு: 12, பன்னெண்டு: 12,
  fifteen: 15, பதினைந்து: 15, பதினஞ்சு: 15, twenty: 20, irupathu: 20, இருபது: 20, thirty: 30, முப்பது: 30, forty: 40, நாற்பது: 40, fifty: 50, ஐம்பது: 50,
  // Grams said as words ("ஐநூறு கிராம்"): only meaningful before a gram word (findQuantities checks the unit).
  இருநூறு: 200, முன்னூறு: 300, நானூறு: 400, ஐநூறு: 500, எழுநூறு: 700,
  arai: 0.5, half: 0.5, அரை: 0.5, அரைக்: 0.5, அரக்: 0.5,
  kaal: 0.25, quarter: 0.25, கால்: 0.25,
  mukkal: 0.75, முக்கால்: 0.75,
  onnarai: 1.5, onarai: 1.5, ஒன்றரை: 1.5, ஒன்னரை: 1.5,
  rendarai: 2.5, randarai: 2.5, ரெண்டரை: 2.5,
  moonarai: 3.5, மூணரை: 3.5,
};

function numberAt(tokens: string[], i: number): { value: number; width: number } | undefined {
  const t = tokens[i];
  if (t === undefined) return undefined;
  // "1 1/2", "1/2"
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac) return { value: Number(frac[1]) / Number(frac[2]), width: 1 };
  if (/^\d+(\.\d+)?$/.test(t)) {
    const next = tokens[i + 1]?.match(/^(\d+)\/(\d+)$/);
    if (next) return { value: Number(t) + Number(next[1]) / Number(next[2]), width: 2 };
    // "1 and half", "1 and a half"
    if (tokens[i + 1] === 'and' && tokens[i + 2] === 'half') return { value: Number(t) + 0.5, width: 3 };
    if (tokens[i + 1] === 'and' && tokens[i + 2] === 'a' && tokens[i + 3] === 'half') return { value: Number(t) + 0.5, width: 4 };
    if (Number(t) >= 1 && (tokens[i + 1] === 'arai' || tokens[i + 1] === 'அரை')) return { value: Number(t) + 0.5, width: 2 };
    return { value: Number(t), width: 1 };
  }
  const w = NUMBER_WORDS[t];
  if (w !== undefined) {
    if (tokens[i + 1] === 'and' && tokens[i + 2] === 'half') return { value: w + 0.5, width: 3 };
    if (tokens[i + 1] === 'and' && tokens[i + 2] === 'a' && tokens[i + 3] === 'half') return { value: w + 0.5, width: 4 };
    // "half a kilo", "quarter of a kilo": the "a" is not "one" (it was read as 1 kg).
    if (w < 1 && (tokens[i + 1] === 'a' || tokens[i + 1] === 'an')) return { value: w, width: 2 };
    if (w < 1 && tokens[i + 1] === 'of' && (tokens[i + 2] === 'a' || tokens[i + 2] === 'an')) return { value: w, width: 3 };
    if (w >= 1 && (tokens[i + 1] === 'arai' || tokens[i + 1] === 'அரை')) return { value: w + 0.5, width: 2 };
    return { value: w, width: 1 };
  }
  return undefined;
}

// Only "not 6" rejects the number after it; "illa / no, 2 kg" is a correction TO that number ("no — make it 2 kg").
const NEGATE_BEFORE = new Set(['not']);
const NEGATE_AFTER = new Set(['illa', 'illai', 'alla', 'venam', 'vendam', 'vendaam', 'இல்ல', 'இல்லை', 'அல்ல', 'வேண்டாம்', 'வேணாம்']);
/** "only", "just", "need", "venum", "போதும்", "மட்டும்": the number in this message is THE amount (a correction). */
const CORRECTION_CUE = /\b(only|just|need|want|venum|vendum|podhum|pothum|mattum|correct ah|make it)\b|போதும்|மட்டும்|வேணும்/;
function isNegatedQty(toks: string[], q: QtyHit): boolean {
  if (NEGATE_BEFORE.has(toks[q.start - 1] ?? '')) return true;
  // the word after the number, or after its unit ("six pieces illa")
  const after = [toks[q.end + 1], toks[q.end + 2]].filter(Boolean);
  return after.some((w, i) => NEGATE_AFTER.has(w!) && (i === 0 || /^(pieces?|pcs|kg|kgs|kilo|kilos|egg|eggs|muttai|முட்டை|கிலோ)$/.test(after[0]!)));
}

export type QtyHit = { value: number; unit: 'kg' | 'piece' | 'bare'; start: number; end: number };

/** Every quantity in the message with its token span: "2 kg", "rendu kilo", "500 gm", "arai kilo", "12 eggs", or a bare "2". */
export function findQuantities(tokens: string[]): QtyHit[] {
  const hits: QtyHit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const n = numberAt(tokens, i);
    if (!n) {
      // "kilo" alone after a product = 1 kg is too vague; only "oru kilo" / "1 kg" count.
      continue;
    }
    const after = tokens[i + n.width];
    // The span covers the number only: a unit word may also be a product alias ("12 muttai").
    if (after && KG_WORDS.includes(after)) {
      hits.push({ value: n.value, unit: 'kg', start: i, end: i + n.width - 1 });
      i += n.width;
    } else if (after && GRAM_WORDS.includes(after)) {
      hits.push({ value: n.value / 1000, unit: 'kg', start: i, end: i + n.width - 1 });
      i += n.width;
    } else if (after && PIECE_WORDS.includes(after)) {
      hits.push({ value: n.value, unit: 'piece', start: i, end: i + n.width - 1 });
      i += n.width - 1;
    } else if (
      /^\d/.test(tokens[i]) ||
      ['arai', 'அரை', 'kaal', 'mukkal', 'onnarai', 'ஒன்றரை', 'rendarai', 'half', 'quarter'].includes(tokens[i]) ||
      // the whole message is just a number word ("எட்டு", "five") answering "how many?"
      (tokens.length <= 2 && !['a', 'an'].includes(tokens[i])) ||
      // a number word ending the sentence ("I need only four", "aaru illa, naalu")
      (!['a', 'an', 'oru'].includes(tokens[i]) && i + n.width >= tokens.length)
    ) {
      // A bare number ("2 broiler", "broiler 3") — only meaningful next to a product.
      // Clock times ("6 mani", "6 pm", "6:30") are not quantities.
      const nxt = tokens[i + n.width];
      if (nxt && /^(mani|pm|am|oclock|min|nimish|hour|hr|neram|மணி|நிமிஷ|நிமிட)/.test(nxt)) continue;
      if (/^\d{1,2}:\d{2}$/.test(tokens[i])) continue;
      if (Number(tokens[i]) > 50) continue; // phone numbers, years, order numbers
      hits.push({ value: n.value, unit: 'bare', start: i, end: i + n.width - 1 });
      i += n.width - 1;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------------------------

/** Customer words for each standard cut. The engine maps them onto the product's own cut options. */
export const CUT_SYNONYMS: Array<{ key: string; words: string[] }> = [
  { key: 'curry', words: ['curry cut', 'curry', 'kari cut', 'kari', 'small pieces', 'small piece', 'chinna piece', 'chinna pieces', 'chinna peace', 'சின்ன பீஸ்', 'சின்ன piece', 'கறி கட்', 'கறி', 'குழம்பு', 'kulambu', 'kuzhambu'] },
  { key: 'biryani', words: ['biryani cut', 'biriyani cut', 'briyani cut', 'biryani', 'biriyani', 'briyani', 'big pieces', 'big piece', 'periya piece', 'periya pieces', 'பெரிய பீஸ்', 'பெரிய piece', 'பிரியாணி'] },
  { key: 'fry', words: ['fry cut', 'fry', '65 cut', 'chilli cut', 'varuval', 'வறுவல்', 'ப்ரை'] },
  { key: 'whole', words: ['whole', 'full bird', 'muzhusa', 'muzhusaa', 'muzhusa venum', 'full ah', 'fulla', 'cut vendam', 'cut venam', 'cut panna vendam', 'முழுசா', 'முழுசாக'] },
];

/** Which cut (as the product names it) the message asks for, if any. */
export function findCut(text: string, cutOptions: string[]): string | undefined {
  const t = clean(text);
  for (const { key, words } of CUT_SYNONYMS) {
    if (!words.some((w) => pad(t).includes(pad(w)))) continue;
    const option = cutOptions.find((o) => clean(o).includes(key));
    if (option) return option;
  }
  // The shop's own option names ("Skinless curry cut") said literally.
  return cutOptions.find((o) => pad(t).includes(pad(clean(o))));
}

/** Any cut word at all (to know a cut was meant even when the product does not offer it). */
export function mentionsCut(text: string): string | undefined {
  const t = clean(text);
  return CUT_SYNONYMS.find(({ words }) => words.some((w) => pad(t).includes(pad(w))))?.key;
}

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------

function phrases(p: Product): string[][] {
  return [p.name, ...p.aliases].map((s) => clean(s).split(' ').filter(Boolean)).filter((x) => x.length);
}

/**
 * Products named in the message with the quantity and cut said next to each one.
 * Segments are split on "and / um / , / +" so "2 kg broiler curry cut and 1 kg country biryani cut"
 * gives each product its own quantity and cut. Longest alias wins ("country chicken" over "chicken").
 */
/**
 * Customer words for a product the catalogue lists under another name: "legs", "chicken legs", "kaal piece",
 * "கால் பீஸ்" are "leg piece" (Chicken Drumsticks lists "leg piece"). Only matches when the catalogue has the alias.
 */
function productSynonyms(t: string): string {
  return t
    .replace(/(^|\s)(?:kaal|கால்) (piece|pieces|peace)(?=\s|$)/g, '$1leg $2')
    .replace(/(^|\s)leg peace(?=\s|$)/g, '$1leg piece')
    .replace(/(^|\s)legs?(?!\s(?:piece|pieces|pc|pcs))(?=\s|$)/g, '$1leg piece');
}

type Candidate = { p: Product; phrase: string[] };
function candidatesFor(products: Product[]): Candidate[] {
  // Longest phrase first; on a tie (two products share an alias, e.g. "eggs") the product that is for sale wins over
  // one staff took off sale, so "12 eggs" is never read as the hidden product.
  return products
    .flatMap((p) => phrases(p).map((phrase) => ({ p, phrase: productSynonyms(phrase.join(' ')).split(' ') })))
    .sort((a, b) => b.phrase.length - a.phrase.length || Number(b.p.available) - Number(a.p.available));
}

export type Mention = { p: Product; start: number; end: number; generic: boolean; variant?: string; cutProduct?: string };
/**
 * Products named in a run of tokens, in order. Two rules keep one request one product:
 *  - a generic word ("chicken", "kozhi") right next to a named product is part of that name ("Chicken leg piece" is
 *    Chicken Drumsticks — not Drumsticks plus the shop's default chicken);
 *  - a product right before an egg word is the KIND of egg ("nattukozhi muttai" = country chicken eggs), not an order
 *    for that product.
 */
function matchProducts(toks: string[], candidates: Candidate[]): Mention[] {
  const used = new Array<boolean>(toks.length).fill(false);
  const found: Mention[] = [];
  for (const { p, phrase } of candidates) {
    for (let i = 0; i + phrase.length <= toks.length; i++) {
      if (phrase.every((w, j) => !used[i + j] && (toks[i + j] === w || toks[i + j] === `${w}s`))) {
        for (let j = 0; j < phrase.length; j++) used[i + j] = true;
        const matched = toks.slice(i, i + phrase.length).join(' ');
        found.push({ p, start: i, end: i + phrase.length - 1, generic: GENERIC_PRODUCT_WORDS.has(matched) || GENERIC_PRODUCT_WORDS.has(matched.replace(/s$/, '')) });
      }
    }
  }
  found.sort((a, b) => a.start - b.start);
  const isEgg = (m: Mention) => EGG_WORDS.has(toks[m.end]) || EGG_WORDS.has(toks[m.end].replace(/s$/, ''));
  const out: Mention[] = [];
  for (let idx = 0; idx < found.length; idx++) {
    const m = found[idx];
    const next = found[idx + 1];
    const prev = out[out.length - 1];
    // "chicken eggs", "kozhi muttai" are plain eggs: a generic word never makes a kind of egg.
    if (m.generic && ((next && !next.generic && next.start === m.end + 1) || (prev && !prev.generic && prev.end === m.start - 1))) continue;
    if (next && next.start === m.end + 1 && isEgg(next) && !isEgg(m)) {
      // "<product> muttai": the egg mention carries the kind; this product is not ordered.
      found[idx + 1] = { ...next, start: m.start, variant: toks.slice(m.start, m.end + 1).join(' ') };
      continue;
    }
    // "<kind> <cut product>" / "<cut product> <kind>": one request — the kind, with that cut.
    const cutLike = (x: Mention) => !!mentionsCut(toks.slice(x.start, x.end + 1).join(' ')) && !isEgg(x);
    if (next && next.start === m.end + 1 && !m.generic && !isEgg(m) && !cutLike(m) && cutLike(next)) {
      found[idx + 1] = { ...m, end: next.end, cutProduct: next.p.id };
      continue;
    }
    if (prev && prev.end === m.start - 1 && !m.generic && !isEgg(m) && !cutLike(m) && cutLike(prev) && !prev.cutProduct) {
      out[out.length - 1] = { ...m, start: prev.start, cutProduct: prev.p.id };
      continue;
    }
    out.push(m);
  }
  return out;
}

/** Tokens of a message as the product matcher reads them (cleaned, loanwords, product synonyms). */
export function productTokens(text: string): string[] {
  return productSynonyms(clean(text)).split(' ').filter(Boolean);
}

/** Every product mention in the whole message with its token position (see matchProducts). */
export function findMentions(text: string, products: Product[]): { toks: string[]; mentions: Mention[] } {
  const toks = productTokens(text);
  return { toks, mentions: matchProducts(toks, candidatesFor(products)) };
}

export function parseItems(text: string, products: Product[]): { items: ItemMention[]; loose: Loose } {
  const segments = (text ?? '')
    // Speech-to-text repeats ("five five", "5 5", "எட்டு எட்டு"): one number, not two.
    .replace(/(^|\s)(\S+)(?:\s+\2)+(?=\s|$)/g, (m, pre: string, w: string) => (/^\d+$/.test(w) || NUMBER_WORDS[w.toLowerCase()] !== undefined ? `${pre}${w}` : m))
    // "one and a half kg" is one quantity, not two order lines split on "and".
    .replace(/(\S+)\s+and\s+(?:a\s+)?half\b/gi, '$1 arai')
    .split(/[,;\n]+/)
    .map((x) => productSynonyms(clean(x)))
    .join('\n')
    .split(/\s(?:and|um|plus|apram|aprom|then|also|matrum|மற்றும்|அப்புறம்)\s|\s?\+\s?|\n/)
    .flatMap((s) => s.split(/\s{2,}/))
    .map((s) => s.trim())
    .filter(Boolean);
  const items: ItemMention[] = [];
  const loose: Loose = {};
  const candidates = candidatesFor(products);

  for (const seg of segments) {
    const toks = seg.split(' ');
    const found = matchProducts(toks, candidates);
    const used = new Array<boolean>(toks.length).fill(false);
    for (const f of found) for (let j = f.start; j <= f.end; j++) used[j] = true;
    // "not six (pieces)", "aaru illa", "ஆறு இல்ல": a quantity the customer is REJECTING is never taken.
    const qtys = findQuantities(toks)
      .filter((q) => !used.slice(q.start, q.end + 1).some(Boolean))
      .filter((q) => !isNegatedQty(toks, q));

    if (!found.length) {
      // "3 kg", "curry cut", "rendu kilo curry cut": belongs to the product being discussed.
      // A bare number counts in a short message, or in a correction ("I need only four", "நாலு போதும்").
      const q = qtys.find((x) => x.unit !== 'bare') ?? (qtys.length === 1 && (toks.length <= 3 || CORRECTION_CUE.test(seg)) ? qtys[0] : undefined);
      if (q) {
        loose.quantity = q.value;
        loose.qtyUnit = q.unit;
      }
      const cutKey = mentionsCut(seg);
      if (cutKey) loose.cut = cutKey;
      continue;
    }
    const taken = new Set<QtyHit>();
    found.forEach((f, idx) => {
      // Quantity: the nearest unused one in this product's share of the segment.
      const from = idx === 0 ? 0 : found[idx - 1].end + 1;
      const to = idx === found.length - 1 ? toks.length - 1 : found[idx + 1].start - 1;
      const own = qtys.filter((q) => q.start >= from && q.end <= to && !taken.has(q));
      // "2 kg broiler" (amount before the name) is the usual order; "broiler 2 kg" is the fallback.
      const before = own.filter((q) => q.end < f.start).sort((a, b) => b.end - a.end)[0];
      const after = own.filter((q) => q.start > f.end).sort((a, b) => a.start - b.start)[0];
      const q = before ?? after;
      if (q) taken.add(q);
      const share = toks.slice(from, to + 1).join(' ');
      const matched = toks.slice(f.start, f.end + 1).join(' ');
      items.push({
        itemId: f.p.id,
        quantity: q?.value,
        qtyUnit: q?.unit,
        cut: f.p.cutOptions.length ? findCut(share, f.p.cutOptions) : undefined,
        matched,
        generic: f.generic,
        ...(f.variant ? { variant: f.variant } : {}),
        ...(f.cutProduct ? { cutProduct: f.cutProduct } : {}),
      });
    });
  }
  // Same product twice in one message: the later mention wins (it is usually a correction).
  const merged = new Map<string, ItemMention>();
  for (const it of items) {
    const prev = merged.get(it.itemId);
    merged.set(it.itemId, { ...prev, ...Object.fromEntries(Object.entries(it).filter(([, v]) => v !== undefined)), generic: (prev?.generic ?? true) && it.generic } as ItemMention);
  }
  return { items: [...merged.values()], loose };
}

// ---------------------------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------------------------

export function parsePayment(text: string): PaymentChoice | undefined {
  const t = clean(text);
  // Already paid: past tense / "already" / "online la". Checked first: "gpay pannitten" = paid, not "will pay by UPI".
  if (
    /\b(already paid|paid already|already pay|pay pannitten|pay panniten|pay pannittan|pay pannitom|paid|payment done|panam kattitten|panam kattiten|kattitten|kattiten|kattiyachu|anuppitten|anupiten|anuppiten|online la pay|online payment|website la pay|website payment|paid online)\b/.test(t) ||
    hasAny(t, ['ஏற்கனவே', 'கட்டிட்டேன்', 'பே பண்ணிட்டேன்', 'அனுப்பிட்டேன்'])
  ) {
    return 'paid_online';
  }
  // "gpay pannitten", "amount anuppitten": a payment word + a past-tense verb.
  if (
    /\b(pannitten|panniten|pannittom|pannitom|pannittan|potten|pottachu|pottuten|anuppitten|anupiten|anuppiten|kattitten|kattiten|mudinjiduchu)\b/.test(t) &&
    /\b(pay|payment|gpay|upi|phonepe|paytm|online|panam|amount|money)\b/.test(t)
  ) {
    return 'paid_online';
  }
  if (/\b(upi|gpay|g pay|google pay|googlepay|phonepe|phone pe|phonepay|paytm|qr|scan|bhim)\b/.test(t) || hasAny(t, ['ஜிபே', 'யுபிஐ', 'ஜி பே', 'கூகுள் பே', 'போன் பே', 'போன்பே', 'ஃபோன் பே', 'பேடிஎம்', 'க்யூஆர்', 'ஸ்கேன்'])) return 'upi_at_shop';
  if (/\b(cash|kaasu|kasu|panam|cash la|cash on|in hand|hand cash|liquid cash|cod)\b/.test(t) || hasAny(t, ['காசு', 'கேஷ்', 'பணம்'])) return 'cash_at_shop';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Pickup time
// ---------------------------------------------------------------------------------------------

export type PickupReading =
  | { kind: 'at'; at: Date }
  | { kind: 'partial'; draft: WhenDraft }
  | { kind: 'none' };

// No \b: JavaScript word boundaries do not work next to Tamil letters, so boundaries are spelled out.
const NUM_WORD = '(\\d{1,3}|arai|half|oru|one|an|rendu|two|moonu|three|onnarai|ஒரு|அரை|ரெண்டு|இரண்டு|மூணு|ஒன்றரை|ஒன்னரை)';
const RELATIVE_MIN = new RegExp(`(?:^|\\s)${NUM_WORD}\\s*(min|mins|minute|minutes|nimisham|nimishathula|nimishathil|நிமிஷம்|நிமிடம்|நிமிஷத்துல|நிமிஷத்தில்)(?=\\s|$)`);
const RELATIVE_HOUR = new RegExp(`(?:^|\\s)${NUM_WORD}\\s*(hour|hours|hr|hrs|mani neram|mani nerathula|mani nerathil|மணி நேரம்|மணி நேரத்துல|மணி நேரத்தில்)(?=\\s|$)`);

/**
 * When the customer will collect. Handles "30 nimishathula", "oru mani nerathula", "ippo varen",
 * "saayangaalam 6 mani", "naalaikku kaalaila 10", "tomorrow 11 am". A time without a day means the
 * next time it occurs; an hour without am/pm ("6 mani") is resolved inside the shop's hours.
 */
const GREETING_TIME_WORDS = /\b(good|gud)\s*(morning|afternoon|evening|night|nite)\b|\bgoodnight\b|\bgn\b/gi;

export function parsePickup(
  text: string,
  now: Date,
  shop: { opensAt: string; closesAt: string },
  previous?: WhenDraft,
): PickupReading {
  // "good night", "good evening" are greetings, never a pickup time ("Thanks, good night" became 7 PM).
  text = (text ?? '').replace(GREETING_TIME_WORDS, ' ');
  const t = clean(text);
  const rm = t.match(RELATIVE_MIN);
  if (rm) {
    const n = /^\d/.test(rm[1]) ? Number(rm[1]) : ['arai', 'half', 'அரை'].includes(rm[1]) ? 30 : NUMBER_WORDS[rm[1]] ?? 0;
    if (n > 0 && n <= 600) return { kind: 'at', at: new Date(now.getTime() + n * 60_000) };
  }
  const rh = t.match(RELATIVE_HOUR);
  if (rh) {
    const n = /^\d/.test(rh[1]) ? Number(rh[1]) : rh[1] === 'an' ? 1 : NUMBER_WORDS[rh[1]] ?? 0;
    if (n > 0 && n <= 24) return { kind: 'at', at: new Date(now.getTime() + n * 3_600_000) };
  }
  if (/\b(ippo|ipo|ippove|now|right now|immediately|udane|udanae|ippovae|seekiram|sikiram|sikkiram|seekram|sigram|asap|as soon as possible|earliest|ready aanadhum|ready aana udane|ready ana udane)\b/.test(t) || hasAny(t, ['இப்போ', 'இப்பவே', 'உடனே', 'சீக்கிரம்', 'சீக்ரம்'])) {
    return { kind: 'at', at: now };
  }

  let draft = mergeWhen(previous, parseWhen(text, now));
  // After "evening" we asked "what time?": a lone hour ("4", "naalu", "8 mani") is that hour in that part of day.
  if (previous?.fromPartOfDay && previous.hour !== undefined) {
    const lone = t.match(/^(\S+)(?: (?:mani|manikku|o ?clock|மணி|மணிக்கு))?$/);
    const h = lone ? (/^\d{1,2}$/.test(lone[1]) ? Number(lone[1]) : NUMBER_WORDS[lone[1]]) : undefined;
    if (h !== undefined && h >= 1 && h <= 12 && Number.isInteger(h)) {
      draft = { ...previous, hour: previous.hour >= 12 && h < 12 ? h + 12 : h, minute: 0, fromPartOfDay: false };
      delete draft.ambiguousHour;
    }
  }
  // "evening" with no hour: the shop has no rule for which hour that is, so it is not a pickup time yet — keep the
  // part of day and ask for the hour (it used to become 6 PM silently). A following "8" is read inside that part.
  if (draft.fromPartOfDay) {
    if (draft.ambiguousHour === undefined) return { kind: 'partial', draft };
    const pm = (draft.hour ?? 0) >= 12;
    draft.hour = pm && draft.ambiguousHour < 12 ? draft.ambiguousHour + 12 : draft.ambiguousHour;
    draft.minute ??= 0;
    delete draft.ambiguousHour;
    draft.fromPartOfDay = false;
  }
  const hasTime = draft.hour !== undefined || draft.ambiguousHour !== undefined;
  if (!hasTime) return draft.date ? { kind: 'partial', draft } : { kind: 'none' };

  const open = toMin(shop.opensAt);
  const close = toMin(shop.closesAt);
  const inHours = (m: number) => (open === close ? true : open < close ? m >= open && m < close : m >= open || m < close);
  const today = istParts(now);
  const days = draft.date ? [draft.date] : [today, next(now, 1)];

  for (const d of days) {
    const hours = draft.hour !== undefined ? [draft.hour] : [draft.ambiguousHour!, (draft.ambiguousHour! % 12) + 12];
    const options = hours
      .map((h) => istDate(d.year, d.month, d.day, h, draft.minute ?? 0))
      .filter((at) => at.getTime() > now.getTime() - 5 * 60_000);
    // Prefer a time inside shop hours; "6 mani" = 6 PM when the shop opens at 7 AM.
    const best = options.find((at) => inHours(istParts(at).hour * 60 + istParts(at).minute)) ?? options[0];
    if (best) return { kind: 'at', at: best };
  }
  return { kind: 'partial', draft };
}

function next(now: Date, days: number) {
  const p = istParts(new Date(now.getTime() + days * 86_400_000));
  return { year: p.year, month: p.month, day: p.day };
}

function toMin(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// ---------------------------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------------------------

export function classify(text: string, offerCode?: string): Intent {
  const t = clean(text);
  if (!t) return 'unknown';
  const only = (words: string[]) => words.includes(t);
  if (isConfirmWords(t)) return 'confirm';
  if (isDeclineWords(t)) return 'decline';
  if (
    only(['yes', 'yes please', 'yeah', 'yep', 'ok', 'okay', 'ok da', 'okay pannunga', 'ok pannunga', 'confirm', 'confirmed', 'confirm pannunga', 'confirm pannidunga', 'sari', 'seri', 'sari pa', 'seri pa', 'sari pannunga', 'saringa', 'seringa', 'aamam', 'aama', 'aamaa', 'aamanga', 'correct', 'correct ah iruku', 'correct ah irukku', 'done', 'go ahead', 'place order', 'order pannunga', 'podunga', 'ஆமா', 'ஆமாம்', 'சரி', 'சரிங்க', 'ஓகே', 'கன்பார்ம்', 'ok confirm', 'yes confirm', 'sari confirm', 'haan'])
  ) {
    return 'confirm';
  }
  if (only(['no', 'nope', 'venam', 'vendam', 'vendaam', 'venaam', 'cancel', 'cancel pannunga', 'illa', 'illai', 'stop', 'வேண்டாம்', 'வேணாம்', 'இல்லை', 'இல்ல', 'கேன்சல்'])) return 'decline';
  if (isGoodbye(text)) return 'goodbye';
  if (isChangeWords(text)) return 'change';
  if (isDoneWords(text)) return 'done';
  // Pickup only: there is no delivery in the product. Asked before menu / outlet words ("delivery charge evlo?").
  if (/\b(delivery|deliver|home delivery|door delivery|veetuku anuppunga|veetuku anupunga|veetukku anuppunga|veetuku kondu|send to my house|courier|swiggy|zomato|dunzo)\b/.test(t) || hasAny(t, ['டெலிவரி', 'வீட்டுக்கு அனுப்புங்க', 'வீட்டுக்கு கொண்டு'])) return 'delivery';
  if (/\b(staff|manager|owner|human|person|aal|call me|call pannunga|pesanum|pesunga|customer care|complaint)\b/.test(t) || hasAny(t, ['பேசணும்', 'கால் பண்ணுங்க'])) return 'human';
  if (/\b(order status|status|ready ah|ready aa|ready aacha|ready achaa|ready ayiducha|eppo ready|when ready|where is my order)\b/.test(t) || hasAny(t, ['ரெடியா', 'ரெடி ஆச்சா'])) return 'order_status';
  if (/\b(clear|start again|start over|ellam venam|ellame venam|full ah cancel)\b/.test(t)) return 'clear';
  if (/\b(venam|vendam|vendaam|venaam|remove|delete|cancel|dont want|no need|thevai illa|eduthudunga|eduthidunga|eduthudu)\b/.test(t) || hasAny(t, ['வேண்டாம்', 'வேணாம்', 'எடுத்துடுங்க', 'எடுத்திடுங்க', 'எடுத்துருங்க', 'நீக்குங்க'])) return 'remove';
  if ((offerCode && pad(t).includes(pad(clean(offerCode)))) || /\b(offer|claim|discount|coupon|50 off|rs 50|₹50)\b/.test(t) || hasAny(t, ['ஆஃபர்', 'ஆபர்'])) return 'offer';
  if (/\b(menu|rate|rates|price|prices|vilai|evlo|evvalavu|enna rate|rate enna|price list|what do you have|enna irukku|enna iruku|items)\b/.test(t) || hasAny(t, ['விலை', 'எவ்வளவு', 'ரேட்'])) return 'menu';
  if (/\b(address|location|shop enga|kadai enga|branch|branches|outlet|timing|timings|open|close)\b/.test(t) || hasAny(t, ['கடை எங்க', 'அட்ரஸ்'])) return 'outlets';
  if (/^(hi|hii+|hello|hey|vanakkam|vanakam|gm|good morning|good evening|good afternoon)\b/.test(t) || hasAny(t, ['வணக்கம்', 'ஹாய்'])) return 'greeting';
  if (/^(thanks|thank you|thx|tq|nandri|romba nandri)\b/.test(t) || hasAny(t, ['நன்றி'])) return 'thanks';
  if (/\b(order (pannanum|pannanam|pannuren|panren|panna venum|podanum|poda venum|pannalama|pannalaama)|i want to order|want to order|wanna order|place an order|make an order|new order)\b/.test(t) || hasAny(t, ['order பண்ணணும்', 'order பண்ணனும்', 'order போடணும்', 'order பண்ணலாமா', 'order பண்றேன்'])) return 'order_start';
  return 'unknown';
}

/**
 * Spoken / typed confirmations are rarely one exact word: "ஆமாங்க", "சரி சரி", "ok confirm pannunga", "yes please
 * confirm". A confirmation is a short message made ONLY of agreement words (+ politeness), with at least one real
 * agreement word and no negation. Used only where the engine is waiting for a yes (the summary / a question).
 */
const AGREE = new Set(['pannu', 'pannidu', 'panniru', 'pannudu', 'podu', 'பண்ணு', 'பண்ணிடு', 'பண்ணிரு', 'பண்ணிடுங்க', 'போடு', 'போடுங்க', 'yes', 'yeah', 'yep', 'ok', 'okay', 'k', 'confirm', 'confirmed', 'sari', 'seri', 'saringa', 'seringa', 'aama', 'aamam', 'aamaa', 'aamanga', 'ama', 'correct', 'done', 'haan', 'ha', 'ஆமா', 'ஆமாம்', 'ஆமாங்க', 'ஆம்', 'சரி', 'சரிங்க', 'சரிங்க', 'ஹா', 'ஹான்']);
const AGREE_FILLER = new Set(['please', 'pls', 'plz', 'pannunga', 'pannidunga', 'pannidu', 'panni', 'podunga', 'da', 'pa', 'ma', 'go', 'ahead', 'it', 'iruku', 'irukku', 'ah', 'thats', 'that', 's', 'is', 'fine', 'good', 'super', 'order', 'place', 'all', 'boss', 'sir', 'madam', 'பண்ணுங்க', 'பண்ணிடுங்க', 'பண்ணுங்கள்', 'சூப்பர்', 'அப்படியே', 'அப்படியே']);
const NEGATION = /\b(no|not|dont|don t|illa|illai|venam|vendam|vendaam|venaam|cancel|wait|change|maathu|maathunga|wrong|thappu)\b|இல்ல|வேண்டா|வேணா|கேன்சல்|மாத்து|தப்பு/;
export function isConfirmWords(t: string): boolean {
  const words = t.split(' ').filter(Boolean);
  if (!words.length || words.length > 6 || NEGATION.test(t)) return false;
  return words.some((w) => AGREE.has(w)) && words.every((w) => AGREE.has(w) || AGREE_FILLER.has(w));
}

const DISAGREE = new Set(['no', 'nope', 'nah', 'venam', 'vendam', 'vendaam', 'venaam', 'cancel', 'illa', 'illai', 'illanga', 'வேண்டாம்', 'வேணாம்', 'வேண்டா', 'வேணா', 'வேண்டாங்க', 'வேணாங்க', 'இல்லை', 'இல்ல', 'இல்லங்க', 'கேன்சல்']);
const DISAGREE_FILLER = new Set(['thanks', 'thank', 'you', 'please', 'pannunga', 'sir', 'madam', 'boss', 'da', 'pa', 'பண்ணுங்க', 'சார்']);
export function isDeclineWords(t: string): boolean {
  const words = t.split(' ').filter(Boolean);
  if (!words.length || words.length > 4) return false;
  return words.some((w) => DISAGREE.has(w)) && words.every((w) => DISAGREE.has(w) || DISAGREE_FILLER.has(w));
}

/**
 * An explicit end of the conversation: "bye", "ok bye", "thanks bye", "சரி, வைக்கிறேன்". Short messages only, so an
 * order that happens to end with "bye" ("2 kg broiler curry cut, cash, 6 mani, bye") is still read as an order.
 * On a phone call this is the only customer sentence that ends the call.
 */
export function isGoodbye(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  const words = t.split(' ');
  if (words.length > 6) return false;
  const bye = /\b(bye|byee+|bye bye|goodbye|good bye|tata|see you|vaikkiren|vaikiren|vachidren|vachidaren|vaikren|call cut pannunga|cut pannunga|cut the call|call cut|cut call|hang up|hangup|disconnect|good night|gud night|goodnight|thats all|that s all|that is all)\b/.test(t) || hasAny(t, ['பை', 'பைபை', 'பை பை', 'வைக்கிறேன்', 'வச்சிடுறேன்', 'வைச்சிடுறேன்', 'வைக்கிறேங்க', 'கட் பண்ணுங்க', 'வைச்சிடுங்க']);
  if (!bye) return false;
  // "bye" next to an order detail is an order message, not a goodbye.
  return !/\d/.test(t) && !/\b(kg|kilo|cut|chicken|broiler|cash|upi|gpay)\b/.test(t.replace(/call cut pannunga|cut pannunga|cut the call|call cut|cut call/g, ''));
}

/**
 * "chicken irukka?", "boneless available ah?", "stock irukka", "do you have liver", "கோழி இருக்கா?":
 * the customer asks WHETHER something is in stock. Answered from the catalogue by rules, never by the model.
 */
export function asksAvailability(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return (
    /\b(irukka|iruka|irukaa|irukkaa|irukkuma|irukuma|irukkudha|irukudha|available|availability|avail|stock|kidaikuma|kidaikkuma|kedaikkuma|kedaikuma|do you have|have you got|do u have|you have|undaa|unda)\b/.test(t) ||
    hasAny(t, ['இருக்கா', 'இருக்குமா', 'கிடைக்குமா', 'ஸ்டாக்'])
  );
}

/**
 * What kind of question the message asks, if any (answered from the database before anything else):
 *   stock_qty       "how much stock is there?", "stock evlo irukku", "எவ்வளவு stock இருக்கு", "ethana kg irukku"
 *   list_available  "which chicken is available?", "enna chicken irukku", "என்ன இருக்கு?", "what do you have?"
 *   item            "do you have chicken liver?", "country chicken irukka?" (a specific product; decided by caller)
 */
export function questionKind(text: string): 'stock_qty' | 'list_available' | 'availability' | undefined {
  const t = clean(text);
  if (!t) return undefined;
  if (
    /\b(how much|how many|evlo|evvalavu|ethana|ethanai|enna) (stock|kg|kilo|kilos)\b|\bstock\b.*\b(evlo|evvalavu|ethana|how much|how many|left|remaining|balance|enna|irukku|iruku|irukka|iruka|available)\b|\b(how much|how many)\b.*\b(left|available|in stock|remaining)\b|\b(kg|kilo|kilos|pieces|pcs)\b.*\b(left|remaining)\b/.test(t) ||
    hasAny(t, ['எவ்வளவு stock', 'stock எவ்வளவு', 'எத்தனை கிலோ இருக்கு', 'எவ்வளவு இருக்கு'])
  ) {
    return 'stock_qty';
  }
  const asksWhich = /\b(which|what|whats|enna|edhu|ethu|any)\b/.test(t) || hasAny(t, ['என்ன', 'எது', 'எந்த']);
  const aboutStock = asksAvailability(text) || /\b(irukku|iruku|have|got|sell|selling|today)\b/.test(t) || hasAny(t, ['இருக்கு', 'இருக்கா']);
  if (asksWhich && aboutStock) return 'list_available';
  if (asksAvailability(text)) return 'availability';
  return undefined;
}

/**
 * Sentences in a model reply that claim something is NOT available / out of stock. Availability is decided by
 * the catalogue (rules) only, so such a sentence from the model is dropped (filterAvailabilityClaims).
 */
const NEGATIVE_AVAILABILITY = /\b(not available|unavailable|out of stock|sold out|no stock|(?:don'?t|do not|dont) have|not on (?:our|the) menu|kidaiyaadhu|kidaiyadhu|kidaikaadhu|kidaikadhu|irukkadhu|irukadhu)\b|available illa|stock illa|inniku illa|innaiku illa|ippo illa|கிடையாது|கிடைக்காது|ஸ்டாக் இல்ல|available இல்ல|இன்னைக்கு இல்ல|இப்போ இல்ல|இருக்காது/i;

export function filterAvailabilityClaims(text: string): string {
  return text
    .split(/(?<=[.!?\n])\s*/)
    .filter((sentence) => !NEGATIVE_AVAILABILITY.test(sentence))
    .join(' ')
    .replace(/\s+\n/g, '\n')
    .trim();
}

/** A plausible Indian mobile number in free text (staff entering numbers, website API). */
export function findPhone(text: string): string | undefined {
  const m = (text ?? '').replace(/[\s-]/g, '').match(/(?:\+?91)?([6-9]\d{9})/);
  return m ? m[1] : undefined;
}

/** "GR-7K2Q9X" style order reference (always contains a digit). */
export function findOrderNumber(text: string): string | undefined {
  const m = (text ?? '').toUpperCase().match(/\bGR-?((?=[A-Z0-9]*\d)[A-Z0-9]{6})\b/);
  return m ? `GR-${m[1]}` : undefined;
}

/** Choose an outlet by number ("2") or by name / area words. */
export function pickOutlet<T extends { id: string; name: string; area: string | null }>(text: string, outlets: T[]): T | undefined {
  const t = clean(text);
  const n = t.match(/^(\d{1,2})$/);
  if (n) return outlets[Number(n[1]) - 1];
  const words = new Set(t.split(' '));
  let best: { o: T; score: number } | undefined;
  for (const o of outlets) {
    const keys = clean(`${o.name} ${o.area ?? ''}`).split(' ').filter((w) => w.length > 2 && !['chicken', 'outlet', 'branch', 'the', 'demo', 'shop'].includes(w));
    const score = keys.filter((k) => words.has(k)).length;
    if (score > 0 && (!best || score > best.score)) best = { o, score };
  }
  return best?.o;
}

/** "2.5 kg", "1 kg", "500 g", "12 pcs". */
export function formatQty(q: number, unit: string): string {
  if (unit === 'piece') return `${q} pcs`;
  if (q < 1) return `${Math.round(q * 1000)} g`;
  return `${Number.isInteger(q) ? q : q.toFixed(q * 100 % 10 === 0 ? 1 : 2)} kg`;
}


// ---------------------------------------------------------------------------------------------
// Conversation cues (Chennai Tamil / Tanglish / English) used by the ordering engine
// ---------------------------------------------------------------------------------------------

/** "Evlo aagum?", "total enna?", "how much is it?", "மொத்தம் எவ்வளவு": the customer asks for THEIR total, not the menu. */
export function asksTotal(text: string): boolean {
  const t = clean(text);
  return (
    /\b(evlo aagum|evlo agum|evvalavu aagum|evlo aachu|evlo achu|total evlo|total enna|total ah|motham evlo|mothama evlo|how much (is it|will it be|is the total|in total)|what s the total|whats the total|what is the total|bill evlo|bill amount)\b/.test(t) ||
    hasAny(t, ['எவ்வளவு ஆகும்', 'எவ்ளோ ஆகும்', 'மொத்தம் எவ்வளவு', 'மொத்தம்'])
  );
}

/** "Ethana manikku varanum?", "eppo varalaam?", "when should I come?": a QUESTION about when to come, not a time. */
export function asksWhenToCome(text: string): boolean {
  const t = clean(text);
  if (/\d/.test(t)) return false; // "8 manikku varuven" is an answer
  return (
    /\b(ethana|ethanai|eppo|epo|enna neram|what time|when)\b.*\b(varanum|vara num|varalaam|varalam|varattum|vandhu vaanganum|collect pannanum|should i come|can i come|do i come|to come|pick up|pickup)\b/.test(t) ||
    hasAny(t, ['எத்தனை மணிக்கு வரணும்', 'எப்போ வரணும்', 'எப்போ வரலாம்', 'எத்தனை மணிக்கு வரலாம்'])
  );
}

/** "Pickup-ku varren", "vandhu vaangikiren", "I'll come": coming to collect, without saying when. */
export function mentionsComing(text: string): boolean {
  const t = clean(text);
  return /\b(pickup|pick up|varen|varren|vareen|varuven|varuvom|varom|vandhu vaangikiren|vandhu vaangikaren|collect pannuren|collect panren|i will come|i ll come|coming)\b/.test(t) || hasAny(t, ['வரேன்', 'வருவேன்', 'வந்து வாங்கிக்கிறேன்']);
}

/** "Innum oru kilo", "innoru piece add pannunga", "one more kg", "add 1 kg": an amount to ADD to what is there. */
export function isAdditive(text: string): boolean {
  const t = clean(text);
  return /\b(innum|inum|innoru|inoru|extra|more|add|kooda|koodudhala|kooduthala|serthu)\b/.test(t) || hasAny(t, ['இன்னும்', 'இன்னொரு', 'சேர்த்து', 'கூட']);
}

/** "adha", "adhu", "that", "it", "அதை": the product just talked about. */
export function refersToIt(text: string): boolean {
  const t = clean(text);
  return /\b(adha|adhu|athu|atha|adhai|idha|idhu|ithu|that|it|this one|that one)\b/.test(t) || hasAny(t, ['அதை', 'அது', 'இதை', 'இது']);
}


/** Finished choosing: "order place pannunga", "place the order", "அவ்வளவுதான்", "போதும்", "that's all", "that's it". */
export function isDoneWords(text: string): boolean {
  const t = clean(text);
  return (
    /\b(order place pannunga|order place panunga|order place pannidunga|order place pannu|place (the |my )?order|place it|that s all|thats all|that is all|that s it|thats it|avlo dhaan|avlo than|avlothaan|avlodhaan|avvalavu dhaan|avvalavu than|podhum|pothum|enough|done ordering|finish (the |my )?order)\b/.test(t) ||
    hasAny(t, ['அவ்வளவுதான்', 'அவ்வளவு தான்', 'அவ்ளோ தான்', 'அவ்ளோதான்', 'போதும்'])
  );
}

/** "No chicken", "எனக்கு chicken வேணாம்", "chicken vendaam": chicken in general is excluded (eggs stay). */
export function excludesChicken(text: string): boolean {
  const t = clean(text);
  if (!/\b(chicken|chickens|kozhi|koli)\b/.test(t) && !hasAny(t, ['கோழி'])) return false;
  return /\b(no chicken|without chicken|chicken illama|chicken illamal)\b/.test(t) || (/\b(venam|vendam|vendaam|venaam|vendaa|vena|dont want|don t want|no need|illa)\b/.test(t) || hasAny(t, ['வேண்டாம்', 'வேணாம்', 'வேண்டா', 'வேணா']));
}

/** "Egg mattum", "eggs only", "எனக்கு eggs தான் வேணும்": the named products and nothing else. */
export function onlyThese(text: string): boolean {
  const t = clean(text);
  return /\b(mattum|matum|mattumae|only|alone|thaan|dhaan)\b/.test(t) || hasAny(t, ['மட்டும்', 'தான்']);
}


/** "change பண்ணனும்", "maathanum", "மாற்றணும்", "I want to change", "edit": the customer wants to edit the order. */
export function isChangeWords(text: string): boolean {
  const t = clean(text);
  return (
    /\b(change|changes|change pannanum|change pannanum|maathanum|mathanum|maathunga|maatha venum|edit|modify|wrong)\b/.test(t) ||
    hasAny(t, ['மாற்றணும்', 'மாத்தணும்', 'மாத்துங்க', 'மாற்றுங்க', 'மாற்ற வேண்டும்', 'மாத்தனும்'])
  );
}

// ---------------------------------------------------------------------------------------------
// Cart edits by product name: "remove eggs", "egg வேண்டாம்", "Chicken மட்டும் போதும்"
// ---------------------------------------------------------------------------------------------

export type EditPolarity = 'remove' | 'only' | 'none';

/** "venam", "vendaam", "remove", "eduthudunga", "வேண்டாம்", "எடுத்துருங்க", "close பண்ணிடுங்க". */
function isRemoveToken(toks: string[], i: number, before: boolean): boolean {
  const w = toks[i];
  if (/^(venam|vendam|vendaam|venaam|vendaa|venda|vena|venaa|venamnga|vendaamnga|remove|delete|cancel|eduth\w*|neekku\w*|dont)$/.test(w)) return true;
  if (['வேண்டா', 'வேணா', 'எடுத்து', 'நீக்கு', 'கேன்சல்'].some((p) => w.startsWith(p))) return true;
  // "close பண்ணிடுங்க", "close pannunga": take it off the order.
  if (w === 'close' && /^(pann|பண்ண)/.test(toks[i + 1] ?? '')) return true;
  if (w === 'thevai' && /^(illa|இல்ல)/.test(toks[i + 1] ?? '')) return true;
  if (w === 'no' && toks[i + 1] === 'need') return true;
  // "no eggs", "not the eggs", "without chicken": only in front of the product.
  return before && ['no', 'not', 'without'].includes(w);
}
/** "mattum", "only", "podhum", "மட்டும்", "போதும்": the named product and nothing else. */
function isOnlyToken(w: string): boolean {
  return /^(mattum\w*|matum|only|alone|podhum|pothum|enough|just)$/.test(w) || ['மட்டும்', 'மட்டு', 'போதும்'].some((p) => w.startsWith(p));
}
const CONNECTOR = /^(and|um|also|plus|then|apram|aprom|matrum|மற்றும்|அப்புறம்|the|a|an|அந்த|antha|andha)$/;

/**
 * For each product mention, what the words around it ask: remove it, keep only it, or nothing about editing.
 * The words AFTER a product belong to it first ("ஆறு egg மட்டும் வேண்டாம்" → remove eggs; "Chicken மட்டும் போதும்" →
 * chicken only). Words before it count only when the previous product did not already claim them ("remove eggs",
 * "no chicken"); "remove eggs and drumsticks" carries the remove to both.
 */
export function mentionPolarities(toks: string[], mentions: Array<{ start: number; end: number }>): EditPolarity[] {
  const out: EditPolarity[] = [];
  const fromAfter: boolean[] = [];
  mentions.forEach((m, i) => {
    const nextStart = mentions[i + 1]?.start ?? toks.length;
    const prevEnd = i > 0 ? mentions[i - 1].end : -1;
    const after = Array.from({ length: Math.max(0, nextStart - m.end - 1) }, (_, k) => m.end + 1 + k);
    const before = Array.from({ length: Math.max(0, m.start - prevEnd - 1) }, (_, k) => prevEnd + 1 + k);
    const read = (idx: number[], isBefore: boolean): EditPolarity =>
      idx.some((k) => isRemoveToken(toks, k, isBefore)) ? 'remove' : idx.some((k) => isOnlyToken(toks[k])) ? 'only' : 'none';
    const a = read(after, false);
    if (a !== 'none') {
      out.push(a);
      fromAfter.push(true);
      return;
    }
    fromAfter.push(false);
    if (!(i > 0 && fromAfter[i - 1])) {
      const b = read(before, true);
      if (b !== 'none') return out.push(b);
    }
    // "remove eggs and drumsticks": joined by an explicit "and" / "um" to the previous product, same request.
    // NOT when nothing joins them: "not wings, leg" contrasts the two (wings go, leg piece stays).
    if (i > 0 && before.length && before.every((k) => CONNECTOR.test(toks[k]))) return out.push(out[i - 1]);
    out.push('none');
  });
  // "eggs and leg piece venam": the edit word after the LAST of an "X and Y" list covers the earlier ones too.
  for (let i = mentions.length - 2; i >= 0; i--) {
    if (out[i] !== 'none' || out[i + 1] === 'none' || !fromAfter[i + 1]) continue;
    const gap = Array.from({ length: Math.max(0, mentions[i + 1].start - mentions[i].end - 1) }, (_, k) => mentions[i].end + 1 + k);
    if (gap.length && gap.every((k) => CONNECTOR.test(toks[k]))) out[i] = out[i + 1];
  }
  return out;
}

/** "kg-ல", "in kg", "kilo la", "pieces-ஆ": the customer names only the unit (no amount, no product). */
export function unitOnly(text: string): 'kg' | 'piece' | undefined {
  const toks = clean(text).split(' ').filter(Boolean);
  if (!toks.length || toks.length > 6 || findQuantities(toks).length) return undefined;
  if (/(^|\s)leg piece/.test(productSynonyms(toks.join(' ')))) return undefined; // a product name, not a unit
  if (toks.some((w) => KG_WORDS.includes(w) || w.startsWith('கிலோ'))) return 'kg';
  if (toks.some((w) => ['piece', 'pieces', 'pcs', 'pc', 'count', 'enni', 'எண்ணி'].includes(w))) return 'piece';
  return undefined;
}

/** A message that is only a small whole number ("4", "naalu", "நாலு", "4 mani"): answers whatever was just asked. */
export function bareNumber(text: string): number | undefined {
  const toks = clean(text).split(' ').filter(Boolean);
  if (!toks.length || toks.length > 2) return undefined;
  if (toks.length === 2 && !/^(mani|manikku|oclock|o|மணி|மணிக்கு)$/.test(toks[1])) return undefined;
  const n = /^\d{1,2}$/.test(toks[0]) ? Number(toks[0]) : NUMBER_WORDS[toks[0]];
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= 12 && !['a', 'an'].includes(toks[0]) ? n : undefined;
}
