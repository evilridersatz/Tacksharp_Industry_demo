import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { invalidateAccess, invalidateOrganization } from '../auth/auth.guard.js';
import { TeamService } from '../team/team.service.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../settings/tenant-settings.js';
import { INDUSTRY_LABEL, SETTABLE_INDUSTRIES, effectiveIndustry } from '../industry/industries.js';
import { PROVIDERS } from '../integrations/providers.js';
import { webhookFailures } from '../common/webhook-failures.js';
import { latencyByChannel } from '../common/latency.js';
import { agentQueue, followUpQueue, marketingQueue, orderFollowUpQueue, queueRedis, whatsappQueue } from '../queues/queues.js';
import { log } from '../common/logger.js';

type Actor = { sub: string };
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
type AnyQueue = { getFailed(start: number, end: number): Promise<Array<{ id?: string; name: string; failedReason?: string; attemptsMade: number; finishedOn?: number; data: unknown }>>; getJobCounts(...types: string[]): Promise<Record<string, number>> };
const QUEUES: Record<string, AnyQueue> = { whatsapp: whatsappQueue as unknown as AnyQueue, followUp: followUpQueue as unknown as AnyQueue, orderFollowUp: orderFollowUpQueue as unknown as AnyQueue, agent: agentQueue as unknown as AnyQueue, marketing: marketingQueue as unknown as AnyQueue };

/**
 * Tacksharp platform administration (staff only; every route checks User.isPlatformAdmin in the database).
 * Platform admins see status, never customer secrets: integrations show configured / tested / enabled only.
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly team: TeamService,
  ) {}

  /** Throws unless the user is a platform admin right now (database, not the session token). */
  async requireAdmin(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true, disabledAt: true } });
    if (!u?.isPlatformAdmin || u.disabledAt) throw new ForbiddenException('Platform administration is restricted to Tacksharp staff.');
  }

  private audit(org: string, actor: Actor, entityType: string, entityId: string, action: string, data: Record<string, unknown> = {}) {
    return this.prisma.auditEvent.create({ data: { organizationId: org, actor: `platform:${actor.sub}`, entityType, entityId, action, data: data as Prisma.InputJsonValue } });
  }

  private async industries(ids: string[]) {
    const rows = await this.prisma.organizationSettings.findMany({ where: { organizationId: { in: ids } }, select: { organizationId: true, data: true } });
    return new Map(rows.map((r) => [r.organizationId, sanitizeSettings(r.data, DEFAULT_SETTINGS).industry]));
  }

  /** Onboarding steps, computed from records (never stored as "done" by a click). */
  private async onboarding(orgId: string) {
    const [users, creds, channels, customers, invitations, status] = await Promise.all([
      this.prisma.user.count({ where: { organizationId: orgId, disabledAt: null } }),
      this.prisma.integrationCredential.findMany({ where: { organizationId: orgId }, select: { provider: true, status: true, enabled: true } }),
      this.prisma.organizationChannel.count({ where: { organizationId: orgId } }),
      this.prisma.customer.count({ where: { organizationId: orgId } }),
      this.prisma.userInvitation.count({ where: { organizationId: orgId } }),
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { status: true } }),
    ]);
    const steps = [
      { key: 'account', label: 'Organization and admin created', done: users > 0 },
      { key: 'activated', label: 'Activated by Tacksharp', done: status?.status === 'active' },
      { key: 'integration_tested', label: 'A provider connection test passed', done: creds.some((c) => c.status === 'ok') },
      { key: 'integration_enabled', label: 'A provider integration enabled', done: creds.some((c) => c.enabled) },
      { key: 'number_routed', label: 'A WhatsApp or phone number routed', done: channels > 0 },
      { key: 'first_customer', label: 'First customer record', done: customers > 0 },
      { key: 'team_invited', label: 'Team member invited', done: invitations > 0 || users > 1 },
    ];
    return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
  }

  async overview() {
    const [byStatus, pending, users, creds, events24, failed24] = await Promise.all([
      this.prisma.organization.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.organization.count({ where: { status: 'pending_review' } }),
      this.prisma.user.count({ where: { disabledAt: null } }),
      this.prisma.integrationCredential.groupBy({ by: ['provider', 'status'], _count: { _all: true } }),
      this.prisma.integrationEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
      this.prisma.integrationEvent.count({ where: { ok: false, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    ]);
    return {
      organizations: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
      pendingRegistrations: pending,
      activeUsers: users,
      integrations: creds.map((c) => ({ provider: c.provider, status: c.status, count: c._count._all })),
      providerEvents24h: { total: events24, failed: failed24 },
      health: await this.health(),
    };
  }

  async organizations(q: { search?: string; status?: string; page?: string }) {
    const page = Math.max(1, Number(q.page) || 1);
    const take = 25;
    const where: Prisma.OrganizationWhereInput = {};
    if (q.status && ['active', 'pending_review', 'suspended'].includes(q.status)) where.status = q.status;
    const s = (q.search ?? '').trim().slice(0, 80);
    if (s) where.OR = [{ name: { contains: s } }, { id: { contains: s } }, { users: { some: { email: { contains: s.toLowerCase() } } } }];
    const [total, rows] = await Promise.all([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * take, take, select: { id: true, name: true, status: true, selfServe: true, isDemo: true, vertical: true, createdAt: true, activatedAt: true, suspendedAt: true, _count: { select: { users: true, customers: true } } } }),
    ]);
    const ind = await this.industries(rows.map((r) => r.id));
    return {
      total, page, pageSize: take,
      rows: rows.map((r) => {
        const industry = effectiveIndustry(r.vertical, ind.get(r.id));
        return { id: r.id, name: r.name, status: r.status, selfServe: r.selfServe, isDemo: r.isDemo, industry, industryLabel: INDUSTRY_LABEL[industry], users: r._count.users, customers: r._count.customers, createdAt: r.createdAt, activatedAt: r.activatedAt, suspendedAt: r.suspendedAt };
      }),
    };
  }

  async organization(id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id }, select: { id: true, name: true, status: true, selfServe: true, isDemo: true, vertical: true, contactPhone: true, createdAt: true, activatedAt: true, suspendedAt: true, suspendedReason: true, allowedIndustries: true } });
    if (!org) throw new NotFoundException('Organization not found');
    const [users, members, creds, channels, audit, resets, usage] = await Promise.all([
      this.prisma.user.findMany({ where: { organizationId: id }, select: { id: true, email: true, name: true, role: true, lastLoginAt: true, disabledAt: true, createdAt: true, isPlatformAdmin: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.organizationMembership.findMany({ where: { organizationId: id }, select: { role: true, user: { select: { id: true, email: true, organizationId: true } } } }),
      this.prisma.integrationCredential.findMany({ where: { organizationId: id }, select: { provider: true, enabled: true, status: true, lastTestAt: true, lastSuccessAt: true, updatedAt: true } }),
      this.prisma.organizationChannel.findMany({ where: { organizationId: id }, select: { kind: true, externalId: true } }),
      this.prisma.auditEvent.findMany({ where: { organizationId: id }, orderBy: { createdAt: 'desc' }, take: 40, select: { id: true, actor: true, entityType: true, entityId: true, action: true, createdAt: true } }),
      this.prisma.auditEvent.findMany({ where: { organizationId: id, action: 'password.reset_requested', createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, select: { entityId: true, createdAt: true } }),
      this.prisma.integrationEvent.groupBy({ by: ['provider', 'ok'], where: { organizationId: id, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: { _all: true }, _sum: { units: true, costEstimate: true } }),
    ]);
    const industry = effectiveIndustry(org.vertical, (await this.industries([id])).get(id));
    return {
      ...org,
      industry,
      industryLabel: INDUSTRY_LABEL[industry],
      settableIndustries: SETTABLE_INDUSTRIES.map((i) => ({ id: i, label: INDUSTRY_LABEL[i] })),
      users: users.map((u) => ({ ...u, access: 'home', resetRequested: resets.some((r) => r.entityId === u.id) })),
      guests: members.filter((m) => m.user.organizationId !== id).map((m) => ({ id: m.user.id, email: m.user.email, role: m.role })),
      // Status only. Platform admins never see customer secrets (not even masked hints).
      integrations: PROVIDERS.map((p) => {
        const c = creds.find((x) => x.provider === p);
        return { provider: p, saved: Boolean(c), enabled: c?.enabled ?? false, status: c?.status ?? 'not_configured', lastTestAt: c?.lastTestAt ?? null, lastSuccessAt: c?.lastSuccessAt ?? null };
      }),
      channels: channels.map((c) => ({ kind: c.kind, id: `••••${c.externalId.slice(-4)}` })),
      usage: usage.map((u) => ({ provider: u.provider, ok: u.ok, count: u._count._all, units: u._sum.units ?? 0, costEstimate: u._sum.costEstimate === null ? null : Number(u._sum.costEstimate) })),
      audit,
      onboarding: await this.onboarding(id),
    };
  }

  /** High-impact actions require the organization's exact name typed back (the console asks for it). */
  private async confirmed(id: string, confirmName: unknown) {
    const org = await this.prisma.organization.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
    if (!org) throw new NotFoundException('Organization not found');
    if (typeof confirmName !== 'string' || confirmName.trim() !== org.name) throw new BadRequestException('Type the organization name exactly to confirm.');
    return org;
  }

  async activate(actor: Actor, id: string, body: { confirmName?: unknown }) {
    const org = await this.confirmed(id, body?.confirmName);
    if (org.status === 'active') return this.organization(id);
    await this.prisma.$transaction([
      this.prisma.organization.update({ where: { id }, data: { status: 'active', activatedAt: new Date(), suspendedAt: null, suspendedReason: null } }),
      // Activation is the verification step for self-service signups (no email provider): mark their admins verified.
      this.prisma.user.updateMany({ where: { organizationId: id, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } }),
    ]);
    invalidateOrganization(id);
    await this.audit(id, actor, 'organization', id, 'organization.activated', { from: org.status });
    log.info('platform.organization_activated', { organizationId: id, by: actor.sub });
    return this.organization(id);
  }

  async suspend(actor: Actor, id: string, body: { confirmName?: unknown; reason?: unknown }) {
    const org = await this.confirmed(id, body?.confirmName);
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 180) : '';
    if (reason.length < 3) throw new BadRequestException('Give a reason for the suspension (it is recorded in the audit log).');
    const me = await this.prisma.user.findUnique({ where: { id: actor.sub }, select: { organizationId: true } });
    if (me?.organizationId === id) throw new ForbiddenException('You cannot suspend your own organization.');
    await this.prisma.organization.update({ where: { id }, data: { status: 'suspended', suspendedAt: new Date(), suspendedReason: reason } });
    invalidateOrganization(id);
    await this.audit(id, actor, 'organization', id, 'organization.suspended', { from: org.status, reason });
    log.warn('platform.organization_suspended', { organizationId: id, by: actor.sub });
    return this.organization(id);
  }

  async setIndustries(actor: Actor, id: string, body: { allowed?: unknown }) {
    const org = await this.prisma.organization.findUnique({ where: { id }, select: { id: true, vertical: true } });
    if (!org) throw new NotFoundException('Organization not found');
    let allowed: string[] | null = null;
    if (body?.allowed !== null) {
      if (!Array.isArray(body?.allowed) || !body.allowed.length) throw new BadRequestException('Send a list of industries, or null for all.');
      allowed = [...new Set(body.allowed.map(String))];
      const bad = allowed.filter((a) => !(SETTABLE_INDUSTRIES as readonly string[]).includes(a));
      if (bad.length) throw new BadRequestException(`Unknown industries: ${bad.join(', ')}`);
    }
    await this.prisma.organization.update({ where: { id }, data: { allowedIndustries: allowed === null ? Prisma.DbNull : allowed } });
    await this.audit(id, actor, 'organization', id, 'organization.industries_set', { allowed });
    return this.organization(id);
  }

  /** Disable / re-enable a user of this organization (sessions end at once when disabled). */
  async setUserDisabled(actor: Actor, orgId: string, userId: string, disabled: boolean) {
    const u = await this.prisma.user.findFirst({ where: { id: userId, organizationId: orgId }, select: { id: true, email: true, isPlatformAdmin: true } });
    if (!u) throw new NotFoundException('User not found in this organization');
    if (u.id === actor.sub) throw new ForbiddenException('You cannot disable yourself.');
    await this.prisma.user.update({ where: { id: userId }, data: disabled ? { disabledAt: new Date(), sessionsRevokedAt: new Date() } : { disabledAt: null } });
    invalidateAccess(userId);
    await this.audit(orgId, actor, 'user', userId, disabled ? 'platform.user_disabled' : 'platform.user_enabled', { email: u.email });
    return this.organization(orgId);
  }

  /** One-time password-reset link for a home user of this organization (shown once, to the platform admin). */
  async resetLink(actor: Actor, orgId: string, userId: string) {
    const link = await this.team.resetLink({ sub: actor.sub, org: orgId }, userId);
    await this.audit(orgId, actor, 'user', userId, 'platform.reset_link_created');
    return link;
  }

  /** Invite an (additional) admin or user for an organization, e.g. when its only admin left. */
  async invite(actor: Actor, orgId: string, body: { email?: unknown; role?: unknown }) {
    if (!(await this.prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } }))) throw new NotFoundException('Organization not found');
    const link = await this.team.invite({ sub: actor.sub, org: orgId }, body ?? {});
    await this.audit(orgId, actor, 'invitation', link.id, 'platform.invitation_created', { role: link.role });
    return link;
  }

  async auditEvents(q: { organizationId?: string; action?: string; page?: string }) {
    const page = Math.max(1, Number(q.page) || 1);
    const where: Prisma.AuditEventWhereInput = {};
    if (q.organizationId) where.organizationId = q.organizationId;
    if (q.action) where.action = { contains: q.action.slice(0, 60) };
    const [total, rows] = await Promise.all([
      this.prisma.auditEvent.count({ where }),
      this.prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50, select: { id: true, organizationId: true, actor: true, entityType: true, entityId: true, action: true, createdAt: true, organization: { select: { name: true } } } }),
    ]);
    return { total, page, pageSize: 50, rows: rows.map((r) => ({ ...r, organizationName: r.organization.name, organization: undefined })) };
  }

  async usage(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const g = await this.prisma.integrationEvent.groupBy({ by: ['organizationId', 'provider', 'source'], where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { units: true, costEstimate: true } });
    const failed = await this.prisma.integrationEvent.groupBy({ by: ['organizationId', 'provider'], where: { createdAt: { gte: since }, ok: false }, _count: { _all: true } });
    const names = new Map((await this.prisma.organization.findMany({ where: { id: { in: [...new Set(g.map((x) => x.organizationId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    return {
      days,
      note: 'Usage recorded by this platform (tests, model turns, test calls). Cost is an estimate from server-configured prices; provider invoices are authoritative.',
      rows: g.map((x) => ({ organizationId: x.organizationId, organizationName: names.get(x.organizationId) ?? x.organizationId, provider: x.provider, source: x.source, events: x._count._all, failed: failed.find((f) => f.organizationId === x.organizationId && f.provider === x.provider)?._count._all ?? 0, units: x._sum.units ?? 0, costEstimate: x._sum.costEstimate === null ? null : Number(x._sum.costEstimate) })),
    };
  }

  /** Failed background jobs (BullMQ) and failed inbound messages. Job payloads are summarised, never dumped. */
  async failures() {
    const jobs: Array<{ queue: string; id: string | undefined; name: string; failedReason: string; attemptsMade: number; finishedOn: number | undefined; organizationId?: string }> = [];
    let queueError: string | null = null;
    try {
      for (const [name, q] of Object.entries(QUEUES)) {
        const failed = await withTimeout(q.getFailed(0, 19), 3000);
        for (const j of failed) jobs.push({ queue: name, id: j.id, name: j.name, failedReason: String(j.failedReason ?? '').replace(/\d{10,}/g, '••••').slice(0, 240), attemptsMade: j.attemptsMade, finishedOn: j.finishedOn, organizationId: (j.data as { organizationId?: string })?.organizationId });
      }
    } catch (e) {
      queueError = e instanceof Error ? e.message : 'unavailable';
    }
    const inbound = await this.prisma.inboundMessage.findMany({ where: { status: { in: ['failed', 'reply_unknown'] } }, orderBy: { updatedAt: 'desc' }, take: 30, select: { id: true, organizationId: true, channel: true, status: true, attempts: true, lastError: true, updatedAt: true } });
    return { jobs: jobs.sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0)).slice(0, 60), queueError, inbound, webhooks: webhookFailures() };
  }

  async health() {
    const t0 = Date.now();
    const check = async (fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await withTimeout(fn(), 3000);
        return { ok: true, ms: Date.now() - t };
      } catch (e) {
        return { ok: false, ms: Date.now() - t, error: e instanceof Error ? e.message.slice(0, 120) : 'error' };
      }
    };
    const [database, redis] = await Promise.all([check(() => this.prisma.$queryRaw`SELECT 1`), check(() => queueRedis.ping())]);
    const queues: Record<string, unknown> = {};
    if (redis.ok) {
      for (const [name, q] of Object.entries(QUEUES)) {
        try {
          queues[name] = await withTimeout(q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'), 3000);
        } catch {
          queues[name] = { error: 'unavailable' };
        }
      }
    }
    const since = new Date(Date.now() - 3_600_000);
    const providerHealth = await this.prisma.integrationEvent.groupBy({ by: ['provider', 'ok'], where: { createdAt: { gte: since } }, _count: { _all: true }, _avg: { latencyMs: true } });
    const mem = process.memoryUsage();
    return {
      checkedAt: new Date().toISOString(),
      ms: Date.now() - t0,
      release: { id: process.env.RELEASE_ID ?? null, node: process.version, uptimeSec: Math.round(process.uptime()), dryRun: process.env.DRY_RUN !== 'false' },
      api: { ok: true, memoryMb: Math.round(mem.rss / 1_048_576) },
      database,
      redis,
      queues,
      storage: await this.storage(),
      // Per-stage response times (p50 / p95) for the last 500 voice turns and WhatsApp replies of THIS API process.
      responseTimes: latencyByChannel(),
      providersLastHour: providerHealth.map((p) => ({ provider: p.provider, ok: p.ok, count: p._count._all, avgLatencyMs: p._avg.latencyMs === null ? null : Math.round(p._avg.latencyMs) })),
    };
  }

  /** Free space where call audio is written (the only local storage the API uses). */
  private async storage() {
    try {
      const { statfs } = await import('node:fs/promises');
      const { config } = await import('../common/config.js');
      const s = await statfs(config.voice.audioDir).catch(() => statfs('.'));
      const freeGb = (s.bavail * s.bsize) / 1e9;
      const totalGb = (s.blocks * s.bsize) / 1e9;
      return { ok: freeGb > 1, freeGb: Number(freeGb.toFixed(1)), totalGb: Number(totalGb.toFixed(1)) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message.slice(0, 80) : 'unavailable' };
    }
  }
}
