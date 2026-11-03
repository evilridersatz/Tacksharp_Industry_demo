import { describe, expect, it } from 'vitest';
import { authorOf, change, csvRows, istSlot, median, percentile, responseTimes } from './metrics.js';

const t = (min: number) => new Date(Date.UTC(2026, 10, 2, 4, 30) + min * 60_000); // 10:00 IST Monday

describe('analytics metrics', () => {
  it('percentiles', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(median([])).toBeNull();
  });

  it('authors from message metadata', () => {
    expect(authorOf({ role: 'user', metadata: null })).toBe('customer');
    expect(authorOf({ role: 'assistant', metadata: { author: 'staff' } })).toBe('team');
    expect(authorOf({ role: 'assistant', metadata: { autoReply: true } })).toBe('automatic');
    expect(authorOf({ role: 'assistant', metadata: { drip: {} } })).toBe('automatic');
    expect(authorOf({ role: 'assistant', metadata: { workflow: {} } })).toBe('automatic');
    expect(authorOf({ role: 'assistant', metadata: {} })).toBe('ai');
  });

  it('response times per customer turn: AI vs team, consecutive customer messages start one turn, unanswered counted', () => {
    const m = (conversationId: string, min: number, role: string, metadata: unknown = {}) => ({ conversationId, role, createdAt: t(min), metadata });
    const r = responseTimes([
      m('a', 0, 'user'), m('a', 0.5, 'user'), m('a', 1, 'assistant'), // AI 60 s (from the first of the two)
      m('a', 10, 'user'), m('a', 25, 'assistant', { author: 'staff' }), // team 900 s
      m('a', 30, 'assistant'), // no open turn: ignored
      m('b', 5, 'user'), m('b', 5.25, 'assistant', { autoReply: true }), // automatic: closes the turn, not counted
      m('c', 2, 'user'), // unanswered
    ]);
    expect(r.ai).toEqual([60]);
    expect(r.team).toEqual([900]);
    expect(r.unanswered).toBe(1);
  });

  it('IST weekday / hour, change, formula-safe CSV', () => {
    expect(istSlot(t(0))).toEqual({ dow: 0, hour: 10 });
    expect(istSlot(new Date(Date.UTC(2026, 10, 1, 19, 0)))).toEqual({ dow: 0, hour: 0 }); // Sun 19:00 UTC = Mon 00:30 IST
    expect(change(150, 100)).toBe(50);
    expect(change(5, 0)).toBeNull();
    expect(csvRows([['a', '=SUM(A1)', 3, null]])).toBe(`"a","'=SUM(A1)","3",""`);
  });
});
