import { describe, expect, it } from 'vitest';
import { passwordProblem, validateSignup } from './signup.js';

const ok = { organizationName: 'Marina Textiles', adminName: 'Priya', email: 'Priya@Marina.example', password: 'a long enough passphrase', industry: 'retail', phone: '+91 98400 12345', acceptTerms: true };
const fieldsOf = (b: Record<string, unknown>) => {
  try { validateSignup(b); return {}; } catch (e) { return ((e as { getResponse: () => { fields?: Record<string, string> } }).getResponse().fields) ?? { generic: true }; }
};

describe('self-service signup validation', () => {
  it('accepts a valid registration and normalises email and phone', () => {
    expect(validateSignup(ok)).toEqual({ organizationName: 'Marina Textiles', adminName: 'Priya', email: 'priya@marina.example', password: 'a long enough passphrase', industry: 'retail', phone: '919840012345' });
  });
  it('names every problem field', () => {
    expect(Object.keys(fieldsOf({}))).toEqual(expect.arrayContaining(['organizationName', 'adminName', 'email', 'password', 'industry', 'acceptTerms']));
  });
  it('enforces password rules', () => {
    expect(passwordProblem('short')).toMatch(/12/);
    expect(passwordProblem('aaaaaaaaaaaaaa')).toMatch(/repeated/);
    expect(passwordProblem('owner@x.example', 'owner@x.example')).toMatch(/email/);
    expect(fieldsOf({ ...ok, password: 'tooshort' })).toHaveProperty('password');
  });
  it('cannot ask for a platform role or the GR Chicken engine', () => {
    // There is no role field at all; the restaurant (GR Chicken) engine is not a signup industry.
    expect(fieldsOf({ ...ok, industry: 'restaurant' })).toHaveProperty('industry');
    expect(validateSignup({ ...ok, role: 'platform_admin', isPlatformAdmin: true })).not.toHaveProperty('role');
  });
  it('blocks bots (honeypot) and throwaway inboxes', () => {
    expect(fieldsOf({ ...ok, website: 'http://spam.example' })).toEqual({ generic: true });
    expect(fieldsOf({ ...ok, email: 'x@mailinator.com' })).toHaveProperty('email');
  });
  it('rejects malformed phones and requires accepting the terms', () => {
    expect(fieldsOf({ ...ok, phone: '12ab' })).toHaveProperty('phone');
    expect(fieldsOf({ ...ok, acceptTerms: false })).toHaveProperty('acceptTerms');
  });
});
