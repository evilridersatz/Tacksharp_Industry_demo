import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { VoiceService } from '../voice/voice.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { effectiveCallWindow } from '../settings/tenant-settings.js';
import { nextAllowedCallTime } from '../common/time.js';
import { log } from '../common/logger.js';
import { mask } from '../whatsapp/whatsapp-sender.service.js';
import { followUpConfig, liveGate } from '../restaurant/followup-config.js';
import { e164 } from '../voice-agents/agent-validation.js';
import { PlivoTelephonyProvider } from './plivo.provider.js';
import { SarvamTelephonyProvider } from './sarvam.provider.js';
import type { ProviderId, TelephonyProvider } from './types.js';

type Actor = { sub: string; org: string };

/** Org-wide caps (the agent's own limits can only be lower). */
const ORG_MAX_CONCURRENT = () => Number(process.env.TELEPHONY_ORG_MAX_CONCURRENT) || 5;
const ORG_DAILY_LIMIT = () => Number(process.env.TELEPHONY_ORG_DAILY_LIMIT) || 200;
const IN_FLIGHT = ['accepted', 'dialing'];
const STALE_MS = 30 * 60_000;

export type PlaceCallBody = { agentId?: unknown; to?: unknown; customerId?: unknown; idempotencyKey?: unknown; confirm?: unknown; ignoreCallWindow?: unknown };

/**
 * Routes calls to the provider chosen for the agent (or the organization's default) and owns every outbound gate.
 * Order of checks (each rejection is recorded with a clear reason and returned, never retried or redialled):
 *  confirm -> idempotency -> agent (this tenant, active, outbound on) -> E.164 -> customer of this tenant ->
 *  consent / DND / opt-out -> calling hours -> concurrency + daily limits -> DRY_RUN and live gate -> provider configured.
 */
@Injectable()
export class TelephonyService {
  readonly providers: Record<ProviderId, TelephonyProvider>;

  constructor(
    private readonly prisma: PrismaService,
    voice: VoiceService,
    private readonly followUps: FollowUpsService,
  ) {
    this.providers = { plivo: new PlivoTelephonyProvider(prisma, voice), sarvam: new SarvamTelephonyProvider(prisma) };
  }

  get sarvam() {
    return this.providers.sarvam as SarvamTelephonyProvider;
  }

  // -------------------------------------------------------------------------------------------- settings / routing

  async defaultProvider(organizationId: string): Promise<ProviderId> {
    const s = await this.prisma.organizationSettings.findUnique({ where: { organizationId } });
    const p = (s?.data as { telephony?: { provider?: string } } | null)?.telephony?.provider;
    return p === 'sarvam' ? 'sarvam' : 'plivo';
  }

  async setDefaultProvider(actor: Actor, provider: unknown) {
    if (provider !== 'plivo' && provider !== 'sarvam') throw new BadRequestException('provider must be plivo or sarvam.');
    const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId: actor.org } });
    const data = { ...((row?.data as Record<string, unknown>) ?? {}), telephony: { provider } };
    await this.prisma.organizationSettings.upsert({ where: { organizationId: actor.org }, update: { data: data as Prisma.InputJsonValue }, create: { organizationId: actor.org, data: data as Prisma.InputJsonValue } });
    await this.prisma.auditEvent.create({ data: { organizationId: actor.org, actor: `user:${actor.sub}`, entityType: 'telephony', entityId: actor.org, action: 'telephony.provider_set', data: { provider } } });
    return this.overview(actor.org, true);
  }

  async overview(organizationId: string, showWebhookUrls = true) {
    const [def, plivo, sarvam, agents] = await Promise.all([
      this.defaultProvider(organizationId),
      this.providers.plivo.getCapabilities(organizationId),
      this.providers.sarvam.getCapabilities(organizationId),
      this.prisma.voiceAgent.findMany({ where: { organizationId, telephonyProvider: 'sarvam', status: { not: 'archived' } }, select: { id: true, name: true } }),
    ]);
    return {
      defaultProvider: def,
      providers: { plivo, sarvam },
      dryRun: followUpConfig().dryRun,
      // Inbound result webhooks to paste into each Sarvam inbound deployment (one per agent).
      sarvamInboundWebhooks: showWebhookUrls ? agents.map((a) => ({ agentId: a.id, agentName: a.name, url: SarvamTelephonyProvider.webhookUrl(organizationId, `inbound:${a.id}`) })) : [],
    };
  }

  // -------------------------------------------------------------------------------------------- outbound

  async placeCall(actor: Actor, body: PlaceCallBody) {
    if (body.confirm !== true) throw new BadRequestException('Confirm the call first (confirm: true).');
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (!/^[\w.:-]{8,100}$/.test(key)) throw new BadRequestException('idempotencyKey: 8 to 100 letters, digits, ., :, - or _ (one per intended call).');
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    const to = body.to === undefined || body.to === null || body.to === '' ? null : e164(body.to);
    if (body.to && !to) throw new BadRequestException('The number must be in international format, e.g. +919876543210.');
    const customerIdIn = typeof body.customerId === 'string' ? body.customerId : null;
    if (!to && !customerIdIn) throw new BadRequestException('Give the customer (customerId) or the number to call (to).');

    // Idempotency: the same key returns the first result, never a second call.
    const prior = await this.prisma.telephonyCallRequest.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.org, idempotencyKey: key } } });
    if (prior) {
      if ((agentId && prior.agentId !== agentId) || (to && prior.toNumber !== to)) throw new ConflictException('This idempotency key was already used for a different call.');
      return { ...view(prior), replayed: true };
    }

    const agent = await this.prisma.voiceAgent.findFirst({ where: { id: agentId, organizationId: actor.org } });
    if (!agent) throw new NotFoundException('Agent not found.');
    const customer = customerIdIn
      ? await this.prisma.customer.findFirst({ where: { id: customerIdIn, organizationId: actor.org } })
      : await this.prisma.customer.findFirst({ where: { organizationId: actor.org, phone: to! } });
    const toNumber = to ?? customer?.phone ?? '';
    if (customerIdIn && !customer) throw new NotFoundException('Customer not found.');
    if (customer && to && customer.phone !== to) throw new BadRequestException('That number does not belong to this customer.');
    const provider: ProviderId = agent.telephonyProvider === 'sarvam' ? 'sarvam' : 'plivo';

    const reject = (reason: string, extra: Record<string, unknown> = {}) => this.record(actor, key, { agentId: agent.id, customerId: customer?.id ?? null, toNumber, provider, status: 'rejected', failureReason: reason }, extra);

    if (agent.status !== 'active') return reject('agent_not_active: publish the agent first');
    if (!(agent.outbound as { enabled?: boolean } | null)?.enabled) return reject('agent_outbound_disabled');
    if (!customer) return reject('unknown_number: add the customer and record their calling consent first');
    if (!customer.callingConsent) return reject('no_calling_consent');
    if (customer.doNotContact) return reject('do_not_contact');
    if (customer.optedOutAt) return reject('opted_out');

    if (body.ignoreCallWindow !== true) {
      const w = effectiveCallWindow(await this.followUps.settingsFor(actor.org));
      const allowedAt = nextAllowedCallTime(new Date(), w.start, w.end);
      if (allowedAt.getTime() > Date.now() + 60_000) return reject('outside_calling_hours', { retryAt: allowedAt });
    }

    const limits = (agent.callLimits as { maxConcurrent?: number; dailyLimit?: number } | null) ?? {};
    const recent = new Date(Date.now() - STALE_MS);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [orgLive, agentLive, orgToday, agentToday] = await Promise.all([
      this.prisma.telephonyCallRequest.count({ where: { organizationId: actor.org, status: { in: IN_FLIGHT }, createdAt: { gt: recent } } }),
      this.prisma.telephonyCallRequest.count({ where: { organizationId: actor.org, agentId: agent.id, status: { in: IN_FLIGHT }, createdAt: { gt: recent } } }),
      this.prisma.telephonyCallRequest.count({ where: { organizationId: actor.org, status: { notIn: ['rejected', 'dry_run'] }, createdAt: { gte: startOfDay } } }),
      this.prisma.telephonyCallRequest.count({ where: { organizationId: actor.org, agentId: agent.id, status: { notIn: ['rejected', 'dry_run'] }, createdAt: { gte: startOfDay } } }),
    ]);
    if (orgLive >= ORG_MAX_CONCURRENT() || agentLive >= (limits.maxConcurrent ?? 2)) return reject('concurrency_limit');
    if (orgToday >= ORG_DAILY_LIMIT() || agentToday >= (limits.dailyLimit ?? 50)) return reject('daily_limit');
    const live = await this.prisma.telephonyCallRequest.findFirst({ where: { organizationId: actor.org, customerId: customer.id, status: { in: IN_FLIGHT }, createdAt: { gt: recent } } });
    if (live) return reject('call_already_in_progress');

    const gate = liveGate(followUpConfig(), customer);
    if (!gate.live) {
      // Dry run: everything above was really checked; no provider is contacted and nothing is billed.
      return this.record(actor, key, { agentId: agent.id, customerId: customer.id, toNumber, provider, status: 'dry_run', failureReason: `not_live: ${gate.reason}` });
    }
    const caps = await this.providers[provider].getCapabilities(actor.org);
    if (!caps.configured) return reject(`${provider}_not_configured`);

    // Claim the key first (unique index): two concurrent requests with the same key cannot both dial.
    let row;
    try {
      row = await this.prisma.telephonyCallRequest.create({ data: { organizationId: actor.org, idempotencyKey: key, agentId: agent.id, customerId: customer.id, toNumber, provider, status: 'accepted', requestedBy: `user:${actor.sub}` } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        const again = await this.prisma.telephonyCallRequest.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.org, idempotencyKey: key } } });
        return { ...view(again!), replayed: true };
      }
      throw e;
    }
    const req = { organizationId: actor.org, requestId: row.id, customerId: customer.id, to: toNumber, agent: { id: agent.id, name: agent.name, sarvamAppId: agent.sarvamAppId, sarvamAppVersion: agent.sarvamAppVersion }, variables: customer.name ? { customer_name: customer.name } : undefined };
    let result = await this.providers[provider].initiateOutboundCall(req);
    // One retry, only when the provider certainly did NOT place the call (rate-limited / connection never made).
    if (!result.ok && result.retryable) {
      await new Promise((r) => setTimeout(r, Number(process.env.TELEPHONY_RETRY_DELAY_MS ?? 1500)));
      result = await this.providers[provider].initiateOutboundCall(req);
    }
    const updated = await this.prisma.telephonyCallRequest.update({
      where: { id: row.id },
      data: result.ok ? { status: 'dialing', providerCallId: result.providerCallId, callId: result.callId ?? null } : { status: 'failed', failureReason: result.reason.slice(0, 190) },
    });
    log.info('telephony.outbound', { requestId: row.id, provider, ok: result.ok, ms: result.latencyMs, to: mask(toNumber) });
    await this.audit(actor, row.id, 'telephony.call_requested', { provider, ok: result.ok, agentId: agent.id });
    return { ...view(updated), acceptMs: result.latencyMs };
  }

  private async record(actor: Actor, key: string, data: { agentId: string; customerId: string | null; toNumber: string; provider: string; status: string; failureReason: string }, extra: Record<string, unknown> = {}) {
    try {
      const row = await this.prisma.telephonyCallRequest.create({ data: { organizationId: actor.org, idempotencyKey: key, requestedBy: `user:${actor.sub}`, ...data, failureReason: data.failureReason.slice(0, 190) } });
      await this.audit(actor, row.id, `telephony.call_${data.status}`, { reason: data.failureReason, provider: data.provider });
      return { ...view(row), ...extra };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        const again = await this.prisma.telephonyCallRequest.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.org, idempotencyKey: key } } });
        return { ...view(again!), replayed: true };
      }
      throw e;
    }
  }

  async status(organizationId: string, requestId: string) {
    const r = await this.prisma.telephonyCallRequest.findFirst({ where: { id: requestId, organizationId } });
    if (!r) throw new NotFoundException('Call request not found');
    const live = await this.providers[r.provider === 'sarvam' ? 'sarvam' : 'plivo'].getCallStatus(organizationId, requestId);
    return { ...view(r), live };
  }

  async list(organizationId: string) {
    const rows = await this.prisma.telephonyCallRequest.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(view);
  }

  private audit(actor: Actor, entityId: string, action: string, data: Record<string, unknown>) {
    return this.prisma.auditEvent.create({ data: { organizationId: actor.org, actor: `user:${actor.sub}`, entityType: 'telephony_call', entityId, action, data: data as Prisma.InputJsonValue } });
  }
}

function view(r: { id: string; agentId: string | null; customerId: string | null; toNumber: string; provider: string; status: string; failureReason: string | null; providerCallId: string | null; callId: string | null; durationSec: number | null; createdAt: Date }) {
  return { requestId: r.id, agentId: r.agentId, customerId: r.customerId, to: r.toNumber ? `••••${r.toNumber.slice(-4)}` : '', provider: r.provider, status: r.status, failureReason: r.failureReason, providerCallId: r.providerCallId, callId: r.callId, durationSec: r.durationSec, createdAt: r.createdAt };
}
