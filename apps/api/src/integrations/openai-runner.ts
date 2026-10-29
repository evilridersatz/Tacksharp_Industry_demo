import { OpenAIProvider, Runner } from '@openai/agents';
import { providerCredentials } from './provider-scope.js';

/**
 * An Agents SDK Runner for the current organization (provider scope):
 *  - its own saved, tested, enabled OpenAI key and validated model;
 *  - otherwise the deployment's default client (OPENAI_API_KEY / OPENAI_BASE_URL), unchanged for existing workspaces;
 *  - a self-service organization without its own key gets `null` (the caller uses its non-AI fallback).
 */
export async function openaiRunner(): Promise<{ runner: Runner | null; source: 'organization' | 'environment' | 'none'; model: string | null; organizationId?: string; reason?: string }> {
  const r = await providerCredentials('openai');
  if (r.source === 'none') return { runner: null, source: 'none', model: null, organizationId: r.organizationId, reason: r.reason };
  if (r.source === 'organization') {
    return { runner: new Runner({ modelProvider: new OpenAIProvider({ apiKey: r.secrets.apiKey }), model: r.config.model }), source: 'organization', model: r.config.model ?? null, organizationId: r.organizationId };
  }
  return { runner: new Runner(), source: 'environment', model: null, organizationId: r.organizationId };
}
