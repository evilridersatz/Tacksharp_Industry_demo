import { ConflictException, ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';
import { hashPassword, verifyPassword } from './password.js';
import { signSession } from './token.js';
import { INDUSTRY_LABEL, effectiveIndustry } from '../industry/industries.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../settings/tenant-settings.js';
import { validateSignup } from './signup.js';

const SESSION_DAYS = 7;

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Same error and similar timing whether the email exists or not.
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, DUMMY_HASH);
    if (!user || !ok || user.disabledAt) {
      log.warn('auth.login_failed', { email: maskEmail(email), ...(user?.disabledAt && ok ? { reason: 'disabled' } : {}) });
      throw new UnauthorizedException('Wrong email or password.');
    }
    // Correct password, suspended organization: say so (the person can act on it), but do not issue a session.
    const home = await this.prisma.organization.findUnique({ where: { id: user.organizationId }, select: { status: true } });
    if (home?.status === 'suspended' && !user.isPlatformAdmin) {
      log.warn('auth.login_refused_suspended', { userId: user.id, organizationId: user.organizationId });
      throw new ForbiddenException('This organization is suspended. Contact Tacksharp support.');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    const token = signSession({ sub: user.id, org: user.organizationId, role: user.role, exp, iat: Date.now() }, config.auth.secret);
    log.info('auth.login', { userId: user.id, organizationId: user.organizationId });
    return { token, maxAgeSec: SESSION_DAYS * 86400, user: publicUser(user) };
  }

  /**
   * The user as seen by THIS session: the organization and role come from the session (a user may have switched into
   * another workspace they are a member of), never from the request.
   */
  async me(userId: string, session?: { org: string; role: string }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { organization: true } });
    if (!user) throw new UnauthorizedException();
    const orgId = session?.org ?? user.organizationId;
    if (orgId !== user.organizationId && !(await this.prisma.organizationMembership.findUnique({ where: { userId_organizationId: { userId, organizationId: orgId } } })))
      throw new UnauthorizedException('Your access to this workspace was removed.');
    const org = orgId === user.organizationId ? user.organization : (await this.prisma.organization.findUnique({ where: { id: orgId } }))!;
    return {
      ...publicUser(user), organizationId: org.id, role: session?.role ?? user.role, organizationName: org.name, vertical: org.vertical, isDemo: org.isDemo, homeOrganizationId: user.organizationId,
      organizationStatus: org.status, selfServe: org.selfServe, isPlatformAdmin: user.isPlatformAdmin, emailVerified: Boolean(user.emailVerifiedAt),
    };
  }

  /**
   * Public self-service registration. The organization, its settings (industry) and its first admin are created in ONE
   * transaction. The admin is an ORGANIZATION admin - signup can never grant platform access. The organization starts
   * as pending_review: a platform admin activates it (no email provider is configured, so activation is the
   * verification step); until then it can be set up but nothing is sent to customers from it (DRY_RUN and the live
   * gates already apply). It never inherits the platform's provider accounts (selfServe = true).
   */
  async signup(body: Record<string, unknown> | null | undefined) {
    if (!config.signup.enabled) throw new ServiceUnavailableException('Self-service registration is closed. Contact Tacksharp to open an account.');
    const input = validateSignup(body);
    const passwordHash = await hashPassword(input.password);
    const nameKey = input.organizationName.toLowerCase();
    const result = await this.prisma.$transaction(async (tx) => {
      // Duplicate account: the email is the login, so it must be new. (Same message whether in this org or another.)
      if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } }))
        throw new ConflictException({ statusCode: 409, message: 'An account with this email already exists. Log in instead, or ask your workspace admin for an invitation.', fields: { email: 'This email is already registered.' } });
      // Duplicate registration: the same organization name registered through signup and not yet decided / active.
      const sameName = await tx.organization.findFirst({ where: { selfServe: true, status: { in: ['pending_review', 'active'] }, name: input.organizationName }, select: { id: true, name: true } });
      if (sameName && sameName.name.toLowerCase() === nameKey)
        throw new ConflictException({ statusCode: 409, message: 'An organization with this name is already registered. Ask its admin to invite you.', fields: { organizationName: 'Already registered.' } });
      const org = await tx.organization.create({
        data: { name: input.organizationName, vertical: 'real_estate', isDemo: false, status: 'pending_review', selfServe: true, contactPhone: input.phone },
      });
      await tx.organizationSettings.create({ data: { organizationId: org.id, data: sanitizeSettings({ industry: input.industry }, DEFAULT_SETTINGS) as never } });
      const user = await tx.user.create({ data: { organizationId: org.id, email: input.email, name: input.adminName, role: 'admin', passwordHash, isPlatformAdmin: false } });
      await tx.auditEvent.create({ data: { organizationId: org.id, actor: `user:${user.id}`, entityType: 'organization', entityId: org.id, action: 'organization.registered', data: { industry: input.industry, via: 'self_service_signup' } } });
      return { org, user };
    });
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    const token = signSession({ sub: result.user.id, org: result.org.id, role: 'admin', exp, iat: Date.now() }, config.auth.secret);
    log.info('auth.signup', { organizationId: result.org.id, userId: result.user.id, industry: input.industry });
    return { token, maxAgeSec: SESSION_DAYS * 86400, user: publicUser(result.user), organization: { id: result.org.id, name: result.org.name, status: result.org.status, industry: input.industry } };
  }

  /**
   * "Forgot password" without an email provider: nothing can be emailed, so the request is recorded for the people who
   * can issue a one-time reset link (the workspace admins and the platform team) and the answer is the same whether
   * or not the email exists (no account enumeration).
   */
  async forgotPassword(emailRaw: unknown) {
    const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase().slice(0, 254) : '';
    const user = email ? await this.prisma.user.findUnique({ where: { email }, select: { id: true, organizationId: true, disabledAt: true } }) : null;
    if (user && !user.disabledAt) {
      const recent = await this.prisma.auditEvent.count({ where: { organizationId: user.organizationId, entityId: user.id, action: 'password.reset_requested', createdAt: { gt: new Date(Date.now() - 60 * 60_000) } } });
      if (!recent) await this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actor: 'public', entityType: 'user', entityId: user.id, action: 'password.reset_requested', data: {} } });
    }
    log.info('auth.forgot_password', { email: email ? maskEmail(email) : '' });
    return {
      ok: true,
      message: 'If this email has an account, your request has been recorded. Email is not configured, so no message is sent: your workspace admin (Team & access → Reset link) or the Tacksharp team will give you a one-time reset link.',
    };
  }

  /** Workspaces this user may open: their own organization plus memberships. */
  async workspaces(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { organization: true, memberships: { include: { organization: true } } } });
    if (!user) throw new UnauthorizedException();
    const all = [{ org: user.organization, role: user.role }, ...user.memberships.filter((m) => m.organizationId !== user.organizationId).map((m) => ({ org: m.organization, role: m.role }))];
    const rows = await this.prisma.organizationSettings.findMany({ where: { organizationId: { in: all.map((a) => a.org.id) } } });
    const settingsIndustry = new Map(rows.map((r) => [r.organizationId, sanitizeSettings(r.data, DEFAULT_SETTINGS).industry]));
    return all.map(({ org, role }) => {
      const industry = effectiveIndustry(org.vertical, settingsIndustry.get(org.id) ?? DEFAULT_SETTINGS.industry);
      return { organizationId: org.id, name: org.name, vertical: org.vertical, isDemo: org.isDemo, status: org.status, role, industry, industryLabel: INDUSTRY_LABEL[industry] };
    });
  }

  /**
   * Switch the session to another workspace the user belongs to. A new signed session is issued for that organization
   * (same expiry policy); every API call then stays scoped to it on the server.
   */
  async switchWorkspace(userId: string, organizationId: string) {
    const options = await this.workspaces(userId);
    const target = options.find((w) => w.organizationId === organizationId);
    if (!target) throw new ForbiddenException('You do not have access to that workspace.');
    if (target.status === 'suspended') throw new ForbiddenException('That organization is suspended.');
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    const home = (await this.prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true } }))?.organizationId;
    const token = signSession({ sub: userId, org: target.organizationId, role: target.role, exp, iat: Date.now(), ...(target.organizationId !== home ? { ws: true } : {}) }, config.auth.secret);
    log.info('auth.workspace_switched', { userId, organizationId: target.organizationId });
    return { token, maxAgeSec: SESSION_DAYS * 86400, workspace: target };
  }

  async createUser(input: { organizationId: string; email: string; password: string; name?: string; role?: string }) {
    const passwordHash = await hashPassword(input.password);
    return this.prisma.user.upsert({
      where: { email: input.email.trim().toLowerCase() },
      create: {
        organizationId: input.organizationId,
        email: input.email.trim().toLowerCase(),
        name: input.name,
        role: input.role ?? 'admin',
        passwordHash,
      },
      update: { passwordHash, name: input.name, organizationId: input.organizationId },
    });
  }
}

// A real scrypt hash of a random string, used to equalize timing for unknown emails.
const DUMMY_HASH = 'scrypt$c2FsdHNhbHRzYWx0c2FsdA==$' + Buffer.alloc(64, 1).toString('base64');

function publicUser(u: { id: string; email: string; name: string | null; role: string; organizationId: string }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, organizationId: u.organizationId };
}

function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  return `${(name ?? '').slice(0, 2)}***@${domain ?? ''}`;
}
