import { describe, expect, it } from 'vitest';
import { extractSlots, qualificationState, findLocation } from './slots.js';
import { assessTranscript } from './transcript-gate.js';
import { detectLanguage, initialLanguage, updateLanguage, replyStyle, type LanguageState } from './language.js';
import { checkVisitTime } from './booking-rules.js';
import { istDate } from './when.js';

const KNOWN = ['Porur', 'OMR', 'Tambaram', 'Velachery', 'Guduvanchery'];
const slots = (t: string, expecting?: any) => extractSlots(t, { knownLocations: KNOWN, expecting }).slots;

describe('rules-first slot extraction', () => {
  it('English, Tanglish and Tamil-script requirements', () => {
    expect(slots('I want a 2 BHK in Porur under 80 lakhs')).toEqual({ location: 'Porur', bhk: 2, budget: 8_000_000 });
    expect(slots('Porur la 2bhk iruka? Budget eighty lakhs kulla venum')).toMatchObject({ location: 'Porur', bhk: 2, budget: 8_000_000 });
    expect(slots('போரூர்ல 2 BHK வேணும், எண்பது லட்சம் budget')).toMatchObject({ location: 'Porur', bhk: 2, budget: 8_000_000 });
    expect(slots('1.2 crore budget OMR villa')).toMatchObject({ location: 'OMR', budget: 12_000_000, propertyType: 'Villa' });
  });
  it('a bare number is only a budget / BHK when we just asked for it', () => {
    expect(slots('80')).toEqual({});
    expect(slots('80', 'budget')).toEqual({ budget: 8_000_000 });
    expect(slots('2', 'bhk')).toEqual({ bhk: 2 });
    expect(slots('hello 2 mani')).toEqual({});
  });
  it('does not mistake "site visit" for a plot, or phone digits for a budget', () => {
    expect(slots('site visit paakanum')).toEqual({});
    expect(slots('my number is 9884012345')).toEqual({});
  });
  it('unknown places are reported, never silently guessed', () => {
    const r = extractSlots('Kolathur la venum', { knownLocations: KNOWN });
    expect(r.slots.location).toBeUndefined();
    expect(r.unknownLocation).toBe('Kolathur');
  });
  it('short names need a real suffix, so ordinary words do not match', () => {
    expect(findLocation('omr la', KNOWN)).toBe('OMR');
    expect(findLocation('homr', KNOWN)).toBeUndefined();
  });
  it('qualification: location + budget + (bhk or type); asks one thing at a time', () => {
    expect(qualificationState({})).toMatchObject({ complete: false, next: 'location' });
    expect(qualificationState({ location: 'Porur' })).toMatchObject({ next: 'budget' });
    expect(qualificationState({ location: 'Porur', budget: 1 })).toMatchObject({ next: 'bhk' });
    expect(qualificationState({ location: 'Porur', budget: 1, propertyType: 'Plot' }).complete).toBe(true);
    expect(qualificationState({ location: 'Porur', budget: 1, bhk: 2 }).complete).toBe(true);
  });
  it('timeline phrases', () => {
    expect(slots('within 3 months').timeline).toBe('within 3 months');
    expect(slots('urgent ah venum').timeline).toBe('immediately');
  });
});

describe('transcript quality gate', () => {
  it('rejects empty, repetition loops and foreign-script garbage', () => {
    expect(assessTranscript({ transcript: '   ' }).verdict).toBe('reject');
    expect(assessTranscript({ transcript: 'the the the the the the' }).verdict).toBe('reject');
    expect(assessTranscript({ transcript: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ ਕਿਵੇਂ ਹੋ', sttLanguage: 'pa-IN' }).verdict).toBe('reject');
    expect(assessTranscript({ transcript: 'કેમ છો મજામાં', sttLanguage: 'gu-IN' }).verdict).toBe('reject');
  });
  it('a recognised one-word answer is fine; a meaningless fragment is weak', () => {
    expect(assessTranscript({ transcript: 'பேசலாம்' }).verdict).toBe('ok');
    expect(assessTranscript({ transcript: 'yes' }).verdict).toBe('ok');
    expect(assessTranscript({ transcript: 'k' }).verdict).toBe('weak');
    expect(assessTranscript({ transcript: '80' }).verdict).toBe('weak');
  });
  it('Tamil words with a wrong STT language label are kept but flagged weak (never used to learn language)', () => {
    const r = assessTranscript({ transcript: 'போரூர்ல 2 BHK வேணும்', sttLanguage: 'pa-IN' });
    expect(r.verdict).toBe('weak');
    expect(r.reasons.join()).toContain('unreliable_stt_language:pa-in');
  });
  it('a day / time or an inventory name is never rejected for a wrong STT language label (real call: "Tomorrow 11 AM." as te-IN)', () => {
    expect(assessTranscript({ transcript: 'Tomorrow 11 AM.', sttLanguage: 'te-IN' }).verdict).not.toBe('reject');
    expect(assessTranscript({ transcript: 'Tomorrow.', sttLanguage: 'te-IN' }).verdict).not.toBe('reject');
    expect(assessTranscript({ transcript: 'tomorrow morning', sttLanguage: 'te-IN' }).verdict).not.toBe('reject');
    expect(assessTranscript({ transcript: 'Green Valley', sttLanguage: 'te-IN', knownTerms: ['Green Valley Residency', 'Green Valley', 'Porur'] }).verdict).not.toBe('reject');
    expect(assessTranscript({ transcript: 'blah blah', sttLanguage: 'te-IN', knownTerms: ['Porur'] }).verdict).toBe('reject');
  });
  it('normal Tamil / English sentences are ok', () => {
    expect(assessTranscript({ transcript: 'நான் போரூர்ல 2 BHK பாக்கறேன்', sttLanguage: 'ta-IN' }).verdict).toBe('ok');
    expect(assessTranscript({ transcript: 'I am looking for a flat in Porur', sttLanguage: 'en-IN' }).verdict).toBe('ok');
  });
});

describe('language detection from the transcript (not from the STT label)', () => {
  it('Tamil, Tanglish, English', () => {
    expect(detectLanguage('நான் போரூர்ல வீடு பாக்கறேன்').lang).toBe('tamil');
    expect(detectLanguage('நான் Porur la 2 BHK flat பாக்கறேன்').lang).toBe('tanglish');
    expect(detectLanguage('Porur la 2bhk iruka budget venum').lang).toBe('tanglish');
    expect(detectLanguage('I am looking for a two bedroom flat near Porur').lang).toBe('english');
  });
  it('foreign script is "other" and never usable', () => {
    expect(detectLanguage('ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ ਕਿਵੇਂ ਹੋ').lang).toBe('other');
  });
});

describe('language tracker', () => {
  const feed = (state: LanguageState, utterances: string[], quality: 'ok' | 'weak' = 'ok') =>
    utterances.reduce(
      (acc, u) => {
        const r = updateLanguage(acc.state, detectLanguage(u), quality);
        return { state: r.state, persisted: r.persist ?? acc.persisted };
      },
      { state, persisted: undefined as string | undefined },
    );

  it('one-off pa-IN / short / foreign utterances never change or save anything', () => {
    const start = initialLanguage('tamil', 'voice');
    const r = feed(start, ['ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ ਕਿਵੇਂ ਹੋ', 'ok', 'hmm']);
    expect(r.persisted).toBeUndefined();
    expect(r.state.effective).toBe('tamil');
  });
  it('weak transcripts never vote', () => {
    const r = feed(initialLanguage(null, 'voice'), ['I am looking for a flat in Porur near the metro', 'please show me options today'], 'weak');
    expect(r.persisted).toBeUndefined();
  });
  it('saves a language only after consistent evidence, and changing a stored one needs more', () => {
    const fresh = feed(initialLanguage(null, 'voice'), ['I am looking for a flat in Porur near the metro station']);
    expect(fresh.persisted).toBeUndefined(); // one long utterance = 2 points, not enough
    const two = feed(initialLanguage(null, 'voice'), ['I am looking for a flat in Porur near the metro station', 'my budget is around eighty lakhs for this purchase']);
    expect(two.persisted).toBe('english');
    // customer stored as tamil; two English sentences are NOT enough to overwrite it
    const keep = feed(initialLanguage('tamil', 'voice'), ['I am looking for a flat in Porur near the metro station', 'my budget is around eighty lakhs for this purchase']);
    expect(keep.persisted).toBeUndefined();
    const switchAfterMany = feed(initialLanguage('tamil', 'voice'), Array(3).fill('I am looking for a flat in Porur near the metro station'));
    expect(switchAfterMany.persisted).toBe('english');
  });
  it('reply language: one long unmistakable sentence switches the reply, short or odd utterances never do, and nothing is saved from one', () => {
    const s0 = initialLanguage('tamil', 'voice');
    const one = feed(s0, ['I am looking for a flat in Porur near the metro station']);
    expect(one.state.effective).toBe('english'); // 10 clear English words: answer in English now
    expect(one.persisted).toBeUndefined(); // ...but a single utterance is never saved as the customer's language
    const stray = feed(s0, ['seri okay', 'okay thanks']);
    expect(stray.state.effective).toBe('tamil'); // short / ambiguous: no flip
    const two = feed(s0, ['could you tell me the price', 'my budget is around eighty lakhs for this']);
    expect(two.state.effective).toBe('english'); // two consistent medium utterances also flip
  });
  it('voice speaks Tamil script for tamil+tanglish; WhatsApp tanglish stays romanized', () => {
    expect(replyStyle('tanglish', 'voice')).toBe('ta');
    expect(replyStyle('tanglish', 'whatsapp')).toBe('tl');
    expect(replyStyle('english', 'voice')).toBe('en');
  });
});

describe('visit time rules', () => {
  const now = istDate(2026, 10, 8, 13, 30);
  it('accepts a normal future slot', () => expect(checkVisitTime(istDate(2026, 10, 10, 11, 0), now).ok).toBe(true));
  it.each([
    [istDate(2026, 10, 8, 12, 0), 'past'],
    [istDate(2026, 10, 8, 13, 45), 'too_soon'],
    [istDate(2026, 10, 10, 7, 0), 'outside_hours'],
    [istDate(2026, 10, 10, 20, 0), 'outside_hours'],
    [istDate(2027, 3, 1, 11, 0), 'too_far'],
  ])('rejects %#', (d, code) => expect((checkVisitTime(d, now) as any).code).toBe(code));
  it('rejects garbage', () => {
    expect((checkVisitTime('not a date', now) as any).code).toBe('invalid');
    expect((checkVisitTime(undefined, now) as any).code).toBe('invalid');
  });
});
