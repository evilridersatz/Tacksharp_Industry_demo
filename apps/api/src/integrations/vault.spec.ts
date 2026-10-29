import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mask, open, parseKeyring, seal, VaultUnavailableError } from './vault.js';

const k = () => randomBytes(32).toString('base64');

describe('credential vault (AES-256-GCM)', () => {
  const ring = parseKeyring(`v1:${k()},v2:${k()}`, 'v2');

  it('round-trips with the active key and never stores plaintext', () => {
    const s = seal(ring, 'org_a', 'plivo', { authId: 'MAXXXXXXXXXXXXXXXXXX', authToken: 'super-secret-token-123' });
    expect(s.keyVersion).toBe('v2');
    expect(Buffer.from(s.ciphertext, 'base64').toString('utf8')).not.toContain('super-secret');
    expect(open(ring, 'org_a', 'plivo', s)).toEqual({ authId: 'MAXXXXXXXXXXXXXXXXXX', authToken: 'super-secret-token-123' });
  });

  it('refuses a ciphertext moved to another organization or provider (bound as authenticated data)', () => {
    const s = seal(ring, 'org_a', 'plivo', { authToken: 'x'.repeat(20) });
    expect(() => open(ring, 'org_b', 'plivo', s)).toThrow();
    expect(() => open(ring, 'org_a', 'sarvam', s)).toThrow();
  });

  it('detects tampering', () => {
    const s = seal(ring, 'org_a', 'openai', { apiKey: 'sk-test-1234567890' });
    const bad = Buffer.from(s.ciphertext, 'base64');
    bad[0] ^= 1;
    expect(() => open(ring, 'org_a', 'openai', { ...s, ciphertext: bad.toString('base64') })).toThrow();
  });

  it('rotation: values sealed with an older key stay readable while it is configured', () => {
    const old = parseKeyring(`v1:${ring.keys.get('v1')!.toString('base64')}`, 'v1');
    const s = seal(old, 'org_a', 'whatsapp', { accessToken: 'EAAG-token-value' });
    expect(s.keyVersion).toBe('v1');
    expect(open(ring, 'org_a', 'whatsapp', s).accessToken).toBe('EAAG-token-value');
    const withoutV1 = parseKeyring(`v2:${ring.keys.get('v2')!.toString('base64')}`, 'v2');
    expect(() => open(withoutV1, 'org_a', 'whatsapp', s)).toThrow(VaultUnavailableError);
  });

  it('a missing or malformed key disables saving instead of storing secrets unprotected', () => {
    expect(parseKeyring('', '').problem).toMatch(/not set/);
    expect(parseKeyring('v1:short', '').problem).toMatch(/32 bytes/);
    expect(parseKeyring(`v1:${k()}`, 'v9').problem).toMatch(/not in CREDENTIALS_KEYS/);
    expect(() => seal(parseKeyring('', ''), 'o', 'plivo', { a: 'b' })).toThrow(VaultUnavailableError);
  });

  it('masks: enough to recognise, never enough to use', () => {
    expect(mask('sk-proj-abcdefghijklmnop1234')).toBe('••••1234');
    expect(mask('short')).toBe('••••');
    expect(mask('')).toBe('');
  });
});
