import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { config } from '../common/config.js';
import { IS_PUBLIC, type AuthedRequest } from './decorators.js';
import { readCookie, verifySession } from './token.js';

export const SESSION_COOKIE = 'ts_session';

/** Read-only roles may only read, sign out and switch to another workspace they belong to. */
const READ_ONLY_ROLES = new Set(['viewer']);
const READ_ONLY_ALLOWED = new Set(['/auth/logout', '/auth/workspace']);
const CACHE_MS = 15_000;

type UserState = { exists: boolean; disabledAt: Date | null; revokedAt: Date | null; homeOrg: string | null; role: string | null };

// Shared by every guard instance in the process, so team changes (remove / role / reset) apply at once.
const users = new Map<string, { at: number; v: UserState }>();
const memberships = new Map<string, { at: number; role: string | null }>();
const orgs = new Map<string, { at: number; status: string | null }>();

/** Forget cached access for a user (called after removal, role change or password reset). */
export function invalidateAccess(userId: string) {
  users.delete(userId);
  for (const k of [...memberships.keys()]) if (k.startsWith(`${userId}|`)) memberships.delete(k);
}

/** Forget the cached organization status (called after a platform admin activates or suspends it). */
export function invalidateOrganization(organizationId: string) {
  orgs.delete(organizationId);
}

/**
 * Global guard: every route needs a valid session unless marked @Public(). With a database it also re-checks, on
 * every request (cached briefly), that the user still exists, is not disabled, that the session was issued after
 * any revocation, and that the workspace membership still exists. The role is taken from the database, not from the
 * (up to 7-day) session token, so a role change or removal applies within seconds.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  private async userState(userId: string): Promise<UserState> {
    const hit = users.get(userId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
    const u = await this.prisma!.user.findUnique({ where: { id: userId }, select: { disabledAt: true, sessionsRevokedAt: true, organizationId: true, role: true } });
    const v: UserState = u ? { exists: true, disabledAt: u.disabledAt, revokedAt: u.sessionsRevokedAt, homeOrg: u.organizationId, role: u.role } : { exists: false, disabledAt: null, revokedAt: null, homeOrg: null, role: null };
    users.set(userId, { at: Date.now(), v });
    return v;
  }

  private async membershipRole(userId: string, organizationId: string) {
    const key = `${userId}|${organizationId}`;
    const hit = memberships.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.role;
    const m = await this.prisma!.organizationMembership.findUnique({ where: { userId_organizationId: { userId, organizationId } }, select: { role: true } });
    memberships.set(key, { at: Date.now(), role: m?.role ?? null });
    return m?.role ?? null;
  }

  private async orgStatus(organizationId: string) {
    const hit = orgs.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.status;
    const o = await this.prisma!.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
    orgs.set(organizationId, { at: Date.now(), status: o?.status ?? null });
    return o?.status ?? null;
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & AuthedRequest>();
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const token = bearer ?? readCookie(req.headers.cookie, SESSION_COOKIE);
    const claims = verifySession(token, config.auth.secret);
    if (!claims) throw new UnauthorizedException('Please log in.');
    req.auth = claims;
    if (!this.prisma) return this.readOnly(req, claims.role);
    return this.check(req, claims);
  }

  private async check(req: Request & AuthedRequest, claims: NonNullable<AuthedRequest['auth']>) {
    const u = await this.userState(claims.sub);
    if (!u.exists || u.disabledAt) throw new UnauthorizedException('Your account no longer has access. Please contact your workspace admin.');
    if (u.revokedAt && (claims.iat ?? 0) < u.revokedAt.getTime()) throw new UnauthorizedException('Your session has ended. Please log in again.');
    let role: string | null;
    if (claims.org === u.homeOrg && !claims.ws) role = u.role;
    else {
      role = await this.membershipRole(claims.sub, claims.org);
      if (!role) throw new UnauthorizedException('Your access to this workspace was removed. Please log in again.');
    }
    // A suspended (or deleted) organization: every session into it stops at once (within the cache window).
    const status = await this.orgStatus(claims.org);
    if (!status) throw new UnauthorizedException('This workspace no longer exists. Please log in again.');
    if (status === 'suspended') throw new UnauthorizedException('This organization is suspended. Contact Tacksharp support.');
    req.auth = { ...claims, role: role ?? claims.role };
    return this.readOnly(req, req.auth.role);
  }

  private readOnly(req: Request, role: string | undefined) {
    if (role && READ_ONLY_ROLES.has(role) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !READ_ONLY_ALLOWED.has(req.path)) {
      throw new ForbiddenException('Your access to this workspace is read-only.');
    }
    return true;
  }
}
