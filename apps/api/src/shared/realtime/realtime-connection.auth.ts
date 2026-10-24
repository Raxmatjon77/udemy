import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  REALTIME_LIMITS,
  type RealtimeConnectErrorCode,
  RealtimeHandshakeAuthSchema,
} from '@udemy/contracts';
import { AppConfigService } from '../config';
import type { RealtimeIdentity } from './realtime-identity';
import { RealtimeConnectionLimiter } from './realtime-connection.limiter';
import {
  REALTIME_SESSION_REVOCATIONS,
  type RealtimeSessionRevocations,
} from './realtime-session-revocations';
import { type WsTicketGrant, WsTicketStore } from './ws-ticket.store';

/**
 * A refused handshake. socket.io sends `message` to the client as its `connect_error`, so it is
 * always one of the contract's `REALTIME_CONNECT_ERROR_CODES` and never carries internals.
 */
export class RealtimeConnectError extends Error {
  constructor(
    readonly code: RealtimeConnectErrorCode,
    options: { cause?: unknown } = {},
  ) {
    super(code, { cause: options.cause });
    this.name = 'RealtimeConnectError';
  }
}

/** What the handshake middleware passes in (from `socket.handshake`). */
export interface RealtimeHandshake {
  /** The `Origin` request header. */
  readonly origin: string | undefined;
  /** `socket.handshake.auth`: client-controlled, validated here. */
  readonly auth: unknown;
}

/** `scheme://host[:port]` of a URL-ish string; undefined when it is not one (e.g. `null`). */
export function normalizeOrigin(value: string | undefined): string | undefined {
  if (value === undefined || !URL.canParse(value)) return undefined;
  const origin = new URL(value).origin;
  return origin === 'null' ? undefined : origin;
}

/**
 * Authenticates a socket.io handshake (design D16, §9 "WebSocket"), in this order:
 *
 * 1. `Origin` ∈ `REALTIME_ALLOWED_ORIGINS`                       -> `origin_not_allowed`
 * 2. `auth.ticket` well-formed, redeemed once (GETDEL)          -> `ticket_invalid`
 * 3. the ticket's session is not revoked (`auth:revoked:sid:*`) -> `session_revoked`
 * 4. fewer than `maxSocketsPerUser` live sockets for the user   -> `too_many_connections`
 *
 * Fails closed: a Redis error at any step refuses the handshake as `ticket_invalid` (the client
 * then asks its BFF for a new ticket, which answers 503 `realtime_unavailable` while Redis is
 * down). The ticket is consumed even when a later step refuses, so it never works twice.
 */
@Injectable()
export class RealtimeConnectionAuth {
  private readonly logger = new Logger(RealtimeConnectionAuth.name);
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    config: AppConfigService,
    private readonly tickets: WsTicketStore,
    @Inject(REALTIME_SESSION_REVOCATIONS) private readonly sessions: RealtimeSessionRevocations,
    private readonly limiter: RealtimeConnectionLimiter,
  ) {
    this.allowedOrigins = new Set(
      config
        .get('REALTIME_ALLOWED_ORIGINS')
        .map((origin) => normalizeOrigin(origin))
        .filter((origin): origin is string => origin !== undefined),
    );
  }

  /** @throws RealtimeConnectError */
  async authenticate(handshake: RealtimeHandshake, now = new Date()): Promise<RealtimeIdentity> {
    const origin = normalizeOrigin(handshake.origin);
    if (origin === undefined || !this.allowedOrigins.has(origin)) {
      this.logger.debug({ origin: handshake.origin ?? null }, 'WS handshake from a foreign origin');
      throw new RealtimeConnectError('origin_not_allowed');
    }

    const auth = RealtimeHandshakeAuthSchema.safeParse(handshake.auth);
    if (!auth.success) throw new RealtimeConnectError('ticket_invalid');
    const grant = await this.failClosed('ticket', () => this.tickets.consume(auth.data.ticket));
    if (grant === null) throw new RealtimeConnectError('ticket_invalid');

    const revoked = await this.failClosed('revocation', () =>
      this.sessions.isRevoked(grant.sessionId),
    );
    if (revoked) throw new RealtimeConnectError('session_revoked');

    const acquired = await this.failClosed('connection cap', () =>
      this.limiter.acquire(grant.userId),
    );
    if (!acquired) throw new RealtimeConnectError('too_many_connections');

    return identityOf(grant, origin, now);
  }

  /** Releases the connection slot of a socket that `authenticate` admitted. Never throws. */
  async release(identity: RealtimeIdentity): Promise<void> {
    try {
      await this.limiter.release(identity.principal.userId);
    } catch (error) {
      // The counter's TTL heals a missed release (see RealtimeConnectionLimiter).
      this.logger.warn({ err: error }, 'Could not release a WS connection slot');
    }
  }

  private async failClosed<T>(step: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger.warn({ err: error, step }, 'WS handshake check failed; refusing the connection');
      throw new RealtimeConnectError('ticket_invalid', { cause: error });
    }
  }
}

function identityOf(grant: WsTicketGrant, origin: string, now: Date): RealtimeIdentity {
  return {
    principal: {
      userId: grant.userId,
      sessionId: grant.sessionId,
      app: grant.app,
      roles: grant.roles,
      permissions: new Set(grant.permissions),
      tokenId: grant.tokenId,
    },
    origin,
    connectedAt: now,
    expiresAt: new Date(now.getTime() + REALTIME_LIMITS.maxConnectionSeconds * 1000),
  };
}
