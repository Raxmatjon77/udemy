import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ErrorCode } from '@udemy/contracts';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@udemy/nest-common/errors';
import type { Request } from 'express';
import {
  AuthMetadataReader,
  getPrincipal,
  type PolicySpec,
  type Principal,
  type RouteSecurity,
} from '../../../shared/auth';
import { classifyGuardContext, type RealtimeIdentity } from '../../../shared/realtime';
import { Authorizer } from '../application/authorizer';

/**
 * Last global guard (after ClientAuthGuard, ThrottlerGuard and JwtAuthGuard). It never
 * verifies tokens: JwtAuthGuard has already put the principal on the request, or left it
 * empty. It enforces the route's security marker:
 *
 * - `@Public`: allow.
 * - `@AuthenticatedOnly`: a principal is required (401).
 * - `@RequirePermissions(...)`: all listed permissions (403 `forbidden`).
 * - `@CheckPolicy(...)`: `Authorizer.canOnResource` per spec; NOT_FOUND -> 404, DENY -> 403.
 *
 * A misconfigured route (no marker, conflicting markers) fails closed with a 500; the
 * RouteSecurityAuditor makes such routes fail startup, so this is defence in depth.
 *
 * WebSocket (Phase 5 design §9): a `@SubscribeMessage` handler of a `@RealtimeGateway` on an
 * authenticated socket is checked against the socket's principal: `@AuthenticatedOnly` passes,
 * `@RequirePermissions` needs every permission. `@CheckPolicy` reads route params of an HTTP
 * request and is refused on a gateway (the auditor fails boot). Every other non-HTTP context is
 * denied.
 */
@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private readonly reader: AuthMetadataReader,
    private readonly authorizer: Authorizer,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const guardContext = classifyGuardContext(context);
    if (guardContext.kind === 'denied') return false;
    const descriptor = this.reader.forContext(context);
    const { security } = descriptor;
    if (
      descriptor.problems.length > 0 ||
      security.kind === 'missing' ||
      security.kind === 'conflict'
    ) {
      throw new Error(
        `Route ${context.getClass().name}.${context.getHandler().name} has an invalid security configuration`,
      );
    }
    if (security.kind === 'public') return true;
    if (guardContext.kind === 'realtime')
      return this.allowsRealtime(guardContext.identity, security);

    const request = context.switchToHttp().getRequest<Request>();
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw new UnauthorizedError('Authentication is required.', { code: ErrorCode.Unauthorized });
    }
    if (security.kind === 'authenticated') return true;

    if (!security.permissions.every((p) => this.authorizer.can(principal, p))) {
      throw forbidden();
    }
    for (const policy of security.policies) {
      await this.checkPolicy(principal, policy, request);
    }
    return true;
  }

  private allowsRealtime(
    identity: RealtimeIdentity,
    security: Exclude<RouteSecurity, { kind: 'public' | 'missing' | 'conflict' }>,
  ): boolean {
    if (security.kind === 'authenticated') return true;
    if (security.policies.length > 0) return false;
    return security.permissions.every((p) => this.authorizer.can(identity.principal, p));
  }

  private async checkPolicy(principal: Principal, policy: PolicySpec, req: Request): Promise<void> {
    // A missing route param must not reach the resolver as the string "undefined".
    const id: unknown = policy.id(req);
    const resourceId = typeof id === 'string' ? id : '';
    const decision = await this.authorizer.canOnResource(
      principal,
      policy.action,
      policy.resource,
      resourceId,
    );
    if (decision === 'NOT_FOUND') {
      throw new NotFoundError('The resource does not exist.', { code: ErrorCode.NotFound });
    }
    if (decision === 'DENY') throw forbidden();
  }
}

function forbidden(): ForbiddenError {
  return new ForbiddenError('You are not allowed to perform this action.', {
    code: ErrorCode.Forbidden,
  });
}
