import { describe, expect, it } from 'vitest';
import { addCycle, effectiveLimits, invoiceAmounts, invoiceNumber, validateOverride } from './plans.js';

describe('plans', () => {
  it('limits: plan, overrides (null = unlimited), unknown plan falls back to the smallest', () => {
    expect(effectiveLimits('growth', null).voiceAgents).toBe(5);
    expect(effectiveLimits('growth', { voiceAgents: 9, users: null })).toMatchObject({ voiceAgents: 9, users: null, workflows: 25 });
    expect(effectiveLimits('nope', null)).toEqual(effectiveLimits('pilot', null));
    expect(effectiveLimits('pilot', { users: -1, junk: 5 }).users).toBe(3);
  });
  it('validates overrides', () => {
    expect(validateOverride({ users: 40, mcpKeys: null })).toEqual({ value: { users: 40, mcpKeys: null } });
    expect(validateOverride({ seats: 4 }).error).toMatch(/Unknown limit/);
    expect(validateOverride({ users: 1.5 }).error).toMatch(/whole number/);
    expect(validateOverride([1]).error).toMatch(/object/);
    expect(validateOverride(null)).toEqual({ value: null });
  });
  it('billing periods by calendar month, end-of-month clamped', () => {
    expect(addCycle(new Date('2026-01-31T00:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addCycle(new Date('2026-11-03T06:00:00Z'), 'quarterly').toISOString()).toBe('2027-02-03T06:00:00.000Z');
    expect(addCycle(new Date('2028-02-29T00:00:00Z'), 'yearly').toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });
  it('invoice amounts in paise; numbers', () => {
    expect(invoiceAmounts(9999, 18)).toEqual({ subtotal: 9999, tax: 1799.82, total: 11798.82 });
    expect(invoiceAmounts(0.1, 18)).toEqual({ subtotal: 0.1, tax: 0.02, total: 0.12 });
    expect(invoiceNumber(2026, 42)).toBe('TS-2026-00042');
  });
});
