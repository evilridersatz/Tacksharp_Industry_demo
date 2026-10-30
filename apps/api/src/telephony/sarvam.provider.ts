import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';
import { normalizePhone } from '../common/phone.js';
import { providerCredentials } from '../integrations/provider-scope.js';
import { sarvamOutboundCall, type FetchLike } from '../integrations/provider-clients.js';
import { recordWebhookFailure } from '../common/webhook-failures.js';
import { verifyWebhookToken, webhookSecret, webhookToken } from './webhook-token.js';
import type { Capabilities, CallStatus, OutboundRequest, OutboundResult, TelephonyProvider, WebhookInput, WebhookResult } from './types.js';

export const SARVAM_DOCS = [
  'https://docs.sarvam.ai/conversations/overview',
  'https://docs.sarvam.ai/api-reference/instant-outbound/create',
  'https://docs.sarvam.ai/api-reference/instant-outbound/webhook-payload',
  'https://docs.sarvam.ai/voice-agents/deploy/inbounds.md',
  'https://docs.sarvam.ai/conversations/deploy/telephony/rent-from-sarvam',
  'https://docs.sarvam.ai/voice-agents/pricing.md',
  'https://docs.sarvam.ai/conversations/build/knowledge-base',
];

const STATUS: Record<string, string> = { connected: 'completed', no_answer: 'no_answer', busy: 'busy', failed: 'failed' };

export class SarvamTelephonyProvider implements TelephonyProvider {
  readonly id = 'sarvam' as const;
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(private readonly prisma: PrismaService) {}

  private async account(organizationId: string) {
    const c = await providerCredentials('sarvam_telephony', organizationId);
    if (c.source === 'none' || c.reason) return null;
    const { apiKey } = c.secrets;
    const { orgId, workspaceId, connectionId, agentPhoneNumber } = c.config;
    if (!apiKey || !orgId || !workspaceId || !connectionId || !agentPhoneNumber) return null;
    return { apiKey, orgId, workspaceId, connectionId, agentPhoneNumber };
  }

  static webhookUrl(organizationId: string, scope: string): string | null {
    const t = webhookToken(organizationId, scope);
    if (!t) return null;
    return `${config.publicBaseUrl}/telephony/sarvam/webhook?org=${encodeURIComponent(organizationId)}&scope=${encodeURIComponent(scope)}&t=${t}`;
  }

  async getCapabilities(organizationId: string): Promise<Capabilities> {
    const configured = Boolean(await this.account(organizationId)) && Boolean(webhookSecret());
    return {
      provider: 'sarvam',
      configured,
      outbound: true,
      inbound: true,
      conversation: 'provider_hosted_agent',
      instructionsSource: 'provider_console',
      knowledgeSource: 'provider_console',
      webhookAuth: 'url_hmac_token',
      realtimeAudio: 'Handled inside Sarvam (8 kHz telephony per the Pulse guide); no documented way to stream call audio to our server.',
      numberProvisioning: 'Rent from Sarvam (KYC required, 30-day auto-renew, wallet billed) or bring your own provider (Exotel, Twilio, Plivo, Vobiz, Smartflo, Pulse, Intalk). A rented number answers only after it is assigned to an inbound deployment; outbound needs the number on a connection.',
      pricing: 'Per Sarvam pricing page (Oct 2026): agent Rs 3.00-3.50/min by plan; Sarvam telephony Rs 0.20 per 30 s pulse; number Rs 59 per 30 days.',
      limits: 'Pay as you go: 4 concurrent calls, 20 calls/min (higher on paid plans). Calls past a limit are rejected.',
      verifiedFrom: SARVAM_DOCS,
      notes: [
        'The call is spoken by the agent configured in Sarvam (app id + version). Agent Builder instructions and knowledge base are NOT pushed to Sarvam automatically: Sarvam documents no public API for agent configuration or knowledge-base upload. Copy them into the Sarvam agent (its Knowledge base supports PDF, DOCX, CSV, TXT, MD).',
        'Sarvam does not document webhook signing; our webhook URL carries an HMAC token (TELEPHONY_WEBHOOK_SECRET).',
        'Webhooks arrive after the call ends, so live per-turn latency inside Sarvam cannot be measured from here; we measure request acceptance time and call duration.',
        'webhook_config is sent as { url }: the field names inside webhook_config are collapsed in the API reference and must be confirmed with a live test call.',
      ],
    };
  }

  async initiateOutboundCall(req: OutboundRequest): Promise<OutboundResult> {
    const started = Date.now();
    const acct = await this.account(req.organizationId);
    if (!acct) return { ok: false, reason: 'sarvam_not_configured', retryable: false, latencyMs: 0 };
    if (!req.agent.sarvamAppId) return { ok: false, reason: 'agent_has_no_sarvam_app_id', retryable: false, latencyMs: 0 };
    const webhookUrl = SarvamTelephonyProvider.webhookUrl(req.organizationId, req.requestId);
    if (!webhookUrl) return { ok: false, reason: 'TELEPHONY_WEBHOOK_SECRET missing (needed to verify call results)', retryable: false, latencyMs: 0 };
    const r = await sarvamOutboundCall(this.fetchImpl, acct, { appId: req.agent.sarvamAppId, appVersion: req.agent.sarvamAppVersion ?? 1, to: req.to, webhookUrl, variables: req.variables });
    await this.prisma.integrationEvent.create({ data: { organizationId: req.organizationId, provider: 'sarvam_telephony', kind: 'call', ok: r.ok, latencyMs: r.latencyMs, errorCode: r.errorCode ?? null, message: r.message.slice(0, 500), units: r.ok ? 1 : null, unitType: 'calls', source: 'organization' } }).catch(() => undefined);
    if (r.ok) return { ok: true, providerCallId: r.attemptId ?? null, latencyMs: Date.now() - started };
    return { ok: false, reason: `sarvam_${r.errorCode ?? 'error'}: ${r.message}`.slice(0, 180), retryable: Boolean(r.retryable), latencyMs: Date.now() - started };
  }

  async handleInboundCall(): Promise<{ handledBy: 'provider' }> {
    // Sarvam answers inbound calls with its hosted agent (inbound deployment); we receive the result by webhook.
    return { handledBy: 'provider' };
  }

  async getCallStatus(organizationId: string, requestId: string): Promise<CallStatus | null> {
    const r = await this.prisma.telephonyCallRequest.findFirst({ where: { id: requestId, organizationId } });
    if (!r) return null;
    return { status: r.status, durationSec: r.durationSec, failureReason: r.failureReason };
  }

  /**
   * Post-call webhook (outbound attempt or inbound interaction). Order: token check (before reading the body) ->
   * payload validation -> exactly-once by attempt_id -> update the request / create the call record.
   */
  async handleWebhook(input: WebhookInput): Promise<WebhookResult> {
    const org = String(input.query.org ?? '');
    const scope = String(input.query.scope ?? '');
    if (!org || !scope || !verifyWebhookToken(org, scope, input.query.t)) {
      recordWebhookFailure('sarvam', 'token_invalid', '/telephony/sarvam/webhook');
      return { accepted: false, reason: 'invalid_token' };
    }
    const b = (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>;
    const attemptId = typeof b.attempt_id === 'string' ? b.attempt_id : typeof b.interaction_id === 'string' ? b.interaction_id : '';
    const status = typeof b.status === 'string' ? b.status : '';
    if (!attemptId || attemptId.length > 120) return { accepted: false, reason: 'invalid_payload', organizationId: org };
    try {
      await this.prisma.telephonyWebhookEvent.create({ data: { organizationId: org, provider: 'sarvam', eventKey: attemptId, kind: scope.startsWith('inbound') ? 'inbound' : 'outbound', payload: redact(b) as Prisma.InputJsonValue } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return { accepted: true, duplicate: true, organizationId: org };
      throw e;
    }
    const durationSec = Number.isFinite(Number(b.duration)) ? Math.round(Number(b.duration)) : null;
    const mapped = STATUS[status] ?? 'failed';
    const failure = typeof b.failure_reason === 'string' ? b.failure_reason.slice(0, 180) : null;
    const transcript = transcriptLines(b.interaction_transcript);

    if (scope.startsWith('inbound:')) {
      const agentId = scope.slice('inbound:'.length);
      const agent = await this.prisma.voiceAgent.findFirst({ where: { id: agentId, organizationId: org } });
      const phone = normalizePhone(callerPhone(b));
      if (!agent || !phone) {
        log.warn('telephony.sarvam_inbound_unlinked', { org, hasAgent: Boolean(agent), hasPhone: Boolean(phone) });
        return { accepted: true, organizationId: org };
      }
      const customer = (await this.prisma.customer.findFirst({ where: { organizationId: org, phone } })) ?? (await this.prisma.customer.create({ data: { organizationId: org, phone, source: 'voice_inbound_sarvam' } }));
      const call = await this.prisma.call.create({ data: { organizationId: org, customerId: customer.id, direction: 'inbound', status: mapped, outcome: status || 'failed', toNumber: '', fromNumber: phone, providerCallId: attemptId, durationSec, agentId: agent.id, provider: 'sarvam', endedAt: new Date(), hangupCause: failure, summary: summary(transcript) } });
      await this.saveTranscript(org, customer.id, phone, call.id, transcript);
      return { accepted: true, organizationId: org };
    }

    const req = await this.prisma.telephonyCallRequest.findFirst({ where: { id: scope, organizationId: org } });
    if (!req) return { accepted: true, organizationId: org, reason: 'unknown_request' };
    let callId = req.callId;
    if (req.customerId) {
      const call = await this.prisma.call.create({ data: { organizationId: org, customerId: req.customerId, direction: 'outbound', status: mapped, outcome: status || 'failed', toNumber: req.toNumber, fromNumber: '', providerCallId: attemptId, durationSec, agentId: req.agentId, provider: 'sarvam', endedAt: new Date(), hangupCause: failure, summary: summary(transcript) } });
      callId = call.id;
      await this.saveTranscript(org, req.customerId, req.toNumber, call.id, transcript);
    }
    await this.prisma.telephonyCallRequest.update({ where: { id: req.id }, data: { status: mapped, durationSec, failureReason: failure, callId, providerCallId: req.providerCallId ?? attemptId } });
    log.info('telephony.sarvam_result', { requestId: req.id, status: mapped, durationSec });
    return { accepted: true, organizationId: org };
  }

  private async saveTranscript(organizationId: string, customerId: string, phone: string, callId: string, lines: Array<{ role: 'user' | 'assistant'; content: string }>) {
    if (!lines.length) return;
    const conv = (await this.prisma.conversation.findFirst({ where: { organizationId, channel: 'voice', externalId: phone } })) ?? (await this.prisma.conversation.create({ data: { id: randomUUID(), organizationId, channel: 'voice', externalId: phone, customerId, updatedAt: new Date() } }));
    await this.prisma.message.createMany({ data: lines.slice(0, 200).map((l, i) => ({ id: `${callId}-${i}`.slice(0, 191), organizationId, conversationId: conv.id, role: l.role, content: l.content.slice(0, 4000), metadata: { callId, provider: 'sarvam' } })) });
  }
}

/** Transcript: accepts an array of { role|speaker, content|text|message } or a plain string. */
export function transcriptLines(t: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (typeof t === 'string') return t.trim() ? [{ role: 'assistant', content: t.trim() }] : [];
  if (!Array.isArray(t)) return [];
  return t
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const who = String(o.role ?? o.speaker ?? '').toLowerCase();
      const content = String(o.content ?? o.text ?? o.message ?? '').trim();
      return { role: (who.includes('user') || who.includes('customer') || who.includes('human') ? 'user' : 'assistant') as 'user' | 'assistant', content };
    })
    .filter((l) => l.content);
}

function callerPhone(b: Record<string, unknown>): string | undefined {
  const c = (b.channel_info ?? {}) as Record<string, unknown>;
  for (const v of [c.user_phone_number, c.from, c.caller, c.caller_number, b.user_phone_number, (b.final_agent_variables as Record<string, unknown> | undefined)?.user_phone_number]) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

const summary = (lines: Array<{ content: string }>) => (lines.length ? lines.map((l) => l.content).join(' ').slice(0, 600) : null);

/** Stored webhook payloads keep outcome fields, not the full transcript (that is saved as messages). */
function redact(b: Record<string, unknown>) {
  const { interaction_transcript: _t, ...rest } = b;
  return rest;
}
