import { describe, expect, it } from 'vitest';
import { classify, findOrderNumber, findPhone, formatQty, parseItems, parsePayment, parsePickup, type Product } from './chicken-parse.js';
import { filterUnverifiedPrices } from './ordering-engine.service.js';
import { readCallReply } from './ready-notice.service.js';
import { isOpen, newOrderNumber, TRANSITIONS } from './orders.service.js';

const P: Product[] = [
  { id: 'broiler', name: 'Broiler Chicken', unit: 'kg', aliases: ['broiler', 'chicken', 'kozhi', 'கோழி'], cutOptions: ['Curry cut', 'Biryani cut', 'Fry cut', 'Whole'], available: true },
  { id: 'skinless', name: 'Skinless Chicken', unit: 'kg', aliases: ['skinless', 'skin illama'], cutOptions: ['Curry cut', 'Biryani cut'], available: true },
  { id: 'country', name: 'Country Chicken', unit: 'kg', aliases: ['country', 'nattu kozhi', 'நாட்டு கோழி'], cutOptions: ['Curry cut', 'Biryani cut', 'Whole'], available: true },
  { id: 'boneless', name: 'Boneless Chicken', unit: 'kg', aliases: ['boneless', 'போன்லெஸ்'], cutOptions: [], available: true },
  { id: 'eggs', name: 'Country Eggs', unit: 'piece', aliases: ['eggs', 'muttai', 'முட்டை'], cutOptions: [], available: true },
];
const items = (t: string) => parseItems(t, P).items.map((i) => [i.itemId, i.quantity ?? null, i.cut ?? null]);
const now = new Date('2026-10-11T10:00:00+05:30');
const shop = { opensAt: '07:00', closesAt: '21:00' };
const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
const pickup = (t: string) => {
  const r = parsePickup(t, now, shop);
  return r.kind === 'at' ? ist(r.at) : r.kind;
};

describe('products, kg and cuts (Tanglish, Tamil, English)', () => {
  it('reads one-line orders', () => {
    expect(items('rendu kilo broiler curry cut')).toEqual([['broiler', 2, 'Curry cut']]);
    expect(items('2kg chicken biryani cut')).toEqual([['broiler', 2, 'Biryani cut']]);
    expect(items('oru kilo broiler fry cut')).toEqual([['broiler', 1, 'Fry cut']]);
    expect(items('1 1/2 kg country whole')).toEqual([['country', 1.5, 'Whole']]);
  });

  it('gives each product its own quantity and cut', () => {
    expect(items('1.5 kg nattu kozhi biryani cut and arai kilo boneless')).toEqual([['country', 1.5, 'Biryani cut'], ['boneless', 0.5, null]]);
    expect(items('அரை கிலோ போன்லெஸ், ரெண்டு கிலோ கோழி கறி கட்')).toEqual([['boneless', 0.5, null], ['broiler', 2, 'Curry cut']]);
  });

  it('understands grams, halves, quarters and pieces', () => {
    expect(items('500 gm boneless')).toEqual([['boneless', 0.5, null]]);
    expect(items('750g skinless curry')).toEqual([['skinless', 0.75, 'Curry cut']]);
    expect(items('kaal kilo boneless')).toEqual([['boneless', 0.25, null]]);
    expect(items('onnarai kilo country curry cut')).toEqual([['country', 1.5, 'Curry cut']]);
    expect(items('12 muttai')).toEqual([['eggs', 12, null]]);
  });

  it('prefers the longest name and maps cut words to the product\'s own cuts', () => {
    expect(items('2 kg country chicken')).toEqual([['country', 2, null]]);
    expect(items('broiler small pieces')).toEqual([['broiler', null, 'Curry cut']]);
    expect(items('broiler periya piece')).toEqual([['broiler', null, 'Biryani cut']]);
    expect(items('broiler muzhusa')).toEqual([['broiler', null, 'Whole']]);
    expect(items('skinless fry cut')).toEqual([['skinless', null, null]]); // skinless has no fry cut
  });

  it('two products with the same alias: the one for sale wins ("12 eggs" is never the hidden product)', () => {
    const products = [
      { id: 'old', name: 'Country Eggs', unit: 'piece' as const, aliases: ['eggs', 'egg'], cutOptions: [], available: false },
      { id: 'new', name: 'Eggs', unit: 'piece' as const, aliases: ['eggs', 'egg'], cutOptions: [], available: true },
    ];
    expect(parseItems('2 kg drumsticks and 12 eggs', products).items).toEqual([expect.objectContaining({ itemId: 'new', quantity: 12 })]);
  });

  it('keeps product-less amounts and cuts for the product being discussed', () => {
    expect(parseItems('3 kg', P).loose).toEqual({ quantity: 3, qtyUnit: 'kg' });
    expect(parseItems('curry cut', P).loose).toEqual({ cut: 'curry' });
    expect(parseItems('கறி கட்', P).loose).toEqual({ cut: 'curry' });
  });

  it('never reads clock times, durations or phone numbers as kg', () => {
    expect(parseItems('6 mani varen', P).loose).toEqual({});
    expect(parseItems('30 nimishathula', P).loose).toEqual({});
    expect(parseItems('9876543210', P).loose).toEqual({});
  });
});

describe('payment', () => {
  it('cash, UPI, already paid online', () => {
    expect(parsePayment('cash la tharen')).toBe('cash_at_shop');
    expect(parsePayment('காசு')).toBe('cash_at_shop');
    expect(parsePayment('gpay')).toBe('upi_at_shop');
    expect(parsePayment('phonepe pannuren')).toBe('upi_at_shop');
    expect(parsePayment('already paid online')).toBe('paid_online');
    expect(parsePayment('gpay pannitten')).toBe('paid_online');
    expect(parsePayment('ஏற்கனவே online-ல பே பண்ணிட்டேன்')).toBe('paid_online');
    expect(parsePayment('2 kg broiler')).toBeUndefined();
  });
});

describe('pickup time (IST)', () => {
  it('relative times in Tanglish and Tamil', () => {
    expect(pickup('30 nimishathula varen')).toBe('2026-10-11 10:30');
    expect(pickup('oru mani nerathula')).toBe('2026-10-11 11:00');
    expect(pickup('ஒரு மணி நேரத்துல வரேன்')).toBe('2026-10-11 11:00');
    expect(pickup('ippo varen')).toBe('2026-10-11 10:00');
  });

  it('clock times resolve to the next time inside shop hours', () => {
    expect(pickup('saayangaalam 6 mani')).toBe('2026-10-11 18:00');
    expect(pickup('6 mani')).toBe('2026-10-11 18:00'); // 6 AM is before the shop opens
    expect(pickup('naalaikku kaalaila 10 manikku varen')).toBe('2026-10-12 10:00');
    expect(pickup('tomorrow 11 am')).toBe('2026-10-12 11:00');
    expect(pickup('9 am')).toBe('2026-10-12 09:00'); // already past today
    expect(pickup('cash')).toBe('none');
  });
});

describe('intents', () => {
  it('only explicit words confirm', () => {
    for (const t of ['sari', 'Sari', 'yes', 'ok', 'confirm pannunga', 'சரி', 'ஆமா']) expect(classify(t)).toBe('confirm');
    for (const t of ['sari 3 kg', 'maybe', 'yes but curry cut']) expect(classify(t)).not.toBe('confirm');
    expect(classify('venam')).toBe('decline');
  });

  it('recognises the common requests', () => {
    expect(classify('Hi')).toBe('greeting');
    expect(classify('வணக்கம்')).toBe('greeting');
    expect(classify('offer claim pannanum (GR50)', 'GR50')).toBe('offer');
    expect(classify('rate enna')).toBe('menu');
    expect(classify('order ready ah?')).toBe('order_status');
    expect(classify('staff kitta pesanum')).toBe('human');
    expect(classify('boneless venam')).toBe('remove');
  });
});

describe('helpers', () => {
  it('formats quantities', () => {
    expect(formatQty(2, 'kg')).toBe('2 kg');
    expect(formatQty(1.5, 'kg')).toBe('1.5 kg');
    expect(formatQty(0.5, 'kg')).toBe('500 g');
    expect(formatQty(12, 'piece')).toBe('12 pcs');
  });

  it('phones and order numbers', () => {
    expect(findPhone('Ravi +91 98765 43210')).toBe('9876543210');
    expect(findOrderNumber('GRATEFUL')).toBeUndefined();
    for (let i = 0; i < 100; i++) {
      const n = newOrderNumber();
      expect(findOrderNumber(`status ${n}`)).toBe(n);
    }
  });

  it('shop hours in IST', () => {
    expect(isOpen(shop, new Date('2026-10-11T12:00:00+05:30'))).toBe(true);
    expect(isOpen(shop, new Date('2026-10-11T22:00:00+05:30'))).toBe(false);
  });

  it('collected and cancelled orders cannot move', () => {
    expect(TRANSITIONS.completed).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
    expect(TRANSITIONS.ready).toContain('completed');
  });

  it('reads the reply on the order-ready call', () => {
    expect(readCallReply('சரி, பத்து நிமிஷத்துல வரேன்')).toBe('coming');
    expect(readCallReply('ok sari varen')).toBe('coming');
    expect(readCallReply('நாளைக்கு வரேன்')).toBe('later');
    expect(readCallReply('venam cancel pannunga')).toBe('cancel');
    expect(readCallReply('')).toBe('unclear');
  });

  it('drops model sentences with prices that are not in the catalogue', () => {
    const prices = new Set([220, 50]);
    expect(filterUnverifiedPrices('Broiler is ₹220 per kg. Mutton is ₹750!', prices)).toBe('Broiler is ₹220 per kg.');
    expect(filterUnverifiedPrices('Our chicken is cut fresh every morning.', prices)).toBe('Our chicken is cut fresh every morning.');
  });
});

describe('several products in one sentence', () => {
  it('does not give one amount to two products', () => {
    expect(items('broiler 2 kg country 1 kg')).toEqual([['broiler', 2, null], ['country', 1, null]]);
    expect(items('2 kg broiler 1 kg country')).toEqual([['broiler', 2, null], ['country', 1, null]]);
  });
});

describe('clock times are never quantities', () => {
  it('"1 kg boneless, cash, 19:56" keeps 1 kg (minutes above 50 used to turn "19" into 19 kg)', () => {
    const products = [{ id: 'b', name: 'Boneless Chicken', unit: 'kg' as const, aliases: ['boneless'], cutOptions: [], available: true }];
    for (const t of ['1 kg boneless, cash, 19:56', '1 kg boneless, cash, 7:55', '1 kg boneless, cash, 18:40', 'boneless 1 kg 20:59 ku varen']) {
      const r = parseItems(t, products);
      expect(r.items[0]?.quantity, t).toBe(1);
      expect(r.loose.quantity, t).toBeUndefined();
    }
  });
});


describe('spoken Tamil / Tanglish as speech-to-text writes it (regression: "unknown" intents, unpriced cart lines)', () => {
  const P = [
    { id: 'curry', name: 'Chicken Curry Cut', unit: 'kg' as const, aliases: ['curry cut', 'chicken curry cut', 'kari cut', 'கறி கட்'], cutOptions: [], available: true },
    { id: 'drum', name: 'Chicken Drumsticks', unit: 'kg' as const, aliases: ['drumstick', 'drumsticks', 'leg piece'], cutOptions: [], available: true },
    { id: 'breast', name: 'Chicken Breast', unit: 'kg' as const, aliases: ['breast', 'chicken breast'], cutOptions: [], available: true },
    { id: 'bl', name: 'Boneless Chicken', unit: 'kg' as const, aliases: ['boneless', 'boneless chicken'], cutOptions: [], available: true },
    { id: 'eggs', name: 'Eggs', unit: 'piece' as const, aliases: ['egg', 'eggs', 'muttai', 'முட்டை'], cutOptions: [], available: true },
  ];
  const first = (t: string) => parseItems(t, P).items.map((i) => [i.itemId, i.quantity, i.qtyUnit]);

  it('confirmations are more than one exact word', () => {
    for (const t of ['ஆமா', 'ஆமாங்க', 'ஆமா சரி', 'சரி சரி', 'சரி ஓகே', 'ஓகே கன்பார்ம் பண்ணுங்க', 'ok confirm pannunga', 'yes please confirm', 'ஆம்', 'ஆமா கன்பார்ம்', 'sari pa'])
      expect(classify(t), t).toBe('confirm');
    // never a confirmation when anything says no / change, or when it is an order detail
    for (const t of ['ஆமா ஆனா வேண்டாம்', 'ok but change it', 'yes 2 kg', 'சரி இல்ல', 'ok wait']) expect(classify(t), t).not.toBe('confirm');
  });

  it('declines, greetings, menu and "I want to order" in Tamil script', () => {
    for (const t of ['வேண்டா', 'இல்லங்க', 'no thanks', 'வேண்டாங்க']) expect(classify(t), t).toBe('decline');
    expect(classify('ஹலோ')).toBe('greeting');
    expect(classify('மெனு சொல்லுங்க')).toBe('menu');
    for (const t of ['order pannanum', 'நான் ஆர்டர் பண்ணணும்', 'I want to order']) expect(classify(t), t).toBe('order_start');
    expect(classify('முட்டை எடுத்துடுங்க')).toBe('remove');
  });

  it('quantities and units written in Tamil script are read (no unpriced cart line)', () => {
    expect(first('ஒன் கேஜி போன்லெஸ்')).toEqual([['bl', 1, 'kg']]);
    expect(first('டூ கேஜி கறி கட்')).toEqual([['curry', 2, 'kg']]);
    expect(first('அரைக் கிலோ போன்லெஸ்')).toEqual([['bl', 0.5, 'kg']]);
    expect(first('ஐநூறு கிராம் போன்லெஸ்')).toEqual([['bl', 0.5, 'kg']]);
    expect(first('ஒரு டஜன் முட்டை')).toEqual([['eggs', 12, 'piece']]);
    expect(first('fifty eggs')).toEqual([['eggs', 50, 'piece']]);
    expect(first('ஒரு கிலோ ட்ரம்ஸ்டிக்')).toEqual([['drum', 1, 'kg']]);
    expect(first('ப்ரெஸ்ட் ஒரு கிலோ')).toEqual([['breast', 1, 'kg']]);
  });

  it('UPI apps said in Tamil script', () => {
    for (const t of ['ஜி பே', 'போன் பே', 'ஜிபே', 'கூகுள் பே']) expect(parsePayment(t), t).toBe('upi_at_shop');
  });
});

describe('Chennai Tamil / Tanglish conversation cues (table-driven)', () => {
  it.each([
    ['Evlo aagum?', 'total'],
    ['total evlo?', 'total'],
    ['How much is the total?', 'total'],
    ['மொத்தம் எவ்வளவு?', 'total'],
    ['Ethana manikku varanum?', 'when'],
    ['eppo varalaam?', 'when'],
    ['What time should I come?', 'when'],
    ['Pickup-ku varren', 'coming'],
    ['vandhu vaangikiren', 'coming'],
    ['Innum oru kilo add pannunga', 'additive'],
    ['Innoru piece add pannunga', 'additive'],
    ['Adha remove pannunga', 'refers'],
    ['Illa, adha vendaam', 'refers'],
  ])('%s → %s', async (text, cue) => {
    const p = await import('./chicken-parse.js');
    const hits = { total: p.asksTotal(text), when: p.asksWhenToCome(text), coming: p.mentionsComing(text), additive: p.isAdditive(text), refers: p.refersToIt(text) };
    expect(hits[cue as keyof typeof hits]).toBe(true);
  });

  it('answers are not questions: "8 manikku varuven" is a time, not "when should I come?"', async () => {
    const p = await import('./chicken-parse.js');
    expect(p.asksWhenToCome('Naan 8 manikku varuven')).toBe(false);
    expect(p.asksTotal('Boneless price enna?')).toBe(false);
    expect(p.isAdditive('1 kg boneless')).toBe(false);
    expect(p.refersToIt('Rendu kilo curry cut venum')).toBe(false);
  });

  it.each([
    ['Seri, confirm pannunga', 'confirm'],
    ['Illa, adha vendaam', 'remove'],
    ['Adha remove pannunga', 'remove'],
    ['Delivery venum', 'delivery'],
    ['Enna menu irukku?', 'menu'],
    ['Price enna?', 'menu'],
    ['Menu-la irukkura price enna?', 'menu'],
  ])('classify(%s) = %s', (text, intent) => {
    expect(classify(text)).toBe(intent);
  });

  it.each([
    ['Cash kudukaren', 'cash_at_shop'],
    ['UPI pannuren', 'upi_at_shop'],
  ])('payment(%s) = %s', (text, choice) => {
    expect(parsePayment(text)).toBe(choice);
  });

  it('ASAP pickup words are a time ("seekiram" = earliest)', () => {
    const now = new Date('2026-10-14T06:30:00Z');
    for (const t of ['seekiram', 'சீக்கிரம்', 'as soon as possible', 'ready aanadhum'])
      expect(parsePickup(t, now, { opensAt: '07:00', closesAt: '22:00' }), t).toEqual({ kind: 'at', at: now });
  });

  it('language: Tanglish ordering sentences are Tanglish, not English (the chat switched to English)', async () => {
    const { detectLanguage } = await import('../conversation/language.js');
    for (const t of ['Ethana manikku varanum?', '1 kg boneless, UPI pannuren', 'Pickup-ku varren', 'Cash kudukaren', 'Naan 8 manikku varuven'])
      expect(detectLanguage(t).lang, t).toBe('tanglish');
    for (const t of ['I would like some chicken wings', 'Do you have boneless chicken?', 'Seven kg please', 'Hello, what do you have today?'])
      expect(detectLanguage(t).lang, t).toBe('english');
  });
});

describe('round 4: egg-only orders, product switches, completion, goodbye (table-driven)', () => {
  const P = [
    { id: 'curry', name: 'Chicken Curry Cut', unit: 'kg' as const, aliases: ['curry cut', 'kari cut'], cutOptions: [], available: true },
    { id: 'eggs', name: 'Eggs', unit: 'piece' as const, aliases: ['egg', 'eggs', 'muttai', 'முட்டை'], cutOptions: [], available: true },
  ];
  it.each([
    ['எட்டு', 8], ['five', 5], ['five five', 5], ['5 5', 5], ['எட்டு எட்டு', 8],
  ])('a number on its own (or repeated by speech-to-text) is one amount: %s → %d', (t, n) => {
    expect(parseItems(t, P).loose.quantity).toBe(n);
  });
  it.each([
    ['Order place pannunga', 'done'], ['Order place pannunga போதும்', 'done'], ['Place the order', 'done'], ['அவ்வளவுதான்', 'done'],
    ['Thanks, good night', 'goodbye'], ['Cut the call', 'goodbye'], ['hang up', 'goodbye'], ['Staff kitta pesanum', 'human'], ['cancel', 'decline'],
  ])('classify(%s) = %s', (t, intent) => expect(classify(t)).toBe(intent));
  it('chicken exclusion and "only" are recognised; a named product stays a product', async () => {
    const p = await import('./chicken-parse.js');
    for (const t of ['No chicken', 'எனக்கு chicken வேணாம்', 'Enakku chicken vendaam']) expect(p.excludesChicken(t), t).toBe(true);
    expect(p.excludesChicken('chicken irukka?')).toBe(false);
    for (const t of ['Egg mattum venum', 'எனக்கு eggs தான் வேணும்', 'eggs only']) expect(p.onlyThese(t), t).toBe(true);
    expect(parseItems('Chicken curry cut வேண்டாம்', P).items.map((i) => i.itemId)).toEqual(['curry']);
  });
  it('greetings are never a pickup time ("Thanks, good night" was 7 PM)', () => {
    const now = new Date('2026-10-14T06:30:00Z');
    for (const t of ['Thanks, good night', 'good evening', 'Good morning sir']) expect(parsePickup(t, now, { opensAt: '07:00', closesAt: '22:00' }).kind, t).toBe('none');
  });
});

describe('round 5: corrections, review intents, vague times (table-driven)', () => {
  const P = [{ id: 'eggs', name: 'Eggs', unit: 'piece' as const, aliases: ['egg', 'eggs', 'muttai', 'முட்டை'], cutOptions: [], available: true }];
  const amount = (t: string) => {
    const r = parseItems(t, P);
    return r.items[0]?.quantity ?? r.loose.quantity;
  };
  it.each([
    ['Not six pieces sir. I need only four.', 4],
    ['not 6, only 4', 4],
    ['six illa, naalu', 4],
    ['நாலு போதும்', 4],
    ['நான்கு முட்டை', 4],
    ['four eggs', 4],
    ['only 3', 3],
  ])('correction "%s" → %d (never the rejected number)', (t, n) => expect(amount(t)).toBe(n));
  it.each([
    ['change பண்ணனும்', 'change'], ['மாற்றணும்', 'change'], ['I want to change', 'change'],
    ['பண்ணு', 'confirm'], ['பண்ணிடு', 'confirm'], ['சரி', 'confirm'], ['ஆமாம்', 'confirm'], ['Yes', 'confirm'], ['No', 'decline'],
  ])('at the review: %s → %s', (t, intent) => expect(classify(t)).toBe(intent));
  it('vague "evening" is not a time; the hour said next is read inside it; "tomorrow 2" is 2 PM tomorrow', () => {
    const now = new Date('2026-10-14T06:30:00Z'); // 12:00 IST — derived from the given clock, never the real one
    const shop = { opensAt: '07:00', closesAt: '21:00' };
    const evening = parsePickup('evening', now, shop);
    expect(evening.kind).toBe('partial');
    const four = parsePickup('4', now, shop, evening.kind === 'partial' ? evening.draft : undefined);
    expect(four.kind === 'at' && four.at.toISOString()).toBe('2026-10-14T10:30:00.000Z'); // 16:00 IST
    const tomorrow = parsePickup('நாளைக்கு ரெண்டு மணிக்கு', now, shop);
    expect(tomorrow.kind === 'at' && tomorrow.at.toISOString()).toBe('2026-10-15T08:30:00.000Z'); // 14:00 IST next day
  });
});

describe('round 5: "no, 2 kg" is a correction to 2 kg, "not 2" rejects 2', () => {
  const P = [{ id: 'c', name: 'Country Chicken', unit: 'kg' as const, aliases: ['nattu kozhi', 'country'], cutOptions: [], available: true }];
  it.each([
    ['illa 2 kg nattu kozhi', 2],
    ['no, 2 kg country', 2],
  ])('%s → %d', (t, n) => expect(parseItems(t, P).items[0]?.quantity).toBe(n));
});

// Round 6: a catalogue shaped like the live one — generic "chicken" belongs to Broiler (off today), specific cuts are
// separate products, Country Chicken / Quail are meat, Eggs are plain eggs.
describe('specific products, egg kinds, edit words and slot answers (round 6)', async () => {
  const { bareNumber, findMentions, mentionPolarities, unitOnly } = await import('./chicken-parse.js');
  const L: Product[] = [
    { id: 'broiler', name: 'Broiler Chicken', unit: 'kg', aliases: ['broiler', 'chicken', 'kozhi', 'கோழி'], cutOptions: [], available: false },
    { id: 'country', name: 'Country Chicken', unit: 'kg', aliases: ['country chicken', 'nattu kozhi', 'nattukozhi', 'நாட்டுக்கோழி', 'நாட்டு கோழி'], cutOptions: [], available: false },
    { id: 'quail', name: 'Quail', unit: 'kg', aliases: ['quail', 'kaadai', 'காடை'], cutOptions: [], available: false },
    { id: 'curry', name: 'Chicken Curry Cut', unit: 'kg', aliases: ['curry cut', 'chicken curry cut', 'kari cut', 'கறி கட்'], cutOptions: [], available: true },
    { id: 'drum', name: 'Chicken Drumsticks', unit: 'kg', aliases: ['drumstick', 'drumsticks', 'leg piece', 'leg pieces', 'லெக் பீஸ்'], cutOptions: [], available: true },
    { id: 'breast', name: 'Chicken Breast', unit: 'kg', aliases: ['breast', 'chicken breast'], cutOptions: [], available: true },
    { id: 'eggs', name: 'Eggs', unit: 'piece', aliases: ['egg', 'eggs', 'muttai', 'முட்டை'], cutOptions: [], available: true },
  ];
  const got = (t: string) => parseItems(t, L).items.map((i) => [i.itemId, i.quantity ?? null, i.variant ?? null]);

  it.each([
    ['Chicken leg piece.', [['drum', null, null]]],
    ['chicken legs', [['drum', null, null]]],
    ['leg piece', [['drum', null, null]]],
    ['லெக் பீஸ்', [['drum', null, null]]],
    ['கால் பீஸ்', [['drum', null, null]]],
    ['2 kg chicken leg piece', [['drum', 2, null]]],
    ['chicken drumsticks 1 kg', [['drum', 1, null]]],
    ['chicken curry cut', [['curry', null, null]]],
    ['1 kg chicken', [['broiler', 1, null]]],
  ])('a named product is that product; "chicken" next to it is part of its name: %s', (t, want) => expect(got(t)).toEqual(want));

  it.each([
    ['nattukozhi muttai', [['eggs', null, 'nattukozhi']]],
    ['நாட்டுக்கோழி முட்டை இருக்கா', [['eggs', null, 'நாட்டுக்கோழி']]],
    ['6 nattu kozhi muttai', [['eggs', 6, 'nattu kozhi']]],
    ['country chicken eggs', [['eggs', null, 'country chicken']]],
    ['kaadai muttai', [['eggs', null, 'kaadai']]],
    ['chicken eggs', [['eggs', null, null]]],
    ['12 muttai', [['eggs', 12, null]]],
    ['nattu kozhi 1 kg', [['country', 1, null]]],
    ['quail availble ?', [['quail', null, null]]],
  ])('eggs OF a product are a kind of egg, never that product\'s meat: %s', (t, want) => expect(got(t)).toEqual(want));

  const cuts = (t: string) => parseItems(t, L).items.map((i) => [i.itemId, i.quantity ?? null, i.cutProduct ?? null]);
  it.each([
    ['broiler curry cut', [['broiler', null, 'curry']]],
    ['2 kg broiler curry cut', [['broiler', 2, 'curry']]],
    ['ரெண்டு கிலோ நாட்டு கோழி கறி கட்', [['country', 2, 'curry']]],
    ['curry cut country chicken', [['country', null, 'curry']]],
    ['chicken curry cut', [['curry', null, null]]],
    ['curry cut', [['curry', null, null]]],
    ['broiler chicken', [['broiler', null, null]]],
  ])('a kind of chicken + a cut is ONE request for that kind (the cut product is only an alternative): %s', (t, want) => expect(cuts(t)).toEqual(want));

  const pol = (t: string) => {
    const { toks, mentions } = findMentions(t, L);
    const p = mentionPolarities(toks, mentions);
    return mentions.map((m, i) => `${m.p.id}:${p[i]}`).join(' ');
  };
  it.each([
    ['Remove eggs', 'eggs:remove'],
    ['Eggs வேண்டாம்', 'eggs:remove'],
    ['egg எடுத்துருங்க வேண்டாம்', 'eggs:remove'],
    ['ஆறு egg வேண்டாம்', 'eggs:remove'],
    ['Chicken மட்டும் போதும்', 'broiler:only'],
    ['Egg மட்டும் வேண்டாம், chicken மட்டும்', 'eggs:remove broiler:only'],
    ['egg மட்டும் வேண்டாம் chicken மட்டும் போதும்', 'eggs:remove broiler:only'],
    ['ஆறு egg எடுத்துருங்க வேண்டாம் அது. ஆறு egg மட்டும் வேண்டாம். Chicken மட்டும் போதும்.', 'eggs:remove eggs:remove broiler:only'],
    ['ஆ change பண்ணுங்க. egg-அ close பண்ணிடுங்க வேண்டாம்.', 'eggs:remove'],
    ['No chicken', 'broiler:remove'],
    ['remove eggs and leg piece', 'eggs:remove drum:remove'],
    ['eggs venam, 1 kg breast', 'eggs:remove breast:none'],
    ['2 kg leg piece', 'drum:none'],
    ['egg mattum', 'eggs:only'],
    ['not eggs leg', 'eggs:remove drum:none'],
    ['not eggs, leg piece', 'eggs:remove drum:none'],
    ['eggs and leg piece venam', 'eggs:remove drum:remove'],
    ['eggs um leg piece um vendam', 'eggs:remove drum:remove'],
  ])('which product an edit word belongs to: %s', (t, want) => expect(pol(t)).toBe(want));

  it('a bare number and a bare unit are recognised as short answers', () => {
    expect(['4', 'naalu', 'நாலு', '4 mani', '11'].map(bareNumber)).toEqual([4, 4, 4, 4, 11]);
    expect(['4 eggs', '2 kg', 'a', '30', '4 pm cash'].map(bareNumber)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(['என்னங்க bro, kg-ல.', 'kilo la', 'pieces ah', '2 kg', 'leg piece'].map(unitOnly)).toEqual(['kg', 'kg', 'piece', undefined, undefined]);
  });
});
