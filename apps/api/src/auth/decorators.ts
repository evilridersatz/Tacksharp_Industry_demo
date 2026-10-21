import { SetMetadata, UnauthorizedException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { SessionClaims } from './token.js';

export const IS_PUBLIC = 'tacksharp:public';

/** Marks a route as reachable without login (webhooks, health, login). Everything else is private. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export type AuthedRequest = { auth?: SessionClaims };

/** The organization of the logged-in user. Never read organizationId from the request body or query. */
export const Org = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth?.org) throw new UnauthorizedException();
  return req.auth.org;
});

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionClaims => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
});
