import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signSession } from '../auth/token.js';
import { invalidateAccess } from '../auth/auth.guard.js';
import { ROLE_PERMISSIONS } from '../governance/permissions.js';

type Actor = { sub: string; org: string };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const INVITE_HOURS = () => Math.min(168, Math.max(1, Number(process.env.INVITE_EXPIRY_HOURS ?? 72) || 72));
const RESET_HOURS = () => Math.min(24, Math.max(1, Number(process.env.RESET_LINK_EXPIRY_HOURS ?? 2) || 2));
const SESSION_DAYS = 7;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/** Roles an admin can give in a workspace (the existing role model plus a read-only viewer). */
export const ASSIGNABLE_ROLES = ['admin', 'manager', 'sales', 'operations', 'front_desk', 'reception', 'insurance', 'technician', 'finance', 'marketing', 'viewer'] as const;

/**
 * Members and access links of ONE workspace (the admin's session organization; never from the request).
 *  - invite: a single-use link (expires, default 72 h) that creates an account in this workspace, or adds this
 *    workspace to an existing account after that account's own password is confirmed;
 *  - reset: a single-use link (default 2 h) to set a new password; every older session is then refused;
 *  - remove: a guest (membership) loses this workspace; a home user is disabled (login and sessions refused);
 *  - role change applies on the next request (the guard reads roles from the database).
 * Tokens are random 32 bytes, shown once; only their SHA-256 is stored. No email provider is configured, so the admin
 * copies the link and sends it personally (the response says so). Everything is audited.
 */
@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService) {}

  private audit(org: string, actor: string, entityId: string, action: string, data: unknown) {
    return this.prisma.auditEvent.create({ data: { organizationId: org, actor, entityType: 'team', entityId, action, data: data as never } }).catch(() => undefined);
  }

  private role(v: unknown) {
    const r = typeof v === 'string' ? v : '';
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(r) || !(r in ROLE_PERMISSIONS || r === 'viewer')) throw new BadRequestException(`Choose a role: ${ASSIGNABLE_ROLES.join(', ')}.`);
    return r;
  }

  async members(org: string) {
    const [home, guests, pending] = await Promise.all([
      this.prisma.user.findMany({ where: { organizationId: org }, select: { id: true, email: true, name: true, role: true, lastLoginAt: true, disabledAt: true, createdAt: true } }),
      this.prisma.organizationMembership.findMany({ where: { organizationId: org }, include: { user: { select: { id: true, email: true, name: true, lastLoginAt: true, disabledAt: true, organizationId: true } } } }),
      this.prisma.userInvitation.findMany({ where: { organizationId: org, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    const rows = [
      ...home.map((u) => ({ userId: u.id, email: u.email, name: u.name, role: u.role, access: 'home' as const, lastLoginAt: u.lastLoginAt, disabled: Boolean(u.disabledAt), since: u.createdAt })),
      ...guests.filter((m) => m.user.organizationId !== org).map((m) => ({ userId: m.user.id, email: m.user.email, name: m.user.name, role: m.role, access: 'member' as const, lastLoginAt: m.user.lastLoginAt, disabled: Boolean(m.user.disabledAt), since: m.createdAt })),
    ].sort((a, b) => a.email.localeCompare(b.email));
    return {
      members: rows,
      invitations: pending.map((i) => ({ id: i.id, kind: i.kind, email: i.email, role: i.role, expiresAt: i.expiresAt, createdAt: i.createdAt, createdBy: i.createdBy })),
      roles: ASSIGNABLE_ROLES,
      emailDelivery: 'not_configured' as const,
    };
  }

  async invite(actor: Actor, body: { email?: unknown; role?: unknown }) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new BadRequestException('Enter a valid email address.');
    const role = this.role(body.role);
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true, organizationId: true, disabledAt: true } });
    if (existing?.organizationId === actor.org) throw new ConflictException('This person already belongs to this workspace. Change their role instead.');
    if (existing && (await this.prisma.organizationMembership.findUnique({ where: { userId_organizationId: { userId: existing.id, organizationId: actor.org } } }))) throw new ConflictException('This person already has access to this workspace.');
    if ((await this.prisma.userInvitation.count({ where: { organizationId: actor.org, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } })) >= 50) throw new BadRequestException('Too many open invitations. Revoke unused ones first.');
    return this.issue(actor, 'invite', email, role, existing?.id ?? null, INVITE_HOURS());
  }

  async resetLink(actor: Actor, userId: string) {
    const target = await this.memberOf(actor.org, userId);
    if (target.disabled) throw new BadRequestException('This account is disabled.');
    // A guest's account belongs to another workspace (and may reach others): only their home workspace admin may
    // reset it, otherwise one workspace's admin could take over an account with access elsewhere.
    if (target.access !== 'home') throw new ForbiddenException("Only the admin of this person's home workspace can reset their password.");
    return this.issue(actor, 'reset', target.email, target.role, userId, RESET_HOURS());
  }

  private async issue(actor: Actor, kind: 'invite' | 'reset', email: string, role: string, userId: string | null, hours: number) {
    // Older open links of the same kind for the same person stop working: only the newest one is valid.
    await this.prisma.userInvitation.updateMany({ where: { organizationId: actor.org, email, kind, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const token = randomBytes(32).toString('base64url');
    const inv = await this.prisma.userInvitation.create({ data: { organizationId: actor.org, kind, email, role, tokenHash: hash(token), expiresAt: new Date(Date.now() + hours * 3_600_000), createdBy: `user:${actor.sub}`, userId } });
    await this.audit(actor.org, `user:${actor.sub}`, inv.id, kind === 'invite' ? 'invitation_created' : 'reset_link_created', { email, role, expiresAt: inv.expiresAt });
    log.info('team.link_created', { org: actor.org, kind, invitationId: inv.id });
    // The token is returned once (for the admin to copy) and never logged or stored in clear.
    return { id: inv.id, kind, email, role, expiresAt: inv.expiresAt, token, path: `/invite#${token}`, emailDelivery: 'not_configured' as const };
  }

  async revokeInvitation(actor: Actor, id: string) {
    const inv = await this.prisma.userInvitation.findFirst({ where: { id, organizationId: actor.org } });
    if (!inv) throw new NotFoundException('Invitation not found');
    if (!inv.acceptedAt && !inv.revokedAt) await this.prisma.userInvitation.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit(actor.org, `user:${actor.sub}`, id, 'invitation_revoked', { email: inv.email });
    return { id, revoked: true };
  }

  private async memberOf(org: string, userId: string) {
    const home = await this.prisma.user.findFirst({ where: { id: userId, organizationId: org }, select: { id: true, email: true, role: true, disabledAt: true } });
    if (home) return { userId, email: home.email, role: home.role, access: 'home' as const, disabled: Boolean(home.disabledAt) };
    const m = await this.prisma.organizationMembership.findUnique({ where: { userId_organizationId: { userId, organizationId: org } }, include: { user: { select: { email: true, disabledAt: true } } } });
    if (!m) throw new NotFoundException('Member not found');
    return { userId, email: m.user.email, role: m.role, access: 'member' as const, disabled: Boolean(m.user.disabledAt) };
  }

  private async admins(org: string) {
    const [home, guests] = await Promise.all([
      this.prisma.user.count({ where: { organizationId: org, role: 'admin', disabledAt: null } }),
      this.prisma.organizationMembership.count({ where: { organizationId: org, role: 'admin', user: { disabledAt: null, NOT: { organizationId: org } } } }),
    ]);
    return home + guests;
  }

  async changeRole(actor: Actor, userId: string, body: { role?: unknown }) {
    const role = this.role(body.role);
    const target = await this.memberOf(actor.org, userId);
    if (userId === actor.sub) throw new ForbiddenException('You cannot change your own role.');
    if (target.role === 'admin' && role !== 'admin' && (await this.admins(actor.org)) <= 1) throw new ForbiddenException('A workspace needs at least one admin.');
    if (target.access === 'home') await this.prisma.user.update({ where: { id: userId }, data: { role } });
    else await this.prisma.organizationMembership.update({ where: { userId_organizationId: { userId, organizationId: actor.org } }, data: { role } });
    invalidateAccess(userId);
    await this.audit(actor.org, `user:${actor.sub}`, userId, 'role_changed', { email: target.email, from: target.role, to: role });
    return { userId, role };
  }

  async remove(actor: Actor, userId: string) {
    const target = await this.memberOf(actor.org, userId);
    if (userId === actor.sub) throw new ForbiddenException('You cannot remove yourself.');
    if (target.role === 'admin' && (await this.admins(actor.org)) <= 1) throw new ForbiddenException('A workspace needs at least one admin.');
    if (target.access === 'member') {
      await this.prisma.organizationMembership.delete({ where: { userId_organizationId: { userId, organizationId: actor.org } } });
    } else {
      // Their home workspace: the account is disabled (it cannot be left without a home); sessions end now.
      await this.prisma.user.update({ where: { id: userId }, data: { disabledAt: new Date(), sessionsRevokedAt: new Date() } });
    }
    await this.prisma.userInvitation.updateMany({ where: { organizationId: actor.org, email: target.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    invalidateAccess(userId);
    await this.audit(actor.org, `user:${actor.sub}`, userId, target.access === 'member' ? 'member_removed' : 'user_disabled', { email: target.email });
    return { userId, removed: true, access: target.access };
  }

  // ------------------------------------------------------------------ public (token holders)

  private async open(token: unknown) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new BadRequestException('This link is not valid.');
    const inv = await this.prisma.userInvitation.findUnique({ where: { tokenHash: hash(token) }, include: { organization: { select: { name: true, isDemo: true } } } });
    if (!inv || inv.revokedAt) throw new BadRequestException('This link is not valid or was replaced by a newer one. Ask your workspace admin for a new link.');
    if (inv.acceptedAt) throw new BadRequestException('This link was already used. Log in, or ask your workspace admin for a new link.');
    if (inv.expiresAt <= new Date()) throw new BadRequestException('This link has expired. Ask your workspace admin for a new link.');
    return inv;
  }

  /** What the link is for (no secret data): shown on the invitation page before the person sets a password. */
  async inspect(token: unknown) {
    const inv = await this.open(token);
    const existing = await this.prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } });
    return { kind: inv.kind, email: inv.email, role: inv.role, workspace: inv.organization.name, isDemo: inv.organization.isDemo, expiresAt: inv.expiresAt, existingAccount: Boolean(existing) };
  }

  async accept(body: { token?: unknown; name?: unknown; password?: unknown; currentPassword?: unknown }) {
    const inv = await this.open(body.token);
    const password = typeof body.password === 'string' ? body.password : '';
    const existing = await this.prisma.user.findUnique({ where: { email: inv.email } });
    if (existing?.disabledAt) throw new ForbiddenException('This account is disabled. Ask your workspace admin.');
    const needNew = inv.kind === 'reset' || !existing;
    if (needNew) {
      if (password.length < 12 || password.length > 200) throw new BadRequestException('Choose a password of at least 12 characters.');
      if (password.toLowerCase().includes(inv.email.split('@')[0].toLowerCase())) throw new BadRequestException('The password must not contain your email name.');
    }
    // Single use: claim the link atomically before acting on it.
    const claimed = await this.prisma.userInvitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
    if (claimed.count !== 1) throw new BadRequestException('This link was already used.');

    let userId: string;
    let org: string;
    let ws = false;
    if (inv.kind === 'reset') {
      if (!existing || (inv.userId && existing.id !== inv.userId)) throw new BadRequestException('This link is not valid.');
      await this.prisma.user.update({ where: { id: existing.id }, data: { passwordHash: await hashPassword(password), sessionsRevokedAt: new Date() } });
      userId = existing.id;
      org = inv.organizationId;
      ws = existing.organizationId !== inv.organizationId;
      await this.audit(inv.organizationId, `user:${existing.id}`, existing.id, 'password_reset', { email: inv.email, invitationId: inv.id });
    } else if (existing) {
      // An existing account joins this workspace: prove it is theirs with their own password (no takeover via link).
      const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      if (!(await verifyPassword(current, existing.passwordHash))) {
        await this.prisma.userInvitation.update({ where: { id: inv.id }, data: { acceptedAt: null } });
        throw new UnauthorizedException('That is not the password of this account.');
      }
      await this.prisma.organizationMembership.upsert({ where: { userId_organizationId: { userId: existing.id, organizationId: inv.organizationId } }, create: { userId: existing.id, organizationId: inv.organizationId, role: inv.role }, update: { role: inv.role } });
      userId = existing.id;
      org = inv.organizationId;
      ws = existing.organizationId !== inv.organizationId;
      await this.audit(inv.organizationId, `user:${existing.id}`, existing.id, 'invitation_accepted', { email: inv.email, role: inv.role, invitationId: inv.id });
    } else {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
      const user = await this.prisma.user.create({ data: { organizationId: inv.organizationId, email: inv.email, name: name || null, role: inv.role, passwordHash: await hashPassword(password) } });
      userId = user.id;
      org = inv.organizationId;
      await this.audit(inv.organizationId, `user:${user.id}`, user.id, 'invitation_accepted', { email: inv.email, role: inv.role, invitationId: inv.id, newAccount: true });
    }
    await this.prisma.userInvitation.update({ where: { id: inv.id }, data: { userId } });
    invalidateAccess(userId);
    log.info('team.link_used', { kind: inv.kind, org, userId });
    // Signed in straight into the workspace the link was for.
    const now = Math.floor(Date.now() / 1000);
    const token = signSession({ sub: userId, org, role: inv.role, exp: now + SESSION_DAYS * 86400, iat: Date.now() + 1, ...(ws ? { ws: true } : {}) }, config.auth.secret);
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    return { token, maxAgeSec: SESSION_DAYS * 86400, organizationId: org, kind: inv.kind };
  }
}
