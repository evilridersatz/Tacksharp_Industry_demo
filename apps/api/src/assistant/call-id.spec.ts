import { describe, expect, it } from 'vitest';
import { callIdOf } from './business-assistant.controller.js';

describe('callIdOf (Sarvam interaction ids from the dashboard)', () => {
  it('accepts ids with characters beyond letters, digits and "-" (35 chars, as Sarvam sends)', () => {
    for (const id of ['20261109_0710/a1b2c3d4e5f6a7b8c9d0e1', 'int#9f8e7d6c5b4a39281706f5e4d3c2b1a0', 'abc~def(1)-2026-11-09T07:10:51Z']) expect(callIdOf(id)).toBe(id);
  });
  it('trims the same way the tool requests do', () => {
    expect(callIdOf(' 9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0 \n')).toBe('9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0');
  });
  it('refuses empty, short, spaced or non-string ids', () => {
    for (const v of ['', 'ab', 'a b c d', 'x\u0000yz1', 42, null, undefined, 'x'.repeat(161)]) expect(callIdOf(v)).toBe('');
  });
});
