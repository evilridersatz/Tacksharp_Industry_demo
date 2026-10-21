import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPlivoSignature, type SignedRequest } from './plivo-signature.js';

const TOKEN = 'test-auth-token-not-real';
const BASE = 'https://api.example.test';

/**
 * Plivo's V3 signing, done independently here: URL (+ "?" sorted query + "." when the body has params) + sorted
 * key+value pairs of the POST body, then "." + nonce, HMAC-SHA256 with the auth token, base64.
 */
function sign(url: string, params: Record<string, string>, nonce: string, token = TOKEN) {
  const u = new URL(url);
  const query = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  const hasBody = Object.keys(params).length > 0;
  let base = `${u.protocol}//${u.host}${u.pathname}`;
  if (query || hasBody) base += `?${query}`;
  if (query && hasBody) base += '.';
  base += Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha256', token).update(`${base}.${nonce}`).digest('base64');
}

function request(path: string, headers: Record<string, string>): SignedRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method: 'POST', originalUrl: path, protocol: 'http', header: (n) => lower[n.toLowerCase()] };
}

const body = { CallUUID: 'abc-123', CallStatus: 'in-progress', From: '919000000000' };
const opts = { enabled: true, authToken: TOKEN, publicBaseUrl: BASE };

describe('Plivo webhook signature (PLIVO_VALIDATE_SIGNATURE=true)', () => {
  it('accepts a valid signature for the exact URL Plivo called', () => {
    const path = '/voice/turn?callId=call_1';
    const sig = sign(`${BASE}${path}`, body, 'nonce-1');
    expect(checkPlivoSignature(request(path, { 'X-Plivo-Signature-V3': sig, 'X-Plivo-Signature-V3-Nonce': 'nonce-1' }), body, opts)).toEqual({ ok: true });
  });

  it('rejects a wrong signature, a changed body, and a signature made with another token', () => {
    const path = '/voice/ready/turn?callId=c2';
    const sig = sign(`${BASE}${path}`, body, 'n2');
    const req = (s: string) => request(path, { 'x-plivo-signature-v3': s, 'x-plivo-signature-v3-nonce': 'n2' });
    expect(checkPlivoSignature(req('bm90LWEtc2lnbmF0dXJl'), body, opts)).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(checkPlivoSignature(req(sig), { ...body, CallStatus: 'completed' }, opts).ok).toBe(false);
    expect(checkPlivoSignature(req(sign(`${BASE}${path}`, body, 'n2', 'another-token')), body, opts).ok).toBe(false);
  });

  it('rejects a request with no signature or no nonce', () => {
    expect(checkPlivoSignature(request('/voice/hangup', {}), body, opts)).toEqual({ ok: false, reason: 'signature_missing' });
    expect(checkPlivoSignature(request('/voice/hangup', { 'x-plivo-signature-v3': 'x' }), body, opts)).toEqual({ ok: false, reason: 'signature_missing' });
  });

  it('fails closed when validation is on but the auth token is missing', () => {
    expect(checkPlivoSignature(request('/voice/hangup', {}), body, { ...opts, authToken: '' })).toEqual({ ok: false, reason: 'auth_token_missing' });
  });

  it('PUBLIC_BASE_URL with a trailing slash, or a proxy-forwarded host, still validates (signature still required)', () => {
    const path = '/voice/feedback/answer?followUpId=f1';
    const sig = sign(`${BASE}${path}`, body, 'n3');
    const headers = { 'x-plivo-signature-v3': sig, 'x-plivo-signature-v3-nonce': 'n3' };
    expect(checkPlivoSignature(request(path, headers), body, { ...opts, publicBaseUrl: `${BASE}/` }).ok).toBe(true);
    // PUBLIC_BASE_URL out of date (old tunnel); the proxy says which host Plivo really called.
    const viaProxy = request(path, { ...headers, 'x-forwarded-host': 'api.example.test', 'x-forwarded-proto': 'https' });
    expect(checkPlivoSignature(viaProxy, body, { ...opts, publicBaseUrl: 'https://old-tunnel.example' }).ok).toBe(true);
    // ...but a forged host header cannot make a bad signature pass.
    const forged = request(path, { 'x-plivo-signature-v3': 'forged', 'x-plivo-signature-v3-nonce': 'n3', 'x-forwarded-host': 'evil.example' });
    expect(checkPlivoSignature(forged, body, opts).ok).toBe(false);
  });

  it('disabled = accepted (the current .env setting; startup logs a warning)', () => {
    expect(checkPlivoSignature(request('/voice/turn', {}), body, { ...opts, enabled: false })).toEqual({ ok: true, reason: 'validation_disabled' });
  });
});
