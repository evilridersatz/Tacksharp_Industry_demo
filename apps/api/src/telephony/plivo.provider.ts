import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { providerCredentials } from '../integrations/provider-scope.js';
import { VoiceService } from '../voice/voice.service.js';
import type { Capabilities, CallStatus, OutboundRequest, OutboundResult, TelephonyProvider, WebhookInput, WebhookResult } from './types.js';

/** Plivo stays fully supported (backward compatible): our engine runs the conversation. */
export class PlivoTelephonyProvider implements TelephonyProvider {
  readonly id = 'plivo' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly voice: VoiceService,
  ) {}

  async getCapabilities(organizationId: string): Promise<Capabilities> {
    const c = await providerCredentials('plivo', organizationId);
    const configured = c.source !== 'none' && !c.reason && Boolean(c.source === 'organization' ? c.config.fromNumber : config.plivo.fromNumber);
    return {
      provider: 'plivo',
      configured,
      outbound: true,
      inbound: true,
      conversation: 'our_engine',
      instructionsSource: 'agent_builder',
      knowledgeSource: 'agent_builder',
      webhookAuth: 'provider_signature',
      realtimeAudio: config.voice.mode === 'stream' ? 'Bidirectional audio stream (real-time mode) with barge-in.' : 'Record-and-reply turns (set VOICE_MODE=stream for real-time audio and barge-in).',
      numberProvisioning: 'Numbers bought in the Plivo console; routed to an organization in Settings → Integrations → Plivo (verified on the account).',
      pricing: 'Per your Plivo account rates (set PLIVO_PRICE_PER_MIN to show estimates).',
      limits: 'Per Plivo account (CPS / concurrency set by Plivo).',
      verifiedFrom: ['Existing production integration (signature-verified answer / turn / hangup webhooks).'],
      notes: ['Agent Builder instructions and knowledge base are used live on every turn.'],
    };
  }

  async initiateOutboundCall(req: OutboundRequest): Promise<OutboundResult> {
    const started = Date.now();
    const r = await this.voice.startOutboundCall({ organizationId: req.organizationId, customerId: req.customerId, agentId: req.agent.id });
    if (r.started) {
      const call = await this.prisma.call.findUnique({ where: { id: r.callId }, select: { providerRequestId: true } });
      return { ok: true, callId: r.callId, providerCallId: call?.providerRequestId ?? null, latencyMs: Date.now() - started };
    }
    return { ok: false, reason: r.reason, retryable: false, latencyMs: Date.now() - started };
  }

  async handleInboundCall(input: WebhookInput) {
    return { handledBy: 'our_engine' as const, xml: await this.voice.answerInbound((input.body ?? {}) as Record<string, string>) };
  }

  async getCallStatus(organizationId: string, requestId: string): Promise<CallStatus | null> {
    const r = await this.prisma.telephonyCallRequest.findFirst({ where: { id: requestId, organizationId } });
    if (!r) return null;
    const call = r.callId ? await this.prisma.call.findFirst({ where: { id: r.callId, organizationId } }) : null;
    return call ? { status: call.status, outcome: call.outcome, durationSec: call.durationSec, endedAt: call.endedAt, failureReason: call.hangupCause } : { status: r.status, failureReason: r.failureReason };
  }

  async handleWebhook(): Promise<WebhookResult> {
    // Plivo callbacks keep their signature-verified routes (/voice/answer, /voice/inbound, /voice/turn, /voice/hangup).
    return { accepted: false, reason: 'plivo_webhooks_use_voice_routes' };
  }
}
