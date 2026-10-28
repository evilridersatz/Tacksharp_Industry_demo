import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';
import { config } from '../common/config.js';
import { followUpConfig } from '../restaurant/followup-config.js';

export type DemoChannel = 'whatsapp' | 'voice';
type Actor = { sub: string };
export type RouteResult = { organizationId: string; sessionId: string; industry: string } | { unrouted: true } | null;
type Probe = { status: 'connected' | 'not_configured' | 'auth_failed' | 'provider_unavailable' | 'not_checked'; detail?: string; checkedAt?: string };

const HOURS = () => Math.min(24, Math.max(1, Number(process.env.DEMO_SESSION_HOURS ?? 4) || 4));
const mask = (p: string) => (p.length > 4 ? `${'•'.repeat(Math.max(0, p.length - 4))}${p.slice(-4)}` : p);

/**
 * Shared-number live demos.
 *
 * One WhatsApp business number and one Plivo number serve every industry workspace. Normally the number's owner
 * organization answers everything that reaches it (TenancyService). A demo session binds ONE approved test phone to
 * ONE industry workspace for a limited time, so that tester's inbound WhatsApp messages and calls reach that
 * workspace's AI agent and are stored there. Rules:
 *  - created explicitly by an admin/manager in the workspace being demonstrated (never from the dashboard's current
 *    selection at message time; switching workspace later does not move an existing session);
 *  - only for phones on the approved test-recipient list (LIVE_TEST_RECIPIENTS): a real customer is never bound;
 *  - one active session per phone: starting a new one ends the previous one (recorded), so routing is deterministic;
 *  - applies only to messages / calls that reach the shared number's owner (hubOrganizationId), so a tester who
 *    writes to some other business's number is unaffected;
 *  - expires (DEMO_SESSION_HOURS, default 4h); conversations and calls already stored keep their workspace.
 *  - DEMO_SHARED_NUMBER_STRICT=true: a sender with no active session gets no AI reply at all (nothing is guessed).
 * Sending still goes through the normal live gate (DRY_RUN, approved recipients, consent).
 */
@Injectable()
export class DemoSessionsService {
  private probes = new Map<string, { at: number; v: Probe }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  private async audit(org: string, actor: string, entityId: string, action: string, data: unknown) {
    await this.prisma.auditEvent.create({ data: { organizationId: org, actor, entityType: 'demo_session', entityId, action, data: data as never } }).catch(() => undefined);
  }

  approvedRecipients(): string[] {
    return followUpConfig().liveTestRecipients;
  }

  /** Who owns the shared numbers (the organization their inbound traffic reaches without a session). */
  async hubs() {
    const wa = config.whatsapp.phoneNumberId ? await this.tenancy.resolve('whatsapp_phone_number_id', config.whatsapp.phoneNumberId) : undefined;
    const voice = config.plivo.fromNumber ? await this.tenancy.resolve('plivo_number', normalizePhone(config.plivo.fromNumber) ?? config.plivo.fromNumber) : undefined;
    return { whatsapp: wa ?? config.defaultOrganizationId, voice: voice ?? config.defaultOrganizationId };
  }

  private async industryOf(org: string) {
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { vertical: true } });
    if (!o) throw new NotFoundException('Workspace not found');
    const industry = this.settings ? (await this.settings.get(org).catch(() => null))?.industry : undefined;
    return { vertical: o.vertical, industry: o.vertical === 'restaurant' ? 'restaurant' : String(industry ?? 'real_estate') };
  }

  async start(org: string, actor: Actor, body: { phone?: unknown; channels?: unknown; confirm?: unknown; name?: unknown }) {
    if (body?.confirm !== true) throw new BadRequestException('Confirm that this phone belongs to an approved tester who agreed to receive demo messages and calls (confirm: true).');
    const phone = normalizePhone(typeof body.phone === 'string' ? body.phone : '');
    if (!phone) throw new BadRequestException('Enter a valid phone number.');
    if (!this.approvedRecipients().includes(phone)) throw new BadRequestException('This number is not on the approved test-recipient list (LIVE_TEST_RECIPIENTS). Only approved testers can be bound to a demo.');
    const list = Array.isArray(body.channels) ? body.channels : ['whatsapp', 'voice'];
    const channels = [...new Set(list.filter((c): c is DemoChannel => c === 'whatsapp' || c === 'voice'))];
    if (!channels.length) throw new BadRequestException('Choose WhatsApp, voice or both.');
    const { industry } = await this.industryOf(org);
    const hubs = await this.hubs();
    // Both channels must share one hub for a single binding; record the WhatsApp hub (voice checked at routing too).
    const hubOrganizationId = channels.includes('whatsapp') ? hubs.whatsapp : hubs.voice;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'Demo tester';

    // The tester as a REAL (non-demo) contact of this workspace, consent recorded as an approved tester.
    const existing = await this.prisma.customer.findFirst({ where: { organizationId: org, phone } });
    if (existing && existing.isDemo && existing.source !== 'demo_session') throw new ConflictException('This number belongs to a synthetic demo record in this workspace; use a different test number.');
    const customer = existing
      ? await this.prisma.customer.update({ where: { id: existing.id }, data: { isDemo: false, optedOutAt: null, doNotContact: false, messagingConsent: channels.includes('whatsapp') || existing.messagingConsent, callingConsent: channels.includes('voice') || existing.callingConsent } })
      : await this.prisma.customer.create({ data: { organizationId: org, phone, name, isDemo: false, source: 'demo_session', messagingConsent: channels.includes('whatsapp'), callingConsent: channels.includes('voice') } });

    const expiresAt = new Date(Date.now() + HOURS() * 3_600_000);
    const session = await this.prisma.$transaction(async (tx) => {
      const prior = await tx.demoSession.findMany({ where: { phone, status: 'active' } });
      if (prior.length) await tx.demoSession.updateMany({ where: { id: { in: prior.map((p) => p.id) } }, data: { status: 'ended', endedAt: new Date(), endedReason: `replaced by a new session in ${org}` } });
      return { created: await tx.demoSession.create({ data: { organizationId: org, industry, hubOrganizationId, phone, channels: channels.join(','), customerId: customer.id, createdBy: `user:${actor.sub}`, expiresAt } }), replaced: prior };
    });
    for (const p of session.replaced) await this.audit(p.organizationId, `user:${actor.sub}`, p.id, 'ended', { reason: 'replaced', by: session.created.id });
    await this.audit(org, `user:${actor.sub}`, session.created.id, 'started', { phone: mask(phone), channels, industry, hubOrganizationId, expiresAt, consentSource: 'approved_test_recipient' });
    log.info('demo_session.started', { org, sessionId: session.created.id, industry, channels: channels.join(','), phone: mask(phone) });
    return { ...this.view(session.created), customerId: customer.id, replaced: session.replaced.map((p) => ({ id: p.id, organizationId: p.organizationId })) };
  }

  async end(org: string, actor: Actor, id: string) {
    const s = await this.prisma.demoSession.findFirst({ where: { id, organizationId: org } });
    if (!s) throw new NotFoundException('Demo session not found');
    if (s.status !== 'active') return this.view(s);
    const done = await this.prisma.demoSession.update({ where: { id }, data: { status: 'ended', endedAt: new Date(), endedReason: 'ended by user' } });
    await this.audit(org, `user:${actor.sub}`, id, 'ended', { reason: 'ended by user' });
    return this.view(done);
  }

  async list(org: string) {
    await this.expireOld();
    const rows = await this.prisma.demoSession.findMany({ where: { organizationId: org }, orderBy: { createdAt: 'desc' }, take: 20 });
    return rows.map((r) => this.view(r));
  }

  private view(s: { id: string; organizationId: string; industry: string; phone: string; channels: string; customerId: string; status: string; endedReason: string | null; expiresAt: Date; lastActivityAt: Date | null; createdAt: Date; endedAt: Date | null; createdBy: string }) {
    const active = s.status === 'active' && s.expiresAt > new Date();
    return { id: s.id, organizationId: s.organizationId, industry: s.industry, phone: mask(s.phone), channels: s.channels.split(','), customerId: s.customerId, status: active ? 'active' : 'ended', endedReason: s.status === 'active' && !active ? 'expired' : s.endedReason, expiresAt: s.expiresAt, lastActivityAt: s.lastActivityAt, createdAt: s.createdAt, endedAt: s.endedAt, createdBy: s.createdBy };
  }

  private async expireOld() {
    await this.prisma.demoSession.updateMany({ where: { status: 'active', expiresAt: { lte: new Date() } }, data: { status: 'ended', endedAt: new Date(), endedReason: 'expired' } }).catch(() => undefined);
  }

  /**
   * Inbound routing for the shared number. `hubOrganizationId` is the organization the receiving number belongs to
   * (from the signed webhook's business number / the dialled Plivo number); `phone` is the sender.
   * Returns the bound workspace, `{unrouted}` (strict mode, no session: do not answer), or null (normal routing).
   */
  async routeInbound(channel: DemoChannel, hubOrganizationId: string, rawPhone: string | null | undefined): Promise<RouteResult> {
    const phone = normalizePhone(rawPhone ?? '');
    if (!phone) return null;
    let s;
    try {
      s = await this.prisma.demoSession.findFirst({ where: { phone, status: 'active', hubOrganizationId, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    } catch (error) {
      // Routing data unavailable: never guess an industry. Strict mode drops the message; otherwise the owner answers.
      log.error('demo_session.lookup_failed', { error: errorMessage(error) });
      return process.env.DEMO_SHARED_NUMBER_STRICT === 'true' ? { unrouted: true } : null;
    }
    if (s && s.channels.split(',').includes(channel)) {
      await this.prisma.demoSession.update({ where: { id: s.id }, data: { lastActivityAt: new Date() } }).catch(() => undefined);
      log.info('demo_session.routed', { channel, sessionId: s.id, org: s.organizationId, industry: s.industry });
      return { organizationId: s.organizationId, sessionId: s.id, industry: s.industry };
    }
    if (process.env.DEMO_SHARED_NUMBER_STRICT === 'true') {
      log.warn('demo_session.unrouted', { channel, phone: mask(phone), reason: s ? `session does not include ${channel}` : 'no active session' });
      return { unrouted: true };
    }
    return null;
  }

  /** Workspaces a delivery receipt for this recipient may belong to (owner + an active demo binding). */
  async receiptOrgs(hubOrganizationId: string, recipient: string | null | undefined): Promise<string[]> {
    const phone = normalizePhone(recipient ?? '');
    const orgs = new Set([hubOrganizationId]);
    if (phone) {
      const rows = await this.prisma.demoSession.findMany({ where: { phone, hubOrganizationId, createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } }, select: { organizationId: true } }).catch(() => []);
      for (const r of rows) orgs.add(r.organizationId);
    }
    return [...orgs];
  }

  /**
   * Integration status. "configured" means credentials are present; a probe (read-only provider request: no message
   * is sent, no call placed) is run only when asked and cached for a minute.
   */
  async status(org: string, probe: boolean) {
    const cfg = followUpConfig();
    const hubs = await this.hubs();
    const { industry } = await this.industryOf(org);
    const wa = config.whatsapp.accessToken && config.whatsapp.phoneNumberId;
    const pv = config.plivo.authId && config.plivo.authToken && config.plivo.fromNumber;
    const whatsapp: Probe = !wa ? { status: 'not_configured' } : probe ? await this.cached('wa', () => this.probeWhatsApp()) : this.probes.get('wa')?.v ?? { status: 'not_checked' };
    const voice: Probe = !pv ? { status: 'not_configured' } : probe ? await this.cached('pv', () => this.probePlivo()) : this.probes.get('pv')?.v ?? { status: 'not_checked' };
    return {
      workspace: { organizationId: org, industry },
      mode: cfg.dryRun ? 'demo_simulated' : 'live',
      dryRun: cfg.dryRun,
      strictRouting: process.env.DEMO_SHARED_NUMBER_STRICT === 'true',
      sessionHours: HOURS(),
      whatsapp: { ...whatsapp, number: config.whatsapp.phoneNumberId ? mask(config.whatsapp.phoneNumberId) : null, ownerOrganizationId: hubs.whatsapp, templateConfigured: Boolean(config.whatsapp.templateName) },
      voice: { ...voice, number: config.plivo.fromNumber ? mask(normalizePhone(config.plivo.fromNumber) ?? config.plivo.fromNumber) : null, ownerOrganizationId: hubs.voice },
      approvedRecipients: this.approvedRecipients().map((p) => ({ value: p, label: mask(p) })),
    };
  }

  private async cached(key: string, run: () => Promise<Probe>) {
    const hit = this.probes.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.v;
    const v = await run();
    this.probes.set(key, { at: Date.now(), v });
    return v;
  }

  private async probeWhatsApp(): Promise<Probe> {
    const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}?fields=verified_name,quality_rating`;
    return this.probe(url, { authorization: `Bearer ${config.whatsapp.accessToken}` }, (j) => [j.verified_name, j.quality_rating && `quality ${j.quality_rating}`].filter(Boolean).join(' · '));
  }

  private async probePlivo(): Promise<Probe> {
    const url = `https://api.plivo.com/v1/Account/${config.plivo.authId}/`;
    const auth = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString('base64');
    return this.probe(url, { authorization: `Basic ${auth}` }, (j) => [j.account_type, j.cash_credits !== undefined && 'credits available'].filter(Boolean).join(' · '));
  }

  private async probe(url: string, headers: Record<string, string>, describe: (j: Record<string, unknown>) => string): Promise<Probe> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      if (res.status === 401 || res.status === 403) return { status: 'auth_failed', detail: `HTTP ${res.status}`, checkedAt };
      if (!res.ok) return { status: 'provider_unavailable', detail: `HTTP ${res.status}`, checkedAt };
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: 'connected', detail: describe(j) || undefined, checkedAt };
    } catch (error) {
      return { status: 'provider_unavailable', detail: errorMessage(error).slice(0, 120), checkedAt };
    }
  }
}
