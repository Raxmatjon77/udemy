import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ClientAppSchema,
  PermissionSchema,
  REALTIME_LIMITS,
  REALTIME_TICKET_PATTERN,
  RoleSchema,
} from '@udemy/contracts';
import { z } from 'zod';
import { InjectRedis, type RedisClient, withRedis } from '../redis';
import { type IssuedWsTicket, type WsTicketGrant, WsTicketStore } from './ws-ticket.store';

/** `ws:tkt:{sha256(ticket) hex}` (design §6 "Redis keys"). */
export function wsTicketKey(ticket: string): string {
  return `ws:tkt:${createHash('sha256').update(ticket, 'utf8').digest('hex')}`;
}

const TICKET_BYTES = 32;

/** The stored value (versioned, so a format change cannot be misread by an older replica). */
const StoredGrantSchema = z.object({
  v: z.literal(1),
  u: z.string().min(1),
  sid: z.string().min(1),
  app: ClientAppSchema,
  roles: z.array(RoleSchema),
  perms: z.array(PermissionSchema),
  jti: z.string().min(1),
});
type StoredGrant = z.infer<typeof StoredGrantSchema>;

function toStored(grant: WsTicketGrant): StoredGrant {
  return {
    v: 1,
    u: grant.userId,
    sid: grant.sessionId,
    app: grant.app,
    roles: [...grant.roles],
    perms: [...grant.permissions],
    jti: grant.tokenId,
  };
}

function fromStored(stored: StoredGrant): WsTicketGrant {
  return {
    userId: stored.u,
    sessionId: stored.sid,
    app: stored.app,
    roles: stored.roles,
    permissions: stored.perms,
    tokenId: stored.jti,
  };
}

@Injectable()
export class RedisWsTicketStore extends WsTicketStore {
  private readonly logger = new Logger(RedisWsTicketStore.name);

  constructor(@InjectRedis() private readonly redis: RedisClient) {
    super();
  }

  async issue(grant: WsTicketGrant): Promise<IssuedWsTicket> {
    const ticket = randomBytes(TICKET_BYTES).toString('base64url');
    const ttlSeconds = REALTIME_LIMITS.ticketTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const stored = await withRedis(() =>
      this.redis.set(wsTicketKey(ticket), JSON.stringify(toStored(grant)), 'EX', ttlSeconds, 'NX'),
    );
    // 256 random bits never collide; a missing OK means Redis did not store it.
    if (stored !== 'OK') throw new Error('WS ticket was not stored');
    return { ticket, expiresAt };
  }

  async consume(ticket: string): Promise<WsTicketGrant | null> {
    if (!REALTIME_TICKET_PATTERN.test(ticket)) return null;
    // GETDEL (Redis >= 6.2): read and delete atomically, so two handshakes racing with the
    // same ticket cannot both get it.
    const raw = await withRedis(() => this.redis.getdel(wsTicketKey(ticket)));
    if (raw === null) return null;
    const parsed = StoredGrantSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.logger.warn('Unreadable WS ticket value; refusing it');
      return null;
    }
    return fromStored(parsed.data);
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
