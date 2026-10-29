import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import { mask, open, parseKeyring, seal, type Keyring } from './vault.js';
import { FIELDS, type Provider } from './providers.js';
import { environmentCredentials, registerCredentialResolver, type CredentialResolver, type ResolvedCredentials } from './provider-scope.js';

const CACHE_MS = 30_000;

/**
 * Encrypted per-organization provider credentials, and the resolution policy every provider call goes through:
 *
 *  1. The organization comes from the authenticated session or the resolved inbound channel (never a request body).
 *  2. Its own credentials are used when saved, ENABLED and the last connection test PASSED.
 *  3. Otherwise, a pre-existing (non self-service) organization keeps using the deployment's environment account
 *     (legacy behaviour, e.g. GR Chicken on PLIVO_* / WHATSAPP_*).
 *  4. A self-service organization never falls back to the platform's account: it gets "not configured".
 *  5. A suspended organization gets nothing.
 *  No path ever uses another organization's saved credentials.
 */
@Injectable()
export class CredentialsService implements CredentialResolver, OnModuleInit, OnModuleDestroy {
  private ring: Keyring;
  private readonly cache = new Map<string, { at: number; v: ResolvedCredentials }>();

  constructor(private readonly prisma: PrismaService) {
    this.ring = parseKeyring(config.credentials.keys, config.credentials.activeKey);
  }

  onModuleInit() {
    registerCredentialResolver(this);
    if (this.ring.problem) log.warn('credentials.vault_unavailable', { reason: this.ring.problem });
  }

  onModuleDestroy() {
    registerCredentialResolver(null);
  }

  /** Server problem that blocks saving secrets (no key configured), shown to admins without revealing anything. */
  get vaultProblem() {
    return this.ring.problem;
  }

  get activeKeyVersion() {
    return this.ring.active;
  }

  invalidate(organizationId: string, provider?: Provider) {
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${organizationId}|`) && (!provider || k.endsWith(`|${provider}`))) this.cache.delete(k);
  }

  async row(organizationId: string, provider: Provider) {
    return this.prisma.integrationCredential.findUnique({ where: { organizationId_provider: { organizationId, provider } } });
  }

  /** Decrypt (server only). Throws VaultUnavailableError when the key that sealed it is missing. */
  secretsOf(row: { organizationId: string; provider: string; secretCiphertext: string | null; secretIv: string | null; secretTag: string | null; keyVersion: string | null }) {
    return open(this.ring, row.organizationId, row.provider, { ciphertext: row.secretCiphertext ?? undefined, iv: row.secretIv ?? undefined, tag: row.secretTag ?? undefined, keyVersion: row.keyVersion ?? undefined });
  }

  /** Encrypt the merged secret object and the masked hints that are safe to show. */
  sealSecrets(organizationId: string, provider: Provider, secrets: Record<string, string>) {
    const sealed = seal(this.ring, organizationId, provider, secrets);
    const hints: Record<string, string> = {};
    for (const f of FIELDS[provider].filter((x) => x.secret)) if (secrets[f.key]) hints[f.key] = mask(secrets[f.key]);
    return { secretCiphertext: sealed.ciphertext, secretIv: sealed.iv, secretTag: sealed.tag, keyVersion: sealed.keyVersion, secretHints: hints };
  }

  async resolve(organizationId: string, provider: Provider): Promise<ResolvedCredentials> {
    const key = `${organizationId}|${provider}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
    const v = await this.compute(organizationId, provider);
    this.cache.set(key, { at: Date.now(), v });
    return v;
  }

  private async compute(organizationId: string, provider: Provider): Promise<ResolvedCredentials> {
    let org: { status: string; selfServe: boolean } | null = null;
    let row: Awaited<ReturnType<CredentialsService['row']>> = null;
    try {
      [org, row] = await Promise.all([
        this.prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true, selfServe: true } }),
        this.row(organizationId, provider),
      ]);
    } catch (e) {
      // Database trouble is not "not configured": keep the legacy behaviour for the deployment's own account.
      log.warn('credentials.lookup_failed', { organizationId, provider, error: errorMessage(e) });
      return { ...environmentCredentials(provider), organizationId };
    }
    if (!org) return { source: 'none', organizationId, secrets: {}, config: {}, reason: 'Unknown organization' };
    if (org.status === 'suspended') return { source: 'none', organizationId, secrets: {}, config: {}, reason: 'Organization suspended' };
    if (row?.enabled && row.status === 'ok') {
      try {
        return { source: 'organization', organizationId, secrets: this.secretsOf(row), config: (row.config ?? {}) as Record<string, string> };
      } catch (e) {
        log.error('credentials.decrypt_failed', { organizationId, provider, keyVersion: row.keyVersion, error: (e as Error).name });
        return { source: 'none', organizationId, secrets: {}, config: {}, reason: 'Saved credentials cannot be decrypted on this server (encryption key missing).' };
      }
    }
    if (org.selfServe) {
      return { source: 'none', organizationId, secrets: {}, config: {}, reason: row ? (row.enabled ? 'Connection test has not passed yet' : 'Integration is disabled') : 'Not configured for this organization' };
    }
    return { ...environmentCredentials(provider), organizationId };
  }
}
