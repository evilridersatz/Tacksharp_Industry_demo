import { describe, expect, it } from 'vitest';
import { diffSnapshots, evaluateTurn, snapshotOf, validateTestCase } from './agent-tests.js';

describe('agent builder helpers', () => {
  it('validates test cases with per-turn errors', () => {
    const ok = validateTestCase({ name: 'Price question', lang: 'en', turns: [{ message: 'price of broiler?', expect: { contains: 'per kg, ₹', notContains: ['mutton'], escalate: false, source: 'knowledge' } }] });
    expect(ok.errors).toEqual({});
    expect(ok.value.turns[0].expect).toEqual({ contains: ['per kg', '₹'], notContains: ['mutton'], escalate: false, source: 'knowledge' });
    const bad = validateTestCase({ name: '', turns: [{ message: '' , expect: { source: 'magic' } }] });
    expect(Object.keys(bad.errors).sort()).toEqual(['name', 'turns.0.message', 'turns.0.source']);
    expect(validateTestCase({ name: 'x', turns: [] }).errors.turns).toMatch(/at least one/);
    expect(validateTestCase({ name: 'x', turns: Array.from({ length: 9 }, () => ({ message: 'hi' })) }).errors.turns).toMatch(/At most 8/);
  });

  it('evaluates checks case-insensitively', () => {
    const checks = evaluateTurn({ contains: ['Broiler'], notContains: ['mutton'], escalate: false, source: 'knowledge' }, { reply: 'broiler is ₹220 per kg', source: 'knowledge', escalate: false });
    expect(checks.every((c) => c.ok)).toBe(true);
    const failing = evaluateTurn({ contains: ['naatu'], escalate: true }, { reply: 'broiler is ₹220', source: 'ai', escalate: false });
    expect(failing.map((c) => c.ok)).toEqual([false, false]);
    expect(evaluateTurn(undefined, { reply: 'x', source: 'ai', escalate: false })).toEqual([]);
  });

  it('snapshots and diffs only configuration fields', () => {
    const a = snapshotOf({ name: 'A', instructions: 'be nice', languages: ['ta'], status: 'active', id: 'x' });
    expect(a).not.toHaveProperty('status');
    const b = { ...a, instructions: 'be brief', languages: ['ta'] };
    expect(diffSnapshots(a, b)).toEqual([{ field: 'instructions', before: 'be nice', after: 'be brief' }]);
  });
});
