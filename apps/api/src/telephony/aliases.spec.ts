import { describe, expect, it } from 'vitest';
import { SPEAK_RULE, withAliases, withAllFields } from './sarvam-tools.controller.js';

describe('withAliases (tool replies under the names a console template may use)', () => {
  it('fills common template names from the message and keeps real fields', () => {
    const r = withAliases({ ok: true, summary_text: '1 kg Broiler = ₹220. Total ₹440.', total: 440, cart_token: 'AB12', message: 'Priced. Read this to the caller.' });
    expect(r.total).toBe(440);
    expect(r.cart_token).toBe('AB12');
    expect(r.summary).toBe('1 kg Broiler = ₹220. Total ₹440.');
    expect(r.result).toContain('Priced.');
    expect(r.response).toContain(SPEAK_RULE);
    expect(r.status).toBe('ok');
  });
  it('never overwrites an existing field, and adds the rule once', () => {
    const r = withAliases({ ok: true, status: 'confirmed', result: 'x', message: 'Done.' });
    expect(r.status).toBe('confirmed');
    expect(r.result).toBe('x');
    expect(withAliases(r).message).toBe(r.message);
  });
  it('leaves replies without a message as they are', () => {
    expect(withAliases({ ok: false, error: 'no_phone' })).toEqual({ ok: false, error: 'no_phone' });
  });
});

describe('withAllFields (no field left for the console to show as "@name")', () => {
  it('a quote that asks a question still carries summary_text, total and cart_token (empty)', () => {
    const r = withAllFields('quote', { ok: false, needs: 'details', questions_text: 'When?', message: 'Ask: When?' });
    expect(r).toMatchObject({ summary_text: '', total: '', cart_token: '', problems_text: '', questions_text: 'When?', ok: false });
  });
  it('a refused order has an empty order_number and a message the agent can use', () => {
    const r = withAllFields('order', { ok: false, error: 'no_phone' });
    expect(r.order_number).toBe('');
    expect(r.message).toContain('staff call back');
  });
  it('keeps real values', () => {
    expect(withAllFields('order', { ok: true, order_number: 'GR-12', message: 'Placed.' })).toMatchObject({ ok: true, order_number: 'GR-12', message: 'Placed.' });
  });
});

import { isPlaceholder } from './sarvam-tools.service.js';
describe('isPlaceholder (values the console did not fill)', () => {
  it('treats leftover set-up words and template forms as not sent', () => {
    for (const v of ['TRANSCRIPT', 'CALLER', 'CALLID', '@Call Transcript', '{{caller}}', '<phone>']) expect(isPlaceholder(v)).toBe(true);
  });
  it('keeps real values', () => {
    for (const v of ['+919876543210', 'user: 1 kg broiler', 'transcript of the call']) expect(isPlaceholder(v)).toBe(false);
  });
});
