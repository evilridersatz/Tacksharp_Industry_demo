import { CanActivate, ExecutionContext, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { config } from '../common/config.js';
import { IS_PUBLIC, type AuthedRequest } from './decorators.js';
import { readCookie, verifySession } from './token.js';

export const SESSION_COOKIE = 'ts_session';

/** Global guard: every route needs a valid session unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /** Membership checks for switched sessions, cached briefly (a removed membership stops working within a minute). */
  private readonly memberships = new Map<string, { at: number; ok: boolean }>();

  private async memberOk(userId: string, organizationId: string) {
    const key = `${userId}|${organizationId}`;
    const hit = this.memberships.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    const ok = Boolean(await this.prisma!.organizationMembership.findUnique({ where: { userId_organizationId: { userId, organizationId } }, select: { id: true } }));
    this.memberships.set(key, { at: Date.now(), ok });
    return ok;
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
    // A workspace-switch session is valid only while the membership exists.
    if (claims.ws && this.prisma) {
      return this.memberOk(claims.sub, claims.org).then((ok) => {
        if (!ok) throw new UnauthorizedException('Your access to this workspace was removed. Please log in again.');
        return true;
      });
    }
    return true;
  }
}
