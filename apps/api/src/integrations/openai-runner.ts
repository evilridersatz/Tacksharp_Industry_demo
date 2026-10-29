import { OpenAIProvider, Runner } from '@openai/agents';
import { providerCredentials } from './provider-scope.js';

/**
 * An Agents SDK Runner for the current organization (provider scope):
 *  - its own saved, tested, enabled OpenAI key and validated model;
 *  - otherwise the deployment's default client (OPENAI_API_KEY / OPENAI_BASE_URL), unchanged for existing workspaces;
 *  - a self-service organization without its own key gets `null` (the caller uses its non-AI fallback).
 */
const providers = new Map<string, OpenAIProvider>();

export async function openaiRunner(): Promise<{ runner: Runner | null; source: 'organization' | 'environment' | 'none'; model: string | null; organizationId?: string; reason?: string }> {
  const r = await providerCredentials('openai');
  if (r.source === 'none') return { runner: null, source: 'none', model: null, organizationId: r.organizationId, reason: r.reason };
  if (r.source === 'organization') {
    // One provider (HTTP client, keep-alive connections) per key, reused across turns: a new client per turn would
    // pay a fresh TLS handshake to OpenAI on every reply.
    let provider = providers.get(r.secrets.apiKey);
    if (!provider) {
      provider = new OpenAIProvider({ apiKey: r.secrets.apiKey });
      providers.set(r.secrets.apiKey, provider);
      if (providers.size > 200) providers.delete(providers.keys().next().value!);
    }
    return { runner: new Runner({ modelProvider: provider, model: r.config.model }), source: 'organization', model: r.config.model ?? null, organizationId: r.organizationId };
  }
  return { runner: new Runner(), source: 'environment', model: null, organizationId: r.organizationId };
}
