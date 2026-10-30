import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { normalizePhone } from '../common/phone.js';
import { log } from '../common/logger.js';
import { followUpConfig } from '../restaurant/followup-config.js';
import { CredentialsService } from './credentials.service.js';
import { VaultUnavailableError } from './vault.js';
import { DEFAULT_CONFIG, FIELDS, PROVIDERS, priceFromEnv, validateSave, type Provider } from './providers.js';
import * as clients from './provider-clients.js';
import type { FetchLike, ProviderResult } from './provider-clients.js';

type Actor = { sub: string; org: string };
const who = (a: Actor) => `user:${a.sub}`;

/** Test operations per provider (anything else is refused). */
export const OPERATIONS: Record<Provider, string[]> = {
  plivo: ['connection', 'call'],
  sarvam: ['connection', 'tts', 'stt'],
  openai: ['connection'],
  whatsapp: ['connection'],
  // Sarvam documents no read-only credential check for Voice Agents, so the only proof is a real test call to an
  // approved test number (DRY_RUN off). It costs a call; it is never automatic.
  sarvam_telephony: ['call'],
};

const SAMPLE_TEXT: Record<string, string> = {
  'ta-IN': 'வணக்கம்! இது Tacksharp சோதனை அழைப்பு. உங்கள் order ready ஆகிவிட்டது.',
  'en-IN': 'Hello! This is a Tacksharp voice test. Your order is ready for pickup.',
  'hi-IN': 'नमस्ते! यह Tacksharp की आवाज़ का परीक्षण है।',
  'te-IN': 'నమస్కారం! ఇది Tacksharp వాయిస్ పరీక్ష.',
  'kn-IN': 'ನಮಸ್ಕಾರ! ಇದು Tacksharp ಧ್ವನಿ ಪರೀಕ್ಷೆ.',
  'ml-IN': 'നമസ്കാരം! ഇത് Tacksharp വോയ്സ് പരിശോധനയാണ്.',
};

/**
 * Organization-scoped provider configuration: save (encrypted), real connection tests, enable / disable, usage and
 * sanitized errors. The organization always comes from the session; secrets never leave the server.
 */
@Injectable()
export class IntegrationsService {
  /** Injected in tests; the global fetch in production. */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: CredentialsService,
  ) {}

  private provider(p: string): Provider {
    if (!(PROVIDERS as readonly string[]).includes(p)) throw new NotFoundException('Unknown integration.');
    return p as Provider;
  }

  private audit(org: string, actor: string, provider: string, action: string, data: Record<string, unknown> = {}) {
    // Field NAMES only - never values.
    return this.prisma.auditEvent.create({ data: { organizationId: org, actor, entityType: 'integration', entityId: provider, action, data: data as Prisma.InputJsonValue } });
  }

  private event(org: string, provider: Provider, kind: string, r: ProviderResult, source: string, cost: number | null = null) {
    return this.prisma.integrationEvent.create({
      data: { organizationId: org, provider, kind, ok: r.ok, latencyMs: r.latencyMs, errorCode: r.errorCode ?? null, message: r.message.slice(0, 500), units: r.units ?? null, unitType: r.unitType ?? null, costEstimate: cost === null ? null : new Prisma.Decimal(cost.toFixed(4)), source },
    });
  }

  /** Deployment facts an admin needs to configure webhooks (no secrets: only whether they are set). */
  private deployment() {
    const base = config.publicBaseUrl;
    return {
      publicBaseUrl: base,
      vault: { ready: !this.creds.vaultProblem, problem: this.creds.vaultProblem ? 'Credential encryption is not configured on this server (CREDENTIALS_KEYS). Saving secrets is disabled until an operator sets it.' : null, keyVersion: this.creds.activeKeyVersion },
      plivo: { answerUrl: `${base}/voice/answer`, inboundUrl: `${base}/voice/inbound`, hangupUrl: `${base}/voice/hangup`, signatureValidation: config.plivo.validateSignature },
      whatsapp: { webhookUrl: `${base}/webhooks/whatsapp`, verifyTokenSet: Boolean(config.whatsapp.verifyToken), appSecretSet: Boolean(process.env.META_APP_SECRET) },
      mode: { dryRun: followUpConfig().dryRun, liveTestRecipients: followUpConfig().liveTestRecipients.length },
    };
  }

  private view(provider: Provider, row: Awaited<ReturnType<CredentialsService['row']>>) {
    const cfg = { ...DEFAULT_CONFIG[provider], ...((row?.config ?? {}) as Record<string, string>) };
    return {
      provider,
      saved: Boolean(row),
      enabled: row?.enabled ?? false,
      status: row?.status ?? 'not_configured',
      lastTestAt: row?.lastTestAt ?? null,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      lastError: row?.lastError ?? null,
      updatedAt: row?.updatedAt ?? null,
      config: cfg,
      /** Masked hints only ("••••3fa1"). The values themselves are never returned. */
      secrets: Object.fromEntries(FIELDS[provider].filter((f) => f.secret).map((f) => [f.key, ((row?.secretHints ?? {}) as Record<string, string>)[f.key] ?? null])),
      fields: FIELDS[provider],
      operations: OPERATIONS[provider],
    };
  }

  async list(org: string) {
    const rows = await this.prisma.integrationCredential.findMany({ where: { organizationId: org } });
    const items = await Promise.all(PROVIDERS.map(async (p) => {
      const r = await this.creds.resolve(org, p);
      return { ...this.view(p, rows.find((x) => x.provider === p) ?? null), effective: { source: r.source, reason: r.reason ?? null } };
    }));
    return { items, deployment: this.deployment() };
  }

  async get(org: string, providerRaw: string) {
    const provider = this.provider(providerRaw);
    const row = await this.creds.row(org, provider);
    const eff = await this.creds.resolve(org, provider);
    const extra: Record<string, unknown> = {};
    if (provider === 'plivo') extra.numbers = await this.numbers(org);
    if (provider === 'whatsapp') {
      extra.routing = await this.prisma.organizationChannel.findMany({ where: { organizationId: org, kind: 'whatsapp_phone_number_id' }, select: { externalId: true, createdAt: true } });
      extra.delivery = await this.delivery(org);
    }
    return { ...this.view(provider, row), effective: { source: eff.source, reason: eff.reason ?? null }, usage: await this.usage(org, provider), deployment: this.deployment(), ...extra };
  }

  async save(actor: Actor, providerRaw: string, body: Record<string, unknown>) {
    const provider = this.provider(providerRaw);
    if (this.creds.vaultProblem) throw new ServiceUnavailableException('Credential encryption is not configured on this server, so secrets cannot be saved. An operator must set CREDENTIALS_KEYS.');
    const org = actor.org;
    const row = await this.creds.row(org, provider);
    let current: Record<string, string> = {};
    if (row) {
      try {
        current = this.creds.secretsOf(row);
      } catch (e) {
        if (!(e instanceof VaultUnavailableError)) throw e;
        current = {}; // unreadable with this server's keys: the admin must enter the secrets again
      }
    }
    const { config: cfg, secrets } = validateSave(provider, body ?? {}, { config: (row?.config ?? {}) as Record<string, string>, hasSecret: new Set(Object.keys(current).filter((k) => current[k])) });
    const merged: Record<string, string> = { ...current };
    for (const [k, v] of Object.entries(secrets)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    const sealed = this.creds.sealSecrets(org, provider, merged);
    const data = { config: cfg, ...sealed, status: 'untested', lastError: null, updatedBy: who(actor) };
    await this.prisma.integrationCredential.upsert({
      where: { organizationId_provider: { organizationId: org, provider } },
      create: { organizationId: org, provider, enabled: false, ...data },
      update: data,
    });
    this.creds.invalidate(org, provider);
    await this.audit(org, who(actor), provider, 'integration.saved', { secretFieldsChanged: Object.keys(secrets), configFields: Object.keys(cfg) });
    log.info('integration.saved', { organizationId: org, provider, secretFieldsChanged: Object.keys(secrets).length });
    return this.get(org, provider);
  }

  async setEnabled(actor: Actor, providerRaw: string, enabled: boolean) {
    const provider = this.provider(providerRaw);
    const row = await this.creds.row(actor.org, provider);
    if (!row) throw new NotFoundException('Save the credentials first.');
    if (enabled && row.status !== 'ok') throw new BadRequestException('Run a successful connection test before enabling. Saving credentials does not prove they work.');
    await this.prisma.integrationCredential.update({ where: { id: row.id }, data: { enabled, updatedBy: who(actor) } });
    this.creds.invalidate(actor.org, provider);
    await this.audit(actor.org, who(actor), provider, enabled ? 'integration.enabled' : 'integration.disabled');
    return this.get(actor.org, provider);
  }

  async remove(actor: Actor, providerRaw: string) {
    const provider = this.provider(providerRaw);
    const row = await this.creds.row(actor.org, provider);
    if (!row) throw new NotFoundException('Nothing saved for this integration.');
    await this.prisma.integrationCredential.delete({ where: { id: row.id } });
    this.creds.invalidate(actor.org, provider);
    await this.audit(actor.org, who(actor), provider, 'integration.deleted');
    return { ok: true };
  }

  // ------------------------------------------------------------------------------------------------ tests

  /** Runs against the SAVED credentials of this organization only (never another organization's, never the env). */
  async test(actor: Actor, providerRaw: string, op: string, body: Record<string, unknown>) {
    const provider = this.provider(providerRaw);
    if (!OPERATIONS[provider].includes(op)) throw new BadRequestException(`Unknown test. Available: ${OPERATIONS[provider].join(', ')}.`);
    const row = await this.creds.row(actor.org, provider);
    if (!row) throw new BadRequestException('Save the credentials first, then test them.');
    let secrets: Record<string, string>;
    try {
      secrets = this.creds.secretsOf(row);
    } catch {
      throw new ServiceUnavailableException('The saved credentials cannot be decrypted on this server (encryption key missing). Enter them again.');
    }
    const cfg = { ...DEFAULT_CONFIG[provider], ...((row.config ?? {}) as Record<string, string>) };
    let result: ProviderResult & Record<string, unknown>;
    let cost: number | null = null;
    switch (`${provider}:${op}`) {
      case 'plivo:connection': {
        const acct = await clients.plivoAccount(this.fetchImpl, { authId: secrets.authId, authToken: secrets.authToken });
        if (!acct.ok || !cfg.fromNumber) { result = acct; break; }
        const num = await clients.plivoNumber(this.fetchImpl, { authId: secrets.authId, authToken: secrets.authToken }, cfg.fromNumber);
        result = num.ok ? { ...acct, latencyMs: acct.latencyMs + num.latencyMs, message: `${acct.message} ${num.message}`, details: { ...acct.details, callerId: num.details } } : { ...num, latencyMs: acct.latencyMs + num.latencyMs, message: `Credentials work, but the caller ID failed: ${num.message}` };
        break;
      }
      case 'plivo:call':
        result = await this.testCall(actor, row, secrets, cfg, body);
        break;
      case 'sarvam:connection':
      case 'sarvam:tts': {
        const text = op === 'tts' && typeof body?.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 300) : SAMPLE_TEXT[cfg.ttsLanguage] ?? SAMPLE_TEXT['en-IN'];
        result = await clients.sarvamTts(this.fetchImpl, secrets.apiKey, { text, model: cfg.ttsModel, language: cfg.ttsLanguage, speaker: cfg.ttsSpeaker });
        const price = priceFromEnv('SARVAM_TTS_PRICE_PER_10K_CHARS');
        if (result.ok && price) cost = (text.length / 10_000) * price;
        break;
      }
      case 'sarvam:stt': {
        let audio: Buffer | null = null;
        if (typeof body?.audioBase64 === 'string' && body.audioBase64) {
          audio = Buffer.from(body.audioBase64, 'base64');
          if (audio.length > 2_000_000) throw new BadRequestException('Keep the test recording under 2 MB (about a minute).');
          if (audio.subarray(0, 4).toString('ascii') !== 'RIFF') throw new BadRequestException('Upload a WAV recording.');
        } else {
          // Round trip: speak the sample with the configured voice, then recognise it.
          const tts = await clients.sarvamTts(this.fetchImpl, secrets.apiKey, { text: SAMPLE_TEXT[cfg.ttsLanguage] ?? SAMPLE_TEXT['en-IN'], model: cfg.ttsModel, language: cfg.ttsLanguage, speaker: cfg.ttsSpeaker });
          if (!tts.ok || !tts.audioBase64) { result = { ...tts, message: `Could not create the test audio: ${tts.message}` }; break; }
          audio = Buffer.from(tts.audioBase64, 'base64');
        }
        result = await clients.sarvamStt(this.fetchImpl, secrets.apiKey, { audio, model: cfg.sttModel, mode: cfg.sttMode, language: cfg.sttLanguage });
        const price = priceFromEnv('SARVAM_STT_PRICE_PER_HOUR');
        if (result.ok && price && result.units) cost = (result.units / 3600) * price;
        break;
      }
      case 'openai:connection': {
        const m = await clients.openaiModel(this.fetchImpl, secrets.apiKey, cfg.model);
        if (!m.ok) { result = m; break; }
        const c = await clients.openaiChat(this.fetchImpl, secrets.apiKey, cfg.model);
        result = c.ok ? { ...c, latencyMs: m.latencyMs + c.latencyMs, message: `${m.message} ${c.message}` } : c;
        const pin = priceFromEnv('OPENAI_PRICE_INPUT_PER_1M');
        const pout = priceFromEnv('OPENAI_PRICE_OUTPUT_PER_1M');
        if (c.ok && pin && pout) cost = ((c.inputTokens ?? 0) * pin + (c.outputTokens ?? 0) * pout) / 1_000_000;
        break;
      }
      case 'whatsapp:connection': {
        const n = await clients.whatsappNumber(this.fetchImpl, { accessToken: secrets.accessToken }, cfg.phoneNumberId);
        if (!n.ok) { result = n; break; }
        const t = await clients.whatsappTemplates(this.fetchImpl, { accessToken: secrets.accessToken }, cfg.businessAccountId);
        result = t.ok
          ? { ...n, latencyMs: n.latencyMs + t.latencyMs, message: `${n.message} ${t.message}`, templates: t.templates }
          : { ...t, latencyMs: n.latencyMs + t.latencyMs, message: `The number works, but templates could not be read: ${t.message}` };
        break;
      }
      case 'sarvam_telephony:call':
        result = await this.testSarvamCall(actor, secrets, cfg, body);
        break;
      default:
        throw new BadRequestException('Unknown test.');
    }
    // A connection test decides whether the saved credentials may be enabled.
    const decides = op === 'connection' || (provider === 'sarvam' && op === 'tts') || (provider === 'sarvam_telephony' && op === 'call');
    if (decides) {
      await this.prisma.integrationCredential.update({
        where: { id: row.id },
        data: { status: result.ok ? 'ok' : 'failed', lastTestAt: new Date(), ...(result.ok ? { lastSuccessAt: new Date(), lastError: null } : { lastError: `${result.errorCode ?? 'error'}: ${result.message}`.slice(0, 1000) }) },
      });
      this.creds.invalidate(actor.org, provider);
    }
    if (op !== 'call' || provider === 'sarvam_telephony') await this.event(actor.org, provider, op === 'connection' ? 'test' : op, result, 'organization', cost);
    await this.audit(actor.org, who(actor), provider, 'integration.tested', { op, ok: result.ok, errorCode: result.errorCode ?? null });
    return { result: { ...result, costEstimate: cost }, integration: await this.get(actor.org, provider) };
  }

  /**
   * A REAL outbound test call from this organization's Plivo account. Gates, in order: an organization admin (checked
   * by the controller), an ACTIVE organization, explicit confirmation, DRY_RUN off, the destination on the approved
   * LIVE_TEST_RECIPIENTS list, a passed connection test. Nothing here can call an arbitrary number.
   */
  private async testCall(actor: Actor, row: { id: string; status: string }, secrets: Record<string, string>, cfg: Record<string, string>, body: Record<string, unknown>) {
    const org = await this.prisma.organization.findUnique({ where: { id: actor.org }, select: { status: true } });
    if (org?.status !== 'active') throw new ForbiddenException('Test calls are available once Tacksharp has activated this organization.');
    if (body?.confirm !== true) throw new BadRequestException('Confirm that a real phone call should be placed (it is charged by Plivo).');
    const live = followUpConfig();
    if (live.dryRun) throw new ForbiddenException('This server runs in dry-run mode (DRY_RUN=true): no real call is placed. An operator must switch it off for live tests.');
    const to = normalizePhone(String(body?.to ?? ''));
    if (!to || !live.liveTestRecipients.includes(to)) throw new ForbiddenException('Test calls go only to numbers on the approved test-recipient list (LIVE_TEST_RECIPIENTS).');
    if (row.status !== 'ok') throw new BadRequestException('Run a successful connection test first.');
    const ev = await this.prisma.integrationEvent.create({ data: { organizationId: actor.org, provider: 'plivo', kind: 'call', ok: false, message: 'Requested', source: 'organization' } });
    const base = config.publicBaseUrl;
    const q = `org=${encodeURIComponent(actor.org)}&ev=${encodeURIComponent(ev.id)}`;
    const r = await clients.plivoCall(this.fetchImpl, { authId: secrets.authId, authToken: secrets.authToken }, { from: cfg.fromNumber, to, answerUrl: `${base}/integrations/plivo/test-call/answer?${q}`, hangupUrl: `${base}/integrations/plivo/test-call/hangup?${q}` });
    await this.prisma.integrationEvent.update({ where: { id: ev.id }, data: { ok: r.ok, latencyMs: r.latencyMs, errorCode: r.errorCode ?? null, message: r.ok ? 'Call requested; waiting for the hangup report.' : r.message.slice(0, 500), units: r.units ?? null, unitType: r.unitType ?? null } });
    return { ...r, details: { ...(r.details ?? {}), eventId: ev.id, to: `••••${to.slice(-4)}` } };
  }

  /**
   * A REAL test call through Sarvam Voice Agents (proves the API key, ids, connection and caller number). Same gates as
   * the Plivo test call: an active organization, explicit confirmation, DRY_RUN off, an approved test recipient, and
   * the Sarvam agent (app) id to answer it.
   */
  private async testSarvamCall(actor: Actor, secrets: Record<string, string>, cfg: Record<string, string>, body: Record<string, unknown>) {
    const org = await this.prisma.organization.findUnique({ where: { id: actor.org }, select: { status: true } });
    if (org?.status !== 'active') throw new ForbiddenException('Test calls are available once Tacksharp has activated this organization.');
    if (body?.confirm !== true) throw new BadRequestException('Confirm that a real phone call should be placed (it is charged by Sarvam).');
    const live = followUpConfig();
    if (live.dryRun) throw new ForbiddenException('This server runs in dry-run mode (DRY_RUN=true): no real call is placed. An operator must switch it off for live tests.');
    const to = normalizePhone(String(body?.to ?? ''));
    if (!to || !live.liveTestRecipients.includes(to)) throw new ForbiddenException('Test calls go only to numbers on the approved test-recipient list (LIVE_TEST_RECIPIENTS).');
    const appId = typeof body?.appId === 'string' ? body.appId.trim() : '';
    const appVersion = Number(body?.appVersion ?? 1);
    if (!/^[\w-]{3,100}$/.test(appId) || !Number.isInteger(appVersion) || appVersion < 1) throw new BadRequestException('Give the Sarvam agent (app) id and version that should answer the test call.');
    return clients.sarvamOutboundCall(this.fetchImpl, { apiKey: secrets.apiKey, orgId: cfg.orgId, workspaceId: cfg.workspaceId, connectionId: cfg.connectionId, agentPhoneNumber: cfg.agentPhoneNumber }, { appId, appVersion, to });
  }

  /** Plivo hangup callback for a test call (signature already verified with THIS organization's token). */
  async recordTestCallHangup(org: string, eventId: string, body: Record<string, string>) {
    const ev = await this.prisma.integrationEvent.findFirst({ where: { id: eventId, organizationId: org, provider: 'plivo', kind: 'call' } });
    if (!ev) return;
    const answered = body.CallStatus === 'completed' && Number(body.BillDuration ?? body.Duration ?? 0) > 0;
    const cost = Number(body.TotalCost);
    await this.prisma.integrationEvent.update({
      where: { id: ev.id },
      data: { ok: answered, errorCode: answered ? null : (body.HangupCause ?? body.CallStatus ?? 'not_answered').slice(0, 60), message: `Call ${body.CallStatus ?? 'ended'} (${body.HangupCause ?? 'no cause given'}), ${body.Duration ?? 0} s.`.slice(0, 500), units: Number(body.BillDuration ?? 0) || null, unitType: 'seconds', costEstimate: Number.isFinite(cost) ? new Prisma.Decimal(cost.toFixed(4)) : null },
    });
  }

  /** Saved Plivo auth token of this organization (signature checks for its own callbacks), or null. */
  async plivoTokenOf(org: string): Promise<string | null> {
    const row = await this.creds.row(org, 'plivo');
    if (!row) return null;
    try {
      return this.creds.secretsOf(row).authToken ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------------ routing

  async numbers(org: string) {
    return this.prisma.organizationChannel.findMany({ where: { organizationId: org, kind: 'plivo_number' }, select: { externalId: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * Route calls to a Plivo number to this organization. Allowed only when the number is verified (live, read-only API
   * request) to be on THIS organization's own Plivo account, and no other organization already owns the mapping.
   */
  async mapPlivoNumber(actor: Actor, raw: unknown) {
    const number = normalizePhone(String(raw ?? ''));
    if (!number) throw new BadRequestException('Enter the number with country code.');
    const eff = await this.creds.resolve(actor.org, 'plivo');
    if (eff.source !== 'organization') throw new BadRequestException('Save, test and enable your own Plivo credentials first: a number can only be routed after Plivo confirms it is on your account.');
    const existing = await this.prisma.organizationChannel.findUnique({ where: { kind_externalId: { kind: 'plivo_number', externalId: number } } });
    if (existing && existing.organizationId !== actor.org) throw new ConflictException('This number is already routed to another organization. Contact Tacksharp support if it is yours.');
    if (existing) return { ok: true, numbers: await this.numbers(actor.org) };
    const check = await clients.plivoNumber(this.fetchImpl, { authId: eff.secrets.authId, authToken: eff.secrets.authToken }, number);
    await this.event(actor.org, 'plivo', 'config', check, 'organization');
    if (!check.ok) throw new BadRequestException(check.message);
    await this.prisma.organizationChannel.create({ data: { organizationId: actor.org, kind: 'plivo_number', externalId: number } });
    await this.audit(actor.org, who(actor), 'plivo', 'integration.number_mapped', { number: `••••${number.slice(-4)}` });
    return { ok: true, numbers: await this.numbers(actor.org) };
  }

  async unmapPlivoNumber(actor: Actor, raw: string) {
    const number = normalizePhone(raw);
    const row = number ? await this.prisma.organizationChannel.findUnique({ where: { kind_externalId: { kind: 'plivo_number', externalId: number } } }) : null;
    if (!row || row.organizationId !== actor.org) throw new NotFoundException('That number is not routed to this organization.');
    await this.prisma.organizationChannel.delete({ where: { id: row.id } });
    await this.audit(actor.org, who(actor), 'plivo', 'integration.number_unmapped', { number: `••••${number!.slice(-4)}` });
    return { ok: true, numbers: await this.numbers(actor.org) };
  }

  /** Route this organization's WhatsApp number (verified with its own token) to it. */
  async mapWhatsappNumber(actor: Actor) {
    const eff = await this.creds.resolve(actor.org, 'whatsapp');
    if (eff.source !== 'organization') throw new BadRequestException('Save, test and enable your own WhatsApp credentials first.');
    const id = eff.config.phoneNumberId;
    const existing = await this.prisma.organizationChannel.findUnique({ where: { kind_externalId: { kind: 'whatsapp_phone_number_id', externalId: id } } });
    if (existing && existing.organizationId !== actor.org) throw new ConflictException('This WhatsApp number is already routed to another organization. Contact Tacksharp support if it is yours.');
    if (!existing) {
      const check = await clients.whatsappNumber(this.fetchImpl, { accessToken: eff.secrets.accessToken }, id);
      if (!check.ok) throw new BadRequestException(check.message);
      await this.prisma.organizationChannel.create({ data: { organizationId: actor.org, kind: 'whatsapp_phone_number_id', externalId: id } });
      await this.audit(actor.org, who(actor), 'whatsapp', 'integration.number_mapped', { phoneNumberId: `••••${id.slice(-4)}` });
    }
    return this.get(actor.org, 'whatsapp');
  }

  // ------------------------------------------------------------------------------------------------ usage

  async usage(org: string, provider: Provider, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.integrationEvent.findMany({ where: { organizationId: org, provider, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 500 });
    const byKind: Record<string, { count: number; failed: number; units: number; cost: number }> = {};
    let cost = 0;
    let costKnown = false;
    for (const r of rows) {
      const k = (byKind[r.kind] ??= { count: 0, failed: 0, units: 0, cost: 0 });
      k.count++;
      if (!r.ok) k.failed++;
      k.units += r.units ?? 0;
      if (r.costEstimate !== null) { const c = Number(r.costEstimate); k.cost += c; cost += c; costKnown = true; }
    }
    return {
      days,
      total: rows.length,
      failed: rows.filter((r) => !r.ok).length,
      byKind,
      costEstimate: costKnown ? Number(cost.toFixed(4)) : null,
      costNote: costKnown ? 'Estimated from the prices configured on the server; the provider invoice is authoritative.' : 'No price configured on the server, so no cost estimate is shown.',
      recentErrors: rows.filter((r) => !r.ok).slice(0, 10).map((r) => ({ at: r.createdAt, kind: r.kind, code: r.errorCode, message: r.message })),
      recent: rows.slice(0, 15).map((r) => ({ at: r.createdAt, kind: r.kind, ok: r.ok, latencyMs: r.latencyMs, code: r.errorCode, message: r.message, units: r.units, unitType: r.unitType })),
    };
  }

  /** WhatsApp delivery as reported by Meta's receipts (accepted is NOT delivered). */
  async delivery(org: string, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const g = await this.prisma.message.groupBy({ by: ['deliveryStatus'], where: { organizationId: org, deliveryStatus: { not: null }, createdAt: { gte: since } }, _count: { _all: true } });
    const counts = Object.fromEntries(g.map((x) => [x.deliveryStatus ?? 'unknown', x._count._all]));
    return { days, counts, note: '"accepted" means Meta took the request; only delivery receipts mark a message delivered or read.' };
  }
}
