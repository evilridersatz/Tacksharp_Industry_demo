import { createHmac, timingSafeEqual } from 'node:crypto';

export type SessionClaims = {
  sub: string; // user id
  org: string; // organization id
  role: string;
  exp: number; // unix seconds
};

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Compact signed token: v1.<payload>.<hmac-sha256>. */
export function signSession(claims: SessionClaims, secret: string): string {
  const payload = b64(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`v1.${payload}`).digest('base64url');
  return `v1.${payload}.${sig}`;
}

export function verifySession(token: string | undefined, secret: string, now = Date.now()): SessionClaims | null {
  if (!token) return null;
  const [version, payload, sig] = token.split('.');
  if (version !== 'v1' || !payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(`v1.${payload}`).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
    if (!claims.sub || !claims.org || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
