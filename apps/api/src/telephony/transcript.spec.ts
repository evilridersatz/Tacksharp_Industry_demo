import { describe, expect, it } from 'vitest';
import { callerLines, transcriptTurns } from './sarvam-tools.service.js';

const said = (t: unknown) => callerLines({ transcript: t });

describe('call transcript: the caller\'s words from any shape Sarvam sends', () => {
  it('lines "user: / agent:"', () => {
    expect(said('agent: Vanakkam\nuser: oru kilo broiler\nagent: Cut?\nuser: curry cut')).toEqual(['oru kilo broiler', 'curry cut']);
  });
  it('one line with every turn, any case, with or without spaces', () => {
    expect(said('Agent: Vanakkam! enna venum? User: 1 kg broiler curry cut Agent: eppo varuveenga? User:6 mani')).toEqual(['1 kg broiler curry cut', '6 mani']);
  });
  it('timestamps and brackets', () => {
    expect(said('[00:01] Agent: hi\n[00:05] User: rendu kilo broiler\n<user> aama')).toEqual(['rendu kilo broiler', 'aama']);
    expect(said('[assistant]: hi\n[user]: oru kilo')).toEqual(['oru kilo']);
  });
  it('JSON (as text or as an array / object)', () => {
    const arr = [{ role: 'assistant', content: 'Vanakkam' }, { role: 'user', content: 'oru kilo broiler' }];
    expect(said(JSON.stringify(arr))).toEqual(['oru kilo broiler']);
    expect(said(arr)).toEqual(['oru kilo broiler']);
    expect(said({ messages: [{ speaker: 'customer', text: 'aama' }] })).toEqual(['aama']);
  });
  it('Tamil text is kept as said', () => {
    expect(said('agent: வணக்கம்\nuser: ஒரு கிலோ பிராய்லர்')).toEqual(['ஒரு கிலோ பிராய்லர்']);
  });
  it('placeholders and unknown text give nothing (never the agent\'s words)', () => {
    expect(said('@Call Transcript')).toEqual([]);
    expect(said('agent: broiler 220 rupees')).toEqual([]);
    expect(transcriptTurns('no roles here at all')).toEqual([]);
  });
});

describe('transcript shape for the log', () => {
  it('keeps the layout, never the words', async () => {
    const { transcriptShape } = await import('./sarvam-tools.service.js');
    const r = transcriptShape('Agent: Vanakkam 220\nUser: ஒரு கிலோ');
    expect(r.shape).not.toMatch(/Vanakkam|கிலோ|220/);
    expect(r.shape).toContain(':');
    expect(r.type).toBe('string');
  });
});
