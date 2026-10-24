import type { ClientApp, Permission, Role } from '@udemy/contracts';

/**
 * What a WS ticket stands for: the principal of the authenticated HTTP request that issued it
 * (design D16). The socket's principal is rebuilt from it at the handshake, so a gateway handler
 * sees the same user, session, app, roles and permissions as that request did.
 */
export interface WsTicketGrant {
  readonly userId: string;
  readonly sessionId: string;
  readonly app: ClientApp;
  readonly roles: readonly Role[];
  readonly permissions: readonly Permission[];
  /** `jti` of the access token that issued the ticket. */
  readonly tokenId: string;
}

export interface IssuedWsTicket {
  /** 32 random bytes, base64url (`REALTIME_TICKET_PATTERN`). Shown once, never stored. */
  readonly ticket: string;
  readonly expiresAt: Date;
}

/**
 * Short-lived, single-use WS tickets (design D16, §6 "Redis keys": `ws:tkt:{sha256}`, 30 s).
 * Only the SHA-256 of a ticket is stored. Fails closed: a store error surfaces as
 * `RedisUnavailableError`, never as a valid ticket.
 */
export abstract class WsTicketStore {
  abstract issue(grant: WsTicketGrant): Promise<IssuedWsTicket>;

  /**
   * Redeems a ticket: returns its grant and deletes it in one atomic step, so a ticket works
   * once. Null when the ticket is malformed, unknown, expired or already used.
   */
  abstract consume(ticket: string): Promise<WsTicketGrant | null>;
}
