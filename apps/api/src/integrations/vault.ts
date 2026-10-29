import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Credential encryption at rest: AES-256-GCM (authenticated) with a server-side keyring.
 *
 *   CREDENTIALS_KEYS="v1:<base64 32 bytes>,v2:<base64 32 bytes>"   CREDENTIALS_ACTIVE_KEY=v2
 *
 * - The keys live only in the server environment (or a secrets manager feeding it), never in the database.
 * - Each ciphertext records its key version: rotation adds a new key, makes it active, then
 *   `npm run credentials:rotate` re-encrypts every row; the old key can be removed afterwards.
 * - Additional authenticated data = "<organizationId>|<provider>": a ciphertext copied to another organization's row
 *   (or another provider) fails authentication instead of decrypting.
 * - Decryption happens only on the server, only for the organization the request is scoped to.
 */
export type Keyring = { active: string | null; keys: Map<string, Buffer>; problem: string | null };
export type Sealed = { ciphertext: string; iv: string; tag: string; keyVersion: string };

export class VaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultUnavailableError';
  }
}

export function parseKeyring(spec: string, activeName: string): Keyring {
  const keys = new Map<string, Buffer>();
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i <= 0) return { active: null, keys: new Map(), problem: 'CREDENTIALS_KEYS must look like "v1:<base64 key>,v2:<base64 key>"' };
    const name = part.slice(0, i).trim();
    const key = Buffer.from(part.slice(i + 1).trim(), 'base64');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return { active: null, keys: new Map(), problem: 'CREDENTIALS_KEYS: key names may use letters, digits, - and _' };
    if (key.length !== 32) return { active: null, keys: new Map(), problem: `CREDENTIALS_KEYS: key "${name}" must be 32 bytes (base64 of 32 random bytes)` };
    keys.set(name, key);
  }
  if (!keys.size) return { active: null, keys, problem: 'CREDENTIALS_KEYS is not set: provider credentials cannot be saved' };
  const active = activeName || [...keys.keys()].pop()!;
  if (!keys.has(active)) return { active: null, keys, problem: `CREDENTIALS_ACTIVE_KEY "${active}" is not in CREDENTIALS_KEYS` };
  return { active, keys, problem: null };
}

const aad = (organizationId: string, provider: string) => Buffer.from(`${organizationId}|${provider}`, 'utf8');

export function seal(ring: Keyring, organizationId: string, provider: string, secrets: Record<string, string>): Sealed {
  if (ring.problem || !ring.active) throw new VaultUnavailableError(ring.problem ?? 'No active credentials key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.keys.get(ring.active)!, iv);
  cipher.setAAD(aad(organizationId, provider));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), keyVersion: ring.active };
}

export function open(ring: Keyring, organizationId: string, provider: string, s: Partial<Sealed> | null | undefined): Record<string, string> {
  if (!s?.ciphertext || !s.iv || !s.tag || !s.keyVersion) return {};
  const key = ring.keys.get(s.keyVersion);
  if (!key) throw new VaultUnavailableError(`Credentials key "${s.keyVersion}" is not configured on this server`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  decipher.setAAD(aad(organizationId, provider));
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(s.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plain) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
}

/** "••••3fa1": enough to recognise which key is stored, never enough to use it. Short values show nothing. */
export function mask(value: string): string {
  if (!value) return '';
  return value.length >= 12 ? `••••${value.slice(-4)}` : '••••';
}
