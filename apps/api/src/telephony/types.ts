/**
 * Telephony provider abstraction. Plivo and Sarvam work very differently, and the capabilities say so honestly:
 *  - Plivo: a carrier. OUR server runs the conversation (answer URL -> record / stream -> our STT -> our agent engine
 *    with the tenant's instructions and knowledge base -> our TTS). Inbound and outbound.
 *  - Sarvam Voice Agents: the conversation runs on an agent HOSTED by Sarvam (app id). We can start an outbound call
 *    to that agent (documented Instant Outbound API) and receive the outcome + transcript by webhook AFTER the call.
 *    Inbound calls are answered by a Sarvam inbound deployment configured in Sarvam's console; we receive the
 *    post-call webhook. Sarvam does not document webhook signing, so our webhook URLs carry an HMAC token.
 */
export type ProviderId = 'plivo' | 'sarvam';

export type Capabilities = {
  provider: ProviderId;
  configured: boolean;
  outbound: boolean;
  inbound: boolean;
  /** Who runs the conversation: our engine (tenant instructions + KB live) or an agent hosted at the provider. */
  conversation: 'our_engine' | 'provider_hosted_agent';
  /** Where the agent's instructions / knowledge must live for calls through this provider. */
  instructionsSource: 'agent_builder' | 'provider_console';
  knowledgeSource: 'agent_builder' | 'provider_console';
  webhookAuth: 'provider_signature' | 'url_hmac_token';
  realtimeAudio: string;
  numberProvisioning: string;
  pricing: string;
  limits: string;
  verifiedFrom: string[];
  notes: string[];
};

export type OutboundRequest = {
  organizationId: string;
  requestId: string;
  customerId: string;
  to: string;
  agent: { id: string; name: string; sarvamAppId: string | null; sarvamAppVersion: number | null };
  variables?: Record<string, string>;
};

export type OutboundResult =
  | { ok: true; providerCallId: string | null; callId?: string; latencyMs: number }
  | { ok: false; reason: string; retryable: boolean; latencyMs: number };

export type CallStatus = { status: string; outcome?: string | null; durationSec?: number | null; endedAt?: Date | null; failureReason?: string | null };

export type WebhookInput = { query: Record<string, unknown>; body: unknown; headers: Record<string, unknown> };
export type WebhookResult = { accepted: boolean; duplicate?: boolean; reason?: string; organizationId?: string };

export interface TelephonyProvider {
  readonly id: ProviderId;
  getCapabilities(organizationId: string): Promise<Capabilities>;
  initiateOutboundCall(req: OutboundRequest): Promise<OutboundResult>;
  /** Plivo: answer XML for our engine. Sarvam: inbound is hosted by Sarvam; we only record the post-call webhook. */
  handleInboundCall(input: WebhookInput): Promise<{ handledBy: 'our_engine' | 'provider'; xml?: string }>;
  getCallStatus(organizationId: string, requestId: string): Promise<CallStatus | null>;
  handleWebhook(input: WebhookInput): Promise<WebhookResult>;
}
