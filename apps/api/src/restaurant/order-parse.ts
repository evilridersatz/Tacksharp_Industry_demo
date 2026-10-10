/**
 * Deterministic understanding of restaurant chat messages: which menu items and quantities the
 * customer asked for, and what they want to do (see the menu, confirm, cancel, ...).
 *
 * Pure functions, no I/O. The ordering engine decides what happens with the result; nothing
 * here ever sets a price.
 */

export type CatalogItem = {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  aliases: string[];
  available: boolean;
};

export type ItemRequest = {
  itemId: string;
  quantity: number;
  matched: string;
  /**
   * Set when the customer named a variant we do not sell in front of a generic name, e.g. "mutton
   * biryani" matching the alias "biryani" of Chicken Biryani. Such a request is never added to the cart.
   */
  unknownVariant?: string;
};

/** Words that change which dish is meant. If one precedes a match that does not contain it, it is a different dish. */
const VARIANT_WORDS = new Set([
  'mutton', 'goat', 'lamb', 'beef', 'pork', 'fish', 'prawn', 'prawns', 'shrimp', 'crab', 'squid', 'egg', 'veg', 'vegetable',
  'paneer', 'gobi', 'mushroom', 'kaadai', 'quail', 'duck', 'turkey', 'nattu', 'country', 'boneless', 'kothu', 'mini', 'jumbo',
]);

export type RestaurantIntent =
  | 'greeting'
  | 'menu'
  | 'category'
  | 'cart'
  | 'clear_cart'
  | 'remove'
  | 'confirm'
  | 'decline'
  | 'checkout'
  | 'order_status'
  | 'human'
  | 'hours'
  | 'outlets'
  | 'thanks'
  | 'unknown';

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, oru: 1, onnu: 1, ek: 1,
  two: 2, couple: 2, rendu: 2, irandu: 2, do: 2,
  three: 3, moonu: 3, moonnu: 3, teen: 3,
  four: 4, naalu: 4, nalu: 4, char: 4,
  five: 5, anju: 5, ainthu: 5, paanch: 5,
  six: 6, aaru: 6, seven: 7, ezhu: 7, eight: 8, ettu: 8, nine: 9, ombodhu: 9, ten: 10, pathu: 10,
  dozen: 12,
};

/** Lower-case, strip punctuation except digits/letters, collapse spaces. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/(\d)\s*x\b/g, '$1 ') // "2x" -> "2"
    .replace(/\bx\s*(\d)/g, ' $1')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

/** Very small stemmer so "biryanis", "parottas", "pieces" match their singular forms. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const FILLER = new Set([
  'i', 'want', 'need', 'please', 'pls', 'plz', 'give', 'me', 'get', 'order', 'add', 'and', 'with', 'also', 'some',
  'the', 'of', 'to', 'for', 'can', 'could', 'would', 'like', 'have', 'my', 'more', 'plus', 'venum', 'vendum', 'kudunga',
  'podunga', 'anuppunga', 'nos', 'no', 'qty', 'quantity', 'piece', 'pcs', 'plate', 'plates', 'portion', 'portions',
]);

function phrasesFor(item: CatalogItem): string[][] {
  return [item.name, ...item.aliases].map((p) => tokens(p).map(stem)).filter((p) => p.length > 0);
}

/**
 * Find menu items and quantities in a message: "2 chicken biryani and one pepsi", "biryani x2",
 * "chicken 65 - 3". Longest phrase wins, so "chicken biryani" is not read as "chicken 65".
 * An item mentioned without a number is quantity 1.
 */
export function parseItemRequests(text: string, catalog: CatalogItem[]): ItemRequest[] {
  const words = tokens(text);
  const stems = words.map(stem);
  const candidates = catalog.flatMap((item) => phrasesFor(item).map((phrase) => ({ item, phrase })));
  candidates.sort((a, b) => b.phrase.length - a.phrase.length);

  const used = new Array<boolean>(words.length).fill(false);
  const found: Array<{ item: CatalogItem; start: number; end: number; matched: string; unknownVariant?: string }> = [];

  for (const { item, phrase } of candidates) {
    for (let i = 0; i + phrase.length <= stems.length; i++) {
      let ok = true;
      for (let j = 0; j < phrase.length; j++) {
        if (used[i + j] || stems[i + j] !== phrase[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (let j = 0; j < phrase.length; j++) used[i + j] = true;
      const matched = words.slice(i, i + phrase.length).join(' ');
      const before = i > 0 && !used[i - 1] ? stems[i - 1] : undefined;
      const unknownVariant = before && VARIANT_WORDS.has(before) && !phrase.includes(before) ? `${words[i - 1]} ${matched}` : undefined;
      found.push({ item, start: i, end: i + phrase.length - 1, matched, unknownVariant });
    }
  }
  found.sort((a, b) => a.start - b.start);

  const quantityAt = (index: number): number | undefined => {
    if (index < 0 || index >= words.length || used[index]) return undefined;
    const w = words[index];
    if (/^\d{1,3}$/.test(w)) return Number(w);
    return NUMBER_WORDS[w];
  };

  const result = new Map<string, ItemRequest>();
  found.forEach((f, idx) => {
    // Number before the item ("2 biryani"), skipping filler words ("2 plates of biryani").
    let qty: number | undefined;
    // For "2 mutton biryani" the quantity sits before the variant word.
    const from = f.unknownVariant ? f.start - 2 : f.start - 1;
    for (let k = from; k >= 0 && k >= from - 2; k--) {
      if (used[k]) break;
      const q = quantityAt(k);
      if (q !== undefined) {
        qty = q;
        used[k] = true;
        break;
      }
      if (!FILLER.has(words[k])) break;
    }
    // Number after the item ("biryani 2", "biryani x2") when the next item has not claimed it.
    if (qty === undefined) {
      const next = found[idx + 1];
      for (let k = f.end + 1; k < words.length && k <= f.end + 2; k++) {
        if (next && k >= next.start) break;
        const q = quantityAt(k);
        // "biryani 2 parotta": the 2 belongs to parotta when it directly precedes it.
        if (q !== undefined && !(next && k === next.start - 1)) {
          qty = q;
          used[k] = true;
          break;
        }
        if (!FILLER.has(words[k])) break;
      }
    }
    const quantity = qty ?? 1;
    const prev = result.get(f.item.id);
    if (f.unknownVariant) {
      result.set(`variant:${f.unknownVariant}`, { itemId: f.item.id, quantity, matched: f.matched, unknownVariant: f.unknownVariant });
      return;
    }
    result.set(f.item.id, { itemId: f.item.id, quantity: (prev?.quantity ?? 0) + quantity, matched: f.matched });
  });
  return [...result.values()];
}

/** A menu category named in the message ("show me starters", "biryani menu"). */
export function findCategory(text: string, categories: Array<{ id: string; name: string }>): { id: string; name: string } | undefined {
  const t = ` ${tokens(text).map(stem).join(' ')} `;
  return categories.find((c) => {
    const name = tokens(c.name).map(stem).join(' ');
    return name && t.includes(` ${name} `);
  });
}

const has = (t: string, re: RegExp) => re.test(t);

export function classifyIntent(text: string): RestaurantIntent {
  const t = normalize(text);
  if (!t) return 'unknown';
  if (has(t, /^(yes|yeah|yep|yup|ok|okay|confirm|confirmed|sure|done|go ahead|place( the)? order|place it|aama|aamaa|sari|seri|correct|haan|ha)( please| pls| confirm| order)?$/)) return 'confirm';
  if (has(t, /^(yes|ok|okay) (confirm|place|go ahead)/)) return 'confirm';
  if (has(t, /^(no|nope|nah|cancel|cancel order|cancel it|vendam|venam|illa|stop|dont)( please| pls| thanks)?$/)) return 'decline';
  if (has(t, /\b(human|staff|person|manager|agent|call me|talk to (someone|a person|staff)|customer care|support)\b/)) return 'human';
  if (findOrderNumber(text) || has(t, /\b(order status|where is my order|track( my)? order|status of my order|my order status|order eppo)\b/)) return 'order_status';
  if (has(t, /\b(clear|empty|reset)( my| the)? (cart|order|basket)\b|\bstart over\b/)) return 'clear_cart';
  if (has(t, /\b(remove|delete|minus|cancel|dont want|no need)\b/)) return 'remove';
  if (has(t, /\b(checkout|check out|thats all|that s all|thats it|that s it|finish|proceed|place order|bill|nothing else|podhum|pothum)\b/)) return 'checkout';
  if (has(t, /\b(cart|basket|my order|what did i order|order summary|total)\b/)) return 'cart';
  if (has(t, /\b(timing|timings|hours|open|close|closing|opening)\b/)) return 'hours';
  if (has(t, /\b(outlet|outlets|branch|branches|location|locations|address|where are you|shop)\b/)) return 'outlets';
  if (has(t, /\b(menu|items|what do you have|whats available|what s available|list|price list|rate card|prices|dishes|food)\b/)) return 'menu';
  if (has(t, /^(hi|hello|hey|hii+|vanakkam|good (morning|afternoon|evening)|start)\b/)) return 'greeting';
  if (has(t, /^(thanks|thank you|thx|tq|nandri)\b/)) return 'thanks';
  return 'unknown';
}

/** A question about the menu ("do you have mutton biryani?", "how much is grill chicken"), not an order. */
export function isQuestion(text: string): boolean {
  const t = normalize(text);
  // "can you add 2 biryani?" is an order phrased politely, not a question.
  if (/\b(add|order|want|need|give|send|get me|ill have|i will have|pack|put)\b/.test(t)) return false;
  if (/\?\s*$/.test(text.trim())) return true;
  return /^(do|does|is|are|have|has|can|what|whats|which|how|when|where|why|price|rate|cost|any|u have|you have)\b/.test(t) || /\b(how much|what is the price|price of|rate of|available|iruka|irukka|irukaa|kidaikuma)\b/.test(t);
}

/** "pickup", "takeaway", "self pickup" / "delivery", "deliver to ...", "home delivery". */
export function parseFulfilment(text: string): 'pickup' | 'delivery' | undefined {
  const t = normalize(text);
  if (/\b(pick ?up|take ?away|takeaway|parcel|collect|self)\b/.test(t)) return 'pickup';
  if (/\b(deliver|delivery|door ?delivery|home delivery|send it|send to)\b/.test(t)) return 'delivery';
  return undefined;
}

/** A plausible Indian mobile number in free text. */
export function findPhone(text: string): string | undefined {
  const m = text.replace(/[\s-]/g, '').match(/(?:\+?91)?([6-9]\d{9})/);
  return m ? m[1] : undefined;
}

/** "GR-7K2Q9X" style order reference anywhere in the text. */
export function findOrderNumber(text: string): string | undefined {
  // Order numbers always contain a digit, so ordinary words ("GRATEFUL") are never read as one.
  const m = text.toUpperCase().match(/\bGR-?((?=[A-Z0-9]*\d)[A-Z0-9]{6})\b/);
  return m ? `GR-${m[1]}` : undefined;
}

/** Choose an outlet by number ("2") or by name / area words. */
export function pickOutlet<T extends { id: string; name: string; area: string | null }>(text: string, outlets: T[]): T | undefined {
  const t = normalize(text);
  const n = t.match(/^(\d{1,2})$/);
  if (n) return outlets[Number(n[1]) - 1];
  const words = new Set(t.split(' '));
  let best: { o: T; score: number } | undefined;
  for (const o of outlets) {
    const keys = tokens(`${o.name} ${o.area ?? ''}`).filter((w) => w.length > 2 && !['chicken', 'outlet', 'branch', 'the'].includes(w));
    const score = keys.filter((k) => words.has(k)).length;
    if (score > 0 && (!best || score > best.score)) best = { o, score };
  }
  return best?.o;
}
