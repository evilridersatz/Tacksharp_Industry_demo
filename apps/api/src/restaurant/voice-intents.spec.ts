import { describe, expect, it } from 'vitest';
import { asksAvailability, classify, filterAvailabilityClaims, isGoodbye, parseItems, questionKind, romanizeLoanwords } from './chicken-parse.js';
import { say, spoken, toSpeech } from './replies.js';
import { decideCallEnd } from '../voice/voice.service.js';
import { AiService } from '../ai/ai.service.js';

const PROPERTY_WORDS = /\b(BHK|property|properties|site visit|apartment|villa|plot|lakhs?|Porur|Green Valley|Lake View)\b/i;

describe('goodbye and delivery intents (WhatsApp and phone)', () => {
  it('explicit goodbyes in Tamil, Tanglish and English', () => {
    for (const t of ['bye', 'Bye bye', 'ok bye', 'seri bye', 'thanks bye', 'thank you, bye', 'சரி, வைக்கிறேன்', 'சரி பை', 'goodbye', "that's all, thanks"]) {
      expect(isGoodbye(t), t).toBe(true);
      expect(classify(t), t).toBe('goodbye');
    }
  });

  it('a normal question or an order is never a goodbye (the call stays open)', () => {
    for (const t of ['rate enna?', 'ரெண்டு கிலோ broiler curry cut வேணும்', '2 kg broiler curry cut, cash, 6 mani, bye', 'சரி', 'ok', 'thanks', 'Hello?', 'eppo ready aagum', 'cash']) {
      expect(isGoodbye(t), t).toBe(false);
      expect(classify(t), t).not.toBe('goodbye');
    }
    // "yes" and "ok" stay confirmations: they place an order only at the confirmation step.
    expect(classify('ok')).toBe('confirm');
    expect(classify('ஆமா')).toBe('confirm');
  });

  it('delivery requests are recognised (GR Chicken is pickup only)', () => {
    for (const t of ['home delivery irukka?', 'Velachery ku delivery pannuveengala', 'veetuku anuppunga', 'டெலிவரி இருக்கா', 'can you deliver to Adyar']) expect(classify(t), t).toBe('delivery');
    expect(say.pickupOnly('en', 'GR Chicken Shop')).toContain("we don't deliver");
  });
});

describe('spoken restaurant lines', () => {
  const lines = [
    spoken.outboundOpening('ta', { name: 'Priya', business: 'GR Chicken' }),
    spoken.outboundOpening('en', { business: 'GR Chicken' }),
    spoken.inboundOpening('ta', { business: 'GR Chicken' }),
    spoken.askPayment('ta'),
    spoken.askPickup('ta', 'GR Chicken Shop', '07:00', '21:00'),
    spoken.help('ta'),
    spoken.handoff('en'),
    spoken.menu('ta', [{ name: 'Broiler Chicken', price: 220, unit: 'kg', available: true, isDemo: false }]),
  ];

  it('openings and prompts never mention property, BHK or an earlier enquiry', () => {
    for (const l of lines) expect(l).not.toMatch(PROPERTY_WORDS);
    expect(lines[0]).toContain('GR Chicken');
    expect(lines[0]).toContain('AI assistant');
    expect(lines[0]).not.toContain('enquiry');
  });

  it('menu on the phone is spoken from catalogue data (no bullets, symbols or unavailable items)', () => {
    const m = spoken.menu('en', [
      { name: 'Broiler Chicken', price: 220, unit: 'kg', available: true, isDemo: false },
      { name: 'Chicken Liver', price: 160, unit: 'kg', available: false, isDemo: false },
    ]);
    expect(m).toBe("Today's prices: Broiler Chicken, 220 rupees a kilo.");
    expect(spoken.menu('ta', [])).toContain('confirm பண்ண முடியல'); // unknown stock is never "nothing available"
  });

  it('toSpeech strips WhatsApp formatting and emoji and says rupees', () => {
    const t = toSpeech('✅ Order *GR-ABC123* confirm aachu — ₹390.\nNandri! 🙏', 'ta');
    expect(t).not.toMatch(/[*✅🙏₹\n]/u);
    expect(t).toContain('390 ரூபாய்');
    expect(toSpeech('Total ₹440', 'en')).toBe('Total 440 rupees');
  });
});

describe('when a call ends (decideCallEnd)', () => {
  const base = { vertical: 'restaurant' as const, turns: 1, maxTurns: 24, endCall: false, failed: false };

  it('a normal answer on turn 1 keeps the call open (the reported 18-second call)', () => {
    expect(decideCallEnd(base)).toEqual({ end: false });
    expect(decideCallEnd({ ...base, turns: 5 })).toEqual({ end: false });
  });

  it('ends only on an explicit end from the engine, with its reason', () => {
    expect(decideCallEnd({ ...base, endCall: true, endReason: 'customer_goodbye' })).toEqual({ end: true, reason: 'customer_goodbye' });
    expect(decideCallEnd({ ...base, endCall: true })).toEqual({ end: true, reason: 'conversation_end' });
  });

  it('bounded: the call ends at the maximum number of turns', () => {
    expect(decideCallEnd({ ...base, turns: 24 })).toEqual({ end: true, reason: 'max_turns' });
  });

  it('a failed restaurant turn asks again instead of hanging up; real estate keeps its documented technical end', () => {
    expect(decideCallEnd({ ...base, failed: true })).toEqual({ end: false });
    expect(decideCallEnd({ ...base, vertical: 'real_estate', failed: true })).toEqual({ end: true, reason: 'technical' });
  });

  it('restaurant turn results map to call actions only when the customer ended it', () => {
    expect(AiService.restaurantActions({})).toEqual({});
    expect(AiService.restaurantActions({ endCall: false })).toEqual({});
    expect(AiService.restaurantActions({ endCall: true, endReason: 'customer_goodbye' })).toEqual({ endCall: true });
    expect(AiService.restaurantActions({ order: { status: 'created' } })).toEqual({ outcome: 'order_placed' });
    expect(AiService.restaurantActions({ endCall: true, endReason: 'handoff' })).toEqual({ endCall: true, outcome: 'human_requested' });
  });
});

describe('availability is the catalogue\'s word', () => {
  it('availability questions are recognised in Tanglish, Tamil and English', () => {
    for (const t of ['chicken irukka?', 'boneless available ah', 'stock irukka', 'கோழி இருக்கா?', 'do you have liver', 'mutton kidaikuma']) expect(asksAvailability(t), t).toBe(true);
    for (const t of ['2 kg broiler curry cut', 'cash', 'Hi', 'eppo ready']) expect(asksAvailability(t), t).toBe(false);
  });

  it('model sentences claiming something is unavailable are removed; the rest is kept', () => {
    expect(filterAvailabilityClaims('Sorry, chicken is not available today. Country Chicken is ₹450 per kg.')).toBe('Country Chicken is ₹450 per kg.');
    expect(filterAvailabilityClaims('Broiler inniku illa. Shop 7 mani open.')).toBe('Shop 7 mani open.');
    expect(filterAvailabilityClaims('சிக்கன் இப்போ இல்ல. நன்றி!')).toBe('நன்றி!');
    expect(filterAvailabilityClaims('We are out of stock.')).toBe('');
    expect(filterAvailabilityClaims('Problem illa, staff will help.')).toBe('Problem illa, staff will help.');
  });

  it('an unknown / unloaded catalogue is "cannot confirm", never "nothing available"', () => {
    expect(spoken.menu('en', [])).toContain("can't confirm");
    expect(spoken.menu('en', [{ name: 'Broiler Chicken', price: 220, unit: 'kg', available: false, isDemo: false }])).toContain('sold out');
    expect(say.menuUnverified('tl')).toContain('confirm panna mudiyala');
    expect(say.notInList('en', ['Broiler Chicken'])).not.toMatch(/not available|unavailable/i);
  });
});

describe('questions are recognised before anything is ordered', () => {
  const products = [
    { id: 'b', name: 'Broiler Chicken', unit: 'kg' as const, aliases: ['broiler', 'chicken', 'kozhi', 'கோழி'], cutOptions: ['Curry cut'], available: true },
    { id: 'c', name: 'Country Chicken', unit: 'kg' as const, aliases: ['country', 'nattu kozhi'], cutOptions: ['Curry cut'], available: true },
    { id: 'l', name: 'Chicken Liver', unit: 'kg' as const, aliases: ['liver'], cutOptions: [], available: true },
  ];
  it('stock-quantity and which-is-available questions in English, Tanglish and Tamil', () => {
    for (const t of ['How much stock is available?', 'stock evlo irukku', 'stock எவ்வளவு இருக்கு', 'how many kg left', 'ethana kg irukku']) expect(questionKind(t), t).toBe('stock_qty');
    for (const t of ['Which chicken is available?', 'enna chicken irukku', 'என்ன chicken இருக்கு?', 'what do you have today']) expect(questionKind(t), t).toBe('list_available');
    expect(questionKind('Do you have chicken liver?')).toBe('availability');
    for (const t of ['2 kg broiler curry cut', 'cash', 'ok']) expect(questionKind(t), t).toBeUndefined();
  });
  it('"chicken" alone is generic; a named product is not (the cause of the repeated broiler question)', () => {
    expect(parseItems('Which chicken is available?', products).items).toEqual([expect.objectContaining({ itemId: 'b', generic: true })]);
    expect(parseItems('Do you have chicken liver?', products).items).toEqual([expect.objectContaining({ itemId: 'l', generic: false })]);
    expect(parseItems('country chicken 2 kg', products).items).toEqual([expect.objectContaining({ itemId: 'c', generic: false, quantity: 2 })]);
  });
  it('Tamil-script English words are understood ("கண்ட்ரி சிக்கன்" = country chicken)', () => {
    expect(romanizeLoanwords('கண்ட்ரி சிக்கன் இருக்கா')).toBe('country chicken இருக்கா');
    expect(parseItems('கண்ட்ரி சிக்கன் ரெண்டு கிலோ', products).items).toEqual([expect.objectContaining({ itemId: 'c', quantity: 2 })]);
    expect(parseItems('லிவர் வேணும்', products).items).toEqual([expect.objectContaining({ itemId: 'l' })]);
  });
});
