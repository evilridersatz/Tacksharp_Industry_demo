import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../common/config.js';
import type { Provider } from './providers.js';

/**
 * Which organization the current unit of work belongs to, so provider calls deep inside shared services (the WhatsApp
 * sender, Sarvam speech, Plivo calls) use THAT organization's credentials without threading an id through every call.
 *
 *  - HTTP requests: set from the authenticated session by ProviderScopeInterceptor.
 *  - Webhooks / queue jobs: set with bindOrganization() as soon as the tenant is resolved (never from a request body).
 *
 * The scope is per async execution chain: concurrent requests and jobs never see each other's organization.
 */
type Scope = { organizationId?: string };
const als = new AsyncLocalStorage<Scope>();

export function runInProviderScope<T>(organizationId: string | undefined, fn: () => T): T {
  return als.run({ organizationId }, fn);
}

/** Record the organization for the rest of the current unit of work (creates a scope if there is none). */
export function bindOrganization(organizationId: string | null | undefined) {
  if (!organizationId) return;
  const s = als.getStore();
  if (s) s.organizationId = organizationId;
  else als.enterWith({ organizationId });
}

export function scopedOrganization(): string | undefined {
  return als.getStore()?.organizationId;
}

export type ResolvedCredentials = {
  /** organization = this organization's own saved, tested credentials; environment = the deployment's (legacy) account. */
  source: 'organization' | 'environment' | 'none';
  organizationId?: string;
  secrets: Record<string, string>;
  config: Record<string, string>;
  /** Why nothing is usable (source 'none'). */
  reason?: string;
};

export interface CredentialResolver {
  resolve(organizationId: string, provider: Provider): Promise<ResolvedCredentials>;
}

let resolver: CredentialResolver | null = null;
export function registerCredentialResolver(r: CredentialResolver | null) {
  resolver = r;
}

/** The deployment's own (.env) account: GR Chicken and every pre-existing workspace keep using it unchanged. */
export function environmentCredentials(provider: Provider): ResolvedCredentials {
  // Always source "environment" (the legacy path keeps its own missing-credential handling); `reason` says when the
  // server has no such account configured.
  const env = (secrets: Record<string, string>, cfg: Record<string, string>, needed: string[]): ResolvedCredentials =>
    needed.every((k) => secrets[k] || cfg[k]) ? { source: 'environment', secrets, config: cfg } : { source: 'environment', secrets, config: cfg, reason: 'The server has no account configured for this provider' };
  switch (provider) {
    case 'plivo':
      return env({ authId: config.plivo.authId, authToken: config.plivo.authToken }, { fromNumber: config.plivo.fromNumber }, ['authId', 'authToken']);
    case 'sarvam':
      return env({ apiKey: config.sarvam.apiKey }, { sttModel: config.sarvam.sttModel, sttMode: config.sarvam.sttMode, sttLanguage: config.sarvam.sttLanguage, ttsModel: config.sarvam.ttsModel, ttsSpeaker: config.sarvam.ttsSpeaker }, ['apiKey']);
    case 'openai':
      return env({ apiKey: process.env.OPENAI_API_KEY ?? '' }, { model: process.env.OPENAI_MODEL || 'gpt-5.4-mini' }, ['apiKey']);
    case 'whatsapp':
      return env({ accessToken: config.whatsapp.accessToken, appSecret: process.env.META_APP_SECRET ?? '' }, { phoneNumberId: config.whatsapp.phoneNumberId }, ['accessToken', 'phoneNumberId']);
    case 'sarvam_telephony':
      return env(
        { apiKey: process.env.SARVAM_AGENTS_API_KEY ?? '' },
        { orgId: process.env.SARVAM_AGENTS_ORG_ID ?? '', workspaceId: process.env.SARVAM_AGENTS_WORKSPACE_ID ?? '', connectionId: process.env.SARVAM_AGENTS_CONNECTION_ID ?? '', agentPhoneNumber: process.env.SARVAM_AGENTS_PHONE_NUMBER ?? '' },
        ['apiKey', 'orgId', 'workspaceId', 'connectionId', 'agentPhoneNumber'],
      );
  }
}

/**
 * Credentials for the organization of the current unit of work (or the one given). Without a resolver (unit tests,
 * scripts) or without a known organization, the deployment's environment account is used - exactly the behaviour
 * before per-organization credentials existed.
 */
export async function providerCredentials(provider: Provider, organizationId = scopedOrganization()): Promise<ResolvedCredentials> {
  if (!resolver || !organizationId) return environmentCredentials(provider);
  return resolver.resolve(organizationId, provider);
}
