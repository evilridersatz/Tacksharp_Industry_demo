import { describe, expect, it } from 'vitest';
import { isKnowledgeGap, questionKey } from './knowledge-studio.service.js';

describe('knowledge studio rules', () => {
  it('questionKey: case, punctuation and spacing do not matter; Tamil is kept', () => {
    expect(questionKey('  Sunday   TIMINGS?? ')).toBe('sunday timings');
    expect(questionKey('Sunday timings')).toBe(questionKey('sunday, timings!'));
    expect(questionKey('நாட்டு கோழி விலை என்ன?')).toBe('நாட்டு கோழி விலை என்ன');
  });

  it('a gap is a reply that is the fallback message, not escalations or knowledge answers', () => {
    const fb = 'Let me check with the team.';
    expect(isKnowledgeGap(fb, { reply: 'Let me check with the team.', source: 'fallback', escalate: false })).toBe(true);
    // A model told to say the fallback, with a little extra around it.
    expect(isKnowledgeGap(fb, { reply: 'Sorry! Let me check with the team', source: 'ai', escalate: false })).toBe(true);
    expect(isKnowledgeGap(fb, { reply: 'We close at 8 PM.', source: 'ai', escalate: false })).toBe(false);
    expect(isKnowledgeGap(fb, { reply: 'Let me check with the team.', source: 'escalation', escalate: true })).toBe(false);
    expect(isKnowledgeGap(fb, { reply: 'We are closed now, back at 9 AM.', source: 'fallback', escalate: false })).toBe(false); // after hours
    expect(isKnowledgeGap('', { reply: 'anything', source: 'fallback', escalate: false })).toBe(false);
  });
});
