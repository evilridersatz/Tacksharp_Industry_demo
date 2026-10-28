import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';
import { hashPassword, verifyPassword } from './password.js';
import { signSession } from './token.js';
import { INDUSTRY_LABEL, effectiveIndustry } from '../industry/industries.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../settings/tenant-settings.js';

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
    return { ...publicUser(user), organizationId: org.id, role: session?.role ?? user.role, organizationName: org.name, vertical: org.vertical, isDemo: org.isDemo, homeOrganizationId: user.organizationId };
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
      return { organizationId: org.id, name: org.name, vertical: org.vertical, isDemo: org.isDemo, role, industry, industryLabel: INDUSTRY_LABEL[industry] };
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
