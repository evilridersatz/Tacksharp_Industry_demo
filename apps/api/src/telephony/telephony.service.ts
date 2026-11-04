import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { effectiveCallWindow } from '../settings/tenant-settings.js';
import { nextAllowedCallTime } from '../common/time.js';
import { log } from '../common/logger.js';
import { mask } from '../whatsapp/whatsapp-sender.service.js';
import { followUpConfig, liveGate } from '../restaurant/followup-config.js';
import { e164 } from '../voice-agents/agent-validation.js';
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
    private readonly followUps: FollowUpsService,
  ) {
    // Sarvam is the only telephony provider. Plivo was removed (2026-11); historical Plivo call rows stay as records.
    this.providers = { sarvam: new SarvamTelephonyProvider(prisma) };
  }

  get sarvam() {
    return this.providers.sarvam as SarvamTelephonyProvider;
  }

  // -------------------------------------------------------------------------------------------- settings / routing

  async defaultProvider(_organizationId?: string): Promise<ProviderId> {
    return 'sarvam';
  }

  async setDefaultProvider(actor: Actor, provider: unknown) {
    if (provider !== 'sarvam') throw new BadRequestException('Sarvam is the only voice provider (Plivo was removed).');
    const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId: actor.org } });
    const data = { ...((row?.data as Record<string, unknown>) ?? {}), telephony: { provider } };
    await this.prisma.organizationSettings.upsert({ where: { organizationId: actor.org }, update: { data: data as Prisma.InputJsonValue }, create: { organizationId: actor.org, data: data as Prisma.InputJsonValue } });
    await this.prisma.auditEvent.create({ data: { organizationId: actor.org, actor: `user:${actor.sub}`, entityType: 'telephony', entityId: actor.org, action: 'telephony.provider_set', data: { provider } } });
    return this.overview(actor.org, true);
  }

  async overview(organizationId: string, showWebhookUrls = true) {
    const [def, sarvam, agents] = await Promise.all([
      this.defaultProvider(organizationId),
      this.providers.sarvam.getCapabilities(organizationId),
      this.prisma.voiceAgent.findMany({ where: { organizationId, telephonyProvider: 'sarvam', status: { not: 'archived' } }, select: { id: true, name: true } }),
    ]);
    return {
      defaultProvider: def,
      providers: { sarvam },
      systemAgentId: await this.systemAgentId(organizationId),
      dryRun: followUpConfig().dryRun,
      // Inbound result webhooks to paste into each Sarvam inbound deployment (one per agent).
      /** The organization's Sarvam-hosted agent (configured in the Sarvam console). */
      sarvamOrgInboundWebhook: showWebhookUrls ? SarvamTelephonyProvider.webhookUrl(organizationId, 'inbound') : null,
      sarvamInboundWebhooks: showWebhookUrls ? agents.map((a) => ({ agentId: a.id, agentName: a.name, url: SarvamTelephonyProvider.webhookUrl(organizationId, `inbound:${a.id}`) })) : [],
    };
  }

  // -------------------------------------------------------------------------------------------- readiness

  /**
   * Launch checklist for one agent, in plain English, from real state only: agent status and test, knowledge base
   * processing, the chosen provider's configuration, number routing, customers who agreed to calls, calling hours,
   * limits and whether this server sends for real (dry run). Each failing check says how to fix it.
   */
  async agentReadiness(organizationId: string, agentId: string) {
    const agent = await this.prisma.voiceAgent.findFirst({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found.');
    type Check = { id: string; label: string; ok: boolean; required: boolean; detail: string; action?: { label: string; href: string } };
    const checks: Check[] = [];
    const add = (c: Check) => checks.push(c);
    const inbound = agent.inbound as { enabled?: boolean; phoneNumber?: string | null } | null;
    const outbound = agent.outbound as { enabled?: boolean } | null;
    const provider: ProviderId = 'sarvam';
    const self = `/voice-agents/${agent.id}`;

    add({ id: 'instructions', label: 'Instructions and greeting', ok: agent.instructions.length >= 20 && agent.greeting.length >= 2, required: true, detail: 'The assistant knows what to do and how to greet callers.', action: { label: 'Edit', href: self } });
    if (agent.knowledgeBaseId) {
      const docs = await this.prisma.knowledgeDocument.groupBy({ by: ['status'], where: { organizationId, knowledgeBaseId: agent.knowledgeBaseId }, _count: { _all: true } });
      const by = Object.fromEntries(docs.map((d) => [d.status, d._count._all])) as Record<string, number>;
      const pending = (by.uploaded ?? 0) + (by.processing ?? 0);
      add({ id: 'knowledge', label: 'Business knowledge', ok: (by.indexed ?? 0) > 0 && !pending && !by.failed, required: true, detail: by.failed ? `${by.failed} document(s) could not be read.` : pending ? `${pending} document(s) are still being processed.` : (by.indexed ?? 0) ? `${by.indexed} document(s) ready.` : 'The knowledge base is empty.', action: { label: 'Open knowledge', href: self } });
    } else add({ id: 'knowledge', label: 'Business knowledge', ok: false, required: false, detail: 'No documents attached: the assistant answers only from its instructions.', action: { label: 'Add knowledge', href: self } });
    add({ id: 'tested', label: 'Tested after the latest changes', ok: Boolean(agent.lastTestedAt), required: true, detail: agent.lastTestedAt ? 'A test conversation passed.' : 'Have a test conversation before launching.', action: { label: 'Test now', href: self } });
    add({ id: 'active', label: 'Agent published', ok: agent.status === 'active', required: true, detail: agent.status === 'active' ? 'Active.' : agent.status === 'archived' ? 'Archived.' : 'Still a draft.', action: { label: 'Publish', href: self } });

    if (inbound?.enabled || outbound?.enabled) {
      const caps = await this.providers[provider].getCapabilities(organizationId);
      add({ id: 'provider', label: 'Voice provider (Sarvam)', ok: caps.configured, required: true, detail: caps.configured ? 'Connected for this workspace.' : 'Sarvam Voice Agents is not set up (account details and a passed test call), or the server has no webhook secret.', action: { label: 'Set up', href: '/settings/integrations/sarvam-telephony' } });
      add({ id: 'sarvam_app', label: 'Sarvam agent id', ok: Boolean(agent.sarvamAppId), required: true, detail: agent.sarvamAppId ? `Calls are answered by Sarvam agent ${agent.sarvamAppId} v${agent.sarvamAppVersion ?? 1}.` : 'Enter the id of the agent you created in Sarvam.', action: { label: 'Add it', href: self } });
    }
    if (inbound?.enabled) {
      add({ id: 'inbound_number', label: 'Number customers call', ok: Boolean(inbound.phoneNumber), required: true, detail: 'Assign this number to an inbound deployment in Sarvam and paste the webhook URL shown on the Voice agents page.', action: { label: 'Add number', href: self } });
    }
    if (outbound?.enabled) {
      const consenting = await this.prisma.customer.count({ where: { organizationId, callingConsent: true, optedOutAt: null, doNotContact: false } });
      add({ id: 'consent', label: 'Customers who agreed to calls', ok: consenting > 0, required: true, detail: consenting ? `${consenting} customer(s) can be called. Opt-outs and do-not-contact are always respected.` : 'No customer has agreed to be called yet. Record consent on the customer first.', action: { label: 'Customers', href: '/contacts' } });
      const w = effectiveCallWindow(await this.followUps.settingsFor(organizationId));
      add({ id: 'hours', label: 'Calling hours', ok: true, required: false, detail: `Calls are placed only between ${String(w.start).padStart(2, '0')}:00 and ${String(w.end).padStart(2, '0')}:00 (India time).`, action: { label: 'Change', href: '/settings' } });
      const l = (agent.callLimits as { maxConcurrent?: number; dailyLimit?: number } | null) ?? {};
      add({ id: 'limits', label: 'Limits', ok: true, required: false, detail: `At most ${l.maxConcurrent ?? 2} call(s) at once and ${l.dailyLimit ?? 50} per day for this agent; each request is placed once, never redialled.` });
    }
    const live = followUpConfig();
    add({ id: 'live', label: 'Live sending', ok: !live.dryRun, required: false, detail: live.dryRun ? 'Test mode: calls are checked end to end but not placed. Tacksharp turns live calling on for your account.' : live.liveAllowAll ? 'Live for consenting customers.' : 'Live for approved test numbers only.' });
    const blocking = checks.filter((c) => c.required && !c.ok);
    return { agentId: agent.id, ready: blocking.length === 0, dryRun: live.dryRun, checks, missing: blocking.map((c) => c.label) };
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
    return this.dial(actor, key, agent, customer, toNumber, { ignoreCallWindow: body.ignoreCallWindow === true, requestedBy: `user:${actor.sub}` });
  }

  /**
   * A call the system places (feedback / ready / follow-up / "test call" button): same gates, same idempotency and
   * same Sarvam path as placeCall, with the organization's system agent (settings.telephony.systemAgentId, or the
   * only active outbound Sarvam agent). Never throws for a business reason: returns { started:false, reason }.
   */
  async placeSystemCall(input: { organizationId: string; customerId: string; purpose: string; idempotencyKey: string; ignoreCallWindow?: boolean; variables?: Record<string, string>; overrides?: { initialBotMessage?: string; initialLanguage?: 'Tamil' | 'English' } }): Promise<{ started: boolean; requestId?: string; reason?: string; retryAt?: Date; dryRun?: boolean }> {
    const actor = { sub: `system:${input.purpose}`, org: input.organizationId };
    const key = `${input.purpose}:${input.idempotencyKey}`.replace(/[^\w.:-]/g, '_').slice(0, 100);
    const prior = await this.prisma.telephonyCallRequest.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.org, idempotencyKey: key } } });
    if (prior) return systemResult(view(prior));
    const agentId = await this.systemAgentId(actor.org);
    if (!agentId) return { started: false, reason: 'no_sarvam_agent: choose the Sarvam agent for automatic calls (Voice agents)' };
    const agent = await this.prisma.voiceAgent.findFirst({ where: { id: agentId, organizationId: actor.org } });
    const customer = await this.prisma.customer.findFirst({ where: { id: input.customerId, organizationId: actor.org } });
    if (!agent || !customer) return { started: false, reason: !agent ? 'no_sarvam_agent' : 'customer_not_found' };
    const r = await this.dial(actor, key, agent, customer, customer.phone ?? '', { ignoreCallWindow: input.ignoreCallWindow === true, requestedBy: actor.sub, variables: {
      ...(input.variables ?? {}),
      call_purpose: input.purpose,
      // Same first sentence as app_overrides.initial_bot_message, also as a variable: an agent whose console first message
      // is set to the @call_opening variable opens with it even if Sarvam does not apply the override. Dropped
      // automatically when the agent does not declare it.
      ...(input.overrides?.initialBotMessage ? { call_opening: input.overrides.initialBotMessage.slice(0, 600) } : {}),
    }, overrides: input.overrides });
    return systemResult(r);
  }

  /** The agent used for automatic calls: settings.telephony.systemAgentId, else the only active outbound Sarvam agent. */
  async systemAgentId(organizationId: string): Promise<string | null> {
    const st = await this.prisma.organizationSettings.findUnique({ where: { organizationId } });
    const chosen = (st?.data as { telephony?: { systemAgentId?: string } } | null)?.telephony?.systemAgentId;
    if (chosen) return chosen;
    const agents = await this.prisma.voiceAgent.findMany({ where: { organizationId, status: 'active', sarvamAppId: { not: null } }, select: { id: true, outbound: true }, take: 5 });
    const outbound = agents.filter((a) => (a.outbound as { enabled?: boolean } | null)?.enabled);
    return outbound.length === 1 ? outbound[0].id : null;
  }

  async setSystemAgent(actor: Actor, agentId: unknown) {
    const id = typeof agentId === 'string' && agentId ? agentId : null;
    if (id && !(await this.prisma.voiceAgent.findFirst({ where: { id, organizationId: actor.org } }))) throw new NotFoundException('Agent not found.');
    const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId: actor.org } });
    const prev = (row?.data as Record<string, unknown>) ?? {};
    const data = { ...prev, telephony: { ...((prev.telephony as Record<string, unknown>) ?? {}), provider: 'sarvam', systemAgentId: id } };
    await this.prisma.organizationSettings.upsert({ where: { organizationId: actor.org }, update: { data: data as Prisma.InputJsonValue }, create: { organizationId: actor.org, data: data as Prisma.InputJsonValue } });
    await this.audit(actor, actor.org, 'telephony.system_agent_set', { agentId: id });
    return this.overview(actor.org, true);
  }

  /** Every outbound gate, then Sarvam. Shared by placeCall (a person) and placeSystemCall (automation). */
  private async dial(
    actor: Actor,
    key: string,
    agent: { id: string; name: string; status: string; outbound: unknown; callLimits: unknown; sarvamAppId: string | null; sarvamAppVersion: number | null },
    customer: { id: string; name: string | null; phone: string | null; callingConsent: boolean; doNotContact: boolean; optedOutAt: Date | null; isDemo: boolean } | null,
    toNumber: string,
    opts: { ignoreCallWindow: boolean; requestedBy: string; variables?: Record<string, string>; overrides?: { initialBotMessage?: string; initialLanguage?: 'Tamil' | 'English' } },
  ) {
    const provider: ProviderId = 'sarvam';

    const reject = (reason: string, extra: Record<string, unknown> = {}) => this.record(actor, key, { agentId: agent.id, customerId: customer?.id ?? null, toNumber, provider, status: 'rejected', failureReason: reason }, extra);

    if (agent.status !== 'active') return reject('agent_not_active: publish the agent first');
    if (!(agent.outbound as { enabled?: boolean } | null)?.enabled) return reject('agent_outbound_disabled');
    if (!customer) return reject('unknown_number: add the customer and record their calling consent first');
    // Opt-out and do-not-contact first: they are the customer's explicit "no" and the clearest reason to show.
    if (customer.optedOutAt) return reject('opted_out');
    if (customer.doNotContact) return reject('do_not_contact');
    if (!customer.callingConsent) return reject('no_calling_consent');

    if (!opts.ignoreCallWindow) {
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

    const gate = liveGate(followUpConfig(), customer as Parameters<typeof liveGate>[1]);
    if (!gate.live) {
      // Dry run: everything above was really checked; no provider is contacted and nothing is billed.
      return this.record(actor, key, { agentId: agent.id, customerId: customer.id, toNumber, provider, status: 'dry_run', failureReason: `not_live: ${gate.reason}` });
    }
    const caps = await this.providers[provider].getCapabilities(actor.org);
    if (!caps.configured) return reject(`${provider}_not_configured`);

    // Claim the key first (unique index): two concurrent requests with the same key cannot both dial.
    let row;
    try {
      row = await this.prisma.telephonyCallRequest.create({ data: { organizationId: actor.org, idempotencyKey: key, agentId: agent.id, customerId: customer.id, toNumber, provider, status: 'accepted', requestedBy: opts.requestedBy } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        const again = await this.prisma.telephonyCallRequest.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.org, idempotencyKey: key } } });
        return { ...view(again!), replayed: true };
      }
      throw e;
    }
    const req = { organizationId: actor.org, requestId: row.id, customerId: customer.id, to: toNumber, agent: { id: agent.id, name: agent.name, sarvamAppId: agent.sarvamAppId, sarvamAppVersion: agent.sarvamAppVersion }, variables: { caller_phone: `+${toNumber.replace(/^\+/, '')}`, ...(customer.name ? { customer_name: customer.name } : {}), ...(opts.variables ?? {}) }, overrides: opts.overrides };
    // caller_phone: for an OUTBOUND call Sarvam's "User Identifier" is empty (docs), so the number is passed as an agent
    // variable the tools can use (@caller_phone); dropped automatically if the agent does not declare it.
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
    log.info('telephony.outbound', { requestId: row.id, provider, ok: result.ok, ms: result.latencyMs, to: mask(toNumber), purpose: opts.variables?.call_purpose ?? 'manual', opening: Boolean(opts.overrides?.initialBotMessage), ...(result.ok ? {} : { reason: result.reason.slice(0, 160) }) });
    await this.audit(actor, row.id, 'telephony.call_requested', { provider, ok: result.ok, agentId: agent.id });
    return { ...view(updated), acceptMs: result.latencyMs };
  }

  private async record(actor: Actor, key: string, data: { agentId: string; customerId: string | null; toNumber: string; provider: string; status: string; failureReason: string }, extra: Record<string, unknown> = {}) {
    try {
      const row = await this.prisma.telephonyCallRequest.create({ data: { organizationId: actor.org, idempotencyKey: key, requestedBy: actor.sub.includes(':') ? actor.sub : `user:${actor.sub}`, ...data, failureReason: data.failureReason.slice(0, 190) } });
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
    const live = r.provider === 'sarvam' ? await this.providers.sarvam.getCallStatus(organizationId, requestId) : null; // historical Plivo rows: record only
    return { ...view(r), live };
  }

  async list(organizationId: string) {
    const rows = await this.prisma.telephonyCallRequest.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(view);
  }

  private audit(actor: Actor, entityId: string, action: string, data: Record<string, unknown>) {
    return this.prisma.auditEvent.create({ data: { organizationId: actor.org, actor: actor.sub.includes(':') ? actor.sub : `user:${actor.sub}`, entityType: 'telephony_call', entityId, action, data: data as Prisma.InputJsonValue } });
  }
}

function systemResult(v: { requestId: string; status: string; failureReason: string | null; retryAt?: Date }) {
  // dry_run is NOT started: every gate passed but nobody was called (DRY_RUN / not an approved live recipient).
  const started = v.status === 'dialing' || v.status === 'accepted' || v.status === 'completed';
  return { started, requestId: v.requestId, dryRun: v.status === 'dry_run', reason: started ? undefined : (v.failureReason ?? v.status), retryAt: v.retryAt };
}

function view(r: { id: string; agentId: string | null; customerId: string | null; toNumber: string; provider: string; status: string; failureReason: string | null; providerCallId: string | null; callId: string | null; durationSec: number | null; createdAt: Date }) {
  return { requestId: r.id, agentId: r.agentId, customerId: r.customerId, to: r.toNumber ? `••••${r.toNumber.slice(-4)}` : '', provider: r.provider, status: r.status, failureReason: r.failureReason, providerCallId: r.providerCallId, callId: r.callId, durationSec: r.durationSec, createdAt: r.createdAt };
}
