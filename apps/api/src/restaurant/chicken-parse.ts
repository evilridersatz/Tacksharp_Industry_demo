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
  /** One of the product's cutOptions. */
  cut?: string;
  matched: string;
};

/** Quantity / cut said without naming a product ("3 kg", "curry cut") — applied to the product being discussed. */
export type Loose = { quantity?: number; cut?: string };

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
  | 'unknown';

const pad = (t: string) => ` ${t} `;
const hasAny = (t: string, words: string[]) => words.some((w) => pad(t).includes(pad(w)));

/** norm() keeps Tamil; we also keep decimal points and fractions inside numbers ("1.5", "1 1/2"). */
export function clean(text: string): string {
  const protectedText = (text ?? '')
    .replace(/(\d)[.,](\d)/g, '$1§$2')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1¶$2')
    .replace(/(\d)\s*(kg|kgs|kilo|kilos|g|gm|gms|gram|grams|kilogram|kilograms)\b/gi, '$1 $2');
  return norm(protectedText).replace(/§/g, '.').replace(/¶/g, '/');
}

// ---------------------------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------------------------

const KG_WORDS = ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'கிலோ', 'கிலோவு', 'kilova'];
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
  arai: 0.5, half: 0.5, அரை: 0.5,
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
    // "one and half", "1 and half", "oru arai"
    if ((tokens[i + 1] === 'and' && tokens[i + 2] === 'half') ) return { value: Number(t) + 0.5, width: 3 };
    return { value: Number(t), width: 1 };
  }
  const w = NUMBER_WORDS[t];
  if (w !== undefined) {
    if ((tokens[i + 1] === 'and' && tokens[i + 2] === 'half')) return { value: w + 0.5, width: 3 };
    if (w >= 1 && (tokens[i + 1] === 'arai' || tokens[i + 1] === 'அரை')) return { value: w + 0.5, width: 2 };
    return { value: w, width: 1 };
  }
  return undefined;
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
    } else if (/^\d/.test(tokens[i]) || ['arai', 'அரை', 'kaal', 'mukkal', 'onnarai', 'ஒன்றரை', 'rendarai'].includes(tokens[i])) {
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
  { key: 'curry', words: ['curry cut', 'curry', 'kari cut', 'kari', 'small pieces', 'small piece', 'chinna piece', 'chinna pieces', 'chinna peace', 'சின்ன பீஸ்', 'கறி கட்', 'கறி', 'குழம்பு', 'kulambu', 'kuzhambu'] },
  { key: 'biryani', words: ['biryani cut', 'biriyani cut', 'briyani cut', 'biryani', 'biriyani', 'briyani', 'big pieces', 'big piece', 'periya piece', 'periya pieces', 'பெரிய பீஸ்', 'பிரியாணி'] },
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
export function parseItems(text: string, products: Product[]): { items: ItemMention[]; loose: Loose } {
  const segments = (text ?? '')
    .split(/[,;\n]+/)
    .map(clean)
    .join('\n')
    .split(/\s(?:and|um|plus|apram|aprom|then|also|matrum|மற்றும்|அப்புறம்)\s|\s?\+\s?|\n/)
    .flatMap((s) => s.split(/\s{2,}/))
    .map((s) => s.trim())
    .filter(Boolean);
  const items: ItemMention[] = [];
  const loose: Loose = {};
  const candidates = products.flatMap((p) => phrases(p).map((phrase) => ({ p, phrase }))).sort((a, b) => b.phrase.length - a.phrase.length);

  for (const seg of segments) {
    const toks = seg.split(' ');
    const used = new Array<boolean>(toks.length).fill(false);
    const found: Array<{ p: Product; start: number; end: number }> = [];
    for (const { p, phrase } of candidates) {
      for (let i = 0; i + phrase.length <= toks.length; i++) {
        if (phrase.every((w, j) => !used[i + j] && (toks[i + j] === w || toks[i + j] === `${w}s`))) {
          for (let j = 0; j < phrase.length; j++) used[i + j] = true;
          found.push({ p, start: i, end: i + phrase.length - 1 });
        }
      }
    }
    found.sort((a, b) => a.start - b.start);
    const qtys = findQuantities(toks).filter((q) => !used.slice(q.start, q.end + 1).some(Boolean));

    if (!found.length) {
      // "3 kg", "curry cut", "rendu kilo curry cut": belongs to the product being discussed.
      const q = qtys.find((x) => x.unit !== 'bare') ?? (qtys.length === 1 && toks.length <= 3 ? qtys[0] : undefined);
      if (q) loose.quantity = q.value;
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
      items.push({
        itemId: f.p.id,
        quantity: q?.value,
        cut: f.p.cutOptions.length ? findCut(share, f.p.cutOptions) : undefined,
        matched: toks.slice(f.start, f.end + 1).join(' '),
      });
    });
  }
  // Same product twice in one message: the later mention wins (it is usually a correction).
  const merged = new Map<string, ItemMention>();
  for (const it of items) {
    const prev = merged.get(it.itemId);
    merged.set(it.itemId, { ...prev, ...Object.fromEntries(Object.entries(it).filter(([, v]) => v !== undefined)) } as ItemMention);
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
  if (/\b(upi|gpay|g pay|google pay|googlepay|phonepe|phone pe|phonepay|paytm|qr|scan|bhim)\b/.test(t) || hasAny(t, ['ஜிபே', 'யுபிஐ'])) return 'upi_at_shop';
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
export function parsePickup(
  text: string,
  now: Date,
  shop: { opensAt: string; closesAt: string },
  previous?: WhenDraft,
): PickupReading {
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
  if (/\b(ippo|ipo|ippove|now|right now|immediately|udane|udanae|ippovae)\b/.test(t) || hasAny(t, ['இப்போ', 'இப்பவே', 'உடனே'])) {
    return { kind: 'at', at: now };
  }

  const draft = mergeWhen(previous, parseWhen(text, now));
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
  if (
    only(['yes', 'yes please', 'yeah', 'yep', 'ok', 'okay', 'ok da', 'okay pannunga', 'ok pannunga', 'confirm', 'confirmed', 'confirm pannunga', 'confirm pannidunga', 'sari', 'seri', 'sari pa', 'seri pa', 'sari pannunga', 'saringa', 'seringa', 'aamam', 'aama', 'aamaa', 'aamanga', 'correct', 'correct ah iruku', 'correct ah irukku', 'done', 'go ahead', 'place order', 'order pannunga', 'podunga', 'ஆமா', 'ஆமாம்', 'சரி', 'சரிங்க', 'ஓகே', 'கன்பார்ம்', 'ok confirm', 'yes confirm', 'sari confirm', 'haan'])
  ) {
    return 'confirm';
  }
  if (only(['no', 'nope', 'venam', 'vendam', 'vendaam', 'venaam', 'cancel', 'cancel pannunga', 'illa', 'illai', 'stop', 'வேண்டாம்', 'வேணாம்', 'இல்லை', 'இல்ல', 'கேன்சல்'])) return 'decline';
  if (/\b(staff|manager|owner|human|person|aal|call me|call pannunga|pesanum|pesunga|customer care|complaint)\b/.test(t) || hasAny(t, ['பேசணும்', 'கால் பண்ணுங்க'])) return 'human';
  if (/\b(order status|status|ready ah|ready aa|ready aacha|ready achaa|ready ayiducha|eppo ready|when ready|where is my order)\b/.test(t) || hasAny(t, ['ரெடியா', 'ரெடி ஆச்சா'])) return 'order_status';
  if (/\b(clear|start again|start over|ellam venam|ellame venam|full ah cancel)\b/.test(t)) return 'clear';
  if (/\b(venam|vendam|vendaam|venaam|remove|delete|cancel|dont want|no need|thevai illa)\b/.test(t) || hasAny(t, ['வேண்டாம்', 'வேணாம்'])) return 'remove';
  if ((offerCode && pad(t).includes(pad(clean(offerCode)))) || /\b(offer|claim|discount|coupon|50 off|rs 50|₹50)\b/.test(t) || hasAny(t, ['ஆஃபர்', 'ஆபர்'])) return 'offer';
  if (/\b(menu|rate|rates|price|prices|vilai|evlo|evvalavu|enna rate|rate enna|price list|what do you have|enna irukku|enna iruku|items)\b/.test(t) || hasAny(t, ['விலை', 'எவ்வளவு', 'ரேட்'])) return 'menu';
  if (/\b(address|location|shop enga|kadai enga|branch|branches|outlet|timing|timings|open|close)\b/.test(t) || hasAny(t, ['கடை எங்க', 'அட்ரஸ்'])) return 'outlets';
  if (/^(hi|hii+|hello|hey|vanakkam|vanakam|gm|good morning|good evening|good afternoon)\b/.test(t) || hasAny(t, ['வணக்கம்', 'ஹாய்'])) return 'greeting';
  if (/^(thanks|thank you|thx|tq|nandri|romba nandri)\b/.test(t) || hasAny(t, ['நன்றி'])) return 'thanks';
  return 'unknown';
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
