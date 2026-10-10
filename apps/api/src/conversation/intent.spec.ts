import { describe, expect, it } from 'vitest';
import { classifyIntent, isExplicitAffirmation, isExplicitNegation, parseCallbackTime } from './intent.js';
import { istDate, istParts } from './when.js';

const NOW = istDate(2026, 10, 8, 13, 30);
const intent = (t: string, ctx = {}) => classifyIntent(t, ctx).intent;
const yes = (t: string) => isExplicitAffirmation(t, NOW).yes;

describe('the incident: "பேசலாம்" must never look like a booking confirmation', () => {
  it('is a consent to talk, not a yes', () => {
    expect(intent('பேசலாம்')).toBe('TALK_CONSENT');
    expect(yes('பேசலாம்')).toBe(false);
    expect(yes('பேசலாம்.')).toBe(false);
    expect(yes('pesalam')).toBe(false);
    expect(yes('சொல்லுங்க')).toBe(false);
  });
  it('hello / generic acknowledgements are not confirmations of anything specific', () => {
    expect(intent('hello')).toBe('GREETING_ACK');
    expect(intent('வணக்கம்')).toBe('GREETING_ACK');
    expect(intent('ஹலோ')).toBe('GREETING_ACK');
  });
});

describe('isExplicitAffirmation (strict whitelist)', () => {
  it.each([
    'yes', 'Yes.', 'yes please', 'ok', 'okay', 'sure', 'confirm', 'yes confirm', 'ஆமா', 'ஆமாங்க', 'சரி', 'சரிங்க', 'ஓகே', 'ஆமா book பண்ணுங்க',
    'book பண்ணுங்க', 'confirm பண்ணுங்க', 'aama pannunga', 'sari book pannunga', 'seri', 'கண்டிப்பா', 'yes book it', 'ok go ahead',
  ])('accepts %s', (t) => expect(yes(t)).toBe(true));

  it.each([
    '', 'hmm', 'பேசலாம்', 'yes but not saturday', 'yes tomorrow', 'ok saturday 5 pm', 'ஆமா ஆனா வேற நாள்', 'no', 'illa', 'வேண்டாம்', 'maybe', 'later',
    'sari apram sollren', 'yes?', 'சரியா?', 'ok what time', 'எப்போ', 'yes I will think about it', 'ஆமா நான் யோசிக்கிறேன்', 'price evlo', 'Porur la 2 bhk',
    'ok bye', 'yes call me later', 'enna',
  ])('rejects %s', (t) => expect(yes(t)).toBe(false));
});

describe('isExplicitNegation (refusing the proposed visit)', () => {
  it.each(['no', 'illa', 'வேண்டாம்', 'visit வேண்டாம்', 'cancel', 'வேற நாள்', 'another day', 'vera time'])('%s', (t) => expect(isExplicitNegation(t)).toBe(true));
  it.each(['yes', 'ok', 'பேசலாம்', 'sari'])('%s is not a negation', (t) => expect(isExplicitNegation(t)).toBe(false));
});

describe('classifyIntent safety intents', () => {
  it('not interested needs a strong signal; weak "no" only counts when it is the whole answer', () => {
    expect(intent('not interested')).toBe('NOT_INTERESTED');
    expect(intent('வேண்டாம்')).toBe('NOT_INTERESTED');
    expect(intent('வேண்டாம் சார்')).toBe('NOT_INTERESTED');
    expect(intent('interest illa')).toBe('NOT_INTERESTED');
    expect(intent('please don\'t call me again')).toBe('NOT_INTERESTED');
    expect(intent('already vaangiten')).toBe('NOT_INTERESTED');
    // not a destructive intent:
    expect(intent('2 bhk வேண்டாம் 3 bhk பாக்கறேன்')).not.toBe('NOT_INTERESTED');
    expect(intent('இப்ப வேண்டாம் அப்புறம் கூப்பிடுங்க')).toBe('CALLBACK_REQUEST');
    expect(intent('visit வேண்டாம்')).not.toBe('NOT_INTERESTED');
  });
  it('during a visit confirmation a bare "வேண்டாம்" refuses the visit only', () => {
    expect(intent('வேண்டாம்', { awaitingVisitConfirmation: true })).not.toBe('NOT_INTERESTED');
    expect(intent('not interested', { awaitingVisitConfirmation: true })).toBe('NOT_INTERESTED');
  });
  it('recognizes appointment cancellation requests for human review', () => {
    expect(intent('Cancel all appointments')).toBe('CANCELLATION_REQUEST');
    expect(intent('cancel my booking')).toBe('CANCELLATION_REQUEST');
    expect(intent('appointment cancel pannunga')).toBe('CANCELLATION_REQUEST');
  });

  it('wrong number / human / callback / goodbye', () => {
    expect(intent('wrong number')).toBe('WRONG_NUMBER');
    expect(intent('naan enquiry pannala')).toBe('WRONG_NUMBER');
    expect(intent('agent kitta pesanum')).toBe('HUMAN_REQUEST');
    expect(intent('I want to talk to a human')).toBe('HUMAN_REQUEST');
    expect(intent('நாளைக்கு call பண்ணுங்க')).toBe('CALLBACK_REQUEST');
    expect(intent('I am busy now')).toBe('CALLBACK_REQUEST');
    expect(intent('bye')).toBe('GOODBYE');
    expect(intent('சரி bye')).toBe('GOODBYE');
    expect(intent('thank you')).toBe('UNKNOWN');
    expect(intent('thank you', { closing: true })).toBe('GOODBYE');
  });
  it('visit interest and repeat', () => {
    expect(intent('site visit பண்ணலாம்')).toBe('VISIT_INTEREST');
    expect(intent('நேர்ல பாக்கணும்')).toBe('VISIT_INTEREST');
    expect(intent('என்ன')).toBe('REPEAT_REQUEST');
    expect(intent('திரும்ப சொல்லுங்க')).toBe('REPEAT_REQUEST');
  });
  it('ordinary qualification answers are UNKNOWN (left to slots / the model)', () => {
    expect(intent('Porur la 2 BHK')).toBe('UNKNOWN');
    expect(intent('80 lakhs')).toBe('UNKNOWN');
  });
});

describe('parseCallbackTime', () => {
  it('tomorrow evening -> 18:00 IST tomorrow; later -> undefined; date only -> 11:00', () => {
    const a = parseCallbackTime('நாளைக்கு evening call பண்ணுங்க', NOW)!;
    expect(istParts(a)).toMatchObject({ day: 9, hour: 18 });
    expect(parseCallbackTime('call me later', NOW)).toBeUndefined();
    expect(istParts(parseCallbackTime('நாளைக்கு கூப்பிடுங்க', NOW)!)).toMatchObject({ day: 9, hour: 11 });
  });
  it('a time earlier than now today rolls to tomorrow', () => {
    expect(istParts(parseCallbackTime('காலை 10 மணிக்கு call பண்ணுங்க', NOW)!)).toMatchObject({ day: 9, hour: 10 });
  });
});
