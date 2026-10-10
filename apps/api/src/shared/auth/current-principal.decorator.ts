import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { getClientContext, getPrincipal } from './auth-request';
import type { ClientContext, Principal } from './principal';

/**
 * The authenticated user of the request. Use it only on authenticated routes: on a route
 * without a principal (e.g. @Public) it throws, which is a programming error (-> 500).
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const principal = getPrincipal(ctx.switchToHttp().getRequest<Request>());
    if (principal === undefined) {
      throw new Error('@CurrentPrincipal() used on a route without an authenticated principal');
    }
    return principal;
  },
);

/** The authenticated BFF of the request. Throws on @NoClientAuth routes (programming error). */
export const CurrentClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientContext => {
    const client = getClientContext(ctx.switchToHttp().getRequest<Request>());
    if (client === undefined) {
      throw new Error('@CurrentClient() used on a route without an authenticated client');
    }
    return client;
  },
);
