import { describe, expect, it } from 'vitest';
import { SPEAK_RULE, withAliases } from './sarvam-tools.controller.js';

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
