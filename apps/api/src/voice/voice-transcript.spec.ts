import { describe, expect, it } from 'vitest';
import { messagesOfCall } from './voice.controller.js';

describe('call transcript', () => {
  it('keeps only this call\'s messages; untagged older messages stay by time window', () => {
    const ms = [
      { id: 'a', metadata: { callId: 'c1' } },
      { id: 'b', metadata: { callId: 'c2' } },
      { id: 'c', metadata: null },
      { id: 'd', metadata: { intent: 'GREETING' } },
    ];
    expect(messagesOfCall(ms, 'c1').map((m) => m.id)).toEqual(['a', 'c', 'd']);
  });
});
