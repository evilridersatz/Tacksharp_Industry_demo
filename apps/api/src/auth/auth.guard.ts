import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { config } from '../common/config.js';
import { IS_PUBLIC, type AuthedRequest } from './decorators.js';
import { readCookie, verifySession } from './token.js';

export const SESSION_COOKIE = 'ts_session';

/** Global guard: every route needs a valid session unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & AuthedRequest>();
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const token = bearer ?? readCookie(req.headers.cookie, SESSION_COOKIE);
    const claims = verifySession(token, config.auth.secret);
    if (!claims) throw new UnauthorizedException('Please log in.');
    req.auth = claims;
    return true;
  }
}
