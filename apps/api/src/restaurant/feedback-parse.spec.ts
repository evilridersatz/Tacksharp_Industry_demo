import { describe, expect, it } from 'vitest';
import { assessFeedback, isComplaint, isStart, isStop, readRating } from './feedback-parse.js';
import { followUpConfig, liveGate } from './followup-config.js';
import { templatePayload, textPayload } from './followup-transport.js';

describe('feedback replies', () => {
  it('reads a 1-5 rating from a WhatsApp reply', () => {
    for (const [t, n] of [['5', 5], ['4 stars', 4], ['3/5', 3], ['⭐⭐⭐⭐', 4], [' 1 ', 1]] as const) expect(readRating(t)).toBe(n);
    for (const t of ['6', '0', 'ok', '5 kg broiler', 'call me at 5']) expect(readRating(t)).toBeUndefined();
  });

  it('reads ratings inside call sentences (Tamil, Tanglish, English)', () => {
    expect(readRating('ஆமா, ரொம்ப நல்லா இருந்துச்சு. அஞ்சு குடுக்கிறேன்.', true)).toBe(5);
    expect(readRating('Chicken fresh-ah illa, smell vandhuchu. Rendu dhaan.', true)).toBe(2);
    expect(readRating('I would give it 4 out of 5', true)).toBe(4);
    expect(readRating('nalla irundhuchu', true)).toBe(4);
  });

  it('detects complaints and escalates low ratings', () => {
    expect(isComplaint('chicken fresh-ah illa')).toBe(true);
    expect(isComplaint('நாத்தம் அடிச்சுது')).toBe(true);
    expect(isComplaint('super ah irundhuchu')).toBe(false);
    expect(assessFeedback('2', false)).toEqual({ rating: 2, complaint: true });
    expect(assessFeedback('5', false)).toEqual({ rating: 5, complaint: false });
    expect(assessFeedback('order late ah vandhuchu, 4', true)).toEqual({ rating: 4, complaint: true });
  });

  it('STOP / START only as a whole message', () => {
    for (const t of ['STOP', 'stop', 'Unsubscribe', 'stop pannunga', 'நிறுத்துங்க']) expect(isStop(t)).toBe(true);
    for (const t of ['dont stop', 'stop at 6 pm and collect', 'bus stop near shop']) expect(isStop(t)).toBe(false);
    expect(isStart('START')).toBe(true);
    expect(isStart('start cutting')).toBe(false);
  });
});

describe('dry-run and live gate', () => {
  it('defaults to dry-run', () => {
    expect(followUpConfig({}).dryRun).toBe(true);
    expect(followUpConfig({ DRY_RUN: 'false' }).dryRun).toBe(false);
  });

  it('live reaches only approved numbers and never demo customers', () => {
    const live = followUpConfig({ DRY_RUN: 'false', LIVE_TEST_RECIPIENTS: '+91 99999 00001, 9876500000' });
    expect(liveGate(live, { phone: '919999900001', isDemo: false })).toEqual({ live: true });
    expect(liveGate(live, { phone: '919876500000', isDemo: false })).toEqual({ live: true });
    expect(liveGate(live, { phone: '919111111111', isDemo: false }).live).toBe(false);
    expect(liveGate(live, { phone: '919999900001', isDemo: true }).live).toBe(false);
    expect(liveGate(followUpConfig({}), { phone: '919999900001', isDemo: false }).reason).toBe('DRY_RUN is on');
    const all = followUpConfig({ DRY_RUN: 'false', LIVE_ALLOW_ALL_CUSTOMERS: 'true' });
    expect(liveGate(all, { phone: '919111111111', isDemo: false }).live).toBe(true);
    expect(liveGate(all, { phone: '910000010001', isDemo: true }).live).toBe(false);
  });

  it('builds WhatsApp Cloud API bodies', () => {
    expect(textPayload('919999900001', 'Hi')).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '919999900001', type: 'text', text: { body: 'Hi', preview_url: false } });
    expect(templatePayload('919999900001', 'gr_feedback_v1', ['Priya', 'GR-AB12CD'], 'en')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919999900001',
      type: 'template',
      template: { name: 'gr_feedback_v1', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Priya' }, { type: 'text', text: 'GR-AB12CD' }] }] },
    });
  });
});
