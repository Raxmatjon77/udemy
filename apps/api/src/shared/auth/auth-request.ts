import type { Request } from 'express';
import type { ClientContext, Principal } from './principal';

/**
 * Typed per-request auth state. Stored under a private symbol instead of augmenting
 * Express' Request: `req.client` already exists there (a deprecated alias of the socket), and
 * a symbol cannot be spoofed by anything parsed from the wire.
 *
 * Writers: ClientAuthGuard (client) and JwtAuthGuard (principal) only. Everyone else reads.
 */
const AUTH_STATE = Symbol('udemy.auth.state');

interface AuthState {
  clientAuthenticated: boolean;
  client?: ClientContext;
  principal?: Principal;
}

type RequestWithAuthState = Request & { [AUTH_STATE]?: AuthState };

function stateOf(req: Request): AuthState {
  const carrier = req as RequestWithAuthState;
  carrier[AUTH_STATE] ??= { clientAuthenticated: false };
  return carrier[AUTH_STATE];
}

/**
 * Called by ClientAuthGuard as soon as the client credentials are verified, before it
 * resolves the end-user IP: from then on X-Client-IP / X-Client-User-Agent are trusted.
 */
export function markClientAuthenticated(req: Request): void {
  stateOf(req).clientAuthenticated = true;
}

export function isClientAuthenticated(req: Request): boolean {
  return stateOf(req).clientAuthenticated;
}

/** Stores the authenticated client (also marks the request client-authenticated). */
export function setClientContext(req: Request, client: ClientContext): void {
  const state = stateOf(req);
  state.clientAuthenticated = true;
  state.client = client;
}

export function getClientContext(req: Request): ClientContext | undefined {
  return stateOf(req).client;
}

export function setPrincipal(req: Request, principal: Principal): void {
  stateOf(req).principal = principal;
}

export function getPrincipal(req: Request): Principal | undefined {
  return stateOf(req).principal;
}
