import { describe, expect, it } from 'vitest';
import { branchPath, evaluate, nextPath, stepAt, validateGraph, type Facts, type Step } from './workflow-graph.js';

const g = validateGraph({
  trigger: { type: 'lead_created' },
  steps: [
    { id: 'a', type: 'send_whatsapp', text: 'Hi {name}' },
    { id: 'c', type: 'condition', field: 'customer.stage', op: 'eq', value: 'qualified', yes: [{ id: 'y1', type: 'ai_call' }, { id: 'y2', type: 'add_tag', tag: 'hot' }], no: [] },
    { id: 'z', type: 'create_task', title: 'Follow up', dueInDays: 1 },
  ],
});
const steps = g.graph.steps;
const facts = (over: Partial<Facts['customer']> = {}, order?: number): Facts => ({ customer: { stage: null, tags: [], language: 'ta', source: 'whatsapp', email: null, messagingConsent: true, ...over }, order: order === undefined ? null : { total: order }, trigger: { channel: 'whatsapp' } });

describe('workflow graph', () => {
  it('validates a good graph', () => expect(g.errors).toEqual({}));

  it('reports field errors per step and for the trigger', () => {
    const r = validateGraph({ trigger: { type: 'stage_reached', stage: 'new' }, steps: [{ id: 'w', type: 'wait', minutes: 0 }, { id: 'm', type: 'send_whatsapp' }, { id: 'c', type: 'condition', field: 'order.total', op: 'gt', value: 'abc', yes: [], no: [] }, { id: 'x', type: 'teleport' }] });
    expect(Object.keys(r.errors).sort()).toEqual(['c', 'm', 'trigger', 'w', 'x']);
    expect(validateGraph({ trigger: { type: 'message_keyword', keywords: [' ', 'x'] }, steps: [{ type: 'ai_call' }] }).errors.trigger).toMatch(/keyword/);
    expect(validateGraph({ trigger: { type: 'lead_created' }, steps: [] }).errors.steps).toMatch(/at least one/);
  });

  it('limits nesting and size', () => {
    let deep: Step[] = [{ id: 'leaf', type: 'ai_call' }];
    for (let i = 0; i < 6; i++) deep = [{ id: `c${i}`, type: 'condition', field: 'customer.has_email', op: 'is_true', yes: deep, no: [] } as Step];
    expect(Object.values(validateGraph({ trigger: { type: 'lead_created' }, steps: deep }).errors).join()).toMatch(/nested/);
    expect(validateGraph({ trigger: { type: 'lead_created' }, steps: Array.from({ length: 41 }, () => ({ type: 'ai_call' })) }).errors.steps).toMatch(/At most/);
  });

  it('navigates: next in list, into a branch, out of a branch, empty branch, end', () => {
    expect(stepAt(steps, [0])?.id).toBe('a');
    expect(nextPath(steps, [0])).toEqual([1]);
    expect(branchPath(steps, [1], 'yes')).toEqual([1, 'yes', 0]);
    expect(nextPath(steps, [1, 'yes', 0])).toEqual([1, 'yes', 1]);
    expect(nextPath(steps, [1, 'yes', 1])).toEqual([2]); // end of branch -> after the condition
    expect(branchPath(steps, [1], 'no')).toEqual([2]); // empty branch
    expect(nextPath(steps, [2])).toBeNull();
    expect(stepAt(steps, [1, 'yes', 9])).toBeUndefined();
  });

  it('evaluates conditions from facts; unknown facts are false', () => {
    const c = (field: string, op: string, value?: string) => ({ id: 'c', type: 'condition', field, op, value, yes: [], no: [] }) as Extract<Step, { type: 'condition' }>;
    expect(evaluate(c('customer.stage', 'eq', 'new'), facts())).toBe(true);
    expect(evaluate(c('customer.stage', 'eq', 'qualified'), facts({ stage: 'qualified' }))).toBe(true);
    expect(evaluate(c('customer.tag', 'eq', 'VIP'), facts({ tags: ['vip'] }))).toBe(true);
    expect(evaluate(c('customer.tag', 'neq', 'vip'), facts({ tags: ['vip'] }))).toBe(false);
    expect(evaluate(c('order.total', 'gt', '500'), facts({}, 640))).toBe(true);
    expect(evaluate(c('order.total', 'lt', '500'), facts({}, 640))).toBe(false);
    expect(evaluate(c('order.total', 'gt', '1'), facts())).toBe(false);
    expect(evaluate(c('customer.has_email', 'is_false'), facts())).toBe(true);
    expect(evaluate(c('customer.whatsapp_consent', 'is_true'), facts({ messagingConsent: false }))).toBe(false);
    expect(evaluate(c('trigger.channel', 'contains', 'whats'), facts())).toBe(true);
  });
});
