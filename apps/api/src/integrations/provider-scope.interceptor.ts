import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/decorators.js';
import { runInProviderScope } from './provider-scope.js';

/**
 * Runs every HTTP request inside a provider scope for the session's organization (set by the AuthGuard, never from
 * the body), so provider calls made while serving it use that organization's credentials. Public routes start with
 * no organization; webhook handlers bind theirs once the tenant is resolved from the provider's identifiers.
 */
@Injectable()
export class ProviderScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    return new Observable((subscriber) => runInProviderScope(req?.auth?.org, () => next.handle().subscribe(subscriber)));
  }
}
