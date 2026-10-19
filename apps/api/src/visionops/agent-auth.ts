import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Local monitoring agent credentials. A token is "vo_<prefix>.<secret>": the prefix finds the agent, the secret is
 * checked against a sha256 hash. The secret is shown once at registration (or rotation) and never stored or logged.
 */
export function newAgentToken() {
  const prefix = `vo_${randomBytes(5).toString('hex')}`;
  const secret = randomBytes(24).toString('base64url');
  return { token: `${prefix}.${secret}`, prefix, hash: hashSecret(secret) };
}

export const hashSecret = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex');

export function parseAgentToken(header: string | undefined): { prefix: string; secret: string } | undefined {
  const m = (header ?? '').trim().match(/^Bearer\s+(vo_[a-f0-9]{10})\.([A-Za-z0-9_-]{20,80})$/);
  return m ? { prefix: m[1], secret: m[2] } : undefined;
}

export function secretMatches(secret: string, hash: string) {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
