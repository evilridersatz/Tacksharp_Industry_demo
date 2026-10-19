import { describe, expect, it } from 'vitest';
import { asksLocation, commonQuestion, isExplicitAffirmation, isLineCheck } from './intent.js';
import { findNamedProperty } from './property-match.js';
import { extractSlots } from './slots.js';
import { bookedSpoken, confirmQuestionSpoken, presentProperties, shortName, whenNoted } from './replies.js';
import { addIstDays, istDate, parseWhen, spokenWhen } from './when.js';

const props = [
  { id: '1', name: 'Green Valley Apartments', location: 'Porur', type: 'Apartment', bhk: 2, price: 8_000_000, priceText: '80 lakhs' },
  { id: '2', name: 'Porur Heights', location: 'Porur', type: 'Apartment', bhk: 2, price: 9_500_000, priceText: '95 lakhs' },
];

describe('voice fast path (real call 2026-10-10 evening)', () => {
  it('everyday side questions are recognised by rules', () => {
    expect(commonQuestion('ஆ சரி. நீங்க போறீங்களா?')).toBe('accompany');
    expect(commonQuestion('நீங்க கூட வருவீங்களா?')).toBe('accompany');
    expect(commonQuestion('will you come with me?')).toBe('accompany');
    expect(commonQuestion('நீங்க AI-ஆ?')).toBe('ai');
    expect(commonQuestion('are you a robot?')).toBe('ai');
    expect(commonQuestion('neenga machine-aa?')).toBe('ai');
    expect(commonQuestion('என்ன properties இருக்கு?')).toBe('whatProperties');
    expect(commonQuestion('what options do you have?')).toBe('whatProperties');
    expect(commonQuestion('Show me the options')).toBe('whatProperties');
    expect(commonQuestion('please send all the properties')).toBe('whatProperties');
    expect(commonQuestion('show me the way to the site')).toBeUndefined();
    expect(commonQuestion('Porur la 2 BHK venum')).toBeUndefined();
    expect(commonQuestion('சரிங்க')).toBeUndefined();
    expect(commonQuestion('நாளைக்கு காலை ஒம்பது மணி')).toBeUndefined();
  });

  it('spoken list: short names + prices, no location / "அப்புறம்"; names only when the budget was just given', () => {
    const r = presentProperties('ta', props, 2);
    expect(r).toBe('Green Valley 80 lakhs, Porur Heights 95 lakhs. எதை பாக்கலாம்?');
    const noPrice = presentProperties('ta', props, 2, { withPrice: false });
    expect(noPrice).not.toMatch(/lakhs/);
    expect(noPrice).toMatch(/Green Valley, Porur Heights/);
    expect(presentProperties('ta', [props[0]], 2, { withPrice: false })).toBe('Green Valley இருக்கு. பாக்கலாமா?');
  });

  it('short names never clash and never cut to one word', () => {
    expect(shortName('Green Valley Residency')).toBe('Green Valley Residency'); // brand word kept
    expect(shortName('Anna Nagar Residency')).toBe('Anna Nagar Residency'); // would sound like the area
    expect(shortName('Green Valley Apartments')).toBe('Green Valley');
    expect(shortName('Metro Square')).toBe('Metro Square');
    expect(shortName('Sunrise Apartments')).toBe('Sunrise Apartments');
    expect(shortName('Green Valley Apartments', [{ name: 'Green Valley Apartments' }, { name: 'Green Valley Homes' }])).toBe('Green Valley Apartments');
  });

  it('confirmation and booking lines are short: "Green Valley, நாளைக்கு 9 மணி. Confirm பண்ணட்டுமா?"', () => {
    const now = new Date();
    const t = addIstDays(now, 1);
    const at = istDate(t.year, t.month, t.day, 9, 0);
    expect(confirmQuestionSpoken('ta', 'Green Valley Apartments', at, now)).toBe('Green Valley, நாளைக்கு 9 மணி. Confirm பண்ணட்டுமா?');
    expect(bookedSpoken('ta', 'Green Valley Apartments', at, now)).toBe('நாளைக்கு 9 மணிக்கு Green Valley book பண்ணிட்டேன். Thank you!'); // after a cached "சூப்பர்."
    const pm = istDate(t.year, t.month, t.day, 17, 30);
    expect(spokenWhen(pm, 'ta', now)).toBe('நாளைக்கு சாயங்காலம் 5:30 மணி');
    // Beyond tomorrow the exact date is still said: a visit is never confirmed on a weekday alone.
    const later = addIstDays(now, 4);
    expect(spokenWhen(istDate(later.year, later.month, later.day, 11, 0), 'ta', now)).toContain(String(later.day));
  });

  it('a day / time heard before a property is chosen is acknowledged in a few words', () => {
    const now = new Date();
    expect(whenNoted('ta', parseWhen('Tomorrow 11 AM.', now), now)).toBe('சரிங்க. நாளைக்கு 11 மணி.');
    expect(whenNoted('ta', parseWhen('நாளைக்கு காலை ஒம்பது மணி', now), now)).toBe('சரிங்க. நாளைக்கு 9 மணி.');
  });
});

describe('real call 2026-10-10 (inbound)', () => {
  it('"சரி பண்ணிருங்க" and other spoken "do it" forms are a yes; "பண்ணாதீங்க" is not', () => {
    for (const yes of ['சரி', 'ஆமாம்', 'ஆமா', 'ஆம்', 'yes', 'book பண்ணுங்க', 'பண்ணுங்க', 'பண்ணிருங்க', 'செஞ்சிருங்க', 'செஞ்சிடுங்க', 'சரி பண்ணிடுங்க', 'சரி பண்ணிருங்க.', 'pannirunga', 'senjidunga', 'book pannirunga', 'confirm பண்ணிருங்க']) {
      expect(isExplicitAffirmation(yes).yes, yes).toBe(true);
    }
    for (const no of ['வேண்டாம்', 'பண்ணாதீங்க', 'cancel', 'no', 'இல்லை', 'வேண்டவே வேண்டாம்', 'வேண்டாம் பண்ணாதீங்க', 'சரி பண்ணிருங்க ஆனா வேற நாள்']) {
      expect(isExplicitAffirmation(no).yes, no).toBe(false);
    }
  });
  it('location questions are recognised', () => {
    for (const q of ['எந்த location?', 'எங்க இருக்கு?', 'endha area?', 'where is it?', 'location enna?']) expect(asksLocation(q)).toBe(true);
    for (const q of ['Porur la venum', 'சரி', 'budget evlo?']) expect(asksLocation(q)).toBe(false);
  });
  it('the list names the area when asked for (customer did not say it)', () => {
    expect(presentProperties('ta', [props[0]], 2, { withArea: true })).toBe('Porur-ல Green Valley 80 lakhs இருக்கு. பாக்கலாமா?');
  });
});

describe('language: short Tamil-family lines keep the current language', () => {
  it('"Done. Okay. பார்க்கலாம்." / "சாயங்காலம் நாலு மணிக்கு." do not flip Tamil <-> Tanglish', async () => {
    const { turnLanguage } = await import('./language.js');
    expect(turnLanguage('Done. Okay. பார்க்கலாம்.', 'tamil')).toMatchObject({ reply: 'tamil', changed: false });
    expect(turnLanguage('சாயங்காலம் நாலு மணிக்கு.', 'tanglish')).toMatchObject({ reply: 'tanglish', changed: false });
    expect(turnLanguage('எனக்கு Porur-ல ஒரு நல்ல 2 BHK apartment வேணும் budget கம்மியா', 'english')).toMatchObject({ changed: true });
  });
});

describe('real calls 2026-10-10 (20:28)', () => {
  it('line checks are recognised; real answers are not', () => {
    for (const t of ['Hello.', 'ஹலோ ஹலோ', 'sound இல்லையா?', 'Hello என்ன பேசவே மாட்டேங்குது.', 'கேக்குதா?', 'can you hear me?', 'voice varala']) expect(isLineCheck(t), t).toBe(true);
    for (const t of ['ஆமா', 'Hello, Porur la 2 BHK venum', 'அப்போ Anna Nagar Residency-ல', 'budget evlo?']) expect(isLineCheck(t), t).toBe(false);
  });
  it('a property is found by name from the whole inventory; an area alone never picks one', () => {
    const inv = [
      { id: 'a', name: 'Anna Nagar Residency', location: 'Anna Nagar, Chennai' },
      { id: 'g', name: 'Green Valley Residency', location: 'Porur, Chennai' },
      { id: 'p', name: 'Porur Premium', location: 'Porur, Chennai' },
      { id: 'h', name: 'Porur Heights', location: 'Porur, Chennai' },
    ];
    const areas = ['Anna Nagar', 'Porur', 'OMR'];
    expect(findNamedProperty('Hello இது பேசுங்க இந்த Anna Nagar Residency.', inv, areas)?.id).toBe('a');
    expect(findNamedProperty('அப்போ Anna Nagar Residency-ல', inv, areas)?.id).toBe('a');
    expect(findNamedProperty('Green Valley பாக்கலாமா', inv, areas)?.id).toBe('g');
    expect(findNamedProperty('Porur Premium', inv, areas)?.id).toBe('p');
    expect(findNamedProperty('Anna Nagar-ல வேணும்', inv, areas)).toBeUndefined();
    expect(findNamedProperty('Porur-ல 2 BHK வேணும்', inv, areas)).toBeUndefined();
  });
});

describe('P0 test 5: real Tanglish speech still extracts', () => {
  it('"Porur-la property venum" -> location Porur', () => {
    expect(extractSlots('Porur-la property venum', { knownLocations: ['Porur', 'OMR', 'Velachery'] }).slots.location).toBe('Porur');
  });
});

describe('startup audio warm-up', () => {
  it('only ~10 short lines are synthesized at startup (it used to be 100+, which earned Sarvam 429s)', async () => {
    const { startupAudioLines } = await import('../voice/voice.service.js');
    const lines = startupAudioLines();
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(lines.length).toBeLessThanOrEqual(14);
    expect(lines).toContain('சரிங்க.');
    expect(lines.every((l) => l.length <= 80)).toBe(true); // acks, wait lines, "didn't hear" prompts
  });
});
